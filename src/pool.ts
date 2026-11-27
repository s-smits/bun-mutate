import { availableParallelism } from "node:os";
import { killsOf, type LocalWorker, qualifySuiteWithPruning } from "./exec.ts";
import { type KillableProc, settleProcs } from "./proc.ts";
import type { BatchPlan, Mutant, VerdictMap } from "./types.ts";

export const UNKNOWN_SUITE_MS = 15_000;

export interface PoolTask {
  readonly key: string;
  readonly plan: BatchPlan;
  readonly weightMs: number;
}

interface SuiteKillStat {
  runs: number;
  kills: number;
}

export function orderActiveByEfficiency(
  plan: BatchPlan,
  killStats: ReadonlyMap<string, SuiteKillStat>,
  durations: ReadonlyMap<string, number>,
  covered: ReadonlyMap<string, ReadonlyMap<string, number>>,
  stopAtKill: boolean,
): BatchPlan {
  if (!stopAtKill || plan.active.length <= 1) return plan;
  const hasSignal = plan.active.some((suite) => durations.has(suite));
  const totalRuns = plan.active.reduce(
    (sum, suite) => sum + (killStats.get(`${plan.mutant.file}\0${suite}`)?.runs ?? 0),
    0,
  );
  if (!hasSignal && totalRuns < 4) return plan;
  const maxCov = Math.max(1, ...plan.active.map((suite) => covered.get(suite)?.get(plan.mutant.file) ?? 0));
  const score = (suite: string) => {
    const stat = killStats.get(`${plan.mutant.file}\0${suite}`);
    const cov = covered.get(suite)?.get(plan.mutant.file) ?? 0;
    const prior = cov > 0 ? 0.2 + 0.6 * (cov / maxCov) : 0.1;
    const ms = Math.max(50, durations.get(suite) ?? UNKNOWN_SUITE_MS);
    return ((stat?.kills ?? 0) + prior) / (((stat?.runs ?? 0) + 1) * ms);
  };
  return { mutant: plan.mutant, active: plan.active.toSorted((a, b) => score(b) - score(a)) };
}

export async function runLocalPool(opts: {
  readonly root: string;
  readonly workers: readonly LocalWorker[];
  readonly tasks: readonly PoolTask[];
  readonly suites: ReadonlyMap<string, readonly string[]>;
  readonly originals: ReadonlyMap<string, string>;
  readonly mutantsByFile: ReadonlyMap<string, readonly Mutant[]>;
  readonly helperFiles: ReadonlyMap<string, readonly string[]>;
  readonly durations: Map<string, number>;
  readonly uncovered: Map<string, Map<string, Set<number>>>;
  readonly covered: Map<string, Map<string, number>>;
  readonly localQualified: Set<string>;
  readonly prune: boolean;
  readonly stopAtKill: boolean;
  readonly seconds: number;
  readonly deadline: number;
  readonly onResult: (task: PoolTask, killed: VerdictMap) => void;
  readonly progress?: (message: string) => void;
}): Promise<{ readonly refused: string | null; readonly unrun: number }> {
  const pending = [...opts.tasks].toSorted((a, b) => b.weightMs - a.weightMs);
  const activeSuites = new Map(
    [...opts.suites.entries()].filter(([name]) => pending.some((task) => task.plan.active.includes(name))),
  );
  const files = [...opts.originals.keys()];
  const unreachedBySuite = new Map<string, Map<string, Set<string>>>();
  const cores = Math.max(1, availableParallelism());
  const localCount = opts.workers.length;
  const baseConc = Math.min(4, Math.max(1, Math.floor(cores / Math.max(1, localCount))));
  const qualifyWait = new Map<string, Promise<string | null>>();

  const isPruned = (suite: string, mutant: Mutant): boolean => {
    if (!opts.prune) return false;
    if (opts.uncovered.get(suite)?.get(mutant.file)?.has(mutant.line) === true) return true;
    return unreachedBySuite.get(suite)?.get(mutant.file)?.has(mutant.id) === true;
  };

  const ensureQualified = async (seat: LocalWorker, names: readonly string[]): Promise<string | null> => {
    const missing = names.filter((name) => !opts.localQualified.has(name));
    if (missing.length === 0) return null;
    for (const name of missing) {
      let wait = qualifyWait.get(name);
      if (wait === undefined) {
        const paths = opts.suites.get(name) ?? [];
        wait = qualifySuiteWithPruning(seat, name, paths, {
          root: opts.root,
          files,
          originals: opts.originals,
          mutantsByFile: opts.mutantsByFile,
          helperFiles: opts.helperFiles.get(name) ?? [],
          prune: opts.prune,
          seconds: opts.seconds,
          localConc: baseConc,
        }).then((res) => {
          if (res.refused === null) {
            opts.localQualified.add(name);
            opts.durations.set(name, res.durationMs);
            if (res.uncovered !== undefined) opts.uncovered.set(name, res.uncovered);
            if (res.covered !== undefined) opts.covered.set(name, res.covered);
            if (res.unreachedIds !== undefined) unreachedBySuite.set(name, res.unreachedIds);
          }
          return res.refused;
        });
        qualifyWait.set(name, wait);
      }
      const why = await wait;
      if (why !== null) return why;
    }
    return null;
  };

  const doneKeys = new Set<string>();
  const activeProcs = new Set<KillableProc>();
  const killStats = new Map<string, SuiteKillStat>();
  let refused: string | null = null;
  let localInFlight = 0;
  let killedSoFar = 0;
  let lastProgressAt = Date.now();

  let resolveDone: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const doneAll = () => refused !== null || doneKeys.size >= opts.tasks.length || Date.now() >= opts.deadline;

  const finishTask = (task: PoolTask, killed: VerdictMap) => {
    if (doneKeys.has(task.key)) return;
    doneKeys.add(task.key);
    const wasKilled = Object.values(killed).includes(true);
    if (wasKilled) killedSoFar += 1;
    for (const [suite, out] of Object.entries(killed)) {
      if (out !== true && out !== false) continue;
      const key = `${task.plan.mutant.file}\0${suite}`;
      const cur = killStats.get(key) ?? { runs: 0, kills: 0 };
      cur.runs += 1;
      if (out) cur.kills += 1;
      killStats.set(key, cur);
    }
    opts.onResult(task, killed);
    const now = Date.now();
    if (
      opts.progress !== undefined &&
      doneKeys.size < opts.tasks.length &&
      (doneKeys.size % 25 === 0 || now - lastProgressAt >= 10_000)
    ) {
      lastProgressAt = now;
      opts.progress(
        `isolated: ${String(doneKeys.size)}/${String(opts.tasks.length)} done (${String(killedSoFar)} killed)`,
      );
    }
    if (doneKeys.size >= opts.tasks.length) resolveDone?.();
  };

  const firstWorker = opts.workers[0];
  const leadSuites = [
    ...new Set(pending.map((task) => task.plan.active[0]).filter((name): name is string => name !== undefined)),
  ];
  if (firstWorker !== undefined && Date.now() < opts.deadline) {
    const why = await ensureQualified(firstWorker, opts.stopAtKill ? leadSuites : [...activeSuites.keys()]);
    if (why !== null) {
      return { refused: why, unrun: opts.tasks.length };
    }
  }

  const runSeat = async (seat: LocalWorker): Promise<void> => {
    while (!doneAll()) {
      const task = pending.shift();
      if (task === undefined) return;
      if (doneKeys.has(task.key)) continue;
      const liveActive = task.plan.active.filter((name) => !isPruned(name, task.plan.mutant));
      if (liveActive.length === 0) {
        finishTask(task, {});
        continue;
      }
      localInFlight += 1;
      try {
        const ordered = orderActiveByEfficiency(
          { mutant: task.plan.mutant, active: liveActive },
          killStats,
          opts.durations,
          opts.covered,
          opts.stopAtKill,
        );
        // Adaptive tail concurrency: 1 under full load -> up to 4 as remaining tasks drain.
        const demand = Math.min(localCount, Math.max(1, pending.length + localInFlight));
        const localConc = Math.min(4, Math.max(1, Math.floor(cores / demand)));
        const outcome = await killsOf(seat, ordered, {
          originals: opts.originals,
          suites: opts.suites,
          durations: opts.durations,
          stopAtKill: opts.stopAtKill,
          seconds: opts.seconds,
          localConc,
          activeProcs,
          beforeSuite: (name) => ensureQualified(seat, [name]),
          isPruned,
        });
        if (outcome.kind === "refused") {
          refused ??= outcome.why;
          if (!doneKeys.has(task.key)) pending.unshift(task);
          resolveDone?.();
          return;
        }
        finishTask(task, outcome.killed);
      } finally {
        localInFlight -= 1;
      }
    }
  };

  const allWorkers = Promise.all(opts.workers.map(runSeat));
  await Promise.race([allWorkers, finished]);
  await settleProcs(activeProcs, 200);
  await Promise.race([allWorkers, Bun.sleep(150)]);
  return { refused, unrun: opts.tasks.length - doneKeys.size };
}
