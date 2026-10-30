/**
 * DSH 路径解析：state 目录、存储目录、临时目录。
 *
 * 与上游 `openclaw` 的 `~/.openclaw` 不同，DSH 使用 `$DSH_HOME`（默认 `~/.dsh`）。
 * 插件自有数据统一落在 `$DSH_HOME/storages/dsh-weixin/` 下。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 解析 DSH home 目录。
 *
 * 优先级与 dsh 自身一致：
 *   1. `DSH_HOME` 环境变量
 *   2. `~/.dsh`
 *
 * @returns {string} 绝对路径（不保证存在）
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".dsh");
}

/**
 * 解析插件专属存储目录：`$DSH_HOME/storages/dsh-weixin`。
 *
 * @param {...string} segments - 追加的子路径片段。
 * @returns {string} 绝对路径（不保证存在）
 */
export function resolveStoreDir(...segments) {
  return path.join(resolveDshHome(), "storages", "dsh-weixin", ...segments);
}

/**
 * 确保目录存在（递归创建）。
 *
 * @param {string} dir - 目标目录。
 * @returns {string} 同一路径，便于链式调用。
 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 插件临时目录：优先 `$DSH_HOME/tmp/dsh-weixin`，失败时回退系统临时目录。
 *
 * @param {...string} segments - 追加的子路径片段。
 * @returns {string} 已确保存在的绝对路径
 */
export function resolveTmpDir(...segments) {
  const preferred = path.join(resolveDshHome(), "tmp", "dsh-weixin", ...segments);
  try {
    return ensureDir(preferred);
  } catch {
    const fallback = path.join(os.tmpdir(), "dsh-weixin", ...segments);
    return ensureDir(fallback);
  }
}
