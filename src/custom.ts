import type { Context } from "./context";
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
