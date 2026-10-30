# DSH 微信插件（dsh-weixin）实施计划

> 目标：把 `@tencent-weixin/openclaw-weixin`（OpenClaw 微信通道插件）改造为可在
> DeepSeek Harness（DSH）`web` profile 下运行的 DSH 插件。

---

## 一、环境核查结果（已实测）

| 项目 | 实测值 | 结论 |
|---|---|---|
| Node.js | v22.22.2 | 满足插件 `engines.node >= 22.13.0` |
| `dsh` 版本 | 0.2.0-rc.2 | 所有 `@deepseek-ai/*` peer 依赖必须锁 `0.2.0-rc.2` |
| `DSH_HOME` | 未设置，实际为 `C:\Users\dolou\.dsh` | 与 `dsh-purge` 的探测顺序一致 |
| 已初始化 profile | `acp` `desktop` `fishcheck` `headless` `sdk` `web` | `web` 已就绪，可直接用 |
| `web` profile 插件数 | 295 个 `id` 条目 | 组合正常，`--dump-config` 退出码 0 |
| `web` 服务启动 | `http://127.0.0.1:3099` 常驻，HTTP 401（需 token） | 可正常启动，认证层生效 |
| `pnpm` | 12.16.1 | `dsh plugin` 是 pnpm 透传，可直接装包 |
| 第三方插件安装 | 已验证：`desktop` 装过 `dsh-purge@1.1.71`，为真实目录 | **安装通道可用** |

### 1.1 三个必须注意的环境事实

**事实 A：`~/.dsh/profiles/node_modules/@deepseek-ai/` 下 195 个软链全部断裂**

```
dsh -> /d/App/DeepSeek Harness Desktop/resources/resources/dsh/node_modules/@deepseek-ai/dsh
       （Desktop 目录已为空）
```

但 `dsh web` 仍能正常启动。原因：运行时从 **npm 全局安装**
（`D:\App\NodeJS\24.16.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`，287 个包，
版本均为 `0.2.0-rc.2`）解析，不依赖 profile 那层软链。

> **影响**：不要把插件开发/调试建立在 `profiles/node_modules` 上。所有依赖声明（peerDependencies）
> 会被 `dsh plugin add` 重新解析安装，不继承那批断链。

**事实 B：`web` profile 的配置树里没有 `dsh-webhook`**

`--dump-config` 检索 `webhook` 结果为空。即：**不能复用 webhook 运行时**，必须自己实现桥接。
`dsh-webhook` / `dsh-webhook-github` 包在 npm 安装中存在（`0.2.0-rc.2`），但未挂载到 `web`。

**事实 C：`web` profile 依赖为空，插件走"包内 patch"机制**

`profiles/web/package.json` 的 `dependencies` 是 `{}`。第三方插件接入方式是：
`dsh plugin --profile web add <包>` → 包被 pnpm 安装到 `profiles/web/node_modules/` →
插件自带的 `cordis.patch.yml` 由插件管理器读入并应用。
`dsh-purge` 就是这个模式（`package.json` 有 `dependencies.dsh-purge` + 包内 `cordis.patch.yml`）。

### 1.2 DSH 侧可用能力（已确认存在）

- `ctx.agents.create()` / `resume()` / `get()` —— 创建与查找 agent
- `agent.followup()` / `steer()` / `inject()` / `whenIdle()` / `cancel()` —— 驱动对话
- `agent/assistant-stream` 事件（`start`/`chunk`/`end` 帧）—— 出站流式捕获
- `agent/turn-stopping` 事件 —— 回合边界
- `agent/status`、`agent/created`、`agent/disposed` —— 生命周期
- `MessageSourceMap` 可 declaration-merge 扩展 —— 注册自有 `kind`
- `ctx.workspaceRegistry.create()` / `attachSession()` —— 会话归属
- `ctx.permissionPresets` / `ctx.agentPresets` / `ctx.sessionTitle`
- `@deepseek-ai/schemastery` —— 配置 schema

---

## 二、总体架构

四层，每层职责单一、可独立验证：

```
┌──────────────────────────────────────────────────────────────┐
│  L4 运维层  扫码登录 / 多账号 / 配置 schema / 安装            │
├──────────────────────────────────────────────────────────────┤
│  L3 桥接层  入站: 轮询→agent.followup                        │
│            出站: agent 事件→sendMessage    ← 需全新实现      │
│            会话映射: senderId ↔ sessionId                    │
├──────────────────────────────────────────────────────────────┤
│  L2 适配层  替换 11 处 openclaw/plugin-sdk 依赖              │
├──────────────────────────────────────────────────────────────┤
│  L1 协议层  getUpdates/sendMessage/CDN/AES/退避  ← 直接复用  │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 L1 协议层：复用，不改

直接移植 `@tencent-weixin/openclaw-weixin@2.4.10` 的以下模块（约 1500 行，零 OpenClaw 依赖）：

| 文件 | 行数 | 职责 |
|---|---|---|
| `api/api.js` | 564 | getUpdates / sendMessage / getUploadUrl / getConfig / sendTyping / notifyStart / notifyStop |
| `api/config-cache.js` | 63 | typing_ticket 缓存 |
| `api/session-guard.js` | — | stale-token 暂停 |
| `cdn/aes-ecb.js` / `cdn-upload.js` / `cdn-url.js` / `pic-decrypt.js` / `upload.js` | ~360 | 媒体上传下载与解密 |
| `storage/sync-buf.js` / `state-dir.js` | ~120 | get_updates_buf 持久化 |
| `util/logger.js` / `random.js` / `redact.js` | ~180 | 日志与脱敏 |
| `media/mime.js` / `media-download.js` | ~170 | 媒体类型与下载 |
| `messaging/markdown-filter.js` | 375 | 微信 Markdown 过滤（流式） |

**为什么必须复用**：`ilink_appid: "bot"`、`iLink-App-Id`、`iLink-App-ClientVersion`、
`X-WECHAT-UIN`、`ilinkai.weixin.qq.com` 端点、`parseWeixinApiJson` 的 uint64 精度保护，
全部来自逆向而非公开文档。自行推导不可行。

### 2.2 L2 适配层：替换 11 处依赖

| # | OpenClaw 依赖 | 出现位置 | DSH 替代方案 |
|---|---|---|---|
| 1 | `plugin-sdk/temp-path` ×3 | `channel.js` `process-message.js` `logger.js` | `os.tmpdir()` + `DSH_HOME/tmp` |
| 2 | `plugin-sdk/account-id` ×2 | `channel.js` `accounts.js` | 本地实现 `normalizeAccountId`（`hex@im.bot`→`hex-im-bot`） |
| 3 | `plugin-sdk/config-mutation` ×1 | `accounts.js` | `@deepseek-ai/dsh-atomic-write` 写 JSON |
| 4 | `plugin-sdk/channel-ingress-runtime` ×1 | `authorization.js` | 简化为单用户白名单（DM only，无群组语义） |
| 5 | `plugin-sdk/hook-runtime` ×1 | `outbound-hooks.js` | cordis `ctx.on()` / `ctx.emit()` |
| 6 | `plugin-sdk/plugin-runtime` ×1 | `outbound-hooks.js` | 同上 |
| 7 | `plugin-sdk/channel-config-schema` ×1 | `index.js` | `@deepseek-ai/schemastery` |

**要重写而非替换的部分**（重点，工作量在此）：

原 `channel.js` 的 `gateway.startAccount` 强依赖 `ctx.channelRuntime`，包含
`routing.resolveAgentRoute`、`session.recordInboundSession`、
`reply.createReplyDispatcherWithTyping`、`reply.withReplyDispatcher`、`media.saveMediaBuffer`。
DSH 无对应物，必须按 DSH 的 agent 模型重新设计（见 L3）。

### 2.3 L3 桥接层：核心新增

#### 入站链路

```
getUpdates 长轮询
  → inbound.js 归一化（文本/图片/语音/引用/位置）
  → 授权判定（DM 白名单）
  → 会话映射 resolve(senderId) → sessionId
  → ctx.agents.get(sessionId) ?? ctx.agents.create({ sessionId, meta.cwd })
  → agent.followup({ content, source: { kind: 'weixin', ... } })
```

#### 出站链路（关键设计）

原插件是"reply dispatcher 回调"模式，DSH 是"事件"模式，故：

```
ctx.on('agent/assistant-stream', ({ agent, frame }) => {
  if (frame.type === 'end') 收集完整文本
})
ctx.on('agent/turn-stopping', ({ agent, turn }) => {
  取该 turn 的完整 assistant 文本 → StreamingMarkdownFilter → sendMessage
})
```

两种出站策略（配置项 `outbound.mode`）：

| 模式 | 机制 | 优点 | 缺点 |
|---|---|---|---|
| `final`（默认，先做） | 仅 `turn-stopping` 整段发送 | 简单、可靠、无节流问题 | 无流式感 |
| `stream` | `assistant-stream` 增量 + 节流合并 | 类打字机体验 | 需合并/去重，易乱序 |

节流参数沿用上游：`minChars: 200`、`idleMs: 3000`。

#### 会话映射

`senderId (xxx@im.wechat) → sessionId`，持久化到 `DSH_HOME/storages/dsh-weixin/sessions.json`。

- 默认：**单用户单会话**（上下文连续，符合微信 DM 直觉）
- 支持 `/new` 重置（复用上游 `slash-commands.js` 思路）
- 进程重启后 `ctx.agents.resume()` 恢复

### 2.4 L4 运维层

- **扫码登录**：移植 `auth/login-qr.js`（依赖 `qrcode-terminal`，纯终端库，无宿主耦合）。
  提供 `dsh weixin login` 命令 + Web UI 二选一（先做 CLI）。
- **多账号**：`auth/accounts.js` 改造，配置文件落在 `DSH_HOME/storages/dsh-weixin/accounts.json`。
- **配置 schema**：`schemastery` 定义 `replyProgressMessages`、`quoteCache`、`outbound.mode` 等。
- **安装**：`dsh plugin --profile web add dsh-weixin`，包内自带 `cordis.patch.yml`。

---

## 三、包结构

```
D:/Project/weixin-dsh/
├── package.json                 # name: dsh-weixin, peerDeps 锁 0.2.0-rc.2
├── cordis.patch.yml             # 插件挂载片段（insert 一行）
├── tsconfig.json
├── src/
│   ├── index.ts                 # 插件入口：name/inject/apply
│   ├── config.ts                # schemastery 配置定义
│   ├── compat.ts                # DSH 版本校验（对齐上游 compat.js）
│   ├── protocol/                # L1 协议层（移植）
│   │   ├── api.ts
│   │   ├── cdn.ts
│   │   ├── sync-buf.ts
│   │   └── markdown-filter.ts
│   ├── adapt/                   # L2 适配层
│   │   ├── tmpdir.ts
│   │   ├── account-id.ts
│   │   ├── config-store.ts
│   │   └── authorization.ts
│   ├── bridge/                  # L3 桥接层
│   │   ├── inbound.ts           # 轮询→followup
│   │   ├── outbound.ts          # 事件→sendMessage
│   │   ├── session-map.ts       # senderId↔sessionId
│   │   └── monitor.ts           # 长轮询主循环
│   ├── auth/
│   │   ├── accounts.ts
│   │   └── login-qr.ts
│   └── types/
│       └── message-source.ts    # declare module 扩展 MessageSourceMap
└── docs/
    └── PLAN.md
```

---

## 四、分阶段实施

### Phase 0：骨架与协议层可跑通（先证明能连上微信）

- 建包、`package.json`、`tsconfig`、`cordis.patch.yml`
- 移植 L1 协议层（`api.ts`、`cdn.ts`、`sync-buf.ts`）
- 移植 `login-qr.ts` + `accounts.ts`
- 实现 `dsh weixin login`：扫码 → 拿 token → 存盘
- **验收**：终端打印二维码，手机扫码后 `accounts.json` 出现有效 token

### Phase 1：出站单向往外发

- `outbound.ts`：`turn-stopping` → `sendMessage`
- 手动触发一条测试消息
- **验收**：微信里收到一条由 DSH agent 生成的回复

### Phase 2：入站单向收进来

- `monitor.ts` 长轮询 + `inbound.ts` 归一化
- `session-map.ts` 会话映射
- `agent.followup()` 投递
- **验收**：微信发"你好"，Web UI 里能看到这条消息并触发 agent

### Phase 3：双向闭环

- 打通 Phase 1+2
- `/new`、`/status` 斜杠命令
- 错误提示（`error-notice.js` 移植）
- **验收**：微信发消息 → agent 处理 → 回复出现在微信

### Phase 4：媒体与体验

- 图片收发（CDN 上传/下载、AES 解密）
- 语音（silk 转码，需 `silk-wasm`，可延后）
- 引用消息（`quote-store.js`，521 行，可延后）
- `stream` 出站模式
- **验收**：微信发图 → agent 看到图；agent 生成图 → 微信收到图

---

## 五、关键决策（建议值）

| 决策点 | 建议 | 理由 |
|---|---|---|
| 移植 vs 重写 | **移植改造** | iLink 协议为逆向所得，无法自行推导；跟上游更新成本低 |
| 出站策略 | **先 `final` 后 `stream`** | `final` 可快速验证闭环，`stream` 作为增强 |
| 会话粒度 | **单用户单会话** | 符合微信 DM 直觉，上下文连续 |
| 宿主 profile | **`web`** | 已就绪、已验证可启动；`desktop` 为 Electron 专用，CLI 拒绝管理 |
| 媒体优先级 | **图片先做，语音/引用延后** | 覆盖 90% 场景，silk 需额外 wasm 依赖 |

---

## 六、风险清单

| 风险 | 等级 | 说明与对策 |
|---|---|---|
| `channelRuntime` 语义缺失 | **高** | 原插件 `routing`/`session`/`reply dispatcher` 无 DSH 对应物，属重新设计而非替换。Phase 1-3 的主要工作量在此 |
| DSH 处于 rc 阶段 | **中** | `0.2.0-rc.2` API 可能变动。声明 `engines.dsh` 并在 `compat.ts` 启动校验 |
| 出站文本归属 | **中** | 需正确过滤 tool-call 中间产物，只发最终 assistant 文本。依赖 `turn-stopping` 的 turn 边界 |
| 会话与 Web UI 竞争 | **中** | 同一 sessionId 若同时被 Web UI 打开，可能出现并发写入。需约定映射策略或独立会话前缀 |
| 微信侧限流 | **中** | 上游 `textChunkLimit: 4000`、`blockStreamingCoalesceDefaults` 需保留 |
| 195 个断链软链 | **低** | 不影响运行时（走 npm 全局），但不要在其上开发调试 |
| 语音/引用消息 | **低** | 可延后；上游 `quote-store.js` 521 行可直接移植 |
| iLink 协议变更 | **中** | 只能跟随上游包版本，需定期对比 `@tencent-weixin/openclaw-weixin` 更新 |

---

## 七、验证手段

| 阶段 | 验证命令 |
|---|---|
| 配置组合 | `dsh --profile web --dump-config \| grep weixin` |
| 插件加载 | `dsh --profile web --dump-config-schema` |
| 服务启动 | `dsh --profile web --port 3099 --no-open` → `curl -o /dev/null -w "%{http_code}" 127.0.0.1:3099` |
| 登录 | `dsh weixin login` → 检查 `accounts.json` |
| 收发闭环 | 微信发消息 → Web UI 可见 → 微信收到回复 |
| 日志 | `DSH_HOME/storages/dsh-weixin/*.log` |

---

## 八、待确认事项

1. **是否接受"移植改造"路线**（保留上游代码 + 打补丁），还是要求完全独立重写？
2. **出站先做 `final`** 是否可接受？流式作为 Phase 4 增强。
3. **会话映射**用"单用户单会话"，是否需要支持"每话题一会话"？
4. 是否需要同时支持 `desktop` profile？（`desktop` 由 Electron 托管，CLI 无法管理其插件）
