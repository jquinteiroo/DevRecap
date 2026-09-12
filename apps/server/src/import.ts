/**
 * Import orchestrator (streaming, two-phase).
 *
 * The single entry point for data into DevRecap. DevRecap never reads anything
 * the user did not hand to these functions.
 *
 * Lifecycle:
 *   1. UPLOAD  — streamUploadToStorage() streams the raw request body to a temp
 *                file, computes SHA-256 incrementally, enforces MAX_UPLOAD_BYTES
 *                mid-stream, then atomically moves it into import storage. An
 *                `uploaded` import row is created (dedup-aware). NOTHING is
 *                analyzed yet.
 *   2. ANALYZE — analyzeImport() is triggered EXPLICITLY by the user. It expands
 *                the stored file (streaming for plain/gz; on-disk for zip
 *                members with safety limits), parses each member line-by-line,
 *                persists raw events, and builds evidence-backed activities.
 *                Status → completed | partial | failed.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";
import type { DB, ImportedSource, ImportSourceAdapter, RawEvent, Activity, Evidence } from "@devrecap/shared";
import { newId, nowIso, stableId, toEpoch, logger } from "@devrecap/shared";
import {
  prepareStoredImport, sanitizeFilename, MAX_UPLOAD_BYTES, MAX_DECOMPRESSED_BYTES,
  formatBytes, ImportLimitError, GenericTextAdapter,
} from "@devrecap/import-core";
import type { MemberDescriptor } from "@devrecap/import-core";
import { CodexExportAdapter, parseCodexJsonlStream } from "@devrecap/codex-parser";
import { GitLogAdapter } from "@devrecap/git-parser";
import {
  normalizeEvents, buildActivities, detectProject, correlateActivityWithCommits,
  StreamingNormalizer, StreamingActivityBuilder,
  classifyRawEvent, nestedShapeKeyOf, sampleShapeOf, emptyDiagnostics,
} from "@devrecap/activity-engine";
import type { ExtractionDiagnostics } from "@devrecap/activity-engine";

const MAX_SAMPLE_SHAPES = 40;

/** Raw events are persisted to SQLite in bounded batches, so a huge import
 *  never holds all rows in memory before writing. */
const RAW_EVENT_BATCH = 500;
import {
  insertImport, updateImport, findImportByHash, getImport, getImportStoredPath,
  insertSession, insertRawEvents, insertActivity, upsertProject, upsertCommit, listCommits,
} from "./store.ts";

/** Content adapters, in preference order; detect() scores decide the winner. */
function adapters(): ImportSourceAdapter[] {
  return [new CodexExportAdapter(), new GitLogAdapter(), new GenericTextAdapter()];
}

// ---------------------------------------------------------------------------
// Phase 1 — streaming upload
// ---------------------------------------------------------------------------

export interface UploadResult {
  import: ImportedSource;
  duplicateOf?: { id: string; importedAt: string; originalFilename: string; status: string };
}

/**
 * Stream a raw request body to storage with an incremental hash and a hard size
 * cap. Never buffers the whole upload. Returns an `uploaded` import row (or, if
 * the content hash already exists and allowDuplicates is false, a reference to
 * the existing import and no new row).
 */
export async function streamUploadToStorage(
  db: DB,
  dataDir: string,
  req: IncomingMessage,
  rawFilename: string,
  opts: { allowDuplicates?: boolean; batchId?: string } = {},
): Promise<UploadResult> {
  const importId = newId("imp");
  const filename = sanitizeFilename(rawFilename);
  const importDir = join(dataDir, "imports", importId);
  await mkdir(importDir, { recursive: true });
  const tmpPath = join(importDir, `.upload.tmp`);
  const finalPath = join(importDir, filename);

  const hash = createHash("sha256");
  let size = 0;
  let overflow = false;

  const out = createWriteStream(tmpPath);
  // Count + hash + size-cap as bytes stream through, before hitting disk limits.
  req.on("data", (chunk: Buffer) => {
    if (overflow) return;
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) {
      overflow = true;
      req.destroy();
      out.destroy();
      return;
    }
    hash.update(chunk);
  });

  try {
    await pipeline(req, out);
  } catch (e) {
    await safeRm(importDir);
    if (overflow) {
      throw new ImportLimitError(
        "MAX_UPLOAD_BYTES",
        `Upload rejected because it exceeds the configured ${formatBytes(MAX_UPLOAD_BYTES)} maximum upload size.`,
      );
    }
    throw new Error(`Upload failed while receiving "${filename}": ${String(e)}`);
  }
  if (overflow) {
    await safeRm(importDir);
    throw new ImportLimitError(
      "MAX_UPLOAD_BYTES",
      `Upload rejected because it exceeds the configured ${formatBytes(MAX_UPLOAD_BYTES)} maximum upload size.`,
    );
  }
  if (size === 0) {
    await safeRm(importDir);
    throw new Error(`Upload rejected: "${filename}" is empty (0 bytes).`);
  }

  const digest = hash.digest("hex");

  // Duplicate detection using the streamed hash.
  if (!opts.allowDuplicates) {
    const dup = findImportByHash(db, digest);
    if (dup) {
      await safeRm(importDir); // discard the freshly-uploaded copy
      return {
        import: dup,
        duplicateOf: {
          id: dup.id, importedAt: dup.importedAt,
          originalFilename: dup.originalFilename, status: dup.status,
        },
      };
    }
  }

  // Atomically move temp → final name.
  await rename(tmpPath, finalPath);

  const imp: ImportedSource = {
    id: importId, batchId: opts.batchId, originalFilename: filename,
    fileType: "unknown", importedAt: nowIso(), size, hash: digest,
    status: "uploaded", eventCount: 0, activityCount: 0, errorCount: 0, warningCount: 0,
  };
  insertImport(db, imp, finalPath);
  logger.info("import uploaded", { importId, filename, size });
  return { import: imp };
}

async function safeRm(dir: string): Promise<void> {
  try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Phase 2 — explicit analyze
// ---------------------------------------------------------------------------

export interface AnalyzeResult {
  import: ImportedSource;
  warnings: string[];
}

/**
 * Analyze a previously-uploaded import. Explicit user action — never called
 * automatically at upload time.
 */
export async function analyzeImport(db: DB, dataDir: string, importId: string): Promise<AnalyzeResult> {
  const imp = getImport(db, importId);
  if (!imp) throw new Error("import not found");
  const storedPath = getImportStoredPath(db, importId);
  if (!storedPath) throw new Error("import has no stored file");

  updateImport(db, importId, { status: "processing" });
  const warnings: string[] = [];

  let prepared;
  try {
    prepared = prepareStoredImport(dataDir, importId, storedPath, imp.originalFilename);
  } catch (e) {
    const message = e instanceof ImportLimitError ? e.message : `Could not expand file: ${String(e)}`;
    const failed: ImportedSource = { ...imp, status: "failed", error: message };
    updateImport(db, importId, failed);
    logger.warn("analyze: expansion failed", { importId, error: message });
    return { import: failed, warnings };
  }

  for (const s of prepared.skipped) warnings.push(`Skipped ${s.name}: ${s.reason}`);

  const stats = await processMembers(db, importId, prepared.members, warnings);

  const status: ImportedSource["status"] =
    stats.events === 0 ? "failed" : stats.malformed > 0 ? "partial" : "completed";
  const finished: ImportedSource = {
    ...imp,
    status,
    fileType: prepared.fileType,
    size: prepared.size,
    detectedFormat: stats.detectedFormat,
    eventCount: stats.events,
    activityCount: stats.activities,
    errorCount: stats.malformed,
    warningCount: warnings.length,
    error: stats.events === 0
      ? buildFailureMessage(imp.originalFilename, stats, warnings)
      : undefined,
    diagnostics: {
      ...stats.diagnostics,
      parserWarnings: warnings.length,
      malformedRecords: stats.malformed,
    },
  };
  updateImport(db, importId, finished);
  logger.info("import analyzed", {
    importId, format: stats.detectedFormat, events: stats.events,
    activities: stats.activities, malformed: stats.malformed, warnings: warnings.length,
  });
  return { import: finished, warnings };
}

/**
 * Re-analyze an existing import with the current extraction logic. Keeps the
 * original stored document; deletes only the DERIVED data (activities, evidence,
 * sessions, raw_events, commits) and regenerates it. Never accesses the original
 * source location — only DevRecap's own stored copy.
 */
export async function reanalyzeImport(db: DB, dataDir: string, importId: string): Promise<AnalyzeResult> {
  const imp = getImport(db, importId);
  if (!imp) throw new Error("import not found");
  // Delete derived data for this import (evidence cascades from activities).
  db.tx(() => {
    db.run(`DELETE FROM activities WHERE import_id=?`, [importId]);
    db.run(`DELETE FROM raw_events WHERE import_id=?`, [importId]);
    db.run(`DELETE FROM commits WHERE import_id=?`, [importId]);
    db.run(`DELETE FROM sessions WHERE import_id=?`, [importId]);
    // reset counters/status; keep the stored file + hash + filename
    updateImport(db, importId, {
      status: "uploaded", eventCount: 0, activityCount: 0, errorCount: 0,
      warningCount: 0, error: undefined, detectedFormat: undefined, diagnostics: undefined,
    });
  });
  return analyzeImport(db, dataDir, importId);
}

function buildFailureMessage(filename: string, stats: MemberStats, warnings: string[]): string {
  if (warnings.length) return `Could not analyze ${filename}: ${warnings[0]}`;
  if (stats.malformed > 0)
    return `Could not analyze ${filename}: all ${stats.malformed} record(s) were malformed and skipped.`;
  return `Could not analyze ${filename}: no parseable events were found.`;
}

interface MemberStats {
  events: number;
  activities: number;
  malformed: number;
  warnings: number;
  detectedFormat: string;
  diagnostics: ExtractionDiagnostics;
  /** Track distinct raw-shape keys already sampled (to cap sampleShapes). */
  sampledKeys: Set<string>;
}

/** Record a raw event into the diagnostics (counts + sanitized sample shapes). */
function recordDiag(stats: MemberStats, ev: import("@devrecap/shared").RawEvent): void {
  const d = stats.diagnostics;
  // Break out modern item_completed events by nested item kind, e.g.
  // "event_msg/item_completed/command_execution".
  const shapeKey = nestedShapeKeyOf(ev);
  d.rawShapes[shapeKey] = (d.rawShapes[shapeKey] ?? 0) + 1;
  const c = classifyRawEvent(ev);
  d.classified[c.cls] = (d.classified[c.cls] ?? 0) + 1;
  if (!stats.sampledKeys.has(shapeKey) && d.sampleShapes.length < MAX_SAMPLE_SHAPES) {
    stats.sampledKeys.add(shapeKey);
    d.sampleShapes.push(sampleShapeOf(ev)); // types only — never content
  }
}

/** Read a small text preview of a member for adapter detection (bounded). */
async function detectMember(member: MemberDescriptor): Promise<{ adapter: ImportSourceAdapter; sample: string }> {
  const all = adapters();
  let sample = member.content ?? "";
  if (!sample && member.path) {
    sample = await readSample(member.path, member.gunzip ?? false, 64 * 1024);
  }
  let best: ImportSourceAdapter = all[all.length - 1];
  let bestScore = -1;
  for (const a of all) {
    const s = a.detect(sample, member.name);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return { adapter: best, sample };
}

async function readSample(path: string, gz: boolean, bytes: number): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const { createGunzip } = await import("node:zlib");
  return await new Promise<string>((resolve) => {
    let acc = "";
    const fs = createReadStream(path);
    const src = gz ? fs.pipe(createGunzip()) : fs;
    const done = () => { fs.destroy(); resolve(acc); };
    src.on("data", (c: Buffer | string) => {
      acc += c.toString();
      if (Buffer.byteLength(acc) >= bytes) done();
    });
    src.on("end", () => resolve(acc));
    src.on("error", () => resolve(acc));
    fs.on("error", () => resolve(acc));
  });
}

async function processMembers(
  db: DB,
  importId: string,
  members: MemberDescriptor[],
  warnings: string[],
): Promise<MemberStats> {
  const stats: MemberStats = {
    events: 0, activities: 0, malformed: 0, warnings: 0, detectedFormat: "unknown",
    diagnostics: emptyDiagnostics(), sampledKeys: new Set(),
  };

  for (const member of members) {
    const { adapter, sample } = await detectMember(member);
    if (stats.detectedFormat === "unknown") stats.detectedFormat = adapter.kind;

    if (adapter.kind === "codex" && member.path && looksLineDelimited(sample)) {
      await processCodexMemberStreaming(db, importId, member, sample, stats, warnings);
    } else {
      processMemberBuffered(db, importId, member, adapter, sample, stats, warnings);
    }
  }
  return stats;
}

/**
 * Memory-bounded Codex path.
 *
 * Streams the JSONL file once and pipes each RawEvent through:
 *   raw-event batch (flushed every RAW_EVENT_BATCH rows) → StreamingNormalizer
 *   → StreamingActivityBuilder (which emits & persists each activity as its
 *   segment closes). Only the current raw-event batch and the current work
 *   segment are ever held in memory — never the whole session.
 *
 * Session-level metadata (session id, cwd, cli_version, model, git) is taken
 * from the already-read detection `sample` (which contains the leading
 * `session_meta`/`turn_context`), so no second pass or full buffer is needed.
 */
async function processCodexMemberStreaming(
  db: DB,
  importId: string,
  member: MemberDescriptor,
  sample: string,
  stats: MemberStats,
  warnings: string[],
): Promise<void> {
  // Derive session metadata from the header sample (bounded, already in memory).
  const headerEvents = normalizeToRaw(sample);
  const meta = extractSessionMeta(headerEvents);
  const headerSessionId = headerEvents.find((e) => e.sessionId)?.sessionId;
  const cwd = headerEvents.find((e) => e.cwd)?.cwd;
  const sid = headerSessionId ?? stableId("cxs", importId, member.name);

  // Project detection from imported metadata ONLY (path is never visited).
  let projectId: string | undefined;
  if (cwd) {
    const proj = detectProject(cwd);
    upsertProject(db, { ...proj, createdAt: nowIso() });
    projectId = proj.id;
  }
  const commitPool = projectId ? listCommits(db, projectId) : listCommits(db);

  // Persist the session row up front; refine counts/timespan at the end.
  insertSession(db, {
    id: sid, importId, sourceMember: member.name, cwd,
    cliVersion: meta.cliVersion, model: meta.model,
    gitBranch: meta.gitBranch, gitCommit: meta.gitCommit,
    eventCount: 0,
  });

  let eventCount = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  let rawBatch: Array<{ seq: number; ts?: string; rootType: string; payloadType?: string; role?: string; toolName?: string; raw: string }> = [];

  const flushRaw = () => {
    if (rawBatch.length === 0) return;
    insertRawEvents(db, sid, importId, rawBatch);
    rawBatch = [];
  };

  const persistActivity = (b: { activity: Activity; evidence: Evidence[] }) => {
    if (commitPool.length) {
      const corr = correlateActivityWithCommits(b.activity, commitPool);
      if (corr.evidence.length) {
        b.evidence.push(...corr.evidence);
        b.activity.confidence = Math.min(0.99, b.activity.confidence + corr.confidenceDelta);
        if (corr.statusToCompleted && b.activity.status !== "completed") {
          b.activity.status = "completed";
          appendReason(b.activity, "A matching Git commit was found in the imported evidence.");
        }
      }
    }
    insertActivity(db, b.activity, b.evidence, importId);
    stats.activities++;
  };

  const builder = new StreamingActivityBuilder("codex", persistActivity, { projectId, diagnostics: stats.diagnostics });
  const normalizer = new StreamingNormalizer((n) => builder.add(n));

  try {
    const res = await parseCodexJsonlStream(member.path!, {
      gunzip: member.gunzip ?? false,
      maxBytes: MAX_DECOMPRESSED_BYTES,
      onEvent: (ev) => {
        // Ensure every event carries the session id so evidence traces sid:seq.
        if (!ev.sessionId) ev.sessionId = sid;
        eventCount++;
        recordDiag(stats, ev); // safe counts + sanitized shapes (no content)
        const te = toEpoch(ev.ts);
        if (te) { if (te < minTs) minTs = te; if (te > maxTs) maxTs = te; }
        // 1) persist raw event (batched)
        rawBatch.push({
          seq: ev.seq, ts: ev.ts, rootType: ev.rootType, payloadType: ev.payloadType,
          role: ev.role, toolName: ev.toolName, raw: ev.raw,
        });
        if (rawBatch.length >= RAW_EVENT_BATCH) flushRaw();
        // 2) feed the streaming normalize → activity pipeline
        normalizer.push(ev);
      },
    });
    if (res.truncated) {
      warnings.push(`${member.name}: stopped after reaching the ${formatBytes(MAX_DECOMPRESSED_BYTES)} decompressed-size limit.`);
    }
    if (res.malformed > 0) {
      warnings.push(`${member.name}: skipped ${res.malformed} malformed record(s)` +
        (res.malformedSamples[0] ? ` (first at line ${res.malformedSamples[0].line}).` : "."));
    }
    stats.malformed += res.malformed;
  } catch (e) {
    flushRaw();
    builder.flush();
    warnings.push(`${member.name}: could not stream-parse (${String(e)}).`);
    stats.warnings++;
    return;
  }

  flushRaw();
  builder.flush(); // emit + persist the final open segment

  if (eventCount === 0) { stats.warnings++; return; }
  stats.events += eventCount;

  // Refine the session row with the final counts/timespan.
  insertSession(db, {
    id: sid, importId, sourceMember: member.name, cwd,
    cliVersion: meta.cliVersion, model: meta.model,
    gitBranch: meta.gitBranch, gitCommit: meta.gitCommit,
    startedAt: minTs !== Infinity ? new Date(minTs).toISOString() : undefined,
    endedAt: maxTs !== -Infinity ? new Date(maxTs).toISOString() : undefined,
    eventCount,
  });
}

/**
 * Buffered path for non-Codex or non-line-delimited members (git-log text,
 * JSON-array exports, generic text, small in-memory zip members). These are
 * already bounded by the archive/member size limits.
 */
function processMemberBuffered(
  db: DB,
  importId: string,
  member: MemberDescriptor,
  adapter: { kind: string; parseContent: (c: string) => { events: RawEvent[]; malformed: number; sessionId?: string } },
  sample: string,
  stats: MemberStats,
  warnings: string[],
): void {
  const content = member.content ?? sample;
  let parsed;
  try {
    parsed = adapter.parseContent(content);
  } catch (e) {
    warnings.push(`${member.name}: parse failed (${String(e)}).`);
    stats.warnings++;
    return;
  }
  const events = parsed.events;
  for (const e of events) recordDiag(stats, e); // safe counts + shapes
  stats.malformed += parsed.malformed;
  if (parsed.malformed > 0) warnings.push(`${member.name}: skipped ${parsed.malformed} malformed record(s).`);
  if (events.length === 0) { stats.warnings++; return; }

  const sid = parsed.sessionId ?? stableId("cxs", importId, member.name);
  for (const e of events) if (!e.sessionId) e.sessionId = sid;
  const cwd = events.find((e) => e.cwd)?.cwd;
  const times = events.map((e) => toEpoch(e.ts)).filter(Boolean).sort((a, b) => a - b);
  const meta = extractSessionMeta(events);
  insertSession(db, {
    id: sid, importId, sourceMember: member.name, cwd,
    cliVersion: meta.cliVersion, model: meta.model,
    gitBranch: meta.gitBranch, gitCommit: meta.gitCommit,
    startedAt: times.length ? new Date(times[0]).toISOString() : undefined,
    endedAt: times.length ? new Date(times[times.length - 1]).toISOString() : undefined,
    eventCount: events.length,
  });
  insertRawEvents(db, sid, importId, events.map((e) => ({
    seq: e.seq, ts: e.ts, rootType: e.rootType, payloadType: e.payloadType,
    role: e.role, toolName: e.toolName, raw: e.raw,
  })));
  stats.events += events.length;

  let projectId: string | undefined;
  if (cwd) {
    const proj = detectProject(cwd);
    upsertProject(db, { ...proj, createdAt: nowIso() });
    projectId = proj.id;
  }
  if (adapter.kind === "git-log") {
    const commits = (adapter as GitLogAdapter).parseCommits(content);
    for (const c of commits) upsertCommit(db, { ...c, projectId }, importId);
  }

  const commitPool = projectId ? listCommits(db, projectId) : listCommits(db);
  const persist = (b: { activity: Activity; evidence: Evidence[] }) => {
    if (commitPool.length) {
      const corr = correlateActivityWithCommits(b.activity, commitPool);
      if (corr.evidence.length) {
        b.evidence.push(...corr.evidence);
        b.activity.confidence = Math.min(0.99, b.activity.confidence + corr.confidenceDelta);
        if (corr.statusToCompleted && b.activity.status !== "completed") {
          b.activity.status = "completed";
          appendReason(b.activity, "A matching Git commit was found in the imported evidence.");
        }
      }
    }
    insertActivity(db, b.activity, b.evidence, importId);
    stats.activities++;
  };
  const norm = normalizeEvents(events);
  const builder = new StreamingActivityBuilder(
    adapter.kind === "git-log" ? "git" : "codex", persist,
    { projectId, diagnostics: stats.diagnostics },
  );
  for (const n of norm) builder.add(n);
  builder.flush();
}

/** Parse a small header sample into RawEvents just to read session metadata. */
function normalizeToRaw(sample: string): RawEvent[] {
  const out: RawEvent[] = [];
  const lines = sample.split(/\r?\n/);
  let seq = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as Record<string, unknown>;
      const rootType = typeof rec.type === "string" ? rec.type : "unknown";
      const payload = (rec.payload ?? {}) as Record<string, unknown>;
      out.push({
        sessionId: rootType === "session_meta" && typeof payload.id === "string" ? payload.id : undefined,
        seq: seq++,
        ts: typeof rec.timestamp === "string" ? rec.timestamp : undefined,
        rootType,
        payloadType: typeof payload.type === "string" ? payload.type : undefined,
        cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
        data: rec.payload ?? rec,
        raw: line,
      });
    } catch {
      // ignore a partial trailing line in the sample
    }
  }
  return out;
}

function looksLineDelimited(sample: string): boolean {
  // JSONL if the first non-empty line parses AND there is more than one line,
  // or it clearly starts with an object (not an array export).
  const trimmed = sample.trimStart();
  return !trimmed.startsWith("[");
}

function appendReason(activity: { metadata?: Record<string, unknown> }, reason: string): void {
  const md = (activity.metadata ?? {}) as Record<string, unknown>;
  const reasons = Array.isArray(md.reasoning) ? (md.reasoning as string[]) : [];
  reasons.push(reason);
  md.reasoning = reasons;
  activity.metadata = md;
}

/** Pull session-level metadata from raw events (session_meta / turn_context). */
function extractSessionMeta(events: RawEvent[]): {
  cliVersion?: string; model?: string; gitBranch?: string; gitCommit?: string;
} {
  const out: { cliVersion?: string; model?: string; gitBranch?: string; gitCommit?: string } = {};
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.rootType === "session_meta") {
      if (typeof d.cli_version === "string") out.cliVersion = d.cli_version;
      const git = d.git as Record<string, unknown> | undefined;
      if (git) {
        if (typeof git.branch === "string") out.gitBranch = git.branch;
        if (typeof git.commit === "string") out.gitCommit = git.commit;
      }
    }
    if (e.rootType === "turn_context" && typeof d.model === "string") out.model = d.model;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Duplicate preview (used by the UI before uploading, still supported)
// ---------------------------------------------------------------------------

export interface DuplicateCheck {
  hash: string;
  duplicate?: { id: string; importedAt: string; originalFilename: string; status: string };
}

export function checkDuplicateByHash(db: DB, hash: string): DuplicateCheck {
  const dup = findImportByHash(db, hash);
  return {
    hash,
    duplicate: dup
      ? { id: dup.id, importedAt: dup.importedAt, originalFilename: dup.originalFilename, status: dup.status }
      : undefined,
  };
}
