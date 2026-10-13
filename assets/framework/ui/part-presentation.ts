import { isValid, Node, UIOpacity, UITransform } from 'cc';
import type { AssetAccess } from '../assets/asset-access';
import type { AssetKey } from '../assets/asset-types';
import type { GameComponent } from '../components/game-component';
import { componentBindings, instancePreparation } from '../components/component-binding';
import { invariant, type ErrorReporter } from '../core/errors';
import type { Lifetime } from '../core/scope';
import { synchronousStateEffect } from '../core/state';
import type { ItemContext } from './item-binding';
import type { ViewBindings } from './view-bindings';
import { guardUIInput } from './input-guard';
import { Preparation } from '../core/preparation';

/** 单个 Part、普通集合、虚拟列表使用同一绑定合同。 */
export interface PartContext<T> extends ItemContext<T> {
    readonly bindings: ViewBindings;
    readonly assets: AssetAccess;
}

/** 一次组合使用同一种 Prefab/Part；换皮创建新的组合，不能把不同类型视为相同实例。 */
export interface PartOptions<T, Part extends GameComponent> {
    readonly prefab: AssetKey<'Prefab'>;
    readonly part: new () => Part;
    /** 每次身份绑定调用一次。通过 item.state 订阅更新，异步资源使用 item.bindings.prepare。 */
    readonly bind: (part: Part, item: PartContext<T>) => void;
}

/** @internal 实例与显示期限分离；候选节点在隐藏区域完成原生/业务组件准备。 */
export interface PartCell<Part> {
    readonly node: Node;
    readonly part: Part;
    visible: boolean;
    bindings?: ViewBindings;
    preparation?: Preparation;
}

/** @internal 公共引擎适配，不实现集合差异计算或虚拟布局。 */
export class PartPresentation<T, Part extends GameComponent> {
    private readonly staging: Node;
    constructor(
        owner: Lifetime,
        private readonly parent: Node,
        private readonly assets: AssetAccess,
        private readonly options: PartOptions<T, Part>,
        private readonly createBindings: (
            owner: Lifetime,
            interactive: () => boolean,
            fault: ErrorReporter,
        ) => ViewBindings,
        private readonly fault: (error: unknown, item?: ItemContext<T>) => void,
    ) {
        invariant(parent.parent, 'PARTS_PARENT', '动态 Part 容器必须已经加入节点树');
        // 无 UITransform 的外壳不参与祖先 Layout；内部镜像容器供候选 Widget 对齐。
        const root = new Node(`${parent.name}:preparing`);
        root.layer = parent.layer;
        root.parent = parent.parent;
        this.staging = new Node('Content');
        this.staging.layer = parent.layer;
        this.staging.parent = root;
        const transform = this.staging.addComponent(UITransform),
            original = parent.getComponent(UITransform);
        const sync = () => {
            if (original) {
                transform.setContentSize(original.contentSize);
                transform.setAnchorPoint(original.anchorPoint);
            }
        };
        sync();
        parent.on(Node.EventType.SIZE_CHANGED, sync);
        parent.on(Node.EventType.ANCHOR_CHANGED, sync);
        owner.signal.onAbort(() => {
            if (isValid(parent, true)) {
                parent.off(Node.EventType.SIZE_CHANGED, sync);
                parent.off(Node.EventType.ANCHOR_CHANGED, sync);
            }
        });
        this.staging.addComponent(UIOpacity).opacity = 0;
        this.staging.pauseSystemEvents(true);
        guardUIInput(this.staging, owner, () => false);
        owner.defer(() => {
            if (isValid(root, true)) root.destroy();
        });
    }

    async create(owner: Lifetime): Promise<PartCell<Part>> {
        const node = await this.assets.in(owner).instantiate(this.options.prefab, this.staging, { active: false });
        const part = node.getComponent(this.options.part);
        invariant(part, 'PART_COMPONENT_MISSING', `Prefab 缺少 Part：${this.options.part.name}`);
        return { node, part, visible: false };
    }

    async bind(cell: PartCell<Part>, item: ItemContext<T>): Promise<void> {
        // 先让隐藏树具备引擎生命周期和布局，框架业务组件尚未获准激活。
        // bind 内嵌套组合的子 Part 才能实际准备，不能在失活祖先下提前视为就绪。
        cell.node.active = true;
        cell.node.pauseSystemEvents(true);
        const bindings = this.createBindings(
            item.scope,
            () => cell.visible,
            (error) => this.fault(error, item),
        );
        cell.bindings = bindings;
        cell.preparation = new Preparation(item.scope);
        cell.preparation.include(bindings.preparation);
        synchronousStateEffect(
            this.options.bind(cell.part, Object.freeze({ ...item, bindings, assets: this.assets.in(item.scope) })),
        );
        await bindings.ready();
        item.signal.throwIfAborted();
        await this.assets.prepareInstance(cell.node);
        const components = instancePreparation(cell.node);
        if (components) cell.preparation.include(components);
        cell.node.pauseSystemEvents(true);
        await cell.preparation.ready();
        item.signal.throwIfAborted();
    }

    show(cell: PartCell<Part>): void {
        cell.node.parent = this.parent;
        cell.visible = true;
        cell.node.resumeSystemEvents(true);
    }

    order(cells: readonly PartCell<Part>[]): void {
        for (let index = 0; index < cells.length; index++)
            if (cells[index].node.getSiblingIndex() !== index) cells[index].node.setSiblingIndex(index);
    }

    deactivate(cell: PartCell<Part>): Promise<void> {
        cell.visible = false;
        cell.bindings = undefined;
        cell.preparation = undefined;
        if (!isValid(cell.node, true)) return Promise.resolve();
        cell.node.pauseSystemEvents(true);
        const parts = componentBindings(cell.node);
        for (const part of parts) part.__allow(undefined);
        cell.node.active = false;
        cell.node.parent = this.staging;
        return Promise.all(parts.map((part) => part.__deactivate())).then(() => {});
    }
}
