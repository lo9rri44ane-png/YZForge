'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

/** Git 不保存空目录；仅由 Creator 依据现有目录元数据补齐目录，并读回同一 UUID。 */
exports.restoreDirectories = async function ({ inside, request }) {
    const assets = inside('assets');
    const restored = [];
    async function visit(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) throw Error('资源目录不支持符号链接：' + entry.name);
            const target = inside(path.join(directory, entry.name));
            if (entry.isDirectory()) await visit(target);
            else if (entry.isFile() && entry.name.endsWith('.meta')) {
                const folder = target.slice(0, -5);
                const exists = await fs.stat(folder).then(
                    () => true,
                    (error) => {
                        if (error.code === 'ENOENT') return false;
                        throw error;
                    },
                );
                if (exists) continue;
                const meta = JSON.parse(await fs.readFile(target, 'utf8'));
                if (meta.importer !== 'directory') continue;
                if (typeof meta.uuid !== 'string' || !meta.uuid) throw Error('目录元数据缺少 UUID：' + target);
                const url = 'db://assets/' + path.relative(assets, folder).replaceAll('\\', '/');
                await request('asset-db', 'create-asset', url, null);
                const info = await request('asset-db', 'query-asset-info', url);
                if (info?.uuid !== meta.uuid || !info.isDirectory) throw Error('补齐目录后 UUID 不一致：' + url);
                restored.push(url);
            }
        }
    }
    await visit(assets);
    return restored;
};
