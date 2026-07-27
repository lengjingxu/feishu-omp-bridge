# 飞书 OMP Bridge 使用说明

这是一个运行在本机的飞书中国版机器人桥接服务。它使用飞书应用长连接收发消息，把消息交给本机的 Codex `app-server` 或 Oh My Pi（OMP），再把中文卡片、执行进度和结果发回原来的私聊、群聊或话题。

英文 README：[README.md](README.md)

## 推荐体验：Codex 项目模式

```text
私聊 Bot
  → 点击“选择项目”
  → 选择本地项目目录
  → 自动创建项目群
  → 点击“查看会话”
  → 选择历史会话或新建会话
  → 自动创建话题
  → 在话题中直接用中文对话
```

映射关系固定为：

```text
一个本地项目目录  →  一个飞书项目群
一个 Codex 会话    →  一个飞书话题
```

项目按最近一次未归档 Codex 会话的活动时间排序。归档会话不会显示。项目只按本地目录识别，不要求目录是 Git 仓库，也不要求目录下存在特定文件。

## 安装前提

- Node.js 20+
- pnpm
- Codex 模式：本机已安装并登录 Codex，`codex app-server --help` 可运行
- OMP 模式：本机已安装并配置 OMP，`omp --mode rpc` 可运行
- 飞书中国版自建应用，已启用机器人和应用长连接

## 安装和构建

```bash
git clone https://github.com/lengjingxu/feishu-omp-bridge.git
cd feishu-omp-bridge
pnpm install
pnpm build
```

开发模式：

```bash
pnpm dev
```

## 飞书应用设置

在飞书开放平台配置自建应用：

1. 启用机器人能力。
2. 开启应用长连接。
3. 订阅消息接收事件 `im.message.receive_v1`。
4. 按需开通发送消息、读取消息、创建群聊、创建话题和邀请成员权限。
5. 发布应用版本，并确认当前账号可以使用该应用。

Bridge 会主动连接飞书服务器，因此不需要公网回调地址，也不需要把本机端口暴露到互联网。

## 首次启动

```bash
node bin/feishu-omp-bridge.mjs run
```

首次运行向导会要求填写租户、App ID 和 App Secret。中国版请选择 `feishu`。配置保存到本机后，App Secret 会迁移到加密 keystore；不要把配置文件复制到 Git 仓库。

## 配置 Codex 项目模式

编辑本机配置 `~/.feishu-omp-bridge/config.json`，将后端设为 `codex`，并指定可以被项目选择卡展示的目录根路径：

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

上面是脱敏示例。推荐先运行向导生成配置，再修改 `preferences`；不要把真实 App ID、Secret、个人路径、open_id 或 chat_id 提交到仓库。

### Codex 配置继承规则

Bridge 默认不设置模型、代理、服务等级或自定义 provider。它会调用设备上的 Codex app-server，由 Codex 自己读取登录状态和本机配置。

在 macOS 上，如果没有设置 `codexAppServerBinary`，Bridge 会优先使用 ChatGPT 桌面应用自带的 Codex runtime，以避免系统 PATH 中的旧 CLI 与桌面端模型缓存不兼容。确实需要切换时才显式配置：

```json
{
  "preferences": {
    "codexAppServerBinary": "/path/to/codex"
  }
}
```

临时覆盖也可以使用：

```bash
CODEX_CLI_PATH=/path/to/codex node bin/feishu-omp-bridge.mjs run
```

不要在 Bridge 配置中手工添加 `model_provider`、`service_tier` 或代理参数来模拟设备配置。

## 飞书中如何使用

### 私聊 Bot

发送“项目”“我的项目”“选择项目”或“开始”，即可打开项目卡片。也可以点击欢迎卡片中的“选择项目”。

### 选择项目

卡片展示项目名称、目录和最近使用情况。选择后会自动创建一个私有项目群，群名类似 `Codex · 项目名`，并发送项目欢迎卡片。

### 选择会话

进入项目群，点击“查看会话”。列表只显示该项目目录下未归档的 Codex 会话，并按最近活动时间排序。可以选择“继续此会话”，也可以点击“新建会话”。

### 进入话题

Bridge 会在项目群创建一个新的话题根消息，并把它绑定到选中的 Codex 会话。之后只在这个话题里直接发送中文需求即可，不需要记 session ID，也不需要输入英文命令。

项目群顶层只处理项目级操作，避免普通消息误触发 Codex。常用中文入口：

| 发送内容 | 作用 |
| --- | --- |
| 项目、我的项目、选择项目 | 打开项目列表 |
| 会话、查看会话 | 打开当前项目的会话列表 |
| 新建、新建会话 | 创建新的 Codex 会话 |
| 状态、当前状态 | 查看当前项目或话题状态 |
| 停止、停止任务 | 中断当前任务 |
| 帮助、怎么用 | 打开帮助卡片 |

## OMP 模式

不设置 `agentBackend` 时，默认使用 OMP。已有 OMP 配置可以继续使用：

```json
{
  "preferences": {
    "agentBackend": "omp",
    "ompBinary": "omp",
    "ompSessionDir": "~/.feishu-omp-bridge/omp-sessions"
  }
}
```

OMP 模式支持飞书私聊、群聊、话题、流式卡片、工具调用、审批和 host tools。

## 常用命令

```bash
node bin/feishu-omp-bridge.mjs run
node bin/feishu-omp-bridge.mjs start
node bin/feishu-omp-bridge.mjs status
node bin/feishu-omp-bridge.mjs restart
node bin/feishu-omp-bridge.mjs stop
node bin/feishu-omp-bridge.mjs ps
node bin/feishu-omp-bridge.mjs --help
```

后台服务使用 macOS `launchd`、Linux `systemd user` 或 Windows 任务计划程序。

英文命令仍兼容，例如 `/status`、`/stop`、`/new`、`/config`、`/reconnect`、`/help`，但普通用户不需要记忆它们。

## 群聊是否需要 @机器人

默认情况下，普通群聊和话题群需要 `@机器人` 才响应，私聊不需要。若要允许群内不 @ 机器人也能触发：

```json
{
  "preferences": {
    "requireMentionInGroup": false
  }
}
```

项目话题连接后，直接在话题中发送消息即可；是否需要 @ 机器人取决于上述配置。

## 本机数据目录

默认目录：`~/.feishu-omp-bridge/`

| 文件或目录 | 作用 |
| --- | --- |
| `config.json` | 应用配置和 SecretRef |
| `secrets.enc` | 本机加密密钥存储 |
| `sessions.json` | 飞书 chat/topic 到 agent session 的映射 |
| `project-bindings.json` | 项目群、话题和 Codex session 的映射 |
| `logs/` | 结构化日志 |
| `media/` | 飞书图片和文件缓存 |

Codex 原始会话通常由本机 Codex 保存在 `~/.codex/sessions/`。Bridge 通过 app-server 读取和继续会话，不会把会话内容写进本项目。

## 安全要求

- 不要提交 `config.json`、`secrets.enc`、日志、会话 JSONL、`.env` 或本机路径清单。
- 不要公开 App Secret、用户 open_id、chat_id、topic_id、Codex thread_id 或完整个人路径。
- 建议配置 `allowedUsers`、`allowedChats` 和 `admins`，限制可以驱动本机 Agent 的用户和群聊。
- 建议只开放必要的 `projectRoots`，不要把整个用户目录作为项目根目录。
- 如果凭据误提交，立即在飞书开放平台重置 App Secret，并清理 Git 历史。

## 测试

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 故障排查

### 项目列表为空

确认 `projectRoots` 是存在的本地目录，并且 Bridge 进程对这些目录有读取权限。项目不要求是 Git 仓库。

### 历史会话没有显示

会话列表按项目目录过滤，并隐藏已归档会话。确认 Codex 桌面端和 Bridge 使用的是同一个本机用户和 Codex 数据目录。

### 飞书群里没有回复

确认消息位于已连接的话题中；普通项目群顶层只响应项目卡片和快捷入口。普通群聊还要检查是否 @ 机器人，或将 `requireMentionInGroup` 设置为 `false`。

### 模型或 service tier 报错

不要在 Bridge 中硬编码模型、provider 或 service tier。先确认设备上的 Codex 能正常启动，再确认 Bridge 使用的是桌面端 runtime 或通过 `CODEX_CLI_PATH` 指定了正确的 Codex binary。

### Codex 桌面端暂时看不到飞书新消息

消息会先写入本机 Codex session，并通过 app-server 正常执行。桌面端列表可能不会实时刷新外部 app-server 写入的轮次；重新打开或刷新对应 Codex 任务即可查看。

## 开发

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
```

## 许可证

MIT
