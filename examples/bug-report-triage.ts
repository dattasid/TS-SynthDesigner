// Bug-report triage: synthetic issue tracker data, one record per bug. A nested environment with a
// cross-field constraint, a reporter that shapes the prompt but is dropped, a typed LLM report that
// feeds a typed LLM triage, and an incident note only for the worst bugs. Runs on OpenRouter into
// scratch/bug-report-triage.jsonl:
//   npx tsx examples/bug-report-triage.ts [numRecords]
// Needs an OpenRouter key in the env var OPENROUTER_API_KEY or in a file of that name.
// Imported (by the tests), it only defines the generator.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FakerGen } from "../src/faker";
import {
  CategorySamplerGen,
  ConditionalRejectionResamplerGen,
  create,
  CustomGen,
  FunctionGen,
  json,
  LLMStructuredGen,
  LLMTextGen,
  match,
  MatchGen,
  prompt,
  Provider,
  reasoningOf,
  refs,
  rootRefs,
  SchemaBuilder,
  SubCategorySamplerGen,
  TreeGen,
  type Infer,
  type Output,
} from "../src/index";

const s = SchemaBuilder;

const providers = {
  openrouter: Provider.openRouter({ apiKey: existsSync("OPENROUTER_API_KEY") ? { file: "OPENROUTER_API_KEY" } : { env: "OPENROUTER_API_KEY" } }),
};
const models = {
  writer: {
    provider: "openrouter",
    model: "qwen/qwen3.8-flash",
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

// The priority is decided before the triage call (see IssueSpecTemp); the LLM explains it.
export const Triage = s.object({
  component: s.enum(["frontend", "backend", "payments", "identity", "mobile", "infrastructure"]),
  duplicateLikely: s.boolean({ description: "whether this sounds like a commonly reported bug" }),
  rationale: s.string({ description: "one or two sentences on the component and the given priority" }),
}, { name: "triage" });

// Pre-decide a few things, dont let LLM decide
export const IssueSpecTemp = s.object({
  priority: s.enum(["P0", "P1", "P2", "P3"]), // weighted
  detail: s.enum(["detailed", "detailedWReproCode", "vague"]), // only power users have repro code
}, { name: "issueSpec" });
export type IssueSpec = Infer<typeof IssueSpecTemp>;

export const BugReport = s.object({
  area: s.enum(["checkout", "search", "auth", "notifications"]),
  severity: s.enum(["low", "medium", "high", "critical"]),
  environment: Environment,
  reporter: Reporter.temp(),
  issueSpec: IssueSpecTemp.temp(), // shapes the prompts, then dropped
  priority: s.enum(["P0", "P1", "P2", "P3"]), // issueSpec's, kept in the record
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
    area: new CategorySamplerGen<BugReport["area"]>({ values: { checkout: 2, search: 3, auth: 2, notifications: 1 } }),
    // Mostly minor bugs: the first value is the most likely.
    severity: new CategorySamplerGen<BugReport["severity"]>({ values: ["low", "medium", "high", "critical"], skew: "zipf" }),
    environment: environmentGen,
    reporter: reporterGen,
    issueSpec: new TreeGen({
      schema: IssueSpecTemp,
      fields: {
        priority: new CategorySamplerGen<IssueSpec["priority"]>({ values: { P0: 1, P1: 2, P2: 4, P3: 3 } }),
        // Keyed by the reporter's skill: novices never send repro code.
        detail: new SubCategorySamplerGen<Reporter["techSavvy"], IssueSpec["detail"]>({
          values: {
            novice: { vague: 3, detailed: 1, detailedWReproCode: 0 },
            "power user": { vague: 1, detailed: 2, detailedWReproCode: 2 },
          },
        }).bind({ category: r.reporter.techSavvy }),
      },
    }),
    priority: FunctionGen.bound({ inputs: { priority: r.issueSpec.priority }, fn: ({ priority }) => priority }),

    report: new LLMStructuredGen({
      model: "writer",
      schema: Report,
      prompt: prompt`You are ${r.reporter.name}, filing a bug report about the ${r.area} feature of a shopping app. Your tech skills: ${r.reporter.techSavvy}. The bug's severity is ${r.severity}. Your setup:
${json(r.environment)}

`.match({
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
      prompt: prompt`You triage bugs for a shopping app. Reported severity: ${r.severity}. Area: ${r.area}. The priority has been set to ${r.priority} (P0: drop everything, P3: someday).
Environment:
${json(r.environment)}

Report:
${json(r.report)}

Pick the component, say whether it is likely a duplicate, and explain the component and the priority in the rationale.`,
    }),
    triageReasoning: reasoningOf(r.triage),

    // No otherwise: most rows get no note and make no call.
    incidentNote: new MatchGen({
      inputs: { severity: r.severity, priority: r.priority },
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
      prompt: prompt`Render this bug as a ticket in Markdown: title, priority, component, environment, steps, expected and actual, and the repro code if there is any.
Priority: ${r.priority}
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

// Run only when executed directly, not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const numRecords = Number(process.argv[2] ?? 10);
  const path = "scratch/bug-report-triage.jsonl";
  const { seed } = await create({ gen: bugReportGen, numRecords, path, overwrite: true, seed: 2026, providers, models });
  console.log(`${numRecords} records in ${path} (seed ${seed.join(",")})`);
}
