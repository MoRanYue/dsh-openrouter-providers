/**
 * dsh-openrouter-providers — Host 半入口（持久插件形态，bundle 行挂载）。
 *
 * 职责：
 * - 配置由本插件自己拥有，持久化到 `$DSH_HOME/openrouter-providers.json`
 *   （DSH_HOME 未设置时用 `~/.dsh`）。0.1.7 的 settings 服务删除了命名空间注册（`settings.register` /
 *   `SettingsScope`），插件不再有可用的配置存储 API，因此本插件自带一个 JSON
 *   文档，各宿主版本行为一致。
 * - 旧宿主（<= 0.1.6-alpha.2）上额外注册一个空的 pass-through settings
 *   命名空间：那里的「设置 → 插件 → 插件配置」按 Host 已服务的命名空间派发
 *   卡片，没有它就渲染不出卡片。该命名空间不承载取值——读写始终走本插件的
 *   文件与 HTTP 路由。0.1.7 起没有 register，跳过该命名空间即可，不再中断
 *   整个 apply。
 * - 通过 webServer 注册 HTTP API：GET/POST /api/openrouter-providers/state
 *   （供 Client 半读写配置；GET 同时返回 OpenRouter 官方提供商目录 catalog，
 *   离线时回退到内置快照）。
 * - 监听 llm/stream waterfall：当请求的 provider 路由命中本插件识别的
 *   OpenRouter 路由（内置 `openrouter` ＋ 配置字段 `routes` 手动补充 ＋
 *   自动识别出 baseURL / apiKeyEnv 指向 OpenRouter 的 pi-ai 提供商——
 *   profile 里把提供商 id 改名也不失配）且该请求的**模型**命中了启用中
 *   的提供商限制（全局列表，或按模型规则 modelRules）或量化限制时，
 *   把请求重路由到本插件注册的专用 adapter
 *   （`openrouter-providers` 路由），由它构造请求体并注入
 *   provider.only / provider.order 路由参数（以及 provider.quantizations、
 *   reasoning.effort）。规则解析自上而下取第一条匹配：`*` 通配、不含 `*`
 *   时按前缀/命名空间匹配（`xiaomi` 命中 `xiaomi/mimo-v2.6-flash`）。
 * - 传输层通过 subprocess 服务派生 `node -e` 子进程完成 HTTP + SSE 流式
 *   解析（动态插件环境没有 fetch 内置）。
 *
 * 这是持久 npm 插件包的主入口（exports["."]），由 cordis.patch.yml 的
 * insert 行挂载进 profile composition，DSH 重启后自动生效。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
// The proxy probe uses node:http directly rather than global fetch: when the
// billion-context plugin is mounted it patches the host's globalThis.fetch and
// rewrites every URL to `<origin>/bili/<original>`, which would turn a probe of
// the proxy into a request the proxy forwards to itself.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const name = 'openrouter-providers'

const SETTINGS_NS = 'openrouter-providers'
const OPENROUTER_ROUTE = 'openrouter'
const PLUGIN_ROUTE = 'openrouter-providers'
const API_KEY_REF = 'OPENROUTER_API_KEY'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
// billion-context's client-agnostic entry point: the full upstream URL is
// embedded in the path, and the proxy strips everything up to `/bili/`.
const PROXY_PATH_PREFIX = '/bili/'
const PROXY_HEALTH_PATH = '/__bili/health'
// Where billion-context keeps its running-instance record, relative to the XDG
// state directory. The file is either a bare origin URL or the instance JSON.
const PROXY_STATE_DIRNAME = 'billion-context'
const PROXY_ORIGIN_FILENAME = 'proxy-origin'
const PROXY_PROBE_TTL_MS = 30000
const PROXY_PROBE_TIMEOUT_MS = 500
const IDLE_MS = 120000
const TOTAL_MS = 1200000
// pi-ai's DEFAULT_MAX_REQUEST_IMAGE_BYTES (llm-pi-ai config): the total base64
// image payload a request may carry before the image-offload contract kicks in.
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
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
const DEFAULT_STATE = {
  enabled: true,
  mode: 'only',
  providers: [],
  // Per-model rules, top-down first match: { pattern, mode, providers }.
  // mode: 'inherit' (global mode) | 'only' | 'order' | 'off' (no injection).
  modelRules: [],
  // Extra llm route ids to treat as OpenRouter, on top of the built-in
  // `openrouter` and the routes auto-detected from provider baseURLs. Only
  // needed when a profile's OpenRouter provider can neither be detected nor
  // renamed to something detectable.
  routes: [],
  quantization: 'off',
  proxy: 'off',
}

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

/** Normalize a configured origin: trimmed, without a trailing slash. */
function trimOrigin(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length === 0 ? undefined : text.replace(/\/+$/, '')
}

/** The proxy's XDG state directory, resolved the way the proxy resolves it. */
function proxyStateDir() {
  const configured = process.env.XDG_STATE_HOME
  const base = typeof configured === 'string' && configured.trim().length > 0
    ? resolve(configured.trim())
    : join(homedir(), '.local', 'state')
  return join(base, PROXY_STATE_DIRNAME)
}

/**
 * Read an origin out of the proxy's `proxy-origin` record.
 *
 * The file is written two ways depending on the proxy's vintage: a bare origin
 * URL, or the running instance's JSON record. Both must be accepted, and a
 * record that carries no usable origin is not a match.
 * @param path - absolute path of the record.
 * @returns the origin, or undefined when the file is absent or unusable.
 */
async function readOriginRecord(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (_absent) {
    return undefined
  }
  const raw = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      const origin = trimOrigin(parsed && parsed.origin)
      return origin !== undefined && /^https?:\/\/\S+$/.test(origin) ? origin : undefined
    } catch (_malformed) {
      return undefined
    }
  }
  return /^https?:\/\/\S+$/.test(trimmed) ? trimOrigin(trimmed) : undefined
}

/**
 * Read the `dsh` lane's port out of the proxy's zone allocation.
 *
 * This is a second, independently written copy of the origin: the port is
 * lane-dependent (not the 8787 the proxy documents), so it can never be
 * hard-coded, and a stale instance record is recovered from here.
 * @param path - absolute path of `port-zone.json`.
 * @returns the origin, or undefined when the file names no `dsh` lane.
 */
async function readZoneOrigin(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (_absent) {
    return undefined
  }
  try {
    const raw = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
    const port = JSON.parse(raw)?.lanes?.dsh
    return typeof port === 'number' && port > 0 ? 'http://127.0.0.1:' + port : undefined
  } catch (_malformed) {
    return undefined
  }
}

/**
 * Ask a candidate origin whether it is a live billion-context proxy.
 *
 * `node:http` is used rather than `globalThis.fetch` on purpose: the proxy's
 * own DSH plugin patches the host's global fetch and rewrites every URL to
 * `<origin>/bili/<original>`, so a fetch-based probe would be forwarded by the
 * proxy back to itself and could never fail.
 * @param origin - candidate origin, e.g. `http://127.0.0.1:18790`.
 * @returns whether the health endpoint answered as the proxy.
 */
function probeProxy(origin) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(PROXY_HEALTH_PATH, origin)
    } catch (_invalid) {
      resolve(false)
      return
    }
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const request = send(url, { method: 'GET', timeout: PROXY_PROBE_TIMEOUT_MS }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try {
          finish(response.statusCode === 200 && JSON.parse(body).ok === true)
        } catch (_notJson) {
          finish(false)
        }
      })
      response.on('error', () => finish(false))
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => finish(false))
    request.end()
  })
}

/**
 * Find the live billion-context proxy, if one is running.
 *
 * Candidates are tried in the order the proxy's own clients use: an explicit
 * `BILI_MCP_PROXY` override, the running instance's record, the `dsh` lane's
 * allocated port, then the documented default. Each is health-checked, so a
 * stale record naming a dead port is skipped rather than trusted.
 * @returns the origin of a live proxy, or undefined when none answers.
 */
async function discoverProxyOrigin() {
  const dir = proxyStateDir()
  const configured = trimOrigin(process.env.BILI_MCP_PROXY)
  const candidates = [
    configured,
    await readOriginRecord(join(dir, PROXY_ORIGIN_FILENAME)),
    await readZoneOrigin(join(dir, 'port-zone.json')),
    'http://127.0.0.1:8787',
  ]
  const tried = new Set()
  for (const candidate of candidates) {
    if (candidate === undefined || tried.has(candidate)) continue
    tried.add(candidate)
    if (await probeProxy(candidate)) return candidate
  }
  return undefined
}

// The probe costs a socket and up to PROXY_PROBE_TIMEOUT_MS per candidate, and
// every model request would otherwise pay it. The cache is refreshed in the
// background instead: a request always reads whatever the last probe found, so
// routing through the proxy costs no added latency. A stopped proxy is
// remembered too, so it is not re-probed once per request either.
let proxyLookup = { at: 0, origin: undefined, pending: undefined }

/**
 * Re-run discovery and update the cache.
 *
 * Concurrent callers share one probe, so a burst of requests on a cold cache
 * opens one set of sockets rather than one per request.
 * @returns the origin of a live proxy, or undefined when none answers.
 */
function refreshProxyOrigin() {
  if (proxyLookup.pending !== undefined) return proxyLookup.pending
  const pending = discoverProxyOrigin().then((origin) => {
    proxyLookup = { at: Date.now(), origin, pending: undefined }
    return origin
  }, () => {
    proxyLookup = { at: Date.now(), origin: undefined, pending: undefined }
    return undefined
  })
  proxyLookup = { ...proxyLookup, pending }
  return pending
}

/**
 * The live proxy origin, as last probed.
 *
 * Never blocks: a stale cache returns its current value immediately and
 * refreshes in the background, so the request that finds the cache cold goes
 * direct and the next one is routed through the proxy.
 * @returns the origin of a live proxy, or undefined when none is known.
 */
function cachedProxyOrigin() {
  if (Date.now() - proxyLookup.at >= PROXY_PROBE_TTL_MS) void refreshProxyOrigin()
  return proxyLookup.origin
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
  if (raw.proxy === 'off' || raw.proxy === 'auto') next.proxy = raw.proxy
  if (Array.isArray(raw.routes)) {
    // The built-in route is never stored: keeping it out of the document
    // makes `routes` read as what it is — extra, manually recognized ids.
    next.routes = [...new Set(raw.routes
      .filter(r => typeof r === 'string')
      .map(r => r.trim())
      .filter(r => r.length > 0 && r !== OPENROUTER_ROUTE))]
  }
  if (Array.isArray(raw.modelRules)) {
    next.modelRules = raw.modelRules
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
  return next
}

/**
 * Match a model id against one rule pattern.
 *
 * A pattern containing `*` compiles to an anchored, case-insensitive glob;
 * without `*` it matches the model itself or its namespace prefix, so
 * `xiaomi` already covers `xiaomi/mimo-v2.6-flash` (SillyTavern users expect
 * this "pick the vendor family" behavior).
 * @param model - requested model id, e.g. `xiaomi/mimo-v2.6-flash`.
 * @param pattern - configured pattern, e.g. `xiaomi/mimo*`.
 * @returns whether the pattern selects the model.
 */
function matchesPattern(model, pattern) {
  if (typeof pattern !== 'string') return false
  const p = pattern.trim().toLowerCase()
  if (p.length === 0) return false
  const m = String(model === undefined || model === null ? '' : model).toLowerCase()
  if (!p.includes('*')) return m === p || m.startsWith(p + '/')
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  try {
    return new RegExp('^(?:' + escaped + ')$').test(m)
  } catch (_invalid) {
    return false
  }
}

/**
 * Resolve the effective provider restriction for one request.
 *
 * Rules are consulted top-down and the first match wins; an unmatched model
 * falls back to the global list. A matched rule with no providers of its own
 * inherits the global list, and mode 'off' lifts the restriction entirely for
 * that model (so one expensive model can be pinned while everything else runs
 * unrestricted, or vice versa).
 * @param cfg - full plugin state.
 * @param model - requested model id.
 * @returns `{ mode, providers }` for this request; empty providers = no injection.
 */
function resolveConfig(cfg, model) {
  if (cfg.enabled !== true) return { mode: cfg.mode, providers: [] }
  const rules = Array.isArray(cfg.modelRules) ? cfg.modelRules : []
  const rule = rules.find(r => r !== undefined && matchesPattern(model, r.pattern))
  if (rule === undefined) return { mode: cfg.mode, providers: cfg.providers }
  if (rule.mode === 'off') return { mode: cfg.mode, providers: [] }
  const mode = rule.mode === 'only' || rule.mode === 'order' ? rule.mode : cfg.mode
  const providers = Array.isArray(rule.providers) && rule.providers.length > 0
    ? rule.providers
    : cfg.providers
  return { mode, providers }
}

// Snapshot of https://openrouter.ai/api/v1/providers, used when the live
// directory cannot be fetched (offline / rate limited). The slugs are what
// provider.only / provider.order expect; names feed the picker UI only.
const BUILTIN_PROVIDER_CATALOG = [
  'makora|Makora', 'xiaomi|Xiaomi', 'gmicloud|GMICloud', 'deepinfra|DeepInfra', 'venice|Venice',
  'novita|NovitaAI', 'io-net|Io Net', 'darkbloom|Darkbloom', 'together|Together', 'fireworks|Fireworks',
  'anthropic|Anthropic', 'openai|OpenAI', 'deepseek|DeepSeek', 'google-ai-studio|Google AI Studio',
  'google-vertex|Google', 'mistral|Mistral', 'groq|Groq', 'cerebras|Cerebras', 'xai|xAI',
  'alibaba|Alibaba', 'moonshotai|Moonshot AI', 'z-ai|Z.AI', 'minimax|Minimax', 'liquid|Liquid',
  'nebius|Nebius', 'parasail|Parasail', 'sambanova|SambaNova', 'siliconflow|SiliconFlow',
  'chutes|Chutes', 'baseten|BaseTen', 'crusoe|Crusoe', 'coreweave|CoreWeave', 'azure|Azure',
  'amazon-bedrock|Amazon Bedrock', 'amazon-nova|Amazon Nova', 'cloudflare|Cloudflare',
  'perplexity|Perplexity', 'cohere|Cohere', 'ai21|AI21', 'reka|Reka', 'inflection|Inflection',
  'upstage|Upstage', 'friendli|Friendli', 'deepgram|Deepgram', 'elevenlabs|ElevenLabs',
  'assemblyai|AssemblyAI', 'voyageai|VoyageAI by MongoDB', 'featherless|Featherless',
  'nvidia|Nvidia', 'databricks|Databricks', 'mancer|Mancer', 'inference-net|InferenceNet',
  'sakana-ai|Sakana AI', 'thinkingmachines|Thinking Machines', 'seed|Seed', 'baidu|Baidu',
  'tencent|Tencent', 'nex-agi|Nex AGI', 'aion-labs|AionLabs', 'atlas-cloud|AtlasCloud',
  'phala|Phala', 'modal|Modal', 'decart|Decart', 'crucible|Crucible', 'sail-research|Sail Research',
  'switchpoint|Switchpoint', 'stealth|Stealth', 'krea|Krea', 'mara|Mara', 'cosine|Cosine',
  'sourceful|Sourceful', 'poolside|Poolside', 'perceptron|Perceptron', 'modelrun|ModelRun',
  'modular|Modular', 'cirrascale|Cirrascale', 'ambient|Ambient', 'inceptron|Inceptron',
  'streamlake|StreamLake', 'avian|Avian', 'typesafe|TypeSafe', 'near-ai|Near AI', 'quiver|Quiver',
  'clarifai|Clarifai', 'unbiased|Unbiased', 'inferact-vllm|Inferact vLLM', 'heygen|HeyGen',
  'tenstorrent|Tenstorrent', 'fish-audio|Fish Audio', 'akashml|AkashML', 'scaledown|ScaleDown',
  'open-inference|OpenInference', 'respan|Respan', 'wafer|Wafer', 'primeintellect|PrimeIntellect',
  'relace|Relace', 'infermatic|Infermatic', 'arcee-ai|Arcee AI', 'black-forest-labs|Black Forest Labs',
  'claude-on-aws|Claude Platform on AWS', 'stepfun|StepFun', 'ollama|Ollama', 'runway|Runway',
  'dekallm|DekaLLM', 'ionstream|Ionstream', 'meta|Meta', 'digitalocean|DigitalOcean',
  'inception|Inception', 'recraft|Recraft', 'nextbit|NextBit', 'morph|Morph',
].map((entry) => {
  const at = entry.indexOf('|')
  return { slug: entry.slice(0, at), name: entry.slice(at + 1) }
})
const CATALOG_TTL_MS = 86400000
// A failed directory fetch retries after this long instead of waiting out the
// full TTL: without it, one transient error at boot would lock the built-in
// snapshot in for 24h and never refresh (review point on the offline fallback).
const CATALOG_RETRY_MS = 60000
// One fetch gives up after this long. The settings page races the refresh
// against a shorter 1.5s budget, so an offline host answers from the built-in
// snapshot instead of stalling the form.
const CATALOG_TIMEOUT_MS = 5000
// `live` records provenance: true once any real fetch of the official
// directory has succeeded, false while only the built-in snapshot is known.
// The config page reads it (catalogSource) to label the fallback honestly.
let catalogLookup = { at: 0, list: BUILTIN_PROVIDER_CATALOG, live: false, pending: undefined }

/**
 * Fetch the live OpenRouter provider directory once.
 * @returns `[{slug, name}]`, or undefined when unreachable/malformed.
 */
function fetchProviderCatalog() {
  return new Promise((resolve) => {
    let req
    try {
      req = httpsRequest(new URL('https://openrouter.ai/api/v1/providers'), { method: 'GET', timeout: CATALOG_TIMEOUT_MS })
    } catch (_invalid) {
      resolve(undefined)
      return
    }
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let body = ''
    req.on('response', (response) => {
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          const rows = Array.isArray(parsed) ? parsed : (parsed && parsed.data)
          const list = Array.isArray(rows)
            ? rows
              .filter(p => p && typeof p.slug === 'string' && typeof p.name === 'string')
              .map(p => ({ slug: p.slug, name: p.name }))
            : []
          finish(list.length > 0 ? list : undefined)
        } catch (_badJson) {
          finish(undefined)
        }
      })
      response.on('error', () => finish(undefined))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => finish(undefined))
    req.end()
  })
}

/** Re-fetch the directory; concurrent callers share one in-flight request. */
function refreshCatalog() {
  if (catalogLookup.pending !== undefined) return catalogLookup.pending
  const pending = fetchProviderCatalog().then((list) => {
    if (list === undefined) {
      // fetchProviderCatalog resolves undefined on failure instead of
      // rejecting. Stamping `at` with the full TTL here would lock the
      // built-in snapshot in for 24h after one transient error, with no
      // retry; failures get a short backoff instead (review point).
      catalogLookup = {
        ...catalogLookup,
        at: Date.now() - CATALOG_TTL_MS + CATALOG_RETRY_MS,
        pending: undefined,
      }
      return catalogLookup.list
    }
    catalogLookup = { at: Date.now(), list, live: true, pending: undefined }
    return catalogLookup.list
  }, () => {
    catalogLookup = { ...catalogLookup, at: Date.now() - CATALOG_TTL_MS + CATALOG_RETRY_MS, pending: undefined }
    return catalogLookup.list
  })
  catalogLookup = { ...catalogLookup, pending }
  return pending
}

/**
 * The provider directory for the picker UI.
 *
 * A cold or stale cache triggers a live refresh, but the caller waits at most
 * 1.5s for it: an offline host still answers immediately with the built-in
 * snapshot instead of stalling the settings page.
 * @returns `[{slug, name}]`, never undefined.
 */
async function currentCatalog() {
  if (Date.now() - catalogLookup.at >= CATALOG_TTL_MS) {
    const fresh = await Promise.race([
      refreshCatalog(),
      new Promise((r) => { const timer = setTimeout(() => r(undefined), 1500); if (timer.unref) timer.unref() }),
    ])
    if (Array.isArray(fresh) && fresh.length > 0) return fresh
  }
  return catalogLookup.list
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
        if (parsed && parsed.error && parsed.error.message) {
          message = parsed.error.message
          var meta = parsed.error.metadata
          if (meta && typeof meta.raw === 'string' && meta.raw.length > 0) {
            message = message + ' | ' + meta.raw
            if (typeof meta.provider_name === 'string' && meta.provider_name.length > 0) {
              message = message + ' (upstream: ' + meta.provider_name + ')'
            }
          }
        }
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
          var errText = ev.error.message || JSON.stringify(ev.error)
          if (ev.error.metadata && typeof ev.error.metadata.raw === 'string' && ev.error.metadata.raw.length > 0) {
            errText = errText + ' | ' + ev.error.metadata.raw
          }
          fail('API_ERROR', errText)
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

  // ---- which llm routes count as OpenRouter ------------------------------
  // The injection condition must NOT depend on the provider literally being
  // named `openrouter`: profiles rename providers freely (this one is
  // `aaaa`), and a rule that silently matches nothing is indistinguishable
  // from a broken provider list — OpenRouter's default price-based routing
  // then answers every request and the rules look "half working".
  //
  // Effective set = built-in `openrouter`
  //                + state.routes (manual entries from the config page)
  //                + pi-ai providers whose configured baseURL / apiKeyEnv
  //                  point at OpenRouter (scanned from the composed plugin
  //                  configs, cached 30s so a rename lands without restart).
  const ROUTE_TTL_MS = 30000
  let routeLookup = { at: 0, pending: undefined, list: [] }

  /** Scan composed plugin configs for pi-ai providers aimed at OpenRouter.
   * Returns `undefined` when the scan cannot run right now (service not up
   * yet, or a transient config read error), so the caller keeps the last
   * known set and simply retries on the next tick instead of dropping the
   * routes that were already working. */
  const detectRoutes = () => {
    const editor = hostCtx.get('configEditor')
    if (editor === undefined || typeof editor.configuration !== 'function') return undefined
    try {
      const found = new Set()
      for (const row of editor.configuration() ?? []) {
        // Shallow merge on purpose, matching cordis semantics: an override
        // that sets `providers` replaces the whole dictionary, so the spread
        // takes it wholesale from override. Do not "fix" this into a deep
        // merge - that would splice an overridden provider into the
        // inherited dictionary the user never configured.
        const config = { ...(row && row.inherited), ...(row && row.override) }
        const providers = config.providers
        if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) continue
        for (const key of Object.keys(providers)) {
          const value = providers[key]
          if (value === null || typeof value !== 'object') continue
          const baseURL = typeof value.baseURL === 'string' ? value.baseURL : ''
          const apiKeyEnv = typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv : ''
          // Anchor on the HOST, not a substring: /openrouter\.ai/ anywhere in the
          // URL would also match a path segment on an unrelated origin.
          let host = ''
          try { host = new URL(baseURL).hostname.toLowerCase() } catch { host = '' }
          const pointsAtOpenRouter = host === 'openrouter.ai' || host.endsWith('.openrouter.ai')
          if (pointsAtOpenRouter || apiKeyEnv === 'OPENROUTER_API_KEY') found.add(key)
        }
      }
      return [...found]
    } catch (error) {
      console.log('[openrouter-providers] route detection unavailable: ' + messageOf(error))
      return undefined
    }
  }

  /** Re-scan; concurrent callers share one scan, and a scan that could not
   * run keeps the last known set (`at` stays put, so the next caller retries
   * immediately rather than waiting a full TTL). */
  const refreshRoutes = () => {
    if (routeLookup.pending !== undefined) return routeLookup.pending
    const previous = routeLookup.list.join(',')
    const pending = Promise.resolve().then(detectRoutes).then((list) => {
      if (!Array.isArray(list)) {
        routeLookup = { at: routeLookup.at, pending: undefined, list: routeLookup.list }
        return routeLookup.list
      }
      routeLookup = { at: Date.now(), pending: undefined, list }
      if (list.join(',') !== previous) {
        console.log('[openrouter-providers] recognized OpenRouter routes: '
          + [OPENROUTER_ROUTE, ...list].join(', '))
      }
      return list
    }, () => {
      routeLookup = { at: Date.now(), pending: undefined, list: routeLookup.list }
      return routeLookup.list
    })
    routeLookup = { ...routeLookup, pending }
    return pending
  }

  /** Recognized route ids for this config, built-in first, deduplicated. */
  const routeCandidates = (cfg) => {
    if (Date.now() - routeLookup.at >= ROUTE_TTL_MS) void refreshRoutes()
    return [...new Set([
      OPENROUTER_ROUTE,
      ...(Array.isArray(cfg.routes) ? cfg.routes : []),
      ...routeLookup.list,
    ])]
  }

  /** Whether one request's provider route counts as OpenRouter here. */
  const isRecognizedRoute = (cfg, provider) =>
    typeof provider === 'string' && routeCandidates(cfg).includes(provider.trim())

  // Warm the scan so the very first request of a session does not miss a
  // renamed provider while the asynchronous scan is still in flight.
  void refreshRoutes()

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
    && state.modelRules.length === 0
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
    // The page shows whether 'auto' is actually finding a proxy, which is the
    // only way a user can tell a working setup from one that silently fell back
    // to a direct request. It probes rather than reading the cache, so a reload
    // always reports the proxy's state now.
    const describe = async () => {
      const current = readState()
      return {
        ...current,
        stateFile: statePath,
        // Provider directory for the checkbox picker (live, snapshot fallback).
        catalog: await currentCatalog(),
        // 'live' = the returned list came from the official API at some point;
        // 'builtin' = only the shipped snapshot is available, so the UI must
        // label it as a fallback instead of presenting it as live.
        catalogSource: catalogLookup.live ? 'live' : 'builtin',
        // Diagnostics: the route ids this request path currently recognizes
        // (built-in + manual + auto-detected). Echoed to the config page so a
        // silent route mismatch is visible instead of guessed at.
        activeRoutes: routeCandidates(current),
        proxyOrigin: current.proxy === 'auto' ? await refreshProxyOrigin() ?? null : null,
      }
    }
    const dispose = webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          json(res, 200, await describe())
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
          json(res, 200, await describe())
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

  // ---- image blocks → OpenRouter `image_url` parts ----
  // DSH image blocks carry only a durable ref (id/mediaType/dims), never the
  // bytes, so the payload comes from the attachments service's host path.
  // flattenText() alone silently dropped every image the runtime let through.
  // An `offloaded` occurrence has already left the context window: degrade it
  // to text instead of resending bytes that are no longer part of history.
  async function imagePart(block) {
    const ref = block.attachment
    if (block.offloaded === true) {
      return { type: 'text', text: `[image previously offloaded from context (${ref.width}x${ref.height}px)]` }
    }
    const store = hostCtx.get('attachments')
    if (store === undefined || typeof store.imageHostPath !== 'function') {
      return { type: 'text', text: '[image unavailable: attachments service is not mounted]' }
    }
    try {
      const hostPath = store.imageHostPath(ref)
      if (typeof hostPath !== 'string' || hostPath.length === 0) {
        return { type: 'text', text: '[image unavailable: attachment has no host path]' }
      }
      const bytes = await readFile(hostPath)
      return { type: 'image_url', image_url: { url: `data:${ref.mediaType};base64,${bytes.toString('base64')}` } }
    } catch (error) {
      const reason = String((error && error.message) || error)
      return { type: 'text', text: `[image unavailable: ${reason}]` }
    }
  }

  async function serializeMessages(messages) {
    const wire = []
    // Represented image payload, in occurrence order: the data URL lengths
    // that actually travel. offloaded:true blocks degrade to text inside
    // imagePart() and never reach this accounting.
    const imageSizes = []
    let imageTotal = 0
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
      const imageBlocks = message.content.filter(b => b.type === 'image')
      if (imageBlocks.length > 0) {
        // Mixed text/image content must go out as a part array; a plain
        // string content would discard the image on the wire.
        const parts = []
        if (text.length > 0) parts.push({ type: 'text', text })
        for (const block of imageBlocks) {
          const part = await imagePart(block)
          parts.push(part)
          if (part.type === 'image_url') {
            const size = part.image_url.url.length
            imageSizes.push(size)
            imageTotal += size
          }
        }
        wire.push({ role: 'user', content: parts })
      } else if (text.length > 0 || toolResults.length === 0) {
        wire.push({ role: 'user', content: text })
      }
      for (const result of toolResults) {
        wire.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: flattenText(result.content) || '(no output)',
        })
      }
    }
    // Raise the image budget failure HERE instead of pushing the overflow
    // upstream: pi-ai bounds every request, and the compaction-image-offload
    // plugin catches IMAGE_OFFLOAD_REQUIRED on agent/request-error, offloads
    // the oldest occurrences to text placeholders and retries, so the user
    // never sees the failure. Registering our own adapter skips pi-ai's
    // toPiContext entirely, so the same contract is raised at the same
    // assembly point. (Review point on PR #3.)
    if (imageTotal > MAX_REQUEST_IMAGE_BYTES) {
      let remaining = imageTotal
      let offloadImages = 0
      while (remaining > MAX_REQUEST_IMAGE_BYTES && offloadImages < imageSizes.length) {
        remaining -= imageSizes[offloadImages]
        offloadImages += 1
      }
      const err = failureError(
        'openrouter-providers: request carries ' + imageTotal + ' bytes of base64 image payload, over the '
          + MAX_REQUEST_IMAGE_BYTES + '-byte bound; the ' + offloadImages + ' oldest image occurrence(s) must offload first',
        'IMAGE_OFFLOAD_REQUIRED',
      )
      // The offloader's contract reads code + offloadImages off the failure;
      // mirror both here and on the error for whichever normalization layer runs.
      err.offloadImages = offloadImages
      err.failure.offloadImages = offloadImages
      throw err
    }
    return wire
  }

  async function buildBody(options) {
    const cfg = readState()
    const body = {
      model: options.model,
      messages: await serializeMessages(options.messages),
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
    // Per-model resolution: a matching modelRules entry overrides the global
    // list/mode for THIS request's model; an unmatched model keeps the global
    // defaults. Empty resolved providers = no provider injection at all.
    const eff = resolveConfig(cfg, options.model)
    if (cfg.enabled && (eff.providers.length > 0 || cfg.quantization !== 'off')) {
      const providerParams = {}
      if (eff.providers.length > 0) {
        if (eff.mode === 'order') {
          providerParams.order = eff.providers.slice()
          providerParams.allow_fallbacks = true
        } else {
          providerParams.only = eff.providers.slice()
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
    // The token meter resolves this once per measurement, with no feature
    // check, and the spill policy calls it for image-bearing requests. Real
    // adapters inherit the base-class default that returns undefined; a plain
    // object supplies it itself, like providerInfo above. This route has no
    // provider-side image pricing of its own, so consumers keep their neutral
    // estimate. Omitting it makes LlmRuntime.imageRequestPricing throw
    // "adapter.imageRequestPricing is not a function" instead of returning
    // undefined.
    imageRequestPricing() {
      return undefined
    },
    // Screenshot consumers resolve the exact request dimensions and byte target
    // through this member, and LlmRuntime looks it up with no feature check.
    // The base-class default preserves the normalized image, so the same
    // pass-through answer keeps a hypothetical caller consistent with that
    // default; omitting it makes LlmRuntime.imageRequestTarget throw
    // "adapter.imageRequestTarget is not a function" instead.
    // (carried from upstream v1.5.3)
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
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
        // Delegate to the configured route's metadata so a contextWindow set
        // in Settings > Models (llm-pi-ai profile) is honored. The real route
        // is not necessarily named `openrouter` (profiles rename providers),
        // so probe every recognized route until one knows this model; catalog
        // membership is advisory and an exhausted probe keeps the fallback.
        let contextWindow = 262144
        let inputModalities
        for (const route of routeCandidates(readState())) {
          if (route === PLUGIN_ROUTE) continue
          try {
            const info = await llm.resolveModelInfo(route, model, signal)
            if (inputModalities === undefined
              && info !== null && info !== undefined
              && Array.isArray(info.inputModalities)) {
              const known = info.inputModalities.filter(m => m === 'text' || m === 'image')
              if (known.length > 0) inputModalities = known
            }
            if (info && info.context && typeof info.context.contextWindow === 'number') {
              contextWindow = info.context.contextWindow
              break
            }
          } catch (_metadataUnavailable) {
            if (signal !== undefined && signal.aborted) break
          }
        }
        return {
          provider,
          id: model,
          name: model,
          context: { contextWindow },
          // Delegate the owning route's declared input types instead of lying
          // with a hard-coded ['text']: LlmRuntime projects every image to the
          // "[image omitted because this model accepts text only]" placeholder
          // whenever this array omits "image", which silently disabled vision
          // on the whole route. An omission (unknown) leaves the gate open.
          ...inputModalities === undefined ? {} : { inputModalities },
          reasoning: {
            efforts: ['off', 'low', 'medium', 'high', 'max'].map(id => ({ id, name: id })),
          },
        }
      })
    },
    async * stream(options) {
      // Image-bearing messages are legal here: LlmRuntime already projected
      // them to text for routes that genuinely declare text-only input, and
      // serializeMessages() now emits `image_url` parts for capable ones. The
      // former blanket UNSUPPORTED_CONTENT rejection is gone with it.
      const credentials = hostCtx.get('credentials')
      // 优先读凭据服务里的条目；读不到再回退到启动环境变量，这样你
      // 只需要在启动 dsh web 的 shell 里 export OPENROUTER_API_KEY，不用在 UI
      // 里再填一次，也不需要把 key 发给任何人。
      let keyValue = ''
      if (credentials !== undefined) {
        const credential = await credentials.resolve(API_KEY_REF)
        if (credential !== undefined && typeof credential.value === 'string') keyValue = credential.value
      }
      if (!keyValue && typeof process.env.OPENROUTER_API_KEY === 'string') keyValue = process.env.OPENROUTER_API_KEY
      if (keyValue.length === 0) {
        throw failureError(
          'openrouter-providers: no credential "' + API_KEY_REF + '" configured; add it to credentials service or export OPENROUTER_API_KEY in your launch environment',
          'AUTH',
        )
      }
      const subprocess = hostCtx.get('subprocess')
      if (subprocess === undefined) {
        throw failureError('openrouter-providers: subprocess service is unavailable', 'SERVER')
      }
      const nodePath = await subprocess.resolveExecutable('node', undefined, options.signal)
      const cfg = readState()
      // 'auto' routes through billion-context when its proxy is actually
      // running, and falls back to a direct request otherwise, so enabling it
      // can never break generation on a host without the proxy.
      const proxyOrigin = cfg.proxy === 'auto' ? cachedProxyOrigin() : undefined
      const headers = {
        'content-type': 'application/json',
        authorization: 'Bearer ' + keyValue,
        'user-agent': 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)',
        // App attribution (docs: app-attribution): HTTP-Referer is the app's
        // unique identifier in rankings/analytics (required) and
        // X-OpenRouter-Title is the display name shown in the OpenRouter UI.
        // X-OpenRouter-Categories is an optional comma-separated marketplace
        // category (max 2, only from the documented set).
        'HTTP-Referer': 'https://github.com/deepseek-ai/deepseek-harness',
        'X-OpenRouter-Title': 'DeepSeek Harness OpenRouter',
        'X-OpenRouter-Categories': 'cli-agent',
      }
      // The proxy buckets its compression state per conversation. Without a
      // stable identity every request opens a fresh bucket, so the compression
      // it is there to provide never accumulates. The loop stamps the session
      // id on the request for exactly this kind of transport metadata.
      if (proxyOrigin !== undefined && typeof options.sessionId === 'string' && options.sessionId.length > 0) {
        headers['x-acp-session'] = options.sessionId
      }
      const payload = {
        url: proxyOrigin === undefined ? OPENROUTER_URL : proxyOrigin + PROXY_PATH_PREFIX + OPENROUTER_URL,
        idleMs: IDLE_MS,
        headers,
        body: await buildBody(options),
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
        env: { OPENROUTER_API_KEY: keyValue },
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
  // The two features gate independently: `enabled` governs the provider
  // restriction this plugin injects, while the proxy is a separate opt-in, so
  // a user who wants compression alone is not forced to also restrict routing.
  hostCtx.on('llm/stream', (options, next) => {
    const cfg = readState()
    // Decide against THIS request's model: a matching rule resolves the
    // effective list; a rule with mode 'off' (or an empty global list) leaves
    // the request on the native route untouched. The route test accepts any
    // recognized OpenRouter route id, not just the literal `openrouter`.
    const eff = resolveConfig(cfg, options.model)
    const restricted = cfg.enabled && (eff.providers.length > 0 || cfg.quantization !== 'off')
    const reroute = isRecognizedRoute(cfg, options.provider) && (restricted || cfg.proxy === 'auto')
    if (reroute) {
      return llm.stream({ ...options, provider: PLUGIN_ROUTE })
    }
    return next()
  })

  console.log('[openrouter-providers] active: OpenRouter-routed requests (built-in "openrouter" + configured/auto-detected routes) stream via "' + PLUGIN_ROUTE + '"')
  })
}
