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

/** What goes inside `${}` in a prompt: a ref to a text-like field, `json(ref)`, or a constant. */
export type PromptPart = Ref<PromptScalar> | JsonRef | string | number;

/** A hole is keyed by its field's ref path (`root.education.city`), so the same field shares one input. */
type Piece = string | { key: string; json: boolean };

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
      if (!refTarget(ref)) {
        if (typeof part !== "string" && typeof part !== "number") {
          throw new ConfigError(`prompt: value ${i + 1} inside \${} must be a ref, json(ref), a string or a number; got ${String(part)}.`);
        }
        pieces.push(String(part));
      } else {
        const key = showRef(ref);
        refsByKey.set(key, ref as Ref<unknown>);
        pieces.push({ key, json: isJson });
      }
      pieces.push(strings[i + 1]!);
    });
    this.refsByKey = refsByKey;
    this.pieces = pieces;
  }

  /** A prompt without holes. */
  static from(text: string | Prompt): Prompt {
    return typeof text === "string" ? new Prompt([text], []) : text;
  }

  /** The text, with each hole filled by `valueOf(ref path)`. */
  render(valueOf: (key: string) => unknown): string {
    let out = "";
    for (const piece of this.pieces) {
      if (typeof piece === "string") out += piece;
      else {
        const value = valueOf(piece.key);
        out += piece.json ? JSON.stringify(value, null, 2) : value === null || value === undefined ? "None" : String(value);
      }
    }
    return out;
  }
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
