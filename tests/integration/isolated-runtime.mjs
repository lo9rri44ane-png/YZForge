import assert from 'node:assert/strict';
import { call } from '../../tools/yzforge/mcp.mjs';

const editor = async (code, args = {}) => (await call('execute_javascript', { context: 'editor', code, args })).data;

/** Own one exact preview window and temporary storage partition; never execute tests in the edit scene. */
export async function isolatedRuntime(urlText, name, work) {
    const url = new URL(urlText);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use a local project URL');
    assert.ok(['http:', 'https:'].includes(url.protocol));
    const sceneState = () =>
        editor(
            `return {scene:await Editor.Message.request('scene','query-current-scene'),dirty:await Editor.Message.request('scene','query-dirty')};`,
        );
    const before = await sceneState();
    const id = await editor(
        `const w=new (require('electron').BrowserWindow)({show:false,width:900,height:1300,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false,offscreen:true,partition:args.name+'-'+Date.now()}});
w.webContents.__yzforgeIsolatedCheck=args.name;w.__testErrors=[];
w.webContents.on('console-message',(_,level,message)=>{if(level>=3)w.__testErrors.push(message);});
try{await w.loadURL(args.url);return w.id;}catch(error){w.destroy();throw error;}`,
        { name, url: url.href },
    );
    const target = `const w=require('electron').BrowserWindow.fromId(args.id);if(w?.webContents.__yzforgeIsolatedCheck!==args.name)throw Error('Owned test window missing');`;
    const run = (code, input = {}) =>
        editor(
            target +
                `return await w.webContents.executeJavaScript('(async()=>{const cc=await System.import("cc");const root=cc.director.getScene()?.getChildByName("GameRoot"),entry=root?.getComponent("game.GameRoot"),app=entry?.app;const args='+JSON.stringify(args.input)+';'+args.code+'})()');`,
            { id, name, code, input },
        );
    const click = async (nodeExpression) => {
        const position = await run(`
await new Promise(resolve=>cc.director.once(cc.Director.EVENT_AFTER_DRAW,resolve));
const node=(${nodeExpression});if(!cc.isValid(node,true))throw Error('Click target missing');
const camera=cc.director.getScene().getComponentsInChildren(cc.Camera).find(c=>(c.visibility&node.layer)!==0);
if(!camera)throw Error('UI camera missing');const p=camera.worldToScreen(node.worldPosition),canvas=cc.game.canvas,rect=canvas.getBoundingClientRect();
return {x:Math.round(rect.left+p.x/canvas.width*rect.width),y:Math.round(rect.top+(1-p.y/canvas.height)*rect.height)};`);
        await editor(
            target +
                `for(const type of ['mouseMove','mouseDown','mouseUp'])w.webContents.sendInputEvent({type,button:'left',clickCount:1,...args.position});await new Promise(resolve=>setTimeout(resolve,80));return true;`,
            { id, name, position },
        );
    };
    const capture = async (fileName) => {
        assert.match(fileName, /^[a-z0-9-]+\.png$/);
        return editor(
            target +
                `const picture=await w.webContents.capturePage(),destination=require('path').join(Editor.Project.path,'temp','mcp-captures',args.fileName);require('fs').mkdirSync(require('path').dirname(destination),{recursive:true});require('fs').writeFileSync(destination,picture.toPNG());return destination;`,
            { id, name, fileName },
        );
    };
    try {
        let ready = false;
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
            ready = await run('return !!app?.ui.inspect().views.some(view=>view.interactive);').catch(() => false);
            if (ready) break;
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        assert.ok(ready, 'Bootstrap did not become ready');
        await work({ run, click, capture });
        assert.deepEqual(await editor(target + 'return w.__testErrors;', { id, name }), [], 'Runtime errors');
    } finally {
        await editor(target + 'w.destroy();return true;', { id, name });
        assert.deepEqual(await sceneState(), before, 'Test changed the edit scene');
    }
}
