/**
 * 全局设定：把微信通道侧的提示词注入到 Agent 的系统提示中。
 *
 * 三种来源按顺序拼接：
 *   1. `globalPrompt` 配置项（`cordis.patch.yml` 或 UI 写入）
 *   2. 每个账号可选的附加设定（`perAccount[<accountId>]`）
 *   3. 运行期变量：当前通道身份、发送者、账号（用 `{{}}` 占位符引用）
 *
 * 为什么走 `systemPrompt.section()` 而不是自己拼字符串塞进消息里：
 * 只有注册成 section 才会被 `renderPrompt` 正规渲染，并且能被 cordis 生命周期
 * 正确回收。直接改消息内容会污染会话记录，且 Web UI 里看不到。
 *
 * 注意 scope：section 注册在调用方 ctx 的 scope 上。这里注册在插件根部，
 * 所以对所有 Agent 生效——包括 Web UI 里手动开的会话。这是"全局"的本意，
 * 但如果只想作用于微信会话，应改用 `agentCtx`（见 `WeixinBridge.attachPrompt`）。
 */
import { logger } from "../util/logger.js";

/** 全局设定在系统提示里的排序位置。 */
const SECTION_ORDER = 150;

/** 占位符：`{{weixin.sessionId}}` 这类运行期变量。 */
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * 把运行期变量填进设定文本。
 *
 * 未识别的占位符原样保留——静默删掉会让用户以为设定生效了，实则丢了一段。
 *
 * @param {string} text - 原始文本
 * @param {Record<string, string>} vars - 变量表
 * @returns {string} 替换后的文本
 */
export function interpolatePlaceholders(text, vars) {
  if (typeof text !== "string" || text.length === 0) return "";
  return text.replace(PLACEHOLDER_RE, (whole, name) => {
    const value = vars?.[name];
    return value === undefined || value === null ? whole : String(value);
  });
}

/**
 * 组装**全局**设定文本（`globalPrompt` + 占位符）。
 *
 * @param {object} params - 参数
 * @param {object} params.cfg - 归一化配置
 * @param {string} [params.accountId] - 账号 ID
 * @param {string} [params.fromUserId] - 微信发送者
 * @param {string} [params.sessionId] - DSH 会话 ID
 * @param {boolean} [params.onlyAccount] - 只取 perAccount 部分（会话级注册用）
 * @returns {string} 最终文本（无设定时为空串）
 */
export function buildGlobalPrompt(params) {
  const { cfg, accountId, fromUserId, sessionId, onlyAccount } = params;

  const blocks = [];
  // 会话级注册时**不要**再拼 globalPrompt：全局 section 已经注入过一份，
  // 两边都拼会让同一段设定在系统提示里出现两遍（实测确实重复了）。
  const base = onlyAccount ? "" : cfg?.globalPrompt;
  if (typeof base === "string" && base.trim()) blocks.push(base.trim());

  const perAccount = accountId ? cfg?.globalPromptByAccount?.[accountId] : undefined;
  if (typeof perAccount === "string" && perAccount.trim()) blocks.push(perAccount.trim());

  if (blocks.length === 0) return "";

  const vars = {
    "weixin.accountId": accountId ?? "",
    "weixin.fromUserId": fromUserId ?? "",
    "weixin.sessionId": sessionId ?? "",
    "weixin.channel": "weixin",
  };

  return interpolatePlaceholders(blocks.join("\n\n"), vars).trim();
}

/**
 * 全局设定的注册器。
 *
 * 分成两个实例：
 *   - **全局**（`register()`）：注册在插件 ctx 上，对所有 Agent 生效
 *   - **会话级**（`registerFor(agentCtx, ...)`）：注册在 agent ctx 上，只影响该会话
 *
 * 默认用全局，因为"全局设定"这个名字就是这个语义。
 */
export class GlobalPromptRegistry {
  /**
   * @param {object} ctx - 插件上下文
   * @param {object} cfg - 归一化配置
   */
  constructor(ctx, cfg) {
    this.ctx = ctx;
    this.cfg = cfg;
    /** @type {(() => void)|null} 当前注册的 disposer */
    this.disposer = null;
  }

  /**
   * 按当前配置（重新）注册全局 section。
   *
   * 幂等：重复调用会先卸载旧的。设定被清空时直接卸载，不留空 section。
   *
   * @returns {void}
   */
  register() {
    this.unregister();

    const text = buildGlobalPrompt({ cfg: this.cfg });
    if (!text) {
      logger.debug("globalPrompt: empty, section not registered");
      return;
    }

    const systemPrompt = this.ctx.systemPrompt;
    if (typeof systemPrompt?.section !== "function") {
      logger.warn("globalPrompt: systemPrompt service unavailable, skip injection");
      return;
    }

    try {
      this.disposer = systemPrompt.section({
        name: "weixin:global-prompt",
        order: SECTION_ORDER,
        // 已经自己做过占位符替换，交给 renderPrompt 再插值会因为未知变量报错
        text: () => this.currentText(),
        interpolate: false,
      });
      logger.info(`globalPrompt: section registered (${text.length} chars)`);
      // 内容摘要：长度对不上时，光看数字无从判断读的是哪份配置，
      // 把开头打出来能立刻定位（曾出现"配置 332 字、注册 31 字"的诡异情况）
      logger.info(`globalPrompt: preview=${JSON.stringify(text.slice(0, 60))}`);
    } catch (err) {
      logger.error(`globalPrompt: section registration failed: ${String(err)}`);
    }
  }

  /**
   * 当前生效的设定文本（每次 assembly 重新求值，支持热改）。
   *
   * @returns {string} 文本
   */
  currentText() {
    return buildGlobalPrompt({ cfg: this.cfg });
  }

  /**
   * 卸载已注册的 section。
   *
   * @returns {void}
   */
  unregister() {
    if (!this.disposer) return;
    try {
      this.disposer();
      logger.debug("globalPrompt: section unregistered");
    } catch (err) {
      logger.warn(`globalPrompt: unregister failed: ${String(err)}`);
    }
    this.disposer = null;
  }

  /**
   * 设定内容变化后调用：重新注册（内容是懒求值的，一般只需确保已注册）。
   *
   * @returns {void}
   */
  refresh() {
    this.register();
  }
}

/**
 * 为单个 Agent 注册**账号级**设定（perAccount）。
 *
 * 只注册 `globalPromptByAccount` 里该账号的部分——`globalPrompt` 已由
 * 全局 section 注入，这里再拼一遍就会在系统提示里出现两份（实测复现过）。
 *
 * @param {object} agentCtx - Agent 作用域上下文
 * @param {object} cfg - 归一化配置
 * @param {object} binding - 绑定信息
 * @param {string} [binding.accountId] - 账号 ID
 * @param {string} [binding.fromUserId] - 微信发送者
 * @param {string} [binding.sessionId] - 会话 ID
 * @returns {(() => void)|undefined} disposer
 */
export function registerSessionPrompt(agentCtx, cfg, binding) {
  const text = buildGlobalPrompt({ cfg, ...binding, onlyAccount: true });
  if (!text) return undefined;

  const systemPrompt = agentCtx?.systemPrompt;
  if (typeof systemPrompt?.section !== "function") return undefined;

  try {
    return systemPrompt.section({
      name: "weixin:session-prompt",
      order: SECTION_ORDER + 1,
      text,
      interpolate: false,
    });
  } catch (err) {
    logger.warn(`globalPrompt: session section failed: ${String(err)}`);
    return undefined;
  }
}
