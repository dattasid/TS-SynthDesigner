import type { Rng } from "./rng";

/** Normal distribution via Box-Muller. Uses two draws per sample and keeps no cached state. */
export function normal(rng: Rng, mean: number, stddev: number): number {
  const u1 = 1 - rng.random(); // (0, 1], so log(u1) is finite
  const u2 = rng.random();
  return mean + stddev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Poisson distribution. Knuth's multiplication method for small means, Hörmann's PTRS (as numpy uses) for large ones. */
export function poisson(rng: Rng, mean: number): number {
  if (mean === 0) return 0;
  if (mean < 10) {
    const limit = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= rng.random();
    } while (p > limit);
    return k - 1;
  }
  const slam = Math.sqrt(mean);
  const loglam = Math.log(mean);
  const b = 0.931 + 2.53 * slam;
  const a = -0.059 + 0.02483 * b;
  const invalpha = 1.1239 + 1.1328 / (b - 3.4);
  const vr = 0.9277 - 3.6224 / (b - 2);
  for (;;) {
    const u = rng.random() - 0.5;
    const v = rng.random();
    const us = 0.5 - Math.abs(u);
    const k = Math.floor(((2 * a) / us + b) * u + mean + 0.43);
    if (us >= 0.07 && v <= vr) return k;
    if (k < 0 || (us < 0.013 && v > us)) continue;
    if (Math.log(v) + Math.log(invalpha) - Math.log(a / (us * us) + b) <= -mean + k * loglam - lgamma(k + 1)) {
      return k;
    }
  }
}

/**
 * Binomial distribution by geometric skipping: jump straight to the next success instead of rolling every trial.
 * Expected cost is O(n * min(p, 1 - p)).
 */
export function binomial(rng: Rng, n: number, p: number): number {
  if (n === 0 || p === 0) return 0;
  if (p === 1) return n;
  const flip = p > 0.5;
  const logFail = Math.log1p(-(flip ? 1 - p : p));
  let successes = 0;
  let trial = 0;
  for (;;) {
    trial += Math.floor(Math.log(1 - rng.random()) / logFail) + 1;
    if (trial > n) break;
    successes++;
  }
  return flip ? n - successes : successes;
}

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** log(Gamma(x)) for x > 0, Lanczos approximation (g = 7). */
export function lgamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  const z = x - 1;
  let sum = LANCZOS[0]!;
  for (let i = 1; i < LANCZOS.length; i++) sum += LANCZOS[i]! / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Precomputed weighted choice over a fixed list of options. */
export class WeightedTable<V> {
  private readonly cumulative: number[];
  private readonly total: number;

  constructor(
    readonly options: readonly V[],
    weights: readonly number[],
  ) {
    let running = 0;
    this.cumulative = weights.map((w) => (running += w));
    this.total = running;
  }

  pick(rng: Rng): V {
    const u = rng.random() * this.total;
    // First index whose cumulative weight exceeds u. Zero-weight options are never chosen.
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cumulative[mid]! > u) hi = mid;
      else lo = mid + 1;
    }
    return this.options[lo]!;
  }
}

export function roundTo(value: number, decimalPlaces: number | undefined): number {
  if (decimalPlaces === undefined) return value;
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}
