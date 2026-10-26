'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Runs under PinK's Electron Node runtime, whose ABI matches the SDK native modules.
// CocosAPI closes its Launcher before returning; explicitly exit this disposable
// worker afterwards because SDK background handles otherwise keep Node alive.
const [project, sdk, report] = process.argv.slice(2);
let cancelled = false;
process.on('SIGINT', () => {
    cancelled = true;
});
process.on('SIGTERM', () => {
    cancelled = true;
});
async function run() {
    const { CocosAPI } = require(path.join(sdk, 'dist/api/index.js'));
    const config = require(path.join(project, 'tools/yzforge/project/game-config.cjs'));
    const build = require(path.join(project, 'tools/yzforge/operations/game-build.cjs'));
    const snapshot = await config.readConfig(project);
    if (snapshot.platform !== 'web') throw Error('PinK 构建验收需要 web 渠道');
    const scene = JSON.parse(fs.readFileSync(path.join(project, config.bootstrapPath + '.meta'), 'utf8'));
    const options = {
        platform: 'web-mobile',
        debug: snapshot.mode === 'debug',
        name: 'YZForge',
        buildPath: 'project://build',
        outputName: 'pink-web',
        startScene: scene.uuid,
        scenes: [{ uuid: scene.uuid, url: 'db://' + config.bootstrapPath }],
        packages: {},
    };
    const lease = await build.begin(project, options);
    try {
        const result = await CocosAPI.buildProject(project, options.platform, options);
        if (cancelled) throw Object.assign(Error('构建已结束，验收已取消'), { code: 'YZ_CANCELLED' });
        if (result.code !== 0) throw Error('CocosAPI 构建失败：' + JSON.stringify(result));
        const frozen = await build.verify(lease);
        const output = path.join(project, 'build/pink-web');
        fs.accessSync(path.join(output, 'index.html'));
        const settings = JSON.parse(fs.readFileSync(path.join(output, 'src/settings.json'), 'utf8'));
        fs.writeFileSync(path.join(output, 'yzforge-build.json'), JSON.stringify(frozen, null, 2) + '\n');
        return {
            ok: true,
            output,
            engine: settings.CocosEngine,
            configHash: frozen.configHash,
            node: process.versions.node,
            abi: process.versions.modules,
        };
    } finally {
        await build.end(lease);
    }
}
run().then(
    (result) => {
        fs.writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
        process.exit(0);
    },
    (error) => {
        fs.writeFileSync(report, JSON.stringify({ ok: false, message: error.message }, null, 2) + '\n');
        console.error(error);
        process.exit(cancelled ? 130 : 1);
    },
);
