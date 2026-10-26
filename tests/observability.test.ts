import test from 'node:test';
import assert from 'node:assert/strict';
import { Scope, runTask } from '../assets/framework/core/scope';
import { FrameworkError, OperationCancelled, errorReporter } from '../assets/framework/core/errors';
import { State, derive } from '../assets/framework/core/state';
import { StateBindings } from '../assets/framework/core/state-bindings';
import { Command } from '../assets/framework/core/command';
import { Events, eventKey } from '../assets/framework/core/events';
import { GameLog, type LogRecord } from '../assets/framework/core/game-log';
import { deferred, flush } from './fake-clock';

test('task identities, cancellation age and cleanup stage remain inspectable without changing ownership', async () => {
    let now = 100;
    const root = new Scope(
        'root',
        () => {},
        () => now,
    );
    const child = root.child('page');
    const task = deferred(),
        cleanup = deferred();
    child.defer(() => cleanup.promise);
    child.track(task.promise, 'fetch');
    const id = child.inspect().tasks[0].id;
    child.track(task.promise, 'duplicate-registration');
    now = 125;
    assert.deepEqual(child.inspect().tasks[0], {
        id,
        label: 'fetch',
        startedAtMs: 100,
        elapsedMs: 25,
        cancellingForMs: undefined,
    });
    const closing = root.close();
    now = 150;
    const snapshot = root.inspect();
    assert.equal(snapshot.closingPhase, 'tasks');
    assert.equal(snapshot.children[0].tasks[0].cancellingForMs, 25);
    assert.ok(Object.isFrozen(snapshot.children[0].tasks[0]));
    task.resolve();
    await flush();
    assert.equal(child.inspect().closingPhase, 'cleanup');
    assert.equal(child.inspect().cleanupStartedAtMs, 150);
    assert.equal(child.closed, false);
    cleanup.resolve();
    await closing;
    assert.equal(root.inspect().children.length, 0);
});

test('state, bindings, command cleanup and events use the owner error outlet with distinct scope context', async () => {
    const errors: { error: unknown; context: any }[] = [];
    const root = new Scope('app', (error, context) => {
        errors.push({ error, context });
    });
    const owner = root.child('page');
    const state = new State(0);
    const failure = Error('observer');
    state.readonly.subscribe(owner, () => {
        throw failure;
    });
    assert.equal(errors[0].error, failure);
    assert.equal(errors[0].context.scopeId, owner.id);
    assert.equal(errors[0].context.scope, 'app/page');
    derive(owner, [state.readonly], (value) => {
        if (value) throw Error('derived');
        return value;
    });
    new StateBindings(owner).prepare(state.readonly, (n) => n, {
        required: false,
        prepare: () => {
            throw Error('prepare');
        },
        render: () => {},
    });
    state.set(1);
    const command = new Command(owner, {
        policy: 'exclusive',
        execute: (_: void, task) => {
            task.scope.defer(() => {
                throw Error('cleanup');
            });
        },
    });
    const invocation = command.invoke(undefined, { owner, context: undefined })!;
    await invocation.result;
    await assert.rejects(invocation.completed, { code: 'SCOPE_CLEANUP_FAILED' });
    const events = new Events(root.report),
        event = eventKey<void>('check');
    events.on(
        event,
        () => {
            throw Error('event');
        },
        owner,
    );
    events.emit(event, undefined);
    owner.report(new OperationCancelled());
    await flush();
    assert.ok(errors.some(({ error }) => String(error).includes('derived')));
    assert.ok(errors.some(({ error }) => String(error).includes('prepare')));
    assert.ok(errors.some(({ error }) => error instanceof FrameworkError && error.code === 'SCOPE_CLEANUP_FAILED'));
    assert.ok(errors.some(({ context }) => context.source === 'event:check' && context.scopeId === owner.id));
    assert.ok(!errors.some(({ error }) => error instanceof OperationCancelled));
    await root.close();
});

test('throwing and rejecting reporters cannot interrupt cancellation or create unhandled rejections', async (t) => {
    const fallback: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
        fallback.push(args);
    });
    const owner = new Scope('faulty-outlet', () => {
        throw Error('sink');
    });
    let notified = false;
    owner.signal.onAbort(() => {
        throw Error('listener');
    });
    owner.signal.onAbort(() => {
        notified = true;
    });
    await owner.close();
    assert.equal(notified, true);
    errorReporter(async () => {
        throw Error('async sink');
    })(Error('original'));
    await flush();
    assert.equal(fallback.length, 2);
    assert.ok(fallback.every((args) => args[1] instanceof FrameworkError && args[1].code === 'ERROR_REPORTER_FAILED'));
});

test('log sinks receive filtered immutable records and sink failures do not change task outcomes', async (t) => {
    const records: LogRecord[] = [];
    const log = new GameLog({
        level: 'warn',
        prefix: 'test',
        sink: (record) => {
            records.push(record);
        },
    });
    log.debug('hidden');
    log.info('hidden');
    log.warn('visible', 1);
    log.error('failure');
    assert.deepEqual(
        records.map((entry) => entry.level),
        ['warn', 'error'],
    );
    assert.ok(Object.isFrozen(records[0]) && Object.isFrozen(records[0].values));
    const calls: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
        calls.push(args);
    });
    const owner = new Scope('log');
    const broken = new GameLog({
        level: 'debug',
        prefix: '',
        sink: async () => {
            throw Error('offline');
        },
    });
    assert.equal(
        await runTask(owner, () => {
            broken.info('queued');
            return 7;
        }),
        7,
    );
    await flush();
    assert.equal(calls.length, 1);
    await owner.close();
});
