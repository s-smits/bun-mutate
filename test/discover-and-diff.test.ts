import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTestIndex,
  changedLinesInDiff,
  cloneTree,
  detectDefaultBase,
  discoverSourceFiles,
  discoverSourceRoots,
  discoverTestFiles,
  rowsOf,
  verdictOf,
} from "../src/index.ts";

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
      mkdirSync(join(dir, "data"), { recursive: true });

      writeFileSync(join(dir, ".gitignore"), ".huge-artifacts/\ndata/\n");
      writeFileSync(join(dir, "src", "app.ts"), "export const ok = (x: number) => x > 0;\n");
      writeFileSync(
        join(dir, "test", "app.test.ts"),
        'import { expect, it } from "bun:test";\nimport { ok } from "../src/app.ts";\nit("ok", () => expect(ok(1)).toBe(true));\n',
      );
      writeFileSync(join(dir, ".huge-artifacts", "nested", "ignored.test.ts"), "export const x = 1;\n");
      writeFileSync(join(dir, "data", "ignored.ts"), "export const y = 2;\n");

      expect(discoverSourceFiles(dir)).toEqual(["src/app.ts"]);
      expect(discoverTestFiles(dir)).toEqual(["test/app.test.ts"]);

      await cloneTree(dir, clone);
      expect(existsSync(join(clone, "src", "app.ts"))).toBe(true);
      expect(existsSync(join(clone, ".huge-artifacts"))).toBe(false);
      expect(existsSync(join(clone, "data"))).toBe(false);
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

  it("auto-detects default base branch and mutates only changed lines via `bun-mutate diff`", () => {
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
});
