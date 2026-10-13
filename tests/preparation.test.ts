import test from 'node:test';
import assert from 'node:assert/strict';
import { Scope } from '../assets/framework/core/scope';
import { State } from '../assets/framework/core/state';
import { StateBindings } from '../assets/framework/core/state-bindings';
import { Preparation } from '../assets/framework/core/preparation';
import { KeyedCollection } from '../assets/framework/ui/keyed-collection';
import { VirtualListController } from '../assets/framework/ui/components/virtual-list/virtual-list-controller';
import { deferred, flush } from './fake-clock';

class Region extends StateBindings {
    add(child: StateBindings, required = true): () => void {
        return this.include(child.preparation, required);
    }
}

test('慢工作只订阅一次，兄弟区域频繁变化、重复设置及多个等待者不增加回调', async (t) => {
    const owner = new Scope('bounded-preparation'),
        root = new Preparation(owner),
        slow = new Preparation(owner),
        changing = new Preparation(owner);
    root.include(slow);
    root.include(changing);
    const work = deferred<void>();
    const observed = t.mock.method(work.promise, 'then');
    slow.set(work.promise);
    const readers = [root.ready(), slow.ready()];
    for (let index = 0; index < 1000; index++) {
        slow.set(work.promise);
        changing.set(Promise.resolve());
        if (index % 100 === 0) readers.push(root.ready());
        await flush();
    }
    const subscriptions = observed.mock.callCount();
    work.resolve();
    await Promise.all(readers);
    await owner.close();
    assert.equal(subscriptions, 1);
});

test('已就绪或已失败的快照在交付前仍核对同步发生的新代次', async () => {
    const owner = new Scope('settled-preparation'),
        preparation = new Preparation(owner);
    for (const failed of [false, true]) {
        preparation.set(failed ? Promise.reject(Error('superseded failure')) : undefined);
        await flush();
        let ready = false;
        const waiting = preparation.ready().then(() => {
            ready = true;
        });
        const work = deferred<void>();
        preparation.set(work.promise);
        await flush();
        assert.equal(ready, false);
        work.resolve();
        await waiting;
    }
    await owner.close();
});

for (const outcome of ['resolve', 'reject'] as const) {
    test(`过期工作迟到的 ${outcome} 不覆盖最新准备状态`, async () => {
        const owner = new Scope('stale-preparation'),
            preparation = new Preparation(owner),
            previous = deferred<void>(),
            latest = deferred<void>();
        preparation.set(previous.promise);
        let ready = false;
        const waiting = preparation.ready().then(() => {
            ready = true;
        });
        preparation.set(latest.promise);
        if (outcome === 'resolve') previous.resolve();
        else previous.reject(Error('stale failure'));
        await flush();
        assert.equal(ready, false);
        latest.resolve();
        await waiting;
        await owner.close();
    });
}

test('准备变化穿过多层组合：已就绪子区域更新时，祖先仍等待最新内容', async () => {
    const owner = new Scope('preparation-tree');
    const root = new Region(owner),
        middle = new Region(owner),
        child = new Region(owner);
    root.add(middle);
    middle.add(child);
    const source = new State(0),
        next = deferred<void>(),
        sibling = deferred<void>();
    child.prepare(source.readonly, (value) => value, {
        prepare: (value) => (value ? next.promise : undefined),
        render: () => {},
    });
    root.prepare(new State(0).readonly, (value) => value, { prepare: () => sibling.promise, render: () => {} });
    let ready = false;
    const opening = root.ready().then(() => {
        ready = true;
    });
    await child.ready();
    await flush();
    source.set(1);
    sibling.resolve();
    await flush();
    assert.equal(ready, false);
    next.resolve();
    await opening;
    await owner.close();
});

test('移除必需区域立即解除等待，慢任务仍持有资源直到实际结束', async () => {
    const owner = new Scope('remove-required'),
        childOwner = owner.child('child');
    const root = new Region(owner),
        child = new Region(childOwner);
    const remove = root.add(child),
        work = deferred<void>();
    let released = false;
    child.prepare(new State(0).readonly, (value) => value, {
        prepare: async (_value, stage) => {
            stage.scope.defer(() => {
                released = true;
            });
            await work.promise;
        },
        render: () => {},
    });
    const opening = root.ready();
    await flush();
    remove();
    const closing = childOwner.close();
    await opening;
    assert.equal(released, false);
    work.resolve();
    await closing;
    assert.equal(released, true);
    await owner.close();
});

test('可选组合不阻挡祖先，直接等待可选区域仍等待它自己的必需资源', async () => {
    const owner = new Scope('optional-region'),
        root = new Region(owner),
        child = new Region(owner);
    root.add(child, false);
    const work = deferred<void>();
    child.prepare(new State(0).readonly, (value) => value, { prepare: () => work.promise, render: () => {} });
    let childReady = false;
    const pending = child.ready().then(() => {
        childReady = true;
    });
    await root.ready();
    assert.equal(childReady, false);
    work.resolve();
    await pending;
    await owner.close();
});

test('祖先忽略被替换代次的失败，最新失败立即交付且不等待其他慢区域', async () => {
    const owner = new Scope('failed-revision'),
        root = new Region(owner),
        child = new Region(owner);
    root.add(child);
    const source = new State(0),
        old = deferred<void>(),
        latest = deferred<void>(),
        sibling = deferred<void>();
    child.prepare(source.readonly, (value) => value, {
        prepare: (value) => (value ? latest.promise : old.promise),
        render: () => {},
        onError: () => {},
    });
    root.prepare(new State(0).readonly, (value) => value, { prepare: () => sibling.promise, render: () => {} });
    const opening = root.ready();
    const failed = assert.rejects(opening, /latest failure/);
    await flush();
    old.reject(Error('stale failure'));
    source.set(1);
    await flush();
    latest.reject(Error('latest failure'));
    await failed;
    sibling.resolve();
    await owner.close();
});

for (const kind of ['collection', 'virtual'] as const) {
    test(`${kind}：两个条目并行等待期间，条目内部独立状态更新向上传递`, async () => {
        const owner = new Scope(kind),
            root = new Region(owner);
        type Cell = { bindings?: StateBindings };
        const states = [new State(0), new State(0)],
            gates = [deferred<void>(), deferred<void>()];
        const adapter = {
            create: async (): Promise<Cell> => ({}),
            bind: async (cell: Cell, item: { scope: Scope['lifetime']; key: string | number }) => {
                const index = Number(item.key);
                cell.bindings = new StateBindings(item.scope);
                cell.bindings.prepare(states[index].readonly, (value) => value, {
                    prepare: (value) => (value ? gates[index].promise : undefined),
                    render: () => {},
                });
                await cell.bindings.ready();
            },
            preparation: (cell: Cell) => cell.bindings!.preparation,
            deactivate: async () => {},
        };
        if (kind === 'collection') {
            const collection = new KeyedCollection(owner, (data: number) => data, {
                ...adapter,
                show: () => {},
                order: () => {},
            });
            root.preparation.include(collection.preparation);
            root.prepare(new State([0, 1]).readonly, (value) => value, {
                prepare: (rows, stage) => collection.prepare(rows, stage),
                render: (plan) => collection.commit(plan),
            });
        } else {
            const list = new VirtualListController(
                owner,
                { itemWidth: 10, itemHeight: 10, overscanRows: 0 },
                { ...adapter, place: () => {}, activate: () => {} },
                (data: number) => data,
            );
            root.preparation.include(list.preparation);
            list.setViewport(20, 0);
            list.setItems([0, 1]);
        }
        await root.ready();
        states[1].set(1);
        let ready = false;
        const opening = root.ready().then(() => {
            ready = true;
        });
        await flush();
        states[0].set(1);
        gates[1].resolve();
        await flush();
        assert.equal(ready, false);
        gates[0].resolve();
        await opening;
        await owner.close();
    });
}

test('已取消子区域使等待拒绝，其兄弟区域迟到的失败仍被消费', async () => {
    const owner = new Scope('cancelled-descendant');
    const root = new Preparation(owner),
        left = new Preparation(owner.child('left'));
    const rightOwner = owner.child('right'),
        right = new Preparation(rightOwner);
    const late = deferred<void>();
    root.include(left);
    root.include(right);
    left.set(late.promise);
    await rightOwner.close();
    await assert.rejects(root.ready(), { code: 'OPERATION_CANCELLED' });
    late.reject(Error('late failure'));
    await flush();
    await owner.close();
});

test('虚拟窗口变化撤销离屏要求，等待新窗口；取消仍立即拒绝', async () => {
    const owner = new Scope('window-readiness');
    const root = new Preparation(owner),
        gates = [deferred<void>(), deferred<void>()];
    const list = new VirtualListController<number, object>(
        owner,
        { itemWidth: 10, itemHeight: 10, overscanRows: 0 },
        {
            create: async () => ({}),
            bind: (_cell, item) => gates[Number(item.key)].promise,
            place: () => {},
            activate: () => {},
            deactivate: async () => {},
        },
        (value) => value,
    );
    root.include(list.preparation);
    list.setViewport(10, 0);
    list.setItems([0, 1]);
    let ready = false;
    const opening = root.ready().then(() => {
        ready = true;
    });
    await flush();
    list.setViewport(10, 10);
    gates[0].resolve();
    await flush();
    assert.equal(ready, false);
    const cancelled = assert.rejects(opening, { code: 'OPERATION_CANCELLED' });
    const closing = owner.close();
    await cancelled;
    gates[1].resolve();
    await closing;
});
