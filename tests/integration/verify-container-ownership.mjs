import assert from 'node:assert/strict';
import { isolatedRuntime } from './isolated-runtime.mjs';

await isolatedRuntime(process.argv[2], 'container-ownership', async ({ run }) => {
    await run(`
const exported=name=>[...System.entries()].map(([,m])=>m).find(m=>m[name])?.[name];
const State=exported('State'),ViewBindings=exported('ViewBindings');
const owner=app.flows.child('container-ownership');
const page=await app.ui.pushPage({id:'showcase.virtual-list-lab-page',kind:'page'},undefined,owner);
const record=[...app.ui.records.values()].find(r=>r.definition.id==='showcase.virtual-list-lab-page');
const view=record.instance.view;
await view.list.dispose();view.list=undefined;
const scroll=view._bindNodeList.getComponent(cc.ScrollView),content=scroll.content,component=view._bindNodeList.getComponent('yzforge.VirtualList');
const assets=record.instance.context.assets.in(owner),errors=[];
const bindings=new ViewBindings(owner,()=>true,error=>errors.push(String(error)),()=>true,assets);
const options={owner,assets,key:row=>row.id,prefab:{id:'showcase/default/prefab/prefabs/virtual-list-item-part',type:'Prefab'},part:cc.js.getClassByName('showcase.VirtualListItemPart'),layout:{itemWidth:scroll.view.width,itemHeight:88,overscanRows:0},bind:()=>{},onError:error=>errors.push(String(error))};
const s={owner,page,component,content,bindings,options,State,errors,handles:[]};globalThis.__containerOwnership=s;
s.items=(rows=[],extra={})=>{const handle=bindings.items(content,new State(rows).readonly,v=>v,{...options,...extra});s.handles.push(handle);return handle;};
s.mount=(extra={})=>{const handle=component.mount({...options,...extra});s.handles.push(handle);return handle;};
s.code=action=>{try{action();return 'accepted';}catch(error){return error.code;}};
s.wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
s.until=async(test)=>{const end=Date.now()+8000;while(!test()){if(Date.now()>end)throw Error('Ownership timeout');await s.wait(5);}};
s.gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
return true;`);
    try {
        assert.equal(
            await run(`
const s=globalThis.__containerOwnership;
const list=s.mount();
if(s.code(()=>s.items())!=='BINDING_PROPERTY_OWNED')throw Error('Empty list did not own Content');
list.setItems([{id:1}]);await list.ready;await list.dispose();
const items=s.items();await items.ready;
if(s.code(()=>s.mount())!=='BINDING_PROPERTY_OWNED')throw Error('Mount stole an empty items container');
await items.dispose();
const again=s.mount();await again.dispose();
if(s.content.children.length)throw Error('Container not returned empty');return true;`),
            true,
        );
        console.log('PASS: empty containers reject both mount orders and can be reused after cleanup');

        assert.equal(
            await run(`
const s=globalThis.__containerOwnership;
for(const layout of [{...s.options.layout,itemHeight:0},{...s.options.layout,itemWidth:s.options.layout.itemWidth+1000}]){
 const code=s.code(()=>s.mount({layout}));
 if(!['VIRTUAL_LIST_LAYOUT','VIRTUAL_LIST_SETUP'].includes(code))throw Error('Expected setup failure: '+code);
 await s.until(()=>!s.component.session);
 const items=s.items();await items.ready;await items.dispose();
}
return true;`),
            true,
        );
        console.log('PASS: constructor and setup failures release their Content claim');

        assert.equal(
            await run(`
const s=globalThis.__containerOwnership;s.cleanup=s.gate();
const list=s.mount({bind:(_part,item)=>item.scope.defer(()=>s.cleanup.promise)});
list.setItems([{id:1}]);await list.ready;
s.component.enabled=false;
let closed=false;const closing=list.dispose().then(()=>{closed=true;});
await s.wait(20);
if(s.content.children.length||closed)throw Error('Expected hidden nodes with pending cleanup');
if(s.code(()=>s.items())!=='BINDING_PROPERTY_OWNED')throw Error('Disabled list released Content before physical cleanup');
s.component.enabled=true;
if(s.code(()=>s.mount())!=='VIRTUAL_LIST_MOUNTED')throw Error('Re-enabled component mounted during cleanup');
s.cleanup.resolve();await closing;
const items=s.items();await items.ready;await items.dispose();
return true;`),
            true,
        );
        console.log('PASS: disable/cancel retains exclusive ownership until asynchronous cleanup completes');

        assert.equal(
            await run(`
const s=globalThis.__containerOwnership;s.cleanup=s.gate();
const items=s.items([{id:1}],{bind:(_part,item)=>item.scope.defer(()=>s.cleanup.promise)});await items.ready;
let closed=false;const closing=items.dispose().then(()=>{closed=true;});await s.wait(20);
if(s.content.children.length||closed)throw Error('Expected retiring ordinary items');
if(s.code(()=>s.mount())!=='BINDING_PROPERTY_OWNED')throw Error('List mounted while ordinary items were retiring');
s.cleanup.resolve();await closing;
const list=s.mount();await list.dispose();
if(s.errors.length)throw Error(s.errors.join());return true;`),
            true,
        );
        console.log('PASS: ordinary items also retain the shared claim while retiring');
    } finally {
        await run(
            `const s=globalThis.__containerOwnership;if(s){s.cleanup?.resolve();s.component.enabled=true;for(const handle of s.handles)await handle.dispose();await s.page.close();await s.owner.close();delete globalThis.__containerOwnership;}return true;`,
        );
    }
});
