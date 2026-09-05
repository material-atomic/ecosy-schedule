import { Registry, type IRegistry } from "./registry";
import { DEFAULT_TIMEOUT, runTarget } from "./runner";
import { Task, type TaskStatus } from "./task";
import type {
  ClassType, Coordinator, ErrorHandler, Hook, InjectMap, Injected, NotFoundHandler,
  Source, TaskDefinition, TaskEvent, TaskParser,
} from "./types";

/** How often due tasks are checked. One second, because expressions have a seconds field. */
const DEFAULT_TICK = 1_000;
const DEFAULT_SYNC = 60_000;
const DEFAULT_RETRY = 0;

/** What happens to a task that disappears from the source. */
export type CascadePolicy =
  /** Stop scheduling, let the run in flight finish, then drop it. */
  | "drain"
  /** Stop scheduling now. A file target is killed; the other two are let go — see `runner`. */
  | "stop"
  /** Leave it running. For when the source is not the only authority. */
  | "keep";

interface Descriptor<Entry, Context> {
  injects: InjectMap;
  source?: Source<Entry, Context>;
  parser?: ClassType<TaskParser<Entry>>;
  registry: IRegistry<Context>;
  coordinator?: ClassType<Coordinator>;
  hook?: ClassType<Hook>;
  retry: number;
  timeout: number;
  syncMs: number | false;
  tickMs: number;
  cascade: CascadePolicy;
  onError?: ErrorHandler;
  notFound?: NotFoundHandler;
}

export interface ScheduleStatus {
  running: boolean;
  lastSyncAt: Date | null;
  lastSyncOk: boolean | null;
  tasks: TaskStatus[];
}

/**
 * A configured scheduler.
 *
 * A plain instance with no global state: constructing two gives two, and
 * whether that should happen is the caller's business. Whatever runs this once
 * — a bootstrap, a framework's init — already owns that question, and
 * answering it here as well would only take the choice away.
 */
export class ScheduleRunner<Entry = string, Context = unknown> {
  private readonly d: Descriptor<Entry, Context>;
  private readonly tasks = new Map<string, Task>();

  private context!: Injected<Context, InjectMap>;
  private parser!: TaskParser<Entry>;
  private coordinator?: Coordinator;
  private hook?: Hook;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Set<Promise<void>>();

  private started = false;
  private lastSyncAt: Date | null = null;
  private lastSyncOk: boolean | null = null;

  constructor(descriptor: Descriptor<Entry, Context>) {
    this.d = descriptor;
  }

  async start(): Promise<void> {
    // Idempotent on a single instance: starting twice must not produce two
    // sets of timers. This says nothing about two separate instances.
    if (this.started) return;
    if (!this.d.source) throw new Error("Schedule: a source is required — call .source(...)");
    if (!this.d.parser) throw new Error("Schedule: a task parser is required — call .task(...)");

    this.started = true;

    const context = {} as Record<string, unknown>;
    for (const [name, Token] of Object.entries(this.d.injects)) context[name] = new Token();
    this.context = context as Injected<Context, InjectMap>;

    this.parser = new this.d.parser();
    this.coordinator = this.d.coordinator && new this.d.coordinator();
    this.hook = this.d.hook && new this.d.hook();

    await this.sync();

    this.tickTimer = setInterval(() => this.tick(), this.d.tickMs);

    /* `false` means the source is read once, at start, and never reconciled
       again — right for a task list baked into the deployment, wrong for one an
       operator edits. The reconcile still happened above, so the tasks are
       loaded either way. */
    if (this.d.syncMs !== false) {
      this.syncTimer = setInterval(() => {
        this.sync().catch((error) => {
          console.warn("[schedule] sync failed:", error);
        });
      }, this.d.syncMs);
    }
  }

  /** Clears both timers and waits for runs already in flight. */
  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.tickTimer = this.syncTimer = null;
    this.started = false;

    await Promise.allSettled([...this.inFlight]);
  }

  status(): ScheduleStatus {
    return {
      running: this.started,
      lastSyncAt: this.lastSyncAt,
      lastSyncOk: this.lastSyncOk,
      tasks: [...this.tasks.values()].map((task) => task.status()),
    };
  }

  /* ------------------------------------------------------------ syncing */

  private async read(): Promise<Entry[]> {
    return new this.d.source!().read(this.context as Context);
  }

  /**
   * Re-reads the source and reconciles.
   *
   * Two failure modes are kept apart on purpose. A source that throws leaves
   * the schedule exactly as it was — a database blip is not an instruction to
   * cancel everything. A source that returns nothing while tasks exist is
   * treated the same way: it is far more likely to be a partial read than a
   * deliberate deletion of every job at once, and getting that wrong wipes a
   * schedule during an incident, which is the worst possible moment.
   */
  async sync(): Promise<void> {
    let entries: Entry[];

    try {
      entries = await this.read();

      /* A source that answers with something other than a list is a broken
         source, not an empty schedule. Checked here so it goes down the same
         path as a failed read — report it, keep the tasks already running —
         rather than throwing past this try and out of a timer callback. */
      if (!Array.isArray(entries)) {
        throw new Error(`source returned ${typeof entries}, expected an array`);
      }

      this.lastSyncOk = true;
    } catch (error) {
      this.lastSyncOk = false;
      this.lastSyncAt = new Date();
      await this.report(`source read failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    this.lastSyncAt = new Date();

    const seen = new Set<string>();
    const now = new Date();

    for (const entry of entries) {
      let definition: TaskDefinition;

      try {
        definition = this.parser.parse(entry);
      } catch (error) {
        await this.report(`unparseable entry: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      seen.add(definition.key);
      const existing = this.tasks.get(definition.key);

      if (existing) existing.update(definition, now);
      else this.tasks.set(definition.key, new Task(definition, now));
    }

    if (entries.length === 0 && this.tasks.size > 0) {
      await this.report(`source returned nothing while ${this.tasks.size} tasks are live — keeping them`);
      return;
    }

    for (const [key, task] of this.tasks) {
      if (seen.has(key)) continue;
      if (this.d.cascade === "keep") continue;

      task.nextAt = null;

      // `drain` leaves the entry until the run in flight settles; the tick
      // loop drops it once `running` clears.
      if (this.d.cascade === "stop" || !task.running) this.tasks.delete(key);
    }
  }

  /* ------------------------------------------------------------ running */

  private tick(): void {
    const now = new Date();

    for (const [key, task] of this.tasks) {
      // A drained task keeps its slot only until its run settles.
      if (task.nextAt === null && !task.running) {
        this.tasks.delete(key);
        continue;
      }

      if (!task.due(now)) continue;

      const run = this.run(task).finally(() => this.inFlight.delete(run));
      this.inFlight.add(run);
    }
  }

  private async run(task: Task): Promise<void> {
    // Advanced before the run, so a slow task does not drag its own schedule
    // along behind it. Overlap is held off by `running`, not by the clock.
    const scheduledFor = task.advance();
    task.running = true;

    try {
      if (this.coordinator && !(await this.coordinator.claim(task.key, scheduledFor))) {
        return; // another instance owns this fire
      }

      const definition = task.current;
      const attempts = (definition.retry ?? this.d.retry) + 1;
      const timeout = definition.timeout ?? this.d.timeout;

      let event!: TaskEvent;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const startedAt = new Date();
        const outcome = await runTarget(definition, this.d.registry, this.context, timeout, this.d.notFound);

        event = {
          key: task.key,
          scheduledFor,
          startedAt,
          durationMs: Date.now() - startedAt.getTime(),
          attempt,
          ok: outcome.ok,
          reason: outcome.reason,
          detail: outcome.detail,
          raw: outcome.raw,
        };

        if (outcome.ok) break;

        await this.d.onError?.(event, definition);

        // Backoff between attempts: retrying a failing endpoint three times in
        // the same millisecond is three failures, not three chances.
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 30_000)));
        }
      }

      task.record(event.ok, event.startedAt);

      // A hook that throws or hangs must not take the run down with it — the
      // work already happened, and reporting is a separate concern.
      await this.safely(() => this.hook?.notify(event));
      await this.safely(() => this.coordinator?.release(task.key, scheduledFor, event));
    } finally {
      task.running = false;
    }
  }

  private async safely(work: () => unknown): Promise<void> {
    try {
      await work();
    } catch (error) {
      console.warn("[schedule] reporting failed:", error);
    }
  }

  private async report(detail: string): Promise<void> {
    console.warn(`[schedule] ${detail}`);

    await this.safely(() =>
      this.d.onError?.(
        { key: "@schedule", scheduledFor: new Date(), startedAt: new Date(), durationMs: 0, attempt: 1, ok: false, reason: "unknown", detail },
        { key: "@schedule", expression: "", target: { type: "handler", key: "@schedule" } },
      ),
    );
  }
}

/* -------------------------------------------------------------- the chain */

export interface IScheduleBuilder<Entry = string, Context = unknown>
  extends ClassType<ScheduleRunner<Entry, Context>> {
  source<E>(source: Source<E, Context>): IScheduleBuilder<E, Context>;
  task(parser: ClassType<TaskParser<Entry>>): IScheduleBuilder<Entry, Context>;
  registry(registry: IRegistry<Context>): IScheduleBuilder<Entry, Context>;
  coordinator(coordinator: ClassType<Coordinator>): IScheduleBuilder<Entry, Context>;
  hook(hook: ClassType<Hook>): IScheduleBuilder<Entry, Context>;
  retry(times: number): IScheduleBuilder<Entry, Context>;
  timeout(ms: number): IScheduleBuilder<Entry, Context>;
  /**
   * Whether, and how often, the source is re-read and reconciled against the
   * tasks already running: a source entry that is new becomes a task, one that
   * changed is updated, one that disappeared is handled by `cascade`.
   *
   * `false` turns the repeat off — read once at start and never again.
   * `true` uses the default interval. A number sets it.
   */
  sync(every: number | boolean): IScheduleBuilder<Entry, Context>;
  tick(ms: number): IScheduleBuilder<Entry, Context>;
  cascade(policy: CascadePolicy): IScheduleBuilder<Entry, Context>;
  onError(handler: ErrorHandler): IScheduleBuilder<Entry, Context>;
  notFound(handler: NotFoundHandler): IScheduleBuilder<Entry, Context>;
}

function chain<Entry, Context>(d: Descriptor<Entry, Context>): IScheduleBuilder<Entry, Context> {
  // Each step returns a new class rather than mutating one, so a
  // half-configured chain can be shared as a base and branched.
  const step = <E>(patch: Partial<Descriptor<E, Context>>) =>
    chain({ ...(d as unknown as Descriptor<E, Context>), ...patch });

  return class extends ScheduleRunner<Entry, Context> {
    constructor() {
      super(d);
    }

    static source<E>(source: Source<E, Context>) { return step<E>({ source }); }
    static task(parser: ClassType<TaskParser<Entry>>) { return step<Entry>({ parser }); }
    static registry(registry: IRegistry<Context>) { return step<Entry>({ registry }); }
    static coordinator(coordinator: ClassType<Coordinator>) { return step<Entry>({ coordinator }); }
    static hook(hook: ClassType<Hook>) { return step<Entry>({ hook }); }
    static retry(times: number) { return step<Entry>({ retry: times }); }
    static timeout(ms: number) { return step<Entry>({ timeout: ms }); }
    static sync(every: number | boolean) {
      const syncMs = every === true ? DEFAULT_SYNC : every;
      return step<Entry>({ syncMs });
    }
    static tick(ms: number) { return step<Entry>({ tickMs: ms }); }
    static cascade(policy: CascadePolicy) { return step<Entry>({ cascade: policy }); }
    static onError(handler: ErrorHandler) { return step<Entry>({ onError: handler }); }
    static notFound(handler: NotFoundHandler) { return step<Entry>({ notFound: handler }); }
  } as unknown as IScheduleBuilder<Entry, Context>;
}

/**
 * Chain-style configuration for a scheduler.
 *
 * ```ts
 * export const AppSchedule = Schedule({ db: DataSource })
 *   .source((ctx) => ctx.db.query("select * from crons"))
 *   .task(RowParser)
 *   .registry(Registry.add(Registry("session.cleanup", (ctx) => ...)))
 *   .coordinator(PgCoordinator)
 *   .hook(Hook.combine(LoggerHook, TelegramHook))
 *   .retry(2)
 *   .sync(30_000)
 *   .cascade("drain");
 *
 * const schedule = new AppSchedule();
 * await schedule.start();
 * ```
 *
 * The chain is the class — there is no terminal to call, and whoever holds the
 * instance decides when it starts and stops.
 */
export function Schedule<Injects extends InjectMap = Record<string, never>>(
  injects: Injects = {} as Injects,
): IScheduleBuilder<string, Injected<unknown, Injects>> {
  return chain({
    injects,
    registry: Registry.empty(),
    retry: DEFAULT_RETRY,
    timeout: DEFAULT_TIMEOUT,
    syncMs: DEFAULT_SYNC,
    tickMs: DEFAULT_TICK,
    cascade: "drain",
  });
}
