import { describe, expect, it } from "vitest";
import { ConfigError, previewSync, SchemaBuilder, TreeGen, UniqueIdGen } from "../src/index";

const s = SchemaBuilder;
const Row = s.object({ id: s.string() });
const ids = (gen: UniqueIdGen, numRecords: number, { seed = 1, startIndex = 0 } = {}) =>
  previewSync({ gen: new TreeGen({ schema: Row, fields: { id: gen } }), numRecords, seed, startIndex }).records.map((r) => r.id);

describe("UniqueIdGen", () => {
  it("maps every row index to its own code, out of order", () => {
    // 2 ** 4 = 16 codes: the first 16 rows get all of them; row 16 has none left.
    const tiny = new UniqueIdGen({ alphabet: "01", length: 4 });
    const all = ids(tiny, 16);
    expect(new Set(all).size).toBe(16);
    expect(all.every((id) => /^[01]{4}$/.test(id))).toBe(true);
    expect(all).not.toEqual([...all].sort());
    expect(() => ids(tiny, 17)).toThrow(/row 16 is past the last id/);

    // 3 ** 3 = 27 is not a square: cycle-walking keeps the codes in range.
    expect(new Set(ids(new UniqueIdGen({ alphabet: "abc", length: 3 }), 27)).size).toBe(27);

    const bug = ids(new UniqueIdGen({ prefix: "BUG-", length: 5 }), 5000);
    expect(new Set(bug).size).toBe(5000);
    expect(bug.every((id) => /^BUG-[0-9A-HJ-NP-Z]{5}$/.test(id))).toBe(true);
  });

  it("joined runs never collide; the seed (or key) picks the permutation", () => {
    const gen = new UniqueIdGen({ length: 3 });
    const whole = ids(gen, 30);
    expect([...ids(gen, 10), ...ids(gen, 20, { startIndex: 10 })]).toEqual(whole);
    expect(ids(gen, 30, { seed: 2 })).not.toEqual(whole);
    const keyed = new UniqueIdGen({ length: 3, key: 7 });
    expect(ids(keyed, 30, { seed: 2 })).toEqual(ids(keyed, 30, { seed: 3 }));
  });

  it("checks its params", () => {
    expect(() => new UniqueIdGen({ length: 0 })).toThrow(ConfigError);
    expect(() => new UniqueIdGen({ alphabet: "aa" })).toThrow(/repeated character/);
    expect(() => new UniqueIdGen({ alphabet: "a" })).toThrow(/at least 2/);
    expect(() => new UniqueIdGen({ length: 20 })).toThrow(/at most 2 \*\* 52/);
  });
});
