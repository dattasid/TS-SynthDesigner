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
  showRef,
  TreeGen,
  type BoundGen,
  type RefTree,
} from "../src/index";

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

interface Address {
  zip: string;
  street: string;
}
interface Person {
  label: string;
  address: Address;
  name: string;
}

describe("Plan", () => {
  it("flattens nested trees into one ordered list of steps, reused for every record", () => {
    const log: string[] = [];
    const probe = () => new ProbeGen(log);
    const inputProbe = <I>() => new ProbeGen<I>(log);
    const address = refs<Address>();
    const person = refs<Person>();

    const tree = new TreeGen<Person>({
      fields: {
        // Reads the whole nested object, so it runs after every field of `address`.
        label: inputProbe<{ addr: Address }>().bind({ addr: person.address }),
        address: new TreeGen<Address>({
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
    interface Side {
      w: string;
      x: string;
      y: string;
      z: string;
    }
    interface Doc {
      a: Side;
      b: Side;
    }
    const log: string[] = [];
    const root = rootRefs<Doc>("doc");
    const side = (reads: "a" | "b", fields: { x?: "y"; z?: "w" }) =>
      new TreeGen<Side>({
        fields: {
          w: new ProbeGen(log),
          x: fields.x ? new ProbeGen<{ v: string }>(log).bind({ v: root[reads].y }) : new ProbeGen(log),
          y: new ProbeGen(log),
          z: fields.z ? new ProbeGen<{ v: string }>(log).bind({ v: root[reads].w }) : new ProbeGen(log),
        },
      });

    // a.x reads b.y while b.z reads a.w. Ordering whole subtrees ("a before b" and "b before a") would
    // call this a cycle; ordering single fields finds a valid order.
    const doc = new TreeGen<Doc>({ fields: { a: side("b", { x: "y" }), b: side("a", { z: "w" }) } });
    expect(Plan.compile(doc).order).toEqual(["a.w", "a.y", "a.z", "b.w", "b.x", "b.y", "a.x", "b.z"]);
    previewSync({ gen: doc, numRecords: 1, seed: 1 });
    expect(log).toContain("a.x(v=b.y#6)");
    expect(log).toContain("b.z(v=a.w#1)");

    // A parent ref: one level up from the object holding the field.
    interface City {
      name: string;
    }
    interface Country {
      code: string;
      city: City;
    }
    const country = parentRefs<Country>();
    const nested = new TreeGen<Country>({
      fields: {
        code: new ProbeGen(log),
        city: new TreeGen<City>({ fields: { name: new ProbeGen<{ code: string }>(log).bind({ code: country.code }) } }),
      },
    });
    expect(Plan.compile(nested).order).toEqual(["code", "city.name"]);

    // Mistakes that only the plan can see, because they depend on where a tree is placed.
    const orphan = new TreeGen<City>({ fields: { name: new ProbeGen<{ code: string }>(log).bind({ code: country.code }) } });
    expect(() => Plan.compile(orphan)).toThrow(/its object is the root, so it has no parent/);

    const selfReader = new TreeGen<Doc>({
      fields: {
        a: new TreeGen<Side>({
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
    interface Shop {
      blurb: string;
      product: { name: string; specs?: { weight: number } };
      weight?: number;
    }
    const p = rootRefs<Shop>("shop");
    const shop = new TreeGen<Shop>({
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
    new TreeGen<Pick<Shop, "product"> & { weight: number }>({
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
    interface Deep {
      path: string;
      a: { b: { c: { scope: string } } };
    }
    const p = rootRefs<Deep>("deep");
    expect(showRef(p.a.b.c.scope)).toBe("deep.a.b.c.scope");
    expect(p.a.b).toBe(p.a.b); // the same ref object each time

    const log: string[] = [];
    type C = Deep["a"]["b"]["c"];
    type B = Deep["a"]["b"];
    const c = new TreeGen<C>({ fields: { scope: new ProbeGen(log) } });
    const b = new TreeGen<B>({ fields: { c } });
    const deep = new TreeGen<Deep>({
      fields: {
        path: new ProbeGen<{ v: string }>(log).bind({ v: p.a.b.c.scope }),
        a: new TreeGen<Deep["a"]>({ fields: { b } }),
      },
    });
    expect(Plan.compile(deep).order).toEqual(["a.b.c.scope", "path"]);
  });

  it("rootRefs names its root: all root refs of a plan share the name, and it must match the root tree's id", () => {
    interface Person {
      name: string;
      nick: string;
    }
    interface World {
      name: string;
      person: Person;
    }
    const p = rootRefs<Person>("person");
    const nickGen = new ProbeGen<{ v: string }>([]).bind({ v: p.name });
    const personGen = new TreeGen<Person>({ id: "person", fields: { name: new ProbeGen([]), nick: nickGen } });
    expect(Plan.compile(personGen).order).toEqual(["name", "nick"]);
    // Another rootRefs with the same name is interchangeable (e.g. made in a helper file).
    const again = new TreeGen<Person>({
      id: "person",
      fields: { name: new ProbeGen([]), nick: new ProbeGen<{ v: string }>([]).bind({ v: rootRefs<Person>("person").name }) },
    });
    expect(Plan.compile(again).order).toEqual(["name", "nick"]);

    // Nested in World: p.name would read world.name. Caught through the root tree's id...
    const world = (id?: string) => new TreeGen<World>({ id, fields: { name: new ProbeGen([]), person: personGen } });
    expect(() => Plan.compile(world("world"))).toThrow(
      new ConfigError(
        "field 'person.nick' reads 'person.name' (input 'v'), but the root is 'world' (from the root tree's id). " +
          'rootRefs("person") was made for another root type: is this tree nested in another one? Use refs/parentRefs in nested trees.',
      ),
    );
    // ...or through another root ref with a different name. Without either, it goes unnoticed.
    const w = rootRefs<World>("world");
    const loud = new TreeGen<World>({ fields: { name: new ProbeGen<{ v: string }>([]).bind({ v: w.person.nick }), person: personGen } });
    expect(() => Plan.compile(loud)).toThrow(/field 'person\.nick' reads 'person\.name' .*but the root is 'world' \(from field 'name'\)/);
    expect(Plan.compile(world()).order).toEqual(["name", "person.name", "person.nick"]);

    expect(() => rootRefs<Person>("")).toThrow(/rootRefs needs the root's name/);
    expect(() => rootRefs<Person>("my person")).toThrow(/an identifier like "person"/);
  });

  it("async Gens: a level's calls run together, and the data does not depend on timing or batch size", async () => {
    interface Row {
      topic: string;
      a: string;
      b: string;
      both: string;
      n: number;
    }
    const p = rootRefs<Row>("row");
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

    const tree = new TreeGen<Row>({
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
