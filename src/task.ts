import { nextFire, parseCron, type CronExpression } from "./cron";
import type { TaskDefinition } from "./types";

export interface TaskStatus {
  key: string;
  enabled: boolean;
  expression: string;
  timezone: string;
  nextAt: Date | null;
  running: boolean;
  lastRunAt: Date | null;
  lastOk: boolean | null;
  runs: number;
  failures: number;
}

/**
 * One scheduled task: its definition, when it fires next, and how it has been
 * doing.
 *
 * The split between the two matters at sync time. A definition that changed
 * gets a freshly computed schedule — the new expression decides the next fire,
 * not an adjustment of the old one — while the history carries over, because
 * "when did this last succeed" is the question people ask after an edit, not
 * before it.
 */
export class Task {
  readonly key: string;

  private definition: TaskDefinition;
  private cron: CronExpression;

  nextAt: Date | null = null;
  running = false;

  lastRunAt: Date | null = null;
  lastOk: boolean | null = null;
  runs = 0;
  failures = 0;

  constructor(definition: TaskDefinition, from: Date = new Date()) {
    this.key = definition.key;
    this.definition = definition;
    this.cron = parseCron(definition.expression);
    this.schedule(from);
  }

  get enabled(): boolean {
    return this.definition.enabled !== false;
  }

  get timezone(): string {
    return this.definition.timezone ?? "UTC";
  }

  get current(): TaskDefinition {
    return this.definition;
  }

  /** Recomputes the next fire from scratch. History is untouched. */
  private schedule(from: Date): void {
    this.nextAt = this.enabled ? nextFire(this.cron, from, this.timezone) : null;
  }

  /**
   * Applies a changed definition.
   *
   * Only reparses when the expression or zone actually moved: reparsing on
   * every sync would reset `nextAt` each time and, for anything firing less
   * often than the sync interval, push the fire permanently into the future.
   */
  update(definition: TaskDefinition, from: Date = new Date()): void {
    const rescheduled =
      definition.expression !== this.definition.expression ||
      definition.timezone !== this.definition.timezone ||
      (definition.enabled !== false) !== this.enabled;

    this.definition = definition;

    if (rescheduled) {
      this.cron = parseCron(definition.expression);
      this.schedule(from);
    }
  }

  due(now: Date): boolean {
    return this.enabled && !this.running && this.nextAt !== null && this.nextAt <= now;
  }

  /**
   * Moves to the fire after this one.
   *
   * Called the moment a run is picked up, before it finishes, so a task that
   * takes longer than its interval does not push its own schedule along behind
   * it. Overlap is prevented by `running`, not by delaying the clock.
   */
  advance(): Date {
    const fired = this.nextAt ?? new Date();
    this.nextAt = nextFire(this.cron, fired, this.timezone);
    return fired;
  }

  record(ok: boolean, at: Date): void {
    this.runs++;
    if (!ok) this.failures++;
    this.lastRunAt = at;
    this.lastOk = ok;
  }

  status(): TaskStatus {
    return {
      key: this.key,
      enabled: this.enabled,
      expression: this.definition.expression,
      timezone: this.timezone,
      nextAt: this.nextAt,
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastOk: this.lastOk,
      runs: this.runs,
      failures: this.failures,
    };
  }
}
