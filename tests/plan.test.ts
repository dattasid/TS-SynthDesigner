import { describe, expect, it } from "vitest";
import { BaseGen, Context, Plan, preview, refs, TreeGen } from "../src/index";

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
});
