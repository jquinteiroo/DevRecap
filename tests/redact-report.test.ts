import { test } from "node:test";
import assert from "node:assert/strict";
import type { Activity, Project } from "@devrecap/shared";
import {
  redact, redactDeep, buildReportInput, DeterministicProvider,
} from "@devrecap/report-engine";

test("redact masks common secret shapes", () => {
  const cases = [
    "sk-abcdefghijklmnopqrstuvwxyz012345",
    "ghp_0123456789abcdefghijklmnopqrstuvwx",
    "AKIAIOSFODNN7EXAMPLE",
    "postgres://user:pass@localhost:5432/db",
  ];
  for (const c of cases) {
    const r = redact(c);
    assert.ok(r.text.includes("[REDACTED]"), `should redact: ${c}`);
    assert.ok(r.redactions.length > 0);
  }
});

test("redact masks assignment-style secrets but keeps the key name", () => {
  const r = redact('password="hunter2secret"');
  assert.ok(r.text.startsWith("password"));
  assert.ok(r.text.includes("[REDACTED]"));
});

test("redact leaves ordinary text untouched", () => {
  const r = redact("Fixed the item selection in the sample dashboard");
  assert.equal(r.text, "Fixed the item selection in the sample dashboard");
  assert.equal(r.redactions.length, 0);
});

test("redactDeep walks nested structures and counts redactions", () => {
  const { value, total } = redactDeep({
    a: "token=abcd1234efgh", nested: { b: ["ok", "sk-abcdefghijklmnopqrstuvwxyz012345"] },
  });
  assert.ok(total >= 2);
  assert.ok(JSON.stringify(value).includes("[REDACTED]"));
});

function fixture(): { acts: Activity[]; projects: Project[] } {
  const now = "2026-09-09T09:00:00Z";
  const acts: Activity[] = [
    { id: "a1", source: "codex", projectId: "p1", startedAt: now, category: "bugfix", title: "Fix item selection", summary: "Touched SampleDashboard.tsx", status: "completed", confidence: 0.9, reviewState: "approved", evidence: [] },
    { id: "a2", source: "codex", projectId: "p1", startedAt: now, category: "investigation", title: "Investigate Demo API", summary: "", status: "in_progress", confidence: 0.6, reviewState: "approved", evidence: [] },
    { id: "a3", source: "codex", projectId: "p2", startedAt: now, category: "feature", title: "Coursework catalog page", summary: "", status: "completed", confidence: 0.7, reviewState: "approved", evidence: [] },
  ];
  const projects: Project[] = [
    { id: "p1", name: "sample-dashboard", displayName: "Sample Dashboard", type: "work", createdAt: now },
    { id: "p2", name: "coursework", displayName: "Coursework Project", type: "university", createdAt: now },
  ];
  return { acts, projects };
}

test("buildReportInput excludes personal/university for work reports", () => {
  const { acts, projects } = fixture();
  const { input } = buildReportInput(acts, projects, {
    kind: "weekly", style: "professional", length: "normal",
    range: { start: "2026-09-01", end: "2026-09-30" }, excludeTypes: ["personal", "university"],
  });
  const names = input.projects.map((p) => p.name);
  assert.ok(names.includes("Sample Dashboard"));
  assert.ok(!names.includes("Coursework Project"), "university project excluded");
});

test("buildReportInput does not infer next steps from in_progress activities", () => {
  const { acts, projects } = fixture();
  const { input } = buildReportInput(acts, projects, {
    kind: "daily", style: "professional", length: "normal",
    range: { start: "2026-09-01", end: "2026-09-30" },
  });
  assert.deepEqual(input.nextSteps, [], "open work is not automatically a next step");
});

test("buildReportInput preserves an explicit evidence-backed next step", () => {
  const { acts, projects } = fixture();
  acts[1].metadata = { nextSteps: ["Validate the Demo API response with the supervisor"] };
  const { input } = buildReportInput(acts, projects, {
    kind: "daily", style: "professional", length: "normal",
    range: { start: "2026-09-01", end: "2026-09-30" },
  });
  assert.deepEqual(input.nextSteps, ["Validate the Demo API response with the supervisor"]);
});

test("deterministic daily spoken report respects the duration budget", async () => {
  const { acts, projects } = fixture();
  const { input } = buildReportInput(acts, projects, {
    kind: "daily", style: "spoken", length: "normal", durationSeconds: 30,
    range: { start: "2026-09-01", end: "2026-09-30" }, excludeTypes: ["university"],
  });
  const { content } = await new DeterministicProvider().generateReport(input);
  const words = content.split(/\s+/).length;
  assert.ok(words <= 110, `spoken report should be concise (was ${words} words)`);
  assert.ok(content.length > 0);
});

test("deterministic weekly report groups by project and avoids invented content", async () => {
  const { acts, projects } = fixture();
  const { input } = buildReportInput(acts, projects, {
    kind: "weekly", style: "professional", length: "detailed",
    range: { start: "2026-09-01", end: "2026-09-30" },
  });
  const { content } = await new DeterministicProvider().generateReport(input);
  assert.ok(content.includes("Sample Dashboard"));
  assert.ok(content.includes("Fix item selection"));
});
