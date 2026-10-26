import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const execute = promisify(execFile);

/** Read process metadata only. Never expose command lines or stop an editor. */
export async function queryEditorProcesses(platform = process.platform) {
    if (platform !== 'win32') return { state: 'unsupported', processes: [] };
    const script =
        "$ErrorActionPreference = 'Stop'\n" +
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n' +
        'Get-CimInstance Win32_Process -Filter "Name = \'CocosCreator.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
    });
    const records = stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, '')) : [];
    return { state: 'checked', processes: Array.isArray(records) ? records : [records] };
}

export async function inspectEditorProcesses(root, pink, { query = queryEditorProcesses } = {}) {
    try {
        const result = await query();
        const project = await realpath(root);
        const key = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
        const creators = [];
        let unreadable = false;
        for (const item of result.processes) {
            if (!item.CommandLine) {
                unreadable = true;
                continue;
            }
            // Only recognize unambiguous argv. Embedded escaped quotes and relative project
            // paths require the other process's parsing/cwd; never guess using our cwd.
            if ((item.CommandLine.match(/"/g)?.length ?? 0) % 2 || /\\"/.test(item.CommandLine)) {
                unreadable = true;
                continue;
            }
            const args = (item.CommandLine.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((arg) => arg.replaceAll('"', ''));
            const index = args.findIndex((arg) => arg === '--project' || arg.startsWith('--project='));
            if (index < 0) continue;
            const path = args[index] === '--project' ? args[index + 1] : args[index].slice('--project='.length);
            if (!path || !isAbsolute(path)) {
                unreadable = true;
                continue;
            }
            const candidate = await realpath(path).catch(() => null);
            if (candidate && key(candidate) === key(project)) creators.push({ pid: item.ProcessId, editor: 'Creator' });
        }
        const pinkActive = Number.isInteger(pink.pid) && !['absent', 'unavailable'].includes(pink.state);
        return {
            state: unreadable ? 'partial' : result.state,
            creators,
            pinkPid: pinkActive ? pink.pid : undefined,
            conflict: pinkActive && creators.length > 0,
        };
    } catch {
        return { state: 'unavailable', creators: [], conflict: false };
    }
}
