import { FrameworkError, type ErrorReporter, reportError } from './errors';
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
     * 同步顺序通知；重入写入排在当前通知之后。异常订阅被移除并单独上报，不回滚已提交状态。
     * 回调必须同步；异步渲染使用 StateBindings.prepare。
     */
    subscribe(owner: Lifetime, listener: (value: Snapshot<T>) => void, onError?: ErrorReporter): () => void;
}

type Listener<T> = { version: number; active: boolean; notify: (value: Snapshot<T>, version: number) => void };
const snapshots = new WeakSet<object>();

function snapshot<T>(value: T, visiting = new Set<object>()): Snapshot<T> {
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
    private dispatching = false;
    private readonly pending: { value: Snapshot<T>; version: number }[] = [];
    private readonly listeners = new Set<Listener<T>>();

    /** @param initial 首份语义数据，不包含 Cocos 对象或有副作用的 getter。 */
    constructor(initial: T) {
        this.value = snapshot(initial);
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const state = this;
        this.readonly = Object.freeze({
            get value() {
                return state.value;
            },
            subscribe: (owner: Lifetime, listener: (value: Snapshot<T>) => void, onError = reportError) =>
                state.subscribe(owner, listener, onError),
        });
    }

    /** 提交完整快照；通知失败不改变该次提交的成功结果。 */
    set(next: T | Snapshot<T>): void {
        const value = snapshot(next) as Snapshot<T>;
        if (Object.is(this.value, value)) return;
        this.value = value;
        this.pending.push({ value, version: ++this.version });
        this.flush();
    }

    private flush(): void {
        if (this.dispatching) return;
        this.dispatching = true;
        try {
            while (this.pending.length) {
                const item = this.pending.shift()!;
                for (const listener of Array.from(this.listeners)) listener.notify(item.value, item.version);
            }
        } finally {
            this.dispatching = false;
        }
    }

    /** 根据最近快照同步构造下一份状态；reducer 抛错时不会提交。 */
    update(reducer: (current: Snapshot<T>) => T | Snapshot<T>): void {
        this.set(reducer(this.value));
    }

    private subscribe(owner: Lifetime, callback: (value: Snapshot<T>) => void, report: ErrorReporter): () => void {
        owner.signal.throwIfAborted();
        let detach = () => {};
        const off = () => {
            listener.active = false;
            this.listeners.delete(listener);
            detach();
        };
        const listener: Listener<T> = {
            version: -1,
            active: true,
            notify: (value, version) => {
                if (!listener.active || version <= listener.version) return;
                listener.version = version;
                try {
                    synchronousStateEffect(callback(value));
                } catch (error) {
                    off();
                    reportObserverError(report, error);
                }
            },
        };
        this.listeners.add(listener);
        detach = owner.signal.onAbort(off);
        const dispatching = this.dispatching;
        this.dispatching = true;
        listener.notify(this.value, this.version);
        this.dispatching = dispatching;
        this.flush();
        return off;
    }
}
