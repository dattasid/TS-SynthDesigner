import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BaseGen,
  CategorySamplerGen,
  ConfigError,
  Context,
  CustomGen,
  GenerationError,
  NumberSamplerGen,
  parentRefs,
  Plan,
  preview,
  previewSync,
  refs,
  rootRefs,
  SchemaBuilder,
  showRef,
  TreeGen,
  type BoundGen,
  type Infer,
  type RefTree,
} from "../src/index";

const s = SchemaBuilder;

/** Test Gen: returns "<path>#<call>" and logs each call's path and inputs, so the run order is visible. */
class ProbeGen<Inputs = {}> extends BaseGen<string, Inputs> {
  constructor(private readonly log: string[]) {
    super(undefined);
  }

  generate(inputs: Inputs, ctx: Context): string {
    const shown = Object.entries(inputs as object).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
    this.log.push(shown.length ? `${ctx.pathString}(${shown.join(", ")})` : ctx.pathString);
    return `${ctx.pathString}#${this.log.length}`;
  }
}

const Address = s.object({ zip: s.string(), street: s.string() });
type Address = Infer<typeof Address>;
const Person = s.object({ label: s.string(), address: Address, name: s.string() });

describe("Plan", () => {
  it("flattens nested trees into one ordered list of steps, reused for every record", () => {
    const log: string[] = [];
    const probe = () => new ProbeGen(log);
    const inputProbe = <I>() => new ProbeGen<I>(log);
    const address = refs(Address);
    const person = refs(Person);

    const tree = new TreeGen({
      schema: Person,
      fields: {
        // Reads the whole nested object, so it runs after every field of `address`.
        label: inputProbe<{ addr: Address }>().bind({ addr: person.address }),
        address: new TreeGen({
          schema: Address,
          fields: {
            zip: inputProbe<{ street: string }>().bind({ street: address.street }), // declared first, runs after street
            street: probe(),
          },
        }),
        name: probe(),
      },
    });

    const plan = Plan.compile(tree);
    // When several steps are ready, the one declared first runs first: label (declared before name).
    expect(plan.order).toEqual(["address.street", "address.zip", "label", "name"]);
    expect(plan.graph()).toEqual([
      { path: "address.street", reads: {} },
      { path: "address.zip", reads: { street: "address.street" } },
      { path: "label", reads: { addr: "address" } },
      { path: "name", reads: {} },
    ]);
    expect(plan.toText()).toBe(
      ["Level 0", "  address.street", "  name", "Level 1", "  address.zip     <- address.street",
        "Level 2", "  label           <- addr=address"].join("\n"),
    );

    const [first] = previewSync({ gen: tree, numRecords: 2, seed: 1 }).records;
    // Both records are one batch: each level runs for every row before the next level starts, and
    // each step runs for rows 0, 1, ... in order.
    expect(log).toEqual([
      "address.street", // level 0, row 0
      "address.street", // level 0, row 1
      "name",
      "name",
      "address.zip(street=address.street#1)", // level 1
      "address.zip(street=address.street#2)",
      `label(addr={"zip":"address.zip#5","street":"address.street#1"})`, // level 2
      `label(addr={"zip":"address.zip#6","street":"address.street#2"})`,
    ]);

    // Objects are pre-shaped: keys come out in declaration order, not run order.
    expect(Object.keys(first!)).toEqual(["label", "address", "name"]);
    expect(Object.keys(first!.address)).toEqual(["zip", "street"]);
  });

  it("root and parent refs reach across subtrees, ordered field by field", () => {
    const Side = s.object({ w: s.string(), x: s.string(), y: s.string(), z: s.string() });
    type Side = Infer<typeof Side>;
    const Doc = s.object({ a: Side, b: Side });
    const log: string[] = [];
    const root = rootRefs(Doc);
    const side = (reads: "a" | "b", fields: { x?: "y"; z?: "w" }) =>
      new TreeGen({
        schema: Side,
        fields: {
          w: new ProbeGen(log),
          x: fields.x ? new ProbeGen<{ v: string }>(log).bind({ v: root[reads].y }) : new ProbeGen(log),
          y: new ProbeGen(log),
          z: fields.z ? new ProbeGen<{ v: string }>(log).bind({ v: root[reads].w }) : new ProbeGen(log),
        },
      });

    // a.x reads b.y while b.z reads a.w. Ordering whole subtrees ("a before b" and "b before a") would
    // call this a cycle; ordering single fields finds a valid order.
    const doc = new TreeGen({ schema: Doc, fields: { a: side("b", { x: "y" }), b: side("a", { z: "w" }) } });
    expect(Plan.compile(doc).order).toEqual(["a.w", "a.y", "a.z", "b.w", "b.x", "b.y", "a.x", "b.z"]);
    previewSync({ gen: doc, numRecords: 1, seed: 1 });
    expect(log).toContain("a.x(v=b.y#6)");
    expect(log).toContain("b.z(v=a.w#1)");

    // A parent ref: one level up from the object holding the field.
    const City = s.object({ name: s.string() });
    const Country = s.object({ code: s.string(), city: City });
    const country = parentRefs(Country);
    const nested = new TreeGen({
      schema: Country,
      fields: {
        code: new ProbeGen(log),
        city: new TreeGen({ schema: City, fields: { name: new ProbeGen<{ code: string }>(log).bind({ code: country.code }) } }),
      },
    });
    expect(Plan.compile(nested).order).toEqual(["code", "city.name"]);

    // Mistakes that only the plan can see, because they depend on where a tree is placed.
    const orphan = new TreeGen({ schema: City, fields: { name: new ProbeGen<{ code: string }>(log).bind({ code: country.code }) } });
    expect(() => Plan.compile(orphan)).toThrow(/its object is the root, so it has no parent/);

    const selfReader = new TreeGen({
      schema: Doc,
      fields: {
        a: new TreeGen({
          schema: Side,
          fields: {
            w: new ProbeGen<{ v: Side }>(log).bind({ v: root.a }), // reads its own enclosing object
            x: new ProbeGen(log),
            y: new ProbeGen(log),
            z: new ProbeGen(log),
          },
        }),
        b: side("a", {}),
      },
    });
    expect(() => Plan.compile(selfReader)).toThrow(
      new ConfigError("field 'a.w' reads 'a' (input 'v'), which contains the field itself."),
    );
  });

  it("a ref can read into one field's value (e.g. a structured LLM reply): it waits for that field", () => {
    const Shop = s.object({
      blurb: s.string(),
      product: s.object({ name: s.string(), specs: s.object({ weight: s.number() }).optional() }),
      weight: s.number().optional(),
    });
    const p = rootRefs(Shop);
    const shop = new TreeGen({
      schema: Shop,
      fields: {
        // Declared first, read before it is made: the plan must order it after product.
        blurb: CustomGen.bound({ inputs: { name: p.product.name }, fn: ({ name }) => `Buy ${name}!` }),
        product: new CustomGen({ fn: (_: {}, ctx) => (ctx.rng.random() < 0.5 ? { name: "Mug" } : { name: "Lamp", specs: { weight: 2 } }) }),
        // specs is optional: reading through a missing object gives undefined.
        weight: CustomGen.bound({ inputs: { w: p.product.specs.weight }, fn: ({ w }) => w }),
      },
    });
    // Through the optional specs, weight may be missing, and the ref's type says so.
    expectTypeOf(p.product.specs.weight).toEqualTypeOf<RefTree<number | undefined>>();
    new TreeGen({
      schema: s.object({ product: Shop.fields.product, weight: s.number() }),
      fields: {
        product: shop.fields.product,
        // @ts-expect-error weight is a required number, but the value read may be undefined
        weight: CustomGen.bound({ inputs: { w: p.product.specs.weight }, fn: ({ w }) => w }),
      },
    });

    const plan = Plan.compile(shop);
    expect(plan.levels()).toEqual([["product"], ["blurb", "weight"]]);
    const { records } = previewSync({ gen: shop, numRecords: 20, seed: 1 });
    for (const r of records) {
      expect(r.blurb).toBe(`Buy ${r.product.name}!`);
      expect(r.weight).toBe(r.product.name === "Lamp" ? 2 : undefined);
    }
  });

  it("refs are property access: any depth, and any field name", () => {
    // `path` and `scope` would clash with a ref's own members if those were plain properties.
    const C = s.object({ scope: s.string() });
    const B = s.object({ c: C });
    const A = s.object({ b: B });
    const Deep = s.object({ path: s.string(), a: A });
    const p = rootRefs(Deep);
    expect(showRef(p.a.b.c.scope)).toBe("root.a.b.c.scope");
    expect(p.a.b).toBe(p.a.b); // the same ref object each time

    const log: string[] = [];
    const c = new TreeGen({ schema: C, fields: { scope: new ProbeGen(log) } });
    const b = new TreeGen({ schema: B, fields: { c } });
    const deep = new TreeGen({
      schema: Deep,
      fields: {
        path: new ProbeGen<{ v: string }>(log).bind({ v: p.a.b.c.scope }),
        a: new TreeGen({ schema: A, fields: { b } }),
      },
    });
    expect(Plan.compile(deep).order).toEqual(["a.b.c.scope", "path"]);
  });

  it("refs belong to their schema: a tree using rootRefs cannot be nested in another by mistake", () => {
    const Person = s.object({ name: s.string(), nick: s.string() });
    const World = s.object({ name: s.string(), person: Person });
    const p = rootRefs(Person);
    const nickGen = new ProbeGen<{ v: string }>([]).bind({ v: p.name });
    const personGen = new TreeGen({ schema: Person, fields: { name: new ProbeGen([]), nick: nickGen } });
    expect(Plan.compile(personGen).order).toEqual(["name", "nick"]);
    // Refs from the same schema are interchangeable (e.g. made in a helper file).
    const again = new TreeGen({
      schema: Person,
      fields: { name: new ProbeGen([]), nick: new ProbeGen<{ v: string }>([]).bind({ v: rootRefs(Person).name }) },
    });
    expect(Plan.compile(again).order).toEqual(["name", "nick"]);

    // Nested in World, p.name would read world.name: the root's schema is World, so it is caught.
    const world = new TreeGen({ schema: World, fields: { name: new ProbeGen([]), person: personGen } });
    expect(() => Plan.compile(world)).toThrow(
      new ConfigError(
        "field 'person.nick' reads 'root.name' (input 'v'), made from another schema than the root's. " +
          "Is this tree nested in another one? Use refs/parentRefs in trees meant to be nested.",
      ),
    );
    // With refs(), the same tree nests anywhere.
    const r = refs(Person);
    const portable = new TreeGen({ schema: Person, fields: { name: new ProbeGen([]), nick: new ProbeGen<{ v: string }>([]).bind({ v: r.name }) } });
    const world2 = new TreeGen({ schema: World, fields: { name: new ProbeGen([]), person: portable } });
    expect(Plan.compile(world2).order).toEqual(["name", "person.name", "person.nick"]);

    expect(() => rootRefs({} as never)).toThrow(/rootRefs\(\) takes the object schema/);
  });

  it("async Gens: a level's calls run together, and the data does not depend on timing or batch size", async () => {
    const Row = s.object({ topic: s.string(), a: s.string(), b: s.string(), both: s.string(), n: s.integer() });
    const p = rootRefs(Row);
    let inFlight = 0;
    let maxInFlight = 0;
    // Stands in for an LLM call: random latency, so calls finish in a different order on every run.
    const slow = (label: string) =>
      CustomGen.bound({
        inputs: { topic: p.topic },
        fn: async ({ topic }, ctx) => {
          const draw = ctx.rng.int(0, 999); // randomness before the first await
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
          inFlight--;
          return `${label}:${topic}:${draw}`;
        },
      });
    expectTypeOf(slow("a")).toEqualTypeOf<BoundGen<string>>(); // the awaited type, so it fits a string field

    const tree = new TreeGen({
      schema: Row,
      fields: {
        topic: new CategorySamplerGen({ values: ["cats", "tax law", "jazz"] }),
        a: slow("a"),
        b: slow("b"),
        both: CustomGen.bound({ inputs: { a: p.a, b: p.b }, fn: ({ a, b }) => `${a} | ${b}` }), // sync, reads async fields
        n: new NumberSamplerGen({ type: "uniform", low: 0, high: 100, integer: true }),
      },
    });

    const { records } = await preview({ gen: tree, numRecords: 6, seed: 5, batchSize: 6 });
    expect(maxInFlight).toBe(12); // a and b are one level: 6 rows x 2 fields in flight at once
    for (const r of records) expect(r.both).toBe(`${r.a} | ${r.b}`); // the next level saw values, not Promises
    expect((await preview({ gen: tree, numRecords: 6, seed: 5, batchSize: 4 })).records).toEqual(records);
    expect((await preview({ gen: tree, numRecords: 6, seed: 5, batchSize: 1 })).records).toEqual(records);

    expect(() => previewSync({ gen: tree, numRecords: 1, seed: 5 })).toThrow(GenerationError);
    expect(() => previewSync({ gen: tree, numRecords: 1, seed: 5 })).toThrow(/field 'a' returned a Promise/);
  });
});
