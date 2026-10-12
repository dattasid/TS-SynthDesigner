import type { Context, Global } from "./context";
import { ConfigError } from "./errors";
import { BaseGen, BoundGen, type MaybePromise, type Ref } from "./gen";
import { Sfc32 } from "./rng";

/** The value type a ref points to: `Ref<number>` -> `number`. */
export type RefValue<R> = R extends Ref<infer V> ? V : never;

/** Input values for a map of refs: `{ age: Ref<number> }` -> `{ age: number }`. */
export type RefValues<R> = { [K in keyof R]: RefValue<R[K]> };

export interface CustomGenParams<Out, Inputs> {
  id?: string;
  /** Computes the value. Type the first parameter to declare the inputs; `Out` is inferred from the returns. */
  fn: (inputs: Inputs, ctx: Context) => MaybePromise<Out>;
}

export interface CustomGenBoundParams<R extends Record<string, Ref<unknown>>, Out> {
  id?: string;
  /** Which fields feed the inputs: `{ age: p.age, city: p.education.city }`. */
  inputs: R;
  /** Computes the value. Its parameter types come from the refs, so nothing needs annotating. */
  fn: (inputs: RefValues<R>, ctx: Context) => MaybePromise<Out>;
}

/**
 * A Gen from a plain function. Two forms:
 *
 * Reusable: declare the inputs by typing the parameter, bind later (possibly in several places).
 *
 *     const occupationGen = new CustomGen({
 *       fn: ({ age }: { age: number }) => (age < 18 ? "Student" : "Engineer"),
 *     });
 *     occupation: occupationGen.bind({ age: p.age })
 *
 * One-off: give the refs first; the function's parameter types come from them.
 *
 *     occupation: CustomGen.bound({
 *       inputs: { age: p.age },
 *       fn: ({ age }) => (age < 18 ? "Student" : "Engineer"),
 *     })
 *
 * Draw randomness only through `ctx.rng` (the row's own stream), or through other Gens called with
 * `ctx`. `ctx.row.index` is the row's index, e.g. for IDs: `` fn: (_, ctx) => `BUG-${10000 + ctx.row.index}` ``.
 *
 * `fn` may be async (e.g. to call an HTTP API); the field's type is still the awaited value.
 */
export class CustomGen<Out, Inputs = {}> extends BaseGen<Out, Inputs> {
  readonly fn: (inputs: Inputs, ctx: Context) => MaybePromise<Out>;

  constructor({ id, fn }: CustomGenParams<Out, Inputs>) {
    super(id);
    this.check(typeof fn === "function", "fn must be a function.");
    this.fn = fn;
  }

  /** The one-off form: a CustomGen already bound to `inputs`, ready to be a field. */
  static bound<const R extends Record<string, Ref<unknown>>, Out>({ id, inputs, fn }: CustomGenBoundParams<R, Out>): BoundGen<Out> {
    return new CustomGen<Out, RefValues<R>>({ id, fn }).bind(inputs as never);
  }

  generate(inputs: Inputs, ctx: Context): MaybePromise<Out> {
    return this.fn(inputs, ctx);
  }
}

/**
 * CustomGen under the name people look for when a field is a function of others, `field2 =
 * f(field1)`: a sum, a template, a lookup. Same two forms; errors name it FunctionGen.
 *
 *     total: FunctionGen.bound({ inputs: { price: p.price, qty: p.qty }, fn: ({ price, qty }) => price * qty }),
 *     name: FunctionGen.bound({ inputs: { f: c.firstName, l: c.lastName }, fn: ({ f, l }) => `${f} ${l}` }),
 */
export class FunctionGen<Out, Inputs = {}> extends CustomGen<Out, Inputs> {
  static override bound<const R extends Record<string, Ref<unknown>>, Out>({ id, inputs, fn }: CustomGenBoundParams<R, Out>): BoundGen<Out> {
    return new FunctionGen<Out, RefValues<R>>({ id, fn }).bind(inputs as never);
  }
}

export interface ConstantGenParams<T> {
  id?: string;
  /** The value every row gets: made elsewhere, e.g. by another run with `numRecords: 1`, read from a file, or typed in. */
  value: T;
}

/**
 * The same value in every row, e.g. a scene that characters are made for:
 *
 *     const [scene] = (await preview({ gen: sceneGen, numRecords: 1 })).records;
 *     scene: new ConstantGen({ value: scene }),
 *     description: new LLMTextGen({ model: "fast", prompt: prompt`A character for ${c.scene.setting}.` }),
 *
 * Typed by the value. It is copied once (so it must be plain data: no functions or class instances
 * beyond Date, Map, Set and the like) and frozen, so every row shares one copy that nobody can change.
 */
export class ConstantGen<T> extends BaseGen<T> {
  readonly value: T;

  constructor({ id, value }: ConstantGenParams<T>) {
    super(id);
    let copy: T;
    try {
      copy = structuredClone(value);
    } catch (error) {
      throw new ConfigError(`${this.describe()}: value must be plain data, since it is copied once: ${(error as Error).message}`);
    }
    this.value = deepFreeze(copy);
  }

  generate(): T {
    return this.value;
  }
}

export interface SourceRowGenParams<T> {
  id?: string;
  /** The rows to serve, e.g. the records of an earlier run. Copied once and frozen, like ConstantGen's value. */
  rows: readonly T[];
  /**
   * Which row each row of the run gets (default "ordered"), counting from the run's first row:
   * - "ordered": rows 0, 1, 2..., starting over at the end.
   * - "shuffle": all rows in a seeded random order, then the same order again. No row is served twice
   *   until all have been.
   * - "random": any row, drawn for each row, so some come twice.
   */
  pick?: "ordered" | "shuffle" | "random";
}

/**
 * Serves rows of a dataset made elsewhere, typically an earlier run, one per row: DataDesigner's seed
 * dataset. Its fields can then be read like any other, e.g. for duplicates of earlier records:
 *
 *     const first = await preview({ gen: bugGen, numRecords: 200, seed });
 *     const dupGen = bugGen.clone({ fields: {
 *       source: new SourceRowGen({ rows: first.records.map(({ id, title }) => ({ id, title })), pick: "shuffle" }),
 *       duplicateOf: FunctionGen.bound({ inputs: { id: r.source.id }, fn: ({ id }) => id }),
 *     } });
 *     const dups = await preview({ gen: dupGen, numRecords: 20, seed, startIndex: first.nextIndex });
 *
 * Which row is served depends only on the seed and the row's index, like everything else.
 */
export class SourceRowGen<T> extends BaseGen<T> {
  readonly rows: readonly T[];
  readonly pick: "ordered" | "shuffle" | "random";
  /** The shuffled order, per run and field path. */
  private readonly orders = new WeakMap<Global, Map<string, number[]>>();

  constructor({ id, rows, pick = "ordered" }: SourceRowGenParams<T>) {
    super(id);
    this.check(Array.isArray(rows) && rows.length > 0, "rows must be a non-empty array.");
    this.check(["ordered", "shuffle", "random"].includes(pick), `pick must be "ordered", "shuffle" or "random", got ${JSON.stringify(pick)}.`);
    let copy: T[];
    try {
      copy = structuredClone(rows as T[]);
    } catch (error) {
      throw new ConfigError(`${this.describe()}: rows must be plain data, since they are copied once: ${(error as Error).message}`);
    }
    this.rows = deepFreeze(copy);
    this.pick = pick;
  }

  generate(_inputs: {}, ctx: Context): T {
    const n = this.rows.length;
    if (this.pick === "random") return this.rows[ctx.rng.int(0, n - 1)]!;
    const i = (ctx.row.index - ctx.global.startIndex) % n;
    return this.rows[this.pick === "ordered" ? i : this.order(ctx)[i]!]!;
  }

  private order(ctx: Context): number[] {
    let byPath = this.orders.get(ctx.global);
    if (!byPath) this.orders.set(ctx.global, (byPath = new Map()));
    let order = byPath.get(ctx.pathString);
    if (!order) {
      // Fisher-Yates, from a stream of the run's seed and the field path: the same order for every row.
      const rng = new Sfc32(ctx.global.seed).fork(`SourceRowGen:${ctx.pathString}`);
      order = Array.from(this.rows, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      byPath.set(ctx.pathString, order);
    }
    return order;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
