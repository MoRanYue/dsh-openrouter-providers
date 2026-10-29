# dsh-openrouter-providers

[中文](README.md) | English

A DeepSeek Harness plugin: pick the **providers** OpenRouter requests may use from the official directory, or scope that per **model rule**, and set a **quantization cap** and a **service tier** (`service_tier`); the plugin injects them as `provider.only` / `provider.order` / `provider.quantizations` routing parameters (plus a top-level `service_tier`) into every OpenRouter model request (multimodal requests carrying images pass through). It can optionally route those requests through the [billion-context](https://github.com/ranxianglei/billion-context) compression proxy. The plugin owns its configuration and writes it to `$DSH_HOME/openrouter-providers.json` (`~/.dsh/openrouter-providers.json` when `DSH_HOME` is unset); it is restored after a restart.

**Compatible DSH versions**: `0.1.5-rc.1` through `0.2.1-rc.3` (`engines.dsh: >=0.1.5-rc.1 <0.3.0`). This plugin imports no `@deepseek-ai/dsh-*` package at all — its only peer is `@deepseek-ai/cordis` — so neither the 0.1.7 nor the 0.2.x breaking changes reach it; the 0.2 major-version crossing was re-verified item by item on a real `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.1-alpha.4`, `0.2.1-rc.2` and `0.2.1-rc.3` (config round-trip, `llm/stream` reroute, real OpenRouter routing, billion-context proxy routing, Plugins-page title and icon, settings-page form rendering, adapter contract, service-tier injection). Note: since `0.2.1-alpha.3` DSH treats `engines.dsh` as a **real gate** (taking precedence over `peerDependencies`, refusing to load on a mismatch), so raising the upper bound is a prerequisite for any `0.3.x` upgrade.

> **Why the settings service is no longer used**: DSH `0.1.7` removed settings namespace registration (`settings.register` / `SettingsScope` / `watch`) and now enumerates only `.volatile()` fields on profile entry Configs. A plugin built on the old API **fails silently** on 0.1.7: `apply` returns early, so neither the HTTP route nor the `llm/stream` reroute is registered, the settings page reports "Cannot read the current state (Host half unavailable)", and request injection never takes effect. This plugin owns its configuration document instead and treats the old namespace as an **optional, capability-detected enhancement** (below), so behavior is identical on old and new hosts.

**Configuration entry points (dual-stack)**: DSH `0.1.6-alpha.2` moved plugin configuration out of Settings onto the new sidebar **Plugins** page and retired `settings.plugin.item`. This plugin registers both slots and lets the host's declarations decide which one applies (the undeclared one simply never fires — no error either way):

| Host | Slot | Where |
| --- | --- | --- |
| DSH ≥ `0.1.6-alpha.2` | `plugins.bundle.config` (keyed by package name) | Sidebar **Plugins** → this bundle's page → configuration form |
| DSH < `0.1.6-alpha.2` | `settings.plugin.item` | **Settings** → **Plugins** → **Plugin configuration** → collapsible card |

On old hosts that card is dispatched per settings namespace the Host serves, so the plugin **probes** for `settings.register` and registers an empty pass-through namespace only when it exists — purely so the card can be dispatched; it carries no values. From 0.1.7 on, that API is gone, the namespace is skipped, and nothing else is affected.

## Features

- **Checkbox provider picker**: the Host half fetches the official OpenRouter directory (`https://openrouter.ai/api/v1/providers`, cached for 24 hours) and the form renders a searchable checkbox list, while keeping a field for hand-typed custom slugs. Selected entries stay visible **even when they are absent from the directory**, so an incomplete offline snapshot never drops an existing selection. If the directory cannot be fetched the form falls back to the built-in snapshot, labels it clearly as "offline or not refreshed", and retries after 60 seconds rather than waiting out the full day.
- **Configuration form**: pick the routing mode and the quantization cap:
  - **Only these providers** → the request body carries `provider: { only: [...], allow_fallbacks: false }`
  - **Try in order** → injects `provider: { order: [...], allow_fallbacks: true }`
  - **Quantization cap** → injects `provider: { quantizations: ['int4' | 'int8' | ...] }` (optional, unrestricted by default; valid values in [OpenRouter Quantization](https://openrouter.ai/docs/guides/routing/provider-selection#quantization))
  - The whole feature has a master switch; saving writes the plugin-owned configuration file (`$DSH_HOME/openrouter-providers.json`). On the new Plugins page only a save writes and leaving the page drops staged edits; the legacy card additionally offers a Discard button and an unsaved badge.
- **Per-model rules (optional)**: a `modelRules` array in the configuration file lets different models use different provider restrictions — pin `makora`/`xiaomi` for `xiaomi/mimo*` while leaving every other model unrestricted, for example. Rules are evaluated **top-down and the first match wins**; unmatched models keep the global configuration. `pattern` is a case-insensitive glob (a `*` makes it a wildcard), and without a `*` it matches a namespace prefix (`xiaomi` already covers `xiaomi/mimo-v2.6-flash`). `mode` is `inherit` (follow the global mode) / `only` / `order` / `off` (skip injection for that model). An empty rule `providers` inherits the global list. Resolution happens in **both** `buildBody()` and the `llm/stream` reroute gate, each against the request's own model, so a model that resolves to no restriction is never forced through the plugin's adapter.
- **Localized UI**: copy comes from the plugin's `openrouter-providers` locale namespace (`zh` / `en`); switching the language re-renders the UI live with no page reload. On hosts without the locale service it falls back to Chinese copy.
- **Display name and icon on the Plugins page**: `meta.title` / `meta.description` in the packaged `locale/zh.json` and `locale/en.json` provide the localized display name (`OpenRouter Providers` in English, 「OpenRouter 提供商列表」in Chinese), so the plugin list shows a readable name instead of the bare package name `dsh-openrouter-providers`; `icon: "./icon.svg"` in `package.json` supplies the card and row artwork (three fading rounded bars, suggesting a provider list narrowing step by step). Both follow the DSH interface language. Note that `exports` must include `"./locale/*.json": "./locale/*.json"`, otherwise Node's exports resolution throws `ERR_PACKAGE_PATH_NOT_EXPORTED` and the display name silently falls back to the package name; `icon` must be a **relative** path with a `.svg/.png/.jpg/.jpeg/.webp` extension, inside the manifest directory and at most 256 KiB — a violation is reported rather than ignored, but only the icon is lost and the name still applies.
- **Route detection does not look at the name**: a provider in the profile can be renamed freely (to `aaaa`, say) and still counts as an OpenRouter route as long as its `baseURL` host is `openrouter.ai` (subdomains included) or its `apiKeyEnv` is `OPENROUTER_API_KEY` — the result is cached for 30 seconds, so a rename needs no restart. The built-in `openrouter` always counts, and extra route names can be listed in the configuration file's `routes` array. The test deliberately anchors on the URL's **host** rather than a substring match: `/openrouter\.ai/` also matches a path fragment on an unrelated domain.
- **Image input**: images in a multimodal request are converted to OpenRouter `image_url` parts (a `data:` URL) instead of being rejected outright. Bytes come from the host path the `attachments` service hands out; an image already moved out of context (`offloaded`) degrades to a text placeholder rather than re-sending bytes that are no longer part of the history. The per-request image budget honours the host's `IMAGE_OFFLOAD_REQUIRED` contract — when exceeded, `compaction-image-offload` moves the oldest images out of context and retries, so the user never sees a failure — and it is enforced against **the provider's actual `maxRequestImageBytes`** rather than a hardcoded 20 MiB.
- **Service tier (optional)**: injects the top-level `service_tier`, one of `default` / `flex` / `priority` / `ultrafast` ([OpenRouter Service Tiers](https://openrouter.ai/docs/guides/features/service-tiers)). Two things are easy to conflate: **"not injected" is not the same as `default`** — omitting the field defers to the workspace default and still lets the `:nitro` / `:floor` variants admit tier endpoints, whereas sending `default` pins the standard tier and closes that door. `ultrafast` needs an adequate `max_tokens`, otherwise it degrades to `priority`. `fast` is not offered — it is a synonym for `priority`. The form also reports **which tier and provider served the last request** (the `service_tier` from the response), because OpenRouter falls back silently when a tier cannot be met; without that feedback you cannot tell whether the setting did anything.
- **Request injection**: the plugin listens on the `llm/stream` waterfall — when the requested provider route is recognised as OpenRouter (enabled, with a non-empty list, or a quantization cap, or a service tier, or the proxy on), the request is rerouted to the plugin's own chat-completions adapter, which builds the request body and injects the `provider` field; `reasoning.effort` (off/low/medium/high/max, all valid OpenRouter values) passes through unchanged. The session log and UI still show the original route name.
- **billion-context compression proxy (optional)**: with the proxy switch set to **Auto**, the plugin detects a running local [billion-context](https://github.com/ranxianglei/billion-context) proxy and, when found, sends requests through its `/bili/` entry point (`<origin>/bili/https://openrouter.ai/api/v1/chat/completions`) to gain its context compression; when no proxy is detected it goes **direct**, so installing this plugin can never break generation. The proxy switch and the provider-restriction master switch are **independent**: to get compression alone, turn the provider restriction off and enable the proxy by itself.
- **Credentials**: reuses the existing `OPENROUTER_API_KEY` — resolved through the `credentials` service first (matching `llm-pi-ai`'s `apiKeyEnv`), falling back to the same-named environment variable of the shell that launched `dsh web`, so there is no need to enter it again in the UI.
- **App attribution**: requests carry `HTTP-Referer: https://github.com/deepseek-ai/deepseek-harness`, `X-OpenRouter-Title: DeepSeek Harness OpenRouter`, and `X-OpenRouter-Categories: cli-agent`, so OpenRouter's UI and leaderboards show `DeepSeek Harness OpenRouter` instead of Unknown ([OpenRouter App Attribution](https://openrouter.ai/docs/app-attribution)).

## Installation (bundle mount)

The plugin mounts as a **bundle package**, like other plugins (dshmarket, dsh-recall-plugin, …): its `cordis.patch.yml` insert row is merged into the profile composition automatically.

### Option A: install from npm (recommended)

In the profile directory (for example `~/.dsh/profiles/web/`):

```bash
pnpm add dsh-openrouter-providers@latest
```

Then add the package to the profile `package.json`'s `dsh.profile.bundles` list:

```json
"dsh": { "profile": { "bundles": [ ..., "dsh-openrouter-providers" ] } }
```

Restart `dsh web`. The bundle coordinator merges the package's `cordis.patch.yml` (insert row: `id: openrouter-providers`) on its own.

### Option B: install from GitHub

```bash
pnpm add dsh-openrouter-providers@github:MoRanYue/dsh-openrouter-providers
```

The remaining steps are the same as Option A (add to `dsh.profile.bundles` and restart).

### Option C: local path

```bash
pnpm add dsh-openrouter-providers@file:D:\\path\\to\\dsh-openrouter-providers
# then add the package name to dsh.profile.bundles and restart
```

### Manual mount (without the bundle)

Append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: openrouter-providers
      name: 'dsh-openrouter-providers'
```

Then add the package to the profile `package.json`'s `dependencies` and `dsh.profile.bundles`, run `pnpm install`, and restart.

## Usage

1. Make sure the model's provider route is OpenRouter — the built-in `openrouter` route, or any provider in the profile whose `baseURL` host is `openrouter.ai` or whose `apiKeyEnv` is `OPENROUTER_API_KEY` (see "Route detection does not look at the name" above).
2. Open the configuration entry for your host (see the table above: sidebar **Plugins** → this bundle's page on DSH ≥ `0.1.6-alpha.2`, or **Settings** → **Plugins** → **Plugin configuration** on older hosts), check providers in the directory (or type a slug the directory does not list), choose the routing mode, quantization cap and service tier, and save. To scope by model, add rules under **Per-model rules**.
3. Every later OpenRouter request carries the injected provider routing parameters.
4. For context compression: start the billion-context proxy (`bili`) first, then set this plugin's **Proxy** field to **Auto** and save. The line under the field reports whether it is connected (`Proxy in use: http://127.0.0.1:18790`) or not detected; once detected it takes effect immediately, with no DSH restart.

Per-model rules look like this in the configuration file (the form edits the same thing):

```json
{
  "enabled": true,
  "mode": "only",
  "providers": ["deepinfra", "novita"],
  "quantization": "off",
  "serviceTier": "off",
  "proxy": "auto",
  "modelRules": [
    { "pattern": "xiaomi/mimo*", "mode": "only", "providers": ["makora", "xiaomi"] },
    { "pattern": "anthropic/*", "mode": "off", "providers": [] }
  ]
}
```

> Provider slug format: see the [OpenRouter Provider Routing docs](https://openrouter.ai/docs/guides/routing/provider-selection) (`order`/`only` fields).

## How it works (brief)

- **Transport**: the dynamic plugin environment has no built-in `fetch`, so the adapter spawns a `node -e` child process through the `subprocess` service to perform HTTP + SSE streaming parsing (text/reasoning/tool-call deltas, usage, `[DONE]`, error classification such as AUTH/RATE_LIMIT/INVALID_REQUEST/SERVER).
- **Image assembly and budgets**: `serializeMessages()` turns image blocks into `data:` URLs and measures them **the way DSH itself does** — the base64 length is `ceil(bytes/3)*4`, excluding the `data:` prefix (counting the prefix would trip the budget about 22 bytes per image early, effectively moving one more image out of context than the host would). The three budgets have different origins: `maxRequestImageBytes` (the per-request hard ceiling) comes from that provider's configuration and is genuinely enforced; `requestImageMaxBytes` (single-image raw bytes) and `requestImagePixelBudget` (single-image pixels) are only **re-encoding targets** in the host — pi-ai satisfies them by downscaling through a quality ladder — and since this plugin carries no image codec they are not enforced at their defaults (doing so would degrade most screenshots to placeholders for no benefit); they are enforced only when the user **explicitly** configures them, and an over-budget image degrades to a text placeholder with the reason. Image bytes are read with `node:fs` straight from attachment storage: that is DSH-owned data living outside any workspace, and the path comes from the trusted `attachments` service rather than from user or model input, so the workspace sandbox policy does not apply to it (the same path the plugin already uses to read and write its own configuration file).
- **Locating a provider's image budget**: the adapter only ever sees `PLUGIN_ROUTE`, while the budget hangs off the provider the user configured. The reroute records the real route in a `WeakMap` keyed by the request's `AbortSignal`, and `stream()` reads it back — the signal is the only object that survives every layer's option spread with its identity intact, so no non-standard field has to be threaded through the option bag.
- **State persistence**: the plugin owns its configuration and writes `$DSH_HOME/openrouter-providers.json` (`~/.dsh/…` when `DSH_HOME` is unset), independent of the settings service. On first start, while the file still holds shipped defaults, the plugin tries each legacy location once, in order: `<workspaceRoot>/.dsh-plugins/openrouter-providers.json` (v1.0.4 and earlier), then `$DSH_HOME/settings.yaml.imported` (the renamed settings document 0.1.7 left behind, whose section for this plugin could not be imported because it declares no Config). The first source that holds values wins, and an existing configuration is never overwritten afterwards.
- **Client communication**: the configuration card reads and writes state over the HTTP API `GET/POST /api/openrouter-providers/state` (registered on the Host half through `webServer`). The client now shows the status code and response excerpt for a non-2xx response instead of reporting every failure as "Host half unavailable".
- **Provider directory**: the same state route also returns `catalog` (`[{slug, name}]`) and `catalogSource` (`live` / `builtin`). The directory is fetched with `node:https` directly — for the same reason as the proxy probe, it must **not** go through `globalThis.fetch`, or a host with billion-context mounted would rewrite the fetch into a proxied request. It is cached for 24 hours; a failed refresh keeps the last successful list with `catalogSource` still `live` (stale but genuinely official), and only a fetch that has never succeeded falls back to the built-in snapshot with `builtin`, which the UI labels as "offline or not refreshed". The settings page waits at most 1.5 seconds for a refresh, so an offline host never blocks the form.
- **Adapter contract**: the plugin registers a plain object adapter (not an `LlmAdapter` subclass), so it has no base-class defaults to fall back on and must implement **every** member the host calls. Besides `stream`, `LlmRuntime` calls `providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `imageRequestTarget` / `listModels` / `resolveModel` / `prepareCall` — omit any one and that call site throws `TypeError: adapter.<name> is not a function`. This plugin's `listModels()` returns an empty array, so the synthetic route never appears in the model catalog (it is reachable only internally, from `llm/stream`); `imageRequestPricing()` returns `undefined`, leaving the token meter and spill policy on their own neutral estimates; `imageRequestTarget()` echoes the normalized width, height and byte ceiling, matching the base-class default (that member arrived in DSH `0.2.1-alpha.3` and is currently called only by the CUA screenshot path).
- **Service tier**: `service_tier` is a **top-level** field, not something inside `provider`. It has three states rather than two: "not injected" (`off`), `default`, and `flex`/`priority`/`ultrafast`. `default` looks like "nothing chosen" but is an **active pin to the standard tier** — omitting the field leaves the `:nitro` / `:floor` variants free to admit tier endpoints, while sending `default` closes that door. OpenRouter **does not validate** this field: probing showed every string (even `bogus`) answers 200 and is silently ignored, so the legal set is enforced by a whitelist in the plugin and an out-of-range value is dropped when the configuration is written. The `service_tier` in the response is the only signal that a tier actually applied (`null` means a non-tier endpoint served the request); the child process surfaces it alongside `provider` as a `served` event, the Host remembers the most recent one and returns it on the state route, and the form renders "which tier served the last request" from it.
- **billion-context proxy integration**: the proxy address is **never a hardcoded port**; it is resolved in billion-context's own discovery order: the `BILI_MCP_PROXY` environment variable → `$XDG_STATE_HOME/billion-context/proxy-origin` (both a bare URL and the instance JSON are supported) → `lanes.dsh` in `port-zone.json` beside it → the `http://127.0.0.1:8787` fallback. Every candidate is confirmed by requesting `/__bili/health` and requiring `ok: true`. The probe deliberately uses `node:http`/`node:https` rather than `globalThis.fetch`: once billion-context is mounted it patches the host `fetch` to rewrite every URL to `<origin>/bili/<original>`, so a `fetch`-based probe would have its own request rewritten into a request the proxy makes to itself — and would then "succeed" forever. The result is cached for 30 seconds and refreshed in the background; the request path only reads that cache, so it never blocks generation on a socket. The settings page re-probes on every load and shows whether the proxy is actually in use. Requests carry an `x-acp-session: <sessionId>` header so the proxy buckets its compression state per conversation and the compression actually accumulates (the value comes from the session identity the host stamps on `GenerateOptions.sessionId` for exactly this kind of transport metadata).

## Limitations

- Images are **not re-encoded**: this plugin carries no image codec, so the attachment's original bytes go out as a `data:` URL. The host's `requestImageMaxBytes` / `requestImagePixelBudget` defaults are only re-encoding targets (pi-ai meets them by downscaling through a quality ladder), so they are not enforced by default; the user has to configure them explicitly, and over-budget images then degrade to text placeholders. The trade-off is that a very large original is sent as-is and may hit the provider's own per-image limit.
- Image bytes are read with `node:fs` straight from attachment storage, bypassing the workspace sandbox (see "How it works").
- With the global "enable provider restriction" switch off, **all per-model rules are inactive too** (the form greys out the rules section), because that switch is the master gate.
- In `only` mode `allow_fallbacks=false`: the request fails when none of the listed providers is available (OpenRouter behavior).
- Proxy routing is decided **per request**: if the proxy stops, requests fall back to a direct connection within 30 seconds (the probe cache TTL); if it starts, they pick it up within the same window, or immediately on opening the settings page once.
- The service tier is **best effort**: OpenRouter does not error when it cannot satisfy a tier, it just falls back, so setting `flex` and seeing "no tier endpoint matched" is a normal outcome rather than a plugin failure. `ultrafast` additionally needs an adequate `max_tokens`, otherwise it degrades to `priority`.
- The proxy and the provider restriction share one transport (this plugin's adapter), so with the proxy on, requests bypass the host's native `openrouter` route. If another plugin (such as billion-context's dsh-native) relies on intercepting the host `globalThis.fetch`, those interceptors do not apply to this plugin's traffic — an inherent consequence of owning the transport.

## License

MIT
