/**
 * 用真实的 `SessionStore` 验证会话恢复路径。
 *
 * 前面的 `bridge-session-recovery.test.js` 用的是手搓假 ctx，断言的是
 * "我们以为的错误形态"。这里换成 DSH 真包，确认两个关键事实确实成立：
 *
 *   1. `sessions.prepare()` 撞 ID 时抛的是**裸 Error**（`name === "Error"`），
 *      不是 `SessionAlreadyExistsError` —— 这正是线上丢消息的根因；
 *   2. `sessions.store` 是公开可访问的 Map，删掉孤儿后能重新 prepare。
 *
 * 依赖是 devDependency 里的 peer 包；包不在时跳过，不让 CI 因环境失败。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isSessionExistsError } from "../src/bridge/weixin-bridge.js";

const SID = "weixin-bot-user@im.wechat";

/**
 * 尽力加载真实的 SessionStore。
 *
 * @returns {Promise<object|null>} { store } 或 null（依赖不可用）
 */
const loadRealStore = async () => {
  try {
    const [{ SessionStore }, { Context }] = await Promise.all([
      import("@deepseek-ai/dsh-session"),
      import("@deepseek-ai/cordis"),
    ]);
    return new SessionStore(new Context());
  } catch {
    return null;
  }
};

test("真实 SessionStore：prepare 撞 ID 抛裸 Error", async (t) => {
  const store = await loadRealStore();
  if (!store) return t.skip("dsh-session / cordis 未安装");

  const s1 = store.prepare(SID, { meta: { cwd: "/tmp" } });
  store.enter(s1);

  let caught;
  try {
    store.prepare(SID, { meta: { cwd: "/tmp" } });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, "第二次 prepare 必须抛错");
  // 这两条是根因的直接证据
  assert.equal(caught.name, "Error", "抛的是裸 Error，不是 SessionAlreadyExistsError");
  assert.equal(caught.constructor, Error);
  // 而我们的识别函数必须认得它
  assert.equal(isSessionExistsError(caught, SID), true);
});

test("真实 SessionStore：删掉孤儿后能重新 prepare", async (t) => {
  const store = await loadRealStore();
  if (!store) return t.skip("dsh-session / cordis 未安装");

  const s1 = store.prepare(SID, { meta: { cwd: "/tmp" } });
  const oldDetach = store.enter(s1);
  assert.equal(store.store.has(SID), true);

  // detachOrphanSession 的核心动作
  store.store.delete(SID);
  assert.equal(store.store.has(SID), false);

  const s2 = store.prepare(SID, { meta: { cwd: "/tmp" } });
  const newDetach = store.enter(s2);

  // 旧 detach 闭包晚到时不能误删新条目（entry 身份比对保护）
  oldDetach();
  assert.equal(store.store.has(SID), true, "旧 detach 不能删掉新会话");

  newDetach();
  assert.equal(store.store.has(SID), false);
});
