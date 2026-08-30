/**
 * What the scheduler needs from the world.
 *
 * One thing is required — a source, because nothing can guess where task
 * definitions live. Everything else is optional and has a defined behaviour
 * when absent, so a scheduler with just a source and a registry is a complete,
 * working single-instance scheduler.
 */

/**
 * A class constructible with no arguments.
 *
 * The single currency of this package: anything the scheduler builds for you —
 * a source, a parser, a coordinator, a hook, a handler — arrives as one of
 * these. Configuration that a constructor would need is captured by a factory
 * that hands back a class, the way `DiskCache(dir)` and `Source(fn)` do.
 *
 * One currency is why there is no `typeof x === "function"` check anywhere in
 * here: nothing has to work out at runtime what it was given.
 */
export type ClassType<Instance = unknown> = new () => Instance;

export type InjectMap = Record<string, ClassType>;

export type Injected<Context, Injects extends InjectMap> = Context & {
  [K in keyof Injects]: Injects[K] extends ClassType<infer Instance> ? Instance : never;
};

export type Promisable<T> = T | Promise<T>;

/* ------------------------------------------------------------ task shape */

/**
 * What a task does when it fires.
 *
 * Three kinds, and they fail in genuinely different ways — see `TaskFailure`.
 */
export type TaskTarget =
  /** A function registered in code. Fast and typed; cannot be interrupted. */
  | { type: "handler"; key: string }
  /** An HTTP call. Works across instances; the request can be abandoned but the server keeps going. */
  | { type: "api"; url: string; method?: string; headers?: Record<string, string>; body?: string }
  /** A child process. The only kind that can genuinely be killed. */
  | { type: "file"; path: string; args?: string[] };

/** One task, after a parser has read it out of whatever the source returned. */
export interface TaskDefinition {
  /** Unique. Used for the registry lookup, for coordination, and as the sync identity. */
  key: string;
  /** Six-field cron, or five for standard crontab. */
  expression: string;
  target: TaskTarget;
  /** IANA zone. Defaults to UTC — never the host zone, which differs between machines. */
  timezone?: string;
  /** False keeps the task known but unscheduled, so its history survives a pause. */
  enabled?: boolean;
  /** Overrides the schedule-level default. */
  retry?: number;
  /** Milliseconds. Overrides the schedule-level default. */
  timeout?: number;
}

/** Turns one entry from a source into a task. Implement this to accept your own format. */
export interface TaskParser<Entry = string> {
  parse(entry: Entry): TaskDefinition;
}

/* -------------------------------------------------------------- outcomes */

/**
 * Why a run failed, normalised across the three target kinds.
 *
 * Without this every consumer of a hook would branch on target type to find
 * out what went wrong. `raw` keeps the original for anyone who needs it.
 */
export type TaskFailure =
  | "throw"    // handler threw
  | "status"   // api answered outside 2xx
  | "timeout"  // deadline passed
  | "exit"     // file exited non-zero, or was killed
  | "unknown";

export interface TaskEvent {
  key: string;
  /** The fire time this run belongs to, computed from the expression — not `now`. */
  scheduledFor: Date;
  startedAt: Date;
  durationMs: number;
  /** 1 for the first try. */
  attempt: number;
  ok: boolean;
  reason?: TaskFailure;
  detail?: string;
  /** Whatever the target produced: return value, response body, stdout. */
  raw?: unknown;
}

/* ----------------------------------------------------------------- ports */

/**
 * Where task definitions come from. Required.
 *
 * A class, not a callback — everything the scheduler constructs is a class, so
 * there is one currency and nothing has to guess at runtime what it was handed.
 * `Source(fn)` wraps a one-line reader into one, so brevity costs nothing.
 */
export interface SourceAdapter<Entry = string, Context = unknown> {
  read(context: Context): Promisable<Entry[]>;
}

export type Source<Entry = string, Context = unknown> = ClassType<SourceAdapter<Entry, Context>>;

/**
 * Decides which instance runs a given fire. Optional.
 *
 * Without one every instance runs everything, which is correct for a single
 * process and wrong the moment there are two. Deliberately separate from the
 * source: a file-backed schedule behind a load balancer still needs
 * coordination, and a database-backed one on a single box does not.
 *
 * `claim` must be atomic across instances. A unique constraint on
 * `(key, scheduledFor)` is a stronger guarantee than a distributed lock, and
 * it leaves a run history behind for free.
 */
export interface Coordinator {
  /** True when this instance won the right to run. False when another already has it. */
  claim(key: string, scheduledFor: Date): Promisable<boolean>;
  /** Called once the run ends, so an abandoned claim can be told from a live one. */
  release(key: string, scheduledFor: Date, event: TaskEvent): Promisable<void>;
}

/**
 * Where run outcomes go. Optional — without one, a finished task reports
 * nowhere.
 *
 * One hook, not a list: `combine` turns several into one, so nothing
 * downstream ever branches on how many there are.
 */
export interface Hook {
  notify(event: TaskEvent): Promisable<void>;
}

/** Called when a source entry names a handler that was never registered. */
export type NotFoundHandler = (key: string, task: TaskDefinition) => Promisable<void>;

/** Called when a run fails, before any retry decision. */
export type ErrorHandler = (event: TaskEvent, task: TaskDefinition) => Promisable<void>;
