import { describe, expect, it } from "vitest";
import {
  NumberSamplerGen,
  ConfigError,
  Context,
  type Gen,
} from "../src/index";

function sample(gen: Gen<number>, n = 20_000): number[] {
  const ctx = Context.create({ seed: 7 });
  return Array.from({ length: n }, () => gen.generate({}, ctx));
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stddev = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
};

describe("number samplers", () => {
  it("hit their target statistics", () => {
    const dice = sample(new NumberSamplerGen({ type: "uniform", low: 1, high: 6, integer: true }));
    expect(new Set(dice)).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(mean(dice)).toBeCloseTo(3.5, 1);

    const prices = sample(new NumberSamplerGen({ type: "uniform", low: 0, high: 100, decimalPlaces: 2 }));
    expect(Math.min(...prices)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...prices)).toBeLessThanOrEqual(100);
    expect(prices.every((p) => (String(p).split(".")[1] ?? "").length <= 2)).toBe(true);

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
