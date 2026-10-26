import test from 'node:test';
import assert from 'node:assert/strict';
import { State, derive, batch } from '../assets/framework/core/state';
import { Scope } from '../assets/framework/core/scope';
import { StateBindings } from '../assets/framework/core/state-bindings';
import { claimProperties } from '../assets/framework/core/property-lease';
import { deferred, flush } from './fake-clock';

test('diamond derivations settle before any observer and batching coalesces related writes', async () => {
    const owner = new Scope('derived'),
        source = new State(1),
        other = new State(10);
    const a = derive(owner, [source.readonly], (n) => n * 2);
    const b = derive(owner, [source.readonly], (n) => n * 3);
    const sum = derive(owner, [a, b, other.readonly], (a, b, c) => a + b + c);
    const seen: number[][] = [];
    source.readonly.subscribe(owner, () => seen.push([a.value, b.value, sum.value]));
    const totals: number[] = [];
    sum.subscribe(owner, (n) => totals.push(n));
    source.set(2);
    assert.deepEqual(seen, [
        [2, 3, 15],
        [4, 6, 20],
    ]);
    batch(() => {
        source.set(3);
        batch(() => {
            other.set(20);
            source.set(4);
        });
    });
    assert.deepEqual(totals, [15, 20, 40]);
    assert.deepEqual(seen.at(-1), [8, 12, 40]);
    await owner.close();
});

test('derived equality preserves branches; disposal detaches inputs and freeze retains last value', async () => {
    const owner = new Scope('owner'),
        model = owner.child('model'),
        source = new State({ id: 1, coins: 0 });
    let calculations = 0;
    const selected = derive(
        model,
        [source.readonly],
        (s) => {
            calculations++;
            return [s.id];
        },
        {
            equals: (a, b) => a[0] === b[0],
        },
    );
    const first = selected.value;
    source.set({ id: 1, coins: 2 });
    assert.equal(selected.value, first);
    assert.equal(calculations, 2);
    await model.close();
    source.set({ id: 2, coins: 3 });
    assert.equal(selected.value, first);
    assert.equal(calculations, 2);
    await owner.close();
});

test('equal upstream values stop downstream computation, notification and resource preparation', async () => {
    const owner = new Scope('equal-branch');
    const source = new State({ id: 1, coins: 0 });
    const selected = derive(owner, [source.readonly], (s) => [s.id], { equals: (a, b) => a[0] === b[0] });
    let calculations = 0,
        notifications = 0,
        preparations = 0;
    const detail = derive(owner, [selected], (ids) => {
        calculations++;
        return { id: ids[0] };
    });
    detail.subscribe(owner, () => {
        notifications++;
    });
    new StateBindings(owner).prepare(detail, (value) => value, {
        prepare: () => {
            preparations++;
        },
        render: () => {},
    });
    await flush();
    source.set({ id: 1, coins: 2 });
    await flush();
    assert.deepEqual([calculations, notifications, preparations], [1, 1, 1]);
    source.set({ id: 2, coins: 2 });
    await flush();
    assert.deepEqual([calculations, notifications, preparations], [2, 2, 2]);
    await owner.close();
});

test('equal branches do not hide changes on other diamond inputs or batched read-through', async () => {
    const owner = new Scope('mixed-diamond');
    const source = new State(1);
    const parity = derive(owner, [source.readonly], (n) => n % 2);
    const twice = derive(owner, [source.readonly], (n) => n * 2);
    let runs = 0;
    const joined = derive(owner, [parity, twice], (a, b) => {
        runs++;
        return [a, b];
    });
    const seen: unknown[] = [];
    joined.subscribe(owner, (value) => {
        seen.push(value);
    });
    batch(() => {
        source.set(3);
        assert.deepEqual(joined.value, [1, 6]);
        source.set(5);
    });
    assert.deepEqual(seen, [
        [1, 2],
        [1, 10],
    ]);
    assert.equal(runs, 3);
    source.set(6);
    assert.deepEqual(seen.at(-1), [0, 12]);
    await owner.close();
});

test('derived errors stop the affected graph, isolate unrelated observers and reject impure calculations', async () => {
    const owner = new Scope('failure'),
        source = new State(0),
        failures: unknown[] = [];
    const a = derive(
        owner,
        [source.readonly],
        (n) => {
            if (n) throw Error('broken calculation');
            return n;
        },
        { onError: (e) => failures.push(e) },
    );
    const b = derive(owner, [a], (n) => n + 1, { onError: () => {} });
    let healthy = 0;
    source.readonly.subscribe(owner, (n) => {
        healthy = n;
    });
    const observed: unknown[] = [];
    b.subscribe(
        owner,
        () => {},
        (e) => observed.push(e),
    );
    source.set(1);
    assert.equal(healthy, 1);
    assert.equal(failures.length, 1);
    assert.equal(observed.length, 1);
    assert.throws(() => b.value, /broken calculation/);
    assert.throws(
        () =>
            derive(owner, [source.readonly], () => {
                source.set(2);
                return 0;
            }),
        { code: 'STATE_WRITE_IN_DERIVE' },
    );
    assert.throws(() => derive(owner, [source.readonly], () => source.readonly.value), {
        code: 'STATE_READ_IN_DERIVE',
    });
    assert.throws(() => derive(owner, [source.readonly], async (n) => n), { code: 'STATE_ASYNC_EFFECT' });
    assert.throws(() => batch(async () => {}), { code: 'STATE_ASYNC_EFFECT' });
    assert.throws(
        () =>
            batch(() => {
                source.set(3);
                throw Error('not a transaction');
            }),
        /not a transaction/,
    );
    assert.equal(source.readonly.value, 3);
    await owner.close();
});

test('property leases reject two writers and release synchronously on dispose and owner cancellation', async () => {
    const owner = new Scope('properties'),
        other = new Scope('other'),
        source = new State('hello'),
        target = { text: '' };
    const a = new StateBindings(owner),
        b = new StateBindings(other);
    const first = a.property(target, 'text', source.readonly, (s) => s);
    assert.equal(target.text, 'hello');
    assert.throws(() => b.property(target, 'text', source.readonly, (s) => s), { code: 'BINDING_PROPERTY_OWNED' });
    const retiring = first.dispose();
    b.property(target, 'text', source.readonly, (s) => s.toUpperCase());
    assert.equal(target.text, 'HELLO');
    other.cancel();
    a.property(target, 'text', source.readonly, (s) => s);
    source.set('world');
    assert.equal(target.text, 'world');
    await Promise.all([retiring, owner.close(), other.close()]);
});

test('a failed derived source rejects initial readiness instead of opening an unrendered view', async () => {
    const owner = new Scope('failed-source'),
        source = new State(0),
        faults: unknown[] = [];
    const derived = derive(
        owner,
        [source.readonly],
        (n) => {
            if (n) throw Error('source failed');
            return n;
        },
        { onError: () => {} },
    );
    source.set(1);
    const bindings = new StateBindings(
        owner,
        () => true,
        (error) => faults.push(error),
    );
    let painted = false;
    bindings.watch(
        derived,
        (n) => n,
        () => {
            painted = true;
        },
    );
    await assert.rejects(bindings.ready(), /source failed/);
    assert.equal(painted, false);
    assert.deepEqual(faults, []);
    await owner.close();
});

test('source failure cancels pending paint promptly but retains its physical resource barrier', async () => {
    const owner = new Scope('source-failed-during-prepare'),
        source = new State(0),
        gate = deferred<number>();
    const derived = derive(
        owner,
        [source.readonly],
        (n) => {
            if (n) throw Error('source failed');
            return n;
        },
        { onError: () => {} },
    );
    const bindings = new StateBindings(owner);
    let released = false,
        painted = false;
    bindings.prepare(derived, (n) => n, {
        prepare: async (_value, task) => {
            task.scope.defer(() => {
                released = true;
            });
            return gate.promise;
        },
        render: () => {
            painted = true;
        },
    });
    let result: unknown = 'pending';
    const waiting = bindings.ready().then(
        () => {
            result = 'ready';
        },
        (error) => {
            result = error;
        },
    );
    await flush();
    source.set(1);
    await flush();
    const failureWasPrompt = result instanceof Error && result.message === 'source failed';
    const retained = !released;
    gate.resolve(0);
    await waiting;
    await owner.close();
    assert.equal(failureWasPrompt, true);
    assert.equal(retained, true);
    assert.equal(released, true);
    assert.equal(painted, false);
});

test('releasing an old property lease twice cannot release its successor', () => {
    const target = { text: '' };
    const old = claimProperties(target, ['text']);
    old();
    const current = claimProperties(target, ['text']);
    old();
    assert.throws(() => claimProperties(target, ['text']), { code: 'BINDING_PROPERTY_OWNED' });
    current();
    claimProperties(target, ['text'])();
});
