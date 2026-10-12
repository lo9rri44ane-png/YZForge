import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewSession, type ViewModelFactory } from '../assets/framework/ui/view-session';
import { Scope, runTask } from '../assets/framework/core/scope';
import type { ModuleContext } from '../assets/framework/modules/module-manager';
import { deferred, flush } from './fake-clock';

test('a session creates each model once, retains params across displays and creates fresh state after close', async () => {
    const owner = new Scope('ui'),
        ctx = {} as ModuleContext;
    let calls = 0;
    const factory: ViewModelFactory<{ selected: number }, { selected: number }> = ({ params }) => {
        calls++;
        return { selected: params.selected };
    };
    const session = new ViewSession(owner.child('first'), { selected: 1 }, ctx);
    const model = session.use(factory);
    model.selected = 2;
    assert.equal(session.use(factory), model);
    assert.equal(session.use(factory).selected, 2);
    await session.__close();
    assert.throws(() => session.use(factory), { code: 'OPERATION_CANCELLED' });
    const fresh = new ViewSession(owner.child('second'), { selected: 3 }, ctx);
    assert.equal(fresh.use(factory).selected, 3);
    assert.equal(calls, 2);
    await owner.close();
});

test('model construction is synchronous; readiness is explicit and close retains the physical work barrier', async () => {
    const owner = new Scope('ui'),
        session = new ViewSession(owner.child('session'), undefined, {} as ModuleContext);
    const gate = deferred();
    let initialized = false,
        closed = false;
    const model = session.use(({ scope }) => ({
        ready: runTask(scope, async () => {
            await gate.promise;
            initialized = true;
        }),
    }));
    assert.equal(initialized, false);
    await flush();
    const closing = session.__close().then(() => {
        closed = true;
    });
    await flush();
    assert.equal(closed, false);
    gate.resolve();
    await model.ready;
    await closing;
    assert.equal(closed, true);
    await owner.close();
});
