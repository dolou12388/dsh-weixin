/**
 * dsh-weixin 插件入口。
 *
 * 范围：插件加载 + `/weixin` 命令 + Web UI 可视化配置路由。
 *
 * 设计约束：
 *   - `inject` 会等待所列服务就绪；服务缺失导致插件永久 pending，故只注入必需项。
 *   - `connection` 仅在 web profile 提供，因此走可选注入（见 `apply` 内 `ctx.inject`），
 *     否则在 headless / acp 等 profile 下插件会卡在 pending。
 *   - DSH 的命令面是 UI 内的 `/name`（`ctx.commands.register`），
 *     而非独立的 `dsh <sub>` 子命令，因此登录入口挂在这里。
 */
import { normalizeConfig } from "./config.js";
import { buildEffectiveConfig, loadSettingsOverlay } from "./config-store.js";
import { setRuntimeConfig } from "./auth/accounts.js";
import { logger, setLogLevel, setConsoleMirror } from "./util/logger.js";
import { resolveDshHome, resolveStoreDir } from "./util/paths.js";
import { assertDshCompatibility } from "./compat.js";
import { WeixinChannel } from "./channel/channel.js";
import { GlobalPromptRegistry } from "./bridge/global-prompt.js";
import { createAutoSendScheduler } from "./auto-send/index.js";
import { registerWeixinCommand } from "./commands/weixin-command.js";
import { registerWeixinRoutes, disposeRoutes } from "./web/routes.js";

/** 当前生效的全局设定注册器（dispose 时需要显式卸载）。 */
let promptRegistry = null;

export const name = "dsh-weixin";

/**
 * 安全读取 UI 设置覆盖层。
 *
 * overlay 属于增强项，读取失败不能拖垮插件启动。
 *
 * @returns {object} 覆盖配置（失败返回空对象）
 */
function loadOverlaySafely() {
  try {
    return loadSettingsOverlay();
  } catch (err) {
    logger.warn(`dsh-weixin: failed to load settings overlay: ${String(err)}`);
    return {};
  }
}

/**
 * 注入的 DSH 服务。
 *
 * 语义：`inject` 里的服务**全部就绪**才会执行 `apply`；缺一个就永久 pending，
 * 插件看起来"装了但没反应"，且不报错。所以这里只放**所有 profile 都提供**的服务。
 *
 * 各服务提供方（已逐个核实 `package.json` 依赖）：
 *   - `agents` / `agentDefaultModel` / `systemPrompt` / `commands` → `dsh-base`，各 profile 都有。
 *   - `workspaceRegistry` → 仅 `dsh-web-app`（`dsh-base` 不含 `dsh-workspace`）。
 *   - `agentPresets` → 仅 `dsh-web-app`（`dsh-base` 不含 `dsh-agent-preset*`）。
 *   - `connection` → 仅 `dsh-web-app`。
 *
 * 后三者一律**不进** `inject`，改用 `ctx.get(name)` 在运行期按需读取：
 * 该 API 不要求声明 inject，服务缺失时返回 `undefined` 而非抛错。
 */
export const inject = [
  "agents",
  "agentDefaultModel",
  "systemPrompt",
  "commands",
];

/**
 * 插件主体。
 *
 * @param {object} ctx - cordis 上下文
 * @param {object} config - 插件配置
 * @returns {void}
 */
export function apply(ctx, config) {
  // UI 设置覆盖层：Web UI 上"点点点"改的配置存在插件自有目录下。
  // 优先级 overlay > cordis.patch.yml > 代码默认值——否则 patch 里已显式写全的
  // 字段会把 UI 改动全部盖掉，"点点点"就失去意义。
  const overlay = loadOverlaySafely();
  const { cfg, overlaid } = buildEffectiveConfig(config, overlay, normalizeConfig);
  if (overlaid) {
    logger.info(`dsh-weixin: settings overlay applied (${Object.keys(overlay).join(", ")})`);
  }

  // 版本兼容性校验：不合规直接抛错，避免半可用状态。
  // 优先使用配置中声明的 hostVersion（探测在 pnpm link 场景下不可靠）。
  assertDshCompatibility(config?.hostVersion);

  if (cfg.enabled === false) {
    logger.info("dsh-weixin disabled by config, skipping");
    return;
  }

  if (config?.logLevel) {
    try {
      setLogLevel(config.logLevel);
    } catch (err) {
      logger.warn(`invalid logLevel, keeping default: ${String(err)}`);
    }
  }
  if (config?.logStdout === false) setConsoleMirror(false);

  // 注入配置，供 accounts / protocol 读取 routeTag、botAgent
  setRuntimeConfig(cfg);

  // 留一份"插件配置原文"的归一化快照，供 UI「恢复默认」回滚内存值使用。
  // 注意：必须是**不含 overlay** 的版本，否则"恢复默认"会把 UI 设置又恢复回来。
  const baseCfg = normalizeConfig(config ?? {});

  logger.info(`dsh-weixin starting; DSH_HOME=${resolveDshHome()}`);
  logger.info(`store dir: ${resolveStoreDir()}`);

  const channel = new WeixinChannel(ctx, cfg);

  // 自动发送（随机骰子冒泡）。配置未开启时 start() 会直接返回，
  // 不会留下任何定时器。
  const autoSend = createAutoSendScheduler({ cfg, channel });

  ctx.effect(() => {
    autoSend.start();
    return () => autoSend.stop();
  }, "dsh-weixin.autoSend()");

  // 全局设定：注入到 Agent 系统提示。空内容时自动跳过，不留空 section。
  ctx.effect(() => {
    promptRegistry = new GlobalPromptRegistry(ctx, cfg);
    promptRegistry.register();
    return () => {
      promptRegistry?.unregister();
      promptRegistry = null;
    };
  }, "dsh-weixin.globalPrompt()");

  // 命令面：注册 /weixin（登录、状态、启停）
  ctx.effect(() => registerWeixinCommand(ctx, cfg, channel), "dsh-weixin.command()");

  // Web UI 数据面：仅在 web profile（有 connection 服务）下注册 HTTP 路由。
  // 用可选注入，避免其他 profile 因缺少 connection 而永久 pending。
  logger.info("dsh-weixin: waiting for optional service 'connection'");
  ctx.inject(["connection"], (webCtx) => {
    logger.info("dsh-weixin: connection service available, registering web routes");
    try {
      const disposers = registerWeixinRoutes(webCtx, channel, cfg, baseCfg, {
        // UI 保存「全局设定」后：
        //   1) 重新注册 section —— 对"尚未创建"的会话生效
        //   2) 让已有微信会话换代 —— 系统提示已固化在会话历史里，
        //      不换会话 ID 的话模型永远拿旧设定（实测确证）
        onGlobalPromptChange: () => {
          promptRegistry?.refresh();
          channel?.bridge?.invalidatePrompt();
        },
        // 自动发送的开关/节奏/概率改动后立即重新对齐定时器，
        // 否则要等满一个基础间隔（默认 30 分钟）才按新参数跑。
        onAutoSendChange: () => autoSend.refresh(),
        autoSend,
      });
      logger.info(`dsh-weixin web routes registered (${disposers.length} endpoints)`);
      webCtx.effect(
        () => async () => {
          logger.info("dsh-weixin web routes disposing");
          await disposeRoutes(disposers);
        },
        "dsh-weixin.routes()",
      );
    } catch (err) {
      logger.error(`dsh-weixin: failed to register web routes: ${String(err)}`);
      if (err && err.stack) logger.error(String(err.stack));
    }
  });

  // 生命周期：dispose 时停止通道
  ctx.effect(() => {
    logger.info("dsh-weixin loaded");
    return async () => {
      logger.info("dsh-weixin disposing");
      await channel.dispose();
    };
  }, "dsh-weixin.lifecycle()");
}
