import { describe, expect, expectTypeOf, it } from "vitest";
import { ConfigError, CustomGen, FunctionGen, mapRows, mapTree, NumberSamplerGen, previewSync, rootRefs, SchemaBuilder } from "../src/index";

const s = SchemaBuilder;
const Bug = s.object({ id: s.string(), title: s.string(), severity: s.enum(["low", "high"]) });
const bugs = [
  { id: "B1", title: "Cart empties", severity: "high" as const, extra: "dropped" },
  { id: "B2", title: "Typo on home page", severity: "low" as const, extra: "dropped" },
  { id: "B3", title: "Login loops", severity: "high" as const, extra: "dropped" },
];

describe("mapRows", () => {
  it("makes one row per source row, in order, in a new shape", async () => {
    const Summary = s.object({ bug: Bug.temp(), line: s.string(), urgent: s.boolean(), n: s.integer() });
    const r = rootRefs(Summary);
    const { records, nextIndex } = await mapRows({
      schema: Summary,
      as: "bug",
      rows: bugs,
      fields: {
        line: FunctionGen.bound({ inputs: { id: r.bug.id, title: r.bug.title }, fn: ({ id, title }) => `${id}: ${title}` }),
        urgent: FunctionGen.bound({ inputs: { severity: r.bug.severity }, fn: ({ severity }) => severity === "high" }),
        n: new NumberSamplerGen({ type: "uniform", low: 0, high: 9, integer: true }),
      },
      seed: 1,
      startIndex: 50,
    });
    expect(records.map(({ line, urgent }) => ({ line, urgent }))).toEqual([
      { line: "B1: Cart empties", urgent: true },
      { line: "B2: Typo on home page", urgent: false },
      { line: "B3: Login loops", urgent: true },
    ]);
    expect(nextIndex).toBe(53);
    expectTypeOf(records[0]!).toEqualTypeOf<{ line: string; urgent: boolean; n: number }>(); // bug is temp
  });

  it("the same shape: each row a changed copy of its source row", () => {
    const Fixed = s.object({ src: Bug.temp(), id: s.string(), title: s.string(), severity: s.enum(["low", "high"]) });
    const r = rootRefs(Fixed);
    const tree = mapTree({
      schema: Fixed,
      as: "src",
      rows: bugs,
      fields: {
        id: FunctionGen.bound({ inputs: { id: r.src.id }, fn: ({ id }) => id }),
        title: FunctionGen.bound({ inputs: { t: r.src.title }, fn: ({ t }) => t.toUpperCase() }),
        severity: CustomGen.bound({ inputs: {}, fn: () => "low" as const }),
      },
    });
    const { records } = previewSync({ gen: tree, numRecords: bugs.length, seed: 1 });
    expect(records).toEqual([
      { id: "B1", title: "CART EMPTIES", severity: "low" },
      { id: "B2", title: "TYPO ON HOME PAGE", severity: "low" },
      { id: "B3", title: "LOGIN LOOPS", severity: "low" },
    ]);
  });

  it("type and config errors", () => {
    const Summary = s.object({ bug: Bug.temp(), line: s.string() });
    const line = CustomGen.bound({ inputs: {}, fn: () => "x" });
    // Compile errors, and at runtime the tree's own checks.
    // @ts-expect-error rows must fit the `as` field's schema
    const partial = mapTree({ schema: Summary, as: "bug", rows: [{ id: "B1" }], fields: { line } });
    expect(() => previewSync({ gen: partial, numRecords: 1 })).toThrow(/bug.title: missing/); // checked as records are made
    // @ts-expect-error `as` must be a field of the schema
    expect(() => mapTree({ schema: Summary, as: "nope", rows: bugs, fields: { line } })).toThrow(/'nope' is not in the schema/);
    // @ts-expect-error every other field needs a Gen
    expect(() => mapTree({ schema: Summary, as: "bug", rows: bugs, fields: {} })).toThrow(/missing fields: line/);
    expect(() => mapTree({ schema: Summary, as: "bug", rows: bugs, fields: { line, bug: line } as never })).toThrow(ConfigError);
    expect(() => mapTree({ schema: Summary, as: "bug", rows: [], fields: { line } })).toThrow(/rows must be a non-empty array/);
  });
});
