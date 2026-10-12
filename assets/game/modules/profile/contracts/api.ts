import type { ReadonlyState } from '../../../../framework/core/state';
/** 演示账号状态快照；订阅方按只读使用。 */
export interface WalletSnapshot {
    /** 当前金币数，为非负安全整数。 */
    readonly coins: number;
    /** 已持久化的奖励幂等标识，与余额一次提交。 */
    readonly claims: readonly string[];
}
/** 模块公开 API 合同；跨模块调用依赖此合同，不直接导入 code 中的私有实现。 */
export interface ProfileApi {
    /** 当前模块的稳定 ID。 */
    readonly moduleId: string;
    /** 读取当前状态，不加载其他业务模块。 */
    readonly state: ReadonlyState<WalletSnapshot>;
    /** 本地演示命令；正数增加、负数扣除，保存成功后发布变化。联网经济由项目服务端处理。 */
    changeCoins(delta: number): WalletSnapshot;
    /** 按稳定业务标识领取一次奖励；记录和金币一次保存，重复请求返回 false。此实现用于本地示例。 */
    claimReward(id: string, amount: number): boolean;
    /** 查询指定任务是否已经领取，供业务服务推导可领取状态。 */
    hasReward(id: string): boolean;
}
