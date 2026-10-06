// Runs the structured review example on OpenRouter and writes the records to JSONL.
//   npx vite-node examples/structured-reviews.run.ts [numRecords]
// Needs an OpenRouter key in the env var OPENROUTER_API_KEY or in a file of that name.
import { existsSync } from "node:fs";
import { create, Provider } from "../src/index";
import { structuredReviewGen } from "./structured-reviews";

const numRecords = Number(process.argv[2] ?? 10);
const path = "scratch/structured-reviews.jsonl";

const { seed } = await create({
  gen: structuredReviewGen,
  numRecords,
  path,
  overwrite: true,
  seed: 2026,
  providers: {
    openrouter: Provider.openRouter({ apiKey: existsSync("OPENROUTER_API_KEY") ? { file: "OPENROUTER_API_KEY" } : { env: "OPENROUTER_API_KEY" } }),
  },
  // As the tutorial: temperature 1, top_p 0.95, max 2048 tokens, thinking off.
  models: {
    writer: {
      provider: "openrouter",
      model: "qwen/qwen3.8-flash",
      temperature: 1,
      topP: 0.95,
      maxTokens: 2048,
      extra: { reasoning: { enabled: false } },
    },
  },
});
console.log(`${numRecords} records in ${path} (seed ${seed.join(",")})`);
