# dsh-weixin

DeepSeek Harness 微信通道插件。移植自 `@tencent-weixin/openclaw-weixin`，把微信 iLink Bot
接入 DSH Agent 会话。

## 当前状态

**端到端收发已打通**：扫码登录 → 长轮询收消息 → DSH Agent 处理 → 回复发回微信，
整条链路已在真机验证（`reply sent ... len=86`）。

| 能力 | 状态 |
|---|---|
| 插件加载到 `web` profile | 完成，日志输出 `dsh-weixin loaded` |
| iLink 协议层（getUpdates / sendMessage / CDN / AES） | 完成，已与真实服务端连通 |
| 扫码登录（含验证码、过期刷新、IDC 重定向） | 完成 |
| 账号存储与 ID 归一化 | 完成 |
| 侧栏微信入口 + 设置页 | 完成 |
| 可视化配置（出站/会话/开关/白名单/全局设定） | 完成，改动即时生效 |
| 入站消息（长轮询 → agent） | 完成，游标持久化 + 指数退避 |
| 出站回复（agent → sendMessage） | 完成，整段 + 流式两种模式 |
| 流式增量下发（`outbound.mode=stream`） | 完成，攒够 1600 字或自然边界才发 |
| 全局设定（提示词注入） | 完成，注入 `systemPrompt.section`，支持 `{{占位符}}` |
| 媒体入站（图片/语音/文件/视频） | 完成，落盘后把路径交给 Agent |
| 媒体出站（Agent 产出文件回传） | 完成，从 `tool/call` 提取写文件路径 |
| 发送频控保护 | 完成，500ms 间隔 + 4 次退避重试 + 收尾补发 |
| 思考过程开关（`replyThinking`） | 完成，默认关闭；整段与流式两条出口都按 `type` 分流 |
| 「正在输入」状态 | 完成，心跳 + 收尾主动发 `status: 2` 撤销 |

### 实现中遇到的硬坑

都是「不报错、但就是不工作」的类型，记下来避免重复踩：

1. **Agent 必须绑模型**。`agents.create()` 内部是 `agentOptions ?? {}`，不传模型就没有可用
   的 LLM 路由，`followup()` 后静默不产生回合。需从 `ctx.agentDefaultModel.currentSelection()`
   取 provider/model，并在 `setup` 里 `installModelSelection()` 写进请求头。
2. **Agent 必须挂预设，否则没有工具**。只传 `meta.agentPreset` 仅写进会话 header 做记录，
   **不会激活预设里的插件**；必须在 `setup(agentCtx)` 里调
   `ctx.agentPresets.mount(agentCtx, presetId)`。漏了这一步，Agent 能正常对话、会把工具调用
   当纯文本写出来（DSML 标记），但从不真正执行，日志里 `tool/call` 恒为 0，且没有任何报错。
3. **会话会持久化，重启后同 ID 不能再 `create()`**，会抛 `SessionAlreadyExistsError`。
   要先 `create()` 失败再 `agents.resume({ resumeSessionId })`。注意 `agentPresets.select()`
   对已开回合的会话会抛 `agent-preset/locked`，所以只能靠 `mount` 走 `setup`。
4. **`session.events` 不存在**。读事件得用 `session.snapshotEvents()`（已标记 deprecated
   但可用），且必须按 `turn` 过滤，否则工具调用后会重发旧内容。
5. **`sendMessage` 的 body 必须包在 `msg` 里并带 `client_id`**，否则服务端只回
   `ret=-2 invalid arguments`，不告诉你差哪个字段。
6. **Workspace 实体的路径字段是 `path` 不是 `cwd`**，写错会让会话全落到 `_no-cwd` 分组。
7. **`ret=-2 prepare failed` 是平台连发频控，会直接丢内容**。短时间连发多个气泡就触发，
   不是排队而是丢弃。必须给相邻发送留间隔（`outbound.sendGapMs`，默认 500ms），
   否则一次长回答的后半截整段消失，且日志里只有一行错误。
8. **`sendTyping` 需要先换 `typing_ticket`**。字段名是 `ilink_user_id`（不是 `to_user_id`），
   且必须先用 `getConfig` 拿票据；`apiPostFetch` 对 HTTP 200 里的 `ret=-3` 不会抛错，
   要自己校验返回码，否则每 5s 一次失败请求刷满日志、功能静默失效。
9. **媒体项结构以实测为准**。微信下发的图片在 `image_item.media.full_url` 里直接给出
   CDN 地址（不必自己拼 base），`media.aes_key` 解码后是 32 位 hex 字符串（不是 16 字节），
   而真实格式是 JPEG 却没有任何扩展名可用——必须按文件头嗅探，写死 `.png` 会让下游 MIME 全错。
10. **`ctx.agents.create` 的 `setup` 必须能异步**。`mount` 是 async 的，`setup` 里要 `await`；
    同步写会静默跳过后续段落。
11. **出站 `aes_key` 是「hex 字符串再 base64」，不是「16 字节原始值 base64」**。两种写法
    服务端都照收并返回 `message_id`，但客户端用错误密钥解不开 CDN 密文，卡片**静默不渲染**——
    表现为「日志显示发送成功、微信里什么都没有」。入站图片的 `aes_key` 是同一套编码。
12. **typing 定时器的存取 key 必须一致**。曾经 `startTyping` 按 `toUserId` 存、
    `flushReply` 按 `agent.id` 查，两个永远对不上，心跳停不下来 →
    「回复都发完了还在显示对方正在输入」。
13. **停心跳 ≠ 撤销状态**。"正在输入"是**服务端状态**，只 `clearInterval` 不发请求它会一直挂着。
    收尾必须再发一次 `sendtyping`，`status: 2`（CANCEL）。
14. **`startTyping` 里不要发 CANCEL**。那里紧接着就要发 TYPING，
    异步的 cancel 可能后到达，把刚点亮的状态又熄掉。清定时器与撤销状态要拆开。
15. **系统提示在会话里是已固化的历史**。`system/message` 属 SurfaceEvent，写进会话后
    一直作为上下文复用。改「全局设定」只重新 `register()` section 对**已有会话完全无效**——
    实测日志显示注册了 332 字，模型收到的仍是旧的 31 字。必须让会话换代（换 sessionId）才会重新组装。


## 安装

前提：本机已安装 DSH（`dsh --version` 可执行），Node.js ≥ 22.13。

### 方式一：从 GitHub 安装（推荐给使用者）

```sh
# 简写形式（GitHub 用户名/仓库名）
dsh plugin --profile web add <owner>/dsh-weixin

# 完整 URL
dsh plugin --profile web add git+https://github.com/<owner>/dsh-weixin.git

# 指定 tag 或分支
dsh plugin --profile web add git+https://github.com/<owner>/dsh-weixin.git#v0.1.0
```

安装器会 clone 仓库、装依赖、并**自动把 `dsh-weixin` 追加到
`dsh.profile.bundles`**，无需手工改配置。

> **为什么 git 来源能装成功**：安装器对 `git` 来源不做 bundle 预校验
> （`path` 来源则要求 `package.json` 里必须有 `dsh.bundle`，否则报
> `declares no dsh.bundle`）。装完后它再读 `node_modules` 里的清单补 `bundles`，
> 所以照样能注册成 profile 层。本包无需构建步骤，`src/` 与 `lib/` 提交在仓库里即可直接运行。

升级：

```sh
dsh plugin --profile web remove dsh-weixin
dsh plugin --profile web add <owner>/dsh-weixin
```

### 方式二：本地路径链接（推荐给开发者）

```sh
dsh plugin --profile web add D:/Project/weixin-dsh

dsh plugin --profile web list | grep weixin
```

`link:` 方式的好处是**改完源码无需重装**——Node 直接读软链指向的目录，重启 `dsh` 即可生效。

### 若 bundle 没被自动注册

正常情况下不用管。只有出现
`declares no dsh.bundle — installed as a plain dependency` 警告时才需要手工补：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-weixin"
      ]
    }
  }
}
```

文件位置：`~/.dsh/profiles/web/package.json`。

### 验证安装

```sh
# 启动（会同时打开浏览器）
dsh --profile web

# 另开一个终端看日志，出现 "dsh-weixin loaded" 即为加载成功
tail -f ~/.dsh/logs/dsh-weixin-$(date +%F).log
```

### 卸载

```sh
dsh plugin --profile web remove dsh-weixin
```

## 使用

### 图形界面（推荐）

启动 `dsh --profile web` 后，左侧栏「插件」按钮**正下方**会出现绿色的微信图标。
点击进入「微信通道」设置页，四个区块：

| 区块 | 可做的事 |
|---|---|
| **通道状态** | 查看运行状态、一键启动/停止 |
| **连接微信** | 点「扫码登录」→ 页面直接显示二维码 → 手机扫码即完成 |
| **已登录账号** | 查看账号 ID、登录日期，可删除 |
| **通道配置** | 出站模式、会话模式、开关、白名单，**点一下即保存生效** |

配置交互约定：

- **开关 / 分段按钮**：点击立刻保存，无需再按确认
- **数字 / 文本输入**：「单条上限」「白名单」等停止输入 700ms 后自动保存
- **「已自定义」标记**：出现在被 UI 改过的项上，便于区分默认值与自定义值
- **「恢复默认」**：清除 UI 设置，回滚到 `cordis.patch.yml` 的值，无需重启
- 出站模式选「整段」时，流式专属的「合并阈值」「空闲窗口」会自动隐藏

UI 设置存放在 `$DSH_HOME/storages/dsh-weixin/settings.json`，
**优先级高于 `cordis.patch.yml`**（否则配置文件里已显式写全的项会把 UI 改动全部盖掉）。

### 命令（等价操作）

在 DSH Web UI 中输入 `/weixin`：

| 命令 | 说明 | 对应界面 |
|---|---|---|
| `/weixin` 或 `/weixin status` | 查看通道与账号状态 | 「通道状态」 |
| `/weixin login` | 扫码登录（终端打印 ASCII 二维码） | 「连接微信」 |
| `/weixin accounts` | 列出已登录账号 | 「已登录账号」 |
| `/weixin start` | 启动轮询 | 「启动」按钮 |
| `/weixin stop` | 停止轮询 | 「停止」按钮 |

> 界面与命令操作同一份状态，二者可以混用。

## 配置

两种方式，任选其一：

1. **界面修改**（推荐）：设置页点点点，即时生效，存 `settings.json`
2. **编辑 `cordis.patch.yml`**：需要重启，且会被 UI 设置覆盖

注意：`config` 会**整体替换**该行，不与代码默认值合并。

```yaml
- insert:
    - id: dsh-weixin
      name: 'dsh-weixin'
      config:
        outbound:
          mode: final          # final | stream
        session:
          mode: single         # single | per-message
        allowFrom: []          # 微信用户白名单，空=不限制
```

### 配置项

| 字段 | 默认 | 界面可改 | 说明 |
|---|---|---|---|
| `enabled` | `true` | — | 是否启用通道（改后需重启） |
| `outbound.mode` | `final` | 是 | `final` 整段发送；`stream` 增量发送 |
| `outbound.minChars` | `1600` | 是（仅 stream） | 流式合并阈值（字符）。太小会让一次回答碎成八九个气泡 |
| `outbound.idleMs` | `3000` | 是（仅 stream） | 流式空闲合并窗口（毫秒） |
| `outbound.textChunkLimit` | `4000` | 是 | 单条消息最大字符数 |
| `outbound.sendGapMs` | `500` | 是 | 相邻消息最小间隔（毫秒）。低于此值易触发平台频控 `ret=-2 prepare failed` 并丢内容 |
| `globalPrompt` | `""` | 是 | 全局设定（提示词注入），支持 `{{weixin.fromUserId}}` 等占位符，上限 64KB |
| `media.inbound` | `true` | 是 | 是否把入站图片/语音/文件落盘后交给 Agent |
| `media.outbound` | `true` | 是 | 是否把 Agent 产出的文件回传微信 |
| `media.dir` | `""` | — | 媒体落盘根目录，空= `$DSH_HOME/storages/dsh-weixin/media` |
| `typingIndicator` | `true` | 是 | 是否发送"正在输入" |
| `replyProgressMessages` | `true` | 是 | 是否发送工具调用进度 |
| `replyThinking` | `false` | 是 | 是否把模型思考过程（reasoning 块）一并发出 |
| `allowFrom` | `[]` | 是 | 微信用户白名单，空=不限制 |
| `session.mode` | `single` | 是 | 每用户固定会话 / 每条消息新会话 |
| `session.cwd` | `""` | 是 | 会话工作目录，空=DSH 默认（改后需重启） |
| `session.idPrefix` | `weixin` | — | 会话 ID 前缀，避免与 Web UI 冲突 |
| `session.agentPreset` | `""` | — | Agent 预设 ID，空=用 DSH 默认预设。**留空时仍会自动取默认预设，否则 Agent 没有工具** |
| `channel.botAgent` | `dsh-weixin/0.1.0` | — | 写入 `base_info.bot_agent` |

## 数据位置

均位于 `$DSH_HOME`（默认 `~/.dsh`）：

```
~/.dsh/storages/dsh-weixin/settings.json            # UI 设置（可删，删后回默认）
~/.dsh/storages/dsh-weixin/accounts/index.json      # 账号索引
~/.dsh/storages/dsh-weixin/accounts/<id>.json       # 账号凭据
~/.dsh/storages/dsh-weixin/accounts/<id>.context-tokens.json
~/.dsh/logs/dsh-weixin-YYYY-MM-DD.log              # 日志（JSON Lines）
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `DSH_HOME` | DSH 主目录 |
| `DSH_WEIXIN_LOG_LEVEL` | 日志级别：TRACE/DEBUG/INFO/WARN/ERROR |
| `DSH_WEIXIN_LOG_STDOUT` | 设为 `0` 关闭 stdout 镜像 |
| `DSH_WEIXIN_ALLOW_ANY_VERSION` | 设为 `1` 跳过宿主版本校验 |

## 架构

```
L5 Web UI   侧栏图标 / 设置页 / 登录卡片        lib/client.js（浏览器 bundle）
L4 运维     扫码登录 / 账号存储 / 配置 / 命令    src/auth, src/commands, src/config-store
───────────────── HTTP /api/dsh-weixin/* ─────────────────
L3 桥接     入站 轮询→agent.followup ；出站 agent 事件→sendMessage
L2 适配     替换 openclaw/plugin-sdk 的 11 处依赖
L1 协议     getUpdates / sendMessage / CDN / AES / 长轮询退避
```

协议层端点与 header 约定（`iLink-App-Id`、`X-WECHAT-UIN`、`AuthorizationType`）
来自上游逆向结果，必须与 `@tencent-weixin/openclaw-weixin` 保持一致，不可自行推导。

### Web UI 层要点

浏览器插件有若干硬约束，改动前需知悉：

- 客户端 bundle 由 `dsh.client.platform` 声明后才会被扫描，入口是 `exports["./client"]`
- bundle 是**自包含单文件**：运行时只能 `require` 9 个基线模块（`react`、
  `react-dom`、`@deepseek-ai/cordis`、`dsh-client-ui-slots` 等），
  **不能**同步 require 相对的 `client*.js`，所以 `lib/client.js` 必须写成一个文件
- 侧栏用 `sidebar.panellist`（list slot，靠 `order` 排序，插件为 0，微信为 1）
- 主面板用 `main`（keyed slot），`key` 必须等于侧栏的 `id`
- 服务端路由走 `ctx.connection.fetch.register()`，`path` 必须是**完整的 `/api/...`**，
  只写相对段会被静默拒绝
- `connection` 服务只在 web profile 存在，故用 `ctx.inject(["connection"], cb)` 可选注入，
  不能写进静态 `inject` 数组（否则其他 profile 永久 pending）
- 改 `lib/client.js` **无需重启 Host**：bundle 的 rev 由文件 mtime/size 算出

## 源码地图

| 文件 | 职责 |
|---|---|
| `src/index.js` | 插件入口，声明 `name` / `inject` / `apply` |
| `src/config.js` | 配置默认值与归一化 |
| `src/config-store.js` | UI 设置 overlay：读写、校验、就地热更新、恢复默认 |
| `src/compat.js` | 宿主版本校验 |
| `src/protocol/api.js` | iLink 协议：长轮询、发送、CDN、uint64 精度保护 |
| `src/auth/accounts.js` | 账号存储与 ID 归一化 |
| `src/auth/login-qr.js` | 扫码登录状态机（支持 Web 注入验证码） |
| `src/bridge/context-tokens.js` | contextToken 持久化 |
| `src/channel/channel.js` | 通道运行时与状态汇总 |
| `src/commands/weixin-command.js` | `/weixin` 命令 |
| `src/web/routes.js` | Web UI 数据面，10 个 HTTP 端点 |
| `lib/client.js` | 浏览器端插件：侧栏图标 + 设置页（自包含单文件） |
| `src/util/*` | 路径、日志、脱敏、格式化 |

### HTTP 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dsh-weixin/state` | 通道快照 + 生效配置 + 已覆盖项 |
| POST | `/api/dsh-weixin/settings` | 写配置（校验 + 落盘 + 热更新） |
| POST | `/api/dsh-weixin/settings/reset` | 恢复默认（清 overlay + 回滚内存） |
| POST | `/api/dsh-weixin/login/start` | 发起扫码，返回二维码（含 PNG data URL） |
| GET | `/api/dsh-weixin/login/status` | 轮询登录进度 |
| POST | `/api/dsh-weixin/login/verify` | 提交数字验证码 |
| POST | `/api/dsh-weixin/login/cancel` | 取消登录 |
| POST | `/api/dsh-weixin/accounts/remove` | 删除账号 |
| POST | `/api/dsh-weixin/start` | 启动通道 |
| POST | `/api/dsh-weixin/stop` | 停止通道 |

## 已知限制

- 需要 DSH **≥ `0.2.0-rc.2`**。`compat.js` 在加载时比对版本：低于此版本直接抛错，
  高于则打 warn 放行（rc 阶段 API 向后兼容的面通常比向前兼容大）。确需跨版本试跑可设
  `DSH_WEIXIN_ALLOW_ANY_VERSION=1` 跳过校验。
- 仅支持单聊（DM），不支持群聊。
- 语音消息只保存 SILK 原始文件，未做 WAV 转码，Agent 拿到的是二进制。
- 出站文件依赖 Agent 主动调用写文件工具（`write`/`edit` 等）。只在正文里说“已生成”而没有
  真正落盘时，不会回传任何文件。
- `replyProgressMessages`（工具调用进度作为中间消息）尚未真正实现。
- iLink 协议为非公开接口，需跟随上游包更新。
- `enabled` 与 `session.cwd` 改动需重启才完全生效（两者只在启动路径上读取）。
- 界面只覆盖常用项；`session.idPrefix`、`channel.botAgent` 等仍需编辑配置文件。

## 许可

MIT。协议层代码源自 `@tencent-weixin/openclaw-weixin`（MIT）。
