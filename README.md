# pi-qq-channel

**QQ 机器人 → pi coding agent 通道桥**（第三方 Agent 接入 QQ 的亲测方案）。

> 本 skill 为 **pi Agent 亲测方案**（2026-09-16 生产环境实战上线，稳定驱动 agent 写文章、跑任务），**其他 Agent 可以照猫画虎**——桥通过 `PI_BIN` 环境变量指定任意 CLI agent 入口。

零依赖 Node（>=18），无需 npm install。功能：

- ✅ 拉下来直接用，教程分 8 步（约 10 分钟）
- ✅ 每用户固定会话 → 上下文连续，不是每次失忆的新壳
- ✅ 观察模式安全起步（allowFrom 为空 = 只登记 openid 不执行）
- ✅ 指数退避 + 熔断：防死循环重连把 appId 打进平台风控（4903）
- ✅ 消息幂等去重 + 同用户串行排队
- ✅ 30 分钟长任务超时（写多篇/配图不杀任务）

---

## 教程（分 8 步，约 10 分钟）

### 第 1 步：创建 QQ 机器人（最关键）

浏览器打开 **https://q.qq.com/qqbot/openclaw/login.html**（用你的 QQ 登录）→ 点「**创建机器人**」→ 记下 **AppID** 和 **AppSecret**。

> ⚠️ **必须用快捷创建入口的新 Claw 机器人**。别用 `q.qq.com/#/apps` 里的旧/已认证机器人——被频繁连接打标后会稳定 **4903 create session error**（详见踩坑记录）。

### 第 2 步：拉代码

```bash
git clone https://github.com/<你的仓库>/pi-qq-channel
cd pi-qq-channel
```

### 第 3 步：填凭据

```bash
mkdir -p ~/.config/qqbot
cat > ~/.config/qqbot/credentials.env <<'CRED'
QQ_APP_ID=你的AppID
QQ_CLIENT_SECRET=你的AppSecret
CRED
chmod 600 ~/.config/qqbot/credentials.env
```

### 第 4 步：配置白名单（先观察模式）

`config.json` 的 `allowFrom` **先留空** —— 观察模式：任何人发消息只登记 openid，不执行任何东西。这是安全底线。

### 第 5 步：起桥

```bash
./run.sh start     # 启动（日志 /tmp/qqbridge.out）
./run.sh status    # 状态
./run.sh log       # 看最近日志
./run.sh stop      # 停止
./run.sh restart   # 重启（改 config 后必做）
```

### 第 6 步：验证 READY

日志出现下面这行即连接成功：

```
🎉 READY，机器人已上线: {"id":"...","username":"<机器人名>","bot":true}
```

### 第 7 步：揭 openid

用手机 QQ 给机器人发一条任意消息 → 日志出现：

```
📥 [c2c] openid=0123456789ABCDEF0123456789ABCDEF ...
```

把这个 openid 填进 `config.json` 的 `allowFrom`（数组里），然后 `./run.sh restart`。

### 第 8 步：放行测试

再发消息，桥会 spawn pi 干活并把回复发回 QQ。成功标志：日志 `✅ Pi 退出 code=0` + 回复到达。

---

## 接其他 Agent（照猫画虎）

桥通过 `PI_BIN` 环境变量指定 agent 入口：

```bash
PI_BIN=/path/to/your-agent ./run.sh start
# 或直接：PI_BIN=/path/to/your-agent node bridge.js
```

只要你的 agent 支持 `-p "prompt"`（非交互单次执行）模式即可。

## 换机器人（重要）

- openid **按 appId 区分**——换了机器人，openid 全变，要重新揭（重复第 7 步）。
- 桥的凭据在 `~/.config/qqbot/credentials.env`，换机器人就是改这个文件 + 重启。
- 被 4903 打标的机器人救不回来，直接弃用换新（见踩坑记录）。

## 踩坑记录（全部实测）

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| **机器人打标** | 所有环境 `4903 create session error`（本机/服务器都不行） | 死循环重连 4.7 万次 + 反复换 secret 测试 → appId 被平台标记；快捷创建的 Claw 机器人天生可用 | 弃用旧机器人，openclaw/login.html 快捷创建新的 |
| **扫码绑定≠解锁** | qqbot-connector 扫码绑定已有机器人后仍 4903 | 绑定只是授权，不改变机器人底层资质 | 别绑旧机器人，直接新建 |
| **spawn EACCES** | `spawn /path/pi EACCES`，直接执行却正常 | spawn 的 **cwd 目录权限 700 缺 x 位**（chdir 进不去） | 目录 `chmod 755`（桥启动会自动修） |
| **pi 静默卡死** | pi 永远不退出，等 2 分钟 | 子进程 **stdin 管道没关**，pi -p 等 EOF | `stdio: ['ignore','pipe','pipe']` |
| **长任务被杀** | 回用户"出错了 code=null" | 超时 6 分钟，SIGKILL 掉写多篇/配图的长任务 | 超时改 30 分钟 + 超时回友好提示 |
| **IP 白名单误判** | 本机 `11298 源IP不在白名单` | 开放平台安全设置里配了 IP 白名单 | 服务器公网 IP 加白名单，或清空（空白=不限） |
| **凭据泄露** | secret 出现在聊天记录/日志 | 口头/聊天传 secret | 用一阵子后到开放平台重置 AppSecret |

## 安全

- 凭据 `~/.config/qqbot/credentials.env` 权限 **600**，永不进 git。
- `allowFrom` 为空 = 观察模式（安全起步）；确认自己 openid 后再放行。
- 群消息默认不处理（`groupAllowFrom` 空）；需要群 @ 时单独配置。
- 桥给 agent 的是 shell 权限——**只对可信 openid 放行**。

## 文件

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 技能总纲（几步走 + 铁律 + 故障速查） |
| `bridge.js` | 桥本体（零依赖 Node，281 行） |
| `run.sh` | 起停脚本（start/stop/status/log/restart） |
| `config.json` | allowFrom 白名单（openid 列表） |
| `README.md` | 本教程 |
