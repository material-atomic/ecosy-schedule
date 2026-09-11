import type { ClassType, Hook as HookPort, Promisable, TaskEvent } from "../types";

/** Milliseconds a hook gets before it is abandoned. Separate from the task's own timeout. */
const HOOK_TIMEOUT = 10_000;

type LineLogger = { info(...a: unknown[]): void; error(...a: unknown[]): void };

/**
 * Builds a hook class that writes each outcome as a log line.
 *
 * A factory returning a class, not an object: the scheduler constructs whatever
 * it is handed, so everything given to `.hook()` arrives in the same shape and
 * nothing has to be told apart at runtime.
 *
 * Takes anything console-shaped, which `console` itself already is, so it costs
 * no dependency and works before real logging is wired up — or a function of
 * the injected context, to write through the logger `Schedule({ … })` injected
 * instead of one reached around it:
 *
 * ```ts
 * Schedule({ logger: AppLogger }).hook(LoggerHook((ctx) => ctx.logger))
 * ```
 */
export function LoggerHook<Context = unknown>(
  logger: LineLogger | ((context: Context) => LineLogger) = console,
): ClassType<HookPort<Context>> {
  return class implements HookPort<Context> {
    notify(event: TaskEvent, context: Context) {
      const log = typeof logger === "function" ? logger(context) : logger;
      const took = `${event.durationMs}ms`;

      if (event.ok) {
        log.info(`[schedule] ${event.key} ok in ${took}`);
        return;
      }

      log.error(
        `[schedule] ${event.key} failed (${event.reason}) after ${took}` +
          `${event.attempt > 1 ? ` on attempt ${event.attempt}` : ""}: ${event.detail ?? ""}`,
      );
    }
  };
}

/**
 * Runs one hook under a deadline, swallowing whatever it does.
 *
 * Takes a function rather than a promise on purpose. Calling `notify()` at the
 * call site and passing the result would leave a *synchronous* throw outside
 * this handler entirely — it escapes before there is anything to catch it, and
 * one badly written hook takes down every other hook in the same batch.
 * Invoking inside `.then` turns that throw into a rejection like any other.
 */
function deadline(work: () => Promisable<void>, ms: number, label: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[schedule] hook ${label} exceeded ${ms}ms — abandoned`);
      resolve();
    }, ms);

    Promise.resolve()
      .then(work)
      .then(
        () => { clearTimeout(timer); resolve(); },
        (error) => {
          clearTimeout(timer);
          console.warn(`[schedule] hook ${label} threw:`, error);
          resolve();
        },
      );
  });
}

/** Marks a composite so nesting one inside another flattens instead of nesting. */
const PARTS = Symbol.for("@ecosy/schedule:hook-parts");

interface HookFactory {
  /**
   * Fans one event out to several hooks, as a single hook class.
   *
   * Concurrently, and each isolated: a Telegram call that fails must not stop
   * the log line from being written, and a slow one must not hold the
   * scheduler — the task has already finished, reporting is separate work.
   *
   * Flattens, so `combine(a, combine(b, c))` and `combine(a, b, c)` behave the
   * same. With no arguments it is a valid no-op, which makes it a usable
   * default rather than something callers must guard against.
   */
  combine<Context = unknown>(...hooks: ClassType<HookPort<Context>>[]): ClassType<HookPort<Context>>;
}

export const Hook: HookFactory = {
  combine<Context = unknown>(...hooks: ClassType<HookPort<Context>>[]): ClassType<HookPort<Context>> {
    const flat = hooks.flatMap(
      (hook) => (hook as { [PARTS]?: ClassType<HookPort<Context>>[] })[PARTS] ?? [hook],
    );

    return class Combined implements HookPort<Context> {
      static readonly [PARTS] = flat;

      private readonly parts = flat.map((Hook) => new Hook());

      async notify(event: TaskEvent, context: Context) {
        await Promise.all(
          this.parts.map((hook, i) => deadline(() => hook.notify(event, context), HOOK_TIMEOUT, `#${i}`)),
        );
      }
    };
  },
};
