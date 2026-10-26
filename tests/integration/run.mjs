import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runVerification } from '../../tools/yzforge/validation/verification.mjs';

const groups = {
    diagnostics: {
        description: '应用错误出口、任务诊断、上报故障隔离；需默认启动场景',
        files: ['verify-observability.mjs'],
    },
    performance: {
        description: '真实列表打开/滚动耗时与预热后资源回落；需展示模块',
        files: ['verify-performance.mjs'],
    },
    presentation: {
        description: '状态绑定、首屏/清理屏障、组件准备顺序、双皮肤与缓存重开；需 workshop 示例',
        files: ['verify-presentation.mjs', 'verify-composition.mjs', 'verify-preparation-tree.mjs'],
    },
    ui: {
        description: '弹窗排序/真实输入、生命周期/缓存/动态组件、异常清理；需展示模块',
        files: ['verify-ui-ordering.mjs', 'verify-framework-lifecycle.mjs', 'verify-ui-cleanup.mjs'],
    },
    startup: {
        description: '启动故障反馈与清理/重试屏障；需默认 GameRoot 与首屏',
        files: ['verify-startup-feedback.mjs'],
    },
    components: {
        description: '原生 UI 组件、布局与真实输入；需包含展示模块的 Web 构建',
        files: ['verify-ui-components.mjs'],
    },
    resources: {
        description: '批量资源、Prefab 池与本地化资源；需展示模块',
        files: ['verify-resources-localization.mjs'],
    },
    localization: {
        description: '多语言示例与首屏就绪；需展示模块',
        files: ['verify-localization-examples.mjs', 'verify-localization-ready.mjs'],
    },
    audio: { description: '音频并发、前后台与回收；需大厅示例', files: ['verify-audio.mjs'] },
    network: { description: '真实本机 HTTP、红点与聚焦引导；需展示模块', files: ['verify-network-guide.mjs'] },
    list: {
        description: '虚拟列表、复用、尺寸变化及组合容器独占；需展示模块',
        files: ['verify-virtual-list.mjs', 'verify-container-ownership.mjs'],
    },
    showcase: { description: '全部功能展示与页面导航；需包含全部示例的 Web 构建', files: ['verify-showcase.mjs'] },
};

async function main() {
    const { values, positionals } = parseArgs({
        options: { url: { type: 'string' }, list: { type: 'boolean' }, help: { type: 'boolean' } },
        allowPositionals: true,
    });
    if (values.list || values.help || !positionals.length) {
        console.log('用法：npm run test:integration -- ui startup --url http://localhost:7456/');
        console.log('串行执行选中的功能组，首个失败停止；--list 列出前置条件。');
        for (const [name, group] of Object.entries(groups)) console.log(`  ${name}: ${group.description}`);
        return;
    }
    const selected = [...new Set(positionals)];
    for (const name of selected)
        if (!Object.hasOwn(groups, name)) throw Error(`未知功能组：${name}。使用 --list 查看可选项。`);
    if (!values.url) throw Error('请使用 --url 指定当前项目的本机预览或 Web 构建地址。');
    const url = new URL(values.url);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname))
        throw Error('--url 必须是本机 HTTP(S) 地址。');
    // 旧的构建回归入口仅接受 IPv4 回环；统一后所有功能组使用同一地址。
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    const files = [...new Set(selected.flatMap((name) => groups[name].files))];
    await runVerification(
        fileURLToPath(new URL('../../', import.meta.url)),
        'integration',
        files.map((file) => ({ name: file, args: [fileURLToPath(new URL(file, import.meta.url)), url.href] })),
        { groups: selected, url: url.href },
    );
    console.log(`PASS: ${files.length} 个集成脚本。`);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
