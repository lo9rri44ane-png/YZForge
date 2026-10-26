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
const owner=app.flows.child('benchmark'),opens=[],frames={vertical:[],horizontal:[],variable:[]},counts=[];
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const key={id:'showcase.virtual-list-lab-page',kind:'page'};
let envUrl;try{envUrl=await System.resolve('cc/env');}catch{/* 发布包把环境常量内联，不注册 cc/env。 */}
let environment,build;
if(envUrl)environment=await System.import(envUrl);
else{
    const response=await fetch(new URL('yzforge-build.json',location.href));
    if(!response.ok)throw Error('Cannot identify runtime: expected preview cc/env or yzforge-build.json');
    const stamp=await response.json();
    build={buildId:stamp.buildId,configHash:stamp.configHash,mode:stamp.mode,channel:stamp.channel,environment:stamp.environment,platform:stamp.platform,appVersion:stamp.appVersion};
    const config=root.getComponent('game.GameSettings').resolve();
    if(build.configHash!==config.configHash)throw Error('Build manifest does not match the running configuration');
    if(!['debug','release'].includes(build.mode))throw Error('Invalid build mode');
    environment={PREVIEW:false,DEBUG:build.mode==='debug'};
}
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
        for(const mode of ['vertical','horizontal','variable']){
            if(mode!=='vertical')record.instance.view.btnMode.node.emit(cc.Button.EventType.CLICK);
            if(mode==='horizontal')record.instance.view.btnMode.node.emit(cc.Button.EventType.CLICK);
            await list.ready;
            let last=await frame();
            for(let j=0;j<args.scrollSamples;j++){
                list.scrollToIndex(j*997%list.count);await list.ready;
                const next=await frame();frames[mode].push(next-last);last=next;
                maxSlots=Math.max(maxSlots,list.inspect().slots);
            }
        }
    }
    await handle.close();await frame();await frame();
    const after=count();
    if(i===args.warmupCycles-1)baseline=after;
    if(i>=args.warmupCycles)counts.push(after);
}
return {coldOpenMs,opens,frames,maxSlots,baseline,counts,build,profile:{userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],engine:cc.VERSION,preview:environment.PREVIEW,debug:environment.DEBUG,renderer:cc.director.root.device?.renderer}};
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
        { ...result.profile, scenario: { ...config, layouts: ['vertical', 'horizontal', 'variable'] } },
        {
            pageOpen: distribution(result.opens),
            ...Object.fromEntries(
                Object.entries(result.frames).map(([axis, samples]) => [axis + 'Scrolling', distribution(samples)]),
            ),
        },
        {
            coldOpenMs: result.coldOpenMs,
            maxSlots: result.maxSlots,
            retainedBaseline: result.baseline,
            retainedSamples: result.counts,
            build: result.build,
        },
        { baseline: values.baseline, problems },
    );
});
