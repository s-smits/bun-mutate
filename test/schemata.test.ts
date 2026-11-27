import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSchemaSource,
  mutantsFromSource,
  runMutationSpecs,
  screenFileWithSchemata,
  verdictOf,
} from "../src/index.ts";

describe("Mode 1 in-process mutant schemata", () => {
  it("excludes top-level initialisers and chained short-circuit precedence swaps", () => {
    const src = [
      "export const TOP = 1 + 2;",
      "export function chained(a: boolean, b: boolean, c: boolean): boolean {",
      "  return a && b || c;",
      "}",
      "export function single(a: boolean, b: boolean): boolean {",
      "  return a && b;",
      "}",
    ].join("\n");
    const mutants = mutantsFromSource("src/logic.ts", src);
    const built = buildSchemaSource("src/logic.ts", src, mutants);
    expect(built.source).not.toBeNull();
    const encodedLabels = [...built.encoded.values()].map((m) => `${String(m.line)}:${m.label}`);

    // Top-level initialiser line 1 must NEVER be encoded in schemata
    expect(encodedLabels.some((item) => item.startsWith("1:"))).toBe(false);
    // Chained `a && b || c` on line 3 must NOT be encoded in schemata (precedence safety)
    expect(encodedLabels.some((item) => item.startsWith("3:"))).toBe(false);
    // Unchained `a && b` on line 6 MUST be encoded
    expect(encodedLabels).toContain("6:&& -> ||");
  });

  it("matches Mode 2 verdicts 1-to-1 on a multi-operator module", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-parity-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(
        join(dir, "src", "calc.ts"),
        [
          "export function classify(x: number, strict: boolean): number {",
          "  if (!strict && x < 0) return 0;",
          "  if (x === 0) return 1;",
          "  return x > 10 ? x + 2 : x - 1;",
          "}",
        ].join("\n") + "\n",
      );
      writeFileSync(
        join(dir, "test", "calc.test.ts"),
        [
          'import { describe, expect, it } from "bun:test";',
          'import { classify } from "../src/calc.ts";',
          'describe("classify", () => {',
          '  it("handles negative when non-strict", () => {',
          "    expect(classify(-1, false)).toBe(0);",
          "  });",
          '  it("handles zero", () => {',
          "    expect(classify(0, true)).toBe(1);",
          "  });",
          '  it("handles large", () => {',
          "    expect(classify(12, true)).toBe(14);",
          "  });",
          "});",
        ].join("\n") + "\n",
      );

      const suites = { calc: ["test/calc.test.ts"] };
      const mode1 = await runMutationSpecs({
        root: dir,
        specs: [{ file: "src/calc.ts", out: join(dir, "m1.jsonl"), suites }],
        schemata: true,
        prune: true,
      });
      const mode2 = await runMutationSpecs({
        root: dir,
        specs: [{ file: "src/calc.ts", out: join(dir, "m2.jsonl"), suites }],
        schemata: false,
        prune: false,
      });

      expect(mode1.refused).toBeNull();
      expect(mode2.refused).toBeNull();
      expect(mode1.schemataEncoded).toBeGreaterThan(0);

      const map1 = new Map(mode1.rows.map((r) => [r.id, verdictOf(r.killed)]));
      const map2 = new Map(mode2.rows.map((r) => [r.id, verdictOf(r.killed)]));
      expect(map1.size).toBe(map2.size);
      for (const [id, v2] of map2) {
        expect(map1.get(id), `parity mismatch for ${id}`).toBe(v2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborts Mode 1 on import-time hits and falls back cleanly to Mode 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-import-time-"));
    try {
      const source = "export function bump(n: number) { return n + 1; }\n";
      writeFileSync(join(dir, "target.ts"), source);
      // Calls target function at top-level during module import!
      writeFileSync(
        join(dir, "target.test.ts"),
        [
          'import { expect, it } from "bun:test";',
          'import { bump } from "./target.ts";',
          "const precomputed = bump(5);",
          'it("uses precomputed value", () => {',
          "  expect(precomputed).toBe(6);",
          "});",
        ].join("\n") + "\n",
      );

      const mutants = mutantsFromSource("target.ts", source);
      const sch = await screenFileWithSchemata({
        root: dir,
        file: "target.ts",
        source,
        mutants,
        suites: new Map([["target", ["target.test.ts"]]]),
        suiteOrder: ["target"],
        capSeconds: 30,
        stopAtKill: true,
      });
      // Probe must detect import-time hit and refuse to record schemata verdicts
      expect(sch.qualifiedSuites.size).toBe(0);
      expect(sch.verdicts.size).toBe(0);

      // Full runner falls back to Mode 2 and kills every mutant cleanly
      const full = await runMutationSpecs({
        root: dir,
        specs: [{ file: "target.ts", out: join(dir, "out.jsonl"), suites: { target: ["target.test.ts"] } }],
        schemata: true,
        prune: true,
      });
      expect(full.refused).toBeNull();
      expect(full.rows.length).toBe(mutants.length);
      expect(full.rows.every((r) => verdictOf(r.killed) === "killed")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborts Mode 1 on cross-mutant state leakage via baseline self-verification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-leak-"));
    try {
      // Mutating `count > 0` or `1` leaves `poisoned = true` so re-running unmutated fails!
      const source = [
        "let poisoned = false;",
        "export function step(n: number): number {",
        "  if (poisoned) throw new Error('leaked');",
        "  if (n === 1) return 10;",
        "  poisoned = true;",
        "  return 20;",
        "}",
      ].join("\n") + "\n";
      writeFileSync(join(dir, "leaky.ts"), source);
      writeFileSync(
        join(dir, "leaky.test.ts"),
        [
          'import { expect, it } from "bun:test";',
          'import { step } from "./leaky.ts";',
          'it("expects 10", () => {',
          "  expect(step(1)).toBe(10);",
          "});",
        ].join("\n") + "\n",
      );

      const mutants = mutantsFromSource("leaky.ts", source);
      const sch = await screenFileWithSchemata({
        root: dir,
        file: "leaky.ts",
        source,
        mutants,
        suites: new Map([["leaky", ["leaky.test.ts"]]]),
        suiteOrder: ["leaky"],
        capSeconds: 30,
        stopAtKill: true,
      });
      // When `=== -> !==` runs, `poisoned` becomes true, causing baseline self-verification to fail -> abort!
      expect(sch.verdicts.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills hanging mutants in Mode 1 via watchdog -> unread and respawns shard for remaining mutants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-sch-hang-"));
    try {
      // `i < n` mutated to `i <= n` stays finite, `i + 1` mutated to `i - 1` loops forever!
      const source = [
        "export function sumTo(n: number): number {",
        "  let acc = 0;",
        "  for (let i = 0; i < n; i = i + 1) {",
        "    acc = acc + i;",
        "  }",
        "  return acc;",
        "}",
      ].join("\n") + "\n";
      writeFileSync(join(dir, "loop.ts"), source);
      writeFileSync(
        join(dir, "loop.test.ts"),
        [
          'import { expect, it } from "bun:test";',
          'import { sumTo } from "./loop.ts";',
          'it("sums", () => {',
          "  expect(sumTo(4)).toBe(6);",
          "});",
        ].join("\n") + "\n",
      );

      const res = await runMutationSpecs({
        root: dir,
        specs: [{ file: "loop.ts", out: join(dir, "out.jsonl"), suites: { loop: ["loop.test.ts"] } }],
        schemata: true,
        prune: true,
        timeoutSeconds: 3,
      });
      expect(res.refused).toBeNull();
      const loopStepMutant = res.rows.find((r) => r.line === 3 && r.label === "+ -> -");
      expect(loopStepMutant).toBeDefined();
      expect(verdictOf(loopStepMutant!.killed)).toBe("unread");
      // Other mutants in the same file still ran and got killed after shard respawn
      const killedCount = res.rows.filter((r) => verdictOf(r.killed) === "killed").length;
      expect(killedCount).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
