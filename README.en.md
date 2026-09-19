# dsh-openrouter-providers

[中文](README.md) | English

A DeepSeek Harness plugin: fill in the **provider list** and **quantization cap** that OpenRouter requests should use, and the plugin injects them as `provider.only` / `provider.order` / `provider.quantizations` routing parameters into every OpenRouter model request. Settings persist through the **DSH settings service** into the settings document (`~/.dsh/settings.yaml`), like every other plugin, and are restored after a restart.

**Compatible DSH version**: DeepSeek Harness `0.1.5-rc.1` — `peerDependencies` declares `@deepseek-ai/dsh-settings@^0.1.5-rc.1` (the lockstep version of DSH 0.1.5-rc.1), which is what the plugin market reads to show the compatibility badge on the plugin card. Earlier DSH versions fall outside this plugin's declared compatibility range.

**Configuration entry points (dual-stack)**: DSH `0.1.6-alpha.2` moved plugin configuration out of Settings onto the new sidebar **Plugins** page and retired `settings.plugin.item`. This plugin registers both slots and lets the host's declarations decide which one applies (the undeclared one simply never fires — no error either way):

| Host | Slot | Where |
| --- | --- | --- |
| DSH ≥ `0.1.6-alpha.2` | `plugins.bundle.config` (keyed by package name) | Sidebar **Plugins** → this bundle's page → configuration form |
| DSH < `0.1.6-alpha.2` | `settings.plugin.item` | **Settings** → **Plugins** → **Plugin configuration** → collapsible card |

## Features

- **Configuration form**: fill in provider slugs (one per line), pick the routing mode, and pick the quantization cap:
  - **Only these providers** → the request body carries `provider: { only: [...], allow_fallbacks: false }`
  - **Try in order** → injects `provider: { order: [...], allow_fallbacks: true }`
  - **Quantization cap** → injects `provider: { quantizations: ['int4' | 'int8' | ...] }` (optional, unrestricted by default; valid values in [OpenRouter Quantization](https://openrouter.ai/docs/guides/routing/provider-selection#quantization))
  - The whole feature has a master switch; saving writes the DSH settings document (`openrouter-providers` namespace, `~/.dsh/settings.yaml`). On the new Plugins page only a save writes and leaving the page drops staged edits; the legacy card additionally offers a Discard button and an unsaved badge.
- **Localized UI**: copy comes from the plugin's `openrouter-providers` locale namespace (`zh` / `en`); switching the language re-renders the UI live with no page reload. On hosts without the locale service it falls back to Chinese copy.
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
- **State persistence**: the `settings` service registers the `openrouter-providers` namespace, and settings are written into the DSH settings document (default `~/.dsh/settings.yaml`), consistent with other plugins; on first start the legacy workspace state file (`<workspaceRoot>/.dsh-plugins/openrouter-providers.json`, v1.0.4 and earlier) is migrated into the settings document automatically.
- **Client communication**: the configuration card reads and writes state over the HTTP API `GET/POST /api/openrouter-providers/state` (registered on the Host half through `webServer`).

## Limitations

- Image input is not supported (a model request containing images returns `UNSUPPORTED_CONTENT`).
- In `only` mode `allow_fallbacks=false`: the request fails when none of the listed providers is available (OpenRouter behavior).

## License

MIT
