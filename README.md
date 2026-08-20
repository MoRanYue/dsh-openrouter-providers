# dsh-openrouter-providers

DeepSeek Harness 插件：在设置页填写 OpenRouter 请求使用的**提供商列表**，并把列表作为 `provider.only` / `provider.order` 路由参数注入到所有 OpenRouter 模型请求中。设置**持久化**到工作区状态文件，重启后自动恢复。

## 功能

- **设置页**（设置 → OpenRouter）：填写提供商 slug 列表（每行一个）、选择路由模式：
  - **仅允许这些提供商** → 请求体注入 `provider: { only: [...], allow_fallbacks: false }`
  - **按顺序优先尝试** → 注入 `provider: { order: [...], allow_fallbacks: true }`
  - 可整体开关；保存后写入 `<workspaceRoot>/.dsh-plugins/openrouter-providers.json`
- **请求注入**：监听 `llm/stream` waterfall——当请求的 provider 路由为 `openrouter` 且列表非空时，把请求重路由到插件自研的 chat-completions adapter，由它构造请求体注入 `provider` 字段；`reasoning.effort`（off/low/medium/high/max，均为 OpenRouter 合法值）按契约透传。会话日志与 UI 仍显示 `openrouter`。
- **凭据**：复用现有 `OPENROUTER_API_KEY`（通过 `credentials` 服务解析，与 `llm-pi-ai` 的 `apiKeyEnv` 一致）。

## 安装（bundle 挂载）

插件以 **bundle 包**形式挂载，与其他插件（dshmarket、dsh-recall-plugin 等）一致，通过 `cordis.patch.yml` 的 insert 行自动合并进 profile composition。

### 方式 A：从 GitHub 安装

在 profile 目录（如 `~/.dsh/profiles/web/`）执行：

```bash
# 1. 添加依赖（npm/pnpm 均可解析 github 源）
pnpm add dsh-openrouter-providers@github:MoRanYue/dsh-openrouter-providers

# 2. 把包加入 profile 的 bundle 列表（package.json 的 dsh.profile.bundles）
#    "dsh.profile": { "bundles": [ ..., "dsh-openrouter-providers" ] }

# 3. 重启 dsh web
```

bundle 协调器会自动合并包内的 `cordis.patch.yml`（insert 行：`id: openrouter-providers`），无需手动编辑 profile 文件。

### 方式 B：本地路径

```bash
pnpm add dsh-openrouter-providers@file:D:\\path\\to\\dsh-openrouter-providers
# 然后同样把包名加入 dsh.profile.bundles 并重启
```

### 手动方式（不依赖 bundle）

在 `~/.dsh/profiles/web/cordis.patch.yml` 中追加：

```yaml
- insert:
    - id: openrouter-providers
      name: 'dsh-openrouter-providers'
```

并在 profile 的 `package.json` 中把包加入 `dependencies` 与 `dsh.profile.bundles`，然后 `pnpm install` 并重启。

## 使用

1. 确保模型的 provider 路由为 `openrouter`（模型选择器中选中 OpenRouter 下的模型）。
2. 打开 设置 → OpenRouter，填写提供商 slug（如 `DeepInfra`、`Together`），选择路由模式，保存。
3. 之后的 OpenRouter 请求都会携带注入的 provider 路由参数。

> 提供商 slug 格式参见 [OpenRouter Provider Routing 文档](https://openrouter.ai/docs/guides/routing/provider-selection)（`order`/`only` 字段）。

## 工作原理（简要）

- **传输层**：动态插件环境没有 `fetch` 内置，adapter 通过 `subprocess` 服务派生 `node -e` 子进程执行 HTTP + SSE 流式解析（文本/推理/工具调用增量、usage、`[DONE]`、错误分类 AUTH/RATE_LIMIT/INVALID_REQUEST/SERVER 等）。
- **状态持久化**：`fs` 服务写入 `<workspaceRoot>/.dsh-plugins/openrouter-providers.json`（自动建目录），启动时加载；写入显式使用 `workspace-write` 沙箱策略。
- **Client 通信**：设置页通过 HTTP API `GET/POST /api/openrouter-providers/state` 读写状态（Host 端经 `webServer` 注册）。

## 限制

- 图像输入不支持（模型请求含图片时返回 `UNSUPPORTED_CONTENT`）。
- `only` 模式下 `allow_fallbacks=false`：列表中的提供商全部不可用时请求失败（OpenRouter 行为）。

## License

MIT
