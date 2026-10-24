/**
 * dsh-openrouter-providers — Client 半（持久插件形态，浏览器 bundle）。
 *
 * 通过 HTTP API（GET/POST /api/openrouter-providers/state）读写 Host 端的
 * 提供商列表、按模型规则与量化限制；GET 同时带回官方提供商目录（catalog），
 * 驱动勾选式选择器。浏览器 bundle 协议：
 * window.__ModuleLoader__.load({ id, factory })，React 来自基线外部模块
 * （require('react')）。
 *
 * 配置入口按宿主版本双栈注册（两个 slots.inject 各自等待自己的声明，未声明
 * 的那个永不触发，因此新旧宿主都不会报错）：
 * - 新宿主（DSH >= 0.1.6-alpha.2）：`plugins.bundle.config`，以包名为键，渲染
 *   在「插件」页该组合包页面里。页面自己画标题/图标/面包屑，并按 owner props
 *   的 view 索取两种视图：`summary` 一句话简介、`page` 表单（只有保存会写入，
 *   离开页面丢弃暂存修改）。
 * - 旧宿主：`settings.plugin.item`（折叠卡片，含未保存徽标与保存/撤销）。
 *
 * 文案跟随 DSH 语言：注册进 locale 服务的 openrouter-providers 命名空间
 * （zh/en 词典），槽注册声明 locale 后由渲染器注入 t 座位；渲染器在每个
 * outlet 上订阅 locale revision，因此切换语言无需刷新即重渲染（响应式）。
 * 不注入 locale 服务时（旧宿主）退回中文文案，界面照常工作。
 */
window.__ModuleLoader__.load({ id: 'dsh-openrouter-providers', factory: (require) => {
  const React = require('react')

  const API_PATH = '/api/openrouter-providers/state'
  // 与 Host 半注册的 settings 命名空间同名（旧槽 settings.plugin.item 的 key）。
  const NS = 'openrouter-providers'
  // 新槽 plugins.bundle.config 以组合包的包名为键。
  const PACKAGE_NAME = 'dsh-openrouter-providers'

  // OpenRouter quantization levels (mirrors QUANT_LEVELS in lib/index.js).
  const QUANT_LEVELS = ['int4', 'int8', 'fp4', 'mxfp4', 'nvfp4', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown']

  // 词典：每个键都必须同时提供 zh 与 en（locale 服务的双语平衡约定）。
  // 无 locale 服务时用 ZH 作为回退，保证旧宿主上的文案与既有行为一致。
  const ZH = {
    cardName: 'OpenRouter 提供商列表',
    cardDesc: '把提供商列表作为 provider.only / provider.order 路由参数，量化位数限制作为 provider.quantizations，注入到 OpenRouter 模型请求。配置持久化到插件自持的配置文件。',
    summary: '把 OpenRouter 请求限制在指定提供商列表与量化位数内。',
    unsaved: '未保存',
    enable: '启用提供商限制',
    routes: '识别的模型路由（可选）',
    routesHint: '插件只对指向 OpenRouter 的模型路由注入。内置始终识别 openrouter，并自动识别配置里 baseURL 指向 openrouter.ai（或 apiKeyEnv 为 OPENROUTER_API_KEY）的提供商；当前识别：{active}。未被识别时可在此手动添加路由 id，每行一个。',
    routesPlaceholder: '例如：\nmy-route-id',
    mode: '路由模式',
    modeOnly: '仅允许这些提供商 (provider.only)',
    modeOrder: '按顺序优先尝试 (provider.order)',
    modeOnlyHint: '仅当列表中的提供商可用时才发送请求（allow_fallbacks=false），全部不可用则请求失败。',
    modeOrderHint: '按列表顺序依次尝试，全部不可用时回退到 OpenRouter 默认路由（allow_fallbacks=true）。',
    quant: '量化位数限制 (provider.quantizations)',
    quantOff: '不限制',
    quantHint: '选择后仅在支持该量化的提供商之间路由（例如 int4 / int8 / fp8 / fp16）。',
    proxy: 'billion-context 压缩代理',
    proxyOff: '直连 OpenRouter（不经过代理）',
    proxyAuto: '自动：检测到代理时经由它请求',
    proxyHint: '检测到 billion-context 代理时，把请求改经它的 /bili/ 入口发出，从而获得上下文压缩；未检测到代理则直连，不影响生成。',
    proxyActive: '代理已接入: {origin}',
    proxyInactive: '未检测到运行中的代理，当前直连',
    providers: '提供商 (provider slug)',
    providersPlaceholder: '每行一个提供商，例如：\nDeepInfra\nTogether',
    discard: '撤销',
    save: '保存',
    saving: '保存中…',
    loadFailed: '无法读取当前状态（Host 端不可用）',
    loadFailedDetail: '无法读取当前状态：{message}',
    savedList: '已保存：{list}',
    savedEmpty: '已保存（空列表：OpenRouter 请求不注入提供商限制）',
    saveFailed: '保存失败',
    saveFailedDetail: '保存失败：{message}',
    settingsDoc: '配置文件: {path}',
    loadError: '加载错误: {message}',
    loaded: '已加载',
    providersHint: '全局默认列表：在下方目录中勾选，或手动添加自定义 slug。留空 = 全局不注入（仅按模型规则生效）。',
    pickerSelected: '已选 {n} 个',
    pickerClear: '清空',
    pickerSearch: '搜索提供商（名称或 slug）…',
    pickerCustomPlaceholder: '自定义 slug',
    pickerAdd: '添加',
    pickerEmpty: '目录为空或未加载——直接在下方输入 slug 添加。',
    pickerNoMatch: '没有匹配的提供商',
    pickerOffline: '离线或未刷新：当前显示内置提供商快照，可能不完整或非最新。',
    rules: '按模型规则（可选，自上而下第一条命中生效）',
    rulesHint: '支持 * 通配；不含 * 时按前缀/命名空间匹配（如 xiaomi 命中 xiaomi/mimo-v2.6-flash）。命中后该模型改用规则的模式与提供商；「不限制」表示该模型跳过提供商注入。',
    rulePattern: '模型匹配',
    rulePatternPlaceholder: '例如 xiaomi/mimo* 或 anthropic/*',
    ruleMode: '模式',
    ruleModeInherit: '跟随全局模式',
    ruleModeOnly: '仅允许规则提供商 (only)',
    ruleModeOrder: '按顺序优先 (order)',
    ruleModeOff: '不限制（跳过注入）',
    ruleProviders: '规则提供商',
    addRule: '＋ 添加模型规则',
    removeRule: '删除',
    savedWithRules: '已保存：{list}；模型规则 {rules} 条',
  }
  const EN = {
    cardName: 'OpenRouter provider list',
    cardDesc: 'Injects the provider list as provider.only / provider.order and the quantization cap as provider.quantizations into OpenRouter model requests. Settings persist to the plugin\'s own configuration file.',
    summary: 'Restricts OpenRouter requests to a configured provider list and quantization cap.',
    unsaved: 'Unsaved',
    enable: 'Enable provider restriction',
    routes: 'Recognized model routes (optional)',
    routesHint: 'Injection only applies to model routes that point at OpenRouter. The built-in route "openrouter" always matches, and providers whose baseURL points at openrouter.ai (or whose apiKeyEnv is OPENROUTER_API_KEY) are detected automatically; currently recognized: {active}. If yours is not detected, add its route id here, one per line.',
    routesPlaceholder: 'e.g.\nmy-route-id',
    mode: 'Routing mode',
    modeOnly: 'Only these providers (provider.only)',
    modeOrder: 'Try in order (provider.order)',
    modeOnlyHint: 'Requests go out only while a listed provider is available (allow_fallbacks=false); the request fails when none is.',
    modeOrderHint: 'Providers are tried in list order, falling back to the default OpenRouter routing when none is available (allow_fallbacks=true).',
    quant: 'Quantization cap (provider.quantizations)',
    quantOff: 'No restriction',
    quantHint: 'Routes only among providers that support the selected quantization (int4 / int8 / fp8 / fp16, for example).',
    proxy: 'billion-context compression proxy',
    proxyOff: 'Direct to OpenRouter (no proxy)',
    proxyAuto: 'Auto: route through the proxy when one is detected',
    proxyHint: 'When a running billion-context proxy is detected, requests go through its /bili/ entry point and gain context compression; with no proxy detected they go direct, so generation is never broken.',
    proxyActive: 'Proxy in use: {origin}',
    proxyInactive: 'No running proxy detected; requests go direct',
    providers: 'Providers (provider slugs)',
    providersPlaceholder: 'One provider per line, for example:\nDeepInfra\nTogether',
    discard: 'Discard',
    save: 'Save',
    saving: 'Saving…',
    loadFailed: 'Cannot read the current state (Host half unavailable)',
    loadFailedDetail: 'Cannot read the current state: {message}',
    savedList: 'Saved: {list}',
    savedEmpty: 'Saved (empty list: OpenRouter requests carry no provider restriction)',
    saveFailed: 'Save failed',
    saveFailedDetail: 'Save failed: {message}',
    settingsDoc: 'Configuration file: {path}',
    loadError: 'Load error: {message}',
    loaded: 'loaded',
    providersHint: 'Global default list: check providers in the catalog below, or add a custom slug by hand. Empty = no global injection (per-model rules still apply).',
    pickerSelected: '{n} selected',
    pickerClear: 'Clear',
    pickerSearch: 'Search providers (name or slug)…',
    pickerCustomPlaceholder: 'Custom slug',
    pickerAdd: 'Add',
    pickerEmpty: 'Catalog is empty or not loaded — type a slug below to add one.',
    pickerNoMatch: 'No matching provider',
    pickerOffline: 'Offline or not refreshed: showing the built-in provider snapshot — it may be incomplete or out of date.',
    rules: 'Per-model rules (optional; the first match from the top wins)',
    rulesHint: 'Supports * wildcards; without * a rule matches by prefix/namespace (e.g. xiaomi matches xiaomi/mimo-v2.6-flash). A matched model uses the rule\'s mode and providers; "No restriction" skips injection for it.',
    rulePattern: 'Model match',
    rulePatternPlaceholder: 'e.g. xiaomi/mimo* or anthropic/*',
    ruleMode: 'Mode',
    ruleModeInherit: 'Follow global mode',
    ruleModeOnly: 'Only rule providers (only)',
    ruleModeOrder: 'Try in order (order)',
    ruleModeOff: 'No restriction (skip injection)',
    ruleProviders: 'Rule providers',
    addRule: '＋ Add model rule',
    removeRule: 'Remove',
    savedWithRules: 'Saved: {list}; {rules} model rule(s)',
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

  /**
   * 读写 Host 状态。非 2xx 必须抛错：此前直接 `r.json()`，把 404/401/500 的
   * 非 JSON 响应体一律变成「Host 端不可用」，掩盖了真实原因（例如路由未注册
   * 时被 `/api` 前缀接管的 401）。抛出的错误带上状态码与响应片段。
   */
  function api(method, body) {
    return fetch(API_PATH, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => {
      if (!r.ok) {
        return r.text().then(
          (text) => Promise.reject(new Error('HTTP ' + r.status + (text ? ': ' + text.slice(0, 200) : ''))),
          () => Promise.reject(new Error('HTTP ' + r.status)),
        )
      }
      return r.json().catch(() => Promise.reject(new Error('HTTP ' + r.status + ': response is not JSON')))
    })
  }

  // 折叠卡片 chrome —— 镜像 dshmarket Market.module.css setCard..setBody 与
  // Host PluginCard（同 token、同尺寸），旧宿主上与相邻内置卡片外观一致。
  // 新「插件」页的 page 视图只复用其中的字段/页脚样式，不画卡片外框。
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
    '.orpv-form{display:flex;flex-direction:column}',
    '.orpv-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
    '.orpv-field + .orpv-field{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb)}',
    '.orpv-field>span{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
    '.orpv-row{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary)}',
    '.orpv-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
    '.orpv-field select,.orpv-field textarea{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px 10px;font-size:13px;font-family:inherit}',
    '.orpv-field textarea{min-height:110px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical;line-height:1.5}',
    '.orpv-field textarea.orpv-routes{min-height:56px}',

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
    '.orpv-proxy-on{color:var(--dsw-alias-state-success-primary,#16a34a)}',
    '.orpv-proxy-off{color:var(--dsw-alias-label-tertiary,#8b93a1)}',
    '.orpv-picker{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-2,#f7f8fa)}',
    '.orpv-pickerBar{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}',
    '.orpv-linkBtn{appearance:none;background:none;border:0;color:var(--dsw-alias-brand-primary,#4f6ef7);font:inherit;font-size:12px;cursor:pointer;padding:0}',
    '.orpv-linkBtn:disabled{opacity:.4;cursor:default}',
    '.orpv-search,.orpv-customInput{background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;font-size:13px;font-family:inherit;width:100%;box-sizing:border-box}',
    '.orpv-pickerList{max-height:210px;overflow:auto;display:flex;flex-direction:column;gap:2px}',
    '.orpv-pickItem{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer}',
    '.orpv-pickItem:hover{background:var(--dsw-alias-bg-layer-3,#f2f3f6)}',
    '.orpv-pickItem input{flex:none;accent-color:var(--dsw-alias-brand-primary,#4f6ef7)}',
    '.orpv-pickName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.orpv-pickSlug{color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:11px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
    '.orpv-customRow{display:flex;gap:8px;align-items:center}',
    '.orpv-customInput{flex:1;min-width:0}',
    '.orpv-addBtn{appearance:none;border:1px solid var(--dsw-alias-border-l1,#d0d5dd);border-radius:6px;background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary);padding:6px 12px;font:inherit;font-size:13px;cursor:pointer;flex:none}',
    '.orpv-addBtn:disabled{opacity:.4;cursor:default}',
    '.orpv-rule{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:8px;margin-top:8px}',
    '.orpv-ruleHead{display:flex;gap:8px;align-items:center}',
    '.orpv-rulePattern{flex:1;min-width:0}',
    '.orpv-ruleHead input,.orpv-ruleHead select{background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;font-size:13px;font-family:inherit}',
    '.orpv-ruleRemove{appearance:none;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:6px;background:none;color:var(--dsw-alias-label-secondary,#6b7280);padding:4px 9px;cursor:pointer;font-size:13px;flex:none}',
    '.orpv-ruleRemove:hover{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626)}',
    '.orpv-ruleLabel{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280)}',
    '.orpv-ruleAdd{display:flex;margin-top:8px}',
    '.orpv-addRule{appearance:none;border:1px dashed var(--dsw-alias-border-l1,#d0d5dd);border-radius:8px;background:none;color:var(--dsw-alias-label-secondary,#6b7280);padding:6px 12px;font:inherit;font-size:13px;cursor:pointer;width:100%}',
    '.orpv-addRule:disabled{opacity:.4;cursor:default}',
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

  /**
   * 把 Host 返回的 modelRules 归一化为可编辑形状；任何残缺行被丢弃/补全，
   * 保证表单状态恒为 `[{ pattern, mode, providers: string[] }]`。
   */
  function normalizeRules(raw) {
    if (!Array.isArray(raw)) return []
    return raw
      .filter(r => r !== null && typeof r === 'object' && !Array.isArray(r))
      .map(r => ({
        pattern: typeof r.pattern === 'string' ? r.pattern.trim() : '',
        mode: r.mode === 'only' || r.mode === 'order' || r.mode === 'off' ? r.mode : 'inherit',
        providers: Array.isArray(r.providers)
          ? r.providers.filter(p => typeof p === 'string').map(p => p.trim()).filter(p => p.length > 0)
          : [],
      }))
      .filter(r => r.pattern.length > 0)
  }

  /**
   * 表单状态与读写：加载、脏检查、保存、撤销。两个视图共用。
   * @param load - 何时开始首次加载（旧卡片=展开时；新页面=挂载即加载）。
   */
  function useProviderForm(load) {
    const [enabled, setEnabled] = React.useState(true)
    const [mode, setMode] = React.useState('only')
    const [quantization, setQuantization] = React.useState('off')
    const [proxy, setProxy] = React.useState('off')
    const [providers, setProviders] = React.useState([])

    // routesText = 额外识别的路由 id，多行文本（保存时解析为数组）。
    const [routesText, setRoutesText] = React.useState('')
    // activeRoutes = Host 端当前实际识别的路由（内置 + 手动 + 自动识别）。
    const [activeRoutes, setActiveRoutes] = React.useState([])
    const [modelRules, setModelRules] = React.useState([])
    // catalog = Host 端带回的 OpenRouter 官方提供商目录 [{slug, name}]。
    const [catalog, setCatalog] = React.useState([])
    // catalogSource = 'live'（官方 API 实时/缓存）| 'builtin'（内置快照兜底，
    // UI 必须明示，不能把快照冒充实时目录——作者评审要求）。
    const [catalogSource, setCatalogSource] = React.useState('live')
    // saved = 最近一次成功保存/加载的不可变快照，用于计算 dirty。
    const [saved, setSaved] = React.useState(null)
    // status 存的是 key + 插值参数，语言切换后旧消息随新语言重渲染。
    const [status, setStatus] = React.useState(null)
    const [saving, setSaving] = React.useState(false)
    const [docPath, setDocPath] = React.useState('')
    const [loadError, setLoadError] = React.useState('')
    // proxyOrigin = Host 半实际探测到的代理地址，null 表示没探测到。
    const [proxyOrigin, setProxyOrigin] = React.useState(null)
    const probed = React.useRef(false)

    React.useEffect(() => {
      if (!load || probed.current) return
      probed.current = true
      let alive = true
      api('GET').then((value) => {
        if (!alive) return
        const v = value && typeof value === 'object' ? value : {}
        const next = {
          enabled: v.enabled !== false,
          mode: v.mode === 'order' ? 'order' : 'only',
          quantization: typeof v.quantization === 'string' ? v.quantization : 'off',
          proxy: v.proxy === 'auto' ? 'auto' : 'off',
          providers: Array.isArray(v.providers) ? v.providers : [],
          routesText: (Array.isArray(v.routes)
            ? v.routes.filter(r => typeof r === 'string')
            : []).join('\n'),
        }
        const rules = normalizeRules(v.modelRules)
        setEnabled(next.enabled)
        setMode(next.mode)
        setQuantization(next.quantization)
        setProxy(next.proxy)
        setProviders(next.providers)
        setRoutesText(next.routesText)
        setActiveRoutes(Array.isArray(v.activeRoutes)
          ? v.activeRoutes.filter(r => typeof r === 'string')
          : [])
        setModelRules(rules)
        setCatalog(Array.isArray(v.catalog)
          ? v.catalog.filter(c => c && typeof c.slug === 'string' && typeof c.name === 'string')
          : [])
        setCatalogSource(v.catalogSource === 'builtin' ? 'builtin' : 'live')
        setSaved({ ...next, modelRules: rules })
        setProxyOrigin(typeof v.proxyOrigin === 'string' ? v.proxyOrigin : null)
        if (typeof v.stateFile === 'string') {
          setDocPath(v.stateFile)
          setLoadError(typeof v.loadError === 'string' ? v.loadError : '')
        }
      }).catch((error) => {
        if (!alive) return
        const detail = error && error.message ? String(error.message) : ''
        setStatus(detail
          ? { key: 'loadFailedDetail', params: { message: detail }, error: true }
          : { key: 'loadFailed', error: true })
      })
      return () => { alive = false }
    }, [load])

    const sameList = (a, b) =>
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
    const sameRules = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const dirty = saved !== null && (
      enabled !== saved.enabled ||
      mode !== saved.mode ||
      quantization !== saved.quantization ||
      proxy !== saved.proxy ||
      routesText !== saved.routesText ||
      !sameList(providers, saved.providers) ||
      !sameRules(modelRules, saved.modelRules)
    )

    const addRule = () => setModelRules([...modelRules, { pattern: '', mode: 'inherit', providers: [] }])
    const updateRule = (index, patch) =>
      setModelRules(modelRules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
    const removeRule = (index) => setModelRules(modelRules.filter((_, i) => i !== index))

    const save = () => {
      setSaving(true)
      setStatus(null)
      // Pattern-less draft rows are dropped on save: a rule with no pattern
      // cannot match anything, and silently keeping it would corrupt the list.
      const cleanRules = modelRules
        .map(rule => ({ ...rule, pattern: String(rule.pattern).trim() }))
        .filter(rule => rule.pattern.length > 0)
      // Extra routes: one id per line; blank lines and the built-in route
      // id are normalized away Host-side, so echo back the stored value.
      const routeList = routesText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
      api('POST', { enabled, mode, providers, quantization, proxy, modelRules: cleanRules, routes: routeList }).then((value) => {
        const v = value && typeof value === 'object' ? value : {}
        const list = Array.isArray(v.providers) ? v.providers : []
        const rules = Array.isArray(v.modelRules) ? v.modelRules : []
        const storedRoutes = Array.isArray(v.routes) ? v.routes.filter(r => typeof r === 'string') : routeList
        const storedRoutesText = storedRoutes.join('\n')
        if (rules.length > 0) {
          setStatus({
            key: 'savedWithRules',
            params: { list: list.length > 0 ? list.join(', ') : '—', rules: rules.length },
          })
        } else if (list.length > 0) {
          setStatus({ key: 'savedList', params: { list: list.join(', ') } })
        } else {
          setStatus({ key: 'savedEmpty' })
        }
        setModelRules(rules)
        // Echo the Host's normalized providers back into the form state: the
        // saved snapshot and the live state must not drift, or any future
        // Host-side normalization leaves the form dirty the instant it saves.
        setProviders(list)
        setRoutesText(storedRoutesText)
        if (Array.isArray(v.activeRoutes)) {
          setActiveRoutes(v.activeRoutes.filter(r => typeof r === 'string'))
        }
        setSaved({
          enabled, mode, quantization, proxy, providers: list,
          routesText: storedRoutesText, modelRules: rules,
        })
        setProxyOrigin(typeof v.proxyOrigin === 'string' ? v.proxyOrigin : null)
        if (Array.isArray(v.catalog)) setCatalog(v.catalog)
        setCatalogSource(v.catalogSource === 'builtin' ? 'builtin' : 'live')
      }).catch((error) => {
        const detail = error && error.message ? String(error.message) : ''
        setStatus(detail
          ? { key: 'saveFailedDetail', params: { message: detail }, error: true }
          : { key: 'saveFailed', error: true })
      }).finally(() => setSaving(false))
    }

    const discard = () => {
      if (saved === null) return
      setEnabled(saved.enabled)
      setMode(saved.mode)
      setQuantization(saved.quantization)
      setProxy(saved.proxy)
      setProviders(saved.providers.slice())
      setRoutesText(saved.routesText || '')
      setModelRules(saved.modelRules.map(rule => ({ ...rule, providers: rule.providers.slice() })))
      setStatus(null)
    }

    return {
      enabled, setEnabled,
      mode, setMode,
      quantization, setQuantization,
      proxy, setProxy, proxyOrigin,
      providers, setProviders,
      routesText, setRoutesText, activeRoutes,
      catalogSource,
      modelRules, setModelRules, addRule, updateRule, removeRule,
      catalog,
      status, saving, dirty, save, discard, docPath, loadError,
    }
  }

  /**
   * 酒馆式勾选选择器：官方目录列表 + 搜索过滤 + 自定义 slug 手动添加。
   * 选中项永远显示（即使不在目录里），因此离线快照缺某家也不丢选择。
   * @param props - { t, selected: string[], onChange(list), catalog: [{slug,name}], disabled }
   */
  function ProviderPicker(props) {
    const t = props.t
    const selected = props.selected
    const catalog = Array.isArray(props.catalog) ? props.catalog : []
    const [query, setQuery] = React.useState('')
    const [custom, setCustom] = React.useState('')

    const selectedSet = new Set(selected)
    const customSelected = selected.filter((slug) => !catalog.some((c) => c.slug === slug))
    const q = query.trim().toLowerCase()
    const rows = [
      ...customSelected.map((slug) => ({ slug, name: slug })),
      ...catalog
        .filter((c) => !customSelected.includes(c.slug))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    ].filter((row) =>
      q.length === 0 || row.slug.toLowerCase().includes(q) || row.name.toLowerCase().includes(q))

    const toggle = (slug) => {
      if (props.disabled) return
      props.onChange(selectedSet.has(slug)
        ? selected.filter((s) => s !== slug)
        : [...selected, slug])
    }
    const addCustom = () => {
      const slug = custom.trim().replace(/^["']|["']$/g, '')
      if (slug.length === 0 || props.disabled) return
      if (!selectedSet.has(slug)) props.onChange([...selected, slug])
      setCustom('')
    }

    return React.createElement('div', { className: 'orpv-picker' }, [
      React.createElement('div', { key: 'bar', className: 'orpv-pickerBar' }, [
        React.createElement('span', { key: 'n' }, t('pickerSelected', { n: selected.length })),
        React.createElement('button', {
          key: 'c', type: 'button', className: 'orpv-linkBtn',
          disabled: props.disabled || selected.length === 0,
          onClick: () => props.onChange([]),
        }, t('pickerClear')),
      ]),
      React.createElement('input', {
        key: 'q', type: 'text', className: 'orpv-search',
        value: query, placeholder: t('pickerSearch'),
        disabled: props.disabled,
        onChange: (e) => setQuery(e.target.value),
      }),
      React.createElement('div', { key: 'list', className: 'orpv-pickerList' },
        rows.length === 0
          ? React.createElement('p', { className: 'orpv-hint' },
            catalog.length === 0 ? t('pickerEmpty') : t('pickerNoMatch'))
          : rows.map((row) => React.createElement('label', {
            key: row.slug, className: 'orpv-pickItem',
          }, [
            React.createElement('input', {
              key: 'cb', type: 'checkbox',
              checked: selectedSet.has(row.slug),
              disabled: props.disabled,
              onChange: () => toggle(row.slug),
            }),
            React.createElement('span', { key: 'nm', className: 'orpv-pickName' }, row.name),
            React.createElement('code', { key: 'sl', className: 'orpv-pickSlug' }, row.slug),
          ]))),
      React.createElement('div', { key: 'cust', className: 'orpv-customRow' }, [
        React.createElement('input', {
          key: 'ci', type: 'text', className: 'orpv-customInput',
          value: custom, placeholder: t('pickerCustomPlaceholder'),
          disabled: props.disabled,
          onChange: (e) => setCustom(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom() } },
        }),
        React.createElement('button', {
          key: 'cb2', type: 'button', className: 'orpv-addBtn',
          disabled: props.disabled || custom.trim().length === 0,
          onClick: addCustom,
        }, t('pickerAdd')),
      ]),
    ])
  }

  /**
   * 一条按模型规则：模型匹配输入 + 模式选择 + 提供商勾选 + 删除。
   * mode = 'off' 时不渲染提供商选择器（该模型跳过注入，无需选）。
   * @param props - { t, rule: {pattern,mode,providers}, catalog, disabled, onChange(patch), onRemove }
   */
  function RuleEditor(props) {
    const t = props.t
    const rule = props.rule
    return React.createElement('div', { className: 'orpv-rule' }, [
      React.createElement('div', { key: 'h', className: 'orpv-ruleHead' }, [
        React.createElement('input', {
          key: 'p', type: 'text', className: 'orpv-rulePattern',
          value: rule.pattern,
          placeholder: t('rulePatternPlaceholder'),
          disabled: props.disabled,
          onChange: (e) => props.onChange({ pattern: e.target.value }),
        }),
        React.createElement('select', {
          key: 'm', value: rule.mode, disabled: props.disabled,
          onChange: (e) => props.onChange({ mode: e.target.value }),
        }, [
          React.createElement('option', { key: 'i', value: 'inherit' }, t('ruleModeInherit')),
          React.createElement('option', { key: 'o', value: 'only' }, t('ruleModeOnly')),
          React.createElement('option', { key: 'r', value: 'order' }, t('ruleModeOrder')),
          React.createElement('option', { key: 'n', value: 'off' }, t('ruleModeOff')),
        ]),
        React.createElement('button', {
          key: 'd', type: 'button', className: 'orpv-ruleRemove',
          disabled: props.disabled, onClick: props.onRemove,
          title: t('removeRule'), 'aria-label': t('removeRule'),
        }, '✕'),
      ]),
      rule.mode === 'off'
        ? null
        : React.createElement('div', { key: 'pb', className: 'orpv-ruleBody' }, [
          React.createElement('span', { key: 'l', className: 'orpv-ruleLabel' }, t('ruleProviders')),
          React.createElement(ProviderPicker, {
            key: 'k',
            t,
            selected: rule.providers,
            onChange: (list) => props.onChange({ providers: list }),
            catalog: props.catalog,
            disabled: props.disabled,
          }),
        ]),
    ])
  }

  /** 表单字段（两个视图共用，返回数组，由调用方放进自己的容器）。 */
  function providerFields(t, form) {
    const disabled = !form.enabled || form.saving
    return [
      React.createElement('div', { key: 'e', className: 'orpv-row' }, [
        React.createElement('input', {
          key: 'e1', type: 'checkbox', checked: form.enabled,
          onChange: (e) => form.setEnabled(e.target.checked),
        }),
        React.createElement('span', { key: 'e2' }, t('enable')),
      ]),
      React.createElement('div', { key: 'rt', className: 'orpv-field' }, [
        React.createElement('span', { key: 'rt1' }, t('routes')),
        React.createElement('textarea', {
          key: 'rt2',
          className: 'orpv-routes',
          rows: 2,
          value: form.routesText,
          placeholder: t('routesPlaceholder'),
          disabled,
          onChange: (e) => form.setRoutesText(e.target.value),
        }),
        React.createElement('p', { key: 'rt3', className: 'orpv-hint' },
          t('routesHint', {
            active: form.activeRoutes.length > 0 ? form.activeRoutes.join(', ') : '—',
          })),
      ]),
      React.createElement('div', { key: 'm', className: 'orpv-field' }, [
        React.createElement('span', { key: 'm1' }, t('mode')),
        React.createElement('select', {
          key: 'm2', value: form.mode, disabled,
          onChange: (e) => form.setMode(e.target.value),
        }, [
          React.createElement('option', { key: 'o1', value: 'only' }, t('modeOnly')),
          React.createElement('option', { key: 'o2', value: 'order' }, t('modeOrder')),
        ]),
        React.createElement('p', { key: 'm3', className: 'orpv-hint' },
          form.mode === 'only' ? t('modeOnlyHint') : t('modeOrderHint')),
      ]),
      React.createElement('div', { key: 'q', className: 'orpv-field' }, [
        React.createElement('span', { key: 'q1' }, t('quant')),
        React.createElement('select', {
          key: 'q2', value: form.quantization, disabled,
          onChange: (e) => form.setQuantization(e.target.value),
        }, [
          React.createElement('option', { key: 'q0', value: 'off' }, t('quantOff')),
          ...QUANT_LEVELS.map((level) =>
            React.createElement('option', { key: 'q' + level, value: level }, level)),
        ]),
        React.createElement('p', { key: 'q3', className: 'orpv-hint' }, t('quantHint')),
      ]),
      React.createElement('div', { key: 'x', className: 'orpv-field' }, [
        React.createElement('span', { key: 'x1' }, t('proxy')),
        React.createElement('select', {
          key: 'x2', value: form.proxy, disabled: form.saving,
          onChange: (e) => form.setProxy(e.target.value),
        }, [
          React.createElement('option', { key: 'x0', value: 'off' }, t('proxyOff')),
          React.createElement('option', { key: 'xa', value: 'auto' }, t('proxyAuto')),
        ]),
        React.createElement('p', { key: 'x3', className: 'orpv-hint' }, t('proxyHint')),
        form.proxy === 'auto'
          ? React.createElement('p', {
            key: 'x4',
            className: form.proxyOrigin ? 'orpv-hint orpv-proxy-on' : 'orpv-hint orpv-proxy-off',
          }, form.proxyOrigin
            ? t('proxyActive', { origin: form.proxyOrigin })
            : t('proxyInactive'))
          : null,
      ]),
      React.createElement('div', { key: 'p', className: 'orpv-field' }, [
        React.createElement('span', { key: 'p1' }, t('providers')),
        React.createElement('p', { key: 'ph', className: 'orpv-hint' }, t('providersHint')),
        React.createElement(ProviderPicker, {
          key: 'pk',
          t,
          selected: form.providers,
          onChange: form.setProviders,
          catalog: form.catalog,
          disabled,
        }),
        form.catalogSource === 'builtin'
          ? React.createElement('p', { key: 'po', className: 'orpv-hint' }, t('pickerOffline'))
          : null,
      ]),
      React.createElement('div', { key: 'r', className: 'orpv-field' }, [
        React.createElement('span', { key: 'r0' }, t('rules')),
        React.createElement('p', { key: 'rh', className: 'orpv-hint' }, t('rulesHint')),
        ...form.modelRules.map((rule, index) => React.createElement(RuleEditor, {
          key: 'rule' + index,
          t,
          rule,
          index,
          catalog: form.catalog,
          disabled,
          onChange: (patch) => form.updateRule(index, patch),
          onRemove: () => form.removeRule(index),
        })),
        React.createElement('div', { key: 'ra', className: 'orpv-ruleAdd' }, [
          React.createElement('button', {
            key: 'ab', type: 'button', className: 'orpv-addRule', disabled,
            onClick: form.addRule,
          }, t('addRule')),
        ]),
      ]),
    ]
  }

  /** 状态行；存的是 key + 参数，语言切换后旧消息随新语言重渲染。 */
  function statusLine(t, form) {
    if (!form.status) return null
    return React.createElement('span', {
      className: form.status.error === true ? 'orpv-status error' : 'orpv-status',
    }, t(form.status.key, form.status.params))
  }

  /** 设置文档路径 + 加载状态（两个视图共用）。 */
  function DebugLine(props) {
    if (!props.docPath) return null
    return React.createElement('p', { className: 'orpv-debug' },
      props.t('settingsDoc', { path: props.docPath })
      + (props.loadError.length > 0
        ? ' | ' + props.t('loadError', { message: props.loadError })
        : ' | ' + props.t('loaded')))
  }

  /** 旧宿主视图：settings.plugin.item 折叠卡片。 */
  function ProviderCard(props) {
    const t = typeof props.t === 'function' ? props.t : fallbackT
    const [open, setOpen] = React.useState(false)
    // 首次展开时懒加载（与 dshmarket 一致：展开页签渲染所有卡片，避免无谓探测）。
    const form = useProviderForm(open)

    const header = React.createElement('button', {
      key: 'hd', type: 'button', className: 'orpv-header',
      'aria-expanded': open,
      onClick: () => setOpen(!open),
    }, [
      React.createElement('div', { key: 'ht', className: 'orpv-headText' }, [
        React.createElement('div', { key: 'n', className: 'orpv-name' }, t('cardName')),
        React.createElement('div', { key: 'd', className: 'orpv-desc' }, t('cardDesc')),
      ]),
      form.dirty ? React.createElement('span', { key: 'u', className: 'orpv-pending' }, t('unsaved')) : null,
      React.createElement('span', {
        key: 'c',
        className: open ? 'orpv-chevron orpv-chevronOpen' : 'orpv-chevron',
      }, React.createElement(ChevronDown, null)),
    ])

    const body = open
      ? React.createElement('div', { key: 'bd', className: 'orpv-body' }, [
          ...providerFields(t, form),
          React.createElement('div', { key: 'ft', className: 'orpv-footer' }, [
            statusLine(t, form),
            React.createElement('button', {
              key: 'dc', type: 'button', className: 'orpv-discard', onClick: form.discard,
              disabled: !form.dirty || form.saving,
            }, t('discard')),
            React.createElement('button', {
              key: 'sv', type: 'button', className: 'orpv-save', onClick: form.save,
              disabled: !form.dirty || form.saving,
            }, form.saving ? t('saving') : t('save')),
          ]),
          React.createElement(DebugLine, { key: 'x', t, docPath: form.docPath, loadError: form.loadError }),
        ])
      : null

    return React.createElement('div', {
      className: open ? 'orpv-card orpv-cardOpen' : 'orpv-card',
    }, [header, body])
  }

  /**
   * 新宿主视图：plugins.bundle.config（「插件」页上本组合包页面里的配置）。
   * 页面按 view 索取：summary 只回一句话，page 回带保存控件的表单；标题、
   * 图标、面包屑由页面画。只有保存会写入，离开页面丢弃暂存修改。
   */
  function BundleConfigView(props) {
    const t = typeof props.t === 'function' ? props.t : fallbackT
    const form = useProviderForm(true)
    // 页面回到列表即卸载本视图：丢弃暂存修改（与内置配置页一致）。
    const discard = React.useRef(form.discard)
    discard.current = form.discard
    React.useEffect(() => () => { discard.current() }, [])

    if (props.view === 'summary') return t('summary')

    return React.createElement('div', { className: 'orpv-form' }, [
      ...providerFields(t, form),
      React.createElement('div', { key: 'ft', className: 'orpv-footer' }, [
        statusLine(t, form),
        React.createElement('button', {
          key: 'sv', type: 'button', className: 'orpv-save', onClick: form.save,
          disabled: !form.dirty || form.saving,
        }, form.saving ? t('saving') : t('save')),
      ]),
      React.createElement(DebugLine, { key: 'x', t, docPath: form.docPath, loadError: form.loadError }),
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

        // locale 是可选服务（旧宿主/精简组合可能没有），且本插件的 apply 可能
        // 早于 locale 注册，所以在槽声明出现时读取，而不用 ctx.inject(['locale'])
        // 等待——那会让界面在没有 locale 的宿主上永不出现。
        let dictionaries = false
        const metaFor = (name, extra) => {
          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
          if (!dictionaries && locale !== undefined && typeof locale.register === 'function') {
            dictionaries = true
            ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'dsh-openrouter-providers: dictionaries')
          }
          const meta = { name, ...extra }
          if (locale !== undefined) meta.locale = NS
          return meta
        }

        // 新宿主（>= 0.1.6-alpha.2）：组合包页面里的配置。
        slots.inject('plugins.bundle.config', () => slots.register(
          metaFor('plugins.bundle.config', { key: PACKAGE_NAME }),
          (props) => React.createElement(BundleConfigView, props ?? null),
        ))

        // 旧宿主：settings.plugin.item 折叠卡片（0.1.6-alpha.2 已退役该 slot，
        // 此时上面的 inject 触发、这个永不触发；反之亦然）。
        slots.inject('settings.plugin.item', () => slots.register(
          metaFor('settings.plugin.item', { key: NS }),
          (props) => React.createElement(ProviderCard, props ?? null),
        ))
      })
    },
  }
}})
