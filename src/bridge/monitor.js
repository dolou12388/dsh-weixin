/**
 * 入站长轮询（移植自上游 `monitor` 语义，但驱动方式改为 DSH Agent）。
 *
 * 循环：`getUpdates` → 解析消息 → 交给 `onMessage` → 用返回的 `get_updates_buf` 续拉。
 *
 * 关键行为：
 *   - 游标（`get_updates_buf`）持久化到 `$DSH_HOME/storages/dsh-weixin/accounts/<id>.sync.json`，
 *     重启后从上次位置继续，避免重复消费历史消息
 *   - 长轮询客户端超时属正常控制流（`getUpdates` 内部已返回空响应），不算错误
 *   - 服务端返回 `ret !== 0` 视为会话失效，抛出供上层终止
 *   - 连续失败按指数退避重试，成功一次即重置
 */
import fs from "node:fs";
import path from "node:path";
import { getUpdates } from "../protocol/api.js";
import { resolveStoreDir, ensureDir } from "../util/paths.js";
import { logger } from "../util/logger.js";

/** 长轮询单次超时（与服务端约定的 35s 对齐）。 */
const LONG_POLL_TIMEOUT_MS = 35_000;
/** 失败重试初始延迟。 */
const RETRY_BASE_MS = 2_000;
/** 失败重试最大延迟。 */
const RETRY_MAX_MS = 60_000;
/** 消息类型：用户发给 bot。 */
const MESSAGE_TYPE_USER = 1;
/** 消息项类型：文本。 */
const ITEM_TYPE_TEXT = 1;
/** 媒体项类型：图片 / 语音 / 文件 / 视频。 */
const ITEM_TYPE_IMAGE = 2;
const ITEM_TYPE_VOICE = 3;
const ITEM_TYPE_FILE = 4;
const ITEM_TYPE_VIDEO = 5;

/**
 * 同步游标文件路径。
 *
 * @param {string} accountId - 账号 ID
 * @returns {string} 绝对路径
 */
function resolveSyncPath(accountId) {
  return resolveStoreDir("accounts", `${accountId}.sync.json`);
}

/**
 * 读取持久化的同步游标。
 *
 * @param {string} accountId - 账号 ID
 * @returns {string} 游标（不存在或损坏时为空串）
 */
export function loadSyncBuf(accountId) {
  try {
    const filePath = resolveSyncPath(accountId);
    if (!fs.existsSync(filePath)) return "";
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return typeof parsed?.get_updates_buf === "string" ? parsed.get_updates_buf : "";
  } catch (err) {
    logger.warn(`loadSyncBuf(${accountId}) failed: ${String(err)}`);
    return "";
  }
}

/**
 * 持久化同步游标。
 *
 * 游标只在内存丢了才会重复消费消息，所以写盘失败仅告警，不中断轮询。
 *
 * @param {string} accountId - 账号 ID
 * @param {string} buf - 游标
 * @returns {void}
 */
export function saveSyncBuf(accountId, buf) {
  if (typeof buf !== "string") return;
  try {
    const filePath = resolveSyncPath(accountId);
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(
      filePath,
      JSON.stringify({ get_updates_buf: buf, savedAt: new Date().toISOString() }, null, 2),
      "utf-8",
    );
  } catch (err) {
    logger.warn(`saveSyncBuf(${accountId}) failed: ${String(err)}`);
  }
}

/**
 * 从一条 iLink 消息里抽取纯文本内容。
 *
 * 只处理文本项；图片/语音/文件等暂不支持，返回空串由调用方过滤。
 * 多个文本项按顺序拼接（上游允许一条消息携带多个 item）。
 *
 * @param {object} msg - WeixinMessage
 * @returns {string} 文本（无文本时为空串）
 */
export function extractText(msg) {
  const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
  const parts = [];
  for (const item of items) {
    if (item?.type !== ITEM_TYPE_TEXT) continue;
    const text = item?.text_item?.text;
    if (typeof text === "string" && text.length > 0) parts.push(text);
  }
  return parts.join("").trim();
}

/**
 * 判断是否为需要处理的入站用户消息。
 *
 * 过滤条件：
 *   - 必须是用户发来的（`message_type === USER`），排除自己发出去的 BOT 消息回显
 *   - 必须有 `from_user_id`
 *   - 必须有文本内容
 *
 * @param {object} msg - WeixinMessage
 * @returns {boolean} 是否需要处理
 */
export function isInboundUserMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.message_type !== MESSAGE_TYPE_USER) return false;
  if (typeof msg.from_user_id !== "string" || !msg.from_user_id) return false;
  // 纯媒体消息（图片/语音/文件/视频）没有文本，同样要放行交给桥接器处理，
  // 只按文本判断会把「只发一张图」当成空消息丢掉
  if (extractText(msg).length > 0) return true;
  return hasMediaItem(msg);
}

/**
 * 判断消息里是否含有可处理的媒体项。
 *
 * @param {object} msg - 消息
 * @returns {boolean} 是否含媒体
 */
export function hasMediaItem(msg) {
  const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
  return items.some((item) => {
    const t = item?.type;
    return t === ITEM_TYPE_IMAGE || t === ITEM_TYPE_VOICE
      || t === ITEM_TYPE_FILE || t === ITEM_TYPE_VIDEO;
  });
}

/**
 * 等待指定毫秒，可被 abort 提前唤醒。
 *
 * @param {number} ms - 毫秒
 * @param {AbortSignal} [signal] - 取消信号
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * 启动单账号长轮询。
 *
 * 返回的 Promise 在 abort 后 resolve；异常情况（如 token 失效）以 reject 通知上层。
 *
 * @param {object} params - 参数
 * @param {object} params.account - 账号运行参数（含 accountId / baseUrl / token）
 * @param {AbortSignal} params.signal - 取消信号
 * @param {(event: {accountId: string, msg: object, text: string, contextToken?: string}) => Promise<void>} params.onMessage - 消息处理器
 * @param {(err: Error) => void} [params.onFatal] - 致命错误回调（如 token 失效）
 * @returns {Promise<void>}
 */
export async function runPollingLoop(params) {
  const { account, signal, onMessage, onFatal } = params;
  const accountId = account.accountId;

  if (!account.token) {
    throw new Error(`账号 ${accountId} 缺少 token，请重新扫码登录`);
  }

  let buf = loadSyncBuf(accountId);
  let failures = 0;

  logger.info(`polling: start accountId=${accountId} baseUrl=${account.baseUrl}`);

  while (!signal.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.token,
        get_updates_buf: buf,
        timeoutMs: LONG_POLL_TIMEOUT_MS,
        abortSignal: signal,
      });

      if (signal.aborted) break;

      // 业务错误码：token 失效等，无法自愈
      if (typeof resp?.ret === "number" && resp.ret !== 0) {
        const message = `getUpdates ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`;
        logger.error(`polling: ${message}`);
        throw new Error(message);
      }

      // 成功即重置退避
      failures = 0;

      const nextBuf = resp?.get_updates_buf;
      if (typeof nextBuf === "string" && nextBuf !== buf) {
        buf = nextBuf;
        saveSyncBuf(accountId, buf);
      }

      const msgs = Array.isArray(resp?.msgs) ? resp.msgs : [];
      if (msgs.length > 0) {
        logger.debug(`polling: ${accountId} received ${msgs.length} message(s)`);
        // 排障开关：媒体/字段结构对不上时，把原始消息完整落盘比对
        if (process.env.DSH_WEIXIN_DUMP_MSG === "1") {
          try {
            const dumpPath = resolveStoreDir("debug-inbound.jsonl");
            fs.appendFileSync(dumpPath, `${JSON.stringify(msgs)}\n`, "utf-8");
          } catch (err) {
            logger.warn(`polling: dump failed ${String(err)}`);
          }
        }
      }

      for (const msg of msgs) {
        if (signal.aborted) break;
        if (!isInboundUserMessage(msg)) {
          logger.debug(
            `polling: skip msg type=${msg?.message_type} from=${msg?.from_user_id ?? "(none)"}`,
          );
          continue;
        }
        const text = extractText(msg);
        try {
          await onMessage({
            accountId,
            msg,
            text,
            contextToken: msg.context_token,
          });
        } catch (err) {
          // 单条消息处理失败不应中断整个轮询
          logger.error(`polling: onMessage failed: ${String(err)}`);
          if (err && err.stack) logger.debug(String(err.stack));
        }
      }
    } catch (err) {
      if (signal.aborted) break;

      // token 失效类错误直接上抛，重试没有意义
      const msgText = String(err);
      if (/ret=(?!0)\d+/.test(msgText) || /401|403|unauthorized/i.test(msgText)) {
        logger.error(`polling: fatal error, stopping loop: ${msgText}`);
        onFatal?.(err instanceof Error ? err : new Error(msgText));
        throw err;
      }

      failures += 1;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 5));
      logger.warn(
        `polling: ${accountId} error (attempt ${failures}), retry in ${delay}ms: ${msgText}`,
      );
      await sleep(delay, signal);
    }
  }

  logger.info(`polling: stopped accountId=${accountId}`);
}
