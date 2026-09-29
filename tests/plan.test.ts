import { describe, expect, it } from "vitest";
import { BaseGen, ConfigError, Context, parentRefs, Plan, preview, refs, rootRefs, TreeGen } from "../src/index";

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
        label: inputProbe<{ addr: Address }>().bind({ addr: person("address") }),
        address: new TreeGen<Address>({
          fields: {
            zip: inputProbe<{ street: string }>().bind({ street: address("street") }), // declared first, runs after street
            street: probe(),
          },
        }),
        name: probe(),
      },
    });

    const plan = Plan.compile(tree);
    // When several steps are ready, the one declared first runs first: label (declared before name).
    expect(plan.order).toEqual(["address.street", "address.zip", "label", "name"]);

    const [first] = preview({ gen: tree, numRecords: 2, seed: 1 }).records;
    expect(log).toEqual([
      "address.street",
      "address.zip(street=address.street#1)",
      `label(addr={"zip":"address.zip#2","street":"address.street#1"})`,
      "name",
      // Second record: same plan, same order.
      "address.street",
      "address.zip(street=address.street#5)",
      `label(addr={"zip":"address.zip#6","street":"address.street#5"})`,
      "name",
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
    const root = rootRefs<Doc>();
    const side = (reads: "a" | "b", fields: { x?: "y"; z?: "w" }) =>
      new TreeGen<Side>({
        fields: {
          w: new ProbeGen(log),
          x: fields.x ? new ProbeGen<{ v: string }>(log).bind({ v: root(reads, "y") }) : new ProbeGen(log),
          y: new ProbeGen(log),
          z: fields.z ? new ProbeGen<{ v: string }>(log).bind({ v: root(reads, "w") }) : new ProbeGen(log),
        },
      });

    // a.x reads b.y while b.z reads a.w. Ordering whole subtrees ("a before b" and "b before a") would
    // call this a cycle; ordering single fields finds a valid order.
    const doc = new TreeGen<Doc>({ fields: { a: side("b", { x: "y" }), b: side("a", { z: "w" }) } });
    expect(Plan.compile(doc).order).toEqual(["a.w", "a.y", "a.z", "b.w", "b.x", "b.y", "a.x", "b.z"]);
    preview({ gen: doc, numRecords: 1, seed: 1 });
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
        city: new TreeGen<City>({ fields: { name: new ProbeGen<{ code: string }>(log).bind({ code: country("code") }) } }),
      },
    });
    expect(Plan.compile(nested).order).toEqual(["code", "city.name"]);

    // Mistakes that only the plan can see, because they depend on where a tree is placed.
    const orphan = new TreeGen<City>({ fields: { name: new ProbeGen<{ code: string }>(log).bind({ code: country("code") }) } });
    expect(() => Plan.compile(orphan)).toThrow(/its object is the root, so it has no parent/);

    const selfReader = new TreeGen<Doc>({
      fields: {
        a: new TreeGen<Side>({
          fields: {
            w: new ProbeGen<{ v: Side }>(log).bind({ v: root("a") }), // reads its own enclosing object
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
});
