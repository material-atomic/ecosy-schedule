/** notFound and onError see the injected context, typed — no cast, no reaching around. */
import { Schedule } from "../src/index";

class AppLogger {
  info(message: string) { void message; }
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

// Parser, coordinator and hook see the injected context, typed.
import { LoggerHook } from "../src/hook/index";
import type { Coordinator, Hook, TaskParser, TaskDefinition, TaskEvent } from "../src/types";
type Ctx = { logger: AppLogger };
export class CtxParser implements TaskParser<string, Ctx> {
  parse(entry: string, ctx: Ctx): TaskDefinition { ctx.logger.warn(entry); return { key: entry, expression: "* * * * *", target: { type: "handler", key: entry } }; }
}
export class CtxCoordinator implements Coordinator<Ctx> {
  claim(_key: string, _at: Date, ctx: Ctx) { ctx.logger.warn("claim"); return true; }
  release(_key: string, _at: Date, _event: TaskEvent, ctx: Ctx) { ctx.logger.warn("release"); }
}
export class CtxHook implements Hook<Ctx> { notify(_event: TaskEvent, ctx: Ctx) { ctx.logger.error("x"); } }
export const Wired = Schedule({ logger: AppLogger }).task(CtxParser).coordinator(CtxCoordinator).hook(CtxHook);
export const Logged = Schedule({ logger: AppLogger }).hook(LoggerHook((ctx: Ctx) => ctx.logger));
