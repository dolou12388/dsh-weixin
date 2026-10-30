/**
 * 扫码登录（移植自上游 `auth/login-qr.js`）。
 *
 * 完整状态机：wait / scaned / need_verifycode / expired / verify_code_blocked /
 * binded_redirect / scaned_but_redirect / confirmed。
 *
 * 与上游差异：仅替换文案与 getConfig 读取来源，协议行为保持一致。
 */
import { randomUUID } from "node:crypto";
import { apiGetFetch, apiPostFetch } from "../protocol/api.js";
import { listIndexedWeixinAccountIds, loadWeixinAccount } from "./accounts.js";
import { logger } from "../util/logger.js";
import { redactToken } from "../util/redact.js";

/** 进行中的登录会话有效期。 */
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
/** get_qrcode_status 长轮询的客户端超时。 */
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
/** ilink get_bot_qrcode / get_qrcode_status 的默认 bot_type。 */
export const DEFAULT_ILINK_BOT_TYPE = "3";
/** 所有二维码请求固定使用的 API base。 */
const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";

/** sessionKey → 登录会话状态。 */
const activeLogins = new Map();

/**
 * 判断登录会话是否仍在有效期内。
 *
 * @param {object} login - 登录会话
 * @returns {boolean} 是否有效
 */
function isLoginFresh(login) {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

/** 清理已过期的登录会话，避免内存泄漏。 */
function purgeExpiredLogins() {
  for (const [id, login] of activeLogins) {
    if (!isLoginFresh(login)) activeLogins.delete(id);
  }
}

/**
 * 收集本地已登录账号的 token（最新 10 个），随二维码请求上报。
 * @returns {string[]} token 列表
 */
function getLocalBotTokenList() {
  const accountIds = listIndexedWeixinAccountIds();
  const tokens = [];
  for (let i = accountIds.length - 1; i >= 0 && tokens.length < 10; i--) {
    const token = loadWeixinAccount(accountIds[i])?.token?.trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

/**
 * 请求新二维码。
 *
 * @param {string} apiBaseUrl - API base
 * @param {string} botType - bot_type
 * @returns {Promise<object>} 二维码响应
 */
async function fetchQRCode(apiBaseUrl, botType) {
  logger.info(`fetchQRCode: base=${apiBaseUrl} bot_type=${botType}`);

  const rawText = await apiPostFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: JSON.stringify({ local_token_list: getLocalBotTokenList() }),
    label: "fetchQRCode",
  });
  return JSON.parse(rawText);
}

/**
 * 从 stdin 读取一行用户输入（用于验证码）。
 *
 * @param {string} prompt - 提示语
 * @returns {Promise<string>} 去空格后的输入
 */
/**
 * 默认的验证码来源：从 stdin 读取（终端场景）。
 *
 * @param {string} prompt - 提示语
 * @returns {Promise<string>} 用户输入
 */
export function readLineFromStdin(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk) => {
      input += chunk.toString();
      if (input.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(input.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
  });
}

/**
 * 把一次登录会话标记为"等待验证码"，并等待外部提供验证码。
 *
 * Web 场景下由 HTTP 路由调用 {@link submitVerifyCode} 提供，终端场景走 stdin。
 *
 * @param {object} login - 登录会话（原地更新）
 * @param {string} message - 给用户的提示
 * @returns {Promise<string>} 验证码
 */
function awaitVerifyCode(login, message) {
  return new Promise((resolve) => {
    login.verifyCodeResolver = (code) => {
      login.verifyCodeResolver = undefined;
      login.pendingVerifyCodeNotice = undefined;
      resolve(code);
    };
    login.pendingVerifyCodeNotice = message;
    logger.info(`awaitVerifyCode: waiting for external verify code sessionKey=${login.sessionKey}`);
  });
}

/**
 * 轮询二维码扫码状态（长轮询）。
 *
 * @param {string} apiBaseUrl - 当前 API base（可能被 IDC 重定向改写）
 * @param {string} qrcode - 二维码标识
 * @param {string} [verifyCode] - 用户输入的验证码
 * @returns {Promise<object>} 状态响应
 */
async function pollQRStatus(apiBaseUrl, qrcode, verifyCode) {
  try {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) {
      endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    }

    const rawText = await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: "pollQRStatus",
    });
    return JSON.parse(rawText);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.debug(`pollQRStatus: client timeout after ${QR_LONG_POLL_TIMEOUT_MS}ms, returning wait`);
      return { status: "wait" };
    }
    logger.warn(`pollQRStatus: network/gateway error, will retry: ${String(err)}`);
    return { status: "wait" };
  }
}

/**
 * 在终端展示二维码与备用链接。
 *
 * @param {string} qrcodeUrl - 二维码内容（URL）
 * @returns {Promise<void>}
 */
export async function displayQRCode(qrcodeUrl) {
  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(qrcodeUrl, { small: true });
    process.stdout.write(`若二维码未能显示或无法使用，可访问以下链接继续：\n`);
    process.stdout.write(`${qrcodeUrl}\n`);
  } catch {
    process.stdout.write(`若二维码未能正常显示，可访问以下链接继续：\n`);
    process.stdout.write(`${qrcodeUrl}\n`);
  }
}

/**
 * 发起扫码登录，返回二维码。
 *
 * @param {object} opts - 选项
 * @param {string} [opts.accountId] - 账号 ID（作为 sessionKey）
 * @param {string} [opts.apiBaseUrl] - API base
 * @param {string} [opts.botType] - bot_type
 * @param {boolean} [opts.force] - 强制刷新二维码
 * @param {boolean} [opts.verbose] - 详细输出
 * @returns {Promise<{qrcodeUrl?: string, message: string, sessionKey: string}>} 登录会话信息
 */
export async function startWeixinLoginWithQr(opts) {
  const sessionKey = opts.accountId || randomUUID();
  purgeExpiredLogins();

  const existing = activeLogins.get(sessionKey);
  if (!opts.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return {
      qrcodeUrl: existing.qrcodeUrl,
      message: "二维码已显示，请用手机微信扫描。",
      sessionKey,
    };
  }

  try {
    const botType = opts.botType || DEFAULT_ILINK_BOT_TYPE;
    logger.info(`startWeixinLoginWithQr: bot_type=${botType}`);

    const qrResponse = await fetchQRCode(FIXED_BASE_URL, botType);
    logger.info(
      `QR code received: qrcode=${redactToken(qrResponse.qrcode)} ` +
        `imgContentLen=${qrResponse.qrcode_img_content?.length ?? 0}`,
    );

    activeLogins.set(sessionKey, {
      sessionKey,
      id: randomUUID(),
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
    });

    return {
      qrcodeUrl: qrResponse.qrcode_img_content,
      message: "用手机微信扫描以下二维码，以继续连接：",
      sessionKey,
    };
  } catch (err) {
    logger.error(`startWeixinLoginWithQr failed: ${String(err)}`);
    return { message: `发起登录失败: ${String(err)}`, sessionKey };
  }
}

/** 二维码最多刷新次数。 */
const MAX_QR_REFRESH_COUNT = 3;

/**
 * 刷新二维码并重新展示。
 *
 * @param {object} activeLogin - 登录会话（原地更新）
 * @param {string} botType - bot_type
 * @param {number} qrRefreshCount - 当前刷新计数
 * @param {() => void} onScannedReset - 重置"已扫描"提示的回调
 * @returns {Promise<{success: boolean, message?: string}>} 结果
 */
async function refreshQRCode(activeLogin, botType, qrRefreshCount, onScannedReset) {
  process.stdout.write(`\n⏳ 正在刷新二维码...(${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
  logger.info(`refreshQRCode: ${qrRefreshCount}/${MAX_QR_REFRESH_COUNT}`);

  try {
    const qrResponse = await fetchQRCode(FIXED_BASE_URL, botType);
    activeLogin.qrcode = qrResponse.qrcode;
    activeLogin.qrcodeUrl = qrResponse.qrcode_img_content;
    activeLogin.startedAt = Date.now();
    onScannedReset();

    process.stdout.write(`🔄 二维码已更新，请重新扫描。\n\n`);
    await displayQRCode(qrResponse.qrcode_img_content);
    return { success: true };
  } catch (refreshErr) {
    logger.error(`refreshQRCode failed: ${String(refreshErr)}`);
    return { success: false, message: `刷新二维码失败: ${String(refreshErr)}` };
  }
}

/**
 * 读取一次登录会话的实时状态，供 Web 轮询。
 *
 * @param {string} sessionKey - 登录会话 key
 * @returns {object} 状态快照
 */
export function getLoginStatus(sessionKey) {
  const login = activeLogins.get(sessionKey);
  if (!login || !isLoginFresh(login)) {
    return { alive: false, status: "expired", message: "二维码已过期，请重新生成。" };
  }
  return {
    alive: true,
    status: login.status ?? "wait",
    qrcodeUrl: login.qrcodeUrl,
    needsVerifyCode: Boolean(login.verifyCodeResolver),
    message: login.pendingVerifyCodeNotice ?? null,
  };
}

/**
 * 提交手机微信上显示的验证码。
 *
 * @param {string} sessionKey - 登录会话 key
 * @param {string} code - 验证码
 * @returns {boolean} 是否被接受（false 表示当前无等待中的验证）
 */
export function submitVerifyCode(sessionKey, code) {
  const login = activeLogins.get(sessionKey);
  const resolver = login?.verifyCodeResolver;
  if (!resolver) {
    logger.warn(`submitVerifyCode: no pending verify session sessionKey=${sessionKey}`);
    return false;
  }
  const trimmed = String(code ?? "").trim();
  if (!trimmed) return false;
  logger.info(`submitVerifyCode: accepted sessionKey=${sessionKey} length=${trimmed.length}`);
  resolver(trimmed);
  return true;
}

/**
 * 结束一次登录会话（用户取消或页面关闭）。
 *
 * @param {string} sessionKey - 登录会话 key
 * @returns {void}
 */
export function cancelLogin(sessionKey) {
  const login = activeLogins.get(sessionKey);
  if (!login) return;
  login.verifyCodeResolver?.("");
  activeLogins.delete(sessionKey);
  logger.info(`cancelLogin: sessionKey=${sessionKey}`);
}

/**
 * 等待用户扫码并完成登录。
 *
 * @param {object} opts - 选项
 * @param {string} opts.sessionKey - 登录会话 key
 * @param {string} [opts.botType] - bot_type
 * @param {number} [opts.timeoutMs] - 总超时
 * @param {boolean} [opts.verbose] - 详细输出
 * @param {(prompt: string) => Promise<string>} [opts.verifyCodeProvider] - 自定义验证码来源
 * @returns {Promise<object>} 登录结果
 */
export async function waitForWeixinLogin(opts) {
  const activeLogin = activeLogins.get(opts.sessionKey);

  if (!activeLogin) {
    logger.warn(`waitForWeixinLogin: no active session sessionKey=${opts.sessionKey}`);
    return { connected: false, message: "当前没有进行中的登录，请先发起登录。" };
  }
  if (!isLoginFresh(activeLogin)) {
    logger.warn(`waitForWeixinLogin: QR expired sessionKey=${opts.sessionKey}`);
    activeLogins.delete(opts.sessionKey);
    return { connected: false, message: "二维码已过期，请重新生成。" };
  }

  const timeoutMs = Math.max(opts.timeoutMs ?? 480_000, 1000);
  const deadline = Date.now() + timeoutMs;
  let scannedPrinted = false;
  let qrRefreshCount = 1;

  activeLogin.currentApiBaseUrl = FIXED_BASE_URL;
  logger.info("开始轮询扫码状态...");

  while (Date.now() < deadline) {
    try {
      const currentBaseUrl = activeLogin.currentApiBaseUrl ?? FIXED_BASE_URL;
      const statusResponse = await pollQRStatus(
        currentBaseUrl,
        activeLogin.qrcode,
        activeLogin.pendingVerifyCode,
      );

      logger.debug(
        `pollQRStatus: status=${statusResponse.status} ` +
          `hasBotToken=${Boolean(statusResponse.bot_token)} ` +
          `hasBotId=${Boolean(statusResponse.ilink_bot_id)}`,
      );
      activeLogin.status = statusResponse.status;

      switch (statusResponse.status) {
        case "wait":
          if (opts.verbose) process.stdout.write(".");
          break;

        case "scaned":
          if (activeLogin.pendingVerifyCode) {
            logger.info("验证码通过，继续轮询");
            activeLogin.pendingVerifyCode = undefined;
          }
          if (!scannedPrinted) {
            process.stdout.write("\n正在验证\n");
            scannedPrinted = true;
          }
          break;

        case "need_verifycode": {
          const verifyPrompt = activeLogin.pendingVerifyCode
            ? "❌ 你输入的数字不匹配，请重新输入："
            : "输入手机微信显示的数字，以继续连接：";
          // 三种来源：调用方显式提供 > Web 注入（awaitVerifyCode）> 终端 stdin。
          activeLogin.pendingVerifyCode = opts.verifyCodeProvider
            ? await opts.verifyCodeProvider(verifyPrompt)
            : process.stdin.isTTY
              ? await readLineFromStdin(verifyPrompt)
              : await awaitVerifyCode(activeLogin, verifyPrompt);
          continue;
        }

        case "expired": {
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            logger.warn(`waitForWeixinLogin: QR expired ${MAX_QR_REFRESH_COUNT} times, giving up`);
            activeLogins.delete(opts.sessionKey);
            return { connected: false, message: "二维码多次失效，连接流程已停止。请稍后再试。" };
          }
          process.stdout.write(`\n⏳ 二维码已过期，正在刷新...\n`);
          const r = await refreshQRCode(
            activeLogin,
            opts.botType || DEFAULT_ILINK_BOT_TYPE,
            qrRefreshCount,
            () => {
              scannedPrinted = false;
            },
          );
          if (!r.success) {
            activeLogins.delete(opts.sessionKey);
            return { connected: false, message: r.message };
          }
          break;
        }

        case "verify_code_blocked": {
          logger.warn(`waitForWeixinLogin: verify_code_blocked count=${qrRefreshCount}`);
          process.stdout.write("\n⛔ 多次输入错误，请稍后再试。\n");
          activeLogin.pendingVerifyCode = undefined;
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            activeLogins.delete(opts.sessionKey);
            return { connected: false, message: "多次输入错误，连接流程已停止。请稍后再试。" };
          }
          const r = await refreshQRCode(
            activeLogin,
            opts.botType || DEFAULT_ILINK_BOT_TYPE,
            qrRefreshCount,
            () => {
              scannedPrinted = false;
            },
          );
          if (!r.success) {
            activeLogins.delete(opts.sessionKey);
            return { connected: false, message: r.message };
          }
          break;
        }

        case "binded_redirect": {
          logger.info(`waitForWeixinLogin: bot already bound sessionKey=${opts.sessionKey}`);
          process.stdout.write("\n✅ 该微信已连接过本 DSH，无需重复连接。\n");
          activeLogins.delete(opts.sessionKey);
          return {
            connected: false,
            alreadyConnected: true,
            message: "该微信已连接过本 DSH，无需重复连接。",
          };
        }

        case "scaned_but_redirect": {
          const redirectHost = statusResponse.redirect_host;
          if (redirectHost) {
            activeLogin.currentApiBaseUrl = `https://${redirectHost}`;
            logger.info(`waitForWeixinLogin: IDC redirect → ${redirectHost}`);
          } else {
            logger.warn(`waitForWeixinLogin: scaned_but_redirect without redirect_host`);
          }
          break;
        }

        case "confirmed": {
          if (!statusResponse.ilink_bot_id) {
            activeLogins.delete(opts.sessionKey);
            logger.error("Login confirmed but ilink_bot_id missing");
            return { connected: false, message: "登录失败：服务器未返回 ilink_bot_id。" };
          }

          activeLogin.botToken = statusResponse.bot_token;
          activeLogins.delete(opts.sessionKey);
          logger.info(
            `✅ 登录成功 ilink_bot_id=${statusResponse.ilink_bot_id} ` +
              `ilink_user_id=${redactToken(statusResponse.ilink_user_id)}`,
          );
          return {
            connected: true,
            botToken: statusResponse.bot_token,
            accountId: statusResponse.ilink_bot_id,
            baseUrl: statusResponse.baseurl,
            userId: statusResponse.ilink_user_id,
            message: "已将 DSH 连接到微信。",
          };
        }

        default:
          logger.debug(`waitForWeixinLogin: unhandled status=${statusResponse.status}`);
      }
    } catch (err) {
      logger.error(`waitForWeixinLogin: poll error ${String(err)}`);
      activeLogins.delete(opts.sessionKey);
      return { connected: false, message: `登录失败: ${String(err)}` };
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  logger.warn(`waitForWeixinLogin: timeout sessionKey=${opts.sessionKey} timeoutMs=${timeoutMs}`);
  activeLogins.delete(opts.sessionKey);
  return { connected: false, message: "登录超时，请重试。" };
}
