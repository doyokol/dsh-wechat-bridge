// DSH × 微信桥接 —— 独立常驻服务
// 职责：唯一一处与微信通道打交道的地方，支持两种 hook 后端（config.hookMode）
//   · wechatagent：复用已装的 WeChatAgent（reader 5031 收、hook 30001 发，图片走 /SendStickerMsg 只能 GIF）
//   · native：用本项目自己编译的 WeChat-Hook（hook 30002 发，/SendTextMsg + /SendImgMsg 直接发 PNG）
//   · 收：连 reader 的 SSE（默认 http://127.0.0.1:5031/api/v1/push/messages）
//   · 对外：给 DSH 插件提供本地 HTTP/SSE 接口，并提供网页管理面板
// DSH 插件（native-context.mjs）只做“消息 → DSH 会话 → 回复”的转发，不碰微信。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const LOG_FILE = path.join(ROOT, 'bridge.log');
const PANEL_FILE = path.join(ROOT, 'panel.html');

const DEFAULTS = {
  dataRoot: '',
  hookMode: 'wechatagent',
  readerUrl: 'http://127.0.0.1:5031',
  hookUrl: 'http://127.0.0.1:30001',
  workspace: path.join(ROOT, 'workspace'),
  allow: [],
  paused: false,
  proactive: true,
  mergeSeconds: 3,
  rateLimitPerMin: 10,
  silent: false,
  serverHost: '127.0.0.1',
  serverPort: 17890,
  ffmpegPath: '',
};

const readText = file => { try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim(); } catch { return ''; } };
const readJsonFile = file => { try { return JSON.parse(readText(file)); } catch { return null; } };

function loadConfig() {
  const stored = readJsonFile(CONFIG_FILE) ?? {};
  const cfg = { ...DEFAULTS, ...stored };
  if (!cfg.dataRoot) {
    const fallback = 'D:/APP/AI/DSH-Wechat/WeChatAgent/data/workspace';
    if (fs.existsSync(fallback)) cfg.dataRoot = fallback;
  }
  if (!cfg.workspace) cfg.workspace = path.join(ROOT, 'workspace');
  return cfg;
}

function patchConfig(patch) {
  const stored = readJsonFile(CONFIG_FILE) ?? {};
  const next = { ...stored, ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return loadConfig();
}

function log(...args) {
  const text = args.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ');
  const line = `[${new Date().toISOString()}] ${text}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  try { console.log('[wechat-bridge]', text); } catch {}
}

let cfg = loadConfig();
let account = '';
let wechatVersion = '';
let readerConnected = false;
let readerLastAt = 0;
const clients = new Set();
const seen = new Set();

const isNative = () => cfg.hookMode === 'native';

function hookToken() {
  if (isNative()) return cfg.hookToken || '';
  return cfg.hookToken
    || readText(path.join(cfg.dataRoot, 'state/hook/native-token.txt'))
    || readText(path.join(cfg.dataRoot, 'state/hook/wechatagent-hook.token'));
}

function readerToken() {
  const io = readJsonFile(path.join(cfg.dataRoot, 'state/wechat-io-config.json')) ?? {};
  return io.reader_token ?? '';
}

function request(url, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? '' : JSON.stringify(body);
    const h = { ...headers };
    if (payload) {
      h['content-type'] = 'application/json';
      h['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(url, { method, headers: h }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, raw, data: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function refreshAccount() {
  try {
    const token = hookToken();
    const auth = token ? { authorization: 'Bearer ' + token } : {};
    if (isNative()) {
      // 新版原生 hook 走 /WeChatAgent/health（返回 databaseAccounts / version）；
      // 老版本只有 /GetSelfProfile，作为兜底各自试一次。
      const health = await request(cfg.hookUrl + '/WeChatAgent/health', { headers: auth });
      if (health.status === 200) {
        const data = health.data ?? {};
        wechatVersion = String(data.version ?? '') || String(cfg.wechatVersion ?? 'native');
        const accounts = Array.isArray(data.databaseAccounts) ? data.databaseAccounts : [];
        if (accounts.length === 1) { if (account !== accounts[0]) log('hook account:', accounts[0]); account = String(accounts[0]); }
        else if (accounts.length > 1) log('hook account candidates:', JSON.stringify(accounts));
        account = account || String(cfg.selfWxid ?? '');
        return;
      }
      const res = await request(cfg.hookUrl + '/GetSelfProfile', { method: 'POST', body: {}, headers: auth });
      // 注意：上游 4.1.10.27 的 SelfInfo 从不填充，wxid 常为空，但发送接口本身可用，所以只要 200 就算就绪
      if (res.status !== 200) { log('native hook 未就绪:', res.status, health.status); account = account || String(cfg.selfWxid ?? ''); wechatVersion = String(cfg.wechatVersion ?? 'native'); return; }
      const wxid = String(res.data?.wxid || '');
      if (wxid && account !== wxid) log('native hook self:', wxid);
      account = wxid || account || (cfg.selfWxid ? String(cfg.selfWxid) : '');
      wechatVersion = String(cfg.wechatVersion ?? 'native');
      return;
    }
    const res = await request(cfg.hookUrl + '/WeChatAgent/health', { headers: auth });
    if (res.status === 401) { log('hook health 401（token 可能已刷新）'); return; }
    const data = res.data ?? {};
    wechatVersion = String(data.version ?? '');
    const accounts = Array.isArray(data.databaseAccounts) ? data.databaseAccounts : [];
    if (accounts.length === 1) {
      if (account !== accounts[0]) log('hook account:', accounts[0]);
      account = String(accounts[0]);
    } else if (accounts.length > 1) {
      log('hook account candidates:', JSON.stringify(accounts));
    }
  } catch (error) {
    log('hook health failed:', error.message);
  }
}

async function hookPost(pathname, body, retried = false) {
  const headers = {};
  const native = isNative();
  const token = hookToken();
  if (token) headers.authorization = 'Bearer ' + token;
  const acct = account || (native ? String(cfg.selfWxid ?? '') : '');
  if (acct) headers['x-wechatagent-account'] = acct;
  const res = await request(cfg.hookUrl + pathname, { method: 'POST', body, headers });
  if ((res.status === 401 || res.status === 409) && !retried) {
    await refreshAccount();
    return hookPost(pathname, body, true);
  }
  if (res.status !== 200) throw new Error('hook ' + res.status + ' ' + res.raw.slice(0, 200));
  const data = res.data ?? {};
  if (data.ret !== undefined && data.ret !== 0) {
    throw new Error('hook 发送失败: ' + (data.error || data.retmsg || res.raw.slice(0, 200)));
  }
  return data;
}

async function sendText(talker, text) {
  if (!text) return;
  await hookPost('/SendTextMsg', { wxidorgid: talker, msg: String(text).slice(0, 16000) });
}

function imageSize(raw, ext) {
  try {
    if (ext === '.png' && raw.length > 24) return { width: raw.readUInt32BE(16), height: raw.readUInt32BE(20) };
    if (ext === '.gif' && raw.length > 10) return { width: raw.readUInt16LE(6), height: raw.readUInt16LE(8) };
    if (ext === '.jpg' || ext === '.jpeg') {
      let i = 2;
      while (i < raw.length) {
        if (raw[i] !== 0xff) { i++; continue; }
        const marker = raw[i + 1];
        const len = raw.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: raw.readUInt16BE(i + 5), width: raw.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {}
  return { width: 0, height: 0 };
}

const FFMPEG_CANDIDATES = () => [
  cfg.ffmpegPath,
  'C:/Users/doyokol/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe',
  'ffmpeg',
].filter(Boolean);

function findFfmpeg() {
  for (const candidate of FFMPEG_CANDIDATES()) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore' });
      return candidate;
    } catch {}
  }
  return '';
}

// 微信表情通道只认 .gif（SendStickerFile 里强制 extension == ".gif"），其他格式先转单帧 GIF。
// 清晰度由缩放宽度决定：原来固定 480px，1920 宽的截图缩到 480 后彻底看不清字。
// 现在按体积从大到小挑第一个不超过 8MB 的档位，尽量保住原始分辨率。
const STICKER_MAX_BYTES = 8 * 1024 * 1024;
const GIF_WIDTH_STEPS = [1600, 1280, 960, 720, 480];
const GIF_CACHE_TAG = 'v2';

function toGif(filePath, raw, ext) {
  const cacheDir = path.join(cfg.workspace, '.outgoing');
  fs.mkdirSync(cacheDir, { recursive: true });
  const stem = crypto.createHash('md5').update(raw).digest('hex');
  const out = path.join(cacheDir, stem + '-' + GIF_CACHE_TAG + '.gif');
  if (fs.existsSync(out)) return out;
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('需要 ffmpeg 才能把 ' + ext + ' 图片转成微信可发送的 GIF');
  let lastError = null;
  for (const width of GIF_WIDTH_STEPS) {
    try {
      execFileSync(ffmpeg, [
        '-y', '-loglevel', 'error', '-i', filePath,
        '-vf', "scale='min(" + width + ",iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
        '-loop', '0', out,
      ], { stdio: 'pipe' });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!fs.existsSync(out)) {
      lastError = new Error('ffmpeg 转换失败：没有产出文件');
      continue;
    }
    const size = fs.statSync(out).size;
    if (size <= STICKER_MAX_BYTES) {
      log('converted to gif:', out, width + 'px', size + 'B');
      return out;
    }
    fs.rmSync(out, { force: true });
    lastError = new Error('转换出的 GIF 超过 8MB（' + width + 'px）');
  }
  throw lastError || new Error('ffmpeg 转换失败');
}

async function sendImage(talker, filePath) {
  if (!fs.existsSync(filePath)) throw new Error('图片不存在: ' + filePath);
  // native 模式：优先自建 hook 的原图接口（/SendImgMsg）；新版 hook 只有表情通道时自动回退。
  if (isNative()) {
    const abs = path.resolve(filePath);
    if (fs.statSync(abs).size > 25 * 1024 * 1024) throw new Error('图片太大（上限 25MB）: ' + abs);
    try {
      await hookPost('/SendImgMsg', { wxidorgid: talker, path: abs });
      return abs;
    } catch (error) {
      if (!/hook 404/.test(String(error.message))) throw error;
      log('native hook 没有 /SendImgMsg，回退表情通道:', abs);
    }
  }
  const source = fs.readFileSync(filePath);
  // 表情通道真正的体积上限由转出来的 GIF 决定（见 toGif），这里只挡明显过大的源文件。
  if (source.length > 25 * 1024 * 1024) throw new Error('图片太大（上限 25MB）: ' + filePath);
  const ext = path.extname(filePath).toLowerCase() || '.png';
  if (!['.png', '.gif', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) throw new Error('不支持的图片类型: ' + ext);
  const gifPath = ext === '.gif' ? filePath : toGif(filePath, source, ext);
  const raw = ext === '.gif' ? source : fs.readFileSync(gifPath);
  const md5 = crypto.createHash('md5').update(raw).digest('hex');
  const outgoing = path.join(cfg.dataRoot, 'state', 'stickers', 'outgoing');
  fs.mkdirSync(outgoing, { recursive: true });
  const target = path.join(outgoing, md5 + '.gif');
  if (!fs.existsSync(target)) fs.writeFileSync(target, raw);
  const { width, height } = imageSize(raw, '.gif');
  await hookPost('/SendStickerMsg', {
    wxidorgid: talker,
    sticker: { md5, productid: '', len: raw.length, type: 1, width, height },
    path: target,
  });
  return target;
}

// ---------- 表情包：直接用 dsh-meme 插件的图库（~/.dsh/meme-packs/<pack>/memes/<mood>/） ----------

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function memeRoots() {
  const roots = [];
  if (cfg.memeRoot) roots.push(cfg.memeRoot);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) roots.push(path.join(home, '.dsh', 'meme-packs'));
  return roots.filter(root => { try { return fs.statSync(root).isDirectory(); } catch { return false; } });
}

// 当前激活的图库优先，其余包一起用（mood 只取标准六类）
function listMemeFiles() {
  const packDirs = [];
  for (const root of memeRoots()) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const memesDir = path.join(root, entry.name, 'memes');
      try { if (fs.statSync(memesDir).isDirectory()) packDirs.push(memesDir); } catch {}
    }
  }
  const byMood = new Map();
  for (const memesDir of packDirs) {
    let moods = [];
    try { moods = fs.readdirSync(memesDir, { withFileTypes: true }); } catch { continue; }
    for (const moodEntry of moods) {
      if (!moodEntry.isDirectory()) continue;
      const mood = moodEntry.name;
      const dir = path.join(memesDir, mood);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      const files = names.filter(n => IMAGE_EXTS.has(path.extname(n).toLowerCase())).map(n => path.join(dir, n));
      if (!files.length) continue;
      if (!byMood.has(mood)) byMood.set(mood, []);
      byMood.get(mood).push(...files);
    }
  }
  return byMood;
}

function memeSummary() {
  const byMood = listMemeFiles();
  const moods = {};
  let total = 0;
  for (const [mood, files] of byMood) { moods[mood] = files.length; total += files.length; }
  return { total, moods };
}

// SendImgMsg 走的原生发图，webp/bmp 先转 png 稳妥
function toPng(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.webp', '.bmp'].includes(ext)) return filePath;
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('需要 ffmpeg 才能把 ' + ext + ' 表情转成 png');
  const cacheDir = path.join(cfg.workspace, '.meme-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, crypto.createHash('md5').update(filePath + fs.statSync(filePath).mtimeMs).digest('hex') + '.png');
  if (!fs.existsSync(out)) {
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', filePath, out], { stdio: 'pipe' });
  }
  return fs.existsSync(out) ? out : filePath;
}

function pickMeme(mood, query = '') {
  const byMood = listMemeFiles();
  const wanted = String(mood || '').trim().toLowerCase();
  let pool = byMood.get(wanted);
  if (!pool || !pool.length) {
    const all = [...byMood.values()].flat();
    if (!all.length) throw new Error('表情包图库是空的（~/.dsh/meme-packs）');
    pool = all;
  }
  const needle = String(query || '').trim().toLowerCase();
  if (needle) {
    const matched = pool.filter(file => path.basename(file).toLowerCase().includes(needle));
    if (matched.length) pool = matched;
  }
  const picked = pool[crypto.randomInt(pool.length)];
  return { file: picked, mood: wanted || 'any' };
}

async function sendMeme(talker, mood, query = '') {
  const { file, mood: used } = pickMeme(mood, query);
  const prepared = toPng(file);
  await sendImage(talker, prepared);
  return { file: prepared, source: file, mood: used, name: path.basename(file) };
}

function allowed(talker) {
  const list = cfg.allow ?? [];
  return list.includes('*') || list.some(item => talker === item || talker.includes(item));
}

// ---------- reader → 本地 SSE ----------

function broadcastFrame(frame) {
  const text = 'data: ' + JSON.stringify(frame) + '\n\n';
  for (const res of clients) {
    try { res.write(text); } catch {}
  }
}

function broadcast(payload) {
  broadcastFrame({ type: 'message', payload });
}

// ---------- 定时提醒：让助手能在过一会儿主动给用户发消息 ----------

const REMINDERS_FILE = path.join(ROOT, 'reminders.json');

function loadReminders() {
  const data = readJsonFile(REMINDERS_FILE);
  return Array.isArray(data) ? data : [];
}

function saveReminders(list) {
  try { fs.writeFileSync(REMINDERS_FILE, JSON.stringify(list, null, 2), 'utf8'); } catch (error) { log('save reminders failed:', error.message); }
}

function addReminder(talker, minutes, note) {
  const list = loadReminders();
  const item = {
    id: crypto.randomUUID().slice(0, 8),
    talker: String(talker),
    note: String(note ?? '').slice(0, 500),
    dueAt: Date.now() + Math.max(1, Math.round(Number(minutes) * 60000)),
    createdAt: Date.now(),
  };
  list.push(item);
  saveReminders(list);
  log('reminder added:', item.id, item.talker, 'in', minutes, 'min', item.note.slice(0, 40));
  return item;
}

function fireReminders() {
  if (cfg.proactive === false) return; // 主动发送关闭：到点的提醒先压着，等开关打开再发
  const list = loadReminders();
  if (!list.length) return;
  const now = Date.now();
  const due = list.filter(item => Number(item.dueAt) <= now);
  if (!due.length) return;
  saveReminders(list.filter(item => Number(item.dueAt) > now));
  for (const item of due) {
    log('reminder due:', item.id, item.talker, item.note.slice(0, 40));
    broadcastFrame({ type: 'wake', payload: { id: item.id, talker: item.talker, note: item.note, dueAt: item.dueAt } });
  }
}

function onReaderMessage(payload) {
  if (!payload || payload.event !== 'message.new') return;
  const talker = String(payload.sessionId ?? '');
  const rawid = String(payload.rawid ?? '');
  if (!talker || !rawid || seen.has(rawid)) return;
  seen.add(rawid);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  if (cfg.paused) return;
  if (!allowed(talker)) return;
  if (payload.type !== 1 && payload.type !== 3) return;
  if (!String(payload.content ?? '').trim()) return;
  readerLastAt = Date.now();
  log('message:', talker, String(payload.content ?? '').slice(0, 60));
  broadcast(payload);
}

let reconnectTimer = null;

function scheduleReconnect(ms) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectReader(); }, ms);
}

function connectReader() {
  if (reconnectTimer) return;
  const url = cfg.readerUrl + '/api/v1/push/messages';
  const req = http.get(url, { headers: { authorization: 'Bearer ' + readerToken() } }, res => {
    if (res.statusCode !== 200) {
      log('reader status', res.statusCode, '（会话未选中或 token 失效）');
      res.resume();
      scheduleReconnect(5000);
      return;
    }
    readerConnected = true;
    log('reader connected');
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try { onReaderMessage(JSON.parse(line.slice(5).trim())); } catch {}
        }
      }
    });
    res.on('end', () => { readerConnected = false; scheduleReconnect(3000); });
    res.on('error', () => { readerConnected = false; scheduleReconnect(3000); });
  });
  req.on('error', error => {
    log('reader error:', error.message);
    readerConnected = false;
    scheduleReconnect(5000);
  });
}

// ---------- 连接微信（WeChatAgent 侧检查/启动/修配置） ----------

const WECHATAGENT_EXE = 'D:/APP/AI/DSH-Wechat/WeChatAgent/WeChatAgent.exe';
const WECHATAGENT_CONFIG = () => path.join(cfg.dataRoot, 'config/wechatagent.json');

const WECHAT_RUNTIME = () => path.join(ROOT, 'runtime', 'wechat-' + String(cfg.wechatVersion || '4.1.10.27'));

function weixinPaths() {
  if (process.platform !== 'win32') return [];
  try {
    const script = "$p = Get-CimInstance Win32_Process -Filter \"Name='Weixin.exe'\" | Select-Object -ExpandProperty ExecutablePath; ($p | Where-Object { $_ }) -join ';'";
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
    return String(out).split(';').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

function startOurWeixin() {
  const dir = WECHAT_RUNTIME();
  const exe = path.join(dir, 'Weixin.exe');
  if (!fs.existsSync(exe)) throw new Error('找不到微信副本：' + exe);
  const port = new URL(cfg.hookUrl).port || '30002';
  const child = spawn(exe, ['StartPort=' + port], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return exe;
}

function wechatAgentRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq WeChatAgent.exe', '/NH'], { encoding: 'utf8' });
    return /WeChatAgent\.exe/i.test(out);
  } catch { return false; }
}

function readWechatAgentConfig() {
  const file = WECHATAGENT_CONFIG();
  try { return JSON.parse(readText(file)); } catch { return null; }
}

function writeWechatAgentConfig(data) {
  const file = WECHATAGENT_CONFIG();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.bridge-tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.copyFileSync(tmp, file);
  fs.unlinkSync(tmp);
}

async function readerSessions() {
  const res = await request(cfg.readerUrl + '/api/v1/sessions', { headers: { authorization: 'Bearer ' + readerToken() } });
  return Array.isArray(res.data?.sessions) ? res.data.sessions : [];
}

// 让 WeChatAgent 的 whitelist 覆盖本桥白名单（reader 只推 selected 会话）。
function syncWhitelist(config, sessions, allow) {
  const privateIds = [];
  const groupIds = [];
  const unresolved = [];
  for (const item of allow) {
    if (item === '*') continue;
    const hit = sessions.find(session => session.username === item || String(session.conversationId) === item);
    if (!hit) { unresolved.push(item); continue; }
    const id = String(hit.conversationId);
    if (Number(hit.type) === 0) privateIds.push(id); else groupIds.push(id);
  }
  config.wechat ??= {};
  config.wechat.whitelist ??= {};
  const prevPrivate = Array.isArray(config.wechat.whitelist.private) ? config.wechat.whitelist.private : [];
  const prevGroups = Array.isArray(config.wechat.whitelist.groups) ? config.wechat.whitelist.groups : [];
  config.wechat.whitelist.private = [...new Set([...prevPrivate, ...privateIds])];
  config.wechat.whitelist.groups = [...new Set([...prevGroups, ...groupIds])];
  config.wechat.wake_mode = 'mention';
  return { private: config.wechat.whitelist.private, groups: config.wechat.whitelist.groups, unresolved };
}

async function connectWechat() {
  const steps = [];
  const push = (name, status, detail = '') => steps.push({ name, status, detail: String(detail ?? '').slice(0, 400) });
  const finish = () => {
    readerConnected = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setTimeout(() => connectReader(), 300);
    const ok = steps.every(step => step.status === 'ok' || step.status === 'skipped' || step.status === 'warning');
    log('connect wechat:', JSON.stringify(steps));
    return { ok, steps };
  };

  if (isNative()) {
    // 自建通道：微信副本 + 我们编译的 hook；不依赖 WeChatAgent
    const expectedDir = WECHAT_RUNTIME().replace(/\\/g, '/').toLowerCase();
    const paths = weixinPaths();
    const ours = paths.filter(item => item.replace(/\\/g, '/').toLowerCase().startsWith(expectedDir));
    if (ours.length) {
      push('微信进程（自建副本）', 'ok', path.basename(ours[0]) + ' · ' + ours.length + ' 个进程');
    } else {
      push('微信进程（自建副本）', 'missing', paths.length ? '当前跑的是另一份微信：' + paths[0] : '未运行');
      try {
        const exe = startOurWeixin();
        push('启动微信副本', 'ok', exe);
        await new Promise(resolve => setTimeout(resolve, 10000));
        const started = weixinPaths().filter(item => item.replace(/\\/g, '/').toLowerCase().startsWith(expectedDir));
        push('微信进程（自建副本）', started.length ? 'ok' : 'failed', started.length ? '已启动' : '启动后仍未检测到（可能要扫码登录）');
      } catch (error) {
        push('启动微信副本', 'failed', error.message);
      }
    }

    try {
      await refreshAccount();
      if (!account) throw new Error('hook 未就绪（微信可能未登录或注入未完成）');
      push('hook 发送通道', 'ok', account + ' / ' + (wechatVersion || '版本未知'));
    } catch (error) {
      push('hook 发送通道', 'failed', error.message);
    }

    try {
      const sessions = await readerSessions();
      push('reader 收消息', 'ok', sessions.length + ' 个会话');
    } catch (error) {
      push('reader 收消息', 'failed', error.message);
    }

    push('接管白名单', (cfg.allow ?? []).length ? 'ok' : 'warning', (cfg.allow ?? []).join('，') || '空（不会回消息）');
    return finish();
  }

  // 1. WeChatAgent 进程
  let running = wechatAgentRunning();
  push('WeChatAgent 进程', running ? 'ok' : 'missing', running ? '已在运行' : '未运行');
  if (!running) {
    if (fs.existsSync(WECHATAGENT_EXE)) {
      try {
        execFileSync('powershell', ['-NoProfile', '-Command',
          `Start-Process -FilePath '${WECHATAGENT_EXE.replace(/'/g, "''")}' -WorkingDirectory '${path.dirname(WECHATAGENT_EXE).replace(/'/g, "''")}'`], { stdio: 'ignore' });
        push('启动 WeChatAgent', 'ok', WECHATAGENT_EXE);
        await new Promise(resolve => setTimeout(resolve, 6000));
        running = wechatAgentRunning();
        push('WeChatAgent 进程', running ? 'ok' : 'failed', running ? '已启动' : '启动后仍未检测到');
      } catch (error) {
        push('启动 WeChatAgent', 'failed', error.message);
      }
    } else {
      push('启动 WeChatAgent', 'failed', '未找到 ' + WECHATAGENT_EXE);
    }
  }

  // 2. hook + 账号
  try {
    await refreshAccount();
    if (!account) throw new Error('hook 未就绪（微信可能未注入，稍等再试）');
    push('hook 发送通道', 'ok', account + ' / ' + (wechatVersion || '版本未知'));
  } catch (error) {
    push('hook 发送通道', 'failed', error.message);
  }

  // 3. reader + 会话
  let sessions = [];
  try {
    sessions = await readerSessions();
    push('reader 收消息', 'ok', sessions.length + ' 个会话');
  } catch (error) {
    push('reader 收消息', 'failed', error.message);
  }

  // 4. 白名单同步
  const config = readWechatAgentConfig();
  if (!config) {
    push('WeChatAgent 白名单', 'failed', '读不到 ' + WECHATAGENT_CONFIG());
  } else if (sessions.length === 0) {
    push('WeChatAgent 白名单', 'skipped', '没有会话可同步');
  } else {
    const backup = WECHATAGENT_CONFIG() + '.bak-before-bridge';
    try { if (!fs.existsSync(backup)) fs.copyFileSync(WECHATAGENT_CONFIG(), backup); } catch {}
    const result = syncWhitelist(config, sessions, cfg.allow ?? []);
    writeWechatAgentConfig(config);
    push('WeChatAgent 白名单', 'ok', `私聊 ${result.private.length} 个 / 群 ${result.groups.length} 个`);
    if (result.unresolved.length) push('未匹配白名单项', 'warning', result.unresolved.join(', '));
  }

  // 5. 重连 reader，使新选中会话立即生效
  return finish();
}

// ---------- HTTP 服务 ----------

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (error) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function tailLog(lines) {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const all = content.split('\n').filter(Boolean);
    return all.slice(-lines).join('\n');
  } catch { return ''; }
}

// —— 面板「会话 / 文件 / 人格卡」用的小工具 ——
const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');

const workspaceDir = () => path.resolve(cfg.workspace || path.join(ROOT, 'workspace'));

// 插件把每轮的思考过程写进 workspace/thinking.jsonl，这里只负责读出来给面板看。
const thinkingFile = () => path.join(workspaceDir(), 'thinking.jsonl');

function readThinking(limit = 30) {
  try {
    const content = fs.readFileSync(thinkingFile(), 'utf8');
    const all = content.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    return all.slice(-limit).reverse();
  } catch { return []; }
}

// DSH 用会话 cwd 生成 sessions 子目录名：非字母数字全转 '-'，两侧各补 '--'
function sessionDirName(dir) {
  const slug = path.resolve(dir).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return '--' + slug + '--';
}

// 与 native-context.mjs 保持一致的推导：会话 id / 每会话记忆文件
const talkerSid = talker => 'wx-' + crypto.createHash('sha256').update(String(talker)).digest('hex').slice(0, 32) + '-' + String(cfg.sessionEpoch ?? '3');
const talkerMemoryFile = talker => path.join(workspaceDir(), 'memory', 'group-' + crypto.createHash('sha1').update(String(talker)).digest('hex').slice(0, 10) + '.md');

function fileMeta(key, label, file, note) {
  let exists = false;
  let size = 0;
  let mtime = 0;
  try {
    const stat = fs.statSync(file);
    exists = stat.isFile();
    size = stat.size;
    mtime = stat.mtimeMs;
  } catch {}
  return { key, label, path: file, exists, size, mtime, note: note || '' };
}

function allowedFile(raw) {
  const abs = path.resolve(String(raw || ''));
  const roots = [workspaceDir(), path.join(ROOT, 'persona')];
  const hit = roots.some(root => abs === path.resolve(root) || abs.startsWith(path.resolve(root) + path.sep));
  if (!hit) throw new Error('这个路径不在允许范围（只开放 workspace 和 persona 目录）');
  if (!/\.(md|txt)$/i.test(abs)) throw new Error('只允许编辑 .md / .txt 文本文件');
  return abs;
}

function readAllowedFile(raw) {
  const abs = allowedFile(raw);
  let text = '';
  let size = 0;
  let mtime = 0;
  try {
    const stat = fs.statSync(abs);
    size = stat.size;
    mtime = stat.mtimeMs;
    if (size > 400000) throw new Error('文件超过 400KB，请用文件工具打开');
    text = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    if (error && error.message && error.message.includes('400KB')) throw error;
    text = '';
  }
  return { path: abs, text, size, mtime };
}

function writeAllowedFile(raw, text) {
  const abs = allowedFile(raw);
  const body = String(text ?? '');
  if (body.length > 400000) throw new Error('内容超过 400KB，拒绝写入');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs)) {
    try { fs.copyFileSync(abs, abs + '.bak'); } catch {}
  }
  fs.writeFileSync(abs, body, 'utf8');
  const stat = fs.statSync(abs);
  log('file saved:', abs, stat.size);
  return { path: abs, size: stat.size, mtime: stat.mtimeMs };
}

let sessionNameCache = { at: 0, rows: [] };
async function sessionNames() {
  if (Date.now() - sessionNameCache.at < 60000 && sessionNameCache.rows.length) return sessionNameCache.rows;
  try {
    const res2 = await request(cfg.readerUrl + '/api/v1/sessions', { headers: { authorization: 'Bearer ' + readerToken() } });
    const payload = res2.data ?? {};
    const rows = Array.isArray(payload.sessions) ? payload.sessions : (Array.isArray(payload) ? payload : []);
    if (rows.length) sessionNameCache = { at: Date.now(), rows };
  } catch {}
  return sessionNameCache.rows;
}

async function chatList() {
  const ws = workspaceDir();
  const sessionBase = path.join(SESSIONS_ROOT, sessionDirName(ws));
  const personaFile = String(cfg.personaFile || '');
  const rows = await sessionNames();
  const named = new Map();
  for (const row of rows) {
    const username = String(row.username || row.talker || '');
    if (!username) continue;
    named.set(username, String(row.displayName || row.nickname || row.remark || ''));
  }
  const talkers = [];
  for (const talker of (cfg.allow ?? [])) if (talker && talker !== '*' && !talkers.includes(talker)) talkers.push(String(talker));
  for (const username of named.keys()) if (!talkers.includes(username) && talkers.length < 60) talkers.push(username);

  return talkers.map(talker => {
    const kind = /@chatroom$/i.test(talker) ? 'group' : 'private';
    const sid = talkerSid(talker);
    const memory = talkerMemoryFile(talker);
    return {
      talker,
      kind,
      name: named.get(talker) || '',
      managed: allowed(talker),
      workspace: ws,
      sid,
      sessionPath: path.join(sessionBase, sid),
      hasSession: fs.existsSync(path.join(sessionBase, sid)),
      sandbox: kind === 'group' ? String(cfg.groupSandboxMode || 'workspace-write') : String(cfg.privateSandboxMode || 'danger-full-access'),
      files: [
        fileMeta('agents', 'AGENTS.md', path.join(ws, 'AGENTS.md'), '群聊和私聊都注入'),
        fileMeta('agentsPrivate', 'AGENTS.private.md', path.join(ws, 'AGENTS.private.md'), '只在私聊注入'),
        fileMeta('memoryDoc', 'MEMORY.md', path.join(ws, 'MEMORY.md'), '只在私聊注入'),
        fileMeta('persona', '人格卡', personaFile, '群聊人设，全局共用'),
        fileMeta('chatMemory', '本会话记忆', memory, '助手自己追加的笔记'),
      ],
    };
  });
}

async function pickerChats(keyword) {
  const q = String(keyword || '').trim();
  let rows = [];
  let warning = '';
  try {
    const res2 = await request(cfg.readerUrl + '/api/v1/chats?q=' + encodeURIComponent(q) + '&limit=150', {
      headers: { authorization: 'Bearer ' + readerToken() },
    });
    const payload = res2.data ?? {};
    rows = Array.isArray(payload.chats) ? payload.chats : [];
  } catch (error) {
    warning = error.message;
  }
  const seen = new Map();
  const chats = [];
  const push = row => {
    const talker = String(row.talker || row.username || '');
    if (!talker) return;
    const name = String(row.name || row.displayName || '');
    const known = seen.get(talker);
    if (known) {
      // 白名单里的条目先占位（没有名字），读到真实会话后把名字/摘要补上
      if (!known.name && name) known.name = name;
      if (!known.summary) known.summary = String(row.summary || '');
      if (!known.lastAt) known.lastAt = Number(row.lastAt) || 0;
      return;
    }
    const item = {
      talker,
      name,
      kind: /@chatroom$/i.test(talker) ? 'group' : (String(row.kind || row.type || '') === 'group' ? 'group' : 'private'),
      lastAt: Number(row.lastAt) || 0,
      summary: String(row.summary || ''),
      managed: allowed(talker),
    };
    seen.set(talker, item);
    chats.push(item);
  };
  if (!q) for (const talker of (cfg.allow ?? [])) if (talker && talker !== '*') push({ talker });
  for (const row of rows) push(row);
  return { chats, warning };
}

function personaList() {
  const dir = path.join(ROOT, 'persona');
  const current = path.resolve(String(cfg.personaFile || ''));
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => /\.(md|txt)$/i.test(name)); } catch {}
  return names.map(name => {
    const file = path.join(dir, name);
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    return { name, path: file, size, current: path.resolve(file) === current };
  });
}

function revealPath(raw) {
  const target = path.resolve(String(raw || workspaceDir()));
  const roots = [ROOT, workspaceDir(), path.join(ROOT, 'persona')];
  if (!roots.some(root => target === path.resolve(root) || target.startsWith(path.resolve(root) + path.sep))) {
    throw new Error('这个路径不在允许范围');
  }
  if (!fs.existsSync(target)) throw new Error('路径不存在：' + target);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) spawn('explorer', [target], { detached: true, stdio: 'ignore' }).unref();
  else spawn('explorer', ['/select,', target], { detached: true, stdio: 'ignore' }).unref();
  return target;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (req.method === 'GET' && (route === '/' || route === '/panel')) {
      const html = fs.existsSync(PANEL_FILE) ? fs.readFileSync(PANEL_FILE, 'utf8') : '<h1>panel.html 缺失</h1>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...CORS });
      return res.end(html);
    }

    if (req.method === 'POST' && route === '/api/connect') {
      const result = await connectWechat();
      return json(res, 200, result);
    }

    if (req.method === 'GET' && route === '/health') {
      return json(res, 200, {
        ok: true,
        paused: !!cfg.paused,
        proactive: cfg.proactive !== false,
        mergeSeconds: Number(cfg.mergeSeconds) || 0,
        privateMergeSeconds: Number(cfg.privateMergeSeconds) || 0,
        groupGapSeconds: Number(cfg.groupGapSeconds) || 0,
        wakeHoldSeconds: Number(cfg.wakeHoldSeconds) || 0,
        wakeWords: Array.isArray(cfg.wakeWords) ? cfg.wakeWords : [],
        rateLimitPerMin: Number(cfg.rateLimitPerMin) || 0,
        silent: !!cfg.silent,
        reminders: loadReminders().length,
        reader: { connected: readerConnected, lastMessageAt: readerLastAt, url: cfg.readerUrl },
        hook: { mode: cfg.hookMode, url: cfg.hookUrl, account, wechatVersion },
        allow: cfg.allow ?? [],
        clients: clients.size,
        uptimeSec: Math.round(process.uptime()),
      });
    }

    if (req.method === 'GET' && route === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...CORS,
      });
      res.write(': connected\n\n');
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      const drop = () => { clearInterval(ping); clients.delete(res); };
      req.on('close', drop);
      req.on('error', drop);
      res.on('error', drop);
      res.on('close', drop);
      return;
    }

    if (req.method === 'POST' && route === '/send/text') {
      const body = await readBody(req);
      const talker = String(body.talker ?? '');
      if (!talker) return json(res, 400, { ok: false, error: '缺少 talker' });
      await sendText(talker, String(body.text ?? ''));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && route === '/send/image') {
      const body = await readBody(req);
      const talker = String(body.talker ?? '');
      const file = String(body.path ?? '');
      if (!talker || !file) return json(res, 400, { ok: false, error: '缺少 talker 或 path' });
      const sent = await sendImage(talker, file);
      return json(res, 200, { ok: true, sent });
    }

    if (req.method === 'POST' && route === '/send/meme') {
      const body = await readBody(req);
      const talker = String(body.talker ?? '');
      const mood = String(body.mood ?? '');
      const query = String(body.query ?? '');
      if (!talker) return json(res, 400, { ok: false, error: '缺少 talker' });
      const sent = await sendMeme(talker, mood, query);
      return json(res, 200, { ok: true, ...sent });
    }

    if (req.method === 'GET' && route === '/api/memes') {
      return json(res, 200, { ok: true, ...memeSummary() });
    }

    if (req.method === 'GET' && route === '/api/config') {
      const { hookToken: _hidden, ...safe } = loadConfig();
      return json(res, 200, safe);
    }

    if (req.method === 'POST' && route === '/api/config') {
      const body = await readBody(req);
      const patch = {};
      for (const key of ['allow', 'paused', 'proactive', 'mergeSeconds', 'privateMergeSeconds', 'groupGapSeconds', 'wakeHoldSeconds', 'wakeWords', 'rateLimitPerMin', 'silent', 'agentPreset', 'provider', 'model', 'sessionEpoch', 'turnTimeoutMs', 'maxChars', 'dataRoot', 'serverPort', 'personaVersion', 'personaFile', 'hookToken', 'hookUrl', 'hookMode', 'selfWxid', 'wechatVersion', 'mediaKey']) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      cfg = patchConfig(patch);
      log('config updated:', JSON.stringify(patch));
      return json(res, 200, { ok: true, config: cfg });
    }

    if (req.method === 'POST' && route === '/api/allow') {
      const body = await readBody(req);
      const talker = String(body.talker || '').trim();
      if (!talker) return json(res, 400, { ok: false, error: '缺少 talker' });
      const on = body.on !== false;
      const list = (cfg.allow ?? []).map(String).filter(item => item && item !== talker && item !== '*');
      if (on) list.push(talker);
      cfg = patchConfig({ allow: list });
      log('allow updated:', JSON.stringify(list));
      return json(res, 200, { ok: true, allow: list, managed: on });
    }

    if (req.method === 'GET' && route === '/api/log') {
      const lines = Math.min(Number(url.searchParams.get('lines') ?? 200) || 200, 2000);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...CORS });
      return res.end(tailLog(lines));
    }

    if (req.method === 'GET' && route === '/api/thinking') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 30) || 30, 200);
      return json(res, 200, { ok: true, items: readThinking(limit) });
    }

    if (req.method === 'POST' && route === '/api/thinking/clear') {
      try { fs.writeFileSync(thinkingFile(), '', 'utf8'); } catch (error) { return json(res, 500, { ok: false, error: error.message }); }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && route === '/api/pause') {
      const body = await readBody(req);
      cfg = patchConfig({ paused: body.paused !== false });
      log('paused:', cfg.paused);
      return json(res, 200, { ok: true, paused: cfg.paused });
    }

    if (req.method === 'GET' && route === '/api/sessions') {
      const res2 = await request(cfg.readerUrl + '/api/v1/sessions', { headers: { authorization: 'Bearer ' + readerToken() } });
      return json(res, 200, res2.data ?? { error: 'reader 返回非 JSON', status: res2.status });
    }

    if (req.method === 'GET' && route === '/api/remind') {
      return json(res, 200, { ok: true, reminders: loadReminders() });
    }

    if (req.method === 'POST' && route === '/api/remind') {
      const body = await readBody(req);
      const talker = String(body.talker ?? '');
      if (!talker) return json(res, 400, { ok: false, error: '缺少 talker' });
      if (cfg.proactive === false) return json(res, 400, { ok: false, error: '主动发送已在面板里关闭' });
      const minutes = Number(body.minutes ?? (Number(body.afterSeconds) / 60) ?? 0);
      if (!Number.isFinite(minutes) || minutes <= 0) return json(res, 400, { ok: false, error: '缺少有效的 minutes' });
      const item = addReminder(talker, Math.min(minutes, 60 * 24 * 30), body.note);
      return json(res, 200, { ok: true, reminder: item });
    }

    if (req.method === 'POST' && route === '/api/remind/delete') {
      const body = await readBody(req);
      const id = String(body.id ?? '');
      const list = loadReminders().filter(item => item.id !== id);
      saveReminders(list);
      return json(res, 200, { ok: true, reminders: list });
    }

    if (req.method === 'GET' && route === '/api/chats') {
      let chats = [];
      let warning = '';
      try { chats = await chatList(); } catch (error) { warning = error.message; }
      return json(res, 200, {
        ok: true,
        workspace: workspaceDir(),
        personaFile: String(cfg.personaFile || ''),
        sessionEpoch: String(cfg.sessionEpoch ?? '3'),
        chats,
        warning,
      });
    }

    if (req.method === 'GET' && route === '/api/chat-picker') {
      const keyword = url.searchParams.get('q') || '';
      const result = await pickerChats(keyword);
      return json(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && route === '/api/file') {
      const target = url.searchParams.get('path');
      if (!target) return json(res, 400, { ok: false, error: '缺少 path' });
      return json(res, 200, { ok: true, ...readAllowedFile(target) });
    }

    if (req.method === 'POST' && route === '/api/file') {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...writeAllowedFile(body.path, body.text) });
    }

    if (req.method === 'GET' && route === '/api/personas') {
      return json(res, 200, { ok: true, current: String(cfg.personaFile || ''), personas: personaList() });
    }

    if (req.method === 'POST' && route === '/api/reveal') {
      const body = await readBody(req);
      const target = revealPath(body.path);
      return json(res, 200, { ok: true, path: target });
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  } catch (error) {
    log('request failed:', route, error.message);
    return json(res, 500, { ok: false, error: error.message });
  }
});

(async () => {
  await refreshAccount();
  connectReader();
  setInterval(() => { if (!account) refreshAccount(); }, 30000);
  setInterval(fireReminders, 5000);
  server.listen(cfg.serverPort, cfg.serverHost, () => {
    log('server listening on http://' + cfg.serverHost + ':' + cfg.serverPort);
    log('dataRoot:', cfg.dataRoot, 'allow:', JSON.stringify(cfg.allow), 'paused:', !!cfg.paused);
  });
})();

process.on('SIGINT', () => { log('SIGINT, exiting'); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM, exiting'); process.exit(0); });

// 兜底：漏网异常只记日志，常驻服务不退出
process.on('uncaughtException', error => { log('uncaughtException:', error && (error.stack || error.message) || String(error)); });
process.on('unhandledRejection', error => { log('unhandledRejection:', error && (error.stack || error.message) || String(error)); });
