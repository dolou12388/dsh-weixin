/**
 * 调度器回归。
 *
 * 覆盖两类东西：
 *   1. `planAfterRoll` 的业务规则（纯函数，最容易在改动中悄悄变形）；
 *   2. `AutoSendScheduler` 的排程不变式——重启恢复、失败退基础节奏、
 *      窗外不掷骰、busy 不丢唤醒。这些都靠注入时钟与随机源验证，
 *      不依赖真实定时器，因此可以稳定跑在 CI 里。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AutoSendScheduler, planAfterRoll } from "../src/auto-send/scheduler.js";

/** 一份可直接覆盖的基准配置。 */
const BASE_AUTO = {
  enabled: true,
  startTime: "09:00",
  endTime: "23:00",
  baseIntervalMin: 30,
  activeIntervalMin: 5,
  hitRate: 0.5,
  maxStreak: 3,
  cooldownMin: 120,
  targets: [],
  maxChars: 120,
  instruction: "",
};

/**
 * 构造本地时区时刻。
 *
 * @param {number} hour - 小时
 * @param {number} minute - 分钟
 * @returns {number} epoch 毫秒
 */
const at = (hour, minute) => new Date(2026, 10, 2, hour, minute, 0).getTime();

/**
 * 出厂状态。
 *
 * @param {object} [patch] - 覆盖字段
 * @returns {object} 状态
 */
const emptyState = (patch = {}) => ({
  version: 1,
  phase: "base",
  streak: 0,
  nextRollAt: 0,
  cooldownUntil: 0,
  lastSentAt: 0,
  lastTarget: null,
  stats: { rolls: 0, hits: 0, sends: 0, failures: 0 },
  ...patch,
});

/**
 * 造一个调度器，默认"必中、能跑、不落盘"。
 *
 * @param {object} options - 覆盖项
 * @returns {object} 调度器与外部观察点
 */
function makeScheduler(options = {}) {
  const sent = [];
  const saves = [];
  const clock = { now: options.now ?? at(10, 0) };
  const scheduler = new AutoSendScheduler({
    cfg: { autoSend: { ...BASE_AUTO, ...(options.auto ?? {}) } },
    now: () => clock.now,
    random: options.random ?? (() => 0),
    loadState: () => options.state ?? emptyState(),
    saveState: (state) => saves.push(JSON.parse(JSON.stringify(state))),
    send: options.send ?? (async () => {
      sent.push(clock.now);
      return { ok: true, target: { accountId: "acc", userId: "u1" } };
    }),
    canRun: options.canRun ?? (() => true),
  });
  return { scheduler, clock, sent, saves };
}

test("planAfterRoll：未命中退回基础节奏并清零连续计数", () => {
  const plan = planAfterRoll({ streak: 2, hit: false, auto: BASE_AUTO });
  assert.deepEqual(plan, { send: false, phase: "base", streak: 0, delayMs: 30 * 60_000, reason: "miss" });
});

test("planAfterRoll：命中切活跃节奏并累加连续计数", () => {
  const plan = planAfterRoll({ streak: 1, hit: true, auto: BASE_AUTO });
  assert.equal(plan.send, true);
  assert.equal(plan.phase, "active");
  assert.equal(plan.streak, 2);
  assert.equal(plan.delayMs, 5 * 60_000);
});

test("planAfterRoll：达到连续上限后冷却，冷却为 0 时退回基础节奏", () => {
  const limited = planAfterRoll({ streak: 2, hit: true, auto: BASE_AUTO });
  assert.equal(limited.reason, "streak-limit");
  assert.equal(limited.streak, 0);
  assert.equal(limited.delayMs, 120 * 60_000);

  const noCooldown = planAfterRoll({ streak: 2, hit: true, auto: { ...BASE_AUTO, cooldownMin: 0 } });
  assert.equal(noCooldown.delayMs, 30 * 60_000);
});

test("planAfterRoll：非法配置回落到安全默认值", () => {
  const plan = planAfterRoll({
    streak: 0,
    hit: false,
    auto: { baseIntervalMin: 0, activeIntervalMin: "x", maxStreak: 0, cooldownMin: -5 },
  });
  assert.equal(plan.delayMs, 30 * 60_000);
});

test("未启用时 start 不建定时器", () => {
  const { scheduler } = makeScheduler({ auto: { enabled: false } });
  scheduler.start();
  assert.equal(scheduler.running, false);
  assert.equal(scheduler.timer, null);
});

test("启动后按基础间隔排程，并落盘", () => {
  const { scheduler, clock, saves } = makeScheduler();
  scheduler.start();
  assert.equal(scheduler.running, true);
  assert.equal(scheduler.state.nextRollAt, clock.now + 30 * 60_000);
  assert.ok(saves.length >= 1);
  scheduler.stop();
});

test("命中发一条，随后进入活跃节奏", async () => {
  const { scheduler, clock, sent } = makeScheduler();
  scheduler.start();
  clock.now = scheduler.state.nextRollAt;
  await scheduler.wake();

  assert.equal(sent.length, 1);
  assert.equal(scheduler.state.phase, "active");
  assert.equal(scheduler.state.streak, 1);
  assert.equal(scheduler.state.nextRollAt, clock.now + 5 * 60_000);
  assert.equal(scheduler.state.stats.sends, 1);
  scheduler.stop();
});

test("连续命中达上限后进入冷却，冷却期内不掷骰", async () => {
  const { scheduler, clock, sent } = makeScheduler();
  scheduler.start();
  for (let i = 0; i < 3; i += 1) {
    clock.now = scheduler.state.nextRollAt;
    await scheduler.wake();
  }
  assert.equal(sent.length, 3);
  assert.equal(scheduler.state.streak, 0);
  assert.equal(scheduler.state.phase, "base");
  assert.equal(scheduler.state.cooldownUntil, clock.now + 120 * 60_000);
  assert.equal(scheduler.state.nextRollAt, scheduler.state.cooldownUntil);

  // 冷却期内唤醒：只顺延到冷却结束，不消耗投掷次数
  const rollsBefore = scheduler.state.stats.rolls;
  const cooldownEnd = scheduler.state.cooldownUntil;
  clock.now = cooldownEnd - 60_000;
  await scheduler.wake();
  assert.equal(sent.length, 3);
  assert.equal(scheduler.state.stats.rolls, rollsBefore);
  assert.equal(scheduler.state.nextRollAt, cooldownEnd);

  // 冷却结束的那一刻恢复掷骰（nextRollAt 就是冷却终点）
  clock.now = cooldownEnd;
  await scheduler.wake();
  assert.equal(sent.length, 4);
  scheduler.stop();
});

test("发送失败退回基础节奏，不沿用活跃间隔", async () => {
  const { scheduler, clock } = makeScheduler({ send: async () => ({ ok: false, reason: "no-target" }) });
  scheduler.start();
  clock.now = scheduler.state.nextRollAt;
  await scheduler.wake();

  assert.equal(scheduler.state.stats.failures, 1);
  assert.equal(scheduler.state.phase, "base");
  assert.equal(scheduler.state.streak, 0);
  assert.equal(scheduler.state.nextRollAt, clock.now + 30 * 60_000);
  scheduler.stop();
});

test("窗外不掷骰，睡到下一个窗口起点", async () => {
  const { scheduler, sent } = makeScheduler({
    now: at(3, 0),
    // 跨零点窗口：凌晨 3 点在窗外，下一个起点是当天 22:00
    auto: { startTime: "22:00", endTime: "02:00" },
    state: emptyState({ nextRollAt: at(3, 0) }),
  });
  scheduler.start();
  await scheduler.wake();

  assert.equal(scheduler.state.stats.rolls, 0);
  assert.equal(sent.length, 0);
  assert.equal(scheduler.state.nextRollAt, at(22, 0));
  assert.equal(scheduler.state.phase, "base");
  scheduler.stop();
});

test("通道未运行时不掷骰，一分钟内重试", async () => {
  const { scheduler, clock } = makeScheduler({ canRun: () => false });
  scheduler.start();
  clock.now = scheduler.state.nextRollAt;
  await scheduler.wake();

  assert.equal(scheduler.state.stats.rolls, 0);
  assert.equal(scheduler.state.nextRollAt, clock.now + 60_000);
  scheduler.stop();
});

test("busy 时唤醒会重排，而不是丢掉这次唤醒", async () => {
  let release;
  const { scheduler, clock } = makeScheduler({
    send: () => new Promise((resolve) => {
      release = resolve;
    }),
  });
  scheduler.start();
  clock.now = scheduler.state.nextRollAt;

  const first = scheduler.wake();
  await new Promise((resolve) => setImmediate(resolve));
  const timerBefore = scheduler.timer;

  await scheduler.wake();
  assert.notEqual(scheduler.timer, timerBefore);
  assert.notEqual(scheduler.timer, null);

  release({ ok: true });
  await first;
  scheduler.stop();
});

test("重启恢复：轻微过期立即补一次，过期过久顺延一个基础间隔", () => {
  const overdueSoon = makeScheduler({
    now: at(10, 0),
    state: emptyState({ nextRollAt: at(9, 58) }),
  });
  overdueSoon.scheduler.start();
  assert.equal(overdueSoon.scheduler.state.nextRollAt, at(10, 0));
  overdueSoon.scheduler.stop();

  const overdueLong = makeScheduler({
    now: at(10, 0),
    state: emptyState({ nextRollAt: at(8, 0) }),
  });
  overdueLong.scheduler.start();
  assert.equal(overdueLong.scheduler.state.nextRollAt, at(10, 30));
  overdueLong.scheduler.stop();

  const absurd = makeScheduler({
    now: at(10, 0),
    state: emptyState({ nextRollAt: at(10, 0) + 3 * 24 * 60 * 60_000 }),
  });
  absurd.scheduler.start();
  assert.equal(absurd.scheduler.state.nextRollAt, at(10, 30));
  absurd.scheduler.stop();
});

test("手动触发忽略概率，且成功后重置基础节奏", async () => {
  const { scheduler, clock, sent } = makeScheduler({ random: () => 0.99, auto: { hitRate: 0 } });
  scheduler.start();
  const result = await scheduler.triggerNow();

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(scheduler.state.nextRollAt, clock.now + 30 * 60_000);
  scheduler.stop();
});

test("status 快照反映窗口与冷却", async () => {
  const { scheduler, clock } = makeScheduler();
  scheduler.start();
  const before = scheduler.status();
  assert.equal(before.running, true);
  assert.equal(before.inWindow, true);
  assert.equal(before.phase, "base");
  assert.equal(before.nextRollInMs, 30 * 60_000);

  clock.now = scheduler.state.nextRollAt;
  await scheduler.wake();
  const after = scheduler.status();
  assert.equal(after.phase, "active");
  assert.equal(after.stats.sends, 1);
  assert.ok(after.lastSentAt > 0);
  assert.deepEqual(after.lastTarget, { accountId: "acc", userId: "u1" });
  scheduler.stop();
});
