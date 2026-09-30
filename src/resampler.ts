import type { Context } from "./context";
import type { RefValues } from "./custom";
import { GenerationError } from "./errors";
import { BaseGen, type BoundGen, type Gen, type Ref } from "./gen";

/**
 * What to do when no sample is accepted within `maxAttempts`:
 * - `fail`: throw a GenerationError (default).
 * - `keepLast`: use the last, rejected, sample.
 * - `skip`: use `undefined`. The Gen's type then includes `undefined`, so it only fits a field that
 *   allows it. (Skipping the fields that depend on it comes with the skip feature, later.)
 */
export type OnExhausted = "fail" | "keepLast" | "skip";

/** The output type: `V`, or `V | undefined` when exhausted attempts are skipped. */
export type ResampledValue<V, E extends OnExhausted> = E extends "skip" ? V | undefined : V;

interface ResamplerOptions<V, E extends OnExhausted> {
  id?: string;
  /** Produces the candidates. Must not need inputs of its own. */
  childGen: Gen<V>;
  /** Tries per value before `onExhausted` applies. Default 100. */
  maxAttempts?: number;
  onExhausted?: E;
}

export interface ConditionalRejectionResamplerParams<V, Inputs, E extends OnExhausted> extends ResamplerOptions<V, E> {
  /** `true` keeps the candidate, `false` draws another. Type the second parameter to declare the inputs. */
  accept: (value: V, inputs: Inputs) => boolean;
}

export interface ConditionalRejectionResamplerBoundParams<R extends Record<string, Ref<unknown>>, V, E extends OnExhausted>
  extends ResamplerOptions<V, E> {
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
export class ConditionalRejectionResamplerGen<V, Inputs = {}, E extends OnExhausted = "fail"> extends BaseGen<
  ResampledValue<V, E>,
  Inputs
> {
  readonly childGen: Gen<V>;
  readonly accept: (value: V, inputs: Inputs) => boolean;
  readonly maxAttempts: number;
  readonly onExhausted: OnExhausted;

  constructor({ id, childGen, accept, maxAttempts = 100, onExhausted }: ConditionalRejectionResamplerParams<V, Inputs, E>) {
    super(id);
    this.childGen = childGen;
    this.accept = accept;
    this.maxAttempts = maxAttempts;
    this.onExhausted = onExhausted ?? "fail";
    this.check(typeof childGen?.generate === "function", "childGen must be a Gen.");
    this.check(typeof accept === "function", "accept must be a function.");
    this.check(Number.isSafeInteger(maxAttempts) && maxAttempts >= 1, `maxAttempts must be an integer >= 1, got ${maxAttempts}.`);
    this.check(["fail", "keepLast", "skip"].includes(this.onExhausted), `onExhausted must be fail, keepLast or skip.`);
    this.check((childGen.inputNames ?? []).length === 0, "childGen must not need inputs.");
  }

  /** The one-off form: already bound to `inputs`, ready to be a field. */
  static bound<const R extends Record<string, Ref<unknown>>, V, E extends OnExhausted = "fail">(
    params: ConditionalRejectionResamplerBoundParams<R, V, E>,
  ): BoundGen<ResampledValue<V, E>> {
    const { inputs, ...rest } = params;
    return new ConditionalRejectionResamplerGen<V, RefValues<R>, E>(rest).bind(inputs as never);
  }

  generate(inputs: Inputs, ctx: Context): ResampledValue<V, E> {
    let value!: V;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      value = this.childGen.generate({}, ctx);
      if (this.accept(value, inputs)) return value;
    }
    switch (this.onExhausted) {
      case "keepLast":
        return value;
      case "skip":
        return undefined as ResampledValue<V, E>;
      default:
        throw new GenerationError(
          `${this.describe()} at ${ctx.pathString}: no value accepted in ${this.maxAttempts} attempts ` +
            `(last: ${JSON.stringify(value)}, inputs: ${JSON.stringify(inputs)}).`,
        );
    }
  }
}
