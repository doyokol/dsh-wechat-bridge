# DSH × 微信 全权限桥接（自建通道）

把**个人微信**接进 [DeepSeek Harness](https://github.com/deepseek-ai)：微信里发一句消息 = 给本机 DSH 派一个任务。它能跑命令、读改文件、截图，把结果（含截图、原图）直接发回微信。

不依赖任何第三方微信客户端：收消息用自建 `reader.py`（离线解密微信本地数据库），发消息用自编译的 `version.dll`（hook 拦截，监听 30002）。

DSH 侧默认用 `standard` 预设，工具不做白名单限制。

## 特性

- **收发都在自己手里**：reader 读库收消息，hook 直发文本 / 原图 / 表情，不经过任何云端中转
- **原图不是缩略图**：微信本地同一张图存三份（`_h` 原图 / 中图 / `_t` 缩略图），优先解 `_h`，实测能还原 1920×1080、1080×2740
- **像人一样聊天**：断句分条发、句末不加句号、自然收尾发表情包、群聊默认潜水（唤醒词/@ 才开口）
- **群聊有记忆**：按群落 `memory/group-<hash>.md`，模型自己往里记群友画像
- **设置页面板**：DSH 设置 →「微信桥接」，改白名单（可搜名字）、对话节奏、唤醒词、人格卡，点开就能编辑规则文件
- **思考过程单独留档**：模型的思考段落到 `workspace/thinking.jsonl`，只在面板看，不发微信

## 架构

```
微信（本机 4.1.10.27 副本）
   ├─ 发：version.dll（自编译 hook，127.0.0.1:30002）
   └─ 收：reader.py（离线读库，127.0.0.1:17891）
              ↕
        server.mjs（桥接服务 127.0.0.1:17890：收发 + SSE + 面板 API）
              ↕  本地 SSE / HTTP
        native-context.mjs（DSH 插件宿主半边：消息 → DSH 轮次）
              ↕
        DSH agent（standard 预设；回复/图片经 server.mjs 发回微信）
```

端口：hook `30002`、reader `17891`、桥接 `17890`。健康检查 `http://127.0.0.1:17890/health`。

## 前置条件

| 需要 | 说明 |
| --- | --- |
| 微信 **4.1.10.27** | hook 是按这个版本的偏移写的，换版本要重新适配 |
| 自编译的 `version.dll` | 放在微信副本目录里，随微信进程加载；源码见 `vendor/`（不随仓库分发） |
| Python 3 + `pycryptodome` | `reader.py` 解密微信本地库用 |
| DeepSeek Harness | 桌面版，插件以 profile bundle 形式挂载 |

> `runtime/`（微信副本）、`vendor/`（hook 源码）、`workspace/`（运行时数据）、`config.json`（含密钥）都在 `.gitignore` 里，仓库只放代码。

## 安装

1. 克隆到任意目录：

   ```bash
   git clone https://github.com/doyokol/dsh-wechat-bridge.git D:/AI/DSH-WeChat-Bridge
   ```

2. 生成配置：

   ```bash
   cp config.example.json config.json
   ```

   然后按下面「配置」一节填 `dbPath` / `selfWxid` / `decryptKey` / `hookToken` / `pythonPath`。

3. 挂进 DSH（二选一）：

   ```bash
   # A. 作为 profile bundle（推荐，会在插件管理页出现）
   dsh plugin --profile desktop add link:D:/AI/DSH-WeChat-Bridge

   # B. 手工：node_modules 建 junction + profile package.json 的 dsh.profile.bundles 加 dsh-wechat-bridge
   ```

4. 启动微信副本：`start-wechat.bat`（首次扫码登录，之后自动恢复）。
5. 启动收发服务：`start-bridge-silent.vbs`（无黑框）。
6. 重启 DSH，设置 →「微信桥接」里点「连接微信」自检（hook / reader / 白名单）。

## 配置（config.json）

从 `config.example.json` 复制，关键的几项：

| 键 | 说明 |
| --- | --- |
| `dbPath` / `selfWxid` | 微信数据目录（`xwechat_files/<你的 wxid>`）与自己的 wxid |
| `decryptKey` | 本地库解密密钥（本机 DPAPI 解出后落盘，别外传） |
| `hookToken` | hook 鉴权 token，读 `runtime/wechat-4.1.10.27/wechatagent-hook.token` |
| `mediaKey` | `{code, aes}`：微信重启后 kvcomm 派生不出 key 时的兜底，用来解图片 |
| `pythonPath` | 带 `pycryptodome` 的 python.exe |
| `allow` | 允许接管的会话（私聊 `wxid_xxx`、群 `xxx@chatroom`）；空 = 谁都不理 |
| `provider` / `model` | DSH 侧用哪个渠道与模型 |
| `mergeSeconds` / `privateMergeSeconds` | 群聊 / 私聊的消息合并窗口（秒）：窗口内连发几条算一次输入，只回一次 |
| `groupGapSeconds` | 群里两次开口的最小间隔 |
| `wakeWords` / `wakeHoldSeconds` | 群聊唤醒词（也可用 @）与被叫醒后保持清醒的秒数 |
| `turnTimeoutMs` | 单轮超时，`0` = 不限时 |
| `personaFile` | 群聊人设文件，只在群会话注入 |
| `maxChars` | 注入 prompt 的最大字符数 |
| `paused` | 暂停处理（不删白名单） |

## 群聊行为

- 群里**默认潜水**：命中唤醒词或被 `@` 才开口，之后 `wakeHoldSeconds` 内可以接话
- 时间距离上次开口不足 `groupGapSeconds` 且没被点名 → 直接跳过
- 这轮判断不该接话时模型只输出 `[SKIP]`，插件整条丢掉
- 群里只放只读工具 + 微信工具 + 记忆工具，`bash/write/edit` 之类由 `tools.guard()` 拒掉
- 群会话沙箱 `workspace-write`（只能改 `workspace/`），私聊默认全权限

## 图片

微信本地每张图有三份：`<md5>_h.dat`（原图）、`<md5>.dat`（中图）、`<md5>_t.dat`（缩略图）。
`reader.py` 的索引按 `_h > 中图 > _t` 挑，解出来写 `workspace/media/in/<md5>.<ext>`，以 `[图片] <路径>` 的形式进 prompt，模型再调 `read_image` 看。

解密 key 从 `kvcomm/key_<code>_*.statistic` 派生；派生不出来时用 `config.mediaKey` 兜底。

## 文件

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | 桥接服务：收消息、发消息、SSE、面板 API |
| `reader.py` | 自建收消息服务（离线解密 + 图片解密 + SSE 推送） |
| `native-context.mjs` | DSH 插件宿主半边（注册工具、拼 prompt、跑轮次、发回复） |
| `client.js` / `panel.html` | DSH 设置页面板 / 独立面板页 |
| `persona/本鲸.md` | 群聊人设示例（可换成自己的） |
| `config.example.json` | 脱敏配置模板 |
| `smoke.mjs` / `test-send.mjs` | 自检脚本 |

## 已知边界

- 只适配微信 `4.1.10.27`；微信自动更新会顶掉 hook（仓库外的看门狗脚本负责还原）
- hook 只监听 `127.0.0.1`，不对外暴露
- 原图直发更吃 vision token
- 群里连续发太多消息会被微信截断（经验值：单轮 ≤5 条）

## 免责声明

仅供个人学习与自用。使用前请自行评估账号风险；因使用本工具导致的账号异常、消息丢失等后果由使用者自负。

## License

MIT
