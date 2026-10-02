import type { Context } from "./context";
import { ConfigError, GenerationError } from "./errors";
import { BoundGen, refTarget, showRef, type Gen, type MaybePromise, type Ref, type Trace } from "./gen";
import { checkBound, TreeGen } from "./tree";

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

/** An input of a step: its name, and the absolute path of the value (or, for `traceOf`, the trace) that feeds it. */
interface Input {
  name: string;
  path: Path;
  /** For `traceOf` inputs: the producer's trace slot (set after sorting). -1 for values. */
  trace: number;
}

/** A field with a Gen that produces a value (anything but a nested TreeGen). */
interface Step {
  path: Path;
  gen: AnyGen;
  inputs: readonly Input[];
  /** Index of the object the value is stored in. */
  object: number;
  key: string;
  /** Where this step's trace is kept per row, if some field reads it with `traceOf`; else -1. */
  traceSlot: number;
}

const show = (path: Path) => (path.length === 0 ? "<root>" : path.join("."));
const startsWith = (path: Path, prefix: Path) => prefix.every((p, i) => path[i] === p);

/**
 * A compiled generation plan: every field of every nested tree flattened into one list of steps,
 * sorted so each step comes after the values it reads.
 *
 * Built once from the tree structure and reused for every record. Records are generated in batches:
 * `runBatch()` creates the batch's empty (pre-shaped) objects, then runs the steps level by level,
 * each step for every row of the batch, in row order. Several partial objects exist at once, and a
 * step can read any value generated before it, anywhere in the record.
 *
 * Async Gens (LLMs, HTTP): a step may return Promises. They are not awaited one by one: the whole
 * level is started, then all its Promises are awaited together, so the slow calls of a level, across
 * all rows and fields, run in parallel. A level with no Promises never awaits, so a tree of sync Gens
 * runs as plain synchronous code.
 *
 * Reproducibility: each field has one random stream (see `contextFor`), shared by all rows. Every step
 * calls its Gen for rows 0, 1, 2... in order, so the draws happen in the same order on every run,
 * whatever the batch size and however long the async calls take. The rule for async Gens is to draw
 * before their first `await`. (Alternative, for out-of-order scheduling, resuming at row i or sharding:
 * a seed per row per field. Cheap if each seed feeds a small generator, e.g. sfc32 or xoshiro128**
 * seeded by hashing (seed, row, path); a Mersenne Twister per seed costs ~20 µs to set up. See Design.md.)
 */
export class Plan<T> {
  /** Absolute paths of the steps, in the order they run. For inspection and tests. */
  readonly order: readonly string[];
  private readonly objects: readonly ObjectSlot[];
  private readonly steps: readonly Step[];
  /** The steps grouped by level (see `levels()`), each level in run order. */
  private readonly stepLevels: readonly (readonly Step[])[];
  private readonly single: AnyGen | undefined;
  /** How many steps are read with `traceOf`. */
  private readonly traceCount: number;

  private constructor(objects: ObjectSlot[], steps: Step[], single: AnyGen | undefined) {
    this.objects = objects;
    this.steps = steps;
    this.traceCount = assignTraceSlots(steps);
    this.stepLevels = groupByLevel(steps);
    this.single = single;
    this.order = single ? ["<root>"] : steps.map((s) => show(s.path));
  }

  /** Compiles the plan for `gen`. A TreeGen is flattened; any other Gen is a single step. */
  static compile<T>(gen: Gen<T>): Plan<T> {
    // A bound Gen reading nothing (e.g. an LLMTextGen whose prompt has no refs) can run on its own.
    if (gen instanceof BoundGen && Object.keys(gen.refs).length === 0) return new Plan<T>([], [], gen.gen as AnyGen);
    if (gen instanceof BoundGen) {
      throw new ConfigError("A bound Gen reads other fields, so it only runs as a field of a TreeGen.");
    }
    if (!(gen instanceof TreeGen)) {
      checkBound(gen as AnyGen, "the Gen", (message) => {
        throw new ConfigError(message);
      });
      return new Plan<T>([], [], gen as AnyGen);
    }

    const objects: ObjectSlot[] = [];
    const steps: Step[] = [];
    flatten(gen, [], -1, "", objects, steps, { name: gen.id, from: gen.id === undefined ? undefined : "the root tree's id" });
    return new Plan<T>(objects, sortSteps(steps), undefined);
  }

  /**
   * The dependency graph, in run order: each step's path and, per input, the path it reads.
   * For inspection, printing and tests.
   */
  graph(): { path: string; reads: Record<string, string> }[] {
    if (this.single) return [{ path: "<root>", reads: {} }];
    return this.steps.map((s) => ({
      path: show(s.path),
      reads: Object.fromEntries(s.inputs.map((i) => [i.name, i.trace < 0 ? show(i.path) : `traceOf(${show(i.path)})`])),
    }));
  }

  /**
   * Steps grouped by level: level 0 reads nothing, and each other step sits one level above the
   * highest step it reads. Steps on the same level do not depend on each other, so they could run
   * together (e.g. batched LLM calls).
   */
  levels(): string[][] {
    if (this.single) return [["<root>"]];
    return this.stepLevels.map((level) => level.map((s) => show(s.path)));
  }

  /**
   * The plan as text, one level at a time, with what each step reads:
   *
   *     Level 1
   *       city            <- category=country
   *       occupation      <- age, country
   *
   * An input named like the last key of its path is shown by path only.
   */
  toText(): string {
    const reads = new Map(this.graph().map((g) => [g.path, g.reads]));
    const levels = this.levels();
    const width = Math.max(...levels.flat().map((p) => p.length)) + 2;
    const lines: string[] = [];
    levels.forEach((paths, i) => {
      lines.push(`Level ${i}`);
      for (const path of paths) {
        const inputs = Object.entries(reads.get(path)!).map(([input, from]) =>
          input === from.split(".").pop() ? from : `${input}=${from}`,
        );
        lines.push(`  ${inputs.length ? path.padEnd(width) + "<- " + inputs.join(", ") : path}`);
      }
    });
    return lines.join("\n");
  }

  /**
   * Checks every Gen against the context before anything is generated (e.g. LLM model nicknames),
   * so a typo fails before the first call is paid for.
   */
  checkContext(ctx: Context): void {
    const gens: [string, AnyGen][] = this.single ? [["<root>", this.single]] : this.steps.map((s) => [show(s.path), s.gen]);
    for (const [path, gen] of gens) {
      try {
        gen.checkContext?.(ctx);
      } catch (error) {
        if (error instanceof ConfigError) throw new ConfigError(`field '${path}': ${error.message}`);
        throw error;
      }
    }
  }

  /** Generates one record. A Promise if an async Gen was involved. */
  run(ctx: Context): MaybePromise<T> {
    const batch = this.runBatch(ctx, 1);
    return batch instanceof Promise ? batch.then((records) => records[0]!) : batch[0]!;
  }

  /**
   * Generates `count` records, level by level (see the class comment). Returns plain records if no
   * Gen returned a Promise, otherwise a Promise of them. With `sync: true`, a Promise is an error
   * naming the field, instead.
   */
  runBatch(ctx: Context, count: number, { sync = false }: { sync?: boolean } = {}): MaybePromise<T[]> {
    if (this.single) {
      const values = Array.from({ length: count }, () => this.single!.generate({}, ctx));
      if (!values.some(isPromise)) return values as T[];
      if (sync) asyncError("<root>", values);
      return Promise.all(values) as Promise<T[]>;
    }

    const rows: Record<string, unknown>[][] = [];
    const traces: Trace[][] = [];
    for (let r = 0; r < count; r++) {
      if (this.traceCount > 0) traces.push(Array.from({ length: this.traceCount }, () => ({})));
      const objects: Record<string, unknown>[] = [];
      for (const slot of this.objects) {
        const obj = { ...slot.template } as Record<string, unknown>;
        if (slot.parent >= 0) objects[slot.parent]![slot.key] = obj;
        objects.push(obj);
      }
      rows.push(objects);
    }
    return this.runLevels(rows, traces, ctx, 0, sync);
  }

  /**
   * Runs levels from `from` on; at the first level that started Promises, awaits them and continues.
   * `traces[row][slot]` holds the traces of the traced steps, filled through `ctx.trace()`.
   */
  private runLevels(rows: Record<string, unknown>[][], traces: Trace[][], ctx: Context, from: number, sync: boolean): MaybePromise<T[]> {
    for (let level = from; level < this.stepLevels.length; level++) {
      const pending: Promise<void>[] = [];
      for (const step of this.stepLevels[level]!) {
        const stepCtx = contextFor(ctx, step.path);
        for (let r = 0; r < rows.length; r++) {
          const objects = rows[r]!;
          const inputs: Record<string, unknown> = {};
          for (const { name, path, trace } of step.inputs) inputs[name] = trace < 0 ? read(objects[0]!, path) : traces[r]![trace];
          const value = step.gen.generate(inputs, step.traceSlot < 0 ? stepCtx : stepCtx.withTrace(traces[r]![step.traceSlot]!));
          const target = objects[step.object]!;
          if (!isPromise(value)) target[step.key] = value;
          else if (sync) asyncError(show(step.path), [value, ...pending]);
          else pending.push(value.then((v) => void (target[step.key] = v)));
        }
      }
      if (pending.length > 0) return Promise.all(pending).then(() => this.runLevels(rows, traces, ctx, level + 1, sync));
    }
    return rows.map((objects) => objects[0] as T);
  }
}

const isPromise = (value: unknown): value is Promise<unknown> => value instanceof Promise;

/** For sync runs: an async Gen was found. Its Promises are left to settle quietly. */
function asyncError(path: string, started: readonly unknown[]): never {
  for (const p of started) if (isPromise(p)) p.catch(() => {});
  throw new GenerationError(
    `field '${path}' returned a Promise (an async Gen, e.g. an LLM Gen). Use \`await preview(...)\` instead of previewSync().`,
  );
}

/**
 * Level 0 reads nothing; every other step sits one level above the highest step it reads (reading an
 * object means reading every field under it). `steps` must be in run order.
 */
function groupByLevel(steps: readonly Step[]): Step[][] {
  const levelOf = new Map<Step, number>();
  const levels: Step[][] = [];
  for (const step of steps) {
    let level = 0;
    for (const { path } of step.inputs) {
      for (const [producer, l] of levelOf) if (startsWith(producer.path, path)) level = Math.max(level, l + 1);
    }
    levelOf.set(step, level);
    (levels[level] ??= []).push(step);
  }
  return levels;
}

/** Walks a tree depth-first, collecting object slots (parents first) and steps (declaration order). */
/** The root's name for `rootRefs`: the root tree's id, else the first root ref's name; and where it came from. */
interface RootName {
  name: string | undefined;
  from: string | undefined;
}

function flatten(tree: TreeGen<object>, path: Path, parent: number, key: string, objects: ObjectSlot[], steps: Step[], root: RootName): void {
  const fields = tree.fields as Record<string, AnyGen | undefined>;
  const names = Object.keys(fields).filter((n) => fields[n] !== undefined);
  const index = objects.length;
  objects.push({ path, template: Object.fromEntries(names.map((n) => [n, undefined])), parent, key });

  for (const name of names) {
    const gen = fields[name]!;
    const fieldPath = [...path, name];
    if (gen instanceof TreeGen) {
      flatten(gen, fieldPath, index, name, objects, steps, root);
    } else if (gen instanceof BoundGen) {
      const inputs = Object.entries(gen.refs).map(([input, ref]) => ({
        name: input,
        path: resolve(ref, path, fieldPath, input, root),
        trace: refTarget(ref)!.trace ? 0 : -1,
      }));
      steps.push({ path: fieldPath, gen: gen.gen, inputs, object: index, key: name, traceSlot: -1 });
    } else {
      checkBound(gen, `field '${show(fieldPath)}'`, (message) => {
        throw new ConfigError(message);
      });
      steps.push({ path: fieldPath, gen, inputs: [], object: index, key: name, traceSlot: -1 });
    }
  }
}

/** The absolute path a ref points to, given the path of the object holding the field. */
function resolve(ref: Ref<unknown>, objectPath: Path, fieldPath: Path, input: string, root: RootName): Path {
  const target = refTarget(ref)!;
  switch (target.scope) {
    case "self":
      return [...objectPath, ...target.path];
    case "parent":
      if (objectPath.length === 0) {
        throw new ConfigError(`field '${show(fieldPath)}' reads '${showRef(ref)}' (input '${input}'), but its object is the root, so it has no parent.`);
      }
      return [...objectPath.slice(0, -1), ...target.path];
    case "root": {
      const name = target.rootName!;
      if (root.name === undefined) {
        root.name = name;
        root.from = `field '${show(fieldPath)}'`;
      } else if (name !== root.name) {
        throw new ConfigError(
          `field '${show(fieldPath)}' reads '${showRef(ref)}' (input '${input}'), but the root is '${root.name}' (from ${root.from}). ` +
            `rootRefs("${name}") was made for another root type: is this tree nested in another one? Use refs/parentRefs in nested trees.`,
        );
      }
      return target.path;
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
    for (const { name: input, path, trace } of step.inputs) {
      const producers = steps.flatMap((s, i) => (startsWith(s.path, path) ? [i] : []));
      if (producers.length === 0) {
        throw new ConfigError(`field '${show(step.path)}' reads '${show(path)}' (input '${input}'), which no field generates.`);
      }
      if (trace >= 0 && !(producers.length === 1 && steps[producers[0]!]!.path.length === path.length)) {
        throw new ConfigError(`field '${show(step.path)}' reads traceOf(${show(path)}) (input '${input}'), which is an object; traceOf reads one field.`);
      }
      if (producers.includes(steps.indexOf(step))) {
        throw new ConfigError(`field '${show(step.path)}' reads '${show(path)}' (input '${input}'), which contains the field itself.`);
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

/**
 * Gives each step read with `traceOf` a trace slot, and points the reading inputs at it. Returns the
 * number of slots. (Input `trace` is 0 for `traceOf` inputs until here.)
 */
function assignTraceSlots(steps: Step[]): number {
  let count = 0;
  for (const step of steps) {
    for (const input of step.inputs) {
      if (input.trace < 0) continue;
      const producer = steps.find((s) => s.path.length === input.path.length && startsWith(s.path, input.path))!;
      if (producer.traceSlot < 0) producer.traceSlot = count++;
      input.trace = producer.traceSlot;
    }
  }
  return count;
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
