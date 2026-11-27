import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectSuiteHelperDeps, type TestIndex } from "./discover.ts";
import { cloneTree, linkModules, type LocalWorker, measureCoverage, spawnsSubprocess } from "./exec.ts";
import { gitMaybe } from "./git.ts";
import { mutantsOf } from "./mutants.ts";
import { verdictOf } from "./report.ts";
import { type PoolTask, runLocalPool, UNKNOWN_SUITE_MS } from "./pool.ts";
import { screenFileWithSchemata } from "./schemata.ts";
import type { KillMode, Mutant, ResultRow, TargetSpec, VerdictMap } from "./types.ts";

const STAMP_FILE = ".bun-mutate-stamp";

// Unused and unreachable diagnostics flag dead code a mutant left behind, not a change in behaviour.
const DEAD_CODE_DIAGNOSTICS = new Set(["6133", "6138", "6192", "6196", "6198", "6199", "6205", "7027", "7028"]);

export function hasTypeError(output: string): boolean {
  return [...output.matchAll(/error TS(\d+):/gu)].some(([, code]) => !DEAD_CODE_DIAGNOSTICS.has(code ?? ""));
}

/** Marks each survivor whose mutated tree fails `tsc --noEmit` as killed under `typecheck`. */
async function typecheckSurvivors(
  root: string,
  originals: ReadonlyMap<string, string>,
  held: readonly Mutant[],
  progress: (message: string) => void,
): Promise<ReadonlySet<string>> {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  if (held.length === 0 || !existsSync(join(root, "tsconfig.json")) || !existsSync(tsc)) return new Set();
  const clone = mkdtempSync(join(tmpdir(), "bun-mutate-typecheck-"));
  const check = () => {
    const ran = Bun.spawnSync(
      [process.execPath, tsc, "--noEmit", "--incremental", "--tsBuildInfoFile", join(clone, ".tsbuildinfo"), "-p", "."],
      { cwd: clone, stdout: "pipe", stderr: "pipe" },
    );
    return hasTypeError(`${ran.stdout.toString()}${ran.stderr.toString()}`);
  };
  try {
    await cloneTree(root, clone);
    linkModules(root, clone);
    if (check()) {
      progress("typecheck: the unmutated tree fails tsc, so survivors stay unscreened");
      return new Set();
    }
    const failed = new Set<string>();
    for (const mutant of held) {
      const orig = originals.get(mutant.file) ?? "";
      const path = join(clone, mutant.file);
      writeFileSync(path, orig.slice(0, mutant.start) + mutant.text + orig.slice(mutant.end));
      if (check()) failed.add(mutant.id);
      writeFileSync(path, orig);
    }
    progress(`typecheck: ${String(failed.size)}/${String(held.length)} survivor(s) fail tsc`);
    return failed;
  } finally {
    rmSync(clone, { recursive: true });
  }
}

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
  readonly testIndex?: TestIndex;
  readonly typecheck?: boolean;
  readonly warn?: (message: string) => void;
  readonly progress?: (message: string) => void;
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
    const wanted =
      spec.ids === undefined ? null : new Set(spec.ids.filter((id) => id.startsWith(`${spec.file}:`)));
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
      const [first, ...restSuites] = active;
      const tailFactor = opts.mode === "stop-at-kill" ? 0.25 : 1;
      const weightMs =
        first === undefined
          ? 0
          : (opts.durations.get(first) ?? UNKNOWN_SUITE_MS) +
            restSuites.reduce(
              (sum, name) => sum + (opts.durations.get(name) ?? UNKNOWN_SUITE_MS) * tailFactor,
              0,
            );
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
  const defaultConc = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
  const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? defaultConc));
  const warn = opts.warn ?? ((msg: string) => console.error(msg));
  const progress = opts.progress ?? (() => {});

  const { originals, allSuites, todo, heldBefore, staleWarnings } = collectTargets(
    opts.root,
    opts.specs,
    warn,
  );
  if (todo.length === 0) {
    return { run: 0, heldBefore, unrun: 0, refused: null, staleWarnings, schemataEncoded: 0, rows: [] };
  }

  const helperFiles = collectSuiteHelperDeps(opts.root, allSuites, opts.testIndex);
  progress(
    `mutating ${String(todo.length)} mutant(s) across ${String(originals.size)} file(s) (${String(allSuites.size)} suite(s))`,
  );

  const rows: ResultRow[] = [];
  const madeDirs = new Set<string>();
  const priorReach = new Map<string, Set<string>>();
  const held: { readonly item: TargetItem; readonly killed: VerdictMap; readonly raw: Readonly<VerdictMap> }[] = [];
  const screen = opts.typecheck === true;
  const record = (item: TargetItem, killed: VerdictMap, raw: Readonly<VerdictMap> = {}) => {
    if (screen && verdictOf(killed) === "survived") held.push({ item, killed, raw });
    else write(item, killed, raw);
  };
  const settle = async (summary: RunSummary): Promise<RunSummary> => {
    const failed = await typecheckSurvivors(
      opts.root,
      originals,
      held.map(({ item }) => item.mutant),
      progress,
    );
    for (const { item, killed, raw } of held) {
      write(item, failed.has(item.mutant.id) ? { ...killed, typecheck: true } : killed, raw);
    }
    return { ...summary, run: rows.length };
  };
  const write = (item: TargetItem, killed: VerdictMap, raw: Readonly<VerdictMap>) => {
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
      reached: item.suites.filter((name) => name in raw || priorReach.get(item.mutant.id)?.has(name) === true),
      source: item.mutant.source,
    };
    appendFileSync(item.out, `${JSON.stringify(row)}\n`);
    rows.push(row);
  };

  // Shared lazy CoW/hardlink worker pool reused by both stateful schemata and isolated execution.
  let ephemeralRoot: string | null = null;
  const preparedWorkers = new Map<number, Promise<LocalWorker>>();
  const head = gitMaybe(opts.root, "rev-parse", "HEAD");
  const stamp =
    (opts.clonesPrefix ?? null) !== null && head !== null && gitMaybe(opts.root, "status", "--porcelain") === ""
      ? `${opts.root}\n${head}`
      : null;
  let cloneBase: string | null = null;

  const ensureWorkers = async (count: number): Promise<LocalWorker[]> => {
    const needed = Math.max(1, Math.min(concurrency, count));
    if (cloneBase === null) {
      if (opts.clonesPrefix === null || opts.clonesPrefix === undefined) {
        ephemeralRoot = mkdtempSync(join(tmpdir(), "bun-mutate-clones-"));
        cloneBase = join(ephemeralRoot, "slot");
      } else {
        cloneBase = opts.clonesPrefix;
      }
    }
    const base = cloneBase;
    const promises: Promise<LocalWorker>[] = [];
    for (let id = 0; id < needed; id += 1) {
      let pending = preparedWorkers.get(id);
      if (pending === undefined) {
        const worker: LocalWorker = { id, clone: `${base}-${String(id)}` };
        pending = (async () => {
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
          return worker;
        })();
        preparedWorkers.set(id, pending);
      }
      promises.push(pending);
    }
    return await Promise.all(promises);
  };

  const ensureSandboxes = async (): Promise<readonly string[]> => {
    const ws = await ensureWorkers(concurrency);
    return ws.map((w) => w.clone);
  };

  const priorById = new Map<string, Map<string, boolean | null>>();
  const localQualified = new Set<string>();
  const durations = new Map<string, number>();
  let schemataEncoded = 0;

  const finishPool = async (afterSchema: readonly PendingItem[]): Promise<RunSummary> => {
    if (afterSchema.length === 0) {
      return { run: rows.length, heldBefore, unrun: 0, refused: null, staleWarnings, schemataEncoded, rows };
    }
    return await runIsolatedPool({
      opts,
      afterSchema,
      originals,
      allSuites,
      helperFiles,
      priorById,
      localQualified,
      durations,
      ensureWorkers,
      concurrency,
      seconds,
      deadline,
      prune,
      mode,
      stopAtKill,
      heldBefore,
      staleWarnings,
      schemataEncoded,
      rows,
      record,
      warn,
      progress,
    });
  };

  try {
    if (enableSchemata && Date.now() < deadline) {
      const schemataStart = Date.now();
      const entries = [...Map.groupBy(todo, (item) => item.mutant.file).entries()];
      let completedFiles = 0;
      const runOneFile = async (
        file: string,
        items: readonly TargetItem[],
        fileConc: number,
        sandboxSlice?: () => Promise<readonly string[]>,
      ): Promise<void> => {
        if (Date.now() >= deadline) return;
        const fileStart = Date.now();
        const suiteOrder = [...new Set(items.flatMap((item) => item.suites))];
        const res = await screenFileWithSchemata({
          root: opts.root,
          file,
          source: originals.get(file) ?? "",
          mutants: items.map((item) => item.mutant),
          suites: allSuites,
          suiteOrder,
          helperFiles,
          ensureSandboxes: sandboxSlice ?? ensureSandboxes,
          capSeconds: seconds,
          stopAtKill,
          concurrency: fileConc,
        });
        completedFiles += 1;
        schemataEncoded += res.encodedCount;
        for (const [name, ms] of res.durations) durations.set(name, ms);
        for (const [id, row] of res.verdicts) priorById.set(id, row);
        for (const [id, names] of res.reached) priorReach.set(id, names);
        if (res.encodedCount > 0 && res.qualifiedSuites.size > 0) {
          let settledHere = 0;
          for (const item of items) {
            const prior = res.verdicts.get(item.mutant.id);
            if (prior === undefined) continue;
            const killed = mode === "stop-at-kill" && [...prior.values()].includes(true);
            const allDone = item.suites.every((name) => prior.has(name));
            if (killed || allDone) settledHere += 1;
          }
          const fSec = ((Date.now() - fileStart) / 1000).toFixed(1);
          progress(
            `schemata [${String(completedFiles)}/${String(entries.length)}] ${file}: ${String(settledHere)}/${String(items.length)} settled in ${fSec}s`,
          );
        }
      };
      // Dynamic slot-pool scheduler: sort largest-first (LPT) and allocate up to `ceil(mutants / 16)`
      // disjoint sandbox slots per file with no small/large barrier, so one slow file never stalls idle cores.
      const queue = entries.toSorted((a, b) => b[1].length - a[1].length);
      const freeSlots = Array.from({ length: concurrency }, (_, idx) => idx);
      const waiters: (() => void)[] = [];
      const acquire = async (want: number): Promise<number[]> => {
        while (freeSlots.length === 0) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
        return freeSlots.splice(0, Math.min(want, freeSlots.length));
      };
      const release = (slots: readonly number[]) => {
        freeSlots.push(...slots);
        while (waiters.length > 0 && freeSlots.length > 0) waiters.shift()?.();
      };
      const running: Promise<void>[] = [];
      for (const [file, items] of queue) {
        if (Date.now() >= deadline) break;
        const want = Math.min(concurrency, Math.max(1, Math.ceil(items.length / 16)));
        const slots = await acquire(want);
        const sliceSandboxes = async (): Promise<readonly string[]> => {
          const all = await ensureSandboxes();
          return slots.map((idx) => all[idx]).filter((dir): dir is string => dir !== undefined);
        };
        const job = runOneFile(file, items, slots.length, sliceSandboxes).finally(() => release(slots));
        running.push(job);
      }
      await Promise.all(running);
      if (schemataEncoded > 0 && durations.size > 0) {
        const sec = ((Date.now() - schemataStart) / 1000).toFixed(1);
        const after = splitAfterSchema(todo, priorById, mode, record);
        progress(
          `schemata: ${String(rows.length)}/${String(todo.length)} settled in ${sec}s (${String(after.length)} remaining)`,
        );
        return await settle(await finishPool(after));
      }
    }
    return await settle(await finishPool(splitAfterSchema(todo, priorById, mode, record)));
  } finally {
    if (ephemeralRoot !== null) rmSync(ephemeralRoot, { recursive: true, force: true });
  }
}

async function runIsolatedPool(ctx: {
  readonly opts: RunOptions;
  readonly afterSchema: readonly PendingItem[];
  readonly originals: ReadonlyMap<string, string>;
  readonly allSuites: ReadonlyMap<string, readonly string[]>;
  readonly helperFiles: ReadonlyMap<string, readonly string[]>;
  readonly priorById: ReadonlyMap<string, Map<string, boolean | null>>;
  readonly localQualified: Set<string>;
  readonly durations: Map<string, number>;
  readonly ensureWorkers: (count: number) => Promise<LocalWorker[]>;
  readonly concurrency: number;
  readonly seconds: number;
  readonly deadline: number;
  readonly prune: boolean;
  readonly mode: KillMode;
  readonly stopAtKill: boolean;
  readonly heldBefore: number;
  readonly staleWarnings: readonly StaleOnlyWarning[];
  readonly schemataEncoded: number;
  readonly rows: ResultRow[];
  readonly record: (item: TargetItem, killed: VerdictMap, raw?: Readonly<VerdictMap>) => void;
  readonly warn: (message: string) => void;
  readonly progress: (message: string) => void;
}): Promise<RunSummary> {
  const {
    opts,
    afterSchema,
    originals,
    allSuites,
    helperFiles,
    priorById,
    localQualified,
    durations,
    ensureWorkers,
    concurrency,
    seconds,
    deadline,
    prune,
    mode,
    stopAtKill,
    heldBefore,
    staleWarnings,
    schemataEncoded,
    rows,
    record,
    warn,
    progress,
  } = ctx;
  const cacheDir = opts.covCache ?? null;
  const hasCache = cacheDir !== null && existsSync(cacheDir);
  const demand = new Map<string, number>();
  for (const { rest } of afterSchema) {
    for (const name of rest) demand.set(name, (demand.get(name) ?? 0) + 1);
  }
  // Measure upfront LCOV for non-subprocess suites with repeated demand; remaining suites
  // (including subprocess suites) get lazy LCOV or source-instrumented reachability on first reach.
  const covSuites = new Map(
    [...allSuites.entries()].filter(([name, paths]) => {
      if (localQualified.has(name)) return false;
      const count = demand.get(name) ?? 0;
      if (count < 3 && !hasCache) return false;
      return !spawnsSubprocess(opts.root, paths, helperFiles.get(name));
    }),
  );
  const runCov = prune && covSuites.size > 0 && (afterSchema.length >= 5 || hasCache);
  const slotCount = Math.min(concurrency, afterSchema.length);

  progress(
    `isolated: ${String(afterSchema.length)} mutant(s) across ${String(slotCount)} worker(s)${runCov ? ` + ${String(covSuites.size)} coverage suite(s)` : ""}`,
  );

  const [cov, workers] = await Promise.all([
    runCov
      ? measureCoverage(opts.root, covSuites, [...originals.keys()], {
          seconds,
          cacheDir,
          concurrency,
          helperFiles,
        })
      : Promise.resolve({
          uncovered: new Map<string, Map<string, Set<number>>>(),
          covered: new Map<string, Map<string, number>>(),
          passed: new Set<string>(),
          durations: new Map<string, number>(),
        }),
    ensureWorkers(slotCount),
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

  const mutantsByFile = new Map<string, Mutant[]>();
  for (const { item } of afterSchema) {
    const list = mutantsByFile.get(item.mutant.file) ?? [];
    list.push(item.mutant);
    mutantsByFile.set(item.mutant.file, list);
  }
  const byId = new Map(afterSchema.map(({ item }) => [item.mutant.id, item] as const));
  const { refused, unrun } = await runLocalPool({
    root: opts.root,
    workers: workers.slice(0, Math.min(workers.length, tasks.length)),
    tasks,
    suites: allSuites,
    originals,
    mutantsByFile,
    helperFiles,
    durations,
    uncovered: cov.uncovered,
    covered: cov.covered,
    localQualified,
    prune,
    stopAtKill,
    seconds,
    deadline,
    onResult: (task, raw) => {
      const item = byId.get(task.plan.mutant.id);
      if (item !== undefined) {
        record(item, finalizeRow(item.suites, priorById.get(item.mutant.id), raw, mode), raw);
      }
    },
    warn,
    progress,
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
}
