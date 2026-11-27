import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cloneTree, linkModules, type LocalWorker, measureCoverage } from "./exec.ts";
import { gitMaybe } from "./git.ts";
import { mutantsOf } from "./mutants.ts";
import { type PoolTask, runLocalPool } from "./pool.ts";
import { screenFileWithSchemata } from "./schemata.ts";
import type { KillMode, Mutant, ResultRow, TargetSpec, VerdictMap } from "./types.ts";

const STAMP_FILE = ".bun-mutate-stamp";

interface TargetItem {
  readonly mutant: Mutant;
  readonly out: string;
  readonly suites: readonly string[];
}

interface PendingItem {
  readonly item: TargetItem;
  readonly rest: readonly string[];
}

export interface StaleOnlyWarning {
  readonly file: string;
  readonly stale: number;
  readonly total: number;
  readonly message: string;
}

export interface RunOptions {
  readonly root: string;
  readonly specs: readonly TargetSpec[];
  readonly stopAtKill?: boolean;
  readonly prune?: boolean;
  readonly schemata?: boolean;
  readonly covCache?: string | null;
  readonly clonesPrefix?: string | null;
  readonly concurrency?: number;
  readonly timeoutSeconds?: number;
  readonly deadlineMs?: number;
  readonly warn?: (message: string) => void;
}

export interface RunSummary {
  readonly run: number;
  readonly heldBefore: number;
  readonly unrun: number;
  readonly refused: string | null;
  readonly staleWarnings: readonly StaleOnlyWarning[];
  readonly schemataEncoded: number;
  readonly rows: readonly ResultRow[];
}

const linesOf = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];

export function finalizeRow(
  names: readonly string[],
  prior: ReadonlyMap<string, boolean | null> | undefined,
  raw: Readonly<VerdictMap>,
  mode: KillMode,
): VerdictMap {
  const out = new Map<string, boolean | null>();
  const killed = [...(prior?.values() ?? []), ...Object.values(raw)].some(Boolean);
  for (const name of names) {
    if (name in raw) out.set(name, raw[name] ?? null);
    else if (prior?.has(name) === true) out.set(name, prior.get(name) ?? null);
    else out.set(name, mode === "stop-at-kill" && killed ? null : false);
  }
  return Object.fromEntries(out);
}

function collectTargets(
  root: string,
  specs: readonly TargetSpec[],
  warn: (message: string) => void,
): {
  readonly originals: Map<string, string>;
  readonly allSuites: Map<string, readonly string[]>;
  readonly todo: TargetItem[];
  readonly heldBefore: number;
  readonly staleWarnings: StaleOnlyWarning[];
} {
  const originals = new Map<string, string>();
  const doneByOut = new Map<string, Set<string>>();
  const allSuites = new Map<string, readonly string[]>();
  const todo: TargetItem[] = [];
  const staleWarnings: StaleOnlyWarning[] = [];
  for (const spec of specs) {
    if (!originals.has(spec.file)) originals.set(spec.file, readFileSync(join(root, spec.file), "utf8"));
    let seen = doneByOut.get(spec.out);
    if (seen === undefined) {
      seen = new Set(linesOf(spec.out).map((line) => (JSON.parse(line) as ResultRow).id));
      doneByOut.set(spec.out, seen);
    }
    const entries = Object.entries(spec.suites);
    const names = entries.map(([name]) => name);
    for (const [name, paths] of entries) allSuites.set(name, paths);
    const wanted = spec.ids === undefined ? null : new Set(spec.ids);
    const current = mutantsOf(root, spec.file);
    if (wanted !== null && wanted.size > 0) {
      const currentIds = new Set(current.map((mutant) => mutant.id));
      const stale = [...wanted].filter((id) => !currentIds.has(id)).length;
      if (stale > 0) {
        const message = `stale --only IDs in ${spec.file}: ${String(stale)}/${String(wanted.size)} matched no current mutant (code moved since recorded)`;
        staleWarnings.push({ file: spec.file, stale, total: wanted.size, message });
        warn(message);
      }
    }
    for (const mutant of current) {
      if (!seen.has(mutant.id) && (wanted?.has(mutant.id) ?? true)) {
        todo.push({ mutant, out: spec.out, suites: names });
      }
    }
  }
  const heldBefore = [...doneByOut.values()].reduce((sum, set) => sum + set.size, 0);
  return { originals, allSuites, todo, heldBefore, staleWarnings };
}

function splitAfterSchema(
  todo: readonly TargetItem[],
  priorById: ReadonlyMap<string, Map<string, boolean | null>>,
  mode: KillMode,
  record: (item: TargetItem, killed: VerdictMap) => void,
): PendingItem[] {
  const remaining: PendingItem[] = [];
  for (const item of todo) {
    const prior = priorById.get(item.mutant.id);
    if (prior !== undefined && mode === "stop-at-kill" && [...prior.values()].includes(true)) {
      record(item, finalizeRow(item.suites, prior, {}, "stop-at-kill"));
      continue;
    }
    const rest = prior === undefined ? item.suites : item.suites.filter((name) => !prior.has(name));
    if (rest.length === 0) record(item, finalizeRow(item.suites, prior, {}, mode));
    else remaining.push({ item, rest });
  }
  return remaining;
}

function buildPoolTasks(opts: {
  readonly afterSchema: readonly PendingItem[];
  readonly priorById: ReadonlyMap<string, Map<string, boolean | null>>;
  readonly uncovered: ReadonlyMap<string, Map<string, Set<number>>>;
  readonly durations: ReadonlyMap<string, number>;
  readonly runCov: boolean;
  readonly mode: KillMode;
  readonly record: (item: TargetItem, killed: VerdictMap) => void;
}): PoolTask[] {
  const tasks: PoolTask[] = [];
  for (const { item, rest } of opts.afterSchema) {
    const active = opts.runCov
      ? rest.filter((name) => opts.uncovered.get(name)?.get(item.mutant.file)?.has(item.mutant.line) !== true)
      : rest;
    if (active.length === 0) {
      opts.record(item, finalizeRow(item.suites, opts.priorById.get(item.mutant.id), {}, opts.mode));
    } else {
      const weightMs = active.reduce((sum, name) => sum + (opts.durations.get(name) ?? 1000), 0);
      tasks.push({ key: item.mutant.id, plan: { mutant: item.mutant, active }, weightMs });
    }
  }
  return tasks;
}

export async function runMutationSpecs(opts: RunOptions): Promise<RunSummary> {
  const stopAtKill = opts.stopAtKill ?? true;
  const mode: KillMode = stopAtKill ? "stop-at-kill" : "all";
  const prune = opts.prune ?? true;
  const enableSchemata = opts.schemata ?? prune;
  const seconds = opts.timeoutSeconds ?? 300;
  const deadline = opts.deadlineMs ?? Number.POSITIVE_INFINITY;
  const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? Math.min(8, availableParallelism())));
  const warn = opts.warn ?? ((msg: string) => console.error(msg));

  const { originals, allSuites, todo, heldBefore, staleWarnings } = collectTargets(
    opts.root,
    opts.specs,
    warn,
  );
  if (todo.length === 0) {
    return { run: 0, heldBefore, unrun: 0, refused: null, staleWarnings, schemataEncoded: 0, rows: [] };
  }

  const rows: ResultRow[] = [];
  const madeDirs = new Set<string>();
  const record = (item: TargetItem, killed: VerdictMap) => {
    const dir = dirname(item.out);
    if (!madeDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      madeDirs.add(dir);
    }
    const row: ResultRow = {
      id: item.mutant.id,
      file: item.mutant.file,
      line: item.mutant.line,
      label: item.mutant.label,
      killed,
    };
    appendFileSync(item.out, `${JSON.stringify(row)}\n`);
    rows.push(row);
  };

  // Stage 1: In-process mutant schemata for eligible pure suites.
  const priorById = new Map<string, Map<string, boolean | null>>();
  const localQualified = new Set<string>();
  const durations = new Map<string, number>();
  let schemataEncoded = 0;

  if (enableSchemata && Date.now() < deadline) {
    const byFile = Map.groupBy(todo, (item) => item.mutant.file);
    const results = await Promise.all(
      [...byFile.entries()].map(([file, items]) => {
        const suiteOrder = [...new Set(items.flatMap((item) => item.suites))];
        return screenFileWithSchemata({
          root: opts.root,
          file,
          source: originals.get(file) ?? "",
          mutants: items.map((item) => item.mutant),
          suites: allSuites,
          suiteOrder,
          capSeconds: seconds,
          stopAtKill,
          concurrency,
        });
      }),
    );
    for (const res of results) {
      schemataEncoded += res.encodedCount;
      for (const name of res.qualifiedSuites) localQualified.add(name);
      for (const [name, ms] of res.durations) durations.set(name, ms);
      for (const [id, row] of res.verdicts) priorById.set(id, row);
    }
  }

  const afterSchema = splitAfterSchema(todo, priorById, mode, record);
  if (afterSchema.length === 0) {
    return {
      run: rows.length,
      heldBefore,
      unrun: 0,
      refused: null,
      staleWarnings,
      schemataEncoded,
      rows,
    };
  }

  // Stage 2: Process-isolated pool with APFS CoW / Linux hardlink clones and subprocess-aware LCOV pruning.
  const leadNeeded = new Set(
    afterSchema.flatMap(({ rest }) => {
      if (mode !== "stop-at-kill" || rest.length < 2) return rest;
      const keep = Math.min(rest.length - 1, Math.max(1, Math.floor((rest.length * 2) / 3)));
      return rest.slice(0, keep);
    }),
  );
  const covSuites = new Map(
    [...allSuites.entries()].filter(([name]) => leadNeeded.has(name) && !localQualified.has(name)),
  );
  const cacheDir = opts.covCache ?? null;
  const runCov = prune && (afterSchema.length >= 5 || (cacheDir !== null && existsSync(cacheDir)));

  const ephemeralRoot =
    opts.clonesPrefix === null || opts.clonesPrefix === undefined
      ? mkdtempSync(join(tmpdir(), "bun-mutate-clones-"))
      : null;
  const cloneBase = opts.clonesPrefix ?? join(ephemeralRoot ?? tmpdir(), "slot");
  const head = gitMaybe(opts.root, "rev-parse", "HEAD");
  const stamp =
    ephemeralRoot === null && head !== null && gitMaybe(opts.root, "status", "--porcelain") === ""
      ? `${opts.root}\n${head}`
      : null;

  const slotCount = Math.min(concurrency, afterSchema.length);
  const workers: LocalWorker[] = Array.from({ length: slotCount }, (_, id) => ({
    id,
    clone: `${cloneBase}-${String(id)}`,
  }));

  const prepareWorker = async (worker: LocalWorker): Promise<void> => {
    const stampPath = join(worker.clone, STAMP_FILE);
    const reusable = stamp !== null && existsSync(stampPath) && readFileSync(stampPath, "utf8") === stamp;
    if (!reusable) {
      await cloneTree(opts.root, worker.clone);
      if (stamp !== null) writeFileSync(stampPath, stamp);
    }
    linkModules(opts.root, worker.clone);
    for (const [file, text] of originals) {
      const target = join(worker.clone, file);
      rmSync(target, { force: true });
      writeFileSync(target, text);
    }
  };

  try {
    const [cov] = await Promise.all([
      runCov
        ? measureCoverage(opts.root, covSuites, [...originals.keys()], {
            seconds,
            cacheDir,
            concurrency,
          })
        : Promise.resolve({
            uncovered: new Map<string, Map<string, Set<number>>>(),
            covered: new Map<string, Map<string, number>>(),
            passed: new Set<string>(),
            durations: new Map<string, number>(),
          }),
      Promise.all(workers.map(prepareWorker)),
    ]);
    for (const name of cov.passed) localQualified.add(name);
    for (const [name, ms] of cov.durations) durations.set(name, ms);

    const tasks = buildPoolTasks({
      afterSchema,
      priorById,
      uncovered: cov.uncovered,
      durations,
      runCov,
      mode,
      record,
    });
    if (tasks.length === 0) {
      return {
        run: rows.length,
        heldBefore,
        unrun: 0,
        refused: null,
        staleWarnings,
        schemataEncoded,
        rows,
      };
    }

    const byId = new Map(afterSchema.map(({ item }) => [item.mutant.id, item] as const));
    const { refused, unrun } = await runLocalPool({
      workers: workers.slice(0, Math.min(workers.length, tasks.length)),
      tasks,
      suites: allSuites,
      originals,
      durations,
      covered: cov.covered,
      localQualified,
      stopAtKill,
      seconds,
      deadline,
      onResult: (task, raw) => {
        const item = byId.get(task.plan.mutant.id);
        if (item !== undefined) {
          record(item, finalizeRow(item.suites, priorById.get(item.mutant.id), raw, mode));
        }
      },
    });
    return {
      run: rows.length,
      heldBefore,
      unrun,
      refused,
      staleWarnings,
      schemataEncoded,
      rows,
    };
  } finally {
    if (ephemeralRoot !== null) rmSync(ephemeralRoot, { recursive: true, force: true });
  }
}
