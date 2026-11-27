const DEFAULT_BASE_REFS = ["origin/main", "origin/master", "main", "master"] as const;

export function gitMaybe(repo: string, ...args: readonly string[]): string | null {
  const res = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0 || res.signalCode != null) return null;
  return new TextDecoder().decode(res.stdout).trim();
}

export function gitRaw(repo: string, ...args: readonly string[]): string | null {
  const res = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0 || res.signalCode != null) return null;
  return new TextDecoder().decode(res.stdout);
}

export function detectDefaultBase(repo: string): string | null {
  for (const ref of DEFAULT_BASE_REFS) {
    if (gitMaybe(repo, "rev-parse", "--verify", "--quiet", ref) !== null) {
      return ref;
    }
  }
  return null;
}

export function resolveDiffRef(repo: string, explicitRef: string | null): string | null {
  const ref = explicitRef ?? detectDefaultBase(repo);
  if (ref === null) return null;
  if (ref.includes("..")) return ref;
  if (gitMaybe(repo, "rev-parse", "--verify", "--quiet", ref) === null) return null;
  const mergeBase = gitMaybe(repo, "merge-base", ref, "HEAD");
  return mergeBase ?? ref;
}

export function changedLinesInDiff(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  let sawMinus = false;
  let oldLeft = 0;
  let newLeft = 0;
  for (const row of diff.split("\n")) {
    if (row.startsWith("diff --git ")) {
      sawMinus = false;
      oldLeft = 0;
      newLeft = 0;
      continue;
    }
    if (oldLeft > 0 || newLeft > 0) {
      if (row.startsWith("-") && oldLeft > 0) {
        oldLeft -= 1;
        continue;
      }
      if (row.startsWith("+") && newLeft > 0) {
        newLeft -= 1;
        continue;
      }
    }
    if (row.startsWith("--- ")) {
      sawMinus = true;
      continue;
    }
    if (sawMinus && row.startsWith("+++ ")) {
      sawMinus = false;
      const file = row.slice(4).replace(/\t$/u, "").replace(/^b\//u, "");
      if (file === "/dev/null") {
        lines = undefined;
      } else {
        lines = changed.get(file) ?? new Set<number>();
        changed.set(file, lines);
      }
      continue;
    }
    sawMinus = false;
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(row);
    if (hunk === null || lines === undefined) continue;
    oldLeft = Number(hunk[1] ?? 1);
    const start = Number(hunk[2]);
    const count = Number(hunk[3] ?? 1);
    newLeft = count;
    for (let line = start; line < start + count; line += 1) lines.add(line);
  }
  return changed;
}

export function diffChangedLines(
  repo: string,
  ref: string,
  paths?: readonly string[],
): Map<string, Set<number>> | null {
  const diffArgs = [
    "-c",
    "core.quotePath=false",
    "diff",
    "--unified=0",
    "--no-color",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-ext-diff",
    ref,
    ...(paths !== undefined && paths.length > 0 ? ["--", ...paths] : []),
  ];
  const raw = gitRaw(repo, ...diffArgs);
  if (raw === null) return null;
  return changedLinesInDiff(raw);
}
