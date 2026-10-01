// Live tests call a real API, so they cost money and need a key: they run only with LIVE=1
// (`LIVE=1 npm test`) and the OpenRouter key in the file OPENROUTER_API_KEY (gitignored).
import { existsSync } from "node:fs";
import { Provider, type ModelSpec } from "../src/index";

const KEY_FILE = "OPENROUTER_API_KEY";

export const skipLive = !process.env.LIVE || !existsSync(KEY_FILE);

/** `providers` and `models` for preview(): a small, cheap model under the nickname "llama". */
export const liveSetup = (spec: Partial<ModelSpec> = {}) => ({
  providers: { openRouter: Provider.openRouter({ apiKey: { file: KEY_FILE } }) },
  models: { llama: { provider: "openRouter", model: "meta-llama/llama-3.1-8b-instruct", ...spec } },
});
