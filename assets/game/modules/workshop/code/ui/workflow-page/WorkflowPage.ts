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
    private readonly parts = new Map<number, TaskPart>();

    /** 模型属于页面会话，输入、订阅和显示资源属于本次显示。 */
    protected async onShow(show: ViewShowContext<WorkflowPageParams, void>): Promise<void> {
        this.parts.clear();
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
        show.bindings.watch(
            model.state,
            (s) => [s.cards, s.claiming] as const,
            ([cards, claiming]) => {
                for (const card of cards) this.parts.get(card.id)?.render(card, { enabled: !claiming });
            },
            { label: 'card-state', equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
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
                    part.render(card, {
                        enabled: !model.state.value.claiming,
                        claim: async (id) => {
                            const selected = model.state.value.cards.find((item) => item.id === id);
                            if (selected) await model.claim.run(selected, call);
                        },
                    });
                    parts.set(card.id, part);
                }
                return { assets, parts };
            },
            render: ({ assets, parts }, _ids, previous) => {
                for (const part of previous?.parts.values() ?? []) part.node.active = false;
                this.parts.clear();
                for (const card of model.state.value.cards) {
                    const part = parts.get(card.id)!;
                    part.render(card, { enabled: !model.state.value.claiming });
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
