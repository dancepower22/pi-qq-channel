#!/usr/bin/env node
/**
 * qq-bridge — 把 QQ 消息接到本机 CLI agent（pi 等）上
 *
 * 零依赖（Node >= 18，用内置 fetch / WebSocket）。
 * 架构：
 *   QQ Bot WebSocket（官方 API v2，op/identify/heartbeat）
 *     → 收到 C2C 单聊 / 群 @ 消息
 *     → 查允许名单（config.json 的 allowFrom）
 *     → 允许：起 `pi -p --session-id qq_<openid>` 拿回复 → 发回 QQ
 *     → 不允许：只记 OpenID，回一句"未授权"，不执行任何东西
 *
 * 安全设计（见 README）：默认**观察模式**——allowFrom 为空时，
 * 任何消息都只登记 OpenID、不执行 Pi。等老闫确认自己的 OpenID 后再放开。
 *
 * 用法：node bridge.js [--workspace <dir>] [--no-exec]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const CFG_FILE = path.join(ROOT, 'config.json');
const CRED_FILE = process.env.HOME + '/.config/qqbot/credentials.env';
const API = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
// 33554432 = 1<<25 = GROUP_AND_C2C_EVENT：群 @消息 + 单聊消息
const INTENTS = 33554432;

const PI_BIN = process.env.PI_BIN || 'pi';  // 多实例：可指向远端/特定安装的 pi 路径
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const NO_EXEC = argv.includes('--no-exec');
const WORKSPACE = path.resolve(argOf('--workspace', path.join(ROOT, 'workspace')));
const SESSION_DIR = path.join(ROOT, 'sessions');
const LOG_FILE = path.join(ROOT, 'bridge.log');
const PI_TIMEOUT_MS = 1000 * 60 * 30;   // 30 分钟：agent 跑「发多篇/配图」等长任务够用（从 6 分钟调大，短超时会杀任务）

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function loadCreds() {
  const txt = fs.readFileSync(CRED_FILE, 'utf8');
  const env = {};
  for (const l of txt.split('\n')) {
    if (!l.trim()) continue;
    const i = l.indexOf('=');
    env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  if (!env.QQ_APP_ID || !env.QQ_CLIENT_SECRET) throw new Error('凭据文件缺字段: ' + CRED_FILE);
  return env;
}

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); }
  catch (_) { return { allowFrom: [], groupAllowFrom: [] }; }
}

// ---------------- QQ 凭据 / 发送 ----------------
let token = null, tokenExp = 0;

async function getToken(force = false) {
  if (!force && token && Date.now() < tokenExp - 60000) return token;
  const cred = loadCreds();
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: cred.QQ_APP_ID, clientSecret: cred.QQ_CLIENT_SECRET }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('取 token 失败: ' + JSON.stringify(j));
  token = j.access_token;
  tokenExp = Date.now() + Number(j.expires_in || 7200) * 1000;
  log(`🔑 已获取 access_token（有效期 ${j.expires_in}s）`);
  return token;
}

const msgSeq = new Map();  // msg_id -> 序号（同一 msg_id 被动回复多条时递增）
function nextSeq(id) { const n = (msgSeq.get(id) || 0) + 1; msgSeq.set(id, n); if (msgSeq.size > 500) msgSeq.clear(); return n; }

async function send(kind, target, content, msgId) {
  const url = kind === 'c2c'
    ? `${API}/v2/users/${target}/messages`
    : `${API}/v2/groups/${target}/messages`;
  const body = { content, msg_type: 0 };
  if (msgId) { body.msg_id = msgId; body.msg_seq = nextSeq(msgId); }
  const t = await getToken();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `QQBot ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) log(`❌ 发送失败 ${r.status} ${txt.slice(0, 200)}`);
  else log(`📤 已回（${kind}/${target.slice(0, 8)}…）${content.slice(0, 40)}…`);
  return r.ok;
}

// ---------------- 起 Pi ----------------
function sessionIdFor(openid) {
  // 每个 QQ 用户固定一个会话 → 上下文连续
  return 'qq_' + require('crypto').createHash('sha1').update(openid).digest('hex').slice(0, 12);
}

function runPi(openid, nick, prompt) {
  return new Promise((resolve) => {
    const sid = sessionIdFor(openid);
    const args = [
      '-p', '--session-dir', SESSION_DIR, '--session-id', sid,
      '--name', `QQ:${nick || openid.slice(0, 6)}`,
      '--append-system-prompt',
      '你现在通过 QQ 聊天窗口跟老闫对话（不是终端）。回复要短、直接、口语化：'
      + '不要用 Markdown 表格和标题、不要长代码块（要贴代码就贴最关键几行）、'
      + '一次说清一件事。信息不够就反问，别猜。\n'
      + '【记忆纪律·必须遵守】你这条 QQ 线跟终端那条线【互相看不见】，共用的只有文件。所以：\n'
      + '① 值得长期记住的事（项目决策 / 老闫偏好 / 踩的坑 / 新线头）【当场】写下来，别攒到会话结束：\n'
      + '   方法/偏好/项目状态 → python3 ~/.agents/skills/pi-memory-evo/cards.py add --layer L1 --scene <writing|design|coding|ops|asset|collab> --text "一句话结论" [--tag a,b]\n'
      + '   任务型待办/线头 → 追加一行到 ~/.agents/memory/OPEN_LOOPS.md（**只追加，绝不整写**）\n'
      + '   写完顺手 python3 ~/.agents/skills/pi-memory-evo/cards.py build\n'
      + '② 引用记忆里带 ? 标记的卡片时，先说明“这条我没验过”；标 ★/✓ 的才可直接当事实引用。\n'
      + '③ 关键结论要写进回复正文（老闫看不到你心里记了什么，只看到 QQ 里那几行）。',
      prompt,
    ];
    log(`🤖 起 Pi 会话 ${sid} …`);
    const t0 = Date.now();
    // ⚠️ stdin 必须 ignore：pi 在 -p 模式会读管道 stdin 并合并进提示词，
    // 留着一个不关的管道 → pi 永远等 stdin EOF → 静默卡死（09-13 踩过，干等 2 分钟）
    const p = spawn(PI_BIN, args, { cwd: WORKSPACE, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    const killer = setTimeout(() => { timedOut = true; try { p.kill('SIGKILL'); } catch (_) {} log('⏱️ Pi 超时（30 分钟）'); }, PI_TIMEOUT_MS);
    p.on('close', (code) => {
      clearTimeout(killer);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      log(`✅ Pi 退出 code=${code} 用时 ${secs}s 输出 ${out.length} 字`);
      if (timedOut) return resolve('⏱️ 任务跑了 30 分钟还没完成，被保护性超时打断了（可能已完成一部分）。你可以让我继续做没做完的部分，或重新说一遍。');
      if (code !== 0 && !out.trim()) return resolve(`（我这边出错了 code=${code}）${err.slice(0, 200)}`);
      resolve(out.trim());
    });
    p.on('error', e => { clearTimeout(killer); resolve('（起不来 pi：' + e.message + '）'); });
  });
}

// ---------------- 消息处理 ----------------
const seen = new Set();   // 幂等：QQ 会重推

async function onMessage(kind, d) {
  const id = d.id;
  if (!id || seen.has(id)) return;
  seen.add(id); if (seen.size > 2000) seen.clear();

  const openid = kind === 'c2c' ? d.author?.user_openid : d.author?.member_openid;
  const nick = kind === 'c2c' ? (d.author?.username || '') : '';
  const text = (d.content || '').trim();
  const cfg = loadCfg();
  const list = kind === 'c2c' ? (cfg.allowFrom || []) : (cfg.groupAllowFrom || []);

  log(`📥 [${kind}] openid=${openid} nick=${nick} msg=${JSON.stringify(text.slice(0, 60))}`);

  if (!list.length) {
    // 观察模式：只登记，不执行
    log('🛡️ 观察模式：未配置允许名单，拒绝执行');
    await send(kind, kind === 'c2c' ? openid : d.group_openid,
      `桥已连通 ✅\n你的 openid：${openid}\n（现在是我在测试阶段，先不执行任务。把这个 openid 填进 config.json 的 allowFrom 后我才会真正干活。）`,
      id);
    return;
  }
  if (!list.includes(openid)) {
    log('🛡️ 不在允许名单，忽略');
    return;
  }
  if (NO_EXEC) {
    await send(kind, kind === 'c2c' ? openid : d.group_openid, `收到：${text}（--no-exec 模式，不执行）`, id);
    return;
  }

  await ack(kind, d);
  // 同一会话串行：两条消息同时到会并发跑同一个 session-id，可能相互踩（09-13 补）
  const mine = (busy.get(openid) || 0) + 1;
  busy.set(openid, mine);
  const prev = queues.get(openid) || Promise.resolve();
  const next = prev.then(async () => {
    const reply = await runPi(openid, nick, text);
    const body = reply.length > 1200 ? reply.slice(0, 1200) + '\n…（太长截断了）' : reply;
    await send(kind, kind === 'c2c' ? openid : d.group_openid, body || '（我没有输出）', id);
  }).catch(e => log('❌ 队列任务出错:', e.message))
    .finally(() => { const n = (busy.get(openid) || 1) - 1; n <= 0 ? busy.delete(openid) : busy.set(openid, n); });
  queues.set(openid, next);
}

const queues = new Map();   // openid -> Promise（串行队列）
const busy = new Map();     // openid -> 待处理条数

async function ack(kind, d) {
  // 即时反馈：不然任务跑着的时候 QQ 那边一片静默，人会以为挂了（09-13 实测痛点）
  try {
    const who = kind === 'c2c' ? d.author?.user_openid : d.group_openid;
    const n = busy.get(who) || 0;
    await send(kind, who, n > 0 ? `⏳ 前面还有 ${n} 条在跑，排队中…` : '👀 收到，我去看看…', d.id);
  } catch (e) { log('（ack 发送失败，忽略）', e.message); }
}

// ---------------- WebSocket 主循环 ----------------
let ws = null, heartbeat = null, lastSeq = 0, running = true, lastReadyAt = 0;

async function connect() {
  const t = await getToken();
  const r = await fetch(`${API}/gateway`, { headers: { 'Authorization': `QQBot ${t}` } });
  const j = await r.json();
  if (!j.url) throw new Error('取 ws 地址失败: ' + JSON.stringify(j));
  log('🔌 连接:', j.url.split('?')[0]);

  ws = new WebSocket(j.url);
  ws.onopen = () => log('✅ WebSocket 已连上');
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.s !== undefined && m.s !== null) lastSeq = m.s;
    switch (m.op) {
      case 10: { // Hello
        const iv = m.d.heartbeat_interval || 30000;
        ws.send(JSON.stringify({ op: 2, d: { token: `QQBot ${token}`, intents: INTENTS, properties: {} } }));
        clearInterval(heartbeat);
        heartbeat = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: lastSeq || null })); } catch (_) {} }, iv);
        log(`💓 心跳间隔 ${iv}ms，已 identify（intents=${INTENTS}）`);
        break;
      }
      case 0: // dispatch
        if (m.t === 'C2C_MESSAGE_CREATE') onMessage('c2c', m.d).catch(e => log('❌', e.message));
        else if (m.t === 'GROUP_AT_MESSAGE_CREATE') onMessage('group', m.d).catch(e => log('❌', e.message));
        else if (m.t === 'READY') { lastReadyAt = Date.now(); failStreak = 0; log('🎉 READY，机器人已上线:', JSON.stringify(m.d?.user || {}).slice(0, 120)); }
        break;
      case 7: log('↩️ 要求重连'); reconnect('服务端要求'); break;
      case 9: log('⚠️ session 失效，需重新 identify'); getToken(true).then(() => reconnect('session失效')).catch(e => { failStreak++; log('❌ 刷新 token 失败:', e.message); if (running) setTimeout(() => reconnect('token失败'), delayMs()); }); break;
      case 11: break; // heartbeat ACK
      default: break;
    }
  };
  ws.onclose = (e) => { log(`🔻 断开 code=${e.code} ${e.reason || ''}`); clearInterval(heartbeat); if (running) { if (lastReadyAt === 0 || Date.now() - lastReadyAt < 30000) failStreak++; reconnect('断开'); } };
  ws.onerror = (e) => log('⚠️ ws error', e.message || '');
}

let reconnecting = false;
let failStreak = 0;               // 连续失败 → 指数退避（READY 后 30s 内被踢也算失败）
function delayMs() {
  if (failStreak >= 8) return 30 * 60 * 1000;   // 疑似风控：长休眠 30 分钟再试，别打扰平台
  return Math.min(3000 * Math.pow(2, Math.min(failStreak, 6)), 60000);
}
function reconnect(reason) {
  if (reconnecting || !running) return;
  reconnecting = true;
  try { ws && ws.close(); } catch (_) {}
  clearInterval(heartbeat);
  const d = delayMs();
  log(`↻ ${reason || '重连'}｜${Math.round(d / 1000)}s 后（连续失败 ${failStreak}）`);
  setTimeout(async () => {
    reconnecting = false;
    try { await connect(); }   // 注意：connect 成功≠READY，failStreak 只在 READY 时复位
    catch (e) {
      failStreak++;
      log('❌ 重连失败:', e.message);
      if (running) setTimeout(() => reconnect('失败重试'), 500);
    }
  }, d);
}

process.on('SIGINT', () => { running = false; log('👋 收到 SIGINT，退出'); try { ws && ws.close(); } catch (_) {} process.exit(0); });

(async () => {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  // 防复发：目录缺执行位会导致 spawn 子进程 EACCES（2026-09-16 踩过），启动时强制修正
  try { fs.chmodSync(WORKSPACE, 0o755); fs.chmodSync(SESSION_DIR, 0o755); } catch (_) {}
  const cfg = loadCfg();
  log(`🚀 qq-bridge 启动 ｜ workspace=${WORKSPACE} ｜ 允许名单=${(cfg.allowFrom || []).length} 人`
      + (cfg.allowFrom && cfg.allowFrom.length ? '' : ' ｜ 🛡️ 观察模式（只登记 openid，不执行）'));
  try { await connect(); }
  catch (e) { failStreak = 2; log('❌ 启动失败:', e.message, '→ 指数退避重连（进程常驻等限流解除）'); reconnect('启动失败'); }
})();
