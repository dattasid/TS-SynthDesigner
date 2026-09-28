import { describe, expect, it } from "vitest";
import { MersenneTwister } from "../src/index";

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
