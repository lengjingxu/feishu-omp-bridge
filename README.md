# Feishu OMP Bridge

一个运行在本机的飞书中国版机器人桥接服务。它通过飞书应用长连接接收消息，把消息交给本机的 Codex `app-server` 或 Oh My Pi（OMP），再把中文卡片、流式进度和结果发回原来的私聊、群聊或话题。

## 主要能力

- 飞书应用长连接：不需要公网回调地址，也不需要把本机端口暴露到互联网。
- Codex 项目模式：从本地目录发现项目；项目不要求是 Git 仓库。
- 一个项目对应一个飞书项目群，一个 Codex 会话对应一个飞书话题。
- 在私聊中点击卡片选择项目，在项目群中选择历史会话或新建会话，之后直接用中文对话。
- 项目按最近一次未归档 Codex 会话的活动时间排序；归档会话不会出现在列表中。
- 使用本机 Codex 配置和登录状态。未显式指定模型、代理或服务等级时，不覆盖设备默认值。
- 运行进度、工具调用、审批、停止任务和继续追问均可通过飞书卡片完成。
- 保留 OMP RPC 后端，兼容已有的 OMP 工作流。

## 工作方式

```text
飞书应用长连接
        ↓
Feishu bridge
        ↓
Codex app-server（stdio）或 OMP RPC
        ↓
本地项目目录 / 本机工具
```

Codex 模式下的映射关系：

```text
本地项目目录  →  飞书项目群
Codex thread  →  飞书话题
chat_id + topic_id  →  Codex thread_id
```

这些内部 ID 默认只保存在本机映射文件中，不展示给普通用户。

## 环境要求

- Node.js 20 或更高版本
- pnpm
- 已安装并登录 Codex；确认本机可以运行 `codex app-server --help`
- 或已安装并配置 OMP；确认本机可以运行 `omp --mode rpc`
- 一个飞书中国版自建应用，启用机器人和应用长连接

## 安装

```bash
git clone https://github.com/lengjingxu/feishu-omp-bridge.git
cd feishu-omp-bridge
pnpm install
pnpm build
```

## 飞书应用配置

在飞书开放平台为自建应用完成以下配置：

1. 启用机器人能力。
2. 开启应用长连接，并订阅消息接收事件 `im.message.receive_v1`。
3. 按需开通发送消息、读取消息、创建群聊、创建话题和邀请成员等权限。
4. 发布应用版本，并确保当前账号可以使用该应用。

应用长连接由 Bridge 主动连接飞书服务器，因此不需要配置公网 Webhook 地址。App Secret 只在首次启动向导或本机密钥存储中使用，禁止写入 Git。

## 首次启动

```bash
node bin/feishu-omp-bridge.mjs run
```

首次启动会引导填写：

- 租户：选择 `feishu`（中国版）或 `lark`
- App ID
- App Secret

凭据会写入本机配置目录，App Secret 会迁移到本机加密 keystore。完成后，直接在飞书私聊机器人发送“项目”或点击“选择项目”。

## Codex 项目模式

在 `~/.feishu-omp-bridge/config.json` 中将后端设置为 `codex`，并填写允许展示的本地项目根目录：

```json
{
  "accounts": {
    "app": {
      "id": "cli_your_app_id",
      "tenant": "feishu",
      "secret": {
        "source": "exec",
        "provider": "feishu-omp-bridge",
        "id": "app-cli_your_app_id"
      }
    }
  },
  "preferences": {
    "agentBackend": "codex",
    "projectRoots": [
      "/Users/you/projects",
      "/Users/you/work"
    ]
  }
}
```

推荐先用启动向导生成配置，再只修改 `preferences`。不要把上面的占位符替换后提交到仓库。

### Codex 的默认配置

默认情况下 Bridge 不强制指定模型、代理、服务等级或自定义 provider，而是调用设备上的 Codex app-server，让它读取当前 Codex 的登录和配置。

在 macOS 上，如果没有显式设置 `codexAppServerBinary`，Bridge 会优先使用 ChatGPT 桌面应用自带的 Codex runtime；也可以用环境变量临时指定：

```bash
CODEX_CLI_PATH=/path/to/codex node bin/feishu-omp-bridge.mjs run
```

只有确实需要切换 runtime 时，才在配置中显式指定：

```json
{
  "preferences": {
    "codexAppServerBinary": "/path/to/codex"
  }
}
```

不要在 Bridge 配置中填写 `model_provider`、`service_tier` 或代理参数来复制设备配置；这类设置应由本机 Codex 自己管理。

### 飞书中的使用流程

1. 私聊机器人，发送“项目”或点击“选择项目”。
2. 在项目卡片中选择一个目录。项目不要求包含 `.git`。
3. Bridge 自动创建 `Codex · 项目名` 项目群，并发送欢迎卡片。
4. 在项目群点击“查看会话”，选择未归档的历史会话，或点击“新建会话”。
5. Bridge 在项目群中创建新的话题，并连接对应 Codex 会话。
6. 在话题中直接发送中文需求，不需要 `@机器人`、session ID 或英文命令。

私聊和项目群顶层支持这些中文入口：

```text
项目、我的项目、选择项目、开始
会话、查看会话、新建、新建会话
状态、停止、停止任务、帮助、怎么用
```

项目群顶层只处理项目级操作；普通自然语言消息应发送到已连接的话题中。

## OMP 模式

不设置 `agentBackend` 时，默认使用 OMP。也可以显式配置：

```json
{
  "preferences": {
    "agentBackend": "omp",
    "ompBinary": "omp",
    "ompSessionDir": "~/.feishu-omp-bridge/omp-sessions"
  }
}
```

OMP 模式保留原有的群聊、话题、卡片交互、工具调用、审批和 host tools 能力。

## 常用命令

```bash
node bin/feishu-omp-bridge.mjs run       # 前台运行
node bin/feishu-omp-bridge.mjs start     # 注册并启动后台服务
node bin/feishu-omp-bridge.mjs status    # 查看后台状态和日志
node bin/feishu-omp-bridge.mjs restart   # 重启后台服务
node bin/feishu-omp-bridge.mjs stop      # 停止后台服务
node bin/feishu-omp-bridge.mjs ps        # 查看本机 Bridge 进程
node bin/feishu-omp-bridge.mjs --help    # 查看完整帮助
```

后台服务使用 macOS `launchd`、Linux `systemd user` 或 Windows 任务计划程序。

高级用户仍可使用 `/status`、`/stop`、`/new`、`/config`、`/reconnect` 和 `/help` 等英文命令；它们不是主要入口。

## 本机数据和会话位置

默认目录为 `~/.feishu-omp-bridge/`：

| 文件或目录 | 用途 |
| --- | --- |
| `config.json` | 应用配置和 SecretRef，不应提交 |
| `secrets.enc` | 本机加密密钥存储 |
| `sessions.json` | 飞书 chat/topic 到 agent session 的映射 |
| `project-bindings.json` | 项目群和话题到 Codex session 的映射 |
| `logs/` | 运行日志，可能包含用户输入摘要 |
| `media/` | 飞书图片和文件缓存 |

Codex 原始会话仍由本机 Codex 管理，通常位于 `~/.codex/sessions/`。Bridge 只是通过 app-server 读取和继续这些会话，不会把完整会话内容提交到项目仓库。

## 群聊消息规则

默认群聊需要 `@机器人` 才会响应，私聊不需要。若希望群里不 @ 机器人也能触发，可在配置中设置：

```json
{
  "preferences": {
    "requireMentionInGroup": false
  }
}
```

生产环境建议同时配置 `allowedUsers`、`allowedChats` 和 `admins`，限制谁可以驱动本机 Agent 执行命令。

## 安全注意事项

- 不要提交 `config.json`、`secrets.enc`、日志、会话 JSONL、`.env` 或本机路径清单。
- 不要在 Issue、PR、截图或日志中公开 App Secret、用户 open_id、chat_id、thread_id 或完整个人路径。
- 本项目会让飞书用户驱动本机 Agent；请使用访问控制、固定项目根目录和最小工具权限。
- 如果凭据曾经误提交，必须立即在飞书开放平台重置 App Secret，并清理 Git 历史。

## 开发和验证

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## 许可证

MIT
