/**
 * 终端输出格式化工具。
 */

/**
 * 格式化单个账号的状态行。
 *
 * @param {object} acc - 账号快照
 * @returns {string} 单行文本
 */
export function formatAccountLine(acc) {
  const flags = [];
  if (acc.configured) flags.push("已登录");
  else flags.push("未配置");
  if (acc.enabled === false) flags.push("已禁用");
  if (acc.running) flags.push("运行中");
  if (acc.lastError) flags.push(`错误: ${acc.lastError}`);

  const parts = [`${acc.accountId}`, `[${flags.join(", ")}]`];
  if (acc.userId) parts.push(`user=${acc.userId}`);
  if (acc.savedAt) parts.push(`saved=${acc.savedAt}`);
  return parts.join(" ");
}

/**
 * 把长文本按字符数切分为若干段。
 *
 * 优先在换行处切分，避免截断 Markdown 结构。
 *
 * @param {string} text - 原始文本
 * @param {number} limit - 单段最大字符数
 * @returns {string[]} 分段结果
 */
export function splitText(text, limit) {
  if (!text) return [];
  if (!Number.isFinite(limit) || limit <= 0) return [text];
  if (text.length <= limit) return [text];

  const chunks = [];
  let rest = text;

  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}
