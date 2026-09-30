import type { Context } from "../context";
import { GenerationError } from "../errors";
import { BaseGen, BoundGen, type Ref } from "../gen";
import { Prompt, promptInputs } from "./prompt";

export interface LLMTextGenParams {
  id?: string;
  /** A model nickname from the context's `models`, e.g. "fast". */
  model: string;
  /** Usually made with the `prompt` tag, whose refs become the fields this Gen reads. */
  prompt: Prompt | string;
  systemPrompt?: Prompt | string;
  /**
   * When the call fails for good (after the provider's retries): `fail` throws a GenerationError
   * (default); `default` uses `defaultValue`.
   */
  onFailure?: "fail" | "default";
  /** The value used with `onFailure: "default"`. Default "None". */
  defaultValue?: string;
}

/**
 * Text from an LLM. Reads the fields named in its prompts, so it needs no `bind()`:
 *
 *     bio: new LLMTextGen({
 *       model: "fast",
 *       prompt: prompt`Write a two-line bio for ${p.name}, a ${p.age}-year-old ${p.occupation}.`,
 *     })
 *
 * Async: all calls of one plan level (every row of the batch, every LLM field) are sent together,
 * limited by each provider's `maxConcurrency`.
 */
export class LLMTextGen extends BoundGen<string> {
  constructor(params: LLMTextGenParams) {
    const call = new LLMTextCall(params);
    super(call, call.refs);
  }

  protected override describe(): string {
    return this.id === undefined ? "LLMTextGen" : `LLMTextGen '${this.id}'`;
  }
}

/** The unbound part of an LLMTextGen: the plan runs this with the prompt's inputs. */
class LLMTextCall extends BaseGen<string, Record<string, unknown>> {
  readonly model: string;
  readonly prompt: Prompt;
  readonly systemPrompt: Prompt | undefined;
  readonly refs: Readonly<Record<string, Ref<unknown>>>;
  private readonly inputOf: ReadonlyMap<string, string>;
  readonly onFailure: "fail" | "default";
  readonly defaultValue: string;

  constructor({ id, model, prompt, systemPrompt, onFailure = "fail", defaultValue }: LLMTextGenParams) {
    super(id);
    this.check(typeof model === "string" && model !== "", "model must be a model nickname, e.g. \"fast\".");
    this.check(typeof prompt === "string" || prompt instanceof Prompt, "prompt must be a string or made with the prompt`...` tag.");
    this.check(onFailure === "fail" || onFailure === "default", `onFailure must be "fail" or "default", got ${JSON.stringify(onFailure)}.`);
    this.check(defaultValue === undefined || onFailure === "default", `defaultValue only applies with onFailure: "default".`);
    this.model = model;
    this.prompt = Prompt.from(prompt);
    this.systemPrompt = systemPrompt === undefined ? undefined : Prompt.from(systemPrompt);
    this.onFailure = onFailure;
    this.defaultValue = defaultValue ?? "None";
    // One input per field read by either prompt.
    const { refs, inputOf } = promptInputs(this.systemPrompt ? [this.prompt, this.systemPrompt] : [this.prompt]);
    this.refs = refs;
    this.inputOf = inputOf;
  }

  override get inputNames(): readonly string[] {
    return Object.keys(this.refs);
  }

  /** Before any call: the model nickname must exist. */
  checkContext(ctx: Context): void {
    ctx.model(this.model);
  }

  generate(inputs: Record<string, unknown>, ctx: Context): Promise<string> {
    const { spec, provider } = ctx.model(this.model);
    // Drawn now, before any await, so the seeds follow row order (see Plan).
    const seed = spec.seed === false ? undefined : ctx.rng.nextUint32() >>> 1;
    const valueOf = (key: string) => inputs[this.inputOf.get(key)!];
    const request = {
      model: spec.model,
      system: this.systemPrompt?.render(valueOf),
      prompt: this.prompt.render(valueOf),
      temperature: spec.temperature,
      maxTokens: spec.maxTokens,
      topP: spec.topP,
      seed,
      extra: spec.extra,
    };
    const where = ctx.pathString;
    return provider.complete(request).then(
      (completion) => completion.text,
      (error: Error) => {
        if (this.onFailure === "default") return this.defaultValue;
        throw new GenerationError(`${this.describe()} at ${where}: ${error.message}`);
      },
    );
  }

  protected override describe(): string {
    return `LLMTextGen${this.id === undefined ? "" : ` '${this.id}'`} (model '${this.model}')`;
  }
}
