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
  bonus?: number | null;
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

  it("onExhausted: fail (default), keepLast, or default (defaultValue, null unless given)", () => {
    const never = (onExhausted: "fail" | "keepLast" | "default") =>
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

    // default without defaultValue: null, and the type says so.
    const nullBonus = ConditionalRejectionResamplerGen.bound({
      childGen: bonusGen,
      inputs: {},
      accept: (bonus) => bonus > 100,
      onExhausted: "default",
    });
    expectTypeOf(nullBonus).toEqualTypeOf<BoundGen<number | null>>();
    const withBonus = new TreeGen<Job>({
      fields: { country, occupation: occuGen, bonus: nullBonus }, // bonus allows null
    });
    expect(preview({ gen: withBonus, numRecords: 1, seed: 1 }).records[0]!.bonus).toBeNull();

    // A default of the values' own type keeps the type: it fits a required string field.
    const job = new TreeGen<Job>({
      fields: {
        country,
        occupation: ConditionalRejectionResamplerGen.bound({
          childGen: occuGen,
          inputs: {},
          accept: () => false,
          onExhausted: "default",
          defaultValue: "unemployed",
        }),
      },
    });
    expect(preview({ gen: job, numRecords: 1, seed: 1 }).records[0]!.occupation).toBe("unemployed");

    new TreeGen<Job>({
      fields: {
        country,
        // @ts-expect-error occupation is a required string; falling back to null gives string | null.
        occupation: ConditionalRejectionResamplerGen.bound({ childGen: occuGen, inputs: {}, accept: () => true, onExhausted: "default" }),
      },
    });

    new TreeGen<Job>({
      fields: {
        country,
        // @ts-expect-error the same for the constructor form: the null default is not hidden by the field's type.
        occupation: new ConditionalRejectionResamplerGen({ childGen: occuGen, accept: () => true, onExhausted: "default" }),
      },
    });

    expect(() => new ConditionalRejectionResamplerGen({ childGen: occuGen, accept: () => true, defaultValue: "x" })).toThrow(
      /defaultValue only applies with onExhausted: "default"/,
    );
  });
});
