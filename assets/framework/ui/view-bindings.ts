import { Button, isValid, Label, Node } from 'cc';
import { StateBindings, type StateBinding } from '../core/state-bindings';
import { claimProperties } from '../core/property-lease';
import { invariant, OperationCancelled, reportError } from '../core/errors';
import { derive, reportObserverError, type ReadonlyState, type Snapshot } from '../core/state';
import type { Command, CommandCall } from '../core/command';
import { runTask, type Lifetime } from '../core/scope';
import type { ErrorReporter } from '../core/errors';
import type { AssetAccess } from '../assets/asset-access';
import type { GameComponent } from '../components/game-component';
import { KeyedCollection } from './keyed-collection';
import { PartPresentation, type PartOptions, type PartCell } from './part-presentation';
import type { ItemKey } from './item-binding';
import { acceptsUIInput } from './input-guard';
import type { VirtualList, VirtualListOptions, VirtualListHandle } from './components/virtual-list/virtual-list';

/** 普通集合与单个 Part 的正式组合参数。 */
export interface PartsOptions<T, Part extends GameComponent> extends PartOptions<T, Part> {
    readonly key: (data: T) => ItemKey;
    readonly required?: boolean;
    readonly onError?: ErrorReporter;
}

export interface PartsBinding extends StateBinding {
    /** 重试尚未提交的集合候选；已显示条目的资源失败使用其 prepare/present 句柄重试。 */
    refresh(): void;
    inspect(): Readonly<{ displayed: number; instances: number; retiring: number }>;
}

/** 数据由绑定源唯一驱动；句柄只控制布局、滚动、重试与关闭。 */
export type BoundVirtualList<T> = Omit<VirtualListHandle<T>, 'setItems' | 'updateItem'>;

/** 页面常用的受管渲染入口；节点属性和点击监听跟随本次显示，模型及 Command 只被借用。 */
export class ViewBindings extends StateBindings {
    /** @internal 交互检查由 UIManager 提供，防止准备或导航交接期间执行按钮工作。 */
    constructor(
        owner: Lifetime,
        current: () => boolean = () => true,
        fault: ErrorReporter = reportError,
        private readonly interactive: () => boolean = () => true,
        private readonly assets?: AssetAccess,
    ) {
        super(owner, current, fault);
    }
    /** 绑定 Label 文本；多语言绑定与此入口不能同时拥有 string。 */
    text<S>(target: Label, source: ReadonlyState<S>, format: (state: Snapshot<S>) => string): StateBinding {
        return this.property(target, 'string', source, format);
    }

    /** 页面、Part 的受管事件入口；禁止准备期输入，取消时同步解绑。 */
    listen(
        node: Node,
        event: string,
        callback: (...args: unknown[]) => void | Promise<void>,
        onError: ErrorReporter = reportError,
    ): () => void {
        this.owner.signal.throwIfAborted();
        const handler = (...args: unknown[]) => {
            if (!this.current() || !this.interactive() || this.owner.signal.aborted || !acceptsUIInput(node)) return;
            void runTask(this.owner, () => callback(...args), this.current, `event:${event}`).catch((error) => {
                if (!(error instanceof OperationCancelled)) reportObserverError(onError, error);
            });
        };
        node.on(event, handler);
        let detach = () => {};
        const off = () => {
            if (isValid(node)) node.off(event, handler);
            detach();
        };
        detach = this.owner.signal.onAbort(off);
        return off;
    }

    /** 容器的全部子节点由集合拥有；相同 key 更新和重排保留实例与条目绑定。 */
    items<S, T, Part extends GameComponent>(
        parent: Node,
        source: ReadonlyState<S>,
        select: (state: Snapshot<S>) => readonly T[],
        options: PartsOptions<T, Part>,
    ): PartsBinding {
        invariant(this.assets, 'PARTS_ASSETS', '组合 Part 需要宿主资源入口');
        invariant(parent.children.length === 0, 'PARTS_CONTAINER', '动态 Part 容器必须为空');
        this.owner.signal.throwIfAborted();
        const release = claimProperties(parent, ['children']);
        const owner = this.owner.child('items');
        // 容器只在物理清理后归还，防止旧节点仍在时被另一个集合接管。
        owner.defer(release);
        let presentation!: PartPresentation<T, Part>;
        const collection = new KeyedCollection<T, PartCell<Part>>(
            owner,
            options.key,
            {
                create: (scope) => presentation.create(scope),
                bind: (cell, item) => presentation.bind(cell, item),
                ready: (cell) => presentation.ready(cell),
                show: (cell) => presentation.show(cell),
                order: (cells) => presentation.order(cells),
                deactivate: (cell) => presentation.deactivate(cell),
            },
            this.fault,
        );
        try {
            presentation = new PartPresentation(
                collection.scope,
                parent,
                this.assets,
                options,
                (scope, interactive, fault) =>
                    new ViewBindings(
                        scope,
                        this.current,
                        fault,
                        () => this.interactive() && interactive(),
                        this.assets,
                    ),
                this.fault,
            );
            let revision = 0;
            const renderer = new StateBindings(owner.lifetime, this.current, this.fault).prepare(
                source,
                (state) => {
                    revision++;
                    return select(state);
                },
                {
                    label: 'items',
                    required: options.required,
                    onError: options.onError,
                    prepare: (items, task) => collection.prepare(items, task),
                    render: (plan) => collection.commit(plan),
                },
            );
            const ready = async () => {
                for (;;) {
                    const expected = revision;
                    try {
                        await renderer.ready;
                        await collection.ready();
                    } catch (error) {
                        if (owner.signal.aborted || revision === expected) throw error;
                    }
                    if (revision === expected) return;
                }
            };
            let remove = () => {};
            const result = Object.freeze({
                get ready() {
                    return ready();
                },
                refresh: () => renderer.refresh(),
                dispose: () => {
                    remove();
                    return owner.close();
                },
                inspect: () => collection.inspect(),
            });
            remove = this.include(result, options.required !== false);
            return result;
        } catch (error) {
            void owner.close().catch(this.fault);
            throw error;
        }
    }

    /** 单个可替换区域；undefined 清空，相同 key 更新，其他 key 在准备成功后替换。 */
    part<S, T, Part extends GameComponent>(
        parent: Node,
        source: ReadonlyState<S>,
        select: (state: Snapshot<S>) => T | undefined,
        options: PartsOptions<T, Part>,
    ): PartsBinding {
        return this.items(
            parent,
            source,
            (state) => {
                const item = select(state);
                return item === undefined ? [] : [item];
            },
            options,
        );
    }

    /** 将虚拟列表接入同一数据绑定和首屏准备流程；只等待当前窗口。 */
    list<S, T, Part extends GameComponent>(
        target: VirtualList,
        source: ReadonlyState<S>,
        select: (state: Snapshot<S>) => readonly T[],
        options: Omit<VirtualListOptions<T, Part>, 'owner' | 'assets' | 'interactive'> & {
            readonly required?: boolean;
        },
    ): BoundVirtualList<T> {
        invariant(this.assets, 'PARTS_ASSETS', '组合列表需要宿主资源入口');
        const owner = this.owner.child('list');
        try {
            const list = target.mount({ ...options, owner, assets: this.assets, interactive: this.interactive });
            const feed = new StateBindings(owner.lifetime, this.current, this.fault).watch(source, select, (items) =>
                list.setItems(items),
            );
            let remove = () => {};
            const result = Object.freeze({
                get count() {
                    return list.count;
                },
                get ready() {
                    return feed.ready.then(() => list.ready);
                },
                refresh: list.refresh,
                setLayout: list.setLayout,
                scrollToIndex: list.scrollToIndex,
                whenIdle: list.whenIdle,
                inspect: list.inspect,
                dispose: () => {
                    remove();
                    return owner.close();
                },
            });
            remove = this.include(result, options.required !== false);
            return result;
        } catch (error) {
            void owner.close().catch(this.fault);
            throw error;
        }
    }
    /**
     * 一个绑定同时拥有按钮可交互状态与点击转发。args 在点击时捕获，enabled 表达业务可用性。
     * 解绑只移除这个按钮；调用的期限使用 call.owner，不能因此销毁共享 Command。
     */
    command<A, R, C, S>(
        target: Button,
        command: Command<A, R, C>,
        input: ReadonlyState<S>,
        options: {
            readonly args: (state: Snapshot<S>) => A | Snapshot<A>;
            readonly enabled?: (state: Snapshot<S>) => boolean;
            readonly call: CommandCall<C>;
            readonly interactive?: () => boolean;
            readonly onError?: (error: unknown) => void;
        },
    ): { dispose(): Promise<void> } {
        this.owner.signal.throwIfAborted();
        const release = claimProperties(target, ['interactable']);
        const scope = this.owner.child('command-button');
        const original = target.interactable;
        const live = () => !scope.signal.aborted && this.current() && isValid(target, true);
        let clicked = () => {};
        scope.signal.onAbort(() => {
            if (isValid(target, true)) {
                target.node.off(Button.EventType.CLICK, clicked);
                target.interactable = original;
            }
            release();
        });
        try {
            const state = derive(
                scope,
                [input, command.state] as const,
                (value) => (options.enabled?.(value) ?? true) && command.canRun(options.args(value)),
                { onError: this.fault },
            );
            state.subscribe(
                scope,
                (enabled) => {
                    if (live()) target.interactable = enabled;
                },
                this.fault,
            );
        } catch (error) {
            void scope.close().catch(this.fault);
            throw error;
        }
        clicked = () => {
            if (
                !live() ||
                !this.interactive() ||
                !target.interactable ||
                !acceptsUIInput(target.node) ||
                !(options.interactive?.() ?? true)
            )
                return;
            try {
                // 泛型条件元组在调用点已经由必填 call 满足。
                const call = command.invoke.bind(command) as (
                    args: A | Snapshot<A>,
                    call: CommandCall<C>,
                ) => ReturnType<Command<A, R, C>['invoke']>;
                const invocation = call(options.args(input.value), options.call);
                void invocation?.result.catch(failed);
            } catch (error) {
                failed(error);
            }
        };
        const failed = (error: unknown) => {
            if (!(error instanceof OperationCancelled)) reportObserverError(options.onError ?? reportError, error);
        };
        if (!scope.signal.aborted) target.node.on(Button.EventType.CLICK, clicked);
        return { dispose: () => scope.close() };
    }
}
