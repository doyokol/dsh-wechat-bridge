# DSH × 微信 全权限桥接（自建通道）

把个人微信接进 DeepSeek Harness：微信里发消息 = 给本机 DSH 派任务，可跑命令、读改文件、截图，并能把截图/图片直接发回微信。
DSH 侧用 `standard` 预设，**工具不做任何白名单限制**。

**不再依赖 WeChatAgent**：收消息用自建 `reader.py`（离线解密读微信本地库），发消息用自编译的 `version.dll`（hook 监听 30002，文本 + 原图直发）。

## 架构

```
微信（本机 4.1.10.27 副本）
   ├─ 发：version.dll（自编译 hook，127.0.0.1:30002）
   └─ 收：reader.py（离线读库，127.0.0.1:17891）
              ↕
        server.mjs（桥接服务，127.0.0.1:17890：收发 + 事件流 + 面板 API）
              ↕  本地 SSE / HTTP
        native-context.mjs（DSH 插件宿主半边：把消息转成 DSH 轮次）
              ↕
        DSH agent（standard 预设，全工具；回复/图片经 server.mjs 发回微信）
```

DSH 设置页里的「微信桥接」面板 = `client.js`（状态、暂停、白名单、连接自检、测试发文本/发图、插件配置、日志）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | 桥接服务：连 reader 收消息、调 hook 发消息、对外 HTTP/SSE、面板 API |
| `reader.py` | 自建收消息服务（离线解密微信库，SSE 推送） |
| `native-context.mjs` | DSH cordis 插件宿主半边（瘦客户端，只连 17890） |
| `client.js` / `package.json` | DSH 插件页面半边与包声明（`dsh.client`） |
| `panel.html` | 独立面板页面（浏览器开 `http://127.0.0.1:17890/`） |
| `config.json` | 唯一配置（两层共用） |
| `persona/本鲸.md` | 群聊人设（只在群会话注入；私聊不用） |
| `runtime/wechat-4.1.10.27/` | 微信固定版本副本（已装入我们的 `version.dll`） |
| `vendor/WeChat-Hook/` | 上游 hook 源码（固定 commit，用于自行编译） |
| `vendor/weflow-cli/` | 读库组件（MIT） |
| `dist/version.dll` | 我们编译的 hook（sha256 见 `dist/build.json`） |
| `scripts/build-hook.ps1` | 编译 hook（用便携 MSVC 工具链，无需装 VS） |
| `scripts/deploy-hook.ps1` | 装 DLL 到微信副本并启动（`-PrepareOnly` 只装不启动） |
| `scripts/start-services.ps1` | 隐藏窗口启动 reader + server（可重复执行） |
| `start-wechat.bat` | 启动微信副本（`StartPort=30002`） |
| `start-bridge-silent.vbs` / `start-bridge.bat` | 启动桥接服务（静默 / 带窗口） |
| `stop-bridge.bat` | 停止 reader 与桥接服务（不动微信） |
| `bridge.log` / `reader.out` / `bridge.err` | 运行日志与崩溃输出 |

## 使用

1. `start-wechat.bat` 启动微信副本（首次需扫码登录；已登录会自动恢复）。
2. `start-bridge-silent.vbs` 启动 reader + 桥接服务（无黑框；已加入开机启动项）。
3. DSH 里在设置 →「微信桥接」查看状态，必要时点「连接微信」自检（检查 hook/reader/白名单）。
4. 微信私聊机器人即可；发「截个图看看」会收到本机截图。

端口：hook `30002`、reader `17891`、桥接 `17890`。健康检查 `http://127.0.0.1:17890/health`。

## 配置（config.json）

| 键 | 说明 |
| --- | --- |
| `hookMode` | `native` = 自编译 hook（推荐）；`wechatagent` = 复用旧 WeChatAgent |
| `hookUrl` | hook 地址，默认 `http://127.0.0.1:30002` |
| `readerUrl` | reader 地址，默认 `http://127.0.0.1:17891` |
| `dbPath` / `decryptKey` | 微信数据目录与解密密钥（DPAPI 解出后明文保存，仅供本机使用） |
| `allow` | 允许的会话（talker username，群为 `xxx@chatroom`），`*` 全放行 |
| `agentPreset` / `provider` / `model` | DSH 侧用哪套预设与模型 |
| `personaFile` / `personaVersion` | 群聊人设文件与版本（改版本号可强制重新注入） |
| `memeRoot` | 表情包图库目录，空 = `~/.dsh/meme-packs`（即 dsh-meme 插件的图库） |
| `mergeSeconds` | 消息合并窗口（秒）：窗口内的连续消息合并成一次输入、只回一次；0 = 每条单独处理 |
| `rateLimitPerMin` | 每分钟最多回复条数；0 = 不限（超限时这条消息不回复） |
| `silent` | 沉默模式：照常接收和处理，但回复不通过微信发出 |
| `groupSandboxMode` / `privateSandboxMode` | 会话沙箱档位：群默认 `workspace-write`（只能改 workspace），私聊默认空=全权限 |
| `paused` | 暂停处理微信消息 |

## 群聊人设与表情包

- 群会话（`xxx@chatroom`）第一次说话时会把 `persona/本鲸.md` 作为角色设定注入；私聊不注入。
- 群聊里模型判断这轮不该接话时只回 `[SKIP]`，插件会丢掉这条，不发给群里。
- 表情包直接用 dsh-meme 的图库：工具 `wechat_send_meme(mood)`，mood ∈ `happy/angry/sad/shy/confused/daily`，服务端随机挑一张发到当前聊天（`POST /send/meme`；`GET /api/memes` 看库存）。
- 对话节奏（合并窗口 / 每分钟上限 / 沉默模式）在设置页「对话节奏」卡片里改，保存后立即生效（插件每轮读取 config.json，不用重启）。

## 群聊权限与记忆

- 群里只给只读工具（`read/glob/grep`）+ 微信三个工具 + 记忆工具；`bash/pwsh/terminal/write/edit/...` 由 `tools.guard()` 直接拒掉（私聊不受影响，仍是全权限）。
- 沙箱：群会话 `sandbox/mode` 设为 `workspace-write`，写操作只落在 `workspace/`。
- 记忆：群里助手用 `wechat_memory_append(note)` 往 `workspace/memory/group-<hash>.md` 追加一行；每轮群聊把最近 5000 字记忆贴进 prompt。记忆只由这一个工具写入，群里的通用文件工具是禁的。

## 已知边界

- 固定微信 `4.1.10.27`（hook 依赖该版本偏移）；换版本需重新编译/适配。
- 图片走 `SendImgMsg` 直发原图；hook 只监听 `127.0.0.1`。
- 微信侧 `wake_mode` 等 WeChatAgent 配置与本通道无关；若两者同时开着同一聊天，会出现双回复（已停用 WeChatAgent）。
