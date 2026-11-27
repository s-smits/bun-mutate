import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { chunkSuites, linkModules } from "../src/exec.ts";
import {
  measureCoverage,
  parseMultiFileBail,
  rowsOf,
  runMutationSpecs,
  spawnsSubprocess,
  verdictOf,
} from "../src/index.ts";

describe("Mode 2 process-isolated pool and execution invariants", () => {
  it("parses multi-file --bail output accurately", () => {
    const suites = new Map<string, readonly string[]>([
      ["s1", ["test/s1.test.ts"]],
      ["s2", ["test/s2.test.ts"]],
      ["s3", ["test/s3.test.ts"]],
    ]);
    const said = [
      "test/s1.test.ts:",
      "(pass) first",
      "test/s2.test.ts:",
      "(fail) second",
      "Bailed out after 1 failure",
      " 1 pass",
      " 1 fail",
    ].join("\n");
    const parsed = parseMultiFileBail(["s1", "s2", "s3"], suites, {
      said,
      code: 1,
      signalled: false,
    });
    expect(parsed).toEqual({ s1: false, s2: true, s3: null });
  });

  it("handles lead-first + combined --bail kills and resumes from existing JSONL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-bail-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(
        join(dir, "src", "ops.ts"),
        [
          "export function inc(x: number): number { return x + 1; }",
          "export function gt(x: number): boolean { return x > 5; }",
        ].join("\n") + "\n",
      );
      writeFileSync(
        join(dir, "test", "a.test.ts"),
        'import { expect, it } from "bun:test";\nimport { inc } from "../src/ops.ts";\nit("inc", () => expect(inc(2)).toBe(3));\n',
      );
      writeFileSync(
        join(dir, "test", "b.test.ts"),
        'import { expect, it } from "bun:test";\nimport { gt } from "../src/ops.ts";\nit("gt", () => { expect(gt(6)).toBe(true); expect(gt(5)).toBe(false); });\n',
      );
      writeFileSync(
        join(dir, "test", "c.test.ts"),
        'import { expect, it } from "bun:test";\nimport { inc } from "../src/ops.ts";\nit("inc2", () => expect(inc(0)).toBe(1));\n',
      );

      const outPath = join(dir, "results.jsonl");
      const suites = {
        a: ["test/a.test.ts"],
        b: ["test/b.test.ts"],
        c: ["test/c.test.ts"],
      };

      const first = await runMutationSpecs({
        root: dir,
        specs: [{ file: "src/ops.ts", out: outPath, suites }],
        schemata: false,
        prune: false,
        stopAtKill: true,
        concurrency: 2,
      });
      expect(first.refused).toBeNull();
      expect(first.unrun).toBe(0);
      expect(first.rows.length).toBe(4);
      expect(first.rows.every((r) => verdictOf(r.killed) === "killed")).toBe(true);

      // Resuming on the same JSONL must skip all already-recorded mutants
      const second = await runMutationSpecs({
        root: dir,
        specs: [{ file: "src/ops.ts", out: outPath, suites }],
        schemata: false,
        prune: false,
      });
      expect(second.run).toBe(0);
      expect(second.heldBefore).toBe(4);
      expect(rowsOf(outPath)).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks Mode 2 infinite-loop hangs as unread via SIGKILL watchdog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-m2-hang-"));
    try {
      writeFileSync(
        join(dir, "spin.ts"),
        [
          "export function count(n: number): number {",
          "  let s = 0;",
          "  for (let i = 0; i < n; i = i + 1) {",
          "    s = s + 1;",
          "  }",
          "  return s;",
          "}",
        ].join("\n") + "\n",
      );
      writeFileSync(
        join(dir, "spin.test.ts"),
        'import { expect, it } from "bun:test";\nimport { count } from "./spin.ts";\nit("counts", () => expect(count(3)).toBe(3));\n',
      );

      const res = await runMutationSpecs({
        root: dir,
        specs: [{ file: "spin.ts", out: join(dir, "out.jsonl"), suites: { spin: ["spin.test.ts"] } }],
        schemata: false,
        prune: false,
        timeoutSeconds: 3,
      });
      expect(res.refused).toBeNull();
      // Line 3 `i = i + 1` -> `i = i - 1` loops forever -> SIGKILL watchdog -> unread
      const hangMutant = res.rows.find((r) => r.line === 3 && r.label === "+ -> -");
      expect(hangMutant).toBeDefined();
      expect(verdictOf(hangMutant!.killed)).toBe("unread");
      // Line 4 `s = s + 1` -> `s = s - 1` finishes and is killed
      const bodyMutant = res.rows.find((r) => r.line === 4 && r.label === "+ -> -");
      expect(bodyMutant).toBeDefined();
      expect(verdictOf(bodyMutant!.killed)).toBe("killed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses when an unmutated baseline lead suite fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-refuse-lead-"));
    try {
      writeFileSync(join(dir, "a.ts"), "export const add = (x: number) => x + 1;\n");
      writeFileSync(
        join(dir, "bad.test.ts"),
        'import { expect, it } from "bun:test";\nimport { add } from "./a.ts";\nit("fails baseline", () => expect(add(1)).toBe(999));\n',
      );
      const res = await runMutationSpecs({
        root: dir,
        specs: [{ file: "a.ts", out: join(dir, "out.jsonl"), suites: { bad: ["bad.test.ts"] } }],
        schemata: true,
        prune: true,
      });
      expect(res.refused).toContain('baseline suite "bad" did not pass unmutated');
      expect(res.run).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses on demand when a secondary (rest) suite fails unmutated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-refuse-rest-"));
    try {
      writeFileSync(join(dir, "a.ts"), "export function val(x: number) { return x + 1; }\n");
      // Lead suite passes unmutated AND does not kill mutations to `val`
      writeFileSync(
        join(dir, "lead.test.ts"),
        'import { expect, it } from "bun:test";\nit("passes", () => expect(1).toBe(1));\n',
      );
      // Secondary suite fails unmutated!
      writeFileSync(
        join(dir, "rest1.test.ts"),
        'import { expect, it } from "bun:test";\nit("broken baseline", () => expect(1).toBe(2));\n',
      );
      writeFileSync(
        join(dir, "rest2.test.ts"),
        'import { expect, it } from "bun:test";\nit("ok", () => expect(2).toBe(2));\n',
      );
      const res = await runMutationSpecs({
        root: dir,
        specs: [
          {
            file: "a.ts",
            out: join(dir, "out.jsonl"),
            suites: {
              lead: ["lead.test.ts"],
              rest1: ["rest1.test.ts"],
              rest2: ["rest2.test.ts"],
            },
          },
        ],
        schemata: false,
        prune: false,
        stopAtKill: true,
      });
      expect(res.refused).toContain('baseline suite "rest1" did not pass unmutated');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips LCOV pruning for subprocess-spawning suites while caching pass and duration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-subproc-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      // Target script executed strictly inside a child process!
      writeFileSync(
        join(dir, "src", "cli-target.ts"),
        [
          "export function compute(x: number): number {",
          "  if (x > 10) return x + 1;",
          "  return x - 1;",
          "}",
          'if (import.meta.main) console.log(String(compute(Number(Bun.argv[2] ?? "0"))));',
        ].join("\n") + "\n",
      );
      writeFileSync(
        join(dir, "test", "cli-target.test.ts"),
        [
          'import { expect, it } from "bun:test";',
          'import { join } from "node:path";',
          "const target = join(import.meta.dir, '..', 'src', 'cli-target.ts');",
          'it("runs child process", () => {',
          '  const r1 = Bun.spawnSync([process.execPath, target, "11"], { stdout: "pipe" });',
          '  expect(new TextDecoder().decode(r1.stdout).trim()).toBe("12");',
          '  const r2 = Bun.spawnSync([process.execPath, target, "10"], { stdout: "pipe" });',
          '  expect(new TextDecoder().decode(r2.stdout).trim()).toBe("9");',
          "});",
        ].join("\n") + "\n",
      );

      expect(spawnsSubprocess(dir, ["test/cli-target.test.ts"])).toBe(true);

      const cacheDir = join(dir, "cov-cache");
      const cov = await measureCoverage(
        dir,
        new Map([["cli", ["test/cli-target.test.ts"]]]),
        ["src/cli-target.ts"],
        { seconds: 30, cacheDir },
      );
      // Baseline passed & duration cached, and NO lines marked uncovered (LCOV skipped for subprocess suite)
      expect(cov.passed.has("cli")).toBe(true);
      expect(cov.durations.get("cli")).toBeGreaterThan(0);
      expect(cov.uncovered.size).toBe(0);
      expect(existsSync(join(cacheDir, "cli.ok"))).toBe(true);
      expect(existsSync(join(cacheDir, "cli.lcov"))).toBe(false);

      // Running full engine with pruning enabled MUST NOT prune the subprocess suite — all mutants get killed!
      const res = await runMutationSpecs({
        root: dir,
        specs: [
          {
            file: "src/cli-target.ts",
            out: join(dir, "out.jsonl"),
            suites: { cli: ["test/cli-target.test.ts"] },
          },
        ],
        prune: true,
        covCache: cacheDir,
      });
      expect(res.refused).toBeNull();
      expect(res.rows.length).toBeGreaterThanOrEqual(5);
      // Verify the `x > 10`, `x + 1`, `x - 1` mutants were all killed by the subprocess test
      const killed = res.rows.filter((r) => verdictOf(r.killed) === "killed");
      expect(killed.length).toBeGreaterThanOrEqual(5);
      // Source file in original repo must remain untouched
      expect(readFileSync(join(dir, "src", "cli-target.ts"), "utf8")).toContain("if (x > 10) return x + 1;");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes unreached mutants in subprocess suites via source-instrumented reachability while keeping reached kills", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-subtrace-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(
        join(dir, "src", "cli-two.ts"),
        [
          "export function used(x: number): number { return x > 10 ? x + 1 : x - 1; }",
          "export function dead(x: number): number { return x < 0 ? x + 5 : x - 5; }",
          'if (import.meta.main) console.log(String(used(Number(Bun.argv[2] ?? "0"))));',
        ].join("\n") + "\n",
      );
      writeFileSync(
        join(dir, "test", "cli-two.test.ts"),
        [
          'import { expect, it } from "bun:test";',
          'import { join } from "node:path";',
          "const target = join(import.meta.dir, '..', 'src', 'cli-two.ts');",
          'it("exercises used() via child process only", () => {',
          '  const a = Bun.spawnSync([process.execPath, target, "11"], { stdout: "pipe" });',
          '  const b = Bun.spawnSync([process.execPath, target, "10"], { stdout: "pipe" });',
          '  expect(new TextDecoder().decode(a.stdout).trim()).toBe("12");',
          '  expect(new TextDecoder().decode(b.stdout).trim()).toBe("9");',
          "});",
        ].join("\n") + "\n",
      );

      const suites = { cli: ["test/cli-two.test.ts"] };
      const pruned = await runMutationSpecs({
        root: dir,
        specs: [{ file: "src/cli-two.ts", out: join(dir, "pruned.jsonl"), suites }],
        prune: true,
        concurrency: 2,
      });
      const unpruned = await runMutationSpecs({
        root: dir,
        specs: [{ file: "src/cli-two.ts", out: join(dir, "unpruned.jsonl"), suites }],
        prune: false,
        concurrency: 2,
      });
      expect(pruned.refused).toBeNull();
      expect(unpruned.refused).toBeNull();
      const mapP = new Map(pruned.rows.map((r) => [r.id, verdictOf(r.killed)]));
      const mapU = new Map(unpruned.rows.map((r) => [r.id, verdictOf(r.killed)]));
      expect(mapP.size).toBe(mapU.size);
      for (const [id, v] of mapU) {
        expect(mapP.get(id), `subprocess trace parity mismatch for ${id}`).toBe(v);
      }
      // Line 1 (`used`) mutants are killed, line 2 (`dead`) mutants survive
      expect(pruned.rows.filter((r) => r.line === 1).every((r) => verdictOf(r.killed) === "killed")).toBe(true);
      expect(pruned.rows.filter((r) => r.line === 2).every((r) => verdictOf(r.killed) === "survived")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects subprocess calls inside imported test helpers so hybrid suites are not LCOV-pruned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-helper-sub-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test", "helpers"), { recursive: true });
      writeFileSync(
        join(dir, "src", "hybrid.ts"),
        [
          "export function inProc(x: number): number { return x + 1; }",
          "export function cliOnly(x: number): number { return x > 5 ? 1 : 0; }",
          "if (import.meta.main) console.log(String(cliOnly(Number(Bun.argv[2]))));",
        ].join("\n") + "\n",
      );
      writeFileSync(
        join(dir, "test", "helpers", "run-cli.ts"),
        [
          'export function runCli(script: string, arg: string): string {',
          '  const r = Bun.spawnSync([process.execPath, script, arg], { stdout: "pipe" });',
          '  return new TextDecoder().decode(r.stdout).trim();',
          "}",
        ].join("\n") + "\n",
      );
      writeFileSync(
        join(dir, "test", "hybrid.test.ts"),
        [
          'import { expect, it } from "bun:test";',
          'import { join } from "node:path";',
          'import { inProc } from "../src/hybrid.ts";',
          'import { runCli } from "./helpers/run-cli.ts";',
          'const target = join(import.meta.dir, "..", "src", "hybrid.ts");',
          'it("tests in-process and via helper subprocess", () => {',
          "  expect(inProc(2)).toBe(3);",
          '  expect(runCli(target, "6")).toBe("1");',
          '  expect(runCli(target, "5")).toBe("0");',
          "});",
        ].join("\n") + "\n",
      );

      const res = await runMutationSpecs({
        root: dir,
        specs: [
          {
            file: "src/hybrid.ts",
            out: join(dir, "out.jsonl"),
            suites: { hybrid: ["test/hybrid.test.ts"] },
          },
        ],
        prune: true,
        schemata: true,
      });
      expect(res.refused).toBeNull();
      // The `cliOnly` line-2 mutants (`> -> >=`, `5 -> 6`, `1 -> 2`, `0 -> 1`) are ONLY executed in the child process.
      // Because test/helpers/run-cli.ts is detected as a subprocess helper, Stage 1 skips it and Stage 2 skips LCOV pruning!
      const cliLineMutants = res.rows.filter((r) => r.line === 2);
      expect(cliLineMutants.length).toBeGreaterThanOrEqual(3);
      expect(cliLineMutants.every((r) => verdictOf(r.killed) === "killed")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isolates a baseline-failing suite so healthy files still complete while surfacing the exact refusal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-per-suite-refusal-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "src", "good.ts"), "export const above = (n: number) => n > 0;\n");
      writeFileSync(join(dir, "src", "bad.ts"), "export const below = (n: number) => n < 0;\n");
      writeFileSync(
        join(dir, "test", "good.test.ts"),
        'import { expect, it } from "bun:test";\nimport { above } from "../src/good.ts";\nit("checks bound", () => expect([above(0), above(1)]).toEqual([false, true]));\n',
      );
      writeFileSync(
        join(dir, "test", "bad.test.ts"),
        'import { expect, it } from "bun:test";\nimport { below } from "../src/bad.ts";\nit("always fails baseline", () => expect(below(1)).toBe(true));\n',
      );
      const warnings: string[] = [];
      const res = await runMutationSpecs({
        root: dir,
        specs: [
          {
            file: "src/good.ts",
            out: join(dir, "good.jsonl"),
            suites: { good: ["test/good.test.ts"] },
          },
          {
            file: "src/bad.ts",
            out: join(dir, "bad.jsonl"),
            suites: { bad: ["test/bad.test.ts"] },
          },
        ],
        prune: true,
        schemata: false,
        warn: (msg) => warnings.push(msg),
      });
      expect(res.refused).toContain('baseline suite "bad"');
      expect(res.unrun).toBeGreaterThan(0);
      expect(warnings.some((msg) => msg.includes('skipping suite "bad"'))).toBe(true);
      const goodRows = rowsOf(join(dir, "good.jsonl"));
      expect(goodRows.length).toBeGreaterThan(0);
      expect(goodRows.every((r) => verdictOf(r.killed) === "killed")).toBe(true);
      expect(rowsOf(join(dir, "bad.jsonl"))).toEqual([]);

      // Lazy secondary-suite refusal with a quoted suite name must terminate cleanly without spin-looping
      const weirdSuite = 'we"ird';
      writeFileSync(join(dir, "src", "lazy.ts"), "export const keep = (n: number) => n > 1;\n");
      writeFileSync(
        join(dir, "test", "pass-weak.test.ts"),
        'import { expect, it } from "bun:test";\nimport { keep } from "../src/lazy.ts";\nit("passes without killing", () => expect(typeof keep).toBe("function"));\n',
      );
      const lazy = await runMutationSpecs({
        root: dir,
        specs: [
          {
            file: "src/lazy.ts",
            out: join(dir, "lazy.jsonl"),
            suites: {
              lead: ["test/pass-weak.test.ts"],
              [weirdSuite]: ["test/bad.test.ts"],
            },
          },
        ],
        prune: false,
        schemata: false,
        stopAtKill: true,
        deadlineMs: Date.now() + 15_000,
      });
      expect(lazy.refused).toContain(`baseline suite "${weirdSuite}"`);
      expect(lazy.unrun).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves relative root paths in linkModules so clones never create self-referential node_modules symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-rel-link-"));
    try {
      const repo = join(dir, "repo");
      const clone = join(dir, "clone");
      mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "export const ok = 1;\n");
      mkdirSync(clone, { recursive: true });
      const relRoot = relative(process.cwd(), repo);
      linkModules(relRoot, clone);
      expect(realpathSync(join(clone, "node_modules"))).toBe(realpathSync(join(repo, "node_modules")));
      expect(existsSync(join(clone, "node_modules", "pkg", "index.js"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chunks combined rest suites by duration budget and count cap so large suite sets do not overflow combined timeouts", () => {
    const durations = new Map<string, number>([
      ["s1", 6000],
      ["s2", 6000],
      ["s3", 6000],
      ["s4", 15_000],
      ["s5", 2000],
    ]);
    // capSeconds = 30 -> budgetMs = 10_000: [s1], [s2], [s3], [s4], [s5]
    expect(chunkSuites(["s1", "s2", "s3", "s4", "s5"], durations, 30)).toEqual([
      ["s1"],
      ["s2"],
      ["s3"],
      ["s4"],
      ["s5"],
    ]);
    // capSeconds = 60 -> budgetMs = 20_000: [s1, s2, s3] (18s), [s4, s5] (17s)
    expect(chunkSuites(["s1", "s2", "s3", "s4", "s5"], durations, 60)).toEqual([
      ["s1", "s2", "s3"],
      ["s4", "s5"],
    ]);
    // Count cap of 10 splits fast suites even when under duration budget
    const twelve = Array.from({ length: 12 }, (_, i) => `f${String(i)}`);
    const fastDurs = new Map(twelve.map((name) => [name, 100]));
    const waves = chunkSuites(twelve, fastDurs, 120);
    expect(waves.map((w) => w.length)).toEqual([10, 2]);
  });
});
