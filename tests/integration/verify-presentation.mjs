import assert from 'node:assert/strict';
import { isolatedRuntime } from './isolated-runtime.mjs';

await isolatedRuntime(process.argv[2], 'presentation', async ({ run, click, capture }) => {
    const setup = await run(`
const exported=name=>[...System.entries()].map(([,m])=>m).find(m=>m[name])?.[name];
const State=exported('State'),register=exported('registerComponentBinding');
if(!State||!register)throw Error('Presentation runtime exports missing');
cc.profiler.hideStats();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(test)=>{const end=Date.now()+10000;while(!test()){if(Date.now()>end)throw Error('Presentation timeout');await wait(5);}};
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
const state={State,wait,until,deferred,owner:app.flows.child('presentation-check'),fixtures:[]};
globalThis.__presentation=state;
const Base=cc.js.getClassByName('yzforge.UIView'),PartBase=cc.js.getClassByName('yzforge.GameComponent');
state.View=cc._decorator.ccclass('test.PresentationView')(class extends Base{onShow(show){return state.hook?.(this,show);}});
state.Part=cc._decorator.ccclass('test.PresentationPart')(class extends PartBase{
 onActivate(a){state.partActivated=true;a.bindings.prepare(state.model.readonly,n=>n,{prepare:()=>state.partGate.promise,render:()=>{state.partRendered=true;}});}
 onTick(){state.ticks++;}
});
state.Native=cc._decorator.ccclass('test.PresentationNative')(class extends cc.Component{
 constructor(){super();register(this,{__bind(){},__allow(owner){if(owner)state.nativeStarted=true;},__ready:()=>state.nativeGate.promise,__deactivate:async()=>{}});}
});
state.fixture=(name,parts=false)=>{
 const owner=state.owner.child(name),root=new cc.Node(name);app.ui.root.addChild(root);root.addComponent(cc.UITransform).setContentSize(400,400);
 const template=new cc.Node('Template');template.active=false;template.addComponent(cc.UITransform).setContentSize(300,200);template.addComponent(state.View);
 if(parts){template.addComponent(state.Native);template.addComponent(state.Part);}
 const prefab=new cc.Prefab();prefab.data=template;
 const key={id:name,kind:'popup'},context=app.modules.context('showcase');
 const modules={assertCanOpen(){},isInternalOwner(){return true;},context(){return context;},isReady(){return true;},quarantine(){}};
 const errors=[],ui=new app.ui.constructor(root,{load:async()=>prefab},modules,app.time,app.clock,[{...key,module:'showcase',prefab:{id:'test/presentation',type:'Prefab'},cache:'keep-one'}],owner,error=>errors.push(String(error)));
 const fixture={owner,ui,key,errors,close:async()=>{await ui.close();await owner.close();template.destroy();prefab.destroy();root.destroy();}};
 state.fixtures.push(fixture);return fixture;
};return true;`);
    assert.equal(setup, true);
    try {
        assert.equal(
            await run(`
const s=globalThis.__presentation,f=s.fixture('presentation-readiness',true);
s.model=new s.State(0);s.viewGate=s.deferred();s.nativeGate=s.deferred();s.partGate=s.deferred();s.ticks=0;
s.hook=(_view,show)=>{show.bindings.prepare(s.model.readonly,n=>n,{prepare:()=>s.viewGate.promise,render:()=>{s.viewRendered=true;}});};
const opening=f.ui.open(f.key,undefined,f.owner);
await s.until(()=>[...f.ui.records.values()][0]?.show);
if([...f.ui.records.values()][0].interactive)throw Error('Displayed before View preparation');
s.viewGate.resolve();await s.until(()=>s.nativeStarted);
if(s.partActivated)throw Error('Business component activated before native readiness');
s.nativeGate.resolve();await s.until(()=>s.partActivated);
if([...f.ui.records.values()][0].interactive||s.ticks)throw Error('Part preparation did not hold readiness');
s.partGate.resolve();const handle=await opening;
if(!s.viewRendered||!s.partRendered||![...f.ui.records.values()][0].interactive)throw Error('Not rendered');
await s.until(()=>s.ticks>0);await handle.close();await f.close();
if(f.errors.length)throw Error(f.errors.join());return true;`),
            true,
        );
        console.log('PASS: View readiness, native-before-business ordering, Part readiness and business frames');

        assert.equal(
            await run(`
const s=globalThis.__presentation,f=s.fixture('presentation-cancel'),gate=s.deferred();
let started=false,released=false,rendered=false,closed=false;
s.hook=(_view,show)=>{show.bindings.prepare(new s.State(1).readonly,n=>n,{prepare:async(_n,stage)=>{started=true;stage.scope.defer(()=>{released=true;});await gate.promise;},render:()=>{rendered=true;}});};
const caller=f.owner.child('caller'),opening=f.ui.open(f.key,undefined,caller).then(()=>{throw Error('Cancelled view opened');},error=>error.code);
await s.until(()=>started);const closing=caller.close().then(()=>{closed=true;});
if(await opening!=='OPERATION_CANCELLED')throw Error('Wrong cancellation result');
await s.wait(30);if(closed||released||rendered)throw Error('Physical cleanup barrier broken');
gate.resolve();await closing;if(!released||rendered)throw Error('Stale preparation committed');
s.hook=(_view,show)=>show.bindings.prepare(new s.State(1).readonly,n=>n,{prepare:()=>{throw Error('expected preparation failure');},render:()=>{}});
let failed=false;try{await f.ui.open(f.key,undefined,f.owner);}catch(error){failed=String(error).includes('expected preparation failure');}
if(!failed)throw Error('Required preparation failure was hidden');
await s.until(()=>f.ui.records.size===0);
await f.close();if(f.errors.length)throw Error(f.errors.join());return true;`),
            true,
        );
        console.log(
            'PASS: cancelled preparation retains resources until physical completion; initial failure is delivered',
        );

        assert.equal(
            await run(`
const s=globalThis.__presentation;
const cards=app.ui.definitions.get('workshop.workflow-page'),compact=app.ui.definitions.get('workshop.workflow-compact-page');
if(!cards||!compact)throw Error('Both skins must be generated');
s.keys=[{id:'test.skin.cards',kind:'overlay'},{id:'test.skin.compact',kind:'overlay'}];
for(const [index,definition] of [cards,compact].entries())app.ui.definitions.set(s.keys[index].id,{...definition,...s.keys[index],modal:false,cache:'keep-one'});
s.cardHandle=await app.ui.open(s.keys[0],undefined,s.owner);
s.cardRecord=[...app.ui.records.values()].find(r=>r.definition.id===s.keys[0].id);
const view=s.cardRecord.instance.view;if(view.parts.size!==3)throw Error('Card skin did not prepare all Parts');
s.cardNodes=[...view.parts.values()].map(part=>part.node.uuid);
return true;`),
            true,
        );
        await capture('presentation-cards.png');
        assert.equal(
            await run(`
const s=globalThis.__presentation;s.compactHandle=await app.ui.open(s.keys[1],undefined,s.owner);
s.compactRecord=[...app.ui.records.values()].find(r=>r.definition.id===s.keys[1].id);
const view=s.compactRecord.instance.view;if(!view._bindLblTasks.string.startsWith('● 初次训练'))throw Error('Initial selection missing');
s.compactInstance=s.compactRecord.instance.node.uuid;s.compactShow=s.compactRecord.show.showId;return true;`),
            true,
        );
        await click('globalThis.__presentation.compactRecord.instance.view._bindBtnNext.node');
        assert.equal(
            await run(
                `const text=globalThis.__presentation.compactRecord.instance.view._bindLblTasks.string;return text.startsWith('○ 初次训练')&&text.includes('●');`,
            ),
            true,
        );
        await click('globalThis.__presentation.compactRecord.instance.view._bindBtnTrain.node');
        assert.equal(
            await run(`
const s=globalThis.__presentation;await s.until(()=>s.cardRecord.instance.view._bindLblOutput.string.includes('训练 1 次'));
if(JSON.stringify(s.cardNodes)!==JSON.stringify([...s.cardRecord.instance.view.parts.values()].map(p=>p.node.uuid)))throw Error('Progress update recreated card nodes');
if(!s.compactRecord.instance.view._bindLblOutput.string.includes('训练 1 次'))throw Error('Skins did not share domain facts');return true;`),
            true,
        );
        await capture('presentation-compact.png');
        assert.equal(
            await run(`
const s=globalThis.__presentation;await s.compactHandle.close();
s.cardRecord.instance.view._bindBtnTrain.node.emit(cc.Button.EventType.CLICK);
await s.until(()=>s.cardRecord.instance.view._bindLblOutput.string.includes('训练 2 次'));
s.compactHandle=await app.ui.open(s.keys[1],undefined,s.owner);
s.compactRecord=[...app.ui.records.values()].find(r=>r.definition.id===s.keys[1].id);
if(s.compactRecord.instance.node.uuid!==s.compactInstance||s.compactRecord.show.showId===s.compactShow)throw Error('Cache identity or show lifetime wrong');
if(!s.compactRecord.instance.view._bindLblTasks.string.startsWith('● 初次训练'))throw Error('Cached instance retained previous ViewModel selection');
if(!s.compactRecord.instance.view._bindLblOutput.string.includes('训练 2 次'))throw Error('Cached skin missed domain update');
await s.compactHandle.close();await s.cardHandle.close();return true;`),
            true,
        );
        console.log(
            'PASS: two real skins, real pointer input, shared business state, local selection, stable Part nodes and cache reopen',
        );
    } finally {
        await run(
            `const s=globalThis.__presentation;if(s){s.viewGate?.resolve();s.nativeGate?.resolve();s.partGate?.resolve();for(const f of s.fixtures)await f.close();await s.owner.close();for(const key of s.keys??[])app.ui.definitions.delete(key.id);delete globalThis.__presentation;}return true;`,
        );
    }
});
