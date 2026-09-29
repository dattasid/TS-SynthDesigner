import type { Context } from "./context";
import { BaseGen, BoundGen, type Gen, type Ref } from "./gen";
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
        this.check(
          names.includes(ref.path),
          `field '${name}' reads '${ref.path}' (input '${input}'), which is not a field of this tree. ` +
            `Fields: ${names.join(", ")}.`,
        );
        this.check(ref.path !== name, `field '${name}' reads itself.`);
        targets.add(ref.path);
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
