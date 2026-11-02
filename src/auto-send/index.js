/**
 * 自动发送的装配层：解析接收者 + 绑定调度器。
 *
 * 调度器本身不碰 I/O（不知道微信、不知道账号），目标解析与发送都在这里，
 * 这样 scheduler.js 的节奏逻辑可以脱离插件单测。
 */
import { getContextToken } from "../bridge/context-tokens.js";
import { AutoSendScheduler } from "./scheduler.js";
import { logger } from "../util/logger.js";

/**
 * 解析本次自动发送的接收者。
 *
 * 优先级（高 → 低）：
 *   1. `autoSend.targets` 里第一个**确实持有 context_token** 的用户；
 *   2. 最近一次入站消息的发送者；
 *   3. 状态文件里记录的上次发送目标。
 *
 * 三个来源都必须过 `context_token` 这一关：微信要求回复带回该令牌，
 * 没有它的用户发出去只会得到 `ret=-2`，不如提前排除。
 *
 * 不做"随便挑一个有令牌的用户"这种兜底——主动消息发给一个久未互动的人
 * 风险太高，宁可让调度器记一次失败并提示去配置 targets。
 *
 * @param {object} params - 参数
 * @param {object} params.cfg - 归一化配置
 * @param {object} params.channel - 通道实例
 * @param {object|null} [params.state] - 调度器状态（取 `lastTarget`）
 * @returns {{accountId: string, userId: string, via: string}|null} 目标；无可用目标返回 null
 */
export function resolveAutoSendTarget({ cfg, channel, state }) {
  const accounts = channel.listAccounts().filter((acc) => acc.token);
  if (accounts.length === 0) return null;

  /**
   * 判断某用户是否持有可用令牌。
   *
   * @param {string} accountId - 账号 ID
   * @param {string} userId - 微信用户 ID
   * @returns {boolean} 是否有令牌
   */
  const hasToken = (accountId, userId) =>
    Boolean(channel.getContextToken(userId) ?? getContextToken(accountId, userId));

  // 1) 显式配置
  const targets = Array.isArray(cfg.autoSend?.targets) ? cfg.autoSend.targets : [];
  for (const raw of targets) {
    const userId = String(raw ?? "").trim();
    if (!userId) continue;
    for (const account of accounts) {
      if (hasToken(account.accountId, userId)) {
        return { accountId: account.accountId, userId, via: "config" };
      }
    }
  }

  // 2) 最近互动
  const recent = channel.getRecentInbound?.();
  if (recent && hasToken(recent.accountId, recent.userId)) {
    return { accountId: recent.accountId, userId: recent.userId, via: "recent" };
  }

  // 3) 上次发送目标
  const last = state?.lastTarget;
  if (last?.userId && hasToken(last.accountId, last.userId)) {
    return { accountId: last.accountId, userId: last.userId, via: "last" };
  }

  return null;
}

/**
 * 构造发送函数，供调度器调用。
 *
 * @param {object} params - 参数
 * @param {object} params.cfg - 归一化配置
 * @param {object} params.channel - 通道实例
 * @param {() => object|null} params.getState - 取调度器状态
 * @returns {(req: object) => Promise<{ok: boolean, reason?: string, target?: object}>} 发送函数
 */
export function createAutoSender({ cfg, channel, getState }) {
  return async ({ maxChars, instruction, phase }) => {
    if (!channel.running || !channel.bridge) {
      return { ok: false, reason: "channel-not-running" };
    }

    const target = resolveAutoSendTarget({ cfg, channel, state: getState() });
    if (!target) {
      logger.warn(
        "autosend: no eligible target — 请先在设置页填写接收者，或先与 bot 对话一次",
      );
      return { ok: false, reason: "no-target" };
    }

    logger.info(`autosend: dispatching via=${target.via} to=${target.userId}`);
    return channel.bridge.triggerAutoSend({
      accountId: target.accountId,
      fromUserId: target.userId,
      maxChars,
      instruction,
      phase,
    });
  };
}

/**
 * 创建调度器（内部完成 sender 与 scheduler 的相互引用）。
 *
 * `getState` 用闭包读 `scheduler.state`，而 scheduler 又需要 `send`，
 * 直接用 let 变量做延迟绑定，避免构造期循环依赖。
 *
 * @param {object} params - 参数
 * @param {object} params.cfg - 归一化配置
 * @param {object} params.channel - 通道实例
 * @returns {AutoSendScheduler} 调度器
 */
export function createAutoSendScheduler({ cfg, channel }) {
  /** @type {AutoSendScheduler|null} */
  let scheduler = null;

  const send = createAutoSender({
    cfg,
    channel,
    getState: () => scheduler?.state ?? null,
  });

  scheduler = new AutoSendScheduler({
    cfg,
    send,
    // 通道没启动时（未扫码、被停用）不掷骰：没人在线时消耗投掷次数，
    // 统计会漂移，命中也会因发不出去而白白记一次失败。
    canRun: () => channel.running === true,
  });
  return scheduler;
}
