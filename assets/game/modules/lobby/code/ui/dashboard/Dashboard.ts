import { _decorator, Button, Node, UITransform } from 'cc';
import type { ViewShowContext } from '../../../../../../framework/ui/ui-view';
import type { DashboardParams, DashboardResult } from '../../../contracts/Dashboard.types';
import { ItemsTable } from '../../generated/config/Items.table';
import { LobbyRes } from '../../../contracts/generated/resources-default';
import { LobbyViews } from '../../generated/views';
import { DashboardBinding } from './generated/DashboardBinding';
import { LobbyServices } from '../../LobbyServices';
import { WalletPart } from '../../components/wallet-part/WalletPart';
import { EconomyTable } from '../../../../common/public';
import { State } from '../../../../../../framework/core/state';
const { ccclass } = _decorator;
/**
 * 框架 API 演示页面：配置、时间、节点事件、弹窗结果、音频及动态图片。
 * 继承自动生成的 DashboardBinding 直接取得节点，不需要在业务脚本中查路径或手动拖引用。
 */
@ccclass('lobby.Dashboard')
export class Dashboard extends DashboardBinding {
    private elapsed = 0;
    /**
     * 每次展示时加载数据、注册输入和日切通知；框架等待此方法完成后才允许交互。
     * @param show - 仅属于本次展示的上下文。资源与监听用 show.scope，await 后更新 UI 用 show.commit。
     */
    protected async onShow(show: ViewShowContext<DashboardParams, DashboardResult>): Promise<void> {
        this.btnBack.node.active = this.ctx.ui.inspect().pages.length > 0;
        show.listen(this.btnBack.node, Button.EventType.CLICK, () => show.ui.back());
        const service = this.ctx.services(LobbyServices).lobby;
        const reward = await service.reward(show.scope);
        this.lblStatus.string = '共享 Profile 服务 · 公共配置 common';
        const slot = new Node('WalletSlot');
        slot.layer = this.node.layer;
        slot.addComponent(UITransform).setContentSize(600, 50);
        slot.parent = this.lblResult.node.parent;
        slot.setPosition(0, -487);
        show.scope.defer(() => {
            slot.destroy();
        });
        const wallet = new State({ id: 0, coins: service.state.value.coins });
        const region = show.bindings.part(slot, wallet.readonly, (state) => state, {
            key: (state) => state.id,
            prefab: LobbyRes.prefab.prefabsWalletPart,
            part: WalletPart,
            bind: (part, item) => part.bind(item),
        });
        service.state.subscribe(show.scope, (state) => wallet.set({ ...wallet.readonly.value, coins: state.coins }));
        const replaceWallet = async () => {
            wallet.set({ ...wallet.readonly.value, id: wallet.readonly.value.id + 1 });
            await region.ready;
        };
        await this.readItems(show);
        this.refreshClock(show);
        // 日期展示与日切通知共同继承项目设置，不再分别手写偏移。
        show.time.onBoundary(
            'day',
            (event) => {
                show.commit(() => {
                    this.lblPeriod.string = `当前业务日：${event.occurrenceKey.split(':')[1]}\n日期与日切统一采用项目日历设置`;
                });
            },
            { emitCurrent: true },
        );
        show.listen(this.btnReward.node, Button.EventType.CLICK, async () => {
            // 防止重复打开和重复提交；页面结束会取消等待，不自动重试领取奖励。
            await show.actions.exclusive('claim-reward', async (task) => {
                // 子弹窗属于当前页面展示；页面结束时会同时关闭它。
                const popup = await show.ui.open(LobbyViews.rewardPopup, reward, { owner: task.scope });
                // open 等待打开完成，result 另行等待玩家选择或外部关闭。
                const result = await popup.result;
                task.signal.throwIfAborted();
                if (result.status === 'completed' && result.value.claimed) service.claim(reward.amount);
                task.commit(() => {
                    this.lblResult.string =
                        result.status === 'completed' && result.value.claimed
                            ? `已领取 ${reward.amount} 金币。\n账号服务已保存，动态 Part 同步更新。`
                            : '本次未领取奖励，可以再次打开。';
                });
            });
        });
        show.listen(
            this.btnReload.node,
            Button.EventType.CLICK,
            async () => {
                await show.actions.exclusive('reload-content', async (task) => {
                    await this.readItems(show);
                    await replaceWallet();
                    task.commit(() => {
                        this.lblResult.string = '配置读取完成。\n新 Part 准备完成后交接，继续显示共享余额。';
                    });
                });
            },
            (error) => {
                show.commit(() => {
                    this.lblResult.string = `操作失败，可以重试：${String(error)}`;
                });
            },
        );
        show.listen(this.btnAudio.node, Button.EventType.CLICK, async () => {
            show.audio.resumeFromGesture();
            const handle = await show.audio.play(LobbyRes.audio.confirm);
            await handle.ended;
            show.commit(() => {
                this.lblResult.string = '音效播放完成，播放句柄已结束。';
            });
        });
        await show.setSprite(this.sprIcon, LobbyRes.sprite.status);
    }
    private async readItems(show: ViewShowContext<DashboardParams, DashboardResult>): Promise<void> {
        // ItemsTable 只有类型和结构合同；load 按发布路由加载 JSON，引用跟随本次展示。
        const items = await show.config.load(ItemsTable);
        const economy = await show.config.load(EconomyTable);
        // 异步期间页面可能已退出；过期 show 的 commit 会跳过，防止旧结果写回。
        show.commit(() => {
            this.lblItems.string = `按需读取 ${items.size} 条配置\n${items.require(1).name} × ${items.require(1).amount} · 公共奖励 ${economy.require(1).amount}`;
        });
    }
    private refreshClock(show: ViewShowContext<DashboardParams, DashboardResult>): void {
        // nowMs 是 UTC 毫秒时间戳；datetime 选择日期+时分秒，省略偏移时继承项目设置。
        this.lblTime.string = show.time.calendar.format(show.time.nowMs(), 'datetime');
    }
    /**
     * 可交互期间每帧调用；这里只累计到约一秒刷新一次时钟文字，不代表业务日切通知。
     * @param dt - 帧间隔，单位秒；60 FPS 时约 0.0167。
     * @param show - 当前有效的展示上下文，挂起或关闭后不再调用此钩子。
     */
    protected onTick(dt: number, show: ViewShowContext<DashboardParams, DashboardResult>): void {
        this.elapsed += dt;
        if (this.elapsed >= 1) {
            this.elapsed %= 1;
            this.refreshClock(show);
        }
    }
}
