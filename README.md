# ecosy-schedule
## Injected context

`Schedule({ … })` takes an injection map. Each entry is constructed once at
`start()`, and the resulting object is the context every callback receives:
a registry handler's `run(ctx)`, a source's `read(ctx)`, and — since 0.2.0 —
the third argument of `notFound` and `onError`.

```ts
export const AppSchedule = Schedule({ logger: AppLogger })
  .source(ApiSource)
  .task(CronRowParser)
  .registry(registry)
  .notFound((key, task, ctx) => {
    ctx.logger.warn(`[cron] "${task.key}" names handler "${key}", which is not registered`);
  })
  .onError((event, task, ctx) => {
    ctx.logger.error(`[cron] ${task.key} failed (${event.reason}): ${event.detail ?? ""}`);
  });
```

Those two are plain functions rather than classes, so they cannot inject for
themselves; before 0.2.0 an app had to reach its logger around the scheduler.
The context is the last argument, so a handler written for `(key, task)` or
`(event, task)` still fits.
