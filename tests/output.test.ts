import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CategorySamplerGen,
  ConstantGen,
  create,
  FunctionGen,
  GenerationError,
  NumberSamplerGen,
  previewSync,
  refs,
  rootRefs,
  SchemaBuilder,
  TreeGen,
} from "../src/index";

const s = SchemaBuilder;

const Customer = s.object({ name: s.string(), secret: s.string().temp() }, { name: "customer" });
const Zone = s.object({ label: s.string(), seed: s.integer().temp() });
const Review = s.object(
  {
    customer: Customer,
    scratch: s.integer().temp(), // generated, read by summary, dropped
    zones: s.array(Zone),
    summary: s.string(),
  },
  { name: "review" },
);

const r = rootRefs(Review);
const c = refs(Customer);
const zones = [
  { label: "north", seed: 1 },
  { label: "south", seed: 2 },
];
const review = new TreeGen({
  schema: Review,
  fields: {
    customer: new TreeGen({
      schema: Customer,
      fields: {
        secret: new CategorySamplerGen({ values: ["s1", "s2"] }),
        name: FunctionGen.bound({ inputs: { secret: c.secret }, fn: ({ secret }) => `Ada (${secret})` }),
      },
    }),
    scratch: new NumberSamplerGen({ type: "uniform", low: 1, high: 9, integer: true }),
    zones: new ConstantGen({ value: zones }),
    summary: FunctionGen.bound({
      inputs: { n: r.scratch, secret: r.customer.secret, first: r.zones },
      fn: ({ n, secret, first }) => `${n}/${secret}/${first[0]!.seed}`,
    }),
  },
});

describe("records on their way out", () => {
  it("temp fields are generated and readable by refs, then dropped at every depth", () => {
    const { records } = previewSync({ gen: review, numRecords: 5, seed: 1 });
    expectTypeOf(records[0]!).toEqualTypeOf<{ customer: { name: string }; zones: { label: string }[]; summary: string }>();
    for (const x of records) {
      expect(Object.keys(x)).toEqual(["customer", "zones", "summary"]);
      expect(Object.keys(x.customer)).toEqual(["name"]);
      expect(x.zones).toEqual([{ label: "north" }, { label: "south" }]);
      expect(x.summary).toMatch(/^\d\/s[12]\/1$/); // the temps were there when summary was made
      expect(x.customer.name).toMatch(/^Ada \(s[12]\)$/);
    }
    // The shared, frozen constant is copied, not changed.
    expect((review.fields.zones as ConstantGen<typeof zones>).value).toEqual(zones);
  });

  it("every record is checked against the schema, catching what types cannot", () => {
    const Rating = s.object({ stars: s.integer({ min: 1, max: 5 }), note: s.string() });
    const wrongRange = new TreeGen({
      schema: Rating,
      fields: {
        stars: new NumberSamplerGen({ type: "uniform", low: 1, high: 10, integer: true }), // a number: types are fine
        note: new CategorySamplerGen({ values: ["ok"] }),
      },
    });
    expect(() => previewSync({ gen: wrongRange, numRecords: 50, seed: 1 })).toThrow(GenerationError);
    expect(() => previewSync({ gen: wrongRange, numRecords: 50, seed: 1 })).toThrow(
      /^record \d+ does not fit the schema: stars: expected an integer from 1 to 5, got \d+\.$/,
    );

    // A function that lies about its type (a cast, or plain JavaScript) is caught too.
    const lying = new TreeGen({
      schema: Rating,
      fields: { stars: FunctionGen.bound({ inputs: {}, fn: () => 3.5 }), note: FunctionGen.bound({ inputs: {}, fn: () => undefined as unknown as string }) },
    });
    expect(() => previewSync({ gen: lying, numRecords: 1 })).toThrow(
      "record 0 does not fit the schema: stars: expected an integer from 1 to 5, got 3.5; note: expected a string, got undefined.",
    );
  });

  it("create checks and drops the same way; validate: false skips the check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "output-test-"));
    const path = join(dir, "reviews.jsonl");
    await create({ gen: review, numRecords: 3, seed: 1, path });
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual(previewSync({ gen: review, numRecords: 3, seed: 1 }).records);

    const Loose = s.object({ n: s.integer({ max: 0 }) });
    const tooBig = new TreeGen({ schema: Loose, fields: { n: new NumberSamplerGen({ type: "uniform", low: 1, high: 2, integer: true }) } });
    await expect(create({ gen: tooBig, numRecords: 2, path, overwrite: true })).rejects.toThrow(/record 0 does not fit the schema/);
    await create({ gen: tooBig, numRecords: 2, path, overwrite: true, validate: false });
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("a Gen that is not a tree passes through", () => {
    const { records } = previewSync({ gen: new CategorySamplerGen({ values: ["a"] }), numRecords: 2 });
    expectTypeOf(records).toEqualTypeOf<string[]>();
    expect(records).toEqual(["a", "a"]);
  });
});
