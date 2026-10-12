import type { WorkflowFeedback, WorkflowState } from './WorkflowPageViewModel';

/** 示例的中文皮肤文案；正式多语言项目可在这里把语义代码映射到语言 Key。 */
export function workflowFeedback(value: WorkflowFeedback): string {
    const text: Record<WorkflowFeedback['code'], string> = {
        intro: '点击完成训练，再点击卡片领取奖励。',
        trained: '训练已保存；业务事件通知页面和展示大厅。',
        'failure-armed': '下一次领取将失败；失败后可再次领取。',
        reloaded: '配置重新读取完成，存档与领取状态保留。',
        cancelled: '已取消，业务状态未改变。',
        granted: '奖励已保存；余额和领取记录一次写入。',
        duplicate: '已领取，不重复增加余额。',
        error: value.message ?? '操作失败，请重试。',
        'confirmation-failed': `确认界面失败，未提交领取：${value.message ?? ''}${value.cleanupPending ? '（仍在清理）' : ''}`,
    };
    return text[value.code];
}

/** 卡片皮肤的排版，不进入业务或 ViewModel。 */
export function workflowSummary(state: WorkflowState): string {
    return `训练 ${state.progress} 次 · 余额 ${state.coins} 金币\n${workflowFeedback(state.feedback)}\nService → ViewModel → View / Part\n模块通信：公开 API + 类型化事件`;
}
