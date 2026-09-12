import { test } from "node:test";
import assert from "node:assert/strict";
import type { RawEvent } from "@devrecap/shared";
import {
  normalizeEvents, extractShellCommand, extractFilePaths,
  buildActivities, detectProject, humanizeName, guessType, remoteToName,
  suggestMerges, correlateActivityWithCommits,
} from "@devrecap/activity-engine";

function ev(seq: number, ts: string, type: string, payload: unknown): RawEvent {
  const p = payload as Record<string, unknown>;
  return {
    seq, ts, rootType: type,
    payloadType: typeof p.type === "string" ? p.type : undefined,
    role: typeof p.role === "string" ? p.role : undefined,
    toolName: typeof p.name === "string" ? p.name : undefined,
    data: payload, raw: JSON.stringify({ type, payload }),
  };
}

test("extractShellCommand unwraps bash -lc arrays", () => {
  assert.equal(extractShellCommand('{"command":["bash","-lc","git status"]}'), "git status");
  assert.equal(extractShellCommand('{"command":"ls -la"}'), "ls -la");
});

test("extractFilePaths finds pathy tokens", () => {
  const files = extractFilePaths("edited src/components/SampleDashboard.tsx and src/utils/Helper.ts");
  assert.ok(files.includes("src/components/SampleDashboard.tsx"));
  assert.ok(files.includes("src/utils/Helper.ts"));
});

test("normalizeEvents classifies commands into kinds", () => {
  const events: RawEvent[] = [
    ev(0, "2026-09-09T08:00:00Z", "session_meta", { id: "s", cwd: "/p" }),
    ev(1, "2026-09-09T08:01:00Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] }),
    ev(2, "2026-09-09T08:02:00Z", "response_item", { type: "function_call", name: "shell", arguments: '{"command":["bash","-lc","npm test"]}' }),
    ev(3, "2026-09-09T08:02:30Z", "response_item", { type: "function_call_output", output: "5 passed" }),
    ev(4, "2026-09-09T08:03:00Z", "response_item", { type: "function_call", name: "shell", arguments: '{"command":["bash","-lc","git commit -m x"]}' }),
  ];
  const norm = normalizeEvents(events);
  const kinds = norm.map((n) => n.kind);
  assert.ok(kinds.includes("user_request"));
  assert.ok(kinds.includes("test_run"));
  assert.ok(kinds.includes("git_op"));
  // test output "5 passed" should mark the test as passed
  const testEv = norm.find((n) => n.kind === "test_run");
  assert.equal(testEv?.passed, true);
});

test("buildActivities produces evidence-backed activities, never empty invention", () => {
  const events: RawEvent[] = [
    ev(0, "2026-09-09T08:00:00Z", "session_meta", { id: "s", cwd: "/p" }),
    ev(1, "2026-09-09T08:01:00Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "The item selection is broken, fix it" }] }),
    ev(2, "2026-09-09T08:02:00Z", "response_item", { type: "function_call", name: "apply_patch", arguments: '{"input":"*** Update File: src/components/SampleDashboard.tsx"}' }),
    ev(3, "2026-09-09T08:03:00Z", "response_item", { type: "function_call", name: "shell", arguments: '{"command":["bash","-lc","npm test"]}' }),
    ev(4, "2026-09-09T08:03:30Z", "response_item", { type: "function_call_output", output: "Tests: 4 passed" }),
  ];
  const built = buildActivities(normalizeEvents(events), "codex", { projectId: "p1" });
  assert.ok(built.length >= 1);
  const a = built[0];
  assert.ok(a.evidence.length > 0, "activity has evidence");
  assert.equal(a.activity.category, "bugfix");
  assert.ok(a.activity.confidence > 0.5, "strong evidence → higher confidence");
});

test("buildActivities drops no-signal segments", () => {
  // Only a session_meta + turn_context → nothing meaningful
  const events: RawEvent[] = [
    ev(0, "2026-09-09T08:00:00Z", "session_meta", { id: "s" }),
    ev(1, "2026-09-09T08:00:01Z", "turn_context", { model: "o4" }),
  ];
  const built = buildActivities(normalizeEvents(events), "codex");
  assert.equal(built.length, 0);
});

test("project detection: names & types", () => {
  assert.equal(humanizeName("demo-api-client"), "Demo Api Client");
  assert.equal(remoteToName("git@github.com:example/repository.git"), "repository");
  assert.equal(guessType("/home/user/university-coursework"), "university");
  const p = detectProject("/home/user/example-project", { gitRemote: "git@github.com:example/repository.git" });
  assert.equal(p.detectedFrom, "git_remote");
  assert.equal(p.name, "repository");
});

test("git correlation attaches commit evidence in the time window", () => {
  const activity = {
    id: "a1", source: "codex" as const, projectId: "p1",
    startedAt: "2026-09-09T09:00:00Z", endedAt: "2026-09-09T09:10:00Z",
    category: "bugfix" as const, title: "Fix item selection", summary: "Touched SampleDashboard.tsx",
    status: "in_progress" as const, confidence: 0.5, reviewState: "pending" as const,
    metadata: { files: ["src/components/SampleDashboard.tsx"] },
  };
  const commit = {
    id: "c1", repositoryId: "r1", projectId: "p1", hash: "dc48b95abcdef",
    committedAt: "2026-09-09T09:15:00Z", committedEpoch: Date.parse("2026-09-09T09:15:00Z"),
    message: "fix item selection", branch: "main", files: ["src/components/SampleDashboard.tsx"],
  };
  const r = correlateActivityWithCommits(activity, [commit]);
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evidence[0].kind, "git_commit");
  assert.ok(r.confidenceDelta > 0);
  assert.equal(r.statusToCompleted, true);
});

test("git correlation ignores commits outside the time window", () => {
  const activity = {
    id: "a1", source: "codex" as const, projectId: "p1",
    startedAt: "2026-09-09T09:00:00Z", category: "bugfix" as const,
    title: "x", summary: "", status: "unknown" as const, confidence: 0.5,
    reviewState: "pending" as const, metadata: { files: ["a.ts"] },
  };
  const commit = {
    id: "c1", repositoryId: "r1", projectId: "p1", hash: "h",
    committedAt: "2026-09-01T00:00:00Z", committedEpoch: Date.parse("2026-09-01T00:00:00Z"),
    message: "unrelated", files: ["a.ts"],
  };
  const r = correlateActivityWithCommits(activity, [commit]);
  assert.equal(r.evidence.length, 0);
});

test("suggestMerges groups same-project, time-close, file-overlapping activities", () => {
  const base = {
    source: "codex" as const, projectId: "p1", category: "feature" as const,
    summary: "", status: "completed" as const, confidence: 0.7, reviewState: "pending" as const,
  };
  const acts = [
    { ...base, id: "a1", title: "edit", startedAt: "2026-09-09T08:00:00Z", endedAt: "2026-09-09T08:05:00Z", metadata: { files: ["x.ts", "y.ts"] } },
    { ...base, id: "a2", title: "more edit", startedAt: "2026-09-09T08:10:00Z", endedAt: "2026-09-09T08:12:00Z", metadata: { files: ["x.ts", "z.ts"] } },
    { ...base, id: "a3", title: "unrelated", startedAt: "2026-09-09T14:00:00Z", metadata: { files: ["q.ts"] } },
  ];
  const groups = suggestMerges(acts, { gapMinutes: 30, fileJaccard: 0.2 });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sort(), ["a1", "a2"]);
});


// --- conservative status + confidence (hardening) --------------------------

test("a lone file edit is NOT marked completed (conservative)", () => {
  const events: RawEvent[] = [
    ev(0, "2026-09-09T08:00:00Z", "session_meta", { id: "s", cwd: "/p" }),
    ev(1, "2026-09-09T08:01:00Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "please tweak the dashboard" }] }),
    ev(2, "2026-09-09T08:02:00Z", "response_item", { type: "function_call", name: "apply_patch", arguments: '{"input":"*** Update File: Dashboard.vue"}' }),
  ];
  const built = buildActivities(normalizeEvents(events), "codex", { projectId: "p1" });
  assert.ok(built.length >= 1);
  const a = built[0].activity;
  assert.notEqual(a.status, "completed");
  assert.ok(["in_progress", "unknown"].includes(a.status));
  assert.ok(a.confidence <= 0.69, "weak evidence keeps confidence modest");
  assert.ok(Array.isArray(a.metadata?.reasoning) && a.metadata.reasoning.length > 0, "reasoning recorded");
});

test("commit + passing test after edits IS marked completed with high confidence", () => {
  const events: RawEvent[] = [
    ev(0, "2026-09-09T08:00:00Z", "session_meta", { id: "s", cwd: "/p" }),
    ev(1, "2026-09-09T08:01:00Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "fix the product filter" }] }),
    ev(2, "2026-09-09T08:02:00Z", "response_item", { type: "function_call", name: "apply_patch", arguments: '{"input":"*** Update File: Dashboard.vue"}' }),
    ev(3, "2026-09-09T08:03:00Z", "response_item", { type: "function_call", name: "shell", arguments: '{"command":["bash","-lc","npm test"]}' }),
    ev(4, "2026-09-09T08:03:30Z", "response_item", { type: "function_call_output", output: "5 passed" }),
    ev(5, "2026-09-09T08:04:00Z", "response_item", { type: "function_call", name: "shell", arguments: '{"command":["bash","-lc","git commit -m fix"]}' }),
  ];
  const built = buildActivities(normalizeEvents(events), "codex", { projectId: "p1" });
  const a = built[0].activity;
  assert.equal(a.status, "completed");
  assert.ok(a.confidence >= 0.7, "strong corroborated evidence → high confidence");
});

test("failed test after edits stays in_progress", () => {
  const events: RawEvent[] = [
    ev(0, "2026-09-09T08:00:00Z", "session_meta", { id: "s", cwd: "/p" }),
    ev(1, "2026-09-09T08:01:00Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "fix the crash" }] }),
    ev(2, "2026-09-09T08:02:00Z", "response_item", { type: "function_call", name: "apply_patch", arguments: '{"input":"*** Update File: a.ts"}' }),
    ev(3, "2026-09-09T08:03:00Z", "response_item", { type: "function_call", name: "shell", arguments: '{"command":["bash","-lc","npm test"]}' }),
    ev(4, "2026-09-09T08:03:30Z", "response_item", { type: "function_call_output", output: "2 failed" }),
  ];
  const built = buildActivities(normalizeEvents(events), "codex", { projectId: "p1" });
  assert.equal(built[0].activity.status, "in_progress");
});

test("blocked requires explicit blocker language, not assumptions", () => {
  const events: RawEvent[] = [
    ev(0, "2026-09-09T08:00:00Z", "session_meta", { id: "s", cwd: "/p" }),
    ev(1, "2026-09-09T08:01:00Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "connect to the staging DB" }] }),
    ev(2, "2026-09-09T08:02:00Z", "response_item", { type: "message", role: "assistant", content: "I am blocked: I need database credentials to proceed." }),
  ];
  const built = buildActivities(normalizeEvents(events), "codex", { projectId: "p1" });
  assert.equal(built[0].activity.status, "blocked");
});

test("investigation-only (no edits) is never completed", () => {
  const events: RawEvent[] = [
    ev(0, "2026-09-09T08:00:00Z", "session_meta", { id: "s", cwd: "/p" }),
    ev(1, "2026-09-09T08:01:00Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "why is the build failing?" }] }),
    ev(2, "2026-09-09T08:02:00Z", "response_item", { type: "function_call", name: "shell", arguments: '{"command":["bash","-lc","grep -rn error src"]}' }),
  ];
  const built = buildActivities(normalizeEvents(events), "codex", { projectId: "p1" });
  assert.notEqual(built[0].activity.status, "completed");
});
