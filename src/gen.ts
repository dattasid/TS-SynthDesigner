import type { Context } from "./context";
import { ConfigError } from "./errors";

/**
 * A typed pointer to a field of the tree being generated.
 * At runtime it is just the field name; at compile time it also carries the field's value type.
 */
export class Ref<V> {
  /** Phantom: never set at runtime. It is what makes `Ref<number>` and `Ref<string>` incompatible. */
  declare readonly __value?: V;

  constructor(readonly path: string) {}
}

/**
 * Returns a ref factory for fields of `T`. `ref("age")` is a `Ref<T["age"]>`, and a name that is not
 * a key of `T` is a compile error.
 *
 *     const person = refs<Person>();
 *     cityGen.bind({ category: person("country") })
 */
export function refs<T>(): <K extends keyof T & string>(name: K) => Ref<T[K]> {
  return (name) => new Ref(name);
}

/** One `Ref<V>` per input `V`: what `bind()` takes. */
export type Refs<Inputs> = { readonly [K in keyof Inputs]: Ref<Inputs[K]> };

/**
 * A generator of values of type `Out`.
 *
 * `Inputs` are named, typed slots for values the Gen needs from other fields (e.g. SubCategory's
 * `category`). The Gen does not know which fields feed them; the tree field decides, with `bind()`.
 * So one Gen can be reused with different fields feeding its inputs.
 */
export interface Gen<Out, Inputs = {}> {
  readonly id: string | undefined;
  generate(inputs: Inputs, ctx: Context): Out;
  /**
   * Phantom, never set. A function-typed property is checked contravariantly, so a Gen that needs
   * inputs cannot be used where a Gen with no inputs is expected (e.g. as a tree field before `bind()`).
   */
  readonly __inputs?: (inputs: Inputs) => void;
}

/** Base class for the built-in Gens. */
export abstract class BaseGen<Out, Inputs = {}> implements Gen<Out, Inputs> {
  declare readonly __inputs?: (inputs: Inputs) => void;

  constructor(readonly id: string | undefined) {}

  abstract generate(inputs: Inputs, ctx: Context): Out;

  /**
   * Decides which fields feed this Gen's inputs. Each ref's type must fit its input's type.
   *
   *     city: cityGen.bind({ category: person("country") })
   */
  bind(inputs: Refs<Inputs>): BoundGen<Out> {
    return new BoundGen(this, inputs as Readonly<Record<string, Ref<unknown>>>);
  }

  /** Names this Gen in error messages. */
  protected describe(): string {
    return this.id === undefined ? this.constructor.name : `${this.constructor.name} '${this.id}'`;
  }

  protected check(condition: boolean, message: string): void {
    if (!condition) throw new ConfigError(`${this.describe()}: ${message}`);
  }

  protected checkProbability(p: number): void {
    this.check(p >= 0 && p <= 1, `p must be in [0, 1], got ${p}.`);
  }

  protected checkDecimalPlaces(decimalPlaces: number | undefined): void {
    this.check(
      decimalPlaces === undefined || (Number.isInteger(decimalPlaces) && decimalPlaces >= 0),
      `decimalPlaces must be an integer >= 0, got ${decimalPlaces}.`,
    );
  }
}

/**
 * A Gen with its inputs wired to fields, made by `bind()`. It has no inputs left, so it can be a tree field.
 * The tree reads `refs` to order fields and to hand over the values.
 */
export class BoundGen<Out> extends BaseGen<Out> {
  constructor(
    readonly gen: Gen<Out, any>,
    readonly refs: Readonly<Record<string, Ref<unknown>>>,
  ) {
    super(gen.id);
    for (const [input, ref] of Object.entries(refs)) {
      this.check(ref instanceof Ref, `input '${input}' must be a Ref, e.g. refs<Person>()("country").`);
    }
  }

  protected override describe(): string {
    const inner = this.gen instanceof BaseGen ? this.gen.constructor.name : "Gen";
    return this.id === undefined ? `bound ${inner}` : `bound ${inner} '${this.id}'`;
  }

  generate(_inputs: {}, _ctx: Context): Out {
    throw new ConfigError(`${this.describe()}: a bound Gen reads other fields, so it only runs as a field of a TreeGen.`);
  }
}
