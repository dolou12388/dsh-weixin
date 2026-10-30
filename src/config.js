/**
 * 插件配置定义。
 *
 * DSH 的配置校验由 schemastery 完成。为避免在无 schemastery 环境下加载失败，
 * 这里提供一份纯 JS 的默认值与归一化逻辑，schema 在可用时另行挂载。
 */

/**
 * 默认配置。
 *
 * 字段语义与上游 `config/config-schema.js` 对齐，额外增加 DSH 专属的出站与会话选项。
 */
export const DEFAULT_CONFIG = {
  /** 是否启用通道。 */
  enabled: true,
  /** 出站策略：final（整段）| stream（增量）。 */
  outbound: {
    mode: "final",
    /** stream 模式下的合并阈值，沿用上游默认。 */
    minChars: 1600,
    /** stream 模式下的空闲合并窗口（毫秒）。 */
    idleMs: 3000,
    /** 单条消息最大字符数。 */
    textChunkLimit: 4000,
    /**
     * 相邻出站消息最小间隔（毫秒）。
     *
     * 平台对短时间连发多个气泡有频控，触发后回 `ret=-2 prepare failed`
     * 并直接丢内容。流式出站一次回复可能十几段，必须留间隔。
     */
    sendGapMs: 500,
  },
  /** 是否发送工具调用进度提示。 */
  replyProgressMessages: true,
  /**
   * 是否把模型的思考过程（reasoning 块）一起发到微信。
   *
   * 默认**关闭**。思考内容通常很长且包含大量自我纠偏、试错，直接发给最终用户
   * 观感很差；调试提示词或排查"模型为什么这么答"时才需要打开。
   */
  replyThinking: false,
  /** 是否显示"正在输入"。 */
  typingIndicator: true,
  /**
   * 要禁用的工具名列表；留空则用内置的"微信不可用"清单。
   *
   * 微信不是交互式 UI，`ask_user_question` 这类需要弹窗的工具调用后会一直挂着。
   */
  toolDeny: [],
  /** 允许发送消息的微信用户 ID 白名单；为空表示不限制（仅 DM）。 */
  allowFrom: [],
  /** 会话映射策略。 */
  session: {
    /** single：每个用户固定一个会话；per-message：每条消息一个新会话。 */
    mode: "single",
    /** 会话工作目录；留空则使用 DSH 默认 workspace。 */
    cwd: "",
    /** 会话 ID 前缀，避免与 Web UI 会话冲突。 */
    idPrefix: "weixin",
    /**
     * Agent 预设 ID；留空则用 DSH 的默认预设。
     *
     * 不挂预设的 Agent 只有模型没有工具，表现是"能对话但从不写文件"。
     */
    agentPreset: "",
  },
  /** 通道级配置（对齐上游 channel 段）。 */
  channel: {
    /** 灰度路由标记。 */
    routeTag: "",
    /** 写入 base_info.bot_agent 的值。 */
    botAgent: "",
    /** 单账号覆盖。 */
    accounts: {},
  },
  /**
   * 全局设定：注入到 Agent 系统提示的文本。
   *
   * 空串表示不注入。支持 `{{weixin.accountId}}` 等占位符，
   * 见 `src/bridge/global-prompt.js` 的 `interpolatePlaceholders`。
   */
  globalPrompt: "",
  /** 按账号的附加设定（键为 accountId）。 */
  globalPromptByAccount: {},
  /** 媒体收发开关。 */
  media: {
    /** 允许接收图片/语音/文件/视频并转成本地文件交给 Agent。 */
    inbound: true,
    /** 允许把 Agent 产出的本地文件自动发回微信。 */
    outbound: true,
    /** 媒体落盘目录；留空则用 `$DSH_HOME/storages/dsh-weixin/media`。 */
    dir: "",
  },
};

/**
 * 深合并配置。
 *
 * @param {object} base - 默认值
 * @param {object} override - 用户配置
 * @returns {object} 合并结果
 */
export function mergeConfig(base, override) {
  if (!override || typeof override !== "object") return { ...base };

  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const prev = base[key];
    if (
      prev &&
      typeof prev === "object" &&
      !Array.isArray(prev) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = mergeConfig(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 归一化用户配置，补齐默认值。
 *
 * @param {object} [config] - 原始配置
 * @returns {object} 归一化后的配置
 */
export function normalizeConfig(config) {
  const merged = mergeConfig(DEFAULT_CONFIG, config ?? {});

  // 白名单去空去重
  merged.allowFrom = Array.isArray(merged.allowFrom)
    ? [...new Set(merged.allowFrom.map((v) => String(v).trim()).filter(Boolean))]
    : [];

  // 出站模式兜底
  if (merged.outbound.mode !== "stream") merged.outbound.mode = "final";
  if (!Number.isFinite(merged.outbound.minChars) || merged.outbound.minChars <= 0) {
    merged.outbound.minChars = DEFAULT_CONFIG.outbound.minChars;
  }
  if (!Number.isFinite(merged.outbound.idleMs) || merged.outbound.idleMs <= 0) {
    merged.outbound.idleMs = DEFAULT_CONFIG.outbound.idleMs;
  }
  if (!Number.isFinite(merged.outbound.textChunkLimit) || merged.outbound.textChunkLimit <= 0) {
    merged.outbound.textChunkLimit = DEFAULT_CONFIG.outbound.textChunkLimit;
  }

  // 会话模式兜底
  if (merged.session.mode !== "per-message") merged.session.mode = "single";
  if (!merged.session.idPrefix) merged.session.idPrefix = "weixin";

  // 全局设定归一化：非字符串一律按空处理，避免把对象塞进系统提示
  merged.globalPrompt =
    typeof merged.globalPrompt === "string" ? merged.globalPrompt : "";
  if (
    !merged.globalPromptByAccount ||
    typeof merged.globalPromptByAccount !== "object" ||
    Array.isArray(merged.globalPromptByAccount)
  ) {
    merged.globalPromptByAccount = {};
  }

  // 媒体开关兜底
  if (!merged.media || typeof merged.media !== "object") {
    merged.media = { ...DEFAULT_CONFIG.media };
  } else {
    merged.media.inbound = merged.media.inbound !== false;
    merged.media.outbound = merged.media.outbound !== false;
    if (typeof merged.media.dir !== "string") merged.media.dir = "";
  }

  return merged;
}
