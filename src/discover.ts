import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { gitRaw } from "./git.ts";

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".git",
  "vendor",
  ".bun-mutate",
  ".next",
  ".turbo",
  ".cache",
]);

const STANDARD_SOURCE_DIRS = ["src", "lib", "app", "tools"] as const;
const SOURCE_EXT_RE = /\.(?:[cm]?ts|tsx)$/u;
const DECLARATION_RE = /\.d\.[cm]?ts$/u;
const TEST_FILE_RE = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/u;
const TEST_DIR_SEGMENT_RE = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/u;
const TEST_HELPER_RE = /(?:^|\/)(?:test|tests|__tests__|helpers?|fixtures?)(?:\/|$)/u;

export const SUBPROCESS_RE =
  /\b(?:Bun\.spawn|Bun\.spawnSync|spawnSync|execSync|execFileSync|child_process)\b|node:child_process/u;

export const FS_WRITE_RE =
  /\b(?:writeFileSync|mkdtempSync|rmSync|mkdirSync|appendFileSync|renameSync|copyFileSync|cpSync|symlinkSync|chmodSync|Bun\.write)\b|fs\/promises/u;

export const STATEFUL_SUITE_RE =
  /\b(?:writeFileSync|mkdtempSync|rmSync|mkdirSync|appendFileSync|renameSync|copyFileSync|cpSync|symlinkSync|chmodSync|Bun\.write|spyOn|beforeAll|afterAll|process\.env|Bun\.env|fetch|createServer|Bun\.serve)\b|fs\/promises/u;

export const SCHEMATA_BLOCK_RE = /\b(?:mock\.module)\b|\.only\b/u;

export const IMPURE_SUITE_RE =
  /\b(?:writeFileSync|mkdtempSync|rmSync|mkdirSync|appendFileSync|renameSync|copyFileSync|cpSync|symlinkSync|chmodSync|Bun\.write|Bun\.spawn|Bun\.spawnSync|spawnSync|execSync|execFileSync|child_process|mock\.module|spyOn|setDefaultTimeout|beforeAll|afterAll|process\.env|Bun\.env|fetch|createServer|Bun\.serve)\b|fs\/promises|\.(?:each|only|skip|todo|if|skipIf|todoIf|failing)\b/u;

const TS_TRANSPILER = new Bun.Transpiler({ loader: "ts" });
const TSX_TRANSPILER = new Bun.Transpiler({ loader: "tsx" });
const JS_TRANSPILER = new Bun.Transpiler({ loader: "js" });
const JSX_TRANSPILER = new Bun.Transpiler({ loader: "jsx" });

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const INDEX_FILES = ["index.ts", "index.tsx", "index.mts", "index.cts", "index.js", "index.mjs"] as const;

export const toPosix = (p: string): string => p.replaceAll("\\", "/");

export function isTestFile(relPath: string): boolean {
  const norm = toPosix(relPath);
  return TEST_FILE_RE.test(norm);
}

export function isSourceFile(relPath: string): boolean {
  const norm = toPosix(relPath);
  if (!SOURCE_EXT_RE.test(norm)) return false;
  if (DECLARATION_RE.test(norm)) return false;
  if (TEST_FILE_RE.test(norm)) return false;
  if (TEST_DIR_SEGMENT_RE.test(norm)) return false;
  const parts = norm.split("/");
  return !parts.some((seg) => IGNORED_DIRS.has(seg));
}

interface AliasRule {
  readonly prefix: string;
  readonly suffix: string;
  readonly wildcard: boolean;
  readonly targets: readonly string[];
  readonly baseDir: string;
}

export interface RepoAliases {
  readonly baseUrl: string | null;
  readonly rules: readonly AliasRule[];
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readTsConfig(root: string): Record<string, unknown> | null {
  const path = join(root, "tsconfig.json");
  if (!existsSync(path)) return null;
  try {
    const res = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
    if (res.error !== undefined || typeof res.config !== "object" || res.config === null) return null;
    return res.config as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractTargets(val: unknown): string[] {
  if (typeof val === "string") return [val];
  if (Array.isArray(val)) return val.flatMap(extractTargets);
  if (typeof val === "object" && val !== null) {
    const rec = val as Record<string, unknown>;
    const preferred = ["bun", "import", "node", "default"];
    const out: string[] = [];
    for (const key of preferred) {
      if (key in rec) out.push(...extractTargets(rec[key]));
    }
    for (const [key, entry] of Object.entries(rec)) {
      if (!preferred.includes(key)) out.push(...extractTargets(entry));
    }
    return out;
  }
  return [];
}

function parsePatternRule(pattern: string, targets: readonly string[], baseDir: string): AliasRule | null {
  if (targets.length === 0) return null;
  const star = pattern.indexOf("*");
  if (star === -1) {
    return { prefix: pattern, suffix: "", wildcard: false, targets, baseDir };
  }
  return {
    prefix: pattern.slice(0, star),
    suffix: pattern.slice(star + 1),
    wildcard: true,
    targets,
    baseDir,
  };
}

export function loadRepoAliases(root: string): RepoAliases {
  const rules: AliasRule[] = [];
  let baseUrl: string | null = null;
  const tsconfig = readTsConfig(root);
  if (tsconfig !== null) {
    const compiler =
      typeof tsconfig.compilerOptions === "object" && tsconfig.compilerOptions !== null
        ? (tsconfig.compilerOptions as Record<string, unknown>)
        : null;
    if (compiler !== null) {
      if (typeof compiler.baseUrl === "string" && compiler.baseUrl.trim() !== "") {
        baseUrl = resolve(root, compiler.baseUrl);
      }
      const pathsBase = baseUrl ?? root;
      if (typeof compiler.paths === "object" && compiler.paths !== null) {
        for (const [pattern, rawTargets] of Object.entries(compiler.paths as Record<string, unknown>)) {
          const rule = parsePatternRule(pattern, extractTargets(rawTargets), pathsBase);
          if (rule !== null) rules.push(rule);
        }
      }
    }
  }
  const pkg = readJsonFile(join(root, "package.json"));
  if (pkg !== null && typeof pkg.imports === "object" && pkg.imports !== null) {
    for (const [pattern, rawTargets] of Object.entries(pkg.imports as Record<string, unknown>)) {
      const rule = parsePatternRule(pattern, extractTargets(rawTargets), root);
      if (rule !== null) rules.push(rule);
    }
  }
  return { baseUrl, rules };
}

function stripGlobTail(pattern: string): string | null {
  const clean = toPosix(pattern).replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (clean === "" || clean === "." || clean.startsWith("..")) return null;
  const parts = clean.split("/");
  const concrete: string[] = [];
  for (const part of parts) {
    if (part.includes("*") || part.includes("?") || part.includes("[")) break;
    concrete.push(part);
  }
  if (concrete.length === 0) return null;
  return concrete.join("/");
}

function collectPackageEntryStrings(val: unknown): string[] {
  if (typeof val === "string") return [val];
  if (Array.isArray(val)) return val.flatMap(collectPackageEntryStrings);
  if (typeof val === "object" && val !== null) {
    return Object.values(val as Record<string, unknown>).flatMap(collectPackageEntryStrings);
  }
  return [];
}

function addIfValidSourceRoot(root: string, candidate: string, roots: Set<string>): void {
  const norm = toPosix(candidate).replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (norm === "" || norm === "." || norm.startsWith("..")) return;
  const firstSeg = norm.split("/")[0] ?? "";
  if (IGNORED_DIRS.has(firstSeg) || TEST_DIR_SEGMENT_RE.test(norm)) return;
  const full = join(root, norm);
  if (!existsSync(full)) return;
  const stat = statSync(full);
  if (stat.isDirectory()) {
    roots.add(norm);
  } else if (stat.isFile() && isSourceFile(norm)) {
    const dir = toPosix(dirname(norm));
    roots.add(dir === "." ? norm : dir);
  }
}

export function discoverSourceRoots(root: string): string[] {
  const roots = new Set<string>();
  const tsconfig = readTsConfig(root);
  if (tsconfig !== null) {
    const compiler =
      typeof tsconfig.compilerOptions === "object" && tsconfig.compilerOptions !== null
        ? (tsconfig.compilerOptions as Record<string, unknown>)
        : null;
    if (compiler !== null && typeof compiler.rootDir === "string") {
      addIfValidSourceRoot(root, compiler.rootDir, roots);
    }
    if (Array.isArray(tsconfig.include)) {
      for (const item of tsconfig.include) {
        if (typeof item !== "string") continue;
        const base = stripGlobTail(item);
        if (base !== null) addIfValidSourceRoot(root, base, roots);
      }
    }
  }
  const pkg = readJsonFile(join(root, "package.json"));
  if (pkg !== null) {
    for (const field of ["exports", "main", "module", "bin"] as const) {
      if (!(field in pkg)) continue;
      for (const entry of collectPackageEntryStrings(pkg[field])) {
        const clean = toPosix(entry).replace(/^\.\//u, "");
        if (!SOURCE_EXT_RE.test(clean)) continue;
        addIfValidSourceRoot(root, clean, roots);
      }
    }
  }
  for (const dir of STANDARD_SOURCE_DIRS) {
    addIfValidSourceRoot(root, dir, roots);
  }
  const packagesDir = join(root, "packages");
  if (existsSync(packagesDir) && statSync(packagesDir).isDirectory()) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
      addIfValidSourceRoot(root, `packages/${entry.name}/src`, roots);
    }
  }
  const sorted = [...roots].toSorted();
  return sorted.filter(
    (candidate, idx) => !sorted.some((other, j) => j !== idx && candidate.startsWith(`${other}/`)),
  );
}

function walkFiles(root: string, startRel: string, keep: (rel: string) => boolean, out: Set<string>): void {
  const startAbs = startRel === "" ? root : join(root, startRel);
  if (!existsSync(startAbs)) return;
  const st = statSync(startAbs);
  if (st.isFile()) {
    const rel = toPosix(relative(root, startAbs));
    if (keep(rel)) out.add(rel);
    return;
  }
  const stack: string[] = [startAbs];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        stack.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        const rel = toPosix(relative(root, join(dir, entry.name)));
        if (keep(rel)) out.add(rel);
      }
    }
  }
}

function listGitFiles(root: string): string[] | null {
  const raw = gitRaw(root, "-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard");
  if (raw === null) return null;
  return raw
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map(toPosix);
}

export function discoverSourceFiles(root: string): string[] {
  const roots = discoverSourceRoots(root);
  const gitFiles = listGitFiles(root);
  if (gitFiles !== null) {
    const inRoots = (rel: string): boolean =>
      roots.length === 0 || roots.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
    return gitFiles.filter((rel) => inRoots(rel) && isSourceFile(rel) && existsSync(join(root, rel))).toSorted();
  }
  const files = new Set<string>();
  if (roots.length === 0) {
    walkFiles(root, "", isSourceFile, files);
  } else {
    for (const dir of roots) walkFiles(root, dir, isSourceFile, files);
  }
  return [...files].toSorted();
}

export function discoverTestFiles(root: string): string[] {
  const gitFiles = listGitFiles(root);
  if (gitFiles !== null) {
    return gitFiles.filter((rel) => isTestFile(rel) && existsSync(join(root, rel))).toSorted();
  }
  const tests = new Set<string>();
  walkFiles(root, "", isTestFile, tests);
  return [...tests].toSorted();
}

function transpilerFor(file: string): Bun.Transpiler | null {
  if (/\.[cm]?tsx$/u.test(file)) return TSX_TRANSPILER;
  if (/\.[cm]?ts$/u.test(file)) return TS_TRANSPILER;
  if (/\.[cm]?jsx$/u.test(file)) return JSX_TRANSPILER;
  if (/\.[cm]?js$/u.test(file)) return JS_TRANSPILER;
  return null;
}

function scanRuntimeSpecifiers(root: string, rel: string): readonly string[] {
  const transpiler = transpilerFor(rel);
  if (transpiler === null) return [];
  let raw: string;
  try {
    raw = readFileSync(join(root, rel), "utf8");
  } catch {
    return [];
  }
  try {
    // Transpiling strips `import type`, `export type`, and type-only named imports so only runtime edges remain.
    const js = transpiler.transformSync(raw);
    return JS_TRANSPILER.scanImports(js).map((entry) => entry.path);
  } catch {
    try {
      return transpiler.scanImports(raw).map((entry) => entry.path);
    } catch {
      return [];
    }
  }
}

function resolveCandidateFile(absBase: string): string | null {
  const candidates: string[] = [];
  if (/\.[cm]?js$/u.test(absBase)) {
    const stem = absBase.replace(/\.[cm]?js$/u, "");
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, absBase);
  } else if (/\.[cm]?jsx$/u.test(absBase)) {
    const stem = absBase.replace(/\.[cm]?jsx$/u, "");
    candidates.push(`${stem}.tsx`, `${stem}.ts`, absBase);
  } else {
    for (const ext of RESOLVE_EXTS) candidates.push(`${absBase}${ext}`);
  }
  for (const cand of candidates) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  if (existsSync(absBase) && statSync(absBase).isDirectory()) {
    for (const idx of INDEX_FILES) {
      const full = join(absBase, idx);
      if (existsSync(full) && statSync(full).isFile()) return full;
    }
  }
  return null;
}

function resolveAlias(specifier: string, aliases: RepoAliases): string | null {
  for (const rule of aliases.rules) {
    if (!rule.wildcard) {
      if (specifier !== rule.prefix) continue;
      for (const target of rule.targets) {
        const hit = resolveCandidateFile(resolve(rule.baseDir, target));
        if (hit !== null) return hit;
      }
      continue;
    }
    if (
      specifier.length >= rule.prefix.length + rule.suffix.length &&
      specifier.startsWith(rule.prefix) &&
      specifier.endsWith(rule.suffix)
    ) {
      const matched = specifier.slice(rule.prefix.length, specifier.length - rule.suffix.length);
      for (const target of rule.targets) {
        const expanded = target.includes("*") ? target.replace("*", matched) : target;
        const hit = resolveCandidateFile(resolve(rule.baseDir, expanded));
        if (hit !== null) return hit;
      }
    }
  }
  if (aliases.baseUrl !== null && !specifier.startsWith(".") && !specifier.startsWith("/")) {
    const hit = resolveCandidateFile(resolve(aliases.baseUrl, specifier));
    if (hit !== null) return hit;
  }
  return null;
}

function resolveSpecifier(
  root: string,
  fromFile: string,
  specifier: string,
  aliases: RepoAliases,
): string | null {
  if (specifier.startsWith("bun:") || specifier.startsWith("node:")) return null;
  let abs: string | null = null;
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const base = specifier.startsWith("/") ? specifier : resolve(dirname(join(root, fromFile)), specifier);
    abs = resolveCandidateFile(base);
  } else {
    abs = resolveAlias(specifier, aliases);
  }
  if (abs === null) {
    try {
      abs = Bun.resolveSync(specifier, dirname(join(root, fromFile)));
    } catch {
      abs = null;
    }
  }
  if (abs === null || !isAbsolute(abs)) return null;
  const rel = toPosix(relative(root, abs));
  if (rel.startsWith("..") || rel.includes("node_modules/")) return null;
  return rel;
}

function runtimeText(root: string, rel: string): string {
  const transpiler = transpilerFor(rel);
  if (transpiler === null) return "";
  try {
    return transpiler.transformSync(readFileSync(join(root, rel), "utf8"));
  } catch {
    return "";
  }
}

const joinedPath = (path: string): string =>
  toPosix(path)
    .split("/")
    .map((part) => JSON.stringify(part))
    .join(", ");

const pathMentioned = (code: string, path: string): boolean => {
  const norm = toPosix(path);
  return code.includes(norm) || code.includes(joinedPath(norm));
};

export interface TestIndex {
  readonly tests: readonly string[];
  readonly importsOf: (file: string) => readonly string[];
  readonly within: (start: string, depth: number) => Set<string>;
  readonly helperFilesOf: (testFile: string) => readonly string[];
  readonly suitesFor: (owner: string) => string[];
}

export function buildTestIndex(
  root: string,
  opts?: { readonly depth?: number; readonly timings?: ReadonlyMap<string, number> },
): TestIndex {
  const depth = opts?.depth ?? 1;
  const timings = opts?.timings ?? new Map<string, number>();
  const aliases = loadRepoAliases(root);
  const tests = discoverTestFiles(root);
  const importCache = new Map<string, readonly string[]>();

  const importsOf = (file: string): readonly string[] => {
    const norm = toPosix(file);
    const cached = importCache.get(norm);
    if (cached !== undefined) return cached;
    const resolved = new Set<string>();
    for (const spec of scanRuntimeSpecifiers(root, norm)) {
      const hit = resolveSpecifier(root, norm, spec, aliases);
      if (hit !== null) resolved.add(hit);
    }
    const list = [...resolved];
    importCache.set(norm, list);
    return list;
  };

  const within = (start: string, limit: number): Set<string> => {
    const norm = toPosix(start);
    const reached = new Set([norm]);
    let layer = [norm];
    for (let hop = 0; hop < limit && layer.length > 0; hop += 1) {
      const next: string[] = [];
      for (const file of layer) {
        for (const dep of importsOf(file)) {
          if (!reached.has(dep)) {
            reached.add(dep);
            next.push(dep);
          }
        }
      }
      layer = next;
    }
    return reached;
  };

  const helperCache = new Map<string, readonly string[]>();
  const helperFilesOf = (testFile: string): readonly string[] => {
    const norm = toPosix(testFile);
    const cached = helperCache.get(norm);
    if (cached !== undefined) return cached;
    const helpers = [...within(norm, 2)].filter((file) => file !== norm && TEST_HELPER_RE.test(file));
    helperCache.set(norm, helpers);
    return helpers;
  };

  const tierCache = new Map<string, number>();
  const speedTierOf = (testFile: string): number => {
    const cached = tierCache.get(testFile);
    if (cached !== undefined) return cached;
    let tier = 0;
    for (const file of [testFile, ...helperFilesOf(testFile)]) {
      const full = join(root, file);
      if (!existsSync(full)) continue;
      const text = readFileSync(full, "utf8");
      if (SUBPROCESS_RE.test(text)) {
        tier = 2;
        break;
      }
      if (IMPURE_SUITE_RE.test(text)) tier = Math.max(tier, 1);
    }
    tierCache.set(testFile, tier);
    return tier;
  };

  const reachAt = (limit: number) =>
    new Map(
      tests.map((test) => {
        const seen = within(test, limit);
        seen.delete(test);
        return [test, seen] as const;
      }),
    );

  const direct = reachAt(1);
  const reachable = depth === 1 ? direct : reachAt(depth);
  let transitive: Map<string, Set<string>> | null = null;
  const transformed = new Map(tests.map((test) => [test, runtimeText(root, test)] as const));

  const compareSuites =
    (owner: string) =>
    (a: string, b: string): number => {
      const directDiff =
        (direct.get(a)?.has(owner) === true ? 0 : 1) - (direct.get(b)?.has(owner) === true ? 0 : 1);
      if (directDiff !== 0) return directDiff;
      const ta = timings.get(a) ?? timings.get(suiteNameForPath(a));
      const tb = timings.get(b) ?? timings.get(suiteNameForPath(b));
      if (ta !== undefined && tb !== undefined) return ta - tb;
      if (ta !== undefined || tb !== undefined) return ta === undefined ? 1 : -1;
      const tierDiff = speedTierOf(a) - speedTierOf(b);
      if (tierDiff !== 0) return tierDiff;
      return statSync(join(root, a)).size - statSync(join(root, b)).size;
    };

  const suitesFor = (ownerRaw: string): string[] => {
    const owner = toPosix(ownerRaw);
    let matched = tests.filter(
      (path) => reachable.get(path)?.has(owner) === true || pathMentioned(transformed.get(path) ?? "", owner),
    );
    if (matched.length === 0 && depth < Number.POSITIVE_INFINITY) {
      transitive ??= reachAt(Number.POSITIVE_INFINITY);
      matched = tests.filter((path) => transitive?.get(path)?.has(owner) === true);
    }
    if (matched.length === 0) {
      const parent = toPosix(dirname(owner));
      if (parent !== "." && parent.includes("/")) {
        const needle = joinedPath(parent);
        matched = tests.filter((path) => (transformed.get(path) ?? "").includes(needle));
      }
    }
    return matched.toSorted(compareSuites(owner));
  };

  return { tests, importsOf, within, helperFilesOf, suitesFor };
}

export function collectSuiteHelperDeps(
  root: string,
  suites: ReadonlyMap<string, readonly string[]>,
  index?: TestIndex,
): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  const aliases = index === undefined ? loadRepoAliases(root) : null;
  const localCache = new Map<string, readonly string[]>();
  const localImports = (file: string): readonly string[] => {
    const norm = toPosix(file);
    const hit = localCache.get(norm);
    if (hit !== undefined) return hit;
    const resolved = new Set<string>();
    if (aliases !== null) {
      for (const spec of scanRuntimeSpecifiers(root, norm)) {
        const target = resolveSpecifier(root, norm, spec, aliases);
        if (target !== null) resolved.add(target);
      }
    }
    const list = [...resolved];
    localCache.set(norm, list);
    return list;
  };
  const helpersFor = (testFile: string): readonly string[] => {
    if (index !== undefined) return index.helperFilesOf(testFile);
    const norm = toPosix(testFile);
    const seen = new Set<string>([norm]);
    let layer = [norm];
    for (let hop = 0; hop < 2 && layer.length > 0; hop += 1) {
      const next: string[] = [];
      for (const cur of layer) {
        for (const dep of localImports(cur)) {
          if (!seen.has(dep)) {
            seen.add(dep);
            next.push(dep);
          }
        }
      }
      layer = next;
    }
    return [...seen].filter((file) => file !== norm && TEST_HELPER_RE.test(file));
  };
  for (const [name, paths] of suites) {
    const helpers = new Set<string>();
    for (const path of paths) {
      for (const dep of helpersFor(path)) helpers.add(dep);
    }
    if (helpers.size > 0) out.set(name, [...helpers]);
  }
  return out;
}

export function suiteNameForPath(relPath: string): string {
  return toPosix(relPath)
    .replace(/^(?:test|tests|__tests__)\//u, "")
    .replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/u, "");
}

export function buildSuiteMap(paths: readonly string[]): Record<string, readonly string[]> {
  const used = new Set<string>();
  const entries: [string, readonly string[]][] = [];
  for (const path of paths) {
    let name = suiteNameForPath(path);
    if (used.has(name)) name = toPosix(path);
    used.add(name);
    entries.push([name, [toPosix(path)]]);
  }
  return Object.fromEntries(entries);
}
