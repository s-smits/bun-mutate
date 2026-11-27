import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTestIndex,
  changedLinesInDiff,
  cloneTree,
  detectDefaultBase,
  diffChangedLines,
  discoverSourceFiles,
  discoverSourceRoots,
  discoverTestFiles,
  resolveDiffRef,
  rowsOf,
  recheckTargets,
  verdictOf,
} from "../src/index.ts";
import { hasTypeError } from "../src/runner.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function runGit(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(res.stderr)}`);
  }
}

describe("automatic repo discovery and path aliases", () => {
  it("discovers source roots, excludes build/vendor/d.ts/tests, and resolves tsconfig paths & package imports", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-discover-"));
    try {
      mkdirSync(join(dir, "src", "core"), { recursive: true });
      mkdirSync(join(dir, "custom"), { recursive: true });
      mkdirSync(join(dir, "packages", "pkg-a", "src"), { recursive: true });
      mkdirSync(join(dir, "dist"), { recursive: true });
      mkdirSync(join(dir, "vendor"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      mkdirSync(join(dir, "__tests__"), { recursive: true });

      writeFileSync(
        join(dir, "tsconfig.json"),
        [
          "{",
          "  // JSONC comment supported",
          '  "compilerOptions": {',
          '    "baseUrl": ".",',
          '    "paths": {',
          '      "@core/*": ["src/core/*"],',
          '      "@custom/*": ["custom/*"]',
          "    },",
          "  },",
          '  "include": ["src/**/*", "custom/**/*"],',
          "}",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "sample-repo",
          imports: {
            "#pkg/*": "./packages/pkg-a/src/*",
          },
          exports: {
            ".": "./src/core/calc.ts",
          },
        }),
      );

      writeFileSync(
        join(dir, "src", "core", "calc.ts"),
        "export interface CalcInput { x: number }\nexport function double(n: number) { return n + n; }\n",
      );
      writeFileSync(
        join(dir, "src", "core", "types.d.ts"),
        "export type OnlyDecl = number;\n",
      );
      writeFileSync(
        join(dir, "custom", "wrap.ts"),
        'import { double } from "@core/calc";\nexport function quad(n: number) { return double(double(n)); }\n',
      );
      writeFileSync(
        join(dir, "packages", "pkg-a", "src", "util.ts"),
        "export function isPos(n: number) { return n > 0; }\n",
      );
      writeFileSync(join(dir, "dist", "calc.ts"), "export const built = 1;\n");
      writeFileSync(join(dir, "vendor", "lib.ts"), "export const vendored = 1;\n");

      // Direct importer via tsconfig @core/*
      writeFileSync(
        join(dir, "test", "calc.test.ts"),
        'import { expect, it } from "bun:test";\nimport { double } from "@core/calc";\nit("d", () => expect(double(2)).toBe(4));\n',
      );
      // Transitive importer via @custom/wrap (2 hops to src/core/calc.ts)
      writeFileSync(
        join(dir, "src", "core", "wrap.test.ts"),
        'import { expect, it } from "bun:test";\nimport { quad } from "@custom/wrap";\nit("q", () => expect(quad(2)).toBe(8));\n',
      );
      // Type-only importer — MUST be dropped!
      writeFileSync(
        join(dir, "test", "type-only.test.ts"),
        'import { expect, it } from "bun:test";\nimport type { CalcInput } from "@core/calc";\nexport type { CalcInput } from "@core/calc";\nit("t", () => { const v: CalcInput = { x: 1 }; expect(v.x).toBe(1); });\n',
      );
      // Package.json #pkg/* importer in __tests__/*.spec.ts
      writeFileSync(
        join(dir, "__tests__", "util.spec.ts"),
        'import { expect, it } from "bun:test";\nimport { isPos } from "#pkg/util.ts";\nit("p", () => expect(isPos(1)).toBe(true));\n',
      );
      // String-literal path mention test
      writeFileSync(
        join(dir, "test", "mention.test.ts"),
        'import { expect, it } from "bun:test";\nconst target = "packages/pkg-a/src/util.ts";\nit("m", () => expect(target.length).toBeGreaterThan(0));\n',
      );

      const roots = discoverSourceRoots(dir);
      expect(roots).toContain("src");
      expect(roots).toContain("custom");
      expect(roots).toContain("packages/pkg-a/src");
      expect(roots).not.toContain("dist");
      expect(roots).not.toContain("vendor");

      const sources = discoverSourceFiles(dir);
      expect(sources).toEqual(["custom/wrap.ts", "packages/pkg-a/src/util.ts", "src/core/calc.ts"]);

      const tests = discoverTestFiles(dir);
      expect(tests).toEqual([
        "__tests__/util.spec.ts",
        "src/core/wrap.test.ts",
        "test/calc.test.ts",
        "test/mention.test.ts",
        "test/type-only.test.ts",
      ]);

      const idx = buildTestIndex(dir, { depth: Number.POSITIVE_INFINITY });
      // Type-only import edge must NOT appear in importsOf
      expect(idx.importsOf("test/type-only.test.ts")).toEqual([]);
      // Direct 1-hop importer (`test/calc.test.ts`) must come BEFORE 2-hop transitive (`src/core/wrap.test.ts`)
      const calcSuites = idx.suitesFor("src/core/calc.ts");
      expect(calcSuites).toEqual(["test/calc.test.ts", "src/core/wrap.test.ts"]);
      expect(calcSuites).not.toContain("test/type-only.test.ts");

      // #pkg/* direct importer comes before string-literal mention
      const utilSuites = idx.suitesFor("packages/pkg-a/src/util.ts");
      expect(utilSuites).toEqual(["__tests__/util.spec.ts", "test/mention.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("orders pure unit suites ahead of subprocess integration suites when no timings exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-order-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "src", "core.ts"), "export const add = (a: number, b: number) => a + b;\n");
      // Tiny subprocess suite (fewer bytes!)
      writeFileSync(
        join(dir, "test", "a-integration.test.ts"),
        'import { add } from "../src/core.ts";\nBun.spawnSync(["echo", String(add(1, 2))]);\n',
      );
      // Larger pure unit suite (more bytes, but pure in-process!)
      writeFileSync(
        join(dir, "test", "z-unit.test.ts"),
        [
          'import { describe, expect, it } from "bun:test";',
          'import { add } from "../src/core.ts";',
          'describe("add exhaustive", () => {',
          '  it("checks many cases cleanly without subprocesses or filesystem writes", () => {',
          "    expect(add(1, 2)).toBe(3);",
          "    expect(add(10, 20)).toBe(30);",
          "  });",
          "});",
        ].join("\n") + "\n",
      );
      const index = buildTestIndex(dir, { depth: 1 });
      expect(index.suitesFor("src/core.ts")).toEqual(["test/z-unit.test.ts", "test/a-integration.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects .gitignore during discovery and Stage-2 tree cloning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-gitignore-"));
    const clone = mkdtempSync(join(tmpdir(), "bm-gitignore-clone-"));
    try {
      runGit(dir, "init", "-b", "main");
      runGit(dir, "config", "user.email", "test@example.com");
      runGit(dir, "config", "user.name", "Test");

      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      mkdirSync(join(dir, ".huge-artifacts", "nested"), { recursive: true });
      mkdirSync(join(dir, "data", "runs"), { recursive: true });

      writeFileSync(join(dir, ".gitignore"), ".huge-artifacts/\n/data/runs/\n.env\n");
      writeFileSync(join(dir, "src", "app.ts"), "export const ok = (x: number) => x > 0;\n");
      writeFileSync(
        join(dir, "test", "app.test.ts"),
        'import { expect, it } from "bun:test";\nimport { ok } from "../src/app.ts";\nit("ok", () => expect(ok(1)).toBe(true));\n',
      );
      writeFileSync(join(dir, ".huge-artifacts", "nested", "ignored.test.ts"), "export const x = 1;\n");
      writeFileSync(join(dir, "data", "keep.txt"), "keep\n");
      writeFileSync(join(dir, "data", "runs", "ignored.ts"), "export const y = 2;\n");
      writeFileSync(join(dir, ".env"), "SECRET=1\n");

      expect(discoverSourceFiles(dir)).toEqual(["src/app.ts"]);
      expect(discoverTestFiles(dir)).toEqual(["test/app.test.ts"]);

      await cloneTree(dir, clone);
      expect(existsSync(join(clone, "src", "app.ts"))).toBe(true);
      expect(existsSync(join(clone, "data", "keep.txt"))).toBe(true);
      expect(existsSync(join(clone, ".huge-artifacts"))).toBe(false);
      expect(existsSync(join(clone, "data", "runs"))).toBe(false);
      expect(existsSync(join(clone, ".env"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe("git diff parsing and zero-flag diff-hunk mode", () => {
  it("parses unified=0 hunks cleanly", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -5,0 +6,2 @@",
      "+const x = a + b;",
      "+return x > 0;",
      "@@ -20 +22 @@",
      "-return false;",
      "+return true;",
    ].join("\n");
    const map = changedLinesInDiff(diff);
    expect([...(map.get("src/a.ts") ?? [])]).toEqual([6, 7, 22]);
  });

  it("auto-detects default base branch and mutates only changed lines via `bun-mutate diff`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-diff-e2e-"));
    try {
      runGit(dir, "init", "-b", "main");
      runGit(dir, "config", "user.email", "test@example.com");
      runGit(dir, "config", "user.name", "Test");

      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });

      writeFileSync(
        join(dir, "src", "ops.ts"),
        [
          "export function untouched(a: number, b: number): number {",
          "  return a + b;",
          "}",
          "export function changed(n: number): boolean {",
          "  return n > 10;",
          "}",
        ].join("\n") + "\n",
      );
      writeFileSync(
        join(dir, "test", "ops.test.ts"),
        [
          'import { expect, it } from "bun:test";',
          'import { changed } from "../src/ops.ts";',
          'it("checks threshold", () => {',
          "  expect(changed(11)).toBe(true);",
          "  expect(changed(10)).toBe(false);",
          "});",
        ].join("\n") + "\n",
      );

      runGit(dir, "add", ".");
      runGit(dir, "commit", "-m", "initial");

      expect(detectDefaultBase(dir)).toBe("main");

      // Create a feature branch and edit ONLY line 5 (`n > 10` -> `n > 5`)
      runGit(dir, "checkout", "-b", "feat/threshold");
      writeFileSync(
        join(dir, "src", "ops.ts"),
        [
          "export function untouched(a: number, b: number): number {",
          "  return a + b;",
          "}",
          "export function changed(n: number): boolean {",
          "  return n > 5;",
          "}",
        ].join("\n") + "\n",
      );
      writeFileSync(
        join(dir, "test", "ops.test.ts"),
        [
          'import { expect, it } from "bun:test";',
          'import { changed } from "../src/ops.ts";',
          'it("checks threshold", () => {',
          "  expect(changed(6)).toBe(true);",
          "  expect(changed(5)).toBe(false);",
          "});",
        ].join("\n") + "\n",
      );
      runGit(dir, "add", ".");
      runGit(dir, "commit", "-m", "lower threshold to 5");

      const outDir = join(dir, ".out");
      const res = Bun.spawnSync([process.execPath, CLI, "diff", "--root", dir, "--out-dir", outDir], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new TextDecoder().decode(res.stdout);
      const stderr = new TextDecoder().decode(res.stderr);
      expect(res.exitCode, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);

      const rows = rowsOf(join(outDir, "results.jsonl"));
      // Only line 5 was changed (`>` -> `>=` and `5` -> `6`), NOT line 2 (`untouched`)!
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.line === 5)).toBe(true);
      expect(rows.every((r) => verdictOf(r.killed) === "killed")).toBe(true);
      expect(readFileSync(join(outDir, "report.md"), "utf8")).toContain("2 killed, 0 survived");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects option-like git refs, replicates refs across files and reftable clones, and bridges facade/barrel tests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-git-and-facade-"));
    try {
      mkdirSync(join(dir, "src", "feature"), { recursive: true });
      mkdirSync(join(dir, "src", "other"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      runGit(dir, "init", "-q", "-b", "main");
      runGit(dir, "config", "user.email", "test@example.com");
      runGit(dir, "config", "user.name", "Test");
      writeFileSync(join(dir, "src", "feature", "helper.ts"), "export const h = (x: number) => x > 0;\n");
      writeFileSync(
        join(dir, "src", "feature", "entry.ts"),
        'import { h } from "./helper.ts";\nexport const run = (x: number) => h(x);\n',
      );
      writeFileSync(
        join(dir, "src", "other", "consumer.ts"),
        'import { h } from "../feature/helper.ts";\nexport const c = (x: number) => h(x);\n',
      );
      writeFileSync(
        join(dir, "test", "feature-direct.test.ts"),
        'import { h } from "../src/feature/helper.ts";\nvoid h;\n',
      );
      writeFileSync(
        join(dir, "test", "feature-entry.test.ts"),
        'import { run } from "../src/feature/entry.ts";\nvoid run;\n',
      );
      writeFileSync(
        join(dir, "test", "other-consumer.test.ts"),
        'import { c } from "../src/other/consumer.ts";\nvoid c;\n',
      );
      runGit(dir, "add", ".");
      runGit(dir, "commit", "-m", "initial");

      // Option-like refs must be rejected without writing to the flag path
      const evilFile = join(dir, "evil-output.txt");
      expect(resolveDiffRef(dir, `--output=${evilFile}`)).toBeNull();
      expect(diffChangedLines(dir, `--output=${evilFile}`)).toBeNull();
      expect(existsSync(evilFile)).toBe(false);

      // cloneTree preserves branch/remote refs and skips stale .bun-mutate* dirs
      const baseSha = new TextDecoder()
        .decode(Bun.spawnSync(["git", "-C", dir, "rev-parse", "main"]).stdout)
        .trim();
      runGit(dir, "update-ref", "refs/remotes/origin/main", baseSha);
      mkdirSync(join(dir, ".bun-mutate-old"), { recursive: true });
      writeFileSync(join(dir, ".bun-mutate-old", "stale.txt"), "stale\n");
      const cloneDir = join(dir, ".clone-check");
      await cloneTree(dir, cloneDir);
      expect(existsSync(join(cloneDir, ".bun-mutate-old"))).toBe(false);
      const cloneRef = new TextDecoder()
        .decode(Bun.spawnSync(["git", "-C", cloneDir, "rev-parse", "origin/main"]).stdout)
        .trim();
      expect(cloneRef).toBe(baseSha);

      // Reftable repositories clone cleanly without failing on refs/heads placeholder files
      const reftableDir = join(dir, "reftable-repo");
      mkdirSync(reftableDir, { recursive: true });
      const reftableInit = Bun.spawnSync(["git", "-C", reftableDir, "init", "-q", "--ref-format=reftable", "-b", "main"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (reftableInit.exitCode === 0) {
        runGit(reftableDir, "config", "user.email", "test@example.com");
        runGit(reftableDir, "config", "user.name", "Test");
        writeFileSync(join(reftableDir, "a.ts"), "export const a = 1;\n");
        runGit(reftableDir, "add", ".");
        runGit(reftableDir, "commit", "-m", "reftable init");
        const rtSha = new TextDecoder()
          .decode(Bun.spawnSync(["git", "-C", reftableDir, "rev-parse", "main"]).stdout)
          .trim();
        runGit(reftableDir, "update-ref", "refs/remotes/origin/main", rtSha);
        const rtClone = join(dir, "reftable-clone");
        await cloneTree(reftableDir, rtClone);
        const rtCloneRef = new TextDecoder()
          .decode(Bun.spawnSync(["git", "-C", rtClone, "rev-parse", "origin/main"]).stdout)
          .trim();
        expect(rtCloneRef).toBe(rtSha);
      }

      // Depth-1 discovery bridges through same-directory facades without fan-out to unrelated compartments
      const idx = buildTestIndex(dir, { depth: 1 });
      expect(idx.suitesFor("src/feature/helper.ts")).toEqual([
        "test/feature-direct.test.ts",
        "test/feature-entry.test.ts",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rechecks an earlier run's survivors after the file shifted and a test grew, starting fresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-recheck-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      const code = ["export function clamp(x: number) {", "  if (x > 10) return 10;", "  return x;", "}"];
      writeFileSync(join(dir, "src", "ops.ts"), `${code.join("\n")}\n`);
      const testOf = (lines: string[]) =>
        `${['import { expect, it } from "bun:test";', 'import { clamp } from "../src/ops.ts";', 'it("clamps", () => {', ...lines, "});"].join("\n")}\n`;
      writeFileSync(join(dir, "test", "ops.test.ts"), testOf(["  expect(clamp(5)).toBe(5);"]));
      const cli = (...args: string[]) => {
        const res = Bun.spawnSync([process.execPath, CLI, ...args, "--root", dir, "-q"], { stdout: "pipe", stderr: "pipe" });
        return { code: res.exitCode, err: new TextDecoder().decode(res.stderr) };
      };

      const staleRow = ["src/ops.ts", "< -> <=", "return x < 0;", "equivalent", "a row whose line is long gone"];
      writeFileSync(join(dir, "answered-survivors.tsv"), `${staleRow.join("\t")}\n`);
      const stale = (out: string) => readFileSync(join(dir, out, "report.md"), "utf8").includes("Stale answer");
      expect(cli("run", "src/ops.ts", "--out-dir", join(dir, "a")).code).toBe(0);
      expect(cli("run", "--out-dir", join(dir, "full")).code).toBe(0);
      expect([stale("a"), stale("full")]).toEqual([false, true]);
      const first = rowsOf(join(dir, "a", "results.jsonl"));
      const open = first.filter((row) => verdictOf(row.killed) !== "killed");
      expect(open.map((row) => row.label)).toContain("delete if");
      expect(open.every((row) => row.source === "if (x > 10) return 10;")).toBe(true);

      writeFileSync(join(dir, "src", "ops.ts"), `${["// Caps a value at ten.", ...code].join("\n")}\n`);
      writeFileSync(
        join(dir, "test", "ops.test.ts"),
        testOf(["  expect(clamp(5)).toBe(5);", "  expect(clamp(11)).toBe(10);", "  expect(clamp(10)).toBe(10);"]),
      );
      const rechecked = cli("run", "--recheck", join(dir, "a", "results.jsonl"));
      expect(rechecked.err).toContain(`recheck: ${String(open.length)} open row(s) found at this tree, 0 on lines since changed`);
      const again = rowsOf(join(dir, ".bun-mutate", "recheck-worktree", "results.jsonl"));
      expect(stale(join(".bun-mutate", "recheck-worktree"))).toBe(false);
      expect(new Set(again.map((row) => row.line))).toEqual(new Set([3]));
      expect(again.filter((row) => verdictOf(row.killed) !== "killed").map((row) => row.label)).toEqual(["> -> >="]);
      expect(rechecked.code).toBe(3);

      // A second recheck starts its default output fresh instead of resuming the first by ID.
      writeFileSync(join(dir, "test", "ops.test.ts"), testOf(["  expect(clamp(5)).toBe(5);"]));
      expect(cli("run", "--recheck", join(dir, "a", "results.jsonl")).code).toBe(3);
      const third = rowsOf(join(dir, ".bun-mutate", "recheck-worktree", "results.jsonl"));
      expect(third.filter((row) => verdictOf(row.killed) !== "killed").map((row) => row.label)).toContain("delete if");
      expect(cli("run", "--recheck", join(dir, "a", "results.jsonl"), "--out-dir", join(dir, "a")).err).toContain(
        "--recheck writes fresh results",
      );
      const ids = join(dir, "a", "survivors.ids.txt");
      expect(cli("run", "--recheck", join(dir, "a", "results.jsonl"), "--only", ids).err).toContain(
        "--recheck takes neither --diff nor --only",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("anchors open rows by line text and label, counting changed lines as gone and skipping answers", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-anchor-"));
    try {
      writeFileSync(join(dir, "a.ts"), "export const f = (x: number) => x > 0;\nexport const g = (y: number) => y < 9;\n");
      const row = (id: string, line: number, label: string, source: string | undefined, killed: boolean | null) => ({
        id,
        file: "a.ts",
        line,
        label,
        killed: { s: killed },
        ...(source === undefined ? {} : { source }),
      });
      const rows = [
        row("a.ts:1:> -> >=", 1, "> -> >=", "export const f = (x: number) => x > 0;", false),
        row("a.ts:2:< -> <=", 2, "< -> <=", "export const g = (y: number) => y < 10;", false),
        row("a.ts:3:9 -> 10", 2, "9 -> 10", "export const g = (y: number) => y < 9;", true),
        row("a.ts:4:9 -> 10", 2, "9 -> 10", "export const g = (y: number) => y < 9;", false),
        row("a.ts:73:< -> <=", 2, "< -> <=", undefined, null),
        row("a.ts:999:> -> <", 1, "> -> <", undefined, false),
      ];
      const answered = new Set(["a.ts  9 -> 10  export const g = (y: number) => y < 9;"]);
      const found = recheckTargets(dir, rows, answered);
      expect([found.anchored, found.gone]).toEqual([2, 2]);
      expect(found.targets.get("a.ts")?.toSorted()).toEqual(["a.ts:34:> -> >=", "a.ts:73:< -> <="]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills a lone survivor whose mutated tree fails tsc, unless --no-typecheck or the tree already fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-typecheck-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      symlinkSync(join(import.meta.dir, "..", "node_modules"), join(dir, "node_modules"));
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, noUnusedLocals: true, types: [] }, include: ["src"] }),
      );
      writeFileSync(
        join(dir, "src", "len.ts"),
        "export function len(x: string | null): number {\n  if (x === null) throw new TypeError();\n  return x.length;\n}\n",
      );
      writeFileSync(
        join(dir, "test", "len.test.ts"),
        'import { expect, it } from "bun:test";\nimport { len } from "../src/len.ts";\nit("len", () => {\n  expect(len("ab")).toBe(2);\n  expect(() => len(null)).toThrow();\n});\n',
      );
      writeFileSync(join(dir, "src", "cap.ts"), "export const cap = (n: number): number => Math.min(n, 9);\n");
      writeFileSync(
        join(dir, "test", "cap.test.ts"),
        'import { expect, it } from "bun:test";\nimport { cap } from "../src/cap.ts";\nit("cap", () => {\n  expect(cap(1)).toBe(1);\n});\n',
      );
      const verdicts = (file: string, out: string, ...flags: string[]) => {
        const args = ["run", file, "--root", dir, "--out-dir", join(dir, out), "-q", ...flags];
        Bun.spawnSync([process.execPath, CLI, ...args]);
        const rows = rowsOf(join(dir, out, "results.jsonl"));
        return rows.filter((row) => verdictOf(row.killed) !== "killed").map((row) => row.label);
      };
      expect(verdicts("src/len.ts", "screened")).toEqual([]);
      expect(verdicts("src/cap.ts", "typed")).toEqual(["9 -> 10"]);
      expect(verdicts("src/len.ts", "unscreened", "--no-typecheck")).toEqual(["delete if"]);
      writeFileSync(join(dir, "src", "broken.ts"), 'export const n: number = "x";\n');
      expect(verdicts("src/len.ts", "broken")).toEqual(["delete if"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts only diagnostics other than unused or unreachable code as a type error", () => {
    const line = (code: string) => `src/a.ts(3,7): error TS${code}: message`;
    expect(hasTypeError("")).toBe(false);
    expect(hasTypeError([line("6133"), line("6196"), line("7027")].join("\n"))).toBe(false);
    expect(hasTypeError([line("6133"), line("2322")].join("\n"))).toBe(true);
    expect(hasTypeError(line("18047"))).toBe(true);
  });
});
