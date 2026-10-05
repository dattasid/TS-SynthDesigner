import type { Context } from "../context";
import { binomial, normal, poisson, roundTo } from "../distributions";
import { GenerationError } from "../errors";
import { BaseGen, type Gen } from "../gen";

// `type` and the parameter names follow DataDesigner's SamplerType values and sampler params (camelCased).

export interface UniformParams {
  type: "uniform";
  /** Lower bound, inclusive. */
  low: number;
  /** Upper bound: exclusive, or inclusive when `integer` or `decimalPlaces` is given. */
  high: number;
  /** Sample whole numbers in [low, high]. Both bounds must then be integers. */
  integer?: boolean;
  /**
   * Sample numbers with this many decimals in [low, high], each equally likely: `low: 10, high: 1000,
   * decimalPlaces: 2` gives 10.00, 10.01, ..., 1000.00. See `roundTo` for how exact they are.
   */
  decimalPlaces?: number;
}

export interface GaussianParams {
  type: "gaussian";
  mean: number;
  stddev: number;
  decimalPlaces?: number;
}

export interface PoissonParams {
  type: "poisson";
  /** Mean number of events in a fixed interval. */
  mean: number;
}

export interface BinomialParams {
  type: "binomial";
  /** Number of trials. */
  n: number;
  /** Probability of success on each trial. */
  p: number;
}

export interface BernoulliParams {
  type: "bernoulli";
  /** Probability of 1; otherwise 0. */
  p: number;
}

/** With probability `p` a sample of `gen`, otherwise 0. Models "zero-inflated" data such as spend or claim amounts. */
export interface BernoulliMixtureParams {
  type: "bernoulli_mixture";
  p: number;
  /** DataDesigner takes a scipy distribution name here; this takes any number Gen without inputs. */
  gen: Gen<number>;
}

export type NumberSamplerParams = { id?: string } & (
  | UniformParams
  | GaussianParams
  | PoissonParams
  | BinomialParams
  | BernoulliParams
  | BernoulliMixtureParams
);

export type NumberSamplerType = NumberSamplerParams["type"];

/**
 * Samples numbers from the distribution named by `type`. Each type has its own parameters,
 * so passing `mean` to a uniform, or forgetting `stddev` on a gaussian, is a compile error.
 */
export class NumberSamplerGen extends BaseGen<number> {
  readonly params: NumberSamplerParams;
  /** Uniform with decimalPlaces: the bounds in steps of 10^-decimalPlaces. */
  private steps: [number, number] | undefined;

  constructor(params: NumberSamplerParams) {
    super(params.id);
    this.params = params;
    this.validate();
  }

  generate(_deps: {}, ctx: Context): number {
    const p = this.params;
    switch (p.type) {
      case "uniform":
        if (p.integer) return ctx.rng.int(p.low, p.high);
        // A whole number of steps, divided by 10^n: rounding a float instead would make the end
        // values half as likely as the others.
        if (this.steps) return ctx.rng.int(...this.steps) / 10 ** p.decimalPlaces!;
        return roundTo(p.low + ctx.rng.random() * (p.high - p.low), p.decimalPlaces);
      case "gaussian":
        return roundTo(normal(ctx.rng, p.mean, p.stddev), p.decimalPlaces);
      case "poisson":
        return poisson(ctx.rng, p.mean);
      case "binomial":
        return binomial(ctx.rng, p.n, p.p);
      case "bernoulli":
        return ctx.rng.random() < p.p ? 1 : 0;
      case "bernoulli_mixture":
        // Separate streams, so whether the mix fires does not shift the inner gen's samples.
        if (ctx.child("mix").rng.random() >= p.p) return 0;
        const value = p.gen.generate({}, ctx.child("value"));
        if (value instanceof Promise) {
          value.catch(() => {});
          throw new GenerationError(`${this.describe()} at ${ctx.pathString}: the mixed-in gen is async; it must be sync.`);
        }
        return value;
    }
  }

  protected override describe(): string {
    return `${super.describe()} (${this.params.type})`;
  }

  private validate(): void {
    const p = this.params;
    switch (p.type) {
      case "uniform":
        if (p.integer) {
          this.check(Number.isSafeInteger(p.low) && Number.isSafeInteger(p.high), `integer bounds must be integers, got [${p.low}, ${p.high}].`);
          this.check(p.low <= p.high, `low must be <= high, got [${p.low}, ${p.high}].`);
          this.check(p.decimalPlaces === undefined, "decimalPlaces does not apply when integer is true.");
        } else {
          this.check(Number.isFinite(p.low) && Number.isFinite(p.high) && p.low < p.high, `need finite low < high, got [${p.low}, ${p.high}).`);
        }
        this.checkDecimalPlaces(p.decimalPlaces);
        if (p.decimalPlaces !== undefined) {
          const factor = 10 ** p.decimalPlaces;
          // low * factor can be a hair off a whole number (0.07 * 100 = 7.000000000000001); snap it first.
          const snap = (x: number) => (Math.abs(x - Math.round(x)) <= 1e-9 * Math.max(1, Math.abs(x)) ? Math.round(x) : x);
          const lo = Math.ceil(snap(p.low * factor));
          const hi = Math.floor(snap(p.high * factor));
          this.check(Number.isSafeInteger(lo) && Number.isSafeInteger(hi), `[${p.low}, ${p.high}] with ${p.decimalPlaces} decimal places is too many digits for a number.`);
          this.check(lo <= hi, `no number with ${p.decimalPlaces} decimal places is in [${p.low}, ${p.high}].`);
          this.steps = [lo, hi];
        }
        return;
      case "gaussian":
        this.check(Number.isFinite(p.mean), `mean must be finite, got ${p.mean}.`);
        this.check(Number.isFinite(p.stddev) && p.stddev >= 0, `stddev must be finite and >= 0, got ${p.stddev}.`);
        this.checkDecimalPlaces(p.decimalPlaces);
        return;
      case "poisson":
        this.check(Number.isFinite(p.mean) && p.mean >= 0, `mean must be finite and >= 0, got ${p.mean}.`);
        return;
      case "binomial":
        this.check(Number.isSafeInteger(p.n) && p.n >= 0, `n must be an integer >= 0, got ${p.n}.`);
        this.checkProbability(p.p);
        return;
      case "bernoulli":
        this.checkProbability(p.p);
        return;
      case "bernoulli_mixture":
        this.checkProbability(p.p);
        return;
      default:
        // Reachable only from untyped JS callers.
        this.check(false, `unknown type '${(p as { type: unknown }).type}'.`);
    }
  }
}
