import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { toPosix } from "./discover.ts";
import { applyMutant } from "./mutants.ts";
import { drainProcess, type KillableProc } from "./proc.ts";
import type { BatchPlan, VerdictMap } from "./types.ts";

const VERDICT_RE = /\n *\d+ (pass|fail)|\nBailed out after \d+ failures?/;

const SUBPROCESS_RE =
  /\b(?:Bun\.spawn|Bun\.spawnSync|spawnSync|execSync|execFileSync|child_process)\b|node:child_process/u;

export interface LocalWorker {
  readonly id: number;
  readonly clone: string;
}

export function suiteTimeoutSeconds(capSeconds: number, durationMs: number | undefined): number {
  if (durationMs === undefined) return capSeconds;
  return Math.min(capSeconds, Math.max(35, Math.ceil((durationMs / 1000) * 12)));
}

export function combinedTimeoutSeconds(
  capSeconds: number,
  names: readonly string[],
  durations: ReadonlyMap<string, number>,
): number {
  let totalMs = 0;
  for (const name of names) {
    const ms = durations.get(name);
    if (ms === undefined) return capSeconds;
    totalMs += ms;
  }
  return Math.min(capSeconds, Math.max(35, Math.ceil((totalMs / 1000) * 10) + 15));
}

export function canCombineSuites(
  active: readonly string[],
  suites: ReadonlyMap<string, readonly string[]>,
  stopAtKill: boolean,
): boolean {
  if (!stopAtKill || active.length <= 1) return false;
  const seen = new Set<string>();
  for (const name of active) {
    const paths = suites.get(name);
    if (paths?.length !== 1) return false;
    const only = paths[0];
    if (only === undefined || seen.has(only)) return false;
    seen.add(only);
  }
  return true;
}

function findLastSuiteHeader(
  active: readonly string[],
  suites: ReadonlyMap<string, readonly string[]>,
  normalized: string,
): { readonly positions: readonly number[]; readonly lastIdx: number; readonly lastPos: number } {
  const positions = active.map((name) => {
    const path = suites.get(name)?.[0];
    return path === undefined ? -1 : normalized.lastIndexOf(`\n${path}:`);
  });
  let lastIdx = -1;
  let lastPos = -1;
  for (let i = 0; i < positions.length; i += 1) {
    const pos = positions[i] ?? -1;
    if (pos > lastPos) {
      lastPos = pos;
      lastIdx = i;
    }
  }
  return { positions, lastIdx, lastPos };
}

export function parseMultiFileBail(
  active: readonly string[],
  suites: ReadonlyMap<string, readonly string[]>,
  outcome: { readonly said: string; readonly code: number; readonly signalled: boolean },
): VerdictMap {
  const { said, code, signalled } = outcome;
  const hasVerdict = !signalled && VERDICT_RE.test(said);
  if (hasVerdict && code === 0) return Object.fromEntries(active.map((name) => [name, false] as const));
  const { positions, lastIdx, lastPos } = findLastSuiteHeader(active, suites, `\n${said}`);
  const blamedIdx = lastIdx === -1 ? 0 : lastIdx;
  const failIdx = hasVerdict && code !== 0 ? blamedIdx : -1;
  const out = new Map<string, boolean | null>();
  for (let i = 0; i < active.length; i += 1) {
    const name = active[i];
    if (name === undefined) continue;
    const pos = positions[i] ?? -1;
    const killed = i === failIdx ? true : pos !== -1 && pos < lastPos ? false : null;
    out.set(name, killed);
  }
  return Object.fromEntries(out);
}

async function spawnTest(
  cwd: string,
  paths: readonly string[],
  seconds: number,
  localConc: number,
  activeProcs?: Set<KillableProc>,
) {
  // Keep Bun's per-test timeout above the external SIGKILL watchdog so infinite loops surface as `unread` (`null`).
  const bunTimeoutMs = Math.max(60_000, Math.ceil(seconds * 1000) + 5_000);
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--bail",
      `--max-concurrency=${String(localConc)}`,
      `--timeout=${String(bunTimeoutMs)}`,
      ...paths,
    ],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    },
  );
  return drainProcess(run, seconds, activeProcs);
}

async function verdict(
  cwd: string,
  paths: readonly string[],
  seconds: number,
  localConc: number,
  activeProcs?: Set<KillableProc>,
): Promise<boolean | null> {
  const { said, code, signalled } = await spawnTest(cwd, paths, seconds, localConc, activeProcs);
  if (signalled) return null;
  return VERDICT_RE.test(said) ? code !== 0 : null;
}

export type KillOutcome =
  | { readonly kind: "ok"; readonly killed: VerdictMap }
  | { readonly kind: "refused"; readonly why: string };

async function runSoloRest(
  seat: LocalWorker,
  rest: readonly string[],
  seed: VerdictMap,
  opts: {
    readonly suites: ReadonlyMap<string, readonly string[]>;
    readonly durations: ReadonlyMap<string, number>;
    readonly stopAtKill: boolean;
    readonly seconds: number;
    readonly localConc: number;
    readonly activeProcs?: Set<KillableProc>;
    readonly beforeSuite?: ((name: string) => Promise<string | null>) | undefined;
  },
): Promise<KillOutcome> {
  const out: VerdictMap = { ...seed };
  for (const name of rest) {
    if (opts.stopAtKill && Object.values(out).some(Boolean)) {
      if (!(name in out)) out[name] = null;
      continue;
    }
    if (out[name] === false || out[name] === true) continue;
    if (opts.beforeSuite !== undefined) {
      const why = await opts.beforeSuite(name);
      if (why !== null) return { kind: "refused", why };
    }
    const timeoutSec = suiteTimeoutSeconds(opts.seconds, opts.durations.get(name));
    out[name] = await verdict(
      seat.clone,
      opts.suites.get(name) ?? [],
      timeoutSec,
      opts.localConc,
      opts.activeProcs,
    );
  }
  return { kind: "ok", killed: out };
}

function replaceFile(path: string, contents: string): void {
  // Unlink before writing so Linux hardlinked clones (`cp -al`) never mutate the original workspace file.
  rmSync(path, { force: true });
  writeFileSync(path, contents);
}

export async function killsOf(
  seat: LocalWorker,
  plan: BatchPlan,
  opts: {
    readonly originals: ReadonlyMap<string, string>;
    readonly suites: ReadonlyMap<string, readonly string[]>;
    readonly durations: ReadonlyMap<string, number>;
    readonly stopAtKill: boolean;
    readonly seconds: number;
    readonly localConc: number;
    readonly activeProcs?: Set<KillableProc>;
    readonly beforeSuite?: ((name: string) => Promise<string | null>) | undefined;
  },
): Promise<KillOutcome> {
  const { mutant, active } = plan;
  const original = opts.originals.get(mutant.file) ?? "";
  const target = join(seat.clone, mutant.file);
  const writeMutant = () => replaceFile(target, applyMutant(original, mutant));
  const restore = () => replaceFile(target, original);
  const qualifyClean = async (names: readonly string[]): Promise<string | null> => {
    if (opts.beforeSuite === undefined) return null;
    restore();
    for (const name of names) {
      const why = await opts.beforeSuite(name);
      if (why !== null) return why;
    }
    writeMutant();
    return null;
  };
  writeMutant();
  try {
    const [lead, ...rest] = active;
    if (lead !== undefined && canCombineSuites(rest, opts.suites, opts.stopAtKill)) {
      const leadWhy = await qualifyClean([lead]);
      if (leadWhy !== null) return { kind: "refused", why: leadWhy };
      const leadSaid = await verdict(
        seat.clone,
        opts.suites.get(lead) ?? [],
        suiteTimeoutSeconds(opts.seconds, opts.durations.get(lead)),
        opts.localConc,
        opts.activeProcs,
      );
      if (leadSaid === true) {
        return {
          kind: "ok",
          killed: { [lead]: true, ...Object.fromEntries(rest.map((name) => [name, null] as const)) },
        };
      }
      const restWhy = await qualifyClean(rest);
      if (restWhy !== null) return { kind: "refused", why: restWhy };
      const paths = rest.flatMap((name) => opts.suites.get(name) ?? []);
      const batch = parseMultiFileBail(
        rest,
        opts.suites,
        await spawnTest(
          seat.clone,
          paths,
          combinedTimeoutSeconds(opts.seconds, rest, opts.durations),
          opts.localConc,
          opts.activeProcs,
        ),
      );
      const blamed = rest.find((name) => batch[name] === true);
      if (blamed !== undefined) {
        const solo = await verdict(
          seat.clone,
          opts.suites.get(blamed) ?? [],
          suiteTimeoutSeconds(opts.seconds, opts.durations.get(blamed)),
          opts.localConc,
          opts.activeProcs,
        );
        if (solo === true) return { kind: "ok", killed: { [lead]: leadSaid, ...batch } };
        const fallback = await runSoloRest(
          seat,
          rest,
          { [blamed]: solo },
          { ...opts, beforeSuite: undefined },
        );
        return fallback.kind === "ok"
          ? { kind: "ok", killed: { [lead]: leadSaid, ...fallback.killed } }
          : fallback;
      }
      if (rest.some((name) => batch[name] === null)) {
        const fallback = await runSoloRest(seat, rest, batch, { ...opts, beforeSuite: undefined });
        return fallback.kind === "ok"
          ? { kind: "ok", killed: { [lead]: leadSaid, ...fallback.killed } }
          : fallback;
      }
      return { kind: "ok", killed: { [lead]: leadSaid, ...batch } };
    }
    return await runSoloRest(
      seat,
      active,
      {},
      {
        ...opts,
        beforeSuite: opts.beforeSuite === undefined ? undefined : (name) => qualifyClean([name]),
      },
    );
  } finally {
    restore();
  }
}

export async function qualifySuites(
  worker: LocalWorker,
  suites: ReadonlyMap<string, readonly string[]>,
  seconds: number,
  localConc: number,
): Promise<string | null> {
  const all = [...new Set([...suites.values()].flat())];
  if (all.length === 0) return "no suites given";
  if (suites.size > 1 && (await verdict(worker.clone, all, seconds, localConc)) === false) return null;
  for (const [name, paths] of suites) {
    const said = await verdict(worker.clone, paths, seconds, localConc);
    if (said === false) continue;
    return `baseline suite "${name}" did not pass unmutated (${said === true ? "failed" : "no verdict"})`;
  }
  return null;
}

export async function cloneTree(root: string, dest: string): Promise<void> {
  const absRoot = resolve(root);
  const absDest = resolve(dest);
  rmSync(absDest, { recursive: true, force: true });
  mkdirSync(absDest, { recursive: true });
  const skipInsideRoot = absDest.startsWith(`${absRoot}/`)
    ? absDest.slice(absRoot.length + 1).split("/")[0]
    : null;
  const entries = readdirSync(absRoot).filter(
    (name) => name !== "node_modules" && name !== ".bun-mutate" && name !== skipInsideRoot,
  );
  if (entries.length > 0 && (process.platform === "darwin" || process.platform === "linux")) {
    const flag = process.platform === "darwin" ? "-cRp" : "-al";
    const fast = Bun.spawn(["cp", flag, ...entries.map((name) => join(absRoot, name)), absDest], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await fast.exited) === 0) return;
    rmSync(absDest, { recursive: true, force: true });
    mkdirSync(absDest, { recursive: true });
  }
  for (const name of entries) {
    cpSync(join(absRoot, name), join(absDest, name), { recursive: true, force: true });
  }
}

export function linkModules(root: string, clone: string): void {
  const rootModules = join(root, "node_modules");
  const cloneModules = join(clone, "node_modules");
  if (existsSync(rootModules) && !existsSync(cloneModules)) {
    symlinkSync(rootModules, cloneModules);
  }
}

export function spawnsSubprocess(root: string, paths: readonly string[]): boolean {
  return paths.some((path) => {
    const full = join(root, path);
    return existsSync(full) && SUBPROCESS_RE.test(readFileSync(full, "utf8"));
  });
}

function parseCoverage(root: string, lcov: string, files: ReadonlySet<string>) {
  const uncovered = new Map<string, Set<number>>();
  const covered = new Map<string, number>();
  let current: string | null = null;
  for (const row of lcov.split("\n")) {
    if (row.startsWith("SF:")) {
      const raw = row.slice(3).trim();
      const norm = toPosix(isAbsolute(raw) ? relative(root, raw) : raw);
      current = files.has(norm) ? norm : null;
    } else if (current !== null && row.startsWith("DA:")) {
      const [lineNo = "", hits = ""] = row.slice(3).split(",");
      if (hits === "0") {
        const set = uncovered.get(current) ?? new Set<number>();
        set.add(Number(lineNo));
        uncovered.set(current, set);
      } else if (Number(hits) > 0) {
        covered.set(current, (covered.get(current) ?? 0) + 1);
      }
    } else if (row === "end_of_record") {
      current = null;
    }
  }
  return { uncovered, covered };
}

const cacheKey = (name: string) => name.replaceAll(/[^A-Za-z0-9._-]/gu, "_");

export interface CoverageResult {
  readonly uncovered: Map<string, Map<string, Set<number>>>;
  readonly covered: Map<string, Map<string, number>>;
  readonly passed: Set<string>;
  readonly durations: Map<string, number>;
}

export async function measureCoverage(
  root: string,
  suites: ReadonlyMap<string, readonly string[]>,
  files: readonly string[],
  opts: { readonly seconds: number; readonly cacheDir: string | null; readonly concurrency?: number },
): Promise<CoverageResult> {
  const uncovered = new Map<string, Map<string, Set<number>>>();
  const covered = new Map<string, Map<string, number>>();
  const passed = new Set<string>();
  const durations = new Map<string, number>();
  if (suites.size === 0) return { uncovered, covered, passed, durations };
  const fileSet = new Set(files.map(toPosix));
  const dir = mkdtempSync(join(tmpdir(), "bm-cov-"));
  const cache = opts.cacheDir;
  if (cache !== null) mkdirSync(cache, { recursive: true });
  const queue = [...suites.entries()];
  const cores = opts.concurrency ?? availableParallelism();
  const maxConc = Math.min(4, Math.max(2, Math.floor(cores / 3)));
  let seq = 0;
  const runOne = async ([name, paths]: readonly [string, readonly string[]]) => {
    const key = cacheKey(name);
    const sub = spawnsSubprocess(root, paths);
    if (cache !== null && existsSync(join(cache, `${key}.ok`))) {
      const ms = Number(readFileSync(join(cache, `${key}.ok`), "utf8").trim());
      passed.add(name);
      durations.set(name, Number.isFinite(ms) && ms > 0 ? ms : 500);
      const lcovPath = join(cache, `${key}.lcov`);
      if (!sub && existsSync(lcovPath)) {
        const parsed = parseCoverage(root, readFileSync(lcovPath, "utf8"), fileSet);
        uncovered.set(name, parsed.uncovered);
        covered.set(name, parsed.covered);
      }
      return;
    }
    seq += 1;
    const outDir = join(dir, String(seq));
    mkdirSync(outDir, { recursive: true });
    const started = Date.now();
    const covArgs = sub ? [] : ["--coverage", "--coverage-reporter=lcov", `--coverage-dir=${outDir}`];
    const bunTimeoutMs = Math.max(60_000, Math.ceil(opts.seconds * 1000) + 5_000);
    const run = Bun.spawn(
      [
        process.execPath,
        "test",
        "--bail",
        `--max-concurrency=${String(maxConc)}`,
        `--timeout=${String(bunTimeoutMs)}`,
        ...covArgs,
        ...paths,
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      },
    );
    const { said, code, signalled } = await drainProcess(run, opts.seconds);
    const ms = Math.max(1, Date.now() - started);
    if (signalled || code !== 0 || !VERDICT_RE.test(said)) return;
    passed.add(name);
    durations.set(name, ms);
    const lcovFile = join(outDir, "lcov.info");
    const lcov = !sub && existsSync(lcovFile) ? readFileSync(lcovFile, "utf8") : null;
    if (cache !== null) {
      if (lcov !== null) writeFileSync(join(cache, `${key}.lcov`), lcov);
      writeFileSync(join(cache, `${key}.ok`), `${String(ms)}\n`);
    }
    if (lcov !== null) {
      const parsed = parseCoverage(root, lcov, fileSet);
      uncovered.set(name, parsed.uncovered);
      covered.set(name, parsed.covered);
    }
  };
  try {
    const slots = Math.min(Math.max(2, Math.floor(cores / 3)), queue.length);
    await Promise.all(
      Array.from({ length: slots }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) await runOne(next);
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { uncovered, covered, passed, durations };
}
