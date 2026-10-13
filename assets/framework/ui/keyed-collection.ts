import { FrameworkError, OperationCancelled, reportError, type ErrorReporter } from '../core/errors';
import { untilCancelled } from '../core/cancellation';
import { runTask, type Lifetime, type Scope, type TaskContext } from '../core/scope';
import { batch, reportObserverError } from '../core/state';
import { ItemBinding, itemKeys, type ItemContext, type ItemKey } from './item-binding';
import { Preparation } from '../core/preparation';

/** @internal 布局与引擎适配；实例销毁必须登记到 create 的 owner。 */
export interface CollectionAdapter<T, Item> {
    create(owner: Lifetime): Promise<Item>;
    bind(item: Item, context: ItemContext<T>): Promise<void>;
    preparation?(item: Item): Preparation;
    show(item: Item): void;
    order(items: readonly Item[]): void;
    deactivate(item: Item): Promise<void>;
}

type Entry<T, Item> = {
    key: ItemKey;
    scope: Scope;
    item?: Item;
    binding?: ItemBinding<T>;
    adopted: boolean;
    closing?: Promise<void>;
    detachPreparation?: () => void;
};

/** @internal 候选集合只拥有新增条目；被保留的节点归集合长期持有。 */
export interface CollectionPlan<T, Item> {
    readonly entries: readonly Entry<T, Item>[];
    readonly data: readonly T[];
    readonly detach: () => void;
}

/**
 * @internal 与 StateBindings.prepare 配合：准备新增项、同步交接、再清理移除项。
 * 等待上一轮移除/取消的真实清理后才创建新增项，慢任务不会造成无界补位。
 */
export class KeyedCollection<T, Item> {
    readonly scope: Scope;
    readonly preparation: Preparation;
    private displayed = new Map<ItemKey, Entry<T, Item>>();
    private readonly entries = new Set<Entry<T, Item>>();
    private readonly retiring = new Set<Promise<void>>();
    private readonly failures: unknown[] = [];

    constructor(
        owner: Lifetime,
        private readonly key: (data: T) => ItemKey,
        private readonly adapter: CollectionAdapter<T, Item>,
        private readonly report: ErrorReporter = reportError,
    ) {
        this.scope = owner.child('parts');
        this.preparation = new Preparation(this.scope.lifetime);
        this.scope.signal.onAbort(() => {
            for (const entry of this.entries) this.retire(entry);
            this.displayed.clear();
        });
        this.scope.defer(async () => {
            await Promise.all(this.retiring);
            if (this.failures.length)
                throw new FrameworkError('PARTS_CLEANUP_FAILED', '动态 Part 清理失败', { failures: this.failures });
        });
    }

    async prepare(data: readonly T[], task: TaskContext): Promise<CollectionPlan<T, Item>> {
        const keys = itemKeys(data, this.key);
        const created: Entry<T, Item>[] = [];
        const detach = task.signal.onAbort(() => {
            for (const entry of created) if (!entry.adopted) this.retire(entry);
        });
        try {
            // 纯更新和重排可立即交接；创建新实例前等待旧候选实际结束。
            if (keys.some((key) => !this.displayed.has(key)))
                await untilCancelled(Promise.all(this.retiring), task.signal);
            task.signal.throwIfAborted();
            const entries: Entry<T, Item>[] = [];
            for (let index = 0; index < data.length; index++) {
                task.signal.throwIfAborted();
                const key = keys[index];
                let entry = this.displayed.get(key);
                if (!entry) {
                    entry = { key, scope: this.scope.child(`part:${key}`), adopted: false };
                    this.entries.add(entry);
                    created.push(entry);
                    const target = entry;
                    await runTask(
                        target.scope,
                        async () => {
                            target.item = await this.adapter.create(target.scope.lifetime);
                            target.scope.signal.throwIfAborted();
                            target.binding = new ItemBinding(target.scope, key, data[index], index);
                            await this.adapter.bind(target.item, target.binding.context);
                        },
                        undefined,
                        'part:prepare',
                    );
                }
                entries.push(entry);
            }
            task.signal.throwIfAborted();
            return { entries, data, detach };
        } catch (error) {
            detach();
            for (const entry of created) if (!entry.adopted) this.retire(entry);
            throw error;
        }
    }

    commit(plan: CollectionPlan<T, Item>): void {
        this.scope.signal.throwIfAborted();
        const previous = this.displayed;
        const next = new Map(plan.entries.map((entry) => [entry.key, entry]));
        // 新内容与条目状态在同一同步交接中生效；观察者在 batch 结束后执行。
        batch(() => {
            for (let index = 0; index < plan.entries.length; index++) {
                const entry = plan.entries[index];
                entry.binding!.update(plan.data[index], index);
                if (!entry.adopted) {
                    const preparation = this.adapter.preparation?.(entry.item!);
                    if (preparation) entry.detachPreparation = this.preparation.include(preparation);
                    this.adapter.show(entry.item!);
                }
                entry.adopted = true;
            }
            this.displayed = next;
            for (const [key, entry] of previous) if (!next.has(key)) this.retire(entry);
            this.adapter.order(plan.entries.map((entry) => entry.item!));
        });
        plan.detach();
    }

    inspect(): Readonly<{ displayed: number; instances: number; retiring: number }> {
        return Object.freeze({
            displayed: this.displayed.size,
            instances: this.entries.size,
            retiring: this.retiring.size,
        });
    }

    /** 已提交条目最新的必需资源；集合本身的候选提交由外层 StateBinding 等待。 */
    ready(): Promise<void> {
        return this.preparation.ready();
    }

    dispose(): Promise<void> {
        return this.scope.close();
    }

    private retire(entry: Entry<T, Item>): void {
        if (entry.closing) return;
        entry.detachPreparation?.();
        entry.detachPreparation = undefined;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        // 在取消监听可能重入关闭之前，登记实例与绑定之间的物理清理屏障。
        if (!entry.scope.signal.aborted) void entry.scope.track(barrier, 'part:retire');
        let finish!: () => void;
        const closed = new Promise<void>((resolve) => {
            finish = resolve;
        });
        entry.closing = closed;
        this.retiring.add(closed);
        entry.scope.cancel();
        let deactivation: Promise<void>;
        try {
            deactivation = entry.item ? this.adapter.deactivate(entry.item) : Promise.resolve();
        } catch (error) {
            deactivation = Promise.reject(error);
        }
        void Promise.allSettled([entry.binding?.scope.close(), deactivation])
            .then(async (results) => {
                for (const result of results) if (result.status === 'rejected') this.failure(result.reason);
                release();
                try {
                    await entry.scope.close();
                } catch (error) {
                    this.failure(error);
                }
            })
            .finally(() => {
                release();
                this.entries.delete(entry);
                this.retiring.delete(closed);
                finish();
            });
    }

    private failure(error: unknown): void {
        if (error instanceof OperationCancelled) return;
        if (this.scope.signal.aborted) this.failures.push(error);
        reportObserverError(this.report, error);
    }
}
