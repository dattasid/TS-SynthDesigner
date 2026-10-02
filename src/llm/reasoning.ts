import { CustomGen } from "../custom";
import { traceOf, type BoundGen, type Ref } from "../gen";

/**
 * The reasoning behind an LLM field's value, as its own field:
 *
 *     bio: new LLMTextGen({ model: "thinker", prompt: prompt`Write a bio for ${p.name}.` }),
 *     bioReasoning: reasoningOf(p.bio),   // in the type: bioReasoning?: string
 *
 * Only from providers that send reasoning apart from the reply (see `Completion.reasoning`), and only
 * from reasoning models: otherwise, and for a field whose Gen is not an LLM Gen, it is undefined. For a
 * structured field, it is the reasoning behind the accepted attempt.
 */
export function reasoningOf(ref: Ref<unknown>): BoundGen<string | undefined> {
  return CustomGen.bound({ id: "reasoningOf", inputs: { trace: traceOf(ref) }, fn: ({ trace }) => trace.reasoning });
}
