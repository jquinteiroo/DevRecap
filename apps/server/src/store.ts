/**
 * Data-access layer (the "store"). All SQL for reading/writing domain objects
 * lives here so route handlers stay thin. Maps DB rows ↔ domain types.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  Activity,
  Commit,
  DB,
  Evidence,
  Project,
} from "@devrecap/shared";
import { newId, nowIso, toEpoch, logger } from "@devrecap/shared";
import { redact } from "@devrecap/report-engine";

// --- projects --------------------------------------------------------------

export function upsertProject(db: DB, p: Project): void {
  db.run(
    `INSERT INTO projects(id,name,display_name,type,root_path,git_remote,detected_from,created_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       git_remote = COALESCE(excluded.git_remote, projects.git_remote),
       detected_from = excluded.detected_from`,
    [p.id, p.name, p.displayName, p.type, p.rootPath ?? null, p.gitRemote ?? null, p.detectedFrom ?? null, p.createdAt],
  );
}

export function listProjects(db: DB): Project[] {
  return db
    .all<Record<string, unknown>>(`SELECT * FROM projects ORDER BY display_name`)
    .map(rowToProject);
}

export function getProject(db: DB, id: string): Project | undefined {
  const r = db.get<Record<string, unknown>>(`SELECT * FROM projects WHERE id=?`, [id]);
  return r ? rowToProject(r) : undefined;
}

export function updateProject(
  db: DB,
  id: string,
  patch: { displayName?: string; type?: string },
): Project | undefined {
  const cur = getProject(db, id);
  if (!cur) return undefined;
  db.run(`UPDATE projects SET display_name=?, type=? WHERE id=?`, [
    patch.displayName ?? cur.displayName,
    patch.type ?? cur.type,
    id,
  ]);
  return getProject(db, id);
}

function rowToProject(r: Record<string, unknown>): Project {
  return {
    id: String(r.id),
    name: String(r.name),
    displayName: String(r.display_name),
    type: String(r.type) as Project["type"],
    rootPath: r.root_path ? String(r.root_path) : undefined,
    gitRemote: r.git_remote ? String(r.git_remote) : undefined,
    detectedFrom: r.detected_from ? String(r.detected_from) : undefined,
    createdAt: String(r.created_at),
  };
}

// --- activities & evidence -------------------------------------------------

export function insertActivity(
  db: DB,
  a: Activity,
  evidence: Evidence[],
  importId?: string,
): void {
  db.tx(() => {
    db.run(
      `INSERT INTO activities(id,source,import_id,project_id,started_at,ended_at,started_epoch,ended_epoch,
        category,title,summary,status,confidence,review_state,merged_into,metadata,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        a.id, a.source, importId ?? null, a.projectId ?? null, a.startedAt, a.endedAt ?? null,
        toEpoch(a.startedAt), toEpoch(a.endedAt ?? a.startedAt),
        a.category, a.title, a.summary, a.status, a.confidence, a.reviewState,
        a.mergedInto ?? null, JSON.stringify(a.metadata ?? {}), nowIso(), nowIso(),
      ],
    );
    for (const e of evidence) insertEvidence(db, e);
  });
}

export function insertEvidence(db: DB, e: Evidence): void {
  db.run(
    `INSERT INTO evidence(id,activity_id,kind,ref_type,ref_id,label,detail,ts,ts_epoch)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [e.id, e.activityId, e.kind, e.refType ?? null, e.refId ?? null, e.label, e.detail ?? null, e.ts ?? null, e.tsEpoch ?? null],
  );
}

export interface ActivityFilter {
  projectId?: string;
  category?: string;
  status?: string;
  source?: string;
  reviewState?: string;
  from?: string;
  to?: string;
  search?: string;
  includeMerged?: boolean;
  limit?: number;
}

export function listActivities(db: DB, f: ActivityFilter = {}): Activity[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.projectId) { where.push("project_id = ?"); params.push(f.projectId); }
  if (f.category) { where.push("category = ?"); params.push(f.category); }
  if (f.status) { where.push("status = ?"); params.push(f.status); }
  if (f.source) { where.push("source = ?"); params.push(f.source); }
  if (f.reviewState) { where.push("review_state = ?"); params.push(f.reviewState); }
  if (!f.includeMerged) where.push("review_state != 'merged'");
  if (f.from) { where.push("started_epoch >= ?"); params.push(toEpoch(f.from)); }
  if (f.to) { where.push("started_epoch <= ?"); params.push(toEpoch(f.to)); }
  if (f.search) {
    where.push("(title LIKE ? OR summary LIKE ?)");
    params.push(`%${f.search}%`, `%${f.search}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = f.limit ? `LIMIT ${Math.max(1, Math.min(1000, f.limit))}` : "";
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM activities ${clause} ORDER BY started_epoch DESC ${limit}`,
    params,
  );
  return rows.map(rowToActivity);
}

export function getActivity(db: DB, id: string): Activity | undefined {
  const r = db.get<Record<string, unknown>>(`SELECT * FROM activities WHERE id=?`, [id]);
  if (!r) return undefined;
  const a = rowToActivity(r);
  a.evidence = listEvidence(db, id);
  return a;
}

export function listEvidence(db: DB, activityId: string): Evidence[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT * FROM evidence WHERE activity_id=? ORDER BY ts_epoch`,
      [activityId],
    )
    .map((r) => ({
      id: String(r.id),
      activityId: String(r.activity_id),
      kind: String(r.kind) as Evidence["kind"],
      refType: r.ref_type ? String(r.ref_type) : undefined,
      refId: r.ref_id ? String(r.ref_id) : undefined,
      label: String(r.label),
      detail: r.detail ? String(r.detail) : undefined,
      ts: r.ts ? String(r.ts) : undefined,
      tsEpoch: r.ts_epoch ? Number(r.ts_epoch) : undefined,
    }));
}

export interface DetailedEvidence extends Evidence {
  sourceFilename?: string;
  sessionId?: string;
  eventType?: string;
  /** Short, redaction-safe excerpt (never the full raw JSON by default). */
  excerpt?: string;
}

/**
 * Evidence enriched for display: joins the originating raw_event (via
 * `<sessionId>:<seq>` ref) to attach the source filename, session id, event
 * type, and a short REDACTED excerpt. Never returns the full raw JSON blob.
 */
export function listEvidenceDetailed(db: DB, activityId: string): DetailedEvidence[] {
  const base = listEvidence(db, activityId);
  return base.map((e) => {
    const out: DetailedEvidence = { ...e };
    if (e.refType === "raw_event" && e.refId && e.refId.includes(":")) {
      const idx = e.refId.lastIndexOf(":");
      const sid = e.refId.slice(0, idx);
      const seq = Number(e.refId.slice(idx + 1));
      const rev = db.get<Record<string, unknown>>(
        `SELECT re.raw, re.root_type, re.payload_type, re.session_id, s.source_member,
                i.original_filename
         FROM raw_events re
         LEFT JOIN sessions s ON s.id = re.session_id
         LEFT JOIN imports i ON i.id = re.import_id
         WHERE re.session_id=? AND re.seq=? LIMIT 1`,
        [sid, seq],
      );
      if (rev) {
        out.sessionId = rev.session_id ? String(rev.session_id) : undefined;
        out.sourceFilename = rev.original_filename
          ? String(rev.original_filename)
          : rev.source_member ? String(rev.source_member) : undefined;
        out.eventType = [rev.root_type, rev.payload_type].filter(Boolean).join("/") || undefined;
        // Prefer the clean stored detail (e.g. the command) over raw JSON.
        out.excerpt = redactExcerpt(e.detail || String(rev.raw ?? ""));
      }
    } else if (e.refType === "commit" && e.refId) {
      const c = db.get<Record<string, unknown>>(
        `SELECT c.hash, c.message, i.original_filename
         FROM commits c LEFT JOIN imports i ON i.id = c.import_id WHERE c.id=? LIMIT 1`,
        [e.refId],
      );
      if (c) {
        out.sourceFilename = c.original_filename ? String(c.original_filename) : undefined;
        out.eventType = "git/commit";
        out.excerpt = redactExcerpt(String(c.message ?? ""));
      }
    }
    // Fallback excerpt from the stored detail (already short & sanitized).
    if (!out.excerpt && e.detail) out.excerpt = redactExcerpt(e.detail);
    return out;
  });
}

function redactExcerpt(text: string, max = 240): string {
  const r = redact(text);
  const t = r.text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function updateActivity(
  db: DB,
  id: string,
  patch: Partial<Pick<Activity, "title" | "summary" | "category" | "status" | "reviewState" | "projectId" | "confidence" | "mergedInto">>,
): Activity | undefined {
  const cur = getActivity(db, id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  db.run(
    `UPDATE activities SET title=?, summary=?, category=?, status=?, review_state=?,
       project_id=?, confidence=?, merged_into=?, updated_at=? WHERE id=?`,
    [next.title, next.summary, next.category, next.status, next.reviewState,
     next.projectId ?? null, next.confidence, next.mergedInto ?? null, nowIso(), id],
  );
  return getActivity(db, id);
}

export function bumpConfidence(db: DB, id: string, delta: number): void {
  const cur = getActivity(db, id);
  if (!cur) return;
  const c = Math.max(0.05, Math.min(0.99, Number((cur.confidence + delta).toFixed(2))));
  db.run(`UPDATE activities SET confidence=?, updated_at=? WHERE id=?`, [c, nowIso(), id]);
}

function rowToActivity(r: Record<string, unknown>): Activity {
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(String(r.metadata ?? "{}")); } catch { /* ignore */ }
  return {
    id: String(r.id),
    source: String(r.source) as Activity["source"],
    projectId: r.project_id ? String(r.project_id) : undefined,
    startedAt: String(r.started_at),
    endedAt: r.ended_at ? String(r.ended_at) : undefined,
    category: String(r.category) as Activity["category"],
    title: String(r.title),
    summary: String(r.summary ?? ""),
    status: String(r.status) as Activity["status"],
    confidence: Number(r.confidence),
    reviewState: String(r.review_state) as Activity["reviewState"],
    mergedInto: r.merged_into ? String(r.merged_into) : undefined,
    metadata,
  };
}

// --- commits (parsed from imported git-log text / embedded git actions) -----

export function upsertCommit(db: DB, c: Commit, importId?: string): void {
  db.run(
    `INSERT INTO commits(id,import_id,repository_id,project_id,hash,author_name,author_email,committed_at,committed_epoch,message,branch,files_json)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, files_json=excluded.files_json`,
    [c.id, importId ?? null, c.repositoryId, c.projectId ?? null, c.hash, c.authorName ?? null, c.authorEmail ?? null,
     c.committedAt, c.committedEpoch, c.message, c.branch ?? null, JSON.stringify(c.files)],
  );
}

export function listCommits(db: DB, projectId?: string, from?: string, to?: string): Commit[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (projectId) { where.push("project_id=?"); params.push(projectId); }
  if (from) { where.push("committed_epoch>=?"); params.push(toEpoch(from)); }
  if (to) { where.push("committed_epoch<=?"); params.push(toEpoch(to)); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db.all<Record<string, unknown>>(
    `SELECT * FROM commits ${clause} ORDER BY committed_epoch DESC`,
    params,
  ).map((r) => {
    let files: string[] = [];
    try { files = JSON.parse(String(r.files_json ?? "[]")); } catch { /* ignore */ }
    return {
      id: String(r.id), repositoryId: String(r.repository_id),
      projectId: r.project_id ? String(r.project_id) : undefined,
      hash: String(r.hash), authorName: r.author_name ? String(r.author_name) : undefined,
      authorEmail: r.author_email ? String(r.author_email) : undefined,
      committedAt: String(r.committed_at), committedEpoch: Number(r.committed_epoch),
      message: String(r.message ?? ""), branch: r.branch ? String(r.branch) : undefined, files,
    };
  });
}

// --- sessions (one per parsed import member) --------------------------------

export function insertSession(
  db: DB,
  s: {
    id: string; importId: string; sourceMember?: string; cwd?: string; cliVersion?: string;
    model?: string; gitBranch?: string; gitCommit?: string; startedAt?: string; endedAt?: string;
    eventCount: number;
  },
): void {
  db.run(
    `INSERT INTO sessions(id,import_id,source_member,cwd,cli_version,model,git_branch,git_commit,started_at,ended_at,event_count)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       cwd=excluded.cwd, model=excluded.model, ended_at=excluded.ended_at,
       event_count=sessions.event_count + excluded.event_count`,
    [s.id, s.importId, s.sourceMember ?? null, s.cwd ?? null, s.cliVersion ?? null, s.model ?? null,
     s.gitBranch ?? null, s.gitCommit ?? null, s.startedAt ?? null, s.endedAt ?? null, s.eventCount],
  );
}

export function insertRawEvents(
  db: DB,
  sessionId: string,
  importId: string,
  events: { seq: number; ts?: string; rootType: string; payloadType?: string; role?: string; toolName?: string; raw: string }[],
): void {
  db.tx(() => {
    for (const e of events) {
      db.run(
        `INSERT INTO raw_events(id,session_id,import_id,seq,ts,ts_epoch,root_type,payload_type,role,tool_name,raw)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [newId("rev"), sessionId, importId, e.seq, e.ts ?? null, toEpoch(e.ts), e.rootType,
         e.payloadType ?? null, e.role ?? null, e.toolName ?? null, e.raw],
      );
    }
  });
}

// --- imports ----------------------------------------------------------------

import type { ImportedSource } from "@devrecap/shared";

export function findImportByHash(db: DB, hash: string): ImportedSource | undefined {
  const r = db.get<Record<string, unknown>>(`SELECT * FROM imports WHERE hash=? ORDER BY imported_at DESC LIMIT 1`, [hash]);
  return r ? rowToImport(r) : undefined;
}

export function insertImport(db: DB, imp: ImportedSource, storedPath?: string): void {
  db.run(
    `INSERT INTO imports(id,batch_id,original_filename,file_type,stored_path,size,hash,status,detected_format,
       event_count,activity_count,error_count,warning_count,error,imported_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [imp.id, imp.batchId ?? null, imp.originalFilename, imp.fileType, storedPath ?? null, imp.size, imp.hash,
     imp.status, imp.detectedFormat ?? null, imp.eventCount ?? 0, imp.activityCount ?? 0,
     imp.errorCount ?? 0, imp.warningCount ?? 0, imp.error ?? null, imp.importedAt],
  );
}

export function updateImport(db: DB, id: string, patch: Partial<ImportedSource>): void {
  const cur = getImport(db, id);
  if (!cur) return;
  const n = { ...cur, ...patch };
  db.run(
    `UPDATE imports SET status=?, file_type=?, size=?, detected_format=?, event_count=?,
       activity_count=?, error_count=?, warning_count=?, error=?, diagnostics=? WHERE id=?`,
    [n.status, n.fileType, n.size, n.detectedFormat ?? null, n.eventCount ?? 0,
     n.activityCount ?? 0, n.errorCount ?? 0, n.warningCount ?? 0, n.error ?? null,
     n.diagnostics !== undefined ? JSON.stringify(n.diagnostics) : (cur.diagnostics !== undefined ? JSON.stringify(cur.diagnostics) : null),
     id],
  );
}

/** Full diagnostics JSON for an import (parsed), or undefined. */
export function getImportDiagnostics(db: DB, id: string): unknown {
  const r = db.get<{ diagnostics: string | null }>(`SELECT diagnostics FROM imports WHERE id=?`, [id]);
  if (!r || !r.diagnostics) return undefined;
  try { return JSON.parse(r.diagnostics); } catch { return undefined; }
}

/** The on-disk directory that holds an import's stored files (or undefined). */
export function getImportStoredPath(db: DB, id: string): string | undefined {
  const r = db.get<{ stored_path: string }>(`SELECT stored_path FROM imports WHERE id=?`, [id]);
  return r?.stored_path ?? undefined;
}

export function getImport(db: DB, id: string): ImportedSource | undefined {
  const r = db.get<Record<string, unknown>>(`SELECT * FROM imports WHERE id=?`, [id]);
  return r ? rowToImport(r) : undefined;
}

export function listImports(db: DB): ImportedSource[] {
  return db.all<Record<string, unknown>>(`SELECT * FROM imports ORDER BY imported_at DESC`).map(rowToImport);
}

export interface DeleteImportResult {
  found: boolean;
  /** True if the physical storage directory is gone after this call. */
  filesRemoved: boolean;
  /** Set when physical deletion failed for a real filesystem reason. */
  fileError?: string;
}

/**
 * Delete an import: DB records (cascade) AND the physical stored copy.
 * Idempotent: if the directory is already gone, DB cleanup still runs and
 * filesRemoved is true. If physical deletion fails for a real fs error, the DB
 * rows are still removed but the error is reported (not silently swallowed).
 */
export function deleteImport(db: DB, id: string, dataDir: string): DeleteImportResult {
  const cur = getImport(db, id);
  if (!cur) return { found: false, filesRemoved: false };

  // Remove the physical import directory: <dataDir>/imports/<id>/
  const importDir = join(dataDir, "imports", id);
  let filesRemoved = true;
  let fileError: string | undefined;
  try {
    if (existsSync(importDir)) {
      rmSync(importDir, { recursive: true, force: true });
    }
    filesRemoved = !existsSync(importDir);
    if (!filesRemoved) fileError = `directory still present after removal: ${importDir}`;
  } catch (e) {
    filesRemoved = false;
    fileError = String(e);
    logger.error("deleteImport: physical removal failed", { id, importDir, error: fileError });
  }

  // Cascades to sessions, raw_events, commits, activities (and evidence via activities).
  db.run(`DELETE FROM imports WHERE id=?`, [id]);
  return { found: true, filesRemoved, fileError };
}

function rowToImport(r: Record<string, unknown>): ImportedSource {
  return {
    id: String(r.id),
    batchId: r.batch_id ? String(r.batch_id) : undefined,
    originalFilename: String(r.original_filename),
    fileType: String(r.file_type ?? ""),
    importedAt: String(r.imported_at),
    size: Number(r.size ?? 0),
    hash: String(r.hash),
    status: String(r.status) as ImportedSource["status"],
    detectedFormat: r.detected_format ? String(r.detected_format) : undefined,
    eventCount: Number(r.event_count ?? 0),
    activityCount: Number(r.activity_count ?? 0),
    errorCount: Number(r.error_count ?? 0),
    warningCount: Number(r.warning_count ?? 0),
    error: r.error ? String(r.error) : undefined,
  };
}
