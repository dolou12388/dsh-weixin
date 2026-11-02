/**
 * 发送时间窗的边界回归。
 *
 * 这些是纯函数，覆盖重点是「跨零点」和「右端开区间」两类容易写错的判断，
 * 以及 `nextWindowStart` 必须返回未来时刻这一不变式。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseClock,
  normalizeClockText,
  formatClock,
  isWithinWindow,
  nextWindowStart,
} from "../src/auto-send/time-window.js";

/**
 * 构造本地时区的某个时刻。
 *
 * @param {number} hour - 小时
 * @param {number} minute - 分钟
 * @returns {number} epoch 毫秒
 */
const at = (hour, minute) => new Date(2026, 10, 2, hour, minute, 0).getTime();

test("parseClock 接受不补零写法，拒绝越界与非法格式", () => {
  assert.equal(parseClock("09:00"), 540);
  assert.equal(parseClock("9:5"), 545);
  assert.equal(parseClock(" 23:59 "), 1439);
  assert.equal(parseClock("24:00"), null);
  assert.equal(parseClock("09:60"), null);
  assert.equal(parseClock("-1:00"), null);
  assert.equal(parseClock("0900"), null);
  assert.equal(parseClock(540), null);
});

test("normalizeClockText 补零，非法值回落", () => {
  assert.equal(normalizeClockText("9:5", "00:00"), "09:05");
  assert.equal(normalizeClockText("bad", "09:00"), "09:00");
  assert.equal(formatClock(545), "09:05");
  assert.equal(formatClock(2000), "23:59");
});

test("同日窗口左闭右开", () => {
  assert.equal(isWithinWindow(at(8, 59), 540, 1380), false);
  assert.equal(isWithinWindow(at(9, 0), 540, 1380), true);
  assert.equal(isWithinWindow(at(22, 59), 540, 1380), true);
  assert.equal(isWithinWindow(at(23, 0), 540, 1380), false);
});

test("跨零点窗口拆成两段判断", () => {
  const start = 22 * 60;
  const end = 2 * 60;
  assert.equal(isWithinWindow(at(21, 59), start, end), false);
  assert.equal(isWithinWindow(at(22, 0), start, end), true);
  assert.equal(isWithinWindow(at(23, 59), start, end), true);
  assert.equal(isWithinWindow(at(0, 0), start, end), true);
  assert.equal(isWithinWindow(at(1, 59), start, end), true);
  assert.equal(isWithinWindow(at(2, 0), start, end), false);
  assert.equal(isWithinWindow(at(12, 0), start, end), false);
});

test("起止相同视为全天", () => {
  assert.equal(isWithinWindow(at(0, 0), 0, 0), true);
  assert.equal(isWithinWindow(at(4, 30), 528, 528), true);
  assert.equal(isWithinWindow(at(23, 59), 1439, 1439), true);
});

test("非有限值不参与判断", () => {
  assert.equal(isWithinWindow(at(3, 0), Number.NaN, 120), true);
});

test("nextWindowStart 始终返回未来时刻", () => {
  // 起点已过 → 顺延到明天
  assert.equal(nextWindowStart(at(3, 0), 22 * 60), at(22, 0));
  assert.equal(nextWindowStart(at(21, 0), 22 * 60), at(22, 0));
  // 恰好在起点上仍算「已到」→ 明天，避免零间隔自旋
  assert.equal(nextWindowStart(at(22, 0), 22 * 60), new Date(2026, 10, 3, 22, 0, 0).getTime());
  // 非法起点退化为 0 点
  assert.equal(nextWindowStart(at(10, 0), Number.NaN), new Date(2026, 10, 3, 0, 0, 0).getTime());
});
