import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const failure = (code, message) => Object.assign(new Error(message), { code });
const canonical = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);

/** Read the existing PinK project owner. Never starts a second host or connects to MCP. */
export async function inspectPink(root, { fetchImpl = fetch } = {}) {
    const project = canonical(await realpath(root));
    const projectKey = createHash('sha256').update(project).digest('hex');
    const directory = resolve(root, 'temp/.cocos-cli-backend');
    let registry;
    try {
        registry = JSON.parse(await readFile(resolve(directory, 'rendezvous.json'), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return { state: 'absent', project, sceneAvailable: false };
        throw failure('YZ_PINK_REGISTRY', 'PinK 项目服务记录无效，请检查项目是否正确打开');
    }
    if (registry.protocol !== 1 || !Number.isInteger(registry.port) || registry.port < 1 || registry.port > 65535)
        throw failure('YZ_PINK_REGISTRY', 'PinK 项目服务端口或协议无效');
    const url = `http://127.0.0.1:${registry.port}`;
    async function read(endpoint, token) {
        let response;
        try {
            response = await fetchImpl(url + endpoint, {
                signal: AbortSignal.timeout(3000),
                redirect: 'error',
                headers: token ? { authorization: `Bearer ${token}` } : {},
            });
        } catch {
            throw failure('YZ_PINK_UNREACHABLE', 'PinK 项目服务不可达；未启动其他实例');
        }
        if (!response.ok) throw failure('YZ_PINK_UNREACHABLE', 'PinK 项目服务未接受状态查询');
        return response.json();
    }
    const identity = await read('/identity');
    if (identity.protocol !== 1 || identity.projectKey !== projectKey || typeof identity.ownerId !== 'string')
        throw failure('YZ_PINK_IDENTITY', '本地服务不属于当前项目，已停止连接');
    let owner;
    try {
        owner = JSON.parse(await readFile(resolve(directory, 'owner.json'), 'utf8'));
    } catch {
        throw failure('YZ_PINK_INITIALIZING', 'PinK 正在登记项目服务，请稍后重试');
    }
    if (
        owner.ownerId !== identity.ownerId ||
        owner.projectKey !== projectKey ||
        owner.project !== project ||
        owner.url !== url ||
        typeof owner.token !== 'string' ||
        !owner.token
    )
        throw failure('YZ_PINK_IDENTITY', 'PinK 项目服务身份已变化，请重新查询');
    const status = await read('/status', owner.token);
    if (
        status.ownerId !== owner.ownerId ||
        status.projectKey !== projectKey ||
        status.project !== project ||
        status.url !== url ||
        status.token !== owner.token ||
        status.protocol !== 1
    )
        throw failure('YZ_PINK_IDENTITY', 'PinK 项目服务读回身份不一致');
    // Credentials and raw session descriptors must never enter CLI output or reports.
    return {
        state: status.state,
        project,
        pid: status.pid,
        ownerId: status.ownerId,
        sceneAvailable: status.state === 'ready' && !!status.sceneSession,
    };
}
