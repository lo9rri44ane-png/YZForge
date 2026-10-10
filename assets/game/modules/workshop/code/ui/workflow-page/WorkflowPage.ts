import { _decorator, Button } from 'cc';
import type { ViewShowContext } from '../../../../../../framework/ui/ui-view';
import type { WorkflowPageParams } from '../../../contracts/WorkflowPage.types';
import { WorkshopServices } from '../../WorkshopServices';
import { WorkshopRes } from '../../../contracts/generated/resources-default';
import { WorkshopViews } from '../../generated/views';
import { TaskPart } from '../../components/task-part/TaskPart';
import { WorkflowPageBinding } from './generated/WorkflowPageBinding';
import { WorkflowPageViewModel } from './WorkflowPageViewModel';
import { workflowSummary } from './workflow-presentation';
import { Badge } from '../../../../../../framework/ui/components/badge/badge';
import { TaskBadges } from '../../../contracts/badges';
const { ccclass } = _decorator;

/** 卡片皮肤只管布局、资源和输入；语义状态与业务流程来自可复用 ViewModel。 */
@ccclass('workshop.WorkflowPage')
export class WorkflowPage extends WorkflowPageBinding {
    private readonly parts = new Map<number, TaskPart>();

    /** 每次显示独立的局部状态；订阅、查询与确认交互随本次显示结束。 */
    protected async onShow(show: ViewShowContext<WorkflowPageParams, void>): Promise<void> {
        this.parts.clear();
        this.nodeBadge.getComponent(Badge)!.bind(this.ctx.badges, TaskBadges, show.scope);
        const model = new WorkflowPageViewModel(this.ctx.services(WorkshopServices).tasks, show.scope, {
            confirm: async (card, owner) =>
                (
                    await show.ui.open(
                        WorkshopViews.claimPopup,
                        {
                            title: `领取「${card.title}」`,
                            detail: `奖励 ${card.reward} 金币。\n取消不会修改状态；重复命令不会重复发放。`,
                        },
                        { owner },
                    )
                ).result,
        });
        show.listen(this.btnBack.node, Button.EventType.CLICK, () => show.ui.back());
        show.listen(this.btnSkin.node, Button.EventType.CLICK, async () => {
            await show.ui.pushPage(WorkshopViews.workflowCompactPage, undefined);
        });
        show.listen(this.btnTrain.node, Button.EventType.CLICK, () => model.train());
        show.listen(this.btnFailure.node, Button.EventType.CLICK, () => model.failNext());
        show.listen(this.btnReload.node, Button.EventType.CLICK, () => model.reload());
        show.listen(this.btnInspect.node, Button.EventType.CLICK, () => {
            const state = this.ctx.diagnostics.snapshot(),
                module = this.ctx.diagnostics.module('workshop');
            this.lblOutput.string = `任务代码已加载：${module.codeReady}\n业务实例存活：${module.businessReady}\n页面栈：${state.pages.join(' → ')}\n配置持有 ${state.configCount} · 资源持有 ${state.resourceCount}`;
        });
        await model.start();
        show.bindings.watch(
            model.state,
            (s) => s,
            (state) => {
                this.lblOutput.string = workflowSummary(state);
                this.btnReload.interactable = !state.loading;
            },
            { label: 'summary' },
        );
        show.bindings.watch(
            model.state,
            (s) => s.cards,
            (cards) => {
                for (const card of cards) this.parts.get(card.id)?.render(card);
            },
            { label: 'card-state' },
        );
        show.bindings.prepare(model.state, (s) => s.cards.map((card) => card.id).join(','), {
            label: 'card-structure',
            prepare: async (_ids, stage) => {
                const assets = show.assets.in(stage.scope),
                    parts = new Map<number, TaskPart>();
                for (const card of model.state.value.cards) {
                    const node = await assets.instantiate(WorkshopRes.prefab.prefabsTaskPart, this.nodeItems, {
                        active: false,
                    });
                    stage.signal.throwIfAborted();
                    const part = node.getComponent(TaskPart);
                    if (!part) throw Error('TaskPart 组件缺失，请重新生成绑定');
                    part.render(card, (id) => model.claim(id));
                    parts.set(card.id, part);
                }
                return { assets, parts };
            },
            render: ({ assets, parts }, _ids, previous) => {
                for (const part of previous?.parts.values() ?? []) part.node.active = false;
                this.parts.clear();
                for (const card of model.state.value.cards) {
                    const part = parts.get(card.id)!;
                    part.render(card);
                    this.parts.set(card.id, part);
                    assets.activate(part.node);
                }
            },
        });
    }

    /** 节点由渲染绑定回收；缓存实例只清理本次显示的引用。 */
    protected onHide(): void {
        this.parts.clear();
    }
}
