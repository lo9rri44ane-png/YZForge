import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import formatting from '../../tools/yzforge/generators/format.cjs';
import { isolatedRuntime } from './isolated-runtime.mjs';

export async function writeCatalogSources(root) {
    const module = 'assets/game/modules/catalog';
    const write = async (file, text) =>
        writeFile(resolve(root, file), await formatting.formatScript(resolve(root, file), text));
    await write(
        module + '/code/CatalogServices.ts',
        `import { moduleServices } from '../../../../framework/modules/module-manager';
import type { CatalogService } from './services/CatalogService';
/** 模块内部共享服务合同。 */
export const CatalogServices = moduleServices<{ readonly catalog: CatalogService }>('catalog');`,
    );
    await write(
        module + '/code/services/CatalogService.ts',
        `import type { ModuleContext } from '../../../../../framework/modules/module-manager';
import { ProductsTable } from '../generated/config/Products.table';
import type { ProductsRow } from '../generated/config/Products.types';
/** 类型化配置提供业务数据，页面不直接读取 JSON。 */
export class CatalogService {
    private products: readonly ProductsRow[] = [];
    /** 模块工厂显式注入上下文，配置持有随模块关闭。 */
    constructor(private readonly ctx: ModuleContext) {}
    /** 模块启动屏障。 */
    async start(): Promise<void> { const table=await this.ctx.config.load(ProductsTable);this.ctx.scope.signal.throwIfAborted();this.products=table.all().filter(row=>row.enabled); }
    /** 只读目录数据。 */
    all(): readonly ProductsRow[] { this.ctx.scope.signal.throwIfAborted();return this.products; }
    /** 按稳定 ID 查询，缺失明确失败。 */
    require(id: number): ProductsRow { const row=this.all().find(row=>row.id===id);if(!row)throw Error('产品不存在：'+id);return row; }
}`,
    );
    await write(
        module + '/code/CatalogModule.ts',
        `import { defineModule } from '../../../../framework/modules/module-manager';
import { CatalogModule } from '../public';
import { dependencies } from './generated/dependencies';
import { CatalogServices } from './CatalogServices';
import { CatalogService } from './services/CatalogService';
/** 配置加载完成后再交付页面可用的 Service。 */
export const createCatalogModule=defineModule(CatalogModule,{dependencies,services:CatalogServices},async(ctx)=>{const catalog=new CatalogService(ctx);await catalog.start();return {services:{catalog},api:{get moduleId(){return ctx.id;}}};});`,
    );
    await write(
        module + '/code/ui/catalog-page/CatalogPageViewModel.ts',
        `import { State } from '../../../../../../framework/core/state';
import type { Lifetime } from '../../../../../../framework/core/scope';
import type { CatalogService } from '../../services/CatalogService';
import type { ProductsRow } from '../../generated/config/Products.types';
/** 页面语义数据。 */
export class CatalogPageViewModel {
    private readonly data=new State<readonly ProductsRow[]>([]);
    readonly state=this.data.readonly;
    /** 页面会话和共享服务显式注入。 */
    constructor(private readonly owner:Lifetime,private readonly service:CatalogService){}
    /** 页面重复显示仍读取同一服务。 */
    start():void{this.owner.signal.throwIfAborted();this.data.set(this.service.all());}
}`,
    );
    await write(
        module + '/code/ui/catalog-page/CatalogPage.model.ts',
        `import type { ViewModelFactory } from '../../../../../../framework/ui/view-session';
import { CatalogServices } from '../../CatalogServices';
import { CatalogPageViewModel } from './CatalogPageViewModel';
/** 组合依赖。 */
export const createCatalogPageModel:ViewModelFactory<CatalogPageViewModel>=({scope,ctx})=>new CatalogPageViewModel(scope,ctx.services(CatalogServices).catalog);`,
    );
    await write(
        module + '/code/ui/catalog-page/CatalogPage.ts',
        `import { _decorator,Graphics,UITransform,ScrollView,Node } from 'cc';
import type { ViewShowContext } from '../../../../../../framework/ui/ui-view';
import { VirtualList } from '../../../../../../framework/ui/components/virtual-list';
import type { BoundVirtualList } from '../../../../../../framework/ui/view-bindings';
import type { ProductsRow } from '../../generated/config/Products.types';
import { CatalogRes } from '../../../contracts/generated/resources-default';
import { CatalogViews } from '../../generated/views';
import { ProductRowPart } from '../../components/product-row-part/ProductRowPart';
import { CatalogPageBinding } from './generated/CatalogPageBinding';
import { createCatalogPageModel } from './CatalogPage.model';
const {ccclass}=_decorator;
/** 空项目开发演练：Service 数据、列表复用和类型化详情路由。 */
@ccclass('catalog.CatalogPage')
export class CatalogPage extends CatalogPageBinding {
    private list?:BoundVirtualList<ProductsRow>;
    protected onShow(show:ViewShowContext<void,void>):void{
        const model=show.session.use(createCatalogPageModel);model.start();
        this.lblTitle.string='产品目录';this.lblSummary.string='120 条配置数据 · 选择产品查看详情';
        for(const g of this.node.getComponentsInChildren(Graphics)){const draw=()=>{const t=g.node.getComponent(UITransform)!;g.clear();g.rect(-t.width*t.anchorX,-t.height*t.anchorY,t.width,t.height);g.fill();};draw();show.listen(g.node,Node.EventType.SIZE_CHANGED,draw);}
        const scroll=this.nodeList.getComponent(ScrollView)!;
        const layout=()=>({itemWidth:scroll.view!.width,itemHeight:104,spacingY:12});
        this.list=show.bindings.list(this.nodeList.getComponent(VirtualList)!,model.state,rows=>rows,{key:row=>row.id,prefab:CatalogRes.prefab.prefabsProductRowPart,part:ProductRowPart,layout:layout(),bind:(part,item)=>part.bind(item,async id=>{await show.ui.open(CatalogViews.productPopup,{id});})});
        show.listen(scroll.view!.node,Node.EventType.SIZE_CHANGED,()=>this.list!.setLayout(layout()));
    }
    protected onHide():void{this.list=undefined;}
}`,
    );
    await write(
        module + '/code/components/product-row-part/ProductRowPart.ts',
        `import {_decorator,Button,Graphics,UITransform,Node} from 'cc';
import type { PartContext } from '../../../../../../framework/ui/part-presentation';
import type { ProductsRow } from '../../generated/config/Products.types';
import { ProductRowPartBinding } from './generated/ProductRowPartBinding';
const {ccclass}=_decorator;
/** 每次身份绑定持有自己的点击监听，复用后读取当前产品。 */
@ccclass('catalog.ProductRowPart')
export class ProductRowPart extends ProductRowPartBinding {
    /** 只注册本次条目身份的工作。 */
    bind(item:PartContext<ProductsRow>,open:(id:number)=>Promise<void>):void{
        item.bindings.text(this.lblName,item.state,({data})=>data.name);
        item.bindings.listen(this.btnOpen.node,Button.EventType.CLICK,()=>open(item.state.value.data.id));
        for(const g of this.node.getComponentsInChildren(Graphics)){const draw=()=>{const t=g.node.getComponent(UITransform)!;g.clear();g.roundRect(-t.width*t.anchorX,-t.height*t.anchorY,t.width,t.height,12);g.fill();};draw();item.bindings.listen(g.node,Node.EventType.SIZE_CHANGED,draw);}
    }
}`,
    );
    await write(
        module + '/code/ui/product-popup/ProductPopup.types.ts',
        `/** 稳定产品 ID；界面读取 Service，不传递可变模型。 */
export interface ProductPopupParams { readonly id:number; }
/** 关闭详情不产生业务结算。 */
export type ProductPopupResult=void;`,
    );
    await write(
        module + '/code/ui/product-popup/ProductPopupViewModel.ts',
        `import type { CatalogService } from '../../services/CatalogService';
/** 详情是按稳定 ID 查得的只读产品。 */
export class ProductPopupViewModel {
    readonly product:ReturnType<CatalogService['require']>;
    /** 服务、ID 显式注入。 */
    constructor(service:CatalogService,id:number){this.product=service.require(id);}
}`,
    );
    await write(
        module + '/code/ui/product-popup/ProductPopup.model.ts',
        `import type { ViewModelFactory } from '../../../../../../framework/ui/view-session';
import type { ProductPopupParams } from './ProductPopup.types';
import { CatalogServices } from '../../CatalogServices';
import { ProductPopupViewModel } from './ProductPopupViewModel';
/** 详情模型只接收服务和稳定 ID。 */
export const createProductPopupModel:ViewModelFactory<ProductPopupViewModel,ProductPopupParams>=({ctx,params})=>new ProductPopupViewModel(ctx.services(CatalogServices).catalog,params.id);`,
    );
    await write(
        module + '/code/ui/product-popup/ProductPopup.ts',
        `import {_decorator,Button,Graphics,UITransform} from 'cc';
import type { ViewShowContext } from '../../../../../../framework/ui/ui-view';
import type { ProductPopupParams } from './ProductPopup.types';
import { ProductPopupBinding } from './generated/ProductPopupBinding';
import { createProductPopupModel } from './ProductPopup.model';
const {ccclass}=_decorator;
/** 类型化详情弹窗，输入和关闭均受显示期限约束。 */
@ccclass('catalog.ProductPopup')
export class ProductPopup extends ProductPopupBinding {
    protected onShow(show:ViewShowContext<ProductPopupParams,void>):void{
        const model=show.session.use(createProductPopupModel);this.lblTitle.string=model.product.name;this.lblDetail.string='产品编号 '+model.product.id+'\\n数据来自 XLSX → 类型化配置 → Service';
        for(const g of this.node.getComponentsInChildren(Graphics)){const t=g.node.getComponent(UITransform)!;g.clear();g.roundRect(-t.width*t.anchorX,-t.height*t.anchorY,t.width,t.height,16);g.fill();}
        show.listen(this.btnClose.node,Button.EventType.CLICK,()=>show.finish(undefined));
    }
}`,
    );
    await write(
        'assets/game/app/start-game.ts',
        `import type { App } from '../../framework/app/app';
import type { BootContext } from '../../framework/app/boot';
import { CatalogViews } from '../modules/catalog/public';
/** 独立项目首屏仅引用模块公开合同。 */
export async function startGame(app:App,boot:BootContext):Promise<void>{await app.ui.pushPage(CatalogViews.catalogPage,undefined,boot.scope);}`,
    );
}

export async function composeCatalog(call, created) {
    const editor = async (code, args = {}) =>
        (await call('execute_javascript', { context: 'editor', code, args })).data;
    const action = (name, input) =>
        editor('return Editor.Message.request("yzforge-editor","dispatch",args.name,args.input);', { name, input });
    for (const kind of ['page', 'popup', 'part']) {
        const result = created.find((r) => r.request.kind === kind);
        await call('inspect_prefab', { target: result.uuid });
        const edited = await call('execute_javascript', {
            context: 'scene',
            args: { uuid: result.uuid, kind },
            code: `
const p=await new Promise((yes,no)=>cc.assetManager.loadAny(args.uuid,(e,a)=>e?no(e):yes(a)));const root=p.data;
if(root.children.length)throw Error('Expected untouched workbench scaffold');const rootId=root._prefab.fileId;
const make=(name,parent,w,h,x=0,y=0)=>{const n=new cc.Node(name);n.layer=root.layer;n.addComponent(cc.UITransform).setContentSize(w,h);n.setPosition(x,y);parent.addChild(n);return n;};
const fill=(n,color)=>{const g=n.addComponent(cc.Graphics);g.fillColor=new cc.Color(...color);return n;};
const text=(name,parent,w,h,value,size,x=0,y=0)=>{const n=make(name,parent,w,h,x,y),l=n.addComponent(cc.Label);l.string=value;l.fontSize=size;l.lineHeight=size+8;l.color=new cc.Color(233,239,249,255);l.overflow=cc.Label.Overflow.SHRINK;return n;};
const button=(name,parent,w,h,value,x=0,y=0)=>{const n=fill(make(name,parent,w,h,x,y),[53,92,145,255]);n.addComponent(cc.Button);text('Caption',n,w-16,h,value,24);return n;};
const stretch=(n,top,bottom,left,right)=>{const w=n.addComponent(cc.Widget);w.isAlignTop=w.isAlignBottom=w.isAlignLeft=w.isAlignRight=true;w.top=top;w.bottom=bottom;w.left=left;w.right=right;w.alignMode=cc.Widget.AlignMode.ON_WINDOW_RESIZE;return w;};
root.getComponent(cc.UITransform).setContentSize(args.kind==='part'?624:720,args.kind==='part'?104:1280);
if(args.kind==='page'){
 fill(make('Background',root,720,1280),[15,28,48,255]);stretch(root.getChildByName('Background'),0,0,0,0);
 const title=text('lbl_title',root,624,60,'产品目录',38,0,540);const titleW=title.addComponent(cc.Widget);titleW.isAlignTop=true;titleW.top=48;
 const subtitle=text('lbl_summary',root,624,44,'配置表 → Service → ViewModel → 列表',20,0,475);const subW=subtitle.addComponent(cc.Widget);subW.isAlignTop=true;subW.top=112;
 const list=make('node_list',root,624,920,0,-40);stretch(list,190,130,48,48);const scroll=list.addComponent(cc.ScrollView);list.addComponent(cc.js.getClassByName('yzforge.VirtualList'));const view=make('View',list,624,920);stretch(view,0,0,0,0);view.addComponent(cc.Mask);const content=make('Content',view,624,920);scroll.content=content;scroll.horizontal=false;scroll.vertical=true;
 const hint=text('Hint',root,624,60,'点击条目查看详情 · 120 条数据按需复用',22,0,-560);const hintW=hint.addComponent(cc.Widget);hintW.isAlignBottom=true;hintW.bottom=40;
} else if(args.kind==='part'){
 fill(root,[31,50,77,255]);const name=text('lbl_name',root,390,60,'产品',26,-80,0);name.getComponent(cc.Label).horizontalAlign=cc.Label.HorizontalAlign.LEFT;const open=button('btn_open',root,120,64,'详情',235,0);const bw=open.addComponent(cc.Widget);bw.isAlignRight=true;bw.right=16;
}else{
 fill(root,[0,0,0,170]);
 const card=fill(make('Card',root,600,420),[29,48,75,255]);
 text('lbl_title',card,536,70,'产品详情',32,0,130);
 text('lbl_detail',card,536,100,'来自类型化配置表',24,0,20);
 button('btn_close',card,230,68,'关闭',0,-125);
}
const {PrefabInfo,CompPrefabInfo}=cc.Prefab._utils;const id=()=>require('crypto').randomBytes(16).toString('base64').replace(/=+$/,'');
const register=n=>{if(!n._prefab){n._prefab=new PrefabInfo();n._prefab.root=root;n._prefab.asset=p;n._prefab.fileId=id();}for(const c of n.components)if(!c.__prefab){c.__prefab=new CompPrefabInfo();c.__prefab.fileId=id();}for(const child of n.children)register(child);};register(root);
const serialized=cce.Utils.serialize(p);return {rootId,content:typeof serialized==='string'?serialized:JSON.stringify(serialized)};`,
        });
        const value = edited.data.result ?? edited.data;
        await editor('await Editor.Message.request("asset-db","save-asset",args.uuid,args.content);return true;', {
            uuid: result.uuid,
            content: value.content,
        });
        const bound = await action(kind === 'part' ? 'bindComponent' : 'bindView', {
            module: 'catalog',
            id: result.id.replace(/^catalog\./, ''),
        });
        console.log('Bound', kind, bound);
        const readback = await call('execute_javascript', {
            context: 'scene',
            args: { uuid: result.uuid },
            code: 'const p=await new Promise((yes,no)=>cc.assetManager.loadAny(args.uuid,(e,a)=>e?no(e):yes(a)));return {rootId:p.data._prefab.fileId,children:p.data.children.map(n=>n.name)};',
        });
        assert.equal((readback.data.result ?? readback.data).rootId, value.rootId);
    }
}

export async function verifyCatalog(url, appId) {
    let result;
    await isolatedRuntime(url, 'catalog-trial', async ({ run, click, capture, resize }) => {
        const initial = await run(
            `cc.profiler.hideStats();const record=Array.from(app.ui.records.values()).find(r=>r.definition.id==='catalog.catalog-page'&&!r.termination);if(!record)throw Error('Catalog page missing');globalThis.__catalogTest={page:record.instance.view};await record.instance.view.list.ready;return {appId:entry.appOptions().appId,modules:entry.appOptions().modules.map(m=>m.id),state:record.instance.view.list.inspect(),diagnostics:app.diagnostics.snapshot()};`,
        );
        assert.equal(initial.appId, appId);
        assert.deepEqual(initial.modules, ['catalog']);
        assert.equal(initial.state.count, 120);
        assert.ok(initial.state.slots < 20);
        const select = `globalThis.__catalogTest.page.nodeList.getComponent(cc.ScrollView).content.children.find(n=>n.active).getComponent('catalog.ProductRowPart').btnOpen.node`;
        await click(select);
        const first = await run(
            `const r=Array.from(app.ui.records.values()).find(r=>r.definition.id==='catalog.product-popup'&&!r.termination);if(!r?.interactive)throw Error('Detail popup not interactive');return {title:r.instance.view.lblTitle.string,detail:r.instance.view.lblDetail.string,id:r.show.params.id};`,
        );
        assert.equal(first.id, 1);
        assert.match(first.title, /001/);
        await click(select);
        assert.equal(
            await run(
                `return Array.from(app.ui.records.values()).filter(r=>r.definition.id==='catalog.product-popup'&&!r.termination).length;`,
            ),
            1,
        );
        const captureView = async (name) => {
            await run(
                'cc.profiler.hideStats();await new Promise(resolve=>cc.director.once(cc.Director.EVENT_AFTER_DRAW,resolve));return true;',
            );
            return capture(name);
        };
        const popupCapture = await captureView('catalog-trial-detail.png');
        await click(
            `Array.from(app.ui.records.values()).find(r=>r.definition.id==='catalog.product-popup'&&!r.termination).instance.view.btnClose.node`,
        );
        for (const [width, height] of [
            [720, 1280],
            [720, 1600],
            [1024, 768],
        ]) {
            await resize(width, height);
            const state = await run(
                `const v=globalThis.__catalogTest.page;v.list.scrollToIndex(119,'end');await v.list.ready;return v.list.inspect();`,
            );
            assert.equal(state.range.end, 120);
            assert.ok(state.slots < 25);
        }
        await resize(720, 1280);
        const pageCapture = await captureView('catalog-trial-page.png');
        await click(
            `globalThis.__catalogTest.page.nodeList.getComponent(cc.ScrollView).content.children.find(n=>n.active&&n.getComponent('catalog.ProductRowPart').lblName.string.includes('120')).getComponent('catalog.ProductRowPart').btnOpen.node`,
        );
        const last = await run(
            `const r=Array.from(app.ui.records.values()).find(r=>r.definition.id==='catalog.product-popup'&&!r.termination);return {id:r.show.params.id,title:r.instance.view.lblTitle.string};`,
        );
        assert.equal(last.id, 120);
        assert.match(last.title, /120/);
        await click(
            `Array.from(app.ui.records.values()).find(r=>r.definition.id==='catalog.product-popup'&&!r.termination).instance.view.btnClose.node`,
        );
        const closed = await run(`await app.close();return app.inspect();`);
        assert.equal(closed.scope.state, 'closed');
        assert.deepEqual(closed.scope.tasks, []);
        assert.deepEqual(closed.modules, []);
        assert.deepEqual(closed.ui.views, []);
        assert.deepEqual(closed.assets.resources, []);
        assert.deepEqual(closed.config, []);
        result = { ok: true, url: url, initial, first, last, closed, pageCapture, popupCapture };
    });

    return result;
}
