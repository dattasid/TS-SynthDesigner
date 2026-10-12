import type { Context } from "./context";
import { ConfigError, GenerationError } from "./errors";
import { BaseGen, BoundGen, type Gen, type MaybePromise, type Refs } from "./gen";
import { Plan } from "./plan";
import { ObjectSchema, type Infer, type Schema } from "./schema";
import { fieldSchema, TreeGen, type AnyObjectSchema, type Fields, type TreeCloneParams } from "./tree";

/**
 * How many items a list gets:
 * - a number: always that many.
 * - `{ min, max }`: a whole number in [min, max], each equally likely.
 * - a Gen of numbers, e.g. `new NumberSamplerGen({ type: "poisson", mean: 3 })`. It must not need inputs.
 */
export type ListCount = number | { min: number; max: number } | Gen<number>;

/** An item Gen, carrying the list's inputs type if it is an `ItemTree`. */
export type ItemGen<T, Inputs> = Gen<T> & { readonly __listInputs?: Inputs };

export interface ListGenParams<T, Inputs> {
  id?: string;
  /**
   * Makes each item: usually a tree (an `ItemTree` from `ListGen.itemTree` to read the list's inputs),
   * or any Gen that needs no inputs, e.g. a sampler for a list of tags.
   */
  item: ItemGen<T, Inputs>;
  count: ListCount;
}

export interface ListGenBoundParams<T, Inputs> extends ListGenParams<T, Inputs> {
  /** Which fields feed the item tree's `as` field: one ref per key of its schema. */
  inputs: Refs<Inputs>;
}

export interface ItemTreeParams<S extends AnyObjectSchema, K extends keyof Infer<S> & string> {
  id?: string;
  schema: S;
  /**
   * The field that gets the list's inputs, the same for every item: an object field, whose keys are
   * the inputs. Its schema says what the other fields can read of it; make it `.temp()` to leave it
   * out of the output.
   */
  as: K;
  /** The Gens of every other field. */
  fields: Omit<Fields<Infer<S>>, K>;
}

/** A tree of list items whose `as` field gets the list's inputs. Made by `ListGen.itemTree`. */
export class ItemTree<S extends AnyObjectSchema, K extends keyof Infer<S> & string> extends TreeGen<S> {
  declare readonly __listInputs?: Infer<S>[K];
  readonly as: K;
  /** The keys of the `as` field: the list's inputs. */
  readonly inputKeys: readonly string[];

  constructor({ id, schema, as, fields }: ItemTreeParams<S, K>) {
    if (Object.hasOwn(fields, as)) throw new ConfigError(`ListGen.itemTree: '${as}' gets the list's inputs, so it cannot also be in fields.`);
    const field: Schema<unknown> | undefined = schema instanceof ObjectSchema ? (schema.fields as Record<string, Schema<unknown>>)[as] : undefined;
    const holder = field && fieldSchema(field);
    if (field && !(holder instanceof ObjectSchema)) throw new ConfigError(`ListGen.itemTree: '${as}' gets the list's inputs, so it must be an object field.`);
    // The tree checks the rest: the schema, `as` being one of its keys, the other fields.
    super({ id, schema, fields: { ...fields, [as]: new ListInputsGen() } as unknown as Fields<Infer<S>> });
    this.as = as;
    this.inputKeys = Object.keys((holder as ObjectSchema<any>).fields);
  }

  /** A copy with some Gens replaced; still an item tree, `as` still getting the list's inputs. */
  override clone({ id = this.id, fields = {} }: TreeCloneParams<S> = {}): ItemTree<S, K> {
    const { [this.as]: _, ...rest } = { ...this.fields, ...fields } as Record<string, unknown>;
    return new ItemTree<S, K>({ id, schema: this.schema, as: this.as, fields: rest as Omit<Fields<Infer<S>>, K> });
  }
}

/** The list's inputs, for an item tree's `as` field. */
class ListInputsGen extends BaseGen<unknown> {
  constructor() {
    super(undefined);
  }

  generate(_inputs: {}, ctx: Context): unknown {
    return ctx.item.inputs;
  }
}

/**
 * A list field whose items are each made by a Gen: a tree per item, with its own fields, prompts and
 * random choices. Each item has its own stream, from the seed, the row, the field path and the item's
 * index, so an item does not depend on the list's length or on the other items, and changing one
 * field of the item tree changes nothing else.
 *
 *     const Landmark = s.object({
 *       zone: s.object({ name: s.string(), biome: s.string() }).temp(),
 *       kind: s.enum(["ruin", "shrine", "tower"]),
 *       description: s.string(),
 *     });
 *     const l = refs(Landmark);
 *     const landmark = ListGen.itemTree({
 *       schema: Landmark,
 *       as: "zone",
 *       fields: {
 *         kind: new CategorySamplerGen({ values: ["ruin", "shrine", "tower"] }),
 *         description: new LLMTextGen({ model: "writer", prompt: prompt`A ${l.kind} in ${l.zone.name}, a ${l.zone.biome}.` }),
 *       },
 *     });
 *     landmarks: ListGen.bound({ item: landmark, count: { min: 2, max: 4 }, inputs: { name: z.name, biome: z.biome } }),
 *
 * The item tree is a tree of its own: its refs reach its own fields and its `as` field, not the
 * record around the list. The items of a list are made together, so their LLM calls run in
 * parallel; like rows, items cannot read each other. In an item, `ctx.item` says which item it is
 * (index, count). `ctx.row` is the row's, so Gens that go by the row index (UniqueIdGen, an ordered
 * SourceRowGen) would give every item the same value.
 */
export class ListGen<T, Inputs = {}> extends BaseGen<T[], Inputs> {
  readonly item: Gen<T>;
  readonly count: ListCount;
  private readonly plan: Plan<T>;

  constructor({ id, item, count }: ListGenParams<T, Inputs>) {
    super(id);
    this.check(typeof item?.generate === "function", "item must be a Gen.");
    this.item = item;
    this.count = count;
    if (typeof count === "number") {
      this.check(Number.isSafeInteger(count) && count >= 0, `count must be an integer >= 0, got ${count}.`);
    } else if (typeof (count as Gen<number>)?.generate === "function") {
      this.check(!(count instanceof BoundGen) && ((count as Gen<number>).inputNames ?? []).length === 0, "the count Gen must not need inputs.");
    } else {
      const { min, max } = (count ?? {}) as { min: number; max: number };
      this.check(
        Number.isSafeInteger(min) && Number.isSafeInteger(max) && 0 <= min && min <= max,
        `count needs integers 0 <= min <= max, got ${JSON.stringify(count)}.`,
      );
    }
    try {
      this.plan = Plan.compile(item);
    } catch (error) {
      if (error instanceof ConfigError) throw new ConfigError(`${this.describe()}: item: ${error.message}`);
      throw error;
    }
  }

  /** The one-off form: a ListGen already bound to `inputs`, ready to be a field. */
  static bound<T, Inputs>({ inputs, ...params }: ListGenBoundParams<T, Inputs>): BoundGen<T[]> {
    return new ListGen<T, Inputs>(params).bind(inputs);
  }

  /**
   * A tree for list items that reads the list's inputs: `as` gets them (the same object for every
   * item), and the other fields are made from them. Like `mapTree`, with the list's inputs in place
   * of a source row.
   */
  static itemTree<S extends AnyObjectSchema, K extends keyof Infer<S> & string>(params: ItemTreeParams<S, K>): ItemTree<S, K> {
    return new ItemTree(params);
  }

  override get inputNames(): readonly string[] {
    return this.item instanceof ItemTree ? this.item.inputKeys : [];
  }

  checkContext(ctx: Context): void {
    this.plan.checkContext(ctx);
    if (typeof this.count === "object" && "generate" in this.count) this.count.checkContext?.(ctx);
  }

  generate(inputs: Inputs, ctx: Context): MaybePromise<T[]> {
    const count = this.drawCount(ctx);
    const items: MaybePromise<T>[] = [];
    for (let i = 0; i < count; i++) {
      items.push(this.plan.run(ctx.child(String(i)).forItem({ index: i, count, inputs: inputs as Record<string, unknown> })));
    }
    return items.some((item) => item instanceof Promise) ? Promise.all(items) : (items as T[]);
  }

  private drawCount(ctx: Context): number {
    const count = this.count;
    if (typeof count === "number") return count;
    if (!("generate" in count)) return ctx.rng.int(count.min, count.max);
    const n = count.generate({}, ctx.child("count"));
    if (n instanceof Promise) {
      n.catch(() => {});
      throw new GenerationError(`${this.describe()} at ${ctx.pathString}: the count Gen is async; it must return a number.`);
    }
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new GenerationError(`${this.describe()} at ${ctx.pathString}: the count Gen gave ${n}; a count must be an integer >= 0.`);
    }
    return n;
  }
}
