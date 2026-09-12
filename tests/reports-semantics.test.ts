/**
 * Semantics V3 + Help Me Remember reports.
 *
 * Covers status-aware titles, richer summaries, conservative Workstream
 * grouping (and NON-grouping of unrelated work), the new report kinds
 * (help_me_remember / daily / review), Portuguese output, traceability from
 * report → workstreams → activities, and the guarantee that reports are built
 * from ACCEPTED activities (never raw noise) and never claim completion for
 * in-progress work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Activity, Project } from "@devrecap/shared";
import { parseCodexJsonl } from "@devrecap/codex-parser";
import { normalizeEvents, buildActivities } from "@devrecap/activity-engine";
import {
  buildReportInput, detectLanguage, DeterministicProvider,
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
function summaryOf(a: Activity) {
  const { input } = buildReportInput([a], PROJECTS, {
    kind: "custom", style: "professional", length: "detailed",
    range: { start: "2026-08-01", end: "2026-09-01" },
  });
  return input.projects[0].activities[0];
}
function report(acts: Activity[], kind: string, language: "auto" | "en" | "pt" = "auto") {
  const { input } = buildReportInput(acts, PROJECTS, {
    kind: kind as never, style: "professional", length: "detailed", language,
    range: { start: "2026-08-28T00:00:00Z", end: "2026-08-28T23:59:59Z" },
  });
  return input;
}

// ---------------------------------------------------------------------------
// Engine semantics: build activities from real events to exercise titleFor.
// ---------------------------------------------------------------------------
function build(lines: string[]) {
  const { events } = parseCodexJsonl(lines.join("\n") + "\n");
  return buildActivities(normalizeEvents(events), "codex", { projectId: "p1" });
}
let clk = Date.UTC(2026, 7, 28, 10, 0, 0);
function ts() { clk += 60000; return new Date(clk).toISOString(); }
function reset() { clk = Date.UTC(2026, 7, 28, 10, 0, 0); }
function ic(item: Record<string, unknown>) { return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "item_completed", item } }); }
function meta() { return JSON.stringify({ timestamp: ts(), type: "session_meta", payload: { id: "s", cwd: "/home/user/contracts" } }); }

test("title verbs match status: completed bugfix says 'Fixed'; in-progress never does", () => {
  reset();
  const done = build([
    meta(),
    ic({ type: "UserMessage", message: "fix the contract validation bug" }),
    ic({ type: "FileChange", changes: { "/home/user/contracts/src/validate.php": { type: "update" } } }),
    ic({ type: "CommandExecution", command: ["php artisan test"], aggregated_output: "OK (10 tests)", exit_code: 0 }),
    ic({ type: "AgentMessage", message: "Fixed the validation; tests pass." }),
  ]);
  assert.equal(done.length, 1);
  assert.equal(done[0].activity.status, "completed");
  assert.match(done[0].activity.title, /^Fixed /, `completed bugfix uses 'Fixed', got "${done[0].activity.title}"`);

  reset();
  const wip = build([
    meta(),
    ic({ type: "UserMessage", message: "fix the contract validation bug" }),
    ic({ type: "FileChange", changes: { "/home/user/contracts/src/validate.php": { type: "update" } } }),
    ic({ type: "CommandExecution", command: ["php artisan test"], aggregated_output: "2 failed", exit_code: 1 }),
    ic({ type: "AgentMessage", message: "Still investigating why it fails." }),
  ]);
  assert.equal(wip.length, 1);
  assert.notEqual(wip[0].activity.status, "completed");
  assert.doesNotMatch(wip[0].activity.title, /\bFixed\b/i, `in-progress must NOT say 'Fixed', got "${wip[0].activity.title}"`);
});

test("titles are concise work topics, not raw prompts (politeness stripped)", () => {
  reset();
  const built = build([
    meta(),
    ic({ type: "UserMessage", message: "Vc consegue colocar os PDFs no forge_files por favor?" }),
    ic({ type: "FileChange", changes: { "/home/user/contracts/src/forge.php": { type: "update" } } }),
  ]);
  const a = built[0].activity;
  const t = a.title;
  // V2: title is a normalized work-topic phrase, NOT the raw prompt. The
  // politeness opener and prompt wording must not appear; the technical terms
  // are preserved in the activity's evidence/areas rather than the title.
  assert.doesNotMatch(t, /vc consegue|por favor|colocar os/i, `raw prompt not echoed, got "${t}"`);
  assert.match(t, /contract|document|PDF/i, `topic-based title, got "${t}"`);
  assert.ok(t.length <= 92);
});

test("summary is rich prose with outcome, never a bare 'Modified n files' dump", () => {
  reset();
  const built = build([
    meta(),
    ic({ type: "UserMessage", message: "adjust the autoload.php configuration" }),
    ic({ type: "CommandExecution", command: ["cat src/autoload.php"], aggregated_output: "...", exit_code: 0 }),
    ic({ type: "FileChange", changes: { "/home/user/contracts/src/autoload.php": { type: "update" } } }),
    ic({ type: "AgentMessage", message: "Still working on it." }),
  ]);
  const s = built[0].activity.summary;
  assert.ok(/in progress/i.test(s), `in-progress outcome stated, got "${s}"`);
  assert.doesNotMatch(s, /completed/i, "must not claim completion");
  assert.ok(/autoload\.php/.test(s), "preserves technical term");
  assert.ok(s.length > 40, "summary is substantive prose");
});

// ---------------------------------------------------------------------------
// Workstream grouping.
// ---------------------------------------------------------------------------
test("related activities group into ONE workstream (shared technical topic)", () => {
  const base = Date.UTC(2026, 7, 28, 10, 0, 0);
  const acts = [
    act({ title: "Investigated incorrect contract PDF generation", status: "in_progress", startedAt: new Date(base).toISOString(), metadata: { filesRead: ["src/pdf/gen.php"], intents: ["os PDFs dos contratos estão errados"] } }),
    act({ title: "Reviewed AcroForm templates", status: "in_progress", startedAt: new Date(base + 600000).toISOString(), metadata: { filesRead: ["src/pdf/acroform.php"], intents: ["revisar os AcroForms"] } }),
    act({ title: "Configured PDF storage in forge_files", status: "in_progress", startedAt: new Date(base + 1200000).toISOString(), metadata: { filesModified: ["src/pdf/forge.php"], intents: ["colocar PDFs no forge_files"] } }),
  ];
  const input = report(acts, "help_me_remember");
  assert.equal(input.workstreams.length, 1, `PDF activities should form one workstream, got ${input.workstreams.length}`);
  assert.equal(input.workstreams[0].activities.length, 3, "all three preserved under the workstream");
});

test("unrelated activities are NOT grouped (different topic + files)", () => {
  const base = Date.UTC(2026, 7, 28, 10, 0, 0);
  const acts = [
    act({ title: "Configured PDF storage in forge_files", status: "in_progress", startedAt: new Date(base).toISOString(), metadata: { filesModified: ["src/pdf/forge.php"], intents: ["colocar PDFs no forge_files"] } }),
    act({ title: "Updated the login page CSS", status: "completed", startedAt: new Date(base + 600000).toISOString(), metadata: { filesModified: ["src/ui/login.css"], intents: ["change the login button color"] } }),
  ];
  const input = report(acts, "help_me_remember");
  assert.equal(input.workstreams.length, 2, "unrelated work must stay in separate workstreams");
});

test("workstream grouping never deletes activities (lossless)", () => {
  const base = Date.UTC(2026, 7, 28, 10, 0, 0);
  const acts = [
    act({ title: "Investigated PDF generation", status: "in_progress", startedAt: new Date(base).toISOString(), metadata: { filesRead: ["src/pdf/a.php"], intents: ["pdf errado"] } }),
    act({ title: "Fixed PDF template loading", status: "completed", startedAt: new Date(base + 300000).toISOString(), metadata: { filesModified: ["src/pdf/b.php"], intents: ["pdf template"] } }),
    act({ title: "Tuned the search index", status: "completed", startedAt: new Date(base + 900000).toISOString(), metadata: { filesModified: ["src/search/index.ts"], intents: ["search relevance"] } }),
  ];
  const input = report(acts, "review");
  const total = input.workstreams.reduce((n, w) => n + w.activities.length, 0);
  assert.equal(total, 3, "every activity appears in exactly one workstream");
});

test("workstream status aggregates: completed + in_progress ⇒ partially_completed", () => {
  const base = Date.UTC(2026, 7, 28, 10, 0, 0);
  const acts = [
    act({ title: "Fixed PDF loader", status: "completed", startedAt: new Date(base).toISOString(), metadata: { filesModified: ["src/pdf/a.php"], intents: ["pdf"] } }),
    act({ title: "Investigated remaining PDF errors", status: "in_progress", startedAt: new Date(base + 300000).toISOString(), metadata: { filesRead: ["src/pdf/a.php"], intents: ["pdf"] } }),
  ];
  const input = report(acts, "review");
  assert.equal(input.workstreams.length, 1);
  // V3: a mix of completed + in_progress aggregates to partially_completed
  // (more accurate than a flat "in progress" for the whole workstream).
  assert.equal(input.workstreams[0].status, "partially_completed");
});

// ---------------------------------------------------------------------------
// Report generation per kind.
// ---------------------------------------------------------------------------
async function render(acts: Activity[], kind: string, language: "auto" | "en" | "pt" = "auto") {
  const input = report(acts, kind, language);
  const { content } = await new DeterministicProvider().generateReport(input);
  return { content, input };
}
function contractActs() {
  const base = Date.UTC(2026, 7, 28, 10, 0, 0);
  return [
    act({ title: "Investigated incorrect contract PDF generation", status: "in_progress", startedAt: new Date(base).toISOString(), metadata: { filesRead: ["src/pdf/gen.php"], intents: ["os contratos estão gerando errado com os PDFs"] } }),
    act({ title: "Configured PDF storage in forge_files", status: "in_progress", startedAt: new Date(base + 900000).toISOString(), metadata: { filesModified: ["src/pdf/forge.php"], intents: ["colocar os PDFs no forge_files para os contratos"] } }),
  ];
}

test("Help Me Remember report is generated from workstreams with honest outcome", async () => {
  const { content, input } = await render(contractActs(), "help_me_remember", "en");
  assert.match(content, /HELP ME REMEMBER/);
  assert.match(content, /Main work/i, "has a synthesized main-work section");
  assert.match(content, /Summary/i, "has a day summary section");
  assert.ok(input.workstreams.length >= 1);
  assert.match(content, /In progress/i, "honest in-progress outcome");
  assert.doesNotMatch(content, /\bCompleted\b/, "must not claim completion for in-progress work");
  // Synthesis, not transcript: no chronological "Then," / "Depois," replay.
  assert.doesNotMatch(content, /^\s*(Then,|Depois,|First,|Primeiro,)/m, "must not be a chronological transcript");
});

test("Daily report is concise and honest about outcome", async () => {
  const { content } = await render(contractActs(), "daily", "en");
  assert.ok(content.length > 0);
  // A single natural narrative; honest that in-progress work isn't done.
  assert.match(content, /still in progress|in progress/i);
  assert.doesNotMatch(content, /\bcompleted\b/i);
});

test("Review report lists a synthesized narrative + status per workstream", async () => {
  const { content } = await render(contractActs(), "review", "en");
  assert.match(content, /REVIEW/);
  assert.match(content, /Status: In progress/i);
  // Terms live in the Technical areas line, not necessarily the narrative.
  assert.match(content, /forge_files|PDF|contract document/i);
});

// ---------------------------------------------------------------------------
// Language.
// ---------------------------------------------------------------------------
test("language auto-detects Portuguese from intents and localizes scaffolding", async () => {
  const input = report(contractActs(), "help_me_remember", "auto");
  assert.equal(input.resolvedLanguage, "pt", "PT intents should resolve to pt");
  const { content } = await new DeterministicProvider().generateReport(input);
  assert.match(content, /PARA ME LEMBRAR/);
  assert.match(content, /Principais frentes/, "localized main-work heading");
  assert.match(content, /Em andamento/, "outcome word localized");
  // No English activity verbs leaking into a Portuguese report.
  assert.doesNotMatch(content, /\b(Investigated|Developed|Fixed|Committed|Worked on|Implemented|Configured|Then,|First,)\b/, "no English verbs/connectors in PT report");
});

test("detectLanguage prefers English for English intents", () => {
  assert.equal(detectLanguage(["please fix the login error", "add a new endpoint"]), "en");
  assert.equal(detectLanguage(["corrigir a geração dos contratos", "os PDFs estão errados"]), "pt");
});

// ---------------------------------------------------------------------------
// Traceability + accepted-data-only.
// ---------------------------------------------------------------------------
test("report is traceable: workstream → activities (with ids) → evidence counts", () => {
  const input = report(contractActs(), "help_me_remember");
  const w = input.workstreams[0];
  assert.ok(w.activities.length >= 1);
  for (const a of w.activities) {
    assert.ok(a.id, "activity carries its id for drill-down");
    assert.equal(typeof a.evidenceCount, "number", "evidence count present for 'View evidence'");
  }
});

test("reports are built from accepted Activities, not raw Codex noise", () => {
  // A rollout of pure noise yields zero activities → zero workstreams → empty report.
  reset();
  const noiseActs = build([
    meta(),
    JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "token_count", info: {} } }),
    ic({ type: "Reasoning", text: "thinking" }),
    JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "turn_complete" } }),
  ]).map((b) => b.activity);
  assert.equal(noiseActs.length, 0, "noise produced no activities");
  const input = report(noiseActs, "help_me_remember");
  assert.equal(input.workstreams.length, 0, "no activities ⇒ no workstreams");
});

test("in-progress activities never produce completion language in any report kind", async () => {
  const acts = contractActs(); // all in_progress
  for (const kind of ["help_me_remember", "review", "executive", "daily"]) {
    const { content } = await render(acts, kind, "en");
    assert.doesNotMatch(content, /\bCompleted\b/, `${kind} must not say 'Completed' for in-progress work`);
  }
});
