/**
 * 微信 ↔ DSH Agent 桥接。
 *
 * 入站：长轮询收到文本 → 映射到会话 → `agent.followup()` 驱动 Agent
 * 出站：监听 `agent/turn-stopping` → 取本回合完整回复 → `sendMessage` 发回微信
 *
 * 会话映射（`session.mode`）：
 *   - `single`：每个微信用户固定一个会话，接续上下文
 *   - `per-message`：每条消息开新会话
 *
 * 单条回复若超过 `outbound.textChunkLimit` 会分段发送。
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { getConfig, sendMessage, sendTyping } from "../protocol/api.js";
import { getContextToken, setContextToken } from "./context-tokens.js";
import { registerSessionPrompt } from "./global-prompt.js";
import {
  ITEM_TYPE,
  buildFileItem,
  buildImageItem,
  buildVideoItem,
  classifyMime,
  downloadMedia,
  guessMime,
  sniffImageExt,
  uploadMedia,
} from "./media.js";
import { StreamWriter, extractChunkText } from "./stream-outbound.js";
import { resolveStoreDir } from "../util/paths.js";
import { logger } from "../util/logger.js";

/** 微信单条文本上限（服务端硬限制，超出会被截断）。 */
const WECHAT_TEXT_LIMIT = 4000;
/** "正在输入" 状态的刷新间隔（微信侧约 5s 失效）。 */
const TYPING_REFRESH_MS = 4_000;
/**
 * 相邻出站消息的最小间隔。
 *
 * 平台对「短时间连发多个气泡」有频控，触发后只回 `ret=-2 prepare failed`，
 * 而且**内容直接丢弃**（不是排队等重试）。流式出站一次回复动辄十几段，
 * 不留间隔必然撞上。500ms 是实测安全值。
 */
const DEFAULT_SEND_GAP_MS = 500;
/** 单条消息最大发送尝试次数。 */
const SEND_MAX_ATTEMPTS = 4;
/** 每次重试前的等待时长（指数退避）。 */
const SEND_RETRY_BACKOFF_MS = [1_000, 2_000, 3_500, 5_000];
/** 待补发片段的最大保留数量。 */
const MAX_FAILED_PARTS = 5;

/**
 * "正在输入"的状态码。
 *
 * `CANCEL` 不是可选项：微信侧的状态是**服务端维护**的，只停心跳不会消失，
 * 它会一直挂着，用户会看到"对方一直在输入"。收尾必须主动发一次 `CANCEL`。
 */
const TypingStatus = { TYPING: 1, CANCEL: 2 };

/**
 * 微信场景下不可用的交互式工具。
 *
 * 这些工具依赖前端弹窗或终端确认，微信里没有对应 UI，调用后回合会一直挂着。
 * 禁掉后 Agent 只能用普通文本提问，用户在微信里直接回复就行。
 *
 * 名字必须与 DSH 实际注册的工具名逐一对应——`restrict()` 对未知名字会整体抛错，
 * 一个拼错就导致整条禁用规则失效。
 */
const WECHAT_UNSUPPORTED_TOOLS = [
  "ask_user_question",
  "exit_plan_mode",
];

/**
 * 判断发送错误是否值得重试。
 *
 * `prepare failed` 是平台连发频控，退避后通常能成功；
 * `invalid arguments` 是请求结构问题，重试没有意义。
 *
 * @param {unknown} err - 错误
 * @returns {boolean} 是否重试
 */
function isRetriableSendError(err) {
  const msg = String(err);
  if (/invalid arguments/.test(msg)) return false;
  return /prepare failed|ret=-2|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
}

/**
 * 等待指定毫秒。
 *
 * @param {number} ms - 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 生成出站消息的 `client_id`。
 *
 * 格式对齐上游：`<prefix>:<毫秒时间戳>-<8 位随机 hex>`。
 * 服务端用它做幂等去重，重复发送同一个 client_id 不会重复投递。
 * 缺失会直接触发 `ret=-2 invalid arguments`。
 *
 * @returns {string} 客户端消息 ID
 */
function generateClientId() {
  return `dsh-weixin:${Date.now()}-${randomBytes(4).toString("hex")}`;
}

/**
 * 把长文本按上限切分。
 *
 * 优先在换行处切，其次在空格处，都找不到才硬切——避免把单词/句子拦腰截断。
 *
 * 软边界（换行/空格）必须落在窗口的**后半段**才采用。早先只要找到换行就切，
 * 于是 `"a\n" + 500 字无换行正文` 这种输入首段只有 1 个字符，一次回复被切成
 * 七八个碎片气泡。现在低于 60% 位置的软边界一律放弃，退回窗口上限硬切。
 *
 * @param {string} text - 原始文本
 * @param {number} limit - 单段上限
 * @returns {string[]} 分段列表
 */
export function chunkText(text, limit) {
  const max = Math.max(1, Math.min(limit || WECHAT_TEXT_LIMIT, WECHAT_TEXT_LIMIT));
  if (text.length <= max) return [text];

  /** 软边界可接受的最小位置：低于此值说明切口太靠前，宁可硬切。 */
  const minCut = Math.floor(max * 0.6);

  const parts = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // 优先换行，其次空格；两者都必须在后半段才采用
    let cut = window.lastIndexOf("\n");
    if (cut < minCut) {
      const space = window.lastIndexOf(" ");
      cut = space >= minCut ? space : -1;
    }
    // 没有任何可接受的软边界 → 按窗口上限硬切
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * 计算某个微信用户对应的 DSH 会话 ID。
 *
 * 固定加前缀，避免与 Web UI 的会话 ID 冲突。
 *
 * @param {object} cfg - 归一化配置
 * @param {string} accountId - 账号 ID
 * @param {string} fromUserId - 微信用户 ID
 * @returns {string} 会话 ID
 */
export function resolveSessionId(cfg, accountId, fromUserId, gen) {
  const prefix = cfg.session?.idPrefix || "weixin";
  const base = `${prefix}-${accountId}-${fromUserId}`;
  if (cfg.session?.mode === "per-message") {
    // 每条消息一个会话：加时间戳区分
    return `${base}-${Date.now().toString(36)}`;
  }
  // `gen` 是"全局设定代数"：设定变更后 +1，会话 ID 随之变化 → 开新会话，
  // 新会话会重新组装系统提示拿到新设定。旧会话原样留在磁盘上，不删。
  return gen > 0 ? `${base}-g${gen}` : base;
}

/**
 * 判断发送者是否在白名单内。
 *
 * @param {object} cfg - 归一化配置
 * @param {string} fromUserId - 微信用户 ID
 * @returns {boolean} 是否允许
 */
export function isAllowedSender(cfg, fromUserId) {
  const allow = Array.isArray(cfg.allowFrom) ? cfg.allowFrom : [];
  if (allow.length === 0) return true;
  const target = String(fromUserId).toLowerCase();
  return allow.some((id) => String(id).toLowerCase() === target);
}

/**
 * 微信通道桥接器。
 */
export class WeixinBridge {
  /**
   * @param {object} ctx - cordis 上下文
   * @param {object} cfg - 归一化配置
   * @param {object} channel - 通道实例（用于读取账号与状态）
   */
  constructor(ctx, cfg, channel) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.channel = channel;
    /** @type {Map<string, object>} sessionId → Agent 句柄 */
    this.agents = new Map();
    /**
     * @type {Map<string, Promise<object>>} sessionId → 进行中的创建任务
     *
     * 同一会话并发到达的消息只应触发一次创建，否则会撞
     * `SessionAlreadyExistsError` 或互相踢掉对方的句柄。
     */
    this.agentCreations = new Map();
    /** @type {Map<string, string>} sessionId → 最近一次回复的接收人 */
    this.replyTargets = new Map();
    /** @type {Map<string, object>} agentId → 正在刷新的 typing 定时器 */
    this.typingTimers = new Map();
    /** @type {Map<string, string>} `${accountId}|${userId}` → typing_ticket（短期有效） */
    this.typingTickets = new Map();
    /** 上一次成功发送的时间戳，用于统计与排障。 */
    this.lastSentAt = 0;
    /**
     * 下一个可用的发送时隙（epoch ms）。
     *
     * `respectSendGap()` 在串行链内把它往后推一个 `sendGapMs`，
     * 从而把并发发送排成有间隔的队列——单纯读 `lastSentAt` 做不到，
     * 因为「读 → 睡 → 发送 → 写」跨了 await，并发调用会读到同一个旧值。
     */
    this.nextSendAt = 0;
    /** 发送时隙串行链：保证「计算 + 占位」原子。 */
    this.sendSlotChain = Promise.resolve();
    /** @type {Map<string, Array<{text: string, label: string, at: number}>>} 发送失败的片段 */
    this.failedParts = new Map();
    /**
     * @type {Map<string, string>} sessionId → 本回合的 `run_id`
     *
     * 上游每轮生成一个 `randomUUID()`，同一轮内所有出站消息（文本分段、
     * 媒体卡片）共用同一个值，让客户端能把它们归到同一条"机器人回复"里。
     * 不传也能发出去，但客户端侧缺少归组信息，多媒体消息容易只显示一部分。
     */
    this.runIds = new Map();
    /** @type {Map<string, string>} sessionId → 媒体落盘目录 */
    this.mediaDirs = new Map();
    /** @type {Set<string>} 本回合已经流式发过内容的会话 */
    this.streamedSessions = new Set();
    /** @type {Set<string>} 流式通道当前处于"思考段"的会话（用于插段标记） */
    this.thinkingOpen = new Set();
    /** @type {Map<string, object>} sessionId → chunk 类型统计（排障用） */
    this.streamStats = new Map();
    /**
     * 全局设定代数。设定变更后 +1，会话 ID 随之变化，下次消息开新会话。
     *
     * 为什么必须换会话 ID：系统提示在会话里是**已固化的历史事件**
     * （`system/message` 是 SurfaceEvent，写进去就一直作为上下文复用）。
     * 只重新 `register()` section 对已有会话完全无效——
     * 实测改了设定、日志也显示注册了 332 字，但模型收到的还是旧的 31 字。
     */
    this.promptGen = 0;

    // 流式出站：只有 mode=stream 时才建，final 模式走整段发送
    this.streamWriter = cfg.outbound?.mode === "stream"
      ? new StreamWriter({
          minChars: cfg.outbound.minChars,
          idleMs: cfg.outbound.idleMs,
        })
      : null;
  }

  /**
   * 处理一条入站消息。
   *
   * @param {object} event - 轮询回调事件
   * @param {string} event.accountId - 账号 ID
   * @param {string} event.text - 文本内容
   * @param {string} event.fromUserId - 发送者
   * @param {string} [event.contextToken] - 回复时必须带回的上下文令牌
   * @param {object} [event.msg] - 原始消息（用于取媒体项）
   * @returns {Promise<void>}
   */
  async handleInbound(event) {
    const { accountId, text, fromUserId, contextToken, msg } = event;

    if (!isAllowedSender(this.cfg, fromUserId)) {
      logger.info(`bridge: reject sender ${fromUserId} (not in allowFrom)`);
      return;
    }

    // context_token 必须随回复带回，先持久化再处理
    if (contextToken) {
      setContextToken(accountId, fromUserId, contextToken);
      this.channel.rememberContextToken(fromUserId, contextToken);
    }

    const sessionId = resolveSessionId(this.cfg, accountId, fromUserId, this.promptGen);

    // 媒体先落盘，再把路径写进文本——Agent 只能看文件，不能直接看微信 CDN
    const mediaNote = await this.ingestMedia(msg, sessionId);
    const finalText = mediaNote ? (text ? `${text}\n\n${mediaNote}` : mediaNote) : text;
    if (!finalText) {
      logger.debug(`bridge: inbound from=${fromUserId} 无可用内容，跳过`);
      return;
    }

    logger.info(
      `bridge: inbound accountId=${accountId} from=${fromUserId} session=${sessionId} `
        + `len=${finalText.length}${mediaNote ? " (含媒体)" : ""}`,
    );

    const agent = await this.ensureAgent(sessionId, accountId, fromUserId);

    // 记录回复目标：出站时按 agent.id 反查该发给谁
    this.replyTargets.set(sessionId, fromUserId);

    // 每轮一个 run_id，本轮所有出站消息共用，供客户端归组
    this.runIds.set(sessionId, randomUUID());

    if (this.cfg.typingIndicator !== false) {
      this.startTyping(accountId, fromUserId);
    }

    const message = createUserMessage({
      content: [{ type: "text", text: finalText }],
      source: {
        // 自定义 kind：MessageSourceMap 是 merge-extensible 的，
        // 运行期直接传对象即可，类型层面无需额外声明。
        kind: "weixin",
        accountId,
        fromUserId,
        sessionId,
      },
    });

    agent.followup(message);
    logger.info(`bridge: followup queued session=${sessionId} agentStatus=${agent.status}`);
  }

  /**
   * 取得（或创建、或恢复）会话对应的 Agent。
   *
   * 三个坑叠在一起，缺一个都跑不通：
   *   1. **必须绑模型**：`create()` 里 `agentOptions ?? {}` 为空，没模型就没有回合。
   *   2. **必须能恢复**：会话会持久化到磁盘，重启后 `create()` 同 ID 会抛
   *      `SessionAlreadyExistsError`，这时得走 `resume()`。
   *   3. **必须先释放僵尸**：内存注册表里若还留着上一轮的 Agent，
   *      连 `resume()` 也会撞 ID。
   *
   * @param {string} sessionId - 会话 ID
   * @param {string} accountId - 账号 ID
   * @param {string} fromUserId - 微信用户 ID
   * @returns {Promise<object>} Agent 实例
   */
  async ensureAgent(sessionId, accountId, fromUserId) {
    const existing = this.agents.get(sessionId);
    if (existing) {
      // 句柄可能已被外部回收（Web UI 删除会话），校验存活
      const live = this.ctx.agents.get(sessionId);
      if (live) return live;
      this.agents.delete(sessionId);
      logger.warn(`bridge: agent ${sessionId} disappeared, recreating`);
    }

    // **并发去重**：下面的创建流程要跨多个 `await`（读预设、create/resume），
    // 同一会话连发两条消息时，两个调用会同时走到这里、都看到 Map 为空，
    // 于是并发创建同一个 sessionId——第二个必然撞 `SessionAlreadyExistsError`，
    // 或者在 resume 路径上把第一个刚建好的 agent 当"僵尸"踢掉。
    // 用 in-flight 表把并发收敛到同一次创建，后来者直接等结果。
    const inflight = this.agentCreations.get(sessionId);
    if (inflight) {
      logger.debug(`bridge: 复用进行中的 agent 创建 session=${sessionId}`);
      return inflight;
    }

    const creation = this.createAgent(sessionId, accountId, fromUserId)
      .finally(() => this.agentCreations.delete(sessionId));
    this.agentCreations.set(sessionId, creation);
    return creation;
  }

  /**
   * 真正执行 Agent 创建/恢复的流程。
   *
   * 从 `ensureAgent` 拆出来的原因见那里的并发去重注释——
   * 只有 `ensureAgent` 需要做去重，创建细节不必知道有去重这回事。
   *
   * @param {string} sessionId - 会话 ID
   * @param {string} accountId - 账号 ID
   * @param {string} fromUserId - 微信用户 ID
   * @returns {Promise<object>} Agent 实例
   */
  async createAgent(sessionId, accountId, fromUserId) {
    const cwd = this.resolveCwd();

    const selection = this.resolveModelSelection();
    const agentOptions = {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort },
    };
    const agentPreset = await this.resolvePresetId();

    // 把选择写进请求头；不装的话请求不带 provider/model
    const setup = async (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
      // 全局设定里若有 perAccount 覆盖，注册到该 Agent 的 scope 上
      registerSessionPrompt(agentCtx, this.cfg, { accountId, fromUserId, sessionId });

      // **真正挂载工具的地方**。`meta.agentPreset` 只写进会话 header 做记录，
      // 不会激活预设里的插件；必须在 setup 里用 scoped ctx 调 mount，
      // 否则 Agent 拿不到任何工具——它只会把工具调用当纯文本写出来（DSML），
      // 既不会真正执行，也不报错，极难发现。
      if (agentPreset) {
        // 用 `ctx.get()` 而非 `ctx.agentPresets`：预设注册表只在 web profile 提供，
        // 静态 inject 会让 headless / acp 下整个插件永久 pending。
        const presetRegistry = this.ctx.get("agentPresets");
        if (!presetRegistry?.mount) {
          logger.warn(
            `bridge: 预设注册表不可用，${agentPreset} 未挂载（当前 profile 无 agentPresets 服务）；`
              + "该会话将没有工具可用",
          );
        } else {
          try {
            await presetRegistry.mount(agentCtx, agentPreset);
          } catch (err) {
            logger.error(`bridge: 挂载预设 ${agentPreset} 失败: ${String(err)}`);
            if (err && err.stack) logger.debug(String(err.stack));
          }
        }
      }

      // 微信不是交互式 UI：这些工具要求前端弹窗/等用户点选，在微信里没人应答，
      // 回合会卡在工具调用上不动。禁掉后 Agent 只能用纯文本提问，用户直接回复即可。
      const deny = Array.isArray(this.cfg.toolDeny) && this.cfg.toolDeny.length > 0
        ? this.cfg.toolDeny
        : WECHAT_UNSUPPORTED_TOOLS;

      // `restrict()` 是「全有或全无」：只要有一个名字不存在就整体抛错，
      // 所以先整批试，失败再逐个试，避免因为版本差异导致一个都禁不掉。
      try {
        agentCtx.tools.restrict({ deny: [...deny] });
        logger.debug(`bridge: 已禁用交互式工具 ${deny.join(", ")}`);
      } catch {
        let ok = 0;
        for (const name of deny) {
          try {
            agentCtx.tools.restrict({ deny: [name] });
            ok += 1;
          } catch {
            // 该名字在当前版本不存在，跳过
          }
        }
        if (ok > 0) logger.debug(`bridge: 已逐个禁用交互式工具 ${ok}/${deny.length}`);
        else logger.debug("bridge: 无匹配的交互式工具可禁用（可能版本差异）");
      }
    };

    const handle = await this.createOrResume({
      sessionId,
      cwd,
      agentOptions,
      setup,
      agentPreset,
    });
    this.agents.set(sessionId, handle);
    this.attachOutbound(sessionId, handle.agent);

    logger.info(
      `bridge: agent ready session=${sessionId} account=${accountId} user=${fromUserId} `
        + `model=${selection.provider}/${selection.model} preset=${agentPreset ?? "(default)"}`,
    );
    return handle.agent;
  }

  /**
   * 解析要挂给微信会话的 Agent 预设。
   *
   * **这一步不能省**：不指定预设时 Agent 只有模型、没有任何工具，
   * 表现是"能对话、会思考，但永远不会写文件/执行命令"，会话日志里
   * `tool/call` 数量始终为 0，且没有任何报错提示。
   *
   * 顺序：配置覆盖 > 注册表默认预设。
   *
   * @returns {Promise<string|undefined>} 预设 ID；拿不到时返回 undefined
   */
  async resolvePresetId() {
    const configured = this.cfg.session?.agentPreset;
    if (typeof configured === "string" && configured.trim()) return configured.trim();

    const registry = this.ctx.get("agentPresets");
    if (!registry) return undefined;

    try {
      // `defaultId` 是 getter，优先用；没有再退到 list() 里找 isDefault
      const direct = registry.defaultId;
      if (typeof direct === "string" && direct) return direct;
    } catch (err) {
      logger.warn(`resolvePresetId: defaultId 读取失败: ${String(err)}`);
    }

    try {
      const rows = await registry.list?.();
      const list = Array.isArray(rows) ? rows : rows?.presets;
      const fallback = Array.isArray(list) ? list.find((r) => r?.isDefault)?.id : undefined;
      return typeof fallback === "string" && fallback ? fallback : undefined;
    } catch (err) {
      logger.warn(`resolvePresetId: list 失败: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * 先建，撞 ID 就恢复。
   *
   * `create()` 失败时可能已在注册表留下痕迹，因此恢复前先清一次。
   *
   * @param {object} opts - 创建/恢复参数
   * @returns {Promise<object>} Agent 句柄
   */
  async createOrResume(opts) {
    const { sessionId, cwd, agentOptions, setup, agentPreset } = opts;

    try {
      return await this.ctx.agents.create({
        sessionId,
        // 预设必须走 meta：它是会话级的持久字段。
        // 不传的话会话能对话但没有工具，且完全静默。
        meta: {
          ...(cwd ? { cwd } : {}),
          ...(agentPreset ? { agentPreset } : {}),
        },
        agentOptions,
        setup,
      });
    } catch (err) {
      if (err?.name !== "SessionAlreadyExistsError") throw err;
      logger.info(`bridge: session ${sessionId} exists on disk, resuming`);
    }

    // 注册表里若有残留，先踢掉，否则 resume 也会撞 ID
    const stale = this.ctx.agents.get(sessionId);
    if (stale) {
      logger.warn(`bridge: evicting stale in-memory agent ${sessionId}`);
      try {
        await stale.dispose?.();
      } catch (err) {
        logger.warn(`bridge: stale agent dispose failed: ${String(err)}`);
      }
    }

    const handle = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions,
      setup,
    });

    return handle;
  }

  /**
   * 解析会话工作目录。
   *
   * 顺序：插件配置 `session.cwd` > DSH 第一个 Workspace 的路径 > `process.cwd()`。
   * 注意 Workspace 实体的字段名是 `path` 而不是 `cwd`——写错会让会话全部落到
   * `_no-cwd` 分组，Agent 也因此拿不到可用的工作目录。
   *
   * @returns {string|undefined} 绝对路径；都拿不到时返回 undefined
   */
  resolveCwd() {
    const configured = this.cfg.session?.cwd;
    if (typeof configured === "string" && configured.trim()) return configured.trim();

    try {
      // `workspaceRegistry` 只在 web profile 提供，故用 `ctx.get()` 可选读取。
      const first = this.ctx.get("workspaceRegistry")?.list?.()[0];
      if (first?.path) return first.path;
    } catch (err) {
      logger.warn(`resolveCwd: workspaceRegistry.list failed: ${String(err)}`);
    }

    return process.cwd();
  }

  /**
   * 把入站消息里的媒体下载解密到本地，返回一段描述文本。
   *
   * Agent 只能读本地文件，读不了微信 CDN；所以这里必须先落盘，再把路径
   * 作为普通文本塞进消息。图片还能让 Agent 用 ViewImage 直接看。
   *
   * @param {object} msg - 原始微信消息
   * @param {string} sessionId - 会话 ID
   * @returns {Promise<string>} 描述文本（无媒体则空串）
   */
  async ingestMedia(msg, sessionId) {
    if (this.cfg.media?.inbound === false) return "";
    const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
    if (items.length === 0) return "";

    // 账号只能按发送者反查：msg.to_user_id 是 `xxx@im.bot` 形态，
    // 与 accountId（`xxx-im-bot`）不是同一个值，拿它匹配永远落空
    const account = this.channel.getAccountForSender(msg?.from_user_id);
    // 媒体项自带 `full_url` 时压根不需要 base，这里仅作兜底
    const cdnBaseUrl = account?.cdnBaseUrl || account?.baseUrl;

    const notes = [];
    for (const item of items) {
      const type = item?.type;
      if (type === ITEM_TYPE.TEXT) continue; // 文本已单独提取

      try {
        const note = await this.ingestOneItem(item, type, sessionId, cdnBaseUrl);
        if (note) notes.push(note);
      } catch (err) {
        logger.error(`bridge: 媒体处理失败 type=${type}: ${String(err)}`);
        // 失败也要告诉 Agent，否则它会以为用户什么都没发
        notes.push(`[收到一个媒体文件，但下载失败: ${String(err).slice(0, 120)}]`);
      }
    }

    return notes.join("\n");
  }

  /**
   * 处理单个媒体项。
   *
   * @param {object} item - item_list 中的一项
   * @param {number} type - 项类型
   * @param {string} sessionId - 会话 ID
   * @param {string} cdnBaseUrl - CDN 地址
   * @returns {Promise<string>} 描述文本
   */
  async ingestOneItem(item, type, sessionId, cdnBaseUrl) {
    const dir = await this.ensureMediaDir(sessionId);

    if (type === ITEM_TYPE.IMAGE) {
      const media = item.image_item?.media;
      if (!media) return "";
      // 图片的 aeskey 可能在 image_item.aeskey（hex）而非 media.aes_key
      const aesKey = item.image_item?.aeskey
        ? { ...media, aes_key: Buffer.from(item.image_item.aeskey, "hex").toString("base64") }
        : media;
      const buf = await downloadMedia(aesKey, cdnBaseUrl, "inbound image");
      // 微信图片实际是 JPEG，写死 .png 会让后续按扩展名判 MIME 的地方全部出错
      const file = path.join(dir, `image-${Date.now()}.${sniffImageExt(buf)}`);
      await fs.writeFile(file, buf);
      logger.info(`bridge: 图片已保存 ${file} (${buf.length} bytes)`);
      return `[用户发送了图片，已保存到 ${file}]`;
    }

    if (type === ITEM_TYPE.VOICE) {
      const media = item.voice_item?.media;
      if (!media) return "";
      const buf = await downloadMedia(media, cdnBaseUrl, "inbound voice");
      // 语音是 SILK 编码，这里原样存下，让 Agent 知道有这段音频
      const file = path.join(dir, `voice-${Date.now()}.silk`);
      await fs.writeFile(file, buf);
      logger.info(`bridge: 语音已保存 ${file} (${buf.length} bytes)`);
      return `[用户发送了语音，SILK 文件已保存到 ${file}]`;
    }

    if (type === ITEM_TYPE.FILE) {
      const fileItem = item.file_item;
      const media = fileItem?.media;
      if (!media) return "";
      const buf = await downloadMedia(media, cdnBaseUrl, "inbound file");
      const name = fileItem.file_name || `file-${Date.now()}.bin`;
      const safe = name.replace(/[\\/:*?"<>|]/g, "_");
      const file = path.join(dir, safe);
      await fs.writeFile(file, buf);
      logger.info(`bridge: 文件已保存 ${file} (${buf.length} bytes)`);
      return `[用户发送了文件「${name}」，已保存到 ${file}]`;
    }

    if (type === ITEM_TYPE.VIDEO) {
      const media = item.video_item?.media;
      if (!media) return "";
      const buf = await downloadMedia(media, cdnBaseUrl, "inbound video");
      const file = path.join(dir, `video-${Date.now()}.mp4`);
      await fs.writeFile(file, buf);
      logger.info(`bridge: 视频已保存 ${file} (${buf.length} bytes)`);
      return `[用户发送了视频，已保存到 ${file}]`;
    }

    return "";
  }

  /**
   * 取得（并创建）某会话的媒体目录。
   *
   * @param {string} sessionId - 会话 ID
   * @returns {Promise<string>} 目录绝对路径
   */
  async ensureMediaDir(sessionId) {
    const cached = this.mediaDirs.get(sessionId);
    if (cached) return cached;

    const configured = this.cfg.media?.dir;
    const base = configured || resolveStoreDir("media");
    // 会话 ID 里可能有 `@` 与 `-`，统一清洗成安全目录名。
    // 取尾部而非头部：sessionId 前缀（`weixin-<accountId>-`）对每个会话都一样，
    // 只有尾部的主键不同，截头会把所有会话截成同一个名字。
    const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
    const dir = path.join(base, safe);
    await fs.mkdir(dir, { recursive: true });
    this.mediaDirs.set(sessionId, dir);
    return dir;
  }

  /**
   * 解析用哪个模型跑微信会话。
   *
   * 来源：DSH 的默认模型服务 `agentDefaultModel`（即 Web UI 里选中的模型）。
   * 拿不到时抛错——静默降级会让 Agent 变成"哑巴"，比直接失败更难排查。
   *
   * @returns {{provider: string, model: string, reasoningEffort?: string}} 模型选择
   */
  resolveModelSelection() {
    const defaultModel = this.ctx.agentDefaultModel;
    const selection = defaultModel?.currentSelection?.();
    if (selection?.provider && selection?.model) return selection;

    throw new Error(
      "无法确定微信会话使用的模型：请在 DSH 中选择默认模型"
        + "（agent-default-model 配置的 provider / model）",
    );
  }

  /**
   * 为某个 Agent 挂上出站监听。
   *
   * 用 `agent/turn-stopping` 而非逐 chunk 转发：先保证"能收到完整回复"，
   * 流式增量留待后续按 `outbound.mode` 扩展。
   *
   * @param {string} sessionId - 会话 ID
   * @param {object} agent - Agent 实例
   * @returns {void}
   */
  attachOutbound(sessionId, agent) {
    // `agent.ctx.on()` 本身就绑在该 Agent 的 scope 上，事件只会来自这个 Agent。
    // 早先这里还加了一层 `payload?.agent?.id !== agent.id` 过滤，但
    // `agent/assistant-stream` 的 payload 只有 `{ frame }`、根本没有 agent 字段，
    // 于是每个帧都被 `undefined !== agent.id` 挡掉——流式通道静默失效，
    // 而正文靠收尾拼装还能发出去，所以表面看"能用"，实际思考内容一个字都出不来。
    const listener = async (payload) => {
      try {
        await this.flushReply(sessionId, agent, payload?.turn);
      } catch (err) {
        logger.error(`bridge: flushReply failed session=${sessionId}: ${String(err)}`);
      }
    };

    // agent.ctx 上的监听随 Agent 销毁自动解绑
    agent.ctx.on("agent/turn-stopping", listener);

    // 流式增量：mode=stream 时把 chunk 攒成段陆续发，营造"边想边说"
    if (this.streamWriter) {
      agent.ctx.on("agent/assistant-stream", (payload) => {
        const frame = payload?.frame;
        if (frame?.type !== "chunk") return;

        // 思考增量默认丢弃。`replyThinking` 打开时一并透传，
        // 否则流式模式下开关会失效（正文走流式、思考只走收尾拼装，两边各管一半）。
        const withThinking = this.cfg.replyThinking === true;
        const chunkType = String(frame.chunk?.type ?? "");
        const isThinking = chunkType === "reasoning-delta" || chunkType === "reasoning";

        let delta = extractChunkText(frame.chunk, { withThinking });
        // 排障用：只记录"哪些类型被收到/被丢弃"，不记录内容（可能很长）
        if (chunkType) {
          const stat = this.streamStats.get(sessionId) ?? {};
          const key = `${chunkType}:${delta ? "kept" : "dropped"}`;
          stat[key] = (stat[key] ?? 0) + 1;
          this.streamStats.set(sessionId, stat);
        }
        if (!delta) return;

        // 流式通道是逐段下发，没法像收尾拼装那样整体加前缀，
        // 所以只在"进入/切换"时插一个标记，避免每段都带一遍。
        if (withThinking && isThinking && !this.thinkingOpen.has(sessionId)) {
          this.thinkingOpen.add(sessionId);
          delta = `【思考】\n${delta}`;
        } else if (withThinking && !isThinking && this.thinkingOpen.has(sessionId)) {
          this.thinkingOpen.delete(sessionId);
          delta = `\n【回答】\n${delta}`;
        }

        try {
          const buf = this.streamWriter.get(sessionId, (text) => this.sendText(sessionId, text));
          buf.push(delta);
          this.streamedSessions.add(sessionId);
        } catch (err) {
          logger.warn(`stream: push failed session=${sessionId}: ${String(err)}`);
        }
      });
    }

    // 回合内失败默认是静默的（只在 UI 里显示），这里显式暴露，否则微信侧
    // 表现为"发消息没反应"，排查起来毫无线索
    agent.ctx.on("agent/error", (payload) => {
      const detail = payload?.error instanceof Error
        ? `${payload.error.name}: ${payload.error.message}`
        : String(payload?.error);
      // `turn` / `step` 并非所有错误都带（如流式阶段就崩的），
      // 直接插值会打出 `turn=undefined step=undefined`，掩盖真正的错误来源。
      const where = [
        payload?.turn === undefined ? "" : `turn=${payload.turn}`,
        payload?.step === undefined ? "" : `step=${payload.step}`,
      ].filter(Boolean).join(" ");
      logger.error(
        `bridge: agent error session=${sessionId}${where ? ` ${where}` : ""}: ${detail}`,
      );
      if (payload?.error instanceof Error && payload.error.stack) {
        logger.debug(String(payload.error.stack));
      }
      // 回合崩了就不会有 turn-stopping，typing 会一直挂着。
      // 这里顺手撤掉，避免用户看到永久的"正在输入"。
      const target = this.replyTargets.get(sessionId);
      if (target) {
        this.stopTyping(target).catch((err) => {
          logger.debug(`typing cancel after error failed: ${String(err)}`);
        });
      }
    });

    // Agent 被销毁（Web UI 删会话、外部 dispose、恢复时踢掉僵尸）时清理本桥接
    // 持有的引用。不清理的话：
    //   - `this.agents` 里的死句柄会一直存活，Map 只增不减；
    //   - 该会话的 typing 定时器会继续每 4s 打一次接口，且服务端状态永不撤销
    //     （用户侧看到"对方一直在输入"），`timer.unref()` 只能让进程退出时
    //     不受阻，进程活着它就一直在跑。
    agent.ctx.on("agent/disposed", () => {
      // 只清理指向**这个** agent 的映射：同 ID 可能已被新实例接手，
      // 拿 ID 盲删会把新句柄一起删掉。
      const tracked = this.agents.get(sessionId);
      if (tracked?.agent === agent || tracked === agent) {
        this.agents.delete(sessionId);
      }
      this.agentCreations.delete(sessionId);
      this.streamedSessions.delete(sessionId);
      this.thinkingOpen.delete(sessionId);
      this.streamStats.delete(sessionId);
      this.failedParts.delete(sessionId);
      this.runIds.delete(sessionId);

      const target = this.replyTargets.get(sessionId);
      if (target) {
        this.stopTyping(target).catch((err) => {
          logger.debug(`typing cancel after dispose failed: ${String(err)}`);
        });
      }
      logger.debug(`bridge: agent disposed, bridge state released session=${sessionId}`);
    });

    logger.debug(`bridge: outbound listener attached session=${sessionId}`);
  }

  /**
   * 取本回合 assistant 文本并发回微信。
   *
   * @param {string} sessionId - 会话 ID
   * @param {object} agent - Agent 实例
   * @param {number} [turn] - 本回合号，用于精确定位回复
   * @returns {Promise<void>}
   */
  async flushReply(sessionId, agent, turn) {
    // **第一件事就是撤 typing**，不能放在任何 return 之后。
    // 必须用 fromUserId 作 key：定时器是按接收者存的
    // （`startTyping(accountId, toUserId)`），早先这里传的是 `agent.id`，
    // 两套 key 对不上，定时器永远查不到 → 心跳停不下来 →
    // 用户看到"回复都发完了还在显示对方正在输入"。
    const fromUserId = this.replyTargets.get(sessionId);
    if (fromUserId) {
      await this.stopTyping(fromUserId);
    } else {
      // 反查不到接收人（会话刚被外部回收之类），退化为全清，
      // 宁可多发一次 CANCEL，也不能留一个永不熄灭的"正在输入"
      for (const key of [...this.typingTimers.keys()]) await this.stopTyping(key);
    }

    if (!fromUserId) {
      logger.debug(`bridge: no reply target for session=${sessionId}, skip`);
      return;
    }

    // 流式模式下，这部分内容已经陆续发出去了，这里只把尾巴补完
    if (this.streamWriter && this.streamedSessions.has(sessionId)) {
      const stat = this.streamStats.get(sessionId);
      if (stat) {
        logger.info(`stream: chunk 统计 session=${sessionId} ${JSON.stringify(stat)}`);
        this.streamStats.delete(sessionId);
      }
      this.streamedSessions.delete(sessionId);
      this.thinkingOpen.delete(sessionId);
      await this.streamWriter.close(sessionId);
      await this.retryFailedParts(sessionId);
      await this.flushOutboundFiles(sessionId, agent, turn, fromUserId);
      return;
    }

    const text = this.extractAssistantText(agent, turn);
    if (!text) {
      logger.debug(`bridge: session=${sessionId} produced no assistant text, skip`);
      return;
    }

    const parts = chunkText(text, this.cfg.outbound?.textChunkLimit ?? WECHAT_TEXT_LIMIT);
    for (let i = 0; i < parts.length; i += 1) {
      await this.sendText(sessionId, parts[i], `${i + 1}/${parts.length}`);
    }

    await this.retryFailedParts(sessionId);
    await this.flushOutboundFiles(sessionId, agent, turn, fromUserId);
  }

  /**
   * 收尾时统一补发之前失败的片段。
   *
   * 频控有恢复窗口，回合结束时再试一次通常能成；仍失败就明确告知用户
   * "有内容没发出去"，而不是让它静默消失。
   *
   * @param {string} sessionId - 会话 ID
   * @returns {Promise<void>}
   */
  async retryFailedParts(sessionId) {
    const list = this.failedParts.get(sessionId);
    if (!list || list.length === 0) return;
    this.failedParts.delete(sessionId);

    const still = [];
    for (const part of list) {
      // 补发必须走统一的时隙队列，不能自己固定 sleep：
      // 它和正常发送是并发的（`flushOutbound` 收尾时两者可能同时进行），
      // 各睡各的就会在同一时刻一起发出去，正好撞平台频控。
      await this.respectSendGap();
      try {
        const fromUserId = this.replyTargets.get(sessionId);
        const account = fromUserId ? this.channel.getAccountForSender(fromUserId) : undefined;
        if (!account || !fromUserId) {
          still.push(part);
          continue;
        }
        const contextToken =
          this.channel.getContextToken(fromUserId) ?? getContextToken(account.accountId, fromUserId);
        await sendMessage({
          baseUrl: account.baseUrl,
          token: account.token,
          body: {
            msg: {
              from_user_id: "",
              to_user_id: fromUserId,
              client_id: generateClientId(),
              message_type: 2,
              message_state: 2,
              item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: part.text } }],
              context_token: contextToken || undefined,
              run_id: this.runIds.get(sessionId) ?? undefined,
            },
          },
        });
        this.lastSentAt = Date.now();
        logger.info(`bridge: 补发成功${part.label} len=${part.text.length}`);
      } catch (err) {
        still.push(part);
        logger.warn(`bridge: 补发仍失败${part.label}: ${String(err)}`);
      }
    }

    if (still.length === 0) return;
    this.failedParts.set(sessionId, still);
    const lostChars = still.reduce((n, p) => n + p.text.length, 0);
    try {
      await this.sendText(sessionId, `（有 ${still.length} 段共 ${lostChars} 字没能发出，建议让我重发一次）`, "lost-notice");
    } catch {
      // 连提示都发不出去就放弃，避免无限循环
    }
  }

  /**
   * 发送一段纯文本到会话对应的微信用户。
   *
   * @param {string} sessionId - 会话 ID
   * @param {string} text - 文本
   * @param {string} [marker] - 日志标记（如分段序号）
   * @returns {Promise<void>}
   */
  async sendText(sessionId, text, marker) {
    const fromUserId = this.replyTargets.get(sessionId);
    if (!fromUserId || !text) return;

    const account = this.channel.getAccountForSender(fromUserId);
    if (!account) {
      logger.warn(`bridge: no account for sender=${fromUserId}, cannot reply`);
      return;
    }

    const contextToken =
      this.channel.getContextToken(fromUserId) ?? getContextToken(account.accountId, fromUserId);

    const label = marker ? ` part=${marker}` : "";
    let lastErr;
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt += 1) {
      // 相邻发送必须留间隔：平台对「短时间连发多个气泡」有频控，
      // 超了只回 `ret=-2 prepare failed`，且内容直接丢失（不是排队）。
      await this.respectSendGap();
      try {
        await sendMessage({
          baseUrl: account.baseUrl,
          token: account.token,
          // 请求体必须包在 `msg` 里，且带 `client_id`——否则服务端只回
          // `ret=-2 invalid arguments`，看不出是哪个字段的问题
          body: {
            msg: {
              from_user_id: "",
              to_user_id: fromUserId,
              client_id: generateClientId(),
              message_type: 2, // BOT
              message_state: 2, // FINISH
              item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text } }],
              context_token: contextToken || undefined,
              run_id: this.runIds.get(sessionId) ?? undefined,
            },
          },
        });
        this.lastSentAt = Date.now();
        logger.info(
          `bridge: reply sent account=${account.accountId} to=${fromUserId}`
            + `${label} len=${text.length}`,
        );
        return;
      } catch (err) {
        lastErr = err;
        const retriable = isRetriableSendError(err);
        if (!retriable || attempt === SEND_MAX_ATTEMPTS) break;
        const wait = SEND_RETRY_BACKOFF_MS[attempt - 1] ?? 5_000;
        logger.warn(
          `bridge: 发送失败${label} attempt=${attempt}/${SEND_MAX_ATTEMPTS} `
            + `len=${text.length}, ${wait}ms 后重试: ${String(err)}`,
        );
        await sleep(wait);
      }
    }

    // 彻底失败就把内容暂存，收尾时再试一次，避免用户看到"回答缺段"
    this.pushFailedPart(sessionId, text, label);
    logger.error(`bridge: 发送最终失败${label} len=${text.length}: ${String(lastErr)}`);
  }

  /**
   * 保证相邻两次发送至少间隔 `sendGapMs`。
   *
   * **必须是"占位"语义，不能只读时间戳再睡**：原实现是
   * 「读 lastSentAt → sleep(wait) → 发送 → 写 lastSentAt」的跨 await 序列，
   * 两个会话并发时会在同一时刻读到同一个 lastSentAt、算出同一个 wait、
   * 一起醒来一起发送，间隔保护直接失效——平台侧表现是 `ret=-2 prepare failed`
   * 且**内容被丢弃**（实测 5 条并发全部落在 1ms 内）。
   *
   * 现在改为串行化「等时隙 → 重算时隙」：用一条 promise 链把并发调用排成队，
   * 每次调用在链内独占，等到自己的时隙后才把下一时隙推出去。
   *
   * 两个细节都不能省：
   *   - **醒后校时**：Node 的 `setTimeout` 在 Windows 上会提前 ~7ms 触发，
   *     单次 sleep 可能"睡不够"，间隔被吃掉后仍会撞频控。
   *   - **从真实唤醒时刻起算下一时隙**（而非固定 `slot + gap`）：
   *     否则定时器误差会沿队列累积，长回复分段发送时整体越走越慢。
   *
   * @returns {Promise<void>}
   */
  async respectSendGap() {
    const gap = this.cfg.outbound?.sendGapMs ?? DEFAULT_SEND_GAP_MS;
    if (!(gap > 0)) return;

    // 排队：把自己挂在队尾，前一个释放后才继续
    const prev = this.sendSlotChain;
    let release;
    this.sendSlotChain = new Promise((resolve) => {
      release = resolve;
    });
    await prev;

    try {
      const target = Math.max(Date.now(), this.nextSendAt || 0);
      let wait = target - Date.now();
      while (wait > 0) {
        await sleep(wait);
        wait = target - Date.now();
      }
      this.nextSendAt = Date.now() + gap;
    } finally {
      // 必须在 finally 释放：sleep 期间插件可能被 dispose，
      // 漏释放会让后续所有发送永久卡在 `await prev` 上。
      release();
    }
  }

  /**
   * 把发送失败的片段压入待补发队列。
   *
   * @param {string} sessionId - 会话 ID
   * @param {string} text - 内容
   * @param {string} label - 日志标记
   * @returns {void}
   */
  pushFailedPart(sessionId, text, label) {
    const list = this.failedParts.get(sessionId) ?? [];
    // 只留最近几条，防止异常情况下无限堆积
    if (list.length >= MAX_FAILED_PARTS) list.shift();
    list.push({ text, label, at: Date.now() });
    this.failedParts.set(sessionId, list);
  }

  /**
   * 把本回合里 Agent 产出的本地文件发回微信。
   *
   * 两个来源，取并集：
   *   1. **写文件类工具调用**（`write` / `edit` / `bash` 等）的参数里出现的路径
   *      —— 这是主要来源，因为 Agent 通常只在正文里说"已生成"，不写绝对路径
   *   2. 回复正文里出现的绝对路径（用户点名要某个文件时常见）
   *
   * 只发本来属于"产出物"的文件：工具入参里读到的源码不该被回传。
   *
   * @param {string} sessionId - 会话 ID
   * @param {object} agent - Agent 实例
   * @param {number} [turn] - 回合号
   * @param {string} fromUserId - 接收者
   * @returns {Promise<void>}
   */
  async flushOutboundFiles(sessionId, agent, turn, fromUserId) {
    if (this.cfg.media?.outbound === false) return;

    const account = this.channel.getAccountForSender(fromUserId);
    if (!account) return;

    const candidates = this.collectProducedFiles(agent, turn);
    if (candidates.size === 0) {
      logger.debug(`bridge: 本回合无产出文件 session=${sessionId}`);
      return;
    }

    for (const filePath of candidates) {
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size === 0) continue;
        await this.sendMediaFile(sessionId, filePath, account, fromUserId);
      } catch (err) {
        logger.warn(`bridge: 发送文件失败 ${filePath}: ${String(err)}`);
      }
    }
  }

  /**
   * 收集本回合 Agent 产出的文件路径。
   *
   * @param {object} agent - Agent 实例
   * @param {number} [turn] - 回合号
   * @returns {Set<string>} 路径集合
   */
  collectProducedFiles(agent, turn) {
    const out = new Set();
    const session = agent?.session;
    const events =
      typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];

    /** 写文件类工具名（DSH 内建工具的命名）。 */
    const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "create_file"]);

    for (const ev of events) {
      if (ev?.type !== "tool/call") continue;
      const data = ev.data;
      if (!data) continue;
      if (turn !== undefined && data.turn !== turn) continue;

      const name = String(data.name ?? "").toLowerCase();
      if (!WRITE_TOOLS.has(name)) continue;

      // arguments 是 JSON 字符串，解析失败不影响其它事件
      let args;
      try {
        args = typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments;
      } catch {
        continue;
      }
      if (!args || typeof args !== "object") continue;

      // 不同工具用的键名不同，全都试一遍
      for (const key of ["file_path", "path", "filePath", "filename", "target_file"]) {
        const v = args[key];
        if (typeof v === "string" && v && path.extname(v)) out.add(v);
      }
    }

    // 正文里的绝对路径作为补充（用户明确要文件时 Agent 会写出来）
    const text = this.extractAssistantText(agent, turn);
    if (text) {
      const re = /(?:[A-Za-z]:[\\/][^\s"'`<>|]+|\/[^\s"'`<>|]+)/g;
      for (const m of text.matchAll(re)) {
        const p = m[0].replace(/[.,;:)\]】」』]+$/, "");
        if (path.extname(p)) out.add(p);
      }
    }

    return out;
  }

  /**
   * 上传并发送一个本地文件。
   *
   * @param {string} sessionId - 会话 ID
   * @param {string} filePath - 本地路径
   * @param {object} account - 账号
   * @param {string} fromUserId - 接收者
   * @returns {Promise<void>}
   */
  async sendMediaFile(sessionId, filePath, account, fromUserId) {
    const mime = guessMime(filePath);
    const kind = classifyMime(mime);

    logger.info(`bridge: 上传媒体 ${path.basename(filePath)} kind=${kind} mime=${mime}`);
    const uploaded = await uploadMedia({ filePath, toUserId: fromUserId, account, kind });

    const item =
      kind === "image"
        ? buildImageItem(uploaded)
        : kind === "video"
          ? buildVideoItem(uploaded)
          : buildFileItem(uploaded, path.basename(filePath));

    const contextToken =
      this.channel.getContextToken(fromUserId) ?? getContextToken(account.accountId, fromUserId);
    const name = path.basename(filePath);

    let lastErr;
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt += 1) {
      // 媒体和文本共用同一条频控通道，也必须留间隔
      await this.respectSendGap();
      try {
        const resp = await sendMessage({
          baseUrl: account.baseUrl,
          token: account.token,
          body: {
            msg: {
              from_user_id: "",
              to_user_id: fromUserId,
              client_id: generateClientId(),
              message_type: 2,
              message_state: 2,
              item_list: [item],
              context_token: contextToken || undefined,
              run_id: this.runIds.get(sessionId) ?? undefined,
            },
          },
        });
        this.lastSentAt = Date.now();
        logger.info(
          `bridge: 媒体已发送 kind=${kind} name=${name} size=${uploaded.fileSize} `
            + `message_id=${resp?.message_id ?? "(none)"}`,
        );
        return;
      } catch (err) {
        lastErr = err;
        if (!isRetriableSendError(err) || attempt === SEND_MAX_ATTEMPTS) break;
        const wait = SEND_RETRY_BACKOFF_MS[attempt - 1] ?? 5_000;
        logger.warn(
          `bridge: 媒体发送失败 name=${name} attempt=${attempt}/${SEND_MAX_ATTEMPTS}, `
            + `${wait}ms 后重试: ${String(err)}`,
        );
        await sleep(wait);
      }
    }

    logger.error(`bridge: 媒体发送最终失败 name=${name} size=${uploaded.fileSize}: ${String(lastErr)}`);
  }

  /**
   * 从 Agent 的会话日志里取最后一条 assistant 文本。
   *
   * 直接读 `agent.session` 的事件流，避免自己维护一份累积缓冲
   * （流式增量与最终消息会重复，日志才是单一事实来源）。
   *
   * @param {object} agent - Agent 实例
   * @returns {string} 文本（无则空串）
   */
  /**
   * 取本回合的 Assistant 回复文本。
   *
   * 两个关键点：
   *   1. 读事件要用 `session.snapshotEvents()`——`session.events` 不存在。
   *   2. 必须按 `turn` 过滤。只取"最近一条"会在 Agent 因工具调用连续产出多条
   *      assistant 消息时重发旧内容。
   *
   * @param {object} agent - Agent 实例
   * @param {number} [turn] - 限定回合号；缺省则取最后一条
   * @returns {string} 文本（无则空串）
   */
  extractAssistantText(agent, turn) {
    try {
      const session = agent.session;
      const events =
        typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];

      // 思考过程默认不外发：内容长、含大量自我纠偏，给最终用户看观感很差。
      const withThinking = this.cfg.replyThinking === true;

      const texts = [];
      for (const ev of events) {
        if (ev?.type !== "assistant/message") continue;
        const data = ev.data;
        if (!data) continue;
        // turn 缺失时不限回合（兜底），有则精确命中
        if (turn !== undefined && data.turn !== turn) continue;
        const blocks = Array.isArray(data.message?.content) ? data.message.content : [];

        const parts = blocks.filter(
          (b) => typeof b?.text === "string"
            && (b.type === "text" || (withThinking && b.type === "reasoning")),
        );
        // 同一块集合里，思考在前、正文在后，按原顺序拼即可。
        // 开启思考时给 reasoning 块加一行前缀，否则用户分不清哪段是思考、
        // 哪段是正式回答（微信里没有样式可以区分）。
        const text = parts
          .map((b) => (b.type === "reasoning" ? `【思考】\n${b.text}` : b.text))
          .join("")
          .trim();
        // 同回合可能分多步产出（含工具调用），全部拼上
        if (text) texts.push(text);
      }
      return texts.join("\n\n").trim();
    } catch (err) {
      logger.warn(`extractAssistantText failed: ${String(err)}`);
    }
    return "";
  }

  /**
   * 开始周期发送"正在输入"。
   *
   * typing 必须先用 `getConfig` 换一个 `typing_ticket`，服务端不带这张票据
   * 一律回 `ret=-3 typing_ticket required`。票据按 (账号, 用户) 缓存，
   * 省掉每次刷新都多打一次 getConfig。
   *
   * @param {string} accountId - 账号 ID
   * @param {string} toUserId - 接收者
   * @returns {void}
   */
  startTyping(accountId, toUserId) {
    // 这里只做同步清理，**不发 CANCEL**：紧接着就要重新发 TYPING，
    // 先撤销再开启会多打一次请求，而且异步的 cancel 可能晚于新的 TYPING
    // 到达服务端，把刚点亮的状态又给熄了。
    this.clearTypingTimer(toUserId);
    const account = this.channel.getAccountForSender(toUserId);
    if (!account?.token) return;

    // ticket 拿不到就整轮放弃：typing 只是锦上添花，不值得为它拖垮回合。
    // 之前漏了这一步，结果是每 5s 一次失败请求把日志刷满，且功能静默失效。
    let disabled = false;

    const ensureTicket = async () => {
      const cacheKey = `${account.accountId}|${toUserId}`;
      const cached = this.typingTickets.get(cacheKey);
      if (cached) return cached;

      const contextToken =
        this.channel.getContextToken(toUserId) ?? getContextToken(account.accountId, toUserId);
      if (!contextToken) return "";

      const resp = await getConfig({
        baseUrl: account.baseUrl,
        token: account.token,
        ilinkUserId: toUserId,
        contextToken,
      });
      const ticket = typeof resp?.typing_ticket === "string" ? resp.typing_ticket : "";
      if (ticket) this.typingTickets.set(cacheKey, ticket);
      return ticket;
    };

    const sendStatus = async (status) => {
      const ticket = await ensureTicket();
      if (!ticket) return false;
      await sendTyping({
        baseUrl: account.baseUrl,
        token: account.token,
        // 字段名是 `ilink_user_id`，不是 `to_user_id`
        body: { ilink_user_id: toUserId, status, typing_ticket: ticket },
      });
      return true;
    };

    const ping = async () => {
      if (disabled) return;
      try {
        if (!(await sendStatus(TypingStatus.TYPING))) {
          disabled = true;
          logger.debug("typing: 未取得 typing_ticket，本轮关闭 typing");
        }
      } catch (err) {
        disabled = true;
        logger.debug(`typing ping failed（本轮关闭）: ${String(err)}`);
      }
    };

    ping();
    const timer = setInterval(ping, TYPING_REFRESH_MS);
    timer.unref?.();

    this.typingTimers.set(toUserId, {
      timer,
      // 只 clearInterval 是不够的：微信侧的"正在输入"是**服务端状态**，
      // 停发心跳并不会让它消失，它会一直挂着（用户看到"对方一直在输入"）。
      // 必须再发一次 status=2 主动撤销。
      cancel: async () => {
        if (disabled) return;
        disabled = true;
        try {
          await sendStatus(TypingStatus.CANCEL);
          logger.info(`typing: 已撤销正在输入 to=${toUserId}`);
        } catch (err) {
          logger.warn(`typing cancel failed to=${toUserId}: ${String(err)}`);
        }
      },
    });
  }

  /**
   * 只清定时器，不撤销服务端状态（同步）。
   *
   * @param {string} key - toUserId
   * @returns {object|undefined} 被移除的条目（含 `cancel`）
   */
  clearTypingTimer(key) {
    const entry = this.typingTimers.get(key);
    if (!entry) return undefined;
    clearInterval(entry.timer);
    this.typingTimers.delete(key);
    return entry;
  }

  /**
   * 停止"正在输入"。
   *
   * 清定时器 + 主动发 `status=2` 撤销服务端状态，两步缺一不可——
   * 只停心跳的话微信侧会一直显示"对方正在输入"。
   *
   * @param {string} key - toUserId
   * @returns {Promise<void>}
   */
  async stopTyping(key) {
    const entry = this.clearTypingTimer(key);
    await entry?.cancel?.();
  }

  /**
   * 全局设定变更后调用：让"下一条消息开新会话"。
   *
   * 系统提示在会话里是**已固化的历史**（`system/message` 属 SurfaceEvent，
   * 写进去后一直作为上下文复用）。所以改设定只重新注册 section 是没用的，
   * 已有会话永远拿旧的。换一个会话 ID 就能拿到重新组装过的系统提示。
   *
   * 旧会话不删除、不销毁，只是不再续用；在 Web UI 里仍可打开回看。
   *
   * @returns {void}
   */
  invalidatePrompt() {
    this.promptGen += 1;
    logger.info(`bridge: 全局设定已变更，下次消息将开新会话 (gen=${this.promptGen})`);
  }

  /**
   * 释放全部资源：停 typing、销毁本桥接创建的 Agent。
   *
   * @returns {Promise<void>}
   */
  async dispose() {
    for (const key of [...this.typingTimers.keys()]) await this.stopTyping(key);

    // 先把流式缓冲里没发完的内容冲出去，再销毁 Agent
    if (this.streamWriter) {
      try {
        await this.streamWriter.closeAll();
      } catch (err) {
        logger.warn(`bridge: close stream buffers failed: ${String(err)}`);
      }
    }

    const handles = [...this.agents.values()];
    this.agents.clear();
    this.replyTargets.clear();
    this.mediaDirs.clear();
    this.streamedSessions.clear();
    this.thinkingOpen.clear();
    this.streamStats.clear();
    this.typingTickets.clear();
    this.failedParts.clear();
    this.runIds.clear();

    for (const handle of handles) {
      try {
        await handle.dispose();
      } catch (err) {
        logger.warn(`bridge: dispose agent failed: ${String(err)}`);
      }
    }
    logger.info(`bridge: disposed (${handles.length} agent(s))`);
  }
}
