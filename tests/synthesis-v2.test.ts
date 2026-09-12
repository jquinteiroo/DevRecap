/**
 * Help Me Remember — Semantic Synthesis V2.
 *
 * These tests lock in the milestone contract: reports SYNTHESIZE work from
 * evidence rather than replaying prompts. They exercise the full engine →
 * workstream → report pipeline on realistic (Aug-28-style) sessions.
 *
 * Coverage:
 *  1. a raw user prompt is never used verbatim as report prose
 *  2. a Portuguese report contains no English activity verbs / connectors
 *  3. `git status` is NOT interpreted as a commit
 *  4. unrelated Git and application-development activities are not grouped
 *  5. operational Codex/session issues do not become main accomplishments
 *  6. multiple related PDF/contract activities collapse into one workstream
 *  7. a workstream summary preserves important technical terms
 *  8. partial completion is represented accurately
 *  9. small legitimate work appears under secondary work
 * 10. the report retains source Activity references
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Activity, Project } from "@devrecap/shared";
import { parseCodexJsonl } from "@devrecap/codex-parser";
import { normalizeEvents, buildActivities } from "@devrecap/activity-engine";
import { buildReportInput, DeterministicProvider } from "@devrecap/report-engine";

// --- build activities from realistic modern Codex events -------------------
let clk = Date.UTC(2026, 7, 28, 10, 0, 0);
function ts() { clk += 60_000; return new Date(clk).toISOString(); }
function reset() { clk = Date.UTC(2026, 7, 28, 10, 0, 0); }
function ic(item: Record<string, unknown>) {
  return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "item_completed", item } });
}
function em(pt: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: pt, ...extra } });
}
function meta(cwd = "/home/user/contracts-app") {
  return JSON.stringify({ timestamp: ts(), type: "session_meta", payload: { id: "s", cwd } });
}
function build(lines: string[]): Activity[] {
  reset();
  const { events } = parseCodexJsonl(lines.join("\n") + "\n");
  return buildActivities(normalizeEvents(events), "codex", { projectId: "p1" }).map((b) => b.activity);
}

const PROJECTS: Project[] = [
  { id: "p1", name: "contracts", displayName: "Contracts App", type: "work", createdAt: "2026-08-28T00:00:00Z" },
];
function report(acts: Activity[], language: "auto" | "en" | "pt" = "auto", kind = "help_me_remember") {
  return buildReportInput(acts, PROJECTS, {
    kind: kind as never, style: "professional", length: "detailed", language,
    range: { start: "2026-08-28T00:00:00Z", end: "2026-08-28T23:59:59Z" },
  }).input;
}
async function renderReport(acts: Activity[], language: "auto" | "en" | "pt", kind = "help_me_remember") {
  const input = report(acts, language, kind);
  return { input, content: (await new DeterministicProvider().generateReport(input)).content };
}

/** A realistic Aug-28 Portuguese session: contract PDFs + git + operational. */
function aug28Session(): Activity[] {
  return build([
    meta(),
    em("task_started"),
    // Contract/PDF/AcroForm front (multiple related steps → one workstream)
    ic({ type: "UserMessage", message: "os contratos estão gerando errado, os PDFs não usam os templates esperados" }),
    ic({ type: "CommandExecution", command: ["grep -rn AcroForm src/pdf"], aggregated_output: "src/pdf/acroform.php:12\n", exit_code: 0 }),
    ic({ type: "CommandExecution", command: ["cat src/pdf/gen.php"], aggregated_output: "class PdfGen {}\n", exit_code: 0 }),
    ic({ type: "UserMessage", message: "ajusta o autoload.php para carregar os PDFs corretamente" }),
    ic({ type: "FileChange", changes: { "/home/user/contracts-app/src/pdf/autoload.php": { type: "update" } } }),
    ic({ type: "UserMessage", message: "agora coloca os PDFs no forge_files" }),
    ic({ type: "FileChange", changes: { "/home/user/contracts-app/src/pdf/forge.php": { type: "update" } } }),
    ic({ type: "CommandExecution", command: ["php artisan test"], aggregated_output: "2 failed", exit_code: 1 }),
    ic({ type: "AgentMessage", message: "Ainda investigando por que os contratos geram errado." }),
    // Git organization front (separate workstream)
    ic({ type: "UserMessage", message: "faz o commit das mudanças" }),
    ic({ type: "CommandExecution", command: ["git add -A && git commit -m 'ajustes nos contratos'"], aggregated_output: "[developer abc123] ajustes", exit_code: 0 }),
    // Operational: a session/branch issue with a concrete action (should NOT
    // be main work, but IS worth remembering under "other").
    ic({ type: "UserMessage", message: "quero trocar de branch mas está acusando overwrite; como volto para a sessão anterior?" }),
    ic({ type: "CommandExecution", command: ["git switch main"], aggregated_output: "error: your local changes would be overwritten", exit_code: 1 }),
    ic({ type: "AgentMessage", message: "Você precisa fazer stash antes de trocar de branch." }),
    em("turn_complete"),
  ]);
}

// ---------------------------------------------------------------------------
test("1. raw user prompt is never used verbatim as report prose", async () => {
  const { content, input } = await renderReport(aug28Session(), "pt");
  // No activity title or report body reproduces the raw prompt text.
  for (const bad of [
    "os contratos estão gerando errado, os PDFs não usam os templates esperados",
    "como eu volto para a conversa anterior do codex",
    "agora coloca os PDFs no forge_files",
  ]) {
    assert.ok(!content.includes(bad), `report must not echo the raw prompt: "${bad}"`);
  }
  for (const w of input.workstreams)
    for (const a of w.activities)
      assert.ok(!a.title.includes("estão gerando errado"), `title must not echo prompt: "${a.title}"`);
});

test("2. Portuguese report contains no English activity verbs / connectors", async () => {
  const { content } = await renderReport(aug28Session(), "pt");
  const leaks = content.match(/\b(Investigated|Developed|Fixed|Implemented|Configured|Committed changes|Worked on|Worked through|Then,|First,|Depois,|Primeiro,|Outcome:|Status:|Main work|Summary\b)\b/g);
  assert.equal(leaks, null, `no English verbs/connectors in PT report; found: ${JSON.stringify(leaks)}`);
});

test("3. git status is NOT interpreted as a commit", () => {
  const acts = build([
    meta(),
    ic({ type: "UserMessage", message: "ver o estado do repositório" }),
    ic({ type: "CommandExecution", command: ["git status"], aggregated_output: "On branch developer\nnothing to commit", exit_code: 0 }),
  ]);
  const a = acts[0];
  assert.notEqual(a.metadata.committed, true, "git status must not set committed");
  assert.doesNotMatch(a.title, /commit/i, `title must not claim a commit, got "${a.title}"`);
});

test("3b. a real chained commit IS recognized as committed", () => {
  const acts = build([
    meta(),
    ic({ type: "UserMessage", message: "commita as mudanças" }),
    ic({ type: "CommandExecution", command: ["git add -A && git commit -m 'x'"], aggregated_output: "[main abc] x", exit_code: 0 }),
  ]);
  assert.equal(acts[0].metadata.committed, true, "real commit sets committed");
});

/** Find the PDF/contract application workstream by its semantic signals (V3:
 *  workstreams are named/keyed from recurring signals, not a fixed bucket). */
function pdfWorkstream(input: { workstreams: Array<{ workKind: string; title: string; topicSignals: Array<{ term: string }>; techTerms: string[] }> }) {
  return input.workstreams.find((w) =>
    w.workKind === "primary" &&
    /(pdf|contract|contrato|acroform|forge_files|autoload)/i.test(
      `${w.title} ${w.topicSignals.map((s) => s.term).join(" ")} ${w.techTerms.join(" ")}`));
}
function gitWorkstream(input: { workstreams: Array<{ topicKey: string }> }) {
  return input.workstreams.find((w) => w.topicKey === "git");
}

test("4. unrelated Git and app-dev activities are not grouped into one workstream", () => {
  const input = report(aug28Session(), "pt");
  const pdf = pdfWorkstream(input);
  const git = gitWorkstream(input);
  assert.ok(pdf, "has an application (PDF/contract) workstream");
  assert.ok(git, "has a separate git workstream");
  assert.notEqual(pdf!.id, git!.id, "app-dev and git are distinct workstreams");
  assert.ok(!pdf!.activities.some((a) => a.gitAction === "committed"), "commit must not land in the app workstream");
});

test("5. operational Codex/session issues do not become main accomplishments", () => {
  const input = report(aug28Session(), "pt");
  const op = input.workstreams.find((w) => w.topicKey === "operational" || w.workKind === "operational");
  assert.ok(op, "operational workstream exists");
  // Highest-ranked (main) workstream is NOT the operational one.
  assert.notEqual(input.workstreams[0].workKind, "operational", "operational must not rank as main work");
  assert.equal(input.workstreams[0].workKind, "primary", "main work is primary");
});

test("6. multiple related PDF/contract activities collapse into one workstream", () => {
  const input = report(aug28Session(), "pt");
  // Exactly one primary app workstream carries the contract/PDF work.
  const pdfStreams = input.workstreams.filter((w) =>
    w.workKind === "primary" &&
    /(pdf|contract|contrato|acroform|forge_files|autoload)/i.test(
      `${w.title} ${w.topicSignals.map((s) => s.term).join(" ")} ${w.techTerms.join(" ")}`));
  assert.equal(pdfStreams.length, 1, `contract activities form ONE workstream, got ${pdfStreams.length}`);
  assert.ok(pdfStreams[0].activities.length >= 2, "the PDF workstream collapses multiple steps");
});

test("7. a workstream summary preserves important technical terms", () => {
  const input = report(aug28Session(), "pt");
  const pdf = pdfWorkstream(input)!;
  const terms = `${pdf.techTerms.join(" ")} ${pdf.title} ${pdf.topicSignals.map((s) => s.term).join(" ")}`;
  assert.match(terms, /PDF|AcroForm|autoload|forge_files/i, `preserves technical terms, got "${terms}"`);
});

test("8. partial completion is represented accurately (not the whole day 'in progress')", () => {
  const input = report(aug28Session(), "pt");
  const pdf = pdfWorkstream(input)!;
  const git = gitWorkstream(input)!;
  // The PDF front is unfinished; the git commit front is completed. The report
  // must NOT collapse both into a single day-level status.
  assert.ok(["in_progress", "partially_completed"].includes(pdf.status), `unfinished PDF work, got ${pdf.status}`);
  assert.equal(git.status, "completed", "the commit front is completed");
});

test("9. small legitimate work appears under secondary work (OTHER), not lost", async () => {
  const { content } = await renderReport(aug28Session(), "pt");
  // The git + operational fronts are secondary and must be listed under OTHER.
  assert.match(content, /Outras coisas que você fez/, "has an OTHER section");
  // The git commit (support work) is captured somewhere in the report.
  assert.match(content, /versionamento|commit/i, "small git work is preserved");
});

test("10. the report retains source Activity references for traceability", () => {
  const input = report(aug28Session(), "pt");
  let total = 0;
  for (const w of input.workstreams) {
    for (const a of w.activities) {
      assert.ok(a.id, "each workstream member keeps its activity id");
      assert.equal(typeof a.evidenceCount, "number", "evidence count present for drill-down");
      total++;
    }
  }
  // A timeline entry exists per activity (chronological detail preserved).
  assert.equal(input.timeline.length, total, "timeline mirrors every activity");
  for (const t of input.timeline) assert.ok(t.activityId && t.workstreamId, "timeline entries link back to activity + workstream");
});

// ---------------------------------------------------------------------------
// Sanity: the same session in English is coherent and honest too.
// ---------------------------------------------------------------------------
test("English report is a synthesis (no transcript, honest outcome)", async () => {
  const { content } = await renderReport(aug28Session(), "en");
  assert.match(content, /HELP ME REMEMBER/);
  assert.match(content, /Main work/);
  assert.doesNotMatch(content, /^\s*(Then,|First,|Depois,)/m, "not a chronological transcript");
  // Contract front is unfinished → must not claim completion for it.
  assert.match(content, /in progress/i);
});
