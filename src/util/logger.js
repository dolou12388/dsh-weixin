/**
 * 插件日志：JSON Lines 追加写入 `$DSH_HOME/logs/dsh-weixin-YYYY-MM-DD.log`。
 *
 * 移植自上游 `util/logger.js`，仅把落盘位置从 OpenClaw 临时目录改为 DSH home，
 * 并补充 stdout 输出（便于 `dsh web` 前台观察）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDshHome } from "./paths.js";

const SUBSYSTEM = "channels/dsh-weixin";
const RUNTIME = "node";
const RUNTIME_VERSION = process.versions.node;
const HOSTNAME = os.hostname() || "unknown";
const PARENT_NAMES = ["dsh"];

/** tslog 兼容的级别 ID（越大越严重）。 */
const LEVEL_IDS = {
  TRACE: 1,
  DEBUG: 2,
  INFO: 3,
  WARN: 4,
  ERROR: 5,
  FATAL: 6,
};

const DEFAULT_LOG_LEVEL = "INFO";

/**
 * 解析日志目录：`$DSH_HOME/logs`。
 * @returns {string} 绝对路径
 */
function resolveLogDir() {
  return path.join(resolveDshHome(), "logs");
}

/**
 * 读取 `DSH_WEIXIN_LOG_LEVEL` 环境变量决定最低级别。
 * @returns {number} 级别 ID
 */
function resolveMinLevel() {
  const env = process.env.DSH_WEIXIN_LOG_LEVEL?.toUpperCase();
  if (env && env in LEVEL_IDS) return LEVEL_IDS[env];
  return LEVEL_IDS[DEFAULT_LOG_LEVEL];
}

let minLevelId = resolveMinLevel();

/** 是否把日志同时打到 stdout（默认开启，便于前台调试）。 */
let mirrorToConsole = process.env.DSH_WEIXIN_LOG_STDOUT !== "0";

/**
 * 动态调整最低日志级别。
 *
 * @param {string} level - TRACE/DEBUG/INFO/WARN/ERROR/FATAL
 * @returns {void}
 */
export function setLogLevel(level) {
  const upper = String(level).toUpperCase();
  if (!(upper in LEVEL_IDS)) {
    throw new Error(
      `Invalid log level: ${level}. Valid levels: ${Object.keys(LEVEL_IDS).join(", ")}`,
    );
  }
  minLevelId = LEVEL_IDS[upper];
}

/**
 * 开关 stdout 镜像。
 *
 * @param {boolean} enabled - 是否镜像到 stdout
 * @returns {void}
 */
export function setConsoleMirror(enabled) {
  mirrorToConsole = Boolean(enabled);
}

/**
 * 把时间偏移到本地时区，使 `toISOString()` 输出本地时钟数字。
 *
 * @param {Date} now - 当前时间
 * @returns {string} ISO 风格本地时间
 */
function toLocalISO(now) {
  const offsetMs = -now.getTimezoneOffset() * 60_000;
  const sign = offsetMs >= 0 ? "+" : "-";
  const abs = Math.abs(now.getTimezoneOffset());
  const offStr = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return new Date(now.getTime() + offsetMs).toISOString().replace("Z", offStr);
}

/**
 * 生成当日日志文件名。
 * @param {Date} now - 当前时间
 * @returns {string} 日志文件绝对路径
 */
function resolveLogPath(now) {
  const dateKey = toLocalISO(now).slice(0, 10);
  return path.join(resolveLogDir(), `dsh-weixin-${dateKey}.log`);
}

let logDirEnsured = false;

/**
 * 构造带账号上下文的 logger 名称。
 * @param {string} [accountId] - 账号 ID
 * @returns {string} logger 名称
 */
function buildLoggerName(accountId) {
  return accountId ? `${SUBSYSTEM}/${accountId}` : SUBSYSTEM;
}

/**
 * 写入一条日志记录（落盘 + 可选 stdout）。
 *
 * @param {string} level - 级别名
 * @param {string} message - 消息
 * @param {string} [accountId] - 账号 ID
 * @returns {void}
 */
function writeLog(level, message, accountId) {
  const levelId = LEVEL_IDS[level] ?? LEVEL_IDS.INFO;
  if (levelId < minLevelId) return;

  const now = new Date();
  const loggerName = buildLoggerName(accountId);
  const prefixed = accountId ? `[${accountId}] ${message}` : message;

  if (mirrorToConsole) {
    const tag = `[dsh-weixin:${level}]`;
    if (levelId >= LEVEL_IDS.ERROR) console.error(`${tag} ${prefixed}`);
    else console.log(`${tag} ${prefixed}`);
  }

  const entry = JSON.stringify({
    "0": loggerName,
    "1": prefixed,
    _meta: {
      runtime: RUNTIME,
      runtimeVersion: RUNTIME_VERSION,
      hostname: HOSTNAME,
      name: loggerName,
      parentNames: PARENT_NAMES,
      date: now.toISOString(),
      logLevelId: levelId,
      logLevelName: level,
    },
    time: toLocalISO(now),
  });

  try {
    if (!logDirEnsured) {
      fs.mkdirSync(resolveLogDir(), { recursive: true });
      logDirEnsured = true;
    }
    fs.appendFileSync(resolveLogPath(now), `${entry}\n`, "utf-8");
  } catch {
    // 尽力而为：日志失败不得阻塞业务。
  }
}

/**
 * 创建 logger 实例，可绑定账号。
 *
 * @param {string} [accountId] - 账号 ID
 * @returns {object} logger
 */
function createLogger(accountId) {
  return {
    info(message) {
      writeLog("INFO", message, accountId);
    },
    debug(message) {
      writeLog("DEBUG", message, accountId);
    },
    warn(message) {
      writeLog("WARN", message, accountId);
    },
    error(message) {
      writeLog("ERROR", message, accountId);
    },
    withAccount(id) {
      return createLogger(id);
    },
    getLogFilePath() {
      return resolveLogPath(new Date());
    },
    close() {
      // appendFileSync 无持久句柄，无需释放。
    },
  };
}

export const logger = createLogger();
