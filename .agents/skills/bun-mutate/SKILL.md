---
name: bun-mutate
description: "Use when running mutation testing with bun-mutate, triaging surviving or unread mutants, simplifying redundant production or test code exposed by survivors, recording answered survivors in answered-survivors.tsv, or re-verifying kills after edits."
---

# bun-mutate

Fast, zero-config mutation testing for Bun and TypeScript. Treat every mutation sweep equally as a **production and test simplification pass**, not a raw kill-rate chase: delete bad or over-defensive production code first, trim weak tests, pin only genuinely load-bearing invariants, and record non-error survivors in `answered-survivors.tsv`.

## Commands

```sh
# Mutate only lines changed since the default branch (or <ref>)
bun-mutate diff [base]

# Mutate explicit files or the whole discovered repository
bun-mutate run [files...]

# Preview mutant counts without running tests
bun-mutate list [--diff [base]] [files...]

# Re-run an earlier run's open survivors and unread mutants after edits, re-anchored by source line
bun-mutate run --recheck .bun-mutate/<run>/results.jsonl

# Summarise recorded JSONL rows (solo or comparative against --old <suite>)
bun-mutate report <results.jsonl...> [--old <suite>] [--survivors]
```

Key flags:
- `--out-dir <dir>` / `--out <jsonl>`: resume-safe JSONL output (`results.jsonl`, `report.md`, `survivors.ids.txt`). Unrun mutants stay unrecorded so rerunning the same command resumes cleanly.
- `--answers <tsv>`: answered-survivor ledger path (defaults to `answered-survivors.tsv` at the repository root).
- `--depth <n|all>`: import-hop test selection depth (default `all`, every test that reaches the file; `1` = direct importers with transitive fallback).
- `-j, --jobs <n>` / `--timeout <s>` / `--until <ISO|HH:MM>`: worker cap, per-suite wall timeout, and graceful deadline.
- Exit code `3` on `diff` (or `--fail-on-survivors`) signals unanswered survivors, `unread` mutants, or untested changed files.

## Four-Stage Survivor Triage Funnel

Never chase raw survivor counts by adding isolated unit tests with synthetic stubs. Work strictly in order on each `file:line` cluster in `report.md`:

1. **Read the suite routing first (`reached` vs unreached).**
   Each cluster in `report.md` names the suites that actually ran with the mutant active:
   - *Ran under named suites*: those tests already execute the line without distinguishing the mutation — audit the code first, then add an assertion to one of those existing flows if the behaviour is load-bearing.
   - *No suite reaches its line*: treat the line as a deletion candidate first, or reach it through a real end-to-end entry point.
   - *`unread` rows*: never treat a timeout, crash, or missing verdict as a kill or a survivor; fix the hang/flake and re-run to a real verdict (`killed` or `survived`).

2. **Audit production code and test value before writing any test.**
   Inspect each surviving expression inside its full enclosing function, callers, and covering suites, and classify in order:
   - **Live defect or inert test:** production logic is wrong today, or an existing test fixture short-circuits before reaching the branch it claims to cover. Fix the bug at its owning boundary, or repair/prune the inert fixture.
   - **Redundant or over-engineered production code:** dead guard, unreachable fallback (`?? default` that never triggers), duplicate lookup, unused sort or tracking field, or awkward control flow. Delete or simplify the production code so the entire survivor cluster disappears cleanly.
   - **Load-bearing unpinned invariant:** genuinely important logic (correctness, state transitions, boundaries, refusals, security/path checks). Close the subsuming invariant for the whole cluster in preference order:
     1. **Property, bounded exhaustive, or table checks** over an input space against an independent rule.
     2. **Live end-to-end or boundary flows** by adjusting a real fixture input or step in an existing suite.
     3. **No narrow stubbed unit tests:** if only mocks, stubs, or hand-built internals can reach a guard worth keeping, keep the code and record it as `unit-only` in `answered-survivors.tsv` instead of adding brittle test boilerplate.
   - **Presentation or arid surface:** CLI wording, formatting, advisory prose, logging (already skipped), or layout constants. Write no test; record it as `presentation`.
   - **Proved equivalent mutant:** identical observable behaviour on all reachable inputs (e.g. `<` vs `<=` between distinct event indices, `-1 -> -2` sentinel compared only against non-negative indices, concurrency pool widths, cache/fast-path guards). Write no test; record it as `equivalent`.

3. **Record non-error survivors in `answered-survivors.tsv`.**
   Keep one tab-separated ledger at `answered-survivors.tsv` at the repository root (pass `--answers <path>` to store it elsewhere):

   ```tsv
   path	label	source	kind	reason
   src/example.ts	< -> <=	if (a < b) return 0;	equivalent	a and b are distinct log indices and can never be equal
   ```

   Columns:
   - `path`: repository-relative file path.
   - `label`: exact mutation operator printed by `report.md` (e.g. `delete if`, `< -> <=`, `0 -> 1`, `swap ?:`).
   - `source`: trimmed source line text as printed in `report.md`.
   - `kind`: one of `equivalent`, `presentation`, or `unit-only`.
   - `reason`: a concrete sentence (at least three words) a reviewer can verify; for `unit-only`, state why no table, property check, or end-to-end flow reaches the line.

   Rules enforced by `bun-mutate`:
   - Rows missing a valid `kind` or checkable `reason` fail immediately.
   - Answered survivors drop out of `report.md` clusters, `survivors.ids.txt`, and exit code `3`, while totals still report them.
   - Matching uses trimmed `source` text, so line-number shifts keep answers valid and any edit to the line automatically retires its answer for re-triage.
   - A full `bun-mutate run` (no explicit files, no `--diff`) lists stale answers that no longer match a live survivor so you can delete them.
   - Add `answered-survivors.tsv merge=union` to `.gitattributes` so parallel branches appending ledger rows merge without conflicts.

4. **Prove every fix against the oracle (watch for mutation rot).**
   - Mutant IDs encode `<file>:<byteOffset>:<label>`. Editing code above a survivor shifts byte offsets so an old `survivors.ids.txt` may match nothing (`bun-mutate` prints a `stale --only IDs` warning on `stderr`). Never treat `0 mutants run` as proof a fix worked.
   - Confirm with `bun-mutate run --recheck <out-dir>/results.jsonl`: it finds each open row at the current tree by its recorded source line and operator, so line shifts don't lose it, and every targeted line must flip from `survived` to `killed` with `0 unread`. A `--diff` run alone never revisits a survivor you pinned by editing a test, because the source line did not change. Rows the recheck reports as gone sit on edited lines; mutate their new text with `bun-mutate diff <earlier commit>`. A mutant that still survives on a line you edited a test for proves the test is inert — fix the fixture or delete the test.
   - Re-run your full project typecheck and test suite after the final edit.

## Verdict Honesty

- `killed`: at least one qualified suite failed with the mutant applied (and passed unmutated). A survivor whose mutated tree fails `tsc --noEmit` (other than unused or unreachable-code diagnostics) is recorded as killed under `typecheck`; pass `--no-typecheck` to skip that screen.
- `survived`: every covering suite passed cleanly (`false`) with zero missing verdicts.
- `unread`: at least one suite timed out, crashed, or gave no verdict and no other suite killed the mutant; excluded from the mutation score `killed / (killed + survived)`.
- Suites that fail unmutated are retried once at one worker and twice the wall, then isolated rather than recording false kills.
