import type { ModuleContext } from '../../../../../framework/modules/module-manager';
import type { StorageKey } from '../../../../../framework/storage/storage';
import { invariant } from '../../../../../framework/core/errors';
import { State, type ReadonlyState } from '../../../../../framework/core/state';
import type { WalletSnapshot } from '../../public';

type WalletState = WalletSnapshot;
const WalletSave: StorageKey<WalletState> = {
    id: 'profile.wallet',
    version: 3,
    migrations: {
        1: (value) => ({ coins: (value as { gold: number }).gold }),
        2: (value) => ({ coins: (value as WalletSnapshot).coins, claims: [] }),
    },
    validate: (value): value is WalletState =>
        !!value &&
        typeof value === 'object' &&
        Number.isSafeInteger((value as WalletSnapshot).coins) &&
        (value as WalletSnapshot).coins >= 0 &&
        Array.isArray((value as WalletState).claims) &&
        (value as WalletState).claims.every((id) => typeof id === 'string' && id.length > 0) &&
        new Set((value as WalletState).claims).size === (value as WalletState).claims.length,
};
/** 纯业务服务：持有状态、校验命令和保存数据，不依赖页面或 Cocos 节点。 */
export class WalletService {
    private readonly data: State<WalletState>;
    /** 统一只读状态协议；界面和其他模块只借用订阅。 */
    readonly state: ReadonlyState<WalletSnapshot>;
    /** 从可恢复存档初始化；损坏且无备份或来自未来版本时明确失败，避免静默覆盖玩家数据。 */
    constructor(private readonly ctx: ModuleContext) {
        const saved = ctx.storage.read(WalletSave);
        invariant(
            saved.status !== 'invalid' && saved.status !== 'incompatible',
            'DEMO_SAVE_UNAVAILABLE',
            `示例存档需要恢复：${saved.status}`,
        );
        const value = saved.value ?? { coins: 0, claims: [] };
        this.data = new State(value);
        this.state = this.data.readonly;
    }
    /** 校验并保存新状态，写盘失败时保留旧状态；单个订阅者失败不影响其他订阅者。 */
    changeCoins(delta: number): WalletSnapshot {
        this.ctx.scope.signal.throwIfAborted();
        const coins = this.state.value.coins + delta;
        invariant(
            Number.isSafeInteger(delta) && Number.isSafeInteger(coins) && coins >= 0,
            'DEMO_INVALID_COINS',
            '金币变动须为安全整数且余额不能为负',
        );
        return this.commit({ coins, claims: this.state.value.claims });
    }
    /** 保存幂等记录和奖励余额；失败时两者都不改变，便于原请求安全重试。 */
    claimReward(id: string, amount: number): boolean {
        this.ctx.scope.signal.throwIfAborted();
        invariant(/^[a-z0-9][a-z0-9/.:_-]{0,159}$/.test(id), 'DEMO_REWARD_ID', '奖励需要稳定的业务标识');
        invariant(Number.isSafeInteger(amount) && amount > 0, 'DEMO_REWARD_AMOUNT', '奖励必须为正整数');
        if (this.state.value.claims.includes(id)) return false;
        const coins = this.state.value.coins + amount;
        invariant(Number.isSafeInteger(coins), 'DEMO_INVALID_COINS', '金币总数超出安全范围');
        this.commit({ coins, claims: [...this.state.value.claims, id] });
        return true;
    }
    /** 只读取领域状态，不加载 UI 或访问节点。 */
    hasReward(id: string): boolean {
        this.ctx.scope.signal.throwIfAborted();
        return this.state.value.claims.includes(id);
    }
    private commit(value: WalletState): WalletSnapshot {
        const next = Object.freeze({ coins: value.coins, claims: Object.freeze(value.claims.slice()) });
        this.ctx.storage.set(WalletSave, next);
        this.data.set(next);
        return this.state.value;
    }
}
