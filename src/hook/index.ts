import type { Hook as HookPort, Promisable, TaskEvent } from "../types";

/** Milliseconds a hook gets before it is abandoned. Separate from the task's own timeout. */
const HOOK_TIMEOUT = 10_000;

/**
 * A hook that writes each outcome as a log line.
 *
 * Takes anything console-shaped, which `console` itself already is, so it
 * costs no dependency and works before any real logging is wired up.
 */
export function LoggerHook(
  logger: { info(...a: unknown[]): void; error(...a: unknown[]): void } = console,
): HookPort {
  return {
    notify(event: TaskEvent) {
      const took = `${event.durationMs}ms`;

      if (event.ok) {
        logger.info(`[schedule] ${event.key} ok in ${took}`);
        return;
      }

      logger.error(
        `[schedule] ${event.key} failed (${event.reason}) after ${took}` +
          `${event.attempt > 1 ? ` on attempt ${event.attempt}` : ""}: ${event.detail ?? ""}`,
      );
    },
  };
}

function deadline(work: Promisable<void>, ms: number, label: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[schedule] hook ${label} exceeded ${ms}ms — abandoned`);
      resolve();
    }, ms);

    Promise.resolve(work).then(
      () => { clearTimeout(timer); resolve(); },
      (error) => {
        clearTimeout(timer);
        console.warn(`[schedule] hook ${label} threw:`, error);
        resolve();
      },
    );
  });
}

interface HookFactory {
  /**
   * Fans one event out to several hooks.
   *
   * Concurrently, and each isolated: a Telegram call that fails must not stop
   * the log line from being written, and a slow one must not hold the
   * scheduler — the task has already finished, reporting is separate work.
   *
   * Flattens, so `combine(a, combine(b, c))` and `combine(a, b, c)` behave the
   * same. With no arguments it is a valid no-op, which makes it a usable
   * default rather than something callers must guard against.
   */
  combine(...hooks: HookPort[]): HookPort;
}

export const Hook: HookFactory = {
  combine(...hooks: HookPort[]): HookPort {
    const flat = hooks.flatMap((hook) => ((hook as { __hooks?: HookPort[] }).__hooks ?? [hook]));

    const composite: HookPort & { __hooks: HookPort[] } = {
      __hooks: flat,
      async notify(event: TaskEvent) {
        await Promise.all(
          flat.map((hook, i) => deadline(hook.notify(event), HOOK_TIMEOUT, `#${i}`)),
        );
      },
    };

    return composite;
  },
};
