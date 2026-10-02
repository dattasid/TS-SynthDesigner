import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { ConfigError, GenerationError } from "../errors";

/** One LLM call, independent of the endpoint's JSON format. */
export interface CompletionRequest {
  model: string;
  system?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** Best effort: sent where the API has a seed parameter, dropped where it has none (Anthropic). */
  seed?: number;
  /** Provider-specific body fields, passed through untouched. */
  extra?: Readonly<Record<string, unknown>>;
  /** Guided decoding: the API constrains the reply to this JSON Schema. Only if `supportsGuidedDecoding`. */
  jsonSchema?: Readonly<Record<string, unknown>>;
}

export interface Completion {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** The reply stopped at the token limit (`maxTokens`), so it is incomplete. */
  truncated?: boolean;
  /**
   * The model's reasoning, where the API sends it apart from the reply: `reasoning` (OpenRouter) or
   * `reasoning_content` (DeepSeek, vLLM) in the OpenAI format, `thinking` blocks from Anthropic (with
   * thinking turned on). OpenAI itself sends none.
   */
  reasoning?: string;
}

/** Anything that answers completion requests: a real `Provider`, or a `MockProvider` in tests. */
export interface LLMProvider {
  readonly name: string;
  /** Whether requests may carry `jsonSchema`. Default false. */
  readonly supportsGuidedDecoding?: boolean;
  complete(request: CompletionRequest): Promise<Completion>;
}

/** Where the API key comes from. Read on the first call, so trees without LLM fields never need one. */
export type ApiKeySource = { env: string } | { file: string };

/** The JSON format an endpoint speaks. OpenAI's chat-completions format covers most endpoints. */
export type ApiFormat = "openai" | "anthropic";

export interface ProviderParams {
  /** For error messages, e.g. "nvidia". */
  name: string;
  api: ApiFormat;
  /** Up to and including the version, e.g. "https://api.openai.com/v1". */
  baseUrl: string;
  /** Omit for endpoints without keys (a local Ollama). */
  apiKey?: ApiKeySource;
  /** Requests in flight at once, across all fields and rows (rate limits are per account). Default 4. */
  maxConcurrency?: number;
  /** Retries after a rate limit (429), a server error (5xx) or a network error. Default 3. */
  maxRetries?: number;
  /** First retry delay; doubles each retry, plus jitter. A `retry-after` header wins. Default 1000. */
  retryBaseMs?: number;
  /** Per request. Default 120000. */
  timeoutMs?: number;
  /** Replaces the global `fetch`, e.g. for tests. */
  fetch?: typeof fetch;
}

/** Preset options: everything but the name and format, all optional. */
export type PresetParams = Partial<Omit<ProviderParams, "name" | "api">>;

/**
 * Connects to an LLM endpoint. One class for every endpoint: a small adapter per JSON format
 * builds the request and reads the reply. Presets fill in the URL and key variable:
 *
 *     Provider.nvidia()                                    // NVIDIA_API_KEY
 *     Provider.anthropic({ apiKey: { file: "~/.keys/anthropic" } })
 *     Provider.ollama()                                    // localhost, no key
 *     new Provider({ name: "nim", api: "openai", baseUrl: "http://my-nim:8000/v1" })
 */
export class Provider implements LLMProvider {
  readonly name: string;
  readonly api: ApiFormat;
  readonly baseUrl: string;
  /**
   * The OpenAI format sends `response_format: json_schema` (OpenAI, Ollama, vLLM, recent NIMs).
   * An endpoint may still ignore it silently; replies are validated either way.
   */
  readonly supportsGuidedDecoding: boolean;
  private readonly apiKey: ApiKeySource | undefined;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly limiter: Limiter;
  private key: Promise<string | undefined> | undefined;

  constructor(params: ProviderParams) {
    const { name, api, baseUrl, apiKey, maxConcurrency = 4, maxRetries = 3, retryBaseMs = 1000, timeoutMs = 120_000 } = params;
    const check = (ok: boolean, message: string) => {
      if (!ok) throw new ConfigError(`Provider '${name}': ${message}`);
    };
    check(api === "openai" || api === "anthropic", `api must be "openai" or "anthropic", got ${JSON.stringify(api)}.`);
    check(/^https?:\/\//.test(baseUrl ?? ""), `baseUrl must be an http(s) URL, got ${JSON.stringify(baseUrl)}.`);
    check(Number.isSafeInteger(maxConcurrency) && maxConcurrency >= 1, `maxConcurrency must be an integer >= 1, got ${maxConcurrency}.`);
    check(Number.isSafeInteger(maxRetries) && maxRetries >= 0, `maxRetries must be an integer >= 0, got ${maxRetries}.`);
    this.name = name;
    this.api = api;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.supportsGuidedDecoding = api === "openai";
    this.apiKey = apiKey;
    this.maxRetries = maxRetries;
    this.retryBaseMs = retryBaseMs;
    this.timeoutMs = timeoutMs;
    this.fetchFn = params.fetch ?? ((...args) => fetch(...args));
    this.limiter = new Limiter(maxConcurrency);
  }

  /** NVIDIA's hosted API (build.nvidia.com), as DataDesigner's default provider. Also fits a self-hosted NIM via `baseUrl`. */
  static nvidia(params: PresetParams = {}): Provider {
    return new Provider({ name: "nvidia", api: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: { env: "NVIDIA_API_KEY" }, ...params });
  }

  static openai(params: PresetParams = {}): Provider {
    return new Provider({ name: "openai", api: "openai", baseUrl: "https://api.openai.com/v1", apiKey: { env: "OPENAI_API_KEY" }, ...params });
  }

  static openRouter(params: PresetParams = {}): Provider {
    return new Provider({ name: "openrouter", api: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: { env: "OPENROUTER_API_KEY" }, ...params });
  }

  /** A local Ollama through its OpenAI-compatible endpoint. No key. */
  static ollama(params: PresetParams = {}): Provider {
    return new Provider({ name: "ollama", api: "openai", baseUrl: "http://localhost:11434/v1", ...params });
  }

  static anthropic(params: PresetParams = {}): Provider {
    return new Provider({ name: "anthropic", api: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: { env: "ANTHROPIC_API_KEY" }, ...params });
  }

  complete(request: CompletionRequest): Promise<Completion> {
    return this.limiter.run(() => this.send(request));
  }

  private async send(request: CompletionRequest): Promise<Completion> {
    const key = await (this.key ??= this.readKey());
    const adapter = ADAPTERS[this.api];
    const { url, headers, body } = adapter.build(this.baseUrl, key, request);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt < this.maxRetries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw new GenerationError(`Provider '${this.name}': request failed: ${(error as Error).message}`);
      }
      if (response.ok) return adapter.parse(await response.json(), this.name);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await sleep(this.backoff(attempt, response.headers.get("retry-after")));
        continue;
      }
      const text = (await response.text().catch(() => "")).slice(0, 500);
      throw new GenerationError(`Provider '${this.name}': HTTP ${response.status} for model '${request.model}': ${text}`);
    }
  }

  private backoff(attempt: number, retryAfter?: string | null): number {
    const seconds = Number(retryAfter);
    if (retryAfter && Number.isFinite(seconds)) return seconds * 1000;
    // Jitter from Math.random: it only spreads retries in time, never affects the data.
    return this.retryBaseMs * 2 ** attempt * (1 + Math.random() * 0.25);
  }

  private async readKey(): Promise<string | undefined> {
    const source = this.apiKey;
    if (!source) return undefined;
    if ("env" in source) {
      const value = process.env[source.env]?.trim();
      if (!value) throw new ConfigError(`Provider '${this.name}': environment variable ${source.env} is not set.`);
      return value;
    }
    const path = source.file.replace(/^~(?=$|[\\/])/, homedir());
    const value = (await readFile(path, "utf8").catch(() => {
      throw new ConfigError(`Provider '${this.name}': cannot read the key file ${source.file}.`);
    })).trim();
    if (!value) throw new ConfigError(`Provider '${this.name}': the key file ${source.file} is empty.`);
    return value;
  }
}

interface Adapter {
  build(baseUrl: string, key: string | undefined, r: CompletionRequest): { url: string; headers: Record<string, string>; body: object };
  parse(json: unknown, provider: string): Completion;
}

/** Drops undefined values, so an unset parameter is left out of the body instead of sent as null. */
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const ADAPTERS: Record<ApiFormat, Adapter> = {
  // OpenAI chat completions: OpenAI, NVIDIA, OpenRouter, Ollama, vLLM...
  openai: {
    build: (baseUrl, key, r) => ({
      url: `${baseUrl}/chat/completions`,
      headers: key ? { authorization: `Bearer ${key}` } : ({} as Record<string, string>),
      body: {
        ...defined({ model: r.model, temperature: r.temperature, max_tokens: r.maxTokens, top_p: r.topP, seed: r.seed }),
        messages: [...(r.system ? [{ role: "system", content: r.system }] : []), { role: "user", content: r.prompt }],
        ...(r.jsonSchema && { response_format: { type: "json_schema", json_schema: { name: "reply", strict: true, schema: r.jsonSchema } } }),
        ...r.extra,
      },
    }),
    parse: (json, provider) => {
      const j = json as {
        choices?: { message?: { content?: string | null; reasoning?: unknown; reasoning_content?: unknown }; finish_reason?: string }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      const message = j.choices?.[0]?.message;
      const text = message?.content;
      if (typeof text !== "string" || text === "") throw new GenerationError(`Provider '${provider}': empty reply.`);
      const usage = j.usage && { inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens };
      const reasoning = [message?.reasoning, message?.reasoning_content].find((r): r is string => typeof r === "string" && r !== "");
      return { text, usage, ...(j.choices?.[0]?.finish_reason === "length" && { truncated: true }), ...(reasoning && { reasoning }) };
    },
  },
  // Anthropic Messages: system prompt at the top level, max_tokens required, no seed, content blocks in the reply.
  anthropic: {
    build: (baseUrl, key, r) => ({
      url: `${baseUrl}/messages`,
      headers: { "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) },
      body: {
        ...defined({ model: r.model, max_tokens: r.maxTokens ?? 1024, system: r.system, temperature: r.temperature, top_p: r.topP }),
        messages: [{ role: "user", content: r.prompt }],
        ...r.extra,
      },
    }),
    parse: (json, provider) => {
      type Block = { type: string; text?: string; thinking?: string };
      const j = json as { content?: Block[]; stop_reason?: string; usage?: { input_tokens: number; output_tokens: number } };
      const join = (type: string, key: "text" | "thinking") => (j.content ?? []).filter((b) => b.type === type).map((b) => b[key] ?? "").join("");
      const text = join("text", "text");
      if (text === "") throw new GenerationError(`Provider '${provider}': empty reply.`);
      const usage = j.usage && { inputTokens: j.usage.input_tokens, outputTokens: j.usage.output_tokens };
      const reasoning = join("thinking", "thinking");
      return { text, usage, ...(j.stop_reason === "max_tokens" && { truncated: true }), ...(reasoning && { reasoning }) };
    },
  },
};

/** At most `max` tasks running; the rest wait in arrival order. */
export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve)); // the slot is handed over on release
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
