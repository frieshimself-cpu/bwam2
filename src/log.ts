export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
}

const RING_SIZE = 500;
const recentEntries: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

const stamp = (ts: number) => new Date(ts).toISOString().slice(11, 19);

function emit(level: LogLevel, args: unknown[]) {
  const msg = args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(" ");
  const entry: LogEntry = { ts: Date.now(), level, msg };
  recentEntries.push(entry);
  if (recentEntries.length > RING_SIZE) recentEntries.shift();
  for (const listener of listeners) listener(entry);

  const line = `[${stamp(entry.ts)}]${level === "info" ? "" : ` ${level.toUpperCase()}`} ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};

/** Subscribe to log lines (the dashboard streams these). Returns an unsubscribe function. */
export function onLog(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recentLogs(limit = 200): LogEntry[] {
  return recentEntries.slice(-limit);
}

/** Sleeps `ms`, or returns early when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export const short = (key: { toBase58(): string } | string) => {
  const s = typeof key === "string" ? key : key.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
