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
  s,
  TreeGen,
  type Infer,
} from "../src/index";

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
