import { Command, type CommandInvocation } from '../../../core/command';
import type { Lifetime, TaskContext } from '../../../core/scope';

/** @internal 点击控制使用统一 Command，按钮不另行维护执行和清理锁。 */
export class AsyncButtonController {
    private readonly command: Command<void, void>;
    private invocation?: CommandInvocation<void>;
    /** 最近一次实际开始的点击的清理屏障，重复 press 不替换它。 */
    get completed(): Promise<void> {
        return this.invocation?.completed ?? Promise.resolve();
    }
    constructor(owner: Lifetime, work: (task: TaskContext) => void | Promise<void>, changed: (busy: boolean) => void) {
        this.command = new Command(owner, { policy: 'exclusive', execute: (_args, task) => work(task) });
        let previous = false;
        this.command.state.subscribe(owner, ({ busy }) => {
            if (busy !== previous) {
                previous = busy;
                changed(busy);
            }
        });
    }
    /** 结果尽早交付；仍在退出和清理时重复触发返回 false。 */
    async press(): Promise<boolean> {
        const invocation = this.command.invoke(undefined);
        if (!invocation) return false;
        this.invocation = invocation;
        await invocation.result;
        return true;
    }
}
