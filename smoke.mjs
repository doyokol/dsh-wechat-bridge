// 冒烟测试：用最小假 ctx 加载桥接插件，验证「SSE 收消息 → 白名单过滤 → hook 发消息」全链路。
// 不占用 DSH 桌面实例；回复内容固定，仅用于自检。
// 用法：node smoke.mjs  （然后往白名单里的微信聊天发一条文本消息）
import { apply } from 'file:///D:/APP/AI/DSH-WeChat-Bridge/native-context.mjs';

const listeners = [];
const cleanups = [];
const agents = new Map();
const fakeCtx = {
  on(type, handler) { if (type === 'session/event') listeners.push(handler); return () => {}; },
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') cleanups.push(dispose);
    return () => {};
  },
  agents: {
    get: sid => agents.get(sid),
    create: async ({ sessionId, setup }) => {
      const agentCtx = { tools: { register: () => () => {} } };
      if (setup) await setup(agentCtx);
      const agent = {
        sessionId,
        followup(message) {
          const text = message?.content?.map(block => block.text).join('') ?? '';
          setTimeout(() => {
            for (const listener of listeners) {
              listener({ id: sessionId }, { type: 'turn/start', data: { turn: 1 } });
              listener({ id: sessionId }, {
                type: 'assistant/message',
                data: { turn: 1, message: { content: [{ type: 'text', text: `[冒烟测试] 收到你的消息：${text.slice(0, 120)}` }] } },
              });
              listener({ id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
            }
          }, 50);
        },
      };
      agents.set(sessionId, agent);
      return agent;
    },
    resume: async () => { throw new Error('smoke: resume unsupported'); },
  },
  sessions: { get: () => undefined },
  agentPresets: {
    resolve: async id => ({ id }),
    mount: async (_agentCtx, id) => ({ id }),
  },
};

apply(fakeCtx, {});
console.log('[smoke] bridge loaded; waiting for a WeChat message from an allowed chat...');
setTimeout(() => { console.log('[smoke] exit'); process.exit(0); }, 5 * 60 * 1000);
