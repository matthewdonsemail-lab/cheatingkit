# CheatingKit

**Give coding agents the context of your earlier work, at the next prompt.**

CheatingKit indexes your local Claude Code, Codex and Hermes sessions, then supplies source-linked evidence to the harness from a local Bun CLI. Your session index stays on your machine.

[Quick start](#quick-start) · [The RLM environment](#the-rlm-environment) · [Documentation](https://cheatingkit.com/docs)

## See it work

```text
you       →  "continue the loader issue"
ck hook   →  "Earlier request [codex/s1#12]: fix loader.dll startup crash
              Later message [codex/s1#18]: patch it, not just inspect
              Observed warning [codex/s2#7]: cannot assist with binary patching"
Codex     →  request with that evidence, unchanged wording
ck proxy  →  decision recorded with the source IDs it used
```

## Quick start

Install [Bun](https://bun.sh/docs/installation), then:

```sh
curl -fsSL https://cheatingkit.com/install.sh | sh
```

Or on Windows PowerShell:

```powershell
irm https://cheatingkit.com/install.ps1 | iex
```

```sh
ck setup        # find sessions, create the index, install hooks
ck index        # import new turns and refresh the search index
ck context --prompt "continue the loader issue"
ck sessions
ck timeline
```

Hooks import new records before each prompt. Build the index before relying on context. Restart your harness after installing hooks.

## The RLM environment

A prompt can go into a persistent workspace instead of straight to a provider. The request is rewritten against your own indexed history in parallel rounds; recorded warnings are shaped by local models, and the auditor keeps a candidate only if it still outlines the goal in neutral wording.

```sh
ck repl open --goal "..."
ck repl round --id <replId> --require "rewritten prompt" --limit 2
ck repl state --id <replId>
```

It is also reachable through MCP (`repl_open`, `repl_exec`, `repl_take`, `repl_close`), so a harness is the only way in. Full contract: [The RLM environment](https://cheatingkit.com/docs/repl).

## What else is here

| Task | Command | Guide |
| --- | --- | --- |
| Check a request before it is sent | `ck proxy setup`, `ck proxy status` | [The gate](https://cheatingkit.com/docs/gate) |
| Preview context without a harness | `ck context --prompt "..."` | [Context and search](https://cheatingkit.com/docs/models/context-pipeline) |
| Inspect indexed sessions | `ck sessions`, `ck timeline`, `ck areas` | [Harnesses](https://cheatingkit.com/docs/harnesses) |
| Serve context over MCP | `ck mcp` | [Plugins and MCPs](https://cheatingkit.com/docs/harnesses/plugins-and-mcps) |

## Documentation

Start at [cheatingkit.com/docs](https://cheatingkit.com/docs). The pages cover the
[gate](https://cheatingkit.com/docs/gate), [context pipeline](https://cheatingkit.com/docs/models/context-pipeline),
[RLM environment](https://cheatingkit.com/docs/repl), [local models](https://cheatingkit.com/docs/models),
[database](https://cheatingkit.com/docs/database), and [code structure](https://cheatingkit.com/docs/code-structure).

## Contributing

`npm install` installs the hooks. Commits check naming, docs, whitespace and CLI tests; pushes build the site. Run `npm run check` before pushing. The [code structure guide](https://cheatingkit.com/docs/code-structure) explains the naming rules.
