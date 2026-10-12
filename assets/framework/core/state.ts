import { FrameworkError, invariant, OperationCancelled, type ErrorReporter, reportError } from './errors';
import type { Lifetime } from './scope';

/** 递归只读的数据快照。状态只接受普通对象、数组和原始值，不持有节点、资源或服务。 */
export type Snapshot<T> = T extends readonly (infer U)[]
    ? readonly Snapshot<U>[]
    : T extends object
      ? { readonly [K in keyof T]: Snapshot<T[K]> }
      : T;

/** ViewModel 对外的状态入口；订阅立即收到当前快照，取消所有者时同步解绑。 */
export interface ReadonlyState<T> {
    /** 最近一次已提交的不可变快照。 */
    readonly value: Snapshot<T>;
    /**
     * 同步通知；先完成派生计算，再通知观察者。批内与重入的待通知写入合并为最新值。
     * 异常订阅被移除并单独上报，不回滚已提交状态。
     * 回调必须同步；异步渲染使用 StateBindings.prepare。
     */
    subscribe(owner: Lifetime, listener: (value: Snapshot<T>) => void, onError?: ErrorReporter): () => void;
}

type Listener<T> = {
    version: number;
    active: boolean;
    notify: (value: Snapshot<T>, version: number) => void;
    fail: (error: unknown) => void;
    stop: () => void;
};
const snapshots = new WeakSet<object>();

/** 复制并冻结可传递的数据；不接受资源、服务、函数或循环引用。 */
export function snapshot<T>(value: T, visiting = new Set<object>()): Snapshot<T> {
    if (typeof value === 'function' || typeof value === 'symbol')
        throw new FrameworkError('STATE_NOT_DATA', 'State accepts data, not functions or symbols');
    if (!value || typeof value !== 'object') return value as Snapshot<T>;
    if (snapshots.has(value)) return value as Snapshot<T>;
    if (visiting.has(value)) throw new FrameworkError('STATE_CYCLE', 'State must not contain cycles');
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new FrameworkError('STATE_NOT_DATA', 'Keep nodes, resources and services outside state');
    visiting.add(value);
    const copy = Array.isArray(value)
        ? value.map((item) => snapshot(item, visiting))
        : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, visiting)]));
    visiting.delete(value);
    Object.freeze(copy);
    snapshots.add(copy);
    return copy as Snapshot<T>;
}

type GraphNode = {
    dependents: Set<DerivedNode>;
    read(): unknown;
};
type DerivedNode = GraphNode & { invalidate(): void; settle(): void };
const graph = new WeakMap<object, GraphNode>();
const dirty = new Set<DerivedNode>();
const notifications = new Map<object, () => void>();
let batching = 0;
let dispatching = false;
let calculating = 0;

function flush(): void {
    if (batching || dispatching || calculating) return;
    dispatching = true;
    try {
        while (dirty.size || notifications.size) {
            for (const node of Array.from(dirty)) node.settle();
            const wave = Array.from(notifications.values());
            notifications.clear();
            for (const notify of wave) notify();
        }
    } finally {
        dispatching = false;
    }
}

/** 同步合并通知，嵌套批次在最外层结束时刷新；不是业务事务，抛错不撤回已经写入的数据。 */
export function batch<T>(work: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
    invariant(!calculating, 'STATE_WRITE_IN_DERIVE', 'Derived calculations must be pure');
    batching++;
    try {
        const result = work();
        synchronousStateEffect(result);
        return result;
    } finally {
        batching--;
        flush();
    }
}

/** @internal 隔离观察者与错误处理器，不能把已完成的业务提交伪装成失败。 */
export function reportObserverError(report: ErrorReporter, error: unknown): void {
    try {
        report(error);
    } catch (cause) {
        reportError(cause);
    }
}

/** @internal void 回调的 TypeScript 类型也能接收 async 函数，运行时拒绝这种误用。 */
export function synchronousStateEffect(result: unknown): void {
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch(reportError);
        throw new FrameworkError('STATE_ASYNC_EFFECT', 'Use bindings.prepare for asynchronous rendering');
    }
}

/**
 * ViewModel 私有的写入口。通过 readonly 向 View 提供读取和订阅，业务操作用 set/update 提交。
 * set 复制并冻结新数据；update 可复用已有快照的分支，让 selector 跳过无关更新。
 */
export class State<T> {
    /** 不包含写权限的稳定入口。 */
    readonly readonly: ReadonlyState<T>;
    private value: Snapshot<T>;
    private version = 0;
    private readonly listeners = new Set<Listener<T>>();
    private readonly node: GraphNode;
    private failure?: { error: unknown };
    private ended = false;

    /** @param initial 首份语义数据，不包含 Cocos 对象或有副作用的 getter。 */
    constructor(initial: T, read?: () => void) {
        this.value = snapshot(initial);
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const state = this;
        this.readonly = Object.freeze({
            get value() {
                invariant(
                    !calculating,
                    'STATE_READ_IN_DERIVE',
                    'Use declared input values inside derived calculations',
                );
                read?.();
                if (state.failure) throw state.failure.error;
                return state.value;
            },
            subscribe: (owner: Lifetime, listener: (value: Snapshot<T>) => void, onError = reportError) =>
                state.subscribe(owner, listener, onError),
        });
        this.node = { dependents: new Set(), read: () => this.readonly.value };
        graph.set(this.readonly, this.node);
    }

    /** 提交完整快照；通知失败不改变该次提交的成功结果。 */
    set(next: T | Snapshot<T>): void {
        invariant(!calculating, 'STATE_WRITE_IN_DERIVE', 'Derived calculations must be pure');
        this.publish(next);
        flush();
    }

    /** @internal 派生图提交已经完成的同步计算。 */
    publish(next: T | Snapshot<T>): void {
        const value = snapshot(next) as Snapshot<T>;
        if (Object.is(this.value, value)) return;
        this.value = value;
        const version = ++this.version;
        for (const dependent of this.node.dependents) dependent.invalidate();
        notifications.set(this, () => {
            for (const listener of Array.from(this.listeners)) listener.notify(value, version);
        });
    }

    /** @internal 派生失败使后续读取抛错，隔离并停止观察者。 */
    fail(error: unknown): void {
        this.failure = { error };
        for (const dependent of this.node.dependents) dependent.invalidate();
        notifications.set(this, () => {
            for (const listener of Array.from(this.listeners)) listener.fail(error);
        });
    }

    /** @internal 派生的期限结束时同步停止全部观察者，最后数据仍可读取。 */
    stop(): void {
        this.ended = true;
        notifications.delete(this);
        for (const listener of Array.from(this.listeners)) listener.stop();
    }

    /** 根据最近快照同步构造下一份状态；reducer 抛错时不会提交。 */
    update(reducer: (current: Snapshot<T>) => T | Snapshot<T>): void {
        this.set(reducer(this.value));
    }

    private subscribe(owner: Lifetime, callback: (value: Snapshot<T>) => void, report: ErrorReporter): () => void {
        owner.signal.throwIfAborted();
        if (this.ended) throw new OperationCancelled('Derived state owner ended');
        let detach = () => {};
        const off = () => {
            listener.active = false;
            this.listeners.delete(listener);
            detach();
        };
        const listener: Listener<T> = {
            version: -1,
            active: true,
            stop: off,
            fail: (error) => {
                off();
                reportObserverError(report, error);
            },
            notify: (value, version) => {
                if (!listener.active || version <= listener.version) return;
                listener.version = version;
                try {
                    synchronousStateEffect(callback(value));
                } catch (error) {
                    listener.fail(error);
                }
            },
        };
        this.listeners.add(listener);
        detach = owner.signal.onAbort(off);
        batching++;
        try {
            listener.notify(this.readonly.value, this.version);
        } catch (error) {
            listener.fail(error);
        } finally {
            batching--;
            flush();
        }
        return off;
    }
}

/** 显式列出依赖的纯同步派生；默认 Object.is，可为集合提供语义比较。 */
export interface DeriveOptions<T> {
    /** 相等时保留前一快照及引用，不通知下游渲染。 */
    readonly equals?: (previous: Snapshot<T>, next: Snapshot<T>) => boolean;
    /** 后续计算失败时停止该派生并上报；首次计算失败直接抛给创建方。 */
    readonly onError?: ErrorReporter;
}
type SourceValues<S extends readonly ReadonlyState<unknown>[]> = {
    [K in keyof S]: S[K] extends ReadonlyState<infer V> ? Snapshot<V> : never;
};

/**
 * 创建随 owner 结束的派生状态。依赖在创建时固定，只接受框架 State/derive，天然形成有向无环图。
 * 同一轮更新先稳定全部派生，再通知 View；计算内禁止写状态或返回 Promise。
 * owner 结束保留最后快照；计算失败后读取抛错、下游停止，重试须重新创建。
 */
export function derive<const S extends readonly ReadonlyState<unknown>[], T>(
    owner: Lifetime,
    sources: S,
    calculate: (...values: SourceValues<S>) => T & (T extends PromiseLike<unknown> ? never : unknown),
    options: DeriveOptions<T> = {},
): ReadonlyState<T> {
    owner.signal.throwIfAborted();
    const dependencies = sources.map((source) => {
        const node = graph.get(source);
        invariant(node, 'STATE_SOURCE_INVALID', 'derive requires framework states');
        return node;
    });
    const compute = (): T => {
        const values = dependencies.map((node) => node.read());
        calculating++;
        try {
            const invoke = calculate as (...values: unknown[]) => T;
            const next = invoke(...Array.from(values));
            synchronousStateEffect(next);
            return next;
        } finally {
            calculating--;
        }
    };
    const initial = compute();
    let active = true,
        stale = false,
        settling = false;
    const state = new State(initial, () => node.settle());
    const base = graph.get(state.readonly)!;
    const disconnect = () => {
        active = false;
        dirty.delete(node);
        for (const source of dependencies) source.dependents.delete(node);
    };
    const node: DerivedNode = {
        ...base,
        invalidate() {
            if (!active || stale || settling) return;
            stale = true;
            dirty.add(node);
            for (const dependent of node.dependents) dependent.invalidate();
        },
        settle() {
            if (!active || !stale) return;
            invariant(!settling, 'STATE_DERIVE_CYCLE', 'Derived state cannot read itself');
            settling = true;
            dirty.delete(node);
            stale = false;
            try {
                const next = snapshot(compute());
                const previous = state.readonly.value;
                let equal: boolean;
                calculating++;
                try {
                    equal = (options.equals ?? Object.is)(previous, next);
                } finally {
                    calculating--;
                }
                if (!equal) state.publish(next);
            } catch (error) {
                disconnect();
                state.fail(error);
                reportObserverError(options.onError ?? reportError, error);
            } finally {
                settling = false;
            }
        },
    };
    graph.set(state.readonly, node);
    for (const source of dependencies) source.dependents.add(node);
    owner.signal.onAbort(() => {
        disconnect();
        state.stop();
    });
    return state.readonly;
}
