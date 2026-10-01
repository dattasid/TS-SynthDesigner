import { describe, expect, it } from "vitest";
import {
  CategorySamplerGen,
  GenerationError,
  LLMStructuredGen,
  MockProvider,
  parseJsonReply,
  preview,
  prompt,
  Provider,
  rootRefs,
  s,
  TreeGen,
  type CompletionRequest,
  type Infer,
  type LLMStructuredGenParams,
} from "../src/index";

const backStory = s.object({
  childhood: s.string({ description: "two sentences" }),
  happiness: s.integer({ min: 1, max: 10 }),
  mood: s.enum(["calm", "anxious"]),
});
type BackStory = Infer<typeof backStory>;

interface Person {
  name: string;
  backStory: BackStory;
}
const p = rootRefs<Person>("person");

const story = (happiness: number) => JSON.stringify({ childhood: "By the sea.", happiness, mood: "calm" });

function run(respond: (r: CompletionRequest) => string | { text: string; truncated?: boolean }, params: Partial<LLMStructuredGenParams<BackStory>> = {}) {
  const mock = new MockProvider({ respond });
  const gen = new TreeGen<Person>({
    fields: {
      name: new CategorySamplerGen({ values: ["Ana", "Ben"] }),
      backStory: new LLMStructuredGen({ model: "fast", prompt: prompt`Invent a backstory for ${p.name}.`, schema: backStory, ...params }),
    },
  });
  const result = preview({ gen, numRecords: 2, seed: 3, providers: { mock }, models: { fast: { provider: "mock", model: "m" } } });
  return { mock, result };
}

describe("LLMStructuredGen", () => {
  it("adds the shape and generated notes to the prompt, and returns the validated, typed object", async () => {
    const { mock, result } = run(() => story(7));
    const { records } = await result;
    expect(records.map((r) => r.backStory)).toEqual([JSON.parse(story(7)), JSON.parse(story(7))]);
    const sent = mock.requests[0]!.prompt;
    expect(sent).toMatch(/^Invent a backstory for (Ana|Ben)\.\n\nReply with only a JSON object of this shape/);
    expect(sent).toContain('{\n  "childhood": string,\n  "happiness": integer,\n  "mood": "calm" | "anxious"\n}');
    expect(sent).toContain('Fields:\n- childhood: two sentences\n- happiness: an integer from 1 to 10\n- mood: one of "calm", "anxious"');
    expect(mock.requests[0]!.jsonSchema).toBeUndefined();
  });

  it("other schemaInPrompt choices: the JSON Schema, the notes only, or nothing", async () => {
    const detailed = run(() => story(7), { schemaInPrompt: "jsonSchemaDetailed" });
    await detailed.result;
    expect(detailed.mock.requests[0]!.prompt).toContain(
      `matches this JSON Schema (no other text):\n${JSON.stringify(backStory.toJSONSchema(), null, 2)}`,
    );
    const notes = run(() => story(7), { schemaInPrompt: "notesOnly" });
    await notes.result;
    expect(notes.mock.requests[0]!.prompt).toMatch(/\.\n\nReply with only a JSON object with these fields \(no other text\):\n- childhood: two sentences\n/);
    const none = run(() => story(7), { schemaInPrompt: "none" });
    await none.result;
    expect(none.mock.requests[0]!.prompt).toMatch(/^Invent a backstory for \w+\.$/);
  });

  it("accepts plain JSON, or one fenced block with any text around it; nothing else", () => {
    const a1 = { ok: true, value: { a: 1 } };
    expect(parseJsonReply('  {"a": 1}\n')).toEqual(a1);
    expect(parseJsonReply('```json\n{"a": 1}\n```')).toEqual(a1);
    expect(parseJsonReply('```\n{"a": 1}')).toEqual(a1); // the reply just ends
    expect(parseJsonReply('```\n{"a": 1}```')).toEqual(a1);
    // Seen from llama-3.1-8b: a line before the block, an explanation after it.
    expect(parseJsonReply('Here is the corrected JSON object:\n\n```json\n{"a": 1}\n```\n\nIn this backstory, ...')).toEqual(a1);
    expect(parseJsonReply('Here it is:\n```\n{"a": "x ``` y"}')).toEqual({ ok: true, value: { a: "x ``` y" } }); // not at a line start

    expect(parseJsonReply('Here it is: {"a": 1}')).toMatchObject({ ok: false, problem: expect.stringMatching(/^the reply is not plain JSON/) });
    expect(parseJsonReply('```json\n{"a": 1}\n```\nor:\n```json\n{"a": 2}\n```')).toEqual({ ok: false, problem: "the reply has 2 fenced blocks; expected one" });
    expect(parseJsonReply('```json\n{"a": 1}\n```\nor:\n```json\n{"a": 2}')).toEqual({ ok: false, problem: "the reply has 2 fenced blocks; expected one" });
    expect(parseJsonReply('{"a": 1, // one\n}')).toMatchObject({ ok: false });
  });

  it("retries an invalid reply with the reply and its problems in the prompt", async () => {
    const bad = '```json\n{"childhood": "x", "happiness": 12, "mood": "calm"}';
    const { mock, result } = run((r) => (r.prompt.includes("Your previous reply") ? story(4) : bad));
    const { records } = await result;
    expect(records.map((r) => r.backStory.happiness)).toEqual([4, 4]);
    expect(mock.requests).toHaveLength(4);
    const [first, , retry] = mock.requests; // both rows' first attempts go out together
    expect(retry!.prompt.startsWith(first!.prompt)).toBe(true);
    expect(retry!.prompt.slice(first!.prompt.length)).toBe(
      '\n\nYour previous reply was:\n```json\n{"childhood": "x", "happiness": 12, "mood": "calm"}' +
        "\n\nIt had these problems:\n- happiness: expected an integer from 1 to 10, got 12\n\nReply again with the corrected JSON only.",
    );
    expect(retry!.seed).toBe(first!.seed! + 1);
  });

  it("after maxAttempts: fails naming the problems, or uses a copy of defaultValue", async () => {
    const failing = run(() => "Sure! Here is a backstory.", { maxAttempts: 2 });
    const error = await failing.result.catch((e: Error) => e);
    expect(error).toBeInstanceOf(GenerationError);
    expect((error as Error).message).toMatch(
      /^LLMStructuredGen \(model 'fast'\) at backStory: no valid reply in 2 attempt\(s\)\. Last problems: the reply is not plain JSON/,
    );

    const fallback = { childhood: "Unknown.", happiness: 5, mood: "calm" as const };
    const defaulted = run(() => "{}", { onFailure: "default", defaultValue: fallback });
    const { records } = await defaulted.result;
    expect(records.map((r) => r.backStory)).toEqual([fallback, fallback]);
    expect(records[0]!.backStory).not.toBe(records[1]!.backStory); // each row its own copy
    expect(defaulted.mock.requests).toHaveLength(6);
  });

  it("a reply cut off at maxTokens fails at once (a retry would be cut off too)", async () => {
    const { mock, result } = run(() => ({ text: '{"childhood": "By the', truncated: true }));
    await expect(result).rejects.toThrow(/the reply was cut off at maxTokens \(the API's default\); raise maxTokens in model 'fast'/);
    expect(mock.requests).toHaveLength(2); // one per row, no retries
  });

  it("apiGuidedDecoding sends the JSON Schema as response_format; providers without it fail before any call", async () => {
    const bodies: any[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ choices: [{ message: { content: story(9) }, finish_reason: "stop" }] }));
    }) as unknown as typeof globalThis.fetch;
    const gen = new LLMStructuredGen({ model: "fast", prompt: "Invent a backstory.", schema: backStory, apiGuidedDecoding: true, schemaInPrompt: "notesOnly" });
    const { records } = await preview({
      gen,
      numRecords: 1,
      providers: { local: Provider.ollama({ fetch }) },
      models: { fast: { provider: "local", model: "llama3.2" } },
    });
    expect(records[0]!.happiness).toBe(9);
    expect(bodies[0].response_format).toEqual({ type: "json_schema", json_schema: { name: "reply", strict: true, schema: backStory.toJSONSchema() } });

    const anthropic = Provider.anthropic({ fetch });
    await expect(
      preview({ gen, numRecords: 1, providers: { a: anthropic }, models: { fast: { provider: "a", model: "claude" } } }),
    ).rejects.toThrow(/LLMStructuredGen \(model 'fast'\): apiGuidedDecoding: provider 'a' \(anthropic\) does not support it; use schemaInPrompt without apiGuidedDecoding\.$/);
    expect(bodies).toHaveLength(1);
  });

  it("checks its params when made", () => {
    const base = { model: "fast", prompt: "x", schema: backStory };
    expect(() => new LLMStructuredGen({ ...base, onFailure: "default" })).toThrow(/defaultValue is required/);
    expect(() => new LLMStructuredGen({ ...base, onFailure: "default", defaultValue: { childhood: "x", happiness: 0, mood: "calm" } })).toThrow(
      /defaultValue does not fit the schema: happiness: expected an integer from 1 to 10, got 0/,
    );
    expect(() => new LLMStructuredGen({ ...base, schema: s.string() })).toThrow(/schema must be an object schema/);
    expect(() => new LLMStructuredGen({ ...base, maxAttempts: 0 })).toThrow(/maxAttempts must be an integer >= 1/);
    expect(() => new LLMStructuredGen({ ...base, schemaInPrompt: "shape" as never })).toThrow(/schemaInPrompt must be one of/);
  });

  it.skipIf(!process.env.NVIDIA_API_KEY)("live: NVIDIA's hosted API", async () => {
    const { records } = await preview({
      gen: new TreeGen<Person>({
        fields: {
          name: new CategorySamplerGen({ values: ["Ana", "Ben", "Chen", "Dara"] }),
          backStory: new LLMStructuredGen({ model: "llama", prompt: prompt`Invent a short backstory for ${p.name}.`, schema: backStory }),
        },
      }),
      numRecords: 4,
      seed: 1,
      providers: { nvidia: Provider.nvidia() },
      models: { llama: { provider: "nvidia", model: "meta/llama-3.1-8b-instruct", maxTokens: 300, temperature: 0.7 } },
    });
    console.table(records.map(({ name, backStory }) => ({ name, ...backStory })));
    for (const r of records) expect(backStory.validate(r.backStory).ok).toBe(true);
  });
});

// Compile-time checks: never called.
export function compileErrors(): void {
  const gen = new LLMStructuredGen({ model: "fast", prompt: "x", schema: backStory });
  new TreeGen<Person>({ fields: { name: new CategorySamplerGen({ values: ["Ana"] }), backStory: gen } });
  // @ts-expect-error the schema's type is BackStory, but name is a string.
  new TreeGen<Person>({ fields: { name: gen, backStory: gen } });
  // @ts-expect-error defaultValue must have the schema's type (mood is "calm" | "anxious").
  new LLMStructuredGen({ model: "fast", prompt: "x", schema: backStory, onFailure: "default", defaultValue: { childhood: "", happiness: 1, mood: "sad" } });
}
