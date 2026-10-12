import { Button, isValid, Label } from 'cc';
import { StateBindings, type StateBinding } from '../core/state-bindings';
import { claimProperties } from '../core/property-lease';
import { OperationCancelled, reportError } from '../core/errors';
import { derive, reportObserverError, type ReadonlyState, type Snapshot } from '../core/state';
import type { Command, CommandCall } from '../core/command';
import type { Lifetime } from '../core/scope';
import type { ErrorReporter } from '../core/errors';

/** 页面常用的受管渲染入口；节点属性和点击监听跟随本次显示，模型及 Command 只被借用。 */
export class ViewBindings extends StateBindings {
    /** @internal 交互检查由 UIManager 提供，防止准备或导航交接期间执行按钮工作。 */
    constructor(
        owner: Lifetime,
        current: () => boolean = () => true,
        fault: ErrorReporter = reportError,
        private readonly interactive: () => boolean = () => true,
    ) {
        super(owner, current, fault);
    }
    /** 绑定 Label 文本；多语言绑定与此入口不能同时拥有 string。 */
    text<S>(target: Label, source: ReadonlyState<S>, format: (state: Snapshot<S>) => string): StateBinding {
        return this.property(target, 'string', source, format);
    }
    /**
     * 一个绑定同时拥有按钮可交互状态与点击转发。args 在点击时捕获，enabled 表达业务可用性。
     * 解绑只移除这个按钮；调用的期限使用 call.owner，不能因此销毁共享 Command。
     */
    command<A, R, C, S>(
        target: Button,
        command: Command<A, R, C>,
        input: ReadonlyState<S>,
        options: {
            readonly args: (state: Snapshot<S>) => A | Snapshot<A>;
            readonly enabled?: (state: Snapshot<S>) => boolean;
            readonly call: CommandCall<C>;
            readonly interactive?: () => boolean;
            readonly onError?: (error: unknown) => void;
        },
    ): { dispose(): Promise<void> } {
        this.owner.signal.throwIfAborted();
        const release = claimProperties(target, ['interactable']);
        const scope = this.owner.child('command-button');
        const original = target.interactable;
        const live = () => !scope.signal.aborted && this.current() && isValid(target, true);
        let clicked = () => {};
        scope.signal.onAbort(() => {
            if (isValid(target, true)) {
                target.node.off(Button.EventType.CLICK, clicked);
                target.interactable = original;
            }
            release();
        });
        try {
            const state = derive(
                scope,
                [input, command.state] as const,
                (value) => (options.enabled?.(value) ?? true) && command.canRun(options.args(value)),
                { onError: this.fault },
            );
            state.subscribe(
                scope,
                (enabled) => {
                    if (live()) target.interactable = enabled;
                },
                this.fault,
            );
        } catch (error) {
            void scope.close().catch(this.fault);
            throw error;
        }
        clicked = () => {
            if (!live() || !this.interactive() || !target.interactable || !(options.interactive?.() ?? true)) return;
            try {
                // 泛型条件元组在调用点已经由必填 call 满足。
                const call = command.invoke.bind(command) as (
                    args: A | Snapshot<A>,
                    call: CommandCall<C>,
                ) => ReturnType<Command<A, R, C>['invoke']>;
                const invocation = call(options.args(input.value), options.call);
                void invocation?.result.catch(failed);
            } catch (error) {
                failed(error);
            }
        };
        const failed = (error: unknown) => {
            if (!(error instanceof OperationCancelled)) reportObserverError(options.onError ?? reportError, error);
        };
        if (!scope.signal.aborted) target.node.on(Button.EventType.CLICK, clicked);
        return { dispose: () => scope.close() };
    }
}
