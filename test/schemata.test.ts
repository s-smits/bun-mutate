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
  it("encodes precedence-safe short-circuit chains while excluding top-level initialisers and regrouping chains", () => {
    const src = [
      "export const TOP = 1 + 2;",
      "export function mixed(a: boolean, b: boolean, c: boolean): boolean {",
      "  return a && b || c;",
      "}",
      "export function tripleOr(a: boolean, b: boolean, c: boolean): boolean {",
      "  return a || b || c;",
      "}",
      "export function tripleAnd(a: boolean, b: boolean, c: boolean): boolean {",
      "  return a && b && c;",
      "}",
    ].join("\n");
    const mutants = mutantsFromSource("src/logic.ts", src);
    const built = buildSchemaSource("src/logic.ts", src, mutants);
    expect(built.source).not.toBeNull();
    const encodedLabels = [...built.encoded.values()].map((m) => `${String(m.line)}:${m.label}`);

    // Top-level initialiser line 1 must NEVER be encoded in schemata
    expect(encodedLabels.some((item) => item.startsWith("1:"))).toBe(false);
    // Precedence-safe `a && b || c` encodes BOTH `&& -> ||` and `|| -> &&` via O(N) thunks
    expect(encodedLabels).toContain("3:&& -> ||");
    expect(encodedLabels).toContain("3:|| -> &&");
    // In `a || b || c`, only the first `||` is precedence-safe (the second would regroup as `a || (b && c)`)
    expect(encodedLabels.filter((item) => item.startsWith("6:"))).toHaveLength(1);
    // In `a && b && c`, only the second `&&` is precedence-safe (the first would regroup as `a || (b && c)`)
    expect(encodedLabels.filter((item) => item.startsWith("9:"))).toHaveLength(1);
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

  it("settles import-time hits directly in schemata via hot query-string re-import", async () => {
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
      // Probe detects import-time hits, verifies re-import idempotency, and settles every mutant in-process!
      expect(sch.qualifiedSuites.has("target")).toBe(true);
      expect(sch.verdicts.size).toBe(mutants.length);
      expect([...sch.verdicts.values()].every((row) => row.get("target") === true)).toBe(true);

      // Full runner matches isolated mode 1-to-1
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

  it("handles stateful suites (beforeAll/afterAll, .each, .skipIf, spyOn, process.env, temp-dir FS) in schemata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-stateful-sch-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      const source = [
        "export function score(x: number, bonus: boolean): number {",
        "  if (x <= 0) return 0;",
        "  return bonus ? x + 2 : x + 1;",
        "}",
      ].join("\n") + "\n";
      writeFileSync(join(dir, "src", "score.ts"), source);
      writeFileSync(
        join(dir, "test", "score.test.ts"),
        [
          'import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";',
          'import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
          'import { tmpdir } from "node:os";',
          'import { join } from "node:path";',
          'import { score } from "../src/score.ts";',
          "setDefaultTimeout(30_000);",
          'describe("score stateful", () => {',
          '  let scratch = "";',
          "  let seq = 0;",
          '  beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "bm-inner-")); });',
          "  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });",
          "  it.each([[0, false, 0], [1, false, 2], [2, true, 4]])(\"scores %p\", (x, b, want) => {",
          "    seq += 1;",
          '    const f = join(scratch, `out-${String(seq)}.txt`);',
          '    process.env.BM_TEST_TEMP = "dirty";',
          "    const spy = spyOn(Math, \"max\");",
          "    writeFileSync(f, String(score(x as number, b as boolean)));",
          "    expect(Number(readFileSync(f, \"utf8\"))).toBe(want as number);",
          "    expect(spy).toBeDefined();",
          "  });",
          '  it.skipIf(true)("skipped branch", () => { expect(1).toBe(2); });',
          "});",
        ].join("\n") + "\n",
      );

      const suites = { score: ["test/score.test.ts"] };
      const fast = await runMutationSpecs({
        root: dir,
        specs: [{ file: "src/score.ts", out: join(dir, "fast.jsonl"), suites }],
        schemata: true,
        prune: true,
      });
      const iso = await runMutationSpecs({
        root: dir,
        specs: [{ file: "src/score.ts", out: join(dir, "iso.jsonl"), suites }],
        schemata: false,
        prune: false,
      });
      expect(fast.refused).toBeNull();
      expect(iso.refused).toBeNull();
      expect(fast.schemataEncoded).toBeGreaterThan(0);
      expect(process.env.BM_TEST_TEMP).toBeUndefined();
      const mapFast = new Map(fast.rows.map((r) => [r.id, verdictOf(r.killed)]));
      const mapIso = new Map(iso.rows.map((r) => [r.id, verdictOf(r.killed)]));
      expect(mapFast.size).toBe(mapIso.size);
      for (const [id, v] of mapIso) {
        expect(mapFast.get(id), `stateful parity mismatch for ${id}`).toBe(v);
      }
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

  it("handles order-dependent stateful suites in reimport mode without false leak aborts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-seq-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      const source = [
        "export function initTag(n: number): string { return n > 0 ? 'ready' : 'cold'; }",
        "export function checkTag(tag: string, n: number): boolean { return tag === 'ready' && n >= 2; }",
      ].join("\n") + "\n";
      writeFileSync(join(dir, "src/state.ts"), source);
      writeFileSync(
        join(dir, "test/state.test.ts"),
        [
          'import { afterAll, expect, it } from "bun:test";',
          'import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
          'import { tmpdir } from "node:os";',
          'import { join } from "node:path";',
          'import { checkTag, initTag } from "../src/state.ts";',
          'const work = mkdtempSync(join(tmpdir(), "bm-seq-work-"));',
          "let wrote = false;",
          "afterAll(() => rmSync(work, { recursive: true, force: true }));",
          'it("step 1 initializes file once", () => {',
          '  if (wrote) throw new Error("not reusable in place");',
          "  wrote = true;",
          '  writeFileSync(join(work, "tag.txt"), initTag(1));',
          "  expect(initTag(0)).toBe('cold');",
          "});",
          'it("step 2 depends on step 1 file", () => {',
          '  const tag = readFileSync(join(work, "tag.txt"), "utf8");',
          "  expect(checkTag(tag, 2)).toBe(true);",
          "  expect(checkTag(tag, 1)).toBe(false);",
          "});",
        ].join("\n") + "\n",
      );
      const mutants = mutantsFromSource("src/state.ts", source);
      const sch = await screenFileWithSchemata({
        root: dir,
        file: "src/state.ts",
        source,
        mutants,
        suites: new Map([["state", ["test/state.test.ts"]]]),
        suiteOrder: ["state"],
        ensureSandboxes: async () => [dir],
        capSeconds: 30,
        stopAtKill: true,
        concurrency: 2,
      });
      expect(sch.qualifiedSuites.has("state")).toBe(true);
      expect(sch.verdicts.size).toBe(sch.encodedCount);
      const killed = [...sch.verdicts.values()].filter((m) => m.get("state") === true).length;
      expect(killed).toBe(sch.encodedCount);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
