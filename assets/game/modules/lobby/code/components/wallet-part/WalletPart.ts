import { _decorator } from 'cc';
import { WalletPartBinding } from './generated/WalletPartBinding';
import type { PartContext } from '../../../../../../framework/ui/part-presentation';
const { ccclass } = _decorator;
/** 通用渲染部件：父页面传入余额；自身不查找 Service，也不处理奖励业务。 */
@ccclass('lobby.WalletPart')
export class WalletPart extends WalletPartBinding {
    /** 同步渲染父对象提供的展示数据，自动绑定 lbl_balance，无需手动拖拽。 */
    bind(item: PartContext<{ readonly id: number; readonly coins: number }>): void {
        item.bindings.text(this.lblBalance, item.state, ({ data }) => `共享账号服务 · 当前余额 ${data.coins} 金币`);
    }
}
