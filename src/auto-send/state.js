/**
 * 自动发送的运行状态持久化。
 *
 * 为什么必须落盘：调度器只有**一个** `nextRollAt`，进程重启、插件重载、
 * 机器休眠都会把它丢掉。不持久化的后果是每次重启都从"刚启动"开始重新计时，
 * 表现成"配了 30 分钟，但一天下来一条都没发"（每次都没熬到一个间隔）。
 *
 * 文件：`$DSH_HOME/storages/dsh-weixin/autosend-state.json`
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStoreDir, ensureDir } from "../util/paths.js";
import { logger } from "../util/logger.js";

/** 状态文件版本。 */
const STATE_VERSION = 1;

/**
 * 状态文件绝对路径。
 *
 * @returns {string} 路径
 */
export function resolveAutoSendStatePath() {
  return resolveStoreDir("autosend-state.json");
}

/**
 * 出厂状态。
 *
 * @returns {object} 全新状态对象
 */
export function emptyAutoSendState() {
  return {
    version: STATE_VERSION,
    /** `base` | `active` */
    phase: "base",
    /** 当前连续命中次数 */
    streak: 0,
    /** 下一次掷骰的时刻（epoch ms），0 表示尚未排程 */
    nextRollAt: 0,
    /** 强制冷却的结束时刻（epoch ms），0 表示不在冷却 */
    cooldownUntil: 0,
    /** 上次成功发送的时刻 */
    lastSentAt: 0,
    /** 上次发送的目标 `{ accountId, userId }` */
    lastTarget: null,
    /** 累计统计，供排障与 UI 展示 */
    stats: { rolls: 0, hits: 0, sends: 0, failures: 0 },
  };
}

/**
 * 读取状态。
 *
 * 文件缺失、损坏、版本不符时返回出厂状态——状态属于增强项，
 * 坏掉只应导致"重新排程"，不应阻断插件启动。
 *
 * @returns {object} 状态
 */
export function loadAutoSendState() {
  const filePath = resolveAutoSendStatePath();
  try {
    if (!fs.existsSync(filePath)) return emptyAutoSendState();
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return emptyAutoSendState();
    if (parsed.version !== STATE_VERSION) {
      logger.warn(
        `autosend state version mismatch (got ${String(parsed.version)}), resetting`,
      );
      return emptyAutoSendState();
    }
    return sanitizeAutoSendState(parsed);
  } catch (err) {
    logger.warn(`loadAutoSendState failed: ${String(err)}`);
    return emptyAutoSendState();
  }
}

/**
 * 把任意对象修成合法状态。
 *
 * 磁盘上的内容可能是手改过的、或被旧版本写入的，逐字段兜底比整体丢弃更友好
 * （至少保留 `lastTarget`，重启后还能找到发送对象）。
 *
 * @param {object} raw - 原始对象
 * @returns {object} 合法状态
 */
function sanitizeAutoSendState(raw) {
  const fallback = emptyAutoSendState();
  const toEpoch = (value, dflt) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : dflt;
  };
  const toCount = (value, dflt) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : dflt;
  };

  const target = raw.lastTarget;
  const hasTarget =
    target && typeof target === "object" && typeof target.userId === "string" && target.userId;

  return {
    version: STATE_VERSION,
    phase: raw.phase === "active" ? "active" : "base",
    streak: toCount(raw.streak, fallback.streak),
    nextRollAt: toEpoch(raw.nextRollAt, 0),
    cooldownUntil: toEpoch(raw.cooldownUntil, 0),
    lastSentAt: toEpoch(raw.lastSentAt, 0),
    lastTarget: hasTarget
      ? { accountId: String(target.accountId ?? ""), userId: target.userId }
      : null,
    stats: {
      rolls: toCount(raw.stats?.rolls, 0),
      hits: toCount(raw.stats?.hits, 0),
      sends: toCount(raw.stats?.sends, 0),
      failures: toCount(raw.stats?.failures, 0),
    },
  };
}

/**
 * 写入状态（原子替换）。
 *
 * 失败只记日志不抛错：写状态失败不该让调度器停摆，
 * 下一次唤醒会重新尝试落盘。
 *
 * @param {object} state - 状态
 * @returns {void}
 */
export function saveAutoSendState(state) {
  const filePath = resolveAutoSendStatePath();
  try {
    ensureDir(path.dirname(filePath));
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    logger.warn(`saveAutoSendState failed: ${String(err)}`);
  }
}
