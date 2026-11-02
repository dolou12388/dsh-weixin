/**
 * 通道生命周期回归。
 *
 * 这里锁的是「状态别说谎」：轮询任务全部退出后，通道级 `running` 必须一起复位，
 * 否则 UI 会停在「运行中」、按钮变成「停止」，用户既看不到真实状态也点不到启动。
 * 另一个回归点是 `start()` 的自愈分支——旧版本遗留的脏标志要能被重新启动覆盖。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { WeixinChannel } from "../src/channel/channel.js";
import { normalizeConfig } from "../src/config.js";
import { normalizeSettingsPatch, applySettingsInPlace } from "../src/config-store.js";

/**
 * 造一个只带生命周期字段的假通道。
 *
 * `runAccount` 在缺 token 时会在 `runPollingLoop` 里同步抛错，
 * 正好用来驱动"任务退出"这条路径，不必真的起长轮询。
 *
 * @param {object} [patch] - 覆盖字段
 * @returns {object} 假实例
 */
const fakeChannel = (patch = {}) => Object.assign(Object.create(WeixinChannel.prototype), {
  running: true,
  activePollers: 1,
  pollTasks: [],
  accounts: new Map([["a", { running: true, lastError: null }]]),
  ...patch,
});

test("start：确实有存活轮询时早退，不重复启动", async () => {
  const channel = fakeChannel({ activePollers: 1 });
  channel.listAccounts = () => [];
  await WeixinChannel.prototype.start.call(channel);
  // 早退即不抛错；若走到账号校验就会抛「尚无可用账号」
  assert.equal(channel.running, true);
});

test("start：标志脏了（无存活轮询）时会自愈并按新账号重建", async () => {
  const channel = fakeChannel({ activePollers: 0 });
  channel.listAccounts = () => [];
  await assert.rejects(
    () => WeixinChannel.prototype.start.call(channel),
    /尚无可用账号/,
  );
});

test("runAccount：最后一个轮询退出时复位通道级标志", async () => {
  const channel = fakeChannel();
  await WeixinChannel.prototype.runAccount.call(channel, { accountId: "a" }, { aborted: false });

  assert.equal(channel.activePollers, 0);
  assert.equal(channel.running, false, "通道级 running 必须复位");
  assert.equal(channel.accounts.get("a").running, false);
  assert.ok(channel.accounts.get("a").lastError, "应记录退出原因");
});

test("runAccount：还有其他轮询存活时不动通道级标志", async () => {
  const channel = fakeChannel({ activePollers: 2 });
  channel.accounts.set("b", { running: true, lastError: null });
  await WeixinChannel.prototype.runAccount.call(channel, { accountId: "a" }, { aborted: false });

  assert.equal(channel.activePollers, 1);
  assert.equal(channel.running, true, "单个账号失效不应拖垮整个通道");
});

test("runAccount：主动 stop（signal 已 abort）时不重复复位", async () => {
  const channel = fakeChannel({ running: false, activePollers: 1 });
  await WeixinChannel.prototype.runAccount.call(channel, { accountId: "a" }, { aborted: true });
  assert.equal(channel.running, false);
});

test("配置：channel.autoStart 默认开启，显式 false 才关闭", () => {
  assert.equal(normalizeConfig({}).channel.autoStart, true);
  assert.equal(normalizeConfig({ channel: { autoStart: false } }).channel.autoStart, false);
  assert.equal(normalizeConfig({ channel: { autoStart: true } }).channel.autoStart, true);
});

test("设置补丁：channelAutoStart 落到 channel 组并可原地生效", () => {
  const patch = normalizeSettingsPatch({ channelAutoStart: false });
  assert.deepEqual(patch.errors, []);
  assert.equal(patch.settings.channel.autoStart, false);

  const cfg = normalizeConfig({});
  applySettingsInPlace(cfg, patch.settings);
  assert.equal(cfg.channel.autoStart, false);
});

test("设置补丁：channelAutoStart 非布尔值被拒绝", () => {
  const patch = normalizeSettingsPatch({ channelAutoStart: "maybe" });
  assert.equal(patch.errors.length, 1);
  assert.equal(patch.settings.channel, undefined);
});
