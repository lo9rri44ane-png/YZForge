import { invariant } from '../core/errors';
import { synchronousStateEffect } from '../core/state';
import type { Lifetime, Scope } from '../core/scope';
import type { ModuleContext } from '../modules/module-manager';

/** 一次打开至真正关闭的模型创建环境，不含任何显示上下文或节点。 */
export interface ViewSessionContext<P> {
    /** 导航挂起时继续存在，真正关闭时取消并等待清理。 */
    readonly scope: Lifetime;
    /** 本次打开的固定参数，返回页面时不重新取值。 */
    readonly params: P extends object ? Readonly<P> : P;
    /** 显式从所属模块取得依赖；工厂负责组合，模型本身只接收所需 Service。 */
    readonly ctx: ModuleContext;
}
/** 同步创建模型；配置准备由模型的 start/ready 或分区绑定明确表达，不隐式等待。 */
export type ViewModelFactory<T, P = void> = (context: ViewSessionContext<P>) => T;

/** 逻辑页面会话；与每次 show 和缓存节点实例分别拥有独立期限。 */
export class ViewSession<P> implements ViewSessionContext<P> {
    private readonly models = new Map<object, unknown>();
    private readonly creating = new Set<object>();
    /** 本次页面会话的借用期限。 */
    readonly scope: Lifetime;
    /** @internal 由 UIManager 为每个打开记录创建，不放进节点缓存。 */
    constructor(
        private readonly owner: Scope,
        readonly params: ViewSessionContext<P>['params'],
        readonly ctx: ModuleContext,
    ) {
        this.scope = owner.lifetime;
        owner.defer(() => {
            this.models.clear();
        });
    }
    /** 每个工厂在本次打开中创建一次；导航返回复用，真正关闭后重开创建新模型。 */
    use<T>(factory: ViewModelFactory<T, P> & (T extends PromiseLike<unknown> ? never : unknown)): T {
        this.scope.signal.throwIfAborted();
        if (this.models.has(factory)) return this.models.get(factory) as T;
        invariant(!this.creating.has(factory), 'UI_MODEL_CYCLE', 'Model factories must not depend on themselves');
        this.creating.add(factory);
        try {
            const model = factory(this);
            synchronousStateEffect(model);
            this.models.set(factory, model);
            return model;
        } finally {
            this.creating.delete(factory);
        }
    }
    /** @internal 保留物理清理屏障后再归还缓存实例。 */
    __close(): Promise<void> {
        return this.owner.close();
    }
}
