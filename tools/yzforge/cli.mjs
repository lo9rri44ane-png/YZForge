import { runCommand } from './commands.mjs';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
    const watching = process.argv[2] === 'watch';
    const result = await runCommand(process.argv.slice(2), undefined, {
        signal: controller.signal,
        onEvent: (event) => console.log(JSON.stringify(event)),
    });
    console.log(JSON.stringify(result, null, watching ? undefined : 2));
    if (!result.ok) process.exitCode = 1;
} finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
}
