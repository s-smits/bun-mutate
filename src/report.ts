import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitRaw } from "./git.ts";
import { mutantsOf } from "./mutants.ts";
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
  readonly reached: readonly string[] | null;
}

export const ANSWER_KINDS: ReadonlySet<string> = new Set(["equivalent", "presentation", "unit-only"]);

/**
 * Reads a ledger of answered survivors: one tab-separated row per answer with columns `path`,
 * `label`, `source` (the trimmed source line), `kind` and `reason`, under an optional header row.
 * An `equivalent` survivor changes nothing observable, a `presentation` one changes only printed
 * wording, and a `unit-only` one sits on a guard no table, property check or end-to-end flow can
 * reach. Editing the line retires its answer, since the source no longer matches.
 */
export function readAnswers(path: string | null): ReadonlySet<string> {
  if (path === null || !existsSync(path)) return new Set();
  const rows = readFileSync(path, "utf8").split("\n").filter(Boolean);
  return new Set(
    rows
      .filter((row, at) => !(at === 0 && row.startsWith("path\t")))
      .map((row) => {
        const [file = "", label = "", source = "", kind = "", reason = ""] = row.split("\t");
        if (!ANSWER_KINDS.has(kind) || reason.trim().split(/\s+/u).length < 3) {
          throw new Error(
            `${path}: "${row}" needs a kind (${[...ANSWER_KINDS].join(", ")}) and a reason a reviewer can check`,
          );
        }
        return `${file}  ${label}  ${source}`;
      }),
  );
}

export const survivorLineCount = (entries: readonly SurvivorEntry[]): number =>
  new Set(entries.map(({ file, line }) => `${file}:${String(line)}`)).size;

/** How to resolve a survivor given the suites that ran with it active. */
export function routeOf(reached: readonly string[]): string {
  if (reached.length === 0) {
    return "no suite reaches its line: delete it, or reach it through an end-to-end entry point";
  }
  const named = reached.slice(0, 3).map((suite) => `\`${suite}\``);
  const more = reached.length > 3 ? ` and ${String(reached.length - 3)} more` : "";
  return `ran under ${named.join(", ")}${more}: assert it through one of these tests, or answer it`;
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
    const source = row.source ?? sources.get(row.file)?.[row.line - 1]?.trim() ?? "";
    const key = `${row.file}  ${row.label}  ${source}`;
    const reached = row.reached ?? null;
    return [{ id: row.id, file: row.file, line: row.line, label: row.label, source, key, reached }];
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
    const line = `- \`${first.file}:${String(first.line)}  [${String(group.length)}: ${ops}]${snippet}\``;
    const known = group.flatMap(({ reached }) => (reached === null ? [] : [reached]));
    if (known.length < group.length) return [line];
    return [line, `  ${routeOf([...new Set(known.flat())])}`];
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
  readonly answered?: ReadonlySet<string>;
  readonly listStale?: boolean;
}): {
  readonly markdown: string;
  readonly killed: number;
  readonly survived: number;
  readonly open: number;
  readonly unread: number;
  readonly score: number | null;
  readonly clusters: readonly string[];
  readonly recheckIds: readonly string[];
  readonly stale: readonly string[];
} {
  const answered = opts.answered ?? new Set<string>();
  const all = survivorEntries(opts.root, opts.rows);
  const entries = all.filter(({ key }) => !answered.has(key));
  const answeredIds = new Set(all.filter(({ key }) => answered.has(key)).map(({ id }) => id));
  const live = new Set(all.map(({ key }) => key));
  const mutated = new Set(opts.rows.map(({ file }) => file));
  const stale =
    opts.listStale === true
      ? [...answered].filter((key) => mutated.has(key.split("  ")[0] ?? "") && !live.has(key))
      : [];
  const clusters = formatSurvivorClusters(entries);
  const recheckIds = recheckIdsOf(opts.rows).filter((id) => !answeredIds.has(id));
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
  const open = entries.length;
  lines.push(
    `Totals: ${String(opts.rows.length)} mutants (${String(killed)} killed, ${String(survived)} survived, ${String(open)} unanswered across ${String(survivorLineCount(entries))} line(s), ${String(unread)} unread, score ${formatScore(killed, survived)})`,
  );
  if (answeredIds.size > 0) lines.push(`Answered in the ledger: ${String(answeredIds.size)}`);
  for (const key of stale) lines.push(`Stale answer, no such survivor now (delete the row): \`${key}\``);
  if (opts.idsFile !== null && opts.idsFile !== undefined && recheckIds.length > 0) {
    lines.push(`Recheck IDs (\`bun-mutate run --only\`): \`${opts.idsFile}\``);
  }
  lines.push(...clusters);
  return {
    markdown: `${lines.join("\n")}\n`,
    killed,
    survived,
    open,
    unread,
    score,
    clusters,
    recheckIds,
    stale,
  };
}

export interface Recheck {
  /** Mutant IDs at the current tree, by file, that carry an earlier run's open rows. */
  readonly targets: Map<string, string[]>;
  /** Open rows whose file, line text or operator no longer exists at the current tree. */
  readonly gone: number;
  /** Open rows re-anchored to at least one current mutant. */
  readonly anchored: number;
}

/**
 * Finds an earlier run's survivors and unread mutants at the current tree, so tests added since can
 * be checked without a full run. A row anchors to every current mutant with its label on a line whose
 * trimmed text matches the row's, nearest its old line first; rows written before `source` was
 * recorded anchor by ID alone. Answered survivors are left out.
 */
export function recheckTargets(
  root: string,
  rows: readonly ResultRow[],
  answered: ReadonlySet<string> = new Set(),
): Recheck {
  const targets = new Map<string, string[]>();
  const current = new Map<string, ReturnType<typeof mutantsOf>>();
  const latest = new Map<string, ResultRow>();
  for (const row of rows) latest.set(row.id, row);
  let gone = 0;
  let anchored = 0;
  for (const row of latest.values()) {
    const verdict = verdictOf(row.killed);
    if (verdict === "killed") continue;
    if (verdict === "survived" && answered.has(`${row.file}  ${row.label}  ${row.source ?? ""}`)) continue;
    if (!current.has(row.file)) {
      current.set(row.file, existsSync(join(root, row.file)) ? mutantsOf(root, row.file) : []);
    }
    const same = (current.get(row.file) ?? []).filter(
      (mutant) =>
        mutant.label === row.label && (row.source === undefined ? mutant.id === row.id : mutant.source === row.source),
    );
    const nearest = Math.min(...same.map((mutant) => Math.abs(mutant.line - row.line)));
    const ids = same.filter((mutant) => Math.abs(mutant.line - row.line) === nearest).map(({ id }) => id);
    if (ids.length === 0) {
      gone += 1;
      continue;
    }
    anchored += 1;
    const list = targets.get(row.file) ?? [];
    for (const id of ids) if (!list.includes(id)) list.push(id);
    targets.set(row.file, list);
  }
  return { targets, gone, anchored };
}
