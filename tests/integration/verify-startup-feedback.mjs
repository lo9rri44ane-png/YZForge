import assert from 'node:assert/strict';
import { isolatedRuntime } from './isolated-runtime.mjs';

await isolatedRuntime(process.argv[2], 'startup-feedback', async ({ run, capture }) => {
    await run(`
const r=globalThis.__startup={notices:[],constructions:0,stops:0,disposals:0,mode:'sdk',settled:false};
r.frame=()=>new Promise(resolve=>cc.director.once(cc.Director.EVENT_AFTER_DRAW,resolve));
r.until=async test=>{const end=Date.now()+8000;while(!test()){if(Date.now()>end)throw Error('Startup check timeout');await new Promise(resolve=>setTimeout(resolve,5));}};
r.node=new cc.Node('StartupProbe');r.node.active=false;cc.director.getScene().addChild(r.node);
r.uiRoot=new cc.Node('StartupProbeUI');r.uiRoot.layer=app.ui.root.layer;r.uiRoot.addComponent(cc.UITransform).setContentSize(720,1280);app.ui.root.addChild(r.uiRoot);
const statusNode=new cc.Node('StartupStatus');statusNode.layer=r.uiRoot.layer;statusNode.addComponent(cc.UITransform).setContentSize(640,240);r.uiRoot.addChild(statusNode);
r.status=statusNode.addComponent(cc.Label);r.status.fontSize=26;r.status.lineHeight=36;r.status.string='正在启动…';
r.entry=r.node.addComponent(cc.js.getClassByName('game.GameRoot'));r.entry.bootStatus=r.status;
const source=entry.appOptions();r.physical=new Promise(resolve=>r.releaseSdk=resolve);
for(const layer of app.ui.layers.values())layer.active=false;cc.profiler.hideStats();
r.entry.appOptions=()=>{
 r.constructions++;
 return {...source,root:r.node,uiRoot:r.uiRoot,modules:[],views:[],maxAudioVoices:r.mode==='constructor'?0:16,
  settings:{...source.settings,previewMockSdk:false,sdk:{...source.settings.sdk,integration:'startup-check',timeoutMs:30}},
  sdkIntegrations:{'startup-check':()=>({id:'startup-check',initialize:()=>r.mode==='sdk'?r.physical:Promise.resolve(),stop(){r.stops++;},dispose(){r.disposals++;}})}};
};
r.entry.onBoot=(_app,boot)=>{
 if(r.mode==='business'){boot.scope.defer(()=>new Promise(resolve=>r.releaseBusiness=resolve));throw Error('EXPECTED_STARTUP_FAILURE');}
 r.status.string='启动完成';
};
const cleaning=r.entry.onBootCleaning;
r.entry.onBootCleaning=function(error){cleaning.call(this,error);r.notices.push(error);r.reentrant=this.retryBoot();};
r.start=()=>{r.settled=false;r.pending=r.entry.retryBoot();r.outcome=r.pending.then(()=>{r.settled=true;return null;},error=>{r.settled=true;return {code:error.code,message:error.message};});};
return true;`);
    try {
        const held = await run(`
const r=globalThis.__startup;r.start();await r.until(()=>r.notices.length===1&&r.stops===1);await r.frame();
return {settled:r.settled,constructions:r.constructions,disposals:r.disposals,retryShared:r.reentrant===r.pending&&r.entry.retryBoot()===r.pending,status:r.status.string,active:r.status.node.active};`);
        assert.equal(held.settled, false);
        assert.equal(held.constructions, 1);
        assert.equal(held.disposals, 0);
        assert.equal(held.retryShared, true);
        assert.equal(held.active, true);
        assert.match(held.status, /启动失败，正在清理/);
        assert.match(held.status, /SDK 调用超时/);
        console.log(JSON.stringify({ case: 'SDK timeout feedback before physical drain', ...held }));
        console.log(JSON.stringify({ screenshot: await capture('yzforge-startup-cleaning-verified.png') }));
        assert.deepEqual(
            await run(`
const r=globalThis.__startup;r.releaseSdk();const outcome=await r.outcome;return {code:outcome.code,disposals:r.disposals,layers:r.uiRoot.children.filter(n=>n.name!=='StartupStatus').length};`),
            {
                code: 'SDK_TIMEOUT',
                disposals: 1,
                layers: 0,
            },
        );

        assert.deepEqual(
            await run(`
const r=globalThis.__startup;r.mode='constructor';r.start();const outcome=await r.outcome;
return {code:outcome.code,constructions:r.constructions,retryShared:r.reentrant===r.pending,notices:r.notices.length};`),
            {
                code: 'AUDIO_VOICE_LIMIT_INVALID',
                constructions: 2,
                retryShared: true,
                notices: 2,
            },
        );
        console.log('PASS: synchronous constructor failure cannot reenter App creation from the feedback hook');

        assert.deepEqual(
            await run(`
const r=globalThis.__startup;r.mode='business';r.start();await r.until(()=>r.releaseBusiness);
return {settled:r.settled,state:r.entry.app.boot.inspect().state,retryShared:r.reentrant===r.pending&&r.entry.retryBoot()===r.pending,notices:r.notices.length,constructions:r.constructions,status:r.status.string};`),
            {
                settled: false,
                state: 'cleaning',
                retryShared: true,
                notices: 3,
                constructions: 3,
                status: '启动失败，正在清理…\nEXPECTED_STARTUP_FAILURE',
            },
        );
        assert.deepEqual(
            await run(`
const r=globalThis.__startup;r.releaseBusiness();const outcome=await r.outcome;r.mode='success';await r.entry.retryBoot();
return {failure:outcome.message,boot:r.entry.app.boot.inspect(),constructions:r.constructions,status:r.status.string};`),
            {
                failure: 'EXPECTED_STARTUP_FAILURE',
                boot: { state: 'ready', attempts: 2 },
                constructions: 3,
                status: '启动完成',
            },
        );
        console.log('PASS: business startup reports cleanup, then retries using the same core App after drain');
    } finally {
        await run(`
const r=globalThis.__startup;r.releaseSdk?.();r.releaseBusiness?.();if(r.outcome)await r.outcome;
if(r.entry.app)await r.entry.app.close();r.node.destroy();r.uiRoot.destroy();await r.frame();return true;`);
    }
});
