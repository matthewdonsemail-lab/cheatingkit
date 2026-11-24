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
| `ck mcp` | Serve the same local context through MCP. |
| `ck sessions` | List imported sessions and their current model. |
| `ck timeline` | Inspect recorded session events and model changes. |
| `ck label` | Run the configured local model over imported messages. |
| `ck areas` | Summarize labels after messages have been labeled. |
| `ck leadups` | Inspect messages preceding recorded warnings. |

Claude Code and Codex use `UserPromptSubmit` hooks. Hermes uses a `pre_llm_call` plugin. Existing hooks are preserved. Restart each harness after installing hooks; Codex may ask you to trust the new hook definition. CheatingKit supplies prior evidence alongside the current prompt and does not change what you typed.

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
