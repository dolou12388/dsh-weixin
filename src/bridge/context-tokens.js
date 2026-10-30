/**
 * contextToken 存储。
 *
 * 微信下行消息携带 `context_token`，回复时必须带回，否则服务端无法关联会话。
 * 上游把它持久化在 `accounts/<id>.context-tokens.json`，这里沿用同样结构。
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStoreDir, ensureDir } from "../util/paths.js";
import { normalizeAccountId } from "../auth/accounts.js";
import { logger } from "../util/logger.js";

/**
 * 单个账号的 contextToken 文件路径。
 *
 * @param {string} accountId - 账号 ID
 * @returns {string} 绝对路径
 */
function resolveTokenPath(accountId) {
  return path.join(resolveStoreDir("accounts"), `${accountId}.context-tokens.json`);
}

/**
 * 读取某账号的全部 contextToken 映射。
 *
 * @param {string} accountId - 账号 ID
 * @returns {Record<string, string>} 接收方 ID → contextToken
 */
export function loadContextTokens(accountId) {
  const id = normalizeAccountId(accountId);
  try {
    const filePath = resolveTokenPath(id);
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.trim()) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 写入某账号的 contextToken 映射。
 *
 * @param {string} accountId - 账号 ID
 * @param {Record<string, string>} tokens - 映射
 * @returns {void}
 */
export function saveContextTokens(accountId, tokens) {
  const id = normalizeAccountId(accountId);
  try {
    ensureDir(resolveStoreDir("accounts"));
    fs.writeFileSync(
      resolveTokenPath(id),
      JSON.stringify(tokens, null, 2),
      "utf-8",
    );
  } catch (err) {
    logger.warn(`saveContextTokens failed for ${id}: ${String(err)}`);
  }
}

/**
 * 记录一次 contextToken（收到入站消息时调用）。
 *
 * @param {string} accountId - 账号 ID
 * @param {string} fromId - 发送方微信 ID
 * @param {string} contextToken - 服务端下发的 token
 * @returns {void}
 */
export function setContextToken(accountId, fromId, contextToken) {
  if (!fromId || !contextToken) return;
  const tokens = loadContextTokens(accountId);
  if (tokens[fromId] === contextToken) return;
  tokens[fromId] = contextToken;
  saveContextTokens(accountId, tokens);
}

/**
 * 取指定接收方的 contextToken。
 *
 * @param {string} accountId - 账号 ID
 * @param {string} toId - 接收方微信 ID
 * @returns {string|undefined} contextToken
 */
export function getContextToken(accountId, toId) {
  const tokens = loadContextTokens(accountId);
  return tokens[toId];
}

/**
 * 查找拥有指定接收方 contextToken 的账号。
 *
 * 多账号场景下用于判定该由哪个 bot 回复。
 *
 * @param {string[]} accountIds - 候选账号
 * @param {string} toId - 接收方微信 ID
 * @returns {string[]} 命中的账号 ID
 */
export function findAccountIdsByContextToken(accountIds, toId) {
  return accountIds.filter((id) => Boolean(getContextToken(id, toId)));
}

/**
 * 清空某账号的全部 contextToken。
 *
 * @param {string} accountId - 账号 ID
 * @returns {void}
 */
export function clearContextTokensForAccount(accountId) {
  const id = normalizeAccountId(accountId);
  try {
    fs.unlinkSync(resolveTokenPath(id));
  } catch {
    // 不存在则忽略
  }
}
