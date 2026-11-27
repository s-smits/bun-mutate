# bun-mutate

Fast, zero-config mutation testing for Bun and TypeScript.

`bun-mutate` generates TypeScript AST mutants, selects relevant tests via runtime import-hop analysis, and runs a hybrid engine: **in-process mutant schemata** for pure and stateful `bun:test` suites, falling back automatically to an **isolated clone pool** for subprocess-spawning suites, unencoded sites, and timeouts.

## Performance on a Real Codebase ([s-smits/anabasis](https://github.com/s-smits/anabasis))

Measured zero-config on a 12-core Apple Silicon laptop against [s-smits/anabasis](https://github.com/s-smits/anabasis) (467 TypeScript source files, 161 test files, `#` subpath imports, mixed pure unit, stateful filesystem, and subprocess integration suites):

| Workload | Scope | Time | Notes |
| --- | --- | --- | --- |
| **End-to-end kernel suite** (`compare.ts`, `reports.ts`, `scheduler.ts`, `climb.ts`) | **1,205 mutants**, 26 suites (`--jobs 5`, shared host) | **20m 07s** | **976/1,205 (81.0%)** settled in-process (`7m 14s`); **988 killed / 210 survived / 7 unread (82.5%)**; **1,205/1,205** exact parity |
| Pure-suite modules (`prompt.ts`, `names.ts`) | 49 mutants, 2 suites (`--jobs 12`) | **1.2 s** | **40.8 mutants/s** (46/49 settled in-process in 0.7 s) |
| Stateful isolated suite (`seat-fork.ts`) | 140 mutants, 1 suite (`--jobs 12`) | **10.5 s** | **13.3 mutants/s** across APFS CoW clones + LCOV pruning |
| Whole-repo AST scan & test index | 467 source files (44,147 mutants), 161 test files | **0.79 s** | Auto-discovered roots, transpiled runtime edges, `#` & `tsconfig` aliases |

## Quickstart

```sh
bun install

# Mutate only lines changed since your default branch (origin/main, origin/master, main, or master)
bun run src/cli.ts diff

# Or once installed on PATH / linked as a bin:
bun-mutate diff
bun-mutate run src/math.ts
bun-mutate list --diff
bun-mutate run --recheck .bun-mutate/run-worktree/results.jsonl
```

## Zero-Config Repository Inference

- **Source roots:** reads `tsconfig.json` (`compilerOptions.rootDir`, `include`), `package.json` (`exports`, `main`, `module`, `bin`), and standard layouts (`src`, `lib`, `app`, `packages/*/src`, `tools`), respecting `.gitignore` and excluding build output, `vendor`, tests, and `*.d.ts`.
- **Tests and path aliases:** discovers `*.test.*` / `*.spec.*` files, resolves `tsconfig` paths and `package.json` `imports`, transpiles away `import type` edges, and ranks direct pure unit suites ahead of stateful and subprocess suites (with path-literal mentions and transitive fallback).
- **Diff mode:** `bun-mutate diff` auto-detects the default branch and mutates only changed lines.

## How the Engine Works

### In-Process Mutant Schemata

Runs single-file `bun:test` suites (both pure and stateful) without per-mutant process spawns:

- **Linear-size AST meta-mutant:** encodes operators, negations, literals, `if` statements, `?:` conditionals, and precedence-safe short-circuit chains (`&&`, `||`, `??` via thunks) into one module, excluding top-level initialisers and regrouping chains so semantics match plain text edits.
- **Full `bun:test` compatibility & isolation:** shims `beforeAll`/`afterAll`/`beforeEach`/`afterEach`, `.each`/`.skip`/`.todo`/`.if`/`.skipIf`/`.todoIf`/`.failing`, `spyOn`/`mock`/`jest`, and restores `process.env` and mocks between mutants. Pure suites run in-place with zero clones; filesystem-writing stateful suites lazily reuse CoW clones.
- **Per-test probing & hot re-import:** a 1× probe records exact per-test and import-time reachability, settles uncovered mutants in `0 ms`, and uses query-string re-import for import-time hits or order-dependent stateful suites.
- **Fail-closed safety:** an external `SIGKILL` watchdog hands hangs to isolated execution, and every kill re-runs unmutated to detect cross-mutant state leakage.

### Isolated Clone Pool

Handles subprocess-spawning suites, unencoded sites, and schemata handoffs:

- **Fast clones:** APFS Copy-on-Write (`cp -cRp`) on macOS and hardlinks (`cp -al`) on Linux, skipping gitignored directories and symlinking `node_modules`.
- **Lazy LCOV & subprocess reachability pruning:** collects LCOV coverage for non-subprocess suites and runs one source-instrumented baseline pass across parent + child processes for subprocess suites (failing closed to unpruned baseline on any error).
- **Lead-first + wave-chunked `--bail`:** runs the highest-efficiency suite first, chunks remaining suites into duration-bounded `bun test --bail` waves so large suite sets do not overflow combined timeouts, and re-verifies blamed kills solo.
- **Resilient baseline qualification:** scales combined qualification timeouts by suite count, bisects failing groups in `O(log N)` steps, and retries transient parallel-load refusals once before isolating the failing suite.

## CLI Reference

| Command / Flag | Description |
| --- | --- |
| `bun-mutate diff [base]` | Mutate changed lines since `[base]`. Exits `3` on unanswered survivors, unread mutants, or untested changed files. |
| `bun-mutate run [files...]` | Mutate specified files or all discovered source files. |
| `bun-mutate list [files...]` | Print per-file mutant counts (supports `--diff [base]`). |
| `bun-mutate report <jsonl...>` | Print per-file `killed / survived / unread` table and clustered `file:line` survivors. |
| `--root <dir>` | Repository root (default: current working directory). |
| `--diff [ref]` | Restrict mutants to lines changed since `<ref>`. |
| `--out <jsonl>` / `--out-dir <dir>` | Resume-safe JSONL output (`results.jsonl`, `report.md`, `survivors.ids.txt`). |
| `--suites <json>` / `--only <file>` | Explicit suite map or mutant ID filter (warns on stale byte offsets). |
| `-j, --jobs <n>` / `--timeout <s>` | Parallel worker cap (`min(8, cores)`) and per-suite timeout cap (`300s`). |
| `--all` / `--no-prune` / `--no-schemata` | Disable stop-at-kill, coverage pruning, or in-process schemata. |
| `--no-typecheck` | Leave survivors unscreened by `tsc`. |
| `--cov-cache <dir>` / `--clones <prefix>` | Reuse mtime-validated coverage caches or clean clone directories. |
| `--depth <n\|all>` / `--until <ISO\|HH:MM>` | Import-hop depth (default `all`, every test that reaches the file; `1` = direct importers + transitive fallback) and graceful deadline. |
| `--old <suite>` / `--survivors` / `-q` | Compare against a baseline suite, list survivor/unread IDs, or quiet progress. |
| `--recheck <jsonl>` | Rerun an earlier run's unanswered survivors and unread mutants at the current tree, re-anchored by source line and operator; exits `3` while any remain. |
| `--answers <tsv>` | Ledger of answered survivors (default `answered-survivors.tsv` at the root; see below). |

## Honesty & Verdicts

- **Strict separation:** `survived` requires a clean pass (`false`) from every suite; timeouts, crashes, and missing verdicts without a confirmed kill report as `unread` and stay out of the mutation score (`killed / (killed + survived)`).
- **Unmutated baseline refusal:** any suite that fails unmutated is isolated and reported rather than recording false kills.
- **Clustered triage:** survivors group by `file:line` with operator counts and source snippets. Each result row records the suites that ran with its mutant active (`reached`; the rest skipped it because their coverage never reaches the line), and each cluster names them: a line some suite runs wants an assertion in one of them, and a line no suite reaches is a deletion candidate or wants an end-to-end entry point.
- **Baseline retry:** a suite that fails unmutated under parallel load gets one retry at one worker and twice its wall before it is skipped.
- **Rows carry their source line:** each result row records the trimmed line its mutant sat on, so the report, the ledger and `--recheck` read the line as it was when the mutant ran, not whatever sits at that line number after later edits.
- **Typecheck screen:** when the root has `tsconfig.json` and `node_modules/typescript`, every survivor is screened once more through `tsc --noEmit` (incremental, in one clone) and recorded as killed under `typecheck` when its mutated tree fails to compile, as a removed narrowing guard does. Unused and unreachable diagnostics (`TS6133`, `TS6196`, `TS7027` and their kin) do not count, since they flag dead code a mutant left behind rather than a change in behaviour. If the unmutated tree already fails `tsc`, survivors stay unscreened. Library callers opt in with `typecheck: true`; the CLI screens by default.
- **Awake for the run:** on macOS the run holds an idle-sleep assertion (`caffeinate -i -w <pid>`) until it exits. A closed lid on battery still sleeps the machine; mutants it interrupts read as unread, never as kills, and `--recheck` reruns them.

## Triaging Survivors (Simplify Before Testing)

Treat a mutation sweep as both a **production and test simplification pass**, not a raw kill-rate chase. Before writing a test for a surviving cluster, audit it in order:

1. **Is the production implementation bad, redundant, or over-engineered?** Surviving mutants frequently expose dead guards, unused sorting or tracking fields whose order no caller observes, duplicate lookups, or unreachable fallbacks. Simplifying or deleting the production code eliminates entire survivor clusters cleanly.
2. **Is it a real defect or an inert test?** Fix live bugs structurally at their owning boundary, or repair an existing test fixture that short-circuited before reaching the branch it meant to exercise.
3. **If no existing test surfaced this, is the behaviour—or the surrounding test—earning its keep?** When inspecting a survivor exposes duplicated cases, synthetic stubs, or narrow tests on incidental details, trim or consolidate weak test parts rather than layering more tests on top.
4. **Pin only genuinely load-bearing invariants.** Prefer property, table, or end-to-end checks over narrow unit tests; retire proved equivalents and arid logging/formatting branches without adding tests, then confirm with `--recheck <out-dir>/results.jsonl`.

### Rechecking After Edits

A survivor is pinned by a test edit, which a `--diff` run never revisits, since `--diff` mutates changed source lines only. Mutant IDs are byte offsets, so `--only` goes stale as soon as anything above the line moves. `--recheck <results.jsonl>` takes the earlier run's survivors and unread mutants, finds each at the current tree by its recorded source line and operator (nearest its old line), and runs only those, writing fresh results to `.bun-mutate/recheck-<head>/`. Rows whose line was since changed or deleted are counted as gone; a `--diff` against the earlier run's commit mutates their new text. Answered survivors are skipped.

```sh
bun-mutate diff main                                   # survivors on changed lines
# delete, simplify, add assertions, answer equivalents ...
bun-mutate run --recheck .bun-mutate/diff-<head>/results.jsonl
```

### Equivalents That Recur

These shapes survived real sweeps and were either proved equivalent or deleted as redundant:

- **Tie-breaks on a stable sort.** `toSorted((a, b) => a.key - b.key || a.index - b.index)` breaks ties by the original index, which a stable sort already keeps: delete the tie-break and its `index` field.
- **Loop starts the first turn forces.** `let [wins, losses] = [0, 0]` where zero wins can never satisfy the loop's test survives `0 -> 1` on `wins`: the first turn moves it to 1 either way. Answer it `equivalent`, citing the test that rules zero out.
- **Unit conversions in waits.** `seconds * 1000 -> 1001` only stretches a timer by a thousandth. Answer it `equivalent` unless a boundary test reads that edge.
- **Read narrowing that only saves work.** A flag that skips parsing some records before a fold survives when it is forced on, because reading everything is always correct. Answer it `equivalent` and say what the narrowing saves.
- **A guard a single owner already enforces.** A catch around a write the owner's lock already refuses, or a limit check repeated before the owner's own abort, survives deletion. Delete the guard rather than pin it, and name the owner in the commit.

## Answered Survivors

Some survivors are not worth a test. Record each in `answered-survivors.tsv` at the repository root, one tab-separated row per mutant under a `path\tlabel\tsource\tkind\treason` header, where `source` is the trimmed source line and `kind` is one of:

- `equivalent`: the mutant changes nothing observable;
- `presentation`: it changes only printed wording or layout;
- `unit-only`: it sits on a guard worth keeping that no table, property check or end-to-end flow can reach, so only a narrow unit test with stubs could kill it.

The reason must be a sentence a reviewer can check. Answered survivors drop out of the report's clusters, the recheck IDs and the exit code, while the totals still count them. Rows match by source text, so line shifts keep an answer and any edit to the line retires it. A full `run` (no explicit files, no `--diff`) lists answers that no longer match a survivor in a mutated file, so the ledger stays current.

## Agent Skill

`bun-mutate` bundles a standalone skill describing the commands, the simplify-first triage funnel, and the `answered-survivors.tsv` ledger at both standard ADE locations:

- `.agents/skills/bun-mutate/SKILL.md` (Antigravity, Codex, OpenCode, Cursor, and other `.agents`-compatible ADEs)
- `.claude/skills/bun-mutate/SKILL.md` (Claude Code)

ADEs read skills from the repository, not from `node_modules`, so a consuming project copies them in after installing:

```sh
bun add -d github:s-smits/bun-mutate
for d in .claude .agents; do mkdir -p $d/skills && cp -R node_modules/bun-mutate/$d/skills/bun-mutate $d/skills/; done
```

## License

MIT
