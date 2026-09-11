/** notFound and onError see the injected context, typed — no cast, no reaching around. */
import { Schedule } from "../src/index";

class AppLogger {
  warn(message: string) { void message; }
  error(message: string) { void message; }
}

export const App = Schedule({ logger: AppLogger })
  .notFound((key, task, ctx) => {
    ctx.logger.warn(`[cron] "${task.key}" names handler "${key}", which is not registered`);
  })
  .onError((event, task, ctx) => {
    ctx.logger.error(`[cron] ${task.key} failed (${event.reason})`);
    // @ts-expect-error — only what was injected is on the context
    ctx.mailer.send();
  });

// Handlers written before the context existed still fit.
export const Legacy = Schedule().notFound((key, task) => { void key; void task; });
