/**
 * 微信 iLink Bot 协议层（移植自上游 `api/api.js`）。
 *
 * 端点与 header 约定来自上游逆向结果，必须逐字保持一致：
 *   - `iLink-App-Id` / `iLink-App-ClientVersion`
 *   - `AuthorizationType: ilink_bot_token`
 *   - `X-WECHAT-UIN`
 *   - `ilink_appid: "bot"`
 *
 * 与上游差异：`buildBaseInfo` 的版本号改从本包 package.json 读取。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigBotAgent, loadConfigRouteTag } from "../auth/accounts.js";
import { logger } from "../util/logger.js";
import { redactBody, redactUrl } from "../util/redact.js";

/**
 * 判断一个已解析的 package.json 是否属于本包。
 *
 * @param {object} parsed - 解析后的 package.json
 * @returns {boolean} 是否本包
 */
function isOwnPackageJson(parsed) {
  if (parsed.ilink_appid !== undefined) return true;
  return typeof parsed.name === "string" && parsed.name === "dsh-weixin";
}

/**
 * 从起始目录向上查找本包 package.json。
 *
 * @param {string} startDir - 起始目录
 * @returns {object} 解析结果；未找到返回 {}
 */
export function readPackageJsonFromDir(startDir) {
  try {
    let dir = startDir;
    const { root } = path.parse(dir);
    while (dir && dir !== root) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8"));
          if (isOwnPackageJson(parsed)) return parsed;
        } catch {
          // 解析失败继续向上
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    // 回退默认值
  }
  return {};
}

/**
 * 读取本包 package.json。
 * @returns {object} 解析结果
 */
function readPackageJson() {
  return readPackageJsonFromDir(path.dirname(fileURLToPath(import.meta.url)));
}

const pkg = readPackageJson();
const CHANNEL_VERSION = pkg.version ?? "unknown";

/**
 * iLink-App-Id：与上游保持一致，固定为 `bot`。
 *
 * 上游从 package.json 顶层 `ilink_appid` 字段读取，此处保留同样的回退逻辑：
 * 若本包 package.json 未声明，则回退到 `"bot"`（上游 npm 包的取值）。
 */
const ILINK_APP_ID = pkg.ilink_appid ?? "bot";

/**
 * 构造 iLink-App-ClientVersion：uint32，编码为 0x00MMNNPP。
 *
 * @param {string} version - 形如 "1.0.11" 的版本号
 * @returns {number} 编码后的版本整数
 */
function buildClientVersion(version) {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_APP_CLIENT_VERSION = buildClientVersion(pkg.version ?? "0.0.0");

/** 上游未声明 bot_agent 时使用的默认值。 */
const DEFAULT_BOT_AGENT = "DSH Weixin";
/** 脱敏后 bot_agent 的最大字节长度。 */
const BOT_AGENT_MAX_LEN = 256;

/**
 * 把用户配置的 botAgent 清洗为 wire 安全字符串。
 *
 * 语法（UA 风格）：product *( SP product )，product = name "/" version [ SP "(" comment ")" ]
 *
 * @param {string} raw - 原始配置值
 * @returns {string} 清洗后的 bot_agent
 */
export function sanitizeBotAgent(raw) {
  if (!raw || typeof raw !== "string") return DEFAULT_BOT_AGENT;

  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_BOT_AGENT;

  const productRe = /^[A-Za-z0-9_.\-]{1,32}\/[A-Za-z0-9_.+\-]{1,32}$/;
  const commentCharRe = /^[\x20-\x27\x2A-\x7E]{1,64}$/;

  const rawTokens = trimmed.split(/\s+/);
  const tokens = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const tok = rawTokens[i];
    if (tok.startsWith("(") && !tok.endsWith(")")) {
      let acc = tok;
      while (i + 1 < rawTokens.length && !acc.endsWith(")")) {
        i += 1;
        acc += " " + rawTokens[i];
      }
      tokens.push(acc);
    } else {
      tokens.push(tok);
    }
  }

  const accepted = [];
  let pendingProduct = null;
  for (const tok of tokens) {
    if (tok.startsWith("(") && tok.endsWith(")")) {
      const inner = tok.slice(1, -1);
      if (pendingProduct && commentCharRe.test(inner)) {
        accepted.push(`${pendingProduct} (${inner})`);
        pendingProduct = null;
      } else if (pendingProduct) {
        accepted.push(pendingProduct);
        pendingProduct = null;
      }
      continue;
    }
    if (pendingProduct) {
      accepted.push(pendingProduct);
      pendingProduct = null;
    }
    if (productRe.test(tok)) pendingProduct = tok;
  }
  if (pendingProduct) accepted.push(pendingProduct);

  if (accepted.length === 0) return DEFAULT_BOT_AGENT;

  const joined = accepted.join(" ");
  if (Buffer.byteLength(joined, "utf-8") <= BOT_AGENT_MAX_LEN) return joined;

  const truncated = [];
  let len = 0;
  for (const t of accepted) {
    const add = (truncated.length === 0 ? 0 : 1) + Buffer.byteLength(t, "utf-8");
    if (len + add > BOT_AGENT_MAX_LEN) break;
    truncated.push(t);
    len += add;
  }
  return truncated.length > 0 ? truncated.join(" ") : DEFAULT_BOT_AGENT;
}

/**
 * 构造每个请求都携带的 `base_info`。
 * @returns {{channel_version: string, bot_agent: string}} base_info
 */
export function buildBaseInfo() {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: sanitizeBotAgent(loadConfigBotAgent()),
  };
}

/** 长轮询 getUpdates 的默认超时。 */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** 常规 API 请求（sendMessage / getUploadUrl）默认超时。 */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** 轻量 API 请求（getConfig / sendTyping）默认超时。 */
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

/**
 * 确保 URL 以 `/` 结尾，便于 `new URL(endpoint, base)` 拼接。
 *
 * @param {string} url - 原始 URL
 * @returns {string} 补斜杠后的 URL
 */
function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * 生成 X-WECHAT-UIN：随机 uint32 → 十进制字符串 → base64。
 * @returns {string} header 值
 */
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/**
 * 构造 GET/POST 共用的 header。
 * @returns {object} header 对象
 */
function buildCommonHeaders() {
  const headers = {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
  const routeTag = loadConfigRouteTag();
  if (routeTag) headers.SKRouteTag = routeTag;
  return headers;
}

/**
 * 构造带鉴权的 POST header。
 *
 * @param {{token?: string}} opts - 含 token 的选项
 * @returns {object} header 对象
 */
function buildHeaders(opts) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  return headers;
}

/**
 * 归类 fetch 层错误，便于诊断（不覆盖 HTTP 4xx/5xx）。
 *
 * @param {Error} err - 原始错误
 * @returns {{type: string, description: string, code?: string}} 分类结果
 */
export function classifyFetchError(err) {
  if (err instanceof Error && err.name === "AbortError") {
    return { type: "timeout", description: "request timeout" };
  }

  const cause = err?.cause;
  const causeCode = cause?.code ?? "";
  const causeStr = String(cause ?? err ?? "") + " " + String(causeCode);
  const matchedCode = causeCode || (typeof cause === "string" ? cause : "");

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(causeStr)) {
    return {
      type: "dns",
      description: "DNS resolution failed, check DNS configuration",
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }
  if (/ECONNREFUSED/i.test(causeStr)) {
    return {
      type: "tcp",
      description: "TCP connection refused",
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(causeStr)) {
    return {
      type: "tcp",
      description: "TCP connection timeout or unreachable",
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }
  if (/UND_ERR_SOCKET|SSL|TLS|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(causeStr)) {
    return {
      type: "tls",
      description: "TLS handshake error",
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }
  return { type: "unknown", description: "network request failed" };
}

/**
 * GET 请求封装。
 *
 * @param {{baseUrl: string, endpoint: string, label: string, timeoutMs?: number}} params - 请求参数
 * @returns {Promise<string>} 原始响应文本
 */
export async function apiGetFetch(params) {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildCommonHeaders();
  logger.debug(`GET ${redactUrl(url.toString())}`);

  const timeoutMs = params.timeoutMs;
  const controller = timeoutMs != null && timeoutMs > 0 ? new AbortController() : undefined;
  const t =
    controller != null && timeoutMs != null
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: hdrs,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (t !== undefined) clearTimeout(t);

    const rawText = await res.text();
    logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    const classified = classifyFetchError(err);
    logger.error(
      `${params.label}: GET fetch failed url=${redactUrl(url.toString())} ` +
        `timeoutMs=${timeoutMs ?? "none"} type=${classified.type} ` +
        `description=${classified.description}` +
        `${classified.code ? ` code=${classified.code}` : ""} error=${String(err)}`,
    );
    throw err;
  }
}

/**
 * 合并内部超时控制器与外部 abort signal。
 *
 * @param {{internal?: AbortController, external?: AbortSignal}} params - 两个 signal 源
 * @returns {{signal?: AbortSignal, cleanup: () => void}} 合并结果
 */
function combineAbortSignals(params) {
  const { internal, external } = params;
  if (!external) return { signal: internal?.signal, cleanup: () => {} };
  if (!internal) return { signal: external, cleanup: () => {} };

  if (external.aborted) {
    internal.abort();
    return { signal: internal.signal, cleanup: () => {} };
  }

  const onExternalAbort = () => internal.abort();
  external.addEventListener("abort", onExternalAbort, { once: true });
  return {
    signal: internal.signal,
    cleanup: () => external.removeEventListener("abort", onExternalAbort),
  };
}

/**
 * POST JSON 请求封装。
 *
 * @param {object} params - 请求参数
 * @param {string} params.baseUrl - API base
 * @param {string} params.endpoint - 相对端点
 * @param {string} params.body - JSON 字符串
 * @param {string} [params.token] - bot token
 * @param {string} params.label - 日志标签
 * @param {number} [params.timeoutMs] - 超时
 * @param {AbortSignal} [params.abortSignal] - 外部取消信号
 * @returns {Promise<string>} 原始响应文本
 */
export async function apiPostFetch(params) {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token });
  logger.debug(`POST ${redactUrl(url.toString())} body=${redactBody(params.body)}`);

  const controller = params.timeoutMs !== undefined ? new AbortController() : undefined;
  const t =
    controller != null && params.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;

  const { signal, cleanup } = combineAbortSignals({
    internal: controller,
    external: params.abortSignal,
  });

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: params.body,
      ...(signal ? { signal } : {}),
    });
    if (t !== undefined) clearTimeout(t);

    const rawText = await res.text();
    logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    const classified = classifyFetchError(err);
    logger.error(
      `${params.label}: POST fetch failed url=${redactUrl(url.toString())} ` +
        `timeoutMs=${params.timeoutMs ?? "none"} type=${classified.type} ` +
        `description=${classified.description}` +
        `${classified.code ? ` code=${classified.code}` : ""} error=${String(err)}`,
    );
    throw err;
  } finally {
    cleanup();
  }
}

/** 需要保精度处理的 uint64 字段（避免 JSON.parse 丢精度）。 */
const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

/**
 * 在 JSON.parse 之前把 uint64 消息 ID 加引号转为字符串。
 *
 * 只改写真实的 object 属性值，不会误改字符串内部的文本。
 *
 * @param {string} rawText - 原始 JSON 文本
 * @returns {object} 解析结果
 */
export function parseWeixinApiJson(rawText) {
  let output = "";
  let index = 0;

  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++];
      continue;
    }

    const stringStart = index;
    index++;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') break;
    }

    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;

    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? "")) cursor++;
    if (rawText[cursor] !== ":") continue;

    let key;
    try {
      key = JSON.parse(stringToken);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue;

    output += rawText.slice(index, cursor + 1);
    cursor++;
    while (/\s/.test(rawText[cursor] ?? "")) {
      output += rawText[cursor++];
    }

    const numberStart = cursor;
    if (rawText[cursor] === "-") cursor++;
    while (/\d/.test(rawText[cursor] ?? "")) cursor++;

    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === "-")) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      index = numberStart;
    }
  }

  return JSON.parse(output);
}

/**
 * 长轮询拉取新消息。
 *
 * 客户端超时（服务端未在 timeoutMs 内响应）视为正常控制流，返回空响应。
 *
 * @param {object} params - 请求参数
 * @param {string} params.baseUrl - API base
 * @param {string} params.token - bot token
 * @param {string} [params.get_updates_buf] - 同步游标
 * @param {number} [params.timeoutMs] - 长轮询超时
 * @param {AbortSignal} [params.abortSignal] - 外部取消信号
 * @returns {Promise<object>} getUpdates 响应
 */
export async function getUpdates(params) {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;

  try {
    const rawText = await apiPostFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
      abortSignal: params.abortSignal,
    });
    return parseWeixinApiJson(rawText);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (params.abortSignal?.aborted) {
        logger.debug(`getUpdates: aborted by external signal`);
      } else {
        logger.debug(`getUpdates: client-side timeout after ${timeout}ms, returning empty response`);
      }
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

/**
 * 获取预签名的 CDN 上传地址。
 *
 * @param {object} params - 上传参数
 * @returns {Promise<object>} 响应
 */
export async function getUploadUrl(params) {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "getUploadUrl",
  });
  return JSON.parse(rawText);
}

/**
 * 发送单条消息，返回服务端分配的 message ID。
 *
 * @param {object} params - 发送参数
 * @param {string} params.baseUrl - API base
 * @param {string} params.token - bot token
 * @param {object} params.body - 消息体
 * @param {number} [params.timeoutMs] - 超时
 * @returns {Promise<object>} 响应
 */
export async function sendMessage(params) {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });

  const resp = parseWeixinApiJson(rawText);
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
  }
  return resp;
}

/**
 * 拉取 bot 配置（含 typing_ticket）。
 *
 * @param {object} params - 请求参数
 * @returns {Promise<object>} 响应
 */
export async function getConfig(params) {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
  });
  return JSON.parse(rawText);
}

/**
 * 向用户发送"正在输入"状态。
 *
 * 服务端把参数错误也放在 HTTP 200 里（`ret=-2`），必须自己校验，否则
 * 调用方会以为发送成功，"正在输入"静默不出现却查不出原因。
 *
 * @param {object} params - 请求参数
 * @returns {Promise<void>}
 */
export async function sendTyping(params) {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "sendTyping",
  });

  let resp;
  try {
    resp = JSON.parse(rawText);
  } catch {
    return; // 非 JSON 响应不视为失败，避免误伤
  }
  if (typeof resp?.ret === "number" && resp.ret !== 0) {
    throw new Error(`sendTyping ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
  }
}

/**
 * 通知微信服务端本通道即将停止。
 *
 * 使用独立超时（不复用长轮询的 abort signal），确保在 abort 之后仍能发出。
 *
 * @param {object} params - 请求参数
 * @returns {Promise<object>} 响应
 */
export async function notifyStop(params) {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/msg/notifystop",
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "notifyStop",
  });
  return JSON.parse(rawText);
}

/**
 * 通知微信服务端本通道已启动。
 *
 * @param {object} params - 请求参数
 * @returns {Promise<object>} 响应
 */
export async function notifyStart(params) {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/msg/notifystart",
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "notifyStart",
  });
  return JSON.parse(rawText);
}
