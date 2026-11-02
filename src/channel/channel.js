/**
 * 微信通道运行时。
 *
 * 职责：
 *   - 解析已登录账号
 *   - 为每个账号启动一条长轮询（`bridge/monitor.js`）
 *   - 把入站消息交给桥接器（`bridge/weixin-bridge.js`）驱动 Agent
 *   - 汇总状态供 UI / 命令查询
 */
import {
  listWeixinAccountIds,
  resolveWeixinAccount,
  loadWeixinAccount,
} from "../auth/accounts.js";
import { runPollingLoop, extractText } from "../bridge/monitor.js";
import { WeixinBridge } from "../bridge/weixin-bridge.js";
import { logger } from "../util/logger.js";

/**
 * 微信通道。
 */
export class WeixinChannel {
  /**
   * @param {object} ctx - cordis 上下文
   * @param {object} cfg - 归一化配置
   */
  constructor(ctx, cfg) {
    this.ctx = ctx;
    this.cfg = cfg;
    /** @type {Map<string, object>} accountId → 运行时状态 */
    this.accounts = new Map();
    /** @type {AbortController|null} 长轮询取消控制器 */
    this.abortController = null;
    /** @type {boolean} 是否已启动轮询 */
    this.running = false;
    /** @type {WeixinBridge|null} 桥接器 */
    this.bridge = null;
    /** @type {Map<string, string>} fromUserId → context_token（出站回复需要） */
    this.contextTokens = new Map();
    /** @type {Map<string, string>} fromUserId → accountId（反查用哪个账号回复） */
    this.senderAccounts = new Map();
    /**
     * @type {Map<string, {accountId: string, at: number}>} fromUserId → 最近一次入站时间
     *
     * 自动发送需要一个"发给谁"的答案。配置里留空时按这里挑最近互动过的人，
     * 因为主动冒泡发给刚聊过的人最自然，也几乎一定有可用的 context_token。
     * 只存内存：重启后靠状态文件里的 `lastTarget` 兜底。
     */
    this.lastInboundAt = new Map();
    /** @type {Promise<void>[]} 轮询任务 */
    this.pollTasks = [];
  }

  /**
   * 列出已注册账号的运行参数。
   *
   * @returns {object[]} 账号列表
   */
  listAccounts() {
    const ids = listWeixinAccountIds();
    const out = [];
    for (const id of ids) {
      try {
        out.push(resolveWeixinAccount(id));
      } catch (err) {
        logger.warn(`listAccounts: failed to resolve ${id}: ${String(err)}`);
      }
    }
    return out;
  }

  /**
   * 记录一条入站消息的 context_token（回复时必须带回）。
   *
   * @param {string} fromUserId - 发送者
   * @param {string} contextToken - 令牌
   * @returns {void}
   */
  rememberContextToken(fromUserId, contextToken) {
    if (fromUserId && contextToken) this.contextTokens.set(fromUserId, contextToken);
  }

  /**
   * 读取某发送者的 context_token。
   *
   * @param {string} fromUserId - 发送者
   * @returns {string|undefined} 令牌
   */
  getContextToken(fromUserId) {
    return this.contextTokens.get(fromUserId);
  }

  /**
   * 反查某个发送者应该用哪个账号回复。
   *
   * 单账号是最常见情况；多账号时用收到的消息来自哪个账号的轮询来判断，
   * 轮询里已通过 `senderAccounts` 记录。
   *
   * @param {string} fromUserId - 发送者
   * @returns {object|null} 账号运行参数
   */
  getAccountForSender(fromUserId) {
    const accountId = this.senderAccounts.get(fromUserId);
    if (accountId) {
      try {
        return resolveWeixinAccount(accountId);
      } catch {
        // 落到下面用首个账号兜底
      }
    }
    const all = this.listAccounts();
    return all[0] ?? null;
  }

  /**
   * 取最近一次入站的发送者。
   *
   * @returns {{userId: string, accountId: string, at: number}|null} 最近互动信息
   */
  getRecentInbound() {
    let best = null;
    for (const [userId, info] of this.lastInboundAt) {
      if (!best || info.at > best.at) best = { userId, accountId: info.accountId, at: info.at };
    }
    return best;
  }

  /**
   * 汇总通道状态，供命令与 UI 输出。
   *
   * @returns {object} 状态快照
   */
  snapshot() {
    const accounts = this.listAccounts().map((acc) => {
      const stored = loadWeixinAccount(acc.accountId) ?? {};
      const runtime = this.accounts.get(acc.accountId) ?? {};
      return {
        accountId: acc.accountId,
        name: acc.name,
        enabled: acc.enabled,
        configured: acc.configured,
        baseUrl: acc.baseUrl,
        userId: stored.userId ?? null,
        savedAt: stored.savedAt ?? null,
        running: Boolean(runtime.running),
        lastError: runtime.lastError ?? null,
      };
    });

    return {
      running: this.running,
      accountCount: accounts.length,
      accounts,
      config: {
        outboundMode: this.cfg.outbound.mode,
        sessionMode: this.cfg.session.mode,
        allowFromCount: this.cfg.allowFrom.length,
        typingIndicator: this.cfg.typingIndicator,
      },
    };
  }

  /**
   * 启动通道：为每个已登录账号拉起一条长轮询。
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this.running) {
      logger.warn("channel.start: already running");
      return;
    }

    const accounts = this.listAccounts().filter((acc) => acc.token);
    if (accounts.length === 0) {
      throw new Error("尚无可用账号，请先扫码登录");
    }

    this.abortController = new AbortController();
    this.bridge = new WeixinBridge(this.ctx, this.cfg, this);
    this.pollTasks = [];

    for (const account of accounts) {
      this.accounts.set(account.accountId, { running: true, lastError: null });
      const task = this.runAccount(account, this.abortController.signal);
      this.pollTasks.push(task);
    }

    this.running = true;
    logger.info(`channel.start: polling started for ${accounts.length} account(s)`);
  }

  /**
   * 单账号轮询任务。
   *
   * 不 await 在 `start()` 里——轮询是常驻循环，await 会让启动永不返回。
   * 异常记录到账号状态，不向上抛（避免一个账号失效拖垮其他账号）。
   *
   * @param {object} account - 账号运行参数
   * @param {AbortSignal} signal - 取消信号
   * @returns {Promise<void>}
   */
  async runAccount(account, signal) {
    const accountId = account.accountId;
    try {
      await runPollingLoop({
        account,
        signal,
        onMessage: async ({ msg, text, contextToken }) => {
          const fromUserId = msg.from_user_id;
          // 记录来源账号，出站时用同一账号回复
          this.senderAccounts.set(fromUserId, accountId);
          // 供自动发送挑选"最近互动过的人"
          this.lastInboundAt.set(fromUserId, { accountId, at: Date.now() });
          await this.bridge.handleInbound({
            accountId,
            text,
            fromUserId,
            contextToken,
            // 原始消息必须透传：媒体项（图片/语音/文件/视频）只在 msg.item_list
            // 里，丢了它整条媒体链路就静默失效，表现为"发图没反应"
            msg,
          });
        },
        onFatal: (err) => {
          const state = this.accounts.get(accountId) ?? {};
          this.accounts.set(accountId, {
            ...state,
            running: false,
            lastError: String(err?.message ?? err),
          });
        },
      });
    } catch (err) {
      const state = this.accounts.get(accountId) ?? {};
      this.accounts.set(accountId, {
        ...state,
        running: false,
        lastError: String(err?.message ?? err),
      });
      logger.error(`channel: account ${accountId} polling stopped: ${String(err)}`);
    }
  }

  /**
   * 停止通道但保留实例，供 UI 再次启动。
   *
   * @returns {Promise<void>}
   */
  async stop() {
    this.running = false;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // 等轮询循环退出（长轮询最长 35s，abort 会立即打断）
    const tasks = this.pollTasks;
    this.pollTasks = [];
    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }

    if (this.bridge) {
      await this.bridge.dispose();
      this.bridge = null;
    }

    for (const [id, state] of this.accounts) {
      this.accounts.set(id, { ...state, running: false });
    }
    this.contextTokens.clear();
    this.senderAccounts.clear();
    this.lastInboundAt.clear();

    logger.info("channel.stop: stopped");
  }

  /**
   * 停止通道并释放资源。
   *
   * @returns {Promise<void>}
   */
  async dispose() {
    await this.stop();
  }
}
