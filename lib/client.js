/**
 * dsh-openrouter-providers — Client 半（持久插件形态，浏览器 bundle）。
 *
 * 注册设置页（settings.section）「OpenRouter」，通过 HTTP API
 * （GET/POST /api/openrouter-providers/state）读写 Host 端的提供商列表。
 * 浏览器 bundle 协议：window.__ModuleLoader__.load({ id, factory })，
 * React 来自基线外部模块（require('react')）。
 */
window.__ModuleLoader__.load({ id: 'dsh-openrouter-providers', factory: (require) => {
  const React = require('react')

  const API_PATH = '/api/openrouter-providers/state'

  function api(method, body) {
    return fetch(API_PATH, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => r.json())
  }

  const css = [
    '.orpv-page{display:flex;flex-direction:column;gap:14px;max-width:600px;padding:4px 2px}',
    '.orpv-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}',
    '.orpv-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:0}',
    '.orpv-row{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary)}',
    '.orpv-field{display:flex;flex-direction:column;gap:6px}',
    '.orpv-field>span{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
    '.orpv-page select,.orpv-page textarea{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px 10px;font-size:13px;font-family:inherit}',
    '.orpv-page textarea{min-height:120px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical;line-height:1.5}',
    '.orpv-page button{background:var(--dsw-alias-brand-primary);color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;cursor:pointer}',
    '.orpv-page button:disabled{opacity:.6;cursor:default}',
    '.orpv-status{font-size:12px;color:var(--dsw-alias-state-success-primary)}',
    '.orpv-status.error{color:var(--dsw-alias-state-error-primary)}',
    '.orpv-debug{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
  ].join('\n')

  function OpenRouterProvidersPage() {
    const [enabled, setEnabled] = React.useState(true)
    const [mode, setMode] = React.useState('only')
    const [text, setText] = React.useState('')
    const [status, setStatus] = React.useState('')
    const [statusError, setStatusError] = React.useState(false)
    const [saving, setSaving] = React.useState(false)
    const [debug, setDebug] = React.useState('')

    React.useEffect(() => {
      let alive = true
      api('GET').then((value) => {
        if (!alive) return
        const v = value && typeof value === 'object' ? value : {}
        setEnabled(v.enabled !== false)
        setMode(v.mode === 'order' ? 'order' : 'only')
        setText(Array.isArray(v.providers) ? v.providers.join('\n') : '')
        if (typeof v.stateFile === 'string') {
          setDebug('状态文件: ' + v.stateFile + (typeof v.loadError === 'string' && v.loadError.length > 0 ? ' | 加载错误: ' + v.loadError : ' | 已加载'))
        }
      }).catch(() => {
        if (!alive) return
        setStatus('无法读取当前状态（Host 端不可用）')
        setStatusError(true)
      })
      return () => { alive = false }
    }, [])

    const save = () => {
      const providers = text.split(/[\n,，;；]+/).map(s => s.trim()).filter(s => s.length > 0)
      setSaving(true)
      setStatus('')
      api('POST', { enabled, mode, providers }).then((value) => {
        const v = value && typeof value === 'object' ? value : {}
        const list = Array.isArray(v.providers) ? v.providers : []
        setStatus(list.length > 0 ? '已保存：' + list.join(', ') : '已保存（空列表：OpenRouter 请求不注入提供商限制）')
        setStatusError(false)
      }).catch(() => {
        setStatus('保存失败')
        setStatusError(true)
      }).finally(() => setSaving(false))
    }

    return React.createElement('div', { className: 'orpv-page' }, [
      React.createElement('h2', { key: 't', className: 'orpv-title' }, 'OpenRouter 提供商列表'),
      React.createElement('p', { key: 'h', className: 'orpv-hint' },
        '当模型请求路由到 OpenRouter（provider 路由 "openrouter"）时，把下面的列表作为 provider 路由参数注入请求体。设置持久化到状态文件，重启后自动恢复。'),
      React.createElement('label', { key: 'e', className: 'orpv-row' }, [
        React.createElement('input', {
          key: 'e1', type: 'checkbox', checked: enabled,
          onChange: (e) => setEnabled(e.target.checked),
        }),
        React.createElement('span', { key: 'e2' }, '启用提供商限制'),
      ]),
      React.createElement('div', { key: 'm', className: 'orpv-field' }, [
        React.createElement('span', { key: 'm1' }, '路由模式'),
        React.createElement('select', {
          key: 'm2', value: mode, disabled: !enabled,
          onChange: (e) => setMode(e.target.value),
        }, [
          React.createElement('option', { key: 'o1', value: 'only' }, '仅允许这些提供商 (provider.only)'),
          React.createElement('option', { key: 'o2', value: 'order' }, '按顺序优先尝试 (provider.order)'),
        ]),
        React.createElement('p', { key: 'm3', className: 'orpv-hint' },
          mode === 'only'
            ? '仅当列表中的提供商可用时才发送请求（allow_fallbacks=false），全部不可用则请求失败。'
            : '按列表顺序依次尝试，全部不可用时回退到 OpenRouter 默认路由（allow_fallbacks=true）。'),
      ]),
      React.createElement('div', { key: 'p', className: 'orpv-field' }, [
        React.createElement('span', { key: 'p1' }, '提供商 (provider slug)'),
        React.createElement('textarea', {
          key: 'p2', value: text, disabled: !enabled,
          placeholder: '每行一个提供商，例如：\nDeepInfra\nTogether',
          onChange: (e) => setText(e.target.value),
        }),
      ]),
      React.createElement('div', { key: 'b', className: 'orpv-row' }, [
        React.createElement('button', { key: 'b1', onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
        status ? React.createElement('span', {
          key: 'b2',
          className: statusError ? 'orpv-status error' : 'orpv-status',
        }, status) : null,
      ]),
      debug ? React.createElement('p', { key: 'd', className: 'orpv-debug' }, debug) : null,
    ])
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
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'openrouter-providers', order: 25, label: () => 'OpenRouter' },
          () => React.createElement(OpenRouterProvidersPage, null),
        ))
      })
    },
  }
}})
