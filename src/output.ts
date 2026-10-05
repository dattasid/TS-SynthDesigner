import { GenerationError } from "./errors";
import type { Gen } from "./gen";
import { ArraySchema, ObjectSchema, OptionalSchema, TempSchema, type Output, type Schema } from "./schema";
import { TreeGen } from "./tree";

/**
 * The type of the records `preview` and `create` return for `gen`: a tree's `Output` (its schema's
 * type without `.temp()` fields), or any other Gen's value type.
 */
export type RecordOf<G> = G extends TreeGen<infer S> ? Output<S> : G extends Gen<infer T> ? T : never;

/**
 * What happens to each generated record on its way out: checked against the tree's schema (unless
 * `validate` is false), then its `.temp()` fields dropped. Records of a Gen that is not a tree pass
 * through unchanged.
 */
export function finisher(gen: Gen<unknown>, { validate = true }: { validate?: boolean } = {}): (record: unknown, index: number) => unknown {
  if (!(gen instanceof TreeGen)) return (record) => record;
  const schema: ObjectSchema<any> = gen.schema;
  return (record, index) => {
    if (validate) {
      const result = schema.validate(record);
      if (!result.ok) {
        const shown = result.issues.slice(0, 5).join("; ") + (result.issues.length > 5 ? `; and ${result.issues.length - 5} more` : "");
        throw new GenerationError(`record ${index} does not fit the schema: ${shown}.`);
      }
    }
    return dropTemps(record, schema);
  };
}

/** The value without `.temp()` fields, at every depth. Copies only the objects that have some, never changing `value`. */
export function dropTemps(value: unknown, schema: Schema<unknown>): unknown {
  if (value === null || value === undefined) return value;
  const s = unmarked(schema);
  if (!hasTemps(s)) return value;
  if (s instanceof ArraySchema) return Array.isArray(value) ? value.map((item) => dropTemps(item, s.items)) : value;
  if (!(s instanceof ObjectSchema) || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const field = s.fields[key] as Schema<unknown> | undefined;
    if (field instanceof TempSchema) continue;
    out[key] = field ? dropTemps(v, field) : v;
  }
  return out;
}

/** The schema under `.temp()` and `.optional()`. */
function unmarked(schema: Schema<unknown>): Schema<unknown> {
  const s = schema instanceof TempSchema ? schema.inner : schema;
  return s instanceof OptionalSchema ? s.inner : s;
}

const tempsCache = new WeakMap<Schema<unknown>, boolean>();

/** Whether a `.temp()` field is anywhere inside (objects and list items). */
function hasTemps(schema: Schema<unknown>): boolean {
  let found = tempsCache.get(schema);
  if (found === undefined) {
    const s = unmarked(schema);
    found =
      s instanceof ObjectSchema
        ? Object.values(s.fields as Record<string, Schema<unknown>>).some((f) => f instanceof TempSchema || hasTemps(f))
        : s instanceof ArraySchema
          ? hasTemps(s.items)
          : false;
    tempsCache.set(schema, found);
  }
  return found;
}
