import type { Context } from "./context";
import { ConfigError } from "./errors";

/**
 * Where a ref's path starts:
 * - `self`: the object that holds the field (siblings).
 * - `parent`: the object that contains that object.
 * - `root`: the top-level record.
 */
export type RefScope = "self" | "parent" | "root";

/**
 * A typed pointer to a value in the record being generated.
 * At runtime it is a scope and a path of keys; at compile time it also carries the value's type.
 * When the plan is compiled, every ref is resolved to an absolute path from the root.
 */
export class Ref<V> {
  /** Phantom: never set at runtime. It is what makes `Ref<number>` and `Ref<string>` incompatible. */
  declare readonly __value?: V;

  constructor(
    readonly scope: RefScope,
    readonly path: readonly string[],
  ) {}

  toString(): string {
    return `${this.scope}.${this.path.join(".")}`;
  }
}

type Key<T> = keyof NonNullable<T> & string;
type At<T, K extends PropertyKey> = NonNullable<T>[K & keyof NonNullable<T>];

/** Makes typed refs into objects of type `T`, one to three keys deep. A key that does not exist is a compile error. */
export interface RefFactory<T> {
  <K1 extends Key<T>>(k1: K1): Ref<At<T, K1>>;
  <K1 extends Key<T>, K2 extends Key<At<T, K1>>>(k1: K1, k2: K2): Ref<At<At<T, K1>, K2>>;
  <K1 extends Key<T>, K2 extends Key<At<T, K1>>, K3 extends Key<At<At<T, K1>, K2>>>(
    k1: K1,
    k2: K2,
    k3: K3,
  ): Ref<At<At<At<T, K1>, K2>, K3>>;
}

function refFactory<T>(scope: RefScope): RefFactory<T> {
  return ((...path: string[]) => new Ref(scope, path)) as RefFactory<T>;
}

/**
 * Refs to siblings: fields of the object `T` that holds the field being bound.
 *
 *     const person = refs<Person>();
 *     city: cityGen.bind({ category: person("country") })
 */
export function refs<T>(): RefFactory<T> {
  return refFactory<T>("self");
}

/** Refs into `T`, the object that contains the object holding the field being bound (one level up). */
export function parentRefs<T>(): RefFactory<T> {
  return refFactory<T>("parent");
}

/**
 * Refs into `T`, the top-level record, from any depth.
 *
 *     const root = rootRefs<Person>();
 *     univCity: cityGen.bind({ category: root("country") })   // inside person.education
 */
export function rootRefs<T>(): RefFactory<T> {
  return refFactory<T>("root");
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
      this.check(
        ref instanceof Ref && ref.path.length > 0,
        `input '${input}' must be a Ref, e.g. refs<Person>()("country").`,
      );
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
