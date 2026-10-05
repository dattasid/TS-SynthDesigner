import type { RefValues } from "../custom";
import { ConfigError } from "../errors";
import { refTarget, showRef, type Ref } from "../gen";

/** Values a prompt can show as text. `null` and `undefined` show as "None". */
export type PromptScalar = string | number | boolean | null | undefined;

const JSON_REF = Symbol("tdd.json");

/** A ref shown as JSON in a prompt: made by `json()`. */
export interface JsonRef {
  readonly [JSON_REF]: Ref<unknown>;
}

/**
 * Shows any value, e.g. a whole nested object, as indented JSON in a prompt:
 *
 *     prompt`Write a story for this person: ${json(p.education)}`
 */
export function json(ref: Ref<unknown>): JsonRef {
  if (!refTarget(ref)) throw new ConfigError(`json() takes a ref, e.g. json(p.education); got ${String(ref)}.`);
  return { [JSON_REF]: ref };
}

/**
 * What goes inside `${}` in a prompt: a ref to a text-like field, `json(ref)`, a constant, another
 * prompt (its text and fields are inlined), or `match({...})`.
 */
export type PromptPart = Ref<PromptScalar> | JsonRef | string | number | Prompt | PromptMatch;

/** One case of a `match`: if `when` holds for the inputs, the text is `then`. */
export interface MatchCase<Inputs> {
  when: (inputs: Inputs) => boolean;
  then: Prompt | string;
}

export interface MatchParams<R extends Record<string, Ref<unknown>>> {
  /** The fields the cases test: `{ age: r.age, stars: r.numberOfStars }`. */
  inputs: R;
  /** Tried in order; the first whose `when` holds gives the text. */
  cases: readonly MatchCase<RefValues<R>>[];
  /** The text when no case holds. Default: nothing. */
  otherwise?: Prompt | string;
}

/** A `match` inside a prompt; made by `match()` or `Prompt.match()`. */
export class PromptMatch {
  readonly inputs: Readonly<Record<string, Ref<unknown>>>;
  readonly cases: readonly { when: (inputs: any) => boolean; then: Prompt }[];
  readonly otherwise: Prompt | undefined;

  constructor({ inputs, cases, otherwise }: MatchParams<Record<string, Ref<unknown>>>) {
    const fail = (message: string): never => {
      throw new ConfigError(`match: ${message}`);
    };
    if (typeof inputs !== "object" || inputs === null) fail("inputs must be an object of refs, e.g. { age: r.age }.");
    for (const [name, ref] of Object.entries(inputs)) {
      const target = refTarget(ref);
      if (!target) fail(`input '${name}' must be a ref, e.g. r.age.`);
      if (target!.path.length === 0) fail(`input '${name}' is a whole ${target!.scope} object; use a field of it.`);
    }
    if (!Array.isArray(cases) || cases.length === 0) fail("cases must be a non-empty list of { when, then }.");
    this.cases = cases.map((c, i) => {
      if (typeof c?.when !== "function") fail(`case ${i + 1}: when must be a function of the inputs.`);
      if (typeof c.then !== "string" && !(c.then instanceof Prompt)) fail(`case ${i + 1}: then must be a string or a prompt\`...\`.`);
      return { when: c.when, then: Prompt.from(c.then) };
    });
    if (otherwise !== undefined && typeof otherwise !== "string" && !(otherwise instanceof Prompt)) {
      fail("otherwise must be a string or a prompt`...`.");
    }
    this.inputs = inputs;
    this.otherwise = otherwise === undefined ? undefined : Prompt.from(otherwise);
  }
}

/**
 * Text chosen by testing fields, Scala-match style: cases are tried in order and the first whose
 * `when` holds wins. Testing one field in every case is a switch; testing different things is an
 * if / else-if chain. Inside a prompt:
 *
 *     prompt`Write a '${r.reviewStyle}' review. ${match({
 *       inputs: { age: r.targetAgeRange, stars: r.numberOfStars },
 *       cases: [
 *         { when: ({ stars }) => stars <= 2, then: "Say what went wrong." },
 *         { when: ({ age }) => age === "18-25", then: "Be informal." },
 *       ],
 *       otherwise: "Be formal.",
 *     })}`
 *
 * or at the end of one: `prompt\`...\`.match({...})`. `then` can be a prompt that reads fields too.
 * The inputs and every branch's fields are inputs of the Gen using the prompt, whichever branch is
 * taken, so the plan orders it after all of them. `when` gets no RNG: same values, same text.
 */
export function match<const R extends Record<string, Ref<unknown>>>(params: MatchParams<R>): PromptMatch {
  return new PromptMatch(params as unknown as MatchParams<Record<string, Ref<unknown>>>);
}

/**
 * A piece of a prompt. A hole is keyed by its field's ref path (`root.education.city`), so the same
 * field shares one input. A match keeps its input names -> ref paths.
 */
type Piece =
  | string
  | { key: string; json: boolean }
  | { keys: Readonly<Record<string, string>>; cases: PromptMatch["cases"]; otherwise: Prompt | undefined };

/**
 * A prompt template: text with holes for field values. Made by the `prompt` tag, or from a plain
 * string (no holes). The refs become the inputs of the Gen using it (see `promptInputs`).
 */
export class Prompt {
  /** Ref path -> ref, one per distinct field. */
  readonly refsByKey: ReadonlyMap<string, Ref<unknown>>;
  private readonly pieces: readonly Piece[];

  constructor(strings: readonly string[], parts: readonly PromptPart[]) {
    const refsByKey = new Map<string, Ref<unknown>>();
    const pieces: Piece[] = [strings[0]!];
    parts.forEach((part, i) => {
      const isJson = typeof part === "object" && part !== null && JSON_REF in part;
      const ref = isJson ? (part as JsonRef)[JSON_REF] : part;
      if (part instanceof Prompt) {
        for (const [key, r] of part.refsByKey) refsByKey.set(key, r);
        pieces.push(...part.pieces);
      } else if (part instanceof PromptMatch) {
        const keys: Record<string, string> = {};
        for (const [name, r] of Object.entries(part.inputs)) {
          keys[name] = showRef(r);
          refsByKey.set(keys[name], r);
        }
        for (const branch of [...part.cases.map((c) => c.then), ...(part.otherwise ? [part.otherwise] : [])]) {
          for (const [key, r] of branch.refsByKey) refsByKey.set(key, r);
        }
        pieces.push({ keys, cases: part.cases, otherwise: part.otherwise });
      } else if (!refTarget(ref)) {
        if (typeof part !== "string" && typeof part !== "number") {
          throw new ConfigError(
            `prompt: value ${i + 1} inside \${} must be a ref, json(ref), a string, a number, a prompt or match(...); got ${String(part)}.`,
          );
        }
        pieces.push(String(part));
      } else {
        const key = showRef(ref);
        refsByKey.set(key, ref as Ref<unknown>);
        pieces.push({ key, json: isJson });
      }
      pieces.push(strings[i + 1]!);
    });
    checkNoBraces(pieces.filter((p): p is string => typeof p === "string").join(""));
    this.refsByKey = refsByKey;
    this.pieces = pieces;
  }

  /** A prompt without holes. */
  static from(text: string | Prompt): Prompt {
    return typeof text === "string" ? new Prompt([text], []) : text;
  }

  /** This prompt followed by `more`: `prompt\`...\`.append(prompt\`...\`)`. */
  append(more: Prompt | string): Prompt {
    return new Prompt(["", "", ""], [this, Prompt.from(more)]);
  }

  /** This prompt followed by a `match` (see `match()`). */
  match<const R extends Record<string, Ref<unknown>>>(params: MatchParams<R>): Prompt {
    return new Prompt(["", "", ""], [this, match(params)]);
  }

  /** The text, with each hole filled by `valueOf(ref path)`. */
  render(valueOf: (key: string) => unknown): string {
    let out = "";
    for (const piece of this.pieces) {
      if (typeof piece === "string") out += piece;
      else if ("cases" in piece) {
        const inputs: Record<string, unknown> = {};
        for (const [name, key] of Object.entries(piece.keys)) inputs[name] = valueOf(key);
        const branch = piece.cases.find((c) => c.when(inputs))?.then ?? piece.otherwise;
        if (branch) out += branch.render(valueOf);
      } else {
        const value = valueOf(piece.key);
        out += piece.json ? JSON.stringify(value, null, 2) : value === null || value === undefined ? "None" : String(value);
      }
    }
    return out;
  }
}

/**
 * `{{ name }}` is DataDesigner's (Jinja) syntax. Here it would reach the LLM as is, without reading the
 * field, so any `{{` in a prompt's own text is an error. (Field values are data and are not checked.)
 */
function checkNoBraces(text: string): void {
  const at = text.indexOf("{{");
  if (at < 0) return;
  const close = text.indexOf("}}", at);
  const snippet = text.slice(at, close >= 0 && close - at < 60 ? close + 2 : at + 20);
  const field = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(snippet)?.[1];
  throw new ConfigError(
    `prompt: found ${JSON.stringify(snippet)}. {{ }} is DataDesigner/Jinja syntax and would be sent to the LLM as is. ` +
      `Read fields with the prompt tag: prompt\`... \${p.${field ?? "field"}} ...\`, with p = rootRefs(YourSchema).`,
  );
}

/**
 * Names the inputs of one or more prompts: one input per distinct field, named after the field's last
 * key (`p.education.city` -> `city`), with `_2`, `_3`... on clashes. Returns input name -> ref (what
 * `bind` takes) and ref path -> input name (for rendering).
 */
export function promptInputs(prompts: readonly Prompt[]): { refs: Record<string, Ref<unknown>>; inputOf: Map<string, string> } {
  const refs: Record<string, Ref<unknown>> = {};
  const inputOf = new Map<string, string>();
  for (const p of prompts) {
    for (const [key, ref] of p.refsByKey) {
      if (inputOf.has(key)) continue;
      const target = refTarget(ref)!;
      const base = target.path[target.path.length - 1]!;
      let input = base;
      for (let n = 2; Object.hasOwn(refs, input); n++) input = `${base}_${n}`;
      refs[input] = ref;
      inputOf.set(key, input);
    }
  }
  return { refs, inputOf };
}

/**
 * The prompt template tag. Refs inside `${}` are the fields the prompt reads; they become the Gen's
 * inputs automatically, and a misspelled field is a compile error:
 *
 *     prompt`Write a two-line bio for ${p.name}, a ${p.age}-year-old ${p.occupation}.`
 *
 * A ref to an object is a compile error (it has no obvious text form); wrap it: `${json(p.education)}`.
 */
export function prompt(strings: TemplateStringsArray, ...parts: PromptPart[]): Prompt {
  return new Prompt(strings, parts);
}
