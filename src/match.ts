import type { Context } from "./context";
import type { RefValues } from "./custom";
import { ConfigError } from "./errors";
import { BaseGen, BoundGen, refTarget, type Gen, type MaybePromise, type Ref } from "./gen";
import { checkBound, TreeGen } from "./tree";

/** One case of a MatchGen: if `when` holds for the inputs, the value comes from `then`. */
export interface MatchGenCase<Inputs> {
  when: (inputs: Inputs) => boolean;
  /** A Gen (run for the row; it may read fields of its own) or a plain value. */
  then: unknown;
}

export interface MatchGenParams<R extends Record<string, Ref<unknown>>, C extends readonly MatchGenCase<RefValues<R>>[], O> {
  id?: string;
  /** The fields the cases test: `{ age: r.targetAgeRange }`. */
  inputs: R;
  /** Tried in order; the first whose `when` holds gives the value. */
  cases: C;
  /** The value when no case holds: a Gen or a plain value. Default: undefined, so the field must be optional. */
  otherwise?: O;
}

/** What a branch gives: a Gen's output, or the value itself. */
type BranchValue<B> = B extends Gen<infer O> ? O : B;

/** The field type: every case's value, and `otherwise`'s (undefined when it is left out). */
export type MatchGenValue<C extends readonly { then: unknown }[], O> = BranchValue<C[number]["then"]> | BranchValue<O>;

/** A branch, ready to run: a value, or a Gen with its inputs renamed (inner name -> MatchGen input name). */
type Branch = { value: unknown } | { gen: Gen<unknown, any>; inputOf: Readonly<Record<string, string>> };

/**
 * A value chosen by testing fields, Scala-match style, like the prompt `match`: cases are tried in
 * order and the first whose `when` holds gives the value, from a Gen or a plain value. Covers
 * DataDesigner's conditional params and skipped columns:
 *
 *     reviewStyle: new MatchGen({
 *       inputs: { age: r.targetAgeRange },
 *       cases: [{ when: ({ age }) => age === "18-25", then: "rambling" }],
 *       otherwise: styleGen,
 *     }),
 *     complaintAnalysis: new MatchGen({            // complaintAnalysis?: string
 *       inputs: { rating: r.customerReview.rating },
 *       cases: [{ when: ({ rating }) => rating <= 2, then: new LLMTextGen({ ... }) }],
 *     }),
 *
 * The type is the union of what the branches give. Without `otherwise`, it includes undefined, so the
 * field must be optional. Only the chosen branch runs (an LLM branch calls the LLM only for its rows),
 * but the fields read by every branch are inputs, so the plan orders this field after all of them.
 * Each branch draws from its own random stream, so changing one branch does not change the others'
 * values. `when` gets no RNG.
 */
class MatchGenImpl<Out> extends BoundGen<Out> {
  constructor(params: MatchGenParams<Record<string, Ref<unknown>>, readonly MatchGenCase<any>[], unknown>) {
    const call = new MatchCall(params);
    super(call as Gen<Out, any>, call.refs);
  }

  protected override describe(): string {
    return this.id === undefined ? "MatchGen" : `MatchGen '${this.id}'`;
  }
}

/** The unbound part of a MatchGen: the plan runs this with the inputs of the match and of every branch. */
class MatchCall extends BaseGen<unknown, Record<string, unknown>> {
  readonly refs: Readonly<Record<string, Ref<unknown>>>;
  private readonly matchInputs: readonly string[];
  private readonly cases: readonly { when: (inputs: any) => boolean; branch: Branch }[];
  private readonly otherwise: Branch | undefined;

  constructor({ id, inputs, cases, otherwise }: MatchGenParams<Record<string, Ref<unknown>>, readonly MatchGenCase<any>[], unknown>) {
    super(id);
    this.check(typeof inputs === "object" && inputs !== null, "inputs must be an object of refs, e.g. { age: r.age }.");
    for (const [name, ref] of Object.entries(inputs)) {
      const target = refTarget(ref);
      this.check(target !== undefined, `input '${name}' must be a ref, e.g. r.age.`);
      this.check(target!.path.length > 0, `input '${name}' is a whole ${target!.scope} object; use a field of it.`);
    }
    this.check(Array.isArray(cases) && cases.length > 0, "cases must be a non-empty list of { when, then }.");
    const refs: Record<string, Ref<unknown>> = { ...inputs };
    this.matchInputs = Object.keys(inputs);
    this.cases = cases.map((c, i) => {
      this.check(typeof c?.when === "function", `case ${i + 1}: when must be a function of the inputs.`);
      return { when: c.when, branch: this.branch(c.then, `case${i + 1}`, refs) };
    });
    this.otherwise = otherwise === undefined ? undefined : this.branch(otherwise, "otherwise", refs);
    this.refs = refs;
  }

  /** A branch; a bound Gen's refs join `refs` as `<label>.<input>`. */
  private branch(then: unknown, label: string, refs: Record<string, Ref<unknown>>): Branch {
    const isGen = typeof (then as Gen<unknown> | undefined)?.generate === "function";
    if (!isGen) return { value: then };
    this.check(!(then instanceof TreeGen), `${label}: a TreeGen cannot be a branch; give the field a MatchGen per key, or match on its fields.`);
    if (!(then instanceof BoundGen)) {
      checkBound(then as Gen<unknown>, label, (message) => this.check(false, message));
      return { gen: then as Gen<unknown>, inputOf: {} };
    }
    const inputOf: Record<string, string> = {};
    for (const [inner, ref] of Object.entries(then.refs)) {
      inputOf[inner] = `${label}.${inner}`;
      refs[inputOf[inner]] = ref;
    }
    return { gen: then.gen, inputOf };
  }

  override get inputNames(): readonly string[] {
    return Object.keys(this.refs);
  }

  /** Branch Gens are checked too, e.g. an LLM branch's model nickname. */
  checkContext(ctx: Context): void {
    for (const branch of [...this.cases.map((c) => c.branch), this.otherwise]) {
      if (branch && "gen" in branch) branch.gen.checkContext?.(ctx);
    }
  }

  generate(inputs: Record<string, unknown>, ctx: Context): MaybePromise<unknown> {
    const own: Record<string, unknown> = {};
    for (const name of this.matchInputs) own[name] = inputs[name];
    const i = this.cases.findIndex((c) => c.when(own));
    const branch = i >= 0 ? this.cases[i]!.branch : this.otherwise;
    if (branch === undefined) return undefined;
    if ("value" in branch) return branch.value;
    const branchInputs: Record<string, unknown> = {};
    for (const [inner, outer] of Object.entries(branch.inputOf)) branchInputs[inner] = inputs[outer];
    return branch.gen.generate(branchInputs, ctx.child(i >= 0 ? `case${i + 1}` : "otherwise"));
  }

  protected override describe(): string {
    return this.id === undefined ? "MatchGen" : `MatchGen '${this.id}'`;
  }
}

/** A MatchGen giving `Out`: a bound Gen, ready to be a field. */
export type MatchGen<Out> = MatchGenImpl<Out>;

// The constructor infers the field type from the branches, while the class has one type parameter, so
// hovers show `MatchGen<string | undefined>`.
export const MatchGen = MatchGenImpl as unknown as new <
  const R extends Record<string, Ref<unknown>>,
  const C extends readonly MatchGenCase<RefValues<R>>[],
  O = undefined,
>(
  params: MatchGenParams<R, C, O>,
) => MatchGen<MatchGenValue<C, O>>;
