/**
 * 日志脱敏工具（移植自上游 `util/redact.js`，行为保持一致）。
 *
 * 用于避免 token、context_token 等敏感字段进入日志。
 */

const DEFAULT_BODY_MAX_LEN = 200;
const DEFAULT_TOKEN_PREFIX_LEN = 6;

/**
 * 截断字符串，超长时追加长度标记。
 *
 * @param {string} s - 原始字符串。
 * @param {number} max - 最大保留长度。
 * @returns {string} 截断结果；空输入返回 ""。
 */
export function truncate(s, max) {
  if (!s) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(len=${s.length})`;
}

/**
 * 脱敏 token：仅保留前几位与总长度。
 *
 * @param {string} token - 原始 token。
 * @param {number} [prefixLen] - 保留前缀长度。
 * @returns {string} 脱敏结果；缺失时返回 "(none)"。
 */
export function redactToken(token, prefixLen = DEFAULT_TOKEN_PREFIX_LEN) {
  if (!token) return "(none)";
  if (token.length <= prefixLen) return `****(len=${token.length})`;
  return `${token.slice(0, prefixLen)}…(len=${token.length})`;
}

/**
 * 截断待记录的 JSON body，并先遮蔽已知敏感字段。
 *
 * @param {string} body - 原始 body 字符串。
 * @param {number} [maxLen] - 最大保留长度。
 * @returns {string} 处理后的字符串；空输入返回 "(empty)"。
 */
export function redactBody(body, maxLen = DEFAULT_BODY_MAX_LEN) {
  if (!body) return "(empty)";
  const redacted = body.replace(
    /"(context_token|bot_token|token|authorization|Authorization)"\s*:\s*"[^"]*"/g,
    '"$1":"<redacted>"',
  );
  if (redacted.length <= maxLen) return redacted;
  return `${redacted.slice(0, maxLen)}…(truncated, totalLen=${redacted.length})`;
}

/**
 * 去除 URL 的查询串（常含签名与 token），仅保留 origin + pathname。
 *
 * @param {string} rawUrl - 原始 URL。
 * @returns {string} 脱敏后的 URL。
 */
export function redactUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const base = `${u.origin}${u.pathname}`;
    return u.search ? `${base}?<redacted>` : base;
  } catch {
    return truncate(rawUrl, 80);
  }
}
