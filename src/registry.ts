import type { ClassType, InjectMap, Injected, Promisable } from "./types";

/**
 * Handlers, held by name.
 *
 * A source entry is text, so it cannot carry a function — only a key that
 * points at one. This is the other half of that: the code declares handlers
 * under names, and the source names them.
 *
 * The wrapper exists so a handler can be given a context: `Entry(fn)` is what
 * lets the scheduler build one and inject into it, the same way a route
 * handler receives its context rather than reaching for globals.
 */
export type HandlerFn<Context = unknown> = (context: Context) => Promisable<unknown>;

export interface RegistryEntry<Context = unknown> {
  readonly key: string;
  readonly injects: InjectMap;
  run(context: Context): Promisable<unknown>;
}

export interface IRegistry<Context = unknown> {
  add(entry: RegistryEntry<Context>): IRegistry<Context>;
  /** The handler under `key`, or undefined — which is what `notFound` reports on. */
  get(key: string): RegistryEntry<Context> | undefined;
  keys(): string[];
}

function build<Context>(entries: ReadonlyMap<string, RegistryEntry<Context>>): IRegistry<Context> {
  return {
    add(entry) {
      // Last registration wins rather than throwing: a hot reload re-runs the
      // declaration, and refusing the second one would leave the first, stale
      // closure in place — the opposite of what an edit is asking for.
      const next = new Map(entries);
      next.set(entry.key, entry);
      return build(next);
    },
    get: (key) => entries.get(key),
    keys: () => [...entries.keys()],
  };
}

interface RegistryFactory {
  /** A handler with no dependencies. */
  <Context = unknown>(key: string, handler: HandlerFn<Context>): RegistryEntry<Context>;
  /** A handler whose context carries the given tokens, constructed per run. */
  <Injects extends InjectMap, Context = unknown>(
    key: string,
    injects: Injects,
    handler: HandlerFn<Injected<Context, Injects>>,
  ): RegistryEntry<Context>;
  /** An empty registry to chain `.add()` onto. */
  empty<Context = unknown>(): IRegistry<Context>;
  add<Context = unknown>(entry: RegistryEntry<Context>): IRegistry<Context>;
}

const RegistryImpl = function (
  key: string,
  second: InjectMap | HandlerFn<never>,
  third?: HandlerFn<never>,
): RegistryEntry<never> {
  const injects = typeof second === "function" ? {} : second;
  const handler = (typeof second === "function" ? second : third) as HandlerFn<never>;

  if (typeof handler !== "function") {
    throw new Error(`Registry: handler for "${key}" is missing`);
  }

  return {
    key,
    injects,
    run(context) {
      // Tokens are constructed per run, not per registration, so a handler
      // never holds a connection open between fires.
      const scoped = context as Record<string, unknown>;
      for (const [name, Token] of Object.entries(injects)) {
        scoped[name] = new (Token as ClassType)();
      }
      return handler(context);
    },
  };
} as unknown as RegistryFactory;

RegistryImpl.empty = <Context>() => build<Context>(new Map());
RegistryImpl.add = <Context>(entry: RegistryEntry<Context>) => RegistryImpl.empty<Context>().add(entry);

export const Registry = RegistryImpl;
