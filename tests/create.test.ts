import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CategorySamplerGen, ConfigError, create, CustomGen, GenerationError, NumberSamplerGen, preview, s, TreeGen } from "../src/index";

const Pet = s.object({ name: s.string(), age: s.integer() });
const pet = new TreeGen({
  id: "pet",
  schema: Pet,
  fields: {
    name: new CategorySamplerGen({ values: ["Rex", "Tom", "Kit"] }),
    age: new NumberSamplerGen({ type: "uniform", low: 1, high: 15, integer: true }),
  },
});

const tempDir = () => mkdtemp(join(tmpdir(), "create-test-"));
const readLines = async (path: string) => (await readFile(path, "utf8")).split("\n");

describe("create", () => {
  it("writes one JSON record per line, the same records preview gives for the seed", async () => {
    const path = join(await tempDir(), "out", "pets.jsonl"); // the "out" folder is made
    const result = await create({ gen: pet, numRecords: 7, seed: 4, batchSize: 3, path });
    expect(result).toEqual({ path, numRecords: 7, seed: [4] });
    const lines = await readLines(path);
    expect(lines.pop()).toBe(""); // ends with a newline
    expect(lines.map((line) => JSON.parse(line))).toEqual((await preview({ gen: pet, numRecords: 7, seed: 4 })).records);
  });

  it("keeps an existing file unless overwrite is set", async () => {
    const path = join(await tempDir(), "pets.jsonl");
    await writeFile(path, "earlier run\n");
    await expect(create({ gen: pet, numRecords: 2, path })).rejects.toThrow(
      new ConfigError(`create: ${path} exists; pass overwrite: true to replace it.`),
    );
    expect(await readFile(path, "utf8")).toBe("earlier run\n");
    await create({ gen: pet, numRecords: 2, path, overwrite: true });
    expect(await readLines(path)).toHaveLength(3);
  });

  it("a failing run keeps the batches written before the failure", async () => {
    const path = join(await tempDir(), "pets.jsonl");
    let calls = 0;
    const flaky = new TreeGen({
      schema: Pet,
      fields: {
        name: CustomGen.bound({
          inputs: {},
          fn: () => {
            if (++calls > 4) throw new Error("service down");
            return "Rex";
          },
        }),
        age: new NumberSamplerGen({ type: "uniform", low: 1, high: 15, integer: true }),
      },
    });
    await expect(create({ gen: flaky, numRecords: 6, batchSize: 2, path })).rejects.toThrow(/service down/);
    expect((await readLines(path)).filter(Boolean)).toHaveLength(4); // batches 1 and 2
  });

  it("names a record that is not JSON", async () => {
    const path = join(await tempDir(), "big.jsonl");
    const gen = CustomGen.bound({ inputs: {}, fn: () => 1n });
    await expect(create({ gen, numRecords: 1, path })).rejects.toThrow(GenerationError);
    await expect(create({ gen, numRecords: 1, path, overwrite: true })).rejects.toThrow(/record 0 cannot be written as JSON/);
  });
});
