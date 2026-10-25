/**
 * dsh-wechat-bridge — 微信桥接设置页（Client 半边）。
 * 以 dsh.client bundle 格式加载：注册 settings.section「微信桥接」页。
 * 数据走独立服务 http://127.0.0.1:17890（server.mjs），该服务负责与 WeChatAgent 打交道。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wechat-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const BASE = 'http://127.0.0.1:17890'

    async function api(path, options) {
      const res = await fetch(BASE + path, options)
      const text = await res.text()
      let data = null
      try { data = JSON.parse(text) } catch { data = { raw: text } }
      if (!res.ok) throw new Error((data && (data.error || data.message)) || ('HTTP ' + res.status))
      return data
    }

    const post = (path, body) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      card: { border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))', borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      title: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #888)', textTransform: 'uppercase', letterSpacing: '.04em' },
      input: { flex: 1, minWidth: '140px', padding: '6px 9px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', fontSize: '13px' },
      textarea: { width: '100%', minHeight: '60px', padding: '7px 9px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', fontSize: '12px', fontFamily: 'ui-monospace, Consolas, monospace', resize: 'vertical' },
      btn: { padding: '6px 12px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px' },
      btnPrimary: { padding: '6px 14px', borderRadius: '7px', border: 'none', background: 'var(--dsw-alias-brand-primary, #4a7dff)', color: '#fff', cursor: 'pointer', fontSize: '12px', fontWeight: 600 },
      pill: (ok) => ({ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '2px 9px', borderRadius: '999px', fontSize: '11px', background: ok ? 'rgba(52,199,89,.16)' : 'rgba(255,69,58,.16)', color: ok ? '#2e9e4f' : '#d33' }),
      dot: (ok) => ({ width: '7px', height: '7px', borderRadius: '50%', background: ok ? '#2e9e4f' : '#d33' }),
      log: { width: '100%', height: '160px', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '11px', whiteSpace: 'pre-wrap', overflow: 'auto', border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))', borderRadius: '7px', padding: '8px', background: 'rgba(128,128,128,.06)' },
      muted: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #999)' },
      step: (s) => ({ display: 'flex', gap: '8px', fontSize: '12px', color: s === 'failed' ? '#d33' : s === 'warning' ? '#c98a00' : 'inherit' }),
      btnBusy: { opacity: 0.6, cursor: 'progress' },
      chip: (on) => ({ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 9px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))', background: on ? 'rgba(74,125,255,.14)' : 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '11.5px' }),
      code: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '11px', padding: '1px 5px', borderRadius: '4px', background: 'rgba(128,128,128,.12)', wordBreak: 'break-all' },
      tag: (on) => ({ display: 'inline-flex', alignItems: 'center', padding: '1px 7px', borderRadius: '5px', fontSize: '11px', background: on ? 'rgba(52,199,89,.16)' : 'rgba(128,128,128,.16)', color: on ? '#2e9e4f' : 'inherit' }),
      toast: (kind) => ({ position: 'fixed', right: '22px', bottom: '22px', zIndex: 9999, maxWidth: '380px', padding: '10px 14px', borderRadius: '9px', fontSize: '12px', lineHeight: 1.5, boxShadow: '0 8px 24px rgba(0,0,0,.2)', background: kind === 'err' ? '#d33' : '#2e9e4f', color: '#fff' }),
      overlay: { position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' },
      modal: { width: 'min(880px, 100%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', gap: '10px', background: 'var(--dsw-alias-bg-primary, #fff)', color: 'var(--dsw-alias-label-primary, #222)', borderRadius: '12px', padding: '16px', boxShadow: '0 20px 60px rgba(0,0,0,.35)', fontSize: '12.5px' },
      modalBody: { flex: 1, minHeight: '340px', width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', fontSize: '12.5px', lineHeight: 1.6, fontFamily: 'ui-monospace, Consolas, monospace', resize: 'vertical' },
    }

    function BridgePanel() {
      const [health, setHealth] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [logText, setLogText] = React.useState('')
      const [connectSteps, setConnectSteps] = React.useState(null)
      const [talker, setTalker] = React.useState('')
      const [text, setText] = React.useState('测试消息：来自 DSH 微信桥接')
      const [imagePath, setImagePath] = React.useState('')
      const [preset, setPreset] = React.useState('')
      const [provider, setProvider] = React.useState('')
      const [model, setModel] = React.useState('')
      const [proactive, setProactive] = React.useState(true)
      const [reminderCount, setReminderCount] = React.useState(0)
      const [memeInfo, setMemeInfo] = React.useState(null)
      const [mergeSeconds, setMergeSeconds] = React.useState('3')
      const [privateMergeSeconds, setPrivateMergeSeconds] = React.useState('10')
      const [wakeText, setWakeText] = React.useState('大肥鱼\n本鲸')
      const [wakeHold, setWakeHold] = React.useState('120')
      const [rateLimit, setRateLimit] = React.useState('10')
      const [rhythmLoaded, setRhythmLoaded] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [toast, setToast] = React.useState(null)
      const [chats, setChats] = React.useState(null)
      const [chatsWarning, setChatsWarning] = React.useState('')
      const [personas, setPersonas] = React.useState([])
      const [currentPersona, setCurrentPersona] = React.useState('')
      const [editor, setEditor] = React.useState(null)
      const [picker, setPicker] = React.useState(null)
      const [pickerQuery, setPickerQuery] = React.useState('')
      const [pickerBusy, setPickerBusy] = React.useState(false)

      const notify = (kind, text) => setToast({ kind, text, at: Date.now() })
      React.useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), toast.kind === 'err' ? 6000 : 2800)
        return () => clearTimeout(timer)
      }, [toast])

      const refresh = React.useCallback(async () => {
        try {
          const data = await api('/health')
          setHealth(data)
          setError('')
          const cfg = await api('/api/config')
          if (!preset && cfg.agentPreset) setPreset(cfg.agentPreset)
          if (!provider && cfg.provider) setProvider(cfg.provider)
          if (!model && cfg.model) setModel(cfg.model)
          if (typeof cfg.proactive === 'boolean') setProactive(cfg.proactive)
          if (!rhythmLoaded) {
            if (cfg.mergeSeconds !== undefined) setMergeSeconds(String(cfg.mergeSeconds))
            if (cfg.privateMergeSeconds !== undefined) setPrivateMergeSeconds(String(cfg.privateMergeSeconds))
            if (Array.isArray(cfg.wakeWords) && cfg.wakeWords.length) setWakeText(cfg.wakeWords.join('\n'))
            if (cfg.wakeHoldSeconds !== undefined) setWakeHold(String(cfg.wakeHoldSeconds))
            if (cfg.rateLimitPerMin !== undefined) setRateLimit(String(cfg.rateLimitPerMin))
            setRhythmLoaded(true)
          }
          if (data && typeof data.reminders === 'number') setReminderCount(data.reminders)
          try {
            const memes = await api('/api/memes')
            if (memes && typeof memes.total === 'number') setMemeInfo({ total: memes.total, moods: memes.moods || {} })
          } catch {}
        } catch (e) {
          setError('连不上桥接服务：' + e.message + '（先启动 start-bridge-silent.vbs）')
        }
      }, [preset, provider, model, rhythmLoaded])

      React.useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t) }, [refresh])

      const run = async (name, fn, label) => {
        setBusy(name); setNotice(''); setError('')
        try {
          const out = await fn()
          if (label) notify('ok', typeof label === 'function' ? label(out) : label)
          return out
        } catch (e) {
          setError(e.message)
          notify('err', e.message)
          return null
        } finally { setBusy('') }
      }

      // 统一的按钮：点击后立刻禁用 + 变文案，避免「点了没反应」
      const Btn = (action, label, onClick, opts) => {
        const o = opts || {}
        const active = busy === action
        return h('button', {
          type: 'button',
          style: active ? { ...(o.primary ? S.btnPrimary : S.btn), ...S.btnBusy } : (o.primary ? S.btnPrimary : S.btn),
          disabled: !!busy || !!o.disabled,
          onClick,
          title: o.title || label,
        }, active ? '处理中…' : label)
      }

      const loadPicker = async (q, silent) => {
        setPickerBusy(true)
        try {
          const data = await api('/api/chat-picker?q=' + encodeURIComponent(q || ''))
          setPicker(Array.isArray(data.chats) ? data.chats : [])
          if (data.warning && !silent) notify('err', data.warning)
        } catch (e) {
          if (!silent) notify('err', e.message)
        } finally {
          setPickerBusy(false)
        }
      }

      React.useEffect(() => { loadPicker('', true) }, [])
      React.useEffect(() => {
        const timer = setTimeout(() => { loadPicker(pickerQuery, true) }, 300)
        return () => clearTimeout(timer)
      }, [pickerQuery])

      const toggleAllow = (chat) => run('allow-' + chat.talker, async () => {
        const data = await post('/api/allow', { talker: chat.talker, on: !chat.managed })
        const list = Array.isArray(data.allow) ? data.allow : []
        setHealth(prev => (prev ? { ...prev, allow: list } : prev))
        setPicker(prev => (prev || []).map(item => (item.talker === chat.talker ? { ...item, managed: !chat.managed } : item)))
        setChats(prev => (prev || []).map(item => (item.talker === chat.talker ? { ...item, managed: !chat.managed } : item)))
        return { managed: !chat.managed }
      }, data => (data && data.managed ? '已加入白名单，下一轮就能收到它的消息' : '已移出白名单'))

      const loadChats = () => run('chats', async () => {
        const data = await api('/api/chats')
        const list = Array.isArray(data.chats) ? data.chats : []
        setChats(list)
        setChatsWarning(data.warning || '')
        if (data.personaFile) setCurrentPersona(data.personaFile)
        return data
      }, data => '读取到 ' + ((data && data.chats) ? data.chats.length : 0) + ' 个会话')

      const loadPersonas = () => run('personas', async () => {
        const data = await api('/api/personas')
        setPersonas(Array.isArray(data.personas) ? data.personas : [])
        setCurrentPersona(data.current || '')
        return data
      }, data => '找到 ' + ((data && data.personas) ? data.personas.length : 0) + ' 张人格卡')

      const usePersona = (file) => run('use-persona', async () => {
        await post('/api/config', { personaFile: file })
        setCurrentPersona(file)
        await loadPersonas()
        return file
      }, '已切换人格卡，下一轮群聊生效')

      const openFile = async (file) => {
        setEditor({ path: file.path, label: file.label || '', text: '载入中…', original: '', busy: true })
        try {
          const data = await api('/api/file?path=' + encodeURIComponent(file.path))
          setEditor({ path: data.path || file.path, label: file.label || '', text: data.text || '', original: data.text || '', busy: false })
        } catch (e) {
          setEditor(null)
          notify('err', e.message)
        }
      }

      const saveFile = async () => {
        if (!editor) return
        const current = editor
        setEditor({ ...current, busy: true })
        try {
          const out = await post('/api/file', { path: current.path, text: current.text })
          setEditor({ ...current, busy: false, original: current.text })
          notify('ok', '已保存 ' + Math.max(1, Math.round((out.size || 0) / 1024)) + 'KB · 下一轮聊天生效')
          if (chats) loadChats()
        } catch (e) {
          setEditor({ ...current, busy: false })
          notify('err', e.message)
        }
      }

      const reveal = (target) => run('reveal', async () => { await post('/api/reveal', { path: target }) }, '已在资源管理器打开')

      const copyPath = (value) => run('copy', async () => {
        try { await navigator.clipboard.writeText(value) } catch { throw new Error('浏览器不让写剪贴板，手动选中复制吧') }
        return value
      }, '路径已复制')

      const clearMemory = (chat) => run('clear-mem', async () => {
        const file = (chat.files || []).find(f => f.key === 'chatMemory')
        if (!file || !file.exists) throw new Error('这个会话还没有记忆文件，等助手记下第一条再说')
        await post('/api/file', { path: file.path, text: '' })
        const data = await api('/api/chats')
        setChats(Array.isArray(data.chats) ? data.chats : [])
        return file
      }, '记忆已清空（原内容留在 .bak 里）')

      const connect = () => run('connect', async () => {
        const result = await post('/api/connect')
        setConnectSteps(result.steps || [])
        setNotice(result.ok ? '已连接' : '部分步骤失败，看下面明细')
        await refresh()
        return result
      }, result => (result && result.ok ? '微信连上了' : '部分步骤失败，看明细'))

      const togglePause = () => run('pause', async () => {
        const next = !(health && health.paused)
        await post('/api/pause', { paused: next })
        await refresh()
        return next
      }, next => (next ? '已暂停转发' : '已恢复转发'))

      const toggleProactive = () => run('proactive', async () => {
        const next = !proactive
        await post('/api/config', { proactive: next })
        setProactive(next)
        setNotice(next ? '已开启主动发送' : '已关闭主动发送')
        await refresh()
        return next
      }, next => (next ? '已开启主动发送' : '已关闭主动发送'))

      const saveRhythm = () => run('rhythm', async () => {
        const mergeValue = Math.min(Math.max(Number(mergeSeconds) || 0, 0), 30)
        const privateValue = Math.min(Math.max(Number(privateMergeSeconds) || 0, 0), 60)
        const limitValue = Math.max(Math.floor(Number(rateLimit) || 0), 0)
        await post('/api/config', { mergeSeconds: mergeValue, privateMergeSeconds: privateValue, rateLimitPerMin: limitValue })
        setNotice('节奏设置已保存：群聊合并 ' + mergeValue + ' 秒 · 私聊合并 ' + privateValue + ' 秒 · 每分钟最多 ' + (limitValue || '不限') + ' 条')
        await refresh()
        return mergeValue
      }, mergeValue => '已保存：群聊合并 ' + mergeValue + ' 秒')

      const saveWake = () => run('wake', async () => {
        const words = String(wakeText || '')
          .split(/[\n,，、;；\s]+/)
          .map(word => word.trim())
          .filter(Boolean)
          .slice(0, 20)
        if (!words.length) throw new Error('至少留一个唤醒词，不然群里永远叫不醒它')
        const hold = Math.min(Math.max(Math.floor(Number(wakeHold) || 0), 0), 3600)
        await post('/api/config', { wakeWords: words, wakeHoldSeconds: hold })
        setNotice('唤醒词已保存：' + words.join(' / ') + ' · 叫醒后保持 ' + hold + ' 秒')
        await refresh()
        return words.length
      }, count => '已保存 ' + count + ' 个唤醒词')

      const loadLog = () => run('log', async () => {
        const res = await fetch(BASE + '/api/log?lines=200')
        const body = await res.text()
        setLogText(body)
        return body
      }, body => '读到 ' + String(body || '').split('\n').filter(Boolean).length + ' 行')

      const sendText = () => run('sendText', async () => {
        await post('/send/text', { talker, text })
        setNotice('已发送')
      }, '文本已发出')

      const sendImage = () => run('sendImage', async () => {
        const result = await post('/send/image', { talker, path: imagePath })
        setNotice('已发送图片：' + (result.sent || ''))
        return result
      }, result => '图片已发出：' + ((result && result.sent) || ''))

      const saveBridge = () => run('bridge', async () => {
        await post('/api/config', { agentPreset: preset, provider, model })
        setNotice('已保存 DSH 侧配置（新会话生效）')
      }, '已保存，新会话生效')

      const startServices = () => run('start', async () => {
        const res = await fetch('/wechat-bridge/start', { method: 'POST' })
        let data = {}
        try { data = await res.json() } catch {}
        if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status + '（DSH 宿主路由没加载，重启 DSH 一次）'))
        setNotice('已拉起独立服务，等几秒自动连上')
        setTimeout(() => { refresh() }, 6000)
      }, '已拉起独立服务，几秒后自动连上')

      const readerOk = !!(health && health.reader && health.reader.connected)
      const hookOk = !!(health && health.hook && health.hook.account)

      return h('div', { style: S.page },
        error && h('div', { style: { ...S.card, borderColor: '#d33' } }, h('div', null, error)),

        h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.title }, '状态'),
            health ? h('span', { style: S.pill(readerOk) }, h('span', { style: S.dot(readerOk) }), 'reader ' + (readerOk ? '已连接' : '未连接')) : h('span', { style: S.pill(false) }, '服务未启动'),
            health && h('span', { style: S.pill(hookOk) }, h('span', { style: S.dot(hookOk) }), 'hook ' + (hookOk ? '就绪' : '未就绪')),
            health && h('span', { style: S.pill(!health.paused) }, health.paused ? '已暂停' : '转发中'),
          ),
          health && h('div', { style: S.muted },
            '账号 ' + (health.hook.account || '-') + ' · 微信 ' + (health.hook.wechatVersion || '-') +
            ' · 白名单 ' + (health.allow || []).length + ' 项 · 客户端 ' + health.clients + ' 个 · 运行 ' + health.uptimeSec + 's'),
          h('div', { style: S.row },
            Btn('start', '启动服务', startServices, { primary: true }),
            Btn('connect', '连接微信', connect),
            Btn('pause', health && health.paused ? '恢复转发' : '暂停转发', togglePause),
            Btn('refresh', '刷新', () => run('refresh', async () => { await refresh(); return true }, '已刷新')),
            notice && h('span', { style: S.muted }, notice),
          ),
          !health && h('div', { style: S.muted }, '桥接服务未运行：点「启动服务」拉起（等价于双击 start-bridge-silent.vbs），开机自启已配置。'),
          connectSteps && h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            connectSteps.map((step, i) => h('div', { key: i, style: S.step(step.status) },
              h('span', null, step.status === 'ok' ? '✓' : step.status === 'failed' ? '✕' : '·'),
              h('span', null, step.name + (step.detail ? '：' + step.detail : '')),
            )),
          ),
        ),

        h('div', { style: S.card },
          h('div', { style: S.title }, '主动发送'),
          h('div', { style: S.row },
            h('span', { style: S.pill(proactive) }, h('span', { style: S.dot(proactive) }), proactive ? '已开启' : '已关闭'),
            Btn('proactive', proactive ? '关闭主动发送' : '开启主动发送', toggleProactive, { primary: !proactive }),
            reminderCount > 0 && h('span', { style: S.muted }, '待触发提醒 ' + reminderCount + ' 条'),
          ),
          h('div', { style: S.muted }, '开启后助手可以自己挑时机找你（比如记下「过一小时问问练完没有」），也能不等你说话主动发消息。关闭后到点的提醒会先压着，重新打开再发。'),
        ),

        h('div', { style: S.card },
          h('div', { style: S.title }, '对话节奏'),
          h('div', { style: S.row },
            h('span', { style: S.muted }, '合并窗口（秒）'),
            h('input', { style: { ...S.input, maxWidth: '90px', flex: 'none' }, type: 'number', min: 0, max: 30, value: mergeSeconds, onChange: e => setMergeSeconds(e.target.value) }),
            h('span', { style: S.muted }, '私聊合并窗口'),
            h('input', { style: { ...S.input, maxWidth: '90px', flex: 'none' }, type: 'number', min: 0, max: 60, value: privateMergeSeconds, onChange: e => setPrivateMergeSeconds(e.target.value) }),
            h('span', { style: S.muted }, '每分钟最多回复'),
            h('input', { style: { ...S.input, maxWidth: '90px', flex: 'none' }, type: 'number', min: 0, value: rateLimit, onChange: e => setRateLimit(e.target.value) }),
            h('span', { style: S.muted }, '条（0 = 不限）'),
            Btn('rhythm', '保存', saveRhythm, { primary: true }),
          ),
          h('div', { style: S.muted }, '合并窗口：这个时间内的连续消息会攒成一次理解、只回一次（0 = 每条都单独处理）。私聊合并窗口可以设长一点，让你连发几条时它等你打完再回。每分钟上限：超过就不回复，防止刷屏。'),
        ),

        h('div', { style: S.card },
          h('div', { style: S.title }, '群聊唤醒词'),
          h('div', { style: S.muted }, '群里没人叫它就一直潜水，连模型都不调；叫到之后才算加入聊天，可以顺嘴接几句。一行一个，逗号或空格分隔也认。'),
          h('textarea', {
            style: { ...S.input, minHeight: '66px', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 },
            value: wakeText,
            onChange: e => setWakeText(e.target.value),
            placeholder: '大肥鱼\n本鲸',
          }),
          h('div', { style: S.row },
            h('span', { style: S.muted }, '叫醒后保持（秒）'),
            h('input', { style: { ...S.input, maxWidth: '90px', flex: 'none' }, type: 'number', min: 0, max: 3600, value: wakeHold, onChange: e => setWakeHold(e.target.value) }),
            h('span', { style: S.muted }, '这段时间内不用再叫它'),
            Btn('wake', '保存唤醒词', saveWake, { primary: true }),
          ),
        ),

        h('div', { style: S.card },
          h('div', { style: S.title }, '表情包图库'),
          h('div', { style: S.row },
            h('span', { style: S.muted }, memeInfo ? '共 ' + memeInfo.total + ' 张' : '读取中…'),
            memeInfo && h('span', { style: S.muted }, Object.keys(memeInfo.moods || {}).map(k => k + ' ' + memeInfo.moods[k]).join(' · ')),
          ),
          h('div', { style: S.muted }, '群聊和私聊里的助手都能用 wechat_send_meme 按情绪直接发表情包，图库就是 DSH 的 meme-packs（~/.dsh/meme-packs）。'),
        ),

        h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.title }, '选聊天'),
            h('input', {
              style: S.input,
              value: pickerQuery,
              placeholder: '搜昵称 / 群名 / wxid，例：神鲸、Yorick、wxid_ep72',
              onChange: e => setPickerQuery(e.target.value),
            }),
            Btn('picker', pickerBusy ? '查询中…' : '刷新', () => loadPicker(pickerQuery, false)),
          ),
          h('div', { style: S.muted }, '直接从微信最近的聊天里挑，点一下就加进/移出白名单，立刻生效（reader 会自动重读配置）'),
          picker === null && h('div', { style: S.muted }, '正在读取微信会话…'),
          picker && picker.length === 0 && h('div', { style: S.muted }, pickerQuery ? '没有匹配的聊天' : '没读到会话，看看 reader 是否连上'),
          (picker || []).map((chat, i) => h('div', { key: chat.talker || i, style: S.row },
            h('span', { style: S.pill(chat.managed) }, h('span', { style: S.dot(chat.managed) }), chat.kind === 'group' ? '群聊' : '私聊'),
            h('strong', { style: { fontSize: '13px' } }, chat.name || chat.talker),
            Btn('allow-' + i, chat.managed ? '移出白名单' : '加入白名单', () => toggleAllow(chat), { primary: !chat.managed }),
          )),
        ),

        h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.title }, '会话 · 文件 · 记忆'),
            Btn('chats', '读取会话', loadChats, { primary: true }),
            h('span', { style: S.muted }, '每个微信会话用的工作区、会话目录，以及它读的规则/记忆文件，点文件名直接打开编辑'),
          ),
          chatsWarning && h('div', { style: S.muted }, chatsWarning),
          !chats && h('div', { style: S.muted }, '点「读取会话」列出来'),
          (chats || []).map((chat, i) => h('div', { key: chat.talker || i, style: { ...S.card, gap: '8px', background: 'rgba(128,128,128,.05)' } },
            h('div', { style: S.row },
              h('span', { style: S.pill(chat.managed) }, h('span', { style: S.dot(chat.managed) }), chat.kind === 'group' ? '群聊' : '私聊'),
              h('strong', { style: { fontSize: '13px' } }, chat.name || chat.talker),
              h('code', { style: S.code }, chat.talker),
              chat.managed ? null : h('span', { style: S.tag(false) }, '未接管'),
              h('span', { style: S.tag(true) }, chat.sandbox),
            ),
            h('div', { style: S.row },
              h('span', { style: S.muted }, '工作区'),
              h('code', { style: S.code }, chat.workspace),
              Btn('reveal-ws-' + i, '打开', () => reveal(chat.workspace)),
              Btn('copy-ws-' + i, '复制', () => copyPath(chat.workspace)),
            ),
            h('div', { style: S.row },
              h('span', { style: S.muted }, '会话'),
              h('code', { style: S.code }, chat.sid),
              h('span', { style: S.tag(chat.hasSession) }, chat.hasSession ? '已有记录' : '还没聊过'),
              Btn('reveal-sid-' + i, '打开会话目录', () => reveal(chat.sessionPath)),
            ),
            h('div', { style: S.row },
              (chat.files || []).map(file => h('button', {
                key: file.key,
                type: 'button',
                style: S.chip(file.exists),
                title: file.path + (file.note ? '\n' + file.note : ''),
                onClick: () => openFile(file),
              }, (file.exists ? '📄 ' : '＋ ') + file.label + (file.exists ? ' · ' + Math.max(1, Math.round(file.size / 1024)) + 'KB' : '')),
            ),
            h('div', { style: S.muted }, 'AGENTS.md 群聊和私聊都读；AGENTS.private.md、MEMORY.md 只在私聊注入；「本会话记忆」是助手自己用 wechat_memory_append 追加的笔记。'),
            h('div', { style: S.row },
              !chat.managed && Btn('allow-chat-' + i, '加入白名单', () => toggleAllow(chat), { primary: true }),
              Btn('clear-mem-' + i, '清空本会话记忆', () => clearMemory(chat)),
            ),
          ))),
          h('div', { style: S.muted }, '改完下一轮聊天就生效，不用重启；AGENTS.md / MEMORY.md 按文件修改时间自动重新注入。'),
        ),

        h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.title }, '人格卡'),
            Btn('personas', '读取人格卡', loadPersonas),
            h('span', { style: S.muted }, '群聊人设文件（persona/ 目录），改完下一轮群聊生效'),
          ),
          currentPersona && h('div', { style: S.row }, h('span', { style: S.muted }, '当前使用'), h('code', { style: S.code }, currentPersona)),
          !personas.length && h('div', { style: S.muted }, '点「读取人格卡」看 persona 目录下都有哪些'),
          (personas || []).map((item, i) => h('div', { key: item.path, style: S.row },
            h('button', {
              type: 'button',
              style: S.chip(item.current),
              title: item.path,
              onClick: () => openFile({ path: item.path, label: item.name }),
            }, (item.current ? '★ ' : '📄 ') + item.name + ' · ' + Math.max(1, Math.round(item.size / 1024)) + 'KB'),
            item.current ? h('span', { style: S.muted }, '使用中') : Btn('use-persona-' + i, '用它', () => usePersona(item.path)),
            Btn('reveal-persona-' + i, '打开目录', () => reveal(item.path)),
          )),
        ),

        h('div', { style: S.card },
          h('div', { style: S.title }, '测试发送'),
          h('div', { style: S.row },
            h('input', { style: S.input, value: talker, placeholder: 'talker（wxid_xxx 或 xxx@chatroom）', onChange: e => setTalker(e.target.value) }),
          ),
          h('div', { style: S.row },
            h('input', { style: S.input, value: text, placeholder: '文本内容', onChange: e => setText(e.target.value) }),
            Btn('sendText', '发文本', sendText),
          ),
          h('div', { style: S.row },
            h('input', { style: S.input, value: imagePath, placeholder: '图片绝对路径（PNG/JPG 自动转 GIF）', onChange: e => setImagePath(e.target.value) }),
            Btn('sendImage', '发图片', sendImage),
          ),
        ),

        h('div', { style: S.card },
          h('div', { style: S.title }, 'DSH 侧配置'),
          h('div', { style: S.row },
            h('input', { style: S.input, value: preset, placeholder: 'agentPreset（默认 standard）', onChange: e => setPreset(e.target.value) }),
            h('input', { style: S.input, value: provider, placeholder: 'provider', onChange: e => setProvider(e.target.value) }),
            h('input', { style: S.input, value: model, placeholder: 'model', onChange: e => setModel(e.target.value) }),
            Btn('bridge', '保存', saveBridge, { primary: true }),
          ),
          h('div', { style: S.muted }, '微信里用什么预设/模型由这里决定；改完对新建的微信会话生效。'),
        ),

        h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.title }, '日志'),
            Btn('log', '读取', loadLog),
            h('span', { style: S.muted }, 'bridge.log 尾部 200 行'),
          ),
          logText ? h('div', { style: S.log }, logText) : h('div', { style: S.muted }, '点「读取」查看'),
        ),

        editor && h('div', {
          style: S.overlay,
          onClick: e => { if (e.target === e.currentTarget) setEditor(null) },
        },
          h('div', { style: S.modal },
            h('div', { style: S.row },
              h('strong', { style: { fontSize: '13px' } }, editor.label || '编辑文件'),
              h('code', { style: S.code }, editor.path),
              h('span', { style: S.tag(editor.text === editor.original) }, editor.text === editor.original ? '已同步' : '有未保存改动'),
            ),
            h('textarea', {
              style: S.modalBody,
              value: editor.text,
              spellCheck: false,
              onChange: e => setEditor(prev => (prev ? { ...prev, text: e.target.value } : prev)),
            }),
            h('div', { style: S.row },
              h('button', {
                type: 'button',
                style: editor.busy ? { ...S.btnPrimary, ...S.btnBusy } : S.btnPrimary,
                disabled: !!editor.busy,
                onClick: saveFile,
              }, editor.busy ? '保存中…' : '保存'),
              h('button', {
                type: 'button',
                style: S.btn,
                disabled: !!editor.busy,
                onClick: () => openFile({ path: editor.path, label: editor.label }),
              }, '重新读取'),
              h('button', { type: 'button', style: S.btn, onClick: () => setEditor(null) }, '关闭'),
              h('span', { style: S.muted }, '保存时自动留一份 .bak 备份'),
            ),
          ),
        ),

        toast && h('div', { style: S.toast(toast.kind) }, toast.text),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'wechat-bridge', order: 26, label: '微信桥接' },
        () => React.createElement(BridgePanel),
      ))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
