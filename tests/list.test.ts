import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CategorySamplerGen,
  ConfigError,
  CustomGen,
  FunctionGen,
  ListGen,
  LLMTextGen,
  MockProvider,
  NumberSamplerGen,
  preview,
  previewSync,
  prompt,
  refs,
  rootRefs,
  SchemaBuilder,
  TreeGen,
  UniqueIdGen,
  type Infer,
  type ListCount,
} from "../src/index";

const s = SchemaBuilder;
const Tag = s.enum(["brave", "sly", "kind", "grim"]);

const Race = s.object({ name: s.string(), traits: s.array(Tag) });
const raceGen = (count: ListCount) =>
  new TreeGen({
    schema: Race,
    fields: {
      name: new CategorySamplerGen({ values: ["Ashkin", "Veyl", "Durrow"] }),
      traits: new ListGen({ item: new CategorySamplerGen<Infer<typeof Tag>>({ values: ["brave", "sly", "kind", "grim"] }), count }),
    },
  });

describe("ListGen", () => {
  it("makes a list of any Gen's values, of a fixed or drawn length", () => {
    const fixed = previewSync({ gen: raceGen(3), numRecords: 20, seed: 1 }).records;
    expect(fixed.every((r) => r.traits.length === 3)).toBe(true);
    expectTypeOf(fixed[0]!.traits).toEqualTypeOf<("brave" | "sly" | "kind" | "grim")[]>();

    const drawn = previewSync({ gen: raceGen({ min: 0, max: 4 }), numRecords: 200, seed: 1 }).records;
    expect(new Set(drawn.map((r) => r.traits.length))).toEqual(new Set([0, 1, 2, 3, 4]));

    const poisson = previewSync({ gen: raceGen(new NumberSamplerGen({ type: "poisson", mean: 2 })), numRecords: 50, seed: 1 }).records;
    expect(poisson.some((r) => r.traits.length !== poisson[0]!.traits.length)).toBe(true);
  });

  it("each item has its own stream: items do not depend on the list's length, rows on the other rows", () => {
    const three = previewSync({ gen: raceGen(3), numRecords: 10, seed: 7 }).records;
    const five = previewSync({ gen: raceGen(5), numRecords: 10, seed: 7 }).records;
    for (let i = 0; i < 10; i++) {
      expect(five[i]!.traits.slice(0, 3)).toEqual(three[i]!.traits);
      expect(five[i]!.name).toBe(three[i]!.name);
    }
    expect(new Set(five.map((r) => r.traits.join())).size).toBeGreaterThan(5); // items vary, not one stream per row
    const alone = previewSync({ gen: raceGen(5), numRecords: 1, seed: 7, startIndex: 6 }).records[0];
    expect(alone).toEqual(five[6]);
  });

  it("item trees read the list's inputs through `as`, and see ctx.item", () => {
    const Landmark = s.object({
      zone: s.object({ name: s.string(), level: s.integer() }).temp(),
      label: s.string(),
      danger: s.integer(),
    });
    const l = refs(Landmark);
    const landmark = ListGen.itemTree({
      schema: Landmark,
      as: "zone",
      fields: {
        label: FunctionGen.bound({ inputs: { zone: l.zone.name }, fn: ({ zone }, ctx) => `${zone} #${ctx.item.index + 1} of ${ctx.item.count}` }),
        danger: FunctionGen.bound({ inputs: { level: l.zone.level }, fn: ({ level }, ctx) => level + ctx.rng.int(0, 2) }),
      },
    });
    const Zone = s.object({ name: s.string(), level: s.integer(), landmarks: s.array(Landmark) });
    const z = refs(Zone);
    const zone = new TreeGen({
      schema: Zone,
      fields: {
        name: new CategorySamplerGen({ values: ["Mirefen", "Cinder Reach"] }),
        level: new NumberSamplerGen({ type: "uniform", low: 1, high: 60, integer: true }),
        landmarks: ListGen.bound({ item: landmark, count: 2, inputs: { name: z.name, level: z.level } }),
      },
    });
    const { records } = previewSync({ gen: zone, numRecords: 10, seed: 1 });
    for (const r of records) {
      expect(r.landmarks.map((x) => x.label)).toEqual([`${r.name} #1 of 2`, `${r.name} #2 of 2`]);
      for (const x of r.landmarks) {
        expect(x.danger - r.level).toBeGreaterThanOrEqual(0);
        expect(x.danger - r.level).toBeLessThanOrEqual(2);
        expect(x).not.toHaveProperty("zone"); // temp
      }
    }
    expectTypeOf(records[0]!.landmarks[0]!).toEqualTypeOf<{ label: string; danger: number }>();

    // A clone is still an item tree.
    const plain = landmark.clone({ fields: { danger: new CustomGen({ fn: () => 0 }) } });
    const again = previewSync({ gen: zone.clone({ fields: { landmarks: ListGen.bound({ item: plain, count: 1, inputs: { name: z.name, level: z.level } }) } }), numRecords: 3, seed: 1 });
    expect(again.records.map((r) => r.landmarks)).toEqual(records.slice(0, 3).map((r) => [{ label: `${r.name} #1 of 1`, danger: 0 }]));
  });

  it("nested lists, and LLM items called in parallel", async () => {
    const Npc = s.object({ place: s.object({ town: s.string() }).temp(), role: s.string(), bio: s.string() });
    const n = refs(Npc);
    const npc = ListGen.itemTree({
      schema: Npc,
      as: "place",
      fields: {
        role: new CategorySamplerGen({ values: ["smith", "priest", "guard"] }),
        bio: new LLMTextGen({ model: "m", prompt: prompt`A ${n.role} of ${n.place.town}.` }),
      },
    });
    const Town = s.object({ region: s.object({ name: s.string() }).temp(), town: s.string(), npcs: s.array(Npc) });
    const t = refs(Town);
    const town = ListGen.itemTree({
      schema: Town,
      as: "region",
      fields: {
        town: FunctionGen.bound({ inputs: { region: t.region.name }, fn: ({ region }, ctx) => `${region} town ${ctx.item.index}` }),
        npcs: ListGen.bound({ item: npc, count: { min: 1, max: 3 }, inputs: { town: t.town } }),
      },
    });
    const Region = s.object({ name: s.string(), towns: s.array(Town) });
    const r = rootRefs(Region);
    const region = new TreeGen({
      schema: Region,
      fields: {
        name: new CategorySamplerGen({ values: ["North", "South"] }),
        towns: ListGen.bound({ item: town, count: 2, inputs: { name: r.name } }),
      },
    });
    const mock = new MockProvider({ latencyMs: [1, 5] });
    const run = () => preview({ gen: region, numRecords: 3, seed: 3, providers: { mock }, models: { m: { provider: "mock", model: "echo" } } });
    const { records } = await run();
    for (const x of records) {
      expect(x.towns.map((t) => t.town)).toEqual([`${x.name} town 0`, `${x.name} town 1`]);
      for (const t of x.towns) for (const p of t.npcs) expect(p.bio).toMatch(new RegExp(`A ${p.role} of ${t.town}\\.$`));
    }
    const calls = records.flatMap((x) => x.towns.flatMap((t) => t.npcs)).length;
    expect(mock.requests.length).toBe(calls);
    expect(mock.maxInFlight).toBe(calls); // every row's items at once
    expect((await run()).records).toEqual(records);
  });

  it("config errors", () => {
    const Item = s.object({ p: s.object({ x: s.string() }).temp(), y: s.string() });
    const i = refs(Item);
    const fields = { y: FunctionGen.bound({ inputs: { x: i.p.x }, fn: ({ x }) => x }) };
    const item = ListGen.itemTree({ schema: Item, as: "p", fields });
    const Holder = s.object({ x: s.string(), n: s.integer(), list: s.array(Item) });
    const h = refs(Holder);
    const x = new CategorySamplerGen({ values: ["a"] });

    // @ts-expect-error the inputs must be bound
    expect(() => new TreeGen({ schema: Holder, fields: { x, n: x as never, list: new ListGen({ item, count: 1 }) } })).toThrow(/needs inputs \(x\)/);
    // @ts-expect-error the refs must fit the inputs' types
    ListGen.bound({ item, count: 1, inputs: { x: h.n } });
    expect(() => ListGen.bound({ item, count: 1, inputs: {} as never })).toThrow(/missing inputs: x/);
    expect(() => ListGen.itemTree({ schema: Item, as: "p", fields: { ...fields, p: x } as never })).toThrow(/'p' gets the list's inputs/);
    expect(() => ListGen.itemTree({ schema: Item, as: "y", fields: {} as never })).toThrow(/must be an object field/);
    for (const count of [-1, 1.5, { min: 3, max: 2 }, { min: -1, max: 2 }, undefined]) {
      expect(() => new ListGen({ item: x, count: count as never })).toThrow(ConfigError);
    }
    expect(() => new ListGen({ item: x, count: FunctionGen.bound({ inputs: { n: h.n }, fn: ({ n }) => n }) as never })).toThrow(/count Gen must not need inputs/);
    expect(() => new ListGen({ item: FunctionGen.bound({ inputs: { x: h.x }, fn: ({ x }) => x }), count: 1 })).toThrow(/item: A bound Gen reads other fields/);

    const bad = (count: unknown) => new TreeGen({ schema: s.object({ l: s.array(s.string()) }), fields: { l: new ListGen({ item: x, count: new CustomGen({ fn: () => count as number }) }) } });
    expect(() => previewSync({ gen: bad(-2), numRecords: 1 })).toThrow(/the count Gen gave -2/);

    const ids = new TreeGen({ schema: s.object({ l: s.array(s.string()) }), fields: { l: new ListGen({ item: new UniqueIdGen(), count: 2 }) } });
    expect(() => previewSync({ gen: ids, numRecords: 1 })).toThrow(/would all get the same id/);
    const outside = new TreeGen({ schema: s.object({ v: s.integer() }), fields: { v: new CustomGen({ fn: (_: {}, ctx) => ctx.item.index }) } });
    expect(() => previewSync({ gen: outside, numRecords: 1 })).toThrow(/ctx.item is only set while a ListGen makes an item/);
  });

  it("checks the items' models before the run", async () => {
    const list = new TreeGen({
      schema: s.object({ l: s.array(s.string()) }),
      fields: { l: new ListGen({ item: new LLMTextGen({ model: "nope", prompt: prompt`Hi` }), count: 1 }) },
    });
    await expect(preview({ gen: list, numRecords: 1, providers: { mock: new MockProvider() }, models: { m: { provider: "mock", model: "x" } } })).rejects.toThrow(
      /field 'l'.*unknown model 'nope'/,
    );
  });
});
