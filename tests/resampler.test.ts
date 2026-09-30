import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CategorySamplerGen,
  ConditionalRejectionResamplerGen,
  GenerationError,
  NumberSamplerGen,
  preview,
  rootRefs,
  TreeGen,
  type BoundGen,
} from "../src/index";

interface Job {
  country: string;
  occupation: string;
  bonus?: number;
}

const p = rootRefs<Job>();
const occuGen = new CategorySamplerGen({ values: ["doctor", "lawyer", "not_allowed_canada"] });
const country = new CategorySamplerGen({ values: ["Canada", "Japan"] });

describe("ConditionalRejectionResamplerGen", () => {
  it("redraws until accept() says yes, reading other fields", () => {
    const job = new TreeGen<Job>({
      fields: {
        country,
        occupation: ConditionalRejectionResamplerGen.bound({
          childGen: occuGen,
          inputs: { country: p.country },
          accept: (value, { country }) => !(country === "Canada" && value === "not_allowed_canada"),
        }),
      },
    });
    const { records } = preview({ gen: job, numRecords: 500, seed: 1 });
    expect(records.some((r) => r.country === "Canada" && r.occupation === "not_allowed_canada")).toBe(false);
    expect(records.some((r) => r.country === "Japan" && r.occupation === "not_allowed_canada")).toBe(true);

    // Reusable form: annotate the inputs once, bind later.
    const noCanadaOnly = new ConditionalRejectionResamplerGen({
      childGen: occuGen,
      accept: (value, { country }: { country: string }) => !(country === "Canada" && value === "not_allowed_canada"),
    });
    const again = new TreeGen<Job>({ fields: { country, occupation: noCanadaOnly.bind({ country: p.country }) } });
    expect(preview({ gen: again, numRecords: 500, seed: 1 }).records).toEqual(records);
  });

  it("onExhausted: fail (default), keepLast, or skip (undefined)", () => {
    const never = (onExhausted: "fail" | "keepLast" | "skip") =>
      new ConditionalRejectionResamplerGen({ childGen: occuGen, accept: () => false, maxAttempts: 3, onExhausted });

    const bonusGen = new NumberSamplerGen({ type: "uniform", low: 0, high: 10, integer: true });
    const fail = new TreeGen<Job>({
      fields: {
        country,
        occupation: ConditionalRejectionResamplerGen.bound({ childGen: occuGen, inputs: {}, accept: () => false, maxAttempts: 3 }),
      },
    });
    expect(() => preview({ gen: fail, numRecords: 1, seed: 1 })).toThrow(GenerationError);
    expect(() => preview({ gen: fail, numRecords: 1, seed: 1 })).toThrow(/at occupation: no value accepted in 3 attempts/);

    expect(occuGen.values).toContain(preview({ gen: never("keepLast"), numRecords: 1, seed: 1 }).records[0]);

    // skip: the value is undefined, and the type says so.
    const skipBonus = ConditionalRejectionResamplerGen.bound({
      childGen: bonusGen,
      inputs: {},
      accept: (bonus) => bonus > 100,
      onExhausted: "skip",
    });
    expectTypeOf(skipBonus).toEqualTypeOf<BoundGen<number | undefined>>();
    const withBonus = new TreeGen<Job>({
      fields: { country, occupation: occuGen, bonus: skipBonus }, // bonus is optional, so undefined fits
    });
    expect(preview({ gen: withBonus, numRecords: 1, seed: 1 }).records[0]!.bonus).toBeUndefined();

    new TreeGen<Job>({
      fields: {
        country,
        // @ts-expect-error occupation is a required string; a Gen that may skip gives string | undefined.
        occupation: ConditionalRejectionResamplerGen.bound({ childGen: occuGen, inputs: {}, accept: () => true, onExhausted: "skip" }),
      },
    });
  });
});
