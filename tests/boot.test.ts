import test from 'node:test';
import assert from 'node:assert/strict';
import { BootFlow } from '../assets/framework/app/boot';
import { Scope } from '../assets/framework/core/scope';
import { OperationCancelled } from '../assets/framework/core/errors';
import { deferred, flush } from './fake-clock';

test('failed startup reclaims its attempt and leaves the host available for retry', async () => {
    const root = new Scope('app'),
        boot = new BootFlow(root.lifetime);
    const calls: number[] = [];
    let cleaned = 0;
    await assert.rejects(
        boot.start(async (attempt) => {
            calls.push(attempt.attempt);
            attempt.scope.defer(() => {
                cleaned++;
            });
            throw Error('offline');
        }),
        /offline/,
    );
    assert.equal(cleaned, 1);
    assert.equal(root.signal.aborted, false);
    assert.equal(boot.inspect().state, 'failed');
    const gate = deferred();
    const retry = boot.start(async (attempt) => {
        calls.push(attempt.attempt);
        attempt.scope.defer(() => {
            cleaned++;
        });
        await gate.promise;
    });
    assert.equal(
        boot.start(() => {
            throw Error('duplicate');
        }),
        retry,
    );
    await flush();
    gate.resolve();
    await retry;
    assert.deepEqual(calls, [1, 2]);
    assert.equal(boot.inspect().state, 'ready');
    assert.throws(() => boot.start(() => {}), { code: 'BOOT_ALREADY_READY' });
    await root.close();
    assert.equal(cleaned, 2);
});

test('startup reports failure while cleanup holds the same attempt and only permits retry after drain', async () => {
    const root = new Scope('app'),
        boot = new BootFlow(root.lifetime),
        gate = deferred(),
        fault = Error('offline');
    const notices: unknown[] = [];
    let settled = false,
        cleanupStarted = false;
    const starting = boot.start(
        ({ scope }) => {
            scope.defer(async () => {
                cleanupStarted = true;
                await gate.promise;
            });
            throw fault;
        },
        (error) => notices.push(error),
    );
    const outcome = starting.catch((error) => {
        settled = true;
        return error;
    });
    try {
        await flush();
        assert.deepEqual(notices, [fault]);
        assert.equal(cleanupStarted, true);
        assert.equal(settled, false);
        assert.deepEqual(boot.inspect(), { state: 'cleaning', attempts: 1 });
        assert.equal(
            boot.start(() => assert.fail('Retry ran before cleanup completed')),
            starting,
        );
        gate.resolve();
        assert.equal(await outcome, fault);
        assert.equal(boot.inspect().state, 'failed');
        await boot.start(() => {});
        assert.deepEqual(boot.inspect(), { state: 'ready', attempts: 2 });
    } finally {
        gate.resolve();
        await outcome;
        await root.close();
    }
});

test('notification errors do not replace startup and cleanup failures', async (t) => {
    const root = new Scope('app'),
        boot = new BootFlow(root.lifetime),
        original = Error('startup'),
        notification = Error('notification'),
        cleanup = Error('cleanup');
    const reported: unknown[] = [];
    t.mock.method(console, 'error', (_prefix, error) => reported.push(error));
    let cleaned = false;
    try {
        await assert.rejects(
            boot.start(
                ({ scope }) => {
                    scope.defer(() => {
                        cleaned = true;
                        throw cleanup;
                    });
                    throw original;
                },
                () => {
                    throw notification;
                },
            ),
            (error: any) => error.code === 'BOOT_CLEANUP_FAILED' && error.details.error === original,
        );
        assert.equal(cleaned, true);
        assert.ok(reported.includes(notification));
        assert.equal(boot.inspect().state, 'failed');
    } finally {
        await root.close();
    }
});

test('normal startup cancellation drains without reporting a failure notification', async () => {
    const root = new Scope('app'),
        boot = new BootFlow(root.lifetime);
    let notifications = 0,
        cleaned = false;
    try {
        await assert.rejects(
            boot.start(
                ({ scope }) => {
                    scope.defer(() => {
                        cleaned = true;
                    });
                    throw new OperationCancelled();
                },
                () => {
                    notifications++;
                },
            ),
            OperationCancelled,
        );
        assert.equal(notifications, 0);
        assert.equal(cleaned, true);
    } finally {
        await root.close();
    }
});
