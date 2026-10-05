import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CategorySamplerGen,
  ConfigError,
  CustomGen,
  GenerationError,
  json,
  LLMTextGen,
  MockProvider,
  NumberSamplerGen,
  Plan,
  preview,
  prompt,
  Provider,
  reasoningOf,
  refs,
  rootRefs,
  s,
  traceOf,
  TreeGen,
} from "../src/index";
import { liveSetup, skipLive } from "./live";

/** A fetch that records requests and answers from `reply` (status + JSON body). */
function fakeFetch(reply: (n: number) => { status: number; body: unknown; headers?: Record<string, string> }, delayMs = 0) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const n = calls.length;
    stats.maxInFlight = Math.max(stats.maxInFlight, ++inFlight);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    inFlight--;
    const { status, body, headers } = reply(n);
    return new Response(JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { fn, calls, stats };
}

const openaiReply = (text: string) => ({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });

describe("Provider", () => {
  afterEach(() => {
    delete process.env.TDD_TEST_KEY;
  });

  it("speaks the OpenAI format (NVIDIA, OpenAI, OpenRouter, Ollama) and the Anthropic format", async () => {
    process.env.TDD_TEST_KEY = "sk-secret";
    const f = fakeFetch(() => ({ status: 200, body: openaiReply("Hello") }));
    const nvidia = Provider.nvidia({ apiKey: { env: "TDD_TEST_KEY" }, fetch: f.fn });
    const reply = await nvidia.complete({
      model: "meta/llama-3.1-8b-instruct",
      system: "Be brief.",
      prompt: "Hi",
      temperature: 0.7,
      seed: 42,
      extra: { frequency_penalty: 0.5 },
    });
    expect(reply).toEqual({ text: "Hello", usage: { inputTokens: 10, outputTokens: 3 } });
    expect(f.calls[0]!.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(f.calls[0]!.headers.authorization).toBe("Bearer sk-secret");
    expect(f.calls[0]!.body).toEqual({
      model: "meta/llama-3.1-8b-instruct",
      temperature: 0.7,
      seed: 42, // unset parameters (max_tokens, top_p) are left out, not sent as null
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
      frequency_penalty: 0.5,
    });

    const a = fakeFetch(() => ({
      status: 200,
      body: { content: [{ type: "text", text: "Hel" }, { type: "text", text: "lo" }], usage: { input_tokens: 8, output_tokens: 2 } },
    }));
    const anthropic = Provider.anthropic({ apiKey: { env: "TDD_TEST_KEY" }, fetch: a.fn });
    expect(await anthropic.complete({ model: "claude-sonnet-5-5", system: "Be brief.", prompt: "Hi", seed: 42 })).toEqual({
      text: "Hello",
      usage: { inputTokens: 8, outputTokens: 2 },
    });
    expect(a.calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(a.calls[0]!.headers["x-api-key"]).toBe("sk-secret");
    expect(a.calls[0]!.headers["anthropic-version"]).toBeDefined();
    expect(a.calls[0]!.body).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 1024, // required by Anthropic; a default when the spec has none
      system: "Be brief.", // top level, not a message
      messages: [{ role: "user", content: "Hi" }], // and no seed: Anthropic has none
    });

    // A reply stopped by the token limit is marked, in either format.
    const cut = fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: "Hel" }, finish_reason: "length" }] } }));
    expect(await Provider.openai({ apiKey: { env: "TDD_TEST_KEY" }, fetch: cut.fn }).complete({ model: "m", prompt: "Hi" })).toMatchObject({ truncated: true });
    const cutA = fakeFetch(() => ({ status: 200, body: { content: [{ type: "text", text: "Hel" }], stop_reason: "max_tokens" } }));
    expect(await Provider.anthropic({ apiKey: { env: "TDD_TEST_KEY" }, fetch: cutA.fn }).complete({ model: "m", prompt: "Hi" })).toMatchObject({ truncated: true });

    // Reasoning sent apart from the reply: OpenRouter's `reasoning`, DeepSeek/vLLM's `reasoning_content`, Anthropic's thinking blocks.
    for (const key of ["reasoning", "reasoning_content"]) {
      const r = fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: "Hi", [key]: "They said hi." } }] } }));
      expect(await Provider.openRouter({ apiKey: { env: "TDD_TEST_KEY" }, fetch: r.fn }).complete({ model: "m", prompt: "Hi" })).toMatchObject({ reasoning: "They said hi." });
    }
    const rA = fakeFetch(() => ({ status: 200, body: { content: [{ type: "thinking", thinking: "They said hi." }, { type: "text", text: "Hi" }] } }));
    expect(await Provider.anthropic({ apiKey: { env: "TDD_TEST_KEY" }, fetch: rA.fn }).complete({ model: "m", prompt: "Hi" })).toEqual({ text: "Hi", reasoning: "They said hi." });

    const ollama = fakeFetch(() => ({ status: 200, body: openaiReply("ok") }));
    await Provider.ollama({ fetch: ollama.fn }).complete({ model: "llama3.2", prompt: "Hi" });
    expect(ollama.calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(ollama.calls[0]!.headers.authorization).toBeUndefined(); // no key
  });

  it("retries rate limits and server errors, not bad requests; limits requests in flight", async () => {
    process.env.TDD_TEST_KEY = "sk-secret";
    const flaky = fakeFetch((n) => (n <= 2 ? { status: n === 1 ? 429 : 503, body: {} } : { status: 200, body: openaiReply("finally") }));
    const p = Provider.openai({ apiKey: { env: "TDD_TEST_KEY" }, fetch: flaky.fn, retryBaseMs: 1 });
    expect((await p.complete({ model: "m", prompt: "Hi" })).text).toBe("finally");
    expect(flaky.calls).toHaveLength(3);

    const bad = fakeFetch(() => ({ status: 400, body: { error: "unknown parameter: seed" } }));
    const q = Provider.openai({ apiKey: { env: "TDD_TEST_KEY" }, fetch: bad.fn, retryBaseMs: 1 });
    const error = await q.complete({ model: "m", prompt: "Hi" }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(GenerationError);
    expect((error as Error).message).toMatch(/Provider 'openai': HTTP 400 for model 'm': .*unknown parameter: seed/);
    expect((error as Error).message).not.toContain("sk-secret");
    expect(bad.calls).toHaveLength(1);

    const slow = fakeFetch(() => ({ status: 200, body: openaiReply("x") }), 5);
    const limited = Provider.openai({ apiKey: { env: "TDD_TEST_KEY" }, fetch: slow.fn, maxConcurrency: 3 });
    await Promise.all(Array.from({ length: 12 }, () => limited.complete({ model: "m", prompt: "Hi" })));
    expect(slow.stats.maxInFlight).toBe(3);
  });

  it("reads the key from an env variable or a file, on the first call", async () => {
    const f = fakeFetch(() => ({ status: 200, body: openaiReply("ok") }));
    const noKey = Provider.nvidia({ apiKey: { env: "TDD_TEST_KEY" }, fetch: f.fn }); // constructing does not need it
    await expect(noKey.complete({ model: "m", prompt: "Hi" })).rejects.toThrow(
      new ConfigError("Provider 'nvidia': environment variable TDD_TEST_KEY is not set."),
    );

    const file = join(mkdtempSync(join(tmpdir(), "tdd-")), "key.txt");
    writeFileSync(file, "sk-from-file\n");
    await Provider.openRouter({ apiKey: { file }, fetch: f.fn }).complete({ model: "m", prompt: "Hi" });
    expect(f.calls[0]!.headers.authorization).toBe("Bearer sk-from-file");
    expect(f.calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
});

const Education = s.object({ university: s.string(), city: s.string() });
const Person = s.object({
  name: s.string(),
  age: s.integer(),
  occupation: s.string(),
  education: Education,
  bio: s.string(),
  bioLength: s.integer(),
});

const p = rootRefs(Person);

const personGen = (bio: LLMTextGen) =>
  new TreeGen({
    schema: Person,
    fields: {
      name: new CategorySamplerGen({ values: ["Ada", "Linus", "Grace"] }),
      age: new NumberSamplerGen({ type: "uniform", low: 20, high: 60, integer: true }),
      occupation: new CategorySamplerGen({ values: ["engineer", "teacher"] }),
      education: new TreeGen({
        schema: Education,
        fields: {
          university: new CategorySamplerGen({ values: ["MIT", "ETH"] }),
          city: new CategorySamplerGen({ values: ["Boston", "Zurich"] }),
        },
      }),
      bio,
      bioLength: CustomGen.bound({ inputs: { bio: p.bio }, fn: ({ bio }) => bio.length }), // reads the LLM's answer
    },
  });

const bioGen = new LLMTextGen({
  model: "fast",
  prompt: prompt`Write a bio for ${p.name}, a ${p.age}-year-old ${p.occupation}.`,
});

describe("LLMTextGen", () => {
  it("fills the prompt from other fields; later fields read its answer; seeds are per row and reproducible", async () => {
    const mock = new MockProvider({ latencyMs: [0, 3] });
    const setup = { providers: { mock }, models: { fast: { provider: "mock", model: "tiny-model", temperature: 0.9 } } };
    const person = personGen(bioGen);

    expect(Plan.compile(person).toText()).toMatch(/\n  bio +<- name, age, occupation\n/);

    const { records } = await preview({ gen: person, numRecords: 8, seed: 3, ...setup });
    for (const r of records) {
      expect(r.bio).toMatch(new RegExp(`^\\[tiny-model seed=\\d+\\] Write a bio for ${r.name}, a ${r.age}-year-old ${r.occupation}\\.$`));
      expect(r.bioLength).toBe(r.bio.length);
    }
    expect(mock.requests[0]!.temperature).toBe(0.9); // from the model spec
    expect(new Set(mock.requests.map((q) => q.seed)).size).toBe(8); // a different seed per row
    expect(mock.maxInFlight).toBe(8); // one level: all rows at once

    // Same seed, same prompts and seeds, whatever the batch size and latency.
    const again = await preview({ gen: person, numRecords: 8, seed: 3, batchSize: 3, ...setup });
    expect(again.records).toEqual(records);
  });

  it("json() for objects, system prompts, and seed: false", async () => {
    const mock = new MockProvider();
    const bio = new LLMTextGen({
      model: "fast",
      systemPrompt: prompt`You write for ${p.education.university} alumni magazines.`,
      prompt: prompt`Bio for ${p.name}. Education: ${json(p.education)}`,
    });
    const { records } = await preview({
      gen: personGen(bio),
      numRecords: 1,
      seed: 1,
      providers: { mock },
      models: { fast: { provider: "mock", model: "m", seed: false } },
    });
    const [r] = records;
    const [q] = mock.requests;
    expect(q!.system).toBe(`You write for ${r!.education.university} alumni magazines.`);
    expect(q!.prompt).toBe(`Bio for ${r!.name}. Education: ${JSON.stringify(r!.education, null, 2)}`);
    expect(q!.seed).toBeUndefined();
  });

  it("an unknown model fails before any call; failures throw or fall back to a default", async () => {
    const mock = new MockProvider();
    const typo = new LLMTextGen({ model: "fsat", prompt: prompt`Bio for ${p.name}` });
    await expect(
      preview({ gen: personGen(typo), numRecords: 5, providers: { mock }, models: { fast: { provider: "mock", model: "m" } } }),
    ).rejects.toThrow(new ConfigError("field 'bio': unknown model 'fsat'. Models: fast."));
    expect(mock.requests).toHaveLength(0);

    await expect(preview({ gen: personGen(bioGen), models: { fast: { provider: "nvidia", model: "m" } } })).rejects.toThrow(
      "model 'fast' uses provider 'nvidia', which is not in providers (none given).",
    );

    const down = new MockProvider({
      respond: () => {
        throw new Error("503 Service Unavailable");
      },
    });
    const setup = { providers: { down }, models: { fast: { provider: "down", model: "m" } } };
    await expect(preview({ gen: personGen(bioGen), numRecords: 2, ...setup })).rejects.toThrow(
      /LLMTextGen \(model 'fast'\) at bio: 503 Service Unavailable/,
    );

    const fallback = new LLMTextGen({ model: "fast", prompt: prompt`Bio for ${p.name}`, onFailure: "default" });
    const { records } = await preview({ gen: personGen(fallback), numRecords: 2, ...setup });
    expect(records.map((r) => [r.bio, r.bioLength])).toEqual([
      ["None", 4],
      ["None", 4],
    ]);
  });

  it("a prompt without refs runs on its own; a ref outside the tag is caught", async () => {
    const mock = new MockProvider({ respond: () => "Why did the chicken..." });
    const joke = new LLMTextGen({ model: "fast", prompt: "Tell a joke." });
    const { records } = await preview({ gen: joke, numRecords: 2, providers: { mock }, models: { fast: { provider: "mock", model: "m" } } });
    expect(records).toEqual(["Why did the chicken...", "Why did the chicken..."]);

    expect(() => `Bio for ${p.name}`).toThrow(/root\.name is a ref, not a value.*use the prompt`\.\.\.` tag/);
  });

  it("{{ }} (DataDesigner's Jinja syntax) is an error, in any prompt form", () => {
    const hint = "Read fields with the prompt tag: prompt`... ${p.name} ...`";
    expect(() => new LLMTextGen({ model: "fast", prompt: "Write a bio for {{ name }}." })).toThrow(ConfigError);
    expect(() => new LLMTextGen({ model: "fast", prompt: "Write a bio for {{ name }}." })).toThrow(`found "{{ name }}"`);
    expect(() => new LLMTextGen({ model: "fast", prompt: "Write a bio for {{ name }}." })).toThrow(hint);
    expect(() => prompt`Bio for {{name}}, a ${p.occupation}`).toThrow(hint);
    expect(() => new LLMTextGen({ model: "fast", prompt: "Hi", systemPrompt: "You are {{ persona }}" })).toThrow(/p\.persona/);
    expect(() => prompt`Bio for ${"{{"}name}}`).toThrow(ConfigError); // constants are part of the text too
    expect(() => prompt`Return {{ unclosed`).toThrow(`found "{{ unclosed"`);

    // Single braces (JSON examples) are fine, and field values are data: never checked.
    const jsonExample = prompt`Reply as {"bio": "..."} for ${p.name}`;
    expect(jsonExample.render(() => "{{ Ada }}")).toBe(`Reply as {"bio": "..."} for {{ Ada }}`);
  });

  it("reasoningOf puts the model's reasoning in another field; traceOf reads any field's trace", async () => {
    const Answer = s.object({
      question: s.string(),
      answer: s.string(),
      answerReasoning: s.string().optional(),
      reasoningWords: s.integer(),
    });
    const a = rootRefs(Answer);
    const gen = new TreeGen({
      schema: Answer,
      id: "answer",
      fields: {
        question: new CategorySamplerGen({ values: ["Why is the sky blue?"] }),
        answer: new LLMTextGen({ model: "thinker", prompt: prompt`${a.question}` }),
        answerReasoning: reasoningOf(a.answer),
        // Any Gen can read a trace: traceOf(ref) is a Ref<Trace>.
        reasoningWords: CustomGen.bound({ inputs: { t: traceOf(a.answer) }, fn: ({ t }) => t.reasoning?.split(" ").length ?? 0 }),
      },
    });
    expect(Plan.compile(gen).toText()).toContain("answerReasoning  <- trace=traceOf(answer)");

    const mock = new MockProvider({ respond: () => ({ text: "Scattering.", reasoning: "Short waves scatter more." }) });
    const setup = { providers: { mock }, models: { thinker: { provider: "mock", model: "m" } } };
    const { records } = await preview({ gen, numRecords: 2, seed: 1, ...setup });
    expect(records[0]).toEqual({ question: "Why is the sky blue?", answer: "Scattering.", answerReasoning: "Short waves scatter more.", reasoningWords: 4 });

    // No reasoning sent, or a field that is not an LLM field: undefined.
    const quiet = await preview({ gen, numRecords: 1, ...setup, providers: { mock: new MockProvider({ respond: () => "Scattering." }) } });
    expect(quiet.records[0]!.answerReasoning).toBeUndefined();
    const fromSampler = new TreeGen({
      schema: Answer.pick("question", "answerReasoning"),
      fields: { question: new CategorySamplerGen({ values: ["Why?"] }), answerReasoning: reasoningOf(a.question) },
    });
    expect((await preview({ gen: fromSampler, numRecords: 1 })).records[0]!.answerReasoning).toBeUndefined();

    // traceOf reads one field, not an object.
    const Inner = s.object({ q: s.string() });
    const Outer = s.object({ p: Inner, r: s.string().optional() });
    const nested = new TreeGen({
      schema: Outer,
      fields: { p: new TreeGen({ schema: Inner, fields: { q: new CategorySamplerGen({ values: ["x"] }) } }), r: reasoningOf(refs(Outer).p) },
    });
    expect(() => Plan.compile(nested)).toThrow("field 'r' reads traceOf(p) (input 'trace'), which is an object; traceOf reads one whole field.");
    expect(() => traceOf(traceOf(a.answer))).toThrow(/traceOf takes a ref to a field/);
  });

  it.skipIf(skipLive)("live: llama-3.1-8b on OpenRouter", async () => {
    const { records } = await preview({
      gen: personGen(new LLMTextGen({ model: "llama", prompt: prompt`In at most 8 words, describe a ${p.occupation} named ${p.name}.` })),
      numRecords: 2,
      seed: 1,
      ...liveSetup({ maxTokens: 40, temperature: 0.7 }),
    });
    console.table(records.map(({ name, occupation, bio }) => ({ name, occupation, bio })));
    for (const r of records) expect(r.bio.length).toBeGreaterThan(0);
  });
});

// Compile-time checks: never called.
export function compileErrors(): void {
  // @ts-expect-error education is an object: no obvious text form. Use json(p.education).
  prompt`Education: ${p.education}`;
  prompt`Education: ${json(p.education)}`; // fine
  // @ts-expect-error 'nmae' is not a field of Person.
  prompt`Bio for ${p.nmae}`;
  // @ts-expect-error an LLMTextGen produces text, but age is a number.
  new TreeGen({ schema: Person.pick("age"), fields: { age: bioGen } });
  // @ts-expect-error reasoning may be missing, so its field must be optional (or `string | undefined`).
  new TreeGen({ schema: s.object({ ...Person.pick("bio").fields, bioReasoning: s.string() }), fields: { bio: bioGen, bioReasoning: reasoningOf(p.bio) } });
}
