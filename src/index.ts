export {
  buildSuiteMap,
  buildTestIndex,
  collectSuiteHelperDeps,
  discoverSourceFiles,
  discoverSourceRoots,
  discoverTestFiles,
  IMPURE_SUITE_RE,
  isSourceFile,
  isTestFile,
  loadRepoAliases,
  SUBPROCESS_RE,
  suiteNameForPath,
  type RepoAliases,
  type TestIndex,
} from "./discover.ts";
export {
  canCombineSuites,
  cloneTree,
  combinedTimeoutSeconds,
  killsOf,
  linkModules,
  loadCachedDurations,
  measureCoverage,
  parseMultiFileBail,
  qualifySuites,
  spawnsSubprocess,
  suiteTimeoutSeconds,
  type CoverageResult,
  type KillOutcome,
  type LocalWorker,
} from "./exec.ts";
export {
  changedLinesInDiff,
  detectDefaultBase,
  diffChangedLines,
  gitMaybe,
  resolveDiffRef,
} from "./git.ts";
export { applyMutant, mutantsFromSource, mutantsOf } from "./mutants.ts";
export { orderActiveByEfficiency, runLocalPool, type PoolTask } from "./pool.ts";
export {
  buildMarkdownReport,
  classifyRow,
  formatReportTable,
  formatScore,
  formatSurvivorClusters,
  freshSurvivors,
  mutationScore,
  recheckIdsOf,
  rowsOf,
  survivorEntries,
  verdictOf,
  writeSurvivorsFile,
  type SurvivorEntry,
} from "./report.ts";
export {
  finalizeRow,
  runMutationSpecs,
  type RunOptions,
  type RunSummary,
  type StaleOnlyWarning,
} from "./runner.ts";
export {
  buildSchemaSource,
  isSchemataSuite,
  screenFileWithSchemata,
  type SchemataResult,
} from "./schemata.ts";
export type {
  BatchPlan,
  KillMode,
  Mutant,
  ResultRow,
  TargetSpec,
  VerdictKind,
  VerdictMap,
} from "./types.ts";
