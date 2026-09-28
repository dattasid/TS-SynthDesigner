import type { Context } from "../context";
import { binomial, normal, poisson, roundTo } from "../distributions";
import { BaseGen, type Gen } from "../gen";

// Parameter names and meanings follow DataDesigner's sampler params (camelCased).

export interface UniformSamplerParams {
  id?: string;
  /** Lower bound, inclusive. */
  low: number;
  /** Upper bound: exclusive for "float", inclusive for "int". */
  high: number;
  /** "float" (default) samples [low, high). "int" samples whole numbers in [low, high]; both must be integers. */
  type?: "float" | "int";
  /** Round float samples to this many decimals. */
  decimalPlaces?: number;
}

export class UniformSamplerGen extends BaseGen<number> {
  readonly low: number;
  readonly high: number;
  readonly type: "float" | "int";
  readonly decimalPlaces: number | undefined;

  constructor({ id, low, high, type = "float", decimalPlaces }: UniformSamplerParams) {
    super(id, {});
    this.low = low;
    this.high = high;
    this.type = type;
    this.decimalPlaces = decimalPlaces;
    if (type === "int") {
      this.check(Number.isSafeInteger(low) && Number.isSafeInteger(high), `int bounds must be integers, got [${low}, ${high}].`);
      this.check(low <= high, `low must be <= high, got [${low}, ${high}].`);
      this.check(decimalPlaces === undefined, "decimalPlaces does not apply to type 'int'.");
    } else {
      this.check(Number.isFinite(low) && Number.isFinite(high) && low < high, `need finite low < high, got [${low}, ${high}).`);
    }
    this.checkDecimalPlaces(decimalPlaces);
  }

  generate(_deps: {}, ctx: Context): number {
    if (this.type === "int") return ctx.rng.int(this.low, this.high);
    return roundTo(this.low + ctx.rng.random() * (this.high - this.low), this.decimalPlaces);
  }
}

export interface GaussianSamplerParams {
  id?: string;
  mean: number;
  stddev: number;
  decimalPlaces?: number;
}

export class GaussianSamplerGen extends BaseGen<number> {
  readonly mean: number;
  readonly stddev: number;
  readonly decimalPlaces: number | undefined;

  constructor({ id, mean, stddev, decimalPlaces }: GaussianSamplerParams) {
    super(id, {});
    this.mean = mean;
    this.stddev = stddev;
    this.decimalPlaces = decimalPlaces;
    this.check(Number.isFinite(mean), `mean must be finite, got ${mean}.`);
    this.check(Number.isFinite(stddev) && stddev >= 0, `stddev must be finite and >= 0, got ${stddev}.`);
    this.checkDecimalPlaces(decimalPlaces);
  }

  generate(_deps: {}, ctx: Context): number {
    return roundTo(normal(ctx.rng, this.mean, this.stddev), this.decimalPlaces);
  }
}

export interface PoissonSamplerParams {
  id?: string;
  /** Mean number of events in a fixed interval. */
  mean: number;
}

export class PoissonSamplerGen extends BaseGen<number> {
  readonly mean: number;

  constructor({ id, mean }: PoissonSamplerParams) {
    super(id, {});
    this.mean = mean;
    this.check(Number.isFinite(mean) && mean >= 0, `mean must be finite and >= 0, got ${mean}.`);
  }

  generate(_deps: {}, ctx: Context): number {
    return poisson(ctx.rng, this.mean);
  }
}

export interface BinomialSamplerParams {
  id?: string;
  /** Number of trials. */
  n: number;
  /** Probability of success on each trial. */
  p: number;
}

export class BinomialSamplerGen extends BaseGen<number> {
  readonly n: number;
  readonly p: number;

  constructor({ id, n, p }: BinomialSamplerParams) {
    super(id, {});
    this.n = n;
    this.p = p;
    this.check(Number.isSafeInteger(n) && n >= 0, `n must be an integer >= 0, got ${n}.`);
    this.checkProbability(p);
  }

  generate(_deps: {}, ctx: Context): number {
    return binomial(ctx.rng, this.n, this.p);
  }
}

export interface BernoulliSamplerParams {
  id?: string;
  /** Probability of 1. */
  p: number;
}

export class BernoulliSamplerGen extends BaseGen<0 | 1> {
  readonly p: number;

  constructor({ id, p }: BernoulliSamplerParams) {
    super(id, {});
    this.p = p;
    this.checkProbability(p);
  }

  generate(_deps: {}, ctx: Context): 0 | 1 {
    return ctx.rng.random() < this.p ? 1 : 0;
  }
}

export interface BernoulliMixtureSamplerParams {
  id?: string;
  /** Probability of sampling from `gen`. Otherwise the value is 0. */
  p: number;
  /** The distribution sampled with probability `p`. DataDesigner takes a scipy name; here it is any number Gen without deps. */
  gen: Gen<number>;
}

/** With probability `p` a sample of `gen`, otherwise 0. Models "zero-inflated" data such as spend or claim amounts. */
export class BernoulliMixtureSamplerGen extends BaseGen<number> {
  readonly p: number;
  readonly gen: Gen<number>;

  constructor({ id, p, gen }: BernoulliMixtureSamplerParams) {
    super(id, {});
    this.p = p;
    this.gen = gen;
    this.checkProbability(p);
    this.check(Object.keys(gen.deps).length === 0, "the mixed gen must not have deps.");
  }

  generate(_deps: {}, ctx: Context): number {
    // Separate streams, so whether the mix fires does not shift the inner gen's samples.
    if (ctx.child("mix").rng.random() >= this.p) return 0;
    return this.gen.generate({}, ctx.child("value"));
  }
}
