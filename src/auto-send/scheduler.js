/**
 * 自动发送调度器（随机骰子）。
 *
 * 结构上是一个**双节奏状态机**，不是固定间隔的定时器：
 *
 *   base（基础节奏）  每隔 N 分钟掷一次骰子
 *     ├─ 未命中 → 继续 base，再等 N 分钟
 *     └─ 命中   → 发送 → 切到 active
 *   active（活跃节奏）每隔 5 分钟掷一次骰子（`activeIntervalMin`）
 *     ├─ 命中   → 再发一条，留在 active
 *     └─ 未命中 → 退回 base，重新等 N 分钟
 *
 * 达到 `maxStreak` 次连续命中后强制冷却，避免一直命中的时候刷屏。
 *
 * 三条实现约束：
 *   1. **只用一个定时器**。不用 `setInterval` 常驻：每轮只排"下一次掷骰"，
 *      参数改动、休眠唤醒、进程重启都只需要改一个 `nextRollAt`。
 *   2. **定时器不持有引用**（`unref`）。否则插件停用后进程退不出去。
 *   3. **发送串行**。`busy` 标志挡住重入：Agent 生成一条消息要几秒到几十秒，
 *      期间定时器若再次触发，会出现同一时刻两条在生成。
 */
import { loadAutoSendState, saveAutoSendState } from "./state.js";
import { parseClock, isWithinWindow, nextWindowStart } from "./time-window.js";
import { logger } from "../util/logger.js";

/**
 * 单次 `setTimeout` 的上限。
 *
 * Node 的定时器用 32 位有符号整数存毫秒，超过 `2^31-1`（约 24.8 天）
 * 会**立即触发**。冷却期最长支持 7 天不会碰到，但分段唤醒还能顺带
 * 修正系统休眠后的时钟漂移，所以统一按 30 分钟一段。
 */
const MAX_TIMER_MS = 30 * 60 * 1000;

/**
 * 判定"过期"的宽限窗口。
 *
 * 进程重启后若发现 `nextRollAt` 已经过去：
 *   - 过去 5 分钟以内 → 认为只是短暂中断，立即补一次；
 *   - 超过 5 分钟 → 说明关机/休眠很久了，直接顺延一个基础间隔，
 *     否则一开机就掷骰发消息，行为很突兀。
 */
const OVERDUE_GRACE_MS = 5 * 60 * 1000;

/** 排程超过这么久一定不合理（时钟回拨、状态文件被手改）。 */
const SANE_AHEAD_MS = 24 * 60 * 60 * 1000;

/**
 * 掷骰后的决策（纯函数）。
 *
 * 抽出来是因为这里集中了全部业务规则，混在 I/O 里就没法验证。
 * `delayMs` 由调用方**以实际发送完成的时刻**为锚点加上去——
 * 命中时要先等 Agent 生成，从"掷骰时刻"起算会让间隔变短。
 *
 * @param {object} params - 决策输入
 * @param {number} params.streak - 当前连续命中次数
 * @param {boolean} params.hit - 本次骰子是否命中
 * @param {object} params.auto - `cfg.autoSend`
 * @returns {{send: boolean, phase: string, streak: number, delayMs: number, reason: string}}
 *   下一步计划
 */
export function planAfterRoll({ streak, hit, auto }) {
  const baseMs = Math.max(1, Number(auto.baseIntervalMin) || 30) * 60_000;
  const activeMs = Math.max(1, Number(auto.activeIntervalMin) || 5) * 60_000;
  const cooldownMs = Math.max(0, Number(auto.cooldownMin) || 0) * 60_000;
  const maxStreak = Math.max(1, Number(auto.maxStreak) || 1);

  if (!hit) {
    // 未命中一律退回基础节奏，连续计数清零——
    // "连续命中"指的是不间断的那一串，中间断一次就该重新数。
    return { send: false, phase: "base", streak: 0, delayMs: baseMs, reason: "miss" };
  }

  const nextStreak = Math.max(0, Number(streak) || 0) + 1;
  if (nextStreak >= maxStreak) {
    return {
      send: true,
      phase: "base",
      streak: 0,
      // `cooldownMin: 0` 表示"不冷却"，此时退回基础节奏而不是立即重掷——
      // delayMs 为 0 会让下一轮与本次紧挨着跑，等于绕过了冷却的本意。
      delayMs: cooldownMs > 0 ? cooldownMs : baseMs,
      reason: "streak-limit",
    };
  }

  return { send: true, phase: "active", streak: nextStreak, delayMs: activeMs, reason: "hit" };
}

/**
 * 自动发送调度器。
 */
export class AutoSendScheduler {
  /**
   * @param {object} options - 依赖注入
   * @param {object} options.cfg - 归一化配置（**保持引用**，UI 改配置是就地改）
   * @param {(params: {maxChars: number, instruction: string, phase: string}) => Promise<{ok: boolean, reason?: string, target?: object}>} options.send - 实际发送动作
   * @param {() => number} [options.now] - 时钟（测试可注入）
   * @param {() => number} [options.random] - 随机源（测试可注入）
   * @param {() => object} [options.loadState] - 状态读取（测试可注入）
   * @param {(state: object) => void} [options.saveState] - 状态写入（测试可注入）
   * @param {() => boolean} [options.canRun] - 掷骰前的额外前置条件（如通道是否在运行）
   */
  constructor(options) {
    this.cfg = options.cfg;
    this.send = options.send;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.loadState = options.loadState ?? loadAutoSendState;
    this.saveState = options.saveState ?? saveAutoSendState;
    this.canRun = options.canRun ?? (() => true);

    this.state = this.loadState();
    this.running = false;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** 发送串行锁：异步生成期间不接新的掷骰 */
    this.busy = false;
    /** 排程版本号：旧定时器的回调认领失败时直接退出 */
    this.scheduleGen = 0;
  }

  /**
   * 取自动发送配置。
   *
   * @returns {object} `cfg.autoSend`
   */
  get auto() {
    return this.cfg.autoSend ?? {};
  }

  /**
   * 基础节奏的毫秒数。
   *
   * @returns {number} 毫秒
   */
  baseMs() {
    return Math.max(1, Number(this.auto.baseIntervalMin) || 30) * 60_000;
  }

  /**
   * 当前时间窗的起止分钟数。
   *
   * @returns {{startMin: number, endMin: number}} 分钟数
   */
  windowMinutes() {
    return {
      startMin: parseClock(this.auto.startTime) ?? 0,
      endMin: parseClock(this.auto.endTime) ?? 0,
    };
  }

  /**
   * 启动调度。
   *
   * @returns {void}
   */
  start() {
    if (this.running) return;
    if (this.auto.enabled !== true) {
      logger.info("autosend: disabled by config, not starting");
      return;
    }
    this.running = true;

    const now = this.now();
    const baseMs = this.baseMs();
    let next = Number(this.state.nextRollAt) || 0;

    // 恢复策略见 OVERDUE_GRACE_MS / SANE_AHEAD_MS 的注释。
    if (next <= 0 || next > now + SANE_AHEAD_MS) {
      next = now + baseMs;
    } else if (next < now - OVERDUE_GRACE_MS) {
      next = now + baseMs;
    } else if (next <= now) {
      next = now;
    }

    this.state.nextRollAt = next;
    this._persist();
    this._schedule(next);

    logger.info(
      `autosend: started phase=${this.state.phase} next=${new Date(next).toISOString()} `
        + `base=${this.auto.baseIntervalMin}min active=${this.auto.activeIntervalMin}min `
        + `p=${this.auto.hitRate} window=${this.auto.startTime}-${this.auto.endTime}`,
    );
  }

  /**
   * 停止调度（保留状态，供下次 start 恢复）。
   *
   * @returns {void}
   */
  stop() {
    if (!this.running) return;
    this.running = false;
    this.scheduleGen += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this._persist();
    logger.info("autosend: stopped");
  }

  /**
   * 配置变更后重新对齐。
   *
   * 只处理"开关"与"排程是否需要提前"，不改 phase / streak——
   * 用户改一个概率不该把已经累积的连续计数清掉。
   *
   * @returns {void}
   */
  refresh() {
    const enabled = this.auto.enabled === true;
    if (enabled && !this.running) {
      this.start();
      return;
    }
    if (!enabled && this.running) {
      this.stop();
      return;
    }
    if (!this.running) return;

    const now = this.now();
    // 基础间隔可能被调小了，原有排程会显得过远，提前到新的合理上限。
    const cap = now + this.baseMs();
    if (this.state.nextRollAt > cap) {
      this.state.nextRollAt = cap;
      this._persist();
    }
    this._schedule(this.state.nextRollAt);
  }

  /**
   * 立即掷一次并发送（手动测试用，忽略命中率）。
   *
   * @returns {Promise<{ok: boolean, reason?: string}>} 结果
   */
  async triggerNow() {
    if (this.busy) return { ok: false, reason: "busy" };

    this.busy = true;
    try {
      const result = await this._deliver("manual");
      if (result.ok) {
        this.state.stats.sends += 1;
        this.state.lastSentAt = this.now();
        if (result.target) this.state.lastTarget = result.target;
        // 手动发过一条，基础节奏从此刻重新起算，避免马上又自动触发。
        // 未启用时调度器没在跑，只需落盘，不必排程。
        if (this.running) {
          this.state.nextRollAt = this.now() + this.baseMs();
          this._schedule(this.state.nextRollAt);
        }
        this._persist();
      }
      return result;
    } finally {
      this.busy = false;
    }
  }

  /**
   * 对外状态快照。
   *
   * @returns {object} 状态
   */
  status() {
    const now = this.now();
    const { startMin, endMin } = this.windowMinutes();
    const next = Number(this.state.nextRollAt) || 0;
    return {
      enabled: this.auto.enabled === true,
      running: this.running,
      phase: this.state.phase,
      streak: this.state.streak,
      inWindow: isWithinWindow(now, startMin, endMin),
      coolingDown: this.state.cooldownUntil > now,
      nextRollAt: next || null,
      nextRollInMs: next > now ? next - now : 0,
      cooldownUntil: this.state.cooldownUntil || null,
      lastSentAt: this.state.lastSentAt || null,
      lastTarget: this.state.lastTarget,
      stats: { ...this.state.stats },
    };
  }

  /**
   * 排下一次唤醒。
   *
   * 用版本号而不是只清 timer：`#schedule` 在分段唤醒时会自我重排，
   * 上一版链上的回调必须认领失败，否则同一时刻会跑两次掷骰。
   *
   * @param {number} atMs - 目标时刻
   * @returns {void}
   */
  _schedule(atMs) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.running) return;

    const gen = ++this.scheduleGen;
    const delay = Math.max(0, atMs - this.now());
    const wait = Math.min(delay, MAX_TIMER_MS);

    this.timer = setTimeout(() => {
      if (!this.running || gen !== this.scheduleGen) return;
      this.timer = null;
      // 还没到点（被分段截断），继续排到真正的目标时刻。
      if (delay > MAX_TIMER_MS) {
        this._schedule(atMs);
        return;
      }
      this.wake().catch((err) => {
        logger.error(`autosend: wake failed: ${String(err)}`);
      });
    }, wait);

    // 不 unref 会拖住进程退出。
    this.timer.unref?.();
  }

  /**
   * 一次唤醒：判断窗口 / 掷骰 / 发送 / 排下一次。
   *
   * @returns {Promise<void>}
   */
  async wake() {
    if (!this.running) return;
    if (this.busy) {
      // 正在发送（手动触发或上一轮还没结束）。**不能直接 return**：
      // 此刻定时器已经被消费掉了，不再排一次就再也不会被唤醒，
      // 表现成"手动发过一条之后自动发送再也不动了"。
      this._schedule(Math.max(Number(this.state.nextRollAt) || 0, this.now() + 5_000));
      return;
    }
    this.busy = true;
    try {
      await this._tick();
    } finally {
      this.busy = false;
    }
  }

  /**
   * 唤醒的实际逻辑。
   *
   * @returns {Promise<void>}
   */
  async _tick() {
    const now = this.now();
    const auto = this.auto;

    if (auto.enabled !== true) {
      logger.info("autosend: disabled by config, stopping");
      this.stop();
      return;
    }

    // 1) 冷却期：直接睡到冷却结束，不掷骰。
    if (this.state.cooldownUntil > now) {
      this.state.nextRollAt = this.state.cooldownUntil;
      this._persist();
      this._schedule(this.state.cooldownUntil);
      logger.info(
        `autosend: cooling down until ${new Date(this.state.cooldownUntil).toISOString()}`,
      );
      return;
    }
    if (this.state.cooldownUntil > 0) {
      // 冷却已结束，清掉标记，回到基础节奏。
      this.state.cooldownUntil = 0;
      this.state.phase = "base";
      this.state.streak = 0;
    }

    // 2) 时间窗：窗外就睡到下一个窗口起点。
    const { startMin, endMin } = this.windowMinutes();
    if (!isWithinWindow(now, startMin, endMin)) {
      const nextAt = nextWindowStart(now, startMin);
      this.state.phase = "base";
      this.state.streak = 0;
      this.state.nextRollAt = nextAt;
      this._persist();
      this._schedule(nextAt);
      logger.info(
        `autosend: outside window ${auto.startTime}-${auto.endTime}, `
          + `next check ${new Date(nextAt).toISOString()}`,
      );
      return;
    }

    // 3) 前置条件（通道是否在跑）。不满足时**不掷骰**、也不计失败：
    //    这时"运气"没有参与，消耗一次投掷会让统计失真，
    //    也可能把 streak 莫名其妙地清零。
    if (!this.canRun()) {
      // 通道未启动时用 1 分钟的粒度重试。若直接顺延一个完整基础间隔，
      // "先开自动发送、20 分钟后再启动通道"就要再等满 30 分钟才进入节奏，
      // 用户会以为配置没生效。
      const retryAt = now + Math.min(this.baseMs(), 60_000);
      this.state.nextRollAt = retryAt;
      this._persist();
      this._schedule(retryAt);
      logger.debug("autosend: channel not running, skip this round");
      return;
    }

    // 4) 掷骰。
    const hitRate = Math.min(1, Math.max(0, Number(auto.hitRate) || 0));
    const hit = this.random() < hitRate;
    this.state.stats.rolls += 1;

    const plan = planAfterRoll({
      streak: this.state.streak,
      hit,
      auto,
    });

    logger.info(
      `autosend: roll phase=${this.state.phase} hit=${hit} `
        + `p=${hitRate} streak=${this.state.streak} → ${plan.reason}`,
    );

    // 5) 未命中：只改节奏，不发。
    if (!plan.send) {
      this.state.phase = plan.phase;
      this.state.streak = plan.streak;
      this.state.nextRollAt = now + plan.delayMs;
      this._persist();
      this._schedule(this.state.nextRollAt);
      return;
    }

    // 6) 命中：发送，锚点取**发送完成**的时刻。
    this.state.stats.hits += 1;
    const result = await this._deliver(plan.reason);
    const after = this.now();

    if (!result?.ok) {
      this.state.stats.failures += 1;
      // 失败不累加连续计数，退回基础节奏。常见原因是 Agent 正忙、
      // 没有可用 context_token——都不该因为一次失败就跳过整个节奏。
      //
      // 注意这里必须用 `baseMs()` 而不是 `plan.delayMs`：
      // 失败发生在"骰子已命中"的路径上，plan 给的是活跃节奏的 5 分钟，
      // 沿用会让失败后的重试比正常节奏密得多。
      this.state.phase = "base";
      this.state.streak = 0;
      this.state.nextRollAt = after + this.baseMs();
      this._persist();
      this._schedule(this.state.nextRollAt);
      logger.warn(`autosend: send failed (${result?.reason ?? "unknown"}), retry after interval`);
      return;
    }

    this.state.stats.sends += 1;
    this.state.lastSentAt = after;
    this.state.phase = plan.phase;
    this.state.streak = plan.streak;
    if (result.target) this.state.lastTarget = result.target;
    if (plan.reason === "streak-limit" && Number(auto.cooldownMin) > 0) {
      this.state.cooldownUntil = after + plan.delayMs;
      logger.info(
        `autosend: reached maxStreak=${auto.maxStreak}, `
          + `cooling down ${auto.cooldownMin}min`,
      );
    } else if (plan.reason === "streak-limit") {
      logger.info(`autosend: reached maxStreak=${auto.maxStreak}, cooldown disabled`);
    }
    this.state.nextRollAt = after + plan.delayMs;
    this._persist();
    this._schedule(this.state.nextRollAt);
  }

  /**
   * 调一次实际发送。
   *
   * 包一层是为了把异常统一成 `{ok:false}`：发送链路上的任何 throw
   * 都不该让调度器停摆，只应记一次失败并继续下一轮。
   *
   * @param {string} reason - 触发原因（日志用）
   * @returns {Promise<{ok: boolean, reason?: string, target?: object}>} 结果
   */
  async _deliver(reason) {
    const auto = this.auto;
    try {
      const result = await this.send({
        maxChars: Number(auto.maxChars) || 120,
        instruction: typeof auto.instruction === "string" ? auto.instruction : "",
        phase: this.state.phase,
        reason,
      });
      return result ?? { ok: false, reason: "empty-result" };
    } catch (err) {
      logger.error(`autosend: deliver threw: ${String(err)}`);
      return { ok: false, reason: String(err?.message ?? err) };
    }
  }

  /**
   * 落盘。
   *
   * @returns {void}
   */
  _persist() {
    this.saveState(this.state);
  }
}
