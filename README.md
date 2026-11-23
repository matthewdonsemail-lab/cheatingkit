# CheatingKit

CheatingKit indexes local Claude Code, Codex, and Hermes sessions in SQLite. The repository contains the website, documentation, and the Bun CLI that is staged as the `cheatingkit` npm package with the `ck` command.

## Run the current checkout

```sh
npm ci
npm run dev
bun run cli setup
bun run cli ingest
bun run cli sessions
bun run cli timeline
bun run cli label
bun run test:cli
npm run build
```

The docs start at `/docs`. The local config template is [cheatingkit.yaml](cheatingkit.yaml); setup writes `~/.cheatingkit/config.yaml` and creates `~/.cheatingkit/sessions.db`.

## Install a published version

Install [Bun](https://bun.sh/docs/installation), then use the version-controlled installer from this repository:

```sh
curl -fsSL https://raw.githubusercontent.com/matthewdonsemail-lab/cheatingkit/main/public/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/matthewdonsemail-lab/cheatingkit/main/public/install.ps1 | iex
```

Both scripts resolve npm's `latest` dist-tag to an exact published version, install that version, and verify `ck --version`. Set `CK_TRACK=next` for a nightly, or `CK_VERSION=X.Y.Z` to install a specific published version. No package is available until the first npm publication.

## Package and release

`npm run check:package` stages a publishable package in `.release/ck`, verifies `ck --version`, and inspects its npm pack contents. The root package stays private to npm, so the website and its development dependencies are not shipped with the CLI.

CI checks pushes and pull requests. After a successful push to `main`, release-please prepares a stable release PR; other successful main pushes publish nightlies. Merging the release PR creates a GitHub Release and publishes the same tagged source to npm's `latest` tag. Nightlies use npm's `next` tag and GitHub prereleases. The workflows require an `NPM_TOKEN` repository secret with permission to publish `cheatingkit`. The website serves `/install.sh` and `/install.ps1` for Bun-based installation.

See [Releases and installation](src/components/docs/content/releases.mdx) for the version sequence and update behavior. [Local context and search](src/components/docs/content/context-pipeline.mdx) describes the intended index and local-model pipeline; [Getting started](src/components/docs/content/getting-started.mdx) distinguishes the working commands from the complete specification.

## Contribution checks

`npm install` runs Lefthook's install step. Commits check CLI naming, model documentation, whitespace, and CLI tests; pushes run the full check and package verification. CLI directories, file names, values, and functions use camelCase; types and classes use PascalCase. Run `npm run docs:sync` after changing a pinned model, then `npm run check` and `npm run check:package` before pushing. The [code structure guide](src/components/docs/content/code-structure.mdx) explains the naming rules and ts-morph rename command.
