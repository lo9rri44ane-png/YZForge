import { Command } from '../../../../../framework/core/command';
import { OperationCancelled, invariant } from '../../../../../framework/core/errors';
import { runTask, type Lifetime, type Scope } from '../../../../../framework/core/scope';
import { State, derive, type ReadonlyState } from '../../../../../framework/core/state';
import type { TasksRow } from '../../contracts/generated/config/Tasks.types';
import type { TaskCardModel } from '../../contracts/workflow';
import type { TaskService } from '../services/TaskService';

/** 每次交互由当前皮肤提供；确认失败抛错、玩家取消返回 false，资源归传入期限。 */
export interface WorkflowInteraction {
    confirm(card: TaskCardModel, owner: Lifetime): Promise<boolean>;
}
/** 语义反馈由皮肤本地化和排版。 */
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
/** 从领域事实、局部选择和操作状态派生，不手动维护重复的 busy/cleanup 标记。 */
export interface WorkflowState {
    readonly cards: readonly TaskCardModel[];
    readonly progress: number;
    readonly coins: number;
    readonly selectedId: number | undefined;
    readonly loading: boolean;
    readonly claiming: boolean;
    readonly feedback: WorkflowFeedback;
}
/** 页面会话内复用；不保存 show、UI 返回协议或节点，也不拥有皮肤资源。 */
export class WorkflowPageViewModel {
    private readonly rows = new State<readonly TasksRow[]>([]);
    private readonly selected = new State<number | undefined>(undefined);
    private readonly message = new State<WorkflowFeedback>({ code: 'intro' });
    private readonly initialized = new State(false);
    private readonly scope: Scope;
    private started?: Promise<void>;
    /** 两种皮肤共用的只读展示状态。 */
    readonly state: ReadonlyState<WorkflowState>;
    /** 整个领取流程互斥，包含确认和实际清理；每次传入当前显示的交互端口。 */
    readonly claim: Command<TaskCardModel, void, WorkflowInteraction>;
    /** 刷新仅提交最新请求，资源由这次模型会话持有。 */
    readonly reload: Command<void, void>;
    /** 依赖由页面工厂显式组合。 */
    constructor(
        private readonly service: TaskService,
        owner: Lifetime,
    ) {
        this.scope = owner.child('view-model:workflow');
        this.claim = new Command(this.scope, {
            policy: 'exclusive',
            execute: async (card, task, interaction) => {
                task.commit(() => this.selected.set(card.id));
                let confirmed: boolean;
                try {
                    confirmed = await interaction.confirm(card, task.scope);
                } catch (error) {
                    if (error instanceof OperationCancelled) throw error;
                    task.commit(() => this.message.set({ code: 'confirmation-failed', message: String(error) }));
                    return;
                }
                task.signal.throwIfAborted();
                if (!confirmed) {
                    task.commit(() => this.message.set({ code: 'cancelled' }));
                    return;
                }
                try {
                    const granted = service.claim(card.id);
                    task.commit(() => this.message.set({ code: granted ? 'granted' : 'duplicate' }));
                } catch (error) {
                    task.commit(() => this.message.set({ code: 'error', message: String(error) }));
                }
            },
        });
        this.reload = new Command(this.scope, {
            policy: 'latest',
            execute: async (_args, task) => {
                try {
                    // 返回的是纯规则快照；加载持有随页面会话回收。
                    const rows = await service.load(task.scope);
                    task.commit(() => {
                        this.rows.set(rows);
                        this.message.set({ code: 'reloaded' });
                    });
                } catch (error) {
                    if (error instanceof OperationCancelled) throw error;
                    task.commit(() => this.message.set({ code: 'error', message: String(error) }));
                }
            },
        });
        const cards = derive(
            this.scope,
            [this.rows.readonly, service.state],
            (rows, facts) => service.cards(rows, facts),
            {
                equals: (a, b) =>
                    a.length === b.length &&
                    a.every((card, index) => {
                        const other = b[index];
                        return (
                            card.id === other.id &&
                            card.title === other.title &&
                            card.progress === other.progress &&
                            card.goal === other.goal &&
                            card.reward === other.reward &&
                            card.state === other.state
                        );
                    }),
            },
        );
        this.state = derive(
            this.scope,
            [
                cards,
                service.state,
                this.selected.readonly,
                this.message.readonly,
                this.initialized.readonly,
                this.claim.state,
                this.reload.state,
            ],
            (cards, facts, selected, message, initialized, claim, reload) => ({
                cards,
                progress: facts.progress,
                coins: facts.coins,
                selectedId: cards.some((card) => card.id === selected) ? selected : cards[0]?.id,
                loading: !initialized || reload.running > 0 || reload.queued > 0,
                claiming: claim.busy,
                feedback: { ...message, cleanupPending: message.code === 'confirmation-failed' && claim.cleaning > 0 },
            }),
        );
    }
    /** 明确的必需数据准备；调用方可 await，独立远程区域使用 required:false 的绑定。 */
    start(): Promise<void> {
        this.started ??= runTask(
            this.scope,
            async (task) => {
                const rows = await this.service.load(task.scope);
                task.commit(() => {
                    this.rows.set(rows);
                    this.initialized.set(true);
                });
            },
            undefined,
            'workflow-init',
        );
        return this.started;
    }
    /** 选择属于页面会话，导航返回时保留；不修改领域数据。 */
    select(id: number): void {
        this.scope.signal.throwIfAborted();
        invariant(
            this.rows.readonly.value.some((row) => row.id === id),
            'DEMO_TASK_UNKNOWN',
            '任务不存在',
        );
        this.selected.set(id);
    }
    /** 业务保存失败转为可重试反馈；观察者错误不影响业务提交。 */
    train(): void {
        this.scope.signal.throwIfAborted();
        try {
            this.service.train();
            this.message.set({ code: 'trained' });
        } catch (error) {
            this.message.set({ code: 'error', message: String(error) });
        }
    }
    /** 示例故障注入入口。 */
    failNext(): void {
        this.scope.signal.throwIfAborted();
        this.service.simulateFailure();
        this.message.set({ code: 'failure-armed' });
    }
}
