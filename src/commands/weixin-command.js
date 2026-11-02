/**
 * `/weixin` 命令：在 DSH UI 内完成登录、状态查看与启停。
 *
 * 语法：
 *   /weixin            显示状态
 *   /weixin status     显示状态
 *   /weixin login      扫码登录
 *   /weixin accounts   列出账号
 *   /weixin start      启动轮询（Phase 1）
 *   /weixin stop       停止轮询
 */
import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  displayQRCode,
  DEFAULT_ILINK_BOT_TYPE,
} from "../auth/login-qr.js";
import {
  normalizeAccountId,
  saveWeixinAccount,
  registerWeixinAccountId,
  clearStaleAccountsForUserId,
  DEFAULT_BASE_URL,
} from "../auth/accounts.js";
import { clearContextTokensForAccount } from "../bridge/context-tokens.js";
import { formatAccountLine } from "../util/format.js";
import { logger } from "../util/logger.js";

/** 登录等待超时。 */
const LOGIN_TIMEOUT_MS = 480_000;

/**
 * 注册 `/weixin` 命令。
 *
 * @param {object} ctx - cordis 上下文
 * @param {object} cfg - 归一化配置
 * @param {object} channel - 通道实例
 * @returns {() => void} 注销函数
 */
export function registerWeixinCommand(ctx, cfg, channel) {
  return ctx.commands.register({
    name: "weixin",
    description: "微信通道：登录、状态、启停",
    input: { hint: "[login|status|accounts|start|stop]" },
    handler: async ({ rawInput }) => {
      const arg = String(rawInput ?? "").trim().split(/\s+/)[0] || "status";

      switch (arg) {
        case "login":
          return await handleLogin(cfg);
        case "accounts":
          return handleAccounts(channel);
        case "start":
          return await handleStart(channel);
        case "stop":
          return await handleStop(channel);
        case "status":
        default:
          return handleStatus(channel, cfg);
      }
    },
  });
}

/**
 * 处理登录。
 *
 * @param {object} cfg - 归一化配置
 * @returns {Promise<{kind: string, text: string}>} 命令结果
 */
async function handleLogin(cfg) {
  logger.info("command /weixin login invoked");

  const startResult = await startWeixinLoginWithQr({
    apiBaseUrl: DEFAULT_BASE_URL,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });

  if (!startResult.qrcodeUrl) {
    return { kind: "error", text: `获取二维码失败：${startResult.message}` };
  }

  // 终端展示；Web UI 下同时把链接回给用户
  await displayQRCode(startResult.qrcodeUrl);

  const waitResult = await waitForWeixinLogin({
    sessionKey: startResult.sessionKey,
    timeoutMs: LOGIN_TIMEOUT_MS,
  });

  if (waitResult.connected && waitResult.botToken && waitResult.accountId) {
    const normalizedId = normalizeAccountId(waitResult.accountId);

    saveWeixinAccount(normalizedId, {
      token: waitResult.botToken,
      baseUrl: waitResult.baseUrl,
      userId: waitResult.userId,
    });
    registerWeixinAccountId(normalizedId);

    if (waitResult.userId) {
      clearStaleAccountsForUserId(normalizedId, waitResult.userId, clearContextTokensForAccount);
    }

    logger.info(`login succeeded accountId=${normalizedId}`);
    return {
      kind: "success",
      text: `已连接微信。账号 ID：${normalizedId}`,
    };
  }

  if (waitResult.alreadyConnected) {
    return { kind: "success", text: "该微信已连接，无需重复登录。" };
  }

  return { kind: "error", text: `登录未完成：${waitResult.message}` };
}

/**
 * 处理状态查询。
 *
 * @param {object} channel - 通道实例
 * @param {object} cfg - 归一化配置
 * @returns {{kind: string, text: string}} 命令结果
 */
function handleStatus(channel, cfg) {
  const snap = channel.snapshot();
  const auto = cfg?.autoSend;
  const autoLine = auto?.enabled
    ? `自动发送：已开启（${auto.startTime}-${auto.endTime}，基础 ${auto.baseIntervalMin} 分钟，命中率 ${Math.round((auto.hitRate ?? 0) * 100)}%）`
    : "自动发送：关闭";
  const lines = [
    `轮询：${snap.running ? "运行中" : "未启动"}`,
    `出站模式：${snap.config.outboundMode}`,
    `会话模式：${snap.config.sessionMode}`,
    `账号数：${snap.accountCount}`,
    autoLine,
  ];

  if (snap.accountCount === 0) {
    lines.push("", "尚未登录。发送 /weixin login 扫码连接。");
  } else {
    lines.push("");
    for (const acc of snap.accounts) lines.push(formatAccountLine(acc));
  }
  return { kind: "success", text: lines.join("\n") };
}

/**
 * 处理账号列表。
 *
 * @param {object} channel - 通道实例
 * @returns {{kind: string, text: string}} 命令结果
 */
function handleAccounts(channel) {
  const snap = channel.snapshot();
  if (snap.accountCount === 0) {
    return { kind: "success", text: "尚未登录任何账号。" };
  }
  return {
    kind: "success",
    text: snap.accounts.map((a) => formatAccountLine(a)).join("\n"),
  };
}

/**
 * 启动轮询。
 *
 * @param {object} channel - 通道实例
 * @returns {Promise<{kind: string, text: string}>} 命令结果
 */
async function handleStart(channel) {
  try {
    await channel.start();
    return { kind: "success", text: "已启动通道。" };
  } catch (err) {
    return { kind: "error", text: `启动失败：${String(err)}` };
  }
}

/**
 * 停止轮询。
 *
 * @param {object} channel - 通道实例
 * @returns {Promise<{kind: string, text: string}>} 命令结果
 */
async function handleStop(channel) {
  await channel.dispose();
  return { kind: "success", text: "已停止通道。" };
}
