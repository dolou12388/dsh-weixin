/**
 * 发送时间窗计算。
 *
 * 全部是纯函数、不依赖任何运行时对象，便于单独验证「跨零点」这类边界。
 *
 * 时间在内部统一用「当日分钟数」（0–1439）表示，避免反复解析字符串。
 * 之所以不用 `Date` 直接比较：窗口可能是 22:00–02:00，
 * 此时 `start > end`，用区间比较会得到空集，必须拆成两段判断。
 */

/**
 * `HH:MM` 格式。
 *
 * 小时与分钟都允许 1–2 位：UI 的 `<input type="time">` 总是给补零值，
 * 但配置文件是手写的，`9:5` 这种写法不该被判成非法。
 */
const CLOCK_RE = /^(\d{1,2}):(\d{1,2})$/;

/**
 * 把 `HH:MM` 解析成当日分钟数。
 *
 * @param {unknown} text - 待解析文本
 * @returns {number|null} 0–1439；格式非法或越界返回 null
 */
export function parseClock(text) {
  if (typeof text !== "string") return null;
  const matched = CLOCK_RE.exec(text.trim());
  if (!matched) return null;

  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return hour * 60 + minute;
}

/**
 * 把任意输入规范成 `HH:MM`；非法时返回兜底值。
 *
 * 允许 `"9:05"` 这类不补零的写法，输出统一补零，便于 UI 回显。
 *
 * @param {unknown} text - 原始值
 * @param {string} fallback - 非法时的兜底（须已是 `HH:MM`）
 * @returns {string} 规范化文本
 */
export function normalizeClockText(text, fallback) {
  const minutes = parseClock(text);
  if (minutes === null) return fallback;
  return formatClock(minutes);
}

/**
 * 把当日分钟数格式化成 `HH:MM`。
 *
 * @param {number} minutes - 0–1439
 * @returns {string} `HH:MM`
 */
export function formatClock(minutes) {
  const safe = Math.max(0, Math.min(1439, Math.round(minutes)));
  const hh = String(Math.floor(safe / 60)).padStart(2, "0");
  const mm = String(safe % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * 取某个时刻的当日分钟数。
 *
 * @param {number} nowMs - epoch 毫秒
 * @returns {number} 0–1439
 */
function minuteOfDay(nowMs) {
  const d = new Date(nowMs);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 判断某时刻是否落在发送时间窗内。
 *
 * 三种形态：
 *   - `start === end`：视为全天开启（用户填 00:00–00:00 的直觉是"不限"）。
 *   - `start < end`：同日区间，左闭右开。
 *   - `start > end`：**跨零点**，拆成 `[start, 24:00)` 与 `[00:00, end)` 两段。
 *
 * 右端用开区间是有意的：窗口 09:00–23:00 的含义是"到 23:00 为止"，
 * 若用闭区间，23:00:30 仍算在窗口内，与用户直觉不符。
 *
 * @param {number} nowMs - epoch 毫秒
 * @param {number} startMin - 起始分钟数
 * @param {number} endMin - 结束分钟数
 * @returns {boolean} 是否在窗内
 */
export function isWithinWindow(nowMs, startMin, endMin) {
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) return true;
  if (startMin === endMin) return true;

  const current = minuteOfDay(nowMs);
  if (startMin < endMin) return current >= startMin && current < endMin;
  return current >= startMin || current < endMin;
}

/**
 * 计算下一个时间窗起点的时刻。
 *
 * 只在「当前不在窗内」时调用，因此必然返回**未来**的时间点。
 * 若今天尚未到达起点则用今天，否则顺延到明天。
 *
 * @param {number} nowMs - epoch 毫秒
 * @param {number} startMin - 起始分钟数
 * @returns {number} 下一个起点的 epoch 毫秒
 */
export function nextWindowStart(nowMs, startMin) {
  const start = Number.isFinite(startMin) ? startMin : 0;
  const target = new Date(nowMs);
  target.setHours(Math.floor(start / 60), start % 60, 0, 0);

  // 加 1 秒余量：窗口右端是开区间，卡在整分边界上仍可能判为窗外。
  if (target.getTime() <= nowMs) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}
