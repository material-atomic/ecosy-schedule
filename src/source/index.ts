import type { ClassType, Promisable, SourceAdapter, TaskDefinition, TaskParser, TaskTarget } from "../types";

/**
 * Built-in sources and the line format they produce.
 *
 * Only local files and HTTP: sharing a file between instances behind a load
 * balancer is a mount, not a library concern.
 */

/**
 * Wraps a reader function into a source class.
 *
 * `.source()` takes a class, not a callback, so that nothing in the scheduler
 * has to work out at runtime what it was handed. This keeps the one-line case
 * one line without reintroducing that ambiguity.
 */
export function Source<Entry = string, Context = unknown>(
  read: (context: Context) => Promisable<Entry[]>,
): ClassType<SourceAdapter<Entry, Context>> {
  return class implements SourceAdapter<Entry, Context> {
    read(context: Context) {
      return read(context);
    }
  };
}

/** Drops comments and blank lines. Everything else is a task. */
function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function FileSource(path: string): ClassType<SourceAdapter<string, unknown>> {
  return class implements SourceAdapter<string, unknown> {
    async read(): Promise<string[]> {
      const { readFile } = await import("node:fs/promises");
      return lines(await readFile(path, "utf-8"));
    }
  };
}

export function HttpSource(url: string, init?: RequestInit): ClassType<SourceAdapter<string, unknown>> {
  return class implements SourceAdapter<string, unknown> {
    async read(): Promise<string[]> {
      const response = await fetch(url, init);

      // Thrown, not swallowed: the scheduler treats a failed read as "keep
      // what we have", and it can only do that if it hears about the failure.
      if (!response.ok) throw new Error(`HttpSource: ${url} answered ${response.status}`);

      return lines(await response.text());
    }
  };
}

/* ------------------------------------------------------------ line format */

/**
 * Crontab-shaped, one task per line:
 *
 * ```
 * # every five minutes
 * 0 *\/5 * * * *  handler:session.cleanup
 * 0 0 3 * * *     api:https://app/internal/report   tz=Asia/Ho_Chi_Minh retry=2
 * 0 0 4 * * *     file:./scripts/rollup.js          name=nightly-rollup
 * ```
 *
 * The target doubles as the key, since one target on one schedule is the usual
 * case. `name=` overrides it, which is what you need to run the same handler on
 * two different expressions.
 */
export class LineParser implements TaskParser<string> {
  parse(line: string): TaskDefinition {
    const tokens = line.split(/\s+/);

    // Five cron fields or six, then the target: count from the target
    // backwards would be ambiguous, so find it by its `kind:` prefix.
    const targetAt = tokens.findIndex((token) => /^(handler|api|file):/.test(token));

    if (targetAt < 5 || targetAt > 6) {
      throw new Error(`LineParser: expected a handler:/api:/file: target after 5 or 6 cron fields — "${line}"`);
    }

    const expression = tokens.slice(0, targetAt).join(" ");
    const target = this.target(tokens[targetAt], line);
    const options = this.options(tokens.slice(targetAt + 1));

    return {
      key: options.name ?? tokens[targetAt],
      expression,
      target,
      timezone: options.tz,
      enabled: options.enabled !== "false",
      retry: options.retry === undefined ? undefined : Number(options.retry),
      timeout: options.timeout === undefined ? undefined : Number(options.timeout),
    };
  }

  private target(token: string, line: string): TaskTarget {
    const at = token.indexOf(":");
    const kind = token.slice(0, at);
    const rest = token.slice(at + 1);

    if (!rest) throw new Error(`LineParser: "${kind}:" has no value — "${line}"`);

    switch (kind) {
      case "handler": return { type: "handler", key: rest };
      case "api": return { type: "api", url: rest };
      case "file": return { type: "file", path: rest };
      default: throw new Error(`LineParser: unknown target "${kind}" — "${line}"`);
    }
  }

  private options(tokens: string[]): Record<string, string | undefined> {
    const options: Record<string, string> = {};

    for (const token of tokens) {
      const at = token.indexOf("=");
      if (at > 0) options[token.slice(0, at)] = token.slice(at + 1);
    }

    return options;
  }
}
