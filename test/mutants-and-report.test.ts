import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMarkdownReport,
  classifyRow,
  formatReportTable,
  formatSurvivorClusters,
  freshSurvivors,
  mutantsFromSource,
  readAnswers,
  recheckIdsOf,
  routeOf,
  runMutationSpecs,
  survivorEntries,
  verdictOf,
  writeSurvivorsFile,
} from "../src/index.ts";
import type { ResultRow } from "../src/types.ts";

describe("mutantsFromSource", () => {
  it("generates expected syntactic mutations and skips inert nodes", () => {
    const source = [
      'import { join } from "node:path";',
      "type Flag = true | false;",
      "interface Pair { a: number; b: number; }",
      "export function check(a: number, b: number, ok: boolean): number {",
      "  console.log(a + b, ok === true);",
      "  const msg = `sum=${a + b}`;",
      "  if (!ok && a < b) return a + 1;",
      "  if (a === 0) throw new Error(b > 1 ? 'many' : 'one');",
      "  return a >= b ? 10 : 20;",
      "}",
      "export const obj = { 1: true };",
    ].join("\n");

    const mutants = mutantsFromSource("src/sample.ts", source);
    const labels = mutants.map((m) => m.label);

    // Inert lines: import (1), type (2), interface (3), console.log (5), template literal (6)
    expect(mutants.every((m) => ![1, 2, 3, 5, 6].includes(m.line))).toBe(true);
    // On line 8: `if (a === 0)` guard IS mutated, while `new Error(...)` message ternary is arid
    const line8Labels = mutants.filter((m) => m.line === 8).map((m) => m.label);
    expect(line8Labels).toContain("delete if");
    expect(line8Labels).toContain("=== -> !==");
    expect(line8Labels).not.toContain("> -> >=");
    expect(line8Labels).not.toContain("swap ?:");
    // Numeric property name `1` in `{ 1: true }` must not be mutated
    expect(mutants.some((m) => m.line === 11 && m.label === "1 -> 2")).toBe(false);
    // Boolean value in `{ 1: true }` IS mutated
    expect(mutants.some((m) => m.line === 11 && m.label === "true -> false")).toBe(true);

    expect(labels).toContain("delete if");
    expect(labels).toContain("drop !");
    expect(labels).toContain("&& -> ||");
    expect(labels).toContain("< -> <=");
    expect(labels).toContain("+ -> -");
    expect(labels).toContain("1 -> 2");
    expect(labels).toContain("swap ?:");
    expect(labels).toContain(">= -> >");
    expect(labels).toContain("10 -> 11");
    expect(labels).toContain("20 -> 21");
  });
});

describe("verdictOf and reporting", () => {
  it("enforces strict verdict honesty (mixed false/null is unread)", () => {
    expect(verdictOf({ a: true, b: null })).toBe("killed");
    expect(verdictOf({ a: false, b: true })).toBe("killed");
    expect(verdictOf({ a: false, b: false })).toBe("survived");
    expect(verdictOf({ a: false, b: null })).toBe("unread");
    expect(verdictOf({ a: null })).toBe("unread");
    expect(verdictOf({})).toBe("unread");
  });

  it("classifies rows against an --old baseline suite", () => {
    const mk = (killed: Record<string, boolean | null>): ResultRow => ({
      id: "src/a.ts:1:+ -> -",
      file: "src/a.ts",
      line: 1,
      label: "+ -> -",
      killed,
    });
    expect(classifyRow(mk({ old: true, fresh: true }), "old")).toBe("ON");
    expect(classifyRow(mk({ old: true, fresh: false }), "old")).toBe("O-");
    expect(classifyRow(mk({ old: false, fresh: true }), "old")).toBe("-N");
    expect(classifyRow(mk({ old: false, fresh: false }), "old")).toBe("--");
    expect(classifyRow(mk({ old: true, fresh: null }), "old")).toBe("unread");
    expect(classifyRow(mk({ old: null, fresh: false }), "old")).toBe("unread");
  });

  it("clusters survivors by file:line, diffs fresh survivors, and exports survivors.ids.txt", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-report-"));
    try {
      const src = ["export function f(x: number) {", "  return x > 0 && x < 10;", "}"].join("\n");
      writeFileSync(join(dir, "a.ts"), src);
      const rows: ResultRow[] = [
        { id: "a.ts:38:> -> >=", file: "a.ts", line: 2, label: "> -> >=", killed: { u: false } },
        { id: "a.ts:43:&& -> ||", file: "a.ts", line: 2, label: "&& -> ||", killed: { u: false } },
        { id: "a.ts:48:< -> <=", file: "a.ts", line: 2, label: "< -> <=", killed: { u: false } },
        { id: "a.ts:50:10 -> 11", file: "a.ts", line: 2, label: "10 -> 11", killed: { u: true } },
        { id: "a.ts:40:0 -> 1", file: "a.ts", line: 2, label: "0 -> 1", killed: { u: false, v: null } },
      ];

      const entries = survivorEntries(dir, rows);
      expect(entries).toHaveLength(3);

      const clusters = formatSurvivorClusters(entries);
      expect(clusters).toEqual([
        "- `a.ts:2  [3: > -> >=, && -> ||, < -> <=]  return x > 0 && x < 10;`",
      ]);

      const fresh = freshSurvivors(entries, entries.slice(0, 1));
      expect(fresh.map((e) => e.label)).toEqual(["&& -> ||", "< -> <="]);

      const ids = recheckIdsOf(rows);
      expect(ids).toEqual([
        "a.ts:38:> -> >=",
        "a.ts:43:&& -> ||",
        "a.ts:48:< -> <=",
        "a.ts:40:0 -> 1",
      ]);

      const idsPath = join(dir, "survivors.ids.txt");
      expect(writeSurvivorsFile(idsPath, ids)).toBe(true);
      expect(readFileSync(idsPath, "utf8").trim().split("\n")).toEqual(ids);

      const table = formatReportTable(rows);
      expect(table).toContain("file  killed  survived  unread  score  suites");
      expect(table).toContain("a.ts  1  3  1  25.0%  u, v");

      const md = buildMarkdownReport({ root: dir, heading: "# Test", rows, idsFile: idsPath });
      expect(md.killed).toBe(1);
      expect(md.survived).toBe(3);
      expect(md.unread).toBe(1);
      expect(md.markdown).toContain("| `a.ts` | 1 | 3 | 1 | 25.0% | u, v |");
      expect(md.markdown).toContain(idsPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops answered survivors from the report and recheck IDs, lists stale answers, and routes the rest by the suites that run them", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-answers-"));
    try {
      const src = ["export function f(x: number) {", "  if (x < 0) return 0;", "  return x > 1 ? x : 1;", "}"];
      writeFileSync(join(dir, "a.ts"), src.join("\n"));
      const rows: ResultRow[] = [
        { id: "a.ts:40:< -> <=", file: "a.ts", line: 2, label: "< -> <=", killed: { u: false, v: false }, reached: ["u"] },
        { id: "a.ts:60:> -> >=", file: "a.ts", line: 3, label: "> -> >=", killed: { u: false, v: false }, reached: [] },
        { id: "a.ts:50:delete if", file: "a.ts", line: 2, label: "delete if", killed: { u: false, v: false }, reached: ["u"] },
      ];
      const ledger = join(dir, "answered-survivors.tsv");
      const answer = (label: string, source: string, kind: string) =>
        ["a.ts", label, source, kind, "x is never zero or below at any caller"].join("\t");
      writeFileSync(
        ledger,
        [
          "path\tlabel\tsource\tkind\treason",
          answer("< -> <=", "if (x < 0) return 0;", "equivalent"),
          answer("> -> >=", "return x > 2 ? x : 1;", "unit-only"),
          "",
        ].join("\n"),
      );

      const md = buildMarkdownReport({
        root: dir,
        heading: "# Test",
        rows,
        answered: readAnswers(ledger),
        listStale: true,
      });
      expect([md.survived, md.open]).toEqual([3, 2]);
      expect(md.recheckIds).toEqual(["a.ts:60:> -> >=", "a.ts:50:delete if"]);
      expect(md.stale).toEqual(["a.ts  > -> >=  return x > 2 ? x : 1;"]);
      expect(md.clusters).toEqual([
        "- `a.ts:2  [1: delete if]  if (x < 0) return 0;`",
        "  ran under `u`: assert it through one of these tests, or answer it",
        "- `a.ts:3  [1: > -> >=]  return x > 1 ? x : 1;`",
        "  no suite reaches its line: delete it, or reach it through an end-to-end entry point",
      ]);
      expect(routeOf(["a", "b", "c", "d"])).toStartWith("ran under `a`, `b`, `c` and 1 more:");
      expect(formatSurvivorClusters(survivorEntries(dir, rows.map(({ reached: _, ...row }) => row)))).toHaveLength(2);

      for (const kind of ["fine", "presentation"]) {
        const bad = join(dir, `${kind}.tsv`);
        writeFileSync(bad, `${["a.ts", "< -> <=", "x", kind, kind === "fine" ? "a checkable reason here" : "short"].join("\t")}\n`);
        expect(() => readAnswers(bad)).toThrow("needs a kind (equivalent, presentation, unit-only)");
      }
      expect(readAnswers(join(dir, "missing.tsv")).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits an explicit stale --only IDs warning when byte offsets shifted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-stale-"));
    try {
      writeFileSync(join(dir, "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
      writeFileSync(
        join(dir, "math.test.ts"),
        'import { expect, it } from "bun:test";\nimport { add } from "./math.ts";\nit("adds", () => { expect(add(1, 2)).toBe(3); });\n',
      );
      const warnings: string[] = [];
      const res = await runMutationSpecs({
        root: dir,
        specs: [
          {
            file: "math.ts",
            out: join(dir, "out.jsonl"),
            suites: { math: ["math.test.ts"] },
            ids: ["math.ts:999:+ -> -", "math.ts:1234:< -> <="],
          },
        ],
        warn: (msg) => warnings.push(msg),
      });
      expect(res.run).toBe(0);
      expect(res.staleWarnings).toHaveLength(1);
      expect(res.staleWarnings[0]?.stale).toBe(2);
      expect(res.staleWarnings[0]?.total).toBe(2);
      expect(warnings[0]).toContain("stale --only IDs in math.ts: 2/2 matched no current mutant");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
