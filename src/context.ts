import { ConfigError } from "./errors";
import type { Trace } from "./gen";
import type { LLMProvider } from "./llm/provider";
import { MersenneTwister, Sfc32, type Rng } from "./rng";

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
  /** Index of the run's first row (default 0); see `Global.startIndex`. */
  startIndex?: number;
  /** How many rows the run makes, if known; see `Global.numRecords`. */
  numRecords?: number;
}

/**
 * What every row of a run shares: one object per run (per `preview()` or `create()` call, not per
 * process), referenced by every context. Read only.
 */
export class Global {
  /** The seed key of the run. Pass it back as `seed` to get the same records again. */
  readonly seed: readonly number[];
  /**
   * Index of the run's first row (default 0). Row indices run from here, so runs meant to be joined
   * can take disjoint ranges: `{ startIndex: 200 }` after a run of 200. Rows depend on their index.
   */
  readonly startIndex: number;
  /** How many rows the run makes; undefined for a context made outside a run. */
  readonly numRecords: number | undefined;
  private readonly providers: Readonly<Record<string, LLMProvider>>;
  private readonly models: Readonly<Record<string, ModelSpec>>;

  constructor(seed: readonly number[], startIndex: number, numRecords: number | undefined, providers: Readonly<Record<string, LLMProvider>>, models: Readonly<Record<string, ModelSpec>>) {
    this.seed = seed;
    this.startIndex = startIndex;
    this.numRecords = numRecords;
    this.providers = providers;
    this.models = models;
  }

  /** The spec and provider for a model nickname. A ConfigError naming the known nicknames if unknown. */
  model(nickname: string): { spec: ModelSpec; provider: LLMProvider } {
    const spec = Object.hasOwn(this.models, nickname) ? this.models[nickname] : undefined;
    if (!spec) {
      const known = Object.keys(this.models);
      throw new ConfigError(
        `unknown model '${nickname}'. ` + (known.length ? `Models: ${known.join(", ")}.` : "No models were given; pass models (and providers) to preview()."),
      );
    }
    return { spec, provider: this.providers[spec.provider]! };
  }
}

/** The row being generated. */
export interface RowInfo {
  /** Its index in the run: `global.startIndex` for the first row, then counting up. */
  readonly index: number;
}

/**
 * Carries everything a Gen needs besides its dependencies: the RNG, the path of the field being
 * generated (for error messages), the row, and the run's shared `global` (seed, models).
 *
 * Each field path has its own context, made by `child(name)`, with a stream forked from the seed and
 * the path. So adding, removing or reordering a field never changes the values of the other fields.
 *
 * In a run, Gens get a row's view of their field's context (`forRow`): the same path and `global`,
 * `ctx.row`, and a stream of the row's own, forked from the path's stream and the row index. So a
 * row's values depend only on the seed and its index: not on the rows before it, the batch size, or
 * the order async calls finish in.
 */
export class Context {
  private constructor(
    readonly rng: Rng,
    readonly path: readonly string[],
    readonly global: Global,
    private readonly children: Map<string, Context>,
    private readonly traceSink?: Trace,
    private readonly rowInfo?: RowInfo,
    /** For a row view: the field's own context (shared by all rows). */
    private readonly base?: Context,
  ) {}

  static create({ seed, providers = {}, models = {}, startIndex = 0, numRecords }: ContextParams = {}): Context {
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
    if (!Number.isSafeInteger(startIndex) || startIndex < 0) throw new RangeError(`startIndex must be an integer >= 0, got ${startIndex}.`);
    const rng = new MersenneTwister(seed ?? randomSeed());
    return new Context(rng, [], new Global(rng.key, startIndex, numRecords, providers, models), new Map());
  }

  /** The run's seed key; the same as `global.seed`. */
  get seed(): readonly number[] {
    return this.global.seed;
  }

  /**
   * The context for a named child. Cached, so it is the same object every time. A row's view gets
   * the row's view of the child.
   */
  child(name: string): Context {
    let c = this.children.get(name);
    if (!c) {
      c = this.base
        ? this.base.child(name).forRow(this.rowInfo!.index)
        : new Context(this.rng.fork(name), [...this.path, name], this.global, new Map());
      this.children.set(name, c);
    }
    return c;
  }

  /**
   * Row `index`'s view of this context: the row's own stream, `row` set, and `trace()` writing
   * into `traceSink` if given. The plan makes one per row per field.
   */
  forRow(index: number, traceSink?: Trace): Context {
    const base = this.base ?? this;
    return new Context(Sfc32.forRow(base.rng.key, index), base.path, base.global, new Map(), traceSink, { index }, base);
  }

  /** The row being generated. A ConfigError outside a run (e.g. a Gen called on `Context.create()`). */
  get row(): RowInfo {
    if (!this.rowInfo) throw new ConfigError(`field '${this.pathString}': ctx.row is only set while a run (preview, create) generates a row.`);
    return this.rowInfo;
  }

  /** Whether this is a row's view, so `row` is set. */
  get hasRow(): boolean {
    return this.rowInfo !== undefined;
  }

  /**
   * Notes something about the value being made, e.g. `ctx.trace({ reasoning })`, for fields reading
   * this one with `traceOf`. A no-op unless some field does.
   */
  trace(entries: Trace): void {
    if (this.traceSink) Object.assign(this.traceSink, entries);
  }

  get pathString(): string {
    return this.path.length === 0 ? "<root>" : this.path.join(".");
  }

  /** The spec and provider for a model nickname; see `Global.model`. */
  model(nickname: string): { spec: ModelSpec; provider: LLMProvider } {
    return this.global.model(nickname);
  }
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}
