/**
 * Activity Extraction V2 — modern Codex `event_msg/item_completed` TurnItems.
 *
 * Newer Codex rollouts persist completed TurnItems as:
 *   { "type": "event_msg", "payload": { "type": "item_completed", "item": {…} } }
 * where item.type is CommandExecution / FileChange / UserMessage / AgentMessage
 * / Reasoning / Plan / McpToolCall. These were previously discarded as
 * TOOL_METADATA noise, causing "N events → 0 activities" on real imports.
 *
 * These tests reproduce those shapes and assert the classifier + normalizer
 * turn them into meaningful work, while keeping true noise filtered.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexJsonl } from "@devrecap/codex-parser";
import {
  normalizeEvents, buildActivities, classifyRawEvent, nestedShapeKeyOf,
  itemKindOf, fileChangesOf,
} from "@devrecap/activity-engine";
import type { RawEvent } from "@devrecap/shared";

// --- builders (modern item_completed shapes) -------------------------------
let clock = Date.UTC(2026, 8, 9, 11, 0, 0);
function ts(): string { clock += 60_000; return new Date(clock).toISOString(); }
function reset() { clock = Date.UTC(2026, 8, 9, 11, 0, 0); }

function meta(cwd = "/home/user/example-project", id = "sess-ic-1") {
  return JSON.stringify({ timestamp: ts(), type: "session_meta", payload: { id, cwd, cli_version: "0.70.0" } });
}
function turnCtx() { return JSON.stringify({ timestamp: ts(), type: "turn_context", payload: { model: "gpt-5-codex" } }); }
function em(payloadType: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: payloadType, ...extra } });
}
/** item_completed wrapping a nested TurnItem. */
function itemCompleted(item: Record<string, unknown>) {
  return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "item_completed", item } });
}
function icUser(message: string) { return itemCompleted({ type: "UserMessage", message }); }
function icAgent(message: string) { return itemCompleted({ type: "AgentMessage", message }); }
function icCommand(command: string, aggregated_output = "", exit_code = 0) {
  return itemCompleted({ type: "CommandExecution", command, aggregated_output, exit_code, cwd: "/home/user/example-project" });
}
function icFileChange(changes: Array<{ path: string; kind: string }>) {
  return itemCompleted({ type: "FileChange", changes });
}

function run(lines: string[]) {
  reset();
  const { events } = parseCodexJsonl(lines.join("\n") + "\n");
  return buildActivities(normalizeEvents(events), "codex", { projectId: "p1" });
}

// ---------------------------------------------------------------------------
// A) item_completed / CommandExecution with a READ command ⇒ FILE_READ evidence
// ---------------------------------------------------------------------------
test("A: item_completed CommandExecution (read command) ⇒ FILE_READ", () => {
  const c = classifyRawEvent(rawIC({ type: "CommandExecution", command: "grep -rn parseDate src", aggregated_output: "src/date.ts:12\n", exit_code: 0 }));
  assert.equal(c.cls, "FILE_READ");
  assert.equal(c.noise, false);
});

// ---------------------------------------------------------------------------
// B) item_completed / CommandExecution test command + success ⇒ testing evidence
// ---------------------------------------------------------------------------
test("B: item_completed CommandExecution (npm test, passed) ⇒ TEST_RESULT + flips test to passed", () => {
  const c = classifyRawEvent(rawIC({ type: "CommandExecution", command: "npm test", aggregated_output: "Tests: 12 passed", exit_code: 0 }));
  assert.equal(c.cls, "TEST_RESULT");

  // End-to-end: a user intent + edit + this passing test ⇒ completed activity.
  const built = run([
    meta(), turnCtx(), em("task_started"),
    icUser("Fix the failing date test"),
    icFileChange([{ path: "src/date.ts", kind: "modified" }]),
    icCommand("npm test", "Tests: 12 passed", 0),
    icAgent("Fixed the off-by-one; all tests pass."),
    em("turn_complete"),
  ]);
  assert.equal(built.length, 1, `got ${built.length}`);
  assert.equal(built[0].activity.status, "completed");
});

// ---------------------------------------------------------------------------
// C) item_completed / FileChange ⇒ FILE_EDIT evidence (create/edit/delete)
// ---------------------------------------------------------------------------
test("C: item_completed FileChange ⇒ FILE_EDIT with correct ops", () => {
  const c = classifyRawEvent(rawIC({ type: "FileChange", changes: [{ path: "src/new.ts", kind: "added" }] }));
  assert.equal(c.cls, "FILE_EDIT");
  assert.equal(c.noise, false);

  const built = run([
    meta(), turnCtx(),
    icUser("Scaffold a new module and drop the old one"),
    icFileChange([
      { path: "src/new-module.ts", kind: "added" },
      { path: "src/index.ts", kind: "modified" },
      { path: "src/legacy.ts", kind: "deleted" },
    ]),
    icAgent("Added the module, wired it into the index, removed the legacy file."),
  ]);
  assert.equal(built.length, 1);
  const md = built[0].activity.metadata as Record<string, string[]>;
  assert.ok(md.filesCreated.includes("src/new-module.ts"), "create recorded");
  assert.ok(md.filesModified.includes("src/index.ts"), "edit recorded");
  assert.ok(md.filesDeleted.includes("src/legacy.ts"), "delete recorded");
});

// ---------------------------------------------------------------------------
// D) user intent + CommandExecution + FileChange + validation ⇒ ONE activity
// ---------------------------------------------------------------------------
test("D: user_message + inspect + FileChange + passing test ⇒ 1 meaningful activity", () => {
  const built = run([
    meta(), turnCtx(), em("task_started"),
    icUser("Fix the login validation bug"),
    icCommand("cat src/auth/login.ts", "export function validate() {…}\n", 0),
    icFileChange([{ path: "src/auth/login.ts", kind: "modified" }]),
    icCommand("npm test", "Tests: 9 passed", 0),
    icAgent("Corrected the validation regex; tests pass."),
    em("token_count", { info: { total_token_usage: { total_tokens: 4000 } } }),
    em("turn_complete"),
  ]);
  assert.equal(built.length, 1, `expected exactly 1 activity, got ${built.length}`);
  const a = built[0].activity;
  assert.equal(a.status, "completed");
  // V2 synthesis: topic-based title (auth), not the raw prompt text.
  assert.doesNotMatch(a.title, /Fix the login validation bug/i, `raw prompt not echoed, got "${a.title}"`);
  assert.match(a.title, /^Fixed /, `completed bugfix verb, got "${a.title}"`);
  const md = a.metadata as Record<string, string[]>;
  assert.ok(md.filesModified.some((f) => /login\.ts/.test(f)), "edit recorded");
  assert.ok(md.filesRead.length >= 1, "inspection read recorded");
});

// ---------------------------------------------------------------------------
// E) metadata + token_count + context only ⇒ ZERO activities
// ---------------------------------------------------------------------------
test("E: session/lifecycle/context/token metadata only ⇒ 0 activities", () => {
  const built = run([
    meta(), turnCtx(),
    em("task_started"),
    em("turn_started"),
    icUser("<environment_context>\n<cwd>/home/user/example-project</cwd>\n</environment_context>"),
    em("token_count", { info: { total_token_usage: { total_tokens: 999 } } }),
    itemCompleted({ type: "Reasoning", text: "Considering the approach…" }),
    itemCompleted({ type: "Plan", steps: ["a", "b"] }),
    em("turn_complete"),
  ]);
  assert.equal(built.length, 0, `pure metadata/context/reasoning/plan must yield 0 activities, got ${built.length}`);
});

// ---------------------------------------------------------------------------
// Classifier + helper unit tests
// ---------------------------------------------------------------------------
function rawIC(item: Record<string, unknown>): RawEvent {
  return { seq: 0, rootType: "event_msg", payloadType: "item_completed", data: { type: "item_completed", item }, raw: "" };
}

test("classifier: item_completed nested UserMessage ⇒ USER_INTENT; AgentMessage ⇒ ASSISTANT_SUMMARY", () => {
  assert.equal(classifyRawEvent(rawIC({ type: "UserMessage", message: "add a button" })).cls, "USER_INTENT");
  assert.equal(classifyRawEvent(rawIC({ type: "AgentMessage", message: "Done." })).cls, "ASSISTANT_SUMMARY");
});

test("classifier: item_completed UserMessage that is context/slash ⇒ noise", () => {
  assert.equal(classifyRawEvent(rawIC({ type: "UserMessage", message: "/resume" })).noise, true);
  assert.equal(classifyRawEvent(rawIC({ type: "UserMessage", message: "<environment_context><cwd>/x</cwd></environment_context>" })).noise, true);
});

test("classifier: item_completed CommandExecution git command ⇒ GIT_EVENT", () => {
  assert.equal(classifyRawEvent(rawIC({ type: "CommandExecution", command: "git commit -m x", aggregated_output: "[main abc] x", exit_code: 0 })).cls, "GIT_EVENT");
});

test("classifier: item_completed CommandExecution failed command ⇒ ERROR", () => {
  const c = classifyRawEvent(rawIC({ type: "CommandExecution", command: "node build.js", aggregated_output: "Error: boom", exit_code: 1 }));
  assert.equal(c.cls, "ERROR");
});

test("classifier: item_completed Reasoning/Plan are noise (process metadata)", () => {
  assert.equal(classifyRawEvent(rawIC({ type: "Reasoning", text: "thinking" })).noise, true);
  assert.equal(classifyRawEvent(rawIC({ type: "Plan", steps: [] })).noise, true);
});

test("classifier: unknown nested item kind is noise (never event=activity)", () => {
  assert.equal(classifyRawEvent(rawIC({ type: "SomeFutureItem", foo: "bar" })).noise, true);
  // an item_completed with no item at all is metadata noise, not a crash
  assert.equal(classifyRawEvent({ seq: 0, rootType: "event_msg", payloadType: "item_completed", data: { type: "item_completed" }, raw: "" }).noise, true);
});

test("helper: itemKindOf is casing/serialization tolerant", () => {
  assert.equal(itemKindOf({ type: "CommandExecution" }), "command_execution");
  assert.equal(itemKindOf({ type: "commandExecution" }), "command_execution");
  assert.equal(itemKindOf({ type: "command_execution" }), "command_execution");
  assert.equal(itemKindOf({ type: "FileChange" }), "file_change");
  assert.equal(itemKindOf({ type: "fileChange" }), "file_change");
  assert.equal(itemKindOf({ type: "UserMessage" }), "user_message");
  assert.equal(itemKindOf(undefined), "other");
});

test("helper: fileChangesOf reads array, map, and bare shapes with ops", () => {
  const arr = fileChangesOf({ changes: [{ path: "a.ts", kind: "added" }, { path: "b.ts", kind: "deleted" }] });
  assert.deepEqual(arr.map((c) => [c.path, c.op]), [["a.ts", "create"], ["b.ts", "delete"]]);
  const map = fileChangesOf({ changes: { "c.ts": "modified" } });
  assert.deepEqual(map.map((c) => [c.path, c.op]), [["c.ts", "edit"]]);
  const bare = fileChangesOf({ path: "d.ts", kind: "update" });
  assert.deepEqual(bare.map((c) => [c.path, c.op]), [["d.ts", "edit"]]);
});

test("diagnostics: nestedShapeKeyOf breaks out item_completed by nested kind", () => {
  assert.equal(nestedShapeKeyOf(rawIC({ type: "CommandExecution", command: "ls" })), "event_msg/item_completed/command_execution");
  assert.equal(nestedShapeKeyOf(rawIC({ type: "FileChange", changes: [] })), "event_msg/item_completed/file_change");
  // non-item events keep the plain shape key
  assert.equal(nestedShapeKeyOf({ seq: 0, rootType: "event_msg", payloadType: "user_message", data: {}, raw: "" }), "event_msg/user_message");
});
