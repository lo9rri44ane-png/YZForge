import { Actions } from '../../../../../../framework/core/actions';
import { OperationCancelled, invariant } from '../../../../../../framework/core/errors';
import { runTask, type Lifetime, type Scope } from '../../../../../../framework/core/scope';
import { State } from '../../../../../../framework/core/state';
import type { ViewResult } from '../../../../../../framework/ui/ui-manager';
import type { TasksRow } from '../../../contracts/generated/config/Tasks.types';
import type { TaskCardModel } from '../../../contracts/workflow';
import type { TaskService } from '../../services/TaskService';

/** 一次性交互通过端口请求，不存入会被重复订阅的状态。 */
export interface WorkflowEffects {
    /** 皮肤/宿主负责打开确认界面；必须保留失败与取消的区别，并遵守传入期限。 */
    confirm(card: TaskCardModel, owner: Lifetime): Promise<ViewResult<boolean>>;
}
/** 语义反馈由皮肤本地化、排版；不携带 Label、预制体路径或预拼接的页面文本。 */
export interface WorkflowFeedback {
    readonly code:
        | 'intro'
        | 'trained'
        | 'failure-armed'
        | 'reloaded'
        | 'cancelled'
        | 'granted'
        | 'duplicate'
        | 'error'
        | 'confirmation-failed';
    readonly message?: string;
    readonly cleanupPending?: boolean;
}
/** 可供卡片、紧凑列表等多种布局使用的展示状态。 */
export interface WorkflowState {
    readonly cards: readonly TaskCardModel[];
    readonly progress: number;
    readonly coins: number;
    readonly selectedId: number | undefined;
    readonly loading: boolean;
    readonly claiming: boolean;
    readonly feedback: WorkflowFeedback;
}

/**
 * 每次展示默认创建一份 ViewModel；复用实现，共享领域状态交给 TaskService。
 * 显式共享实例时，传入外部流程期限；每个 View 仍独立拥有自己的 bindings 和显示资源。
 */
export class WorkflowPageViewModel {
    private readonly data = new State<WorkflowState>({
        cards: [],
        progress: 0,
        coins: 0,
        selectedId: undefined,
        loading: true,
        claiming: false,
        feedback: { code: 'intro' },
    });
    /** 对外只有读取和订阅权限；输入通过明确命名的方法调用。 */
    readonly state = this.data.readonly;
    private readonly scope: Scope;
    private readonly actions: Actions;
    private rows: readonly TasksRow[] = [];
    private started?: Promise<void>;

    /** Service 和一次性交互是显式依赖；ViewModel 不保存 show、节点或渲染 Port。 */
    constructor(
        private readonly service: TaskService,
        owner: Lifetime,
        private readonly effects: WorkflowEffects,
    ) {
        this.scope = owner.child('view-model:workflow');
        this.actions = new Actions(this.scope);
    }

    /** 首次初始化失败交给界面准备屏障；重复调用共享同一任务和订阅。 */
    start(): Promise<void> {
        this.started ??= runTask(
            this.scope,
            async (task) => {
                this.rows = await this.service.load(task.scope);
                task.signal.throwIfAborted();
                this.data.update((s) => ({ ...s, loading: false }));
                this.service.subscribe(() => this.refresh(), this.scope);
            },
            undefined,
            'workflow-init',
        );
        return this.started;
    }

    /** 选择只属于本展示实例，不改变领域存档或其他皮肤的局部选择。 */
    select(id: number): void {
        this.scope.signal.throwIfAborted();
        invariant(
            this.rows.some((row) => row.id === id),
            'DEMO_TASK_UNKNOWN',
            '任务不存在',
        );
        this.data.update((s) => ({ ...s, selectedId: id }));
    }

    /** 同步业务失败转为可重试反馈；渲染订阅错误不会进入此业务 catch。 */
    train(): void {
        this.scope.signal.throwIfAborted();
        try {
            this.service.train();
        } catch (error) {
            this.feedback({ code: 'error', message: String(error) });
            return;
        }
        this.feedback({ code: 'trained' });
    }

    /** 示例故障注入，不属于渲染逻辑。 */
    failNext(): void {
        this.scope.signal.throwIfAborted();
        this.service.simulateFailure();
        this.feedback({ code: 'failure-armed' });
    }

    /** 连续查询只接受最后一次结果；取消不显示为失败。 */
    async reload(): Promise<void> {
        await this.actions.latest('reload', async (task) => {
            task.commit(() => this.data.update((s) => ({ ...s, loading: true })));
            try {
                const rows = await this.service.load(task.scope);
                task.commit(() => {
                    this.rows = rows;
                    this.feedback({ code: 'reloaded' });
                });
            } catch (error) {
                if (error instanceof OperationCancelled) throw error;
                task.commit(() => this.feedback({ code: 'error', message: String(error) }));
            } finally {
                task.commit(() => this.data.update((s) => ({ ...s, loading: false })));
            }
        });
    }

    /** 确认前不写业务；同一实例重复点击被合并，Service 再执行领域校验和幂等提交。 */
    async claim(id: number): Promise<void> {
        await this.actions.exclusive('claim', async (task) => {
            const card = this.state.value.cards.find((item) => item.id === id);
            invariant(card, 'DEMO_TASK_UNKNOWN', '任务不存在');
            task.commit(() => this.data.update((s) => ({ ...s, claiming: true, selectedId: id })));
            // 锁持续覆盖确认界面的物理清理，而不只覆盖 result 的提前交付。
            task.scope.defer(() => {
                if (!this.scope.signal.aborted)
                    this.data.update((s) => ({
                        ...s,
                        claiming: false,
                        feedback: s.feedback.cleanupPending ? { ...s.feedback, cleanupPending: false } : s.feedback,
                    }));
            });
            let result: ViewResult<boolean>;
            try {
                result = await this.effects.confirm(card, task.scope);
            } catch (error) {
                if (error instanceof OperationCancelled) throw error;
                task.commit(() =>
                    this.feedback({ code: 'confirmation-failed', message: String(error), cleanupPending: false }),
                );
                return;
            }
            task.signal.throwIfAborted();
            if (result.status === 'failed') {
                task.commit(() =>
                    this.feedback({
                        code: 'confirmation-failed',
                        message: String(result.error),
                        cleanupPending: result.cleanupPending,
                    }),
                );
                return;
            }
            if (result.status !== 'completed' || !result.value) {
                task.commit(() => this.feedback({ code: 'cancelled' }));
                return;
            }
            let granted: boolean;
            try {
                granted = this.service.claim(id);
            } catch (error) {
                task.commit(() => this.feedback({ code: 'error', message: String(error) }));
                return;
            }
            task.commit(() => this.feedback({ code: granted ? 'granted' : 'duplicate' }));
        });
    }

    /** 提前结束自己创建的实例；一般由传入的显示/流程期限自动回收。 */
    dispose(): Promise<void> {
        return this.scope.close();
    }

    private feedback(feedback: WorkflowFeedback): void {
        this.data.update((s) => ({ ...s, feedback }));
        this.refresh();
    }
    private refresh(): void {
        if (this.scope.signal.aborted) return;
        const snapshot = this.service.snapshot(),
            cards = this.service.cards(this.rows),
            previous = this.state.value;
        const equalCards =
            cards.length === previous.cards.length &&
            cards.every((card, index) => {
                const other = previous.cards[index];
                return (
                    card.id === other.id &&
                    card.title === other.title &&
                    card.progress === other.progress &&
                    card.goal === other.goal &&
                    card.reward === other.reward &&
                    card.state === other.state
                );
            });
        const selectedId = cards.some((card) => card.id === previous.selectedId) ? previous.selectedId : cards[0]?.id;
        if (
            equalCards &&
            snapshot.progress === previous.progress &&
            snapshot.coins === previous.coins &&
            selectedId === previous.selectedId
        )
            return;
        this.data.update((s) => ({ ...s, ...snapshot, cards: equalCards ? s.cards : cards, selectedId }));
    }
}
