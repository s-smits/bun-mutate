# bun-mutate

Fast, zero-config mutation testing for Bun and TypeScript.

`bun-mutate` generates TypeScript AST mutants, selects relevant tests via runtime import-hop analysis, and runs a hybrid engine: **in-process mutant schemata** for pure and stateful `bun:test` suites, falling back automatically to an **isolated clone pool** for subprocess-spawning suites, unencoded sites, and timeouts.

## Performance on a Real Codebase ([s-smits/anabasis](https://github.com/s-smits/anabasis))

Measured zero-config on a 12-core Apple Silicon laptop against [s-smits/anabasis](https://github.com/s-smits/anabasis) (467 TypeScript source files, 161 test files, `#` subpath imports, mixed pure unit, stateful filesystem, and subprocess integration suites):

| Workload | Scope | Time | Notes |
| --- | --- | --- | --- |
| **End-to-end kernel suite** (`compare.ts`, `reports.ts`, `scheduler.ts`, `climb.ts`) | **1,205 mutants**, 26 suites (`--jobs 5`, shared host) | **24m 05s** | **970/1,205 (80.5%)** settled in-process; **988 killed / 210 survived / 7 unread (82.5%)**; **915/915** exact parity vs prior engine |
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
bun-mutate run src/math.ts --only .bun-mutate/run-worktree/survivors.ids.txt
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
- **Lead-first + combined `--bail`:** runs the highest-efficiency suite first, batches remaining suites under `bun test --bail`, and re-verifies blamed kills solo.

## CLI Reference

| Command / Flag | Description |
| --- | --- |
| `bun-mutate diff [base]` | Mutate changed lines since `[base]`. Exits `3` on survivors, unread mutants, or untested changed files. |
| `bun-mutate run [files...]` | Mutate specified files or all discovered source files. |
| `bun-mutate list [files...]` | Print per-file mutant counts (supports `--diff [base]`). |
| `bun-mutate report <jsonl...>` | Print per-file `killed / survived / unread` table and clustered `file:line` survivors. |
| `--root <dir>` | Repository root (default: current working directory). |
| `--diff [ref]` | Restrict mutants to lines changed since `<ref>`. |
| `--out <jsonl>` / `--out-dir <dir>` | Resume-safe JSONL output (`results.jsonl`, `report.md`, `survivors.ids.txt`). |
| `--suites <json>` / `--only <file>` | Explicit suite map or mutant ID filter (warns on stale byte offsets). |
| `-j, --jobs <n>` / `--timeout <s>` | Parallel worker cap (`min(8, cores)`) and per-suite timeout cap (`300s`). |
| `--all` / `--no-prune` / `--no-schemata` | Disable stop-at-kill, coverage pruning, or in-process schemata. |
| `--cov-cache <dir>` / `--clones <prefix>` | Reuse mtime-validated coverage caches or clean clone directories. |
| `--depth <n\|all>` / `--until <ISO\|HH:MM>` | Import-hop depth (`1` + transitive fallback) and graceful deadline. |
| `--old <suite>` / `--survivors` / `-q` | Compare against a baseline suite, list survivor/unread IDs, or quiet progress. |

## Honesty & Verdicts

- **Strict separation:** `survived` requires a clean pass (`false`) from every suite; timeouts, crashes, and missing verdicts without a confirmed kill report as `unread` and stay out of the mutation score (`killed / (killed + survived)`).
- **Unmutated baseline refusal:** any suite that fails unmutated aborts the run rather than recording false kills.
- **Clustered triage:** survivors group by `file:line` with operator counts and source snippets.

## License

MIT
