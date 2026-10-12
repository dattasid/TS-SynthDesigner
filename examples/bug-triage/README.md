# Bug-report triage: a synthetic issue tracker

[`bug-triage-100.jsonl`](bug-triage-100.jsonl) holds 100 bug reports for a shopping app. Each one
has a report written by a simulated user, the triage, and a Markdown ticket. Some reports are
duplicates of earlier bugs, and a few records are deliberately wrong, each labelled with what is
wrong. That makes the file useful test data for a checker, a dedup model, or an LLM judge.

Every record comes from the generator in [`bug-report-triage.ts`](bug-report-triage.ts): about
400 lines, with every field typed.

The deliberate errors we introduce are:
1. Wrong priority: The triage will mention setting a certain priority but the bug will be set to something different.
2. Missing duplicate ID: The triage will mention this is a duplicate, but the duplicate id field is not set.

## One bug and its duplicate

The problem with randomly generating duplicate bugs, in a framework like this is - a row is not allowed to look at other rows being generated in the same run. This is because when a field of row2 is being generated, row1 might not have finished generating everything and might be waiting on LLM calls.

We solve this by generating no duplicate bugs in one run, then generating duplicates only on another run. Our framework allows looking at another finished run as shared readonly data.

| | BUG-KXBMK (original) | BUG-4AMUX (`duplicateOf: "BUG-KXBMK"`) |
|---|---|---|
| area, severity | auth, medium | auth, medium (copied from the original) |
| environment | Android 13, native app 4.5.9 | iOS 17, native app 4.7.2 |
| title | Unable to sign in to the shopping app | Sign-in fails in the iOS shopping app |
| actual | The app does not sign me in. | Sign-in does not complete, so I can't access my account. |
| triage | identity: "This concerns authentication: the app fails to sign the user in after they submit account details…" | identity: "This is a duplicate of BUG-KXBMK, which reports being unable to sign in; …" |

## What is in a record

```ts
{
  pathology: "none" | "bad_priority" | "dup_no_id", // the injected pathology
  id: "BUG-4AMUX",
  duplicateOf?: "BUG-KXBMK",
  area, severity, priority,
  environment: { platform, os, browser, appVersion },
  report: { title, stepsToReproduce: string[], expected, actual, reproCode? },  // LLM, typed
  triage: { component, rationale },                                             // LLM, typed
  incidentNote?,                                                                 // LLM, worst bugs only
  ticketText,                                                                    // LLM, Markdown
}
```

## The dataset

`npx tsx examples/bug-triage/bug-report-triage.ts 100 examples/bug-triage/bug-triage-100.jsonl`,
seed 2026, model `openai/gpt-6-luna`.

| | |
|---|---|
| kind | 85 originals, 10 duplicates, 5 duplicates without an id |
| pathology | none 89, bad_priority 6, dup_no_id 5 |
| area | search 39, checkout 26, auth 20, notifications 15 |
| severity | low 41, medium 30, high 18, critical 11 |
| platform | web 42, ios 34, android 24 |
| triage component (LLM's choice) | mobile 38, backend 22, frontend 20, identity 18, payments 2 |
| incident notes | 20 (every critical or P0 bug) |

Checked on this file:
- All 10 duplicates name their original's id in the triage.
- All 5 dup_no_id rows say "duplicate of an existing issue", with no id.
- None of the other 85 rows calls itself a duplicate.
- All 6 bad_priority rationales name the priority the bug was triaged with, not the stored one.
- No rationale argues with its priority, so only the bad_priority rows disagree with it.

The same seed gives the same sampled values: ids, areas, environments, which bugs are duplicated
and which are corrupted. The LLM's text can differ from run to run.

## How it is built

### The LLM does not sample or make random choices

LLMs are known for being biased samplers. They will pick options more common in their training data, dragging the entire generated dataset towards the mode.
This is why we decide the actual properties of what to randomly generate in code. Then we ask the LLM to add flavor text, or to make choices that are not as important.
For example: we pick the bug priority level in code. Then we ask the LLM to generate text that reflects this decision.

```ts
priority: new SubCategorySamplerGen({
  values: {
    low:      { P0: 1,  P1: 2,  P2: 10, P3: 20 },
    critical: { P0: 20, P1: 6,  P2: 1,  P3: 1 },
    // ...
  },
}).bind({ category: r.severity }),
```

```ts
prompt`... The priority has been set to ${r.issueSpec.priority} (P0: drop everything, P3: someday).
${match({
  inputs: { reason: r.issueSpec.priorityReason },
  cases: [{ when: ({ reason }) => reason !== undefined,
            then: prompt`The priority is unusual for this severity, because ${r.issueSpec.priorityReason}. ...` }],
})}`
```

Two triage rationales from the dataset. The code chose the severity and the priority, and for the
second one, a reason for the mismatch; the LLM wrote the words:

| | decided in code | the LLM's rationale |
|---|---|---|
| BUG-RSH0Z | low severity, P3 | "The checkout UI accepts the discount code but fails to refresh the displayed order total, so this belongs to the frontend component. Moving to P3 is appropriate for a low-severity issue with a workaround of checking the final total before placing the order." |
| BUG-77NUD | low severity, P0, because "a key enterprise customer reported it" | "The report describes a vague usability issue in the web checkout experience, so frontend is the best fit. Moving to P0 because a key enterprise customer reported it, making immediate investigation and resolution critical despite the reported low severity." |

### Typed LLM calls feeding each other

The bug `report` is a typed LLM reply (`LLMStructuredGen` with a schema). The triage prompt reads it with
`json(r.report)`, and its own reply is typed too: `component` can only be one of six values, which
is checked on every reply. An invalid reply is retried, and the model is shown what was wrong. The
ticket prompt reads both. The plan runs the calls in dependency order, with the calls of one level
running in parallel across the batch.

### Impossible combinations are redrawn

Safari only on macOS, and the apps have no browser:

```ts
browser: ConditionalRejectionResamplerGen.bound({
  childGen: new CategorySamplerGen({ values: ["Chrome", "Firefox", "Safari", "Edge", "native app"] }),
  inputs: { platform: e.platform, os: e.os },
  accept: (browser, { platform, os }) =>
    platform !== "web" ? browser === "native app" : browser !== "native app" && (browser !== "Safari" || os === "macOS"),
}),
```

### Fields that shape the prompts, then disappear

The reporter (name, tech skills) and the issue spec (priority, detail level, whether to name the
priority) are `.temp()`. They are generated and read by the prompts, then dropped from the final records,
and from the record type, `Output<typeof BugReport>`. Novices write vaguely; only power users are
asked for repro code.

### Duplicates: a second run that reads the first

```ts
const originals = await preview({ gen: bugReportGen, numRecords: 85, seed });
const duplicates = await preview({
  gen: duplicateGen(originals.records),  // bugReportGen.clone(), five fields replaced
  numRecords: 10, seed,
  startIndex: originals.nextIndex,       // its own range of row indices
});
```

`duplicateGen` replaces five fields of the same tree. `dupSource` becomes a `SourceRowGen` over
the originals, and `duplicateOf`, `area` and `severity` are read from it. Everything else, including
the reporter, the environment and all the prompts, is the original tree's. The report prompt gets
"Someone else already reported this bug as ... describe it in your own words".

The dup_no_id run is the same clone without `duplicateOf`: the triage says "duplicate", but the
record does not say of what.

### Ids that give nothing away

The way we generate, all duplicate bug rows are next to each other. We can shuffle, but then bugs are not in order, and duplicates might seemingly refer to bugs filed later. The solution was to hash the bug ids, so each id remains unique but they look like UUIDs.

```ts
id: new UniqueIdGen({ prefix: "BUG-", length: 5 }),
```

The row index goes through a seeded Feistel permutation, so ids never repeat, across the three runs
too, and they are not in row order. The runs' records are shuffled together at the end. So neither
the position nor the id tells a checker which run made a record.

### The planted defects

| pathology | how | what a checker should notice |
|---|---|---|
| `bad_priority` (~5% of originals, drawn) | The stored `priority` is replaced after the prompts used the real one. The triage always names the real one. | `priority` disagrees with the ticket and with the rationale ("moving to P3"). |
| `dup_no_id` (exactly 5%, its own run) | A duplicate without `duplicateOf`. | The rationale says "duplicate of an existing issue", but `duplicateOf` is missing. |

## Run it

```sh
npx tsx examples/bug-triage/bug-report-triage.ts 20                 # into scratch/bug-report-triage.jsonl
npx tsx examples/bug-triage/bug-report-triage.ts 100 my-bugs.jsonl
```

It needs an OpenRouter key in the `OPENROUTER_API_KEY` environment variable or in a file of that name
in the repo root. `npm test` runs the whole pipeline against a mock model, with no key needed.
To use another provider, change `providers` and `models` at the top of
[`bug-report-triage.ts`](bug-report-triage.ts). There are presets for OpenAI, Anthropic, NVIDIA
(build.nvidia.com or a self-hosted NIM), OpenRouter, and a local Ollama:

```ts
const providers = { anthropic: Provider.anthropic() };  // key from ANTHROPIC_API_KEY
const models = { writer: { provider: "anthropic", model: "claude-sonnet-5-5", temperature: 1, maxTokens: 2048 } };
```

`Provider.openai()` reads `OPENAI_API_KEY` and `Provider.nvidia()` reads `NVIDIA_API_KEY`. The
fields name only the nickname `writer`, so nothing else changes.
