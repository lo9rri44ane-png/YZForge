import { State } from '../../assets/framework/core/state';
import type { StateBindings } from '../../assets/framework/core/state-bindings';

export function stateContracts(bindings: StateBindings): void {
    const model = new State({ coins: 1, rows: [{ id: 1 }] });
    // @ts-expect-error View only receives read capabilities.
    model.readonly.set({ coins: 2, rows: [] });
    // @ts-expect-error Snapshots are recursively readonly.
    model.readonly.value.rows[0].id = 2;
    bindings.watch(
        model.readonly,
        (s) => s.coins,
        (coins) => {
            const amount: number = coins;
            void amount;
        },
    );
    bindings.prepare(model.readonly, (s) => s.rows, {
        prepare: async (rows, task) => {
            task.signal.throwIfAborted();
            return rows.map((row) => String(row.id));
        },
        render: (labels) => {
            const text: string = labels.join(',');
            void text;
            // @ts-expect-error Prepared values retain their inferred type.
            const wrong: number = labels;
            void wrong;
        },
    });
}
