import type { Context } from "./context";
import { BaseGen, BoundGen, type Gen, type Ref } from "./gen";

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
 * Generates objects of type `T`, one field at a time.
 *
 * Fields may be declared in any order: a field whose Gen is bound to other fields (`bind()`) is
 * generated after them. The output keeps the declaration order.
 * A TreeGen is itself a Gen, so it can be used as a field of another tree.
 */
export class TreeGen<T extends object> extends BaseGen<T> {
  readonly fields: Fields<T>;
  /** Field names in generation order (dependencies first). */
  readonly order: readonly string[];

  constructor({ id, fields }: TreeGenParams<T>) {
    super(id);
    this.fields = fields;
    this.order = this.sortFields();
  }

  /**
   * A copy of this tree with some Gens replaced. Since it starts from a complete tree, it stays complete.
   *
   *     const kids = person.clone({ fields: { age: kidAgeGen } });
   */
  clone({ id = this.id, fields = {} }: TreeCloneParams<T> = {}): TreeGen<T> {
    return new TreeGen<T>({ id, fields: { ...this.fields, ...fields } as Fields<T> });
  }

  generate(_inputs: {}, ctx: Context): T {
    const fields = this.fields as Record<string, AnyGen>;
    const values: Record<string, unknown> = {};
    for (const name of this.order) {
      const gen = fields[name]!;
      const fieldCtx = ctx.child(name);
      if (gen instanceof BoundGen) {
        const inputs: Record<string, unknown> = {};
        for (const [input, ref] of Object.entries(gen.refs)) inputs[input] = values[ref.path];
        values[name] = gen.gen.generate(inputs, fieldCtx);
      } else {
        values[name] = gen.generate({}, fieldCtx);
      }
    }
    const record: Record<string, unknown> = {};
    for (const name of Object.keys(fields)) if (name in values) record[name] = values[name];
    return record as T;
  }

  /** Kahn's topological sort. Ties keep declaration order, so the order is stable and readable. */
  private sortFields(): string[] {
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

    const order: string[] = [];
    const done = new Set<string>();
    while (order.length < names.length) {
      const ready = names.find((n) => !done.has(n) && [...dependsOn.get(n)!].every((d) => done.has(d)));
      if (ready === undefined) {
        const stuck = names.filter((n) => !done.has(n));
        this.check(false, `dependency cycle among fields: ${stuck.join(", ")}.`);
      }
      order.push(ready!);
      done.add(ready!);
    }
    return order;
  }
}
