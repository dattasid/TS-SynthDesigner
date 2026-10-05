import type { Context } from "./context";
import { ConfigError } from "./errors";
import { BaseGen, BoundGen, refFits, refTarget, showRef, type Gen, type MaybePromise, type Ref } from "./gen";
import { Plan } from "./plan";
import { ObjectSchema, OptionalSchema, TempSchema, type Infer, type Schema } from "./schema";

/**
 * One Gen per key of `T`, whose output type matches that key's type.
 * A missing required key, an extra key, a Gen of the wrong type, or a Gen whose inputs are not
 * bound is a compile error. Optional keys of `T` (`middleName?: string`) may be left out.
 */
export type Fields<T> = { [K in keyof T]: Gen<T[K]> };

/** Any object schema: what a TreeGen is made from. */
export type AnyObjectSchema = ObjectSchema<any>;

export interface TreeGenParams<S extends AnyObjectSchema> {
  id?: string;
  /** The data model: `s.object({...})`. Its type is what `fields` must match, and what refs see. */
  schema: S;
  /** One Gen per schema key (optional keys may be left out). */
  fields: Fields<Infer<S>>;
}

export interface TreeCloneParams<S extends AnyObjectSchema> {
  /** Defaults to the original's id. */
  id?: string;
  /** Gens to replace. Every other field keeps the original's Gen. */
  fields?: Partial<Fields<Infer<S>>>;
}

export interface TreeBuilderParams<S extends AnyObjectSchema> {
  id?: string;
  schema: S;
}

/** The schema under `.temp()` and `.optional()`: what a field's value must fit. */
export function fieldSchema(schema: Schema<unknown>): Schema<unknown> {
  const unmarked = schema instanceof TempSchema ? schema.inner : schema;
  return unmarked instanceof OptionalSchema ? unmarked.inner : unmarked;
}

type AnyGen = Gen<unknown, any>;

/** Throws via `fail` if `gen` declares inputs but is used without `bind()`. */
export function checkBound(gen: AnyGen, where: string, fail: (message: string) => void): void {
  if (gen instanceof BoundGen || gen instanceof TreeGen) return;
  const needs = gen.inputNames ?? [];
  if (needs.length > 0) {
    fail(`${where} needs inputs (${needs.join(", ")}) but is not bound. Use .bind({ ${needs.map((n) => `${n}: ...`).join(", ")} }).`);
  }
}

/**
 * Makes objects of a schema's type: one Gen per field. A TreeGen is itself a Gen, so it can be a field
 * of another tree (whose schema has the same schema object at that key).
 *
 *     const Person = s.object({ name: s.string(), age: s.integer() });
 *     type Person = Infer<typeof Person>;
 *     const personGen = new TreeGen({ schema: Person, fields: { name: nameGen, age: ageGen } });
 *
 * It holds structure only. Generation is done by a `Plan`, which flattens the whole tree and orders
 * every field after the fields it reads. Fields may be declared in any order; the output keeps the
 * declaration order.
 */
export class TreeGen<S extends AnyObjectSchema> extends BaseGen<Infer<S>> {
  readonly schema: S;
  readonly fields: Fields<Infer<S>>;
  private plan: Plan<Infer<S>> | undefined;

  constructor({ id, schema, fields }: TreeGenParams<S>) {
    super(id);
    this.check(schema instanceof ObjectSchema, "schema must be an object schema, made with s.object({...}).");
    this.schema = schema;
    this.fields = fields;
    // Early errors: fields vs schema, unknown refs and cycles among this tree's own fields. The plan
    // checks the whole tree again.
    this.checkFields();
  }

  /**
   * A copy of this tree with some Gens replaced. Since it starts from a complete tree, it stays complete.
   *
   *     const kids = person.clone({ fields: { age: kidAgeGen } });
   */
  clone({ id = this.id, fields = {} }: TreeCloneParams<S> = {}): TreeGen<S> {
    return new TreeGen<S>({ id, schema: this.schema, fields: { ...this.fields, ...fields } as Fields<Infer<S>> });
  }

  /**
   * A step-by-step alternative to the `fields` object, for loops, conditionals, or fields added later.
   * Each `field()` call is type-checked (the key must be in the schema, the Gen must produce its
   * type, inputs must be bound); completeness is checked against the schema at `build()`.
   */
  static builder<S extends AnyObjectSchema>(params: TreeBuilderParams<S>): TreeBuilder<S> {
    return new TreeBuilder<S>(params);
  }

  /** Generates one object, running this tree's plan (compiled on first use, then reused). */
  generate(_inputs: {}, ctx: Context): MaybePromise<Infer<S>> {
    this.plan ??= Plan.compile<Infer<S>>(this);
    return this.plan.run(ctx);
  }

  private checkFields(): void {
    const fields = this.fields as Record<string, AnyGen | undefined>;
    const names = Object.keys(fields).filter((n) => fields[n] !== undefined);
    const schemaFields = this.schema.fields as Record<string, Schema<unknown>>;
    const keys = Object.keys(schemaFields);
    const unknown = names.filter((n) => !keys.includes(n));
    this.check(unknown.length === 0, `field '${unknown[0]}' is not in the schema. Schema keys: ${keys.join(", ")}.`);
    const optional = this.schema.optionalKeys;
    const missing = keys.filter((k) => !names.includes(k) && !optional.includes(k));
    this.check(missing.length === 0, `missing fields: ${missing.join(", ")}.`);

    const dependsOn = new Map<string, Set<string>>();
    for (const name of names) {
      const gen = fields[name];
      this.check(typeof gen?.generate === "function", `field '${name}' is not a Gen.`);
      checkBound(gen!, `field '${name}'`, (message) => this.check(false, message));
      if (gen instanceof TreeGen) {
        this.check(
          gen.schema === fieldSchema(schemaFields[name]!),
          `field '${name}' is a TreeGen made from another schema; its schema must be the very object at '${name}' in this tree's schema.`,
        );
      }
      const refs: Readonly<Record<string, Ref<unknown>>> = gen instanceof BoundGen ? gen.refs : {};
      const targets = new Set<string>();
      for (const [input, ref] of Object.entries(refs)) {
        // Only sibling refs can be checked here; parent and root refs depend on where the tree is placed,
        // so the plan checks them.
        const refAt = refTarget(ref)!;
        if (refAt.scope !== "self") continue;
        const target = refAt.path[0]!;
        // Unknown key first: a better message than "another schema" for a misspelled field.
        if (names.includes(target)) {
          this.check(
            refFits(refAt, this.schema),
            `field '${name}' reads '${showRef(ref)}' (input '${input}') with refs made from another schema; use refs() of this tree's schema.`,
          );
        }
        this.check(
          names.includes(target),
          `field '${name}' reads '${showRef(ref)}' (input '${input}'), but '${target}' is not a field of this tree. ` +
            `Fields: ${names.join(", ")}.`,
        );
        this.check(target !== name, `field '${name}' reads itself.`);
        targets.add(target);
      }
      dependsOn.set(name, targets);
    }

    const done = new Set<string>();
    while (done.size < names.length) {
      const ready = names.find((n) => !done.has(n) && [...dependsOn.get(n)!].every((d) => done.has(d)));
      if (ready === undefined) {
        const stuck = names.filter((n) => !done.has(n));
        this.check(false, `dependency cycle among fields: ${stuck.join(", ")}.`);
      }
      done.add(ready!);
    }
  }
}

/** Made by `TreeGen.builder()`. */
export class TreeBuilder<S extends AnyObjectSchema> {
  private readonly fields: Partial<Fields<Infer<S>>> = {};

  constructor(private readonly params: TreeBuilderParams<S>) {}

  /** Adds a field. Adding the same name twice throws; use `TreeGen.clone()` to replace a Gen. */
  field<K extends keyof Infer<S> & string>({ name, gen }: { name: K; gen: Gen<Infer<S>[K]> }): this {
    if (Object.hasOwn(this.fields, name)) {
      throw new ConfigError(`${this.describe()}: field '${name}' was already added.`);
    }
    this.fields[name] = gen as Fields<Infer<S>>[K];
    return this;
  }

  /** Builds the TreeGen. Missing fields (from the schema), refs and cycles are checked here. */
  build(): TreeGen<S> {
    return new TreeGen<S>({ id: this.params.id, schema: this.params.schema, fields: this.fields as Fields<Infer<S>> });
  }

  private describe(): string {
    return this.params.id === undefined ? "TreeBuilder" : `TreeBuilder '${this.params.id}'`;
  }
}
