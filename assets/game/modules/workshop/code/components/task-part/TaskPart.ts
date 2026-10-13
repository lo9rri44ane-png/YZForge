import { _decorator, UIOpacity } from 'cc';
import type { TaskCardModel } from '../../../contracts/workflow';
import { TaskPartBinding } from './generated/TaskPartBinding';
import { Badge } from '../../../../../../framework/ui/components/badge/badge';
import { taskBadge } from '../../../contracts/badges';
import type { PartContext } from '../../../../../../framework/ui/part-presentation';
import type { Command, CommandCall } from '../../../../../../framework/core/command';
import { derive } from '../../../../../../framework/core/state';
import type { WorkflowInteraction } from '../../presentation/WorkflowPageViewModel';
const { ccclass } = _decorator;

/** 任务卡片只绑定展示与输入，可直接用于普通集合、单个区域或虚拟列表。 */
@ccclass('workshop.TaskPart')
export class TaskPart extends TaskPartBinding {
    bind(
        item: PartContext<TaskCardModel>,
        claim: Command<TaskCardModel, void, WorkflowInteraction>,
        call: CommandCall<WorkflowInteraction>,
    ): void {
        this.nodeBadge.getComponent(Badge)!.bind(this.ctx.badges, taskBadge(item.state.value.data.id), item.scope);
        item.bindings.text(this.lblTitle, item.state, (state) => state.data.title);
        item.bindings.text(
            this.lblDetail,
            item.state,
            ({ data }) => `训练 ${data.progress} / ${data.goal} · 奖励 ${data.reward} 金币`,
        );
        item.bindings.text(
            this.lblState,
            item.state,
            ({ data }) => ({ locked: '未完成', ready: '可领取', claimed: '已领取' })[data.state],
        );
        item.bindings.command(this.btnClaim, claim, item.state, {
            args: (state) => state.data,
            enabled: (state) => state.data.state === 'ready',
            call,
        });
        const opacity = this.btnClaim.getComponent(UIOpacity);
        if (opacity) {
            const enabled = derive(
                item.scope,
                [item.state, claim.state],
                ({ data }) => data.state === 'ready' && claim.canRun(data),
            );
            item.bindings.property(opacity, 'opacity', enabled, (value) => (value ? 255 : 110));
        }
    }
}
