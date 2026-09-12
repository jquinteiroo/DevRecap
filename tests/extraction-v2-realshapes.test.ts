/**
 * Activity Extraction V2 — REAL Codex schema regression tests.
 *
 * These fixtures reproduce the schema shapes seen in ACTUAL Codex rollout files
 * (verified against real public rollouts) that the first V2 classifier wrongly
 * discarded as noise, producing the "hundreds of events → 0 activities" bug:
 *
 *   - event_msg/user_message         (the real user turn text)
 *   - event_msg/agent_message        (assistant prose)
 *   - function_call name=exec_command with arguments = {"cmd": "...", ...}
 *   - event_msg/exec_command_end     (command result: aggregated_output/exit_code)
 *
 * They assert that real work now yields a small number of meaningful activities
 * (not 0, not one-per-event), that investigation-without-edit is preserved, that
 * genuine noise stays filtered, and that the counts-only diagnostics are
 * populated correctly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexJsonl } from "@devrecap/codex-parser";
import {
  normalizeEvents, buildActivities, classifyRawEvent,
  StreamingActivityBuilder, StreamingNormalizer, emptyDiagnostics,
  rawShapeKey, sampleShapeOf,
} from "@devrecap/activity-engine";
import type { RawEvent } from "@devrecap/shared";

// --- real-shape JSONL builders ---------------------------------------------
let clock = Date.UTC(2026, 8, 9, 8, 0, 0);
function ts(): string { clock += 60_000; return new Date(clock).toISOString(); }
function reset() { clock = Date.UTC(2026, 8, 9, 8, 0, 0); }

function meta(cwd = "/home/user/example-project", id = "sess-real-1") {
  return JSON.stringify({ timestamp: ts(), type: "session_meta", payload: { id, cwd, cli_version: "0.65.0", source: "cli", git: { branch: "main" } } });
}
function turnCtx() { return JSON.stringify({ timestamp: ts(), type: "turn_context", payload: { model: "gpt-5-codex" } }); }
function taskStarted() { return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "task_started" } }); }
function taskComplete() { return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "task_complete" } }); }
function tokenCount() { return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 5000 } } } }); }

/** REAL user turn: event_msg/user_message with a plain string `message`. */
function userMsg(message: string) {
  return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "user_message", message } });
}
/** REAL agent turn: event_msg/agent_message with a plain string `message`. */
function agentMsg(message: string) {
  return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "agent_message", message, phase: "final_answer" } });
}
/** REAL exec: function_call name=exec_command, arguments = {"cmd": "..."}. */
function execCmd(cmd: string, workdir = "/home/user/example-project") {
  return JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd, workdir, yield_time_ms: 5000 }) } });
}
/** REAL exec result: event_msg/exec_command_end with aggregated_output + exit_code. */
function execEnd(command: string, aggregated_output: string, exit_code = 0) {
  return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "exec_command_end", command: ["/bin/bash", "-lc", command], aggregated_output, stdout: aggregated_output, stderr: "", exit_code } });
}
/** REAL edit: apply_patch function_call. */
function applyPatch(patchBody: string) {
  return JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: patchBody }) } });
}

function run(lines: string[]) {
  reset();
  const { events } = parseCodexJsonl(lines.join("\n") + "\n");
  return buildActivities(normalizeEvents(events), "codex", { projectId: "p1" });
}

// ---------------------------------------------------------------------------
// Regression: a realistic session of REAL shapes must NOT collapse to zero.
// ---------------------------------------------------------------------------
test("real shapes: user_message + exec_command + exec_command_end ⇒ >=1 activity (not 0)", () => {
  const built = run([
    meta(), turnCtx(), taskStarted(),
    userMsg("The date parser is off by one day for timezones behind UTC."),
    execCmd("grep -rn parseDate src"),
    execEnd("grep -rn parseDate src", "src/date.ts:12: export function parseDate(s)\n", 0),
    applyPatch("*** Begin Patch\n*** Update File: src/date.ts\n@@\n- old\n+ fixed\n*** End Patch"),
    execCmd("npm test"),
    execEnd("npm test", "Tests: 14 passed", 0),
    agentMsg("Fixed the off-by-one in parseDate for negative UTC offsets. All tests pass."),
    taskComplete(), tokenCount(),
  ]);
  assert.ok(built.length >= 1, `expected >=1 activity, got ${built.length}`);
  assert.ok(built.length <= 3, `expected a small number of activities, got ${built.length}`);
  const a = built[0].activity;
  assert.equal(a.status, "completed", `edit + passing test ⇒ completed, got ${a.status}`);
  // V2 synthesis: an evidence-derived topic phrase, not the raw prompt.
  assert.doesNotMatch(a.title, /off by one|timezones behind/i, `raw prompt not echoed, got "${a.title}"`);
  assert.ok(a.title.length > 0);
  // The .jsonl / log filenames must never leak into a title.
  assert.ok(!/\.jsonl|rollout-|\.log\b/i.test(a.title), `no data-file names in title, got "${a.title}"`);
});

// ---------------------------------------------------------------------------
// Investigation with NO edit (intent + reads + commands) is a legitimate
// activity — not dropped, never "completed".
// ---------------------------------------------------------------------------
test("real shapes: investigation (intent + reads/commands, no edit) ⇒ 1 investigation, not completed", () => {
  const built = run([
    meta(), turnCtx(), taskStarted(),
    userMsg("Why does the server return a 500 on the /reports endpoint?"),
    execCmd("grep -rn '/reports' src/server"),
    execEnd("grep -rn '/reports' src/server", "src/server/api.ts:88: router.get('/reports'...)\n", 0),
    execCmd("cat src/server/api.ts"),
    execEnd("cat src/server/api.ts", "export function registerApi() { /* ... */ }\n", 0),
    agentMsg("The handler dereferences an undefined settings object; I have not applied a fix yet."),
    taskComplete(),
  ]);
  assert.equal(built.length, 1, `one investigation, got ${built.length}`);
  const a = built[0].activity;
  assert.equal(a.category, "investigation");
  assert.notEqual(a.status, "completed");
  const md = a.metadata as Record<string, string[]>;
  assert.equal(md.filesModified.length, 0, "no edits recorded");
  assert.ok((md.filesRead.length + (md.commandCount ? 1 : 0)) >= 1, "reads/commands recorded as evidence");
});

// ---------------------------------------------------------------------------
// Mixed real context + real work: context is ignored, the work is preserved.
// ---------------------------------------------------------------------------
test("real shapes: context noise mixed with work ⇒ work preserved, context ignored", () => {
  const built = run([
    meta(), turnCtx(), taskStarted(),
    // Injected context / session control that must NOT become activities:
    userMsg("<environment_context>\n<cwd>/home/user/example-project</cwd>\n<sandbox>read-only</sandbox>\n</environment_context>"),
    userMsg("/resume"),
    tokenCount(),
    // Real work:
    userMsg("Add pagination to the activity list API."),
    applyPatch("*** Begin Patch\n*** Update File: src/server/store.ts\n@@\n+ limit/offset\n*** End Patch"),
    execCmd("npm test"),
    execEnd("npm test", "Tests: 9 passed", 0),
    agentMsg("Added limit/offset pagination to listActivities; tests pass."),
    taskComplete(),
  ]);
  assert.equal(built.length, 1, `context must not create extra activities, got ${built.length}`);
  const a = built[0].activity;
  assert.equal(a.category, "feature");
  assert.equal(a.status, "completed");
  // V2 synthesis: topic-based title (the API), never the injected context text.
  assert.match(a.title, /API|activity|pagination/i, `topic-based title, got "${a.title}"`);
  assert.ok(!/environment_context|resume/i.test(a.title), "no context text in title");
});

// ---------------------------------------------------------------------------
// A git intent with no edit should become a git activity, not "Implemented
// <a data file>", and must not be dropped.
// ---------------------------------------------------------------------------
test("real shapes: git commit intent (no edit) ⇒ git activity, sensible title", () => {
  const built = run([
    meta(), turnCtx(), taskStarted(),
    userMsg("add and commit the staged changes"),
    execCmd("git add -A && git commit -m 'Add pagination'"),
    execEnd("git add -A && git commit -m 'Add pagination'", "[main abc1234] Add pagination\n 1 file changed", 0),
    agentMsg("Staged and committed the changes."),
    taskComplete(),
  ]);
  assert.equal(built.length, 1, `one git activity, got ${built.length}`);
  const a = built[0].activity;
  assert.equal(a.category, "git");
  assert.ok(!/\.jsonl|rollout-|\.log\b/i.test(a.title), `no data-file names in title, got "${a.title}"`);
  assert.ok(a.title.length > 0);
});

// ---------------------------------------------------------------------------
// Pure noise session (real shapes): task_started/complete + token_count +
// slash-command + injected context ⇒ ZERO activities.
// ---------------------------------------------------------------------------
test("real shapes: pure session/metadata/slash-command noise ⇒ 0 activities", () => {
  const built = run([
    meta(), turnCtx(), taskStarted(),
    userMsg("/resume"),
    userMsg("<user_instructions>Follow AGENTS.md conventions.</user_instructions>"),
    tokenCount(),
    taskComplete(),
  ]);
  assert.equal(built.length, 0, `noise-only session must yield 0 activities, got ${built.length}`);
});

// ---------------------------------------------------------------------------
// Classification unit tests for the real shapes.
// ---------------------------------------------------------------------------
function raw(rootType: string, payload: Record<string, unknown>, role?: string, toolName?: string): RawEvent {
  return { seq: 0, rootType, payloadType: typeof payload.type === "string" ? payload.type : undefined, role, toolName, data: payload, raw: "" };
}

test("classifier: event_msg/user_message with real text is USER_INTENT (not TOOL_METADATA noise)", () => {
  const c = classifyRawEvent(raw("event_msg", { type: "user_message", message: "fix the failing test" }));
  assert.equal(c.cls, "USER_INTENT");
  assert.equal(c.noise, false);
});

test("classifier: event_msg/user_message that is a slash-command is noise", () => {
  const c = classifyRawEvent(raw("event_msg", { type: "user_message", message: "/resume" }));
  assert.equal(c.noise, true);
});

test("classifier: event_msg/agent_message is ASSISTANT_SUMMARY (not noise)", () => {
  const c = classifyRawEvent(raw("event_msg", { type: "agent_message", message: "I fixed the bug." }));
  assert.equal(c.cls, "ASSISTANT_SUMMARY");
  assert.equal(c.noise, false);
});

test("classifier: function_call name=exec_command reads arguments.cmd", () => {
  const rd = classifyRawEvent(raw("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "grep -rn foo src" }) }, undefined, "exec_command"));
  assert.equal(rd.cls, "FILE_READ");
  const tst = classifyRawEvent(raw("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) }, undefined, "exec_command"));
  assert.equal(tst.cls, "TEST_RUN");
  const git = classifyRawEvent(raw("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "git commit -m x" }) }, undefined, "exec_command"));
  assert.equal(git.cls, "GIT_EVENT");
});

test("classifier: event_msg/exec_command_end classified by output + exit_code", () => {
  const pass = classifyRawEvent(raw("event_msg", { type: "exec_command_end", command: ["bash", "-lc", "npm test"], aggregated_output: "Tests: 10 passed", exit_code: 0 }));
  assert.equal(pass.cls, "TEST_RESULT");
  assert.equal(pass.noise, false);
  const fail = classifyRawEvent(raw("event_msg", { type: "exec_command_end", command: ["bash", "-lc", "npm test"], aggregated_output: "2 failed", exit_code: 1 }));
  assert.equal(fail.cls, "TEST_RESULT");
  // An error signal present with a SUCCESS exit (e.g. an error printed but the
  // command itself returned 0) routes to ERROR rather than a test result.
  const err = classifyRawEvent(raw("event_msg", { type: "exec_command_end", command: ["bash", "-lc", "npm run lint"], aggregated_output: "error: unexpected token", exit_code: 0 }));
  assert.equal(err.cls, "ERROR");
  // A non-zero exit whose output has no test/pass signal but does carry an error
  // signal is treated as a failing command result (TEST_RESULT).
  const failResult = classifyRawEvent(raw("event_msg", { type: "exec_command_end", command: ["bash", "-lc", "node x"], aggregated_output: "Error: cannot find module", exit_code: 1 }));
  assert.equal(failResult.cls, "TEST_RESULT");
  const ok = classifyRawEvent(raw("event_msg", { type: "exec_command_end", command: ["bash", "-lc", "ls"], aggregated_output: "a.txt b.txt", exit_code: 0 }));
  assert.equal(ok.cls, "COMMAND_RESULT");
});

// ---------------------------------------------------------------------------
// Diagnostics: counts-only, populated correctly, no raw content.
// ---------------------------------------------------------------------------
test("diagnostics: streaming build populates counts and sanitized shapes (no content)", () => {
  reset();
  const lines = [
    meta(), turnCtx(), taskStarted(),
    userMsg("Fix the off-by-one date bug."),
    execCmd("grep -rn parseDate src"),
    execEnd("grep -rn parseDate src", "src/date.ts:12\n", 0),
    applyPatch("*** Begin Patch\n*** Update File: src/date.ts\n+fix\n*** End Patch"),
    execCmd("npm test"),
    execEnd("npm test", "Tests: 3 passed", 0),
    agentMsg("Fixed; tests pass."),
    taskComplete(), tokenCount(),
  ];
  const { events } = parseCodexJsonl(lines.join("\n") + "\n");

  const diag = emptyDiagnostics();
  // Feed diagnostics exactly the way import.ts does: per-raw-event recording…
  const sampledKeys = new Set<string>();
  for (const ev of events) {
    const key = rawShapeKey(ev);
    diag.rawShapes[key] = (diag.rawShapes[key] ?? 0) + 1;
    const c = classifyRawEvent(ev);
    diag.classified[c.cls] = (diag.classified[c.cls] ?? 0) + 1;
    if (!sampledKeys.has(key)) { sampledKeys.add(key); diag.sampleShapes.push(sampleShapeOf(ev)); }
  }
  // …and candidate/accept/reject counts via the streaming builder.
  const out: unknown[] = [];
  const builder = new StreamingActivityBuilder("codex", (a) => out.push(a), { projectId: "p1", diagnostics: diag });
  const norm = new StreamingNormalizer((n) => builder.add(n));
  for (const ev of [...events].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""))) norm.push(ev);
  builder.flush();

  // Raw shapes recorded for the real types.
  assert.ok(diag.rawShapes["event_msg/user_message"] >= 1);
  assert.ok(diag.rawShapes["response_item/function_call"] >= 1);
  assert.ok(diag.rawShapes["event_msg/exec_command_end"] >= 1);

  // Classification counted the real user intent as USER_INTENT (not noise).
  assert.ok((diag.classified["USER_INTENT"] ?? 0) >= 1, "user intent classified");
  assert.ok((diag.classified["FILE_EDIT"] ?? 0) >= 1, "edit classified");

  // Task-engine funnel: at least one candidate created & at least one accepted.
  assert.ok(diag.candidatesCreated >= 1, "candidate created");
  assert.ok(diag.activitiesAccepted >= 1, "activity accepted");
  assert.equal(diag.activitiesAccepted, out.length, "accepted count matches emitted activities");
  assert.equal(diag.candidatesCreated, diag.activitiesAccepted + diag.candidatesRejected, "funnel adds up");

  // Sanitized sample shapes carry TYPES ONLY — never message text / commands.
  const serialized = JSON.stringify(diag.sampleShapes);
  assert.ok(!/off-by-one|parseDate|npm test|Begin Patch/.test(serialized), "no raw content leaks into sample shapes");
  for (const s of diag.sampleShapes) {
    assert.equal(typeof s.rootType, "string");
    // only known safe keys allowed
    for (const k of Object.keys(s)) {
      assert.ok(["rootType", "payloadType", "itemType", "toolName", "contentTypes"].includes(k), `unexpected shape key: ${k}`);
    }
  }
});

test("diagnostics: a rejected bare-question candidate records a rejection reason", () => {
  reset();
  const lines = [
    meta(), turnCtx(),
    userMsg("What is the difference between let and const?"),
    agentMsg("let is block-scoped and reassignable; const is block-scoped and not reassignable."),
  ];
  const { events } = parseCodexJsonl(lines.join("\n") + "\n");
  const diag = emptyDiagnostics();
  const out: unknown[] = [];
  const builder = new StreamingActivityBuilder("codex", (a) => out.push(a), { projectId: "p1", diagnostics: diag });
  const norm = new StreamingNormalizer((n) => builder.add(n));
  for (const ev of events) norm.push(ev);
  builder.flush();

  assert.equal(out.length, 0, "a bare question yields no activity");
  assert.ok(diag.candidatesRejected >= 1, "at least one rejection recorded");
  const totalReasons = Object.values(diag.rejectionReasons).reduce((a, b) => a + b, 0);
  assert.ok(totalReasons >= 1, "a rejection reason was recorded");
  assert.ok("no_work_evidence" in diag.rejectionReasons, "bare question rejected as no_work_evidence");
});
