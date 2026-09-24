/**
 * dsh-openrouter-providers — Host 半入口（持久插件形态，bundle 行挂载）。
 *
 * 职责：
 * - 配置由本插件自己拥有，持久化到 `$DSH_HOME/openrouter-providers.json`
 *   （DSH_HOME 未设置时用 `~/.dsh`）。0.1.7 的 settings 服务删除了命名空间
 *   注册（`settings.register` / `SettingsScope`），插件不再有可用的配置存储
 *   API，因此本插件自带一个 JSON 文档，各宿主版本行为一致。
 * - 旧宿主（<= 0.1.6-alpha.2）上额外注册一个空的 pass-through settings
 *   命名空间：那里的「设置 → 插件 → 插件配置」按 Host 已服务的命名空间派发
 *   卡片，没有它就渲染不出卡片。该命名空间不承载取值——读写始终走本插件的
 *   文件与 HTTP 路由。0.1.7 起没有 register，跳过该命名空间即可，不再中断
 *   整个 apply。
 * - 通过 webServer 注册 HTTP API：GET/POST /api/openrouter-providers/state
 *   （供 Client 半读写配置）。
 * - 监听 llm/stream waterfall：当请求的 provider 路由为 `openrouter` 且
 *   开启了提供商列表或量化限制时，把请求重路由到本插件注册的专用 adapter
 *   （`openrouter-providers` 路由），由它构造请求体并注入
 *   provider.only / provider.order 路由参数（以及 provider.quantizations、
 *   reasoning.effort）。
 * - 传输层通过 subprocess 服务派生 `node -e` 子进程完成 HTTP + SSE 流式
 *   解析（动态插件环境没有 fetch 内置）。
 *
 * 这是持久 npm 插件包的主入口（exports["."]），由 cordis.patch.yml 的
 * insert 行挂载进 profile composition，DSH 重启后自动生效。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const name = 'openrouter-providers'

const SETTINGS_NS = 'openrouter-providers'
const OPENROUTER_ROUTE = 'openrouter'
const PLUGIN_ROUTE = 'openrouter-providers'
const API_KEY_REF = 'OPENROUTER_API_KEY'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const IDLE_MS = 120000
const TOTAL_MS = 1200000
const STATE_PATH = '/api/openrouter-providers/state'
const STATE_FILENAME = 'openrouter-providers.json'
// The removed settings document, renamed by the harness once it settled every
// entry. A section that failed to import (this plugin's, since it declares no
// Config) stays in the renamed file — the only copy of a pre-0.1.7 value.
const IMPORTED_SETTINGS_FILENAME = 'settings.yaml.imported'
// Pre-1.0.5 state file, resolved against the session workspace root.
const LEGACY_STATE_RELPATH = '.dsh-plugins/openrouter-providers.json'
// OpenRouter quantization levels (docs: provider.quantizations). 'off' = no
// restriction; the rest are valid values accepted by the OpenRouter router.
const QUANT_LEVELS = ['int4', 'int8', 'fp4', 'mxfp4', 'nvfp4', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown']

/** Shipped values for a document that omits a field. */
const DEFAULT_STATE = { enabled: true, mode: 'only', providers: [], quantization: 'off' }

/** Human-readable form of a thrown value. */
function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

/** Resolve the harness home the way the harness does: `$DSH_HOME`, else `~/.dsh`.
 * A blank override is unset, matching `resolveDshHome`.
 * @returns the absolute harness home directory.
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured.trim().length > 0
    ? resolve(configured.trim())
    : join(homedir(), '.dsh')
}

/**
 * Pick the state fields out of a parsed document, ignoring everything else.
 * Absent or malformed fields stay absent so a caller can merge a partial patch.
 * @param raw - any parsed document.
 * @returns the recognized fields, or undefined when `raw` is not an object.
 */
function pickState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const next = {}
  if (typeof raw.enabled === 'boolean') next.enabled = raw.enabled
  if (raw.mode === 'only' || raw.mode === 'order') next.mode = raw.mode
  if (Array.isArray(raw.providers)) {
    next.providers = raw.providers
      .filter(p => typeof p === 'string')
      .map(p => p.trim())
      .filter(p => p.length > 0)
  }
  if (raw.quantization === 'off' || QUANT_LEVELS.includes(raw.quantization)) next.quantization = raw.quantization
  return next
}

/**
 * Read one stored state document.
 *
 * A leading BOM is stripped before parsing: Windows editors and PowerShell
 * `Set-Content -Encoding utf8` write one, and `JSON.parse` rejects it. Leaving
 * it would make the file unreadable, which the caller would then treat as
 * "no configuration" and overwrite with the legacy values.
 * @param path - absolute document path.
 * @returns the recognized fields, or undefined when the file does not exist.
 * @throws when the file exists but cannot be read or parsed.
 */
async function readStateFile(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
  return pickState(JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text))
}

/**
 * Write the state document, creating its directory.
 * @param path - absolute document path.
 * @param state - complete state to persist.
 */
async function writeStateFile(path, state) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}

/**
 * Recover the configuration a previous plugin version stored elsewhere.
 *
 * Two historical homes are consulted, in the order their generations ended:
 * the pre-1.0.5 workspace file, then the retired settings document (imported
 * as `settings.yaml.imported` once the harness settled every entry; this
 * plugin's section landed there because a section with no Config cannot be
 * imported, which makes that file the only copy of a pre-0.1.7 value). Reads
 * go through `ctx.fs`, so a confined filesystem still governs access.
 * @param hostCtx - host context carrying the filesystem service.
 * @param statePath - destination document; never read as a source.
 * @returns the recovered fields, or undefined when no source holds any.
 */
async function migrateLegacyState(hostCtx, statePath) {
  const fsSvc = hostCtx.get('fs')
  if (fsSvc === undefined) return undefined
  const sandboxPolicySvc = hostCtx.get('sandboxPolicy')
  const home = dshHome()
  const sources = [
    sandboxPolicySvc === undefined ? undefined : join(sandboxPolicySvc.workspaceRoot, LEGACY_STATE_RELPATH),
    join(home, IMPORTED_SETTINGS_FILENAME),
  ].filter(source => source !== undefined && source !== statePath)

  for (const source of sources) {
    try {
      const text = await fsSvc.readText(await fsSvc.resolve(source))
      const parsed = source.endsWith(IMPORTED_SETTINGS_FILENAME)
        ? await sectionOfImportedSettings(text)
        : JSON.parse(text)
      const found = pickState(parsed)
      if (found !== undefined && Object.keys(found).length > 0) return found
    } catch (error) {
      // Absent, unreadable, or not ours: try the next generation.
      console.log('[openrouter-providers] no legacy configuration at ' + source + ' (' + messageOf(error) + ')')
    }
  }
  return undefined
}

/**
 * Read this plugin's section out of the retired settings document.
 *
 * The document is YAML and neither parser is a dependency of this package, so
 * both are tried in turn; a host that carries neither simply skips this
 * migration source, which the caller already treats as "nothing to recover".
 * @param text - raw YAML of `settings.yaml.imported`.
 * @returns the parsed section, or undefined when the file has none.
 * @throws when the document is YAML but neither parser is installed.
 */
async function sectionOfImportedSettings(text) {
  for (const name of ['yaml', 'js-yaml']) {
    let module
    try {
      module = await import(name)
    } catch (_unavailable) {
      continue
    }
    const parse = typeof module.parse === 'function' ? module.parse : module.default?.load
    if (typeof parse !== 'function') continue
    const document = parse(text)
    if (document === null || typeof document !== 'object') return undefined
    return document[SETTINGS_NS]
  }
  throw new Error('no YAML parser available (tried yaml, js-yaml)')
}

// Child helper executed with `node -e`: reads one JSON request from stdin,
// streams the OpenRouter SSE response, prints one JSON line per event.
// The script contains NO backslashes, backticks, or dollar-brace sequences,
// so it embeds verbatim inside the template literal below.
const CHILD_SCRIPT = `(async () => {
  var NL = String.fromCharCode(10)
  var out = function (obj, exitCode) {
    var line = JSON.stringify(obj) + NL
    if (exitCode === undefined) { process.stdout.write(line); return }
    process.stdout.write(line, function () { process.exit(exitCode) })
  }
  var fail = function (code, message, status) {
    var line = { type: 'error', code: code, message: String(message).slice(0, 2000) }
    if (status !== undefined) line.status = status
    out(line, 1)
  }
  var REQ
  try {
    var input = ''
    process.stdin.setEncoding('utf8')
    for await (var chunk of process.stdin) input += chunk
    REQ = JSON.parse(input)
  } catch (error) {
    fail('BAD_REQUEST', 'plugin bridge: cannot read request: ' + (error && error.message ? error.message : error))
    return
  }
  var idleMs = typeof REQ.idleMs === 'number' ? REQ.idleMs : 120000
  var lastActivity = Date.now()
  var watchdog = setInterval(function () {
    if (Date.now() - lastActivity > idleMs) {
      fail('TIMEOUT', 'no data from OpenRouter for ' + idleMs + 'ms')
    }
  }, 5000)
  if (watchdog.unref) watchdog.unref()
  process.on('SIGTERM', function () { process.exit(130) })

  try {
    var res = await fetch(REQ.url, {
      method: 'POST',
      headers: REQ.headers,
      body: JSON.stringify(REQ.body),
    })
    lastActivity = Date.now()
    if (!res.ok) {
      var text = await res.text().catch(function () { return '' })
      var message = text
      try {
        var parsed = JSON.parse(text)
        if (parsed && parsed.error && parsed.error.message) message = parsed.error.message
      } catch (_ignore) { /* keep raw text */ }
      fail('HTTP_' + res.status, message, res.status)
      return
    }
    var reader = res.body.getReader()
    var decoder = new TextDecoder()
    var buf = ''
    while (true) {
      var step = await reader.read()
      if (step.done) break
      lastActivity = Date.now()
      buf += decoder.decode(step.value, { stream: true })
      var nl
      while ((nl = buf.indexOf(NL)) >= 0) {
        var line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1)
        line = line.trim()
        if (line.length === 0) continue
        if (line.slice(0, 5) !== 'data:') continue
        var data = line.slice(5).trim()
        if (data === '[DONE]') { out({ type: 'done', finish: 'stop' }, 0); return }
        var ev
        try { ev = JSON.parse(data) } catch (_skip) { continue }
        if (ev.error) {
          fail('API_ERROR', ev.error.message || JSON.stringify(ev.error))
          return
        }
        var choice = ev.choices && ev.choices[0]
        if (ev.usage) out({ type: 'usage', usage: ev.usage })
        var delta = choice && choice.delta
        if (delta) {
          if (delta.content) out({ type: 'text', text: delta.content })
          var reasoning = delta.reasoning || delta.reasoning_content
          if (reasoning) out({ type: 'reasoning', text: reasoning })
          if (Array.isArray(delta.tool_calls)) {
            for (var i = 0; i < delta.tool_calls.length; i++) {
              var tc = delta.tool_calls[i]
              out({
                type: 'tool',
                index: tc.index === undefined ? 0 : tc.index,
                id: tc.id || '',
                name: tc.function && tc.function.name ? tc.function.name : '',
                args: tc.function && tc.function.arguments ? tc.function.arguments : '',
              })
            }
          }
        }
        if (choice && choice.finish_reason) out({ type: 'done', finish: choice.finish_reason })
      }
    }
    fail('STREAM_CLOSED', 'stream ended without [DONE] or finish_reason')
  } catch (error) {
    fail('TRANSPORT', error && error.message ? error.message : String(error))
  }
})()`

/**
 * HTTP API 与请求注入装配。宿主启动早期各服务（fs / sandboxPolicy / llm /
 * webServer）尚未注册，因此全部装配放进 ctx.inject——cordis 会在依赖服务
 * 可用后再调用回调（async 回调会被等待）。
 *
 * `settings` 不再出现在依赖列表里：0.1.7 删除了命名空间注册，配置改由本
 * 插件自持。旧宿主上那半个命名空间按能力探测单独注册（见下）。
 * @param ctx - Host context。
 */
export function apply(ctx) {
  ctx.inject(['fs', 'sandboxPolicy', 'llm', 'webServer', 'timer'], async (hostCtx) => {
  // ---- configuration: owned by this plugin, not by the settings service ----
  // 0.1.7 removed `settings.register`, so a plugin can no longer own a
  // settings namespace; its `describe()` only lists `.volatile()` Config
  // fields of profile entries, and this plugin ships no Config. The document
  // below is therefore the single source of truth on every host version.
  const statePath = join(dshHome(), STATE_FILENAME)
  let state = { ...DEFAULT_STATE }
  // Whether a document we could not read may be replaced. A file that exists
  // but does not parse is somebody's configuration; treating it as "no
  // configuration" would let the legacy migration below overwrite it.
  let readable = true
  try {
    const stored = await readStateFile(statePath)
    if (stored !== undefined) state = { ...DEFAULT_STATE, ...stored }
  } catch (error) {
    readable = false
    console.log('[openrouter-providers] cannot read ' + statePath + ': ' + messageOf(error))
  }
  const readState = () => ({ ...state, providers: state.providers.slice() })

  /**
   * Merge a patch, persist it, and publish only after the write succeeded.
   * @param patch - recognized fields to merge over the current state.
   * @throws when the document cannot be written; the in-memory state stays put.
   */
  const updateState = async (patch) => {
    const next = { ...state, ...patch }
    await writeStateFile(statePath, next)
    state = next
  }

  // ---- legacy settings namespace (pre-0.1.7 hosts only) ----
  // The old "Settings → Plugins → Plugin configuration" page dispatched a card
  // per settings namespace the Host answered for, so a card needs a registered
  // namespace to render at all. It is an empty pass-through: its whole job is
  // to make the card dispatchable, and the values stay in the file above. A
  // host without `register` has nothing to serve here and is skipped.
  ctx.inject(['settings'], (settingsCtx) => {
    const settingsSvc = settingsCtx.get('settings')
    if (settingsSvc === undefined || typeof settingsSvc.register !== 'function') return
    try {
      const passThrough = value => ({ ...(value ?? {}) })
      passThrough.toJSON = () => ({
        uid: 0,
        refs: { 0: { type: 'object', meta: { default: {} }, dict: {} } },
      })
      // register() returns the disposer; an effect owns its lifetime.
      settingsCtx.effect(
        () => settingsSvc.register(SETTINGS_NS, passThrough, { base: {} }),
        'dsh-openrouter-providers: legacy settings namespace',
      )
    } catch (error) {
      console.log('[openrouter-providers] legacy settings namespace skipped: ' + messageOf(error))
    }
  })

  // ---- one-time migration into the plugin-owned document ----
  // Runs only while the document is readable AND still holds shipped defaults,
  // so neither an existing user document nor an unparseable one (whose real
  // values are unknown) is overwritten by an older source.
  const isPristine = readable
    && state.providers.length === 0
    && state.quantization === DEFAULT_STATE.quantization
    && state.enabled === DEFAULT_STATE.enabled
    && state.mode === DEFAULT_STATE.mode
  if (isPristine) {
    const migrated = await migrateLegacyState(hostCtx, statePath)
    if (migrated !== undefined) {
      try {
        await updateState(migrated)
        console.log('[openrouter-providers] migrated legacy configuration into ' + statePath)
      } catch (error) {
        console.log('[openrouter-providers] legacy configuration not migrated: ' + messageOf(error))
      }
    }
  }

  // ---- HTTP API backing the settings page (replaces the dynamic host.call) ----
  const webServer = hostCtx.get('webServer')
  if (webServer !== undefined) {
    const readBody = (req) => new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
    const json = (res, status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    const dispose = webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          json(res, 200, { ...readState(), stateFile: statePath })
          return
        }
        if (req.method === 'POST') {
          let input = {}
          try {
            const raw = await readBody(req)
            input = JSON.parse(raw)
          } catch (_badJson) {
            // Empty or malformed body behaves as an empty patch.
          }
          const patch = pickState(input) ?? {}
          if (Object.keys(patch).length > 0) {
            try {
              await updateState(patch)
            } catch (error) {
              json(res, 400, { error: messageOf(error) })
              return
            }
          }
          json(res, 200, { ...readState(), stateFile: statePath })
          return
        }
        res.writeHead(405)
        res.end()
      },
    })
    hostCtx.effect(() => dispose, 'dsh-openrouter-providers: state HTTP route')
  }

  // ---- LLM adapter + transport-level reroute ----
  const llm = hostCtx.get('llm')
  if (llm === undefined) {
    console.log('[openrouter-providers] llm service unavailable, plugin inactive')
    return
  }

  function flattenText(blocks) {
    return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
  }

  function serializeMessages(messages) {
    const wire = []
    for (const message of messages) {
      if (message.role === 'system') {
        wire.push({ role: 'system', content: flattenText(message.content) })
        continue
      }
      if (message.role === 'assistant') {
        const text = flattenText(message.content)
        const reasoning = message.content.filter(b => b.type === 'reasoning').map(b => b.text).join('')
        const toolCalls = message.content.filter(b => b.type === 'tool-call').map(b => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: b.arguments },
        }))
        wire.push({
          role: 'assistant',
          content: text,
          ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        })
        continue
      }
      const toolResults = message.content.filter(b => b.type === 'tool-result')
      const text = flattenText(message.content)
      if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text })
      for (const result of toolResults) {
        wire.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: flattenText(result.content) || '(no output)',
        })
      }
    }
    return wire
  }

  function buildBody(options) {
    const cfg = readState()
    const body = {
      model: options.model,
      messages: serializeMessages(options.messages),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.stop !== undefined) body.stop = options.stop
    const tools = (options.tools || []).map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    if (tools.length > 0) body.tools = tools
    // DSH effort ids off/low/medium/high/max are all valid OpenRouter effort values.
    if (options.reasoningEffort !== undefined && options.reasoningEffort !== 'off') {
      body.reasoning = { effort: options.reasoningEffort }
    }
    if (cfg.enabled && (cfg.providers.length > 0 || cfg.quantization !== 'off')) {
      const providerParams = {}
      if (cfg.providers.length > 0) {
        if (cfg.mode === 'order') {
          providerParams.order = cfg.providers.slice()
          providerParams.allow_fallbacks = true
        } else {
          providerParams.only = cfg.providers.slice()
          providerParams.allow_fallbacks = false
        }
      }
      if (cfg.quantization !== 'off') {
        providerParams.quantizations = [cfg.quantization]
      }
      body.provider = providerParams
    }
    return body
  }

  function classifyChildCode(code) {
    if (/^HTTP_40[13]$/.test(code)) return 'AUTH'
    if (/^HTTP_429$/.test(code)) return 'RATE_LIMIT'
    if (/^HTTP_4\d\d$/.test(code) || code === 'API_ERROR' || code === 'BAD_REQUEST') return 'INVALID_REQUEST'
    if (/^HTTP_5\d\d$/.test(code)) return 'SERVER'
    return code
  }

  function failureError(message, code, status) {
    const err = new Error(message)
    err.code = code
    const failure = { message, code }
    if (status !== undefined) {
      err.status = status
      failure.status = status
    }
    err.failure = failure
    return err
  }

  function mapUsage(raw) {
    const usage = {
      inputTokens: typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : 0,
      outputTokens: typeof raw.completion_tokens === 'number' ? raw.completion_tokens : 0,
    }
    const details = raw.prompt_tokens_details
    if (details && typeof details.cached_tokens === 'number' && details.cached_tokens > 0) {
      usage.cacheReadTokens = details.cached_tokens
    }
    return usage
  }

  function mapFinish(raw, channelCount) {
    if (raw === 'tool_calls' || raw === 'function_call') return { kind: 'tool-calls' }
    if (raw === 'length') return { kind: 'max-tokens' }
    if (raw === 'stop' && channelCount === 0) {
      return {
        kind: 'error',
        failure: { message: 'OpenRouter returned a completed response with no content', code: 'EMPTY_RESPONSE' },
      }
    }
    return { kind: 'stop' }
  }

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: 'OpenRouter (Provider List)' }
    },
    providerRetryPolicy() {
      return undefined
    },
    listModels() {
      return Promise.resolve([])
    },
    // dsh-llm >= 0.1.1-rc.2 dispatches through LlmAdapter#prepareCall instead
    // of resolveModel + stream. The base class default lives on the abstract
    // class, so a plain object adapter must provide it explicitly; binding the
    // stream to this adapter's own resolveModel keeps the same generation.
    async prepareCall(provider, model, signal) {
      return {
        model: await this.resolveModel(provider, model, signal),
        stream: options => this.stream(options),
      }
    },
    resolveModel(provider, model, signal) {
      return Promise.resolve().then(async () => {
        // Delegate to the configured openrouter route's metadata so a
        // contextWindow set in Settings > Models (llm-pi-ai profile) is
        // honored; fall back to pi-ai's default when unavailable.
        let contextWindow = 262144
        try {
          const info = await llm.resolveModelInfo(OPENROUTER_ROUTE, model, signal)
          if (info && info.context && typeof info.context.contextWindow === 'number') {
            contextWindow = info.context.contextWindow
          }
        } catch (_metadataUnavailable) {
          // Catalog membership is advisory; keep the fallback.
        }
        return {
          provider,
          id: model,
          name: model,
          context: { contextWindow },
          inputModalities: ['text'],
          reasoning: {
            efforts: ['off', 'low', 'medium', 'high', 'max'].map(id => ({ id, name: id })),
          },
        }
      })
    },
    async * stream(options) {
      for (const message of options.messages) {
        if (message.content.some(block => block.type === 'image')) {
          throw failureError('openrouter-providers: image input is not supported', 'UNSUPPORTED_CONTENT')
        }
      }
      const credentials = hostCtx.get('credentials')
      if (credentials === undefined) {
        throw failureError('openrouter-providers: credentials service is unavailable', 'AUTH')
      }
      const credential = await credentials.resolve(API_KEY_REF)
      if (credential === undefined || typeof credential.value !== 'string' || credential.value.length === 0) {
        throw failureError(
          'openrouter-providers: no credential "' + API_KEY_REF + '" configured; set it in Settings > Models',
          'AUTH',
        )
      }
      const subprocess = hostCtx.get('subprocess')
      if (subprocess === undefined) {
        throw failureError('openrouter-providers: subprocess service is unavailable', 'SERVER')
      }
      const nodePath = await subprocess.resolveExecutable('node', undefined, options.signal)
      const payload = {
        url: OPENROUTER_URL,
        idleMs: IDLE_MS,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + credential.value,
          'user-agent': 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)',
          // App attribution (docs: app-attribution): HTTP-Referer is the app's
          // unique identifier in rankings/analytics (required) and
          // X-OpenRouter-Title is the display name shown in the OpenRouter UI.
          // X-OpenRouter-Categories is an optional comma-separated marketplace
          // category (max 2, only from the documented set).
          'HTTP-Referer': 'https://github.com/deepseek-ai/deepseek-harness',
          'X-OpenRouter-Title': 'DeepSeek Harness OpenRouter',
          'X-OpenRouter-Categories': 'cli-agent',
        },
        body: buildBody(options),
      }
      const handle = subprocess.spawn({
        argv: [nodePath, '-e', CHILD_SCRIPT],
        cwd: '.',
        stdio: {
          stdin: { data: JSON.stringify(payload) },
          stdout: 'pipe',
          stderr: { maxBytes: 20000 },
        },
        graceMs: 15000,
        signal: options.signal,
        env: { OPENROUTER_API_KEY: credential.value },
      })

      const channelByKey = new Map()
      const indexByKey = new Map()
      let nextIndex = 0
      let errorInfo = undefined
      let sawFinish = false
      let finishRaw = undefined
      let usage = undefined

      const channel = (key, blockType) => {
        let entry = channelByKey.get(key)
        if (entry === undefined) {
          const index = nextIndex
          nextIndex += 1
          indexByKey.set(key, index)
          entry = { index, blockType, text: '', toolCallId: '', toolCallName: '', args: '' }
          channelByKey.set(key, entry)
        }
        return entry
      }

      const timeoutDispose = hostCtx.timeout(() => handle.terminate(), TOTAL_MS)
      try {
        let buffer = ''
        for await (const chunk of handle.stdout) {
          buffer += chunk.toString('utf8')
          let nl
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (line.length === 0) continue
            let message
            try { message = JSON.parse(line) } catch (_skip) { continue }
            switch (message.type) {
              case 'text': {
                const entry = channel('text', 'text')
                if (entry.text.length === 0) yield { type: 'block-start', index: entry.index, blockType: 'text' }
                entry.text += message.text
                yield { type: 'text-delta', index: entry.index, text: message.text }
                break
              }
              case 'reasoning': {
                const entry = channel('reasoning', 'reasoning')
                if (entry.text.length === 0) yield { type: 'block-start', index: entry.index, blockType: 'reasoning' }
                entry.text += message.text
                yield { type: 'reasoning-delta', index: entry.index, text: message.text }
                break
              }
              case 'tool': {
                const key = 'tool:' + message.index
                const entry = channel(key, 'tool-call')
                if (entry.toolCallId === '' && entry.toolCallName === '' && entry.args === '') {
                  yield { type: 'block-start', index: entry.index, blockType: 'tool-call' }
                }
                if (message.id) entry.toolCallId = message.id
                if (message.name) entry.toolCallName = message.name
                if (message.args) entry.args += message.args
                yield {
                  type: 'tool-call-delta',
                  index: entry.index,
                  id: entry.toolCallId || 'call-' + entry.index,
                  ...(entry.toolCallName.length > 0 ? { name: entry.toolCallName } : {}),
                  argumentsDelta: message.args,
                }
                break
              }
              case 'usage': usage = message.usage; break
              case 'done':
                if (!sawFinish) { sawFinish = true; finishRaw = message.finish }
                break
              case 'error': errorInfo = message; break
              default: break
            }
          }
        }
        const outcome = await handle.done.catch(() => null)

        if (errorInfo !== undefined) {
          throw failureError('openrouter: ' + errorInfo.message, classifyChildCode(errorInfo.code), errorInfo.status)
        }
        if (!sawFinish) {
          if (options.signal !== undefined && options.signal.aborted) {
            throw failureError('openrouter: request aborted', 'ABORTED')
          }
          const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
          const exitCode = outcome === null ? '?' : String(outcome.exitCode)
          throw failureError(
            'openrouter: stream ended without a terminal event (exit ' + exitCode + ')'
              + (stderr.length > 0 ? ': ' + stderr.slice(0, 400) : ''),
            'TRANSPORT',
          )
        }
        for (const key of indexByKey.keys()) {
          const entry = channelByKey.get(key)
          yield {
            type: 'block-end',
            index: entry.index,
            block: entry.blockType === 'tool-call'
              ? {
                type: 'tool-call',
                id: entry.toolCallId || 'call-' + entry.index,
                name: entry.toolCallName,
                arguments: entry.args,
              }
              : { type: entry.blockType, text: entry.text },
          }
        }
        if (usage !== undefined) yield { type: 'usage', usage: mapUsage(usage) }
        yield { type: 'finish', reason: mapFinish(finishRaw, indexByKey.size) }
      } finally {
        timeoutDispose()
        handle.terminate()
      }
    },
  }

  hostCtx.effect(() => llm.registerAdapter([PLUGIN_ROUTE], adapter))

  // Transport-level reroute: keep the logged header and UI selection on the
  // configured openrouter route, but stream the request through our adapter.
  hostCtx.on('llm/stream', (options, next) => {
    const cfg = readState()
    if (options.provider === OPENROUTER_ROUTE && cfg.enabled && (cfg.providers.length > 0 || cfg.quantization !== 'off')) {
      return llm.stream({ ...options, provider: PLUGIN_ROUTE })
    }
    return next()
  })

  console.log('[openrouter-providers] active: requests on route "' + OPENROUTER_ROUTE + '" stream via "' + PLUGIN_ROUTE + '"')
  })
}
