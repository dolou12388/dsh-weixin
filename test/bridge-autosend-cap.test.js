/**
 * 自动发送标记的作用域回归。
 *
 * 标记只按会话存，而同一会话里随时可能收到用户自己的消息。这里锁住的行为是：
 * 只有「标记记录的 runId == 当前轮 runId」时，才把回复当作冒泡处理
 * （压单行 + 截断）。否则必须原样放行，避免改坏用户正在看的回复。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { WeixinBridge } from "../src/bridge/weixin-bridge.js";

/**
 * 造一个只带标记相关字段的假 bridge。
 *
 * `consumeAutoSendCap` 只读 `autoSendMarks` 与 `runIds`，因此不必构造完整实例；
 * 但必须继承原型，否则内部的 `this.autoSendMarkFor` 找不到。
 *
 * @returns {object} 假实例
 */
const fakeBridge = () => Object.assign(Object.create(WeixinBridge.prototype), {
  autoSendMarks: new Map(),
  runIds: new Map(),
});

/**
 * 调用真实方法。
 *
 * @param {object} self - 假实例
 * @param {string} sessionId - 会话 ID
 * @param {string} text - 原始文本
 * @returns {string} 处理结果
 */
const cap = (self, sessionId, text) => WeixinBridge.prototype.consumeAutoSendCap.call(self, sessionId, text);

test("无标记时原样返回", () => {
  const bridge = fakeBridge();
  assert.equal(cap(bridge, "s1", "任意内容"), "任意内容");
});

test("本回合标记：压成单行并截断到上限", () => {
  const bridge = fakeBridge();
  bridge.runIds.set("s1", "run-a");
  bridge.autoSendMarks.set("s1", { runId: "run-a", maxChars: 10, timer: null });

  const out = cap(bridge, "s1", "第一行\n\n第二行内容超长了");
  assert.equal(out.includes("\n"), false);
  assert.ok(out.length <= 10, `长度应不超过 10，实际 ${out.length}`);
  assert.ok(out.endsWith("…"));
});

test("未超长时不截断，只压平换行", () => {
  const bridge = fakeBridge();
  bridge.runIds.set("s1", "run-a");
  bridge.autoSendMarks.set("s1", { runId: "run-a", maxChars: 40, timer: null });

  assert.equal(cap(bridge, "s1", "  两行\n文本  "), "两行 文本");
});

test("长度恰好等于上限时不截断", () => {
  const bridge = fakeBridge();
  bridge.runIds.set("s1", "run-a");
  bridge.autoSendMarks.set("s1", { runId: "run-a", maxChars: 4, timer: null });

  assert.equal(cap(bridge, "s1", "abcd"), "abcd");
});

test("标记被消费后立即移除", () => {
  const bridge = fakeBridge();
  bridge.runIds.set("s1", "run-a");
  bridge.autoSendMarks.set("s1", { runId: "run-a", maxChars: 120, timer: null });

  cap(bridge, "s1", "内容");
  assert.equal(bridge.autoSendMarks.has("s1"), false);
});

test("runId 不匹配时原样放行，且不消费标记", () => {
  const bridge = fakeBridge();
  bridge.runIds.set("s1", "run-user"); // 用户后来发了一轮
  bridge.autoSendMarks.set("s1", { runId: "run-auto", maxChars: 10, timer: null });

  const long = "这是一段很长的用户回复，不应该被自动发送的截断规则改坏";
  assert.equal(cap(bridge, "s1", long), long);
  assert.equal(bridge.autoSendMarks.has("s1"), true);
});

test("autoSendMarkFor 只认本回合标记", () => {
  const bridge = fakeBridge();
  const mark = { runId: "run-auto", maxChars: 10, timer: null };
  bridge.autoSendMarks.set("s1", mark);

  assert.equal(WeixinBridge.prototype.autoSendMarkFor.call(bridge, "s1"), null);
  bridge.runIds.set("s1", "run-auto");
  assert.equal(WeixinBridge.prototype.autoSendMarkFor.call(bridge, "s1"), mark);
  bridge.runIds.set("s1", "run-other");
  assert.equal(WeixinBridge.prototype.autoSendMarkFor.call(bridge, "s1"), null);
});
