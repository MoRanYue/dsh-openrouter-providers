# dsh-openrouter-providers

[中文](README.md) | English

A DeepSeek Harness plugin: fill in the **provider list** and **quantization cap** that OpenRouter requests should use, and the plugin injects them as `provider.only` / `provider.order` / `provider.quantizations` routing parameters into every OpenRouter model request. The plugin owns its configuration and writes it to `$DSH_HOME/openrouter-providers.json` (`~/.dsh/openrouter-providers.json` when `DSH_HOME` is unset); it is restored after a restart.

**Compatible DSH versions**: `0.1.5-rc.1` through `0.1.7-rc.2` (`engines.dsh: >=0.1.5-rc.1 <0.2.0`). This plugin imports no `@deepseek-ai/dsh-*` package at all — its only peer is `@deepseek-ai/cordis` — so the 0.1.7 breaking changes do not reach it.

> **Why the settings service is no longer used**: DSH `0.1.7` removed settings namespace registration (`settings.register` / `SettingsScope` / `watch`) and now enumerates only `.volatile()` fields on profile entry Configs. A plugin built on the old API **fails silently** on 0.1.7: `apply` returns early, so neither the HTTP route nor the `llm/stream` reroute is registered, the settings page reports "Cannot read the current state (Host half unavailable)", and request injection never takes effect. This plugin owns its configuration document instead and treats the old namespace as an **optional, capability-detected enhancement** (below), so behavior is identical on old and new hosts.

**Configuration entry points (dual-stack)**: DSH `0.1.6-alpha.2` moved plugin configuration out of Settings onto the new sidebar **Plugins** page and retired `settings.plugin.item`. This plugin registers both slots and lets the host's declarations decide which one applies (the undeclared one simply never fires — no error either way):

| Host | Slot | Where |
| --- | --- | --- |
| DSH ≥ `0.1.6-alpha.2` | `plugins.bundle.config` (keyed by package name) | Sidebar **Plugins** → this bundle's page → configuration form |
| DSH < `0.1.6-alpha.2` | `settings.plugin.item` | **Settings** → **Plugins** → **Plugin configuration** → collapsible card |

On old hosts that card is dispatched per settings namespace the Host serves, so the plugin **probes** for `settings.register` and registers an empty pass-through namespace only when it exists — purely so the card can be dispatched; it carries no values. From 0.1.7 on, that API is gone, the namespace is skipped, and nothing else is affected.

## Features

- **Configuration form**: fill in provider slugs (one per line), pick the routing mode, and pick the quantization cap:
  - **Only these providers** → the request body carries `provider: { only: [...], allow_fallbacks: false }`
  - **Try in order** → injects `provider: { order: [...], allow_fallbacks: true }`
  - **Quantization cap** → injects `provider: { quantizations: ['int4' | 'int8' | ...] }` (optional, unrestricted by default; valid values in [OpenRouter Quantization](https://openrouter.ai/docs/guides/routing/provider-selection#quantization))
  - The whole feature has a master switch; saving writes the plugin-owned configuration file (`$DSH_HOME/openrouter-providers.json`). On the new Plugins page only a save writes and leaving the page drops staged edits; the legacy card additionally offers a Discard button and an unsaved badge.
- **Localized UI**: copy comes from the plugin's `openrouter-providers` locale namespace (`zh` / `en`); switching the language re-renders the UI live with no page reload. On hosts without the locale service it falls back to Chinese copy.
- **Display name and icon on the Plugins page**: `meta.title` / `meta.description` in the packaged `locale/zh.json` and `locale/en.json` provide the localized display name (`OpenRouter Providers` in English, 「OpenRouter 提供商列表」in Chinese), so the plugin list shows a readable name instead of the bare package name `dsh-openrouter-providers`; `icon: "./icon.svg"` in `package.json` supplies the card and row artwork (three fading rounded bars, suggesting a provider list narrowing step by step). Both follow the DSH interface language. Note that `exports` must include `"./locale/*.json": "./locale/*.json"`, otherwise Node's exports resolution throws `ERR_PACKAGE_PATH_NOT_EXPORTED` and the display name silently falls back to the package name; `icon` must be a **relative** path with a `.svg/.png/.jpg/.jpeg/.webp` extension, inside the manifest directory and at most 256 KiB — a violation is reported rather than ignored, but only the icon is lost and the name still applies.
- **Request injection**: the plugin listens on the `llm/stream` waterfall — when the requested provider route is `openrouter` (enabled, with a non-empty list or a quantization cap), the request is rerouted to the plugin's own chat-completions adapter, which builds the request body and injects the `provider` field; `reasoning.effort` (off/low/medium/high/max, all valid OpenRouter values) passes through unchanged. The session log and UI still show `openrouter`.
- **Credentials**: reuses the existing `OPENROUTER_API_KEY` (resolved through the `credentials` service, matching `llm-pi-ai`'s `apiKeyEnv`).
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

1. Make sure the model's provider route is `openrouter` (pick a model under OpenRouter in the model selector).
2. Open the configuration entry for your host (see the table above: sidebar **Plugins** → this bundle's page on DSH ≥ `0.1.6-alpha.2`, or **Settings** → **Plugins** → **Plugin configuration** on older hosts), fill in provider slugs (such as `DeepInfra`, `Together`), choose the routing mode and quantization cap, and save.
3. Every later OpenRouter request carries the injected provider routing parameters.

> Provider slug format: see the [OpenRouter Provider Routing docs](https://openrouter.ai/docs/guides/routing/provider-selection) (`order`/`only` fields).

## How it works (brief)

- **Transport**: the dynamic plugin environment has no built-in `fetch`, so the adapter spawns a `node -e` child process through the `subprocess` service to perform HTTP + SSE streaming parsing (text/reasoning/tool-call deltas, usage, `[DONE]`, error classification such as AUTH/RATE_LIMIT/INVALID_REQUEST/SERVER).
- **State persistence**: the plugin owns its configuration and writes `$DSH_HOME/openrouter-providers.json` (`~/.dsh/…` when `DSH_HOME` is unset), independent of the settings service. On first start, while the file still holds shipped defaults, the plugin tries each legacy location once, in order: `<workspaceRoot>/.dsh-plugins/openrouter-providers.json` (v1.0.4 and earlier), then `$DSH_HOME/settings.yaml.imported` (the renamed settings document 0.1.7 left behind, whose section for this plugin could not be imported because it declares no Config). The first source that holds values wins, and an existing configuration is never overwritten afterwards.
- **Client communication**: the configuration card reads and writes state over the HTTP API `GET/POST /api/openrouter-providers/state` (registered on the Host half through `webServer`). The client now shows the status code and response excerpt for a non-2xx response instead of reporting every failure as "Host half unavailable".

## Limitations

- Image input is not supported (a model request containing images returns `UNSUPPORTED_CONTENT`).
- In `only` mode `allow_fallbacks=false`: the request fails when none of the listed providers is available (OpenRouter behavior).

## License

MIT
