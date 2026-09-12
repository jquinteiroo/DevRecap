/**
 * End-to-end import pipeline test (streaming, two-phase).
 *
 * Upload (streamed, no base64) → analyze (explicit) → activities + evidence →
 * duplicate detection → cascade + physical delete. Also covers streaming gzip
 * and a large generated JSONL to prove the parser is structurally streaming.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, existsSync, mkdtempSync, createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { once } from "node:events";
import { openDb } from "@devrecap/shared";
import {
  streamUploadToStorage, analyzeImport, reanalyzeImport, checkDuplicateByHash,
} from "../apps/server/src/import.ts";
import { listActivities, getActivity, listImports, deleteImport, listEvidenceDetailed, getImportDiagnostics } from "../apps/server/src/store.ts";

const FIXTURE = join(process.cwd(), "fixtures", "codex", "2026", "09", "09", "rollout-2026-09-09T08-17-00-abc123.jsonl");

/** A minimal IncomingMessage-like Readable carrying bytes + headers. */
function fakeReq(bytes: Buffer, headers: Record<string, string> = {}) {
  const r = Readable.from([bytes]) as Readable & { headers: Record<string, string> };
  r.headers = headers;
  return r as unknown as import("node:http").IncomingMessage;
}

/** Wrap an existing Readable (e.g. a file stream) as an IncomingMessage-like req. */
function fakeReqFromStream(stream: Readable, headers: Record<string, string> = {}) {
  (stream as Readable & { headers: Record<string, string> }).headers = headers;
  return stream as unknown as import("node:http").IncomingMessage;
}

function tmp(): string { return mkdtempSync(join(tmpdir(), "dr-e2e-")); }

test("upload (streamed) then analyze → evidence-backed activities, status partial", async () => {
  const db = openDb(":memory:");
  const dir = tmp();
  try {
    const bytes = readFileSync(FIXTURE);
    const up = await streamUploadToStorage(db, dir, fakeReq(bytes), "rollout.jsonl");
    assert.equal(up.import.status, "uploaded");
    assert.equal(up.duplicateOf, undefined);
    // NOT analyzed yet:
    assert.equal(listActivities(db, {}).length, 0);

    const res = await analyzeImport(db, dir, up.import.id);
    assert.equal(res.import.detectedFormat, "codex");
    assert.equal(res.import.status, "partial"); // fixture has one malformed line
    assert.ok((res.import.eventCount ?? 0) >= 10);
    assert.ok((res.import.activityCount ?? 0) >= 1);
    assert.ok((res.import.errorCount ?? 0) >= 1);
    assert.ok(res.warnings.some((w) => /malformed/i.test(w)), "warns about malformed records");

    const acts = listActivities(db, {});
    assert.equal(acts.length, res.import.activityCount);
    for (const a of acts) {
      const full = getActivity(db, a.id);
      assert.ok((full?.evidence?.length ?? 0) > 0, `activity ${a.id} has evidence`);
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("duplicate detection: second upload of identical bytes is flagged, no new import", async () => {
  const db = openDb(":memory:");
  const dir = tmp();
  try {
    const bytes = readFileSync(FIXTURE);
    const first = await streamUploadToStorage(db, dir, fakeReq(bytes), "rollout.jsonl");
    assert.equal(first.duplicateOf, undefined);

    // Pre-upload hash probe now reports the duplicate.
    const probe = checkDuplicateByHash(db, first.import.hash);
    assert.ok(probe.duplicate, "hash probe finds the existing import");

    const second = await streamUploadToStorage(db, dir, fakeReq(bytes), "rollout.jsonl");
    assert.ok(second.duplicateOf, "second upload flagged as duplicate");
    assert.equal(listImports(db).length, 1, "no duplicate import row created");

    // allowDuplicates forces a new import.
    const forced = await streamUploadToStorage(db, dir, fakeReq(bytes), "rollout.jsonl", { allowDuplicates: true });
    assert.equal(forced.duplicateOf, undefined);
    assert.equal(listImports(db).length, 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("compressed .gz upload is transparently stream-decompressed and parsed", async () => {
  const db = openDb(":memory:");
  const dir = tmp();
  try {
    const gz = gzipSync(readFileSync(FIXTURE));
    const up = await streamUploadToStorage(db, dir, fakeReq(gz), "rollout.jsonl.gz");
    const res = await analyzeImport(db, dir, up.import.id);
    assert.equal(res.import.detectedFormat, "codex");
    assert.ok((res.import.activityCount ?? 0) >= 1, "activities produced from gzipped session");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("empty upload is rejected with a clear message", async () => {
  const db = openDb(":memory:");
  const dir = tmp();
  try {
    await assert.rejects(
      () => streamUploadToStorage(db, dir, fakeReq(Buffer.alloc(0)), "empty.jsonl"),
      /empty/i,
    );
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("deleting an import removes DB rows (cascade) AND the physical directory", async () => {
  const db = openDb(":memory:");
  const dir = tmp();
  try {
    const bytes = readFileSync(FIXTURE);
    const up = await streamUploadToStorage(db, dir, fakeReq(bytes), "rollout.jsonl");
    await analyzeImport(db, dir, up.import.id);
    assert.ok(listActivities(db, {}).length > 0);
    const importDir = join(dir, "imports", up.import.id);
    assert.ok(existsSync(importDir), "stored copy exists before delete");

    const r = deleteImport(db, up.import.id, dir);
    assert.equal(r.found, true);
    assert.equal(r.filesRemoved, true);
    assert.equal(r.fileError, undefined);
    assert.ok(!existsSync(importDir), "physical directory removed");
    assert.equal(listActivities(db, {}).length, 0, "activities cascade-deleted");
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM evidence")!.n, 0);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM raw_events")!.n, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("delete is idempotent when the physical directory is already gone", async () => {
  const db = openDb(":memory:");
  const dir = tmp();
  try {
    const up = await streamUploadToStorage(db, dir, fakeReq(readFileSync(FIXTURE)), "rollout.jsonl");
    await analyzeImport(db, dir, up.import.id);
    // Remove the directory out-of-band, then delete via the API.
    rmSync(join(dir, "imports", up.import.id), { recursive: true, force: true });
    const r = deleteImport(db, up.import.id, dir);
    assert.equal(r.found, true);
    assert.equal(r.filesRemoved, true, "already-gone directory counts as removed");
    assert.equal(listImports(db).length, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("detailed evidence is traceable and redaction-safe", async () => {
  const db = openDb(":memory:");
  const dir = tmp();
  try {
    const up = await streamUploadToStorage(db, dir, fakeReq(readFileSync(FIXTURE)), "rollout.jsonl");
    await analyzeImport(db, dir, up.import.id);
    const act = listActivities(db, {})[0];
    const ev = listEvidenceDetailed(db, act.id);
    assert.ok(ev.length > 0);
    const withSource = ev.find((e) => e.sourceFilename);
    assert.ok(withSource, "at least one evidence item carries its source filename");
    assert.equal(withSource!.sourceFilename, "rollout.jsonl");
    assert.ok(withSource!.sessionId, "carries session id");
    assert.ok(withSource!.eventType, "carries event type");
    // Excerpts are short (never the full raw blob).
    for (const e of ev) if (e.excerpt) assert.ok(e.excerpt.length <= 241);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("LARGE generated JSONL streams correctly (counts, not RAM)", async () => {
  const db = openDb(":memory:");
  const dir = tmp();
  const srcDir = mkdtempSync(join(tmpdir(), "dr-large-"));
  const srcPath = join(srcDir, "big.jsonl");
  try {
    // Generate a synthetic session by STREAMING to disk (bounded memory during
    // generation — never builds the whole file as one in-memory string).
    const N = 20_000;
    const ws = createWriteStream(srcPath);
    const write = (line: string) => {
      if (!ws.write(line + "\n")) return once(ws, "drain");
      return undefined;
    };
    await write(JSON.stringify({ type: "session_meta", payload: { id: "big", cwd: "/home/user/example-project" } }));
    for (let i = 0; i < N; i++) {
      if (i % 5000 === 0) await write("THIS IS A MALFORMED LINE {"); // interleave bad lines
      await write(JSON.stringify({
        timestamp: new Date(Date.UTC(2026, 8, 9, 8, 0, i % 60)).toISOString(),
        type: "response_item",
        payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", `echo step ${i}`] }) },
      }));
    }
    ws.end();
    await once(ws, "finish");

    // Upload it by STREAMING the file from disk (no readFileSync of the whole
    // file) — mirrors how a real browser upload streams a File body.
    const up = await streamUploadToStorage(db, dir, fakeReqFromStream(createReadStream(srcPath)), "big.jsonl");
    const res = await analyzeImport(db, dir, up.import.id);
    assert.equal(res.import.eventCount, N + 1, "all valid records parsed (meta + N events)");
    assert.ok((res.import.errorCount ?? 0) >= 4, "malformed lines counted, not fatal");
    assert.notEqual(res.import.status, "failed");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  }
});


/** Build a small REAL-shape Codex session (event_msg/user_message,
 *  function_call exec_command, event_msg/exec_command_end) as JSONL bytes. */
function realShapeSessionBytes(): Buffer {
  let t = Date.UTC(2026, 8, 9, 9, 0, 0);
  const ts = () => { t += 60_000; return new Date(t).toISOString(); };
  const lines = [
    JSON.stringify({ timestamp: ts(), type: "session_meta", payload: { id: "e2e-real", cwd: "/home/user/example-project", cli_version: "0.65.0" } }),
    JSON.stringify({ timestamp: ts(), type: "turn_context", payload: { model: "gpt-5-codex" } }),
    JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "user_message", message: "The date parser is off by one day." } }),
    JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "grep -rn parseDate src", workdir: "/home/user/example-project" }) } }),
    JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "exec_command_end", command: ["/bin/bash", "-lc", "grep -rn parseDate src"], aggregated_output: "src/date.ts:12\n", exit_code: 0 } }),
    JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** Update File: src/date.ts\n+fix\n*** End Patch" }) } }),
    JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) } }),
    JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "exec_command_end", command: ["/bin/bash", "-lc", "npm test"], aggregated_output: "Tests: 7 passed", exit_code: 0 } }),
    JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "agent_message", message: "Fixed the off-by-one; tests pass.", phase: "final_answer" } }),
    JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "task_complete" } }),
    JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 4200 } } } }),
  ];
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

test("REAL Codex shapes: full upload → analyze produces meaningful activities (regression: not 0)", async () => {
  const db = openDb(":memory:");
  const dir = tmp();
  try {
    const up = await streamUploadToStorage(db, dir, fakeReq(realShapeSessionBytes()), "real.jsonl");
    const res = await analyzeImport(db, dir, up.import.id);
    assert.equal(res.import.detectedFormat, "codex");
    assert.ok((res.import.eventCount ?? 0) >= 10, `parsed the events, got ${res.import.eventCount}`);
    // The regression was 0 activities from real shapes — must now be >= 1.
    assert.ok((res.import.activityCount ?? 0) >= 1, `expected >=1 activity, got ${res.import.activityCount}`);
    assert.ok((res.import.activityCount ?? 0) <= 3, "a small number of activities, not one-per-event");

    const acts = listActivities(db, {});
    assert.ok(acts.length >= 1);
    const a = acts[0];
    assert.equal(a.status, "completed");
    assert.ok(!/\.jsonl|rollout-|\.log\b/i.test(a.title), `no data-file name in title, got "${a.title}"`);
    assert.ok((getActivity(db, a.id)?.evidence?.length ?? 0) > 0, "activity carries evidence");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("diagnostics are persisted on the import and retrievable (counts only, no content)", async () => {
  const db = openDb(":memory:");
  const dir = tmp();
  try {
    const up = await streamUploadToStorage(db, dir, fakeReq(realShapeSessionBytes()), "real.jsonl");
    await analyzeImport(db, dir, up.import.id);
    const diag = getImportDiagnostics(db, up.import.id) as Record<string, unknown> | undefined;
    assert.ok(diag, "diagnostics persisted");
    const d = diag as {
      rawShapes: Record<string, number>; classified: Record<string, number>;
      candidatesCreated: number; activitiesAccepted: number; candidatesRejected: number;
      parserWarnings: number; malformedRecords: number; sampleShapes: unknown[];
    };
    assert.ok((d.rawShapes["event_msg/user_message"] ?? 0) >= 1, "user_message shape counted");
    assert.ok((d.rawShapes["event_msg/exec_command_end"] ?? 0) >= 1, "exec_command_end shape counted");
    assert.ok((d.classified["USER_INTENT"] ?? 0) >= 1, "user intent classified");
    assert.ok(d.candidatesCreated >= 1 && d.activitiesAccepted >= 1, "task-engine funnel populated");
    assert.equal(typeof d.parserWarnings, "number");
    assert.equal(typeof d.malformedRecords, "number");
    // No raw content anywhere in the persisted diagnostics blob.
    const blob = JSON.stringify(diag);
    assert.ok(!/off by one|parseDate|npm test|Begin Patch|Fixed the/.test(blob), "no raw content in persisted diagnostics");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("reanalyze: regenerates derived data from the stored copy, keeps the file", async () => {
  const db = openDb(":memory:");
  const dir = tmp();
  try {
    const up = await streamUploadToStorage(db, dir, fakeReq(realShapeSessionBytes()), "real.jsonl");
    const first = await analyzeImport(db, dir, up.import.id);
    const firstCount = first.import.activityCount ?? 0;
    assert.ok(firstCount >= 1);
    const importDir = join(dir, "imports", up.import.id);
    assert.ok(existsSync(importDir), "stored copy exists");

    // Corrupt the derived layer to prove reanalyze truly rebuilds it: manually
    // wipe activities, then reanalyze must restore them from the stored file.
    db.run("DELETE FROM activities");
    assert.equal(listActivities(db, {}).length, 0);

    const re = await reanalyzeImport(db, dir, up.import.id);
    assert.equal(re.import.status, first.import.status, "same terminal status after reanalyze");
    assert.equal(re.import.activityCount, firstCount, "same activity count regenerated");
    assert.equal(listActivities(db, {}).length, firstCount, "activities restored");
    // Original stored file still present (never touched the source location).
    assert.ok(existsSync(importDir), "stored copy preserved through reanalyze");
    // No orphaned / duplicated rows for this import.
    const n = db.get<{ n: number }>("SELECT COUNT(*) n FROM activities WHERE import_id=?", [up.import.id])!.n;
    assert.equal(n, firstCount, "no duplicate activity rows after reanalyze");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
