import { Command } from '../../assets/framework/core/command';
import { State, derive, batch } from '../../assets/framework/core/state';
import type { Lifetime } from '../../assets/framework/core/scope';
import type { ViewSession } from '../../assets/framework/ui/view-session';

export function commands(owner: Lifetime, session: ViewSession<void>): void {
    const command = new Command<{ id: number }, boolean, { confirm(id: number): Promise<boolean> }>(owner, {
        policy: 'exclusive',
        execute: (input, _task, interaction) => interaction.confirm(input.id),
    });
    command.invoke({ id: 1 }, { owner, context: { confirm: async () => true } });
    // @ts-expect-error Interaction context is required on each invocation.
    command.invoke({ id: 1 });
    // @ts-expect-error Arguments are typed independently from the interaction context.
    command.run({ id: '1' }, { owner, context: { confirm: async () => true } });
    // @ts-expect-error Operation state is readonly.
    command.state.value.busy = false;
    const state = new State({ id: 1 });
    const label = derive(owner, [state.readonly], (s) => String(s.id));
    const text: string = label.value;
    void text;
    // @ts-expect-error Derived calculations cannot be async.
    derive(owner, [state.readonly], async (s) => s.id);
    // @ts-expect-error Notification batches cannot span an await.
    batch(async () => {});
    // @ts-expect-error Model creation is synchronous; readiness is explicit.
    session.use(async () => ({ id: 1 }));
    // @ts-expect-error A page only borrows the session lifetime.
    session.scope.close();
}
