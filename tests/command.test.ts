import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from '../assets/framework/core/command';
import { Scope } from '../assets/framework/core/scope';
import { deferred, flush } from './fake-clock';

test('command captures arguments, delivers errors before cleanup, and exposes an independent cleanup outcome', async () => {
    const owner = new Scope('command'),
        gate = deferred(),
        errors: unknown[] = [],
        args = { id: 1 };
    let received = 0;
    const command = new Command<{ id: number }, void>(owner, {
        policy: 'exclusive',
        onCleanupError: (e) => errors.push(e),
        execute: (input, task) => {
            received = input.id;
            task.scope.defer(async () => {
                await gate.promise;
                throw Error('cleanup failed');
            });
            throw Error('request failed');
        },
    });
    const invocation = command.invoke(args)!;
    args.id = 2;
    await assert.rejects(invocation.result, /request failed/);
    assert.equal(received, 1);
    assert.equal(command.state.value.cleaning, 1);
    assert.equal(command.canRun(args), false);
    assert.equal(command.invoke(args), undefined);
    let completed = false;
    const end = assert.rejects(invocation.completed, { code: 'SCOPE_CLEANUP_FAILED' }).then(() => {
        completed = true;
    });
    await flush();
    assert.equal(completed, false);
    gate.resolve();
    await end;
    assert.equal(command.canRun(args), true);
    assert.equal(invocation.state.value.outcome, 'failed');
    assert.equal(errors.length, 1);
    await owner.close();
});

test('idle notification admits a synchronous retry, with no stale completion overwriting its status', async () => {
    const owner = new Scope('retry'),
        gate = deferred();
    let calls = 0,
        retried: ReturnType<Command<void, void>['invoke']>;
    const command = new Command<void, void>(owner, {
        policy: 'exclusive',
        execute: async () => {
            if (++calls === 2) await gate.promise;
        },
    });
    let wasBusy = false;
    command.state.subscribe(owner, ({ busy }) => {
        if (wasBusy && !busy && calls === 1) retried = command.invoke(undefined);
        wasBusy = busy;
    });
    const first = command.invoke(undefined)!;
    await first.completed;
    await flush();
    assert.ok(retried);
    assert.equal(calls, 2);
    assert.equal(command.state.value.running, 1);
    gate.resolve();
    await retried.completed;
    await owner.close();
});

test('latest retains cancelled physical work in aggregate status and both owner cleanup barriers', async () => {
    const owner = new Scope('model'),
        show = new Scope('show'),
        gate = deferred();
    let released = false;
    const command = new Command<number, number>(owner, {
        policy: 'latest',
        execute: async (id, task) => {
            if (id === 1) {
                task.scope.defer(() => {
                    released = true;
                });
                await gate.promise;
            }
            return id;
        },
    });
    const old = command.invoke(1, { owner: show, context: undefined })!;
    await flush();
    const fresh = command.invoke(2, { owner: show, context: undefined })!;
    await assert.rejects(old.result, { code: 'OPERATION_CANCELLED' });
    assert.equal(await fresh.result, 2);
    await fresh.completed;
    assert.deepEqual(command.state.value, { pending: 1, queued: 0, running: 0, cleaning: 1, busy: true });
    let closed = false;
    const closing = owner.close().then(() => {
        closed = true;
    });
    await flush();
    assert.equal(closed, false);
    assert.equal(released, false);
    gate.resolve();
    await closing;
    await show.close();
    assert.equal(released, true);
});

test('serial results are prompt while subsequent work waits for physical cleanup; queued cancellation never executes', async () => {
    const owner = new Scope('serial'),
        gate = deferred(),
        order: number[] = [];
    const command = new Command<number, number>(owner, {
        policy: 'serial',
        maxPending: 3,
        execute: (n, task) => {
            order.push(n);
            if (n === 1) task.scope.defer(() => gate.promise);
            return n;
        },
    });
    const first = command.invoke(1)!,
        cancelled = command.invoke(2)!,
        third = command.invoke(3)!;
    assert.throws(() => command.invoke(4), { code: 'ACTION_QUEUE_FULL' });
    assert.equal(await first.result, 1);
    cancelled.cancel();
    await assert.rejects(cancelled.result, { code: 'OPERATION_CANCELLED' });
    await cancelled.completed;
    assert.deepEqual(order, [1]);
    gate.resolve();
    assert.equal(await third.result, 3);
    await third.completed;
    assert.deepEqual(order, [1, 3]);
    await owner.close();
});

test('keyed exclusion and distinct display owners let shared definitions survive one display closing', async () => {
    const owner = new Scope('flow'),
        a = new Scope('a'),
        b = new Scope('b'),
        gate = deferred();
    const command = new Command<number, number>(owner, {
        policy: 'exclusive',
        key: String,
        execute: async (id) => {
            await gate.promise;
            return id;
        },
    });
    const first = command.invoke(1, { owner: a, context: undefined })!;
    const second = command.invoke(2, { owner: b, context: undefined })!;
    assert.equal(command.canRun(1), false);
    assert.equal(command.canRun(3), true);
    a.cancel();
    await assert.rejects(first.result, { code: 'OPERATION_CANCELLED' });
    assert.equal(second.state.value.outcome, 'pending');
    gate.resolve();
    assert.equal(await second.result, 2);
    await Promise.all([first.completed, second.completed, a.close(), b.close(), owner.close()]);
});
