"""DSH-WeChat-Bridge 自带的消息读取服务（收消息侧）。

不依赖 WeChatAgent 进程：直接读取微信 4.x 的 SQLCipher 数据库，
用 vendor/weflow-cli 里 MIT 许可的 nt_decrypt 解密。

对外 HTTP（默认 127.0.0.1:17891，可用 config.json 的 readerPort 改）：
  GET /health                  -> {"ok":true,"dbReady":true,"talkers":N}
  GET /api/v1/sessions         -> {"success":true,"sessions":[{username,displayName,type}]}
  GET /api/v1/chats?q=&limit=  -> {"success":true,"chats":[{username,displayName,type,lastAt,summary}]}
  GET /api/v1/messages?talker= -> {"success":true,"messages":[...]}
  GET /api/v1/push/messages    -> SSE，事件体为 message.new 推送
"""

import hashlib
import json
import pathlib
import queue
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE
sys.path.insert(0, str(ROOT / 'vendor' / 'weflow-cli' / 'scripts'))
import nt_decrypt as nt  # noqa: E402

CONFIG_PATH = ROOT / 'config.json'
POLL_INTERVAL = 1.0
HISTORY_LIMIT = 30
MIME_EXT = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp'}

# 不是真人会话，列白名单时跳过
SYSTEM_TALKERS = {
    'weixin', 'filehelper', 'fmessage', 'medianote', 'floatbottle', 'newsapp',
    'qqmail', 'qqsafe', 'brandsessionholder', 'notifymessage', 'weixinreminder',
    'officialaccounts', 'notification_messages', 'mphelper', 'exmail_tool',
    'weixinpay', 'wechatpay', 'tenpay', 'wxpay', 'qqmailplugin', 'weibo',
}

# WeChatAgent 项目里那份 MIT 的图片解码实现（能解微信 4.x 的 .dat）。换版本时按候选路径找。
MEDIA_SCRIPTS_CANDIDATES = [
    r'D:\APP\AI\DSH-Wechat\WeChatAgent\data\workspace\scripts',
]


def load_config():
    with open(CONFIG_PATH, encoding='utf-8') as handle:
        return json.load(handle)


class MediaStore:
    """把收到的图片变成本地 jpg：消息 → MessageResourceInfo.packed_info(md5) → <md5>_t.dat → 解密。"""

    def __init__(self, config):
        self.config = config
        self.db_path = pathlib.Path(config['dbPath'])
        self.own_wxid = config.get('selfWxid') or ''
        self.out_dir = pathlib.Path(config.get('mediaDir') or (ROOT / 'workspace' / 'media' / 'in'))
        self.scripts = config.get('wechatScripts') or ''
        self.mod = None
        self.keys = None
        self.index = {}
        self.index_at = 0.0
        self.conn = None
        self.memo = {}

    def _module(self):
        if self.mod is not None:
            return self.mod
        for path in [self.scripts] + MEDIA_SCRIPTS_CANDIDATES:
            if not path or not pathlib.Path(path).is_dir():
                continue
            if path not in sys.path:
                sys.path.insert(0, path)
            try:
                import wechat_media  # noqa: WPS433
                self.mod = wechat_media
                return self.mod
            except Exception:
                continue
        return None

    def _derive_keys(self):
        if self.keys is not None:
            return self.keys
        mod = self._module()
        if not mod:
            return None
        try:
            self.keys = mod.resolve_v2_media_key(str(self.db_path), self.own_wxid)
        except Exception:
            self.keys = None
        if not self.keys:
            # 派生不出来时（kvcomm 里没有 key_<code>_*.statistic，微信重启/升级后常见）用配置里存的 key。
            # aes 允许两种写法：16 位字符串（就是 AES key 本身）或 32 位 hex。
            stored = self.config.get('mediaKey')

            def parse_aes(text):
                text = str(text or '').strip()
                if len(text) == 16:
                    return text.encode('ascii')
                if len(text) == 32:
                    return bytes.fromhex(text)
                return None

            try:
                if isinstance(stored, dict):
                    code = int(stored.get('code'))
                    aes = parse_aes(stored.get('aes'))
                    if aes:
                        self.keys = (code, aes)
                elif isinstance(stored, str) and ':' in stored:
                    code_text, aes_text = stored.split(':', 1)
                    aes = parse_aes(aes_text)
                    if aes:
                        self.keys = (int(code_text), aes)
            except (TypeError, ValueError):
                self.keys = None
            if self.keys:
                print('media key from config fallback (code=%s)' % self.keys[0], flush=True)
        return self.keys

    def _resource_conn(self):
        if self.conn is not None:
            return self.conn
        path = self.db_path / 'db_storage' / 'message' / 'message_resource.db'
        if not path.is_file():
            return None
        key, salt = nt.derive_database_key(str(path), '', '', self.config['decryptKey'])
        conn, _cursor = nt.connect_nt_db(str(path), key, salt)
        self.conn = conn
        return conn

    def md5_for(self, server_id, local_id):
        """MessageResourceInfo.packed_info 里那串 32 位 hex 就是要找的图片 md5。"""
        cached = self.memo.get((server_id, local_id))
        if cached:
            return cached
        conn = self._resource_conn()
        if conn is None:
            return None
        row = None
        try:
            if server_id:
                row = conn.execute(
                    'SELECT packed_info FROM MessageResourceInfo WHERE message_svr_id=? LIMIT 1',
                    (int(server_id),)).fetchone()
            if row is None and local_id:
                row = conn.execute(
                    'SELECT packed_info FROM MessageResourceInfo WHERE message_local_id=? LIMIT 1',
                    (int(local_id),)).fetchone()
        except Exception:
            return None
        if not row or not row[0]:
            return None
        import re
        match = re.search(rb'[0-9a-fA-F]{32}', bytes(row[0]))
        if not match:
            return None
        md5 = match.group(0).decode('ascii').lower()
        self.memo[(server_id, local_id)] = md5
        return md5

    def _file_index(self, force=False):
        now = time.time()
        if self.index and not force and now - self.index_at < 120:
            return self.index
        # 同一张图微信本地会存好几份：<md5>_h.dat（原图）、<md5>.dat（中图）、
        # <md5>_b.dat（聊天气泡里显示的那张，比缩略图大得多）、<md5>_t.dat（缩略图）。
        # 按 _h > 无后缀 > _b > _t 挑，别让 _t 把 _b 挤掉（2026-10-25 修：_b 之前没登记，
        # 分数是 0，比 _t 的 1 还低，于是永远取到看不清字的缩略图）。
        rank = {'_h': 4, '': 3, '_b': 2, '_t': 1}
        bucket = {}
        for root in ('msg', 'cache', 'resource'):
            base = self.db_path / root
            if not base.is_dir():
                continue
            try:
                for item in base.rglob('*.dat'):
                    name = item.name.lower()
                    core = name[:-4]
                    if '_' in core:
                        md5, suffix = core.split('_', 1)
                        suffix = '_' + suffix
                    else:
                        md5, suffix = core, ''
                    if len(md5) != 32:
                        continue
                    bucket.setdefault(md5, []).append((rank.get(suffix, 0), item))
            except OSError:
                continue
        # 一个 md5 可能有好几份文件，全留着按优先级排好，解码失败的再往下一份试。
        self.index = {
            md5: [item for _, item in sorted(items, key=lambda pair: -pair[0])]
            for md5, items in bucket.items()
        }
        self.index_at = now
        return self.index

    def resolve(self, server_id, local_id):
        """返回解密后的本地图片路径，失败返回 None。"""
        md5 = self.md5_for(server_id, local_id)
        if not md5:
            return None
        for existing in self.out_dir.glob(md5 + '.*'):
            if existing.suffix in ('.jpg', '.png', '.gif', '.webp'):
                return existing
        mod = self._module()
        pair = self._derive_keys()
        if not mod or not pair:
            return None
        sources = self._file_index().get(md5) or self._file_index(True).get(md5) or []
        for source in sources:
            got = self._decode_source(mod, source, pair)
            if not got:
                continue
            data, mime = got
            ext = MIME_EXT.get(mime)
            if not ext:
                continue
            self.out_dir.mkdir(parents=True, exist_ok=True)
            target = self.out_dir / (md5 + ext)
            target.write_bytes(data)
            return target
        return None

    @staticmethod
    def _decode_source(mod, source, pair):
        """先按 V2 加密解；不是加密文件（明文 jpg/png）就直接读。"""
        got = mod.decode_wechat_v2(str(source), pair[0], pair[1])
        if got:
            return got
        try:
            head = pathlib.Path(source).read_bytes()[:16]
        except OSError:
            return None
        mime = mod.detect_mime_from_bytes(head)
        if not mime:
            return None
        try:
            return pathlib.Path(source).read_bytes(), mime
        except OSError:
            return None


class Reader:
    def __init__(self, config):
        self.config = config
        self.db_path = pathlib.Path(config['dbPath'])
        self.key = config['decryptKey']
        self.own_wxid = config.get('selfWxid') or ''
        self.talkers = list(config.get('allow') or [])
        self.message_db = self.db_path / 'db_storage' / 'message' / 'message_0.db'
        self.contact_db = self.db_path / 'db_storage' / 'contact' / 'contact.db'
        self.session_db = self.db_path / 'db_storage' / 'session' / 'session.db'
        self.names = {}
        self.group_titles = {}
        self.last_id = {}
        self.queue = queue.Queue()
        self.lock = threading.Lock()
        self.conns = None
        self.media = MediaStore(config)

    # ---------- 数据库 ----------
    def open_conns(self):
        pairs, failures = nt.connect_message_shards_detailed(str(self.message_db), '', '', self.key)
        if failures or not pairs:
            for _, connection in pairs:
                connection.close()
            raise RuntimeError('消息库分片无法读取: ' + repr(failures))
        return [connection for _, connection in pairs]

    def refresh_names(self):
        try:
            key, salt = nt.derive_database_key(str(self.contact_db), '', '', self.key)
            names = nt.load_contact_names(str(self.contact_db), key, salt)
            if names:
                self.names = names
        except Exception:
            pass
        try:
            key, salt = nt.derive_database_key(str(self.session_db), '', '', self.key)
            connection, cursor = nt.connect_nt_db(str(self.session_db), key, salt)
            try:
                titles = {}
                try:
                    for username, title in cursor.execute(
                        'SELECT username,session_title FROM SessionNoContactInfoTable LIMIT 5000'):
                        if username and title:
                            titles[username] = title
                except Exception:
                    pass
                self.group_titles = titles
            finally:
                connection.close()
        except Exception:
            pass

    def display_name(self, talker):
        if talker in self.group_titles:
            return self.group_titles[talker]
        entry = self.names.get(talker)
        if entry:
            return entry if isinstance(entry, str) else str(entry)
        return talker

    def sender_name(self, wxid):
        entry = self.names.get(wxid)
        if entry:
            return entry if isinstance(entry, str) else str(entry)
        return wxid

    def fetch(self, talker, limit=HISTORY_LIMIT):
        conns = self.open_conns()
        try:
            data = nt.get_messages(conns, talker, limit=limit, name_map=self.names,
                                   own_wxid=self.own_wxid)
            return data.get('messages', [])
        finally:
            for connection in conns:
                connection.close()

    def sessions(self):
        return [{'username': talker, 'displayName': self.display_name(talker),
                 'conversationId': talker,
                 'type': 1 if '@chatroom' in talker else 0} for talker in self.talkers]

    def chats(self, keyword='', limit=150):
        """最近的会话（群 + 私聊），给面板选白名单用。按最后活跃时间倒序。"""
        keyword = (keyword or '').strip().lower()
        out = []
        try:
            key, salt = nt.derive_database_key(str(self.session_db), '', '', self.key)
            connection, cursor = nt.connect_nt_db(str(self.session_db), key, salt)
        except Exception:
            traceback.print_exc()
            return out
        try:
            rows = list(cursor.execute(
                'SELECT username,last_timestamp,summary FROM SessionTable '
                'ORDER BY sort_timestamp DESC LIMIT 800'))
        except Exception:
            traceback.print_exc()
            rows = []
        finally:
            try:
                connection.close()
            except Exception:
                pass
        for username, last_ts, summary in rows:
            username = str(username or '')
            if not username or username in SYSTEM_TALKERS:
                continue
            if username.startswith('gh_') or username.startswith('@') or username.startswith('weixin_'):
                continue
            name = self.display_name(username)
            summary = str(summary or '')
            if keyword and keyword not in (username + ' ' + name).lower():
                continue
            out.append({
                'username': username,
                'displayName': name,
                'type': 'group' if '@chatroom' in username else 'private',
                'lastAt': int(last_ts or 0),
                'summary': summary[:80],
            })
            if len(out) >= limit:
                break
        return out

    # ---------- 轮询 ----------
    def refresh_talkers(self):
        """白名单可能在运行中被桥接改掉，配置文件变了就重新读一次。"""
        try:
            stat = CONFIG_PATH.stat()
            stamp = (stat.st_mtime_ns, stat.st_size)
            if stamp == getattr(self, '_config_stamp', None):
                return
            self._config_stamp = stamp
            talkers = list(load_config().get('allow') or [])
            if talkers != self.talkers:
                self.talkers = talkers
                print('[reader] talkers ->', talkers, flush=True)
        except Exception:
            pass

    def poll_once(self):
        self.refresh_talkers()
        for talker in self.talkers:
            try:
                rows = self.fetch(talker)
            except Exception:
                continue
            rows.sort(key=lambda item: item.get('localId') or 0)
            last = self.last_id.get(talker, 0)
            fresh = [row for row in rows if (row.get('localId') or 0) > last]
            if not fresh:
                continue
            self.last_id[talker] = fresh[-1]['localId']
            for row in fresh:
                content = row.get('content') or row.get('parsedContent') or ''
                local_type = row.get('localType')
                if row.get('isSend'):
                    continue
                sender = row.get('senderUsername') or ''
                if sender and self.own_wxid and (sender == self.own_wxid or self.own_wxid.startswith(sender)):
                    continue
                image_path = None
                if local_type == 3:
                    # 微信自己的原图常常比消息行晚几百毫秒到几秒才落到 msg/cache/resource。
                    # 早先只试一次，没下完就永远定稿成 `[图片]`（用户发来的截图会整张丢失）。
                    # 这里给它几秒重试窗口，仍然拿不到才退回纯占位文本。
                    for attempt in range(4):
                        try:
                            image_path = self.media.resolve(row.get('serverId'), row.get('localId'))
                        except Exception:
                            traceback.print_exc()
                            image_path = None
                        if image_path:
                            break
                        time.sleep(1.0 if attempt == 0 else 0.8)
                    content = ('[图片] ' + str(image_path)) if image_path else '[图片]'
                elif local_type != 1 or not content:
                    continue
                payload = {
                    'event': 'message.new',
                    'sessionId': talker,
                    'conversationId': talker,
                    'sessionType': 'group' if '@chatroom' in talker else 'private',
                    'rawid': str(row.get('serverId') or row.get('localId')),
                    'groupName': self.display_name(talker) if '@chatroom' in talker else '',
                    'sourceName': self.display_name(talker),
                    'senderName': self.sender_name(sender),
                    'talkerId': sender,
                    'content': content,
                    'type': 3 if image_path else 1,
                    'imagePath': str(image_path) if image_path else '',
                    'timestamp': row.get('createTime'),
                }
                self.queue.put(payload)

    def prime(self):
        """启动时把游标推进到当前最新消息，避免把历史消息当成新消息推送。"""
        for talker in self.talkers:
            try:
                rows = self.fetch(talker, limit=5)
            except Exception:
                continue
            ids = [row.get('localId') or 0 for row in rows]
            if ids:
                self.last_id[talker] = max(ids)

    def run(self):
        while True:
            try:
                self.poll_once()
            except Exception:
                traceback.print_exc()
            time.sleep(POLL_INTERVAL)


class Handler(BaseHTTPRequestHandler):
    reader = None

    def log_message(self, *args):
        pass

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parts = urlsplit(self.path)
        query = parse_qs(parts.query)
        if parts.path == '/health':
            try:
                self.reader.fetch(self.reader.talkers[0]) if self.reader.talkers else None
                ready = True
            except Exception:
                ready = False
            return self._json({'ok': True, 'dbReady': ready, 'talkers': len(self.reader.talkers)})
        if parts.path == '/api/v1/sessions':
            return self._json({'success': True, 'sessions': self.reader.sessions()})
        if parts.path == '/api/v1/chats':
            keyword = (query.get('q') or [''])[0]
            try:
                limit = int((query.get('limit') or ['150'])[0])
            except ValueError:
                limit = 150
            try:
                rows = self.reader.chats(keyword, max(1, min(limit, 400)))
            except Exception as error:
                return self._json({'success': False, 'error': str(error)}, 500)
            return self._json({'success': True, 'chats': rows})
        if parts.path == '/api/v1/messages':
            talker = (query.get('talker') or [''])[0]
            try:
                rows = self.reader.fetch(talker)
            except Exception as error:
                return self._json({'success': False, 'error': str(error)}, 500)
            return self._json({'success': True, 'messages': rows})
        if parts.path == '/api/v1/push/messages':
            return self._sse()
        return self._json({'success': False, 'error': 'not found'}, 404)

    def _sse(self):
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream; charset=utf-8')
        self.send_header('cache-control', 'no-cache')
        self.send_header('connection', 'keep-alive')
        self.end_headers()
        while True:
            try:
                payload = self.reader.queue.get(timeout=15)
                chunk = 'event: message\ndata: ' + json.dumps(payload, ensure_ascii=False) + '\n\n'
            except queue.Empty:
                chunk = ': keep-alive\n\n'
            try:
                self.wfile.write(chunk.encode('utf-8'))
                self.wfile.flush()
            except Exception:
                return


def main():
    config = load_config()
    reader = Reader(config)
    reader.refresh_names()
    try:
        reader.open_conns()
        reader.prime()
        print('reader ready: db=%s talkers=%d' % (reader.db_path, len(reader.talkers)), flush=True)
    except Exception as error:
        print('reader 启动时读取数据库失败: %s' % error, flush=True)
    threading.Thread(target=reader.run, daemon=True).start()
    Handler.reader = reader
    port = int(config.get('readerPort') or 17891)
    host = config.get('readerHost') or '127.0.0.1'
    server = ThreadingHTTPServer((host, port), Handler)
    print('reader listening on %s:%d' % (host, port), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
