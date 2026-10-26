import type { App } from '../../framework/app/app';
import type { BootContext } from '../../framework/app/boot';
import { director, find, isValid, Node, Canvas } from 'cc';
import { NonogramDemo } from './nonogram/NonogramDemo';
import { ShowcaseModule } from '../modules/showcase/public';

/**
 * 项目的启动接入点；通过公开界面合同选择首屏，复杂业务调用所属模块的公开 API。
 * 当前直接进入数织；撤销本接入时恢复 ShowcaseViews 的公开导入，并调用
 * await app.ui.pushPage(ShowcaseViews.showcasePage, undefined, boot.scope)。不需要修改框架。
 * @param app 已装配的应用服务；导入 UI 合同不会提前加载预制体或启动模块业务。
 * @param boot 本次启动尝试，首屏与会话由 boot.scope 持有；异步提交使用 boot.commit。
 * @returns 首屏打开完成；失败应抛出，由框架回收本次尝试并显示启动错误。
 */
export async function startGame(app: App, boot: BootContext): Promise<void> {
    boot.scope.signal.throwIfAborted();
    const scene = director.getScene();
    const canvas = find('GameRoot/Canvas') ?? scene?.getComponentInChildren(Canvas)?.node;
    if (!canvas) throw new Error('数织启动失败：未找到 GameRoot/Canvas 或原生 Canvas');
    const host = new Node('NonogramDemoHost');
    host.layer = canvas.layer;
    canvas.addChild(host);
    // 挂在 Canvas 上以沿用相机和坐标空间；本次启动期限只拥有本次创建的节点。
    boot.scope.defer(() => {
        if (isValid(host)) host.destroy();
    });
    host.addComponent(NonogramDemo);
    // 沿用应用已有的展示模块宿主；绑定期限属于本次启动，不调用内部生命周期入口。
    await app.bindScene(host, ShowcaseModule.id, boot.scope);
}
