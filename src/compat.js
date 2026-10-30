/**
 * DSH 版本兼容性校验。
 *
 * 上游 `compat.js` 用同样的思路拒绝不兼容的宿主版本。DSH 目前处于 rc 阶段，
 * 跨 rc 版本 API 可能变动，因此在加载时就明确拒绝，避免运行到一半才失败。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 本插件针对的 DSH 版本。 */
export const SUPPORTED_DSH_VERSION = "0.2.0-rc.2";

/**
 * 解析版本号为可比较的数组。
 *
 * @param {string} v - 版本字符串
 * @returns {number[]|null} 数字段；无法解析返回 null
 */
export function parseVersion(v) {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] || ""];
}

/**
 * 比较两个版本。
 *
 * @param {string} a - 版本 A
 * @param {string} b - 版本 B
 * @returns {number} -1 / 0 / 1
 */
export function compareVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return NaN;

  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  // 有预发布标记的版本低于同号正式版
  if (pa[3] === pb[3]) return 0;
  if (!pa[3]) return 1;
  if (!pb[3]) return -1;
  return pa[3] < pb[3] ? -1 : 1;
}

/**
 * 探测宿主 DSH 版本。
 *
 * 依次尝试：
 *   1. `@deepseek-ai/dsh/package.json` 解析
 *   2. `~/.dsh/profiles/node_modules/@deepseek-ai/dsh/package.json`
 *   3. 环境变量 `DSH_VERSION`
 *
 * @returns {string|null} 版本号
 */
export function detectDshVersion() {
  const fromEnv = process.env.DSH_VERSION?.trim();
  if (fromEnv) return fromEnv;

  const candidates = [];

  // 与 dsh 安装目录同级解析（插件被 pnpm 安装时通常能解析到）
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, "..", "node_modules", "@deepseek-ai", "dsh", "package.json"));
  } catch {
    // ignore
  }

  // profile 共享 node_modules
  const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
  candidates.push(
    path.join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh", "package.json"),
  );

  // 从实际已加载的同族包反查版本。
  // 注意：profiles/node_modules 下的 @deepseek-ai/* 可能是断裂软链，
  // 因此这里读取包的 main 入口真实路径，再向上找 package.json。
  const probePackages = ["dsh-agent", "dsh-session", "dsh-base"];
  for (const pkgName of probePackages) {
    try {
      const entry = import.meta.resolve?.(`@deepseek-ai/${pkgName}`);
      if (!entry) continue;
      const entryPath = entry.startsWith("file://") ? fileURLToPath(entry) : entry;
      let dir = path.dirname(entryPath);
      for (let i = 0; i < 5; i++) {
        const pj = path.join(dir, "package.json");
        if (fs.existsSync(pj)) {
          const parsed = JSON.parse(fs.readFileSync(pj, "utf-8"));
          if (parsed?.name === `@deepseek-ai/${pkgName}` && parsed.version) {
            return parsed.version;
          }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // 该包不可解析，继续下一个
    }
  }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, "utf-8"));
        if (pkg?.version) return pkg.version;
      }
    } catch {
      // 继续下一个候选
    }
  }
  return null;
}

/**
 * 断言宿主版本兼容，不兼容时抛出明确错误。
 *
 * 版本来源优先级：显式参数 > `DSH_VERSION` 环境变量 > 运行时探测。
 * 环境变量 `DSH_WEIXIN_ALLOW_ANY_VERSION=1` 可跳过校验（仅用于本地调试）。
 *
 * @param {string} [explicitVersion] - 由插件配置显式声明的宿主版本
 * @returns {void}
 * @throws {Error} 版本不兼容时
 */
export function assertDshCompatibility(explicitVersion) {
  if (process.env.DSH_WEIXIN_ALLOW_ANY_VERSION === "1") return;

  const actual = explicitVersion?.trim() || detectDshVersion();
  if (!actual) {
    // 探测不到时放行，仅提示——避免在非常规部署下直接不可用。
    console.warn(
      `[dsh-weixin] 无法探测 DSH 版本；本插件针对 ${SUPPORTED_DSH_VERSION}。` +
        `可在插件配置中设置 hostVersion，或设置 DSH_VERSION 环境变量。`,
    );
    return;
  }

  // 只拒绝「低于」目标版本，高于则放行。
  // 早先要求版本完全相等，导致 peerDependencies 放宽后依然装了就起不来——
  // 别人用 rc.3 会被直接抛错，比 peer 警告更糟。rc 阶段 API 向后兼容的面
  // 通常比向前兼容大，低版本缺少本插件依赖的接口才是真风险。
  const cmp = compareVersion(actual, SUPPORTED_DSH_VERSION);
  if (Number.isNaN(cmp)) {
    console.warn(`[dsh-weixin] 无法解析 DSH 版本 "${actual}"，跳过校验。`);
    return;
  }
  if (cmp < 0) {
    throw new Error(
      `[dsh-weixin] 宿主 DSH 版本过低!\n` +
        `  当前 DSH 版本: ${actual}\n` +
        `  本插件要求:   >= ${SUPPORTED_DSH_VERSION}\n` +
        `  如确认可用，设置 DSH_WEIXIN_ALLOW_ANY_VERSION=1 跳过校验。`,
    );
  }
  if (cmp > 0) {
    // 高于目标版本：放行，但留一条记录便于排查"新版 DSH 下行为异常"的问题
    console.warn(
      `[dsh-weixin] 宿主 DSH ${actual} 高于本插件验证过的 ${SUPPORTED_DSH_VERSION}，` +
        `已放行。若出现异常请先回退 DSH 版本再复现。`,
    );
  }
}
