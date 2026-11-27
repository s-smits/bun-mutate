import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitRaw } from "./git.ts";
import type { ResultRow, VerdictKind, VerdictMap } from "./types.ts";

export function verdictOf(killed: Readonly<VerdictMap>): VerdictKind {
  const verdicts = Object.values(killed);
  if (verdicts.includes(true)) return "killed";
  return verdicts.length > 0 && verdicts.every((one) => one === false) ? "survived" : "unread";
}

export function classifyRow(row: ResultRow, oldSuite: string | null = null): string {
  if (oldSuite === null) return verdictOf(row.killed);
  const others = new Set(
    Object.entries(row.killed).flatMap(([name, kill]) => (name === oldSuite ? [] : [kill])),
  );
  const kept = others.has(true);
  if (!kept && (row.killed[oldSuite] == null || others.has(null))) return "unread";
  return `${row.killed[oldSuite] === true ? "O" : "-"}${kept ? "N" : "-"}`;
}

export function rowsOf(path: string): ResultRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ResultRow);
}

export interface SurvivorEntry {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly label: string;
  readonly source: string;
  readonly key: string;
}

export function survivorEntries(
  root: string,
  rows: readonly ResultRow[],
  commit: string | null = null,
): SurvivorEntry[] {
  const sources = new Map<string, string[]>();
  return rows.flatMap((row) => {
    if (verdictOf(row.killed) !== "survived") return [];
    if (!sources.has(row.file)) {
      let text: string | null = null;
      if (commit !== null) text = gitRaw(root, "show", `${commit}:${row.file}`);
      if (text === null) {
        const full = join(root, row.file);
        text = existsSync(full) ? readFileSync(full, "utf8") : "";
      }
      sources.set(row.file, text.split("\n"));
    }
    const source = sources.get(row.file)?.[row.line - 1]?.trim() ?? "";
    const key = `${row.file}  ${row.label}  ${source}`;
    return [{ id: row.id, file: row.file, line: row.line, label: row.label, source, key }];
  });
}

export function freshSurvivors(
  now: readonly SurvivorEntry[],
  before: readonly SurvivorEntry[],
): SurvivorEntry[] {
  const beforeCounts = new Map<string, number>();
  for (const { key } of before) beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
  const seen = new Map<string, number>();
  return now.filter((entry) => {
    const prior = seen.get(entry.key) ?? 0;
    seen.set(entry.key, prior + 1);
    return prior >= (beforeCounts.get(entry.key) ?? 0);
  });
}

export function formatSurvivorClusters(entries: readonly SurvivorEntry[]): string[] {
  const groups = [...Map.groupBy(entries, ({ file, line }) => `${file}:${String(line)}`).values()].toSorted(
    (a, b) =>
      b.length - a.length ||
      (a[0]?.file ?? "").localeCompare(b[0]?.file ?? "") ||
      (a[0]?.line ?? 0) - (b[0]?.line ?? 0),
  );
  return groups.flatMap((group) => {
    const first = group[0];
    if (first === undefined) return [];
    const counts = new Map<string, number>();
    for (const { label } of group) counts.set(label, (counts.get(label) ?? 0) + 1);
    const ops = [...counts].map(([label, n]) => (n > 1 ? `${label} x${String(n)}` : label)).join(", ");
    const snippet = first.source === "" ? "" : `  ${first.source}`;
    return [`- \`${first.file}:${String(first.line)}  [${String(group.length)}: ${ops}]${snippet}\``];
  });
}

const suitesInGroup = (group: readonly ResultRow[]): string =>
  [...new Set(group.flatMap((row) => Object.keys(row.killed)))].join(", ");

export function formatReportTable(rows: readonly ResultRow[], oldSuite: string | null = null): string {
  const columns = oldSuite === null ? ["killed", "survived", "unread"] : ["ON", "O-", "-N", "--", "unread"];
  const header = oldSuite === null ? ["file", ...columns, "score", "suites"] : ["file", ...columns];
  const lines = [header.join("  ")];
  for (const [file, group] of Map.groupBy(rows, (row) => row.file)) {
    const counts = columns.map((kind) => group.filter((row) => classifyRow(row, oldSuite) === kind).length);
    const tail =
      oldSuite === null
        ? [formatScore(counts[0] ?? 0, counts[1] ?? 0), suitesInGroup(group)]
        : [];
    lines.push([file, ...counts.map(String), ...tail].join("  "));
  }
  return lines.join("\n");
}

export function recheckIdsOf(rows: readonly ResultRow[], oldSuite: string | null = null): string[] {
  const survivorKind = oldSuite === null ? "survived" : "O-";
  const ids: string[] = [];
  for (const row of rows) {
    const kind = classifyRow(row, oldSuite);
    if (kind === survivorKind || kind === "unread") ids.push(row.id);
  }
  return ids;
}

export function writeSurvivorsFile(path: string, ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  writeFileSync(path, `${ids.join("\n")}\n`);
  return true;
}

export function mutationScore(killed: number, survived: number): number | null {
  const scored = killed + survived;
  return scored === 0 ? null : (killed / scored) * 100;
}

export function formatScore(killed: number, survived: number): string {
  const pct = mutationScore(killed, survived);
  return pct === null ? "n/a" : `${pct.toFixed(1)}%`;
}

export function buildMarkdownReport(opts: {
  readonly root: string;
  readonly heading: string;
  readonly rows: readonly ResultRow[];
  readonly untested?: readonly (readonly [string, number])[];
  readonly idsFile?: string | null;
}): {
  readonly markdown: string;
  readonly killed: number;
  readonly survived: number;
  readonly unread: number;
  readonly score: number | null;
  readonly clusters: readonly string[];
  readonly recheckIds: readonly string[];
} {
  const entries = survivorEntries(opts.root, opts.rows);
  const clusters = formatSurvivorClusters(entries);
  const recheckIds = recheckIdsOf(opts.rows);
  const lines = [
    opts.heading,
    "",
    "| file | killed | survived | unread | score | suites |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const [file, group] of Map.groupBy(opts.rows, (row) => row.file)) {
    const k = group.filter((row) => verdictOf(row.killed) === "killed").length;
    const s = group.filter((row) => verdictOf(row.killed) === "survived").length;
    const u = group.filter((row) => verdictOf(row.killed) === "unread").length;
    lines.push(
      `| \`${file}\` | ${String(k)} | ${String(s)} | ${String(u)} | ${formatScore(k, s)} | ${suitesInGroup(group)} |`,
    );
  }
  const killed = opts.rows.filter((row) => verdictOf(row.killed) === "killed").length;
  const survived = opts.rows.filter((row) => verdictOf(row.killed) === "survived").length;
  const unread = opts.rows.filter((row) => verdictOf(row.killed) === "unread").length;
  const score = mutationScore(killed, survived);
  lines.push("");
  if (opts.untested !== undefined) {
    for (const [file, count] of opts.untested) {
      lines.push(`No nearby test: \`${file}\` (${String(count)} mutants)`);
    }
  }
  lines.push(
    `Totals: ${String(opts.rows.length)} mutants (${String(killed)} killed, ${String(survived)} survived across ${String(clusters.length)} line(s), ${String(unread)} unread, score ${formatScore(killed, survived)})`,
  );
  if (opts.idsFile !== null && opts.idsFile !== undefined && recheckIds.length > 0) {
    lines.push(`Recheck IDs (\`bun-mutate run --only\`): \`${opts.idsFile}\``);
  }
  lines.push(...clusters);
  return {
    markdown: `${lines.join("\n")}\n`,
    killed,
    survived,
    unread,
    score,
    clusters,
    recheckIds,
  };
}
