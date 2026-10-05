import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CategorySamplerGen,
  ConfigError,
  LLMTextGen,
  MatchGen,
  MockProvider,
  NumberSamplerGen,
  Plan,
  preview,
  previewSync,
  prompt,
  rootRefs,
  SubCategorySamplerGen,
  s,
  TreeGen,
} from "../src/index";

const Review = s.object({
  ageRange: s.string(),
  stars: s.integer(),
  category: s.string(),
  style: s.string(),
  item: s.string(),
  complaint: s.string().optional(),
});

const r = rootRefs(Review);
const styleGen = new CategorySamplerGen({ values: { rambling: 1, brief: 2, detailed: 2 } });

const base = {
  ageRange: new CategorySamplerGen({ values: ["18-25", "25-50", "50+"] }),
  stars: new NumberSamplerGen({ type: "uniform", low: 1, high: 5, integer: true }),
  category: new CategorySamplerGen({ values: ["Books", "Clothing"] }),
  // DataDesigner's conditional params: rambling for 18-25, else the usual sample.
  style: new MatchGen({
    inputs: { age: r.ageRange },
    cases: [{ when: ({ age }) => age === "18-25", then: "rambling" }],
    otherwise: styleGen,
  }),
  // A bound Gen as a branch: it reads a field of its own (category).
  item: new MatchGen({
    inputs: { stars: r.stars },
    cases: [{ when: ({ stars }) => stars === 5, then: "the best thing ever" }],
    otherwise: new SubCategorySamplerGen({ values: { Books: ["a novel", "a cookbook"], Clothing: ["a coat", "a hat"] } }).bind({
      category: r.category,
    }),
  }),
};

describe("MatchGen", () => {
  it("first case that holds wins, else otherwise; branches can be values, Gens or bound Gens", () => {
    const tree = new TreeGen({ schema: Review, id: "review", fields: base });
    const { records } = previewSync({ gen: tree, numRecords: 300, seed: 1 });
    for (const x of records) {
      if (x.ageRange === "18-25") expect(x.style).toBe("rambling");
      else expect(["rambling", "brief", "detailed"]).toContain(x.style);
      if (x.stars === 5) expect(x.item).toBe("the best thing ever");
      else expect(x.category === "Books" ? ["a novel", "a cookbook"] : ["a coat", "a hat"]).toContain(x.item);
      expect(x.complaint).toBeUndefined();
    }
    expect(new Set(records.filter((x) => x.ageRange !== "18-25").map((x) => x.style)).size).toBe(3);
    // The branch's field is an input too, so the plan orders item after category.
    expect(Plan.compile(tree).toText()).toMatch(/item +<- stars, otherwise\.category=category$/m);
  });

  it("without otherwise, skips: undefined, and only matching rows run the branch (e.g. call the LLM)", async () => {
    const mock = new MockProvider();
    const tree = new TreeGen({
      schema: Review,
      id: "review",
      fields: {
        ...base,
        complaint: new MatchGen({
          inputs: { stars: r.stars },
          cases: [{ when: ({ stars }) => stars <= 2, then: new LLMTextGen({ model: "m", prompt: prompt`Why only ${r.stars} stars for ${r.item}?` }) }],
        }),
      },
    });
    expect(Plan.compile(tree).toText()).toMatch(/complaint +<- stars, case1\.stars=stars, case1\.item=item$/);
    const { records } = await preview({ gen: tree, numRecords: 40, seed: 2, providers: { mock }, models: { m: { provider: "mock", model: "echo" } } });
    const unhappy = records.filter((x) => x.stars <= 2);
    expect(mock.requests).toHaveLength(unhappy.length);
    for (const x of records) {
      if (x.stars <= 2) expect(x.complaint).toMatch(new RegExp(`Why only ${x.stars} stars for ${x.item}\\?$`));
      else expect(x.complaint).toBeUndefined();
    }

    // An unknown model in a branch fails before any call.
    const typo = new TreeGen({
      schema: Review.pick("stars", "complaint"),
      fields: {
        stars: base.stars,
        complaint: new MatchGen({ inputs: { stars: r.stars }, cases: [{ when: () => true, then: new LLMTextGen({ model: "nope", prompt: "Hi" }) }] }),
      },
    });
    await expect(preview({ gen: typo, numRecords: 1, providers: { mock }, models: { m: { provider: "mock", model: "echo" } } })).rejects.toThrow(
      "field 'complaint': unknown model 'nope'",
    );
  });

  it("each branch has its own random stream: changing one branch leaves the others' values alone", () => {
    const noisy = (otherwise: CategorySamplerGen) =>
      new TreeGen({
        schema: Review.pick("stars", "item"),
        fields: {
          stars: base.stars,
          item: new MatchGen({
            inputs: { stars: r.stars },
            cases: [{ when: ({ stars }) => stars >= 4, then: new CategorySamplerGen({ values: ["a", "b", "c", "d"] }) }],
            otherwise,
          }),
        },
      });
    const one = previewSync({ gen: noisy(new CategorySamplerGen({ values: ["x", "y"] })), numRecords: 100, seed: 3 }).records;
    const two = previewSync({ gen: noisy(new CategorySamplerGen({ values: ["p", "q", "r"] })), numRecords: 100, seed: 3 }).records;
    expect(two.filter((x) => x.stars >= 4)).toEqual(one.filter((x) => x.stars >= 4));
  });

  it("is typed: the union of the branches, plus undefined without otherwise", () => {
    const skip = new MatchGen({ inputs: { s: r.stars }, cases: [{ when: ({ s }) => s < 3, then: styleGen }] });
    expectTypeOf(skip).toEqualTypeOf<MatchGen<string | undefined>>();
    const withDefault = new MatchGen({ inputs: { s: r.stars }, cases: [{ when: ({ s }) => s < 3, then: styleGen }], otherwise: "None" });
    expectTypeOf(withDefault).toEqualTypeOf<MatchGen<string>>();

    new TreeGen({
      schema: Review.pick("stars", "style"),
      // @ts-expect-error style is a required string, and without otherwise the value can be undefined
      fields: { stars: base.stars, style: skip },
    });
    new TreeGen({ schema: Review.pick("stars", "style"), fields: { stars: base.stars, style: withDefault } });

    // @ts-expect-error stars is a number: comparing it to a string can never hold
    new MatchGen({ inputs: { s: r.stars }, cases: [{ when: ({ s }) => s === "5", then: "x" }] });
  });

  it("checks its params", () => {
    const needsInput = new SubCategorySamplerGen({ values: { Books: ["a novel"] } });
    expect(() => new MatchGen({ inputs: { s: r.stars }, cases: [] })).toThrow(ConfigError);
    expect(() => new MatchGen({ inputs: { s: "stars" as never }, cases: [{ when: () => true, then: 1 }] })).toThrow(/input 's' must be a ref/);
    expect(() => new MatchGen({ inputs: { s: r.stars }, cases: [{ when: () => true, then: new TreeGen({ schema: s.object({ a: s.integer() }), fields: { a: base.stars } }) }] })).toThrow(
      /a TreeGen cannot be a branch/,
    );
    expect(() => new MatchGen({ inputs: { s: r.stars }, cases: [{ when: () => true, then: 1 }], otherwise: needsInput as never })).toThrow(/otherwise needs inputs \(category\) but is not bound/);
  });
});
