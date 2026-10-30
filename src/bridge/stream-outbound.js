/**
 * 流式出站：把 `agent/assistant-stream` 的增量合并成尽量少、尽量长的微信消息。
 *
 * 微信不是流式通道，逐 token 发等于刷屏。所以这里的策略是「攒够再发」：
 *
 *   - 累积到 `minChars` 字符 → 立即发一段
 *   - 距上次发送超过 `idleMs` 且有新增 → 发一段
 *   - 遇到换行/句末标点 → 视为自然边界，可以直接发
 *   - 回合结束（`turn-stopping`）→ 把剩余全部发完
 *
 * 这样既保留"打字感"（长回答会分多段陆续到），又不会把一句话拦腰切断。
 */
import { logger } from "../util/logger.js";

/** 触发发送的自然边界字符。 */
const BREAK_CHARS = new Set(["\n", "。", "！", "？", "；", ".", "!", "?", ";"]);

/**
 * 单个会话的出站缓冲。
 *
 * 每个 sessionId 一个实例，避免并发会话互相污染。
 */
export class StreamBuffer {
  /**
   * @param {object} opts - 参数
   * @param {number} opts.minChars - 触发发送的最小字符数
   * @param {number} opts.idleMs - 空闲多久后强制发送
   * @param {(text: string) => Promise<void>} opts.flush - 实际发送函数
   */
  constructor(opts) {
    this.minChars = Math.max(1, opts.minChars ?? 1600);
    this.idleMs = Math.max(100, opts.idleMs ?? 3000);
    this.flushFn = opts.flush;

    /** @type {string} 尚未发送的文本 */
    this.pending = "";
    /** @type {number} 上次发送时间 */
    this.lastSentAt = 0;
    /** @type {NodeJS.Timeout|null} 空闲定时器 */
    this.idleTimer = null;
    /** @type {boolean} 是否已关闭 */
    this.closed = false;
    /** @type {Promise<void>} 串行化发送，避免段序错乱 */
    this.tail = Promise.resolve();
  }

  /**
   * 追加增量文本。
   *
   * @param {string} delta - 新增内容
   * @returns {void}
   */
  push(delta) {
    if (this.closed || typeof delta !== "string" || delta.length === 0) return;
    this.pending += delta;

    if (this.pending.length >= this.minChars) {
      this.scheduleFlush("minChars");
      return;
    }

    // 自然边界提前发，但要真的攒够量：阈值低时按半数处理会让一段回复
    // 碎成八九个气泡，观感很差。取 3/4 兼顾"别太碎"和"别等太久"。
    const lastChar = this.pending[this.pending.length - 1];
    if (BREAK_CHARS.has(lastChar) && this.pending.length >= Math.ceil(this.minChars * 0.75)) {
      this.scheduleFlush("boundary");
      return;
    }

    // 否则等空闲窗口
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.scheduleFlush("idle"), this.idleMs);
    if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
  }

  /**
   * 触发一次发送（串行排队）。
   *
   * @param {string} reason - 触发原因，仅用于日志
   * @returns {void}
   */
  scheduleFlush(reason) {
    if (this.closed) return;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.pending) return;

    const text = this.pending;
    this.pending = "";
    this.lastSentAt = Date.now();

    this.tail = this.tail
      .then(() => this.flushFn(text))
      .catch((err) => {
        logger.error(`stream: flush failed reason=${reason}: ${String(err)}`);
      });
  }

  /**
   * 结束：把剩余内容发完并关闭。
   *
   * @returns {Promise<void>} 全部发送完成
   */
  async close() {
    this.closed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.pending) {
      const text = this.pending;
      this.pending = "";
      this.tail = this.tail.then(() => this.flushFn(text)).catch((err) => {
        logger.error(`stream: final flush failed: ${String(err)}`);
      });
    }
    await this.tail;
  }
}

/**
 * 从 `StreamChunk` 里取文本增量。
 *
 * 关键：`text-delta` 与 `reasoning-delta` 的**结构完全相同**（都是 `{ type, index, text }`），
 * 唯一的区别就是 `type`。早先这里只判断 `typeof chunk.text === "string"` 就直接返回，
 * 于是思考内容被当成正文走了流式通道直接发出去——`replyThinking` 开关根本拦不住它，
 * 因为那条路径走的是 `extractAssistantText`（另一端）。
 *
 * 认识的形状：
 *   - `{ type: "text-delta", text }`（DSH 原生）
 *   - `{ type: "content_block_delta", delta: { type: "text_delta", text } }`（Anthropic 风格）
 *   - `{ delta: "..." }` 裸字符串（无 type 时的兜底）
 *
 * @param {object} chunk - StreamChunk
 * @param {object} [opts] - 选项
 * @param {boolean} [opts.withThinking] - 是否连思考增量一起返回（`replyThinking` 打开时）
 * @returns {string} 文本增量（不需要的块为空串）
 */
export function extractChunkText(chunk, opts) {
  if (!chunk || typeof chunk !== "object") return "";
  const withThinking = opts?.withThinking === true;

  const type = typeof chunk.type === "string" ? chunk.type : "";

  if (type === "reasoning-delta" || type === "reasoning") {
    return withThinking && typeof chunk.text === "string" ? chunk.text : "";
  }
  // 工具参数永远不发：半个 JSON 碎片发给用户毫无意义
  if (type === "tool-call-delta" || type === "tool-call") return "";

  // Anthropic 风格的嵌套 delta
  const nested = chunk.delta;
  if (nested && typeof nested === "object") {
    const nestedType = typeof nested.type === "string" ? nested.type : "";
    if (nestedType === "input_json_delta") return "";
    if (nestedType === "thinking_delta") {
      return withThinking && typeof nested.thinking === "string" ? nested.thinking : "";
    }
    if (typeof nested.text === "string") return nested.text;
    return "";
  }

  // DSH 原生：只有 type 为 text-delta / text 时才认 text 字段。
  // 没有 type 的裸对象也放行（兼容旧形状）。
  if (typeof chunk.text === "string") {
    if (type && type !== "text-delta" && type !== "text") return "";
    return chunk.text;
  }

  if (typeof nested === "string") return nested;

  return "";
}

/**
 * 管理多个会话的流式缓冲。
 */
export class StreamWriter {
  /**
   * @param {object} opts - 参数
   * @param {number} opts.minChars - 合并阈值
   * @param {number} opts.idleMs - 空闲窗口
   */
  constructor(opts) {
    this.minChars = opts.minChars;
    this.idleMs = opts.idleMs;
    /** @type {Map<string, StreamBuffer>} sessionId → buffer */
    this.buffers = new Map();
  }

  /**
   * 取得（或创建）某会话的缓冲。
   *
   * @param {string} sessionId - 会话 ID
   * @param {(text: string) => Promise<void>} flush - 发送函数
   * @returns {StreamBuffer} 缓冲
   */
  get(sessionId, flush) {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = new StreamBuffer({
        minChars: this.minChars,
        idleMs: this.idleMs,
        flush,
      });
      this.buffers.set(sessionId, buf);
    }
    return buf;
  }

  /**
   * 关闭并移除某会话的缓冲。
   *
   * @param {string} sessionId - 会话 ID
   * @returns {Promise<void>} 完成
   */
  async close(sessionId) {
    const buf = this.buffers.get(sessionId);
    if (!buf) return;
    this.buffers.delete(sessionId);
    await buf.close();
  }

  /**
   * 关闭全部。
   *
   * @returns {Promise<void>} 完成
   */
  async closeAll() {
    const ids = [...this.buffers.keys()];
    await Promise.allSettled(ids.map((id) => this.close(id)));
  }
}
