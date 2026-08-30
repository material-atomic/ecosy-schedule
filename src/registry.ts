import type { ClassType, InjectMap, Injected, Promisable } from "./types";

/**
 * Handlers, held by name.
 *
 * A source entry is text, so it cannot carry a function — only a key that
 * points at one. This is the other half of that: the code declares handlers
 * under names, and the source names them.
 *
 * An entry is a class, not an object, because the scheduler constructs it —
 * once per run, so a handler never holds a connection open between fires. The
 * key lives on the static side because the lookup happens before anything is
 * built.
 */
export type HandlerFn<Context = unknown> = (context: Context) => Promisable<unknown>;

export interface RegistryEntry<Context = unknown> {
  run(context: Context): Promisable<unknown>;
}

/** A handler class: `key` to find it by, `run` once it exists. */
export interface RegistryEntryClass<Context = unknown> extends ClassType<RegistryEntry<Context>> {
  readonly key: string;
}

export interface IRegistry<Context = unknown> {
  add(entry: RegistryEntryClass<Context>): IRegistry<Context>;
  /** The handler under `key`, or undefined — which is what `notFound` reports on. */
  get(key: string): RegistryEntryClass<Context> | undefined;
  keys(): string[];
}

/**
 * The registry itself stays a plain collection.
 *
 * Nothing ever constructs it — it is read, not built — so making it a class
 * would be ceremony without a job. The rule is about what the scheduler
 * instantiates, and that is the entries, not the box holding them.
 */
function build<Context>(entries: ReadonlyMap<string, RegistryEntryClass<Context>>): IRegistry<Context> {
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
  <Context = unknown>(key: string, handler: HandlerFn<Context>): RegistryEntryClass<Context>;
  /** A handler whose context carries the given tokens, constructed per run. */
  <Injects extends InjectMap, Context = unknown>(
    key: string,
    injects: Injects,
    handler: HandlerFn<Injected<Context, Injects>>,
  ): RegistryEntryClass<Context>;
  /** An empty registry to chain `.add()` onto. */
  empty<Context = unknown>(): IRegistry<Context>;
  add<Context = unknown>(entry: RegistryEntryClass<Context>): IRegistry<Context>;
}

const RegistryImpl = function (
  key: string,
  second: InjectMap | HandlerFn<never>,
  third?: HandlerFn<never>,
): RegistryEntryClass<never> {
  const injects = typeof second === "function" ? {} : second;
  const handler = (typeof second === "function" ? second : third) as HandlerFn<never>;

  if (typeof handler !== "function") {
    throw new Error(`Registry: handler for "${key}" is missing`);
  }

  return class Entry {
    static readonly key = key;

    run(context: never) {
      // Tokens are constructed here, per run, so a handler never holds a
      // connection open between fires.
      const scoped = context as Record<string, unknown>;
      for (const [name, Token] of Object.entries(injects)) {
        scoped[name] = new (Token as ClassType)();
      }
      return handler(context);
    }
  };
} as unknown as RegistryFactory;

RegistryImpl.empty = <Context>() => build<Context>(new Map());
RegistryImpl.add = <Context>(entry: RegistryEntryClass<Context>) =>
  RegistryImpl.empty<Context>().add(entry);

export const Registry = RegistryImpl;
