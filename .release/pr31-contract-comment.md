## Contract wiring verified on the installed path

The YAML contract now drives the code instead of sitting beside it. `validateAnalysisResult` runs on every rewrite and every gate stage, the transition map is the only route through the gate, and each decision and attempt records the contract `version` and `hash`. Unmapped outcomes fail closed with the allowed values named.

### Installed run (build `0.1.0.57`, commit `6d3f857`)

Native Codex, two real sessions, enforce mode, gate on.

| Session | Request | Gate | Stages | Revisions | Outcome |
|---|---|---|---|---|---|
| 1 (new task) | `3d748a84` | allow | scope, consistency, validate | 0 | `unchanged`, wording already clear |
| 1 part 2 | `c235ab52` | allow | scope, consistency, validate | 0 | `unchanged`, stream cut off mid-turn |
| 2 (`continue task 785ab0fb`) | `bc4c8d50` | allow | scope, consistency, validate | 2 | completed, wrote `result.txt` |

Every decision record carries `schema: {version: 1, hash: f0fcfecea829…}`, a bound task state and the injected task evidence. `result.txt` contains exactly `CONTINUITY_OK` with no trailing newline, and only that file was edited.

Contract rejection on the installed build:

```
rewrite  unchanged with proposedText  -> analysis_schema_invalid
rewrite  proposed with null text      -> analysis_schema_invalid
rewrite  unchanged with empty reason  -> analysis_schema_invalid
validate faithful: "true"             -> analysis_schema_invalid
scope    extra field                  -> analysis_schema_invalid
validate_unfaithful                   -> bounded_revision
```

### Behaviour changes found on the way

- Observe forwarded the original bytes even when the gate produced them, so a validated rewrite was dropped. It now forwards the analyzed body.
- A request the gate cannot evaluate because it has no user text (for example `{}`) blocked port-check requests in observe. It is now recorded and forwarded untouched, and still blocks in enforce.
- Client tests inherited the `CHEATINGKIT_GATE_MODE=enforce` from this shell, so they now clear it.
- `json_object` output was rejected by plain Responses endpoints because the input never said JSON, and the rewrite prompt still asked for plain text under a JSON contract. Both fixed.
- The analysis/provider separator refused two models on one host. A different model is now accepted; the identical model still fails.

165 → 169 tests, naming and package checks pass.

### Needs the restart

The installed run above used one-shot `codex exec` processes. Merging needs a restart of the interactive Codex session: the new code is installed and the proxy is running on `4178` in enforce mode, but the resident session still has the old route in memory.

@matt please restart Codex, then run one short task. I will confirm the restarted session appears in `ck proxy attempts` with schema version and hash before this leaves draft.
