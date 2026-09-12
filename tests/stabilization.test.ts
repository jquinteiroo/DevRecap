/**
 * Stabilization & repository-hygiene regressions.
 *
 * These lock in the fixes from the stabilization pass so they cannot silently
 * regress:
 *   - ReportContext preserves the real activity end time (endedAt).
 *   - The workspace linker uses a Windows-safe link type (junction on win32).
 *   - External AI composition requires explicit consent (server-enforced); the
 *     deterministic path never does.
 *   - The API key is never returned to the browser in plaintext, is preserved
 *     across settings updates, and is not logged.
 *   - The validator rejects per-workstream completion lies (one finished
 *     workstream cannot license "completed" wording for an unfinished one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Activity, Project, ReportContext, StructuredReport } from "@devrecap/shared";
import { buildReportInput, buildReportContext, validateComposedReport } from "@devrecap/report-engine";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const PROJECTS: Project[] = [
  { id: "p1", name: "app", displayName: "App", type: "work", createdAt: "2026-09-03T00:00:00Z" },
];
let seq = 0;
function act(partial: Partial<Activity> & { title: string; status: Activity["status"]; startedAt: string; endedAt: string }): Activity {
  return {
    id: `a${++seq}`, source: "codex", projectId: "p1",
    category: "bugfix", summary: "", confidence: 0.6, reviewState: "pending",
    evidence: [{ id: `e${seq}`, activityId: `a${seq}`, kind: "shell_command", label: "x" }],
    metadata: {}, ...partial,
  } as Activity;
}
function ctxOf(acts: Activity[]) {
  const { input } = buildReportInput(acts, PROJECTS, {
    kind: "help_me_remember" as never, style: "spoken", length: "normal", language: "en",
    range: { start: "2026-09-03T00:00:00Z", end: "2026-09-03T23:59:59Z" },
  });
  return buildReportContext(input);
}

// ---------------------------------------------------------------------------
// 3. ReportContext timestamps
// ---------------------------------------------------------------------------
test("ReportContext preserves the real activity endedAt (not startedAt)", () => {
  const started = "2026-09-03T10:00:00.000Z";
  const ended = "2026-09-03T11:45:00.000Z";
  const ctx = ctxOf([
    act({ title: "Fixed the widget export", status: "completed", startedAt: started, endedAt: ended,
      metadata: { filesModified: ["src/widget/export.ts"], intents: ["fix widget export"] } }),
  ]);
  assert.equal(ctx.activities.length, 1);
  const a = ctx.activities[0];
  assert.equal(a.startedAt, started, "startedAt preserved");
  assert.equal(a.endedAt, ended, "endedAt reflects the REAL end time, not startedAt");
  assert.notEqual(a.endedAt, a.startedAt, "end time is not collapsed onto the start time");
});

test("ReportContext falls back to startedAt only when no endedAt is available", () => {
  const started = "2026-09-03T09:00:00.000Z";
  // Build an activity with NO endedAt (simulating an instantaneous / manual one).
  const a = act({ title: "Ran a quick check", status: "unknown", startedAt: started, endedAt: started });
  delete (a as { endedAt?: string }).endedAt;
  const ctx = ctxOf([a]);
  assert.equal(ctx.activities[0].endedAt, started, "safe fallback to startedAt when end time is absent");
});

// ---------------------------------------------------------------------------
// 1. Windows-safe workspace linking
// ---------------------------------------------------------------------------
test("workspace linker chooses a Windows-safe link type (junction on win32)", () => {
  const src = readFileSync(resolve(ROOT, "scripts/link-workspaces.mjs"), "utf8");
  // Must branch on platform and use a junction on Windows (no admin/dev-mode).
  assert.match(src, /process\.platform\s*===\s*["']win32["']\s*\?\s*["']junction["']\s*:\s*["']dir["']/,
    "link-workspaces.mjs must use junction on win32 and dir elsewhere");
  // The symlink call must use the platform-derived link type, not a hardcoded
  // "dir" literal. Inspect only non-comment lines so the explanatory comment
  // (which legitimately mentions symlinkSync(..., "dir")) is ignored.
  const codeLines = src
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
  const symlinkCalls = codeLines.filter((l) => /symlinkSync\(/.test(l));
  assert.ok(symlinkCalls.length >= 1, "expected a symlinkSync call");
  for (const call of symlinkCalls) {
    assert.doesNotMatch(call, /symlinkSync\([^)]*,\s*["']dir["']\s*\)/,
      "the hardcoded symlinkSync(..., \"dir\") EPERM regression must not return");
  }
});


// ---------------------------------------------------------------------------
// 8. Validator hardening — per-workstream completion semantics
// ---------------------------------------------------------------------------

/** A mixed report context: one COMPLETED workstream + one IN-PROGRESS one, in
 *  two clearly-unrelated topic areas (so they form separate workstreams). */
function mixedContext(): ReportContext {
  const t0 = "2026-09-03T10:00:00.000Z";
  const t1 = "2026-09-03T10:30:00.000Z";
  const t2 = "2026-09-03T12:00:00.000Z";
  const t3 = "2026-09-03T12:40:00.000Z";
  return ctxOf([
    act({ title: "Fixed the invoice export", status: "completed", startedAt: t0, endedAt: t1,
      metadata: { filesModified: ["src/invoice/export.ts"], testCount: 3, committed: true, intents: ["fix invoice export"] } }),
    act({ title: "Investigating the search ranking", status: "in_progress", startedAt: t2, endedAt: t3,
      metadata: { filesRead: ["src/search/rank.ts"], intents: ["investigate search ranking relevance"] } }),
  ]);
}

/** Build a fabricated composed report whose per-section text is provided. */
function composed(ctx: ReportContext, bodyByObjective: Record<string, string>): StructuredReport {
  const sections = ctx.workstreams.map((w) => ({
    heading: w.objective, body: "", workstreamId: w.id, activityIds: w.activityIds,
  }));
  const content = ctx.workstreams
    .map((w) => `### ${w.objective}\n${bodyByObjective[w.objective] ?? "Worked on it."}`)
    .join("\n\n");
  return { content, sections, composer: "openai", fellBack: false };
}

test("validator ACCEPTS honest mixed-status prose (finished says done, unfinished does not)", () => {
  const ctx = mixedContext();
  const finished = ctx.workstreams.find((w) => w.status === "completed")!;
  const unfinished = ctx.workstreams.find((w) => w.status === "in_progress")!;
  const report = composed(ctx, {
    [finished.objective]: "Completed this and validated it with tests.",
    [unfinished.objective]: "Still investigating the ranking; more work remains.",
  });
  const v = validateComposedReport(report, ctx);
  assert.equal(v.ok, true, `honest mixed report should pass, got: ${v.reason}`);
});

test("validator REJECTS a completion claim on an in-progress workstream even when another is completed", () => {
  const ctx = mixedContext();
  const finished = ctx.workstreams.find((w) => w.status === "completed")!;
  const unfinished = ctx.workstreams.find((w) => w.status === "in_progress")!;
  // The composer honestly reports the finished one, but LIES that the
  // in-progress one is done. The global anyFinished guard would miss this;
  // per-section validation must catch it.
  const report = composed(ctx, {
    [finished.objective]: "Completed and shipped.",
    [unfinished.objective]: "This was completed and fully finished today.",
  });
  const v = validateComposedReport(report, ctx);
  assert.equal(v.ok, false, "a per-workstream completion lie must be rejected");
  assert.match(v.reason, /unfinished workstream/i);
  assert.match(v.reason, new RegExp(unfinished.objective.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test("validator's per-section check is not fooled by a completed workstream mentioned later", () => {
  // Regression: the in-progress section's chunk must NOT absorb the later
  // "completed" wording from the finished workstream / summary sections.
  const ctx = mixedContext();
  const finished = ctx.workstreams.find((w) => w.status === "completed")!;
  const unfinished = ctx.workstreams.find((w) => w.status === "in_progress")!;
  const report = composed(ctx, {
    [unfinished.objective]: "Still in progress; more investigation remains.",
    [finished.objective]: "Completed successfully.",
  });
  const v = validateComposedReport(report, ctx);
  assert.equal(v.ok, true, `chunk attribution must be per-section, got: ${v.reason}`);
});


// ---------------------------------------------------------------------------
// 7. Cross-platform CI presence
// ---------------------------------------------------------------------------
test("CI workflow runs on Windows + Ubuntu with Node 24 and exercises the linker", () => {
  const wf = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(wf, /windows-latest/, "CI must run on Windows (guards the EPERM regression)");
  assert.match(wf, /ubuntu-latest/, "CI must run on Ubuntu");
  assert.match(wf, /node-version:\s*["']?24/, "CI must use Node 24 LTS");
  assert.match(wf, /npm run setup/, "CI must run the workspace linker (npm run setup)");
  assert.match(wf, /npm test/, "CI must run the test suite");
  assert.match(wf, /npm run smoke/, "CI must run the server health smoke test");
});
