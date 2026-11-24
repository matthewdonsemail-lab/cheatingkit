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
| `ck proxy setup` | Choose OpenAI, Anthropic, Agnes 3.0 Flash, or a compatible provider and model, then connect Codex. |
| `ck proxy setup claude` | Connect Claude Code to an Anthropic Messages-compatible API through the local relay. |
| `ck proxy setup hermes` | Choose a Chat Completions provider and model, then connect Hermes to the local relay. |
| `ck proxy start` / `ck proxy status` / `ck proxy stop` | Run and inspect the local provider relay. |
| `ck proxy run codex|claude|hermes -- [args]` | Ensure the relay is healthy, then launch the selected installed harness. |
| `ck proxy startup install|status|remove` | Opt in to a reversible Windows login launcher for the relay. |
| `ck proxy attempts [request ID]` | Inspect locally recorded proxy requests, analysis decisions, and observed outcomes. |
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

### Codex provider proxy

The proxy is a separate path from the prompt hooks. Run the interactive provider setup to choose OpenAI Responses, Anthropic Messages, Agnes 3.0 Flash, or a custom endpoint that implements the Responses or Chat Completions API. The Agnes choice prefills its Chat Completions base URL and `agnes-3.0-flash` model ID; both fields remain editable. Choose masked direct key entry, an environment variable, or a keyless local endpoint where supported. Direct keys are stored as plaintext in per-route files under `~/.cheatingkit/proxy-secrets/`, with owner-only permissions on Unix and an explicit current-user ACL on Windows. Profiles and status output contain only the credential source, never the key. Removing a route deletes its locally stored direct key and profile, then restarts any remaining configured routes. Environment-variable credentials are never stored. If Hermes already has a Chat Completions provider profile, Codex setup offers its URL, model, and key variable name as defaults; Codex saves a separate profile.

```sh
ck proxy setup
ck proxy status
ck proxy remove codex
ck proxy stop
```

If you choose an environment variable, set it before `ck proxy setup` and keep it available whenever the proxy starts. A direct key is read from its restricted local file on each start. The installer starts a loopback server, adds a `cheatingkit` model provider and selected model to Codex's configuration, and records the previous values for restoration. It disables WebSockets for the HTTP Responses route. Restart Codex after installing or removing the route. OpenAI and custom Responses providers must implement `/v1/responses`. The Anthropic choice translates supported Codex `/v1/responses` requests into Anthropic `/v1/messages`; the Chat Completions choice translates them into `/v1/chat/completions`. Both translate text, function calls, usage, errors, and streaming events back to Codex. They preserve instructions, conversation turns, supported images, and function tool calls and results. Chat translation flattens namespace tools for the provider and restores their namespace on return. The installer disables Codex hosted web search for translated routes and restores its previous setting on removal. Unsupported request features, including previous response IDs, opaque encrypted reasoning replay, non-image media, and built-in tool formats, return an explicit error. These routes do not provide reasoning-state continuity; `reasoning.summary: auto` is advisory and no summary is synthesized. Codex-only `client_metadata` is kept local. Optional corpus-backed analysis is configured with `ck proxy analysis setup`; [issue #10](https://github.com/matthewdonsemail-lab/cheatingkit/issues/10) tracks additional adapters.

### Claude Code provider proxy

Run `ck proxy setup claude` to choose an Anthropic Messages-compatible base URL (default `https://api.anthropic.com/v1`) and a direct or environment-variable key. This stores a separate Anthropic profile, starts the local server, and sets `env.ANTHROPIC_BASE_URL` in Claude Code's user settings. Restart Claude Code. Requests to `/v1/messages` and `/v1/messages/count_tokens` are relayed to the chosen URL, including system instructions, conversation turns, tools, images, and streaming events. In explicit provider credential mode the proxy substitutes the provider key, relays HTTP errors, and cancels upstream work when the client disconnects. `ck proxy remove claude` restores the prior setting; `ck proxy stop` stops the server. The native Claude route and the Codex-to-Anthropic translation route have separate provider settings and can share the local server.

### Hermes provider proxy

Run `ck proxy setup hermes` to select a provider that implements OpenAI Chat Completions at `/v1/chat/completions`, its model ID, and a direct key, environment variable, or keyless local endpoint. CheatingKit stores a separate Hermes provider profile and changes Hermes's `model.provider`, `model.default`, `model.base_url`, and `model.api_mode` to use the loopback server. Restart Hermes. The route relays its conversation, tool definitions, HTTP errors, and streaming response in Chat Completions format. `ck proxy remove hermes` restores those previous model settings while preserving unrelated config edits. This route can run alone or beside Codex and Claude Code routes. It does not translate a Chat Completions request into Responses or Anthropic Messages.

`ck proxy analysis setup` configures one optional separate Responses or Chat Completions analysis model for the local routes. Select Agnes 3.0 Flash to prefill its Chat Completions base URL and model ID, or enter another provider's API format, base URL, and model ID. Then choose a masked direct key, an environment variable, or a keyless local endpoint where supported. Its credential is separate from task provider credentials. Analysis is off by default. When enabled, it receives the latest eligible plain user message, bounded plain-text conversation history, and source-linked local corpus evidence; tool and media payloads are excluded from the analysis input. `suggest` records proposed wording and forwards the original request. `apply` proposes a replacement for the latest eligible user text. With the gate enabled it must pass independent validation in enforce mode before being forwarded; observe forwards the original bytes. With the gate off, legacy apply behavior changes the text directly. The task provider, previous turns, tools, and stream setting remain in place. An analysis failure forwards the original request. Claude token-count requests and multipart Hermes user messages remain unchanged. Use `ck proxy analysis last` to inspect the latest decision. Restart the proxy after changing analysis settings.

Each proxied model request gets a local request ID, returned in the `x-cheatingkit-request-id` response header. CheatingKit records the selected plain user text, optional proposal and evidence source IDs, harness, protocol, provider, model, HTTP status, stream completion, and a bounded assistant text excerpt in the same local SQLite database as imported sessions. `ck proxy attempts` shows recent records; use `--prompt "text"` to compare attempts containing that text, or pass a request ID for one record. Warning and refusal labels are observations from response text, not verified causes. Legacy attempt excerpts exclude tool/media payloads; the gate audit retains the original request body. Authentication headers are not recorded. Current model API requests do not normally carry CheatingKit's imported session/source IDs, so those timeline link fields are null unless the caller explicitly supplies `x-cheatingkit-session-id` and `x-cheatingkit-source-id` headers.

### Per-message gate

Every model request through the proxy is checked before forwarding. The default `observe` rollout records `allow`, `block`, or `needs_clarification` and forwards the original bytes. Configure the separate analysis provider with `ck proxy analysis setup`, then restart with `ck proxy start --gate-mode enforce` to enforce decisions. `--gate-mode off` disables evaluation and retains legacy analysis behavior. `CHEATINGKIT_GATE_MODE=off|observe|enforce` also selects the mode. Stop a running proxy before changing modes; status reports the active mode.

The gate retrieves source-linked local history, assesses scope and safety, and independently validates that proposed wording preserves every goal and constraint. At most two revisions can restore fidelity or clarify wording. Revisions never optimize for predicted provider acceptance. Enforced blocks, clarification requests, evaluator failures, malformed evaluator output, and unresolved fidelity make zero task-provider calls. Local responses use HTTP 403 for blocks and 422 for clarification. Without a configured analysis model, observe records an evaluator error and forwards; enforce blocks. Requests without eligible plain user text, including unsupported multipart messages, fail closed in enforce mode. Prompt hooks alone do not enforce this gate; the harness must use the proxy.

`ck proxy attempts [request ID]` includes `gateDecision`: the original request body, original/proposed text, retrieved evidence and source IDs, scope/validation results, every revision, and the termination reason. Request bodies (including any tool/media data they contain) are stored locally for this audit; authentication headers are never included. Provider `response.failed` codes and messages are retained, with cyber warnings labelled `potential_cyber_warning`, other provider failures `provider_error`, and transport failures `stream_error`.

Native relay credentials are preserved by default, even if a task-provider key is configured. The analysis key is used only for analysis calls. Codex Responses route installation enables OpenAI authentication for this native mode, following the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). For intentionally configured replacement providers, use `CHEATINGKIT_CREDENTIAL_MODE=provider` or `--credential-mode provider` on start/install to opt into task-provider credentials. Codex protocol translation continues to require the selected destination provider's credentials. Reinstall an existing Codex route to change its authentication setting.

### Proxy startup and recovery

After installing a harness route, use `ck proxy run codex -- [Codex arguments]` (or `claude` or `hermes`) to launch it. The command checks the loopback service before launching the harness, reuses a healthy instance, and starts a new instance when the saved process is stale. If startup fails, it reports the local proxy log path and does not launch the harness. It passes the harness exit code through. A proxy crash during an active model request can still fail that request; launch the harness again with `ck proxy run` to recover.

On Windows, `ck proxy startup install` adds an opt-in launcher to your user Startup folder so the proxy starts at login. `ck proxy startup status` checks it; `ck proxy startup remove` removes the unchanged launcher. The launcher runs the currently installed CheatingKit and Bun paths, so reinstall it if either path changes. Keys entered directly are loaded from their restricted local files at startup; environment variable keys must be available in the login environment. On macOS and Linux, use `ck proxy run` or your own login service; automatic login startup is not installed by this command. `ck proxy stop` stops the current process but leaves an installed login launcher in place.

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
