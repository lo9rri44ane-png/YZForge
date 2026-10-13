import { untilCancelled } from './cancellation';
import type { Lifetime } from './scope';

type Outcome = { readonly status: 'pending' | 'ready' } | { readonly status: 'failed'; readonly error: unknown };
const complete: Outcome = { status: 'ready' };

/**
 * @internal 必需显示内容的准备树，不持有资源或等待物理清理。
 * 子级的新工作、接入和移除同步使祖先失效；等待者始终核对整棵树的最新代次。
 */
export class Preparation {
    private work?: Promise<void>;
    private outcome: Outcome = complete;
    private revision = 0;
    private readonly listeners = new Set<() => void>();
    private readonly children = new Map<object, { preparation: Preparation; detach: () => void }>();

    constructor(private readonly owner: Lifetime) {
        owner.signal.onAbort(() => {
            this.changed();
            for (const child of this.children.values()) child.detach();
            this.children.clear();
            this.listeners.clear();
        });
    }

    /** 替换自身的当前准备；旧工作的资源由原 Scope 继续持有。 */
    set(work?: Promise<void>): void {
        if (this.work === work) return;
        if (this.owner.signal.aborted) {
            void work?.catch(() => {});
            return;
        }
        this.work = work;
        const pending: Outcome = { status: 'pending' };
        this.outcome = work ? pending : complete;
        if (work) {
            const settle = (outcome: Outcome) => {
                if (this.owner.signal.aborted || this.outcome !== pending) return;
                this.outcome = outcome;
                this.changed();
            };
            // 每代只观察一次工作；ready 读取缓存结果，不向慢 Promise 反复追加回调。
            // 拒绝处理始终存在，过期或取消后的迟到错误也会被消费。
            void work.then(
                () => settle(complete),
                (error) => settle({ status: 'failed', error }),
            );
        }
        this.changed();
    }

    /** 仅接入必需的子区域；返回同步移除函数，不取消或关闭被借用的子级。 */
    include(preparation: Preparation): () => void {
        this.owner.signal.throwIfAborted();
        const token = {};
        const changed = () => this.changed();
        preparation.listeners.add(changed);
        const detach = () => {
            preparation.listeners.delete(changed);
        };
        this.children.set(token, { preparation, detach });
        this.changed();
        return () => {
            detach();
            if (this.children.delete(token)) this.changed();
        };
    }

    async ready(): Promise<void> {
        for (;;) {
            this.owner.signal.throwIfAborted();
            const revision = this.revision;
            const outcome = this.snapshot();
            if (outcome.status !== 'pending') {
                // 交付就绪或失败前保留一次核对，覆盖同一同步调用栈替换的代次。
                await Promise.resolve();
                this.owner.signal.throwIfAborted();
                if (revision !== this.revision) continue;
                if (outcome.status === 'failed') throw outcome.error;
                return;
            }
            let resume!: () => void;
            const changed = new Promise<void>((resolve) => {
                resume = resolve;
            });
            this.listeners.add(resume);
            try {
                // 只等可解绑的树变化，旧快照不会滞留在尚未结束的物理工作上。
                await untilCancelled(changed, this.owner.signal);
            } finally {
                this.listeners.delete(resume);
            }
        }
    }

    private snapshot(): Outcome {
        if (this.owner.signal.aborted) return { status: 'failed', error: this.owner.signal.reason };
        let outcome = this.outcome;
        if (outcome.status === 'failed') return outcome;
        for (const child of this.children.values()) {
            const state = child.preparation.snapshot();
            if (state.status === 'failed') return state;
            if (state.status === 'pending') outcome = state;
        }
        return outcome;
    }

    private changed(): void {
        this.revision++;
        for (const listener of Array.from(this.listeners)) listener();
    }
}
