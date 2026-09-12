/**
 * Activity Extraction V2 — scenario fixtures A–G + classification unit tests.
 *
 * Each scenario is built as realistic Codex JSONL and run through the full
 * parse → classify → normalize → activity pipeline, asserting the number,
 * category, and status of the activities produced. The guiding requirement:
 * infrastructure noise never becomes an activity, questions without work
 * produce nothing, reads are not edits, and multi-event work collapses to one
 * concise activity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexJsonl } from "@devrecap/codex-parser";
import {
  normalizeEvents, buildActivities, classifyRawEvent,
} from "@devrecap/activity-engine";
import type { RawEvent } from "@devrecap/shared";

// --- tiny JSONL builders ----------------------------------------------------
let clock = Date.UTC(2026, 8, 9, 8, 0, 0);
function ts(): string { clock += 60_000; return new Date(clock).toISOString(); }
function reset() { clock = Date.UTC(2026, 8, 9, 8, 0, 0); }

function meta(cwd = "/home/user/example-project", id = "sess-1") {
  return JSON.stringify({ timestamp: ts(), type: "session_meta", payload: { id, cwd, cli_version: "0.65.0", source: "cli" } });
}
function turnCtx() { return JSON.stringify({ timestamp: ts(), type: "turn_context", payload: { model: "o4-mini" } }); }
function userMsg(text: string) {
  return JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
}
function systemMsg(role: "system" | "developer", text: string) {
  return JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
}
function assistantMsg(text: string) {
  return JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
}
function shell(cmd: string) {
  return JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", cmd] }) } });
}
function readTool(path: string) {
  return JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "read_file", arguments: JSON.stringify({ path }) } });
}
function applyPatch(patchBody: string) {
  return JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: patchBody }) } });
}
function output(text: string) {
  return JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "function_call_output", output: text } });
}
function tokenCount() {
  return JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 5000 } } } });
}

function run(lines: string[]) {
  reset();
  const { events } = parseCodexJsonl(lines.join("\n") + "\n");
  return buildActivities(normalizeEvents(events), "codex", { projectId: "p1" });
}

// ---------------------------------------------------------------------------
// Fixture A — bug reported, inspected, edited, test fails, fixed, test passes
// Expected: ONE bugfix activity, status completed.
// ---------------------------------------------------------------------------
test("Fixture A: report → edit → test-fail → fix → test-pass ⇒ 1 bugfix completed", () => {
  const built = run([
    meta(), turnCtx(),
    userMsg("The item selector is not working — inactive items still show up."),
    readTool("src/components/SampleDashboard.tsx"),
    shell("grep -rn itemId src/components/SampleDashboard.tsx"),
    applyPatch("*** Begin Patch\n*** Update File: src/components/SampleDashboard.tsx\n@@\n- old\n+ new\n*** End Patch"),
    shell("npm test"),
    output("Tests: 1 failed, 3 passed"),
    applyPatch("*** Begin Patch\n*** Update File: src/components/SampleDashboard.tsx\n@@\n- new\n+ fixed\n*** End Patch"),
    shell("npm test"),
    output("Tests: 4 passed"),
    assistantMsg("Fixed the filter so inactive items are excluded. All tests pass now."),
  ]);
  assert.equal(built.length, 1, "one activity");
  const a = built[0].activity;
  assert.equal(a.category, "bugfix");
  assert.equal(a.status, "completed");
  assert.ok(a.confidence >= 0.7, `high confidence, got ${a.confidence}`);
  // Semantic Synthesis V2: title is an evidence-derived work phrase, NOT the
  // raw user prompt. A completed bugfix leads with "Fixed".
  assert.match(a.title, /^Fixed /, `completed bugfix title, got "${a.title}"`);
  assert.doesNotMatch(a.title, /item selector/i, "title must not echo the raw prompt");
  // modified file recorded; not counted as a read
  const md = a.metadata as Record<string, string[]>;
  assert.ok(md.filesModified.some((f) => /SampleDashboard\.tsx/.test(f)), "edited file recorded as modified");
  assert.ok(built[0].evidence.length >= 3, "multiple evidence items preserved");
});

// ---------------------------------------------------------------------------
// Fixture B — user asks a question, assistant explains, no files changed
// Expected: ZERO implementation activity.
// ---------------------------------------------------------------------------
test("Fixture B: pure Q&A, no work ⇒ 0 activities", () => {
  const built = run([
    meta(), turnCtx(),
    userMsg("What does the useMemo hook do in React?"),
    assistantMsg("useMemo memoizes a computed value so it is only recomputed when its dependencies change."),
  ]);
  assert.equal(built.length, 0, "a bare question with no work yields no activity");
});

// ---------------------------------------------------------------------------
// Fixture C — environment context + session/tool metadata only
// Expected: ZERO activities.
// ---------------------------------------------------------------------------
test("Fixture C: environment/session/tool metadata only ⇒ 0 activities", () => {
  const built = run([
    meta(), turnCtx(),
    userMsg("<environment_context>\n<cwd>/home/user/example-project</cwd>\n<current_date>2026-09-09</current_date>\n<sandbox>read-only</sandbox>\n</environment_context>"),
    userMsg("<user_instructions>Follow the repo conventions.</user_instructions>"),
    tokenCount(),
  ]);
  assert.equal(built.length, 0, "context/metadata never becomes an activity");
});

// ---------------------------------------------------------------------------
// Fixture D — user investigates an error, reads files, runs diagnostics, no fix
// Expected: ONE investigation, status in_progress or unknown (never completed).
// ---------------------------------------------------------------------------
test("Fixture D: investigation with no resolution ⇒ 1 investigation, not completed", () => {
  const built = run([
    meta(), turnCtx(),
    userMsg("Why does the build fail with a module resolution error?"),
    readTool("tsconfig.json"),
    shell("grep -rn moduleResolution src"),
    output("src/index.ts:1: import x from './x'"),
    shell("cat package.json"),
    output("{ \"name\": \"demo\" }"),
    assistantMsg("The paths look misconfigured, but I haven't applied a change yet."),
  ]);
  assert.equal(built.length, 1, "one investigation activity");
  const a = built[0].activity;
  assert.equal(a.category, "investigation");
  assert.notEqual(a.status, "completed");
  assert.ok(["in_progress", "unknown"].includes(a.status), `got ${a.status}`);
  // reads recorded as reads, NOT modifications
  const md = a.metadata as Record<string, string[]>;
  assert.equal(md.filesModified.length, 0, "no modifications");
  assert.ok(md.filesRead.length >= 1, "reads recorded");
});

// ---------------------------------------------------------------------------
// Fixture E — feature requested, multiple files edited, tests pass
// Expected: ONE feature activity, status completed.
// ---------------------------------------------------------------------------
test("Fixture E: feature with edits + passing tests ⇒ 1 feature completed", () => {
  const built = run([
    meta(), turnCtx(),
    userMsg("Add a CSV export button to the reports page."),
    applyPatch("*** Begin Patch\n*** Add File: src/pages/reports.tsx\n+content\n*** End Patch"),
    applyPatch("*** Begin Patch\n*** Update File: src/services/export.ts\n+content\n*** End Patch"),
    shell("npm test"),
    output("Tests: 12 passed"),
    assistantMsg("Added the CSV export button and wiring; tests pass."),
  ]);
  assert.equal(built.length, 1);
  const a = built[0].activity;
  assert.equal(a.category, "feature");
  assert.equal(a.status, "completed");
  // Completed feature leads with "Implemented" and describes the work area
  // (UI/reports), not the verbatim prompt.
  assert.match(a.title, /^Implemented /, `completed feature title, got "${a.title}"`);
  assert.equal(a.metadata.workKind, "primary", "feature work is primary");
});

// ---------------------------------------------------------------------------
// Fixture F — SKILL.md / system instructions loaded (as injected user turn)
// Expected: ZERO activities; SKILL.md must not appear as work.
// ---------------------------------------------------------------------------
test("Fixture F: SKILL.md / system instruction loading ⇒ 0 activities", () => {
  const built = run([
    meta(), turnCtx(),
    systemMsg("developer", "# Instructions\nYou are Codex. Follow the workspace conventions."),
    userMsg("<user_instructions>\nSKILL.md loaded: use the review skill for PRs.\n</user_instructions>"),
    assistantMsg("Understood."),
  ]);
  assert.equal(built.length, 0, "SKILL.md/system loading never becomes an activity");
  assert.ok(
    !built.some((b) => /skill\.md/i.test(b.activity.title)),
    "no activity titled after SKILL.md",
  );
});

// ---------------------------------------------------------------------------
// Fixture G — a command fails mid-task, then a later fix succeeds
// Expected: status completed, NOT blocked.
// ---------------------------------------------------------------------------
test("Fixture G: mid-task failure then successful fix ⇒ completed, not blocked", () => {
  const built = run([
    meta(), turnCtx(),
    userMsg("Fix the failing unit test in the parser."),
    shell("npm test"),
    output("Error: 2 failed"),
    applyPatch("*** Begin Patch\n*** Update File: src/parser.ts\n+fix\n*** End Patch"),
    shell("npm test"),
    output("Tests: 8 passed"),
    assistantMsg("The parser bug is fixed and all tests pass."),
  ]);
  assert.equal(built.length, 1);
  const a = built[0].activity;
  assert.equal(a.status, "completed", "a transient mid-task error must not force blocked");
  assert.notEqual(a.status, "blocked");
});

// ---------------------------------------------------------------------------
// Follow-up prompts stay in the SAME task (not new activities)
// ---------------------------------------------------------------------------
test("Follow-up prompts (try again / run the tests) stay in one task", () => {
  const built = run([
    meta(), turnCtx(),
    userMsg("The date formatter is off by one day."),
    applyPatch("*** Begin Patch\n*** Update File: src/date.ts\n+fix\n*** End Patch"),
    userMsg("run the tests"),
    shell("npm test"),
    output("Tests: 5 passed"),
    userMsg("still not working"),
    applyPatch("*** Begin Patch\n*** Update File: src/date.ts\n+fix2\n*** End Patch"),
    userMsg("run the tests again"),
    shell("npm test"),
    output("Tests: 6 passed"),
    assistantMsg("Fixed the off-by-one; tests pass."),
  ]);
  assert.equal(built.length, 1, "follow-ups collapse into a single activity");
  assert.equal(built[0].activity.status, "completed");
});

// ---------------------------------------------------------------------------
// Classification unit tests
// ---------------------------------------------------------------------------
function raw(rootType: string, payload: unknown, role?: string, toolName?: string): RawEvent {
  return { seq: 0, rootType, payloadType: (payload as { type?: string })?.type, role, toolName, data: payload, raw: "" };
}

test("classifier: environment_context user message is SYSTEM_CONTEXT/noise", () => {
  const c = classifyRawEvent(raw("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context><cwd>/x</cwd></environment_context>" }] }, "user"));
  assert.equal(c.cls, "SYSTEM_CONTEXT");
  assert.equal(c.noise, true);
});

test("classifier: session_meta and turn_context and token_count are metadata noise", () => {
  assert.equal(classifyRawEvent(raw("session_meta", { id: "s" })).noise, true);
  assert.equal(classifyRawEvent(raw("turn_context", { model: "x" })).noise, true);
  assert.equal(classifyRawEvent(raw("event_msg", { type: "token_count" })).noise, true);
});

test("classifier: developer/system role messages are noise", () => {
  assert.equal(classifyRawEvent(raw("response_item", { type: "message", role: "developer", content: "instructions" }, "developer")).noise, true);
  assert.equal(classifyRawEvent(raw("response_item", { type: "message", role: "system", content: "prompt" }, "system")).noise, true);
});

test("classifier: a real user request is USER_INTENT (not noise)", () => {
  const c = classifyRawEvent(raw("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "fix the login bug" }] }, "user"));
  assert.equal(c.cls, "USER_INTENT");
  assert.equal(c.noise, false);
});

test("classifier: read tool vs edit tool", () => {
  assert.equal(classifyRawEvent(raw("response_item", { type: "function_call", name: "read_file", arguments: "{}" }, undefined, "read_file")).cls, "FILE_READ");
  assert.equal(classifyRawEvent(raw("response_item", { type: "function_call", name: "apply_patch", arguments: "{}" }, undefined, "apply_patch")).cls, "FILE_EDIT");
  assert.equal(classifyRawEvent(raw("response_item", { type: "function_call", name: "grep_search", arguments: "{}" }, undefined, "grep_search")).cls, "FILE_READ");
});

test("classifier: grep/cat commands are reads; sed -i / redirection are edits", () => {
  const rd = classifyRawEvent(raw("response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "grep -rn foo src"] }) }, undefined, "shell"));
  assert.equal(rd.cls, "FILE_READ");
  const ed = classifyRawEvent(raw("response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "sed -i 's/a/b/' src/x.ts"] }) }, undefined, "shell"));
  assert.equal(ed.cls, "FILE_EDIT");
});

test("read-vs-edit: a file only read is NOT counted as modified", () => {
  const built = run([
    meta(), turnCtx(),
    userMsg("Look at how the router is set up."),
    readTool("src/router.ts"),
    readTool("src/routes/index.ts"),
    assistantMsg("The router uses a central registry in src/router.ts."),
  ]);
  // investigation (reads only), never completed, no modifications
  assert.ok(built.length <= 1);
  if (built.length === 1) {
    const md = built[0].activity.metadata as Record<string, string[]>;
    assert.equal(md.filesModified.length, 0, "reads are not modifications");
    assert.notEqual(built[0].activity.status, "completed");
  }
});

test("assistant-mentioned file paths are NOT treated as modifications", () => {
  const built = run([
    meta(), turnCtx(),
    userMsg("Explain the build pipeline."),
    assistantMsg("The pipeline is defined in webpack.config.js and tsconfig.json and package.json."),
  ]);
  // pure explanation → no activity, and certainly no 'modified' files
  assert.equal(built.length, 0);
});
