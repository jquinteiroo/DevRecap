/**
 * Semantic Report Composer.
 *
 * Covers the milestone's guarantees:
 *   - Workstreams are named by OBJECTIVE, never by a technology collection
 *     ("VUE & PDF" / "Command & Progress" are banned) and never by generic
 *     terms; technologies live under "Technical areas".
 *   - buildReportContext exposes only STRUCTURED FACTS (objectives, statuses,
 *     counts, terms) — never raw conversations, command output, or source code.
 *   - The composer abstraction: DeterministicComposer is the source of truth and
 *     always valid; an external composer receives ONLY the ReportContext.
 *   - The validator rejects fabricated / dishonest / generic output and
 *     composeReport falls back to the deterministic composer when it does.
 *   - Traceability: every section maps to real workstream + activity IDs.
 *   - Portuguese quality: objective-based headings with localized verbs, no
 *     English verb leakage, no "fez alterações em N arquivos" as the headline,
 *     domain/tech nouns preserved verbatim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  Activity, Project, ReportContext, StructuredReport, Settings,
} from "@devrecap/shared";
import {
  buildReportInput, buildReportContext, validateComposedReport,
  DeterministicComposer, LLMComposer, selectComposer, composeReport,
} from "@devrecap/report-engine";

// --- helpers ---------------------------------------------------------------
const PROJECTS: Project[] = [
  { id: "p1", name: "contracts", displayName: "Contracts App", type: "work", createdAt: "2026-08-28T00:00:00Z" },
];
let seq = 0;
function act(partial: Partial<Activity> & { title: string; status: Activity["status"]; startedAt: string }): Activity {
  return {
    id: `a${++seq}`, source: "codex", projectId: "p1",
    endedAt: partial.startedAt, category: "bugfix", summary: "", confidence: 0.6,
    reviewState: "pending", evidence: [{ id: `e${seq}`, activityId: `a${seq}`, kind: "shell_command", label: "x" }],
    metadata: {}, ...partial,
  } as Activity;
}
function buildInput(acts: Activity[], language: "auto" | "en" | "pt" = "auto") {
  return buildReportInput(acts, PROJECTS, {
    kind: "help_me_remember" as never, style: "spoken", length: "normal", language,
    range: { start: "2026-08-28T00:00:00Z", end: "2026-08-28T23:59:59Z" },
  }).input;
}
const base = Date.UTC(2026, 7, 28, 10, 0, 0);
function at(offsetMin: number) { return new Date(base + offsetMin * 60000).toISOString(); }

/** A realistic PDF/contract work set that USED to name a workstream "VUE & PDF". */
function contractActs(): Activity[] {
  return [
    act({
      title: "Investigated incorrect contract document generation",
      category: "investigation", status: "in_progress", startedAt: at(0),
      metadata: {
        filesRead: ["src/pdf/gen.vue", "src/pdf/acroform.php"],
        intents: ["os contratos estão gerando errado com os PDFs", "revisar o documento do contrato"],
      },
    }),
    act({
      title: "Fixed contract document PDF generation",
      category: "bugfix", status: "completed", startedAt: at(15),
      metadata: {
        filesModified: ["src/pdf/gen.vue", "src/pdf/forge.php"],
        testCount: 4, committed: true,
        intents: ["corrigir a geração do documento do contrato em PDF"],
      },
    }),
  ];
}

const SETTINGS: Settings = {
  timezone: "UTC", aiProvider: "deterministic", aiModel: "", ollamaEndpoint: "http://localhost:11434",
  redactionEnabled: true, showPayloadPreview: true, excludedProjectIds: [],
  defaultStyle: "spoken", defaultLength: "normal", defaultLanguage: "auto",
  dailyDurationSeconds: 0, reviewThreshold: 0.4,
};

// ---------------------------------------------------------------------------
// Objective-based naming (NOT technology collections).
// ---------------------------------------------------------------------------
test("workstreams are named by objective, never a technology collection", () => {
  const input = buildInput(contractActs(), "en");
  assert.ok(input.workstreams.length >= 1);
  for (const w of input.workstreams) {
    const name = (w.objective && w.objective.trim()) || w.title;
    // Banned: joining technology keywords with "&", or an all-caps tech pair.
    assert.doesNotMatch(name, /\bVUE\b.*&|&.*\bPDF\b/i, `tech-collection name banned, got "${name}"`);
    assert.doesNotMatch(name, /^[A-Z]+ & [A-Z]+$/, `"X & Y" tech-join banned, got "${name}"`);
    assert.doesNotMatch(name, /Command & Progress/i, `meaningless name banned, got "${name}"`);
    // It should read like an objective: "<Verb> the <subject>".
    assert.match(name, /^(Investigate|Fix|Build|Configure|Restructure|Validate|Document|Ship|Organize|Evolve|Work on)\b/,
      `objective-shaped name expected, got "${name}"`);
  }
});

test("banned generic terms never stand alone as a workstream name", () => {
  const input = buildInput(contractActs(), "en");
  const banned = /^(command|progress|application|system|project|activity|changes|development|files|code|implementation)\.?$/i;
  for (const w of input.workstreams) {
    const name = (w.objective && w.objective.trim()) || w.title;
    for (const word of name.split(/\s+/)) assert.doesNotMatch(word, banned, `generic term "${word}" in "${name}"`);
  }
});

test("technologies appear under technical terms, not as the objective", () => {
  const input = buildInput(contractActs(), "en");
  const w = input.workstreams[0];
  // The domain subject (contract / document) drives the name; the technology
  // (PDF, Vue) is supporting detail carried on techTerms.
  const name = (w.objective && w.objective.trim()) || w.title;
  assert.match(name.toLowerCase(), /contract|document/, `objective names the subject, got "${name}"`);
  const allTechs = input.workstreams.flatMap((x) => x.techTerms).map((t) => t.toLowerCase());
  assert.ok(allTechs.some((t) => /pdf|vue/.test(t)), "technologies preserved on techTerms");
});

// ---------------------------------------------------------------------------
// buildReportContext: structured facts only.
// ---------------------------------------------------------------------------
test("ReportContext contains only structured facts, no raw content", () => {
  const input = buildInput(contractActs(), "en");
  const ctx = buildReportContext(input);
  const json = JSON.stringify(ctx);
  // No raw conversation / prompt text leaked.
  assert.doesNotMatch(json, /os contratos estão gerando errado/, "raw intent text must not be in context");
  // No huge command output field.
  assert.doesNotMatch(json, /aggregated_output|stdout|stderr/i, "no raw command output field");
  // Structured facts ARE present.
  assert.ok(ctx.workstreams.length >= 1, "workstreams present");
  assert.ok(ctx.activities.length >= 1, "activities present");
  assert.ok(Array.isArray(ctx.technicalAreas), "technical areas present");
  for (const a of ctx.activities) {
    assert.equal(typeof a.filesModifiedCount, "number", "file COUNT, not file list");
    assert.equal(typeof a.status, "string");
  }
});

test("ReportContext preserves traceability: workstream → activity IDs", () => {
  const input = buildInput(contractActs(), "en");
  const ctx = buildReportContext(input);
  const actIds = new Set(ctx.activities.map((a) => a.id));
  for (const w of ctx.workstreams) {
    assert.ok(w.activityIds.length >= 1, "workstream references its activities");
    for (const id of w.activityIds) assert.ok(actIds.has(id), `activity ${id} present in context`);
  }
});

// ---------------------------------------------------------------------------
// Composer abstraction.
// ---------------------------------------------------------------------------
test("DeterministicComposer produces a valid, traceable StructuredReport", async () => {
  const input = buildInput(contractActs(), "en");
  const ctx = buildReportContext(input);
  const out = await new DeterministicComposer(input).compose(ctx);
  assert.equal(out.composer, "deterministic");
  assert.equal(out.fellBack, false);
  assert.ok(out.content.length > 0);
  assert.equal(out.sections.length, input.workstreams.length, "one section per workstream");
  for (const s of out.sections) assert.ok(s.activityIds.length >= 1, "sections keep activity refs");
  assert.equal(validateComposedReport(out, ctx).ok, true, "deterministic output is always valid");
});

test("selectComposer defaults to deterministic and only uses LLM when configured", () => {
  const input = buildInput(contractActs(), "en");
  assert.equal(selectComposer(SETTINGS, input).external, false, "deterministic by default");

  const openai = selectComposer({ ...SETTINGS, aiProvider: "openai", openaiApiKey: "sk-test" }, input);
  assert.equal(openai.external, true);
  assert.equal(openai.name, "openai");

  // OpenAI selected but NO key ⇒ must NOT become external (never mandatory).
  const noKey = selectComposer({ ...SETTINGS, aiProvider: "openai", openaiApiKey: undefined }, input);
  assert.equal(noKey.external, false, "no API key ⇒ deterministic, never fails");
});

test("an LLM composer receives ONLY the ReportContext (never the raw input)", async () => {
  const input = buildInput(contractActs(), "en");
  const ctx = buildReportContext(input);
  let seenPrompt = "";
  const composer = new LLMComposer("openai", async (p) => { seenPrompt = p; return "PARA ME LEMBRAR\n\nResumo\n\nFix the contract document."; }, input);
  await composer.compose(ctx);
  // The prompt must not carry raw conversation text or file lists.
  assert.doesNotMatch(seenPrompt, /os contratos estão gerando errado/, "no raw intent in LLM prompt");
  assert.doesNotMatch(seenPrompt, /forge\.php|gen\.vue/, "no raw file paths in LLM prompt");
});

// ---------------------------------------------------------------------------
// Validator + deterministic fallback.
// ---------------------------------------------------------------------------
function makeExternalComposer(name: string, produce: (ctx: ReportContext) => StructuredReport) {
  return {
    name, external: true,
    compose: async (ctx: ReportContext) => produce(ctx),
  };
}

test("validator rejects completion wording when nothing is complete → falls back", async () => {
  // All in-progress work.
  const acts = [
    act({ title: "Investigated contract document generation", category: "investigation", status: "in_progress", startedAt: at(0),
      metadata: { filesRead: ["src/pdf/gen.php"], intents: ["investigar geração do documento"] } }),
  ];
  const input = buildInput(acts, "en");
  const ctx = buildReportContext(input);
  const lying = makeExternalComposer("openai", (c) => ({
    content: "I completed and finished all of the contract work today.",
    sections: c.workstreams.map((w) => ({ heading: w.objective, body: "", workstreamId: w.id, activityIds: w.activityIds })),
    composer: "openai", fellBack: false,
  }));
  assert.equal(validateComposedReport(await lying.compose(ctx), ctx).ok, false);
  const composed = await composeReport(lying, input, ctx);
  assert.equal(composed.fellBack, true, "must fall back to deterministic");
  assert.match(composed.composer, /fell back/i);
  assert.doesNotMatch(composed.content, /\bcompleted\b/i, "deterministic fallback is honest");
});

test("validator rejects a fabricated technical term in the Technical areas line", async () => {
  const input = buildInput(contractActs(), "en");
  const ctx = buildReportContext(input);
  const fab = makeExternalComposer("openai", (c) => ({
    content: "Summary\n\nWork done.\n\nTechnical areas\nPDF, Kubernetes, GraphQL",
    sections: c.workstreams.map((w) => ({ heading: w.objective, body: "", workstreamId: w.id, activityIds: w.activityIds })),
    composer: "openai", fellBack: false,
  }));
  const v = validateComposedReport(await fab.compose(ctx), ctx);
  assert.equal(v.ok, false);
  assert.match(v.reason, /fabricated technical term/i);
  const composed = await composeReport(fab, input, ctx);
  assert.equal(composed.fellBack, true);
});

test("validator rejects generic and duplicate headings", async () => {
  const input = buildInput(contractActs(), "en");
  const ctx = buildReportContext(input);
  const wid = ctx.workstreams[0].id;
  const aid = ctx.workstreams[0].activityIds;

  const generic: StructuredReport = {
    content: "some text", composer: "openai", fellBack: false,
    sections: [{ heading: "the application", body: "", workstreamId: wid, activityIds: aid }],
  };
  assert.match(validateComposedReport(generic, ctx).reason, /generic heading/i);

  const dup: StructuredReport = {
    content: "some text", composer: "openai", fellBack: false,
    sections: [
      { heading: "Fix the contract document", body: "", workstreamId: wid, activityIds: aid },
      { heading: "Fix the contract document", body: "", workstreamId: wid, activityIds: aid },
    ],
  };
  assert.match(validateComposedReport(dup, ctx).reason, /duplicate heading/i);
});

test("validator rejects sections that reference unknown workstreams/activities", () => {
  const input = buildInput(contractActs(), "en");
  const ctx = buildReportContext(input);
  const bad: StructuredReport = {
    content: "text", composer: "openai", fellBack: false,
    sections: [{ heading: "Fix the contract document", body: "", workstreamId: "wst_does_not_exist", activityIds: ["ghost"] }],
  };
  assert.equal(validateComposedReport(bad, ctx).ok, false);
});

test("validator rejects fabricated next-steps / future plans", () => {
  const input = buildInput(contractActs(), "en");
  const ctx = buildReportContext(input);
  const plan: StructuredReport = {
    content: "Work summary.\n\nNext steps: I will implement the export feature tomorrow.",
    composer: "openai", fellBack: false,
    sections: ctx.workstreams.map((w) => ({ heading: w.objective, body: "", workstreamId: w.id, activityIds: w.activityIds })),
  };
  const v = validateComposedReport(plan, ctx);
  assert.equal(v.ok, false);
  assert.match(v.reason, /next steps|plan/i);
});

test("composeReport falls back to deterministic when the external composer throws", async () => {
  const input = buildInput(contractActs(), "en");
  const ctx = buildReportContext(input);
  const boom = makeExternalComposer("ollama", () => { throw new Error("connection refused"); });
  const composed = await composeReport(boom, input, ctx);
  assert.equal(composed.fellBack, true, "unavailable provider must not fail the report");
  assert.ok(composed.content.length > 0, "still returns a valid deterministic report");
});

test("a valid external composition is accepted (no needless fallback)", async () => {
  const input = buildInput(contractActs(), "en");
  const ctx = buildReportContext(input);
  const good = makeExternalComposer("openai", (c) => ({
    content: "Summary\n\nFixed the contract document generation and validated it with tests.\n\nTechnical areas\n" + c.technicalAreas.join(", "),
    sections: c.workstreams.map((w) => ({ heading: w.objective, body: "", workstreamId: w.id, activityIds: w.activityIds })),
    composer: "openai", fellBack: false,
  }));
  const composed = await composeReport(good, input, ctx);
  assert.equal(composed.fellBack, false, "valid LLM output is kept");
  assert.equal(composed.composer, "openai");
});

// ---------------------------------------------------------------------------
// Portuguese quality.
// ---------------------------------------------------------------------------
test("PT report uses localized objective verbs and never English work verbs", async () => {
  const input = buildInput(contractActs(), "pt");
  assert.equal(input.resolvedLanguage, "pt");
  const ctx = buildReportContext(input);
  const { content } = await composeReport(new DeterministicComposer(input), input, ctx);

  assert.match(content, /PARA ME LEMBRAR/);
  // Objective verb is localized (Corrigir / Investigar / Configurar / Desenvolver).
  assert.match(content, /\b(Corrigir|Investigar|Configurar|Desenvolver|Reestruturar|Validar|Documentar)\b/,
    "PT objective heading uses a localized verb");
  // No English work verbs / banned names leaking into a PT report.
  assert.doesNotMatch(content, /\b(Investigated|Worked on|Developed|Fixed|Implemented|Configured)\b/, "no English verbs in PT");
  assert.doesNotMatch(content, /VUE & PDF|Command & Progress/i, "no banned tech-collection names");
  // The file count is NOT the headline description.
  assert.doesNotMatch(content, /^.*fez alterações em \d+ arquivos\.?$/m,
    "file count must not be the whole/main sentence");
  // Domain nouns preserved verbatim (the PT intent says "contratos" — never
  // translated to English, never replaced by a technology).
  assert.match(content, /contrato/i, "PT domain noun preserved verbatim");
});

test("PT report keeps technologies in the Áreas técnicas section, not the headings", async () => {
  const input = buildInput(contractActs(), "pt");
  const ctx = buildReportContext(input);
  const { content } = await composeReport(new DeterministicComposer(input), input, ctx);
  assert.match(content, /Áreas técnicas/);
  // A heading (### ...) should name the objective/subject, not be a bare tech.
  const headings = content.split(/\r?\n/).filter((l) => l.startsWith("### "));
  for (const h of headings) {
    assert.doesNotMatch(h, /^### (PDF|Vue)$/i, `heading must not be a bare technology, got "${h}"`);
  }
});
