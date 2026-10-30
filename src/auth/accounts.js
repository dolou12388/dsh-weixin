/**
 * 微信账号存储（移植自上游 `auth/accounts.js`）。
 *
 * 与上游差异：
 *   - 存储根目录改为 `$DSH_HOME/storages/dsh-weixin`
 *   - 去掉对 quote-store / pairing 的副作用依赖（由调用方按需处理）
 *   - `routeTag` / `botAgent` 改从插件运行时配置读取，不再读 openclaw.json
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStoreDir, ensureDir } from "../util/paths.js";
import { logger } from "../util/logger.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** 运行时配置快照，由插件 `apply` 注入。 */
let runtimeConfig = {};

/**
 * 注入插件运行时配置（供 routeTag / botAgent 读取）。
 *
 * @param {object} config - 插件配置对象
 * @returns {void}
 */
export function setRuntimeConfig(config) {
  runtimeConfig = config && typeof config === "object" ? config : {};
}

// ---------------------------------------------------------------------------
// 账号 ID 归一化（替代 openclaw/plugin-sdk/account-id）
// ---------------------------------------------------------------------------

/**
 * 把微信原始 ID 归一化为文件系统安全的形式。
 *
 * 例：`b0f5860fdecb@im.bot` → `b0f5860fdecb-im-bot`
 *
 * @param {string} raw - 原始 ID
 * @returns {string} 归一化 ID；非法输入返回空串
 */
export function normalizeAccountId(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // 只保留 [A-Za-z0-9_-]。`@` 与 `.` 都折叠为 `-`，
  // 以对齐上游：`xxx@im.bot` → `xxx-im-bot`（而非 `xxx-im.bot`）。
  return trimmed
    .replace(/[@.]+/g, "-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/**
 * 归一化 ID 反推原始 ID（兼容旧安装遗留的原始文件名）。
 *
 * @param {string} normalizedId - 归一化 ID
 * @returns {string|undefined} 原始 ID
 */
export function deriveRawAccountId(normalizedId) {
  if (normalizedId.endsWith("-im-bot")) {
    return `${normalizedId.slice(0, -7)}@im.bot`;
  }
  if (normalizedId.endsWith("-im-wechat")) {
    return `${normalizedId.slice(0, -10)}@im.wechat`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 账号索引
// ---------------------------------------------------------------------------

/**
 * 账号数据根目录。
 * @returns {string} 绝对路径
 */
function resolveAccountsRoot() {
  return resolveStoreDir("accounts");
}

/**
 * 账号索引文件路径（记录所有已登录账号）。
 * @returns {string} 绝对路径
 */
function resolveAccountIndexPath() {
  return path.join(resolveAccountsRoot(), "index.json");
}

/**
 * 列出已通过扫码登录注册的全部账号 ID。
 * @returns {string[]} 账号 ID 列表
 */
export function listIndexedWeixinAccountIds() {
  const filePath = resolveAccountIndexPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

/**
 * 把账号 ID 写入持久索引（已存在则跳过）。
 *
 * @param {string} accountId - 账号 ID
 * @returns {void}
 */
export function registerWeixinAccountId(accountId) {
  ensureDir(resolveAccountsRoot());
  const existing = listIndexedWeixinAccountIds();
  if (existing.includes(accountId)) return;
  fs.writeFileSync(
    resolveAccountIndexPath(),
    JSON.stringify([...existing, accountId], null, 2),
    "utf-8",
  );
}

/**
 * 从持久索引中移除账号 ID。
 *
 * @param {string} accountId - 账号 ID
 * @returns {void}
 */
export function unregisterWeixinAccountId(accountId) {
  const existing = listIndexedWeixinAccountIds();
  const updated = existing.filter((id) => id !== accountId);
  if (updated.length !== existing.length) {
    fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
  }
}

/**
 * 单账号数据文件路径。
 * @param {string} accountId - 账号 ID
 * @returns {string} 绝对路径
 */
function resolveAccountPath(accountId) {
  return path.join(resolveAccountsRoot(), `${accountId}.json`);
}

/**
 * 读取 JSON 文件，失败返回 null。
 *
 * @param {string} filePath - 文件路径
 * @returns {object|null} 解析结果
 */
function readJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {
    // 读取失败视为不存在
  }
  return null;
}

/**
 * 按 ID 读取账号数据，带原始 ID 兼容回退。
 *
 * @param {string} accountId - 账号 ID
 * @returns {object|null} 账号数据
 */
export function loadWeixinAccount(accountId) {
  const primary = readJsonFile(resolveAccountPath(accountId));
  if (primary) return primary;

  const rawId = deriveRawAccountId(accountId);
  if (rawId) {
    const compat = readJsonFile(resolveAccountPath(rawId));
    if (compat) return compat;
  }
  return null;
}

/**
 * 扫码登录成功后持久化账号数据（合并写入）。
 *
 * @param {string} accountId - 归一化账号 ID
 * @param {{token?: string, baseUrl?: string, userId?: string}} update - 更新字段
 * @returns {void}
 */
export function saveWeixinAccount(accountId, update) {
  const dir = resolveAccountsRoot();
  ensureDir(dir);

  const existing = loadWeixinAccount(accountId) ?? {};
  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId =
    update.userId !== undefined
      ? update.userId.trim() || undefined
      : existing.userId?.trim() || undefined;

  const data = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };

  const filePath = resolveAccountPath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");

  // Windows 上 chmod 语义有限，失败不阻断。
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * 删除账号关联的全部本地文件。
 *
 * @param {string} accountId - 账号 ID
 * @returns {void}
 */
export function clearWeixinAccount(accountId) {
  const dir = resolveAccountsRoot();
  const files = [
    `${accountId}.json`,
    `${accountId}.sync.json`,
    `${accountId}.context-tokens.json`,
    `${accountId}.allow-from.json`,
    `${accountId}.sessions.json`,
  ];
  for (const file of files) {
    try {
      fs.unlinkSync(path.join(dir, file));
    } catch {
      // 不存在则忽略
    }
  }
}

/**
 * 清理与新账号共享同一 userId 的旧账号，避免 contextToken 归属歧义。
 *
 * @param {string} currentAccountId - 当前账号 ID
 * @param {string} userId - 微信用户 ID
 * @param {(accountId: string) => void} [onClearContextTokens] - 清理 contextToken 的回调
 * @returns {void}
 */
export function clearStaleAccountsForUserId(currentAccountId, userId, onClearContextTokens) {
  if (!userId) return;

  for (const id of listIndexedWeixinAccountIds()) {
    if (id === currentAccountId) continue;
    const data = loadWeixinAccount(id);
    if (data?.userId?.trim() === userId) {
      logger.info(
        `clearStaleAccountsForUserId: removing stale account=${id} (same userId=${userId})`,
      );
      onClearContextTokens?.(id);
      clearWeixinAccount(id);
      unregisterWeixinAccountId(id);
    }
  }
}

// ---------------------------------------------------------------------------
// 运行时配置读取（替代 openclaw.json）
// ---------------------------------------------------------------------------

/**
 * 读取配置中的 routeTag（用于灰度路由）。
 *
 * @param {string} [accountId] - 账号 ID
 * @returns {string|undefined} routeTag
 */
export function loadConfigRouteTag(accountId) {
  const section = runtimeConfig?.channel ?? {};
  if (accountId) {
    const tag = section.accounts?.[accountId]?.routeTag;
    if (typeof tag === "number") return String(tag);
    if (typeof tag === "string" && tag.trim()) return tag.trim();
  }
  if (typeof section.routeTag === "number") return String(section.routeTag);
  return typeof section.routeTag === "string" && section.routeTag.trim()
    ? section.routeTag.trim()
    : undefined;
}

/**
 * 读取配置中的 botAgent（写入 base_info.bot_agent）。
 *
 * @returns {string|undefined} 原始配置值（未脱敏）
 */
export function loadConfigBotAgent() {
  const value = runtimeConfig?.channel?.botAgent;
  return typeof value === "string" && value.trim() ? value : undefined;
}

// ---------------------------------------------------------------------------
// 账号解析
// ---------------------------------------------------------------------------

/**
 * 列出配置中登记的账号 ID（DSH 下以持久索引为准）。
 *
 * @returns {string[]} 账号 ID 列表
 */
export function listWeixinAccountIds() {
  return listIndexedWeixinAccountIds();
}

/**
 * 解析指定账号的完整运行参数。
 *
 * @param {string} accountId - 账号 ID（为空时取索引首个账号）
 * @returns {object} 账号运行参数
 */
export function resolveWeixinAccount(accountId) {
  const raw = accountId?.trim();
  if (!raw) {
    const all = listIndexedWeixinAccountIds();
    if (all.length === 0) {
      throw new Error("weixin: no accounts registered — run `dsh weixin login` first");
    }
    accountId = all[0];
  }

  const id = normalizeAccountId(raw);
  const section = runtimeConfig?.channel ?? {};
  const accountCfg = section.accounts?.[id] ?? section ?? {};
  const accountData = loadWeixinAccount(id);

  const token = accountData?.token?.trim() || undefined;
  const stateBaseUrl = accountData?.baseUrl?.trim() || "";

  return {
    accountId: id,
    baseUrl: stateBaseUrl || DEFAULT_BASE_URL,
    cdnBaseUrl: accountCfg.cdnBaseUrl?.trim() || CDN_BASE_URL,
    token,
    enabled: accountCfg.enabled !== false,
    configured: Boolean(token),
    name: accountCfg.name?.trim() || undefined,
  };
}
