import { OperationCancelled, type ErrorReporter, reportError } from './errors';
import { untilCancelled } from './cancellation';
import { runTask, type Lifetime, type Scope, type TaskContext } from './scope';
import { State, type ReadonlyState, type Snapshot, reportObserverError, synchronousStateEffect } from './state';
import { claimProperties } from './property-lease';
import { Preparation } from './preparation';

/** 一块显示区域的准备屏障和控制入口。资源归绑定所有，不归 ViewModel 或短期 Actions 所有。 */
export interface StateBinding {
    /** 等待读取此属性时及等待期间的最新代次；关闭立即拒绝为取消。 */
    readonly ready: Promise<void>;
    /** 重新准备当前值，可用于显示资源失败后的重试。 */
    refresh(): void;
    /** 同步停止订阅和回写，等待本绑定实际工作结束后释放资源；不能在自己的 prepare 中等待。 */
    dispose(): Promise<void>;
}

/** 已实际交接到画面的纯数据。输入绑定到此状态，准备期间仍对应旧画面。 */
export type PresentedValue<T> = { readonly ready: false } | { readonly ready: true; readonly value: T };
export interface PresentedBinding<T> extends StateBinding {
    readonly state: ReadonlyState<PresentedValue<T>>;
}

/** 同步绑定的选择规则。选择值使用 Object.is 比较；对象分支应复用不可变快照。 */
export interface WatchOptions<T> {
    /** 声明这块渲染独占的属性；重叠绑定明确报错，dispose/owner 结束同步归还。 */
    readonly writes?: readonly (readonly [object, PropertyKey])[];
    /** 用于诊断的区域名称。 */
    readonly label?: string;
    /** 显式比较选中的值，避免无关状态改变导致重复渲染。 */
    readonly equals?: (previous: T, next: T) => boolean;
}

/** 异步准备只创建待显示内容；render 同步交接，成功后才释放旧内容。 */
export interface PrepareBinding<T, Prepared> extends WatchOptions<T> {
    /** 用 stage.scope 持有候选资源，检查 signal；不要在准备阶段修改当前画面。 */
    readonly prepare: (value: T, stage: TaskContext) => Prepared | Promise<Prepared>;
    /** 同步替换画面；previous 是仍持有资源的上一份内容，返回后由框架释放。 */
    readonly render: (prepared: Prepared, value: T, previous: Prepared | undefined) => void;
    /** 默认 true：首份内容参与界面准备屏障；false 用于可独立显示占位的区域。 */
    readonly required?: boolean;
    /** 准备失败时保留旧内容并通知此回调。首份必需内容仍会使 ready 失败；渲染错误走宿主故障通道。 */
    readonly onError?: ErrorReporter;
}

type Stage<T> = { scope: Scope; prepared?: T; retiring?: boolean };

/**
 * 一次显示/激活的状态绑定集合。业务使用 show.bindings 或 activation.bindings。
 * 也可给外部流程单独创建；不拥有或关闭传入的 ViewModel，多个皮肤可各自订阅。
 */
export class StateBindings {
    /** @internal 组合区域接入此准备树；业务使用 ready。 */
    readonly preparation: Preparation;
    private preparing = true;

    /** @param fault 渲染错误的宿主故障处理器，与业务命令失败分开。 */
    constructor(
        protected readonly owner: Lifetime,
        protected readonly current: () => boolean = () => true,
        protected readonly fault: ErrorReporter = reportError,
    ) {
        this.preparation = new Preparation(owner);
    }

    /** 单向属性绑定；选择值未变化不写入，不能再为同一属性注册其他受管写入者。 */
    property<O extends object, K extends keyof O, S>(
        target: O,
        key: K,
        source: ReadonlyState<S>,
        select: (state: Snapshot<S>) => O[K],
    ): StateBinding {
        return this.watch(
            source,
            select,
            (value) => {
                target[key] = value;
            },
            { writes: [[target, key]], label: String(key) },
        );
    }

    /** 同步首绘和后续局部更新；不要返回 Promise，需要资源准备时使用 prepare。 */
    watch<S, T>(
        source: ReadonlyState<S>,
        select: (state: Snapshot<S>) => T,
        render: (value: T) => void,
        options: WatchOptions<T> = {},
    ): StateBinding {
        return this.connect(source, select, { ...options, render: (_prepared, value) => render(value) });
    }

    /** 最新代次才能交接；过期准备即使不响应取消，也持有资源直到它实际结束。 */
    prepare<S, T, P>(
        source: ReadonlyState<S>,
        select: (state: Snapshot<S>) => T,
        options: PrepareBinding<T, P>,
    ): StateBinding {
        return this.connect(source, select, options);
    }

    /** 与 prepare 相同的资源规则，并提供已显示快照用于按钮参数；选中值必须是纯数据。 */
    present<S, T, P>(
        source: ReadonlyState<S>,
        select: (state: Snapshot<S>) => T,
        options: PrepareBinding<T, P>,
    ): PresentedBinding<T> {
        const displayed = new State<PresentedValue<T>>({ ready: false });
        const binding = this.prepare(source, select, {
            ...options,
            render: (prepared, value, previous) => {
                synchronousStateEffect(options.render(prepared, value, previous));
                displayed.set({ ready: true, value });
            },
        });
        return Object.freeze({
            state: displayed.readonly,
            get ready() {
                return binding.ready;
            },
            refresh: binding.refresh,
            dispose: binding.dispose,
        });
    }

    /** 等待已注册的必需绑定；UIView 在 onShow 后自动调用，后加的绑定可单独等待其 ready。 */
    async ready(): Promise<void> {
        try {
            await this.preparation.ready();
        } finally {
            this.preparing = false;
        }
    }

    /** @internal 让组合区域参与同一首绘屏障，不再创建第二套页面准备调度器。 */
    protected include(preparation: Preparation, required = true): () => void {
        return required ? this.preparation.include(preparation) : () => {};
    }

    private connect<S, T, P>(
        source: ReadonlyState<S>,
        select: (state: Snapshot<S>) => T,
        options: Omit<PrepareBinding<T, P>, 'prepare'> & { prepare?: PrepareBinding<T, P>['prepare'] },
    ): StateBinding {
        const owner = this.owner.child(`binding:${options.label ?? 'state'}`);
        const preparation = new Preparation(owner.lifetime);
        const releases: (() => void)[] = [];
        try {
            for (const [target, key] of options.writes ?? []) releases.push(claimProperties(target, [key]));
        } catch (error) {
            for (const release of releases) release();
            void owner.close().catch(this.fault);
            throw error;
        }
        owner.signal.onAbort(() => {
            for (const release of releases) release();
        });
        let painted = false;
        let selected: T;
        let selectedOnce = false;
        let pending: Stage<P> | undefined;
        let displayed: Stage<P> | undefined;
        let rendering = false;
        let queued: { state: Snapshot<S>; force: boolean } | undefined;
        const active = () => !owner.signal.aborted && this.current();
        const fail = (error: unknown, preparing: boolean) => {
            if (error instanceof OperationCancelled || !active()) return;
            const initial = !painted;
            // 初始必需错误由 ready 交给宿主，避免在 onShow 准备栈内重入关闭。
            const report = preparing ? (options.onError ?? reportError) : this.fault;
            if (!initial || !this.preparing || options.required === false || (preparing && options.onError))
                reportObserverError(report, error);
        };
        const retire = (stage: Stage<P>) => {
            if (stage.retiring) return;
            stage.retiring = true;
            stage.scope.cancel();
            // 不在任务内等待自身关闭；宿主已取消时还要保留资源直到祖先实际工作结束。
            void stage.scope
                .drainCancelledTasks()
                .then(() => stage.scope.close())
                .catch((error) => reportObserverError(this.fault, error));
        };
        const rejectSource = (error: unknown) => {
            if (pending) {
                retire(pending);
                pending = undefined;
            }
            preparation.set(Promise.reject(error));
            fail(error, false);
        };
        const commit = (stage: Stage<P>, prepared: P, value: T) => {
            if (!active() || pending !== stage || stage.scope.signal.aborted) throw new OperationCancelled();
            rendering = true;
            try {
                synchronousStateEffect(options.render(prepared, value, displayed?.prepared));
                stage.prepared = prepared;
                const previous = displayed;
                displayed = stage;
                pending = undefined;
                painted = true;
                if (previous) retire(previous);
            } finally {
                rendering = false;
            }
            if (queued) {
                const next = queued;
                queued = undefined;
                update(next.state, next.force);
            }
        };
        const update = (state: Snapshot<S>, force = false) => {
            if (!active()) return;
            if (rendering) {
                queued = { state, force };
                return;
            }
            let value: T;
            try {
                value = select(state);
                if (!force && selectedOnce && (options.equals ?? Object.is)(selected, value)) return;
            } catch (error) {
                rejectSource(error);
                return;
            }
            selected = value;
            selectedOnce = true;
            if (!options.prepare) {
                preparation.set();
                rendering = true;
                try {
                    synchronousStateEffect(options.render(undefined as P, value, undefined));
                    painted = true;
                } catch (error) {
                    preparation.set(Promise.reject(error));
                    fail(error, false);
                } finally {
                    rendering = false;
                }
                if (queued) {
                    const next = queued;
                    queued = undefined;
                    update(next.state, next.force);
                }
                return;
            }
            if (pending) retire(pending);
            const stage: Stage<P> = { scope: owner.child('revision') };
            pending = stage;
            let preparing = true;
            const physical = runTask(
                stage.scope,
                async (task) => {
                    const prepared = await options.prepare!(value, task);
                    preparing = false;
                    commit(stage, prepared, value);
                },
                () => active() && pending === stage,
                'prepare',
            );
            preparation.set(untilCancelled(physical, stage.scope.signal));
            void physical.then(
                () => {
                    if (displayed !== stage) retire(stage);
                },
                (error) => {
                    if (pending === stage) {
                        pending = undefined;
                        fail(error, preparing);
                    }
                    retire(stage);
                },
            );
        };
        try {
            source.subscribe(owner.lifetime, (state) => update(state), rejectSource);
        } catch (error) {
            void owner.close().catch((cause) => reportObserverError(this.fault, cause));
            throw error;
        }
        const remove = this.include(preparation, options.required !== false);
        const binding = Object.freeze({
            get ready() {
                return preparation.ready();
            },
            refresh: () => update(source.value, true),
            dispose: () => {
                remove();
                owner.cancel();
                return owner.drainCancelledTasks().then(() => owner.close());
            },
        });
        return binding;
    }
}
