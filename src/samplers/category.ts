import type { Context } from "../context";
import { WeightedTable } from "../distributions";
import { GenerationError } from "../errors";
import { BaseGen, type Ref } from "../gen";

/**
 * Either a map of value to weight (`{ doctor: 2, lawyer: 1 }`), or a list of values with equal weights.
 * Weights are relative and need not sum to 1. A weight of 0 means the value is never picked.
 */
export type CategoryValues<V extends string> = Readonly<Record<V, number>> | readonly V[];

export interface CategorySamplerParams<V extends string> {
  id?: string;
  values: CategoryValues<V>;
}

/** Picks one of `values`, by weight. */
export class CategorySamplerGen<V extends string> extends BaseGen<V> {
  readonly values: CategoryValues<V>;
  private readonly table: WeightedTable<V>;

  constructor({ id, values }: CategorySamplerParams<V>) {
    super(id, {});
    this.values = values;
    this.table = buildTable(values, (message) => this.check(false, message));
  }

  generate(_deps: {}, ctx: Context): V {
    return this.table.pick(ctx.rng);
  }
}

export interface SubCategorySamplerParams<P extends string, V extends string> {
  id?: string;
  /** The field whose value selects the list to pick from, e.g. `ref("country")`. */
  parent: Ref<P>;
  /**
   * For each parent value, the values to pick from. When the parent field is a union of literals
   * (`"Canada" | "France"`), a missing or misspelled key is a compile error.
   */
  values: Readonly<Record<NoInfer<P>, CategoryValues<V>>>;
}

/** Picks a value from the list for the parent field's value, e.g. a city within the chosen country. */
export class SubCategorySamplerGen<P extends string, V extends string> extends BaseGen<V, { parent: P }> {
  readonly values: Readonly<Record<P, CategoryValues<V>>>;
  private readonly tables = new Map<string, WeightedTable<V>>();

  constructor({ id, parent, values }: SubCategorySamplerParams<P, V>) {
    super(id, { parent });
    this.values = values;
    const entries = Object.entries(values) as [string, CategoryValues<V>][];
    this.check(entries.length > 0, "values must have at least one parent value.");
    for (const [parentValue, childValues] of entries) {
      const table = buildTable(childValues, (message) => this.check(false, `for parent value '${parentValue}': ${message}`));
      this.tables.set(parentValue, table);
    }
  }

  generate({ parent }: { parent: P }, ctx: Context): V {
    const table = this.tables.get(parent);
    if (!table) {
      throw new GenerationError(
        `${this.describe()} at ${ctx.pathString}: parent value '${parent}' has no entry in values. ` +
          `Known parent values: ${[...this.tables.keys()].join(", ")}.`,
      );
    }
    return table.pick(ctx.rng);
  }
}

function buildTable<V extends string>(values: CategoryValues<V>, fail: (message: string) => void): WeightedTable<V> {
  const entries: [V, number][] = Array.isArray(values)
    ? (values as readonly V[]).map((v) => [v, 1])
    : (Object.entries(values) as [V, number][]);
  if (entries.length === 0) fail("values must not be empty.");
  if (Array.isArray(values) && new Set(values).size !== values.length) fail("values must not contain duplicates.");
  for (const [value, weight] of entries) {
    if (!Number.isFinite(weight) || weight < 0) fail(`weight of '${value}' must be finite and >= 0, got ${weight}.`);
  }
  if (!entries.some(([, weight]) => weight > 0)) fail("at least one weight must be > 0.");
  return new WeightedTable(
    entries.map(([value]) => value),
    entries.map(([, weight]) => weight),
  );
}
