import type { IRegistry } from "./registry";
import type { NotFoundHandler, TaskDefinition, TaskFailure } from "./types";

export interface RunOutcome {
  ok: boolean;
  reason?: TaskFailure;
  detail?: string;
  raw?: unknown;
}

/** Milliseconds after which a run is abandoned. */
export const DEFAULT_TIMEOUT = 30_000;

function failure(reason: TaskFailure, detail: string, raw?: unknown): RunOutcome {
  return { ok: false, reason, detail, raw };
}

/**
 * Races a promise against a deadline.
 *
 * The loser is not cancelled — nothing here can cancel a promise. Each target
 * kind does what it can on top of this: an HTTP request is aborted, a child
 * process is killed, and an in-process handler simply keeps running with
 * nobody listening. That last one is a real limit, not an oversight: a
 * function already executing cannot be interrupted in JavaScript.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

const TIMED_OUT = Symbol("timed-out");

async function runHandler(
  task: TaskDefinition,
  registry: IRegistry<unknown>,
  context: unknown,
  timeout: number,
  notFound?: NotFoundHandler,
): Promise<RunOutcome> {
  if (task.target.type !== "handler") return failure("unknown", "not a handler target");

  const Entry = registry.get(task.target.key);

  if (!Entry) {
    // Loud, not silent: a row that is enabled but points nowhere would
    // otherwise look like a task that simply never fires.
    await notFound?.(task.target.key, task);
    return failure("unknown", `no handler registered for "${task.target.key}"`);
  }

  try {
    const result = await withDeadline(Promise.resolve(new Entry().run(context)), timeout);

    if (result === TIMED_OUT) {
      return failure("timeout", `handler exceeded ${timeout}ms (still running — a function cannot be interrupted)`);
    }

    return { ok: true, raw: result };
  } catch (error) {
    return failure("throw", error instanceof Error ? error.message : String(error), error);
  }
}

async function runApi(task: TaskDefinition, timeout: number): Promise<RunOutcome> {
  if (task.target.type !== "api") return failure("unknown", "not an api target");

  const { url, method = "POST", headers, body } = task.target;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await response.text();

    // Only the status decides. A 200 carrying `{ ok: false }` is the caller's
    // business — the scheduler has no way to know what a body means, and
    // guessing would make it wrong for somebody.
    return response.ok
      ? { ok: true, raw: text }
      : failure("status", `${response.status} ${response.statusText}`, text);
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";

    return aborted
      ? failure("timeout", `request exceeded ${timeout}ms (abandoned — the server may still be working)`)
      : failure("throw", error instanceof Error ? error.message : String(error), error);
  } finally {
    clearTimeout(timer);
  }
}

async function runFile(task: TaskDefinition, timeout: number): Promise<RunOutcome> {
  if (task.target.type !== "file") return failure("unknown", "not a file target");

  // Imported here rather than at the top so that a consumer using only
  // handler and api targets is not forced onto Node.
  const { spawn } = await import("node:child_process");
  const { path, args = [] } = task.target;

  return new Promise<RunOutcome>((resolve) => {
    const child = spawn(process.execPath, [path, ...args], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      // The one target kind that can actually be stopped.
      child.kill("SIGKILL");
    }, timeout);

    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(failure("throw", error.message, error));
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (killed) return resolve(failure("timeout", `killed after ${timeout}ms`, stderr));
      if (code !== 0) return resolve(failure("exit", `exit ${code}: ${stderr.trim().slice(0, 500)}`, stderr));

      resolve({ ok: true, raw: stdout });
    });
  });
}

export function runTarget(
  task: TaskDefinition,
  registry: IRegistry<unknown>,
  context: unknown,
  timeout = DEFAULT_TIMEOUT,
  notFound?: NotFoundHandler,
): Promise<RunOutcome> {
  switch (task.target.type) {
    case "handler": return runHandler(task, registry, context, timeout, notFound);
    case "api": return runApi(task, timeout);
    case "file": return runFile(task, timeout);
  }
}
