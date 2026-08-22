/**
 * dsh-openrouter-providers — Client 半（持久插件形态，浏览器 bundle）。
 *
 * 注册插件配置折叠卡片（「插件」→「插件配置」，settings.plugin.item 槽），
 * 通过 HTTP API（GET/POST /api/openrouter-providers/state）读写 Host 端的
 * 提供商列表与量化限制。浏览器 bundle 协议：
 * window.__ModuleLoader__.load({ id, factory })，React 来自基线外部模块
 * （require('react')）。
 *
 * 卡片外观参照 dshmarket SettingsCard / Host PluginCard：手写 setCard 系列
 * token（--dsw-alias-*），默认折叠，首次展开时懒加载，dirty 显示「未保存」
 * 徽标，footer 提供保存/撤销。
 */
window.__ModuleLoader__.load({ id: 'dsh-openrouter-providers', factory: (require) => {
  const React = require('react')

  const API_PATH = '/api/openrouter-providers/state'

  // OpenRouter quantization levels (mirrors QUANT_LEVELS in lib/index.js).
  const QUANT_LEVELS = ['int4', 'int8', 'fp4', 'mxfp4', 'nvfp4', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown']

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

  function OpenRouterProvidersPage() {
    const [open, setOpen] = React.useState(false)
    const [enabled, setEnabled] = React.useState(true)
    const [mode, setMode] = React.useState('only')
    const [quantization, setQuantization] = React.useState('off')
    const [text, setText] = React.useState('')
    // saved = 最近一次成功保存/加载的不可变快照，用于计算 dirty。
    const [saved, setSaved] = React.useState(null)
    const [status, setStatus] = React.useState('')
    const [statusError, setStatusError] = React.useState(false)
    const [saving, setSaving] = React.useState(false)
    const [debug, setDebug] = React.useState('')
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
          setDebug('设置文档: ' + v.stateFile + (typeof v.loadError === 'string' && v.loadError.length > 0 ? ' | 加载错误: ' + v.loadError : ' | 已加载'))
        }
      }).catch(() => {
        if (!alive) return
        setStatus('无法读取当前状态（Host 端不可用）')
        setStatusError(true)
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
      setStatus('')
      api('POST', { enabled, mode, providers: parsedProviders, quantization }).then((value) => {
        const v = value && typeof value === 'object' ? value : {}
        const list = Array.isArray(v.providers) ? v.providers : []
        setStatus(list.length > 0 ? '已保存：' + list.join(', ') : '已保存（空列表：OpenRouter 请求不注入提供商限制）')
        setStatusError(false)
        setSaved({ enabled, mode, quantization, providers: parsedProviders })
      }).catch(() => {
        setStatus('保存失败')
        setStatusError(true)
      }).finally(() => setSaving(false))
    }

    const discard = () => {
      if (saved === null) return
      setEnabled(saved.enabled)
      setMode(saved.mode)
      setQuantization(saved.quantization)
      setText(saved.providers.join('\n'))
      setStatus('')
      setStatusError(false)
    }

    const header = React.createElement('button', {
      key: 'hd', type: 'button', className: 'orpv-header',
      'aria-expanded': open,
      onClick: () => setOpen(!open),
    }, [
      React.createElement('div', { key: 'ht', className: 'orpv-headText' }, [
        React.createElement('div', { key: 'n', className: 'orpv-name' }, 'OpenRouter 提供商列表'),
        React.createElement('div', { key: 'd', className: 'orpv-desc' },
          '把提供商列表作为 provider.only / provider.order 路由参数，量化位数限制作为 provider.quantizations，注入到 OpenRouter 模型请求。设置持久化到 DSH 设置文档。'),
      ]),
      dirty ? React.createElement('span', { key: 'u', className: 'orpv-pending' }, '未保存') : null,
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
          React.createElement('div', { key: 'q', className: 'orpv-field' }, [
            React.createElement('span', { key: 'q1' }, '量化位数限制 (provider.quantizations)'),
            React.createElement('select', {
              key: 'q2', value: quantization, disabled: !enabled,
              onChange: (e) => setQuantization(e.target.value),
            }, [
              React.createElement('option', { key: 'q0', value: 'off' }, '不限制'),
              ...QUANT_LEVELS.map((level) =>
                React.createElement('option', { key: 'q' + level, value: level }, level)),
            ]),
            React.createElement('p', { key: 'q3', className: 'orpv-hint' },
              '选择后仅在支持该量化的提供商之间路由（例如 int4 / int8 / fp8 / fp16）。'),
          ]),
          React.createElement('div', { key: 'p', className: 'orpv-field' }, [
            React.createElement('span', { key: 'p1' }, '提供商 (provider slug)'),
            React.createElement('textarea', {
              key: 'p2', value: text, disabled: !enabled,
              placeholder: '每行一个提供商，例如：\nDeepInfra\nTogether',
              onChange: (e) => setText(e.target.value),
            }),
          ]),
          React.createElement('div', { key: 'f', className: 'orpv-footer' }, [
            status ? React.createElement('span', {
              key: 's',
              className: statusError ? 'orpv-status error' : 'orpv-status',
            }, status) : null,
            React.createElement('button', {
              key: 'dc', type: 'button', className: 'orpv-discard', onClick: discard,
              disabled: !dirty || saving,
            }, '撤销'),
            React.createElement('button', {
              key: 'sv', type: 'button', className: 'orpv-save', onClick: save,
              disabled: !dirty || saving,
            }, saving ? '保存中…' : '保存'),
          ]),
          debug ? React.createElement('p', { key: 'x', className: 'orpv-debug' }, debug) : null,
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
        slots.inject('settings.plugin.item', () => slots.register(
          { name: 'settings.plugin.item', key: 'openrouter-providers' },
          () => React.createElement(OpenRouterProvidersPage, null),
        ))
      })
    },
  }
}})