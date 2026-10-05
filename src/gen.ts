import type { Context } from "./context";
import { ConfigError } from "./errors";
import { ObjectSchema, type Infer } from "./schema";

/**
 * Where a ref's path starts:
 * - `self`: the object that holds the field (siblings).
 * - `parent`: the object that contains that object.
 * - `root`: the top-level record.
 */
export type RefScope = "self" | "parent" | "root";

/** Where a ref points, at runtime. */
export interface RefTarget {
  readonly scope: RefScope;
  readonly path: readonly string[];
  /**
   * The object schema the ref was made from (`refs(Customer)`). The plan checks it is the schema of
   * the object the scope resolves to, so refs cannot silently read the wrong object.
   */
  readonly schema: ObjectSchema<any>;
  /** Made by `traceOf`: the ref reads the field's trace instead of its value. */
  readonly trace?: true;
}

/** Key of a ref's runtime data. A symbol, so every plain name stays free for fields. */
const REF_TARGET = Symbol("tdd.ref");
/** Type-only key for the phantom value type. Never exists at runtime. */
declare const REF_VALUE: unique symbol;

/**
 * A typed pointer to a value in the record being generated. At runtime it is a scope and a path of
 * keys; at compile time it also carries the value's type, so `Ref<number>` and `Ref<string>` differ.
 * When the plan is compiled, every ref is resolved to an absolute path from the root.
 */
export interface Ref<V> {
  readonly [REF_VALUE]?: V;
}

/**
 * A ref that can also be navigated by property access: `p.education.city` is a `RefTree` for
 * `city`, and a `Ref<string>` wherever a ref is expected. Autocompletes, and a misspelled key is an
 * ordinary "property does not exist" error. Values that are not objects cannot be navigated further.
 */
export type RefTree<T> = Ref<T> &
  (NonNullable<T> extends object
    ? // Through an optional object, every field below may be missing too: `p.specs.weight` is a
      // Ref<number | undefined> when `specs` is optional.
      { readonly [K in keyof NonNullable<T> & string]-?: RefTree<NonNullable<T>[K] | Extract<T, null | undefined>> }
    : {});

/** The scope and path of a ref, or undefined if `value` is not a ref. */
export function refTarget(value: unknown): RefTarget | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  return (value as { [REF_TARGET]?: RefTarget })[REF_TARGET];
}

/** For error messages: `root.education.city`, `self.city`, `parent.country`. */
export function showRef(ref: unknown): string {
  const target = refTarget(ref);
  if (!target) return String(ref);
  const path = [target.scope, ...target.path].join(".");
  return target.trace ? `traceOf(${path})` : path;
}

function makeRef(scope: RefScope, path: readonly string[], schema: ObjectSchema<any>): unknown {
  const target: RefTarget = Object.freeze({ scope, path: Object.freeze([...path]), schema });
  const children = new Map<string, unknown>();
  // Each property access returns the ref one key deeper. Only refs are made here, while trees are
  // set up; the plan resolves them to paths once, so the Proxy costs nothing per record.
  const proxy: object = new Proxy(Object.create(null) as object, {
    get(_, key) {
      if (key === REF_TARGET) return target;
      // `${ref}` in a plain template string would silently become garbage text; say what to do instead.
      if (key === Symbol.toPrimitive) return () => {
        throw new ConfigError(`${showRef(proxy)} is a ref, not a value, so it has no text. In a prompt, use the prompt\`...\` tag.`);
      };
      if (typeof key === "symbol") return undefined;
      let child = children.get(key);
      if (!child) children.set(key, (child = makeRef(scope, [...path, key], schema)));
      return child;
    },
    set() {
      return false; // refs are read-only
    },
  });
  return proxy;
}

/**
 * Whether a ref made from `target.schema` may read `object`, a tree's schema: its first key must be
 * the very same field schema there. The same schema, or one extended by spreading it
 * (`s.object({ ...Customer.fields, email: s.string() })`), passes; another object does not.
 */
export function refFits(target: RefTarget, object: ObjectSchema<any>): boolean {
  if (target.schema === object) return true;
  const key = target.path[0];
  return key !== undefined && Object.hasOwn(object.fields, key) && object.fields[key] === target.schema.fields[key];
}

function checkSchema(fn: string, schema: unknown): void {
  if (!(schema instanceof ObjectSchema)) {
    throw new ConfigError(`${fn}() takes the object schema of the tree it reads, e.g. ${fn}(Person) with const Person = s.object({...}).`);
  }
}

/**
 * Refs to siblings: fields of the object that holds the field being bound, whose schema is `schema`.
 *
 *     const p = refs(Person);
 *     city: cityGen.bind({ category: p.country })
 *
 * Typed by the schema, so a typo is a compile error. The plan checks the holding tree's schema is
 * this very object, so the refs cannot silently read another tree's fields.
 */
export function refs<S extends ObjectSchema<any>>(schema: S): RefTree<Infer<S>> {
  checkSchema("refs", schema);
  return makeRef("self", [], schema) as RefTree<Infer<S>>;
}

/** Refs into the object one level up from the one holding the field: the tree whose schema is `schema`. */
export function parentRefs<S extends ObjectSchema<any>>(schema: S): RefTree<Infer<S>> {
  checkSchema("parentRefs", schema);
  return makeRef("parent", [], schema) as RefTree<Infer<S>>;
}

/**
 * Refs into the top-level record, from any depth: every ref is a path from the top. With one root
 * type, using these everywhere is simplest.
 *
 *     const p = rootRefs(Person);
 *     univCity: cityGen.bind({ category: p.country })   // inside person.education
 *
 * The plan checks the root tree's schema is `schema`, so a tree using these refs cannot be nested in
 * another tree by mistake. Refs from the same schema are interchangeable: helpers in other files can
 * make their own. For trees meant to be nested, use `refs` / `parentRefs`.
 */
export function rootRefs<S extends ObjectSchema<any>>(schema: S): RefTree<Infer<S>> {
  checkSchema("rootRefs", schema);
  return makeRef("root", [], schema) as RefTree<Infer<S>>;
}

/**
 * What a Gen noted about a value while making it, besides the value: e.g. the reasoning an LLM sent
 * separately from its reply. Read by other fields through `traceOf(ref)`.
 */
export interface Trace {
  /** The model's reasoning (thinking) text, from providers that send it apart from the reply. */
  reasoning?: string;
}

/**
 * A ref to a field's trace instead of its value: what its Gen noted while making it (see `Trace`).
 * Reading it orders the reader after the field, like any ref. A Gen that notes nothing gives `{}`.
 *
 *     bioReasoning: CustomGen.bound({ inputs: { t: traceOf(p.bio) }, fn: ({ t }) => t.reasoning })
 *
 * (`reasoningOf(p.bio)` is that Gen.) Only the Gens of traced fields record anything, so tracing costs
 * nothing elsewhere.
 */
export function traceOf(ref: Ref<unknown>): Ref<Trace> {
  const target = refTarget(ref);
  if (!target || target.trace) throw new ConfigError(`traceOf takes a ref to a field, e.g. traceOf(p.bio); got ${showRef(ref)}.`);
  if (target.path.length === 0) throw new ConfigError(`traceOf takes a ref to a field, not a whole ${target.scope} object.`);
  return Object.freeze({ [REF_TARGET]: Object.freeze({ ...target, trace: true as const }) }) as Ref<Trace>;
}

/** One `Ref<V>` per input `V`: what `bind()` takes. */
export type Refs<Inputs> = { readonly [K in keyof Inputs]: Ref<Inputs[K]> };

/**
 * A value, or a Promise of one. Only Gens that wait on something slow (an LLM, an HTTP call) return
 * Promises; number and category Gens stay plain synchronous code. The plan awaits only when needed.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * A generator of values of type `Out`.
 *
 * `Inputs` are named, typed slots for values the Gen needs from other fields (e.g. SubCategory's
 * `category`). The Gen does not know which fields feed them; the tree field decides, with `bind()`.
 * So one Gen can be reused with different fields feeding its inputs.
 */
export interface Gen<Out, Inputs = {}> {
  readonly id: string | undefined;
  /**
   * The names of `Inputs`, at runtime (types are erased). Lets `bind()` and the plan catch missing or
   * unknown inputs from plain JavaScript or casts. `undefined` means not declared: nothing is checked.
   */
  readonly inputNames?: readonly string[];
  /**
   * Produces one value. May return a Promise; if it does, draw all randomness from `ctx` before the
   * first `await`, so the draws happen in row order (see Plan) and the data stays reproducible.
   */
  generate(inputs: Inputs, ctx: Context): MaybePromise<Out>;
  /**
   * Optional. Called once before anything is generated, to check the Gen against the context, e.g.
   * that an LLM Gen's model nickname exists. Throws a ConfigError if not.
   */
  checkContext?(ctx: Context): void;
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

  /** See `Gen.inputNames`. Subclasses with inputs override this; the default is "not declared". */
  get inputNames(): readonly string[] | undefined {
    return undefined;
  }

  abstract generate(inputs: Inputs, ctx: Context): MaybePromise<Out>;

  /**
   * Decides which fields feed this Gen's inputs. Each ref's type must fit its input's type.
   *
   *     city: cityGen.bind({ category: person.country })
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
    const declared = gen.inputNames;
    if (declared) {
      const given = Object.keys(refs);
      const missing = declared.filter((n) => !given.includes(n));
      const unknown = given.filter((n) => !declared.includes(n));
      this.check(missing.length === 0, `missing inputs: ${missing.join(", ")}.`);
      this.check(unknown.length === 0, `unknown inputs: ${unknown.join(", ")}. Inputs: ${declared.join(", ") || "none"}.`);
    }
    for (const [input, ref] of Object.entries(refs)) {
      const target = refTarget(ref);
      this.check(target !== undefined, `input '${input}' must be a ref, e.g. rootRefs(Person).country.`);
      this.check(target!.path.length > 0, `input '${input}' is a whole ${target!.scope} object; bind a field of it instead.`);
    }
  }

  /** A bound Gen has no inputs left. */
  override get inputNames(): readonly string[] {
    return [];
  }

  protected override describe(): string {
    const inner = this.gen instanceof BaseGen ? this.gen.constructor.name : "Gen";
    return this.id === undefined ? `bound ${inner}` : `bound ${inner} '${this.id}'`;
  }

  generate(_inputs: {}, _ctx: Context): Out {
    throw new ConfigError(`${this.describe()}: a bound Gen reads other fields, so it only runs as a field of a TreeGen.`);
  }
}
