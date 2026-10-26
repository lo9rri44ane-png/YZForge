import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { State, derive } from '../../assets/framework/core/state.ts';
import { Scope } from '../../assets/framework/core/scope.ts';
import { VirtualListController } from '../../assets/framework/ui/components/virtual-list/virtual-list-controller.ts';
import { distribution, savePerformance } from '../../tools/yzforge/validation/performance.mjs';

const { values } = parseArgs({ options: { baseline: { type: 'string' } } });
const root = fileURLToPath(new URL('../../', import.meta.url));
const stateSamples = [],
    listSamples = [];
let maxListInstances = 0;
let equalBranchExtraCalculations = 0;
for (let sample = 0; sample < 12; sample++) {
    const owner = new Scope('benchmark');
    try {
        const source = new State({ id: 1, coins: 0 });
        const selected = derive(owner, [source.readonly], (value) => value.id);
        let calculations = 0;
        for (let i = 0; i < 250; i++)
            derive(owner, [selected], (id) => {
                calculations++;
                return { id, i };
            });
        let start = performance.now();
        for (let i = 0; i < 2000; i++) source.set({ id: 1, coins: i });
        const stateMs = performance.now() - start;
        equalBranchExtraCalculations = Math.max(equalBranchExtraCalculations, calculations - 250);
        const list = new VirtualListController(
            owner,
            { itemWidth: 100, itemHeight: 20 },
            {
                create: async () => ({}),
                place: () => {},
                bind: () => {},
                activate: () => {},
                deactivate: async () => {},
            },
            (item) => item,
        );
        list.setViewport(400, 0);
        list.setItems(Array.from({ length: 100000 }, (_, i) => i));
        await list.ready();
        maxListInstances = Math.max(maxListInstances, list.inspect().slots);
        start = performance.now();
        for (let i = 0; i < 100; i++) {
            list.setViewport(400, ((i * 997) % 99900) * 20);
            await list.ready();
            maxListInstances = Math.max(maxListInstances, list.inspect().slots);
        }
        const listMs = performance.now() - start;
        if (sample >= 2) {
            stateSamples.push(stateMs);
            listSamples.push(listMs);
        }
    } finally {
        await owner.close();
    }
}
await savePerformance(
    root,
    'node',
    { node: process.version, scenario: 'state-250x2000-list-100000x100-v1' },
    { equalBranches: distribution(stateSamples), listJumps: distribution(listSamples) },
    { equalBranchExtraCalculations, maxListInstances },
    {
        baseline: values.baseline,
        problems: [
            ...(equalBranchExtraCalculations
                ? [`Equal branches recalculated ${equalBranchExtraCalculations} times`]
                : []),
            ...(maxListInstances > 23 ? [`List capacity exceeded: ${maxListInstances} > 23`] : []),
        ],
    },
);
