import assert from 'node:assert/strict';
import { isolatedRuntime } from './isolated-runtime.mjs';

await isolatedRuntime(process.argv[2], 'ui-ordering', async ({ run, click, capture }) => {
    await run(`
const Base=cc.js.getClassByName('yzforge.UIView'),page=[...app.ui.records.values()].find(r=>r.interactive);
if(!Base||!page)throw Error('Framework fixture unavailable');
const r=globalThis.__ordering={clicks:[],errors:[],handles:[],releases:{}};
r.frame=()=>new Promise(resolve=>cc.director.once(cc.Director.EVENT_AFTER_DRAW,resolve));
const View=cc._decorator.ccclass('test.OrderingPopup')(class extends Base{
 onShow(show){
  this.node.getChildByName('Title').getComponent(cc.Label).string=show.params.name;
  show.listen(this.node,cc.Button.EventType.CLICK,()=>r.clicks.push(show.params.name));
 }
});
r.owner=app.flows.child('ui-ordering');r.root=new cc.Node('OrderingFixture');r.root.layer=app.ui.root.layer;
r.root.addComponent(cc.UITransform).setContentSize(app.ui.root.getComponent(cc.UITransform).contentSize);app.ui.root.addChild(r.root);
const node=r.template=new cc.Node('Popup');node.active=false;node.layer=r.root.layer;
node.addComponent(cc.UITransform).setContentSize(460,290);node.addComponent(View);node.addComponent(cc.Button).transition=cc.Button.Transition.NONE;
const g=node.addComponent(cc.Graphics);g.fillColor=new cc.Color(59,147,210);g.roundRect(-230,-145,460,290,18);g.fill();
const title=new cc.Node('Title');title.layer=node.layer;title.addComponent(cc.UITransform).setContentSize(440,150);
const label=title.addComponent(cc.Label);label.fontSize=64;label.lineHeight=80;label.horizontalAlign=cc.Label.HorizontalAlign.CENTER;label.verticalAlign=cc.Label.VerticalAlign.CENTER;node.addChild(title);
r.prefab=new cc.Prefab();r.prefab.data=node;
const definitions=['A','B','C'].map(name=>({id:name,kind:'popup',module:page.instance.context.id,prefab:{id:name,type:'Prefab'},cache:'keep-one'}));
const modules={assertCanOpen(){},isInternalOwner(){return true;},context(){return page.instance.context;},isReady(){return true;},quarantine(){}};
r.ui=new app.ui.constructor(r.root,{load:key=>new Promise(resolve=>r.releases[key.id]=()=>resolve(r.prefab))},modules,app.time,app.clock,definitions,r.owner,e=>r.errors.push(String(e)));
r.record=id=>[...r.ui.records.values()].find(v=>v.definition.id===id&&!v.termination);
r.order=kind=>r.ui.layers.get(kind).children.filter(n=>n.activeInHierarchy&&n.getComponent(cc.UIOpacity).opacity>0).map(n=>[...r.ui.records.values()].find(v=>v.instance?.container===n)?.definition.id);
return true;`);
    try {
        for (const completion of ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA']) {
            const actual = await run(
                `
const r=globalThis.__ordering;await Promise.all(r.handles.map(h=>h.close()));await r.ui.evictModule(r.ui.definitions.get('A').module);
r.releases={};const pending=['A','B','C'].map(name=>r.ui.open({id:name,kind:'popup'},{name},r.owner));
for(let i=0;i<20&&Object.keys(r.releases).length<3;i++)await Promise.resolve();
if(Object.keys(r.releases).length!==3)throw Error('Loads did not start');
for(const name of args.completion){r.releases[name]();await pending[['A','B','C'].indexOf(name)];}
r.handles=await Promise.all(pending);await r.frame();await r.frame();r.clicks.length=0;
return r.order('popup');`,
                { completion },
            );
            assert.deepEqual(actual, ['A', 'B', 'C']);
            await click("globalThis.__ordering.record('C').instance.node");
            assert.deepEqual(await run('return globalThis.__ordering.clicks;'), ['C']);
        }
        console.log('PASS: all six concurrent completion orders match real mouse input');

        assert.deepEqual(
            await run(`
const r=globalThis.__ordering,old=new Map([...r.ui.records.values()].map(v=>[v.definition.id,v.instance.node]));
await Promise.all(r.handles.map(h=>h.close()));r.handles=[];
for(const name of ['C','A','B']){r.handles.push(await r.ui.open({id:name,kind:'popup'},{name},r.owner));if(r.record(name).instance.node!==old.get(name))throw Error('Cache not reused');}
await r.frame();r.clicks.length=0;return r.order('popup');`),
            ['C', 'A', 'B'],
        );
        await click("globalThis.__ordering.record('B').instance.node");
        assert.deepEqual(await run('return globalThis.__ordering.clicks;'), ['B']);
        assert.equal(
            await run(`
const r=globalThis.__ordering,saved=cc.Node.prototype.setSiblingIndex;let moves=0;
cc.Node.prototype.setSiblingIndex=function(index){moves++;return saved.call(this,index);};
try{for(let i=0;i<20;i++)r.ui.updateInput();return moves;}finally{cc.Node.prototype.setSiblingIndex=saved;}`),
            0,
        );
        console.log('PASS: cache reopen changes priority; 20 unchanged refreshes move no nodes');

        await run(`
const r=globalThis.__ordering,b=r.record('B');r.hideStarted=false;r.closeSettled=false;
b.instance.view.onHide=()=>{r.hideStarted=true;return new Promise(resolve=>r.releaseHide=resolve);};
r.closing=b.handle.close().finally(()=>r.closeSettled=true);await r.frame();await r.frame();r.clicks.length=0;
if(!r.hideStarted||r.closeSettled)throw Error('Slow cleanup fixture failed');return true;`);
        await click("globalThis.__ordering.record('A').instance.node");
        assert.deepEqual(
            await run(
                `const r=globalThis.__ordering;return {clicks:r.clicks,closed:r.closeSettled,visible:r.order('popup')};`,
            ),
            {
                clicks: ['A'],
                closed: false,
                visible: ['C', 'A'],
            },
        );
        await run(
            `const r=globalThis.__ordering;r.releaseHide();await r.closing;for(const item of r.ui.cache.values())item.view.onHide=()=>{};return true;`,
        );
        console.log('PASS: hiding a modal restores the next modal before physical cleanup');

        await run(`
const r=globalThis.__ordering;await Promise.all(r.handles.map(h=>h.close()));r.ui.assets.load=async()=>r.prefab;
const original=r.ui.definitions.get('A');
r.ui.definitions.set('Overlay',{...original,id:'Overlay',kind:'overlay',modal:false,cache:'none'});
r.ui.definitions.set('Loading',{...original,id:'Loading',kind:'loading',cache:'none'});
r.handles=[];
for(const [id,kind] of [['Loading','loading'],['Overlay','overlay'],['A','popup']])r.handles.push(await r.ui.open({id,kind},{name:id},r.owner));
await r.frame();r.clicks.length=0;return true;`);
        await click("globalThis.__ordering.record('A').instance.node");
        assert.deepEqual(await run('return globalThis.__ordering.clicks;'), ['Loading']);
        await run(
            `const r=globalThis.__ordering;await r.record('Loading').handle.close();r.clicks.length=0;return true;`,
        );
        await click("globalThis.__ordering.record('A').instance.node");
        assert.deepEqual(await run('return globalThis.__ordering.clicks;'), ['Overlay']);
        await run(
            `const r=globalThis.__ordering;r.record('Overlay').instance.node.setPosition(500,0);await r.frame();r.clicks.length=0;return true;`,
        );
        await click("globalThis.__ordering.record('A').instance.node");
        assert.deepEqual(await run('return globalThis.__ordering.clicks;'), ['A']);
        console.log('PASS: fixed layer priority, default loading modal and nonmodal overlay');
        console.log(JSON.stringify({ screenshot: await capture('yzforge-ui-ordering-verified.png') }));
    } finally {
        assert.deepEqual(
            await run(`
const r=globalThis.__ordering;for(const release of Object.values(r.releases))release();r.releaseHide?.();
if(r.closing)await r.closing;await r.ui.close();await r.owner.close();r.template.destroy();r.prefab.destroy();r.root.destroy();await r.frame();return r.errors;`),
            [],
        );
    }
});
