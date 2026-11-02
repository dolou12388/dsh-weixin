/**
 * 会话恢复路径的回归。
 *
 * 线上故障：「微信发消息不回、会话里也查不到，轮询开着、账号也登录着」。
 * 日志只有一行 `onMessage failed: session "..." already exists`。
 *
 * 根因是 `createOrResume` 只认 `err.name === "SessionAlreadyExistsError"`，
 * 而 DSH 的 `sessions.prepare()` 抛的是**裸 Error**——`name` 就是 `"Error"`。
 * 于是重启后（磁盘有日志、内存无会话）每条入站消息都在进 Agent 之前被丢弃。
 *
 * 这里锁住三件事：
 *   1. 裸 Error 形态的"已存在"必须被识别；
 *   2. 别的会话（ID 不匹配）的同名错误不能被误判吞掉；
 *   3. 走到 resume 前必须清掉只剩 session 的孤儿，否则 resume 同样撞 ID。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { WeixinBridge, isSessionExistsError } from "../src/bridge/weixin-bridge.js";

const SID = "weixin-bot-user@im.wechat";

/**
 * 造一个只带 `createOrResume` 所需字段的假 bridge。
 *
 * @param {object} ctx - 假的 cordis 上下文
 * @returns {object} 假实例
 */
const fakeBridge = (ctx) => Object.assign(Object.create(WeixinBridge.prototype), { ctx });

/**
 * 造一个最小可用的假 ctx。
 *
 * @param {object} opts - 行为覆盖
 * @param {object} [opts.liveAgent] - `agents.get()` 要返回的存活 Agent
 * @param {boolean} [opts.createFails] - `agents.create()` 是否抛"已存在"
 * @param {boolean} [opts.resumeFails] - `agents.resume()` 是否抛"已存在"
 * @param {boolean} [opts.hasOrphan] - `sessions.store` 里是否有同名孤儿
 * @returns {object} 假 ctx
 */
const makeCtx = ({ liveAgent, createFails = false, resumeFails = false, hasOrphan = false } = {}) => {
  const store = new Map(hasOrphan ? [[SID, { id: SID }]] : []);
  const calls = { create: 0, resume: 0, dispose: 0 };
  const sessions = { store };

  const agents = {
    get: () => liveAgent,
    create: async () => {
      calls.create += 1;
      if (createFails) {
        // 复刻 `sessions.prepare()` 的真实抛法：裸 Error，没有 name 字段。
        throw new Error(`session "${SID}" already exists`);
      }
      return { agent: { id: SID }, dispose: async () => { calls.dispose += 1; } };
    },
    resume: async () => {
      calls.resume += 1;
      // 孤儿没被清掉时，resume 内部同样走 prepare，一样撞 ID。
      if (resumeFails || store.has(SID)) {
        throw new Error(`session "${SID}" already exists`);
      }
      return { agent: { id: SID }, dispose: async () => { calls.dispose += 1; } };
    },
  };

  return {
    agents,
    // `ctx.get()` 是 cordis 里读取未注入服务的唯一安全方式；
    // 直接 `ctx.sessions` 会抛 "cannot get property without inject"。
    get: (name) => (name === "sessions" ? sessions : undefined),
    calls,
  };
};

test("裸 Error 形态的 already exists 被识别", () => {
  const err = new Error(`session "${SID}" already exists`);
  assert.equal(err.name, "Error");
  assert.equal(isSessionExistsError(err, SID), true);
});

test("带 name 的 SessionAlreadyExistsError 被识别", () => {
  const err = Object.assign(new Error(`session "${SID}" already exists`), {
    name: "SessionAlreadyExistsError",
    sessionId: SID,
  });
  assert.equal(isSessionExistsError(err, SID), true);
});

test("别的会话 ID 的同名错误不被吞掉", () => {
  const err = new Error('session "other-session" already exists');
  assert.equal(isSessionExistsError(err, SID), false);
});

test("无关错误不被吞掉", () => {
  assert.equal(isSessionExistsError(new Error("boom"), SID), false);
  assert.equal(isSessionExistsError(undefined, SID), false);
  assert.equal(isSessionExistsError("session already exists", SID), false);
});

test("create 撞裸 Error 后会走 resume 而不是抛给上层", async () => {
  // 这正是线上场景：磁盘有日志、内存无会话，create 必然抛裸 Error。
  const ctx = makeCtx({ createFails: true, hasOrphan: true });
  const bridge = fakeBridge(ctx);

  const handle = await bridge.createOrResume({
    sessionId: SID,
    cwd: "/tmp",
    agentOptions: { provider: "p", model: "m" },
    setup: async () => {},
  });

  assert.equal(ctx.calls.create, 1);
  assert.equal(ctx.calls.resume, 1);
  assert.equal(handle.agent.id, SID);
  // 孤儿必须已被摘掉，否则 resume 不可能成功
  assert.equal(ctx.get("sessions").store.has(SID), false);
});

test("内存里已有存活 Agent 时直接复用，不碰 create/resume", async () => {
  const liveAgent = { id: SID };
  const ctx = makeCtx({ liveAgent, createFails: true });
  const bridge = fakeBridge(ctx);

  const handle = await bridge.createOrResume({ sessionId: SID, agentOptions: {}, setup: async () => {} });

  assert.equal(handle.agent, liveAgent);
  assert.equal(handle.reused, true);
  assert.equal(ctx.calls.create, 0);
  assert.equal(ctx.calls.resume, 0);
  // 复用的 Agent 不能被桥接销毁：它可能正被 Web UI 打开着
  await handle.dispose();
  assert.equal(ctx.calls.dispose, 0);
});

test("resume 期间会话被重新塞回 store 时会再清一次并重试", async () => {
  const ctx = makeCtx({ createFails: true, hasOrphan: true });
  let first = true;
  // 第一次 resume 时故意把孤儿塞回去，模拟"清理与 resume 之间别的组件又 prepare 了它"
  ctx.agents.resume = async () => {
    ctx.calls.resume += 1;
    if (first) {
      first = false;
      ctx.get("sessions").store.set(SID, { id: SID });
      throw new Error(`session "${SID}" already exists`);
    }
    if (ctx.get("sessions").store.has(SID)) throw new Error(`session "${SID}" already exists`);
    return { agent: { id: SID }, dispose: async () => {} };
  };

  const bridge = fakeBridge(ctx);
  const handle = await bridge.createOrResume({ sessionId: SID, agentOptions: {}, setup: async () => {} });

  assert.equal(ctx.calls.resume, 2);
  assert.equal(handle.agent.id, SID);
});

test("没有 Agent 的孤儿才摘，有 Agent 时不动", () => {
  const ctx = makeCtx({ hasOrphan: false });
  ctx.get("sessions").store.set(SID, { id: SID });
  const bridge = fakeBridge(ctx);

  // 有 Agent → 不能摘（那是正在用的会话）
  ctx.agents.get = () => ({ id: SID });
  assert.equal(bridge.detachOrphanSession(SID), false);
  assert.equal(ctx.get("sessions").store.has(SID), true);

  // 没 Agent → 摘掉
  ctx.agents.get = () => undefined;
  assert.equal(bridge.detachOrphanSession(SID), true);
  assert.equal(ctx.get("sessions").store.has(SID), false);
});

test("sessions.store 不可用时不崩，只返回 false", () => {
  const bridge = fakeBridge({ agents: { get: () => undefined } });
  assert.equal(bridge.detachOrphanSession(SID), false);
});
