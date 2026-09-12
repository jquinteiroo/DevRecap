/**
 * Activity Extraction V2 — event_msg compatibility regression tests.
 *
 * Targeted coverage for the real Codex rollout `event_msg` schema:
 *   - event_msg/user_message  → USER_INTENT   (text from payload.message)
 *   - event_msg/agent_message → ASSISTANT_SUMMARY
 *   - event_msg/token_count | task_started | turn_started |
 *     thread_settings_applied | turn_complete → noise (never an activity)
 *   - event_msg/turn_aborted with a reason → ERROR evidence
 *   - the SAME user turn delivered twice (event_msg + response_item) must
 *     produce ONE user intent / ONE task, not two.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexJsonl } from "@devrecap/codex-parser";
import { normalizeEvents, buildActivities, classifyRawEvent } from "@devrecap/activity-engine";
import type { RawEvent } from "@devrecap/shared";

// --- builders (real event_msg shapes) --------------------------------------
let clock = Date.UTC(2026, 8, 9, 10, 0, 0);
function ts(): string { clock += 60_000; return new Date(clock).toISOString(); }
function tsSame(): string { return new Date(clock).toISOString(); } // no advance
function reset() { clock = Date.UTC(2026, 8, 9, 10, 0, 0); }

function meta(cwd = "/home/user/example-project", id = "sess-em-1") {
  return JSON.stringify({ timestamp: ts(), type: "session_meta", payload: { id, cwd, cli_version: "0.65.0" } });
}
function turnCtx() { return JSON.stringify({ timestamp: ts(), type: "turn_context", payload: { model: "gpt-5-codex" } }); }
function em(payloadType: string, extra: Record<string, unknown> = {}, sameTs = false) {
  return JSON.stringify({ timestamp: sameTs ? tsSame() : ts(), type: "event_msg", payload: { type: payloadType, ...extra } });
}
function emUser(message: string, sameTs = false) { return em("user_message", { message }, sameTs); }
function emAgent(message: string) { return em("agent_message", { message, phase: "final_answer" }); }
function riUser(text: string, sameTs = false) {
  return JSON.stringify({ timestamp: sameTs ? tsSame() : ts(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
}
function execCmd(cmd: string) {
  return JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }) } });
}
function readTool(path: string) {
  return JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "read_file", arguments: JSON.stringify({ path }) } });
}
function applyPatch(patchBody: string) {
  return JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: patchBody }) } });
}
function execEnd(command: string, out: string, exit_code = 0) {
  return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "exec_command_end", command: ["/bin/bash", "-lc", command], aggregated_output: out, exit_code } });
}

function run(lines: string[]) {
  reset();
  const { events } = parseCodexJsonl(lines.join("\n") + "\n");
  return buildActivities(normalizeEvents(events), "codex", { projectId: "p1" });
}

// ---------------------------------------------------------------------------
// Test A — event_msg user_message + real tool activity ⇒ ONE activity.
// ---------------------------------------------------------------------------
test("A: event_msg user_message + inspect/edit/test ⇒ 1 meaningful activity (not 0)", () => {
  const built = run([
    meta(), turnCtx(), em("task_started"),
    emUser("Fix the login validation"),
    readTool("src/auth/login.ts"),
    applyPatch("*** Begin Patch\n*** Update File: src/auth/login.ts\n@@\n- old\n+ fixed\n*** End Patch"),
    execCmd("npm test"),
    execEnd("npm test", "Tests: 8 passed", 0),
    emAgent("Fixed the login validation; all tests pass."),
    em("token_count", { info: { total_token_usage: { total_tokens: 3000 } } }),
    em("turn_complete"),
  ]);
  assert.equal(built.length, 1, `expected exactly 1 activity, got ${built.length}`);
  const a = built[0].activity;
  assert.equal(a.status, "completed");
  // V2 synthesis: title is an evidence-derived topic (auth), not the raw prompt.
  assert.doesNotMatch(a.title, /Fix the login validation/i, `raw prompt not echoed, got "${a.title}"`);
  assert.match(a.title, /^Fixed /, `completed bugfix verb, got "${a.title}"`);
  const md = a.metadata as Record<string, string[]>;
  assert.ok(md.filesModified.some((f) => /login\.ts/.test(f)), "edit recorded");
  assert.equal(md.filesModified.filter((f) => /login\.ts/.test(f)).length, 1, "edit not double-counted");
});

// ---------------------------------------------------------------------------
// Test B — the SAME user turn as BOTH response_item and event_msg ⇒ ONE intent.
// ---------------------------------------------------------------------------
test("B: response_item user + equivalent event_msg user_message ⇒ 1 intent, 1 task", () => {
  const built = run([
    meta(), turnCtx(),
    // Same turn, delivered twice with the same timestamp (real rollout twin).
    riUser("Add pagination to the reports list", false),
    emUser("Add pagination to the reports list", true),
    applyPatch("*** Begin Patch\n*** Update File: src/reports.ts\n+pagination\n*** End Patch"),
    execCmd("npm test"),
    execEnd("npm test", "Tests: 4 passed", 0),
    emAgent("Added pagination; tests pass."),
  ]);
  assert.equal(built.length, 1, `duplicate turn must not create two tasks, got ${built.length}`);
  const a = built[0].activity;
  const md = a.metadata as Record<string, string[]>;
  assert.equal(md.intents.length, 1, `exactly one canonical intent, got ${md.intents.length}: ${JSON.stringify(md.intents)}`);
  assert.equal(a.status, "completed");
});

test("B2: duplicate turn in the REVERSE order (event_msg first) ⇒ 1 intent, 1 task", () => {
  const built = run([
    meta(), turnCtx(),
    emUser("Refactor the date utils", false),
    riUser("Refactor the date utils", true),
    applyPatch("*** Begin Patch\n*** Update File: src/date.ts\n+refactor\n*** End Patch"),
    emAgent("Refactored the date utilities."),
  ]);
  assert.equal(built.length, 1, `got ${built.length}`);
  assert.equal((built[0].activity.metadata as Record<string, string[]>).intents.length, 1);
});

test("B3: two DIFFERENT user turns still produce two tasks (dedup is not over-broad)", () => {
  const built = run([
    meta(), turnCtx(),
    emUser("Add a logout button"),
    applyPatch("*** Begin Patch\n*** Update File: src/ui/nav.ts\n+logout\n*** End Patch"),
    emAgent("Added the logout button."),
    emUser("Now add a dark-mode toggle"),
    applyPatch("*** Begin Patch\n*** Update File: src/ui/theme.ts\n+darkmode\n*** End Patch"),
    emAgent("Added the dark-mode toggle."),
  ]);
  assert.equal(built.length, 2, `distinct turns must remain distinct tasks, got ${built.length}`);
});

// ---------------------------------------------------------------------------
// Test C — pure lifecycle/metadata event_msg ⇒ ZERO activities.
// ---------------------------------------------------------------------------
test("C: token_count / task_started / turn_started / thread_settings_applied / turn_complete ⇒ 0 activities", () => {
  const built = run([
    meta(), turnCtx(),
    em("thread_settings_applied", { settings: { model: "gpt-5-codex" } }),
    em("task_started"),
    em("turn_started"),
    em("token_count", { info: { total_token_usage: { total_tokens: 1234 } } }),
    em("turn_complete"),
  ]);
  assert.equal(built.length, 0, `pure lifecycle/metadata must yield 0 activities, got ${built.length}`);
});

// ---------------------------------------------------------------------------
// Test D — event_msg user_message + inspection only ⇒ ONE investigation.
// ---------------------------------------------------------------------------
test("D: event_msg user_message + inspection commands (no edit) ⇒ 1 investigation, not completed", () => {
  const built = run([
    meta(), turnCtx(), em("task_started"),
    emUser("Why does the report endpoint return an empty list?"),
    execCmd("grep -rn listActivities src/server"),
    execEnd("grep -rn listActivities src/server", "src/server/store.ts:120: export function listActivities()\n", 0),
    readTool("src/server/store.ts"),
    emAgent("The default filter excludes merged rows; I have not changed anything yet."),
    em("turn_complete"),
  ]);
  assert.equal(built.length, 1, `expected 1 investigation, got ${built.length}`);
  const a = built[0].activity;
  assert.equal(a.category, "investigation");
  assert.notEqual(a.status, "completed");
  const md = a.metadata as Record<string, string[]>;
  assert.equal(md.filesModified.length, 0, "no edits");
  assert.ok(md.filesRead.length >= 1, "reads recorded as evidence");
});

// ---------------------------------------------------------------------------
// Classifier unit tests for the lifecycle event_msg types.
// ---------------------------------------------------------------------------
function raw(payloadType: string, extra: Record<string, unknown> = {}): RawEvent {
  return { seq: 0, rootType: "event_msg", payloadType, data: { type: payloadType, ...extra }, raw: "" };
}

test("classifier: event_msg lifecycle types are noise (never work)", () => {
  for (const t of ["task_started", "turn_started", "thread_settings_applied", "token_count", "turn_complete", "task_complete"]) {
    const c = classifyRawEvent(raw(t));
    assert.equal(c.noise, true, `${t} should be noise`);
  }
});

test("classifier: event_msg turn_started/thread_settings_applied are SESSION_METADATA", () => {
  assert.equal(classifyRawEvent(raw("turn_started")).cls, "SESSION_METADATA");
  assert.equal(classifyRawEvent(raw("task_started")).cls, "SESSION_METADATA");
  assert.equal(classifyRawEvent(raw("thread_settings_applied")).cls, "SESSION_METADATA");
});

test("classifier: event_msg turn_aborted with a reason is ERROR evidence; bare is noise", () => {
  const withReason = classifyRawEvent(raw("turn_aborted", { reason: "user interrupted the turn" }));
  assert.equal(withReason.cls, "ERROR");
  assert.equal(withReason.noise, false);
  const bare = classifyRawEvent(raw("turn_aborted"));
  assert.equal(bare.noise, true);
});

test("classifier: unknown event_msg type defensively falls back to metadata noise", () => {
  const c = classifyRawEvent(raw("some_future_event_msg_type", { foo: "bar" }));
  assert.equal(c.noise, true, "unknown event_msg types never become work");
});
