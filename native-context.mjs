// DSH × 微信桥接 —— DSH 插件（瘦客户端）
// 微信收发全部由独立服务 server.mjs 负责（它才是和 WeChatAgent 打交道的地方）。
// 本插件只做三件事：
//   1. 订阅本地服务的事件流（http://127.0.0.1:17890/events）
//   2. 把微信消息变成 DSH 会话轮次
//   3. 把回复 / 工具发的图片交回本地服务发送
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-wechat-bridge';
export const inject = ['agents', 'sessions', 'agentPresets', 'tools'];

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const LOG_FILE = path.join(ROOT, 'bridge.log');
const START_VBS = path.join(ROOT, 'start-bridge-silent.vbs');

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:17890',
  workspace: path.join(ROOT, 'workspace'),
  agentPreset: 'standard',
  provider: '',
  model: '',
  sessionEpoch: '',
  turnTimeoutMs: 600000,
  maxChars: 18000,
  personaFile: '',
  personaVersion: '1',
  mergeSeconds: 0,
  rateLimitPerMin: 0,
  silent: false,
  groupSandboxMode: 'workspace-write',
  privateSandboxMode: '',
};

const DEFAULT_PERSONA_FILE = path.join(ROOT, 'persona', '本鲸.md');

const readText = file => { try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim(); } catch { return ''; } };
const readJson = file => { try { return JSON.parse(readText(file)); } catch { return null; } };

function replyTextOf(message) {
  if (!message) return '';
  if (message.toolCalls?.length) return '';
  const blocks = Array.isArray(message.content) ? message.content : [];
  if (blocks.some(block => ['tool-call', 'tool_call', 'tool_use'].includes(block.type))) return '';
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('').trim();
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(readJson(CONFIG_FILE) ?? {}), ...config };
  const log = (...args) => {
    const line = `[${new Date().toISOString()}] [plugin] ${args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}`;
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
    try { console.log('[dsh-wechat-bridge]', ...args); } catch {}
  };

  const workspace = cfg.workspace || path.join(ROOT, 'workspace');
  const base = String(cfg.serverUrl || DEFAULTS.serverUrl).replace(/\/+$/, '');
  let closed = false;

  // 面板里的「主动发送」开关以配置文件为准（面板改完即时生效，不需要重启）
  const proactiveOn = () => (readJson(CONFIG_FILE)?.proactive ?? true) !== false;

  // 群聊人设：只注入群会话，每次会话注入一次（改 personaVersion 可强制重新注入）
  const personaText = () => {
    const stored = readJson(CONFIG_FILE) ?? {};
    const file = stored.personaFile || cfg.personaFile || DEFAULT_PERSONA_FILE;
    const text = readText(file);
    if (!text) return '';
    return text;
  };
  // 版本号 = 面板里的 personaVersion + 人设文件的修改时间：手动改版本号能强制重注入，
  // 直接编辑/替换人设文件（包括助手自己改）也会在下一轮群聊自动生效。
  const personaVersion = () => {
    const stored = readJson(CONFIG_FILE) ?? {};
    const base = String(stored.personaVersion ?? cfg.personaVersion ?? '1');
    const file = stored.personaFile || cfg.personaFile || DEFAULT_PERSONA_FILE;
    let stamp = '0';
    try { const stat = fs.statSync(file); stamp = String(Math.round(stat.mtimeMs)) + ':' + stat.size; } catch {}
    return base + '@' + stamp;
  };

  // 工作区里的 AGENTS.md（说话风格/规则）和 MEMORY.md（长期记忆）——之前根本没读，
  // 导致模型只拿到 DSH 默认助手腔。规则两个分支都注入；MEMORY.md 只进私聊，群聊不带。
  // 注入用 guidelinesVersion 做版本号，只在会话第一轮或文件改动后注入一次，不每轮重复。
  const readAgentsDoc = name => {
    try {
      const text = fs.readFileSync(path.join(workspace, name), 'utf8');
      if (!text.trim()) return '';
      return text.length > 6000 ? text.slice(0, 6000) + '\n…（后面省略）' : text;
    } catch { return ''; }
  };
  const guidelinesVersion = () => {
    let stamp = '0';
    for (const name of ['AGENTS.md', 'AGENTS.private.md', 'MEMORY.md']) {
      try { const s = fs.statSync(path.join(workspace, name)); stamp += ':' + Math.round(s.mtimeMs) + ':' + s.size; } catch {}
    }
    return stamp;
  };

  // 群聊记忆：助手自己写的笔记（只追加），每轮群聊把最近的记忆贴进 prompt。
  // 存 workspace/memory/ 下，按会话分开，群聊只有这一个写入入口（文件工具在群里被禁掉）。
  const MEMORY_DIR = path.join(workspace, 'memory');
  // 群聊写各自的 group-<hash>.md；私聊写工作区根目录的 MEMORY.md（和人手写的长期记忆同一份）。
  const memoryFile = talker => (String(talker).includes('@chatroom')
    ? path.join(MEMORY_DIR, 'group-' + crypto.createHash('sha1').update(String(talker)).digest('hex').slice(0, 10) + '.md')
    : path.join(workspace, 'MEMORY.md'));
  const readMemory = talker => {
    try {
      const text = fs.readFileSync(memoryFile(talker), 'utf8');
      return text.length > 9000 ? '…（更早的记忆省略）\n' + text.slice(-9000) : text;
    } catch { return ''; }
  };
  const appendMemory = (talker, note) => {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    // 支持一次写多条：按换行拆开，每条单独一个 bullet，方便记「某某是谁」这种画像。
    const lines = String(note)
      .split(/\r?\n/)
      .map(line => line.replace(/^[-*\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 20);
    const body = lines.map(line => `- [${stamp}] ${line.slice(0, 800)}`).join('\n');
    if (body) fs.appendFileSync(memoryFile(talker), body + '\n', 'utf8');
    return lines.length;
  };

  const cells = new Map();       // talker -> { sid, initialized, agent }
  const installed = new Set();   // 已经装过微信工具组的 sid
  const pending = new Map();     // sid -> { resolve, reject, timer, talker }
  const turns = new Map();       // sid -> { id, text }
  const queues = new Map();      // talker -> Promise
  const handles = new Map();     // sid -> tool dispose
  const cleanups = [];

  function serverRequest(pathname, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = {};
      if (payload) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload);
      }
      const req = http.request(base + pathname, { method: payload ? 'POST' : 'GET', headers }, res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(raw); } catch {}
          if (res.statusCode !== 200) return reject(new Error('bridge ' + res.statusCode + ' ' + raw.slice(0, 200)));
          if (data && data.ok === false) return reject(new Error(data.error || 'bridge 返回失败'));
          resolve(data);
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const sendText = (talker, text) => text ? serverRequest('/send/text', { talker, text }) : Promise.resolve();
  const sendImage = (talker, filePath) => serverRequest('/send/image', { talker, path: filePath });

  async function ensureAgent(talker) {
    const cached = cells.get(talker);
    if (cached) {
      const live = ctx.agents.get(cached.sid);
      // 只缓存「工具已装好」的会话；没装过的走下面 attach 分支补装，否则会一直缺 wechat_* 工具
      if (live && typeof live.followup === 'function' && installed.has(cached.sid)) {
        cached.agent = live;
        return cached;
      }
    }
    let sid = 'wx-' + crypto.createHash('sha256').update(talker).digest('hex').slice(0, 32) + (cfg.sessionEpoch ? '-' + String(cfg.sessionEpoch) : '');
    const isGroup = String(talker).includes('@chatroom');
    // 安装微信工具组：新建会话时在 setup 里跑；会话已经被 DSH 界面打开时（attach）也要补装，
    // 否则那条会话的 agent 里没有 wechat_* 工具，模型会说"发不出图"。
    // compress 处理：优先直接对 agent 隐藏（tools.restrict），模型连这个工具都看不到，
    // 就不会每轮白跑一步去调用再被拒（拒绝文案还会漏进聊天）。
    // 若 restrict 不可用（工具不在可限制名单里），退化成半小时限流的 guard。
    const COMPRESS_GAP_MS = 30 * 60 * 1000;
    const lastCompressAt = new Map();
    const compressGate = exec => {
      if (String(exec?.name ?? '') !== 'compress') return undefined;
      // 面板里点了「压缩一次」：允许窗口内放行，压缩完窗口自然过期。
      if (compressForced()) {
        log('compress allowed (forced):', sid);
        lastCompressAt.set(sid, Date.now());
        return undefined;
      }
      const last = lastCompressAt.get(sid) ?? 0;
      const wait = COMPRESS_GAP_MS - (Date.now() - last);
      if (wait > 0) {
        log('compress denied (cooldown):', sid, Math.ceil(wait / 60000) + 'min left');
        return '刚折过一次，先别折：每次折叠都会让后面的请求缓存失效、反而更慢。除非上下文快到上限或明显变慢，才需要再折一次。';
      }
      lastCompressAt.set(sid, Date.now());
      return undefined;
    };

    // 记忆工具：群聊私聊都装。群聊写 memory/group-<hash>.md，私聊写工作区根的 MEMORY.md。
    // 不给这个工具时，模型会直接去 edit MEMORY.md，然后被「file has not been read」挡住报错。
    const registerMemoryTools = agentCtx => {
      const disposeMemory = agentCtx.tools.register({
        name: 'wechat_memory_append',
        description: '往长期记忆里追加一条笔记（只追加，会一直保留，之后的聊天里会作为「记忆」出现）。适合记：别人的癖好和外号、共同梗、约定、答应过的事、你自己想记住的事。一句话一条，简短。记东西就用这个工具，不要去编辑 MEMORY.md 文件。',
        parameters: {
          type: 'object',
          properties: { note: { type: 'string', description: '要记住的内容，一句话，短一点' } },
          required: ['note'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
            required: ['ok', 'message'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
        },
        async execute(args) {
          const note = String(args?.note ?? '').trim();
          if (!note) return { ok: false, message: '需要 note 参数' };
          try {
            const count = appendMemory(talker, note);
            return { ok: true, message: `记住了 ${count} 条。` };
          } catch (error) {
            return { ok: false, message: '记不下来：' + ((error && error.message) || String(error)) };
          }
        },
      });
      if (disposeMemory) handles.set(sid + ':memory', disposeMemory);

      const disposeMemoryRead = agentCtx.tools.register({
        name: 'wechat_memory_read',
        description: '把已经记下的长期记忆读出来看看（确认自己的笔记真的写进去了、之前记过谁）。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
            required: ['ok', 'text'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        async execute() {
          const text = readMemory(talker).trim();
          return { ok: true, text: text || '（还没有任何记忆）' };
        },
      });
      if (disposeMemoryRead) handles.set(sid + ':memory-read', disposeMemoryRead);
    };

    const installTools = agentCtx => {
      // 先把 compress 从这条会话的工具表里摘掉（群聊私聊都摘）。
      let compressHidden = false;
      try {
        const disposeRestrict = agentCtx.tools.restrict({ deny: ['compress'] });
        if (disposeRestrict) {
          handles.set(sid + ':restrict-compress', disposeRestrict);
          compressHidden = true;
        }
      } catch (error) {
        log('compress restrict unavailable, fall back to cooldown guard:', String(error?.message ?? error));
      }
      // 群聊限权：命令、终端、写文件这些一律拒掉，只留只读 + 微信相关 + 记忆工具。
      // 私聊保持全权限（agent 默认）。
      if (isGroup) {
        // 白名单式限权：只放行只读/联网/微信/记忆类工具，其余（命令、终端、写文件、后台任务…）一律拒。
        // 联网工具（web_search / web_fetch / read_page / x_search / web_reader）必须放行，
        // 否则查行情、看新闻、搜资料全都做不了。
        // 注意 meme-search__search 带连字符，用 /^...|meme/ 兜住。
        // 上下文工具只放行 acp_status（看还剩多少可压）；compress 已在上面被 restrict 掉，
        // 万一 restrict 没生效，这里还有 compressGate 兜底。
        const KEEP = /^(read|glob|grep|list|find|search|web|fetch|x_search|read_page|todo_write|wechat_|meme|skill|compress|acp_status)/i;
        const disposeGuard = agentCtx.tools.guard(exec => {
          if (!compressHidden) {
            const blocked = compressGate(exec);
            if (blocked !== undefined) return blocked;
          }
          const name = String(exec?.name ?? '');
          if (!name) return undefined;
          if (KEEP.test(name)) return undefined;
          return `群聊里不开放「${name}」工具`;
        });
        if (disposeGuard) handles.set(sid + ':guard', disposeGuard);

        registerMemoryTools(agentCtx);
      } else {
        // 私聊保留全权限；compress 已被 restrict 摘掉，restrict 失败时用同一条限流兜底。
        if (!compressHidden) {
          const disposeGuard = agentCtx.tools.guard(compressGate);
          if (disposeGuard) handles.set(sid + ':guard', disposeGuard);
        }
        registerMemoryTools(agentCtx);
      }

      const dispose = agentCtx.tools.register({
        name: 'wechat_send_image',
        description: '把本机图片文件直接发到当前微信聊天（png/jpg/webp 会自动转成 GIF）。截图后用它把图片发给对方。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '本机图片的绝对路径' } },
          required: ['path'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, sent: { type: 'string' }, message: { type: 'string' } },
            required: ['ok', 'sent', 'message'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
        },
        async execute(args) {
          if (!args?.path || typeof args.path !== 'string') return { ok: false, sent: '', message: '需要 path 参数' };
          try {
            const result = await sendImage(talker, args.path);
            return { ok: true, sent: String(result?.sent ?? args.path), message: '图片已发送到微信：' + args.path };
          } catch (error) {
            return { ok: false, sent: args.path, message: '图片发送失败：' + ((error && error.message) || String(error)) };
          }
        },
      });
      if (dispose) handles.set(sid, dispose);

      // 表情包：直接用 dsh-meme 图库里的图，按情绪随机挑一张发到微信
      const disposeMeme = agentCtx.tools.register({
        name: 'wechat_send_meme',
        description: '从本机表情包图库挑一张图直接发到当前微信聊天。按情绪选 mood：happy 开心/卖萌、angry 生气/炸毛、sad 难过/无语、shy 害羞、confused 困惑/惊讶、daily 日常/困/摸鱼。表情包是表达情绪用的，一条回复最多发一张。注意：微信里只能靠这个工具发表情，不要写 [表情: xxx] 这类占位文字。',
        parameters: {
          type: 'object',
          properties: {
            mood: {
              type: 'string',
              enum: ['happy', 'angry', 'sad', 'shy', 'confused', 'daily'],
              description: '情绪分类',
            },
            query: {
              type: 'string',
              description: '可选：想找的关键词（按图片文件名匹配），留空就按情绪随机挑',
            },
          },
          required: ['mood'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, mood: { type: 'string' }, message: { type: 'string' } },
            required: ['ok', 'mood', 'message'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
        },
        async execute(args) {
          const mood = String(args?.mood ?? '').trim();
          if (!mood) return { ok: false, mood: '', message: '需要 mood 参数' };
          // 一轮只准一张：模型有时候先发一张、想两秒又补一张，用户看到的就是连甩两个表情。
          if (memeTurn.get(talker)) {
            log('meme skipped (already sent this turn):', talker);
            return { ok: true, mood, message: '这一轮已经发过一张表情包了，不要再连发第二张' };
          }
          // 频率闸：同一个聊天 8 分钟内最多一张，压住「每条回复都配图」。
          if (!memeAllowed(talker)) {
            log('meme skipped (cooldown):', talker);
            return { ok: true, mood, message: '刚发过表情包了，这轮先不发，只用文字回就行' };
          }
          const sent = await sendMemeNow(talker, mood, args?.query);
          if (!sent.ok) return { ok: false, mood, message: '表情包发送失败：' + sent.error };
          return { ok: true, mood, message: '表情包已发到微信' + (sent.name ? '（' + sent.name + '）' : '') };
        },
      });
      if (disposeMeme) handles.set(sid + ':meme', disposeMeme);

      // 发文字的工具（wechat_send / wechat_send_rich）已经下线：
      // 模型每调一次就要多跑一整轮（40 秒起），于是出现「发一条→想→再发一条」。
      // 现在正文直接写在最终回复里，发送端按空行拆成最多 3 条；表情用 [meme:tag] 标记。

      // 行情：群里没有 shell，跑不了 skill 里的 python 脚本，所以把腾讯行情接口做成原生工具。
      // 私聊/群聊都能用，不依赖 python 和第三方库。
      const STOCK_INDEX = {
        '上证': 'sh000001', '上证指数': 'sh000001',
        '深证': 'sz399001', '深证成指': 'sz399001',
        '创业板': 'sz399006', '创业板指': 'sz399006',
        '沪深300': 'sh000300', '科创50': 'sh000688', '北证50': 'bj899050',
      };
      const stockSymbol = code => {
        const c = String(code).trim().toLowerCase();
        if (STOCK_INDEX[c]) return STOCK_INDEX[c];
        if (/^(sh|sz|bj)\d{6}$/.test(c)) return c;
        if (/^\d{6}$/.test(c)) {
          if (/^[659]/.test(c)) return 'sh' + c;
          if (/^[48]/.test(c)) return 'bj' + c;
          return 'sz' + c;
        }
        return null;
      };
      const disposeStock = agentCtx.tools.register({
        name: 'wechat_stock',
        description: '查 A 股实时行情（大盘指数或个股）。用户问「今天大盘怎么样」「茅台多少钱」「涨了多少」时用它。不传参数就返回上证/深证/创业板三大指数。',
        parameters: {
          type: 'object',
          properties: {
            targets: {
              type: 'array',
              items: { type: 'string' },
              description: '要查的指数名或股票代码，例如 ["上证","沪深300"] 或 ["600519","000001"]。留空则查三大指数。',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
            required: ['ok', 'message'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
        },
        async execute(args) {
          const raw = Array.isArray(args?.targets) ? args.targets.map(String) : [];
          const list = raw.length ? raw : ['上证', '深证', '创业板'];
          const symbols = [];
          const unknown = [];
          for (const t of list) {
            const s = stockSymbol(t);
            if (s) symbols.push(s); else unknown.push(t);
          }
          if (!symbols.length) return { ok: false, message: '没看懂要查什么：' + list.join('、') };
          try {
            const res = await fetch('https://qt.gtimg.cn/q=' + symbols.join(','), {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const buf = Buffer.from(await res.arrayBuffer());
            const text = new TextDecoder('gbk').decode(buf);
            const lines = [];
            for (const chunk of text.split(';')) {
              if (!chunk.includes('="')) continue;
              const f = chunk.split('="')[1].split('~');
              if (f.length < 40) continue;
              const name = f[1] || f[2];
              const price = f[3] || '-';
              const pct = f[32] || '0';
              const chg = f[31] || '0';
              const sign = Number(pct) > 0 ? '+' : '';
              lines.push(`${name} ${price}（${sign}${chg}，${sign}${pct}%）`);
            }
            const note = unknown.length ? '\n（没查到：' + unknown.join('、') + '）' : '';
            return {
              ok: lines.length > 0,
              message: lines.length ? lines.join('\n') + note : '行情接口没返回数据',
            };
          } catch (error) {
            return { ok: false, message: '查行情失败：' + ((error && error.message) || String(error)) };
          }
        },
      });
      if (disposeStock) handles.set(sid + ':stock', disposeStock);

      const disposeRemind = agentCtx.tools.register({
        name: 'wechat_remind',
        description: '设定一个「过一会儿主动找对方」的定时提醒：N 分钟后你会被自动唤醒，并主动给对方发一条微信消息。用户说「我去健身了」「我出门一趟」「晚点再说」这类时，用它稍后主动关心一句。',
        parameters: {
          type: 'object',
          properties: {
            minutes: { type: 'number', description: '多少分钟后触发（最小 1，最大 43200）' },
            note: { type: 'string', description: '写给未来的自己的备忘：到点时为什么要找对方、该说什么' },
          },
          required: ['minutes', 'note'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, dueAt: { type: 'string' }, message: { type: 'string' } },
            required: ['ok', 'dueAt', 'message'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
        },
        async execute(args) {
          if (!args || typeof args.minutes !== 'number' || !args.note) return { ok: false, dueAt: '', message: '需要 minutes 和 note' };
          if (!proactiveOn()) return { ok: false, dueAt: '', message: '主动发送已在「DSH 设置 → 微信桥接」里关闭，不能设定提醒' };
          try {
            const result = await serverRequest('/api/remind', { talker, minutes: args.minutes, note: String(args.note) });
            const dueAt = new Date(Number(result?.reminder?.dueAt ?? Date.now())).toLocaleString('zh-CN');
            return { ok: true, dueAt, message: `已设定提醒：约 ${dueAt} 主动发消息。` };
          } catch (error) {
            return { ok: false, dueAt: '', message: '设定提醒失败：' + ((error && error.message) || String(error)) };
          }
        },
      });
      if (disposeRemind) handles.set(sid + ':remind', disposeRemind);
    };
    const setup = async agentCtx => {
      if (cfg.agentPreset) {
        const mounted = await ctx.agentPresets.mount(agentCtx, cfg.agentPreset);
        if (mounted?.id !== cfg.agentPreset) throw new Error('agent preset failed to mount: ' + cfg.agentPreset);
        log('preset mounted:', mounted.id);
      }
      installTools(agentCtx);
      installed.add(sid);
    };
    fs.mkdirSync(workspace, { recursive: true });
    const agentOptions = {};
    if (cfg.provider) agentOptions.provider = cfg.provider;
    if (cfg.model) agentOptions.model = cfg.model;
    const options = Object.keys(agentOptions).length ? { agentOptions } : {};
    const meta = { cwd: workspace, ...(cfg.agentPreset ? { agentPreset: cfg.agentPreset } : {}) };

    // 群聊和私聊用不同的沙箱档位：群聊默认只允许改工作区（workspace-write），私聊保持全权限。
    // 工作区 = 会话 cwd（D:\APP\AI\DSH-WeChat-Bridge\workspace），
    // 所以 config.json / persona / 代码都在它外面，群里改不到。
    function applySandbox(agent, talker) {
      try {
        const group = String(talker).includes('@chatroom');
        const want = group
          ? (cfg.groupSandboxMode ?? 'workspace-write')
          : (cfg.privateSandboxMode ?? '');
        if (!want) return;
        const session = agent?.session;
        if (!session || typeof session.append !== 'function') { log('sandbox: 拿不到 session，跳过'); return; }
        let current;
        try { current = ctx.get('sandboxPolicy')?.overrideOf?.(session); } catch {}
        if (current === want) return;
        session.append('sandbox/mode', { mode: want });
        log('sandbox mode:', want, 'session:', session.id ?? '(unknown)');
      } catch (error) {
        log('sandbox mode failed:', (error && error.message) || String(error));
      }
    }

    const publishCell = (talker, sid, agent, cached) => {
      const cell = { sid, initialized: cached?.initialized ?? false, personaVersion: cached?.personaVersion ?? '', agent };
      cells.set(talker, cell);
      applySandbox(agent, talker);
      return cell;
    };
    const createOrResume = async sessionId => {
      try {
        await ctx.agents.create({ sessionId, meta, ...options, setup });
      } catch (error) {
        const message = String(error?.message ?? error);
        // 写句柄被别处占着时不能 resume，交给外层换标识重建
        if (/active write handle/i.test(message)) throw error;
        if (!/exist|duplicate|already/i.test(message)) throw error;
        await ctx.agents.resume({ resumeSessionId: sessionId, ...options, setup });
      }
    };

    // 会话可能已经被别处打开（比如你在 DSH 界面上点开了这个会话，DSH 自己持有写句柄）。
    // 这时再 create 会报 "already owned by an active write handle"；直接挂到那个 agent 上继续聊，
    // 不要为了绕开冲突新建会话——否则聊了很久的会话会被拆成好几个。
    const live = ctx.agents.get(sid);
    if (live && typeof live.followup === 'function') {
      log('attach to session already open:', sid);
      // 这条会话是 DSH 界面先开起来的，setup 没跑过 → 这里补装工具，否则没有 wechat_* 工具。
      if (!installed.has(sid)) {
        try {
          if (live.ctx) { installTools(live.ctx); installed.add(sid); log('tools installed on open session:', sid); }
        } catch (error) {
          log('install tools on open session failed:', (error && error.message) || String(error));
        }
      }
      return publishCell(talker, sid, live, cached);
    }

    try {
      await createOrResume(sid);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/active write handle/i.test(message)) throw error;
      // 写句柄被占：多半是上一次异常退出的尾巴。先等一下重试同一会话（历史不丢），
      // 真的抢不回来才换新会话标识重建。
      log('session busy, retrying same session in 1.5s:', sid);
      await new Promise(resolve => setTimeout(resolve, 1500));
      try {
        await createOrResume(sid);
      } catch (retryError) {
        if (!/active write handle/i.test(String(retryError?.message ?? retryError))) throw retryError;
        // 再确认一次：也许这期间别处已经把这个会话开起来了，那就挂上去，别再新建。
        const live = ctx.agents.get(sid);
        if (live && typeof live.followup === 'function') {
          log('session opened elsewhere meanwhile, attaching:', sid);
      return publishCell(talker, sid, live, cached);
        }
        try { ctx.agents.get(sid)?.dispose?.(); } catch {}
        sid = sid + '-r' + Date.now().toString(36).slice(-4);
        log('session still owned by another handle, recreating as', sid);
        await createOrResume(sid);
      }
    }
    // create() 的返回值不一定是可对话的 agent；官方做法是创建后再从注册表取。
    const agent = ctx.agents.get(sid);
    if (!agent || typeof agent.followup !== 'function') throw new Error('DSH agent was not published');
    log('agent ready:', sid, 'preset:', ctx.agentPresets.composedPreset?.(agent.ctx) ?? '(unknown)', 'status:', agent.status ?? '(none)');
    return publishCell(talker, sid, agent, cached);
  }

  async function ask(talker, prompt) {
    const cell = await ensureAgent(talker);
    const sid = cell.sid;
    const agent = ctx.agents.get(sid) ?? cell.agent;
    if (!agent || typeof agent.followup !== 'function') throw new Error('agent unavailable');
    if (pending.has(sid)) throw new Error('busy');
    return new Promise((resolve, reject) => {
      // turnTimeoutMs <= 0 表示不限时：模型想多久就多久（思考很久是正常的，别打断它）
      const limit = Number(cfg.turnTimeoutMs) || 0;
      const timer = limit > 0 ? setTimeout(() => {
        pending.delete(sid);
        turns.delete(sid);
        try { agent.cancel?.({ kind: 'user' }); } catch {}
        reject(new Error('turn_timeout'));
      }, limit) : null;
      pending.set(sid, { resolve, reject, timer, talker });
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'dsh-wechat-bridge', form: 'relay' },
        }));
      } catch (error) {
        if (timer) clearTimeout(timer);
        pending.delete(sid);
        reject(error);
      }
    });
  }

  const SKIP_MARK = /^(?:\[?\s*(skip|silent|不回复|不发言|不吭声|跳过|沉默|闭嘴)\s*\]?\s*)+[。.!！~～…\s]*$/i;
  // 单独一行的沉默标记。模型习惯先「自言自语」解释一通、再在末尾补一行 [SKIP]，
  // 以前只匹配「整段只有 SKIP」，于是那些内心判断被原样发到微信里。
  const SKIP_LINE = /^[\s*_`~【\[(（]*\s*(?:skip|silent|不回复|不发言|不吭声|跳过|沉默|闭嘴)\s*[\s*_`~】\])）]*$/i;
  // 典型的「内心戏」：在跟人解释自己为什么不说、抱怨读不到消息。
  // 这类句子一句都不能发到微信里。
  const SELF_TALK = /(未识别|空白消息|识别不了|读不到消息|看不到消息|对方也看不到|我回的话|我自己抽风|这轮我(就不|不)|不该我(说|插话)|我先不说|就不吭声|在跟.{0,20}(说|聊)|不是叫我|没(有)?叫我|不是对我说|不是问我的?|跟我(没|无)关|轮不到我|这(条|句)(消息)?(不是|跟我)|他们?在(聊|说)|我(就)?不(用|该|需要)(回|插嘴|插话)|这是.{0,12}(在跟|对|问).{0,12}(说话|说|聊))/;

  // 这一条根本不是模型说的话，是框架/代理层吐出来的错误（dsh 有时会把 ACP stream error 之类
  // 当成 assistant 正文写进会话）。以前会被原样转发到微信，用户看到一堆 ❌ [ACP] xxx。
  const FRAMEWORK_ERROR = /(\[ACP\]|stream error|turn degenerated|continuation nudge|turn_error|turn_aborted|model not found|账号已被禁用|api key|unauthorized|rate limit|insufficient|余额不足|context length|maximum context|overloaded|ECONNRESET|ETIMEDOUT)/i;

  // 发完微信之后，模型常把「我刚发了什么」当成正文总结一遍（中英文都有），
  // 例如「The morning exchange is complete — I replied to … all delivered through the WeChat tools」。
  // 这类自述一个字都不能进微信。
  const NARRATION_EN = /(completed (this|the) turn|(all )?replies? (were|have been|was) delivered|delivered (through|via) (the )?wechat|i (have |'ve )?(replied|sent|delivered)|no further action|wechat tools?\b|the morning exchange)/i;
  const NARRATION_CN = /(本轮(已经)?(完成|结束)|(已经)?(全部)?(发送|回复)(完毕|完成)|通过微信(工具)?(发送|发出)|无需(再|继续)?(回复|发送)|(任务|回复)(已)?完成[，,]?\s*无)/;

  function looksLikeNarration(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return false;
    // 英文自述优先判（它经常夹着中文原话，比如 replied to "被阿唔弄醒了好几次"）
    if (NARRATION_EN.test(raw)) return true;
    if (!/[\u4e00-\u9fa5]/.test(raw)) return false;
    return NARRATION_CN.test(raw);
  }

  // 模型有时候不真去调工具，而是把原生工具调用标记当正文吐出来（而且半角 | 还被写成了全角 ｜）：
  //   <｜｜DSML｜｜tool_calls> / <｜｜DSML｜｜invoke name="wechat_send"> / <｜｜DSML｜｜parameter name="text">
  // 这些残渣以前会被原样发到微信，群友看到的就是 </｜｜DSML｜｜ invoke> 这种东西。
  const DSML_FRAGMENT = /<\/?[｜|]{0,2}\s*(?:DSML|antml|tool_calls?|function_calls?|invoke|parameter|calls?)\b[^\n]{0,200}/gi;
  const DSML_TEXT_PARAM = /parameter\s+name\s*=\s*"text"[^>]*>([\s\S]*?)(?:<\s*\/|$)/i;

  // 标记里如果夹带了真正要发的话，就捞出来当正文用（比整段丢掉划算）。
  function salvageToolcall(text) {
    const raw = String(text ?? '');
    if (!/DSML/i.test(raw)) return '';
    const match = raw.match(DSML_TEXT_PARAM);
    if (!match) return '';
    return stripJunk(match[1]);
  }

  // 把标记类残渣全部剥掉，只留人话。
  function stripJunk(text) {
    return String(text ?? '')
      .replace(DSML_FRAGMENT, ' ')
      .replace(/<\|[^|\n]{0,60}\|>/g, ' ')
      .replace(/^\s*<\/?[A-Za-z_][A-Za-z0-9_:.-]{0,40}\s*>\s*$/gm, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 老版本机器人用「先思考、再另起一行 RESPOND: 正文」的格式，好处是界面里能看清哪句是思考、
  // 哪句真发出去。这里沿用：RESPOND:/回复： 之前的一切都算思考，直接丢掉。
  const OUT_MARK = /(?:^|\n)[ \t>*_]*(?:RESPOND|REPLY|回复|发送|要说的话|正文)[ \t>*_]*[:：][ \t]*/i;

  // 把「思考 + 标记 + 正文」拆成两段；没有标记时思考为空、正文原样（向后兼容）。
  function splitReply(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return { think: '', reply: raw };
    const match = raw.match(OUT_MARK);
    if (!match) return { think: '', reply: raw };
    const at = match.index ?? 0;
    return { think: raw.slice(0, at).trim(), reply: raw.slice(at + match[0].length).trim() };
  }

  function extractReply(text) {
    return splitReply(text).reply;
  }

  // 思考过程只留档给自己看，绝不发微信：写到 workspace/thinking.jsonl，面板可读。
  const THINK_FILE = path.join(workspace, 'thinking.jsonl');
  function recordThinking(talker, think, reply) {
    if (!think) return;
    try {
      fs.mkdirSync(workspace, { recursive: true });
      try { if (fs.statSync(THINK_FILE).size > 2 * 1024 * 1024) fs.renameSync(THINK_FILE, THINK_FILE + '.1'); } catch {}
      const line = JSON.stringify({
        at: new Date().toISOString(),
        talker,
        kind: String(talker).includes('@chatroom') ? 'group' : 'private',
        think: think.slice(0, 8000),
        reply: String(reply ?? '').slice(0, 2000),
      });
      fs.appendFileSync(THINK_FILE, line + '\n', 'utf8');
    } catch (error) {
      log('recordThinking failed:', error.message);
    }
  }

  // 把模型回复整理成「真正要发到微信的文字」，返回 null 表示这轮不说话。
  // 只有模型自己打了沉默标记时才做清理：删掉标记行和那些自我解释，剩下的发出去；
  // 没打标记的正常回复原样放行，免得误伤正文。
  function cleanReply(text) {
    // 先做两件兜底：① 标记里夹带的话捞出来；② 剥掉 DSML 之类残渣。
    const raw = stripJunk(salvageToolcall(text) || text);
    if (!raw) return null;
    if (SKIP_MARK.test(raw)) return null;
    if (looksLikeNarration(raw)) return null;
    // 工具报错行不该进聊天：compress 被摘掉后模型会凭印象去调（Error: unknown tool），
    // 或者绕过记忆工具直接 edit MEMORY.md（Error: cannot modify … file has not been read）。
    const TOOL_ERROR_LINE = /^\s*(?:Error|错误)\s*[:：]|unknown tool|cannot modify|cannot read|file has not been read|ENOENT|EACCES|EPERM/i;
    const cleaned = raw.split(/\r?\n/).filter(line => !TOOL_ERROR_LINE.test(line)).join('\n').trim();
    if (!cleaned) return null;
    const lines = cleaned.split(/\r?\n/);
    const marked = lines.some(line => SKIP_LINE.test(line.trim()));
    if (!marked) return cleaned;
    const kept = lines.filter(line => !SKIP_LINE.test(line.trim()) && !SELF_TALK.test(line));
    const body = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (body && looksLikeNarration(body)) return null;
    return body || null;   // 除了标记和内心戏啥也没有 = 这轮不说话
  }

  // 按空行拆成 2-3 条发，模拟真人连着敲几段。模型不一定会主动调 wechat_send，
  // 所以分条这件事由发送端兜底。
  function splitParagraphs(text) {
    const parts = String(text ?? '')
      .split(/\r?\n\s*\r?\n/)
      .map(part => part.trim())
      .filter(Boolean);
    if (parts.length <= 3) return parts;
    return [parts[0], parts[1], parts.slice(2).join('\n\n')];
  }

  // 客户端插件用 [表情: 描述] / [STICKER:id] 这类标记来渲染图，微信里只会变成字面文字，发出去前剥掉。
  function stripMarkers(text) {
    return String(text ?? '')
      .replace(/\[\s*(表情|sticker)\s*[:：][^\]]*\]/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 模型在正文末尾写 [meme:happy] 这种标记，发送端就真的发一张对应情绪的图，并把标记删掉。
  // 这样「文字+表情」只要一次模型往返，不用先发字再补一次工具调用（那要多跑一整轮）。
  const MEME_MARK = /\[\s*(?:meme|mem|表情包?|sticker)\s*[:：]\s*(happy|angry|sad|shy|confused|daily|开心|生气|难过|害羞|困惑|日常)\s*\]/i;
  const MEME_MOOD_ALIAS = {
    开心: 'happy', 生气: 'angry', 难过: 'sad', 害羞: 'shy', 困惑: 'confused', 日常: 'daily',
  };

  // 群聊里叫它一声才醒。默认就是它的名字；面板里可改（一行一个）。
  const DEFAULT_WAKE_WORDS = ['大肥鱼', '本鲸'];

  // 面板里的节奏设置：合并窗口 / 每分钟回复上限 / 沉默模式，都是即时读取，不用重启
  function settings() {
    const stored = readJson(CONFIG_FILE) ?? {};
    const num = (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const rawWords = stored.wakeWords ?? cfg.wakeWords;
    const words = (Array.isArray(rawWords) ? rawWords : DEFAULT_WAKE_WORDS)
      .map(word => String(word).trim())
      .filter(Boolean)
      .slice(0, 20);
    return {
      mergeSeconds: Math.min(num(stored.mergeSeconds ?? cfg.mergeSeconds, 0), 30),
      privateMergeSeconds: Math.min(num(stored.privateMergeSeconds ?? Math.max(num(stored.mergeSeconds ?? cfg.mergeSeconds, 0), 10), 0), 60),
      groupGapSeconds: Math.min(num(stored.groupGapSeconds ?? cfg.groupGapSeconds, 25), 600),
      wakeHoldSeconds: Math.min(num(stored.wakeHoldSeconds ?? cfg.wakeHoldSeconds, 120), 3600),
      wakeWords: words.length ? words : DEFAULT_WAKE_WORDS,
      rateLimitPerMin: Math.floor(num(stored.rateLimitPerMin ?? cfg.rateLimitPerMin, 0)),
      silent: (stored.silent ?? cfg.silent) === true,
      memeCooldownMinutes: Math.min(num(stored.memeCooldownMinutes ?? cfg.memeCooldownMinutes, 8), 240),
      compressOnceUntil: num(stored.compressOnceUntil ?? cfg.compressOnceUntil, 0),
    };
  }

  // 手动压一次：把 compressOnceUntil 设成未来时间戳，窗口内放行 compress，并提示模型这一轮折一下。
  function compressForced() {
    return Date.now() < (settings().compressOnceUntil ?? 0);
  }

  function compressRuleLine() {
    return compressForced()
      ? '上下文：这一轮先用 compress 工具把前面很长的聊天记录压缩一次（调一次就够，别反复调），压缩完再正常回复。'
      : '上下文：压缩工具（compress）已经关掉了，不要调用它、也不要跟对方提；聊天记录多长都不用你操心，正常聊就行。';
  }

  const sentAt = new Map();     // talker -> 最近一分钟的发送时间戳
  const wakeAt = new Map();     // talker -> 最近一次被唤醒（叫到名字）的时间
  const fallbackAt = new Map(); // talker -> 最近一次发「卡了一下」兜底话术的时间
  const lastMemeAt = new Map(); // talker -> 最近一次真的发出表情包的时间（限频用）
  const FALLBACK_GAP_MS = 10 * 60 * 1000; // 同一个聊天 10 分钟内最多发一次兜底话术

  // 表情包限频：默认同一个聊天 8 分钟内最多一张。她太爱配图了，光靠提示词压不住。
  function memeAllowed(talker) {
    const gap = (settings().memeCooldownMinutes ?? 8) * 60 * 1000;
    if (gap <= 0) return true;
    return Date.now() - (lastMemeAt.get(talker) ?? 0) >= gap;
  }

  // 真正发一张表情，成功后记时间；失败把本轮配额退回去。
  async function sendMemeNow(talker, mood, query) {
    memeTurn.set(talker, Date.now());
    try {
      const result = await serverRequest('/send/meme', { talker, mood, query: String(query ?? '') });
      lastMemeAt.set(talker, Date.now());
      return { ok: true, name: String(result?.name ?? '') };
    } catch (error) {
      memeTurn.delete(talker);
      return { ok: false, error: String((error && error.message) || error) };
    }
  }
  const buffers = new Map();    // talker -> { items, timer }
  const recentTalk = new Map(); // talker -> 最近聊过的消息（潜水时也记，叫醒后当上下文）
  const lastReply = new Map();  // talker -> 最近一次真正发出去的文字
  const memeTurn = new Map();   // talker -> 本轮已经发过表情包的时间戳（防止一轮连发两张）
  const RECENT_MAX = 14;        // 最多记 14 条
  const RECENT_WINDOW_MS = 10 * 60 * 1000; // 只保留最近 10 分钟

  // 群里平时潜水，等有人真的叫它时，它得知道刚才大家在聊什么、发的是什么图，
  // 否则就会出现「@大肥鱼 如何评价」→ 它回「评价什么呀」这种断片。
  function rememberTalk(talker, items) {
    const list = recentTalk.get(talker) ?? [];
    const fallbackName = String(talker).includes('@chatroom') ? '群友' : '对方';
    for (const item of items) {
      list.push({
        name: item.senderName || item.talkerId || fallbackName,
        content: String(item.content ?? ''),
        at: Date.now(),
      });
    }
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    const kept = list.filter(x => x.at >= cutoff).slice(-RECENT_MAX);
    recentTalk.set(talker, kept);
    return kept;
  }

  function talkHistory(talker) {
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    return (recentTalk.get(talker) ?? []).filter(x => x.at >= cutoff);
  }

  function recentSends(talker) {
    const now = Date.now();
    const list = (sentAt.get(talker) ?? []).filter(time => now - time < 60000);
    sentAt.set(talker, list);
    return list;
  }

  function recordSend(talker) {
    const list = recentSends(talker);
    list.push(Date.now());
    sentAt.set(talker, list);
  }

  const SKIP_RULE = '沉默规则：如果这轮不该你说话、或者对方让你「接下来别回复/别说话」，就只输出一行 [SKIP]——前后不要加任何解释、不要说你为什么不说、不要描述你看到了什么异常，这些话会被系统整段丢掉，你的时间白花。';
  // 群里最大的毛病是「每句都接」。真人泡群是大部分时间潜水，只有被点到才吭声。
  const GROUP_QUIET_RULE = '群里的规矩：默认潜水。只有这几种情况才说话——①有人 @ 你、叫你的名字、直接问你；②有人问了一个真需要答案的问题；③有人接着你上一句在说、在等你回。除此之外一律只输出 [SKIP]：别人之间互相接梗、发图发表情、复述结论、聊游戏战况、互相打趣、感叹两句，统统不需要你插嘴。别对每条消息都表态，别把每句话都当在跟你说话。';
  const NO_THINKING_RULE = 'RESPOND: 冒号之后只写要发到微信的那句话本身：不要写判断过程、不要写「这是 X 在跟 Y 说话」「不是叫我」「跟我无关」「我先看看」这类分析——判断在 RESPOND 之前想完就行，冒号后面直接是聊天内容。';
  const OUT_RULE = '输出格式：要发的话必须单独开一行，以「RESPOND:」开头，冒号后面就是会发到微信的正文（想分条就用空行分段）。RESPOND 之前的任何内容都被当成思考丢掉，不会发出去。这轮不打算说话就只输出一行 [SKIP]。';
  // 已经用 wechat_send 发过话的轮次，模型最后一步爱写一段「我发了什么、发给了谁」的总结。
  const NO_NARRATION_RULE = '如果你这一轮已经用 wechat_send / wechat_send_image / wechat_send_meme 把话发出去了，最后一步只输出一行 [SKIP]，不要总结「我发了什么」「本轮完成」「已通过微信工具发送」这类话——那不是聊天内容，发出去对方会看到一段莫名其妙的独白。';
  // 分条方式：一次写完让系统拆，比反复调 wechat_send 快得多（每次调用都要重跑一遍模型）。
  const SPLIT_RULE = '分条方式：想发 2-3 条就把每段用空行隔开、一次写完，系统会自动拆成几条依次发出去。不要为了分条反复调用 wechat_send——每调一次都要重跑一遍模型，对方要等十几秒才看到下一条。wechat_send 只用于发图片、文件，或者确实要精确控制某一条。';

  function buildPrompt(items, cell, talker, history = []) {
    const first = items[0] ?? {};
    const group = first.sessionType === 'group';
    const parts = [];
    if (group) {
      const version = personaVersion();
      const needsPersona = !cell.initialized || cell.personaVersion !== version;
      if (needsPersona) {
        const persona = personaText();
        if (persona) parts.push('下面是你在群里的角色设定，请一直按它说话：\n\n' + persona);
        cell.personaVersion = version;
      }
      parts.push('群聊要点：默认一到两行、口语、不要 emoji 堆砌、不要 Markdown；发图用 wechat_send_meme。');
      parts.push('正文直接写，系统会按空行自动拆成最多 3 条发出去（已经没有「发文字」的工具了，别去找 wechat_send）。想配表情就在正文最后另起一行写 [meme:happy]（tag 取 happy/angry/sad/shy/confused/daily，写中文情绪也行），系统会发一张真表情并把那一行删掉；表情别每条都发，十次里有那么一两次就够。绝对不要写 [表情: xxx] 或 [STICKER:xxx] 这类占位文字——微信里它就是一串字，不是图。');
      parts.push('你的文字回复会被按空行拆成 2-3 条依次发出，所以想连发几条就用空行分段，每段一到两行。');
      parts.push(SPLIT_RULE);
      parts.push(NO_THINKING_RULE);
      parts.push(OUT_RULE);
      parts.push('你在群里没有命令、终端和写文件的权限，只有只读工具 + 微信工具 + 记忆工具，别答应去做本机操作。');
      parts.push(compressRuleLine());
      parts.push('长期记忆用 wechat_memory_append 写（一句话一条，也可以一次写多行=多条），会一直保留、以后每次群聊都附在下面。值得记的：每个群友是谁、外号、说话风格和脾气、工作/生活里提过的事、共同梗、约定、答应过的事。有人聊到关于自己的新信息（换了工作、在忙什么、爱好），就顺手记一条画像；不确定记没记过，用 wechat_memory_read 先看一眼。不要问「要不要我记下来」，直接记。');
      const memory = readMemory(talker);
      if (memory.trim()) parts.push('群聊记忆（你自己之前记的）：\n' + memory.trim());
      // 说话风格只在会话第一轮注入一次；长期记忆（MEMORY.md）属于私聊，不塞进群聊。
      const gv = guidelinesVersion();
      if (!cell.initialized || cell.guidelinesVersion !== gv) {
        const regs = readAgentsDoc('AGENTS.md');
        if (regs) parts.push('以下是本机工作区的说话规则（AGENTS.md），优先遵守：\n' + regs);
        cell.guidelinesVersion = gv;
      }
      parts.push(SKIP_RULE);
      parts.push(GROUP_QUIET_RULE);
      parts.push(NO_NARRATION_RULE);
      if (history.length) {
        parts.push('群里刚才在说这些（你潜水，没回，只是看过了）：');
        for (const past of history.slice(-10)) parts.push(`[${past.name}] ${past.content}`);
        parts.push('——上面这些只是背景，别逐条回，也别总结它们；只看这一轮该接什么。有人发过图片（形如 [图片] D:\\...），需要看内容就用 read_image 打开那个路径。');
      }
      parts.push('微信消息·微信群「' + (first.groupName || '') + '」：');
      for (const item of items) {
        const who = item.senderName || item.talkerId || '群友';
        parts.push(`[${who}] ${String(item.content ?? '')}`);
      }
    } else {
      parts.push(cell.initialized
        ? '这是私聊：正常对话即可。'
        : '你是运行在用户本机的 DSH 助手，通过微信与人对话。可以执行本机任务（命令、文件、截图等）。要把图片发给对方时调用 wechat_send_image 工具，传本机图片绝对路径；想发表情包用 wechat_send_meme。用户说「我去健身了/我出门一趟/待会儿再说」这类暂时离开的话时，用 wechat_remind 安排过一会儿主动问一句（别用固定套路，按事情性质估时间）。这是私聊：正常对话即可。\n重要：你的文字回复会被按空行拆成 2-3 条依次发出，想连发几条就用空行分段。只写要发到微信的那句话本身，不要写你的判断过程、内心想法、为什么这么做——没人要看这些。');
      // 私聊才带长期记忆；规则和记忆都只在会话第一轮（或文件改动后）注入一次，
      // 不必每轮重复塞进上下文。
      const gv = guidelinesVersion();
      if (!cell.initialized || cell.guidelinesVersion !== gv) {
        const regs = readAgentsDoc('AGENTS.md');
        if (regs) parts.push('以下是本机工作区的说话规则（AGENTS.md），优先遵守：\n' + regs);
        const priv = readAgentsDoc('AGENTS.private.md');
        if (priv) parts.push('以下是私聊专属规则（AGENTS.private.md），群里没有这些，别在群里提：\n' + priv);
        const mem = readAgentsDoc('MEMORY.md');
        if (mem) parts.push('以下是本鲸的长期记忆（MEMORY.md），聊天时自然带出，别逐条念：\n' + mem);
        cell.guidelinesVersion = gv;
      }
      parts.push('正文直接写，系统会按空行自动拆成最多 3 条发出去（已经没有「发文字」的工具了，别去找 wechat_send）。想配表情就在正文最后另起一行写 [meme:happy]（tag 取 happy/angry/sad/shy/confused/daily，写中文情绪也行），系统会发一张真表情并把那一行删掉；表情别每条都发，十次里有那么一两次就够。绝对不要写 [表情: xxx] 或 [STICKER:xxx] 这类占位文字——微信里它就是一串字，不是图。');
      parts.push(SPLIT_RULE);
      parts.push(NO_THINKING_RULE);
      parts.push(OUT_RULE);
      parts.push(SKIP_RULE);
      parts.push(NO_NARRATION_RULE);
      parts.push(compressRuleLine());
      parts.push('要记东西就用 wechat_memory_append（只追加、不会坏文件）；不要直接去编辑 MEMORY.md 或别的文件——文件工具要求先读后写，很容易报「file has not been read」，而且那行报错会漏到你眼前。');
      parts.push('微信私聊，对方说：');
      for (const item of items) parts.push(String(item.content ?? ''));
    }
    if (items.length > 1) parts.push('（上面的消息是连续几条，合并成一次理解，只回一次。）');
    return parts.join('\n').slice(0, cfg.maxChars);
  }

  async function handle(talker, items) {
    try {
      const conf = settings();
      // 先把这批消息之前的上下文取出来，再把本批记进去：潜水时也记，被叫醒时不至于断片。
      const history = talkHistory(talker);
      rememberTalk(talker, items);
      memeTurn.delete(talker);   // 新一轮，表情包配额重置
      const limit = conf.rateLimitPerMin;
      if (limit > 0 && recentSends(talker).length >= limit) {
        log('rate limited:', talker, 'limit', limit, '/min');
        return;
      }
      // 群聊唤醒：没叫它就一直潜水（连模型都不调，省钱也不乱回）。
      // 叫醒之后 wakeHoldSeconds 内算「还在跟它说话」，可以顺嘴接几句。
      if (String(talker).includes('@chatroom')) {
        // 唤醒判定：叫名字，或者「@ + 它的名字」。
        // 注意不能只看有没有 @ —— 群里天天 @ 别人（@Yorick、@某某），以前那样等于永远醒着。
        const texts = items.map(item => String(item.content ?? ''));
        const named = texts.some(text => conf.wakeWords.some(word => text.includes(word)));
        const mentions = texts
          .map(text => (text.match(/[@＠]\s*[^\s@＠]{1,24}/g) || []).join(' '))
          .join(' ');
        const atMe = conf.wakeWords.some(word => mentions.includes(word));
        const hit = named || atMe;
        if (hit) {
          wakeAt.set(talker, Date.now());
        } else if (Date.now() - (wakeAt.get(talker) ?? 0) > conf.wakeHoldSeconds * 1000) {
          log('group asleep (no wake word):', talker, 'words=' + JSON.stringify(conf.wakeWords), 'named=' + named, 'at=' + atMe, String(items[0]?.content ?? '').slice(0, 40));
          return;
        }
        // 冷却：被点名时立刻回；只是刚才被叫醒、没再点名，就至少隔 groupGapSeconds 再开口
        // 例外：这批里有图片，或者它刚问过对方一句（等人家回答），就别拿冷却把人挡掉。
        if (!hit && conf.groupGapSeconds > 0) {
          const hasImage = texts.some(text => /\[图片\]|\[表情包\]/.test(text));
          const askedBack = /[?？]\s*$/.test(String(lastReply.get(talker) ?? ''));
          const lastAt = Math.max(0, ...(sentAt.get(talker) ?? [0]));
          if (!hasImage && !askedBack && Date.now() - lastAt < conf.groupGapSeconds * 1000) {
            log('group gap skip:', talker, 'gap', conf.groupGapSeconds + 's', 'idle', Math.round((Date.now() - lastAt) / 1000) + 's');
            return;
          }
        }
      }
      log('message:', talker, 'x' + items.length, String(items[0]?.content ?? '').slice(0, 60));
      const cell = await ensureAgent(talker);
      const prompt = buildPrompt(items, cell, talker, history);
      log('ask ->', cell.sid, 'initialized:', cell.initialized, 'merged:', items.length);
      const reply = await ask(talker, prompt);
      cell.initialized = true;
      const raw = String(reply ?? '').trim();
      const split = splitReply(raw);
      const cleaned = stripMarkers(cleanReply(split.reply) ?? '');
      // 正文末尾的 [meme:happy] 由发送端处理：删掉标记，文字发完再补一张真表情。
      const memeHit = cleaned.match(MEME_MARK);
      const wantMood = memeHit ? String(MEME_MOOD_ALIAS[memeHit[1]] ?? memeHit[1]).toLowerCase() : '';
      const text = wantMood ? cleaned.replace(MEME_MARK, '').replace(/\n{3,}/g, '\n\n').trim() : cleaned;
      recordThinking(talker, split.think, text);
      if (!text && !wantMood) {
        log('skipped (nothing to send):', cell.sid, JSON.stringify(raw.slice(0, 80)));
        return;
      }
      if (FRAMEWORK_ERROR.test(text) && text.length < 400) {
        log('skipped (framework error text):', cell.sid, JSON.stringify(text.slice(0, 160)));
        return;
      }
      if (settings().silent) {
        log('silent mode, reply kept local:', cell.sid, JSON.stringify(text.slice(0, 120)));
        return;
      }
      log('reply <-', cell.sid, JSON.stringify(text.slice(0, 120)));
      const chunks = splitParagraphs(text).slice(0, 3);
      for (let i = 0; i < chunks.length; i += 1) {
        await sendText(talker, chunks[i]);
        if (i < chunks.length - 1) await new Promise(done => setTimeout(done, 700));
      }
      recordSend(talker);
      lastReply.set(talker, chunks[chunks.length - 1] ?? text);
      if (wantMood) {
        if (memeAllowed(talker)) {
          const sentMeme = await sendMemeNow(talker, wantMood, '');
          log('meme marker:', talker, wantMood, sentMeme.ok ? (sentMeme.name || 'ok') : 'failed: ' + sentMeme.error);
        } else {
          log('meme marker skipped (cooldown):', talker, wantMood);
        }
      }
    } catch (error) {
      const message = String(error?.message ?? error);
      log('turn failed:', message);
      // 插件上下文已经失效（DSH 重载/退出中的旧实例）：只记日志，不要把报错发到微信。
      if (/inactive context/i.test(message)) return;
      // 上一轮还没跑完时挤进来的重复消息：直接丢掉，别因此甩一句道歉
      if (/^busy$/i.test(message)) return;
      if (settings().silent) return;
      // 同一个聊天 10 分钟内最多抱怨一次，别每失败一轮就发一句
      const now = Date.now();
      if (now - (fallbackAt.get(talker) ?? 0) < FALLBACK_GAP_MS) {
        log('fallback suppressed:', talker, message.slice(0, 80));
        return;
      }
      fallbackAt.set(talker, now);
      // 渠道/额度类如实说；其它（超时、被取消、未知）只给一句人话
      const channelTrouble = /积分|余额|quota|insufficient|rate limit|unauthorized|api key|账号已被禁用|model not found|no adapter|ECONNRESET|ETIMEDOUT|overloaded/i.test(message);
      const line = channelTrouble ? '本鲸这边的通道出问题了，晚点再说' : '本鲸这边卡了一下，你再说一遍';
      try { await sendText(talker, line); } catch {}
    }
  }

  // 消息合并：
  // 1) 静默窗口——每来一条新消息就重置计时（群聊最多等 15 秒、私聊 25 秒），
  //    避免一句话拆几条被拆成两次输入
  // 2) 思考中不另起一轮——机器人还在想的时候，新消息只攒着，等这一轮说完再一起处理，
  //    否则每来一批就排一次队，回复会排长龙、延迟越来越高
  const runningTurns = new Set();
  const MERGE_MAX_WAIT_MS = 15000;
  const PRIVATE_MERGE_MAX_WAIT_MS = 25000;

  function mergeWindow(talker) {
    const conf = settings();
    const isPrivate = !String(talker).includes('@chatroom');
    return {
      window: isPrivate ? conf.privateMergeSeconds : conf.mergeSeconds,
      maxWait: isPrivate ? PRIVATE_MERGE_MAX_WAIT_MS : MERGE_MAX_WAIT_MS,
    };
  }

  function queueMessage(talker, payload) {
    const { window, maxWait } = mergeWindow(talker);
    if (window <= 0) {
      enqueue(talker, () => handle(talker, [payload]));
      return;
    }
    const slot = buffers.get(talker) ?? { items: [], timer: null, firstAt: 0, lastAt: 0 };
    slot.items.push(payload);
    slot.lastAt = Date.now();
    if (!slot.firstAt) slot.firstAt = slot.lastAt;

    // 正在思考：先攒着，等这轮结束后由 flushAfterTurn 一起发
    if (runningTurns.has(talker)) {
      buffers.set(talker, slot);
      return;
    }

    if (slot.timer) clearTimeout(slot.timer);
    const wait = Math.max(0, Math.min(window * 1000, slot.firstAt + maxWait - Date.now()));
    slot.timer = setTimeout(() => flushBuffer(talker), wait);
    buffers.set(talker, slot);
  }

  function flushBuffer(talker) {
    const slot = buffers.get(talker);
    if (!slot) return;
    if (runningTurns.has(talker)) return;   // 还在想，等结束再说
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    buffers.delete(talker);
    const items = slot.items.slice();
    if (!items.length) return;
    log('merge flush:', talker, items.length + ' 条');

    enqueue(talker, async () => {
      runningTurns.add(talker);
      try {
        await handle(talker, items);
      } finally {
        runningTurns.delete(talker);
        // 思考期间又攒了消息：等一个「安静窗口」再合并成下一轮。
        // 以前固定 800ms 就开火，用户还在连着打字，于是每条消息各开一轮、一条一条回。
        const left = buffers.get(talker);
        if (left && left.items.length && !left.timer) {
          const { window, maxWait } = mergeWindow(talker);
          const now = Date.now();
          const quiet = Math.max(2500, Math.min(window * 1000, (left.lastAt || now) + window * 1000 - now));
          const wait = Math.max(0, Math.min(quiet, (left.firstAt || now) + maxWait - now));
          left.firstAt = left.firstAt || now;
          left.timer = setTimeout(() => flushBuffer(talker), wait);
          buffers.set(talker, left);
          log('merge hold:', talker, left.items.length + ' 条', 'wait ' + Math.round(wait / 1000) + 's');
        }
      }
    });
  }

  function enqueue(talker, task) {
    const previous = queues.get(talker) ?? Promise.resolve();
    const next = previous.then(task, task).catch(() => {});
    queues.set(talker, next);
    next.finally(() => { if (queues.get(talker) === next) queues.delete(talker); });
  }

  async function handleWake(talker, wake) {
    try {
      if (!proactiveOn()) { log('wake skipped (proactive off):', talker); return; }
      log('wake:', talker, String(wake.note ?? '').slice(0, 60));
      const cell = await ensureAgent(talker);
      const prompt = [
        '[定时提醒] 你之前给自己留的备忘：' + String(wake.note ?? ''),
        '现在时间到了，主动给对方发一条微信消息。要求：自然口语、简短，像人一样随口一问；不要提"提醒/定时/备忘/刚才"这类字眼，也不要解释你为什么来消息。',
      ].join('\n');
      const reply = await ask(talker, prompt);
      cell.initialized = true;
      const rawWake = String(reply ?? '').trim();
      const wakeSplit = splitReply(rawWake);
      const wakeCleaned = stripMarkers(cleanReply(wakeSplit.reply) ?? '');
      const wakeMemeHit = wakeCleaned.match(MEME_MARK);
      const wakeMood = wakeMemeHit ? String(MEME_MOOD_ALIAS[wakeMemeHit[1]] ?? wakeMemeHit[1]).toLowerCase() : '';
      const text = wakeMood ? wakeCleaned.replace(MEME_MARK, '').replace(/\n{3,}/g, '\n\n').trim() : wakeCleaned;
      recordThinking(talker, wakeSplit.think, text);
      if (!text && !wakeMood) { log('wake skipped (nothing to send):', cell.sid); return; }
      if (FRAMEWORK_ERROR.test(text) && text.length < 400) { log('wake skipped (framework error text):', cell.sid); return; }
      if (settings().silent) { log('silent mode, wake reply kept local:', cell.sid, JSON.stringify(text.slice(0, 120))); return; }
      log('wake reply <-', cell.sid, JSON.stringify(text.slice(0, 120)));
      const wakeChunks = splitParagraphs(text).slice(0, 3);
      for (let i = 0; i < wakeChunks.length; i += 1) {
        await sendText(talker, wakeChunks[i]);
        if (i < wakeChunks.length - 1) await new Promise(done => setTimeout(done, 700));
      }
      recordSend(talker);
      if (wakeMood && memeAllowed(talker)) {
        const sentWakeMeme = await sendMemeNow(talker, wakeMood, '');
        log('wake meme marker:', talker, wakeMood, sentWakeMeme.ok ? (sentWakeMeme.name || 'ok') : 'failed: ' + sentWakeMeme.error);
      }
    } catch (error) {
      log('wake failed:', error?.message ?? String(error));
    }
  }

  let reconnectTimer = null;
  function scheduleReconnect(ms) {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, ms);
  }

  function connect() {
    if (closed || reconnectTimer) return;
    const req = http.get(base + '/events', res => {
      if (res.statusCode !== 200) {
        log('bridge events status', res.statusCode);
        res.resume();
        scheduleReconnect(3000);
        return;
      }
      log('connected to bridge server:', base);
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
            let frame = null;
            try { frame = JSON.parse(line.slice(5).trim()); } catch {}
            if (!frame || !frame.payload) continue;
            if (frame.type === 'message') {
              const talker = String(frame.payload.sessionId ?? '');
              if (!talker) continue;
              const payload = frame.payload;
              queueMessage(talker, payload);
            } else if (frame.type === 'wake') {
              const talker = String(frame.payload.talker ?? '');
              if (!talker) continue;
              const wake = frame.payload;
              enqueue(talker, () => handleWake(talker, wake));
            }
          }
        }
      });
      res.on('end', () => scheduleReconnect(2000));
      res.on('error', () => scheduleReconnect(2000));
    });
    req.on('error', error => {
      log('bridge server unreachable:', error.message, '（独立服务没启动？）');
      scheduleReconnect(5000);
    });
    cleanups.push(() => req.destroy());
  }

  ctx.on('session/event', (session, event) => {
    const sid = String(session.id);
    const item = pending.get(sid);
    if (!item) return;
    if (event.type === 'turn/start') turns.set(sid, { id: event.data.turn, text: '' });
    if (event.type === 'assistant/message') {
      const turn = turns.get(sid);
      if (turn && turn.id === event.data.turn) turn.text = replyTextOf(event.data.message);
    }
    if (event.type !== 'turn/end') return;
    const turn = turns.get(sid);
    if (turn && turn.id !== event.data.turn) return;
    turns.delete(sid);
    pending.delete(sid);
    clearTimeout(item.timer);
    const reason = event.data.reason?.kind;
    const failure = event.data.reason?.error;
    const detail = failure ? String(failure.message ?? failure).slice(0, 300) : '';
    log('turn/end', sid, reason, detail);
    if (reason === 'completed') item.resolve(turn?.text ?? '');
    else item.reject(new Error('turn_' + (reason ?? 'failed') + (detail ? '：' + detail : '')));
  }, { global: true });

  ctx.effect(() => () => {
    closed = true;
    for (const slot of buffers.values()) { try { clearTimeout(slot.timer); } catch {} }
    buffers.clear();
    runningTurns.clear();
    recentTalk.clear();
    lastReply.clear();
    memeTurn.clear();
    for (const cleanup of cleanups) { try { cleanup(); } catch {} }
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('plugin_stopped')); }
    pending.clear();
    for (const dispose of handles.values()) { try { dispose(); } catch {} }
    handles.clear();
  });

  // 设置页「启动服务」按钮：浏览器不能直接起进程，交给宿主插件拉起 start-bridge-silent.vbs。
  const portOpen = port => new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = value => { try { socket.destroy(); } catch {} resolve(value); };
    socket.setTimeout(800, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

  ctx.inject(['webServer'], webCtx => {
    const register = (routePath, handler, label) => {
      try {
        webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: routePath, handler }), 'dsh-wechat-bridge: ' + label);
      } catch (error) {
        log('web route failed:', routePath, error?.message ?? String(error));
      }
    };
    register('/wechat-bridge/start', (req, res) => {
      const reply = (status, body) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
      try {
        const child = spawn('wscript.exe', [START_VBS], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        log('start-services requested, spawn pid', child.pid);
        reply(200, { ok: true, pid: child.pid, script: START_VBS });
      } catch (error) {
        reply(500, { ok: false, error: error?.message ?? String(error) });
      }
    }, 'start-services');
    register('/wechat-bridge/status', async (req, res) => {
      const [bridge, reader] = await Promise.all([portOpen(Number(cfg.serverPort) || 17890), portOpen(17891)]);
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, bridge, reader }));
    }, 'service-status');
  });

  connect();
  log('started; bridge server:', base, 'workspace:', workspace);
}
