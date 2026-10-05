import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CategorySamplerGen,
  ConditionalRejectionResamplerGen,
  GenerationError,
  NumberSamplerGen,
  previewSync,
  rootRefs,
  s,
  TreeGen,
  type BoundGen,
} from "../src/index";

const Job = s.object({ country: s.string(), occupation: s.string(), bonus: s.number().optional() });

const p = rootRefs(Job);
const occuGen = new CategorySamplerGen({ values: ["doctor", "lawyer", "not_allowed_canada"] });
const country = new CategorySamplerGen({ values: ["Canada", "Japan"] });

describe("ConditionalRejectionResamplerGen", () => {
  it("redraws until accept() says yes, reading other fields", () => {
    const job = new TreeGen({
      schema: Job,
      fields: {
        country,
        occupation: ConditionalRejectionResamplerGen.bound({
          childGen: occuGen,
          inputs: { country: p.country },
          accept: (value, { country }) => !(country === "Canada" && value === "not_allowed_canada"),
        }),
      },
    });
    const { records } = previewSync({ gen: job, numRecords: 500, seed: 1 });
    expect(records.some((r) => r.country === "Canada" && r.occupation === "not_allowed_canada")).toBe(false);
    expect(records.some((r) => r.country === "Japan" && r.occupation === "not_allowed_canada")).toBe(true);

    // Reusable form: annotate the inputs once, bind later.
    const noCanadaOnly = new ConditionalRejectionResamplerGen({
      childGen: occuGen,
      accept: (value, { country }: { country: string }) => !(country === "Canada" && value === "not_allowed_canada"),
    });
    const again = new TreeGen({ schema: Job, fields: { country, occupation: noCanadaOnly.bind({ country: p.country }) } });
    expect(previewSync({ gen: again, numRecords: 500, seed: 1 }).records).toEqual(records);
  });

  it('onExhausted: fail (default), keepLast, or default (defaultValue, "None" unless given)', () => {
    const never = (onExhausted: "fail" | "keepLast" | "default") =>
      new ConditionalRejectionResamplerGen({ childGen: occuGen, accept: () => false, maxAttempts: 3, onExhausted });

    const bonusGen = new NumberSamplerGen({ type: "uniform", low: 0, high: 10, integer: true });
    const fail = new TreeGen({
      schema: Job,
      fields: {
        country,
        occupation: ConditionalRejectionResamplerGen.bound({ childGen: occuGen, inputs: {}, accept: () => false, maxAttempts: 3 }),
      },
    });
    expect(() => previewSync({ gen: fail, numRecords: 1, seed: 1 })).toThrow(GenerationError);
    expect(() => previewSync({ gen: fail, numRecords: 1, seed: 1 })).toThrow(/at occupation: no value accepted in 3 attempts/);

    expect(occuGen.values).toContain(previewSync({ gen: never("keepLast"), numRecords: 1, seed: 1 }).records[0]);

    // default without defaultValue: the text "None", which fits a string field as is.
    const noneJob = new TreeGen({
      schema: Job,
      fields: {
        country,
        occupation: ConditionalRejectionResamplerGen.bound({ childGen: occuGen, inputs: {}, accept: () => false, onExhausted: "default" }),
      },
    });
    expect(previewSync({ gen: noneJob, numRecords: 1, seed: 1 }).records[0]!.occupation).toBe("None");

    // A number field needs its own default: here 0.
    const zeroBonus = ConditionalRejectionResamplerGen.bound({
      childGen: bonusGen,
      inputs: {},
      accept: (bonus) => bonus > 100,
      onExhausted: "default",
      defaultValue: 0,
    });
    expectTypeOf(zeroBonus).toEqualTypeOf<BoundGen<number>>();
    const withBonus = new TreeGen({ schema: Job, fields: { country, occupation: occuGen, bonus: zeroBonus } });
    expect(previewSync({ gen: withBonus, numRecords: 1, seed: 1 }).records[0]!.bonus).toBe(0);

    // Any other default of the values' own type works too.
    const job = new TreeGen({
      schema: Job,
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
    expect(previewSync({ gen: job, numRecords: 1, seed: 1 }).records[0]!.occupation).toBe("unemployed");

    new TreeGen({
      schema: Job,
      fields: {
        country,
        occupation: occuGen,
        // @ts-expect-error bonus is a number; falling back to "None" gives number | "None".
        bonus: ConditionalRejectionResamplerGen.bound({ childGen: bonusGen, inputs: {}, accept: () => true, onExhausted: "default" }),
      },
    });

    new TreeGen({
      schema: Job,
      fields: {
        country,
        occupation: occuGen,
        // @ts-expect-error the same for the constructor form: the "None" default is not hidden by the field's type.
        bonus: new ConditionalRejectionResamplerGen({ childGen: bonusGen, accept: () => true, onExhausted: "default" }),
      },
    });

    expect(() => new ConditionalRejectionResamplerGen({ childGen: occuGen, accept: () => true, defaultValue: "x" })).toThrow(
      /defaultValue only applies with onExhausted: "default"/,
    );
  });
});
