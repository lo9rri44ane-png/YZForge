import assert from 'node:assert/strict';
import { isolatedRuntime } from './isolated-runtime.mjs';

await isolatedRuntime(process.argv[2], 'preparation-tree', async ({ run }) => {
    await run(`
const exported=name=>[...System.entries()].map(([,m])=>m).find(m=>m[name])?.[name];
const State=exported('State');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(test)=>{const end=Date.now()+8000;while(!test()){if(Date.now()>end)throw Error('Open review timed out');await wait(5);}};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const state={State,wait,until,deferred,owner:app.flows.child('open-readiness-review'),fixtures:[]};
globalThis.__openReadinessReview=state;
const Base=cc.js.getClassByName('yzforge.UIView'),PartBase=cc.js.getClassByName('yzforge.GameComponent');
state.View=cc._decorator.ccclass('test.OpenReadinessView')(class extends Base{onShow(show){return state.current.hook(this,show);}});
state.Part=cc._decorator.ccclass('test.OpenReadinessTrigger')(class extends PartBase{
 onActivate(a){
  const s=state.current;s.part=this;s.partActivated=true;s.phase.set(1);
  if(s.mode==='page-component-state')s.componentBinding=a.bindings.prepare(s.inner.readonly,v=>v,{prepare:value=>{if(value){s.newStarted=true;return s.a.promise;}},render:()=>{}});
  if(s.toggle){
   s.activations++;
   if(s.activations===1)a.scope.defer(async()=>{s.cleanupStarted=true;await s.cleanup.promise;s.cleanupEnded=true;});
   else a.bindings.prepare(new State(0).readonly,v=>v,{prepare:()=>s.reactivated.promise,render:()=>{s.reactivationPrepared=true;}});
  }
 }
 onDeactivate(){
  const s=state.current;
  if(s.toggle){s.deactivations++;const first=this.__deactivate(),second=this.__deactivate();s.sameBarrier=first===second;s.barrier=first;}
 }
});
state.Dynamic=cc._decorator.ccclass('test.AdoptedReadinessPart')(class extends PartBase{onActivate(a){const s=state.current;a.bindings.prepare(s.inner.readonly,v=>v,{prepare:value=>{if(value){s.newStarted=true;return s.a.promise;}},render:()=>{}});}});
state.fixture=name=>{
 const owner=state.owner.child(name),hostNode=new cc.Node(name);app.ui.root.addChild(hostNode);hostNode.addComponent(cc.UITransform).setContentSize(400,400);
 const template=new cc.Node('Template');template.active=false;template.addComponent(cc.UITransform).setContentSize(300,200);template.addComponent(state.View);template.addComponent(state.Part);
 const prefab=new cc.Prefab();prefab.data=template;
 const key={id:name,kind:'popup'},context=app.modules.context('showcase');
 const modules={assertCanOpen(){},isInternalOwner(){return true;},context(){return context;},isReady(){return true;},quarantine(){}};
 const errors=[],ui=new app.ui.constructor(hostNode,{load:async()=>prefab},modules,app.time,app.clock,[{...key,module:'showcase',prefab:{id:'test/open-review',type:'Prefab'},cache:'keep-one'}],owner,error=>errors.push(String(error)));
 const f={owner,ui,key,errors,close:async()=>{await ui.close();await owner.close();template.destroy();prefab.destroy();hostNode.destroy();}};
 state.fixtures.push(f);return f;
};return true;`);
    try {
        for (const mode of [
            'collection-source',
            'item-internal-state',
            'part-activation-state',
            'nested-part-state',
            'page-component-state',
            'virtual-list-state',
            'adopted-component-state',
        ]) {
            const result = await run(
                `
const state=globalThis.__openReadinessReview,mode=args.mode;
const s={mode,a:state.deferred(),b:state.deferred(),source:new state.State([{id:1}]),inner:new state.State(0),phase:new state.State(0),readyChecks:0,opened:false,latestReady:false,newStarted:false};state.current=s;
const f=state.fixture('open-review-'+mode);s.fixture=f;
s.hook=(view,show)=>{
 const container=new cc.Node('Items');container.layer=view.node.layer;container.parent=view.node;container.addComponent(cc.UITransform).setContentSize(300,200);
 const originalReady=show.bindings.ready.bind(show.bindings);show.bindings.ready=()=>{s.readyChecks++;return originalReady();};
 const options={
  key:row=>row.id,prefab:{id:'showcase/default/prefab/prefabs/virtual-list-item-part',type:'Prefab'},part:cc.js.getClassByName('showcase.VirtualListItemPart'),
  bind:(part,item)=>{
   const attach=bindings=>bindings.prepare(s.inner.readonly,v=>v,{prepare:value=>{if(value){s.newStarted=true;return s.a.promise;}},render:()=>{}});
   if(mode==='part-activation-state')part.onActivate=a=>{attach(a.bindings);};
   else if(mode==='nested-part-state'){
    const nested=new cc.Node('Nested');nested.layer=part.node.layer;nested.parent=part.node;nested.addComponent(cc.UITransform).setContentSize(100,100);
    item.bindings.part(nested,new state.State({id:8}).readonly,v=>v,{key:v=>v.id,prefab:{id:'showcase/default/prefab/prefabs/virtual-list-item-part',type:'Prefab'},part:cc.js.getClassByName('showcase.VirtualListItemPart'),bind:child=>{child.onActivate=a=>{attach(a.bindings);};}});
   }else if(mode==='adopted-component-state'){
    part.onActivate=a=>{a.bindings.prepare(new state.State(0).readonly,v=>v,{prepare:async()=>{
     const child=new cc.Node('Adopted');child.active=false;child.parent=part.node;child.addComponent(state.Dynamic);
     await a.assets.bindComponents(child);child.active=true;await a.assets.bindComponents(child);
    },render:()=>{}});};
   }else if(mode==='item-internal-state'||mode==='virtual-list-state')attach(item.bindings);
   else if(mode==='collection-source')item.bindings.prepare(item.state,v=>v.data.id,{prepare:id=>{if(id===2){s.newStarted=true;return s.a.promise;}},render:()=>{}});
  },
 };
 if(mode==='virtual-list-state'){
  const node=new cc.Node('List');node.parent=view.node;node.addComponent(cc.UITransform).setContentSize(300,200);
  const viewport=new cc.Node('View');viewport.parent=node;viewport.addComponent(cc.UITransform).setContentSize(300,200);container.parent=viewport;
  const scroll=node.addComponent(cc.ScrollView);scroll.content=container;
  const list=node.addComponent(cc.js.getClassByName('yzforge.VirtualList'));
  s.region=show.bindings.list(list,s.source.readonly,v=>v,{...options,layout:{itemWidth:300,itemHeight:88,overscanRows:0}});
 }else s.region=show.bindings.items(container,s.source.readonly,v=>v,options);
 show.bindings.prepare(s.phase.readonly,v=>v,{prepare:value=>value?s.b.promise:undefined,render:()=>{}});
};
s.opening=f.ui.open(f.key,undefined,f.owner).then(handle=>{s.handle=handle;s.opened=true;},error=>{s.openError=String(error);});
try{
 await state.until(()=>s.partActivated&&s.readyChecks>=2);await s.region.ready;await state.wait(20);
 if(mode==='collection-source')s.source.set([{id:2}]);else s.inner.set(1);
 s.latest=(mode==='page-component-state'?s.componentBinding.ready:s.region.ready).then(()=>{s.latestReady=true;});
 await state.until(()=>s.newStarted);s.b.resolve();await state.wait(60);
 const record=[...f.ui.records.values()][0];
 return {mode,readyChecks:s.readyChecks,openResolved:s.opened,interactive:record?.interactive,latestRequiredReady:s.latestReady,latestPreparationStarted:s.newStarted,openError:s.openError,errors:f.errors};
}finally{s.a.resolve();s.b.resolve();await s.opening;await s.latest;if(!s.opened||s.openError)throw Error(s.openError??'Open failed after readiness');await f.close();}
`,
                { mode },
            );
            assert.equal(result.openResolved, false);
            assert.equal(result.interactive, false);
            assert.equal(result.latestRequiredReady, false);
            assert.equal(result.latestPreparationStarted, true);
            assert.deepEqual(result.errors, []);
            assert.equal(result.openError, undefined);
            console.log('PASS: UIManager.open waits for latest required preparation: ' + mode);
        }
        for (const mode of ['disable-only', 'reenable', 'disable-again', 'repeated-disable', 'repeated-reenable']) {
            const enabled = mode === 'reenable' || mode === 'repeated-reenable';
            const result = await run(
                `
const state=globalThis.__openReadinessReview,mode=args.mode;
const s={mode,toggle:true,phase:new state.State(0),b:state.deferred(),cleanup:state.deferred(),reactivated:state.deferred(),readyChecks:0,opened:false,activations:0,deactivations:0,cleanupEnded:false,reactivationPrepared:false};state.current=s;
const f=state.fixture('preparation-toggle-'+mode);
s.hook=(_view,show)=>{
 const original=show.bindings.ready.bind(show.bindings);show.bindings.ready=()=>{s.readyChecks++;return original();};
 show.bindings.prepare(s.phase.readonly,v=>v,{prepare:value=>value?s.b.promise:undefined,render:()=>{}});
};
s.opening=f.ui.open(f.key,undefined,f.owner).then(()=>{s.opened=true;},error=>{s.openError=String(error);});
try{
 await state.until(()=>s.readyChecks>=2);await state.wait(20);
 s.part.enabled=false;
 if(mode==='reenable')s.part.enabled=true;
 if(mode==='disable-again'){s.part.enabled=true;s.part.enabled=false;}
 if(mode.startsWith('repeated-')){
  for(let index=0;index<20;index++){s.part.enabled=true;s.part.enabled=false;}
  if(mode==='repeated-reenable')s.part.enabled=true;
 }
 await state.until(()=>s.cleanupStarted);
 let drained=false;s.barrier.then(()=>{drained=true;});
 s.b.resolve();
 if(args.enabled)await state.wait(60);else await state.until(()=>s.opened||s.openError);
 const before={opened:s.opened,enabled:s.part.enabledInHierarchy,interactive:[...f.ui.records.values()][0]?.interactive,drained,cleanupEnded:s.cleanupEnded,activations:s.activations,deactivations:s.deactivations,sameBarrier:s.sameBarrier};
 s.cleanup.resolve();await s.barrier;
 let afterCleanup;
 if(args.enabled){
  await state.until(()=>s.activations===2);await state.wait(40);
  afterCleanup={opened:s.opened,cleanupEnded:s.cleanupEnded,reactivationPrepared:s.reactivationPrepared};
 }
 s.reactivated.resolve();await s.opening;
 return {before,afterCleanup,after:{opened:s.opened,activations:s.activations,reactivationPrepared:s.reactivationPrepared},openError:s.openError,errors:f.errors};
}finally{s.cleanup.resolve();s.reactivated.resolve();s.b.resolve();await s.opening;await f.close();}
`,
                { mode, enabled },
            );
            assert.deepEqual(result.before, {
                opened: !enabled,
                enabled,
                interactive: !enabled,
                drained: false,
                cleanupEnded: false,
                activations: 1,
                deactivations: 1,
                sameBarrier: true,
            });
            if (enabled)
                assert.deepEqual(result.afterCleanup, {
                    opened: false,
                    cleanupEnded: true,
                    reactivationPrepared: false,
                });
            assert.deepEqual(result.after, {
                opened: true,
                activations: enabled ? 2 : 1,
                reactivationPrepared: enabled,
            });
            assert.equal(result.openError, undefined);
            assert.deepEqual(result.errors, []);
            console.log('PASS: component toggles separate current preparation from physical cleanup: ' + mode);
        }
    } finally {
        await run(
            `const state=globalThis.__openReadinessReview;state.current?.a?.resolve();state.current?.b?.resolve();state.current?.cleanup?.resolve();state.current?.reactivated?.resolve();for(const f of state.fixtures)await f.close();await state.owner.close();delete globalThis.__openReadinessReview;return true;`,
        );
    }
});
