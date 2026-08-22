/**
 * dsh-openrouter-providers — Host 半入口（持久插件形态，bundle 行挂载）。
 *
 * 职责：
 * - 通过 webServer 注册 HTTP API：GET/POST /api/openrouter-providers/state
 *   （供 Client 半读写提供商列表）；
 * - 把状态持久化到 <workspaceRoot>/.dsh-plugins/openrouter-providers.json，
 *   插件启动时自动加载；
 * - 监听 llm/stream waterfall：当请求的 provider 路由为 `openrouter` 且
 *   提供商列表非空时，把请求重路由到本插件注册的专用 adapter
 *   （`openrouter-providers` 路由），由它构造请求体并注入
 *   provider.only / provider.order 路由参数（以及 reasoning.effort）。
 * - 传输层通过 subprocess 服务派生 `node -e` 子进程完成 HTTP + SSE 流式
 *   解析（动态插件环境没有 fetch 内置）。
 *
 * 这是持久 npm 插件包的主入口（exports["."]），由 cordis.patch.yml 的
 * insert 行挂载进 profile composition，DSH 重启后自动生效。
 */

export const name = 'openrouter-providers'

const OPENROUTER_ROUTE = 'openrouter'
const PLUGIN_ROUTE = 'openrouter-providers'
const API_KEY_REF = 'OPENROUTER_API_KEY'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const IDLE_MS = 120000
const TOTAL_MS = 1200000
const STATE_PATH = '/api/openrouter-providers/state'

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
 * @param ctx - Host context。
 */
export function apply(ctx) {
  ctx.inject(['fs', 'sandboxPolicy', 'llm', 'webServer', 'timer'], async (hostCtx) => {
  // Plugin state, persisted to a JSON file under the workspace root so a
  // restart of the harness keeps the user's provider list.
  const state = { enabled: true, mode: 'only', providers: [] }
  let lastLoadError = undefined
  const fsSvc = hostCtx.get('fs')
  const sandboxPolicySvc = hostCtx.get('sandboxPolicy')
  const stateFile = sandboxPolicySvc === undefined
    ? undefined
    : sandboxPolicySvc.workspaceRoot + '/.dsh-plugins/openrouter-providers.json'

  async function loadState() {
    if (fsSvc === undefined || stateFile === undefined) {
      lastLoadError = 'skipped: fs service or workspace root unavailable'
      return
    }
    try {
      const target = await fsSvc.resolve(stateFile)
      const text = await fsSvc.readText(target)
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object') return
      if (typeof parsed.enabled === 'boolean') state.enabled = parsed.enabled
      if (parsed.mode === 'order' || parsed.mode === 'only') state.mode = parsed.mode
      if (Array.isArray(parsed.providers)) {
        state.providers = parsed.providers
          .filter(p => typeof p === 'string')
          .map(p => p.trim())
          .filter(p => p.length > 0)
      }
    } catch (error) {
      // Absent or unreadable state file: keep defaults.
      lastLoadError = error && error.message ? error.message : String(error)
      console.log('[openrouter-providers] no persisted state (' + lastLoadError + ')')
    }
  }

  async function persistState() {
    if (fsSvc === undefined || stateFile === undefined) return false
    try {
      const target = await fsSvc.resolve(stateFile)
      const policy = sandboxPolicySvc === undefined
        ? undefined
        : { mode: 'workspace-write', workspaceRoot: sandboxPolicySvc.workspaceRoot }
      await fsSvc.writeText(
        target,
        JSON.stringify({ enabled: state.enabled, mode: state.mode, providers: state.providers }, null, 2),
        undefined,
        undefined,
        policy,
      )
      return true
    } catch (error) {
      console.error('[openrouter-providers] persist failed:', error)
      return false
    }
  }

  await loadState()

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
          json(res, 200, {
            enabled: state.enabled,
            mode: state.mode,
            providers: state.providers.slice(),
            stateFile,
            ...(lastLoadError !== undefined ? { loadError: lastLoadError } : {}),
          })
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
          if (input && typeof input === 'object') {
            if (typeof input.enabled === 'boolean') state.enabled = input.enabled
            if (input.mode === 'order' || input.mode === 'only') state.mode = input.mode
            if (Array.isArray(input.providers)) {
              state.providers = input.providers
                .filter(p => typeof p === 'string')
                .map(p => p.trim())
                .filter(p => p.length > 0)
            }
          }
          await persistState()
          json(res, 200, {
            enabled: state.enabled,
            mode: state.mode,
            providers: state.providers.slice(),
            stateFile,
          })
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
    if (state.enabled && state.providers.length > 0) {
      body.provider = state.mode === 'order'
        ? { order: state.providers.slice(), allow_fallbacks: true }
        : { only: state.providers.slice(), allow_fallbacks: false }
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
    if (options.provider === OPENROUTER_ROUTE && state.enabled && state.providers.length > 0) {
      return llm.stream({ ...options, provider: PLUGIN_ROUTE })
    }
    return next()
  })

  console.log('[openrouter-providers] active: requests on route "' + OPENROUTER_ROUTE + '" stream via "' + PLUGIN_ROUTE + '"')
  })
}
