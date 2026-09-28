import { MersenneTwister, type Rng } from "./rng";

/** Placeholder for LLM model settings. The shape is TBD; only the alias is used to look models up. */
export interface ModelConfig {
  alias: string;
  model: string;
  provider?: string;
}

export interface ContextParams {
  /** Omit for a random seed. `ctx.seed` reports the one used, so any run can be reproduced. */
  seed?: number | readonly number[];
  modelConfigs?: readonly ModelConfig[];
}

/**
 * Carries everything a Gen needs besides its dependencies: the RNG, the path of the field being
 * generated (for error messages), and the model configs.
 *
 * Each field gets its own RNG stream via `child(name)`, forked from the seed and the field path.
 * So adding, removing or reordering a field never changes the values of the other fields.
 */
export class Context {
  private readonly children = new Map<string, Context>();

  private constructor(
    readonly rng: Rng,
    readonly seed: readonly number[],
    readonly path: readonly string[],
    readonly modelConfigs: readonly ModelConfig[],
  ) {}

  static create({ seed, modelConfigs = [] }: ContextParams = {}): Context {
    const rng = new MersenneTwister(seed ?? randomSeed());
    return new Context(rng, rng.key, [], modelConfigs);
  }

  /** The context for a named child. Cached, so the same child keeps drawing from one stream across records. */
  child(name: string): Context {
    let c = this.children.get(name);
    if (!c) {
      c = new Context(this.rng.fork(name), this.seed, [...this.path, name], this.modelConfigs);
      this.children.set(name, c);
    }
    return c;
  }

  get pathString(): string {
    return this.path.length === 0 ? "<root>" : this.path.join(".");
  }
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}
