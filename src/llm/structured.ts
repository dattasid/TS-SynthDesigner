import type { Context } from "../context";
import { GenerationError } from "../errors";
import { BaseGen, BoundGen, type Ref } from "../gen";
import { ObjectSchema, type Schema } from "../schema";
import { Prompt, promptInputs } from "./prompt";
import type { CompletionRequest } from "./provider";

/**
 * How the prompt tells the model about the reply's shape (appended to the prompt):
 * - `shortSchemaAndNotes`: the shape in a compact JSON-like form, then a line per field with its
 *   description and constraints. Short, and easy for small models to follow.
 * - `jsonSchemaDetailed`: the full JSON Schema. Precise, but several times longer.
 * - `notesOnly`: the field lines without the shape. For `apiGuidedDecoding`, where the API enforces
 *   the shape but (except OpenAI) does not show the schema to the model.
 * - `none`: nothing; the prompt describes the reply itself.
 */
export type SchemaInPrompt = "shortSchemaAndNotes" | "jsonSchemaDetailed" | "notesOnly" | "none";

export interface LLMStructuredGenParams<T> {
  id?: string;
  /** A model nickname from the context's `models`, e.g. "fast". */
  model: string;
  /** Usually made with the `prompt` tag, whose refs become the fields this Gen reads. */
  prompt: Prompt | string;
  systemPrompt?: Prompt | string;
  /** The reply's shape, made with `s.object(...)`. The field's type is the schema's type. */
  schema: Schema<T>;
  /** Default `shortSchemaAndNotes`. Generated from the schema, so it never drifts from what is validated. */
  schemaInPrompt?: SchemaInPrompt;
  /**
   * The API constrains the reply to the schema's JSON Schema (`response_format` in the OpenAI format).
   * Default false. Replies are still validated: some endpoints ignore it silently.
   */
  apiGuidedDecoding?: boolean;
  /** Calls per value: an invalid reply is retried with its problems listed in the prompt. Default 3. */
  maxAttempts?: number;
  /** When no attempt gives a valid reply, or a call fails: `fail` throws (default); `default` uses `defaultValue`. */
  onFailure?: "fail" | "default";
  /** Required with `onFailure: "default"`; must fit the schema. Each row gets its own copy. */
  defaultValue?: NoInfer<T>;
}

/**
 * A JSON object from an LLM, checked against a schema and typed by it:
 *
 *     const backStory = s.object({
 *       childhood: s.string({ description: "two sentences" }),
 *       happiness: s.integer({ min: 1, max: 10 }),
 *     });
 *     ...
 *     backStory: new LLMStructuredGen({
 *       model: "fast",
 *       prompt: prompt`Invent a backstory for ${p.name}, ${p.age}.`,
 *       schema: backStory,
 *     })
 *
 * Each reply is parsed (a ```json fence is allowed, even without its closing fence) and validated.
 * An invalid reply is retried, with the reply and its problems added to the prompt. A reply cut off
 * at `maxTokens` fails at once, since a retry would be cut off too.
 */
export class LLMStructuredGen<T> extends BoundGen<T> {
  constructor(params: LLMStructuredGenParams<T>) {
    const call = new LLMStructuredCall(params);
    super(call, call.refs);
  }

  protected override describe(): string {
    return this.id === undefined ? "LLMStructuredGen" : `LLMStructuredGen '${this.id}'`;
  }
}

const GUIDANCE: readonly SchemaInPrompt[] = ["shortSchemaAndNotes", "jsonSchemaDetailed", "notesOnly", "none"];

class LLMStructuredCall<T> extends BaseGen<T, Record<string, unknown>> {
  readonly model: string;
  readonly prompt: Prompt;
  readonly systemPrompt: Prompt | undefined;
  readonly schema: ObjectSchema<any>;
  readonly refs: Readonly<Record<string, Ref<unknown>>>;
  private readonly inputOf: ReadonlyMap<string, string>;
  /** Appended to the rendered prompt: the schema as `schemaInPrompt` says. */
  private readonly guidance: string;
  private readonly jsonSchema: Record<string, unknown> | undefined;
  readonly maxAttempts: number;
  readonly onFailure: "fail" | "default";
  private readonly defaultValue: T | undefined;

  constructor(params: LLMStructuredGenParams<T>) {
    const { id, model, prompt, systemPrompt, schema, schemaInPrompt = "shortSchemaAndNotes", apiGuidedDecoding = false } = params;
    const { maxAttempts = 3, onFailure = "fail", defaultValue } = params;
    super(id);
    this.check(typeof model === "string" && model !== "", "model must be a model nickname, e.g. \"fast\".");
    this.check(typeof prompt === "string" || prompt instanceof Prompt, "prompt must be a string or made with the prompt`...` tag.");
    this.check(schema instanceof ObjectSchema, "schema must be an object schema, made with s.object({...}).");
    this.check(GUIDANCE.includes(schemaInPrompt), `schemaInPrompt must be one of ${GUIDANCE.map((g) => `"${g}"`).join(", ")}; got ${JSON.stringify(schemaInPrompt)}.`);
    this.check(typeof apiGuidedDecoding === "boolean", `apiGuidedDecoding must be true or false, got ${JSON.stringify(apiGuidedDecoding)}.`);
    this.check(Number.isSafeInteger(maxAttempts) && maxAttempts >= 1, `maxAttempts must be an integer >= 1, got ${maxAttempts}.`);
    this.check(onFailure === "fail" || onFailure === "default", `onFailure must be "fail" or "default", got ${JSON.stringify(onFailure)}.`);
    this.check((defaultValue !== undefined) === (onFailure === "default"), `defaultValue is required with onFailure: "default", and only applies there.`);
    if (defaultValue !== undefined) {
      const fits = schema.validate(defaultValue);
      this.check(fits.ok, `defaultValue does not fit the schema: ${fits.ok ? "" : fits.issues.join("; ")}.`);
    }
    this.model = model;
    this.prompt = Prompt.from(prompt);
    this.systemPrompt = systemPrompt === undefined ? undefined : Prompt.from(systemPrompt);
    this.schema = schema as ObjectSchema<any>;
    this.guidance = guidanceText(this.schema, schemaInPrompt);
    this.jsonSchema = apiGuidedDecoding ? this.schema.toJSONSchema() : undefined;
    this.maxAttempts = maxAttempts;
    this.onFailure = onFailure;
    this.defaultValue = defaultValue;
    const { refs, inputOf } = promptInputs(this.systemPrompt ? [this.prompt, this.systemPrompt] : [this.prompt]);
    this.refs = refs;
    this.inputOf = inputOf;
  }

  override get inputNames(): readonly string[] {
    return Object.keys(this.refs);
  }

  /** Before any call: the model nickname must exist, and its provider must do guided decoding if asked. */
  checkContext(ctx: Context): void {
    const { spec, provider } = ctx.model(this.model);
    this.check(
      this.jsonSchema === undefined || provider.supportsGuidedDecoding === true,
      `apiGuidedDecoding: provider '${spec.provider}' (${provider.name}) does not support it; ` +
        `use schemaInPrompt without apiGuidedDecoding.`,
    );
  }

  generate(inputs: Record<string, unknown>, ctx: Context): Promise<T> {
    const { spec, provider } = ctx.model(this.model);
    // Drawn now, before any await, so the seeds follow row order (see Plan). Attempt n uses seed + n.
    const seed = spec.seed === false ? undefined : ctx.rng.nextUint32() >>> 1;
    const valueOf = (key: string) => inputs[this.inputOf.get(key)!];
    const prompt = this.prompt.render(valueOf) + this.guidance;
    const request: CompletionRequest = {
      model: spec.model,
      system: this.systemPrompt?.render(valueOf),
      prompt,
      temperature: spec.temperature,
      maxTokens: spec.maxTokens,
      topP: spec.topP,
      extra: spec.extra,
      jsonSchema: this.jsonSchema,
    };
    const where = ctx.pathString;
    const failed = (problem: string): T => {
      if (this.onFailure === "default") return structuredClone(this.defaultValue!);
      throw new GenerationError(`${this.describe()} at ${where}: ${problem}`);
    };

    const attempt = async (n: number, currentPrompt: string): Promise<T> => {
      let completion;
      try {
        completion = await provider.complete({ ...request, prompt: currentPrompt, seed: seed === undefined ? undefined : (seed + n) % 2 ** 31 });
      } catch (error) {
        return failed((error as Error).message); // the provider has already retried what is worth retrying
      }
      if (completion.truncated) {
        return failed(`the reply was cut off at maxTokens (${spec.maxTokens ?? "the API's default"}); raise maxTokens in model '${this.model}'.`);
      }
      const parsed = parseJsonReply(completion.text);
      const result = parsed.ok ? this.schema.validate(parsed.value) : { ok: false as const, issues: [parsed.problem] };
      if (result.ok) return result.value as T;
      if (n + 1 >= this.maxAttempts) {
        return failed(`no valid reply in ${this.maxAttempts} attempt(s). Last problems: ${result.issues.join("; ")}.`);
      }
      return attempt(n + 1, prompt + retryText(completion.text, result.issues));
    };
    return attempt(0, prompt);
  }

  protected override describe(): string {
    return `LLMStructuredGen${this.id === undefined ? "" : ` '${this.id}'`} (model '${this.model}')`;
  }
}

function guidanceText(schema: ObjectSchema<any>, how: SchemaInPrompt): string {
  switch (how) {
    case "shortSchemaAndNotes":
      return `\n\nReply with only a JSON object of this shape (plain JSON, no comments, no other text):\n${schema.shape("")}\n\nFields:\n${schema.notes().join("\n")}`;
    case "jsonSchemaDetailed":
      return `\n\nReply with only a JSON object that matches this JSON Schema (no other text):\n${JSON.stringify(schema.toJSONSchema(), null, 2)}`;
    case "notesOnly":
      return `\n\nReply with only a JSON object with these fields (no other text):\n${schema.notes().join("\n")}`;
    case "none":
      return "";
  }
}

const MAX_ECHO = 2000;

/** Added to the prompt for a retry: the invalid reply and what is wrong with it. */
function retryText(reply: string, issues: readonly string[]): string {
  const shown = reply.length > MAX_ECHO ? `${reply.slice(0, MAX_ECHO)}...` : reply;
  return `\n\nYour previous reply was:\n${shown}\n\nIt had these problems:\n${issues.map((i) => `- ${i}`).join("\n")}\n\nReply again with the corrected JSON only.`;
}

/**
 * The JSON in a reply. Lenient only about a Markdown fence around it (```json ... ```), whose closing
 * fence may be missing. Anything else (prose around the JSON, comments) is a problem for the retry.
 */
export function parseJsonReply(text: string): { ok: true; value: unknown } | { ok: false; problem: string } {
  let body = text.trim();
  const fence = /^```[\w-]*[ \t]*\r?\n/.exec(body);
  if (fence) body = body.slice(fence[0].length).replace(/\r?\n?```$/, "").trim();
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (error) {
    return { ok: false, problem: `the reply is not plain JSON (${(error as Error).message})` };
  }
}
