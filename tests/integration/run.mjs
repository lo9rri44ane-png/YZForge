import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const groups = {
    ui: {
        description: '弹窗排序/真实输入、生命周期/缓存/动态组件、异常清理；需展示模块',
        files: ['verify-ui-ordering.mjs', 'verify-framework-lifecycle.mjs', 'verify-ui-cleanup.mjs'],
    },
    startup: {
        description: '启动故障反馈与清理/重试屏障；需默认 GameRoot 与首屏',
        files: ['verify-startup-feedback.mjs'],
    },
    components: { description: '原生 UI 组件、布局与真实输入；需展示模块', files: ['verify-ui-components.mjs'] },
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
    list: { description: '虚拟列表、复用与尺寸变化；需展示模块', files: ['verify-virtual-list.mjs'] },
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
    const started = Date.now();
    for (const [index, file] of files.entries()) {
        console.log(`\n[${index + 1}/${files.length}] ${file}`);
        await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), url.href], {
                cwd: fileURLToPath(new URL('../../', import.meta.url)),
                stdio: 'inherit',
                windowsHide: true,
            });
            child.once('error', reject);
            child.once('exit', (code, signal) => {
                if (code === 0) resolve();
                else reject(Error(`${file} 失败（${signal ?? code}），已停止后续检查。`));
            });
        });
    }
    console.log(`\nPASS: ${files.length} 个集成脚本，${((Date.now() - started) / 1000).toFixed(1)} 秒。`);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
