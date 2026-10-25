import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

const ROOT = 'D:/APP/AI/DSH-WeChat-Bridge';
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const dataRoot = cfg.dataRoot;
const hookUrl = cfg.hookUrl || 'http://127.0.0.1:30001';
let hookToken = cfg.hookToken
  || fs.readFileSync(path.join(dataRoot, 'state/hook/native-token.txt'), 'utf8').trim();
const readerToken = (JSON.parse(fs.readFileSync(path.join(dataRoot, 'state/wechat-io-config.json'), 'utf8'))).reader_token;

const target = process.argv[2] || 'wxid_ep72ue039kcf11';
const filePath = process.argv[3] || path.join(ROOT, 'workspace/screenshot_test.png');

function imageSize(raw, ext) {
  try {
    if (ext === '.png' && raw.length > 24) return { width: raw.readUInt32BE(16), height: raw.readUInt32BE(20) };
    if (ext === '.gif' && raw.length > 10) return { width: raw.readUInt16LE(6), height: raw.readUInt16LE(8) };
  } catch {}
  return { width: 0, height: 0 };
}

function request(url, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const h = { ...headers };
    if (payload) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(payload); }
    const req = http.request(url, { method: body ? 'POST' : 'GET', headers: h }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const health = await request(hookUrl + '/WeChatAgent/health', null, { authorization: 'Bearer ' + hookToken });
console.log('health', health.status, health.raw.slice(0, 200));
const accounts = JSON.parse(health.raw).databaseAccounts || [];
const account = accounts[0];

const raw = fs.readFileSync(filePath);
const ext = path.extname(filePath).toLowerCase() || '.png';
const md5 = crypto.createHash('md5').update(raw).digest('hex');
const outgoing = path.join(dataRoot, 'state/stickers/outgoing');
fs.mkdirSync(outgoing, { recursive: true });
const dest = path.join(outgoing, md5 + ext);
if (!process.env.SKIP_COPY) {
  fs.mkdirSync(outgoing, { recursive: true });
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, raw);
}
const { width, height } = imageSize(raw, ext);
console.log('file', filePath, raw.length, 'bytes', width + 'x' + height, '->', dest);

const res = await request(hookUrl + '/SendStickerMsg', {
  wxidorgid: target,
  sticker: { md5, productid: '', len: raw.length, type: 1, width, height },
  path: dest,
}, { authorization: 'Bearer ' + hookToken, 'x-wechatagent-account': account });
console.log('send', res.status, res.raw.slice(0, 400));

const rq = await request('http://127.0.0.1:5031/api/v1/messages?talker=' + encodeURIComponent(target) + '&limit=3', null, { authorization: 'Bearer ' + readerToken });
const msgs = JSON.parse(rq.raw).messages || [];
for (const m of msgs) console.log('msg', m.localId, 'isSend=' + m.isSend, 'type=' + m.localType, String(m.content).slice(0, 60));
