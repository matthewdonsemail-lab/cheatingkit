# CheatingKit

CheatingKit helps coding agents recover context from earlier work. Its local `ck` CLI imports Claude Code, Codex, and Hermes conversations into SQLite, finds related requests and observed warning responses, and supplies source-linked context at each new prompt through harness hooks. Your session index stays on your machine.

[Quick start](#quick-start) · [What you can do](#what-you-can-do) · [Updates](#updates) · [Documentation](https://cheatingkit.com/docs)

## Quick start

Install [Bun](https://bun.sh/docs/installation), then run the installer for your shell. You do not need to clone this repository.

**macOS or Linux**

```sh
curl -fsSL https://cheatingkit.com/install.sh | sh
```

**Windows PowerShell**

```powershell
irm https://cheatingkit.com/install.ps1 | iex
```

Set up your local session index and inspect it:

```sh
ck setup
ck sessions
ck timeline
```

`ck setup` detects supported local session sources, creates `~/.cheatingkit/config.yaml` and a local SQLite database, and offers to import conversations, build the semantic index, and install prompt hooks. Complete the semantic index build before using prompt context. The hooks import new transcript records before each prompt and add a source-linked context pack when the index is ready. Each website installer resolves npm's `latest` tag to an exact published version, installs it, and verifies `ck --version`.

## What you can do

| Command | Purpose |
| --- | --- |
| `ck detect` | Show which supported local session sources are present. |
| `ck ingest` | Import new conversations into the local index. |
| `ck index` | Import new conversations and update the local semantic search index. |
| `ck context --prompt "..."` | Preview the context a prompt would receive. |
| `ck hooks install` / `ck hooks remove` | Add or remove CheatingKit's prompt integrations. |
| `ck proxy setup` | Choose a Responses provider and model in an interactive setup, then connect Codex. |
| `ck proxy setup claude` | Connect Claude Code to the local Anthropic Messages relay using an Anthropic API key from an environment variable. |
| `ck proxy setup hermes` | Choose a Chat Completions provider and model, then connect Hermes to the local relay. |
| `ck proxy start` / `ck proxy status` / `ck proxy stop` | Run and inspect the local provider relay. |
| `ck proxy install codex` / `ck proxy remove codex` | Route Codex through the local relay and restore its prior setting. |
| `ck proxy install claude` / `ck proxy remove claude` | Route Claude Code through the local relay and restore its prior setting. |
| `ck proxy install hermes` / `ck proxy remove hermes` | Route Hermes through the local relay and restore its prior model settings. |
| `ck mcp` | Serve the same local context through MCP. |
| `ck sessions` | List imported sessions and their current model. |
| `ck timeline` | Inspect recorded session events and model changes. |
| `ck label` | Run the configured local model over imported messages. |
| `ck areas` | Summarize labels after messages have been labeled. |
| `ck leadups` | Inspect messages preceding recorded warnings. |

Claude Code and Codex use `UserPromptSubmit` hooks. Hermes uses a `pre_llm_call` plugin. Existing hooks are preserved. Restart each harness after installing hooks; Codex may ask you to trust the new hook definition. CheatingKit supplies prior evidence alongside the current prompt and does not change what you typed.

### Codex provider proxy preview

The proxy is a separate path from the prompt hooks. Run the interactive provider setup to choose OpenAI API or a custom endpoint that implements the OpenAI Responses API, enter the model ID, and name the environment variable containing its API key. The key stays in your environment; CheatingKit stores only the variable name. For a keyless local endpoint, leave that field blank.

```sh
ck proxy setup
ck proxy status
ck proxy remove codex
ck proxy stop
```

Set the chosen key environment variable before `ck proxy setup` and keep it available when starting the proxy again. The installer starts a detached loopback server, adds a dedicated `cheatingkit` model provider and selected model to Codex's configuration, and records the previous values for restoration. The local provider disables WebSockets because this route serves HTTP Responses requests and SSE streams. Restart Codex after installing or removing the route. The upstream provider must implement `/v1/responses` for both normal and streaming requests. A Chat Completions-only provider cannot serve this Codex route without a cross-protocol adapter. Optional corpus-backed analysis is configured with `ck proxy analysis setup`; [issue #10](https://github.com/matthewdonsemail-lab/cheatingkit/issues/10) tracks additional adapters.

### Claude Code provider proxy preview

Set `ANTHROPIC_API_KEY` in the terminal that runs CheatingKit, then run `ck proxy setup claude`. This stores the environment variable name in a separate Anthropic profile, starts the local server, and sets `env.ANTHROPIC_BASE_URL` in Claude Code's user settings. Restart Claude Code. Requests to `/v1/messages` and `/v1/messages/count_tokens` are relayed to `https://api.anthropic.com/v1`, including system instructions, conversation turns, tools, images, and streaming events. The proxy substitutes the provider key, relays HTTP errors, and cancels upstream work when the client disconnects. `ck proxy remove claude` restores the prior setting; `ck proxy stop` stops the server. The Anthropic and Codex routes have separate provider settings and can share the local server. This route does not translate Codex Responses requests into Anthropic Messages.

### Hermes provider proxy preview

Run `ck proxy setup hermes` to select a provider that implements OpenAI Chat Completions at `/v1/chat/completions`, its model ID, and an API key environment variable (blank for a keyless local endpoint). CheatingKit stores a separate Hermes provider profile and changes Hermes's `model.provider`, `model.default`, `model.base_url`, and `model.api_mode` to use the loopback server. Restart Hermes. The route relays its conversation, tool definitions, HTTP errors, and streaming response in Chat Completions format. `ck proxy remove hermes` restores those previous model settings while preserving unrelated config edits. This route can run alone or beside Codex and Claude Code routes. It does not translate a Chat Completions request into Responses or Anthropic Messages.

`ck proxy analysis setup` configures one optional separate Responses-compatible analysis model for the local routes. Analysis is off by default. When enabled, it receives the latest eligible plain user message, bounded plain-text conversation history, and source-linked local corpus evidence; tool and media payloads are excluded from the analysis input. `suggest` records proposed wording and forwards the original request. `apply` changes only the latest eligible user text before the task provider request. The task provider, previous turns, tools, and stream setting remain in place. An analysis failure forwards the original request. Claude token-count requests and multipart Hermes user messages remain unchanged. Use `ck proxy analysis last` to inspect the latest decision. Restart the proxy after changing analysis settings.

## Updates

```sh
ck updates
ck update --apply
```

The default track is stable. You can also rerun the [website installer](https://cheatingkit.com/docs/releases) to install npm's current `latest` version. Your local configuration and database remain in place. See [Releases and installation](https://cheatingkit.com/docs/releases) for nightly and pinned versions.

## Documentation

- [Getting started](https://cheatingkit.com/docs/getting-started)
- [Releases and installation](https://cheatingkit.com/docs/releases)
- [How it works](https://cheatingkit.com/docs/how-it-works)
