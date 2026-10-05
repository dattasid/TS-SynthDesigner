import { describe, expect, it } from "vitest";
import {
  NumberSamplerGen,
  ConfigError,
  Context,
} from "../src/index";

function sample(gen: NumberSamplerGen, n = 20_000): number[] {
  const ctx = Context.create({ seed: 7 });
  return Array.from({ length: n }, () => gen.generate({}, ctx));
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stddev = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
};

describe("number samplers", () => {
  it("with decimalPlaces: steps of 10^-n, bounds included, each value equally likely, no stray digits", () => {
    const decimals = (x: number) => (String(x).split(".")[1] ?? "").length;
    // 11 values, 0.00 to 0.10: the ends are as likely as the middle (rounding a float would halve them).
    const cents = sample(new NumberSamplerGen({ type: "uniform", low: 0, high: 0.1, decimalPlaces: 2 }), 55_000);
    const counts = new Map<number, number>();
    for (const c of cents) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1]);
    for (const n of counts.values()) expect(n / 5000).toBeCloseTo(1, 1);

    const prices = sample(new NumberSamplerGen({ type: "uniform", low: 10, high: 1000, decimalPlaces: 2 }));
    expect(prices.every((p) => p >= 10 && p <= 1000 && decimals(p) <= 2)).toBe(true);
    const heights = sample(new NumberSamplerGen({ type: "gaussian", mean: 170, stddev: 10, decimalPlaces: 1 }));
    expect(heights.every((h) => decimals(h) <= 1)).toBe(true);

    // 0.07 * 100 is 7.000000000000001 in floats; the bound still means 0.07.
    expect(Math.min(...sample(new NumberSamplerGen({ type: "uniform", low: 0.07, high: 0.08, decimalPlaces: 2 }), 200))).toBe(0.07);
    // Bounds between steps are rounded inward.
    expect(new Set(sample(new NumberSamplerGen({ type: "uniform", low: 0.051, high: 0.069, decimalPlaces: 2 }), 200))).toEqual(new Set([0.06]));
    expect(() => new NumberSamplerGen({ type: "uniform", low: 0.051, high: 0.059, decimalPlaces: 2 })).toThrow(/no number with 2 decimal places/);
    expect(() => new NumberSamplerGen({ type: "uniform", low: 0, high: 1e10, decimalPlaces: 8 })).toThrow(/too many digits/);
  });

  it("hit their target statistics", () => {
    const dice = sample(new NumberSamplerGen({ type: "uniform", low: 1, high: 6, integer: true }));
    expect(new Set(dice)).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(mean(dice)).toBeCloseTo(3.5, 1);


    const heights = sample(new NumberSamplerGen({ type: "gaussian", mean: 170, stddev: 10 }));
    expect(mean(heights)).toBeCloseTo(170, 0);
    expect(stddev(heights)).toBeCloseTo(10, 0);

    // Small means use Knuth's method, large ones PTRS. Poisson variance equals its mean.
    for (const m of [3, 250]) {
      const events = sample(new NumberSamplerGen({ type: "poisson", mean: m }));
      expect(mean(events) / m).toBeCloseTo(1, 1);
      expect(stddev(events) ** 2 / m).toBeCloseTo(1, 1);
    }

    const heads = sample(new NumberSamplerGen({ type: "binomial", n: 100, p: 0.3 }));
    expect(mean(heads)).toBeCloseTo(30, 0);

    // 70% of customers spend nothing; the rest spend around 50.
    const spend = sample(
      new NumberSamplerGen({ type: "bernoulli_mixture", p: 0.3, gen: new NumberSamplerGen({ type: "gaussian", mean: 50, stddev: 5 }) }),
    );
    expect(spend.filter((s) => s === 0).length / spend.length).toBeCloseTo(0.7, 1);

    // Bad params fail at construction, naming the Gen.
    expect(() => new NumberSamplerGen({ type: "gaussian", id: "height", mean: 170, stddev: -1 })).toThrow(
      new ConfigError("NumberSamplerGen 'height' (gaussian): stddev must be finite and >= 0, got -1."),
    );
  });
});
