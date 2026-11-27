#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildSuiteMap,
  buildTestIndex,
  discoverSourceFiles,
  isSourceFile,
  toPosix,
} from "./discover.ts";
import { loadCachedDurations } from "./exec.ts";
import { diffChangedLines, gitMaybe, resolveDiffRef } from "./git.ts";
import { mutantsOf } from "./mutants.ts";
import {
  buildMarkdownReport,
  formatReportTable,
  formatScore,
  formatSurvivorClusters,
  recheckIdsOf,
  rowsOf,
  survivorEntries,
  verdictOf,
  writeSurvivorsFile,
} from "./report.ts";
import { runMutationSpecs } from "./runner.ts";
import type { TargetSpec } from "./types.ts";

const VERSION = "0.1.0";

const USAGE = `bun-mutate ${VERSION} — Fast mutation testing for Bun & TypeScript

Usage:
  bun-mutate diff [base] [options]           Mutate only git diff hunks (auto-detects base branch)
  bun-mutate run [files...] [options]        Run mutation testing (zero-config or explicit files/suites)
  bun-mutate list [files...] [options]       Count mutants per file (supports --diff [base])
  bun-mutate report <jsonl...> [options]     Tabulate results and print clustered survivors

Options:
  --root <dir>             Repository root (default: current working directory)
  --diff [ref]             Restrict mutants to lines changed since <ref> (default branch if omitted)
  --out <jsonl>            JSONL output file (appends & resumes)
  --out-dir <dir>          Directory for results.jsonl, report.md, and survivors.ids.txt
  --suites <json>          Explicit JSON map of { suiteName: ["path/to/test.ts"] }
  --only <file>            Newline-separated mutant IDs to run (warns on stale offsets)
  -j, --jobs, --concurrency <n>  Parallel worker count (default: min(8, CPU cores))
  --timeout <s>            Per-mutant/suite wall timeout cap in seconds (default: 300)
  --all                    Run every suite even after a kill (default stops at first kill)
  --no-prune               Disable in-process schemata and LCOV coverage pruning
  --no-schemata            Disable in-process schemata (run every suite in isolated clones)
  --cov-cache <dir>        Cache baseline suite durations and LCOV coverage
  --clones <prefix>        Reusable directory prefix for isolated clones
  --depth <n|all>          Import-hop depth for test selection (default: all; 1 = direct importers with transitive fallback)
  --until <ISO|HH:MM>      Stop starting new mutants after deadline
  --old <suite>            (report) Compare a baseline suite against newer suites
  --survivors              (report) Print surviving and unread mutant IDs
  --write-ids <file>       Write surviving and unread IDs for \`--only\`
  --no-fail                Exit 0 even when survivors or unread mutants remain
  -q, --quiet              Suppress progress lines on stderr
  -h, --help               Show this help
  -v, --version            Show version`;

interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set([
  "root",
  "out",
  "out-dir",
  "state",
  "suites",
  "only",
  "jobs",
  "concurrency",
  "timeout",
  "cov-cache",
  "clones",
  "depth",
  "until",
  "old",
  "write-ids",
]);

const BOOL_FLAGS = new Set([
  "all",
  "stop-at-kill",
  "prune",
  "no-prune",
  "no-schemata",
  "survivors",
  "no-fail",
  "fail-on-survivors",
  "json",
  "quiet",
  "help",
  "version",
]);

const SHORT_MAP: Record<string, string> = {
  j: "jobs",
  q: "quiet",
  h: "help",
  v: "version",
};

function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      const inlineVal = eq === -1 ? null : body.slice(eq + 1);
      if (name === "diff") {
        if (inlineVal !== null) {
          flags.set("diff", inlineVal);
        } else {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith("-") && !existsSync(next)) {
            flags.set("diff", next);
            i += 1;
          } else {
            flags.set("diff", true);
          }
        }
        continue;
      }
      if (BOOL_FLAGS.has(name)) {
        flags.set(name, true);
        continue;
      }
      if (VALUE_FLAGS.has(name)) {
        const val = inlineVal ?? argv[i + 1];
        if (val === undefined) die(`missing value for --${name}`);
        if (inlineVal === null) i += 1;
        flags.set(name, val);
        continue;
      }
      die(`unknown option: --${name}\n\n${USAGE}`);
    }
    if (token.startsWith("-") && token.length === 2) {
      const mapped = SHORT_MAP[token[1] ?? ""];
      if (mapped === undefined) die(`unknown option: ${token}\n\n${USAGE}`);
      if (BOOL_FLAGS.has(mapped)) {
        flags.set(mapped, true);
      } else {
        const val = argv[i + 1];
        if (val === undefined) die(`missing value for ${token}`);
        i += 1;
        flags.set(mapped, val);
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

function die(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function intFlag(flags: ReadonlyMap<string, string | true>, ...names: readonly string[]): number | undefined {
  for (const name of names) {
    const raw = flags.get(name);
    if (typeof raw !== "string") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) die(`--${name} expects a positive integer, got "${raw}"`);
    return n;
  }
  return undefined;
}

function strFlag(flags: ReadonlyMap<string, string | true>, ...names: readonly string[]): string | null {
  for (const name of names) {
    const raw = flags.get(name);
    if (typeof raw === "string") return raw;
  }
  return null;
}

function parseDeadline(raw: string | null): number {
  if (raw === null) return Number.POSITIVE_INFINITY;
  if (/^\d{1,2}:\d{2}$/u.test(raw)) {
    const [h = Number.NaN, m = Number.NaN] = raw.split(":").map(Number);
    const at = new Date();
    at.setHours(h, m, 0, 0);
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) die(`--until "${raw}" is not a valid timestamp or HH:MM clock time`);
  return parsed;
}

function resolveDiffTargets(
  root: string,
  explicitRef: string | null,
  explicitFiles: readonly string[],
): { readonly ref: string; readonly targets: Map<string, string[]> } {
  const ref = resolveDiffRef(root, explicitRef);
  if (ref === null) {
    die(
      explicitRef === null
        ? `could not detect a default git base branch (origin/main, origin/master, main, master) in ${root}; pass --diff <ref>`
        : `git ref "${explicitRef}" could not be resolved in ${root}`,
    );
  }
  const changed = diffChangedLines(root, ref, explicitFiles);
  if (changed === null) die(`git diff failed for ref "${ref}" in ${root}`);
  const targets = new Map<string, string[]>();
  for (const [rawFile, lines] of changed) {
    const file = toPosix(rawFile);
    if (lines.size === 0 || !isSourceFile(file)) continue;
    const full = join(root, file);
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    const ids = mutantsOf(root, file)
      .filter((mutant) => lines.has(mutant.line))
      .map((mutant) => mutant.id);
    if (ids.length > 0) targets.set(file, ids);
  }
  return { ref, targets };
}

function handleList(root: string, files: readonly string[], flags: ReadonlyMap<string, string | true>): void {
  const diffFlag = flags.get("diff");
  if (diffFlag !== undefined) {
    const { ref, targets } = resolveDiffTargets(root, typeof diffFlag === "string" ? diffFlag : null, files);
    if (targets.size === 0) {
      console.log(`0 diff mutants since ${ref.slice(0, 12)}`);
      return;
    }
    for (const [file, ids] of targets) console.log(`${file}\t${String(ids.length)}`);
    return;
  }
  const list = files.length > 0 ? files.map(toPosix) : discoverSourceFiles(root);
  for (const file of list) {
    console.log(`${file}\t${String(mutantsOf(root, file).length)}`);
  }
}

function handleReport(root: string, jsonlFiles: readonly string[], flags: ReadonlyMap<string, string | true>): void {
  if (jsonlFiles.length === 0) die("report expects at least one JSONL file\n\n" + USAGE);
  const old = strFlag(flags, "old");
  const rows = jsonlFiles.flatMap(rowsOf);
  const ids = recheckIdsOf(rows, old);
  const writeIds = strFlag(flags, "write-ids");
  if (writeIds !== null && ids.length > 0) writeSurvivorsFile(writeIds, ids);
  if (flags.has("survivors")) {
    for (const id of ids) console.log(id);
    return;
  }
  console.log(formatReportTable(rows, old));
  if (old === null) {
    const entries = survivorEntries(root, rows);
    const clusters = formatSurvivorClusters(entries);
    if (clusters.length > 0) {
      console.log("");
      console.log(`Survivors: ${String(entries.length)} across ${String(clusters.length)} line(s)`);
      for (const line of clusters) console.log(line);
    }
  }
}

async function handleRun(
  sub: "run" | "diff",
  root: string,
  rest: readonly string[],
  flags: ReadonlyMap<string, string | true>,
): Promise<number> {
  const isDiff = sub === "diff" || flags.has("diff");
  const diffRefArg =
    sub === "diff"
      ? (rest[0] ?? (typeof flags.get("diff") === "string" ? String(flags.get("diff")) : null))
      : typeof flags.get("diff") === "string"
        ? String(flags.get("diff"))
        : null;
  const explicitFiles = sub === "diff" ? rest.slice(1) : rest;

  const outDirFlag = strFlag(flags, "out-dir", "state");
  const outFlag = strFlag(flags, "out");
  const head = gitMaybe(root, "rev-parse", "--short=9", "HEAD") ?? "worktree";
  const defaultDir = join(root, ".bun-mutate", isDiff ? `diff-${head}` : `run-${head}`);
  const outDir = outDirFlag !== null ? resolve(outDirFlag) : outFlag !== null ? dirname(resolve(outFlag)) : defaultDir;
  const outPath = outFlag !== null ? resolve(outFlag) : join(outDir, "results.jsonl");
  mkdirSync(dirname(outPath), { recursive: true });

  const suitesPath = strFlag(flags, "suites");
  const explicitSuites =
    suitesPath === null
      ? null
      : (JSON.parse(readFileSync(resolve(suitesPath), "utf8")) as Record<string, string[]>);

  const onlyPath = strFlag(flags, "only");
  const onlyIds =
    onlyPath === null
      ? undefined
      : readFileSync(resolve(onlyPath), "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);

  let diffRef: string | null = null;
  let targetFiles: string[];
  let diffIdsByFile: Map<string, string[]> | null = null;

  if (isDiff) {
    const resolved = resolveDiffTargets(root, diffRefArg, explicitFiles);
    diffRef = resolved.ref;
    diffIdsByFile = resolved.targets;
    targetFiles = [...resolved.targets.keys()];
    if (targetFiles.length === 0) {
      console.log(`0 diff mutants since ${diffRef.slice(0, 12)}`);
      return 0;
    }
  } else {
    targetFiles = explicitFiles.length > 0 ? explicitFiles.map(toPosix) : discoverSourceFiles(root);
    if (targetFiles.length === 0) die(`no TypeScript source files found in ${root}`);
  }

  const rawDepth = strFlag(flags, "depth");
  const depth =
    rawDepth === null
      ? Number.POSITIVE_INFINITY
      : rawDepth === "all" || rawDepth === "infinity"
        ? Number.POSITIVE_INFINITY
        : intFlag(flags, "depth") ?? 1;
  const covCache = strFlag(flags, "cov-cache");
  const timings = loadCachedDurations(covCache);
  const index = explicitSuites === null ? buildTestIndex(root, { depth, timings }) : null;

  const specs: TargetSpec[] = [];
  const untested: [string, number][] = [];

  for (const file of targetFiles) {
    const idsForFile =
      onlyIds !== undefined
        ? onlyIds
        : diffIdsByFile !== null
          ? (diffIdsByFile.get(file) ?? [])
          : undefined;
    if (explicitSuites !== null) {
      specs.push(
        idsForFile === undefined
          ? { file, out: outPath, suites: explicitSuites }
          : { file, out: outPath, suites: explicitSuites, ids: idsForFile },
      );
      continue;
    }
    const matched = index?.suitesFor(file) ?? [];
    if (matched.length === 0) {
      const count = idsForFile?.length ?? mutantsOf(root, file).length;
      untested.push([file, count]);
      continue;
    }
    const suiteMap = buildSuiteMap(matched);
    specs.push(
      idsForFile === undefined
        ? { file, out: outPath, suites: suiteMap }
        : { file, out: outPath, suites: suiteMap, ids: idsForFile },
    );
  }

  if (specs.length === 0) {
    for (const [file, count] of untested) {
      console.error(`no nearby test for ${file} (${String(count)} mutants)`);
    }
    return isDiff && !flags.has("no-fail") ? 3 : 0;
  }

  const prune = !flags.has("no-prune");
  const schemata = prune && !flags.has("no-schemata");
  const stopAtKill = !flags.has("all");
  const concurrency = intFlag(flags, "jobs", "concurrency");
  const timeoutSeconds = intFlag(flags, "timeout") ?? 300;
  const deadlineMs = parseDeadline(strFlag(flags, "until"));

  const started = Date.now();
  const quiet = flags.has("quiet") || flags.has("json");
  const summary = await runMutationSpecs({
    root,
    specs,
    stopAtKill,
    prune,
    schemata,
    covCache,
    clonesPrefix: strFlag(flags, "clones"),
    concurrency,
    timeoutSeconds,
    deadlineMs,
    testIndex: index ?? undefined,
    progress: quiet ? undefined : (msg) => console.error(msg),
  });
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

  if (summary.refused !== null && summary.run === 0) {
    console.error(summary.refused);
    return 1;
  }

  const allRows = rowsOf(outPath);
  const recheckIds = recheckIdsOf(allRows);
  const idsFile = strFlag(flags, "write-ids") ?? join(outDir, "survivors.ids.txt");
  let wroteIds = false;
  if (recheckIds.length > 0) {
    wroteIds = writeSurvivorsFile(idsFile, recheckIds);
  } else {
    rmSync(idsFile, { force: true });
  }

  const heading =
    diffRef !== null
      ? `# Mutation report at ${head} (diff since ${diffRef.slice(0, 12)})`
      : `# Mutation report at ${head}`;
  const report = buildMarkdownReport({
    root,
    heading,
    rows: allRows,
    untested,
    idsFile: wroteIds ? idsFile : null,
  });

  if (outDirFlag !== null || outFlag === null) {
    writeFileSync(join(outDir, "report.md"), report.markdown);
  }

  if (flags.has("json")) {
    console.log(
      JSON.stringify(
        {
          run: summary.run,
          heldBefore: summary.heldBefore,
          unrun: summary.unrun,
          refused: summary.refused,
          killed: report.killed,
          survived: report.survived,
          unread: report.unread,
          score: report.score,
          untested: untested.map(([file, mutants]) => ({ file, mutants })),
          out: outPath,
          idsFile: wroteIds ? idsFile : null,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `${String(summary.run)} mutants run in ${elapsedSec}s (${String(summary.heldBefore)} held before): ${String(report.killed)} killed, ${String(report.survived)} survived, ${String(report.unread)} unread (${formatScore(report.killed, report.survived)})`,
    );
    if (report.clusters.length > 0) {
      for (const line of report.clusters) console.log(line);
    }
    if (wroteIds) console.log(`survivor IDs: ${idsFile}`);
    for (const [file, count] of untested) {
      console.error(`no nearby test: ${file} (${String(count)} mutants)`);
    }
  }

  if (summary.refused !== null) {
    console.error(summary.refused);
    return 1;
  }

  if (summary.unrun > 0) {
    console.error(`${String(summary.unrun)} mutants left unrun; re-run to resume`);
    return 1;
  }
  const hasGap = report.survived > 0 || report.unread > 0 || (isDiff && untested.length > 0);
  if ((isDiff || flags.has("fail-on-survivors")) && !flags.has("no-fail") && hasGap) {
    return 3;
  }
  const allOk = allRows.every((row) => verdictOf(row.killed) === "killed");
  return !allOk && flags.has("fail-on-survivors") && !flags.has("no-fail") ? 3 : 0;
}

async function main(): Promise<void> {
  const { positionals, flags } = parseCliArgs(Bun.argv.slice(2));
  if (flags.has("version")) {
    console.log(VERSION);
    return;
  }
  if (flags.has("help") || positionals.length === 0) {
    console.log(USAGE);
    return;
  }
  const rootArg = strFlag(flags, "root") ?? process.cwd();
  const root = realpathSync(resolve(rootArg));
  const [sub, ...rest] = positionals;
  if (sub === "list") {
    handleList(root, rest, flags);
    return;
  }
  if (sub === "report") {
    handleReport(root, rest, flags);
    return;
  }
  if (sub === "run" || sub === "diff") {
    const code = await handleRun(sub, root, rest, flags);
    process.exit(code);
  }
  die(`unknown command: ${String(sub)}\n\n${USAGE}`);
}

if (import.meta.main) {
  await main();
}
