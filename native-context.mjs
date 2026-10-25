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
  const memoryFile = talker => path.join(MEMORY_DIR, 'group-' + crypto.createHash('sha1').update(String(talker)).digest('hex').slice(0, 10) + '.md');
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
    const installTools = agentCtx => {
      // 群聊限权：命令、终端、写文件这些一律拒掉，只留只读 + 微信相关 + 记忆工具。
      // 私聊保持全权限（agent 默认）。
      if (isGroup) {
        // 白名单式限权：只放行只读/联网/微信/记忆类工具，其余（命令、终端、写文件、后台任务…）一律拒。
        // 联网工具（web_search / web_fetch / read_page / x_search / web_reader）必须放行，
        // 否则查行情、看新闻、搜资料全都做不了。
        // 注意 meme-search__search 带连字符，用 /^...|meme/ 兜住。
        const KEEP = /^(read|glob|grep|list|find|search|web|fetch|x_search|read_page|todo_write|wechat_|meme|skill)/i;
        const disposeGuard = agentCtx.tools.guard(exec => {
          const name = String(exec?.name ?? '');
          if (!name || KEEP.test(name)) return undefined;
          return `群聊里不开放「${name}」工具`;
        });
        if (disposeGuard) handles.set(sid + ':guard', disposeGuard);

        const disposeMemory = agentCtx.tools.register({
          name: 'wechat_memory_append',
          description: '往群聊记忆里记一条笔记（只追加，会一直保留并在之后的群聊里作为「群聊记忆」出现）。适合记：群里谁来谁往、谁的癖好和外号、共同梗、约定、答应过的事、你自己想记住的事。一句一条，简短。',
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
          description: '把群聊记忆里已经记下的内容读出来看看（确认自己的笔记真的写进去了、之前记过谁）。',
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
          try {
            const result = await serverRequest('/send/meme', { talker, mood, query: String(args?.query ?? '') });
            const name = String(result?.name ?? '');
            return { ok: true, mood: String(result?.mood ?? mood), message: '表情包已发到微信' + (name ? '（' + name + '）' : '') };
          } catch (error) {
            return { ok: false, mood, message: '表情包发送失败：' + ((error && error.message) || String(error)) };
          }
        },
      });
      if (disposeMeme) handles.set(sid + ':meme', disposeMeme);

      // 主动发文本：不必等对方先说话，可以自己找对方（比如"看完了，觉得还行"）
      const disposeSend = agentCtx.tools.register({
        name: 'wechat_send',
        description: '主动往当前微信聊天发一条文本消息（不需要对方先说话）。适合想说点什么、或补充一句的时候。',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: '要发送的文本' } },
          required: ['text'],
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
          if (!args?.text || typeof args.text !== 'string') return { ok: false, message: '需要 text 参数' };
          if (!proactiveOn()) return { ok: false, message: '主动发送已在「DSH 设置 → 微信桥接」里关闭，不能主动发消息' };
          try {
            await sendText(talker, args.text);
            return { ok: true, message: '已发送到微信' };
          } catch (error) {
            return { ok: false, message: '发送失败：' + ((error && error.message) || String(error)) };
          }
        },
      });
      if (disposeSend) handles.set(sid + ':send', disposeSend);

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
    const lines = raw.split(/\r?\n/);
    const marked = lines.some(line => SKIP_LINE.test(line.trim()));
    if (!marked) return raw;
    const kept = lines.filter(line => !SKIP_LINE.test(line.trim()) && !SELF_TALK.test(line));
    const body = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
    };
  }

  const sentAt = new Map();     // talker -> 最近一分钟的发送时间戳
  const wakeAt = new Map();     // talker -> 最近一次被唤醒（叫到名字）的时间
  const fallbackAt = new Map(); // talker -> 最近一次发「卡了一下」兜底话术的时间
  const FALLBACK_GAP_MS = 10 * 60 * 1000; // 同一个聊天 10 分钟内最多发一次兜底话术
  const buffers = new Map();    // talker -> { items, timer }

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

  function buildPrompt(items, cell, talker) {
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
      parts.push('发表情只能用 wechat_send_meme 工具；绝对不要写 [表情: xxx] 或 [STICKER:xxx] 这类占位文字——微信里它就是一串字，不是图。');
      parts.push('你的文字回复会被按空行拆成 2-3 条依次发出，所以想连发几条就用空行分段，每段一到两行。');
      parts.push(NO_THINKING_RULE);
      parts.push(OUT_RULE);
      parts.push('你在群里没有命令、终端和写文件的权限，只有只读工具 + 微信工具 + 记忆工具，别答应去做本机操作。');
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
      parts.push('发表情只能用 wechat_send_meme 工具；绝对不要写 [表情: xxx] 或 [STICKER:xxx] 这类占位文字——微信里它就是一串字，不是图。');
      parts.push(NO_THINKING_RULE);
      parts.push(OUT_RULE);
      parts.push(SKIP_RULE);
      parts.push('微信私聊，对方说：');
      for (const item of items) parts.push(String(item.content ?? ''));
    }
    if (items.length > 1) parts.push('（上面的消息是连续几条，合并成一次理解，只回一次。）');
    return parts.join('\n').slice(0, cfg.maxChars);
  }

  async function handle(talker, items) {
    try {
      const conf = settings();
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
        if (!hit && conf.groupGapSeconds > 0) {
          const lastAt = Math.max(0, ...(sentAt.get(talker) ?? [0]));
          if (Date.now() - lastAt < conf.groupGapSeconds * 1000) {
            log('group gap skip:', talker, 'gap', conf.groupGapSeconds + 's', 'idle', Math.round((Date.now() - lastAt) / 1000) + 's');
            return;
          }
        }
      }
      log('message:', talker, 'x' + items.length, String(items[0]?.content ?? '').slice(0, 60));
      const cell = await ensureAgent(talker);
      const prompt = buildPrompt(items, cell, talker);
      log('ask ->', cell.sid, 'initialized:', cell.initialized, 'merged:', items.length);
      const reply = await ask(talker, prompt);
      cell.initialized = true;
      const raw = String(reply ?? '').trim();
      const split = splitReply(raw);
      const text = stripMarkers(cleanReply(split.reply) ?? '');
      recordThinking(talker, split.think, text);
      if (!text) {
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
    const slot = buffers.get(talker) ?? { items: [], timer: null, firstAt: 0 };
    slot.items.push(payload);
    if (!slot.firstAt) slot.firstAt = Date.now();

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
        // 思考期间又攒了消息：稍等一下再合并成下一轮，别立刻追一条
        const left = buffers.get(talker);
        if (left && left.items.length && !left.timer) {
          left.firstAt = left.firstAt || Date.now();
          left.timer = setTimeout(() => flushBuffer(talker), 800);
          buffers.set(talker, left);
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
      const text = stripMarkers(cleanReply(wakeSplit.reply) ?? '');
      recordThinking(talker, wakeSplit.think, text);
      if (!text) { log('wake skipped (nothing to send):', cell.sid); return; }
      if (FRAMEWORK_ERROR.test(text) && text.length < 400) { log('wake skipped (framework error text):', cell.sid); return; }
      if (settings().silent) { log('silent mode, wake reply kept local:', cell.sid, JSON.stringify(text.slice(0, 120))); return; }
      log('wake reply <-', cell.sid, JSON.stringify(text.slice(0, 120)));
      const wakeChunks = splitParagraphs(text).slice(0, 3);
      for (let i = 0; i < wakeChunks.length; i += 1) {
        await sendText(talker, wakeChunks[i]);
        if (i < wakeChunks.length - 1) await new Promise(done => setTimeout(done, 700));
      }
      recordSend(talker);
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
