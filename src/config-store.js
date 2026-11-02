/**
 * 配置覆盖层（settings overlay）。
 *
 * 背景：DSH 的插件配置来自 `cordis.patch.yml` / profile 配置，由 Host 解析并在
 * `apply()` 时一次性传入。运行期若要改配置，直接回写 YAML 有两个问题：
 *   1. 文件归 Host 所有，重写会丢失注释、并在下次 reconcile 时被覆盖
 *   2. 即使写成功，不重启进程也不会重新 `apply()`
 *
 * 因此 Web UI 的「点点点」配置走这里：写入插件自有的 overlay 文件，
 * 并在内存中就地更新 `cfg`（`WeixinChannel.cfg` 与 `setRuntimeConfig()` 持同一引用，
 * 改完立刻对这些读取方生效）。
 *
 * 覆盖优先级：overlay（UI 设置） > 插件配置（cordis.patch.yml） > 代码默认值
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStoreDir, ensureDir } from "./util/paths.js";
import { logger } from "./util/logger.js";
import { parseClock } from "./auto-send/time-window.js";

/** overlay 文件版本，便于将来迁移。 */
const OVERLAY_VERSION = 1;

/** 单条消息上限的可选区间。 */
export const TEXT_CHUNK_LIMIT_MIN = 200;
export const TEXT_CHUNK_LIMIT_MAX = 20000;
/** 流式合并阈值的可选区间。 */
export const MIN_CHARS_MIN = 1;
export const MIN_CHARS_MAX = 20000;
/** 空闲合并窗口的可选区间（毫秒）。 */
export const IDLE_MS_MIN = 100;
export const IDLE_MS_MAX = 60000;
/** 相邻消息发送间隔的可选区间（毫秒）。 */
export const SEND_GAP_MS_MIN = 0;
export const SEND_GAP_MS_MAX = 10000;
/** 自动发送节奏的可选区间（分钟）。 */
export const AUTO_SEND_INTERVAL_MIN = 1;
export const AUTO_SEND_INTERVAL_MAX = 1440;
/** 自动发送连续命中上限的可选区间。 */
export const AUTO_SEND_STREAK_MIN = 1;
export const AUTO_SEND_STREAK_MAX = 100;
/** 自动发送强制冷却的可选区间（分钟）。 */
export const AUTO_SEND_COOLDOWN_MIN = 0;
export const AUTO_SEND_COOLDOWN_MAX = 10080;
/** 自动发送单条长度上限的可选区间（字符）。 */
export const AUTO_SEND_CHARS_MIN = 10;
export const AUTO_SEND_CHARS_MAX = 1000;

/**
 * overlay 文件路径：`$DSH_HOME/storages/dsh-weixin/settings.json`。
 *
 * @returns {string} 绝对路径
 */
export function resolveSettingsPath() {
  return resolveStoreDir("settings.json");
}

/**
 * 读取 overlay。
 *
 * 文件缺失、损坏、版本不符时一律返回空对象——overlay 属于增强项，
 * 坏掉不应阻断插件启动。
 *
 * @returns {object} 覆盖配置（可直接喂给 `mergeConfig`）
 */
export function loadSettingsOverlay() {
  const filePath = resolveSettingsPath();
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};
    if (parsed.version !== OVERLAY_VERSION) {
      logger.warn(
        `settings overlay version mismatch (got ${String(parsed.version)}), ignoring`,
      );
      return {};
    }
    const { version, savedAt, settings, ...rest } = parsed;
    // 兼容两种落盘形态：包一层 `settings`（新）或平铺（旧）。
    const body = settings && typeof settings === "object" ? settings : rest;
    return body && typeof body === "object" ? body : {};
  } catch (err) {
    logger.warn(`loadSettingsOverlay failed: ${String(err)}`);
    return {};
  }
}

/**
 * 写入 overlay（原子替换）。
 *
 * @param {object} settings - 嵌套形态的配置片段
 * @returns {void}
 */
export function saveSettingsOverlay(settings) {
  const filePath = resolveSettingsPath();
  ensureDir(path.dirname(filePath));
  const payload = {
    version: OVERLAY_VERSION,
    savedAt: new Date().toISOString(),
    settings: settings && typeof settings === "object" ? settings : {},
  };
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
  logger.info(`settings overlay saved: ${filePath}`);
}

/**
 * 清空 overlay（恢复到插件配置）。
 *
 * @returns {void}
 */
export function clearSettingsOverlay() {
  try {
    fs.unlinkSync(resolveSettingsPath());
    logger.info("settings overlay cleared");
  } catch {
    // 不存在则忽略
  }
}

// ---------------------------------------------------------------------------
// 校验与就地应用
// ---------------------------------------------------------------------------

/**
 * 判断是否为普通对象。
 *
 * @param {unknown} value - 待判断值
 * @returns {boolean} 是否为普通对象
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 解析整数并夹到区间内。
 *
 * @param {unknown} value - 原始值
 * @param {number} min - 下界
 * @param {number} max - 上界
 * @returns {number|null} 合法值；非法返回 null
 */
function toBoundedInt(value, min, max) {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 解析布尔值（兼容 "true"/"false" 字符串）。
 *
 * @param {unknown} value - 原始值
 * @returns {boolean|null} 合法值；非法返回 null
 */
function toBool(value) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * 解析白名单：接受数组或逗号/空白分隔的字符串，去空去重。
 *
 * @param {unknown} value - 原始值
 * @returns {string[]} 归一化列表
 */
function toAllowList(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，\s]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const id = String(item ?? "").trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/**
 * 把 UI 提交的**扁平**字段转成嵌套配置片段（含校验）。
 *
 * 只接受白名单内的键，未知键忽略——路由对外暴露，不做宽松透传。
 *
 * @param {object} patch - 扁平补丁，如 `{ outboundMode: "stream" }`
 * @returns {{ settings: object, errors: string[] }} 嵌套片段与错误列表
 */
export function normalizeSettingsPatch(patch) {
  const src = isPlainObject(patch) ? patch : {};
  const settings = {};
  const errors = [];

  if ("enabled" in src) {
    const v = toBool(src.enabled);
    if (v === null) errors.push("enabled 必须是布尔值");
    else settings.enabled = v;
  }

  if ("outboundMode" in src) {
    const v = String(src.outboundMode ?? "").trim();
    if (v !== "final" && v !== "stream") errors.push("outboundMode 只能是 final 或 stream");
    else settings.outbound = Object.assign(settings.outbound ?? {}, { mode: v });
  }

  if ("minChars" in src) {
    const v = toBoundedInt(src.minChars, MIN_CHARS_MIN, MIN_CHARS_MAX);
    if (v === null) errors.push("minChars 必须是整数");
    else settings.outbound = Object.assign(settings.outbound ?? {}, { minChars: v });
  }

  if ("idleMs" in src) {
    const v = toBoundedInt(src.idleMs, IDLE_MS_MIN, IDLE_MS_MAX);
    if (v === null) errors.push("idleMs 必须是整数");
    else settings.outbound = Object.assign(settings.outbound ?? {}, { idleMs: v });
  }

  if ("textChunkLimit" in src) {
    const v = toBoundedInt(src.textChunkLimit, TEXT_CHUNK_LIMIT_MIN, TEXT_CHUNK_LIMIT_MAX);
    if (v === null) errors.push("textChunkLimit 必须是整数");
    else settings.outbound = Object.assign(settings.outbound ?? {}, { textChunkLimit: v });
  }

  if ("sendGapMs" in src) {
    const v = toBoundedInt(src.sendGapMs, SEND_GAP_MS_MIN, SEND_GAP_MS_MAX);
    if (v === null) errors.push("sendGapMs 必须是整数");
    else settings.outbound = Object.assign(settings.outbound ?? {}, { sendGapMs: v });
  }

  if ("typingIndicator" in src) {
    const v = toBool(src.typingIndicator);
    if (v === null) errors.push("typingIndicator 必须是布尔值");
    else settings.typingIndicator = v;
  }

  if ("replyProgressMessages" in src) {
    const v = toBool(src.replyProgressMessages);
    if (v === null) errors.push("replyProgressMessages 必须是布尔值");
    else settings.replyProgressMessages = v;
  }

  if ("replyThinking" in src) {
    const v = toBool(src.replyThinking);
    if (v === null) errors.push("replyThinking 必须是布尔值");
    else settings.replyThinking = v;
  }

  if ("sessionMode" in src) {
    const v = String(src.sessionMode ?? "").trim();
    if (v !== "single" && v !== "per-message") {
      errors.push("sessionMode 只能是 single 或 per-message");
    } else {
      settings.session = Object.assign(settings.session ?? {}, { mode: v });
    }
  }

  if ("sessionCwd" in src) {
    const v = String(src.sessionCwd ?? "").trim();
    settings.session = Object.assign(settings.session ?? {}, { cwd: v });
  }

  if ("allowFrom" in src) {
    settings.allowFrom = toAllowList(src.allowFrom);
  }

  // 全局设定：直接存原文。上限 64KB，避免有人把整个知识库塞进系统提示。
  if ("globalPrompt" in src) {
    const v = String(src.globalPrompt ?? "");
    if (v.length > 64 * 1024) {
      errors.push("globalPrompt 超过 64KB 上限");
    } else {
      settings.globalPrompt = v;
    }
  }

  if ("mediaInbound" in src) {
    const v = toBool(src.mediaInbound);
    if (v === null) errors.push("mediaInbound 必须是布尔值");
    else settings.media = Object.assign(settings.media ?? {}, { inbound: v });
  }

  if ("mediaOutbound" in src) {
    const v = toBool(src.mediaOutbound);
    if (v === null) errors.push("mediaOutbound 必须是布尔值");
    else settings.media = Object.assign(settings.media ?? {}, { outbound: v });
  }

  // 自动发送：整组字段共用 `settings.autoSend`，逐项 Object.assign 累加，
  // 这样 UI 每次只提交改动的那一个字段也不会把同组其它字段抹掉。
  const auto = (patchFields) => {
    settings.autoSend = Object.assign(settings.autoSend ?? {}, patchFields);
  };

  if ("autoSendEnabled" in src) {
    const v = toBool(src.autoSendEnabled);
    if (v === null) errors.push("autoSendEnabled 必须是布尔值");
    else auto({ enabled: v });
  }

  for (const [field, key, label] of [
    ["autoSendStart", "startTime", "autoSendStart"],
    ["autoSendEnd", "endTime", "autoSendEnd"],
  ]) {
    if (!(field in src)) continue;
    const v = String(src[field] ?? "").trim();
    // 统一补零后再落盘，避免出现 "9:5" 这种下次解析仍合法、但排序比较会错的值。
    const minutes = parseClock(v);
    if (minutes === null) {
      errors.push(`${label} 必须是 HH:MM 格式`);
      continue;
    }
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    auto({ [key]: `${hh}:${mm}` });
  }

  if ("autoSendBaseIntervalMin" in src) {
    const v = toBoundedInt(src.autoSendBaseIntervalMin, AUTO_SEND_INTERVAL_MIN, AUTO_SEND_INTERVAL_MAX);
    if (v === null) errors.push("autoSendBaseIntervalMin 必须是整数");
    else auto({ baseIntervalMin: v });
  }

  if ("autoSendActiveIntervalMin" in src) {
    const v = toBoundedInt(src.autoSendActiveIntervalMin, AUTO_SEND_INTERVAL_MIN, AUTO_SEND_INTERVAL_MAX);
    if (v === null) errors.push("autoSendActiveIntervalMin 必须是整数");
    else auto({ activeIntervalMin: v });
  }

  if ("autoSendHitRate" in src) {
    // 用 0–1 小数而非百分数：配置层存的就是小数，路由层再换算会让
    // 「配置文件写 0.2、接口要传 20」这种隐性差异变成长期踩坑点。
    const n = typeof src.autoSendHitRate === "number"
      ? src.autoSendHitRate
      : Number.parseFloat(String(src.autoSendHitRate ?? ""));
    if (!Number.isFinite(n) || n < 0 || n > 1) errors.push("autoSendHitRate 必须在 0 到 1 之间");
    else auto({ hitRate: n });
  }

  if ("autoSendMaxStreak" in src) {
    const v = toBoundedInt(src.autoSendMaxStreak, AUTO_SEND_STREAK_MIN, AUTO_SEND_STREAK_MAX);
    if (v === null) errors.push("autoSendMaxStreak 必须是整数");
    else auto({ maxStreak: v });
  }

  if ("autoSendCooldownMin" in src) {
    const v = toBoundedInt(src.autoSendCooldownMin, AUTO_SEND_COOLDOWN_MIN, AUTO_SEND_COOLDOWN_MAX);
    if (v === null) errors.push("autoSendCooldownMin 必须是整数");
    else auto({ cooldownMin: v });
  }

  if ("autoSendMaxChars" in src) {
    const v = toBoundedInt(src.autoSendMaxChars, AUTO_SEND_CHARS_MIN, AUTO_SEND_CHARS_MAX);
    if (v === null) errors.push("autoSendMaxChars 必须是整数");
    else auto({ maxChars: v });
  }

  if ("autoSendTargets" in src) {
    auto({ targets: toAllowList(src.autoSendTargets) });
  }

  if ("autoSendInstruction" in src) {
    const v = String(src.autoSendInstruction ?? "");
    if (v.length > 2000) errors.push("autoSendInstruction 超过 2000 字上限");
    else auto({ instruction: v });
  }

  return { settings, errors };
}

/**
 * 把嵌套配置片段就地合并进运行中的 `cfg`。
 *
 * 就地改而非替换对象，因为 `WeixinChannel` 与 `setRuntimeConfig()` 都持有
 * 这个对象的引用——替换会留下指向旧配置的读者。
 *
 * @param {object} cfg - 归一化配置对象
 * @param {object} settings - 嵌套片段
 * @returns {void}
 */
export function applySettingsInPlace(cfg, settings) {
  if (!isPlainObject(cfg) || !isPlainObject(settings)) return;

  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    if (key === "allowFrom") {
      cfg.allowFrom = Array.isArray(value) ? [...value] : [];
      continue;
    }
    const prev = cfg[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      applySettingsInPlace(prev, value);
    } else {
      cfg[key] = value;
    }
  }
}

/**
 * 把 overlay 与插件配置合并后重新归一化。
 *
 * @param {object} pluginConfig - `apply()` 收到的原始配置
 * @param {object} overlay - 从磁盘读到的覆盖
 * @param {(raw: object) => object} normalize - 归一化函数
 * @returns {{ cfg: object, overlaid: boolean }} 结果
 */
export function buildEffectiveConfig(pluginConfig, overlay, normalize) {
  const hasOverlay = isPlainObject(overlay) && Object.keys(overlay).length > 0;
  const merged = hasOverlay
    ? normalize(deepMerge(pluginConfig ?? {}, overlay))
    : normalize(pluginConfig ?? {});
  return { cfg: merged, overlaid: hasOverlay };
}

/**
 * 深合并（overlay 覆盖 base）。
 *
 * @param {object} base - 基础配置
 * @param {object} override - 覆盖配置
 * @returns {object} 新对象
 */
function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = deepMerge(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 判断哪些字段的改动需要重启 DSH 才能完全生效。
 *
 * 目前：`enabled` 决定 `apply()` 是否继续执行，`session.cwd` 影响 Agent 建会话，
 * 两者都只在启动路径上读取。
 *
 * @param {object} settings - 本次提交的嵌套片段
 * @returns {string[]} 需要重启才生效的字段名
 */
export function restartRequiredFor(settings) {
  const out = [];
  if (settings && "enabled" in settings) out.push("enabled");
  if (settings?.session && "cwd" in settings.session) out.push("sessionCwd");
  return out;
}
