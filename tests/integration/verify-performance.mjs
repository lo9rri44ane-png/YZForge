import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isolatedRuntime } from './isolated-runtime.mjs';
import { distribution, savePerformance } from '../../tools/yzforge/validation/performance.mjs';

const { values, positionals } = parseArgs({ options: { baseline: { type: 'string' } }, allowPositionals: true });
const root = fileURLToPath(new URL('../../', import.meta.url));
const config = JSON.parse(
    await readFile(new URL('../../project-settings/performance-budgets.json', import.meta.url), 'utf8'),
).runtime;
for (const key of ['warmupCycles', 'pageCycles', 'scrollSamples', 'maxListInstances'])
    assert.ok(Number.isInteger(config[key]) && config[key] > 0 && config[key] <= 1000, `Invalid ${key}`);
await isolatedRuntime(positionals[0], 'framework-performance', async ({ run }) => {
    const result = await run(
        `
const owner=app.flows.child('benchmark'),opens=[],frames=[],counts=[];
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const key={id:'showcase.virtual-list-lab-page',kind:'page'};
const environment=await System.import('cc/env');
const count=()=>{const s=app.diagnostics.snapshot();return {resources:s.resourceCount,configs:s.configCount,draining:s.configDrainingCount,views:app.ui.inspect().views.length};};
let baseline,coldOpenMs,maxSlots=0;
try {
for(let i=0;i<args.warmupCycles+args.pageCycles;i++){
    const started=performance.now();
    const handle=await app.ui.pushPage(key,undefined,owner);
    const record=[...app.ui.records.values()].find(r=>r.definition.id===key.id&&!r.termination);
    const list=record?.instance.view.list;if(!list)throw Error('Performance fixture missing');
    await list.ready;await frame();
    const elapsed=performance.now()-started;
    if(i===0)coldOpenMs=elapsed;
    if(i>=args.warmupCycles)opens.push(elapsed);
    if(i===args.warmupCycles){
        let last=await frame();
        for(let j=0;j<args.scrollSamples;j++){
            list.scrollToIndex(j*997%list.count);await list.ready;
            const next=await frame();frames.push(next-last);last=next;
            maxSlots=Math.max(maxSlots,list.inspect().slots);
        }
    }
    await handle.close();await frame();await frame();
    const after=count();
    if(i===args.warmupCycles-1)baseline=after;
    if(i>=args.warmupCycles)counts.push(after);
}
return {coldOpenMs,opens,frames,maxSlots,baseline,counts,profile:{userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],engine:cc.VERSION,preview:environment.PREVIEW,debug:environment.DEBUG,renderer:cc.director.root.device?.renderer}};
}finally{await owner.close();}`,
        config,
    );
    const problems = [];
    if (result.maxSlots > config.maxListInstances)
        problems.push(`List instance budget exceeded: ${result.maxSlots} > ${config.maxListInstances}`);
    if (!result.counts.every((count) => JSON.stringify(count) === JSON.stringify(result.baseline)))
        problems.push('Retained resources/configuration/views did not return to the warmed baseline');
    await savePerformance(
        root,
        'creator-runtime',
        { ...result.profile, scenario: config },
        { pageOpen: distribution(result.opens), scrolling: distribution(result.frames) },
        {
            coldOpenMs: result.coldOpenMs,
            maxSlots: result.maxSlots,
            retainedBaseline: result.baseline,
            retainedSamples: result.counts,
        },
        { baseline: values.baseline, problems },
    );
});
