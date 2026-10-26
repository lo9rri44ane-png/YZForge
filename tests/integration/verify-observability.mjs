import assert from 'node:assert/strict';
import { isolatedRuntime } from './isolated-runtime.mjs';

await isolatedRuntime(process.argv[2], 'framework-observability', async ({ run }) => {
    const result = await run(`
const errors=[],logs=[],root=new cc.Node('diagnostic-probe'),uiRoot=new cc.Node('ui');
uiRoot.parent=root;
const options={...entry.appOptions(),root,uiRoot,modules:[{id:'diagnostic-probe',dependencies:[],factory:async ctx=>({api:{notify:()=>ctx.scope.report(Error('module-probe'))}})}],views:[],onError:(error,context)=>errors.push({message:error.message,context}),logSink:record=>logs.push(record)};
let probe,owner,gate;
try {
    probe=await app.constructor.create(options);
    owner=probe.flows.child('page');
    const module=await probe.modules.use({id:'diagnostic-probe'},owner);
    module.api.notify();
    probe.events.on({id:'probe'},()=>{throw Error('event-probe');},owner);
    probe.events.emit({id:'probe'},undefined);
    probe.log.error('log-probe');
    await new Promise(resolve=>setTimeout(resolve,0));
    const work=new Promise(resolve=>{gate=resolve;});owner.track(work,'slow-probe');
    const before=owner.inspect();owner.cancel();
    await new Promise(resolve=>setTimeout(resolve,20));
    const pending=owner.inspect();gate();await owner.close();
    return {errors,logs,before,pending,after:owner.inspect()};
}finally{gate?.();await owner?.close();await probe?.close();root.destroy();}`);
    assert.ok(
        result.errors.some(
            (entry) => entry.message === 'module-probe' && entry.context.scope.includes('module:diagnostic-probe'),
        ),
    );
    assert.ok(result.errors.some((entry) => entry.message === 'event-probe' && entry.context.source === 'event:probe'));
    assert.ok(result.logs.some((entry) => entry.message === 'log-probe'));
    assert.equal(result.before.tasks[0].id, result.pending.tasks[0].id);
    assert.ok(result.pending.tasks[0].cancellingForMs >= 0);
    assert.equal(result.after.state, 'closed');
    assert.equal(result.after.tasks.length, 0);
    const rebound = await run(`
const ComponentScope=[...System.entries()].map(([,exports])=>exports.ComponentScope).find(Boolean);
if(!ComponentScope)throw Error('ComponentScope export missing');
const oldErrors=[],newErrors=[],oldOwner=new app.scope.constructor('old-owner',(error,context)=>oldErrors.push(context)),newOwner=new app.scope.constructor('new-owner',(error,context)=>newErrors.push(context));
const node=new cc.Node('rebind-probe'),component=node.addComponent(cc.Sprite),lifetime=new ComponentScope(component,()=>{});
let release;
try {
    const first=lifetime.begin(oldOwner,'binding',()=>{}),scopeId=first.id;
    first.defer(async()=>{await new Promise(resolve=>{release=resolve;});throw Error('old-cleanup');});
    lifetime.begin(newOwner,'binding',()=>{});
    for(let i=0;i<10&&!release;i++)await Promise.resolve();
    if(!release)throw Error('Old cleanup did not begin');
    release();await first.close().catch(()=>{});await new Promise(resolve=>setTimeout(resolve,0));
    return {scopeId,oldErrors,newErrors};
}finally{release?.();await Promise.allSettled([lifetime.__deactivate(),oldOwner.close(),newOwner.close()]);node.destroy();}`);
    assert.ok(rebound.oldErrors.length > 0, 'Old binding cleanup was not reported to its owner');
    assert.ok(rebound.oldErrors.every((context) => context.scopeId === rebound.scopeId));
    assert.deepEqual(rebound.newErrors, [], 'Old cleanup was reported to the new binding owner');
    console.log('PASS: App diagnostics, module/event outlets, logs and retained physical task');
});
