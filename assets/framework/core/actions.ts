import { Command } from './command';
import { invariant, OperationCancelled } from './errors';
import type { Lifetime, TaskContext } from './scope';

type Work<T> = (task: TaskContext) => T | Promise<T>;
type Entry = { policy: string; capacity: number; command: Command<void, unknown, Work<unknown>> };
/** 动态命名工作的便捷入口，与 Command 共用执行和清理机制；稳定的业务操作优先定义 Command。 */
export class Actions {
    private readonly entries = new Map<string, Entry>();
    /** owner 结束立即取消结果交付，并保留实际清理屏障。 */
    constructor(
        private readonly owner: Lifetime,
        private readonly isCurrent: () => boolean = () => true,
    ) {}
    /** 包含执行、排队及全部旧调用的清理。 */
    busy(key: string): boolean {
        return this.entries.get(key)?.command.state.value.busy ?? false;
    }
    /** 仅最新结果可以提交；被替换的旧任务仍需响应取消。 */
    latest<T>(key: string, work: Work<T>): Promise<T> {
        return this.get(key, 'latest').run(undefined, { owner: this.owner, context: work }) as Promise<T>;
    }
    /** 执行与清理期间忽略同名重复触发，返回 undefined。 */
    exclusive<T>(key: string, work: Work<T>): Promise<T | undefined> {
        return this.get(key, 'exclusive').run(undefined, { owner: this.owner, context: work }) as Promise<
            T | undefined
        >;
    }
    /** 容量在同名队列首次定义后固定；结果立即交付，下一项等实际清理。 */
    serial<T>(key: string, work: Work<T>, maxPending = 32): Promise<T> {
        return this.get(key, 'serial', maxPending).run(undefined, { owner: this.owner, context: work }) as Promise<T>;
    }
    private get(key: string, policy: 'latest' | 'exclusive' | 'serial', capacity = 32): Entry['command'] {
        invariant(key.trim().length > 0, 'ACTION_KEY_EMPTY', 'Provide a stable action name');
        this.owner.signal.throwIfAborted();
        const previous = this.entries.get(key);
        invariant(
            !previous || (previous.policy === policy && previous.capacity === capacity),
            'ACTION_POLICY_MISMATCH',
            key,
        );
        if (previous) return previous.command;
        const command = new Command<void, unknown, Work<unknown>>(this.owner, {
            policy,
            maxPending: capacity,
            execute: async (_args, task, work) => {
                const current: TaskContext = { ...task, commit: (action) => this.isCurrent() && task.commit(action) };
                if (!this.isCurrent()) throw new OperationCancelled('Action host ended');
                const value = await work(current);
                if (!this.isCurrent()) throw new OperationCancelled('Action host ended');
                return value;
            },
        });
        this.entries.set(key, { policy, capacity, command });
        return command;
    }
}
