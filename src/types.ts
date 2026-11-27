export interface Mutant {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly label: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** The trimmed source line the mutant sits on, which anchors it across edits. */
  readonly source: string;
}

export type VerdictMap = Record<string, boolean | null>;

export type VerdictKind = "killed" | "survived" | "unread";

export interface ResultRow {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly label: string;
  readonly killed: VerdictMap;
  /** Suites that ran with the mutant active; the rest skipped it because their coverage never reaches its line. */
  readonly reached?: readonly string[];
  /** The trimmed source line at run time, so answers and rechecks survive later edits. */
  readonly source?: string;
}

export interface TargetSpec {
  readonly file: string;
  readonly out: string;
  readonly suites: Readonly<Record<string, readonly string[]>>;
  readonly ids?: readonly string[];
}

export interface BatchPlan {
  readonly mutant: Mutant;
  readonly active: readonly string[];
}

export type KillMode = "stop-at-kill" | "all";
