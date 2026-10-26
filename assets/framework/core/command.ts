import { invariant, OperationCancelled, type ErrorReporter } from './errors';
import { runTask, type Lifetime, type Scope, type TaskContext } from './scope';
import { batch, snapshot, State, reportObserverError, type ReadonlyState, type Snapshot } from './state';

/** 一次调用的逻辑结果与实际清理分别推进；cleaning 包含取消后仍未退出的工作。 */
export interface InvocationState {
    /** 排队、执行、等待退出与清理、全部完成。 */
    readonly phase: 'queued' | 'running' | 'cleaning' | 'completed';
    /** 结果已经交付后不会被清理失败覆盖。 */
    readonly outcome: 'pending' | 'succeeded' | 'failed' | 'cancelled';
}
/** 操作汇总状态，包含 latest 已替换但仍在退出的旧调用。 */
export interface CommandState {
    /** 尚未完成实际清理的调用总数。 */
    readonly pending: number;
    /** 尚在排队的调用数。 */
    readonly queued: number;
    /** 仍在正常执行的调用数。 */
    readonly running: number;
    /** 已交付结果或取消，仍在退出和清理的调用数。 */
    readonly cleaning: number;
    /** 是否有未完成调用；接收新调用还须结合策略与 key 判断。 */
    readonly busy: boolean;
}
/** 一个具体调用；result 与 completed 独立表达业务结果与实际清理。 */
export interface CommandInvocation<R> {
    /** 尽早交付本次结果、业务错误或取消。 */
    readonly result: Promise<R>;
    /** 等待实际工作及全部清理；不会用清理错误替换 result。 */
    readonly completed: Promise<void>;
    /** 本次调用的只读状态。 */
    readonly state: ReadonlyState<InvocationState>;
    /** 取消等待与后续提交；不会撤回已经发生的业务写入。 */
    cancel(): void;
}
/** 参数是数据快照，交互端口通过每次调用的 context 传入。 */
export interface CommandOptions<A, R, C> {
    /** 防重复、仅保留最新结果或有界串行队列。 */
    readonly policy: 'exclusive' | 'latest' | 'serial';
    /** 工作使用本次 context；长寿命模型不能保存显示上下文。 */
    readonly execute: (args: Snapshot<A>, task: TaskContext, context: C) => R | Promise<R>;
    /** 默认整项操作互斥；每个实体独立并行时显式返回实体 key。 */
    readonly key?: (args: Snapshot<A>) => string;
    /** serial 每个 key 的容量，含执行与清理，默认 32。 */
    readonly maxPending?: number;
    /** 独立清理错误报告，默认框架日志。 */
    readonly onCleanupError?: ErrorReporter;
}
/** 一次交互环境；owner 结束只取消本次调用，不销毁共享定义。 */
export interface CommandCall<C> {
    /** 本次显示或业务会话期限。 */
    readonly owner: Lifetime;
    /** 当前宿主的语义交互端口，不存入状态或参数快照。 */
    readonly context: C;
}
type Entry<R> = {
    key: string;
    scope: Scope;
    status: State<InvocationState>;
    handle: CommandInvocation<R>;
    start(): void;
};
/**
 * 模型拥有操作定义，按钮只借用；先更新准入再发布状态。
 * 取消立即交付，资源保留到工作实际退出；Service 负责幂等和已提交请求的对账。
 */
export class Command<A, R, C = void> {
    private readonly data = new State<CommandState>({ pending: 0, queued: 0, running: 0, cleaning: 0, busy: false });
    /** 多个皮肤和按钮共享同一执行状态。 */
    readonly state = this.data.readonly;
    private readonly entries = new Set<Entry<R>>();
    private readonly latest = new Map<string, Entry<R>>();
    private readonly options: CommandOptions<A, R, C>;
    /** owner 是定义的使用期；不隐式查找 Service 或 UI。 */
    constructor(
        private readonly owner: Lifetime,
        options: CommandOptions<A, R, C>,
    ) {
        owner.signal.throwIfAborted();
        invariant(
            options.maxPending === undefined || (Number.isSafeInteger(options.maxPending) && options.maxPending > 0),
            'ACTION_LIMIT_INVALID',
            'Command capacity must be a positive integer',
        );
        this.options = Object.freeze({ ...options });
    }
    /** 只读准入查询；不能代替 invoke 的原子准入判断。 */
    canRun(args: A | Snapshot<A>): boolean {
        if (this.owner.signal.aborted) return false;
        const key = this.options.key?.(args as Snapshot<A>) ?? '';
        const count = Array.from(this.entries).filter((entry) => entry.key === key).length;
        return (
            this.options.policy === 'latest' ||
            count < (this.options.policy === 'exclusive' ? 1 : (this.options.maxPending ?? 32))
        );
    }
    /** 同步捕获参数；exclusive 重复返回 undefined，serial 满时抛错。有交互端口时必须提供 call。 */
    invoke(
        args: A | Snapshot<A>,
        ...calls: [C] extends [void] ? [call?: CommandCall<C>] : [call: CommandCall<C>]
    ): CommandInvocation<R> | undefined {
        return this.begin(args, calls[0]);
    }
    private begin(args: A | Snapshot<A>, call?: CommandCall<C>): CommandInvocation<R> | undefined {
        this.owner.signal.throwIfAborted();
        const caller = call?.owner ?? this.owner;
        caller.signal.throwIfAborted();
        const captured = snapshot(args) as Snapshot<A>;
        const key = this.options.key?.(captured) ?? '';
        const previous = Array.from(this.entries).filter((entry) => entry.key === key);
        if (this.options.policy === 'exclusive' && previous.length) return undefined;
        invariant(
            this.options.policy !== 'serial' || previous.length < (this.options.maxPending ?? 32),
            'ACTION_QUEUE_FULL',
            `Command queue is full: ${key}`,
        );
        const scope = caller.child(`command:${key || this.options.policy}`);
        const status = new State<InvocationState>({ phase: 'queued', outcome: 'pending' });
        let resolve!: (value: R) => void, reject!: (error: unknown) => void;
        let resolveDone!: () => void, rejectDone!: (error: unknown) => void;
        const result = new Promise<R>((yes, no) => {
            resolve = yes;
            reject = no;
        });
        const completed = new Promise<void>((yes, no) => {
            resolveDone = yes;
            rejectDone = no;
        });
        void result.catch(() => {});
        void completed.catch((error) => reportObserverError(this.options.onCleanupError ?? scope.report, error));
        let settled = false,
            started = false,
            closing = false;
        const deliver = (outcome: InvocationState['outcome'], value: unknown) => {
            if (settled) return;
            settled = true;
            if (outcome === 'succeeded') resolve(value as R);
            else reject(value);
            batch(() => {
                status.set({ phase: 'cleaning', outcome });
                this.publish();
            });
        };
        const finish = async () => {
            if (closing) return;
            closing = true;
            let failure: { error: unknown } | undefined;
            try {
                await scope.close();
            } catch (error) {
                failure = { error };
            }
            this.entries.delete(entry);
            if (this.latest.get(key) === entry) this.latest.delete(key);
            detach();
            unown();
            batch(() => {
                status.set({ ...status.readonly.value, phase: 'completed' });
                this.publish();
            });
            if (failure) rejectDone(failure.error);
            else resolveDone();
            this.advance(key);
        };
        const current = () =>
            !settled &&
            !this.owner.signal.aborted &&
            (this.options.policy !== 'latest' || this.latest.get(key) === entry);
        const entry: Entry<R> = {
            key,
            scope,
            status,
            handle: Object.freeze({ result, completed, state: status.readonly, cancel: () => scope.cancel() }),
            start: () => {
                if (started || closing) return;
                if (scope.signal.aborted) {
                    void finish();
                    return;
                }
                started = true;
                // 先登记工作，避免同步状态观察者关闭 caller 时越过屏障。
                const physical = runTask(
                    scope,
                    async (task) => {
                        const value = await this.options.execute(captured, task, call?.context as C);
                        task.signal.throwIfAborted();
                        return value;
                    },
                    current,
                    'command',
                );
                batch(() => {
                    status.set({ phase: 'running', outcome: 'pending' });
                    this.publish();
                });
                void physical
                    .then(
                        (value) => deliver('succeeded', value),
                        (error: unknown) =>
                            deliver(error instanceof OperationCancelled ? 'cancelled' : 'failed', error),
                    )
                    .then(finish);
            },
        };
        this.entries.add(entry);
        const replaced = this.latest.get(key);
        this.latest.set(key, entry);
        const detach = this.owner.signal.onAbort(() => scope.cancel());
        const unown = this.owner.defer(() => completed);
        scope.signal.onAbort((error) => {
            deliver('cancelled', error);
            if (!started) void finish();
        });
        if (this.options.policy === 'latest') replaced?.scope.cancel(new OperationCancelled('Command replaced'));
        if (this.options.policy !== 'serial' || !previous.length) entry.start();
        else this.publish();
        return entry.handle;
    }
    /** 只等待逻辑结果；实际清理继续由调用与定义两个 owner 持有。 */
    run(
        args: A | Snapshot<A>,
        ...calls: [C] extends [void] ? [call?: CommandCall<C>] : [call: CommandCall<C>]
    ): Promise<R | undefined> {
        return this.begin(args, calls[0])?.result ?? Promise.resolve(undefined);
    }
    private advance(key: string): void {
        if (this.options.policy !== 'serial') return;
        const entries = Array.from(this.entries).filter((entry) => entry.key === key);
        if (entries.some((entry) => entry.status.readonly.value.phase !== 'queued')) return;
        entries[0]?.start();
    }
    private publish(): void {
        const entries = Array.from(this.entries);
        this.data.set({
            pending: entries.length,
            busy: entries.length > 0,
            queued: entries.filter((entry) => entry.status.readonly.value.phase === 'queued').length,
            running: entries.filter((entry) => entry.status.readonly.value.phase === 'running').length,
            cleaning: entries.filter((entry) => entry.status.readonly.value.phase === 'cleaning').length,
        });
    }
}
