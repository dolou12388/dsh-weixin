/**
 * 插件配置定义与归一化。
 *
 * 两条契约（DSH 硬规则 6）：
 *   1. 导出的 `Config` 是 Schemastery schema，默认值写在 schema 里；
 *      不要导出普通对象充当 Config —— Cordis 用 `Config["~standard"].validate()`
 *      校验，普通对象没有该接口会被直接忽略，配置校验就形同虚设。
 *   2. **默认值不得被下发的 cfg 修改**。历史实现里 `mergeConfig` 只做浅拷贝，
 *      嵌套对象（`outbound` / `session` / `media` / `channel`）会与 `DEFAULT_CONFIG`
 *      共享同一个引用；UI 热更新就地改 `cfg.outbound.mode` 时，被改的其实是
 *      默认值本身，于是同一进程内后续任何一次 `normalizeConfig({})` 都会拿到
 *      被污染的默认值，「恢复默认」也回不到出厂值。现在统一返回深拷贝。
 *
 * **关于 schemastery 的加载方式**：它被声明为 `dependencies`，正常安装一定有；
 * 但本插件曾被从 GitHub 直接安装过，而某些 profile 的 pnpm 解析会漏装它，
 * 表现为 `ERR_MODULE_NOT_FOUND`——插件连模块都进不去，比配置不校验严重得多。
 * 因此改为**同步 require（可选）+ 手写 `~standard` 兜底**：
 *   - 有 schemastery：用它，得到完整的类型/范围校验；
 *   - 没有：退化为手写校验器，仍能在加载期拒绝非法枚举值，只是范围检查变弱。
 * 用 `createRequire` 而非顶层 `import`，就是为了让缺包变成"降级"而不是"崩溃"。
 */
import { createRequire } from "node:module";
import { normalizeClockText } from "./auto-send/time-window.js";

const require = createRequire(import.meta.url);

/**
 * 尝试加载 schemastery。
 *
 * @returns {object|null} Schema 构造器；不可用时返回 null
 */
function loadSchema() {
  try {
    const mod = require("@deepseek-ai/schemastery");
    const Schema = mod?.default ?? mod;
    return typeof Schema?.object === "function" ? Schema : null;
  } catch {
    return null;
  }
}

const Schema = loadSchema();

/**
 * 单个微信文本项的上限。服务端在 4000 字符处硬截断，超过会被切掉。
 */
const WECHAT_TEXT_LIMIT = 4000;

/** 单条配置文本（全局设定）的字节上限。 */
const GLOBAL_PROMPT_MAX_BYTES = 64 * 1024;

/**
 * 出站模式的合法取值。
 */
export const OUTBOUND_MODES = ["final", "stream"];

/**
 * 会话模式的合法取值。
 */
export const SESSION_MODES = ["single", "per-message"];

/**
 * 默认配置（出厂值）。
 *
 * 只用于文档与归一化兜底；**不要**把它当作可变对象使用。
 * `normalizeConfig` 会深拷贝后再交给调用方。
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
    textChunkLimit: WECHAT_TEXT_LIMIT,
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
    /**
     * 插件加载时自动拉起轮询。
     *
     * 默认开启。否则 DSH 每次重启（更新、崩溃、手动重启）后都要去设置页
     * 手动点一次「启动」，这段时间消息不会被接收；而自动发送走 `ctx.effect`
     * 会自动启动，两者行为不一致会造成"看起来在跑"的误判。
     */
    autoStart: true,
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
  /**
   * 自动发送（随机骰子冒泡）。
   *
   * 语义：在允许的时间段内按节奏"掷骰子"，命中则让 Agent 主动生成一条
   * 消息发出去。基础节奏命中后切到活跃节奏，活跃节奏连续命中会累积
   * `maxStreak`，达到上限后强制冷却，避免刷屏。
   *
   * 默认**关闭**——主动对外发消息属于有外部副作用的动作，
   * 必须由用户显式打开。
   */
  autoSend: {
    /** 总开关。 */
    enabled: false,
    /** 允许发送的起始时刻（`HH:MM`，含）。 */
    startTime: "09:00",
    /** 允许发送的结束时刻（`HH:MM`，不含）。与起始相同表示全天。 */
    endTime: "23:00",
    /** 基础节奏：每隔多少分钟掷一次骰子。 */
    baseIntervalMin: 30,
    /** 活跃节奏：命中发送后，改成每隔多少分钟掷一次。 */
    activeIntervalMin: 5,
    /** 单次掷骰的命中概率（0–1）。 */
    hitRate: 0.2,
    /** 连续命中多少次后强制冷却。 */
    maxStreak: 5,
    /** 冷却时长（分钟）。 */
    cooldownMin: 120,
    /** 指定接收者 userId；留空则用最近互动过的用户。 */
    targets: [],
    /** 单条自动消息的最大字符数，超出截断。 */
    maxChars: 120,
    /** 生成指令；留空使用内置默认指令。 */
    instruction: "",
  },
};

/**
 * 构造配置 schema。
 *
 * 默认值全部取自 `DEFAULT_CONFIG`，二者不会漂移。
 *
 * @returns {object} Schemastery schema
 */
function buildSchemasteryConfig() {
  return Schema.object({
    enabled: Schema.boolean().default(DEFAULT_CONFIG.enabled),
    outbound: Schema.object({
      mode: Schema.union(OUTBOUND_MODES).default(DEFAULT_CONFIG.outbound.mode),
      minChars: Schema.natural()
        .min(1)
        .max(20000)
        .default(DEFAULT_CONFIG.outbound.minChars),
      idleMs: Schema.natural()
        .min(100)
        .max(60000)
        .default(DEFAULT_CONFIG.outbound.idleMs),
      textChunkLimit: Schema.natural()
        .min(200)
        .max(WECHAT_TEXT_LIMIT)
        .default(DEFAULT_CONFIG.outbound.textChunkLimit),
      sendGapMs: Schema.natural()
        .max(10000)
        .default(DEFAULT_CONFIG.outbound.sendGapMs),
    }).default(DEFAULT_CONFIG.outbound),
    replyProgressMessages: Schema.boolean().default(DEFAULT_CONFIG.replyProgressMessages),
    replyThinking: Schema.boolean().default(DEFAULT_CONFIG.replyThinking),
    typingIndicator: Schema.boolean().default(DEFAULT_CONFIG.typingIndicator),
    toolDeny: Schema.array(Schema.string()).default(DEFAULT_CONFIG.toolDeny),
    allowFrom: Schema.array(Schema.string()).default(DEFAULT_CONFIG.allowFrom),
    session: Schema.object({
      mode: Schema.union(SESSION_MODES).default(DEFAULT_CONFIG.session.mode),
      cwd: Schema.string().default(DEFAULT_CONFIG.session.cwd),
      idPrefix: Schema.string().default(DEFAULT_CONFIG.session.idPrefix),
      agentPreset: Schema.string().default(DEFAULT_CONFIG.session.agentPreset),
    }).default(DEFAULT_CONFIG.session),
    channel: Schema.object({
      routeTag: Schema.union([Schema.string(), Schema.number()]).default(
        DEFAULT_CONFIG.channel.routeTag,
      ),
      botAgent: Schema.string().default(DEFAULT_CONFIG.channel.botAgent),
      autoStart: Schema.boolean().default(DEFAULT_CONFIG.channel.autoStart),
      accounts: Schema.dict(Schema.any()).default(DEFAULT_CONFIG.channel.accounts),
    }).default(DEFAULT_CONFIG.channel),
    globalPrompt: Schema.string()
      // 全局设定会整段注入系统提示，超长会挤掉真正的上下文。
      // Schemastery 的 min/max 按字符串长度算，中文一字一码点，
      // 故按 3 字节/字的保守估算折半，宁严勿松。
      .max(Math.floor(GLOBAL_PROMPT_MAX_BYTES / 3))
      .default(DEFAULT_CONFIG.globalPrompt),
    globalPromptByAccount: Schema.dict(Schema.string()).default(
      DEFAULT_CONFIG.globalPromptByAccount,
    ),
    media: Schema.object({
      inbound: Schema.boolean().default(DEFAULT_CONFIG.media.inbound),
      outbound: Schema.boolean().default(DEFAULT_CONFIG.media.outbound),
      dir: Schema.string().default(DEFAULT_CONFIG.media.dir),
    }).default(DEFAULT_CONFIG.media),
    autoSend: Schema.object({
      enabled: Schema.boolean().default(DEFAULT_CONFIG.autoSend.enabled),
      // 时间用 `HH:MM` 字符串而非整数分钟：UI 的 <input type="time"> 直接给这个格式，
      // 省一层换算，也让配置文件可读。
      startTime: Schema.string().default(DEFAULT_CONFIG.autoSend.startTime),
      endTime: Schema.string().default(DEFAULT_CONFIG.autoSend.endTime),
      // 上限 1440（一天）：超过一天没有意义，还会让 setTimeout 溢出。
      baseIntervalMin: Schema.natural()
        .min(1)
        .max(1440)
        .default(DEFAULT_CONFIG.autoSend.baseIntervalMin),
      activeIntervalMin: Schema.natural()
        .min(1)
        .max(1440)
        .default(DEFAULT_CONFIG.autoSend.activeIntervalMin),
      hitRate: Schema.number()
        .min(0)
        .max(1)
        .default(DEFAULT_CONFIG.autoSend.hitRate),
      maxStreak: Schema.natural()
        .min(1)
        .max(100)
        .default(DEFAULT_CONFIG.autoSend.maxStreak),
      // 冷却最长 7 天。
      cooldownMin: Schema.natural()
        .min(0)
        .max(10080)
        .default(DEFAULT_CONFIG.autoSend.cooldownMin),
      targets: Schema.array(Schema.string()).default(DEFAULT_CONFIG.autoSend.targets),
      maxChars: Schema.natural()
        .min(10)
        .max(1000)
        .default(DEFAULT_CONFIG.autoSend.maxChars),
      instruction: Schema.string().max(2000).default(DEFAULT_CONFIG.autoSend.instruction),
    }).default(DEFAULT_CONFIG.autoSend),
  });
}

/**
 * 手写校验器的产物形状，对齐 Standard Schema v1。
 *
 * Cordis 只调用 `Config["~standard"].validate(config)`，并要求它**同步**返回
 * `{ value }` 或 `{ issues }`（见 `resolveConfig`：`if ("then" in result) throw`）。
 * 只要满足这条契约，Cordis 并不关心它是不是 schemastery 造的。
 *
 * @param {object} input - 用户配置
 * @returns {{value: object}|{issues: Array<{message: string, path?: Array<string|number>}>}}
 *   校验结果
 */
function validateWithoutSchema(input) {
  const issues = [];

  if (input !== undefined && input !== null && typeof input !== "object") {
    return { issues: [{ message: "config must be an object" }] };
  }
  const raw = input ?? {};

  // 枚举值是最容易写错、后果又最隐蔽的一类（写错后行为静默降级），
  // 缺 schemastery 时也要保住这条校验。
  const mode = raw.outbound?.mode;
  if (mode !== undefined && mode !== null && !OUTBOUND_MODES.includes(mode)) {
    issues.push({
      message: `expected one of ${OUTBOUND_MODES.join(" | ")}`,
      path: ["outbound", "mode"],
    });
  }
  const sessionMode = raw.session?.mode;
  if (sessionMode !== undefined && sessionMode !== null && !SESSION_MODES.includes(sessionMode)) {
    issues.push({
      message: `expected one of ${SESSION_MODES.join(" | ")}`,
      path: ["session", "mode"],
    });
  }

  const globalPrompt = raw.globalPrompt;
  if (typeof globalPrompt === "string"
    && Buffer.byteLength(globalPrompt, "utf8") > GLOBAL_PROMPT_MAX_BYTES) {
    issues.push({
      message: `must be at most ${GLOBAL_PROMPT_MAX_BYTES} bytes`,
      path: ["globalPrompt"],
    });
  }

  if (issues.length > 0) return { issues };
  // 与 schemastery 路径保持一致：返回补全默认值后的深拷贝。
  return { value: normalizeConfig(raw) };
}

/**
 * 插件配置 schema —— Cordis 加载插件时的校验入口。
 *
 * 非法取值（如 `outbound.mode: "x"`）会在**加载阶段**直接抛错，
 * 而不是等到运行到一半才失败，符合"配置错误要响亮"。
 *
 * 未知字段会被保留但不报错，这样升级插件、回退旧配置都不会卡住启动。
 *
 * 有 schemastery 时返回真 schema；没有时返回手写 `~standard` 实现。
 * 两条路径的契约完全一致，对 Cordis 透明。
 */
export const Config = Schema
  ? buildSchemasteryConfig()
  : {
      "~standard": {
        version: 1,
        vendor: "dsh-weixin",
        validate: validateWithoutSchema,
      },
    };

/**
 * 判断是否为可参与深合并的普通对象。
 *
 * 显式排除 null —— `typeof null === "object"`，不排除会让 `{ outbound: null }`
 * 走进合并分支，随后在 `merged.outbound.mode` 处抛 TypeError。
 *
 * @param {unknown} value - 待判断值
 * @returns {boolean} 是否为普通对象
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 深拷贝一个配置值。
 *
 * 数组与普通对象逐层新建；其余（原始值、函数等）原样返回。
 * 目的是切断与 `DEFAULT_CONFIG` 及调用方入参的引用共享。
 *
 * @param {unknown} value - 待拷贝值
 * @returns {unknown} 拷贝结果
 */
export function cloneConfigValue(value) {
  if (Array.isArray(value)) return value.map(cloneConfigValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = cloneConfigValue(item);
    }
    return out;
  }
  return value;
}

/**
 * 深合并配置。
 *
 * `base` 不会被修改：所有嵌套对象都先深拷贝再合并，
 * 因此调用方拿到的结果与 `base` 完全脱钩。
 *
 * @param {object} base - 默认值（不会被写入）
 * @param {object} override - 用户配置
 * @returns {object} 合并结果（全新对象树）
 */
export function mergeConfig(base, override) {
  const out = cloneConfigValue(base);
  if (!isPlainObject(override)) return out;

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = mergeConfig(prev, value);
    } else {
      // 显式传 null 视为"用默认值"，而不是把默认值覆盖成 null，
      // 否则后续任何 `cfg.x.y` 访问都会抛 TypeError。
      out[key] = value === null ? cloneConfigValue(base[key]) : cloneConfigValue(value);
    }
  }
  return out;
}

/**
 * 把任意输入夹成合法整数。
 *
 * @param {unknown} value - 原始值
 * @param {number} fallback - 非法时回退值
 * @param {number} min - 下界
 * @param {number} max - 上界
 * @returns {number} 合法整数
 */
function toBoundedInt(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 把任意输入夹成合法浮点数。
 *
 * 与 `toBoundedInt` 的区别：不做取整。命中率这类 0–1 的概率值
 * 若被四舍五入成 0 或 1，功能会直接退化成"永不发送"或"每次必发"。
 *
 * @param {unknown} value - 原始值
 * @param {number} fallback - 非法时回退值
 * @param {number} min - 下界
 * @param {number} max - 上界
 * @returns {number} 合法浮点数
 */
function toBoundedFloat(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 归一化用户配置，补齐默认值并夹紧非法取值。
 *
 * 与 schema 的分工：schema 在**加载期**拒绝非法配置（响亮失败），
 * 这里在**运行期**对 UI 热更新等旁路来源做宽容修正——
 * 这些来源无法触发 schema 校验，只能在消费点兜底。
 *
 * 不修改入参，也不修改 `DEFAULT_CONFIG`。
 *
 * @param {object} [config] - 原始配置
 * @returns {object} 归一化后的全新配置对象
 */
export function normalizeConfig(config) {
  const merged = mergeConfig(DEFAULT_CONFIG, config);

  // 白名单去空去重。
  // 必须先剔除 null/undefined 再 `String()`：直接 `String(null)` 会得到
  // 字符串 `"null"`，于是白名单里凭空多出一个永不匹配的用户 ID，
  // 而且它非空、不会被下面的 `filter(Boolean)` 拦掉（已实测复现）。
  merged.allowFrom = Array.isArray(merged.allowFrom)
    ? [...new Set(
        merged.allowFrom
          .filter((v) => v !== null && v !== undefined)
          .map((v) => String(v).trim())
          .filter(Boolean),
      )]
    : [];

  // 工具黑名单同理：非字符串项会让 restrict() 整体抛错
  merged.toolDeny = Array.isArray(merged.toolDeny)
    ? [...new Set(
        merged.toolDeny
          .filter((v) => v !== null && v !== undefined)
          .map((v) => String(v).trim())
          .filter(Boolean),
      )]
    : [];

  // 出站参数兜底
  if (merged.outbound.mode !== "stream") merged.outbound.mode = "final";
  merged.outbound.minChars = toBoundedInt(
    merged.outbound.minChars,
    DEFAULT_CONFIG.outbound.minChars,
    1,
    20000,
  );
  merged.outbound.idleMs = toBoundedInt(
    merged.outbound.idleMs,
    DEFAULT_CONFIG.outbound.idleMs,
    100,
    60000,
  );
  merged.outbound.textChunkLimit = toBoundedInt(
    merged.outbound.textChunkLimit,
    DEFAULT_CONFIG.outbound.textChunkLimit,
    200,
    WECHAT_TEXT_LIMIT,
  );
  merged.outbound.sendGapMs = toBoundedInt(
    merged.outbound.sendGapMs,
    DEFAULT_CONFIG.outbound.sendGapMs,
    0,
    10000,
  );

  // 会话模式兜底
  if (merged.session.mode !== "per-message") merged.session.mode = "single";
  if (!merged.session.idPrefix) merged.session.idPrefix = "weixin";
  if (typeof merged.session.cwd !== "string") merged.session.cwd = "";
  if (typeof merged.session.agentPreset !== "string") merged.session.agentPreset = "";

  // 全局设定归一化：非字符串一律按空处理，避免把对象塞进系统提示
  merged.globalPrompt =
    typeof merged.globalPrompt === "string" ? merged.globalPrompt : "";
  if (!isPlainObject(merged.globalPromptByAccount)) {
    merged.globalPromptByAccount = {};
  }

  // 媒体开关兜底
  merged.media.inbound = merged.media.inbound !== false;
  merged.media.outbound = merged.media.outbound !== false;
  if (typeof merged.media.dir !== "string") merged.media.dir = "";

  // 自动发送兜底。先保证是对象：UI 覆盖层若写入 `autoSend: "on"` 这类
  // 非对象值，后面按属性赋值会在 undefined 上抛错，整条配置链失效。
  if (!isPlainObject(merged.autoSend)) {
    merged.autoSend = cloneConfigValue(DEFAULT_CONFIG.autoSend);
  }
  const autoSend = merged.autoSend;
  autoSend.enabled = autoSend.enabled === true;
  autoSend.startTime = normalizeClockText(
    autoSend.startTime,
    DEFAULT_CONFIG.autoSend.startTime,
  );
  autoSend.endTime = normalizeClockText(autoSend.endTime, DEFAULT_CONFIG.autoSend.endTime);
  autoSend.baseIntervalMin = toBoundedInt(
    autoSend.baseIntervalMin,
    DEFAULT_CONFIG.autoSend.baseIntervalMin,
    1,
    1440,
  );
  autoSend.activeIntervalMin = toBoundedInt(
    autoSend.activeIntervalMin,
    DEFAULT_CONFIG.autoSend.activeIntervalMin,
    1,
    1440,
  );
  autoSend.hitRate = toBoundedFloat(
    autoSend.hitRate,
    DEFAULT_CONFIG.autoSend.hitRate,
    0,
    1,
  );
  autoSend.maxStreak = toBoundedInt(autoSend.maxStreak, DEFAULT_CONFIG.autoSend.maxStreak, 1, 100);
  autoSend.cooldownMin = toBoundedInt(
    autoSend.cooldownMin,
    DEFAULT_CONFIG.autoSend.cooldownMin,
    0,
    10080,
  );
  autoSend.maxChars = toBoundedInt(autoSend.maxChars, DEFAULT_CONFIG.autoSend.maxChars, 10, 1000);
  autoSend.targets = Array.isArray(autoSend.targets)
    ? [...new Set(
        autoSend.targets
          .filter((v) => v !== null && v !== undefined)
          .map((v) => String(v).trim())
          .filter(Boolean),
      )]
    : [];
  autoSend.instruction =
    typeof autoSend.instruction === "string" ? autoSend.instruction : "";

  // 通道配置兜底
  if (!isPlainObject(merged.channel.accounts)) merged.channel.accounts = {};
  merged.channel.autoStart = merged.channel.autoStart !== false;

  return merged;
}
