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
 *     const ref = refs<Person>();
 *     new SubCategorySamplerGen({ parent: ref("country"), values: cityMap })
 */
export function refs<T>(): <K extends keyof T & string>(name: K) => Ref<T[K]> {
  return (name) => new Ref(name);
}

/** The refs a Gen holds for its dependencies: one `Ref<V>` per dependency value `V`. */
export type Refs<Deps> = { readonly [K in keyof Deps]: Ref<Deps[K]> };

/**
 * A generator of values of type `Out`. `Deps` are the already-generated values it needs,
 * declared through `deps` refs so the tree can order fields and hand the values over.
 */
export interface Gen<Out, Deps = {}> {
  readonly id: string | undefined;
  readonly deps: Refs<Deps>;
  generate(deps: Deps, ctx: Context): Out;
}

/** Base class for the built-in Gens. */
export abstract class BaseGen<Out, Deps = {}> implements Gen<Out, Deps> {
  constructor(
    readonly id: string | undefined,
    readonly deps: Refs<Deps>,
  ) {}

  abstract generate(deps: Deps, ctx: Context): Out;

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
