import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
