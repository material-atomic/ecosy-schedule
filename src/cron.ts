/**
 * Cron expression parsing and next-fire calculation.
 *
 * Six fields, seconds first:
 *
 * ```
 * ┌─────── second        0-59
 * │ ┌───── minute        0-59
 * │ │ ┌─── hour          0-23
 * │ │ │ ┌─ day of month  1-31
 * │ │ │ │ ┌ month        1-12 or JAN-DEC
 * │ │ │ │ │ ┌ day of week 0-6 or SUN-SAT (7 also means Sunday)
 * * * * * * *
 * ```
 *
 * Five fields are accepted too and read as standard crontab — seconds become
 * 0. That is not leniency for its own sake: an expression copied from a
 * crontab into a six-field parser shifts every value one column left and runs
 * at the wrong time without erroring. Counting the fields removes the trap.
 */

export interface CronField {
  /** Sorted, de-duplicated values this field matches. */
  values: number[];
  /** `*` — true when the field constrains nothing. Needed for the dom/dow rule. */
  wildcard: boolean;
}

export interface CronExpression {
  second: CronField;
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset to add to a name index, e.g. months are 1-based. */
  nameBase?: number;
}

const SPECS: FieldSpec[] = [
  { name: "second", min: 0, max: 59 },
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: "day of week", min: 0, max: 6, names: DAYS, nameBase: 0 },
];

function fail(expression: string, message: string): never {
  throw new Error(`Cron: ${message} in "${expression}"`);
}

function toNumber(token: string, spec: FieldSpec, expression: string): number {
  const named = spec.names?.indexOf(token.toLowerCase());

  if (named !== undefined && named >= 0) {
    return named + (spec.nameBase ?? 0);
  }

  if (!/^\d+$/.test(token)) {
    fail(expression, `"${token}" is not a valid ${spec.name}`);
  }

  const value = Number(token);

  // 7 is Sunday as well as 0 — both spellings are in the wild, and rejecting
  // one of them breaks expressions people copy from working systems.
  if (spec.name === "day of week" && value === 7) return 0;

  if (value < spec.min || value > spec.max) {
    fail(expression, `${spec.name} ${value} is outside ${spec.min}-${spec.max}`);
  }

  return value;
}

function parseField(raw: string, spec: FieldSpec, expression: string): CronField {
  // `?` means "no specific value" in Quartz. Treated as `*`, which is what it
  // amounts to once the dom/dow rule below is applied.
  const field = raw === "?" ? "*" : raw;
  const wildcard = field === "*";
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");

    if (stepRaw !== undefined && !/^\d+$/.test(stepRaw)) {
      fail(expression, `step "${stepRaw}" is not a number`);
    }

    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (step < 1) fail(expression, `step must be at least 1`);

    let from: number;
    let to: number;

    if (range === "*") {
      from = spec.min;
      to = spec.max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      from = toNumber(a, spec, expression);
      to = toNumber(b, spec, expression);
    } else {
      from = toNumber(range, spec, expression);
      // A bare value with a step means "from here to the end", e.g. `5/15`.
      to = stepRaw === undefined ? from : spec.max;
    }

    if (from > to) fail(expression, `range ${from}-${to} runs backwards`);

    for (let value = from; value <= to; value += step) values.add(value);
  }

  if (values.size === 0) fail(expression, `field "${raw}" matches nothing`);

  return { values: [...values].sort((a, b) => a - b), wildcard };
}

export function parseCron(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);

  // Five fields is standard crontab: prepend a zero second rather than
  // silently reading minute-as-second.
  const parts = fields.length === 5 ? ["0", ...fields] : fields;

  if (parts.length !== 6) {
    fail(expression, `expected 5 or 6 fields, got ${fields.length}`);
  }

  const [second, minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, i) =>
    parseField(part, SPECS[i], expression),
  );

  return { second, minute, hour, dayOfMonth, month, dayOfWeek };
}

/* ------------------------------------------------------ next fire */

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Wall-clock fields of an instant in a zone.
 *
 * `hourCycle: "h23"` matters: with plain `hour12: false` some locales render
 * midnight as 24, which then reads as an invalid hour.
 */
function partsInZone(instant: Date, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const read = (type: string) => Number(parts.find((p) => p.type === type)!.value);

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * The instant at which a zone's wall clock reads `wall`.
 *
 * Returns null when no such instant exists — the hour skipped by a
 * spring-forward transition. The caller treats that as "this occurrence does
 * not happen" and looks for the next one, which is what every cron does with a
 * time that the calendar simply never reaches.
 *
 * Ambiguous times, the hour repeated by a fall-back transition, resolve to the
 * first occurrence. Since the search always moves forward from the previous
 * fire, the second occurrence is never selected and the job runs once.
 */
function instantFromWall(wall: Wall, timeZone: string): Date | null {
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);

  // Offsets can shift between the guess and the answer, so iterate: each pass
  // measures the zone's offset at the current guess and corrects. Two passes
  // suffice everywhere; a third is cheap insurance against odd historical
  // zones.
  let guess = asIfUtc;

  for (let i = 0; i < 3; i++) {
    const seen = partsInZone(new Date(guess), timeZone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    const corrected = asIfUtc - (seenAsUtc - guess);

    if (corrected === guess) break;
    guess = corrected;
  }

  const check = partsInZone(new Date(guess), timeZone);
  const exists =
    check.year === wall.year && check.month === wall.month && check.day === wall.day &&
    check.hour === wall.hour && check.minute === wall.minute && check.second === wall.second;

  return exists ? new Date(guess) : null;
}

/** Weekday of a calendar date. Independent of zone: a date has one weekday. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nextValue(field: CronField, from: number): number | null {
  for (const value of field.values) if (value >= from) return value;
  return null;
}

/**
 * Whether a date matches the day fields.
 *
 * The rule is inherited from Vixie cron and surprises nearly everyone: when
 * *both* day-of-month and day-of-week are restricted, a date matches if
 * *either* does — not both. `0 0 0 1 * 1` fires on the 1st of every month and
 * on every Monday. When one of them is `*`, only the other constrains.
 */
function matchesDay(expr: CronExpression, year: number, month: number, day: number): boolean {
  const domMatch = expr.dayOfMonth.values.includes(day);
  const dowMatch = expr.dayOfWeek.values.includes(weekdayOf(year, month, day));

  if (expr.dayOfMonth.wildcard && expr.dayOfWeek.wildcard) return true;
  if (expr.dayOfMonth.wildcard) return dowMatch;
  if (expr.dayOfWeek.wildcard) return domMatch;

  return domMatch || dowMatch;
}

/** Bound on the search, in candidate days. Beyond five years an expression is unsatisfiable. */
const MAX_DAYS = 366 * 5;

/**
 * The first instant strictly after `from` that matches `expression` in `timeZone`.
 *
 * Returns null when the expression can never match — `0 0 0 30 2 *` asks for
 * February 30th. Returning null rather than looping forever means a bad row in
 * a cron table is reported, not a hung process.
 */
export function nextFire(
  expr: CronExpression,
  from: Date,
  timeZone = "UTC",
): Date | null {
  const start = partsInZone(new Date(from.getTime() + 1000), timeZone);

  let { year, month, day, hour, minute, second } = start;
  let daysScanned = 0;

  while (daysScanned <= MAX_DAYS) {
    // ── month
    const nextMonth = nextValue(expr.month, month);
    if (nextMonth === null) {
      year++;
      month = expr.month.values[0];
      day = 1;
      hour = minute = second = 0;
      continue;
    }
    if (nextMonth !== month) {
      month = nextMonth;
      day = 1;
      hour = minute = second = 0;
    }

    // ── day
    if (day > daysInMonth(year, month) || !matchesDay(expr, year, month, day)) {
      day++;
      hour = minute = second = 0;
      daysScanned++;

      if (day > daysInMonth(year, month)) {
        day = 1;
        month++;
        if (month > 12) {
          month = 1;
          year++;
        }
      }
      continue;
    }

    // ── hour
    const nextHour = nextValue(expr.hour, hour);
    if (nextHour === null) {
      day++;
      hour = minute = second = 0;
      daysScanned++;
      continue;
    }
    if (nextHour !== hour) {
      hour = nextHour;
      minute = second = 0;
    }

    // ── minute
    const nextMinute = nextValue(expr.minute, minute);
    if (nextMinute === null) {
      hour++;
      minute = second = 0;
      continue;
    }
    if (nextMinute !== minute) {
      minute = nextMinute;
      second = 0;
    }

    // ── second
    const nextSecond = nextValue(expr.second, second);
    if (nextSecond === null) {
      minute++;
      second = 0;
      continue;
    }
    second = nextSecond;

    const instant = instantFromWall({ year, month, day, hour, minute, second }, timeZone);

    // A wall time inside a spring-forward gap never happens. Step past it and
    // keep looking rather than reporting a time the clock will not reach.
    if (instant === null) {
      second++;
      if (second > 59) {
        second = 0;
        minute++;
        if (minute > 59) {
          minute = 0;
          hour++;
        }
      }
      continue;
    }

    return instant;
  }

  return null;
}
