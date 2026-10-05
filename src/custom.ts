import type { Context } from "./context";
import { ConfigError } from "./errors";
import { BaseGen, BoundGen, type MaybePromise, type Ref } from "./gen";

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
 * Draw randomness only through `ctx.rng`, or through other Gens called with `ctx`.
 *
 * `fn` may be async (e.g. to call an HTTP API); the field's type is still the awaited value. Draw any
 * randomness before the first `await`, so the draws happen in row order and the data is reproducible.
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

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
