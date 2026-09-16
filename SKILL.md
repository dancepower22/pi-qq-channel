---
name: pi-qq-channel
description: >-
  QQ 机器人 → pi coding agent 的通道桥（第三方 Agent 接入 QQ）。
  **本 skill 为 pi Agent 亲测方案（2026-09-16 生产实战），其他 Agent 可以照猫画虎**。
  拉下来直接用：快捷创建 QQ 机器人 → 填凭据 → 起桥 → 发消息揭 openid → 放行。
  零依赖 Node，每用户固定会话上下文连续；观察模式安全起步；指数退避+熔断防被平台打标。
  触发词：QQ 通道、QQ 接入、QQ 机器人、QQ 桥、接 QQ、qq channel、qq-bridge、agent 接 QQ。
requires: node>=18, pi(或任意 CLI agent)
---

# pi-qq-channel — QQ 机器人 → pi 通道桥

> 把 QQ 消息接到你的 pi（或其他 CLI agent）：QQ 用户给机器人发消息 → 桥 spawn pi 跑 → 回复发回 QQ。
> 2026-09-16 生产环境实战沉淀。

## 架构

```
QQ 用户 ──> QQ Bot 开放平台 ──WebSocket──> bridge.js
                                             │ 查 allowFrom 白名单
                                             ├─ 不在名单：只登记 openid，不执行
                                             └─ 在名单：spawn pi -p --session-id qq_<hash> "消息"
                                                          │（每用户固定 session → 上下文连续）
QQ 用户 <── REST /v2/users/{openid}/messages <────────────┘
```

## 几步走（新环境，约 10 分钟）

1. **创建机器人**：浏览器打开 `https://q.qq.com/qqbot/openclaw/login.html`（用你的 QQ 登录）→ 点「创建机器人」→ 记下 AppID 和 AppSecret。
   ⚠️ **必须用快捷创建的新机器人**。别用 q.qq.com/#/apps 里的旧/认证过的机器人——被频繁连接打标后会 **4903 create session error**（见铁律 1）。
2. **拉代码**：`git clone https://github.com/<你的仓库>/pi-qq-channel`（本仓库就是）。
3. **填凭据**：写 `~/.config/qqbot/credentials.env`（chmod 600）：
   ```
   QQ_APP_ID=你的AppID
   QQ_CLIENT_SECRET=你的AppSecret
   ```
4. **配置**：`config.json` 的 `allowFrom` 先留空（观察模式：任何人发消息只登记 openid，不执行任何东西）。
5. **起桥**：`./run.sh start`（日志 `/tmp/qqbridge.out`，状态 `./run.sh status`）。
6. **验证 READY**：日志出现 `🎉 READY，机器人已上线` 即连接成功。
7. **揭 openid**：从 QQ 给机器人发一条任意消息 → 日志出现 `📥 [c2c] openid=xxxx` → 把这个 openid 填进 `config.json` 的 `allowFrom` → `./run.sh restart`。
8. **放行测试**：再发消息，桥会 spawn pi 干活并回复。

## 铁律（违反即翻车，全部实测踩过）

1. **机器人必须用快捷创建入口（openclaw/login.html）的新 Claw 机器人**——qqbot-connector 扫码"绑定"已有机器人 ≠ 解锁；被死循环重连/反复测试打标的 appId 会稳定 4903（本机/服务器都连不上），只能弃用换新。
2. **严禁死循环重连**：桥已内置指数退避（7s→61s）+ 熔断（连续失败 ≥8 次 → 长休眠 30 分钟）。改掉 = 把自己 appId 打进平台风控。
3. **spawn 的 cwd 目录必须有执行位**：目录权限 `700 缺 x` 会报 `spawn ... EACCES`（2026-09-16 踩过）。桥启动会自动 chmod 755，别手动改成 700。
4. **子进程 stdin 必须 `ignore`**：`pi -p` 会读 stdin 并合并进提示词，留着一个不关的管道 → pi 永远等 EOF → 静默卡死。
5. **长任务超时设 30 分钟**：6 分钟会 SIGKILL 掉"写多篇/配图"这类长任务，还会回用户一句误导的"出错了"。
6. **凭据安全**：`credentials.env` 权限 600、永不进 git；AppSecret 一旦出现在聊天记录/日志里，用一阵子后到开放平台重置。
7. **观察模式起步**：`allowFrom` 为空 = 任何消息只登记 openid 不执行。确认自己的 openid 后再放行，这是安全底线。
8. **openid 按 appId 区分**：换了机器人，openid 全变，要重新揭。

## 技术要点

- 零依赖 Node（>=18）：内置 fetch / WebSocket，无需 npm install（除扫码绑定 qqbot-connector 外）。
- `PI_BIN` 环境变量指定 agent 入口（默认 `pi`）——桥可接任意 CLI agent。
- 每用户固定 `--session-id qq_<hash>` → 上下文连续，不是每次失忆的新壳。
- 幂等去重：QQ 会重推消息，桥按 msg id 去重。
- 消息排队：同用户多消息串行处理（`⏳ 前面还有 N 条` 提示）。
- 会话隔离：`workspace/`、`sessions/` 目录随桥本地存放，删桥即清。

## 文件

| 文件 | 作用 |
|---|---|
| `bridge.js` | 桥本体（零依赖 Node） |
| `run.sh` | 起停（`start/stop/status/log/restart`） |
| `config.json` | allowFrom 白名单（openid 列表） |
| `README.md` | 完整教程（分步 + 踩坑） |

## 故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `4903 create session error` | appId 被平台打标 | 弃用旧机器人，快捷创建新机器人 |
| `spawn ... EACCES` | cwd 目录缺执行位 | 桥已自动修；手动 `chmod 755 workspace sessions` |
| `code=null` 回"出错了" | 6 分钟超时杀任务 | 已改 30 分钟；让用户重发继续 |
| `11298 源IP不在白名单` | 开放平台配了 IP 白名单 | 把服务器公网 IP 加进白名单，或清空白名单 |
| 频繁 `1005` 断开 | 服务端要求重连（正常） | 桥自动退避重连，观察即可 |
| 消息只登记不回复 | 观察模式 | 填 allowFrom 后重启 |
