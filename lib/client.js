/**
 * dsh-openrouter-providers — Client 半（持久插件形态，浏览器 bundle）。
 *
 * 注册插件配置折叠卡片（「插件」→「插件配置」，settings.plugin.item 槽），
 * 通过 HTTP API（GET/POST /api/openrouter-providers/state）读写 Host 端的
 * 提供商列表与量化限制。浏览器 bundle 协议：
 * window.__ModuleLoader__.load({ id, factory })，React 来自基线外部模块
 * （require('react')）。
 *
 * 文案跟随 DSH 语言：注册进 locale 服务的 openrouter-providers 命名空间
 * （zh/en 词典），槽注册声明 locale 后由渲染器注入 t 座位；渲染器在每个
 * outlet 上订阅 locale revision，因此切换语言无需刷新即重渲染（响应式）。
 * 不注入 locale 服务时（旧宿主）退回中文文案，卡片照常工作。
 *
 * 卡片外观参照 dshmarket SettingsCard / Host PluginCard：手写 setCard 系列
 * token（--dsw-alias-*），默认折叠，首次展开时懒加载，dirty 显示「未保存」
 * 徽标，footer 提供保存/撤销。
 */
window.__ModuleLoader__.load({ id: 'dsh-openrouter-providers', factory: (require) => {
  const React = require('react')

  const API_PATH = '/api/openrouter-providers/state'
  // 与 Host 半注册的 settings 命名空间同名（settings.plugin.item 的 key）。
  const NS = 'openrouter-providers'

  // OpenRouter quantization levels (mirrors QUANT_LEVELS in lib/index.js).
  const QUANT_LEVELS = ['int4', 'int8', 'fp4', 'mxfp4', 'nvfp4', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown']

  // 词典：每个键都必须同时提供 zh 与 en（locale 服务的双语平衡约定）。
  // 无 locale 服务时用 ZH 作为回退，保证旧宿主上的文案与既有行为一致。
  const ZH = {
    cardName: 'OpenRouter 提供商列表',
    cardDesc: '把提供商列表作为 provider.only / provider.order 路由参数，量化位数限制作为 provider.quantizations，注入到 OpenRouter 模型请求。设置持久化到 DSH 设置文档。',
    unsaved: '未保存',
    enable: '启用提供商限制',
    mode: '路由模式',
    modeOnly: '仅允许这些提供商 (provider.only)',
    modeOrder: '按顺序优先尝试 (provider.order)',
    modeOnlyHint: '仅当列表中的提供商可用时才发送请求（allow_fallbacks=false），全部不可用则请求失败。',
    modeOrderHint: '按列表顺序依次尝试，全部不可用时回退到 OpenRouter 默认路由（allow_fallbacks=true）。',
    quant: '量化位数限制 (provider.quantizations)',
    quantOff: '不限制',
    quantHint: '选择后仅在支持该量化的提供商之间路由（例如 int4 / int8 / fp8 / fp16）。',
    providers: '提供商 (provider slug)',
    providersPlaceholder: '每行一个提供商，例如：\nDeepInfra\nTogether',
    discard: '撤销',
    save: '保存',
    saving: '保存中…',
    loadFailed: '无法读取当前状态（Host 端不可用）',
    savedList: '已保存：{list}',
    savedEmpty: '已保存（空列表：OpenRouter 请求不注入提供商限制）',
    saveFailed: '保存失败',
    settingsDoc: '设置文档: {path}',
    loadError: '加载错误: {message}',
    loaded: '已加载',
  }
  const EN = {
    cardName: 'OpenRouter provider list',
    cardDesc: 'Injects the provider list as provider.only / provider.order and the quantization cap as provider.quantizations into OpenRouter model requests. Settings persist to the DSH settings document.',
    unsaved: 'Unsaved',
    enable: 'Enable provider restriction',
    mode: 'Routing mode',
    modeOnly: 'Only these providers (provider.only)',
    modeOrder: 'Try in order (provider.order)',
    modeOnlyHint: 'Requests go out only while a listed provider is available (allow_fallbacks=false); the request fails when none is.',
    modeOrderHint: 'Providers are tried in list order, falling back to the default OpenRouter routing when none is available (allow_fallbacks=true).',
    quant: 'Quantization cap (provider.quantizations)',
    quantOff: 'No restriction',
    quantHint: 'Routes only among providers that support the selected quantization (int4 / int8 / fp8 / fp16, for example).',
    providers: 'Providers (provider slugs)',
    providersPlaceholder: 'One provider per line, for example:\nDeepInfra\nTogether',
    discard: 'Discard',
    save: 'Save',
    saving: 'Saving…',
    loadFailed: 'Cannot read the current state (Host half unavailable)',
    savedList: 'Saved: {list}',
    savedEmpty: 'Saved (empty list: OpenRouter requests carry no provider restriction)',
    saveFailed: 'Save failed',
    settingsDoc: 'Settings document: {path}',
    loadError: 'Load error: {message}',
    loaded: 'loaded',
  }

  /** `{name}` 模板替换，与 locale 服务的插值语义一致。 */
  function format(template, params) {
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      (params !== undefined && Object.prototype.hasOwnProperty.call(params, name)
        ? String(params[name])
        : match))
  }

  /** 无 locale 服务（旧宿主）时的回退翻译。 */
  function fallbackT(key, params) {
    return format(ZH[key] !== undefined ? ZH[key] : key, params)
  }

  function api(method, body) {
    return fetch(API_PATH, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => r.json())
  }

  // 折叠卡片 chrome —— 镜像 dshmarket Market.module.css setCard..setBody 与
  // Host PluginCard（同 token、同尺寸），与相邻内置卡片外观一致。
  const css = [
    '.orpv-card{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
    '.orpv-card:hover{border-color:var(--dsw-alias-label-dimmed,#c8ccd4)}',
    '.orpv-cardOpen{background:var(--dsw-alias-bg-layer-2,#f7f8fa);border-color:var(--dsw-alias-label-dimmed,#c8ccd4)}',
    '.orpv-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
    '.orpv-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-2px}',
    '.orpv-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
    '.orpv-name{color:var(--dsw-alias-label-primary,#1f2328);font-size:15px;font-weight:600;line-height:1.4}',
    '.orpv-desc{color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:13px;line-height:1.5}',
    '.orpv-chevron{color:var(--dsw-alias-label-tertiary,#8b93a1);flex:none;display:inline-flex;transition:transform .16s}',
    '.orpv-chevronOpen{transform:rotate(180deg)}',
    '.orpv-pending{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform,#eef0f4);color:var(--dsw-alias-label-secondary,#6b7280)}',
    '.orpv-body{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb);margin:0 16px;padding-bottom:8px}',
    '.orpv-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
    '.orpv-field + .orpv-field{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb)}',
    '.orpv-field>span{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
    '.orpv-row{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary)}',
    '.orpv-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
    '.orpv-card select,.orpv-card textarea{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px 10px;font-size:13px;font-family:inherit}',
    '.orpv-card textarea{min-height:110px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical;line-height:1.5}',
    '.orpv-footer{display:flex;align-items:center;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb)}',
    '.orpv-footer .orpv-status{margin-right:auto}',
    '.orpv-discard,.orpv-save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}',
    '.orpv-discard:focus-visible,.orpv-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-2px}',
    '.orpv-discard{border-color:var(--dsw-alias-border-l2,#e5e7eb);background:none;color:var(--dsw-alias-label-secondary,#6b7280)}',
    '.orpv-save{background:var(--dsw-alias-label-primary,#1f2328);color:var(--dsw-alias-bg-layer-3,#fff)}',
    '.orpv-discard:disabled,.orpv-save:disabled{opacity:.4;cursor:default}',
    '.orpv-status{font-size:12px;color:var(--dsw-alias-state-success-primary,#16a34a)}',
    '.orpv-status.error{color:var(--dsw-alias-state-error-primary,#dc2626)}',
    '.orpv-debug{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);word-break:break-all;margin:0;padding:8px 0 0}',
  ].join('\n')

  // 手绘 chevron（无法引入 @deepseek-ai/dsh-client-ui-primitives，bundle 纯净性）。
  function ChevronDown() {
    return React.createElement('svg', {
      width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
      'aria-hidden': true,
    }, React.createElement('path', {
      d: 'M4 6l4 4 4-4', stroke: 'currentColor', strokeWidth: 1.5,
      strokeLinecap: 'round', strokeLinejoin: 'round',
    }))
  }

  function OpenRouterProvidersPage(props) {
    // t 由槽渲染器按 locale 命名空间注入；旧宿主没有 locale 服务时回退。
    const t = typeof props.t === 'function' ? props.t : fallbackT
    const [open, setOpen] = React.useState(false)
    const [enabled, setEnabled] = React.useState(true)
    const [mode, setMode] = React.useState('only')
    const [quantization, setQuantization] = React.useState('off')
    const [text, setText] = React.useState('')
    // saved = 最近一次成功保存/加载的不可变快照，用于计算 dirty。
    const [saved, setSaved] = React.useState(null)
    // status 存的是 key + 插值参数，语言切换后旧消息随新语言重渲染。
    const [status, setStatus] = React.useState(null)
    const [saving, setSaving] = React.useState(false)
    const [docPath, setDocPath] = React.useState('')
    const [loadError, setLoadError] = React.useState('')
    // 首次展开时懒加载（与 dshmarket 一致：展开页签渲染所有卡片，避免无谓探测）。
    const probed = React.useRef(false)

    React.useEffect(() => {
      if (!open || probed.current) return
      probed.current = true
      let alive = true
      api('GET').then((value) => {
        if (!alive) return
        const v = value && typeof value === 'object' ? value : {}
        const next = {
          enabled: v.enabled !== false,
          mode: v.mode === 'order' ? 'order' : 'only',
          quantization: typeof v.quantization === 'string' ? v.quantization : 'off',
          providers: Array.isArray(v.providers) ? v.providers : [],
        }
        setEnabled(next.enabled)
        setMode(next.mode)
        setQuantization(next.quantization)
        setText(next.providers.join('\n'))
        setSaved(next)
        if (typeof v.stateFile === 'string') {
          setDocPath(v.stateFile)
          setLoadError(typeof v.loadError === 'string' ? v.loadError : '')
        }
      }).catch(() => {
        if (!alive) return
        setStatus({ key: 'loadFailed', error: true })
      })
      return () => { alive = false }
    }, [open])

    const parsedProviders = text.split(/[\n,，;；]+/).map(s => s.trim()).filter(s => s.length > 0)
    const sameProviders = (a, b) =>
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
    const dirty = saved !== null && (
      enabled !== saved.enabled ||
      mode !== saved.mode ||
      quantization !== saved.quantization ||
      !sameProviders(parsedProviders, saved.providers)
    )

    const save = () => {
      setSaving(true)
      setStatus(null)
      api('POST', { enabled, mode, providers: parsedProviders, quantization }).then((value) => {
        const v = value && typeof value === 'object' ? value : {}
        const list = Array.isArray(v.providers) ? v.providers : []
        setStatus(list.length > 0
          ? { key: 'savedList', params: { list: list.join(', ') } }
          : { key: 'savedEmpty' })
        setSaved({ enabled, mode, quantization, providers: parsedProviders })
      }).catch(() => {
        setStatus({ key: 'saveFailed', error: true })
      }).finally(() => setSaving(false))
    }

    const discard = () => {
      if (saved === null) return
      setEnabled(saved.enabled)
      setMode(saved.mode)
      setQuantization(saved.quantization)
      setText(saved.providers.join('\n'))
      setStatus(null)
    }

    const header = React.createElement('button', {
      key: 'hd', type: 'button', className: 'orpv-header',
      'aria-expanded': open,
      onClick: () => setOpen(!open),
    }, [
      React.createElement('div', { key: 'ht', className: 'orpv-headText' }, [
        React.createElement('div', { key: 'n', className: 'orpv-name' }, t('cardName')),
        React.createElement('div', { key: 'd', className: 'orpv-desc' }, t('cardDesc')),
      ]),
      dirty ? React.createElement('span', { key: 'u', className: 'orpv-pending' }, t('unsaved')) : null,
      React.createElement('span', {
        key: 'c',
        className: open ? 'orpv-chevron orpv-chevronOpen' : 'orpv-chevron',
      }, React.createElement(ChevronDown, null)),
    ])

    const body = open
      ? React.createElement('div', { key: 'bd', className: 'orpv-body' }, [
          React.createElement('div', { key: 'e', className: 'orpv-row' }, [
            React.createElement('input', {
              key: 'e1', type: 'checkbox', checked: enabled,
              onChange: (e) => setEnabled(e.target.checked),
            }),
            React.createElement('span', { key: 'e2' }, t('enable')),
          ]),
          React.createElement('div', { key: 'm', className: 'orpv-field' }, [
            React.createElement('span', { key: 'm1' }, t('mode')),
            React.createElement('select', {
              key: 'm2', value: mode, disabled: !enabled,
              onChange: (e) => setMode(e.target.value),
            }, [
              React.createElement('option', { key: 'o1', value: 'only' }, t('modeOnly')),
              React.createElement('option', { key: 'o2', value: 'order' }, t('modeOrder')),
            ]),
            React.createElement('p', { key: 'm3', className: 'orpv-hint' },
              mode === 'only' ? t('modeOnlyHint') : t('modeOrderHint')),
          ]),
          React.createElement('div', { key: 'q', className: 'orpv-field' }, [
            React.createElement('span', { key: 'q1' }, t('quant')),
            React.createElement('select', {
              key: 'q2', value: quantization, disabled: !enabled,
              onChange: (e) => setQuantization(e.target.value),
            }, [
              React.createElement('option', { key: 'q0', value: 'off' }, t('quantOff')),
              ...QUANT_LEVELS.map((level) =>
                React.createElement('option', { key: 'q' + level, value: level }, level)),
            ]),
            React.createElement('p', { key: 'q3', className: 'orpv-hint' }, t('quantHint')),
          ]),
          React.createElement('div', { key: 'p', className: 'orpv-field' }, [
            React.createElement('span', { key: 'p1' }, t('providers')),
            React.createElement('textarea', {
              key: 'p2', value: text, disabled: !enabled,
              placeholder: t('providersPlaceholder'),
              onChange: (e) => setText(e.target.value),
            }),
          ]),
          React.createElement('div', { key: 'f', className: 'orpv-footer' }, [
            status ? React.createElement('span', {
              key: 's',
              className: status.error === true ? 'orpv-status error' : 'orpv-status',
            }, t(status.key, status.params)) : null,
            React.createElement('button', {
              key: 'dc', type: 'button', className: 'orpv-discard', onClick: discard,
              disabled: !dirty || saving,
            }, t('discard')),
            React.createElement('button', {
              key: 'sv', type: 'button', className: 'orpv-save', onClick: save,
              disabled: !dirty || saving,
            }, saving ? t('saving') : t('save')),
          ]),
          docPath
            ? React.createElement('p', { key: 'x', className: 'orpv-debug' },
                t('settingsDoc', { path: docPath })
                + (loadError.length > 0 ? ' | ' + t('loadError', { message: loadError }) : ' | ' + t('loaded')))
            : null,
        ])
      : null

    return React.createElement('div', {
      className: open ? 'orpv-card orpv-cardOpen' : 'orpv-card',
    }, [header, body])
  }

  return {
    name: 'dsh-openrouter-providers',
    apply(ctx) {
      // slots 服务在页面启动早期可能尚未注册，用 ctx.inject 等待。
      ctx.inject(['slots'], () => {
        const slots = ctx.get('slots')
        if (!slots) return
        if (typeof document !== 'undefined' && document.head) {
          const style = document.createElement('style')
          style.textContent = css
          document.head.appendChild(style)
          const cleanup = () => { style.remove() }
          ctx.effect(() => cleanup, 'dsh-openrouter-providers: styles')
        }
        // locale 是可选服务（旧宿主没有它），因此不能用 ctx.inject(['locale'])
        // 等待——那会让卡片在没有 locale 的宿主上永不出现。改在
        // settings.plugin.item 声明出现的时刻读取：该声明由 ui-settings-plugins
        // 注册，而它自己注入 locale，所以此处有 locale 就意味着宿主支持本地化。
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'dsh-openrouter-providers: dictionaries')
        }
        // 声明 locale 命名空间：渲染器给入口注入 t 座位，并在每次语言切换
        // （含词典迟到注册）时重渲染该入口，无需刷新页面。注册的组件必须把
        // 收到的 props 透传给卡片，否则 t 座位到不了页面。
        const meta = { name: 'settings.plugin.item', key: NS }
        if (locale !== undefined) meta.locale = NS
        slots.inject('settings.plugin.item', () => slots.register(
          meta,
          (props) => React.createElement(OpenRouterProvidersPage, props ?? null),
        ))
      })
    },
  }
}})
