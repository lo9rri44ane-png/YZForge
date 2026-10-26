import assert from 'node:assert/strict';
import { isolatedRuntime } from './isolated-runtime.mjs';

await isolatedRuntime(process.argv[2], 'list-layouts', async ({ run, click, drag, resize, capture }) => {
    await run(
        `const owner=app.flows.child('list-layouts'),bindings=new Map(),prototype=cc.js.getClassByName('showcase.VirtualListItemPart').prototype,originalBind=prototype.bind;prototype.bind=function(item){bindings.set(item.key,item);return originalBind.call(this,item);};const handle=await app.ui.pushPage({id:'showcase.virtual-list-lab-page',kind:'page'},undefined,owner);const record=Array.from(app.ui.records.values()).find(r=>r.handle===handle);globalThis.__listLayoutTest={owner,handle,view:record.instance.view,bindings,prototype,originalBind};return true;`,
    );
    const check = (code) =>
        run(
            `const v=globalThis.__listLayoutTest.view,list=v.list,scroll=v.nodeList.getComponent(cc.ScrollView);const check=(value,message)=>{if(!value)throw Error(message);};await list.ready;${code}`,
        );
    const mode = () => click('globalThis.__listLayoutTest.view.btnMode.node');
    await mode();
    await mode();
    const horizontal = await check(
        `check(scroll.horizontal&&!scroll.vertical,'Horizontal axis not applied');list.scrollToIndex(4999,'center');await list.ready;check(list.inspect().indices.includes(4999),'Horizontal jump missing target');check(scroll.getScrollOffset().x<0&&Math.abs(scroll.getScrollOffset().y)<1,'Horizontal offset sign');const before=scroll.getScrollOffset().x;list.scrollToIndex(4999,'nearest');check(Math.abs(before-scroll.getScrollOffset().x)<1,'Nearest moved visible horizontal row');list.scrollToIndex(9999,'end');await list.ready;check(Math.abs(-scroll.getScrollOffset().x-scroll.getMaxScrollOffset().x)<1,'Horizontal last item clipped');list.scrollToIndex(0);await list.ready;return list.inspect();`,
    );
    assert.ok(horizontal.slots < 15);
    await drag('globalThis.__listLayoutTest.view.nodeList', { x: -160, y: 0 });
    await check(
        `check(scroll.getScrollOffset().x<0,'Real horizontal drag failed');scroll.stopAutoScroll();return true;`,
    );
    console.log(await capture('virtual-list-horizontal.png'));
    await check(
        `list.scrollToIndex(1);await list.ready;const test=globalThis.__listLayoutTest;test.survivors=[2,3].map(key=>test.bindings.get(key));check(test.survivors.every(item=>item&&!item.signal.aborted),'Missing axis-switch fixture');return true;`,
    );
    await mode();
    await check(
        `const test=globalThis.__listLayoutTest;check(test.survivors.every(item=>!item.signal.aborted&&test.bindings.get(item.key)===item),'Axis switch cancelled a still-visible binding');return true;`,
    );
    const variable = await check(
        `check(!scroll.horizontal&&scroll.vertical,'Vertical axis not restored');check(Math.abs(scroll.getScrollOffset().x)<1&&Math.abs(scroll.getScrollOffset().y)<1,'Axis change retained old offset');list.scrollToIndex(4999,'center');await list.ready;check(list.inspect().indices.includes(4999),'Variable jump missing target');const cells=scroll.content.children.filter(n=>n.active).sort((a,b)=>b.position.y-a.position.y);const heights=cells.map(n=>n.getComponent(cc.UITransform).height);check(new Set(heights).size>1,'Variable row heights missing');for(let i=1;i<cells.length;i++){const a=cells[i-1],b=cells[i],at=a.getComponent(cc.UITransform),bt=b.getComponent(cc.UITransform);const bottom=a.position.y-at.height*at.anchorY,top=b.position.y+bt.height*(1-bt.anchorY);check(Math.abs(bottom-top-8)<0.01,'Rows overlap or have wrong spacing');}return {state:list.inspect(),heights};`,
    );
    const target = `const target=scroll.content.children.find(n=>n.active&&n.getComponent('showcase.VirtualListItemPart').lblTitle.string.includes('#5000'));check(target,'Updated row missing');return {uuid:target.uuid,height:target.getComponent(cc.UITransform).height};`;
    const before = await check(target);
    await click('globalThis.__listLayoutTest.view.btnRefresh.node');
    const after = await check(target);
    assert.equal(after.uuid, before.uuid, 'Same-key height update replaced the node');
    assert.notEqual(after.height, before.height, 'Data update did not apply the new height');
    for (const [width, height] of [
        [720, 1280],
        [720, 1600],
        [768, 1024],
        [1280, 720],
        [1920, 1080],
        [2560, 1080],
        [1280, 800],
        [1024, 768],
    ]) {
        await resize(width, height);
        const state = await check(
            `list.scrollToIndex(9999,'end');await list.ready;check(list.inspect().range.end===10000,'Resize lost last row');check(Math.abs(scroll.getScrollOffset().y-scroll.getMaxScrollOffset().y)<1,'Variable end not clamped');check(list.inspect().slots<100,'Resize exceeded pool budget');return {viewport:[scroll.view.width,scroll.view.height],slots:list.inspect().slots};`,
        );
        console.log(JSON.stringify({ width, height, ...state }));
    }
    await resize(720, 1280);
    console.log(await capture('virtual-list-variable.png'));
    await click('globalThis.__listLayoutTest.view.btnData.node');
    await check(
        `await list.whenIdle();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));check(list.count===0&&scroll.content.children.length===0,'Empty variable list retained nodes: '+JSON.stringify({count:list.count,children:scroll.content.children.length}));return true;`,
    );
    await click('globalThis.__listLayoutTest.view.btnData.node');
    await check(`check(list.count===10000,'Variable list failed to repopulate');return true;`);
    const closed = await run(
        `try{await globalThis.__listLayoutTest.owner.close();await app.close();return app.inspect();}catch(error){throw Error(JSON.stringify(error,(_key,value)=>value instanceof Error?{message:value.message,code:value.code,details:value.details,cause:value.cause}:value));}finally{const test=globalThis.__listLayoutTest;test.prototype.bind=test.originalBind;}`,
    );
    assert.equal(closed.scope.state, 'closed');
    assert.deepEqual(closed.modules, []);
    assert.deepEqual(closed.ui.views, []);
    console.log(JSON.stringify({ ok: true, horizontal, variable }));
});
