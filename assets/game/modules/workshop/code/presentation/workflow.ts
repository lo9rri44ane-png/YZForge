import type { ViewModelFactory } from '../../../../../framework/ui/view-session';
import type { ViewShowContext } from '../../../../../framework/ui/ui-view';
import type { CommandCall } from '../../../../../framework/core/command';
import { WorkshopServices } from '../WorkshopServices';
import { WorkshopViews } from '../generated/views';
import { WorkflowPageViewModel, type WorkflowInteraction } from './WorkflowPageViewModel';

/** 显式组合模型依赖；每个页面会话各创建一份，各种皮肤复用同一个工厂。 */
export const createWorkflow: ViewModelFactory<WorkflowPageViewModel> = ({ ctx, scope }) =>
    new WorkflowPageViewModel(ctx.services(WorkshopServices).tasks, scope);

/** 当前显示的语义交互适配；UI 结果协议在这里转换，不进入可复用模型。 */
export function workflowCall(show: ViewShowContext<void, void>): CommandCall<WorkflowInteraction> {
    return {
        owner: show.scope,
        context: {
            confirm: async (card, owner) => {
                const popup = await show.ui.open(
                    WorkshopViews.claimPopup,
                    {
                        title: `领取「${card.title}」`,
                        detail: `奖励 ${card.reward} 金币。\n取消不会修改状态；重复命令不会重复发放。`,
                    },
                    { owner },
                );
                const result = await popup.result;
                if (result.status === 'failed') throw result.error;
                return result.status === 'completed' && result.value;
            },
        },
    };
}
