import type { ModuleContext } from '../../../../../framework/modules/module-manager';
import type { Lifetime } from '../../../../../framework/core/scope';
import type { ProfileApi, WalletSnapshot } from '../../../profile/public';
import { EconomyTable } from '../../../common/public';
import type { ReadonlyState } from '../../../../../framework/core/state';

/** 大厅业务组合：通过账号模块公开 API 操作状态，通过公共配置合同读取奖励定义。 */
export class LobbyService {
    /** 共享账号状态使用框架统一的只读协议。 */
    readonly state: ReadonlyState<WalletSnapshot>;
    /** 依赖由模块工厂显式传入，无全局单例或字符串服务查找。 */
    constructor(
        private readonly ctx: ModuleContext,
        private readonly profile: ProfileApi,
    ) {
        this.state = profile.state;
    }
    /** 读取公共资源包中的奖励配置，不启动 common 模块工厂。 */
    async reward(owner: Lifetime): Promise<{ title: string; amount: number }> {
        this.ctx.scope.signal.throwIfAborted();
        const table = await this.ctx.config.in(owner).load(EconomyTable);
        const row = table.require(1);
        return { title: row.name, amount: row.amount };
    }
    /** 执行演示奖励业务，页面只负责传递玩家确认结果。 */
    claim(amount: number): WalletSnapshot {
        this.ctx.scope.signal.throwIfAborted();
        return this.profile.changeCoins(amount);
    }
}
