/* Against dist/, driven through start()/stop() — the path an app takes. */
import { test } from "node:test";
import assert from "node:assert/strict";

const dist = new URL("../dist/", import.meta.url).href;
const { Schedule, Registry } = await import(`${dist}index.mjs`);
const { Source } = await import(`${dist}source/index.mjs`);
const { LoggerHook, Hook } = await import(`${dist}hook/index.mjs`);

class AppLogger { lines = []; info(m) { this.lines.push(`info:${m}`); } warn(m) { this.lines.push(`warn:${m}`); } error(m) { this.lines.push(`error:${m}`); } }
class Db { static made = 0; id = ++Db.made; }

const rows = (...list) => Source(async () => list);
class Parser { parse(row) { return { key: row.key, expression: "* * * * * *", target: { type: "handler", key: row.handler } }; } }

/** Runs a schedule for ~2 cron seconds and returns what it saw. */
async function drive(S, ms = 2300) {
  const runner = new S();
  await runner.start();
  await new Promise((r) => setTimeout(r, ms));
  await runner.stop();
  return runner;
}

test("notFound and onError get the injected context", async () => {
  const seen = { nf: [], err: [] };
  const Fail = Registry("job.fail", {}, async () => { throw new Error("boom"); });
  const S = Schedule({ logger: AppLogger })
    .source(rows({ key: "missing", handler: "job.missing" }, { key: "fail", handler: "job.fail" }))
    .task(Parser).registry(Registry.empty().add(Fail)).retry(0).sync(false).tick(100)
    .notFound((key, task, ctx) => seen.nf.push(ctx.logger))
    .onError((event, task, ctx) => seen.err.push(ctx.logger));
  await drive(S);
  assert.ok(seen.nf.length && seen.nf.every((l) => l instanceof AppLogger));
  assert.ok(seen.err.length && seen.err.every((l) => l instanceof AppLogger));
  assert.equal(seen.nf[0], seen.err[0], "one context: the same logger instance");
});

test("parser, coordinator and hook get it too", async () => {
  const seen = { parse: [], claim: [], release: [], notify: [] };
  class CtxParser { parse(row, ctx) { seen.parse.push(ctx?.logger); return new Parser().parse(row); } }
  class Coord {
    claim(key, at, ctx) { seen.claim.push(ctx?.logger); return true; }
    release(key, at, event, ctx) { seen.release.push(ctx?.logger); }
  }
  class Notify { notify(event, ctx) { seen.notify.push(ctx?.logger); } }
  const Ok = Registry("job.ok", {}, async () => "done");
  const S = Schedule({ logger: AppLogger })
    .source(rows({ key: "ok", handler: "job.ok" })).task(CtxParser).registry(Registry.empty().add(Ok))
    .coordinator(Coord).hook(Notify).sync(false).tick(100);
  await drive(S);
  for (const [port, got] of Object.entries(seen)) {
    assert.ok(got.length > 0, `${port} was called`);
    assert.ok(got.every((l) => l instanceof AppLogger), `${port} got the injected logger`);
  }
  assert.equal(new Set(Object.values(seen).flat()).size, 1, "all four see the same instance");
});

test("a handler's own injects stay in its run — not in the shared context, not in other handlers", async () => {
  const views = { a: [], b: [], onError: [] };
  const A = Registry("job.a", { db: Db }, async (ctx) => { views.a.push(ctx.db?.id); await new Promise((r) => setTimeout(r, 30)); views.a.push(ctx.db?.id); throw new Error("a fails"); });
  const B = Registry("job.b", {}, async (ctx) => { views.b.push("db" in ctx); });
  const S = Schedule({ logger: AppLogger })
    .source(rows({ key: "a", handler: "job.a" }, { key: "b", handler: "job.b" }))
    .task(Parser).registry(Registry.empty().add(A).add(B)).retry(0).sync(false).tick(100)
    .onError((event, task, ctx) => views.onError.push("db" in ctx));
  const runner = await drive(S);
  assert.ok(views.a.length >= 2 && views.a.every((id) => typeof id === "number"), "A sees its own Db");
  assert.equal(views.a[0], views.a[1], "the same Db for the length of one run");
  assert.ok(views.b.length && views.b.every((has) => has === false), "B never sees A's Db");
  assert.ok(views.onError.every((has) => has === false), "neither does onError");
  assert.equal("db" in runner["context"], false, "the scheduler's own context was not written to");
});

test("LoggerHook can write through the injected logger; combine passes the context on", async () => {
  let logger;
  const seen = [];
  class Grab { notify(event, ctx) { logger = ctx.logger; seen.push(event.key); } }
  const Ok = Registry("job.ok", {}, async () => 1);
  const S = Schedule({ logger: AppLogger })
    .source(rows({ key: "ok", handler: "job.ok" })).task(Parser).registry(Registry.empty().add(Ok))
    .hook(Hook.combine(LoggerHook((ctx) => ctx.logger), Grab)).sync(false).tick(100);
  await drive(S);
  assert.ok(seen.length > 0);
  assert.ok(logger.lines.some((l) => /^info:\[schedule\] ok ok in \d+ms$/.test(l)), JSON.stringify(logger.lines));
});

test("ports written before the context existed still work", async () => {
  let ran = 0;
  class OldParser { parse(row) { return new Parser().parse(row); } }
  class OldHook { notify(event) { ran++; } }
  const Ok = Registry("job.ok", async () => 1);
  await drive(Schedule().source(rows({ key: "ok", handler: "job.ok" })).task(OldParser).registry(Registry.empty().add(Ok)).hook(OldHook).sync(false).tick(100));
  assert.ok(ran > 0);
});
