import { _decorator, Button } from 'cc';
import type { ViewShowContext } from '../../../../../../framework/ui/ui-view';
import { WorkshopServices } from '../../WorkshopServices';
import { WorkshopViews } from '../../generated/views';
import { WorkflowPageViewModel } from '../workflow-page/WorkflowPageViewModel';
import { workflowFeedback } from '../workflow-page/workflow-presentation';
import { WorkflowCompactPageBinding } from './generated/WorkflowCompactPageBinding';
const { ccclass } = _decorator;

/** 紧凑皮肤：与卡片页复用 ViewModel 实现，节点结构、选择方式和排版可以不同。 */
@ccclass('workshop.WorkflowCompactPage')
export class WorkflowCompactPage extends WorkflowCompactPageBinding {
    protected async onShow(show: ViewShowContext<void, void>): Promise<void> {
        const model = new WorkflowPageViewModel(this.ctx.services(WorkshopServices).tasks, show.scope, {
            confirm: async (card, owner) =>
                (
                    await show.ui.open(
                        WorkshopViews.claimPopup,
                        {
                            title: `领取「${card.title}」`,
                            detail: `确认领取 ${card.reward} 金币？`,
                        },
                        { owner },
                    )
                ).result,
        });
        show.listen(this.btnBack.node, Button.EventType.CLICK, () => show.ui.back());
        show.listen(this.btnTrain.node, Button.EventType.CLICK, () => model.train());
        show.listen(this.btnReload.node, Button.EventType.CLICK, () => model.reload());
        show.listen(this.btnNext.node, Button.EventType.CLICK, () => {
            const state = model.state.value,
                index = state.cards.findIndex((card) => card.id === state.selectedId);
            const next = state.cards[(index + 1) % state.cards.length];
            if (next) model.select(next.id);
        });
        show.listen(this.btnClaim.node, Button.EventType.CLICK, () => {
            const id = model.state.value.selectedId;
            if (id !== undefined) return model.claim(id);
        });
        await model.start();
        show.bindings.watch(
            model.state,
            (s) => s,
            (state) => {
                this.lblOutput.string = `余额 ${state.coins} 金币 · 训练 ${state.progress} 次\n${workflowFeedback(state.feedback)}`;
                this.btnReload.interactable = !state.loading;
                this.btnClaim.interactable =
                    !state.claiming &&
                    state.cards.some((card) => card.id === state.selectedId && card.state === 'ready');
            },
            { label: 'summary' },
        );
        show.bindings.watch(
            model.state,
            (s) => [s.cards, s.selectedId] as const,
            ([cards, selected]) => {
                this.lblTasks.string = cards
                    .map(
                        (card) =>
                            `${card.id === selected ? '●' : '○'} ${card.title}\n   ${card.progress}/${card.goal} · ${card.reward} 金币 · ${{ locked: '未完成', ready: '可领取', claimed: '已领取' }[card.state]}`,
                    )
                    .join('\n\n');
            },
            { label: 'tasks', equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
        );
    }
}
