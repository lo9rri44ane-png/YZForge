import { invariant } from '../core/errors';
import { runTask, taskContext, type Lifetime, type Scope, type TaskContext } from '../core/scope';
import { State, type ReadonlyState, type Snapshot } from '../core/state';

/** 稳定业务身份；位置变化不改变身份。 */
export type ItemKey = string | number;

/** 同一次条目绑定中的最新数据和位置；异步视觉更新通过 bindings.prepare 提交。 */
export interface ItemState<T> {
    readonly data: T;
    readonly index: number;
}

/** 普通集合与虚拟列表共用的条目合同。模型状态由调用方持有，节点只借用它。 */
export interface ItemContext<T> extends TaskContext {
    readonly key: ItemKey;
    readonly state: ReadonlyState<ItemState<T>>;
    run<R>(work: (task: TaskContext) => R | Promise<R>): Promise<R>;
}

/** @internal 一次业务身份绑定；资源准备代次是它的子级，数据更新不结束此期限。 */
export class ItemBinding<T> {
    readonly scope: Scope;
    readonly context: ItemContext<T>;
    private readonly state: State<ItemState<T>>;
    private input: T | Snapshot<T>;

    constructor(owner: Lifetime, key: ItemKey, data: T | Snapshot<T>, index: number, current = () => true) {
        this.scope = owner.child(`item:${key}`);
        this.input = data;
        this.state = new State<ItemState<T>>({ data: data as T, index });
        this.context = Object.freeze({
            ...taskContext(this.scope, current),
            key,
            state: this.state.readonly,
            run: <R>(work: (task: TaskContext) => R | Promise<R>) => runTask(this.scope, work, current, 'item:work'),
        });
    }

    update(data: T | Snapshot<T>, index: number): void {
        this.scope.signal.throwIfAborted();
        if (this.input === data && this.state.readonly.value.index === index) return;
        this.input = data;
        this.state.set({ data: data as T, index });
    }
}

/** @internal 先校验整个集合，非法身份不改变当前显示。 */
export function itemKeys<T>(items: readonly T[], key: (data: T) => ItemKey): ItemKey[] {
    const seen = new Set<ItemKey>();
    return items.map((data) => {
        const id = key(data);
        invariant(
            typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)),
            'ITEM_KEY_INVALID',
            '条目 Key 必须是字符串或有限数值',
        );
        invariant(!seen.has(id), 'ITEM_KEY_DUPLICATE', `重复条目 Key：${id}`);
        seen.add(id);
        return id;
    });
}
