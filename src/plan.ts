import type { Context } from "./context";
import { ConfigError } from "./errors";
import { BoundGen, type Gen } from "./gen";
import { TreeGen } from "./tree";

type AnyGen = Gen<unknown, any>;
type Path = readonly string[];

/** An object in the record: the root, or a nested TreeGen's object. Created up front, filled in later. */
interface ObjectSlot {
  path: Path;
  /** Every key in declaration order, set to undefined. Copying it gives each record the same V8 shape. */
  template: Readonly<Record<string, undefined>>;
  /** Index of the containing object in the plan's object list; -1 for the root. */
  parent: number;
  /** Key in the containing object. */
  key: string;
}

/** A field with a Gen that produces a value (anything but a nested TreeGen). */
interface Step {
  path: Path;
  gen: AnyGen;
  /** Input name -> absolute path of the value that feeds it. */
  inputs: readonly (readonly [string, Path])[];
  /** Index of the object the value is stored in. */
  object: number;
  key: string;
}

const show = (path: Path) => (path.length === 0 ? "<root>" : path.join("."));
const startsWith = (path: Path, prefix: Path) => prefix.every((p, i) => path[i] === p);

/**
 * A compiled generation plan: every field of every nested tree flattened into one list of steps,
 * sorted so each step comes after the values it reads.
 *
 * Built once from the tree structure and reused for every record. Per record, `run()` creates the
 * empty (pre-shaped) objects and fills them in step order, so several partial objects exist at once
 * and a step can read any value generated before it, anywhere in the record.
 */
export class Plan<T> {
  /** Absolute paths of the steps, in the order they run. For inspection and tests. */
  readonly order: readonly string[];
  private readonly objects: readonly ObjectSlot[];
  private readonly steps: readonly Step[];
  private readonly single: AnyGen | undefined;

  private constructor(objects: ObjectSlot[], steps: Step[], single: AnyGen | undefined) {
    this.objects = objects;
    this.steps = steps;
    this.single = single;
    this.order = single ? ["<root>"] : steps.map((s) => show(s.path));
  }

  /** Compiles the plan for `gen`. A TreeGen is flattened; any other Gen is a single step. */
  static compile<T>(gen: Gen<T>): Plan<T> {
    if (gen instanceof BoundGen) {
      throw new ConfigError("A bound Gen reads other fields, so it only runs as a field of a TreeGen.");
    }
    if (!(gen instanceof TreeGen)) return new Plan<T>([], [], gen as AnyGen);

    const objects: ObjectSlot[] = [];
    const steps: Step[] = [];
    flatten(gen, [], -1, "", objects, steps);
    return new Plan<T>(objects, sortSteps(steps), undefined);
  }

  /** Generates one record. */
  run(ctx: Context): T {
    if (this.single) return this.single.generate({}, ctx) as T;

    const objects: Record<string, unknown>[] = [];
    for (const slot of this.objects) {
      const obj = { ...slot.template } as Record<string, unknown>;
      if (slot.parent >= 0) objects[slot.parent]![slot.key] = obj;
      objects.push(obj);
    }
    const root = objects[0]!;
    for (const step of this.steps) {
      const inputs: Record<string, unknown> = {};
      for (const [name, path] of step.inputs) inputs[name] = read(root, path);
      objects[step.object]![step.key] = step.gen.generate(inputs, contextFor(ctx, step.path));
    }
    return root as T;
  }
}

/** Walks a tree depth-first, collecting object slots (parents first) and steps (declaration order). */
function flatten(tree: TreeGen<object>, path: Path, parent: number, key: string, objects: ObjectSlot[], steps: Step[]): void {
  const fields = tree.fields as Record<string, AnyGen | undefined>;
  const names = Object.keys(fields).filter((n) => fields[n] !== undefined);
  const index = objects.length;
  objects.push({ path, template: Object.fromEntries(names.map((n) => [n, undefined])), parent, key });

  for (const name of names) {
    const gen = fields[name]!;
    const fieldPath = [...path, name];
    if (gen instanceof TreeGen) {
      flatten(gen, fieldPath, index, name, objects, steps);
    } else if (gen instanceof BoundGen) {
      // Refs are relative to the tree that holds the field (siblings), so prefix the tree's path.
      const inputs = Object.entries(gen.refs).map(([input, ref]) => [input, [...path, ref.path]] as const);
      steps.push({ path: fieldPath, gen: gen.gen, inputs, object: index, key: name });
    } else {
      steps.push({ path: fieldPath, gen, inputs: [], object: index, key: name });
    }
  }
}

/**
 * Kahn's topological sort over all steps. A step reading a path depends on every step at or under
 * that path (reading a whole nested object waits for all of its fields). Ties keep declaration order.
 */
function sortSteps(steps: Step[]): Step[] {
  const dependsOn = steps.map((step) => {
    const deps = new Set<number>();
    for (const [input, path] of step.inputs) {
      const producers = steps.flatMap((s, i) => (startsWith(s.path, path) ? [i] : []));
      if (producers.length === 0) {
        throw new ConfigError(`field '${show(step.path)}' reads '${show(path)}' (input '${input}'), which no field generates.`);
      }
      for (const p of producers) deps.add(p);
    }
    return deps;
  });

  const order: Step[] = [];
  const done = new Set<number>();
  while (order.length < steps.length) {
    const ready = steps.findIndex((_, i) => !done.has(i) && [...dependsOn[i]!].every((d) => done.has(d)));
    if (ready < 0) {
      const stuck = steps.flatMap((s, i) => (done.has(i) ? [] : [show(s.path)]));
      throw new ConfigError(`dependency cycle among fields: ${stuck.join(", ")}.`);
    }
    order.push(steps[ready]!);
    done.add(ready);
  }
  return order;
}

function read(root: Record<string, unknown>, path: Path): unknown {
  let value: unknown = root;
  for (const key of path) value = (value as Record<string, unknown>)[key];
  return value;
}

/** The per-path RNG stream: the same fork chain the path always gets, so values do not depend on step order. */
function contextFor(ctx: Context, path: Path): Context {
  let c = ctx;
  for (const key of path) c = c.child(key);
  return c;
}
