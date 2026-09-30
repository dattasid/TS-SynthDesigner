import type { Context } from "./context";
import type { RefValues } from "./custom";
import { GenerationError } from "./errors";
import { BaseGen, type BoundGen, type Gen, type Ref } from "./gen";

/**
 * What to do when no sample is accepted within `maxAttempts`:
 * - `fail`: throw a GenerationError (default).
 * - `keepLast`: use the last, rejected, sample.
 * - `default`: use `defaultValue`, which defaults to the text "None": human readable, and unlike ""
 *   it does not look like "no data came in". The Gen's type becomes `V | typeof defaultValue`, so
 *   "None" fits a string field as is, and a number field needs a `defaultValue` (a number, or `null`
 *   for a field that allows null).
 */
export type OnExhausted = "fail" | "keepLast" | "default";

/** The output type: `V`, or `V | D` when exhausted attempts fall back to the default `D`. */
export type ResampledValue<V, E extends OnExhausted, D> = E extends "default" ? V | D : V;

interface ResamplerOptions<V, E extends OnExhausted, D> {
  id?: string;
  /** Produces the candidates. Must not need inputs of its own, and must be sync (async childGens come later). */
  childGen: Gen<V>;
  /** Tries per value before `onExhausted` applies. Default 100. */
  maxAttempts?: number;
  onExhausted?: E;
  /** The value used with `onExhausted: "default"`. Default "None". */
  defaultValue?: D;
}

export interface ConditionalRejectionResamplerParams<V, Inputs, E extends OnExhausted, D>
  extends ResamplerOptions<V, E, D> {
  /** `true` keeps the candidate, `false` draws another. Type the second parameter to declare the inputs. */
  accept: (value: V, inputs: Inputs) => boolean;
}

export interface ConditionalRejectionResamplerBoundParams<R extends Record<string, Ref<unknown>>, V, E extends OnExhausted, D>
  extends ResamplerOptions<V, E, D> {
  /** Which fields feed the inputs: `{ country: p.country }`. */
  inputs: R;
  /** `true` keeps the candidate, `false` draws another. Parameter types come from `childGen` and the refs. */
  accept: (value: V, inputs: RefValues<R>) => boolean;
}

/**
 * Draws from `childGen` until `accept` says yes: rejection sampling, with a condition that can read
 * other fields. The generalization of DataDesigner's inequality constraints.
 *
 *     occu2: ConditionalRejectionResamplerGen.bound({
 *       childGen: occuGen,
 *       inputs: { country: p.country },
 *       accept: (value, { country }) => !(country === "Canada" && value === "not_allowed_canada"),
 *     })
 *
 * Like CustomGen, there is also a reusable form (`new ...({ childGen, accept: (value, inputs: {...}) => ... })`
 * plus `bind()`).
 */
// NoInfer<D> throughout: D must come only from `defaultValue`. Otherwise, with no defaultValue, TypeScript
// would infer D from where the Gen is used (e.g. a number field) and hide that the value is "None".
export class ConditionalRejectionResamplerGen<V, Inputs = {}, E extends OnExhausted = "fail", D = "None"> extends BaseGen<
  ResampledValue<V, E, NoInfer<D>>,
  Inputs
> {
  readonly childGen: Gen<V>;
  readonly accept: (value: V, inputs: Inputs) => boolean;
  readonly maxAttempts: number;
  readonly onExhausted: OnExhausted;
  readonly defaultValue: NoInfer<D>;

  constructor(params: ConditionalRejectionResamplerParams<V, Inputs, E, D>) {
    const { id, childGen, accept, maxAttempts = 100, onExhausted } = params;
    super(id);
    this.childGen = childGen;
    this.accept = accept;
    this.maxAttempts = maxAttempts;
    this.onExhausted = onExhausted ?? "fail";
    this.defaultValue = ("defaultValue" in params ? params.defaultValue : "None") as NoInfer<D>;
    this.check(typeof childGen?.generate === "function", "childGen must be a Gen.");
    this.check(typeof accept === "function", "accept must be a function.");
    this.check(Number.isSafeInteger(maxAttempts) && maxAttempts >= 1, `maxAttempts must be an integer >= 1, got ${maxAttempts}.`);
    this.check(["fail", "keepLast", "default"].includes(this.onExhausted), "onExhausted must be fail, keepLast or default.");
    this.check(
      !("defaultValue" in params) || this.onExhausted === "default",
      `defaultValue only applies with onExhausted: "default", got "${this.onExhausted}".`,
    );
    this.check((childGen.inputNames ?? []).length === 0, "childGen must not need inputs.");
  }

  /** The one-off form: already bound to `inputs`, ready to be a field. */
  static bound<const R extends Record<string, Ref<unknown>>, V, E extends OnExhausted = "fail", D = "None">(
    params: ConditionalRejectionResamplerBoundParams<R, V, E, D>,
  ): BoundGen<ResampledValue<V, E, NoInfer<D>>> {
    const { inputs, ...rest } = params;
    return new ConditionalRejectionResamplerGen<V, RefValues<R>, E, D>(rest).bind(inputs as never);
  }

  generate(inputs: Inputs, ctx: Context): ResampledValue<V, E, NoInfer<D>> {
    let value!: V;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const candidate = this.childGen.generate({}, ctx);
      if (candidate instanceof Promise) {
        candidate.catch(() => {});
        // Redrawing after an await would take this field's random draws out of row order.
        throw new GenerationError(`${this.describe()} at ${ctx.pathString}: childGen is async; that is not supported yet.`);
      }
      value = candidate;
      if (this.accept(value, inputs)) return value;
    }
    switch (this.onExhausted) {
      case "keepLast":
        return value;
      case "default":
        return this.defaultValue as ResampledValue<V, E, NoInfer<D>>;
      default:
        throw new GenerationError(
          `${this.describe()} at ${ctx.pathString}: no value accepted in ${this.maxAttempts} attempts ` +
            `(last: ${JSON.stringify(value)}, inputs: ${JSON.stringify(inputs)}).`,
        );
    }
  }
}
