import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SUBPROCESS_RE, toPosix } from "./discover.ts";
import { gitMaybe, gitRaw } from "./git.ts";
import { applyMutant } from "./mutants.ts";
import { drainProcess, type KillableProc } from "./proc.ts";
import { buildTraceSource } from "./schemata.ts";
import type { BatchPlan, Mutant, VerdictMap } from "./types.ts";

const VERDICT_RE = /\n *\d+ (pass|fail)|\nBailed out after \d+ failures?/;

const CLONE_SKIP_DIRS = new Set(["node_modules", ".bun-mutate", ".cache", ".turbo", ".next", "coverage"]);

const explicitPath = (path: string): string =>
  isAbsolute(path) || path.startsWith("./") || path.startsWith("../") ? path : `./${path}`;

export interface LocalWorker {
  readonly id: number;
  readonly clone: string;
}

export function suiteTimeoutSeconds(capSeconds: number, durationMs: number | undefined): number {
  if (durationMs === undefined) return capSeconds;
  return Math.min(capSeconds, Math.max(12, Math.ceil((durationMs / 1000) * 12) + 8));
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
  return Math.min(capSeconds, Math.max(15, Math.ceil((totalMs / 1000) * 10) + 10));
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
      ...paths.map(explicitPath),
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
  mutant: Mutant,
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
    readonly isPruned?: ((name: string, mutant: Mutant) => boolean) | undefined;
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
    if (opts.isPruned?.(name, mutant) === true) {
      out[name] = false;
      continue;
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
    readonly isPruned?: ((name: string, mutant: Mutant) => boolean) | undefined;
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
      const leadSaid =
        opts.isPruned?.(lead, mutant) === true
          ? false
          : await verdict(
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
      const prunedRest: VerdictMap = {};
      const liveRest: string[] = [];
      for (const name of rest) {
        if (opts.isPruned?.(name, mutant) === true) prunedRest[name] = false;
        else liveRest.push(name);
      }
      if (liveRest.length === 0) {
        return { kind: "ok", killed: { [lead]: leadSaid, ...prunedRest } };
      }
      if (liveRest.length === 1) {
        const fallback = await runSoloRest(seat, mutant, liveRest, prunedRest, {
          ...opts,
          beforeSuite: undefined,
        });
        return fallback.kind === "ok"
          ? { kind: "ok", killed: { [lead]: leadSaid, ...fallback.killed } }
          : fallback;
      }
      const paths = liveRest.flatMap((name) => opts.suites.get(name) ?? []);
      const batch = parseMultiFileBail(
        liveRest,
        opts.suites,
        await spawnTest(
          seat.clone,
          paths,
          combinedTimeoutSeconds(opts.seconds, liveRest, opts.durations),
          opts.localConc,
          opts.activeProcs,
        ),
      );
      const blamed = liveRest.find((name) => batch[name] === true);
      if (blamed !== undefined) {
        const solo = await verdict(
          seat.clone,
          opts.suites.get(blamed) ?? [],
          suiteTimeoutSeconds(opts.seconds, opts.durations.get(blamed)),
          opts.localConc,
          opts.activeProcs,
        );
        if (solo === true) return { kind: "ok", killed: { [lead]: leadSaid, ...prunedRest, ...batch } };
        const fallback = await runSoloRest(
          seat,
          mutant,
          liveRest,
          { ...prunedRest, [blamed]: solo },
          { ...opts, beforeSuite: undefined },
        );
        return fallback.kind === "ok"
          ? { kind: "ok", killed: { [lead]: leadSaid, ...fallback.killed } }
          : fallback;
      }
      if (liveRest.some((name) => batch[name] === null)) {
        const fallback = await runSoloRest(seat, mutant, liveRest, { ...prunedRest, ...batch }, {
          ...opts,
          beforeSuite: undefined,
        });
        return fallback.kind === "ok"
          ? { kind: "ok", killed: { [lead]: leadSaid, ...fallback.killed } }
          : fallback;
      }
      return { kind: "ok", killed: { [lead]: leadSaid, ...prunedRest, ...batch } };
    }
    return await runSoloRest(seat, mutant, active, {}, {
      ...opts,
      beforeSuite: opts.beforeSuite === undefined ? undefined : (name) => qualifyClean([name]),
    });
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

export interface LazyQualificationResult {
  readonly refused: string | null;
  readonly durationMs: number;
  readonly uncovered?: Map<string, Set<number>>;
  readonly covered?: Map<string, number>;
  readonly unreachedIds?: Map<string, Set<string>>;
}

export async function qualifySuiteWithPruning(
  worker: LocalWorker,
  name: string,
  paths: readonly string[],
  opts: {
    readonly root: string;
    readonly files: readonly string[];
    readonly originals: ReadonlyMap<string, string>;
    readonly mutantsByFile: ReadonlyMap<string, readonly Mutant[]>;
    readonly helperFiles: readonly string[];
    readonly prune: boolean;
    readonly seconds: number;
    readonly localConc: number;
  },
): Promise<LazyQualificationResult> {
  if (paths.length === 0) return { refused: "no suites given", durationMs: 0 };
  const sub = spawnsSubprocess(opts.root, paths, opts.helperFiles);
  if (!opts.prune) {
    const t0 = Date.now();
    const said = await verdict(worker.clone, paths, opts.seconds, opts.localConc);
    const durationMs = Math.max(1, Date.now() - t0);
    if (said === false) return { refused: null, durationMs };
    return {
      refused: `baseline suite "${name}" did not pass unmutated (${said === true ? "failed" : "no verdict"})`,
      durationMs,
    };
  }
  if (!sub) {
    const outDir = mkdtempSync(join(tmpdir(), "bm-lcov-"));
    try {
      const t0 = Date.now();
      const bunTimeoutMs = Math.max(60_000, Math.ceil(opts.seconds * 1000) + 5_000);
      const run = Bun.spawn(
        [
          process.execPath,
          "test",
          "--bail",
          `--max-concurrency=${String(opts.localConc)}`,
          `--timeout=${String(bunTimeoutMs)}`,
          "--coverage",
          "--coverage-reporter=lcov",
          `--coverage-dir=${outDir}`,
          ...paths.map(explicitPath),
        ],
        { cwd: worker.clone, stdout: "pipe", stderr: "pipe", detached: true },
      );
      const { said, code, signalled } = await drainProcess(run, opts.seconds);
      const durationMs = Math.max(1, Date.now() - t0);
      const ok = !signalled && code === 0 && VERDICT_RE.test(said);
      if (!ok) {
        const reason = !signalled && VERDICT_RE.test(said) && code !== 0 ? "failed" : "no verdict";
        return {
          refused: `baseline suite "${name}" did not pass unmutated (${reason})`,
          durationMs,
        };
      }
      const lcovFile = join(outDir, "lcov.info");
      if (existsSync(lcovFile)) {
        const parsed = parseCoverage(
          worker.clone,
          readFileSync(lcovFile, "utf8"),
          new Set(opts.files.map(toPosix)),
        );
        return { refused: null, durationMs, uncovered: parsed.uncovered, covered: parsed.covered };
      }
      return { refused: null, durationMs };
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
  // Subprocess-spawning suite: instrument target files on disk in this worker's clone once to record
  // exact reachability across parent + all child processes; fail closed to plain baseline on error.
  const traceDir = mkdtempSync(join(tmpdir(), "bm-trace-"));
  const written: Array<{
    readonly file: string;
    readonly tracePath: string;
    readonly encoded: ReadonlyMap<number, Mutant>;
  }> = [];
  try {
    let idx = 0;
    for (const file of opts.files) {
      const original = opts.originals.get(file);
      const fileMutants = opts.mutantsByFile.get(file);
      if (original === undefined || fileMutants === undefined || fileMutants.length === 0) continue;
      idx += 1;
      const tracePath = join(traceDir, `t-${String(idx)}.txt`);
      const built = buildTraceSource(file, original, fileMutants, tracePath);
      if (built.source === null || built.encoded.size === 0) continue;
      replaceFile(join(worker.clone, file), built.source);
      written.push({ file, tracePath, encoded: built.encoded });
    }
    if (written.length > 0) {
      const t0 = Date.now();
      const said = await verdict(worker.clone, paths, opts.seconds, opts.localConc);
      const durationMs = Math.max(1, Date.now() - t0);
      for (const item of written) {
        const orig = opts.originals.get(item.file);
        if (orig !== undefined) replaceFile(join(worker.clone, item.file), orig);
      }
      if (said === false) {
        const unreachedIds = new Map<string, Set<string>>();
        const covered = new Map<string, number>();
        for (const item of written) {
          const hitIndices = new Set<number>();
          if (existsSync(item.tracePath)) {
            for (const line of readFileSync(item.tracePath, "utf8").split("\n")) {
              const trimmed = line.trim();
              if (trimmed.length > 0) hitIndices.add(Number(trimmed));
            }
          }
          const unreached = new Set<string>();
          let reachedCount = 0;
          for (const [k, mutant] of item.encoded) {
            if (hitIndices.has(k)) reachedCount += 1;
            else unreached.add(mutant.id);
          }
          if (unreached.size > 0) unreachedIds.set(item.file, unreached);
          if (reachedCount > 0) covered.set(item.file, reachedCount);
        }
        return { refused: null, durationMs, unreachedIds, covered };
      }
    }
  } finally {
    for (const item of written) {
      const orig = opts.originals.get(item.file);
      if (orig !== undefined) replaceFile(join(worker.clone, item.file), orig);
    }
    rmSync(traceDir, { recursive: true, force: true });
  }
  // Fail-closed fallback: plain uninstrumented baseline qualification with no pruning for this suite.
  const t0 = Date.now();
  const said = await verdict(worker.clone, paths, opts.seconds, opts.localConc);
  const durationMs = Math.max(1, Date.now() - t0);
  if (said === false) return { refused: null, durationMs };
  return {
    refused: `baseline suite "${name}" did not pass unmutated (${said === true ? "failed" : "no verdict"})`,
    durationMs,
  };
}

function cloneGitTree(absRoot: string, absDest: string, skipInsideRoot: string | null): boolean {
  if (gitMaybe(absRoot, "rev-parse", "--show-prefix") !== "") return false;
  const listed = gitRaw(
    absRoot,
    "-c",
    "core.quotePath=false",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  );
  if (listed === null) return false;
  const made = new Set<string>();
  for (const rel of listed.split("\0")) {
    if (rel === "") continue;
    const top = rel.split("/")[0] ?? "";
    if (CLONE_SKIP_DIRS.has(top) || top === skipInsideRoot) continue;
    const src = join(absRoot, rel);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(src);
    } catch {
      continue;
    }
    const dst = join(absDest, rel);
    const parent = dirname(dst);
    if (!made.has(parent)) {
      mkdirSync(parent, { recursive: true });
      made.add(parent);
    }
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(src), dst);
    else if (stat.isFile()) copyFileSync(src, dst, constants.COPYFILE_FICLONE);
  }
  const objects = gitMaybe(absRoot, "rev-parse", "--path-format=absolute", "--git-path", "objects");
  if (objects !== null && gitMaybe(absDest, "init", "-q") !== null) {
    mkdirSync(join(absDest, ".git", "objects", "info"), { recursive: true });
    writeFileSync(join(absDest, ".git", "objects", "info", "alternates"), `${objects}\n`);
    const head = gitMaybe(absRoot, "rev-parse", "-q", "--verify", "HEAD^{commit}");
    if (head !== null) writeFileSync(join(absDest, ".git", "HEAD"), `${head}\n`);
    const index = gitMaybe(absRoot, "rev-parse", "--path-format=absolute", "--git-path", "index");
    if (index !== null && existsSync(index)) {
      copyFileSync(index, join(absDest, ".git", "index"), constants.COPYFILE_FICLONE);
    }
  }
  return true;
}

export async function cloneTree(root: string, dest: string): Promise<void> {
  const absRoot = resolve(root);
  const absDest = resolve(dest);
  rmSync(absDest, { recursive: true, force: true });
  mkdirSync(absDest, { recursive: true });
  const skipInsideRoot = absDest.startsWith(`${absRoot}/`)
    ? absDest.slice(absRoot.length + 1).split("/")[0] ?? null
    : null;
  if (cloneGitTree(absRoot, absDest, skipInsideRoot)) return;
  const entries = readdirSync(absRoot).filter(
    (name) => !CLONE_SKIP_DIRS.has(name) && name !== skipInsideRoot,
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
  for (const wsDir of ["packages", "apps"]) {
    const absWs = join(root, wsDir);
    if (!existsSync(absWs)) continue;
    try {
      for (const entry of readdirSync(absWs, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgMods = join(absWs, entry.name, "node_modules");
        const clonePkgMods = join(clone, wsDir, entry.name, "node_modules");
        if (existsSync(pkgMods) && existsSync(dirname(clonePkgMods)) && !existsSync(clonePkgMods)) {
          symlinkSync(pkgMods, clonePkgMods);
        }
      }
    } catch {
      // Ignore unreadable workspace directories
    }
  }
}

export function spawnsSubprocess(
  root: string,
  paths: readonly string[],
  helperFiles: readonly string[] = [],
): boolean {
  for (const path of [...paths, ...helperFiles]) {
    const full = join(root, path);
    if (existsSync(full) && SUBPROCESS_RE.test(readFileSync(full, "utf8"))) return true;
  }
  return false;
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

function isCacheFresh(cachePath: string, root: string, deps: readonly string[]): boolean {
  if (!existsSync(cachePath)) return false;
  let cacheMtime: number;
  try {
    cacheMtime = statSync(cachePath).mtimeMs;
  } catch {
    return false;
  }
  for (const dep of deps) {
    const full = join(root, dep);
    if (!existsSync(full)) continue;
    try {
      if (statSync(full).mtimeMs > cacheMtime) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function loadCachedDurations(cacheDir: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (cacheDir === null || !existsSync(cacheDir)) return out;
  try {
    for (const file of readdirSync(cacheDir)) {
      if (!file.endsWith(".ok")) continue;
      const ms = Number(readFileSync(join(cacheDir, file), "utf8").trim());
      if (Number.isFinite(ms) && ms > 0) out.set(file.slice(0, -3), ms);
    }
  } catch {
    // Ignore unreadable cache directory
  }
  return out;
}

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
  opts: {
    readonly seconds: number;
    readonly cacheDir: string | null;
    readonly concurrency?: number;
    readonly helperFiles?: ReadonlyMap<string, readonly string[]>;
  },
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
    const helpers = opts.helperFiles?.get(name) ?? [];
    const sub = spawnsSubprocess(root, paths, helpers);
    const suiteDeps = [...paths, ...helpers];
    const okPath = cache !== null ? join(cache, `${key}.ok`) : null;
    const lcovPath = cache !== null ? join(cache, `${key}.lcov`) : null;
    const okFresh = okPath !== null && isCacheFresh(okPath, root, suiteDeps);
    const lcovFresh = lcovPath !== null && isCacheFresh(lcovPath, root, [...suiteDeps, ...files]);
    if (okFresh && (sub || lcovFresh)) {
      const ms = Number(readFileSync(okPath, "utf8").trim());
      passed.add(name);
      durations.set(name, Number.isFinite(ms) && ms > 0 ? ms : 500);
      if (!sub && lcovPath !== null && existsSync(lcovPath)) {
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
        ...paths.map(explicitPath),
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
