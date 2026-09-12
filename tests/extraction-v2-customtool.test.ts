/**
 * Activity Extraction V2 — unified `custom_tool_call` (exec / apply_patch).
 *
 * Modern Codex uses a single response_item:
 *   { type:"custom_tool_call", call_id, name:"exec"|"apply_patch", input:"<string>" }
 * paired later with:
 *   { type:"custom_tool_call_output", call_id, output:"<string>" }
 *
 * The classifier previously read only `payload.arguments`, so these `exec`
 * calls were dropped as NOISE — real work never reached a TaskCandidate. These
 * tests reproduce the real shape and assert the calls now contribute work
 * evidence, correlate with their output by call_id, and are not double-counted
 * when the same execution is also present as an item_completed/CommandExecution.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexJsonl } from "@devrecap/codex-parser";
import {
  normalizeEvents, buildActivities, classifyRawEvent,
  customToolCommandOf, looksLikePatch,
} from "@devrecap/activity-engine";
import type { RawEvent } from "@devrecap/shared";

// --- builders (real modern shapes) -----------------------------------------
let clock = Date.UTC(2026, 8, 9, 12, 0, 0);
function ts(): string { clock += 60_000; return new Date(clock).toISOString(); }
function tsSoon(): string { clock += 400; return new Date(clock).toISOString(); } // same execution twin
function reset() { clock = Date.UTC(2026, 8, 9, 12, 0, 0); }

function meta(cwd = "/home/user/example-project", id = "sess-ct-1") {
  return JSON.stringify({ timestamp: ts(), type: "session_meta", payload: { id, cwd, cli_version: "0.72.0" } });
}
function turnCtx() { return JSON.stringify({ timestamp: ts(), type: "turn_context", payload: { model: "gpt-5-codex" } }); }
function em(pt: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: pt, ...extra } });
}
function icUser(message: string) {
  return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", message } } });
}
function icAgent(message: string) {
  return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", message } } });
}
function icCommand(command: string[], aggregated_output = "", exit_code = 0, when = ts) {
  return JSON.stringify({ timestamp: when(), type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "itm_" + command.join("_"), command, cwd: "/home/user/example-project", aggregated_output, exit_code, status: exit_code === 0 ? "success" : "failed" } } });
}
/** custom_tool_call: name + STRING input + call_id (no `arguments`). */
function ctCall(name: string, input: string, callId: string, when = ts) {
  return JSON.stringify({ timestamp: when(), type: "response_item", payload: { type: "custom_tool_call", call_id: callId, name, input } });
}
function ctOutput(callId: string, output: string) {
  return JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "custom_tool_call_output", call_id: callId, output } });
}

function run(lines: string[]) {
  reset();
  const { events } = parseCodexJsonl(lines.join("\n") + "\n");
  return buildActivities(normalizeEvents(events), "codex", { projectId: "p1" });
}
function normKinds(lines: string[]) {
  reset();
  const { events } = parseCodexJsonl(lines.join("\n") + "\n");
  return normalizeEvents(events).map((n) => n.kind);
}

// ---------------------------------------------------------------------------
// Test 1 — user intent + item_completed/CommandExecution(read) + agent reply
//          ⇒ ONE investigation activity.
// ---------------------------------------------------------------------------
test("1: user intent + CommandExecution(read) + agent ⇒ 1 investigation (not completed)", () => {
  const built = run([
    meta(), turnCtx(), em("task_started"),
    icUser("Why is the report endpoint returning an empty list?"),
    icCommand(["cat src/server/store.ts"], "export function listActivities(){…}\n", 0),
    icAgent("The default filter excludes merged rows; no change applied yet."),
    em("turn_complete"),
  ]);
  assert.equal(built.length, 1, `got ${built.length}`);
  const a = built[0].activity;
  assert.equal(a.category, "investigation");
  assert.notEqual(a.status, "completed");
  const md = a.metadata as Record<string, string[]>;
  assert.ok(md.filesRead.length >= 1, "read recorded as evidence");
  assert.equal(md.filesModified.length, 0, "no edits");
});

// ---------------------------------------------------------------------------
// Test 2 — user intent + item_completed/FileChange + CommandExecution(test pass)
//          ⇒ ONE completed activity.
// ---------------------------------------------------------------------------
test("2: user intent + FileChange + CommandExecution(test passed) ⇒ 1 completed", () => {
  const built = run([
    meta(), turnCtx(), em("task_started"),
    icUser("Fix the off-by-one in the date parser"),
    JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", id: "fc1", changes: { "/home/user/example-project/src/date.ts": { type: "update" } }, status: "completed" } } }),
    icCommand(["npm test"], "Tests: 12 passed", 0),
    icAgent("Corrected the offset; all tests pass."),
    em("turn_complete"),
  ]);
  assert.equal(built.length, 1, `got ${built.length}`);
  const a = built[0].activity;
  assert.equal(a.status, "completed");
  const md = a.metadata as Record<string, string[]>;
  assert.ok(md.filesModified.some((f) => /date\.ts/.test(f)), "file change recorded as edit");
});

// ---------------------------------------------------------------------------
// Test 3 — custom_tool_call name=exec + matching output ⇒ work evidence.
// ---------------------------------------------------------------------------
test("3: custom_tool_call name=exec (+ output) contributes work evidence", () => {
  const kinds = normKinds([
    meta(), turnCtx(),
    icUser("Run the test suite and fix what fails"),
    ctCall("exec", "npm test", "call_1"),
    ctOutput("call_1", "Tests: 3 failed, 5 passed"),
    ctCall("apply_patch", "*** Begin Patch\n*** Update File: src/x.ts\n+fix\n*** End Patch", "call_2"),
    ctCall("exec", "npm test", "call_3"),
    ctOutput("call_3", "Tests: 8 passed"),
    icAgent("Fixed the failure; tests pass."),
  ]);
  // exec calls must NOT be dropped as noise — they produce work events.
  assert.ok(kinds.includes("test_run"), `expected test_run, got ${kinds.join(",")}`);
  assert.ok(kinds.includes("file_edit"), `expected file_edit from apply_patch, got ${kinds.join(",")}`);

  const built = run([
    meta(), turnCtx(),
    icUser("Run the test suite and fix what fails"),
    ctCall("exec", "npm test", "call_1"),
    ctOutput("call_1", "Tests: 3 failed, 5 passed"),
    ctCall("apply_patch", "*** Begin Patch\n*** Update File: src/x.ts\n+fix\n*** End Patch", "call_2"),
    ctCall("exec", "npm test", "call_3"),
    ctOutput("call_3", "Tests: 8 passed"),
    icAgent("Fixed the failure; tests pass."),
  ]);
  assert.equal(built.length, 1, `got ${built.length}`);
  assert.equal(built[0].activity.status, "completed", "final passing test ⇒ completed");
});

// ---------------------------------------------------------------------------
// Test 4 — same execution as BOTH custom_tool_call and item_completed
//          ⇒ not double-counted.
// ---------------------------------------------------------------------------
test("4: same exec via custom_tool_call AND item_completed/CommandExecution ⇒ no double count", () => {
  const kinds = normKinds([
    meta(), turnCtx(),
    icUser("List the source files"),
    // two serializations of the SAME `ls src` execution, close in time
    ctCall("exec", "ls src", "call_x", tsSoon),
    icCommand(["ls src"], "a.ts b.ts\n", 0, tsSoon),
    icAgent("There are two source files."),
  ]);
  const reads = kinds.filter((k) => k === "file_read").length;
  const shells = kinds.filter((k) => k === "shell_command").length;
  assert.equal(reads + shells, 1, `same execution must yield ONE work event, got kinds ${kinds.join(",")}`);
});

// ---------------------------------------------------------------------------
// Test 5 — metadata only ⇒ ZERO activities.
// ---------------------------------------------------------------------------
test("5: metadata/token/context only ⇒ 0 activities", () => {
  const built = run([
    meta(), turnCtx(),
    em("task_started"),
    em("token_count", { info: { total_token_usage: { total_tokens: 100 } } }),
    icUser("<environment_context>\n<cwd>/home/user/example-project</cwd>\n</environment_context>"),
    JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "item_completed", item: { type: "Reasoning", text: "thinking" } } }),
    em("turn_complete"),
  ]);
  assert.equal(built.length, 0, `got ${built.length}`);
});

// ---------------------------------------------------------------------------
// Classifier + helper unit tests for custom_tool_call
// ---------------------------------------------------------------------------
function rawCT(name: string, input: string, callId = "c1"): RawEvent {
  return { seq: 0, rootType: "response_item", payloadType: "custom_tool_call", toolName: name, data: { type: "custom_tool_call", call_id: callId, name, input }, raw: "" };
}

test("classifier: custom_tool_call name=exec with shell input classifies by command", () => {
  assert.equal(classifyRawEvent(rawCT("exec", "npm test")).cls, "TEST_RUN");
  assert.equal(classifyRawEvent(rawCT("exec", "git commit -m x")).cls, "GIT_EVENT");
  assert.equal(classifyRawEvent(rawCT("exec", "cat src/x.ts")).cls, "FILE_READ");
  assert.equal(classifyRawEvent(rawCT("exec", "sed -i 's/a/b/' src/x.ts")).cls, "FILE_EDIT");
});

test("classifier: custom_tool_call name=exec with non-shell/code input ⇒ COMMAND (never NOISE)", () => {
  const codey = classifyRawEvent(rawCT("exec", "import os\nfor i in range(10):\n    print(i)\n"));
  assert.equal(codey.cls, "COMMAND");
  assert.equal(codey.noise, false);
});

test("classifier: custom_tool_call name=apply_patch ⇒ FILE_EDIT", () => {
  const c = classifyRawEvent(rawCT("apply_patch", "*** Begin Patch\n*** Update File: src/x.ts\n+fix\n*** End Patch"));
  assert.equal(c.cls, "FILE_EDIT");
  assert.equal(c.noise, false);
});

test("classifier: a patch-looking exec input is still FILE_EDIT", () => {
  const c = classifyRawEvent(rawCT("exec", "*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch"));
  assert.equal(c.cls, "FILE_EDIT");
});

test("helper: customToolCommandOf parses JSON args and short one-liners; rejects code blocks", () => {
  assert.equal(customToolCommandOf('{"command":["bash","-lc","npm test"]}'), "npm test");
  assert.equal(customToolCommandOf('{"cmd":"git status"}'), "git status");
  assert.equal(customToolCommandOf("ls -la src"), "ls -la src");
  assert.equal(customToolCommandOf("def main():\n    return 1\n"), undefined);
  assert.equal(customToolCommandOf(""), undefined);
});

test("helper: looksLikePatch recognizes apply_patch and unified diff bodies", () => {
  assert.equal(looksLikePatch("*** Begin Patch\n*** Update File: a.ts\n+x\n*** End Patch"), true);
  assert.equal(looksLikePatch("diff --git a/x b/x\n--- a/x\n+++ b/x"), true);
  assert.equal(looksLikePatch("npm test"), false);
});
