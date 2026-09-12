import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractContentText, recordToRawEvent, parseCodexJsonl, parseCodexJsonArray,
  CodexExportAdapter, looksLikeCodex,
} from "@devrecap/codex-parser";

test("extractContentText handles array of parts and plain string", () => {
  assert.equal(
    extractContentText([{ type: "input_text", text: "hello" }, { type: "input_text", text: "world" }]),
    "hello\nworld",
  );
  assert.equal(extractContentText("plain string content"), "plain string content");
  assert.equal(extractContentText(undefined), "");
});

test("recordToRawEvent maps two-level type + payload.type", () => {
  const ev = recordToRawEvent(
    { timestamp: "2026-09-09T08:00:00Z", type: "response_item", payload: { type: "function_call", name: "shell" } },
    3, "{...}",
  );
  assert.ok(ev);
  assert.equal(ev.rootType, "response_item");
  assert.equal(ev.payloadType, "function_call");
  assert.equal(ev.toolName, "shell");
  assert.equal(ev.seq, 3);
});

test("recordToRawEvent extracts sessionId + cwd from session_meta", () => {
  const ev = recordToRawEvent({ type: "session_meta", payload: { id: "sess-1", cwd: "/x" } }, 0, "");
  assert.equal(ev?.sessionId, "sess-1");
  assert.equal(ev?.cwd, "/x");
});

test("recordToRawEvent preserves unknown record types (rootType='unknown')", () => {
  const ev = recordToRawEvent({ payload: { type: "mystery" } }, 0, "raw");
  assert.equal(ev?.rootType, "unknown");
  assert.equal(ev?.raw, "raw");
});

test("recordToRawEvent rejects non-objects", () => {
  assert.equal(recordToRawEvent("not an object", 0, ""), undefined);
  assert.equal(recordToRawEvent(null, 0, ""), undefined);
});

test("parseCodexJsonl skips malformed lines and keeps valid ones", () => {
  const content = [
    JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd: "/proj" } }),
    "THIS IS NOT JSON {",
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }),
    "", // blank line — not malformed
    "42", // valid JSON but not an object → malformed
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "ok" } }),
  ].join("\n");
  const res = parseCodexJsonl(content);
  assert.equal(res.events.length, 3);
  assert.equal(res.malformed, 2);
  assert.equal(res.sessionId, "s1");
});

test("parseCodexJsonl on empty content yields nothing (no crash)", () => {
  const res = parseCodexJsonl("");
  assert.equal(res.events.length, 0);
  assert.equal(res.malformed, 0);
});

test("parseCodexJsonArray handles a JSON array export", () => {
  const content = JSON.stringify([
    { type: "session_meta", payload: { id: "sX", cwd: "/p" } },
    { type: "response_item", payload: { type: "message", role: "user", content: "do a thing" } },
  ]);
  const res = parseCodexJsonArray(content);
  assert.equal(res.events.length, 2);
  assert.equal(res.sessionId, "sX");
});

test("CodexExportAdapter detects codex content and parses JSONL vs JSON array", () => {
  const a = new CodexExportAdapter();
  const jsonl = '{"type":"session_meta","payload":{"id":"s1"}}\n{"type":"response_item","payload":{"type":"message","role":"user","content":"x"}}';
  const arr = '[{"type":"session_meta","payload":{"id":"s2"}}]';
  assert.ok(a.detect(jsonl, "rollout-x.jsonl") > 0.5);
  assert.equal(a.parseContent(jsonl).events.length, 2);
  assert.equal(a.parseContent(arr).events.length, 1);
});

test("looksLikeCodex scores rollout JSON high and plain text low", () => {
  assert.ok(looksLikeCodex('{"type":"session_meta","payload":{}}', "rollout-a.jsonl") > 0.7);
  assert.ok(looksLikeCodex("just some notes", "notes.txt") < 0.3);
});
