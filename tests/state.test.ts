import test from 'node:test';
import assert from 'node:assert/strict';
import { State } from '../assets/framework/core/state';
import { StateBindings } from '../assets/framework/core/state-bindings';
import { Scope, runTask } from '../assets/framework/core/scope';
import { deferred, flush } from './fake-clock';

test('state copies data, shares immutable branches, rejects resources, and exposes no write capability', () => {
    const input = { items: [{ id: 1 }], coins: 0 };
    const state = new State(input);
    input.items[0].id = 2;
    assert.equal(state.readonly.value.items[0].id, 1);
    assert.equal(Object.isFrozen(state.readonly.value.items[0]), true);
    const items = state.readonly.value.items;
    state.update((s) => ({ ...s, coins: 1 }));
    assert.equal(state.readonly.value.items, items);
    assert.equal('set' in state.readonly, false);
    assert.throws(() => new State(new Map()), { code: 'STATE_NOT_DATA' });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    assert.throws(() => new State(cyclic), { code: 'STATE_CYCLE' });
});

test('subscriptions are ordered under reentrancy, isolate faults, and detach synchronously', async () => {
    const owner = new Scope('state');
    const state = new State(0),
        events: string[] = [],
        errors: unknown[] = [];
    state.readonly.subscribe(owner, (n) => {
        events.push(`a${n}`);
        if (n === 1) state.set(2);
    });
    state.readonly.subscribe(owner, (n) => events.push(`b${n}`));
    state.readonly.subscribe(
        owner,
        () => {
            throw Error('broken');
        },
        (error) => errors.push(error),
    );
    state.set(1);
    assert.deepEqual(events, ['a0', 'b0', 'a1', 'b1', 'a2', 'b2']);
    assert.equal(errors.length, 1);
    owner.cancel();
    state.set(3);
    assert.equal(events.length, 6);
    assert.equal(state.readonly.value, 3);
    await owner.close();
});

test('an initial subscriber can publish or subscribe without reversing versions', async () => {
    const owner = new Scope('reentry'),
        state = new State(0),
        seen: number[] = [];
    state.readonly.subscribe(owner, (n) => {
        seen.push(n);
        if (!n) state.set(1);
    });
    assert.deepEqual(seen, [0, 1]);
    const nested: number[] = [];
    state.readonly.subscribe(owner, (n) => {
        if (n === 2) {
            state.set(3);
            state.readonly.subscribe(owner, (value) => nested.push(value));
        }
    });
    state.set(2);
    assert.deepEqual(nested, [3]);
    await owner.close();
});

test('selector renders only its region and synchronous updates create no revision scopes', async () => {
    const owner = new Scope('view'),
        state = new State({ coins: 0, items: [1] });
    const bindings = new StateBindings(owner),
        seen: (readonly number[])[] = [];
    bindings.watch(
        state.readonly,
        (s) => s.items,
        (items) => seen.push(items),
    );
    for (let i = 0; i < 100; i++) state.update((s) => ({ ...s, coins: i }));
    await bindings.ready();
    assert.equal(seen.length, 1);
    assert.equal(owner.inspect().children[0].children.length, 0);
    await owner.close();
});

test('latest preparation wins, first paint waits, and displayed resources outlive preparation', async () => {
    const owner = new Scope('view'),
        state = new State('old');
    const old = deferred<string>(),
        fresh = deferred<string>(),
        seen: string[] = [],
        released: string[] = [];
    const binding = new StateBindings(owner).prepare(state.readonly, (s) => s, {
        prepare: async (value, task) => {
            task.scope.defer(() => {
                released.push(value);
            });
            return await (value === 'old' ? old : fresh).promise;
        },
        render: (value) => {
            seen.push(value);
        },
    });
    let ready = false;
    void binding.ready.then(() => {
        ready = true;
    });
    await flush();
    state.set('new');
    await flush();
    old.resolve('OLD');
    await flush();
    assert.deepEqual(seen, []);
    assert.equal(ready, false);
    fresh.resolve('NEW');
    await binding.ready;
    await flush();
    assert.deepEqual(seen, ['NEW']);
    assert.deepEqual(released, ['old']);
    await owner.close();
    assert.deepEqual(released, ['old', 'new']);
});

test('failed replacements keep the previous display and retry the same value explicitly', async () => {
    const owner = new Scope('view'),
        state = new State(1),
        released: number[] = [],
        errors: unknown[] = [];
    let fail = false,
        displayed = 0;
    const binding = new StateBindings(owner).prepare(state.readonly, (s) => s, {
        prepare: (n, task) => {
            task.scope.defer(() => {
                released.push(n);
            });
            if (fail) throw Error('offline');
            return n;
        },
        render: (n, _value, previous) => {
            assert.equal(released.includes(previous ?? -1), false);
            displayed = n;
        },
        onError: (error) => errors.push(error),
    });
    await binding.ready;
    fail = true;
    state.set(2);
    await flush();
    assert.equal(displayed, 1);
    assert.equal(released.includes(1), false);
    assert.equal(errors.length, 1);
    fail = false;
    binding.refresh();
    await flush();
    assert.equal(displayed, 2);
    assert.equal(released.includes(1), true);
    await owner.close();
});

test('required preparation fails readiness; optional preparation reports and keeps its placeholder', async () => {
    const owner = new Scope('view'),
        state = new State(0),
        errors: unknown[] = [];
    const bindings = new StateBindings(
        owner,
        () => true,
        (error) => errors.push(error),
    );
    bindings.prepare(state.readonly, (s) => s, {
        prepare: () => {
            throw Error('required');
        },
        render: () => {},
    });
    await assert.rejects(bindings.ready(), /required/);
    assert.deepEqual(errors, []);
    const optional = new StateBindings(
        owner,
        () => true,
        (error) => errors.push(error),
    );
    optional.prepare(state.readonly, (s) => s, {
        required: false,
        prepare: () => {
            throw Error('optional');
        },
        render: () => {},
    });
    await optional.ready();
    await flush();
    assert.equal(errors.length, 1);
    await owner.close();
});

test('render faults cannot escape state publication or be treated as a recoverable preparation error', async () => {
    const owner = new Scope('view'),
        state = new State(0),
        faults: unknown[] = [],
        recoverable: unknown[] = [];
    const bindings = new StateBindings(
        owner,
        () => true,
        (error) => faults.push(error),
    );
    bindings.watch(
        state.readonly,
        (s) => s,
        (n) => {
            if (n) throw Error('label lost');
        },
    );
    const binding = bindings.prepare(state.readonly, (s) => s, {
        prepare: (n) => n,
        render: (n) => {
            if (n) throw Error('node lost');
        },
        onError: (error) => recoverable.push(error),
    });
    await binding.ready;
    assert.doesNotThrow(() => state.set(1));
    await flush();
    assert.equal(state.readonly.value, 1);
    assert.equal(faults.length, 2);
    assert.deepEqual(recoverable, []);
    await owner.close();
});

test('closing cancels readiness and subscriptions, but waits for noncooperative work and ancestor resource users', async () => {
    const owner = new Scope('view'),
        state = new State(0),
        gate = deferred(),
        ancestor = deferred();
    let released = false,
        rendered = false,
        closed = false;
    const binding = new StateBindings(owner).prepare(state.readonly, (s) => s, {
        prepare: async (_n, task) => {
            task.scope.defer(() => {
                released = true;
            });
            await gate.promise;
        },
        render: () => {
            rendered = true;
        },
    });
    const task = runTask(owner, () => ancestor.promise);
    const rejection = assert.rejects(binding.ready, { code: 'OPERATION_CANCELLED' });
    await flush();
    const closing = owner.close().then(() => {
        closed = true;
    });
    await rejection;
    gate.resolve();
    await flush();
    assert.equal(closed, false);
    assert.equal(released, false);
    assert.equal(rendered, false);
    ancestor.resolve();
    await task;
    await closing;
    assert.equal(released, true);
});

test('two views can bind one state; closing one does not cancel the other or its resources', async () => {
    const state = new State(0),
        a = new Scope('skin-a'),
        b = new Scope('skin-b');
    const seenA: number[] = [],
        seenB: number[] = [];
    new StateBindings(a).watch(
        state.readonly,
        (s) => s,
        (n) => seenA.push(n),
    );
    new StateBindings(b).watch(
        state.readonly,
        (s) => s,
        (n) => seenB.push(n),
    );
    state.set(1);
    await a.close();
    state.set(2);
    assert.deepEqual(seenA, [0, 1]);
    assert.deepEqual(seenB, [0, 1, 2]);
    await b.close();
});

test('a render-triggered update retains both stages through the latest initial paint', async () => {
    const state = new State(0),
        owner = new Scope('view'),
        next = deferred<number>(),
        released: number[] = [];
    let ready = false;
    const binding = new StateBindings(owner).prepare(state.readonly, (s) => s, {
        prepare: (n, task) => {
            task.scope.defer(() => {
                released.push(n);
            });
            return n ? next.promise : n;
        },
        render: (n) => {
            if (!n) state.set(1);
        },
    });
    void binding.ready.then(() => {
        ready = true;
    });
    await flush();
    assert.equal(ready, false);
    assert.deepEqual(released, []);
    next.resolve(1);
    await binding.ready;
    await owner.close();
    assert.deepEqual(released.sort(), [0, 1]);
});

test('a selector failure invalidates an older preparation before it can commit', async () => {
    const owner = new Scope('view'),
        state = new State(0),
        gate = deferred<number>(),
        seen: number[] = [];
    const binding = new StateBindings(owner).prepare(
        state.readonly,
        (n) => {
            if (n) throw Error('invalid selection');
            return n;
        },
        {
            prepare: () => gate.promise,
            render: (n) => {
                seen.push(n);
            },
        },
    );
    await flush();
    state.set(1);
    await assert.rejects(binding.ready, /invalid selection/);
    gate.resolve(0);
    await flush();
    assert.deepEqual(seen, []);
    await owner.close();
});

test('the screen readiness barrier rechecks regions that changed while another region was preparing', async () => {
    const owner = new Scope('view'),
        a = new State(0),
        b = new State(0);
    const slowA = deferred<number>(),
        slowB = deferred<number>(),
        bindings = new StateBindings(owner);
    bindings.prepare(a.readonly, (n) => n, { prepare: (n) => (n ? slowA.promise : n), render: () => {} });
    bindings.prepare(b.readonly, (n) => n, { prepare: () => slowB.promise, render: () => {} });
    let ready = false;
    const waiting = bindings.ready().then(() => {
        ready = true;
    });
    await flush();
    a.set(1);
    slowB.resolve(0);
    await flush();
    assert.equal(ready, false);
    slowA.resolve(1);
    await waiting;
    await owner.close();
});

test('bindings registered after the initial readiness gate report their first rendering failure', async () => {
    const owner = new Scope('view'),
        state = new State(0),
        faults: unknown[] = [];
    const bindings = new StateBindings(
        owner,
        () => true,
        (error) => faults.push(error),
    );
    await bindings.ready();
    bindings.watch(
        state.readonly,
        (n) => n,
        () => {
            throw Error('late region failed');
        },
    );
    assert.equal(faults.length, 1);
    await owner.close();
});
