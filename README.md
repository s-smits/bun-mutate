# bun-mutate

Fast, zero-config mutation testing for Bun and TypeScript.

`bun-mutate` generates syntactic TypeScript AST mutants, selects the relevant tests via runtime import-hop analysis, and runs a two-stage execution engine: **in-process mutant schemata** for pure `bun:test` suites, falling back automatically to a **process-isolated CoW/hardlink pool** for stateful or subprocess-spawning suites.

## Quickstart

```sh
# Install dependencies
bun install

# Mutate only lines changed since your default branch (origin/main, origin/master, main, or master)
bun run src/cli.ts diff

# Or once installed on PATH / linked as a bin:
bun-mutate diff

# Mutate a specific file or every discovered source file
bun-mutate run src/math.ts
bun-mutate run

# Inspect mutant counts before running
bun-mutate list --diff

# Re-check only previously surviving and unread mutants
bun-mutate run src/math.ts --only .bun-mutate/run-worktree/survivors.ids.txt
```

## Zero-Config Repository Inference

Without any configuration file, `bun-mutate` inspects the target repository:

- **Source roots:** reads `tsconfig.json` (`compilerOptions.rootDir`, `include`), `package.json` (`exports`, `main`, `module`, `bin`), and standard layouts (`src`, `lib`, `app`, `packages/*/src`, `tools`), excluding `node_modules`, `dist`, `build`, `.git`, `vendor`, test files, and `*.d.ts`.
- **Tests and path aliases:** discovers `*.test.*` and `*.spec.*` files across the tree, loads `tsconfig.json` `compilerOptions.paths` / `baseUrl` and `package.json` `imports`, transpiles away `import type` and `export type` edges, and selects runtime importers (direct 1-hop importers first, plus string-literal path mentions, with transitive fallback when no direct importer exists).
- **Default git base:** `bun-mutate diff` and `--diff` without an argument resolve `origin/main`, `origin/master`, `main`, or `master` automatically and mutate only the changed lines in the diff.

## How the Two-Stage Engine Works

### Stage 1: In-Process Mutant Schemata

Pure single-file `bun:test` suites (no filesystem writes, subprocesses, module mocks, env mutations, or network calls) are screened without cloning the repository:

1. **Linear-size AST meta-mutant:** rewrites function-body operators, negations, literals, `if` statements, and `?:` conditionals into a single meta-mutant file. Top-level initialisers and chained short-circuit expressions (`&&`, `||`, `??`) are excluded so module evaluation and operator precedence remain identical to plain text edits.
2. **Parallel 1× probe:** loads the meta-mutant via `Bun.plugin` and runs each `it()` once unmutated. If any mutant site executes at module import time, the suite aborts cleanly and falls back to Stage 2. Otherwise the probe records exact per-`it()` reachability and orders covering tests fastest-first.
3. **Sharded execution with safety checks:** suites are ranked by `coveredMutants / baselineMs`, work is sharded across CPU cores, an external `SIGKILL` watchdog marks infinite loops as `unread` and respawns the shard, and every killed mutant re-runs its failing test unmutated to detect state leakage.

### Stage 2: Process-Isolated Pool

Any mutant or suite not settled by Stage 1 runs in isolated repository clones:

- **Fast clones:** uses APFS Copy-on-Write (`cp -cRp`) on macOS and hardlinks (`cp -al`) on Linux, symlinking `node_modules` and unlinking target files before writing so the source checkout is never modified.
- **Subprocess-aware LCOV pruning:** collects baseline LCOV coverage to skip suites that do not execute a mutant's line. Suites that spawn child processes (`Bun.spawn`, `spawnSync`, `child_process`, etc.) bypass LCOV pruning while keeping baseline pass and timing caches.
- **Lead-first + combined `--bail`:** runs the highest-efficiency suite first, then batches remaining single-file suites with `bun test --bail`, re-verifying blamed kills solo and falling back to solo execution on ambiguity or timeout.
- **Adaptive concurrency and timeouts:** scales per-process `--max-concurrency` from `1` under full worker saturation up to `4` as the tail drains, and qualifies each baseline suite unmutated on demand before trusting any kill.

## CLI Reference

| Command / Flag | Description |
| --- | --- |
| `bun-mutate diff [base]` | Mutate changed lines since `[base]` (or auto-detected default branch). Exits `3` if survivors, unread mutants, or untested changed files remain. |
| `bun-mutate run [files...]` | Mutate specified files or all discovered source files. |
| `bun-mutate list [files...]` | Print per-file mutant counts (supports `--diff [base]`). |
| `bun-mutate report <jsonl...>` | Print per-file `killed / survived / unread` table and clustered `file:line` survivors. |
| `--root <dir>` | Repository root (defaults to current working directory). |
| `--diff [ref]` | Restrict mutants to lines changed since `<ref>`. |
| `--out <jsonl>` | Append results to `<jsonl>` and resume past already-recorded mutant IDs. |
| `--out-dir <dir>` | Directory for `results.jsonl`, `report.md`, and `survivors.ids.txt`. |
| `--suites <json>` | Explicit JSON map `{ "suiteName": ["test/foo.test.ts"] }`. |
| `--only <file>` | Run only mutant IDs listed in `<file>` (emits a warning if offsets went stale). |
| `-j, --jobs, --concurrency <n>` | Parallel worker cap (default: `min(8, CPU cores)`). |
| `--timeout <s>` | Wall-clock timeout cap per suite/mutant in seconds (default: `300`). |
| `--all` | Run every suite even after a kill (default stops at the first kill). |
| `--no-prune` | Disable Stage 1 schemata and Stage 2 LCOV pruning. |
| `--no-schemata` | Skip Stage 1 and run every suite in the process-isolated pool. |
| `--cov-cache <dir>` | Persist baseline pass durations and LCOV files between runs. |
| `--clones <prefix>` | Reuse clean-tree clone directories across runs instead of temporary clones. |
| `--until <ISO\|HH:MM>` | Stop dispatching new mutants after the deadline; re-run to resume. |
| `--old <suite>` / `--survivors` | Compare an old suite against newer suites or list surviving + unread IDs. |

## Honesty and Mutation Rot

- **Strict verdicts:** a mutant is reported as `survived` only when every suite returned a clean pass (`false`). Any timeout, hang, crash, or unexecuted suite (`null`) without a confirmed kill (`true`) is reported as `unread`, never as a survivor or a kill.
- **Unmutated baseline refusal:** if any suite fails unmutated (whether lead or secondary), execution stops and refuses the run rather than recording false kills.
- **Stale `--only` IDs:** mutant IDs embed byte offsets (`file:offset:operator`). When source lines move between recording `survivors.ids.txt` and re-checking, `bun-mutate` prints an explicit warning naming how many IDs matched no current mutant.
- **Clustered triage:** survivors are grouped by `file:line` with operator counts and source snippets so repeated mutations on one untested branch surface as a single item rather than noise.

## License

MIT
