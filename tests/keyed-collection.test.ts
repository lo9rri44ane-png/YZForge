import test from 'node:test';
import assert from 'node:assert/strict';
import { Scope } from '../assets/framework/core/scope';
import { State } from '../assets/framework/core/state';
import { StateBindings } from '../assets/framework/core/state-bindings';
import { KeyedCollection } from '../assets/framework/ui/keyed-collection';
import type { ItemContext } from '../assets/framework/ui/item-binding';
import { deferred, flush } from './fake-clock';

type Row = { id: string; title: string };
type Cell = { active: boolean; destroyed: boolean; text: string; context?: ItemContext<Row> };
const row = (id: string, title = id): Row => ({ id, title });
function fixture(
    options: {
        bind?: (cell: Cell, context: ItemContext<Row>) => void | Promise<void>;
        create?: () => Promise<void>;
        deactivate?: () => Promise<void>;
    } = {},
) {
    const errors: unknown[] = [],
        cells: Cell[] = [],
        orders: Cell[][] = [];
    const owner = new Scope('collection-test', (error) => errors.push(error));
    const state = new State<readonly Row[]>([]);
    const collection = new KeyedCollection<Row, Cell>(
        owner,
        (data) => data.id,
        {
            create: async (scope) => {
                await options.create?.();
                scope.signal.throwIfAborted();
                const cell: Cell = { active: false, destroyed: false, text: '' };
                cells.push(cell);
                scope.child('asset-instance').defer(() => {
                    cell.destroyed = true;
                });
                return cell;
            },
            bind: async (cell, context) => {
                cell.context = context;
                context.state.subscribe(context.scope, (state) => {
                    cell.text = state.data.title;
                });
                await options.bind?.(cell, context);
            },
            show: (cell) => {
                cell.active = true;
            },
            order: (order) => orders.push([...order]),
            deactivate: (cell) => {
                cell.active = false;
                return options.deactivate?.() ?? Promise.resolve();
            },
        },
        (error) => errors.push(error),
    );
    const binding = new StateBindings(
        owner,
        () => true,
        (error) => errors.push(error),
    ).prepare(state.readonly, (rows) => rows, {
        prepare: (rows, task) => collection.prepare(rows, task),
        render: (plan) => collection.commit(plan),
        onError: (error) => errors.push(error),
    });
    return { owner, state, cells, orders, collection, binding, errors };
}

test('集合按业务身份增删：保留 B、销毁 A、只创建 C，同 ID 更新不重绑', async () => {
    const f = fixture();
    f.state.set([row('A'), row('B')]);
    await f.binding.ready;
    const [a, b] = f.cells,
        context = b.context!;
    f.state.set([row('B', 'updated'), row('C')]);
    await f.binding.ready;
    await flush();
    assert.equal(f.cells.length, 3);
    assert.equal(b.context, context);
    assert.equal(context.signal.aborted, false);
    assert.equal(context.state.value.index, 0);
    assert.equal(b.text, 'updated');
    assert.equal(a.active, false);
    assert.equal(a.destroyed, true);
    for (let i = 0; i < 20; i++) {
        f.binding.refresh();
        await f.binding.ready;
    }
    assert.equal(f.cells.length, 3);
    assert.deepEqual(f.collection.inspect(), { displayed: 2, instances: 2, retiring: 0 });
    await f.owner.close();
    assert.ok(f.cells.every((cell) => cell.destroyed));
    assert.deepEqual(f.errors, []);
});

test('排序只改变位置状态，绑定身份和订阅保持；非法重复 Key 保留原画面', async () => {
    const f = fixture();
    f.state.set([row('A'), row('B')]);
    await f.binding.ready;
    const [a, b] = f.cells;
    f.state.set([row('B'), row('A')]);
    await f.binding.ready;
    assert.deepEqual(f.orders.at(-1), [b, a]);
    assert.equal(a.context!.state.value.index, 1);
    assert.equal(a.context!.signal.aborted, false);
    f.state.set([row('B'), row('B')]);
    await assert.rejects(f.binding.ready, { code: 'ITEM_KEY_DUPLICATE' });
    assert.deepEqual(f.orders.at(-1), [b, a]);
    assert.equal(f.cells.length, 2);
    await f.owner.close();
});

test('新增内容失败保留原集合，新数据不会提前写入被复用的条目', async () => {
    let fail = true;
    const f = fixture({
        bind: (_cell, context) => {
            if (context.key === 'C' && fail) throw Error('offline');
        },
    });
    f.state.set([row('A'), row('B')]);
    await f.binding.ready;
    const b = f.cells[1];
    f.state.set([row('B', 'next'), row('C')]);
    await assert.rejects(f.binding.ready, /offline/);
    assert.equal(b.text, 'B');
    assert.deepEqual(
        f.cells.filter((cell) => cell.active).map((cell) => cell.text),
        ['A', 'B'],
    );
    fail = false;
    f.binding.refresh();
    await f.binding.ready;
    assert.equal(b.text, 'next');
    assert.deepEqual(
        f.cells.filter((cell) => cell.active).map((cell) => cell.text),
        ['next', 'C'],
    );
    await f.owner.close();
});

test('连续替换等待旧候选真实退出，实例数量有界且旧候选不能提交', async () => {
    const gate = deferred<void>();
    const f = fixture({ bind: (_cell, context) => (context.key === 'slow' ? gate.promise : undefined) });
    f.state.set([row('A')]);
    await f.binding.ready;
    f.state.set([row('slow')]);
    for (let i = 0; i < 6; i++) await flush();
    const slow = f.cells[1];
    assert.ok(slow);
    for (let i = 0; i < 20; i++) f.state.set([row(`next-${i}`)]);
    await flush();
    assert.equal(f.cells.length, 2);
    assert.equal(slow.destroyed, false);
    assert.equal(slow.context!.signal.aborted, true);
    assert.equal(f.cells[0].active, true);
    gate.resolve();
    await f.binding.ready;
    assert.equal(slow.active, false);
    assert.equal(slow.destroyed, true);
    assert.deepEqual(
        f.cells.filter((cell) => cell.active).map((cell) => cell.text),
        ['next-19'],
    );
    assert.equal(f.cells.length, 3);
    await f.owner.close();
});

test('关闭同步停用输入，节点等条目任务、清理和组件失活全部结束才销毁', async () => {
    const work = deferred<void>(),
        cleanup = deferred<void>(),
        deactivate = deferred<void>();
    let task!: Promise<unknown>;
    const f = fixture({
        bind: (_cell, context) => {
            task = context.run(() => work.promise);
            context.scope.defer(() => cleanup.promise);
        },
        deactivate: () => deactivate.promise,
    });
    f.state.set([row('A')]);
    await f.binding.ready;
    let closed = false;
    const closing = f.owner.close().then(() => {
        closed = true;
    });
    await flush();
    assert.equal(f.cells[0].active, false);
    assert.equal(f.cells[0].destroyed, false);
    work.resolve();
    await task;
    await flush();
    cleanup.resolve();
    await flush();
    assert.equal(closed, false);
    assert.equal(f.cells[0].destroyed, false);
    deactivate.resolve();
    await closing;
    assert.equal(f.cells[0].destroyed, true);
    assert.deepEqual(f.owner.inspect().children, []);
});

test('取消监听重入集合关闭也保持完整清理屏障', async () => {
    const gate = deferred<void>();
    const f = fixture({
        bind: (_cell, item) => {
            item.signal.onAbort(() => {
                void f.collection.dispose();
            });
            item.scope.defer(() => gate.promise);
        },
    });
    f.state.set([row('A')]);
    await f.binding.ready;
    const closing = f.owner.close();
    await flush();
    assert.equal(f.cells[0].destroyed, false);
    gate.resolve();
    await closing;
    assert.equal(f.cells[0].destroyed, true);
});

test('集合关闭的清理失败被交付，其余实例仍全部释放', async () => {
    const f = fixture({
        bind: (_cell, item) => {
            item.scope.defer(() => {
                throw Error('cleanup');
            });
        },
    });
    f.state.set([row('A'), row('B')]);
    await f.binding.ready;
    await assert.rejects(f.owner.close(), { code: 'SCOPE_CLEANUP_FAILED' });
    assert.ok(f.cells.every((cell) => cell.destroyed));
    assert.equal(f.collection.inspect().instances, 0);
});
