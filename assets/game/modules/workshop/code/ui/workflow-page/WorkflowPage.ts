import { _decorator, Button } from 'cc';
import type { ViewShowContext } from '../../../../../../framework/ui/ui-view';
import type { WorkflowPageParams } from '../../../contracts/WorkflowPage.types';
import { WorkshopRes } from '../../../contracts/generated/resources-default';
import { WorkshopViews } from '../../generated/views';
import { TaskPart } from '../../components/task-part/TaskPart';
import { WorkflowPageBinding } from './generated/WorkflowPageBinding';
import { createWorkflow, workflowCall } from '../../presentation/workflow';
import { State, derive } from '../../../../../../framework/core/state';
import { workflowSummary } from '../../presentation/workflow-presentation';
import { Badge } from '../../../../../../framework/ui/components/badge/badge';
import { TaskBadges } from '../../../contracts/badges';
const { ccclass } = _decorator;

/** 卡片皮肤只管布局、资源和输入；语义状态与业务流程来自可复用 ViewModel。 */
@ccclass('workshop.WorkflowPage')
export class WorkflowPage extends WorkflowPageBinding {
    /** 模型属于页面会话，输入、订阅和显示资源属于本次显示。 */
    protected async onShow(show: ViewShowContext<WorkflowPageParams, void>): Promise<void> {
        this.nodeBadge.getComponent(Badge)!.bind(this.ctx.badges, TaskBadges, show.scope);
        const model = show.session.use(createWorkflow),
            call = workflowCall(show);
        const inspection = new State<string | undefined>(undefined);
        show.listen(this.btnBack.node, Button.EventType.CLICK, () => show.ui.back());
        show.listen(this.btnSkin.node, Button.EventType.CLICK, async () => {
            await show.ui.pushPage(WorkshopViews.workflowCompactPage, undefined);
        });
        show.listen(this.btnTrain.node, Button.EventType.CLICK, () => model.train());
        show.listen(this.btnFailure.node, Button.EventType.CLICK, () => model.failNext());
        show.bindings.command(this.btnReload, model.reload, model.state, {
            args: () => undefined,
            enabled: (state) => !state.loading,
            call: { owner: show.scope, context: undefined },
        });
        show.listen(this.btnInspect.node, Button.EventType.CLICK, () => {
            const state = this.ctx.diagnostics.snapshot(),
                module = this.ctx.diagnostics.module('workshop');
            inspection.set(
                `任务代码已加载：${module.codeReady}\n业务实例存活：${module.businessReady}\n页面栈：${state.pages.join(' → ')}\n配置持有 ${state.configCount} · 资源持有 ${state.resourceCount}`,
            );
        });
        await model.start();
        model.state.subscribe(show.scope, () => inspection.set(undefined));
        const summary = derive(
            show.scope,
            [model.state, inspection.readonly],
            (state, detail) => detail ?? workflowSummary(state),
        );
        show.bindings.text(this.lblOutput, summary, (text) => text);
        show.bindings.items(this.nodeItems, model.state, (state) => state.cards, {
            key: (card) => card.id,
            prefab: WorkshopRes.prefab.prefabsTaskPart,
            part: TaskPart,
            bind: (part, item) => part.bind(item, model.claim, call),
        });
    }
}
