import { describe, expect, it } from "vitest";
import { MersenneTwister, Sfc32 } from "../src/index";

describe("MersenneTwister", () => {
  it("matches the reference MT19937 outputs, and forks are stable", () => {
    // mt19937ar.c with init_genrand(5489), the standard default seed.
    const bySeed = new MersenneTwister(5489);
    expect([1, 2, 3, 4, 5].map(() => bySeed.nextUint32())).toEqual([
      3499211612, 581869302, 3890346734, 3586334585, 545404204,
    ]);

    // mt19937ar.c with init_by_array({0x123, 0x234, 0x345, 0x456}), the published mt19937ar.out.
    const byArray = new MersenneTwister([0x123, 0x234, 0x345, 0x456]);
    expect([1, 2, 3, 4, 5].map(() => byArray.nextUint32())).toEqual([
      1067595299, 955945823, 477289528, 4107218783, 4228976476,
    ]);

    // A fork depends only on the seed and the label, not on how much the parent has drawn.
    const fresh = new MersenneTwister(42);
    const used = new MersenneTwister(42);
    for (let i = 0; i < 1000; i++) used.random();
    expect(used.fork("age").random()).toBe(fresh.fork("age").random());
    expect(fresh.fork("age").random()).not.toBe(fresh.fork("name").random());
  });
});

describe("Sfc32", () => {
  it("is fixed by its key, and row streams differ", () => {
    const draws = (rng: Sfc32) => [1, 2, 3].map(() => rng.nextUint32());
    expect(draws(new Sfc32([7, 8]))).toEqual(draws(new Sfc32([7, 8])));
    expect(draws(Sfc32.forRow([7], 0))).not.toEqual(draws(Sfc32.forRow([7], 1)));
    expect(draws(Sfc32.forRow([7], 1))).not.toEqual(draws(Sfc32.forRow([8], 1)));
    expect(draws(Sfc32.forRow([7], 1))).not.toEqual(draws(Sfc32.forRow([7], 2 ** 32 + 1))); // the high word counts
    expect(new Sfc32([1]).fork("a").random()).toBe(new Sfc32([1]).fork("a").random());
    // Rough uniformity: the first draw of 10000 row streams.
    let sum = 0;
    for (let i = 0; i < 10000; i++) sum += Sfc32.forRow([42], i).random();
    expect(sum / 10000).toBeCloseTo(0.5, 1);
    expect(() => new Sfc32([])).toThrow(RangeError);
  });
});
