import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BoundGen,
  ConfigError,
  ConstantGen,
  CustomGen,
  FunctionGen,
  LLMTextGen,
  MockProvider,
  NumberSamplerGen,
  preview,
  previewSync,
  prompt,
  rootRefs,
  SchemaBuilder,
  SourceRowGen,
  TreeGen,
  type Infer,
} from "../src/index";

const s = SchemaBuilder;

const Order = s.object({ price: s.number(), qty: s.integer(), total: s.number(), label: s.string() });

describe("FunctionGen", () => {
  it("is CustomGen under another name: same two forms, its own name in errors", () => {
    const o = rootRefs(Order);
    const labelGen = new FunctionGen({ fn: ({ qty }: { qty: number }) => `${qty} items` });
    const order = new TreeGen({
      schema: Order,
      id: "order",
      fields: {
        price: new NumberSamplerGen({ type: "uniform", low: 1, high: 20, decimalPlaces: 2 }),
        qty: new NumberSamplerGen({ type: "uniform", low: 1, high: 5, integer: true }),
        total: FunctionGen.bound({ inputs: { price: o.price, qty: o.qty }, fn: ({ price, qty }) => Math.round(price * qty * 100) / 100 }),
        label: labelGen.bind({ qty: o.qty }),
      },
    });
    for (const x of previewSync({ gen: order, numRecords: 20, seed: 1 }).records) {
      expect(x.total).toBe(Math.round(x.price * x.qty * 100) / 100);
      expect(x.label).toBe(`${x.qty} items`);
    }

    const bound = FunctionGen.bound({ inputs: { qty: o.qty }, fn: ({ qty }) => qty * 2 });
    expect(bound).toBeInstanceOf(BoundGen);
    expect(bound.gen).toBeInstanceOf(FunctionGen);
    expect(bound.gen).toBeInstanceOf(CustomGen);
    expectTypeOf(bound).toEqualTypeOf<BoundGen<number>>();
    expect(() => new FunctionGen({ fn: 3 as never })).toThrow("FunctionGen: fn must be a function.");
  });
});

const Scene = s.object({ setting: s.string(), mood: s.string(), props: s.array(s.string()) });
type Scene = Infer<typeof Scene>;
const Character = s.object({ scene: Scene, role: s.string(), description: s.string() });

describe("ConstantGen", () => {
  const scene: Scene = { setting: "a lighthouse in a storm", mood: "tense", props: ["lantern", "logbook"] };

  it("gives every row the same value, typed by it; refs read into it", async () => {
    const c = rootRefs(Character);
    const character = new TreeGen({
      schema: Character,
      id: "character",
      fields: {
        scene: new ConstantGen({ value: scene }),
        role: new FunctionGen({ fn: (_: {}, ctx) => (ctx.rng.random() < 0.5 ? "keeper" : "sailor") }),
        description: new LLMTextGen({ model: "m", prompt: prompt`A ${c.role} at ${c.scene.setting}, feeling ${c.scene.mood}.` }),
      },
    });
    const { records } = await preview({ gen: character, numRecords: 4, seed: 1, providers: { mock: new MockProvider() }, models: { m: { provider: "mock", model: "echo" } } });
    for (const x of records) {
      expect(x.scene).toEqual(scene);
      expect(x.description).toMatch(new RegExp(`A ${x.role} at a lighthouse in a storm, feeling tense\\.$`));
    }
    expect(records[0]!.scene).toBe(records[1]!.scene); // one shared copy

    new TreeGen({
      schema: s.object({ scene: Scene }),
      // @ts-expect-error the value must fit the field: mood is missing
      fields: { scene: new ConstantGen({ value: { setting: "x", props: [] } }) },
    });
  });

  it("copies and freezes the value: the input stays the caller's, rows cannot change it", () => {
    const input = { setting: "a lighthouse", mood: "calm", props: ["lantern"] };
    const gen = new ConstantGen({ value: input });
    input.props.push("rope");
    expect(gen.value.props).toEqual(["lantern"]);
    expect(Object.isFrozen(input)).toBe(false);
    expect(() => (gen.value.props as string[]).push("rope")).toThrow(TypeError);

    expect(() => new ConstantGen({ value: { at: () => 1 } })).toThrow(ConfigError);
    expect(() => new ConstantGen({ value: { at: () => 1 } })).toThrow(/ConstantGen: value must be plain data/);
  });
});

describe("SourceRowGen", () => {
  const Dup = s.object({ source: s.object({ id: s.string() }), copyOf: s.string() });
  const r = rootRefs(Dup);
  const rows = [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }];
  const run = (pick: "ordered" | "shuffle" | "random", startIndex = 0, numRecords = 8, seed = 1) =>
    previewSync({
      gen: new TreeGen({
        schema: Dup,
        fields: {
          source: new SourceRowGen({ rows, pick }),
          copyOf: FunctionGen.bound({ inputs: { id: r.source.id }, fn: ({ id }) => `copy of ${id}` }),
        },
      }),
      numRecords,
      seed,
      startIndex,
    }).records;

  it("serves rows in order, shuffled, or at random, counted from the run's first row", () => {
    expect(run("ordered", 100).map((x) => x.source.id).join("")).toBe("ABCDABCD");
    expect(run("ordered")[2]).toEqual({ source: { id: "C" }, copyOf: "copy of C" });

    const shuffled = run("shuffle").map((x) => x.source.id);
    expect(new Set(shuffled.slice(0, 4)).size).toBe(4); // every row once before any repeats
    expect(shuffled.slice(4)).toEqual(shuffled.slice(0, 4));
    expect(run("shuffle", 50)).toEqual(run("shuffle")); // the order is per run, not per index
    const orders = new Set([1, 2, 3, 4, 5, 6].map((seed) => run("shuffle", 0, 4, seed).map((x) => x.source.id).join("")));
    expect(orders.size).toBeGreaterThan(1);

    const random = run("random", 0, 40).map((x) => x.source.id);
    expect(new Set(random).size).toBe(4);
    expect(random.slice(0, 4).join("")).not.toBe(random.slice(4, 8).join("")); // not a fixed cycle
  });

  it("copies and freezes the rows; checks its params", () => {
    const source = [{ id: "A" }];
    const gen = new SourceRowGen({ rows: source });
    source[0]!.id = "changed";
    expect(gen.rows[0]!.id).toBe("A");
    expect(Object.isFrozen(gen.rows[0])).toBe(true);
    expect(() => new SourceRowGen({ rows: [] })).toThrow(/rows must be a non-empty array/);
    expect(() => new SourceRowGen({ rows, pick: "best" as never })).toThrow(/pick must be/);
    expect(() => new SourceRowGen({ rows: [() => 1] })).toThrow(/plain data/);
  });
});
