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
const state={State,derive:exported('derive'),Command:exported('Command'),ViewBindings:exported('ViewBindings'),wait,until,deferred,owner:app.flows.child('presentation-check'),fixtures:[]};
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
s.hook=(_view,show)=>{
 const source=new s.State(0),derived=s.derive(show.scope,[source.readonly],n=>{if(n)throw Error('expected source failure');return n;},{onError:()=>{}});
 source.set(1);show.bindings.watch(derived,n=>n,()=>{throw Error('Failed source rendered');});
};
let sourceFailed=false;try{await f.ui.open(f.key,undefined,f.owner);}catch(error){sourceFailed=String(error).includes('expected source failure');}
if(!sourceFailed)throw Error('Required source failure was hidden');
await s.until(()=>f.ui.records.size===0);
await f.close();if(f.errors.length)throw Error(f.errors.join());return true;`),
            true,
        );
        console.log(
            'PASS: cancelled preparation retains resources until physical completion; preparation and derived source failures are delivered',
        );

        assert.equal(
            await run(`
const s=globalThis.__presentation;
const cards=app.ui.definitions.get('workshop.workflow-page'),compact=app.ui.definitions.get('workshop.workflow-compact-page');
if(!cards||!compact)throw Error('Both skins must be generated');
s.keys=[{id:'test.skin.cards',kind:'popup'},{id:'test.skin.compact',kind:'popup'}];
for(const [index,definition] of [cards,compact].entries())app.ui.definitions.set(s.keys[index].id,{...definition,...s.keys[index],modal:false,cache:'keep-one'});
s.cardHandle=await app.ui.open(s.keys[0],undefined,s.owner);
s.cardRecord=[...app.ui.records.values()].find(r=>r.definition.id===s.keys[0].id);
const view=s.cardRecord.instance.view;if(view._bindNodeItems.children.length!==3)throw Error('Card skin did not prepare all Parts');
s.cardNodes=view._bindNodeItems.children.map(node=>node.uuid);
const part=view._bindNodeItems.children[0].getComponent('workshop.TaskPart');let partClicks=0;
const off=part.activation.bindings.listen(part.node,'test-part-input',()=>{partClicks++;});
app.ui.setInteractive(s.cardRecord,false);part.node.emit('test-part-input');await s.wait(0);
if(partClicks!==0)throw Error('Part activation bypassed View input restriction');
app.ui.setInteractive(s.cardRecord,true);part.node.emit('test-part-input');await s.wait(0);
if(partClicks!==1)throw Error('Part activation did not restore input');off();
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
if(JSON.stringify(s.cardNodes)!==JSON.stringify(s.cardRecord.instance.view._bindNodeItems.children.map(node=>node.uuid)))throw Error('Progress update recreated card nodes');
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
return true;`),
            true,
        );
        console.log(
            'PASS: two real skins, real pointer input, shared business state, local selection, stable Part nodes and cache reopen',
        );

        await click('globalThis.__presentation.compactRecord.instance.view._bindBtnClaim.node');
        await run(
            `const s=globalThis.__presentation;await s.until(()=>[...app.ui.records.values()].some(r=>r.definition.id==='workshop.claim-popup'&&r.interactive));s.popup=[...app.ui.records.values()].find(r=>r.definition.id==='workshop.claim-popup');if(s.compactRecord.instance.view._bindBtnClaim.interactable)throw Error('Command button did not lock');return true;`,
        );
        await click('globalThis.__presentation.popup.instance.view._bindBtnCancel.node');
        await run(
            `const s=globalThis.__presentation;await s.until(()=>s.compactRecord.instance.view._bindBtnClaim.interactable);if(!s.compactRecord.instance.view._bindLblOutput.string.includes('已取消'))throw Error('Cancellation feedback missing');return true;`,
        );
        await click('globalThis.__presentation.compactRecord.instance.view._bindBtnClaim.node');
        await run(
            `const s=globalThis.__presentation;await s.until(()=>[...app.ui.records.values()].some(r=>r.definition.id==='workshop.claim-popup'&&r.interactive));s.popup=[...app.ui.records.values()].find(r=>r.definition.id==='workshop.claim-popup');return true;`,
        );
        await click('globalThis.__presentation.popup.instance.view._bindBtnConfirm.node');
        await run(
            `const s=globalThis.__presentation;await s.until(()=>s.compactRecord.instance.view._bindLblOutput.string.includes('余额 20 金币'));if(s.compactRecord.instance.view._bindBtnClaim.interactable)throw Error('Claimed item is still enabled');if(!s.cardRecord.instance.view._bindLblOutput.string.includes('余额 20 金币'))throw Error('Shared reward state not rendered');await s.compactHandle.close();await s.cardHandle.close();return true;`,
        );
        console.log(
            'PASS: real command button input, confirmation cancellation, cleanup admission and shared reward rendering',
        );

        assert.equal(
            await run(`
try {
const s=globalThis.__presentation,owner=s.owner.child('shared-command'),bindingOwner=owner.child('button-a');
const root=new cc.Node('command-binding-check');app.ui.root.addChild(root);
const a=new cc.Node('a'),b=new cc.Node('b');root.addChild(a);root.addChild(b);
const first=a.addComponent(cc.Button),second=b.addComponent(cc.Button),gate=s.deferred(),input=new s.State({id:1});
let calls=0,cancelled=false;
const command=new s.Command(owner,{policy:'exclusive',execute:async(_args,task)=>{calls++;task.signal.onAbort(()=>cancelled=true);await gate.promise;}});
const one=new s.ViewBindings(bindingOwner),two=new s.ViewBindings(owner),options={args:v=>v.id,call:{owner,context:undefined}};
const binding=one.command(first,command,input.readonly,options);two.command(second,command,input.readonly,options);
let conflict=false;try{two.property(first,'interactable',input.readonly,()=>true);}catch(error){conflict=error.code==='BINDING_PROPERTY_OWNED';}
if(!conflict)throw Error('Managed property conflict not detected');
a.emit(cc.Button.EventType.CLICK);await s.until(()=>calls===1);
if(first.interactable||second.interactable)throw Error('Shared command buttons did not agree');
await binding.dispose();if(cancelled)throw Error('Unbinding a button cancelled the borrowed command');
gate.resolve();await s.until(()=>second.interactable);if(calls!==1)throw Error('Duplicate command');
await owner.close();root.destroy();return true;
} catch(error) { return {failure:String(error.stack??error)}; }`),
            true,
        );
        console.log('PASS: shared command bindings, property ownership and detach without cancelling borrowed work');

        assert.equal(
            await run(`
try {
const s=globalThis.__presentation,owner=s.owner.child('native-command'),root=new cc.Node('async-button-check');
root.active=false;app.ui.root.addChild(root);root.addComponent(cc.UITransform);
const Type=cc.js.getClassByName('yzforge.AsyncButton');if(!Type)throw Error('AsyncButton missing');
const button=root.addComponent(Type);button.autoGuard=false;root.active=true;
await s.until(()=>button.lifetime.context);
const gate=s.deferred();let delivered=false;
const result=button.run(task=>{task.scope.defer(()=>gate.promise);throw Error('expected button failure');}).then(()=>{throw Error('Button hid failure');},error=>{if(!String(error).includes('expected button failure'))throw error;delivered=true;});
await result;
if(!delivered||button.interactable||!button.runningConvenience)throw Error('Button feedback or cleanup lock wrong');
if(await button.run(()=>{})!==false)throw Error('Button admitted work before cleanup');
gate.resolve();await s.until(()=>!button.runningConvenience&&button.interactable);
const handle=button.bind(owner,()=>{}),bindings=new s.ViewBindings(owner),input=new s.State(1);
const command=new s.Command(owner,{policy:'exclusive',execute:()=>{}});
let conflict=false;try{bindings.command(button,command,input.readonly,{args:()=>undefined,call:{owner,context:undefined}});}catch(error){conflict=error.code==='BINDING_PROPERTY_OWNED';}
if(!conflict)throw Error('AsyncButton property ownership not shared');
await handle.dispose();await owner.close();root.destroy();return true;
} catch(error) { return {failure:String(error.stack??error)}; }`),
            true,
        );
        console.log(
            'PASS: native AsyncButton delivers failure before cleanup, keeps its lock and shares property ownership',
        );

        assert.equal(
            await run(`
const s=globalThis.__presentation;
s.page=await app.ui.pushPage({id:'workshop.workflow-compact-page',kind:'page'},undefined,s.owner);
s.pageRecord=[...app.ui.records.values()].find(r=>r.definition.id==='workshop.workflow-compact-page');
s.session=s.pageRecord.show.session;s.oldShow=s.pageRecord.show;
s.pageRecord.instance.view._bindBtnNext.node.emit(cc.Button.EventType.CLICK);
await s.until(()=>s.pageRecord.instance.view._bindLblTasks.string.includes('● 持续练习'));
if(!s.pageRecord.instance.view._bindLblTasks.string.includes('● 持续练习'))throw Error('Selection did not move');
s.selectedText=s.pageRecord.instance.view._bindLblTasks.string;
await s.pageRecord.show.ui.pushPage({id:'workshop.workflow-page',kind:'page'},undefined);
await s.until(()=>s.pageRecord.suspended&&!s.pageRecord.show);
if(s.session.scope.signal.aborted)throw Error('Suspension ended page session');
app.ui.back();
await s.until(()=>s.pageRecord.interactive&&s.pageRecord.show!==s.oldShow);
if(s.pageRecord.show.session!==s.session)throw Error('Back recreated page session');
if(s.pageRecord.instance.view._bindLblTasks.string!==s.selectedText)throw Error('Back lost local selection');
let stale=false;try{await s.oldShow.ui.open({id:'workshop.claim-popup',kind:'popup'},{title:'stale',detail:'stale'});}catch(error){stale=error.code==='OPERATION_CANCELLED';}
if(!stale)throw Error('Stale display accepted interaction');
await s.page.close();
if(!s.session.scope.signal.aborted)throw Error('Close retained page session');
return true;`),
            true,
        );
        console.log(
            'PASS: navigation keeps the page model and selection, rebuilds display bindings, rejects stale UI and closes the session',
        );
    } finally {
        await run(
            `const s=globalThis.__presentation;if(s){s.viewGate?.resolve();s.nativeGate?.resolve();s.partGate?.resolve();for(const f of s.fixtures)await f.close();await s.owner.close();for(const key of s.keys??[])app.ui.definitions.delete(key.id);delete globalThis.__presentation;}return true;`,
        );
    }
});
