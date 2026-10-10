import test from 'node:test';
import assert from 'node:assert/strict';
import { Scope } from '../../assets/framework/core/scope';
import { Events } from '../../assets/framework/core/events';
import { BadgeStore } from '../../assets/framework/badges/badge-store';
import { TimeService } from '../../assets/framework/time/time-service';
import { Storage } from '../../assets/framework/storage/storage';
import { WalletService } from '../../assets/game/modules/profile/code/services/WalletService';
import { TaskService } from '../../assets/game/modules/workshop/code/services/TaskService';
import { TaskBadges, taskBadge } from '../../assets/game/modules/workshop/contracts/badges';
import { WorkflowPageViewModel } from '../../assets/game/modules/workshop/code/ui/workflow-page/WorkflowPageViewModel';
import { LabClock } from '../../assets/game/modules/showcase/code/services/LabClock';
import { StorageLab, LabWallet, LabStorageBackend } from '../../assets/game/modules/showcase/code/services/StorageLab';
import type { ModuleContext } from '../../assets/framework/modules/module-manager';
import type { ProfileApi } from '../../assets/game/modules/profile/public';
import type { TasksRow } from '../../assets/game/modules/workshop/contracts/generated/config/Tasks.types';
import type { ViewResult } from '../../assets/framework/ui/ui-manager';
import { flush, deferred } from '../fake-clock';
const row: TasksRow = { id: 1, name: '初次训练', goal: 1, reward: 20, quality: 'normal', economy: 1 };
async function setup(rows: readonly TasksRow[] = [row]) {
    const scope = new Scope('example-test');
    const backend = new LabStorageBackend();
    const storage = new Storage('test:', backend);
    const ctx = {
        scope: scope.lifetime,
        storage,
        events: new Events(),
        badges: new BadgeStore(scope),
        config: {
            in: () => ({
                loadMany: async () => ({ tasks: { all: () => rows }, economy: { require: () => ({ id: 1 }) } }),
            }),
        },
    } as unknown as ModuleContext;
    const wallet = new WalletService(ctx);
    const profile: ProfileApi = {
        moduleId: 'profile',
        snapshot: () => wallet.snapshot(),
        changeCoins: (n) => wallet.changeCoins(n),
        claimReward: (id, amount) => wallet.claimReward(id, amount),
        hasReward: (id) => wallet.hasReward(id),
        subscribe: (callback, owner) => wallet.subscribe(callback, owner),
    };
    const tasks = new TaskService(ctx, profile);
    await tasks.load(scope);
    return { scope, backend, storage, ctx, wallet, tasks };
}

test('task domain rejects incomplete commands and persists reward deduplication across service recreation', async () => {
    const s = await setup();
    try {
        assert.throws(() => s.tasks.claim(999), { code: 'DEMO_TASK_UNKNOWN' });
        assert.throws(() => s.tasks.claim(row.id), { code: 'DEMO_TASK_LOCKED' });
        s.tasks.train();
        assert.equal(s.tasks.claim(row.id), true);
        assert.equal(s.tasks.claim(row.id), false);
        assert.equal(s.wallet.snapshot().coins, 20);
        const recreated = new WalletService(s.ctx);
        assert.equal(recreated.claimReward('workshop/task/1', 20), false);
        assert.equal(recreated.snapshot().coins, 20);
        assert.equal(s.tasks.cards([row])[0].state, 'claimed');
    } finally {
        await s.scope.close();
    }
});

test('failed reward write changes neither balance nor idempotency record, and retry grants exactly once', async () => {
    const s = await setup();
    try {
        s.tasks.train();
        s.backend.failKey = 'test:profile.wallet';
        assert.throws(() => s.tasks.claim(row.id), { code: 'STORAGE_WRITE_FAILED' });
        assert.equal(s.wallet.snapshot().coins, 0);
        assert.equal(s.wallet.hasReward('workshop/task/1'), false);
        s.backend.failKey = '';
        assert.equal(s.tasks.claim(row.id), true);
        assert.equal(s.tasks.claim(row.id), false);
        assert.equal(s.wallet.snapshot().coins, 20);
    } finally {
        await s.scope.close();
    }
});

test('任务红点在业务保存后更新，失败保留原值，外部领取同步更新且关闭清空', async () => {
    const s = await setup();
    const counts: number[] = [];
    s.ctx.badges.subscribe(TaskBadges, s.scope, (value) => counts.push(value));
    s.backend.failKey = 'test:workshop.progress';
    assert.throws(() => s.tasks.train());
    assert.deepEqual(counts, [0]);
    s.backend.failKey = '';
    s.tasks.train();
    assert.equal(s.ctx.badges.get(taskBadge(row.id)), 1);
    s.backend.failKey = 'test:profile.wallet';
    assert.throws(() => s.tasks.claim(row.id));
    assert.deepEqual(counts, [0, 1]);
    s.backend.failKey = '';
    s.wallet.claimReward('workshop/task/1', row.reward);
    assert.deepEqual(counts, [0, 1, 0]);
    await s.scope.close();
    assert.deepEqual(s.ctx.badges.inspect(), { nodes: 0, subscriptions: 0, ended: true });
});

test('simulated domain failure and training write failure leave old state unchanged', async () => {
    const s = await setup();
    try {
        s.backend.failKey = 'test:workshop.progress';
        assert.throws(() => s.tasks.train(), { code: 'STORAGE_WRITE_FAILED' });
        assert.equal(s.tasks.snapshot().progress, 0);
        s.backend.failKey = '';
        s.tasks.train();
        s.tasks.simulateFailure();
        assert.throws(() => s.tasks.claim(row.id), /模拟请求失败/);
        assert.equal(s.wallet.snapshot().coins, 0);
        assert.equal(s.tasks.claim(row.id), true);
    } finally {
        await s.scope.close();
    }
});

test('ViewModel waits for confirmation and coalesces duplicate commands without a rendering port', async () => {
    const s = await setup(),
        show = s.scope.child('show'),
        answer = deferred<ViewResult<boolean>>();
    let opens = 0;
    const model = new WorkflowPageViewModel(s.tasks, show, {
        confirm: () => {
            opens++;
            return answer.promise;
        },
    });
    try {
        await Promise.all([model.start(), model.start()]);
        assert.equal(model.state.value.cards.length, 1);
        model.train();
        const first = model.claim(1),
            repeated = model.claim(1);
        await flush();
        assert.equal(opens, 1);
        assert.equal(model.state.value.claiming, true);
        assert.equal(s.wallet.snapshot().coins, 0);
        answer.resolve({ status: 'completed', value: true });
        await Promise.all([first, repeated]);
        await flush();
        assert.equal(model.state.value.coins, 20);
        assert.equal(model.state.value.feedback.code, 'granted');
        assert.equal(model.state.value.claiming, false);
        await show.close();
        const before = model.state.value;
        s.tasks.train();
        await flush();
        assert.equal(model.state.value, before);
    } finally {
        await s.scope.close();
    }
});

test('two skins share business facts while keeping local selection and lifetimes independent', async () => {
    const s = await setup([row, { ...row, id: 2, name: '第二项' }]);
    const a = s.scope.child('cards'),
        b = s.scope.child('compact');
    const effects = { confirm: async (): Promise<ViewResult<boolean>> => ({ status: 'cancelled' }) };
    const cards = new WorkflowPageViewModel(s.tasks, a, effects),
        compact = new WorkflowPageViewModel(s.tasks, b, effects);
    try {
        await Promise.all([cards.start(), compact.start()]);
        compact.select(2);
        assert.equal(cards.state.value.selectedId, 1);
        assert.equal(compact.state.value.selectedId, 2);
        s.tasks.train();
        await flush();
        assert.equal(cards.state.value.cards[0].state, 'ready');
        const branch = cards.state.value.cards;
        s.wallet.changeCoins(7);
        assert.equal(cards.state.value.coins, 7);
        assert.equal(compact.state.value.coins, 7);
        assert.equal(cards.state.value.cards, branch, 'unrelated wallet changes preserve card branch identity');
        s.wallet.claimReward('workshop/task/1', 20);
        assert.equal(cards.state.value.cards[0].state, 'claimed');
        assert.equal(compact.state.value.cards[0].state, 'claimed');
        await a.close();
        const ended = cards.state.value;
        s.wallet.changeCoins(3);
        assert.equal(cards.state.value, ended);
        assert.equal(compact.state.value.coins, 30);
        assert.equal(compact.state.value.selectedId, 2);
    } finally {
        await s.scope.close();
    }
});

test('task observer removes both sources on unsubscribe or initial callback failure', async () => {
    const s = await setup();
    try {
        let failedCalls = 0;
        assert.throws(() =>
            s.tasks.subscribe(() => {
                failedCalls++;
                throw Error('Initial render failed');
            }, s.scope),
        );
        s.tasks.train();
        s.wallet.changeCoins(1);
        await flush();
        assert.equal(failedCalls, 1, 'failed registration must not leave either source subscribed');
        let calls = 0;
        const off = s.tasks.subscribe(() => calls++, s.scope);
        assert.equal(calls, 1, 'deliver current state immediately');
        s.tasks.train(); // Event delivery has been queued but has not run yet.
        off();
        off();
        s.wallet.changeCoins(1);
        await flush();
        assert.equal(calls, 1, 'unsubscribe must also suppress queued notifications');
    } finally {
        await s.scope.close();
    }
});

test('cancelled and failed confirmation remain distinct and neither commits rewards', async () => {
    for (const outcome of [
        { status: 'cancelled' } as const,
        { status: 'failed', error: Error('UI fault'), cleanupPending: true } as const,
    ]) {
        const s = await setup();
        const cleanup = deferred();
        const model = new WorkflowPageViewModel(s.tasks, s.scope, {
            confirm: async (_card, owner) => {
                owner.defer(() => cleanup.promise);
                return outcome;
            },
        });
        try {
            await model.start();
            model.train();
            await model.claim(1);
            assert.equal(
                model.state.value.feedback.code,
                outcome.status === 'cancelled' ? 'cancelled' : 'confirmation-failed',
            );
            assert.equal(model.state.value.claiming, true);
            if (outcome.status === 'failed') assert.equal(model.state.value.feedback.cleanupPending, true);
            assert.deepEqual(s.tasks.snapshot(), { progress: 1, coins: 0 });
            assert.equal(s.wallet.hasReward('workshop/task/1'), false);
            cleanup.resolve();
            await flush();
            assert.equal(model.state.value.claiming, false);
            assert.equal(!!model.state.value.feedback.cleanupPending, false);
        } finally {
            cleanup.resolve();
            await s.scope.close();
        }
    }
});

test('a display fault cannot turn a committed reward into a failed business operation', async () => {
    const s = await setup(),
        faults: unknown[] = [];
    const model = new WorkflowPageViewModel(s.tasks, s.scope, {
        confirm: async () => ({ status: 'completed', value: true }),
    });
    try {
        await model.start();
        model.train();
        model.state.subscribe(
            s.scope,
            (state) => {
                if (state.coins) throw Error('skin broken');
            },
            (error) => faults.push(error),
        );
        await model.claim(1);
        assert.equal(model.state.value.feedback.code, 'granted');
        assert.equal(s.wallet.snapshot().coins, 20);
        assert.equal(faults.length, 1);
    } finally {
        await s.scope.close();
    }
});

test('calendar lab merges background periods and releases all injected driver callbacks', async () => {
    const scope = new Scope('lab-time'),
        clock = new LabClock();
    const time = new TimeService(clock, scope, { calendar: { offsetMinutes: 480, resetMinute: 240 } });
    const events: { reason: string; missedCount: number | null }[] = [];
    time.in(scope).onBoundary('day', (event) => {
        events.push(event);
    });
    await flush();
    clock.setBackground(true);
    clock.advance(3 * 86400000);
    await flush();
    assert.equal(events.length, 0);
    clock.setBackground(false);
    await flush();
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'resume');
    assert.equal(events[0].missedCount, 2);
    clock.rewindDay();
    await flush();
    assert.equal(events.length, 1);
    await scope.close();
    assert.deepEqual(clock.inspect(), { timers: 0, listeners: 0 });
});

test('storage lab corruption, failed writes, upgrades and future saves use actual Storage behavior', () => {
    const lab = new StorageLab();
    assert.match(lab.corrupt(), /recovered/);
    assert.equal(lab.storage.read(LabWallet).value?.coins, 10);
    assert.match(lab.failWrite(), /失败后余额仍为 10/);
    assert.equal(lab.storage.get(LabWallet)?.coins, 10);
    assert.match(lab.upgrade(), /migrated/);
    assert.equal(lab.storage.get(LabWallet)?.coins, 30);
    assert.match(lab.future(), /incompatible/);
    assert.equal(JSON.parse(lab.backend.values.get('showcase:wallet')!).version, 99);
});
