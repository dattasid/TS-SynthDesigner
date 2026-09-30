import { Limiter, type Completion, type CompletionRequest, type LLMProvider } from "./provider";

export interface MockProviderParams {
  name?: string;
  /** The reply. Default: `[<model> seed=<seed>] <prompt>`, so tests can see exactly what was sent. */
  respond?: (request: CompletionRequest) => string | Promise<string>;
  /** Simulated latency in ms: a number, or `[min, max]` for random latency (timing only, not the data). */
  latencyMs?: number | readonly [number, number];
  /** Requests in flight at once, like `Provider`'s. Default: no limit. */
  maxConcurrency?: number;
}

/** A provider without network, for tests and demos. Records every request it gets. */
export class MockProvider implements LLMProvider {
  readonly name: string;
  readonly requests: CompletionRequest[] = [];
  /** The most requests that were in flight at once. */
  maxInFlight = 0;
  private inFlight = 0;
  private readonly respond: (request: CompletionRequest) => string | Promise<string>;
  private readonly latencyMs: number | readonly [number, number];
  private readonly limiter: Limiter;

  constructor({ name = "mock", respond, latencyMs = 0, maxConcurrency = Infinity }: MockProviderParams = {}) {
    this.name = name;
    this.limiter = new Limiter(maxConcurrency);
    this.respond = respond ?? ((r) => `[${r.model} seed=${r.seed ?? "-"}] ${r.prompt}`);
    this.latencyMs = latencyMs;
  }

  complete(request: CompletionRequest): Promise<Completion> {
    this.requests.push(request);
    return this.limiter.run(() => this.reply(request));
  }

  private async reply(request: CompletionRequest): Promise<Completion> {
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    try {
      const ms = typeof this.latencyMs === "number" ? this.latencyMs : this.latencyMs[0] + Math.random() * (this.latencyMs[1] - this.latencyMs[0]);
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
      return { text: await this.respond(request) };
    } finally {
      this.inFlight--;
    }
  }
}
