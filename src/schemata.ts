import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { FS_WRITE_RE, SCHEMATA_BLOCK_RE, STATEFUL_SUITE_RE, SUBPROCESS_RE } from "./discover.ts";
import { isPropertyNameNode, scriptKindFor } from "./mutants.ts";
import { killProcessGroup, streamLines } from "./proc.ts";
import type { Mutant } from "./types.ts";

const BUN_TEST_IMPORT_RE = /import\s+\{[^}]+\}\s+from\s+["']bun:test["']/u;

const BINARY_OP_CODES = new Map<string, readonly [number, string]>([
  ["<", [0, "<="]],
  ["<=", [1, "<"]],
  [">", [2, ">="]],
  [">=", [3, ">"]],
  ["===", [4, "!=="]],
  ["!==", [5, "==="]],
  ["+", [6, "-"]],
  ["-", [7, "+"]],
]);

const SHORT_CIRCUIT_CODES = new Map<string, readonly [number, string]>([
  ["&&", [0, "||"]],
  ["||", [1, "&&"]],
  ["??", [2, "&&"]],
]);

const TS_TRANSPILER = new Bun.Transpiler({ loader: "ts" });
const TSX_TRANSPILER = new Bun.Transpiler({ loader: "tsx" });

const SCHEMA_HELPERS = `function __bmIf(k: number): boolean { return !__bmHit(k); }
function __bmNot(k: number, v: unknown): unknown { return __bmHit(k) ? v : !v; }
function __bmCond(k: number, v: unknown): boolean { return __bmHit(k) ? !v : Boolean(v); }
function __bmLit<T>(k: number, orig: T, alt: T): T { return __bmHit(k) ? alt : orig; }
function __bmL(k: number, op: number, a: () => unknown, b: () => unknown): unknown {
  const m = __bmHit(k);
  if (op === 0) return m ? (a() || b()) : (a() && b());
  if (op === 1) return m ? (a() && b()) : (a() || b());
  return m ? (a() && b()) : (a() ?? b());
}
function __bmB(k: number, op: number, a: unknown, b: unknown): unknown {
  const m = __bmHit(k);
  switch (op) {
    case 0: return m ? (a as number) <= (b as number) : (a as number) < (b as number);
    case 1: return m ? (a as number) < (b as number) : (a as number) <= (b as number);
    case 2: return m ? (a as number) >= (b as number) : (a as number) > (b as number);
    case 3: return m ? (a as number) > (b as number) : (a as number) >= (b as number);
    case 4: return m ? a !== b : a === b;
    case 5: return m ? a === b : a !== b;
    case 6: return m ? (a as number) - (b as number) : (a as number) + (b as number);
    default: return m ? (a as number) + (b as number) : (a as number) - (b as number);
  }
}
`;

const SCHEMA_PREAMBLE = `const __bmSch = () => (globalThis as unknown as { __BM_SCH?: { m: number; rec: boolean; hits: Set<number> } }).__BM_SCH;
function __bmHit(k: number): boolean {
  const s = __bmSch();
  if (s === undefined) return false;
  if (s.rec) s.hits.add(k);
  return s.m === k;
}
${SCHEMA_HELPERS}`;

function tracePreamble(tracePath: string): string {
  return `import { appendFileSync as __bmAppend } from "node:fs";
const __bmSeen = new Set<number>();
function __bmHit(k: number): boolean {
  if (!__bmSeen.has(k)) {
    __bmSeen.add(k);
    __bmAppend(${JSON.stringify(tracePath)}, String(k) + "\\n");
  }
  return false;
}
${SCHEMA_HELPERS}`;
}

export interface SuiteProfile {
  readonly eligible: boolean;
  readonly stateful: boolean;
  readonly writesFs: boolean;
}

export function classifySchemataSuite(
  root: string,
  paths: readonly string[],
  helperFiles: readonly string[] = [],
): SuiteProfile {
  if (paths.length !== 1) return { eligible: false, stateful: false, writesFs: false };
  const only = paths[0];
  if (only === undefined) return { eligible: false, stateful: false, writesFs: false };
  const full = join(root, only);
  if (!existsSync(full)) return { eligible: false, stateful: false, writesFs: false };
  const text = readFileSync(full, "utf8");
  if (!BUN_TEST_IMPORT_RE.test(text) || SUBPROCESS_RE.test(text) || SCHEMATA_BLOCK_RE.test(text)) {
    return { eligible: false, stateful: false, writesFs: false };
  }
  let stateful = STATEFUL_SUITE_RE.test(text);
  let writesFs = FS_WRITE_RE.test(text);
  for (const dep of helperFiles) {
    const depFull = join(root, dep);
    if (!existsSync(depFull)) continue;
    const depText = readFileSync(depFull, "utf8");
    if (SUBPROCESS_RE.test(depText) || SCHEMATA_BLOCK_RE.test(depText)) {
      return { eligible: false, stateful: false, writesFs: false };
    }
    if (STATEFUL_SUITE_RE.test(depText)) stateful = true;
    if (FS_WRITE_RE.test(depText)) writesFs = true;
  }
  return { eligible: true, stateful, writesFs };
}

export function isSchemataSuite(
  root: string,
  paths: readonly string[],
  helperFiles: readonly string[] = [],
): boolean {
  return classifySchemataSuite(root, paths, helperFiles).eligible;
}

function isFunctionNode(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function hasUnsafeThunkExpr(node: ts.Node): boolean {
  if (
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    ts.isMetaProperty(node) ||
    node.kind === ts.SyntaxKind.SuperKeyword ||
    (ts.isIdentifier(node) && node.text === "arguments")
  ) {
    return true;
  }
  if (isFunctionNode(node)) return false;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && hasUnsafeThunkExpr(child)) found = true;
  });
  return found;
}

function buildMutantLookup(mutants: readonly Mutant[]) {
  const bySpan = new Map<string, { readonly index: number; readonly mutant: Mutant }>();
  const starts: number[] = [];
  for (let i = 0; i < mutants.length; i += 1) {
    const mutant = mutants[i];
    if (mutant === undefined) continue;
    bySpan.set(`${String(mutant.start)}:${String(mutant.end)}:${mutant.label}`, { index: i, mutant });
    starts.push(mutant.start);
  }
  starts.sort((a, b) => a - b);
  return { bySpan, starts };
}

function spanHasMutant(starts: readonly number[], from: number, to: number): boolean {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((starts[mid] ?? 0) < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < starts.length && (starts[lo] ?? to) < to;
}

function rewriteDirectChildren(
  source: string,
  tree: ts.SourceFile,
  node: ts.Node,
  visit: (child: ts.Node) => string,
): string {
  const start = node.getStart(tree);
  const end = node.getEnd();
  let cursor = start;
  let out = "";
  ts.forEachChild(node, (child) => {
    const cs = child.getStart(tree);
    const ce = child.getEnd();
    if (cs < cursor || ce <= cs) return;
    out += source.slice(cursor, cs);
    out += visit(child);
    cursor = ce;
  });
  out += source.slice(cursor, end);
  return out;
}

interface RewriteCtx {
  readonly source: string;
  readonly tree: ts.SourceFile;
  readonly starts: readonly number[];
  readonly lookup: (
    s: number,
    e: number,
    label: string,
  ) => { readonly index: number; readonly mutant: Mutant } | undefined;
  readonly encoded: Map<number, Mutant>;
}

function isSamePrecedenceBinary(node: ts.Node, op: string, tree: ts.SourceFile): boolean {
  return ts.isBinaryExpression(node) && node.operatorToken.getText(tree) === op;
}

function isPrecedenceSafeShortCircuit(node: ts.BinaryExpression, op: string, tree: ts.SourceFile): boolean {
  if (op === "&&") return !isSamePrecedenceBinary(node.parent, "&&", tree);
  if (op === "||") return !isSamePrecedenceBinary(node.left, "||", tree);
  if (op === "??") {
    return !isSamePrecedenceBinary(node.left, "??", tree) && !isSamePrecedenceBinary(node.parent, "??", tree);
  }
  return false;
}

function rewriteBinary(
  node: ts.BinaryExpression,
  ctx: RewriteCtx,
  recurse: (child: ts.Node) => string,
): string {
  const op = node.operatorToken.getText(ctx.tree);
  const bin = BINARY_OP_CODES.get(op);
  if (bin !== undefined) {
    const hit = ctx.lookup(
      node.operatorToken.getStart(ctx.tree),
      node.operatorToken.getEnd(),
      `${op} -> ${bin[1]}`,
    );
    if (hit !== undefined) {
      ctx.encoded.set(hit.index, hit.mutant);
      return `(__bmB(${String(hit.index)}, ${String(bin[0])}, (${recurse(node.left)}), (${recurse(node.right)})))`;
    }
  }
  const sc = SHORT_CIRCUIT_CODES.get(op);
  if (
    sc !== undefined &&
    isPrecedenceSafeShortCircuit(node, op, ctx.tree) &&
    !hasUnsafeThunkExpr(node.left) &&
    !hasUnsafeThunkExpr(node.right)
  ) {
    const hit = ctx.lookup(
      node.operatorToken.getStart(ctx.tree),
      node.operatorToken.getEnd(),
      `${op} -> ${sc[1]}`,
    );
    if (hit !== undefined) {
      ctx.encoded.set(hit.index, hit.mutant);
      return `(__bmL(${String(hit.index)}, ${String(sc[0])}, () => (${recurse(node.left)}), () => (${recurse(node.right)})))`;
    }
  }
  return rewriteDirectChildren(ctx.source, ctx.tree, node, recurse);
}

function rewriteLeafOrControl(
  node: ts.Node,
  ctx: RewriteCtx,
  recurse: (child: ts.Node) => string,
): string | null {
  const start = node.getStart(ctx.tree);
  const end = node.getEnd();
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const hit = ctx.lookup(start, node.operand.getStart(ctx.tree), "drop !");
    if (hit !== undefined) {
      ctx.encoded.set(hit.index, hit.mutant);
      return `(__bmNot(${String(hit.index)}, (${recurse(node.operand)})))`;
    }
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    const orig = node.getText(ctx.tree);
    const alt = orig === "true" ? "false" : "true";
    const hit = ctx.lookup(start, end, `${orig} -> ${alt}`);
    if (hit !== undefined) {
      ctx.encoded.set(hit.index, hit.mutant);
      return `(__bmLit(${String(hit.index)}, ${orig}, ${alt}))`;
    }
  }
  if (ts.isNumericLiteral(node) && !isPropertyNameNode(node)) {
    const num = Number(node.text.replaceAll("_", ""));
    const hit = Number.isFinite(num)
      ? ctx.lookup(start, end, `${node.text} -> ${String(num + 1)}`)
      : undefined;
    if (hit !== undefined) {
      ctx.encoded.set(hit.index, hit.mutant);
      return `(__bmLit(${String(hit.index)}, ${node.getText(ctx.tree)}, ${String(num + 1)}))`;
    }
  }
  if (ts.isConditionalExpression(node)) {
    const hit = ctx.lookup(start, end, "swap ?:");
    if (hit !== undefined) {
      ctx.encoded.set(hit.index, hit.mutant);
      return `((__bmCond(${String(hit.index)}, (${recurse(node.condition)}))) ? (${recurse(node.whenTrue)}) : (${recurse(node.whenFalse)}))`;
    }
  }
  if (ts.isIfStatement(node) && !ts.isLabeledStatement(node.parent)) {
    const hit = ctx.lookup(start, end, "delete if");
    if (hit !== undefined) {
      ctx.encoded.set(hit.index, hit.mutant);
      const elsePart = node.elseStatement === undefined ? "" : ` else ${recurse(node.elseStatement)}`;
      return `{ if (__bmIf(${String(hit.index)})) { if (${recurse(node.expression)}) ${recurse(node.thenStatement)}${elsePart} } }`;
    }
  }
  return null;
}

function rewriteNode(node: ts.Node, ctx: RewriteCtx, scope: "fn" | "top"): string {
  const start = node.getStart(ctx.tree);
  const end = node.getEnd();
  if (!spanHasMutant(ctx.starts, start, end)) return ctx.source.slice(start, end);
  const nextScope: "fn" | "top" = scope === "fn" || isFunctionNode(node) ? "fn" : "top";
  const recurse = (child: ts.Node) => rewriteNode(child, ctx, nextScope);
  if (scope === "fn" && ts.isBinaryExpression(node)) return rewriteBinary(node, ctx, recurse);
  if (scope === "fn") {
    const special = rewriteLeafOrControl(node, ctx, recurse);
    if (special !== null) return special;
  }
  return rewriteDirectChildren(ctx.source, ctx.tree, node, recurse);
}

function buildInstrumented(
  file: string,
  source: string,
  mutants: readonly Mutant[],
  preamble: string,
): { readonly source: string | null; readonly encoded: ReadonlyMap<number, Mutant> } {
  if (mutants.length === 0) return { source: null, encoded: new Map() };
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const { bySpan, starts } = buildMutantLookup(mutants);
  const encoded = new Map<number, Mutant>();
  const ctx: RewriteCtx = {
    source,
    tree,
    starts,
    lookup: (s, e, label) => bySpan.get(`${String(s)}:${String(e)}:${label}`),
    encoded,
  };
  let cursor = 0;
  let body = "";
  for (const stmt of tree.statements) {
    const ss = stmt.getStart(tree);
    const se = stmt.getEnd();
    body += source.slice(cursor, ss);
    body += rewriteNode(stmt, ctx, "top");
    cursor = se;
  }
  body += source.slice(cursor);
  if (encoded.size === 0) return { source: null, encoded };
  let combined: string;
  if (body.startsWith("#!")) {
    const nl = body.indexOf("\n");
    const shebang = nl === -1 ? body : body.slice(0, nl + 1);
    const rest = nl === -1 ? "" : body.slice(nl + 1);
    combined = `${shebang}${preamble}\n${rest}`;
  } else {
    combined = `${preamble}\n${body}`;
  }
  try {
    const transpiler = file.endsWith(".tsx") ? TSX_TRANSPILER : TS_TRANSPILER;
    transpiler.transformSync(combined);
    return { source: combined, encoded };
  } catch {
    return { source: null, encoded: new Map() };
  }
}

export function buildSchemaSource(
  file: string,
  source: string,
  mutants: readonly Mutant[],
): { readonly source: string | null; readonly encoded: ReadonlyMap<number, Mutant> } {
  return buildInstrumented(file, source, mutants, SCHEMA_PREAMBLE);
}

export function buildTraceSource(
  file: string,
  source: string,
  mutants: readonly Mutant[],
  tracePath: string,
): { readonly source: string | null; readonly encoded: ReadonlyMap<number, Mutant> } {
  return buildInstrumented(file, source, mutants, tracePreamble(tracePath));
}

const WORKER_HARNESS = `import {
  expect as realExpect,
  it as realIt,
  jest as realJest,
  mock as realMock,
  spyOn as realSpyOn,
} from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { plugin } from "bun";
const metaSource = readFileSync(cfg.metaPath, "utf8");
const sch = { m: -1, rec: true, hits: new Set<number>() };
(globalThis as Record<string, unknown>).__BM_SCH = sch;
interface Scope {
  readonly id: number;
  readonly beforeAll: (() => unknown)[];
  readonly afterAll: (() => unknown)[];
  readonly beforeEach: (() => unknown)[];
  readonly afterEach: (() => unknown)[];
}
interface TestCase {
  readonly fn: () => unknown;
  readonly failing: boolean;
  readonly beforeEach: readonly (() => unknown)[];
  readonly afterEach: readonly (() => unknown)[];
  readonly scopeIds: readonly number[];
}
let nextScopeId = 0;
let scopes: Scope[] = [];
let allScopes: Scope[] = [];
let collected: TestCase[] = [];
function resetRegistry(): void {
  nextScopeId = 0;
  const rootScope: Scope = { id: nextScopeId++, beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };
  scopes = [rootScope];
  allScopes = [rootScope];
  collected = [];
}
resetRegistry();
const noop = () => {};
const pushTestWith = (failing: boolean) => (_name: string, fn?: () => unknown) => {
  if (typeof fn !== "function") return;
  collected.push({
    fn,
    failing,
    beforeEach: scopes.flatMap((s) => s.beforeEach),
    afterEach: scopes.toReversed().flatMap((s) => s.afterEach),
    scopeIds: scopes.map((s) => s.id),
  });
};
const pushTest = pushTestWith(false);
const pushFailing = pushTestWith(true);
const pushDescribe = (_name: string, fn?: () => void) => {
  if (typeof fn !== "function") return;
  const sc: Scope = { id: nextScopeId++, beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };
  allScopes.push(sc);
  scopes.push(sc);
  try { fn(); } finally { scopes.pop(); }
};
function makeEach(reg: (name: string, fn: () => unknown) => void) {
  return (rows: readonly unknown[]) => (name: string, fn: (...args: unknown[]) => unknown) => {
    for (const row of rows) {
      const args = Array.isArray(row) ? row : [row];
      reg(name, () => fn(...args));
    }
  };
}
const itSkip = Object.assign(noop, { each: () => noop, concurrent: noop });
const descSkip = Object.assign(noop, { each: () => noop, concurrent: noop });
const itFn = Object.assign(pushTest, {
  concurrent: pushTest,
  each: makeEach(pushTest),
  failing: pushFailing,
  skip: itSkip,
  todo: itSkip,
  if: (cond: unknown) => (cond ? itFn : itSkip),
  skipIf: (cond: unknown) => (cond ? itSkip : itFn),
  todoIf: (cond: unknown) => (cond ? itSkip : itFn),
});
const describeFn = Object.assign(pushDescribe, {
  concurrent: pushDescribe,
  each: makeEach((name, fn) => pushDescribe(name, fn as () => void)),
  skip: descSkip,
  todo: descSkip,
  if: (cond: unknown) => (cond ? describeFn : descSkip),
  skipIf: (cond: unknown) => (cond ? descSkip : describeFn),
  todoIf: (cond: unknown) => (cond ? descSkip : describeFn),
});
(globalThis as Record<string, unknown>).__BM_TEST = {
  expect: realExpect,
  describe: describeFn,
  it: itFn,
  test: itFn,
  spyOn: realSpyOn,
  mock: realMock,
  jest: realJest,
  setDefaultTimeout: noop,
  beforeAll: (fn: () => unknown) => { scopes[scopes.length - 1]?.beforeAll.push(fn); },
  afterAll: (fn: () => unknown) => { scopes[scopes.length - 1]?.afterAll.push(fn); },
  beforeEach: (fn: () => unknown) => { scopes[scopes.length - 1]?.beforeEach.push(fn); },
  afterEach: (fn: () => unknown) => { scopes[scopes.length - 1]?.afterEach.push(fn); },
};
const escRe = (s: string) => s.replaceAll(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
plugin({
  name: "bun-mutate-schema",
  setup(build) {
    build.onLoad({ filter: new RegExp("^" + escRe(cfg.targetAbs) + "$") }, () => ({
      contents: metaSource,
      loader: cfg.targetLoader,
    }));
    build.onLoad({ filter: new RegExp("^" + escRe(cfg.suiteAbs) + "(\\\\?.*)?$") }, () => ({
      contents: readFileSync(cfg.suiteAbs, "utf8").replace(
        /import\\s+\\{([^}]+)\\}\\s+from\\s+["']bun:test["'];?/g,
        (_: string, names: string) =>
          "const {" +
          names
            .replaceAll(/\\btype\\s+[A-Za-z0-9_$]+(?:\\s+as\\s+[A-Za-z0-9_$]+)?\\s*,?/g, "")
            .replaceAll(/\\bas\\b/g, ":") +
          "} = (globalThis as any).__BM_TEST;",
      ),
      loader: cfg.suiteLoader,
    }));
  },
});
const baseEnv: Record<string, string | undefined> = { ...process.env };
function cleanupState(): void {
  try { realMock.restore(); } catch {}
  for (const key of Object.keys(process.env)) {
    if (!(key in baseEnv)) delete process.env[key];
  }
  for (const [key, val] of Object.entries(baseEnv)) {
    if (val === undefined) delete process.env[key];
    else if (process.env[key] !== val) process.env[key] = val;
  }
}
async function runBeforeAll(): Promise<void> {
  for (const sc of allScopes) {
    for (const hook of sc.beforeAll) await hook();
  }
}
async function runAfterAll(): Promise<void> {
  for (const sc of allScopes.toReversed()) {
    for (const hook of sc.afterAll) {
      try { await hook(); } catch {}
    }
  }
}
async function runCase(one: TestCase): Promise<void> {
  for (const hook of one.beforeEach) await hook();
  let threw = false;
  let caught: unknown;
  try {
    await one.fn();
  } catch (err) {
    threw = true;
    caught = err;
  } finally {
    for (const hook of one.afterEach) await hook();
  }
  if (one.failing) {
    if (!threw) throw new Error("expected failing test to fail");
  } else if (threw) {
    throw caught;
  }
}
let reimpSeq = 0;
async function loadFresh(mutantId: number): Promise<void> {
  resetRegistry();
  sch.m = mutantId;
  reimpSeq += 1;
  await import(cfg.suiteAbs + "?bm=" + String(reimpSeq));
}
realIt("schema", async () => {
  if (cfg.mode === "probe") {
    const baseStart = performance.now();
    sch.m = -1;
    sch.rec = true;
    sch.hits.clear();
    try {
      await import(cfg.suiteAbs);
    } catch {
      console.log("__BM_SCH_ABORT__ import-fail");
      return;
    }
    if (collected.length === 0) {
      console.log("__BM_SCH_ABORT__ empty");
      return;
    }
    const importHits = [...sch.hits];
    const beforeAllHitSet = new Set<number>();
    sch.hits.clear();
    try {
      await runBeforeAll();
    } catch {
      await runAfterAll();
      console.log("__BM_SCH_ABORT__ baseline-fail");
      return;
    }
    for (const id of sch.hits) beforeAllHitSet.add(id);
    const hitsByMutant = new Map<number, Array<{ readonly idx: number; readonly ms: number }>>();
    for (let idx = 0; idx < collected.length; idx += 1) {
      const tc = collected[idx];
      if (tc === undefined) continue;
      sch.hits.clear();
      const t0 = performance.now();
      try {
        await runCase(tc);
      } catch {
        await runAfterAll();
        console.log("__BM_SCH_ABORT__ baseline-fail");
        return;
      }
      const ms = Math.max(0.1, performance.now() - t0);
      for (const id of sch.hits) {
        const list = hitsByMutant.get(id) ?? [];
        list.push({ idx, ms });
        hitsByMutant.set(id, list);
      }
    }
    const baselineMs = Math.max(1, Math.round(performance.now() - baseStart));
    const totalTests = collected.length;
    const beforeAllHits = [...beforeAllHitSet];
    const hasLifecycleHits = importHits.length > 0 || beforeAllHits.length > 0;
    let execMode: "reuse" | "reimport" = "reuse";
    const sampleIndices = [0, Math.floor(totalTests / 2), totalTests - 1]
      .filter((v, i, arr) => v >= 0 && v < totalTests && arr.indexOf(v) === i);
    const needReuseCheck = cfg.stateful || allScopes.some((s) => s.beforeAll.length > 0 || s.afterAll.length > 0);
    if (needReuseCheck) {
      cleanupState();
      sch.m = -1;
      sch.rec = false;
      let reuseOk = true;
      for (const idx of sampleIndices) {
        const tc = collected[idx];
        if (tc === undefined) continue;
        try { await runCase(tc); } catch { reuseOk = false; break; }
      }
      cleanupState();
      if (!reuseOk) execMode = "reimport";
    }
    await runAfterAll();
    cleanupState();
    if (execMode === "reimport" || hasLifecycleHits) {
      sch.rec = false;
      let reimpOk = true;
      try {
        await loadFresh(-1);
        await runBeforeAll();
        for (let idx = 0; idx < collected.length; idx += 1) {
          const tc = collected[idx];
          if (tc === undefined) continue;
          await runCase(tc);
        }
      } catch {
        reimpOk = false;
      } finally {
        await runAfterAll();
        cleanupState();
      }
      if (!reimpOk) {
        console.log("__BM_SCH_ABORT__ non-idempotent");
        return;
      }
    }
    const testsByMutant: Record<string, number[]> = {};
    for (const [id, list] of hitsByMutant) {
      testsByMutant[String(id)] = list.toSorted((a, b) => a.ms - b.ms).map((one) => one.idx);
    }
    const allCovered = new Set<number>([...hitsByMutant.keys(), ...importHits, ...beforeAllHits]);
    writeFileSync(
      cfg.planPath,
      JSON.stringify({ baselineMs, testsByMutant, importHits, beforeAllHits, execMode, totalTests }),
    );
    console.log("__BM_SCH_PROBED__ " + String(baselineMs) + " " + String(allCovered.size));
    return;
  }
  const plan = JSON.parse(readFileSync(cfg.planPath, "utf8")) as {
    testsByMutant: Record<string, number[]>;
    importHits: number[];
    beforeAllHits: number[];
    execMode: "reuse" | "reimport";
    totalTests: number;
  };
  const importHitSet = new Set<number>(plan.importHits);
  const beforeAllHitSet = new Set<number>(plan.beforeAllHits);
  sch.rec = false;
  let reuseLoaded = false;
  const ensureReuseLoaded = async (): Promise<boolean> => {
    if (reuseLoaded) return true;
    try {
      await loadFresh(-1);
      await runBeforeAll();
      reuseLoaded = true;
      return true;
    } catch {
      await runAfterAll();
      cleanupState();
      return false;
    }
  };
  try {
    for (const id of cfg.indices) {
      const isImp = importHitSet.has(id);
      const isPre = beforeAllHitSet.has(id);
      const testIds = plan.testsByMutant[String(id)] ?? [];
      if (!isImp && !isPre && testIds.length === 0) {
        console.log("__BM_SCH_ROW__ " + String(id) + " 0");
        continue;
      }
      console.log("__BM_SCH_START__ " + String(id));
      const useReimport = plan.execMode === "reimport" || isImp || isPre;
      if (!useReimport) {
        if (!(await ensureReuseLoaded())) {
          console.log("__BM_SCH_ABORT__ leak");
          return;
        }
        sch.m = id;
        let failedCase: TestCase | null = null;
        try {
          for (const idx of testIds) {
            const tc = collected[idx];
            if (tc === undefined) continue;
            try { await runCase(tc); } catch { failedCase = tc; break; }
          }
        } finally {
          sch.m = -1;
          cleanupState();
        }
        if (failedCase !== null) {
          try {
            await runCase(failedCase);
          } catch {
            console.log("__BM_SCH_ABORT__ leak");
            return;
          } finally {
            cleanupState();
          }
          console.log("__BM_SCH_ROW__ " + String(id) + " 1");
        } else {
          console.log("__BM_SCH_ROW__ " + String(id) + " 0");
        }
      } else {
        if (reuseLoaded) {
          await runAfterAll();
          reuseLoaded = false;
        }
        let failed = false;
        let failedIdx = -1;
        try {
          await loadFresh(id);
          await runBeforeAll();
          for (let idx = 0; idx < collected.length; idx += 1) {
            const tc = collected[idx];
            if (tc === undefined) continue;
            try {
              await runCase(tc);
            } catch {
              failed = true;
              failedIdx = idx;
              break;
            }
          }
        } catch {
          failed = true;
        } finally {
          sch.m = -1;
          await runAfterAll();
          cleanupState();
        }
        if (failed) {
          let verifyOk = true;
          try {
            await loadFresh(-1);
            await runBeforeAll();
            for (let idx = 0; idx <= failedIdx && idx < collected.length; idx += 1) {
              const tc = collected[idx];
              if (tc !== undefined) await runCase(tc);
            }
          } catch {
            verifyOk = false;
          } finally {
            await runAfterAll();
            cleanupState();
          }
          if (!verifyOk) {
            console.log("__BM_SCH_ABORT__ leak");
            return;
          }
          console.log("__BM_SCH_ROW__ " + String(id) + " 1");
        } else {
          console.log("__BM_SCH_ROW__ " + String(id) + " 0");
        }
      }
    }
  } finally {
    if (reuseLoaded) await runAfterAll();
    cleanupState();
  }
}, 600_000);
`;

interface ProbeInfo {
  readonly suiteName: string;
  readonly suiteRel: string;
  readonly suiteLoader: "ts" | "tsx";
  readonly stateful: boolean;
  readonly writesFs: boolean;
  readonly planPath: string;
  readonly baselineMs: number;
  readonly coveredCount: number;
  readonly coveredIds: ReadonlySet<number>;
  readonly effectiveMutantMs: number;
}

const loaderOf = (path: string): "ts" | "tsx" => (path.endsWith(".tsx") || path.endsWith(".jsx") ? "tsx" : "ts");

async function probeSuite(opts: {
  readonly cwd: string;
  readonly tmpDir: string;
  readonly seq: number;
  readonly suiteName: string;
  readonly suiteRel: string;
  readonly metaPath: string;
  readonly targetAbs: string;
  readonly targetLoader: "ts" | "tsx";
  readonly suiteAbs: string;
  readonly suiteLoader: "ts" | "tsx";
  readonly stateful: boolean;
  readonly writesFs: boolean;
  readonly capSeconds: number;
}): Promise<ProbeInfo | null> {
  const planPath = join(opts.tmpDir, `plan-${String(opts.seq)}.json`);
  const runnerPath = join(opts.tmpDir, `probe-${String(opts.seq)}.test.ts`);
  const payload = JSON.stringify({
    mode: "probe",
    metaPath: opts.metaPath,
    targetAbs: opts.targetAbs,
    targetLoader: opts.targetLoader,
    suiteAbs: opts.suiteAbs,
    suiteLoader: opts.suiteLoader,
    stateful: opts.stateful,
    planPath,
    indices: [],
  });
  writeFileSync(runnerPath, `const cfg = ${payload};\n${WORKER_HARNESS}`);
  const run = Bun.spawn([process.execPath, "test", "--timeout=600000", runnerPath], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  let baselineMs = -1;
  let coveredCount = 0;
  let aborted = false;
  const timer = setTimeout(() => killProcessGroup(run, "SIGKILL"), Math.min(opts.capSeconds, 120) * 1000);
  try {
    await streamLines(run.stdout, (line) => {
      if (line.includes("__BM_SCH_ABORT__")) aborted = true;
      const at = line.indexOf("__BM_SCH_PROBED__ ");
      if (at !== -1) {
        const [ms = "", count = ""] = line
          .slice(at + 18)
          .trim()
          .split(" ");
        baselineMs = Number(ms);
        coveredCount = Number(count);
      }
    });
    await run.exited;
  } finally {
    clearTimeout(timer);
    rmSync(runnerPath, { force: true });
  }
  if (aborted || baselineMs <= 0 || !existsSync(planPath)) return null;
  let coveredIds = new Set<number>();
  let effectiveMutantMs = baselineMs;
  try {
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      testsByMutant?: Record<string, number[]>;
      importHits?: number[];
      beforeAllHits?: number[];
      execMode?: "reuse" | "reimport";
      totalTests?: number;
    };
    const ids = new Set<number>([
      ...(plan.importHits ?? []),
      ...(plan.beforeAllHits ?? []),
      ...Object.keys(plan.testsByMutant ?? {}).map(Number),
    ]);
    coveredIds = ids;
    const isFullReload =
      plan.execMode === "reimport" ||
      (plan.importHits?.length ?? 0) > 0 ||
      (plan.beforeAllHits?.length ?? 0) > 0;
    const totalTests = Math.max(1, plan.totalTests ?? 1);
    effectiveMutantMs = isFullReload ? baselineMs : Math.max(10, baselineMs / totalTests);
  } catch {
    return null;
  }
  return {
    suiteName: opts.suiteName,
    suiteRel: opts.suiteRel,
    suiteLoader: opts.suiteLoader,
    stateful: opts.stateful,
    writesFs: opts.writesFs,
    planPath,
    baselineMs,
    coveredCount,
    coveredIds,
    effectiveMutantMs,
  };
}

async function runSchemaShard(opts: {
  readonly cwd: string;
  readonly tmpDir: string;
  readonly seq: number;
  readonly metaPath: string;
  readonly targetAbs: string;
  readonly targetLoader: "ts" | "tsx";
  readonly suiteAbs: string;
  readonly probe: ProbeInfo;
  readonly indices: readonly number[];
  readonly capSeconds: number;
}): Promise<{ readonly results: Map<number, boolean | null>; readonly aborted: boolean }> {
  const results = new Map<number, boolean | null>();
  let remaining = [...opts.indices];
  const floorSec = opts.probe.baselineMs < 500 ? 5 : 12;
  const timeoutMs =
    Math.min(opts.capSeconds, Math.max(floorSec, Math.ceil((opts.probe.baselineMs / 1000) * 8))) * 1000;
  let attempt = 0;
  while (remaining.length > 0) {
    attempt += 1;
    const runnerPath = join(opts.tmpDir, `s-${String(opts.seq)}-${String(attempt)}.test.ts`);
    const payload = JSON.stringify({
      mode: "run",
      metaPath: opts.metaPath,
      targetAbs: opts.targetAbs,
      targetLoader: opts.targetLoader,
      suiteAbs: opts.suiteAbs,
      suiteLoader: opts.probe.suiteLoader,
      stateful: opts.probe.stateful,
      planPath: opts.probe.planPath,
      indices: remaining,
    });
    writeFileSync(runnerPath, `const cfg = ${payload};\n${WORKER_HARNESS}`);
    const run = Bun.spawn([process.execPath, "test", "--timeout=600000", runnerPath], {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    });
    let activeId: number | null = null;
    let timedOutId: number | null = null;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (id: number | null) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOutId = id;
        killProcessGroup(run, "SIGKILL");
      }, timeoutMs);
    };
    arm(null);
    try {
      await streamLines(run.stdout, (line) => {
        if (line.includes("__BM_SCH_ABORT__")) aborted = true;
        const startAt = line.indexOf("__BM_SCH_START__ ");
        if (startAt !== -1) {
          activeId = Number(line.slice(startAt + 17).trim());
          arm(activeId);
        }
        const rowAt = line.indexOf("__BM_SCH_ROW__ ");
        if (rowAt !== -1) {
          const [rawId = "", rawKill = ""] = line
            .slice(rowAt + 15)
            .trim()
            .split(" ");
          results.set(Number(rawId), rawKill === "1");
          activeId = null;
          arm(null);
        }
      });
      await run.exited;
    } finally {
      if (timer !== null) clearTimeout(timer);
      rmSync(runnerPath, { force: true });
    }
    if (aborted) return { results, aborted: true };
    const failedId = timedOutId ?? activeId;
    if (failedId !== null && !results.has(failedId)) {
      results.set(failedId, null);
      remaining = remaining.filter((id) => !results.has(id));
      continue;
    }
    break;
  }
  return { results, aborted: false };
}

export interface SchemataResult {
  readonly verdicts: Map<string, Map<string, boolean | null>>;
  readonly qualifiedSuites: Set<string>;
  readonly durations: Map<string, number>;
  readonly encodedCount: number;
  readonly timedOutCount: number;
}

export async function screenFileWithSchemata(opts: {
  readonly root: string;
  readonly file: string;
  readonly source: string;
  readonly mutants: readonly Mutant[];
  readonly suites: ReadonlyMap<string, readonly string[]>;
  readonly suiteOrder: readonly string[];
  readonly helperFiles?: ReadonlyMap<string, readonly string[]>;
  readonly ensureSandboxes?: () => Promise<readonly string[]>;
  readonly capSeconds: number;
  readonly stopAtKill: boolean;
  readonly concurrency?: number;
}): Promise<SchemataResult> {
  const verdicts = new Map<string, Map<string, boolean | null>>();
  const qualifiedSuites = new Set<string>();
  const durations = new Map<string, number>();
  let timedOutCount = 0;
  const profiles = new Map<string, SuiteProfile>();
  for (const name of opts.suiteOrder) {
    const prof = classifySchemataSuite(opts.root, opts.suites.get(name) ?? [], opts.helperFiles?.get(name) ?? []);
    if (prof.eligible) profiles.set(name, prof);
  }
  const pureSuites = [...profiles.entries()].filter(([, p]) => !p.stateful).map(([n]) => n);
  const statefulSuites = [...profiles.entries()].filter(([, p]) => p.stateful).map(([n]) => n);
  if ((pureSuites.length === 0 && statefulSuites.length === 0) || opts.mutants.length === 0) {
    return { verdicts, qualifiedSuites, durations, encodedCount: 0, timedOutCount: 0 };
  }
  const built = buildSchemaSource(opts.file, opts.source, opts.mutants);
  if (built.source === null || built.encoded.size === 0) {
    return { verdicts, qualifiedSuites, durations, encodedCount: 0, timedOutCount: 0 };
  }
  const tmpDir = join(
    tmpdir(),
    `bm-sch-${String(process.pid)}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  const targetLoader = loaderOf(opts.file);
  const metaPath = join(tmpDir, `meta.${targetLoader}`);
  writeFileSync(metaPath, built.source);
  const maxWorkers = Math.max(1, opts.concurrency ?? availableParallelism());
  let sandboxes: readonly string[] = [];
  const cwdFor = (writesFs: boolean, slot: number): string => {
    if (!writesFs || sandboxes.length === 0) return opts.root;
    return sandboxes[slot % sandboxes.length] ?? opts.root;
  };
  let seq = 0;
  let alive = [...built.encoded.keys()];

  const runWave = async (waveSuites: readonly string[]): Promise<void> => {
    if (waveSuites.length === 0 || alive.length === 0) return;
    if (waveSuites.some((name) => profiles.get(name)?.writesFs === true) && sandboxes.length === 0 && opts.ensureSandboxes !== undefined) {
      sandboxes = await opts.ensureSandboxes();
    }
    const probeQueue = [...waveSuites];
    const probedRaw: (ProbeInfo | null)[] = [];
    const probeWorkers = Math.min(maxWorkers, probeQueue.length);
    await Promise.all(
      Array.from({ length: probeWorkers }, async (_, slot) => {
        for (let suiteName = probeQueue.shift(); suiteName !== undefined; suiteName = probeQueue.shift()) {
          const suiteRel = opts.suites.get(suiteName)?.[0];
          const prof = profiles.get(suiteName);
          if (suiteRel === undefined || prof === undefined) continue;
          const cwd = cwdFor(prof.writesFs, slot);
          const targetAbs = realpathSync(join(cwd, opts.file));
          const suiteAbs = realpathSync(join(cwd, suiteRel));
          seq += 1;
          probedRaw.push(
            await probeSuite({
              cwd,
              tmpDir,
              seq,
              suiteName,
              suiteRel,
              metaPath,
              targetAbs,
              targetLoader,
              suiteAbs,
              suiteLoader: loaderOf(suiteRel),
              stateful: prof.stateful,
              writesFs: prof.writesFs,
              capSeconds: opts.capSeconds,
            }),
          );
        }
      }),
    );
    const probed = probedRaw
      .filter((one): one is ProbeInfo => one !== null)
      .toSorted(
        (a, b) =>
          b.coveredCount / Math.max(5, b.effectiveMutantMs) - a.coveredCount / Math.max(5, a.effectiveMutantMs),
      );
    for (const probe of probed) {
      qualifiedSuites.add(probe.suiteName);
      durations.set(probe.suiteName, probe.baselineMs);
      if (alive.length === 0) continue;
      const coveredAlive: number[] = [];
      const uncoveredAlive: number[] = [];
      for (const id of alive) {
        if (probe.coveredIds.has(id)) coveredAlive.push(id);
        else uncoveredAlive.push(id);
      }
      const outs =
        coveredAlive.length === 0
          ? []
          : await (async () => {
              const estimatedMs = coveredAlive.length * Math.max(20, probe.effectiveMutantMs);
              const shardCap =
                probe.writesFs && sandboxes.length > 0 ? Math.min(maxWorkers, sandboxes.length) : maxWorkers;
              const shardCount = Math.min(
                shardCap,
                coveredAlive.length,
                Math.max(1, Math.ceil(estimatedMs / 400)),
              );
              const shards: number[][] = Array.from({ length: shardCount }, () => []);
              for (let i = 0; i < coveredAlive.length; i += 1) {
                const id = coveredAlive[i];
                if (id !== undefined) shards[i % shardCount]?.push(id);
              }
              return await Promise.all(
                shards
                  .filter((shard) => shard.length > 0)
                  .map((shard, slot) => {
                    seq += 1;
                    const cwd = cwdFor(probe.writesFs, slot);
                    return runSchemaShard({
                      cwd,
                      tmpDir,
                      seq,
                      metaPath,
                      targetAbs: realpathSync(join(cwd, opts.file)),
                      targetLoader,
                      suiteAbs: realpathSync(join(cwd, probe.suiteRel)),
                      probe,
                      indices: shard,
                      capSeconds: opts.capSeconds,
                    });
                  }),
              );
            })();
      if (outs.some((out) => out.aborted)) continue;
      const nextAlive: number[] = [];
      for (const id of uncoveredAlive) {
        const mutant = built.encoded.get(id);
        if (mutant === undefined) continue;
        const row = verdicts.get(mutant.id) ?? new Map<string, boolean | null>();
        row.set(probe.suiteName, false);
        verdicts.set(mutant.id, row);
        nextAlive.push(id);
      }
      for (const id of coveredAlive) {
        const mutant = built.encoded.get(id);
        if (mutant === undefined) continue;
        const found = outs.find((out) => out.results.has(id))?.results.get(id);
        if (found === undefined) {
          nextAlive.push(id);
          continue;
        }
        if (found === null) {
          // Hand timed-out or crashed schemata mutants straight to isolated execution with full timeout.
          timedOutCount += 1;
          continue;
        }
        const row = verdicts.get(mutant.id) ?? new Map<string, boolean | null>();
        row.set(probe.suiteName, found);
        verdicts.set(mutant.id, row);
        if (found === false || (!opts.stopAtKill && found === true)) nextAlive.push(id);
      }
      alive = nextAlive;
    }
  };

  try {
    await runWave(pureSuites);
    if (alive.length > 0) await runWave(statefulSuites);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return { verdicts, qualifiedSuites, durations, encodedCount: built.encoded.size, timedOutCount };
}
