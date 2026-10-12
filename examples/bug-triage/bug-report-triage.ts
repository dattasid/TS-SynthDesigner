// Bug-report triage: synthetic issue tracker data, one record per bug. A nested environment with a
// cross-field constraint, a reporter that shapes the prompt but is dropped, a typed LLM report that
// feeds a typed LLM triage, and an incident note only for the worst bugs. Some bugs duplicate earlier
// ones: made in later runs that read the first run's records. A few records are corrupted on purpose
// (`pathology`), as test data for a checker. See README.md here. Runs on OpenRouter, into
// scratch/bug-report-triage.jsonl unless a path is given:
//   npx tsx examples/bug-triage/bug-report-triage.ts [numRecords] [path]
// Needs an OpenRouter key in the env var OPENROUTER_API_KEY or in a file of that name.
// Imported (by the tests), it only defines the generator.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FakerGen } from "../../src/faker";
import {
  CategorySamplerGen,
  ConditionalRejectionResamplerGen,
  ConstantGen,
  CustomGen,
  FunctionGen,
  json,
  LLMStructuredGen,
  LLMTextGen,
  match,
  MatchGen,
  preview,
  prompt,
  Provider,
  reasoningOf,
  refs,
  rootRefs,
  SchemaBuilder,
  Sfc32,
  SourceRowGen,
  SubCategorySamplerGen,
  TreeGen,
  UniqueIdGen,
  type Infer,
  type LLMProvider,
  type ModelSpec,
  type Output,
} from "../../src/index";

const s = SchemaBuilder;

const providers = {
  openrouter: Provider.openRouter({ apiKey: existsSync("OPENROUTER_API_KEY") ? { file: "OPENROUTER_API_KEY" } : { env: "OPENROUTER_API_KEY" } }),
};
const models = {
  writer: {
    provider: "openrouter",
    model: "openai/gpt-6-luna",
    temperature: 1,
    topP: 0.95,
    maxTokens: 2048,
    extra: { reasoning: { enabled: false } },
  },
};

// Where the bug was seen.
export const Environment = s.object({
  platform: s.enum(["web", "ios", "android"]),
  os: s.string(),
  browser: s.string(), // "native app" off the web
  appVersion: s.string(),
}, { name: "environment" });
export type Environment = Infer<typeof Environment>;

// Who reported it: shapes the report, then dropped.
export const Reporter = s.object({
  name: s.string(),
  techSavvy: s.enum(["novice", "power user"]),
  email: s.string(),
}, { name: "reporter" });
export type Reporter = Infer<typeof Reporter>;

// LLM reply schemas.
export const Report = s.object({
  title: s.string({ description: "a one-line summary, as the reporter would write it" }),
  stepsToReproduce: s.array(s.string(), { description: "the steps, as the reporter gives them; may be few or vague" }),
  expected: s.string(),
  actual: s.string(),
  reproCode: s.string({ description: "a minimal code snippet that reproduces the bug, only when asked for" }).optional(),
}, { name: "report" });

// The priority and whether it is a duplicate are decided before the triage call; the LLM explains them.
export const Triage = s.object({
  component: s.enum(["frontend", "backend", "payments", "identity", "mobile", "infrastructure"]),
  rationale: s.string({ description: "one or two sentences on the component and the given priority" }),
}, { name: "triage" });

// The earlier bug a duplicate repeats: a few fields of a record of the first run.
export const DupSource = s.object({
  id: s.string(),
  area: s.enum(["checkout", "search", "auth", "notifications"]),
  severity: s.enum(["low", "medium", "high", "critical"]),
  title: s.string(),
  actual: s.string(),
}, { name: "dupSource" });
export type DupSource = Infer<typeof DupSource>;

// Pre-decide a few things, dont let LLM decide
export const IssueSpecTemp = s.object({
  priority: s.enum(["P0", "P1", "P2", "P3"]), // weighted by severity: mostly in line, sometimes not
  // Why the priority is far from the severity, when it is: drawn here, explained by the LLM.
  priorityReason: s.string().optional(),
  detail: s.enum(["detailed", "detailedWReproCode", "vague"]), // only power users have repro code
  mentionPriority: s.boolean(), // the triage names the priority ("moved to P0"); always for bad_priority
}, { name: "issueSpec" });
export type IssueSpec = Infer<typeof IssueSpecTemp>;

// Severity is technical impact, priority is business urgency. A gap of 2 or more steps needs a reason.
const severityRank = { low: 0, medium: 1, high: 2, critical: 3 } as const;
const urgencyRank = { P3: 0, P2: 1, P1: 2, P0: 3 } as const;
const priorityGap = (severity: BugReport["severity"], priority: IssueSpec["priority"]) => urgencyRank[priority] - severityRank[severity];

export const BugReport = s.object({
  // A deliberate defect, the label for a checker. bad_priority: the stored priority is not the one
  // the triage and ticket were written for. dup_no_id: a duplicate, so said by the triage, without
  // duplicateOf.
  pathology: s.enum(["none", "bad_priority", "dup_no_id"]),
  id: s.string(), // BUG-7KQ2M: from the row index, so unique across the runs, and no clue to which run made it
  dupSource: DupSource.optional().temp(), // only in the duplicate runs
  duplicateOf: s.string().optional(), // the id of the bug this one duplicates
  area: s.enum(["checkout", "search", "auth", "notifications"]),
  severity: s.enum(["low", "medium", "high", "critical"]),
  environment: Environment,
  reporter: Reporter.temp(),
  issueSpec: IssueSpecTemp.temp(), // shapes the prompts, then dropped
  priority: s.enum(["P0", "P1", "P2", "P3"]), // issueSpec's, kept in the record; another one for bad_priority
  report: Report,
  triage: Triage,
  triageReasoning: s.string().optional(), // only reasoning models send it
  incidentNote: s.string().optional(), // only for the worst bugs
  ticketText: s.string(),
}, { name: "bug" });
export type BugReport = Infer<typeof BugReport>;
/** A record as written: no reporter, no issueSpec. */
export type BugReportRecord = Output<typeof BugReport>;

const e = refs(Environment); // relative: the environment's own fields
const r = rootRefs(BugReport);

const osByPlatform = {
  web: ["Windows", "macOS", "Linux", "ChromeOS"],
  ios: ["iOS 17", "iOS 18", "iPadOS 18"],
  android: ["Android 13", "Android 14", "Android 15"],
};

export const environmentGen = new TreeGen({
  schema: Environment,
  fields: {
    platform: new CategorySamplerGen<Environment["platform"]>({ values: { web: 3, ios: 2, android: 2 } }),
    os: new SubCategorySamplerGen<Environment["platform"]>({ values: osByPlatform }).bind({ category: e.platform }),
    // Draw any browser, redraw the impossible pairs: Safari only on macOS, and the apps have no browser.
    browser: ConditionalRejectionResamplerGen.bound({
      childGen: new CategorySamplerGen({ values: ["Chrome", "Firefox", "Safari", "Edge", "native app"] }),
      inputs: { platform: e.platform, os: e.os },
      accept: (browser, { platform, os }) =>
        platform !== "web" ? browser === "native app" : browser !== "native app" && (browser !== "Safari" || os === "macOS"),
    }),
    appVersion: CustomGen.bound({ inputs: {}, fn: (_, ctx) => `4.${ctx.rng.int(0, 12)}.${ctx.rng.int(0, 9)}` }),
  },
});

const rp = refs(Reporter);
export const reporterGen = new TreeGen({
  schema: Reporter,
  fields: {
    name: new FakerGen({ fn: (f) => f.person.fullName() }),
    techSavvy: new CategorySamplerGen<Reporter["techSavvy"]>({ values: { novice: 2, "power user": 1 } }),
    email: FakerGen.bound({
      inputs: { name: rp.name },
      fn: (f, { name }) => f.internet.email({ firstName: name.split(" ")[0], lastName: name.split(" ").at(-1) }),
    }),
  },
});

/** Its LLM fields use the model nickname "writer"; `models` above (or a test's mock) says what it is. */
export const bugReportGen = new TreeGen({
  id: "bug",
  schema: BugReport,
  fields: {
    pathology: new CategorySamplerGen<BugReport["pathology"]>({ values: { none: 95, bad_priority: 5, dup_no_id: 0 } }), // dup_no_id: only in its own run (bugReports)
    id: new UniqueIdGen({ prefix: "BUG-", length: 5 }),
    // Set by duplicateGen; read by the prompts, so present (and undefined) here.
    dupSource: new ConstantGen<DupSource | undefined>({ value: undefined }),
    duplicateOf: new ConstantGen<string | undefined>({ value: undefined }),
    area: new CategorySamplerGen<BugReport["area"]>({ values: { checkout: 2, search: 3, auth: 2, notifications: 1 } }),
    // Mostly minor bugs: the first value is the most likely.
    severity: new CategorySamplerGen<BugReport["severity"]>({ values: ["low", "medium", "high", "critical"], skew: "zipf" }),
    environment: environmentGen,
    reporter: reporterGen,
    issueSpec: new TreeGen({
      schema: IssueSpecTemp,
      fields: {
        priority: new SubCategorySamplerGen<BugReport["severity"], IssueSpec["priority"]>({
          values: {
            low: { P0: 1, P1: 2, P2: 10, P3: 20 },
            medium: { P0: 1, P1: 4, P2: 12, P3: 4 },
            high: { P0: 4, P1: 12, P2: 3, P3: 1 },
            critical: { P0: 20, P1: 6, P2: 1, P3: 1 },
          },
        }).bind({ category: r.severity }),
        // Only the mismatches get a reason; the others stay undefined.
        priorityReason: new MatchGen({
          inputs: { severity: r.severity, priority: r.issueSpec.priority },
          cases: [
            {
              when: ({ severity, priority }) => priorityGap(severity, priority) <= -2, // bad bug, fixed later
              then: new CategorySamplerGen({
                values: [
                  "there is an easy workaround",
                  "it is in a feature being retired next quarter",
                  "it only happens in a rare edge case",
                  "the fix needs a large refactor that is already scheduled",
                ],
              }),
            },
            {
              when: ({ severity, priority }) => priorityGap(severity, priority) >= 2, // small bug, fixed now
              then: new CategorySamplerGen({
                values: [
                  "a key enterprise customer reported it",
                  "it is on the homepage, seen by every visitor",
                  "the wording has legal or compliance implications",
                  "it is on a screen in next week's launch demo",
                ],
              }),
            },
          ],
        }),
        // Keyed by the reporter's skill: novices never send repro code.
        detail: new SubCategorySamplerGen<Reporter["techSavvy"], IssueSpec["detail"]>({
          values: {
            novice: { vague: 3, detailed: 1, detailedWReproCode: 0 },
            "power user": { vague: 1, detailed: 2, detailedWReproCode: 2 },
          },
        }).bind({ category: r.reporter.techSavvy }),
        mentionPriority: CustomGen.bound({
          inputs: { pathology: r.pathology },
          fn: ({ pathology }, ctx) => pathology === "bad_priority" || ctx.rng.random() < 0.25,
        }),
      },
    }),
    // The prompts all use issueSpec's priority; only this field is corrupted.
    priority: CustomGen.bound({
      inputs: { priority: r.issueSpec.priority, pathology: r.pathology },
      fn: ({ priority, pathology }, ctx): BugReport["priority"] => {
        if (pathology !== "bad_priority") return priority;
        const others = (["P0", "P1", "P2", "P3"] as const).filter((p) => p !== priority);
        return others[ctx.rng.int(0, others.length - 1)];
      },
    }),

    report: new LLMStructuredGen({
      model: "writer",
      schema: Report,
      prompt: prompt`You are ${r.reporter.name}, filing a bug report about the ${r.area} feature of a shopping app. Your tech skills: ${r.reporter.techSavvy}. The bug's severity is ${r.severity}. Your setup:
${json(r.environment)}

${match({
  inputs: { dup: r.dupSource },
  cases: [{
    when: ({ dup }) => dup !== undefined,
    then: prompt`Someone else already reported this bug as "${r.dupSource.title}" (what happened: ${r.dupSource.actual}). You hit the same bug: describe it in your own words, from your own setup; do not copy their wording.

`,
  }],
})}`.match({
        inputs: { detail: r.issueSpec.detail },
        cases: [
          {
            when: ({ detail }) => detail === "vague",
            then: "Write vaguely and emotionally: skip steps, and do not mention versions. Leave reproCode null.",
          },
          {
            when: ({ detail }) => detail === "detailed",
            then: "Write precise, numbered steps, and mention your OS, browser and app version. Leave reproCode null.",
          },
        ],
        // detailedWReproCode
        otherwise: "Write precise, numbered steps, mention your OS, browser and app version, and put a minimal code snippet that reproduces the bug (e.g. a curl call or a few lines of JavaScript) in reproCode.",
      }),
    }),

    // A typed reply feeding another typed call. The priority is given, not chosen.
    triage: new LLMStructuredGen({
      model: "writer",
      schema: Triage,
      prompt: prompt`You triage bugs for a shopping app. Reported severity: ${r.severity}. Area: ${r.area}. The priority has been set to ${r.issueSpec.priority} (P0: drop everything, P3: someday).
Environment:
${json(r.environment)}

Report:
${json(r.report)}

${match({
  inputs: { reason: r.issueSpec.priorityReason },
  cases: [{
    when: ({ reason }) => reason !== undefined,
    then: prompt`The priority is unusual for this severity, because ${r.issueSpec.priorityReason}. The rationale must explain this.
`,
  }],
})}${match({
  inputs: { mention: r.issueSpec.mentionPriority },
  cases: [{
    when: ({ mention }) => mention,
    then: prompt`The rationale must name the priority, ${r.issueSpec.priority}, as a triager would (e.g. "moving to ${r.issueSpec.priority}", "prio is ${r.issueSpec.priority}").
`,
  }],
  otherwise: `Do not name the priority level (P0 to P3) in the rationale.
`,
})}${match({
  inputs: { dup: r.dupSource, of: r.duplicateOf },
  cases: [
    {
      when: ({ dup, of }) => dup !== undefined && of !== undefined,
      then: prompt`This bug duplicates ${r.duplicateOf} ("${r.dupSource.title}"). The rationale must say it is a duplicate of ${r.duplicateOf}.
`,
    },
    {
      when: ({ dup }) => dup !== undefined,
      then: prompt`This bug duplicates an earlier report ("${r.dupSource.title}"), whose ID you do not have. The rationale must say it is a duplicate of an existing issue, without any ID.
`,
    },
  ],
  otherwise: `Do not call it a duplicate.
`,
})}Pick the component, and explain the component and the priority in the rationale. The rationale must support the given priority: do not question it or suggest another.`,
    }),
    triageReasoning: reasoningOf(r.triage),

    // No otherwise: most rows get no note and make no call.
    incidentNote: new MatchGen({
      inputs: { severity: r.severity, priority: r.issueSpec.priority },
      cases: [{
        when: ({ severity, priority }) => severity === "critical" || priority === "P0",
        then: new LLMTextGen({
          model: "writer",
          prompt: prompt`Write a 3-line incident summary (impact, suspected cause, next step) for this bug in the ${r.triage.component} component:
${json(r.report)}`,
        }),
      }],
    }),

    ticketText: new LLMTextGen({
      model: "writer",
      prompt: prompt`Render this bug as a ticket in Markdown: ID, title, priority, component, environment, steps, expected and actual, and the repro code if there is any.
ID: ${r.id}
Priority: ${r.issueSpec.priority}${match({
  inputs: { of: r.duplicateOf },
  cases: [{ when: ({ of }) => of !== undefined, then: prompt`
Duplicate of: ${r.duplicateOf}` }],
})}
Report:
${json(r.report)}
Triage:
${json(r.triage)}
Environment:
${json(r.environment)}
${match({
  inputs: { note: r.incidentNote },
  cases: [{ when: ({ note }) => note !== undefined, then: prompt`Add an "Incident" section with this note:
${r.incidentNote}
` }],
})}Reply with only the ticket.`,
    }),
  },
});

/**
 * The duplicates of a set of bugs: each repeats one of `originals` (drawn at random, so a popular bug
 * may come up twice), in its area and severity, with its own reporter, words and triage.
 * `withId: false` leaves out duplicateOf: the dup_no_id pathology.
 */
export function duplicateGen(originals: readonly BugReportRecord[], { withId = true } = {}) {
  const sources = originals.map(({ id, area, severity, report }): DupSource => ({ id, area, severity, title: report.title, actual: report.actual }));
  return bugReportGen.clone({
    id: withId ? "duplicate" : "duplicate without id",
    fields: {
      pathology: new ConstantGen<BugReport["pathology"]>({ value: withId ? "none" : "dup_no_id" }),
      dupSource: new SourceRowGen({ rows: sources, pick: "random" }),
      ...(withId && { duplicateOf: FunctionGen.bound({ inputs: { source: r.dupSource }, fn: ({ source }) => source!.id }) }),
      area: FunctionGen.bound({ inputs: { source: r.dupSource }, fn: ({ source }) => source!.area }),
      severity: FunctionGen.bound({ inputs: { source: r.dupSource }, fn: ({ source }) => source!.severity }),
    },
  });
}

export interface BugReportsParams {
  numRecords: number;
  seed: number;
  providers: Readonly<Record<string, LLMProvider>>;
  models: Readonly<Record<string, ModelSpec>>;
}

/**
 * The whole dataset, in three runs over one seed, each its own range of row indices (so of ids): the
 * originals, 10% duplicates of them, and 5% dup_no_id. Then shuffled, so the position does not give
 * the kind away. Exact counts, unlike a sampled pathology.
 */
export async function bugReports({ numRecords, seed, providers, models }: BugReportsParams): Promise<BugReportRecord[]> {
  const numDuplicates = Math.round(numRecords * 0.1);
  const numNoId = Math.round(numRecords * 0.05);
  const llm = { seed, providers, models };
  const originals = await preview({ gen: bugReportGen, numRecords: numRecords - numDuplicates - numNoId, ...llm });
  const duplicates = await preview({ gen: duplicateGen(originals.records), numRecords: numDuplicates, startIndex: originals.nextIndex, ...llm });
  const noId = await preview({ gen: duplicateGen(originals.records, { withId: false }), numRecords: numNoId, startIndex: duplicates.nextIndex, ...llm });
  const records = [...originals.records, ...duplicates.records, ...noId.records];
  const rng = new Sfc32([seed]).fork("order"); // Fisher-Yates
  for (let i = records.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [records[i], records[j]] = [records[j]!, records[i]!];
  }
  return records;
}

// Run only when executed directly, not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const numRecords = Number(process.argv[2] ?? 20);
  const path = process.argv[3] ?? "scratch/bug-report-triage.jsonl";
  const records = await bugReports({ numRecords, seed: 2026, providers, models });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((x) => JSON.stringify(x) + "\n").join(""));
  console.log(`${records.length} records in ${path} (seed 2026)`);
}
