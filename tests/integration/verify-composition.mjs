import assert from 'node:assert/strict';
import { isolatedRuntime } from './isolated-runtime.mjs';

await isolatedRuntime(process.argv[2], 'composition', async ({ run, click, capture }) => {
    await run(`
const exported=name=>[...System.entries()].map(([,m])=>m).find(m=>m[name])?.[name];
const State=exported('State'),Command=exported('Command'),ViewBindings=exported('ViewBindings');
const owner=app.flows.child('composition-check');
const page=await app.ui.pushPage({id:'workshop.workflow-page',kind:'page'},undefined,owner);
const record=[...app.ui.records.values()].find(r=>r.definition.id==='workshop.workflow-page');
const ctx=record.instance.context,Part=cc.js.getClassByName('workshop.TaskPart');
const hostNode=new cc.Node('CompositionCheck');hostNode.layer=record.instance.node.layer;hostNode.parent=app.ui.root;
hostNode.addComponent(cc.UITransform).setContentSize(680,1000);owner.defer(()=>{hostNode.destroy();});
const container=new cc.Node('Items');container.layer=hostNode.layer;container.parent=hostNode;
container.addComponent(cc.UITransform).setContentSize(650,800);
const layout=container.addComponent(cc.Layout);layout.type=cc.Layout.Type.VERTICAL;layout.resizeMode=cc.Layout.ResizeMode.CONTAINER;layout.spacingY=20;
const state=new State([]),errors=[],calls=[],bindings=new ViewBindings(owner,()=>true,error=>errors.push(String(error)),()=>true,ctx.assets.in(owner));
const claim=new Command(owner,{policy:'exclusive',execute:async(card)=>{calls.push(card.id);}});
const call={owner,context:undefined};
const row=(id,title='Task '+id)=>({id,title,goal:1,progress:1,reward:10,state:'ready'});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const s={owner,page,root:hostNode,container,state,row,errors,calls,bindings,gate:undefined,created:0,moves:0,claim,call};
globalThis.__composition=s;
s.region=bindings.items(container,state.readonly,value=>value,{
 key:card=>card.id,prefab:{id:'workshop/default/prefab/prefabs/task-part',type:'Prefab'},part:Part,
 bind:(part,item)=>{
  s.created++;part.bind(item,claim,call);
  item.bindings.prepare(item.state,v=>v.data.title,{prepare:title=>title.startsWith('Async ')?s.updateGate.promise:undefined,render:()=>{}});
  const move=part.node.setSiblingIndex;part.node.setSiblingIndex=function(index){s.moves++;return move.call(this,index);};
  if(item.key===9){s.pending=part;s.pendingItem=item;item.bindings.prepare(item.state,v=>v.data.id,{prepare:()=>s.gate.promise,render:()=>{}});}
 },onError:error=>errors.push(String(error)),
});
s.cells=()=>container.children.map(node=>node.getComponent(Part));
s.until=async(test)=>{const end=Date.now()+10000;while(!test()){if(Date.now()>end)throw Error('Composition timeout');await new Promise(resolve=>setTimeout(resolve,5));}};
s.deferred=deferred;
state.set([row(1),row(2)]);await s.region.ready;
if(s.cells().length!==2)throw Error('Initial Parts missing');
s.first=s.cells()[0];s.second=s.cells()[1];return true;`);
    try {
        assert.equal(
            await run(`
const s=globalThis.__composition;
s.state.set([s.row(2,'updated'),s.row(3)]);await s.region.ready;
if(s.cells()[0]!==s.second||s.cells()[0]._bindLblTitle.string!=='updated')throw Error('Same-key update replaced Part or failed to render');
await s.until(()=>!cc.isValid(s.first,true));
const uuids=s.cells().map(p=>p.node.uuid),created=s.created;s.moves=0;
for(let i=0;i<20;i++){s.region.refresh();await s.region.ready;}
if(s.moves!==0||s.created!==created)throw Error('Unchanged collection moved or recreated nodes');
s.state.set([s.row(3),s.row(2,'reordered')]);await s.region.ready;
if(s.cells()[1]!==s.second||s.created!==created)throw Error('Reorder rebound stable key');
if(s.cells().map(p=>p.node.uuid).join()!==uuids.reverse().join())throw Error('Sibling order wrong');
return true;`),
            true,
        );
        console.log(
            'PASS: real Parts retain identity, update state, reorder correctly, and refresh 20 times with zero extra moves',
        );

        assert.equal(
            await run(`
const s=globalThis.__composition;
const outer=s.root.addComponent(cc.Layout);outer.type=cc.Layout.Type.VERTICAL;outer.resizeMode=cc.Layout.ResizeMode.CONTAINER;
s.container.getComponent(cc.Layout).updateLayout();outer.updateLayout();
if(s.root.getComponent(cc.UITransform).height!==s.container.getComponent(cc.UITransform).height)throw Error('Preparing container changed ancestor Layout');
outer.enabled=false;
s.firstGate=s.deferred();s.updateGate=s.firstGate;s.state.set([s.row(2,'Async first')]);
let ready=false;const preparing=s.region.ready.then(()=>{ready=true;});
await s.until(()=>s.second._bindLblTitle.string==='Async first');
await new Promise(resolve=>setTimeout(resolve,25));if(ready)throw Error('Same-key readiness ignored resource preparation');
s.updateGate=s.deferred();s.state.set([s.row(2,'Async latest')]);
await s.until(()=>s.second._bindLblTitle.string==='Async latest');
s.firstGate.resolve();await new Promise(resolve=>setTimeout(resolve,25));
if(ready)throw Error('Readiness returned before latest same-key revision');
s.updateGate.resolve();await preparing;
if(s.cells()[0]!==s.second)throw Error('Async update replaced stable Part');
return true;`),
            true,
        );
        console.log(
            'PASS: staging is excluded from ancestor Layout; same-key readiness follows the latest required resources',
        );

        await run(`
const s=globalThis.__composition;s.state.set([s.row(2,'Displayed A')]);await s.region.ready;
s.gate=s.deferred();s.state.set([s.row(9,'Candidate B')]);
await s.until(()=>s.pending);s.root.resumeSystemEvents(true);
s.pending._bindBtnClaim.node.emit(cc.Button.EventType.CLICK);
await new Promise(resolve=>setTimeout(resolve,20));
if(s.calls.length||s.cells()[0]!==s.second)throw Error('Candidate received input or displaced old display');
return true;`);
        await click('globalThis.__composition.second._bindBtnClaim.node');
        assert.equal(
            await run(`
const s=globalThis.__composition;await s.until(()=>s.calls.length===1);
if(s.calls[0]!==2)throw Error('Click targeted pending data instead of displayed Part');
s.gate.resolve();await s.region.ready;
if(s.cells()[0]._bindLblTitle.string!=='Candidate B')throw Error('Candidate did not commit');return true;`),
            true,
        );
        await click('globalThis.__composition.cells()[0]._bindBtnClaim.node');
        assert.deepEqual(
            await run(`const s=globalThis.__composition;await s.until(()=>s.calls.length===2);return s.calls;`),
            [2, 9],
        );
        await capture('composition-committed-input.png');
        console.log(
            'PASS: hidden candidate rejects input; real pointer clicks target the displayed identity before and after handoff',
        );

        assert.equal(
            await run(`
const s=globalThis.__composition;
await s.region.dispose();await s.bindings.ready();
if(s.container.children.length)throw Error('Disposed collection retained nodes');
const source=new (s.state.constructor)(s.row(7));
s.nestedGate=s.deferred();
const single=s.bindings.part(s.container,source.readonly,row=>row,{
 key:row=>row.id,prefab:{id:'workshop/default/prefab/prefabs/task-part',type:'Prefab'},part:cc.js.getClassByName('workshop.TaskPart'),bind:(part,item)=>{
  part.bind(item,s.claim,s.call);
  const slot=new cc.Node('NestedSlot');slot.layer=part.node.layer;slot.parent=part.node;slot.addComponent(cc.UITransform).setContentSize(500,150);
  item.bindings.part(slot,new (s.state.constructor)(s.row(8)).readonly,row=>row,{
   key:row=>row.id,prefab:{id:'workshop/default/prefab/prefabs/task-part',type:'Prefab'},part:cc.js.getClassByName('workshop.TaskPart'),bind:(child,context)=>{
    child.bind(context,s.claim,s.call);
    child.onActivate=activation=>{s.nestedStarted=true;activation.bindings.prepare(context.state,v=>v.data.id,{prepare:()=>s.nestedGate.promise,render:()=>{s.nestedPainted=true;}});};
   },
  });
 },
});
let opened=false;const opening=s.bindings.ready().then(()=>{opened=true;});
await s.until(()=>s.nestedStarted||opened);await new Promise(resolve=>setTimeout(resolve,25));
if(opened)throw Error('Nested Part activation bypassed readiness');
s.nestedGate.resolve();await opening;
if(!s.nestedPainted)throw Error('Nested Part was not prepared');
if(s.cells().length!==1||s.cells()[0]._bindLblTitle.string!=='Task 7')throw Error('Single Part did not join readiness');
source.set(undefined);await single.ready;
if(s.container.children.length)throw Error('Undefined did not clear single region');
await single.dispose();await s.bindings.ready();
if(s.errors.length)throw Error(s.errors.join());return true;`),
            true,
        );
        console.log(
            'PASS: disposal removes readiness, nested Part activation joins readiness, and a single Part clears on undefined',
        );
    } finally {
        await run(
            `const s=globalThis.__composition;if(s){s.gate?.resolve();s.firstGate?.resolve();s.updateGate?.resolve();s.nestedGate?.resolve();await s.owner.close();await s.page.close();delete globalThis.__composition;}return true;`,
        );
    }
});
