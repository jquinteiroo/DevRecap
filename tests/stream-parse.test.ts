import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseCodexJsonlStream } from "@devrecap/codex-parser";
import type { RawEvent } from "@devrecap/shared";

function tmpFile(name: string, content: Buffer | string): string {
  const dir = mkdtempSync(join(tmpdir(), "dr-stream-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

test("parseCodexJsonlStream parses valid lines, counts malformed, preserves unknown", async () => {
  const content = [
    JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd: "/p" } }),
    "not json {",
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "hi" } }),
    JSON.stringify({ type: "something_new", payload: { type: "future_kind", detail: 1 } }),
    "",
    "123", // valid JSON, not an object → malformed
  ].join("\n");
  const p = tmpFile("s.jsonl", content);
  const events: RawEvent[] = [];
  try {
    const res = await parseCodexJsonlStream(p, { onEvent: (e) => events.push(e) });
    assert.equal(res.events, 3, "3 object records (meta, message, unknown)");
    assert.equal(res.malformed, 2, "bad JSON + non-object");
    assert.equal(res.sessionId, "s1");
    assert.ok(res.malformedSamples.length >= 1);
    assert.ok(res.malformedSamples[0].line >= 1);
    const unknown = events.find((e) => e.rootType === "something_new");
    assert.ok(unknown, "unknown record types are preserved as events");
    assert.equal(unknown!.payloadType, "future_kind");
  } finally { rmSync(join(p, ".."), { recursive: true, force: true }); }
});

test("parseCodexJsonlStream transparently gunzips a .gz source", async () => {
  const content = [
    JSON.stringify({ type: "session_meta", payload: { id: "gz1" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "done" } }),
  ].join("\n");
  const p = tmpFile("s.jsonl.gz", gzipSync(Buffer.from(content)));
  const events: RawEvent[] = [];
  try {
    const res = await parseCodexJsonlStream(p, { gunzip: true, onEvent: (e) => events.push(e) });
    assert.equal(res.events, 2);
    assert.equal(res.sessionId, "gz1");
  } finally { rmSync(join(p, ".."), { recursive: true, force: true }); }
});

test("parseCodexJsonlStream stops at the decompressed-size limit (truncated)", async () => {
  // Build a gz whose decompressed size exceeds a tiny maxBytes.
  const lines: string[] = [];
  for (let i = 0; i < 2000; i++) {
    lines.push(JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "x".repeat(200) } }));
  }
  const p = tmpFile("big.jsonl.gz", gzipSync(Buffer.from(lines.join("\n"))));
  let count = 0;
  try {
    const res = await parseCodexJsonlStream(p, { gunzip: true, maxBytes: 4096, onEvent: () => count++ });
    assert.equal(res.truncated, true, "stops at the maxBytes limit");
    assert.ok(res.events < 2000, "did not read the whole stream");
  } finally { rmSync(join(p, ".."), { recursive: true, force: true }); }
});
