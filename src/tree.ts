import type { Context } from "./context";
import { ConfigError } from "./errors";
import { BaseGen, type Gen } from "./gen";

/**
 * One Gen per key of `T`, whose output type matches that key's type.
 * A missing key, an extra key, or a Gen of the wrong type is a compile error.
 */
export type Fields<T> = { [K in keyof T]-?: Gen<T[K], any> };

export interface TreeGenParams<T> {
  id?: string;
  fields: Fields<T>;
}

/**
 * Generates objects of type `T`, one field at a time.
 *
 * Fields may be declared in any order: each field's deps come from the refs its Gen holds, and fields
 * are generated after the fields they depend on. The output keeps the declaration order.
 * A TreeGen is itself a Gen, so it can be used as a field of another tree.
 */
export class TreeGen<T extends object> extends BaseGen<T> {
  readonly fields: Fields<T>;
  /** Field names in generation order (dependencies first). */
  readonly order: readonly string[];

  constructor({ id, fields }: TreeGenParams<T>) {
    super(id, {});
    this.fields = fields;
    this.order = this.sortFields();
  }

  generate(_deps: {}, ctx: Context): T {
    const fields = this.fields as Record<string, Gen<unknown, Record<string, unknown>>>;
    const values: Record<string, unknown> = {};
    for (const name of this.order) {
      const gen = fields[name]!;
      const depValues: Record<string, unknown> = {};
      for (const [depName, ref] of Object.entries(gen.deps)) depValues[depName] = values[ref.path];
      values[name] = gen.generate(depValues, ctx.child(name));
    }
    const record: Record<string, unknown> = {};
    for (const name of Object.keys(fields)) record[name] = values[name];
    return record as T;
  }

  /** Kahn's topological sort. Ties keep declaration order, so the order is stable and readable. */
  private sortFields(): string[] {
    const fields = this.fields as Record<string, Gen<unknown, Record<string, unknown>>>;
    const names = Object.keys(fields);
    this.check(names.length > 0, "fields must not be empty.");

    const dependsOn = new Map<string, Set<string>>();
    for (const name of names) {
      const gen = fields[name];
      this.check(gen !== undefined && typeof gen.generate === "function", `field '${name}' is not a Gen.`);
      const targets = new Set<string>();
      for (const [depName, ref] of Object.entries(gen!.deps)) {
        this.check(
          Object.hasOwn(fields, ref.path),
          `field '${name}' depends on '${ref.path}' (via '${depName}'), which is not a field of this tree. ` +
            `Fields: ${names.join(", ")}.`,
        );
        this.check(ref.path !== name, `field '${name}' depends on itself.`);
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
