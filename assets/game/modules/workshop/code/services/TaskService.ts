import type { ModuleContext } from '../../../../../framework/modules/module-manager';
import type { Lifetime } from '../../../../../framework/core/scope';
import type { StorageKey } from '../../../../../framework/storage/storage';
import type { ProfileApi } from '../../../profile/public';
import type { TasksRow } from '../../contracts/generated/config/Tasks.types';
import type { TaskCardModel } from '../../contracts/workflow';
import { TasksTable } from '../../contracts/generated/config/Tasks.table';
import { EconomyTable } from '../../../common/public';
import { WorkshopChanged } from '../../contracts/workflow';
import { invariant } from '../../../../../framework/core/errors';
import type { BadgeSource } from '../../../../../framework/badges';
import { TaskBadges, taskBadge } from '../../contracts/badges';
import { State, derive, type ReadonlyState } from '../../../../../framework/core/state';

/** 跨界面共享的事实，选择项、按钮忙碌和反馈不进入领域状态。 */
export interface TaskFacts {
    readonly progress: number;
    readonly coins: number;
    readonly claims: readonly string[];
}

const ProgressSave: StorageKey<{ progress: number }> = {
    id: 'workshop.progress',
    version: 1,
    validate: (value): value is { progress: number } =>
        !!value &&
        typeof value === 'object' &&
        Number.isSafeInteger((value as { progress: number }).progress) &&
        (value as { progress: number }).progress >= 0,
};

/** 任务领域服务：配置、规则、状态和存档；不引用 Page、ViewModel 或 Cocos 节点。 */
export class TaskService {
    private readonly progress: State<number>;
    /** 与其他 Service、ViewModel 使用同一只读状态协议。 */
    readonly state: ReadonlyState<TaskFacts>;
    private failNext = false;
    private definitions = new Map<number, TasksRow>();
    private readonly badges = new Map<number, BadgeSource>();
    /** 依赖由模块工厂按 module.json 注入；账号状态通过公开 API 访问。 */
    constructor(
        private readonly ctx: ModuleContext,
        private readonly profile: ProfileApi,
    ) {
        const saved = ctx.storage.read(ProgressSave);
        invariant(
            saved.status !== 'invalid' && saved.status !== 'incompatible',
            'DEMO_PROGRESS_INVALID',
            '训练存档需要恢复',
        );
        this.progress = new State(saved.value?.progress ?? 0);
        this.state = derive(ctx.scope, [this.progress.readonly, profile.state], (progress, wallet) => ({
            progress,
            ...wallet,
        }));
        ctx.badges.group(TaskBadges, 'sum', ctx.scope);
        this.state.subscribe(ctx.scope, () => this.updateBadges());
    }
    /** 并行加载本模块任务表与公共表，期限由调用页面决定。 */
    async load(owner: Lifetime): Promise<readonly TasksRow[]> {
        const tables = await this.ctx.config.in(owner).loadMany({ tasks: TasksTable, economy: EconomyTable });
        owner.signal.throwIfAborted();
        for (const row of tables.tasks.all()) tables.economy.require(row.economy);
        // 只接收配置管线校验过的规则，领取命令不接受 UI 传来的金额或完成条件。
        this.definitions = new Map(tables.tasks.all().map((row) => [row.id, row]));
        this.ctx.badges.batch(() => {
            for (const [id, source] of this.badges)
                if (!this.definitions.has(id)) {
                    source.dispose();
                    this.badges.delete(id);
                }
            for (const row of this.definitions.values())
                if (!this.badges.has(row.id))
                    this.badges.set(row.id, this.ctx.badges.source(taskBadge(row.id), this.ctx.scope, TaskBadges));
            this.updateBadges();
        });
        return tables.tasks.all();
    }
    /** 完成训练：保存成功后更新状态并发出业务事件。 */
    train(): void {
        this.ctx.scope.signal.throwIfAborted();
        const next = this.progress.readonly.value + 1;
        invariant(Number.isSafeInteger(next), 'DEMO_PROGRESS_LIMIT', '训练次数超出范围');
        this.ctx.storage.set(ProgressSave, { progress: next });
        this.progress.set(next);
        this.publish('完成训练');
    }
    /** 将原始配置和玩家状态转换成可渲染的数据；只读查询不会改变业务。 */
    cards(rows: readonly TasksRow[], facts = this.state.value): readonly TaskCardModel[] {
        this.ctx.scope.signal.throwIfAborted();
        return rows.map((row) => ({
            id: row.id,
            title: row.name,
            reward: row.reward,
            progress: Math.min(facts.progress, row.goal),
            goal: row.goal,
            state: facts.claims.includes(this.rewardId(row.id))
                ? 'claimed'
                : facts.progress >= row.goal
                  ? 'ready'
                  : 'locked',
        }));
    }
    /** 按 ID 领取，金额和条件只从 Service 已加载的配置读取；按钮状态不作为业务保证。 */
    claim(id: number): boolean {
        this.ctx.scope.signal.throwIfAborted();
        const row = this.definitions.get(id);
        invariant(row, 'DEMO_TASK_UNKNOWN', '任务不存在或尚未加载配置');
        invariant(this.progress.readonly.value >= row.goal, 'DEMO_TASK_LOCKED', '请先完成所需训练次数');
        if (this.failNext) {
            this.failNext = false;
            throw Error('模拟请求失败：状态未改变，请再次领取');
        }
        const granted = this.profile.claimReward(this.rewardId(row.id), row.reward);
        this.publish(granted ? `领取 ${row.name}` : '重复领取已拦截');
        return granted;
    }
    /** 演示故障入口，只影响下一次领取，失败发生在任何业务写入之前。 */
    simulateFailure(): void {
        this.failNext = true;
    }
    private rewardId(id: number): string {
        return `workshop/task/${id}`;
    }
    private publish(reason: string): void {
        this.updateBadges();
        const { progress, coins } = this.state.value;
        this.ctx.events.emit(WorkshopChanged, { reason, progress, coins });
    }
    private updateBadges(): void {
        if (this.ctx.scope.signal.aborted) return;
        this.ctx.badges.batch(() => {
            for (const row of this.definitions.values())
                this.badges
                    .get(row.id)
                    ?.set(
                        Number(
                            this.progress.readonly.value >= row.goal && !this.profile.hasReward(this.rewardId(row.id)),
                        ),
                    );
        });
    }
}
