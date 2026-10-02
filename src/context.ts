import { ConfigError } from "./errors";
import type { Trace } from "./gen";
import type { LLMProvider } from "./llm/provider";
import { MersenneTwister, type Rng } from "./rng";

/** A model under a nickname: which provider serves it, and the parameters every call sends. */
export interface ModelSpec {
  /** Key of a provider in the context's `providers`. */
  provider: string;
  /** The provider's model name, e.g. "nvidia/nemotron-mini-4b-instruct". */
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /**
   * Send a per-row seed, drawn from the field's random stream (default true). Best effort: the
   * OpenAI format sends it, Anthropic has no such parameter. Set false for an endpoint that rejects it.
   */
  seed?: boolean;
  /** Provider-specific body fields, passed through untouched. */
  extra?: Readonly<Record<string, unknown>>;
}

export interface ContextParams {
  /** Omit for a random seed. `ctx.seed` reports the one used, so any run can be reproduced. */
  seed?: number | readonly number[];
  /** Name -> provider, e.g. `{ nvidia: Provider.nvidia() }`. */
  providers?: Readonly<Record<string, LLMProvider>>;
  /** Nickname -> model spec, e.g. `{ fast: { provider: "nvidia", model: "...", temperature: 0.9 } }`. */
  models?: Readonly<Record<string, ModelSpec>>;
}

/** The providers and models of a context, shared by all its children. */
interface LLMSetup {
  providers: Readonly<Record<string, LLMProvider>>;
  models: Readonly<Record<string, ModelSpec>>;
}

/**
 * Carries everything a Gen needs besides its dependencies: the RNG, the path of the field being
 * generated (for error messages), and the LLM providers and model nicknames.
 *
 * Each field gets its own RNG stream via `child(name)`, forked from the seed and the field path.
 * So adding, removing or reordering a field never changes the values of the other fields.
 */
export class Context {
  private constructor(
    readonly rng: Rng,
    readonly seed: readonly number[],
    readonly path: readonly string[],
    private readonly llm: LLMSetup,
    private readonly children = new Map<string, Context>(),
    private readonly traceSink?: Trace,
  ) {}

  static create({ seed, providers = {}, models = {} }: ContextParams = {}): Context {
    for (const [nick, spec] of Object.entries(models)) {
      if (!Object.hasOwn(providers, spec.provider)) {
        const known = Object.keys(providers);
        throw new ConfigError(
          `model '${nick}' uses provider '${spec.provider}', which is not in providers` +
            (known.length ? ` (${known.join(", ")}).` : " (none given)."),
        );
      }
      if (typeof spec.model !== "string" || spec.model === "") throw new ConfigError(`model '${nick}' needs a model name.`);
    }
    const rng = new MersenneTwister(seed ?? randomSeed());
    return new Context(rng, rng.key, [], { providers, models });
  }

  /** The context for a named child. Cached, so the same child keeps drawing from one stream across records. */
  child(name: string): Context {
    let c = this.children.get(name);
    if (!c) {
      c = new Context(this.rng.fork(name), this.seed, [...this.path, name], this.llm);
      this.children.set(name, c);
    }
    return c;
  }

  /**
   * Notes something about the value being made, e.g. `ctx.trace({ reasoning })`, for fields reading
   * this one with `traceOf`. A no-op unless some field does.
   */
  trace(entries: Trace): void {
    if (this.traceSink) Object.assign(this.traceSink, entries);
  }

  /** This context, with `trace()` writing into `sink`. The plan makes one per row for traced fields. */
  withTrace(sink: Trace): Context {
    return new Context(this.rng, this.seed, this.path, this.llm, this.children, sink);
  }

  get pathString(): string {
    return this.path.length === 0 ? "<root>" : this.path.join(".");
  }

  /** The spec and provider for a model nickname. A ConfigError naming the known nicknames if unknown. */
  model(nickname: string): { spec: ModelSpec; provider: LLMProvider } {
    const spec = Object.hasOwn(this.llm.models, nickname) ? this.llm.models[nickname] : undefined;
    if (!spec) {
      const known = Object.keys(this.llm.models);
      throw new ConfigError(
        `unknown model '${nickname}'. ` + (known.length ? `Models: ${known.join(", ")}.` : "No models were given; pass models (and providers) to preview()."),
      );
    }
    return { spec, provider: this.llm.providers[spec.provider]! };
  }
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}
