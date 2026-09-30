import type { Context } from "./context";
import { ConfigError } from "./errors";
import { BaseGen, BoundGen, refTarget, showRef, type Gen, type Ref } from "./gen";
import { Plan } from "./plan";

/**
 * One Gen per key of `T`, whose output type matches that key's type.
 * A missing required key, an extra key, a Gen of the wrong type, or a Gen whose inputs are not
 * bound is a compile error. Optional keys of `T` (`middleName?: string`) may be left out.
 */
export type Fields<T> = { [K in keyof T]: Gen<T[K]> };

export interface TreeGenParams<T> {
  id?: string;
  fields: Fields<T>;
}

export interface TreeCloneParams<T> {
  /** Defaults to the original's id. */
  id?: string;
  /** Gens to replace. Every other field keeps the original's Gen. */
  fields?: Partial<Fields<T>>;
}

export interface TreeBuilderParams<T> {
  id?: string;
  /**
   * Keys that must have a Gen by `build()`. Optional: types are erased at runtime, so without this
   * list the builder cannot know which keys `T` has, and a missing field just won't appear in records.
   */
  requiredKeys?: readonly (keyof T & string)[];
}

type AnyGen = Gen<unknown, any>;

/**
 * Describes objects of type `T`: one Gen per field. A TreeGen is itself a Gen, so it can be a field
 * of another tree.
 *
 * It holds structure only. Generation is done by a `Plan`, which flattens the whole tree and orders
 * every field after the fields it reads. Fields may be declared in any order; the output keeps the
 * declaration order.
 */
export class TreeGen<T extends object> extends BaseGen<T> {
  readonly fields: Fields<T>;
  private plan: Plan<T> | undefined;

  constructor({ id, fields }: TreeGenParams<T>) {
    super(id);
    this.fields = fields;
    // Early errors: unknown refs and cycles among this tree's own fields. The plan checks the whole tree again.
    this.checkFields();
  }

  /**
   * A copy of this tree with some Gens replaced. Since it starts from a complete tree, it stays complete.
   *
   *     const kids = person.clone({ fields: { age: kidAgeGen } });
   */
  clone({ id = this.id, fields = {} }: TreeCloneParams<T> = {}): TreeGen<T> {
    return new TreeGen<T>({ id, fields: { ...this.fields, ...fields } as Fields<T> });
  }

  /**
   * A step-by-step alternative to the `fields` object, for loops, conditionals, or fields added later.
   * Each `field()` call is still type-checked (the key must exist in `T`, the Gen must produce
   * `T[key]`, inputs must be bound), but completeness is not checked at compile time.
   */
  static builder<T extends object>(params: TreeBuilderParams<T> = {}): TreeBuilder<T> {
    return new TreeBuilder<T>(params);
  }

  /** Generates one object, running this tree's plan (compiled on first use, then reused). */
  generate(_inputs: {}, ctx: Context): T {
    this.plan ??= Plan.compile<T>(this);
    return this.plan.run(ctx);
  }

  private checkFields(): void {
    const fields = this.fields as Record<string, AnyGen | undefined>;
    const names = Object.keys(fields).filter((n) => fields[n] !== undefined);
    this.check(names.length > 0, "fields must not be empty.");

    const dependsOn = new Map<string, Set<string>>();
    for (const name of names) {
      const gen = fields[name];
      this.check(typeof gen?.generate === "function", `field '${name}' is not a Gen.`);
      const refs: Readonly<Record<string, Ref<unknown>>> = gen instanceof BoundGen ? gen.refs : {};
      const targets = new Set<string>();
      for (const [input, ref] of Object.entries(refs)) {
        // Only sibling refs can be checked here; parent and root refs depend on where the tree is placed,
        // so the plan checks them.
        const { scope, path } = refTarget(ref)!;
        if (scope !== "self") continue;
        const target = path[0]!;
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
export class TreeBuilder<T extends object> {
  private readonly fields: Partial<Fields<T>> = {};

  constructor(private readonly params: TreeBuilderParams<T>) {}

  /** Adds a field. Adding the same name twice throws; use `TreeGen.clone()` to replace a Gen. */
  field<K extends keyof T & string>({ name, gen }: { name: K; gen: Gen<T[K]> }): this {
    if (Object.hasOwn(this.fields, name)) {
      throw new ConfigError(`${this.describe()}: field '${name}' was already added.`);
    }
    this.fields[name] = gen as Fields<T>[K];
    return this;
  }

  /** Builds the TreeGen. Refs and cycles are checked here, and `requiredKeys` if given. */
  build(): TreeGen<T> {
    const missing = (this.params.requiredKeys ?? []).filter((k) => !Object.hasOwn(this.fields, k));
    if (missing.length > 0) throw new ConfigError(`${this.describe()}: missing fields: ${missing.join(", ")}.`);
    return new TreeGen<T>({ id: this.params.id, fields: this.fields as Fields<T> });
  }

  private describe(): string {
    return this.params.id === undefined ? "TreeBuilder" : `TreeBuilder '${this.params.id}'`;
  }
}
