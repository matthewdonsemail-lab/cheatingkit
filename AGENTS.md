# Repository workflow

## Install and verify before merging

- Every behavior change must be installed locally from the candidate branch and tested through the installed application before it can merge to `main`.
- Unit tests, builds, package checks, and CI are required where applicable, but do not replace installed end-to-end verification.
- For harness integrations, preserve the user's native authentication and test the real request path, including the resulting local decision/attempt records.
- After installing changes that need a harness/application restart, explicitly prompt the user to restart. Explain what takes effect and what verification remains.
- Keep the PR unmerged until restart-dependent verification is complete. Record the installed commit/build, test performed, observed result, and any remaining limitation in the PR description.
- Use an isolated worktree when another agent is working in the repository. Never discard another agent's uncommitted changes to reconcile a branch.
