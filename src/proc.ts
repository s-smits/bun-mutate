export interface KillableProc {
  readonly pid: number;
  kill: (signal?: number | NodeJS.Signals) => void;
}

export interface DrainableProc extends KillableProc {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly signalCode: string | number | null;
}

export function killProcessGroup(child: KillableProc, signal: NodeJS.Signals): void {
  if (Number.isSafeInteger(child.pid) && child.pid > 1) {
    for (const target of [-child.pid, child.pid]) {
      try {
        process.kill(target, signal);
        return;
      } catch {
        // Group or process already exited; fall through.
      }
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

export async function settleProcs(procs: ReadonlySet<KillableProc>, graceMs: number): Promise<void> {
  if (procs.size === 0) return;
  for (const proc of procs) killProcessGroup(proc, "SIGTERM");
  const until = Date.now() + graceMs;
  while (procs.size > 0 && Date.now() < until) await Bun.sleep(20);
  for (const proc of procs) killProcessGroup(proc, "SIGKILL");
}

export async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf.length > 0) onLine(buf);
}

export async function drainProcess(
  run: DrainableProc,
  seconds: number,
  activeProcs?: Set<KillableProc>,
): Promise<{ readonly said: string; readonly code: number; readonly signalled: boolean }> {
  activeProcs?.add(run);
  let timedOut = false;
  const timer =
    seconds > 0 && Number.isFinite(seconds)
      ? setTimeout(() => {
          timedOut = true;
          killProcessGroup(run, "SIGKILL");
        }, seconds * 1000)
      : null;
  try {
    const drain = Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]).then(
      (parts) => parts.join(""),
    );
    const code = await run.exited;
    try {
      process.kill(-run.pid, "SIGKILL");
    } catch {
      // ESRCH: the suite left no process in its group to hold the pipes open.
    }
    const said = await Promise.race([drain, Bun.sleep(200).then(() => "")]);
    return { said, code, signalled: timedOut || run.signalCode != null };
  } finally {
    if (timer !== null) clearTimeout(timer);
    activeProcs?.delete(run);
  }
}
