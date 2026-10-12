import { _decorator, Button } from 'cc';
import type { ViewShowContext } from '../../../../../../framework/ui/ui-view';
import { createWorkflow, workflowCall } from '../../presentation/workflow';
import { workflowFeedback } from '../../presentation/workflow-presentation';
import { WorkflowCompactPageBinding } from './generated/WorkflowCompactPageBinding';
const { ccclass } = _decorator;

/** 紧凑皮肤：与卡片页复用 ViewModel 实现，节点结构、选择方式和排版可以不同。 */
@ccclass('workshop.WorkflowCompactPage')
export class WorkflowCompactPage extends WorkflowCompactPageBinding {
    protected async onShow(show: ViewShowContext<void, void>): Promise<void> {
        const model = show.session.use(createWorkflow);
        show.listen(this.btnBack.node, Button.EventType.CLICK, () => show.ui.back());
        show.listen(this.btnTrain.node, Button.EventType.CLICK, () => model.train());
        show.bindings.command(this.btnReload, model.reload, model.state, {
            args: () => undefined,
            enabled: (state) => !state.loading,
            call: { owner: show.scope, context: undefined },
        });
        show.listen(this.btnNext.node, Button.EventType.CLICK, () => {
            const state = model.state.value,
                index = state.cards.findIndex((card) => card.id === state.selectedId);
            const next = state.cards[(index + 1) % state.cards.length];
            if (next) model.select(next.id);
        });
        show.bindings.command(this.btnClaim, model.claim, model.state, {
            args: (state) => state.cards.find((card) => card.id === state.selectedId)!,
            enabled: (state) => state.cards.some((card) => card.id === state.selectedId && card.state === 'ready'),
            call: workflowCall(show),
        });
        await model.start();
        show.bindings.text(
            this.lblOutput,
            model.state,
            (state) => `余额 ${state.coins} 金币 · 训练 ${state.progress} 次\n${workflowFeedback(state.feedback)}`,
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
            { label: 'tasks', equals: (a, b) => a[0] === b[0] && a[1] === b[1], writes: [[this.lblTasks, 'string']] },
        );
    }
}
