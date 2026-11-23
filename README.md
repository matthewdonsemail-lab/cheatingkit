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

## Package and release

`npm run stage:cli` creates a publishable package in `.release/ck`. Run `bun .release/ck/bin/ck.js --version` and `npm pack --dry-run --json ./.release/ck` to inspect it. The root package stays private to npm, so the website and its development dependencies are not shipped with the CLI.

CI checks pushes and pull requests. After a successful push to `main`, release-please prepares stable releases; other successful main pushes produce nightlies. Stable packages use npm's `latest` tag and nightlies use `next`. The release workflows need an `NPM_TOKEN` repository secret to publish. The website serves `/install.sh` and `/install.ps1` for Bun-based installation.

See [Releases and installation](src/components/docs/content/releases.mdx) for the version sequence and update behavior. [Local context and search](src/components/docs/content/context-pipeline.mdx) describes the intended index and local-model pipeline; [Getting started](src/components/docs/content/getting-started.mdx) distinguishes the working commands from the complete specification.

## Contribution checks

`npm install` runs Lefthook's install step. Commits check naming, model documentation, whitespace, and CLI tests; pushes check the site build. Run `npm run docs:sync` after changing a pinned model, then `npm run check` before pushing. The [code structure guide](src/components/docs/content/code-structure.mdx) explains the naming rules and ts-morph rename command.
