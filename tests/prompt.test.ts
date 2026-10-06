import { describe, expect, it } from "vitest";
import {
  CategorySamplerGen,
  ConfigError,
  LLMTextGen,
  match,
  MockProvider,
  NumberSamplerGen,
  Plan,
  preview,
  prompt,
  refs,
  refTarget,
  rootRefs,
  showRef,
  SchemaBuilder,
  TreeGen,
  type Infer,
} from "../src/index";

const s = SchemaBuilder;

const Review = s.object({
  ageRange: s.enum(["18-25", "25-50", "50+"]),
  stars: s.integer(),
  product: s.string(),
  complaint: s.string().optional(),
  review: s.string(),
});
type Review = Infer<typeof Review>;

const r = rootRefs(Review);

/** Renders with values given by field name: `{ stars: 1 }` fills `r.stars`. */
const renderWith = (p: ReturnType<typeof prompt>, values: Partial<Review>) =>
  p.render((_key, ref) => values[refTarget(ref)!.path[0] as keyof Review]);

const tone = match({
  inputs: { age: r.ageRange, stars: r.stars },
  cases: [
    { when: ({ stars }) => stars <= 2, then: prompt`Say what went wrong with ${r.product}.` },
    { when: ({ age }) => age === "18-25", then: "Be informal." },
  ],
  otherwise: "Be formal.",
});

describe("match in prompts", () => {
  it("tries cases in order; the first that holds wins, else otherwise", () => {
    const p = prompt`Review ${r.product}. ${tone} Reply with only the review.`;
    expect(renderWith(p, { product: "Mug", stars: 1, ageRange: "18-25" })).toBe("Review Mug. Say what went wrong with Mug. Reply with only the review.");
    expect(renderWith(p, { product: "Mug", stars: 4, ageRange: "18-25" })).toBe("Review Mug. Be informal. Reply with only the review.");
    expect(renderWith(p, { product: "Mug", stars: 4, ageRange: "50+" })).toBe("Review Mug. Be formal. Reply with only the review.");

    // Without otherwise, no match adds nothing: an "if" without "else". Testing one field in every case is a switch.
    const hint = prompt`Analyze the review.`.match({
      inputs: { complaint: r.complaint },
      cases: [{ when: ({ complaint }) => complaint !== undefined, then: prompt` Complaint: ${r.complaint}` }],
    });
    expect(renderWith(hint, {})).toBe("Analyze the review.");
    expect(renderWith(hint, { complaint: "too small" })).toBe("Analyze the review. Complaint: too small");
  });

  it("chains: append and match return new prompts; prompts nest", () => {
    const base = prompt`Review ${r.product}.`;
    const chained = base.match({ inputs: { stars: r.stars }, cases: [{ when: ({ stars }) => stars === 5, then: " Gush." }] }).append(prompt` (${r.stars} stars)`);
    expect(renderWith(chained, { product: "Mug", stars: 5 })).toBe("Review Mug. Gush. (5 stars)");
    expect(renderWith(base, { product: "Mug", stars: 5 })).toBe("Review Mug."); // unchanged
    expect(renderWith(prompt`${base} ${base}`, { product: "Mug" })).toBe("Review Mug. Review Mug.");
  });

  it("the inputs and every branch's fields are the Gen's inputs, so the plan orders it after them", async () => {
    const tree = new TreeGen({
      schema: Review,
      id: "review",
      fields: {
        ageRange: new CategorySamplerGen<Review["ageRange"]>({ values: ["18-25", "25-50", "50+"] }),
        stars: new NumberSamplerGen({ type: "uniform", low: 1, high: 5, integer: true }),
        product: new CategorySamplerGen({ values: ["Mug", "Lamp"] }),
        complaint: new CategorySamplerGen({ values: ["late"] }),
        review: new LLMTextGen({ model: "m", prompt: prompt`Write a review. ${tone}` }),
      },
    });
    // product is read only in a branch, and still an input.
    expect(Plan.compile(tree).toText()).toMatch(/review +<- ageRange, stars, product$/);

    const { records } = await preview({ gen: tree, numRecords: 30, seed: 1, providers: { mock: new MockProvider() }, models: { m: { provider: "mock", model: "echo" } } });
    for (const x of records) {
      const want = x.stars <= 2 ? `Say what went wrong with ${x.product}.` : x.ageRange === "18-25" ? "Be informal." : "Be formal.";
      expect(x.review.endsWith(`Write a review. ${want}`)).toBe(true);
    }
  });

  it("is typed: inputs from the refs; a bad ref or a wrong comparison is a compile error", () => {
    match({
      inputs: { age: r.ageRange },
      // @ts-expect-error ageRange is "18-25" | "25-50" | "50+": "18-24" can never match
      cases: [{ when: ({ age }) => age === "18-24", then: "x" }],
    });
    // @ts-expect-error no field 'stras'
    match({ inputs: { s: r.stras }, cases: [{ when: () => true, then: "x" }] });
    match({
      inputs: { stars: r.stars },
      // @ts-expect-error when must return a boolean
      cases: [{ when: ({ stars }) => stars, then: "x" }],
    });
  });

  it("refs show by their schema's name; same-named schemas still get separate inputs", () => {
    const A = s.object({ city: s.string() }, { name: "place" });
    const B = s.object({ city: s.string() }, { name: "place" });
    expect(showRef(refs(A).city)).toBe("place.city");
    expect(showRef(refs(s.object({ city: s.string() })).city)).toBe("self.city"); // unnamed: the scope
    const p = prompt`${refs(A).city} / ${rootRefs(B).city}`;
    expect(p.refsByKey.size).toBe(2);
    expect(() => s.object({ a: s.string() }, { name: "my place" })).toThrow(/name must be an identifier/);
  });

  it("checks its params at runtime too", () => {
    expect(() => match({ inputs: { x: "stars" as never }, cases: [{ when: () => true, then: "x" }] })).toThrow(/input 'x' must be a ref/);
    expect(() => match({ inputs: { s: r.stars }, cases: [] })).toThrow(ConfigError);
    expect(() => match({ inputs: { s: r.stars }, cases: [{ when: () => true, then: "Hi {{ name }}" }] })).toThrow(/DataDesigner\/Jinja/);
  });
});
