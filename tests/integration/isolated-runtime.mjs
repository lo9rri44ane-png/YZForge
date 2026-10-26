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
w.webContents.on('console-message',(_,level,message,line,source)=>{if(level>=3)w.__testErrors.push({message,line,source});});
try{await w.loadURL(args.url);return w.id;}catch(error){w.destroy();throw error;}`,
        { name, url: url.href },
    );
    const target = `const w=require('electron').BrowserWindow.fromId(args.id);if(w?.webContents.__yzforgeIsolatedCheck!==args.name)throw Error('Owned test window missing');`;
    const run = async (code, input = {}) => {
        const result = await editor(
            target +
                `return await w.webContents.executeJavaScript('(async()=>{try{const cc=await System.import("cc");const root=cc.director.getScene()?.getChildByName("GameRoot"),entry=root?.getComponent("game.GameRoot"),app=entry?.app;const args='+JSON.stringify(args.input)+';return {ok:true,value:await(async()=>{'+args.code+'})()};}catch(error){return {ok:false,message:String(error),stack:error?.stack};}})()');`,
            { id, name, code, input },
        );
        if (!result.ok) throw Error(result.stack ?? result.message);
        return result.value;
    };
    const positionOf = (nodeExpression) =>
        run(`
await new Promise(resolve=>cc.director.once(cc.Director.EVENT_AFTER_DRAW,resolve));
const node=(${nodeExpression});if(!cc.isValid(node,true))throw Error('Click target missing');
const camera=cc.director.getScene().getComponentsInChildren(cc.Camera).find(c=>(c.visibility&node.layer)!==0);
if(!camera)throw Error('UI camera missing');const p=camera.worldToScreen(node.worldPosition),canvas=cc.game.canvas,rect=canvas.getBoundingClientRect();
return {x:Math.round(rect.left+p.x/canvas.width*rect.width),y:Math.round(rect.top+(1-p.y/canvas.height)*rect.height)};`);
    const click = async (nodeExpression) => {
        const position = await positionOf(nodeExpression);
        await editor(
            target +
                `for(const type of ['mouseMove','mouseDown','mouseUp'])w.webContents.sendInputEvent({type,button:'left',clickCount:1,...args.position});await new Promise(resolve=>setTimeout(resolve,80));return true;`,
            { id, name, position },
        );
    };
    const drag = async (nodeExpression, delta) => {
        const position = await positionOf(nodeExpression);
        await editor(
            target +
                `const start=args.position;w.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...start});for(let i=1;i<=8;i++){w.webContents.sendInputEvent({type:'mouseMove',button:'left',x:Math.round(start.x+args.delta.x*i/8),y:Math.round(start.y+args.delta.y*i/8)});await new Promise(resolve=>setTimeout(resolve,16));}w.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(start.x+args.delta.x),y:Math.round(start.y+args.delta.y)});return true;`,
            { id, name, position, delta },
        );
    };
    const resize = async (width, height) => {
        assert.ok(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0);
        await editor(
            target +
                `w.setContentSize(args.width,args.height);await new Promise(resolve=>setTimeout(resolve,250));return true;`,
            { id, name, width, height },
        );
        await run(
            `cc.screen.windowSize=new cc.Size(args.width,args.height);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return true;`,
            { width, height },
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
            const mapped = await editor(
                target +
                    `return w.webContents.executeJavaScript('(async()=>{try{return typeof await globalThis.System?.resolve("cc")==="string";}catch{return false;}})()');`,
                { id, name },
            );
            ready =
                mapped &&
                (await run('return !!app?.ui.inspect().views.some(view=>view.interactive);').catch(() => false));
            if (ready) break;
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        assert.ok(
            ready,
            'Bootstrap did not become ready: ' +
                JSON.stringify(await editor(target + 'return w.__testErrors;', { id, name })),
        );
        await work({ run, click, drag, resize, capture });
        assert.deepEqual(await editor(target + 'return w.__testErrors;', { id, name }), [], 'Runtime errors');
    } finally {
        await editor(target + 'w.destroy();return true;', { id, name });
        assert.deepEqual(await sceneState(), before, 'Test changed the edit scene');
    }
}
