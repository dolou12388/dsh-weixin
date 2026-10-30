/**
 * 面向 Web UI 的 HTTP 路由。
 *
 * 客户端插件（`lib/client.js`）通过 `fetch` 调用这些端点，从而把
 * `/weixin login|status|accounts|start|stop` 这些命令转成可视化操作。
 *
 * 路径固定在 `/api/dsh-weixin/*` 下，由 `ctx.connection.fetch.register()` 注册。
 * 该注册表自带浏览器鉴权与 Host/Origin 校验，无需自行校验请求来源。
 */
import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  getLoginStatus,
  submitVerifyCode,
  cancelLogin,
  DEFAULT_ILINK_BOT_TYPE,
} from "../auth/login-qr.js";
import {
  normalizeAccountId,
  saveWeixinAccount,
  registerWeixinAccountId,
  clearStaleAccountsForUserId,
  clearWeixinAccount,
  unregisterWeixinAccountId,
  DEFAULT_BASE_URL,
} from "../auth/accounts.js";
import { clearContextTokensForAccount } from "../bridge/context-tokens.js";
import {
  normalizeSettingsPatch,
  applySettingsInPlace,
  saveSettingsOverlay,
  clearSettingsOverlay,
  loadSettingsOverlay,
  restartRequiredFor,
} from "../config-store.js";
import { logger } from "../util/logger.js";

/** 路由前缀（完整路径，Connection 要求以 `/api/` 开头）。 */
const ROUTE_PREFIX = "/api/dsh-weixin";
/** 登录等待超时（与终端命令一致）。 */
const LOGIN_TIMEOUT_MS = 480_000;

/**
 * 统一 JSON 响应。
 *
 * @param {object} body - 响应体
 * @param {number} [status] - HTTP 状态码
 * @returns {Response} Fetch Response
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * 读取 JSON 请求体。
 *
 * @param {Request} request - 请求
 * @returns {Promise<object>} 解析结果（失败返回空对象）
 */
async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 把二维码内容渲染成浏览器可直接显示的 data URL。
 *
 * 微信返回的 `qrcodeUrl` 是一个**网页落地页**（`https://liteapp.weixin.qq.com/q/...`），
 * 终端里靠 `qrcode-terminal` 转成 ASCII 才能显示；浏览器 `<img src>` 直接用它
 * 只会得到破图。这里在服务端把它编码成真正的二维码位图。
 *
 * 失败时返回空串，调用方仍可退回展示链接文案，不阻断登录。
 *
 * @param {string} content - 二维码内容（URL）
 * @returns {Promise<string>} `data:image/png;base64,...`，失败为空串
 */
async function renderQrDataUrl(content) {
  if (!content) return "";
  try {
    const mod = await import("qrcode");
    const QR = mod.default ?? mod;
    return await QR.toDataURL(content, {
      margin: 1,
      width: 240,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#FFFFFF" },
    });
  } catch (err) {
    logger.warn(`renderQrDataUrl failed: ${String(err)}`);
    return "";
  }
}

/**
 * 把源配置逐字段写回目标配置（就地修改）。
 *
 * 与 `applySettingsInPlace` 的区别：这里是**全量覆盖**，用于「恢复默认」；
 * 且数组按内容替换，避免残留 UI 改过的元素。
 *
 * @param {object} target - 运行中的 cfg（会被就地修改）
 * @param {object} source - 基准配置
 * @returns {void}
 */
function rollbackInPlace(target, source) {
  for (const [key, value] of Object.entries(source)) {
    const prev = target[key];
    if (
      prev &&
      typeof prev === "object" &&
      !Array.isArray(prev) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      rollbackInPlace(prev, value);
      continue;
    }
    target[key] = Array.isArray(value) ? [...value] : value;
  }
}

/**
 * 深合并 overlay 片段（后者覆盖前者）。
 *
 * overlay 是多层嵌套对象（`outbound.mode` / `session.mode` 等），
 * 单字段提交时不能整体替换，否则会丢掉同级字段。
 *
 * @param {object} base - 已有 overlay
 * @param {object} patch - 本次提交
 * @returns {object} 合并结果
 */
function mergeOverlay(base, patch) {
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    const prev = out[key];
    if (
      prev &&
      typeof prev === "object" &&
      !Array.isArray(prev) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = mergeOverlay(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 注册微信插件的 HTTP 端点。
 *
 * @param {object} ctx - 带 connection 服务的上下文
 * @param {object} channel - 通道实例
 * @param {object} cfg - 当前生效配置（可变引用）
 * @param {object} baseCfg - 不含 overlay 的插件配置快照
 * @param {object} [hooks] - 可选钩子
 * @param {() => void} [hooks.onGlobalPromptChange] - 全局设定变化后重新注册
 * @returns {Array<() => void>} 各端点的 disposer
 */
export function registerWeixinRoutes(ctx, channel, cfg, baseCfg, hooks) {
  const disposers = [];
  /** 每次登录的运行态：sessionKey → Promise 结果。 */
  const loginRuns = new Map();
  /** 二维码图片缓存：sessionKey → { content, image }。 */
  const qrCache = new Map();

  /**
   * 注册单条路由。
   *
   * @param {string} path - 前缀之后的路径段
   * @param {readonly string[]} methods - 允许的方法
   * @param {(req: Request) => Promise<Response>} fetch - 处理器
   * @returns {void}
   */
  const route = (path, methods, fetch) => {
    disposers.push(
      ctx.connection.fetch.register({
        path: `${ROUTE_PREFIX}/${path}`,
        methods,
        requestBody: "buffered",
        fetch,
      }),
    );
  };

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  route("state", ["GET"], async () => {
    const snap = channel.snapshot();
    // overlay 里出现过的顶层键，代表该项已被 UI 覆盖（用于前端标注"已自定义"）。
    let overridden = [];
    try {
      overridden = Object.keys(loadSettingsOverlay());
    } catch (err) {
      logger.warn(`state: failed to read overlay keys: ${String(err)}`);
    }

    return json({
      ok: true,
      ...snap,
      // 当前生效的配置（供表单回显）
      settings: {
        enabled: cfg.enabled !== false,
        outboundMode: cfg.outbound?.mode ?? "final",
        minChars: cfg.outbound?.minChars ?? 1600,
        idleMs: cfg.outbound?.idleMs ?? 3000,
        textChunkLimit: cfg.outbound?.textChunkLimit ?? 4000,
        sendGapMs: cfg.outbound?.sendGapMs ?? 500,
        typingIndicator: cfg.typingIndicator !== false,
        replyProgressMessages: cfg.replyProgressMessages !== false,
        replyThinking: cfg.replyThinking === true,
        sessionMode: cfg.session?.mode ?? "single",
        sessionCwd: cfg.session?.cwd ?? "",
        allowFrom: Array.isArray(cfg.allowFrom) ? cfg.allowFrom : [],
        routeTag: cfg.channel?.routeTag ?? "",
        botAgent: cfg.channel?.botAgent ?? "",
        globalPrompt: cfg.globalPrompt ?? "",
        mediaInbound: cfg.media?.inbound !== false,
        mediaOutbound: cfg.media?.outbound !== false,
      },
      /** 已被 UI 覆盖的配置分组（顶层键）。 */
      overridden,
    });
  });

  // -------------------------------------------------------------------------
  // 配置写回（把 cordis.patch.yml 里的项搬成 UI 开关）
  // -------------------------------------------------------------------------

  route("settings", ["POST", "PATCH"], async (request) => {
    const body = await readJson(request);
    const { settings, errors } = normalizeSettingsPatch(body);

    if (errors.length > 0) {
      return json({ ok: false, error: errors.join("；"), errors }, 400);
    }
    if (Object.keys(settings).length === 0) {
      return json({ ok: false, error: "没有可更新的字段" }, 400);
    }

    try {
      // 1) 落盘：与已有 overlay 合并，避免多次单字段提交互相覆盖。
      const previous = loadSettingsOverlay();
      const next = mergeOverlay(previous, settings);
      saveSettingsOverlay(next);
      // 2) 就地改内存中的 cfg —— channel.cfg 与 setRuntimeConfig 持同一引用，
      //    改完立刻对读取方生效，无需重启。
      applySettingsInPlace(cfg, settings);

      // 3) 全局设定是"注册时才读文本"的，改完必须重新注册，否则要重启才生效
      if ("globalPrompt" in settings && hooks?.onGlobalPromptChange) {
        hooks.onGlobalPromptChange();
      }

      const needsRestart = restartRequiredFor(settings);
      logger.info(
        `settings updated: ${Object.keys(settings).join(", ")}` +
          (needsRestart.length > 0 ? ` (restart required: ${needsRestart.join(", ")})` : ""),
      );

      return json({
        ok: true,
        settings: {
          enabled: cfg.enabled !== false,
          outboundMode: cfg.outbound?.mode,
          minChars: cfg.outbound?.minChars,
          idleMs: cfg.outbound?.idleMs,
          textChunkLimit: cfg.outbound?.textChunkLimit,
          sendGapMs: cfg.outbound?.sendGapMs,
          typingIndicator: cfg.typingIndicator !== false,
          replyProgressMessages: cfg.replyProgressMessages !== false,
          replyThinking: cfg.replyThinking === true,
          sessionMode: cfg.session?.mode,
          sessionCwd: cfg.session?.cwd ?? "",
          allowFrom: Array.isArray(cfg.allowFrom) ? cfg.allowFrom : [],
          globalPrompt: cfg.globalPrompt ?? "",
          mediaInbound: cfg.media?.inbound !== false,
          mediaOutbound: cfg.media?.outbound !== false,
        },
        needsRestart,
      });
    } catch (err) {
      logger.error(`settings update failed: ${String(err)}`);
      return json({ ok: false, error: String(err) }, 500);
    }
  });

  route("settings/reset", ["POST"], async () => {
    try {
      clearSettingsOverlay();

      // 回滚内存值：把 baseCfg（不含 overlay 的插件配置）逐字段写回 cfg。
      // 就地改而非替换对象，因为 channel.cfg 与 setRuntimeConfig() 持有同一引用。
      if (baseCfg) {
        rollbackInPlace(cfg, baseCfg);
        // 回滚后全局设定可能变空，重新注册才能撤掉旧 section
        hooks?.onGlobalPromptChange?.();
        logger.info("settings overlay reset; in-memory config rolled back to plugin config");
        return json({ ok: true, needsRestart: false });
      }

      logger.warn("settings overlay reset; no base config snapshot, restart required");
      return json({
        ok: true,
        needsRestart: true,
        message: "已清除 UI 设置，重启 DSH 后恢复为插件配置文件中的值",
      });
    } catch (err) {
      logger.error(`settings reset failed: ${String(err)}`);
      return json({ ok: false, error: String(err) }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // 登录
  // -------------------------------------------------------------------------

  route("login/start", ["POST"], async () => {
    try {
      const started = await startWeixinLoginWithQr({
        apiBaseUrl: DEFAULT_BASE_URL,
        botType: DEFAULT_ILINK_BOT_TYPE,
        force: true,
      });

      if (!started.qrcodeUrl) {
        return json({ ok: false, error: started.message ?? "获取二维码失败" }, 502);
      }

      const { sessionKey, qrcodeUrl } = started;
      const qrcodeImage = await renderQrDataUrl(qrcodeUrl);

      // 后台等待扫码；结果写入 loginRuns，由 login/status 轮询取走。
      const run = waitForWeixinLogin({
        sessionKey,
        timeoutMs: LOGIN_TIMEOUT_MS,
      })
        .then((result) => {
          if (result.connected && result.botToken && result.accountId) {
            const normalizedId = normalizeAccountId(result.accountId);
            saveWeixinAccount(normalizedId, {
              token: result.botToken,
              baseUrl: result.baseUrl,
              userId: result.userId,
            });
            registerWeixinAccountId(normalizedId);
            if (result.userId) {
              clearStaleAccountsForUserId(
                normalizedId,
                result.userId,
                clearContextTokensForAccount,
              );
            }
            logger.info(`web login succeeded accountId=${normalizedId}`);
            return { ok: true, accountId: normalizedId, message: "已连接微信" };
          }
          if (result.alreadyConnected) {
            return { ok: true, alreadyConnected: true, message: result.message };
          }
          return { ok: false, message: result.message ?? "登录未完成" };
        })
        .catch((err) => {
          logger.error(`web login failed: ${String(err)}`);
          return { ok: false, message: String(err) };
        })
        .finally(() => {
          // 保留 60s 供前端取走结果，之后清理。
          setTimeout(() => loginRuns.delete(sessionKey), 60_000).unref?.();
        });

      loginRuns.set(sessionKey, run);

      return json({ ok: true, sessionKey, qrcodeUrl, qrcodeImage });
    } catch (err) {
      logger.error(`login/start failed: ${String(err)}`);
      return json({ ok: false, error: String(err) }, 500);
    }
  });

  route("login/status", ["GET"], async (request) => {
    const sessionKey = new URL(request.url).searchParams.get("sessionKey") ?? "";
    if (!sessionKey) return json({ ok: false, error: "缺少 sessionKey" }, 400);

    const live = getLoginStatus(sessionKey);
    const run = loginRuns.get(sessionKey);

    // 已结束：给出最终结果并清理
    if (run) {
      const settled = await Promise.race([run, Promise.resolve(null)]);
      if (settled) {
        loginRuns.delete(sessionKey);
        qrCache.delete(sessionKey);
        return json({ ok: true, done: true, result: settled });
      }
    }

    if (!live.alive && !run) {
      qrCache.delete(sessionKey);
      return json({ ok: true, done: true, result: { ok: false, message: live.message } });
    }

    // 二维码图片按 content 缓存：轮询 1.5s 一次，不缓存会反复做同样的编码工作。
    // 二维码过期刷新后 content 变化，缓存自动失效。
    let qrcodeImage = "";
    const content = live.qrcodeUrl ?? "";
    if (content) {
      const hit = qrCache.get(sessionKey);
      if (hit && hit.content === content) {
        qrcodeImage = hit.image;
      } else {
        qrcodeImage = await renderQrDataUrl(content);
        qrCache.set(sessionKey, { content, image: qrcodeImage });
      }
    } else {
      qrCache.delete(sessionKey);
    }

    return json({
      ok: true,
      done: false,
      status: live.status,
      qrcodeUrl: live.qrcodeUrl,
      qrcodeImage,
      needsVerifyCode: live.needsVerifyCode,
      message: live.message,
    });
  });

  route("login/verify", ["POST"], async (request) => {
    const body = await readJson(request);
    const sessionKey = String(body.sessionKey ?? "");
    const code = String(body.code ?? "");
    if (!sessionKey) return json({ ok: false, error: "缺少 sessionKey" }, 400);
    const accepted = submitVerifyCode(sessionKey, code);
    return accepted
      ? json({ ok: true })
      : json({ ok: false, error: "当前没有等待中的验证码" }, 409);
  });

  route("login/cancel", ["POST"], async (request) => {
    const body = await readJson(request);
    const sessionKey = String(body.sessionKey ?? "");
    if (sessionKey) {
      cancelLogin(sessionKey);
      loginRuns.delete(sessionKey);
      qrCache.delete(sessionKey);
    }
    return json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // 账号管理
  // -------------------------------------------------------------------------

  route("accounts/remove", ["POST"], async (request) => {
    const body = await readJson(request);
    const accountId = normalizeAccountId(String(body.accountId ?? ""));
    if (!accountId) return json({ ok: false, error: "缺少 accountId" }, 400);
    clearContextTokensForAccount(accountId);
    clearWeixinAccount(accountId);
    unregisterWeixinAccountId(accountId);
    logger.info(`accounts/remove: accountId=${accountId}`);
    return json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // 启停
  // -------------------------------------------------------------------------

  route("start", ["POST"], async () => {
    try {
      await channel.start();
      const snap = channel.snapshot();
      return json({ ok: true, running: snap.running, accountCount: snap.accountCount });
    } catch (err) {
      logger.error(`start failed: ${String(err)}`);
      return json({ ok: false, error: String(err?.message ?? err) }, 500);
    }
  });

  route("stop", ["POST"], async () => {
    try {
      await channel.stop();
      return json({ ok: true, running: false });
    } catch (err) {
      logger.error(`stop failed: ${String(err)}`);
      return json({ ok: false, error: String(err?.message ?? err) }, 500);
    }
  });

  return disposers;
}

/**
 * 一次性注销全部路由。
 *
 * @param {Array<() => Promise<void>>} disposers - 注册时收集的注销函数
 * @returns {Promise<void>}
 */
export async function disposeRoutes(disposers) {
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (err) {
      logger.warn(`disposeRoutes: ${String(err)}`);
    }
  }
  disposers.length = 0;
}
