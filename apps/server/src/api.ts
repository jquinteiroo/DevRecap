/**
 * REST API routes. Registers all /api endpoints on a Router.
 */

import type { DB } from "@devrecap/shared";
import {
  getSettings, saveSettings, redactSettings, nowIso, newId, toEpoch, dayKey, ValidationError,
  ConsentRequiredError, nonEmpty, optStr, enumOf, strArray, bool, num, isoDate,
} from "@devrecap/shared";
import { Router } from "./http.ts";
import { streamUploadToStorage, analyzeImport, reanalyzeImport, checkDuplicateByHash } from "./import.ts";
import {
  listProjects, updateProject, listActivities, getActivity, updateActivity,
  insertActivity, listCommits, insertEvidence, listEvidenceDetailed,
  listImports, getImport, deleteImport, getImportDiagnostics,
} from "./store.ts";
import { seedDemoData } from "./seed.ts";
import {
  buildReportInput, buildReportContext, reportContextDigest,
  selectComposer, composeReport, DeterministicComposer,
} from "@devrecap/report-engine";
import type {
  Activity, ReportKind, ReportStyle, ReportLength, ReportLanguage,
} from "@devrecap/shared";

const CATEGORIES = ["feature","bugfix","investigation","refactor","testing","documentation","git","deployment","configuration","database","other"] as const;
const STATUSES = ["completed","in_progress","blocked","unknown"] as const;
const REVIEW = ["pending","approved","ignored","edited","merged"] as const;
const STYLES = ["spoken","professional","executive","technical"] as const;
const LENGTHS = ["short","normal","detailed"] as const;
const KINDS = ["daily","weekly","custom","monthly","help_me_remember","review","executive"] as const;
const LANGUAGES = ["auto","en","pt"] as const;

export function registerApi(router: Router, db: DB, dataDir: string): void {
  router.get("/api/health", () => ({ ok: true, time: nowIso() }));

  // --- settings ---
  // The stored OpenAI API key is NEVER returned to the browser: the endpoint
  // exposes only whether a key is set + a masked hint (see redactSettings).
  router.get("/api/settings", () => redactSettings(getSettings(db)));
  router.post("/api/settings", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    // NOTE: no codexDir/repoDirs/autoScan — DevRecap never connects to tools.
    if ("timezone" in b) patch.timezone = nonEmpty(b.timezone, "timezone");
    if ("aiProvider" in b) patch.aiProvider = enumOf(b.aiProvider, ["deterministic","openai","ollama"], "aiProvider");
    if ("aiModel" in b) patch.aiModel = optStr(b.aiModel, "aiModel") ?? "";
    // API key: an omitted/empty value PRESERVES the existing key; only a real
    // value replaces it; clearOpenaiApiKey:true removes it (handled below).
    if ("openaiApiKey" in b) {
      const k = optStr(b.openaiApiKey, "openaiApiKey");
      if (k) patch.openaiApiKey = k;
    }
    if ("ollamaEndpoint" in b) patch.ollamaEndpoint = nonEmpty(b.ollamaEndpoint, "ollamaEndpoint");
    if ("redactionEnabled" in b) patch.redactionEnabled = bool(b.redactionEnabled, "redactionEnabled");
    if ("showPayloadPreview" in b) patch.showPayloadPreview = bool(b.showPayloadPreview, "showPayloadPreview");
    if ("excludedProjectIds" in b) patch.excludedProjectIds = strArray(b.excludedProjectIds, "excludedProjectIds");
    if ("defaultStyle" in b) patch.defaultStyle = enumOf(b.defaultStyle, STYLES, "defaultStyle");
    if ("defaultLength" in b) patch.defaultLength = enumOf(b.defaultLength, LENGTHS, "defaultLength");
    if ("defaultLanguage" in b) patch.defaultLanguage = enumOf(b.defaultLanguage, LANGUAGES, "defaultLanguage");
    if ("dailyDurationSeconds" in b) patch.dailyDurationSeconds = num(b.dailyDurationSeconds, "dailyDurationSeconds");
    if ("reviewThreshold" in b) patch.reviewThreshold = num(b.reviewThreshold, "reviewThreshold");
    const saved = saveSettings(db, patch as never, { clearOpenaiApiKey: b.clearOpenaiApiKey === true });
    // Never return the raw key to the browser.
    return redactSettings(saved);
  });

  // --- imports (the ONLY data entry point) ---

  // Phase 1: STREAMING binary upload. Raw request body -> temp file -> hash ->
  // atomic move. Filename via ?filename= (or X-Filename header). NOT analyzed.
  router.postRaw("/api/imports/upload", async ({ req, query }) => {
    const rawName = query.get("filename")
      || (Array.isArray(req.headers["x-filename"]) ? req.headers["x-filename"][0] : req.headers["x-filename"])
      || "upload.bin";
    const allowDuplicates = query.get("allowDuplicates") === "true";
    const res = await streamUploadToStorage(db, dataDir, req, String(rawName), { allowDuplicates });
    if (res.duplicateOf) {
      return { ok: true, duplicate: true, existing: res.duplicateOf };
    }
    return { ok: true, duplicate: false, import: res.import };
  });

  // Duplicate check by a client-computed hash (optional pre-upload probe).
  router.get("/api/imports/check", ({ query }) => {
    const hash = nonEmpty(query.get("hash"), "hash");
    return checkDuplicateByHash(db, hash);
  });

  // Phase 2: EXPLICIT analyze of an uploaded import.
  router.post("/api/imports/:id/analyze", async ({ params }) => {
    const imp = getImport(db, params.id);
    if (!imp) throw new ValidationError("import not found");
    const result = await analyzeImport(db, dataDir, params.id);
    return { ok: true, import: result.import, warnings: result.warnings };
  });

  // Re-analyze an already-uploaded import with the CURRENT extraction logic.
  // Keeps the original stored file; regenerates only derived data. Never
  // touches the original source location.
  router.post("/api/imports/:id/reanalyze", async ({ params }) => {
    const imp = getImport(db, params.id);
    if (!imp) throw new ValidationError("import not found");
    const result = await reanalyzeImport(db, dataDir, params.id);
    return { ok: true, import: result.import, warnings: result.warnings };
  });

  // Safe, counts-only extraction diagnostics (no raw content / no payloads).
  router.get("/api/imports/:id/diagnostics", ({ params }) => {
    const imp = getImport(db, params.id);
    if (!imp) throw new ValidationError("import not found");
    return { importId: params.id, diagnostics: getImportDiagnostics(db, params.id) ?? null };
  });

  router.get("/api/imports", () => listImports(db));
  router.get("/api/imports/:id", ({ params }) => {
    const imp = getImport(db, params.id);
    if (!imp) throw new ValidationError("import not found");
    const sessions = db.all(`SELECT id, source_member, cwd, event_count, started_at FROM sessions WHERE import_id=?`, [params.id]);
    return { ...imp, sessions };
  });
  router.delete("/api/imports/:id", ({ params }) => {
    const r = deleteImport(db, params.id, dataDir);
    if (!r.found) throw new ValidationError("import not found");
    if (r.fileError) {
      // DB rows are gone, but physical removal had a real fs error — report it.
      return { ok: false, deleted: params.id, filesRemoved: r.filesRemoved, fileError: r.fileError };
    }
    return { ok: true, deleted: params.id, filesRemoved: r.filesRemoved };
  });

  router.post("/api/seed", () => {
    const r = seedDemoData(db);
    return { ok: true, ...r };
  });

  // --- projects ---
  router.get("/api/projects", () => {
    const projects = listProjects(db);
    const counts = db.all<{ project_id: string; n: number }>(
      `SELECT project_id, COUNT(*) n FROM activities WHERE review_state != 'merged' GROUP BY project_id`,
    );
    const countMap = new Map(counts.map((c) => [c.project_id, c.n]));
    return projects.map((p) => ({ ...p, activityCount: countMap.get(p.id) ?? 0 }));
  });
  router.patch("/api/projects/:id", ({ params, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const patch: { displayName?: string; type?: string } = {};
    if ("displayName" in b) patch.displayName = nonEmpty(b.displayName, "displayName");
    if ("type" in b) patch.type = enumOf(b.type, ["work","personal","university","other"], "type");
    const updated = updateProject(db, params.id, patch);
    if (!updated) throw new ValidationError("project not found");
    return updated;
  });

  // --- activities ---
  router.get("/api/activities", ({ query }) => {
    return listActivities(db, {
      projectId: query.get("projectId") ?? undefined,
      category: query.get("category") ?? undefined,
      status: query.get("status") ?? undefined,
      source: query.get("source") ?? undefined,
      reviewState: query.get("reviewState") ?? undefined,
      from: query.get("from") ?? undefined,
      to: query.get("to") ?? undefined,
      search: query.get("search") ?? undefined,
      limit: query.get("limit") ? Number(query.get("limit")) : 500,
    });
  });
  router.get("/api/activities/:id", ({ params }) => {
    const a = getActivity(db, params.id);
    if (!a) throw new ValidationError("activity not found");
    return a;
  });
  router.get("/api/activities/:id/evidence", ({ params }) => {
    const a = getActivity(db, params.id);
    if (!a) throw new ValidationError("activity not found");
    return listEvidenceDetailed(db, params.id);
  });
  router.patch("/api/activities/:id", ({ params, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const patch: Partial<Activity> = {};
    if ("title" in b) patch.title = nonEmpty(b.title, "title");
    if ("summary" in b) patch.summary = optStr(b.summary, "summary") ?? "";
    if ("category" in b) patch.category = enumOf(b.category, CATEGORIES, "category");
    if ("status" in b) patch.status = enumOf(b.status, STATUSES, "status");
    if ("reviewState" in b) patch.reviewState = enumOf(b.reviewState, REVIEW, "reviewState");
    if ("projectId" in b) patch.projectId = optStr(b.projectId, "projectId");
    const updated = updateActivity(db, params.id, patch);
    if (!updated) throw new ValidationError("activity not found");
    return updated;
  });
  // manual activity
  router.post("/api/activities", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const title = nonEmpty(b.title, "title");
    const startedAt = b.startedAt ? isoDate(b.startedAt, "startedAt") : nowIso();
    const activity: Activity = {
      id: newId("act"), source: "manual",
      projectId: optStr(b.projectId, "projectId"),
      startedAt, endedAt: startedAt,
      category: enumOf(b.category, CATEGORIES, "category", "other"),
      title, summary: optStr(b.summary, "summary") ?? "",
      status: enumOf(b.status, STATUSES, "status", "completed"),
      confidence: 1, reviewState: "approved",
      metadata: { manual: true },
    };
    insertActivity(db, activity, [{
      id: newId("evd"), activityId: activity.id, kind: "manual_note",
      label: "Manual entry", detail: activity.summary || title, ts: startedAt, tsEpoch: toEpoch(startedAt),
    }]);
    return activity;
  });
  // merge
  router.post("/api/activities/merge", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const ids = strArray(b.ids, "ids");
    if (ids.length < 2) throw new ValidationError("merge requires >= 2 ids");
    const primaryId = ids[0];
    const primary = getActivity(db, primaryId);
    if (!primary) throw new ValidationError("primary activity not found");
    for (const id of ids.slice(1)) {
      const a = getActivity(db, id);
      if (!a) continue;
      // move evidence to primary
      for (const e of a.evidence ?? []) {
        insertEvidence(db, { ...e, id: newId("evd"), activityId: primaryId });
      }
      updateActivity(db, id, { reviewState: "merged", mergedInto: primaryId });
    }
    updateActivity(db, primaryId, {
      confidence: Math.min(0.99, primary.confidence + 0.1),
      reviewState: "approved",
    });
    return getActivity(db, primaryId);
  });

  // --- timeline ---
  router.get("/api/timeline", ({ query }) => {
    const tz = getSettings(db).timezone;
    const acts = listActivities(db, {
      from: query.get("from") ?? undefined,
      to: query.get("to") ?? undefined,
      projectId: query.get("projectId") ?? undefined,
      category: query.get("category") ?? undefined,
      status: query.get("status") ?? undefined,
      source: query.get("source") ?? undefined,
      limit: 1000,
    });
    const projects = new Map(listProjects(db).map((p) => [p.id, p]));
    const byDay = new Map<string, unknown[]>();
    for (const a of acts) {
      const k = dayKey(a.startedAt, tz);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k)!.push({
        ...a,
        projectName: a.projectId ? projects.get(a.projectId)?.displayName : undefined,
      });
    }
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, items]) => ({ day, items }));
  });

  // --- dashboard ---
  router.get("/api/dashboard", () => {
    const tz = getSettings(db).timezone;
    const today = dayKey(nowIso(), tz);
    const all = listActivities(db, { limit: 1000 });
    const todays = all.filter((a) => dayKey(a.startedAt, tz) === today);
    const recent = all.slice(0, 12);
    const projects = new Map(listProjects(db).map((p) => [p.id, p]));
    const decorate = (a: Activity) => ({
      id: a.id, title: a.title, startedAt: a.startedAt, category: a.category,
      status: a.status, confidence: a.confidence, source: a.source,
      projectName: a.projectId ? projects.get(a.projectId)?.displayName : undefined,
    });
    const activeProjects = new Set(todays.map((a) => a.projectId).filter(Boolean));
    const imports = db.all(
      `SELECT id, original_filename, status, detected_format, event_count, activity_count, imported_at
       FROM imports ORDER BY imported_at DESC LIMIT 5`,
    );
    return {
      today,
      counts: {
        detected: todays.length,
        projects: activeProjects.size,
        completed: todays.filter((a) => a.status === "completed").length,
        inProgress: todays.filter((a) => a.status === "in_progress").length,
        investigation: todays.filter((a) => a.category === "investigation").length,
        pendingReview: all.filter((a) => a.reviewState === "pending" && a.confidence < getSettings(db).reviewThreshold).length,
      },
      todays: todays.map(decorate),
      recent: recent.map(decorate),
      recentImports: imports,
    };
  });

  // --- search ---
  router.get("/api/search", ({ query }) => {
    const q = query.get("q") ?? "";
    const acts = listActivities(db, {
      search: q || undefined,
      projectId: query.get("projectId") ?? undefined,
      category: query.get("category") ?? undefined,
      status: query.get("status") ?? undefined,
      from: query.get("from") ?? undefined,
      to: query.get("to") ?? undefined,
      limit: 200,
    });
    const projects = new Map(listProjects(db).map((p) => [p.id, p]));
    return acts.map((a) => ({
      ...a, projectName: a.projectId ? projects.get(a.projectId)?.displayName : undefined,
    }));
  });

  // --- commits (parsed from imported git-log text) ---
  router.get("/api/commits", ({ query }) =>
    listCommits(db, query.get("projectId") ?? undefined, query.get("from") ?? undefined, query.get("to") ?? undefined));

  // --- reports ---
  const buildInput = (b: Record<string, unknown>) => {
    const settings = getSettings(db);
    const kind = enumOf(b.kind, KINDS, "kind", "daily") as ReportKind;
    const style = enumOf(b.style, STYLES, "style", settings.defaultStyle) as ReportStyle;
    const length = enumOf(b.length, LENGTHS, "length", settings.defaultLength) as ReportLength;
    const language = enumOf(b.language, LANGUAGES, "language", settings.defaultLanguage) as ReportLanguage;
    const durationSeconds = b.durationSeconds ? num(b.durationSeconds, "durationSeconds") : settings.dailyDurationSeconds;
    const range = resolveRange(kind, b, settings.timezone);
    const workOnly = b.workOnly === undefined ? true : bool(b.workOnly, "workOnly");
    const projectIds = strArray(b.projectIds, "projectIds", []);

    const acts = listActivities(db, {
      from: range.start, to: range.end,
      reviewState: b.approvedOnly ? "approved" : undefined,
      limit: 1000,
    }).filter((a) => a.reviewState !== "ignored")
      .filter((a) => projectIds.length === 0 || (a.projectId && projectIds.includes(a.projectId)));
    // attach evidence counts
    for (const a of acts) a.evidence = getActivity(db, a.id)?.evidence ?? [];

    const projects = listProjects(db);
    return buildReportInput(acts, projects, {
      kind, style, length, language, durationSeconds, range,
      excludeTypes: workOnly ? ["personal", "university"] : [],
      redactionEnabled: settings.redactionEnabled,
    });
  };

  // Payload preview: shows EXACTLY the sanitized ReportContext a semantic
  // composer (incl. an external LLM) would receive — never the raw ReportInput
  // and never raw session data. This is the privacy inspection surface.
  router.post("/api/reports/preview", ({ body }) => {
    const { input, redactionCount } = buildInput((body ?? {}) as Record<string, unknown>);
    const settings = getSettings(db);
    const composer = selectComposer(settings, input);
    const context = buildReportContext(input);
    // The consent digest fingerprints EXACTLY this sanitized context. If the
    // composer is external, the client must echo this digest back (with an
    // explicit confirmation) to POST /api/reports before anything is sent.
    const contextDigest = reportContextDigest(context);
    return {
      context, redactionCount, composer: composer.name, external: composer.external,
      requiresConsent: composer.external, contextDigest,
    };
  });

  router.post("/api/reports", async ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const { input, redactionCount } = buildInput(b);
    const settings = getSettings(db);
    const context = buildReportContext(input);

    // Choose the composer, then GATE any external one behind explicit consent.
    // This is enforced on the SERVER (not merely in the UI): an external
    // provider is only ever contacted when the request carries a consent object
    // that (a) explicitly confirms and (b) matches the exact ReportContext
    // digest the user previewed. Otherwise we NEVER call out — we either refuse
    // (default) or, if the client opted in, fall back to the local composer.
    const selected = selectComposer(settings, input);
    let composer = selected;
    if (selected.external) {
      const digest = reportContextDigest(context);
      const consent = (b.consent ?? {}) as Record<string, unknown>;
      const confirmed = consent.confirmed === true;
      const digestMatches = typeof consent.contextDigest === "string"
        && consent.contextDigest === digest;
      if (!confirmed || !digestMatches) {
        // The client may pre-authorize a silent local fallback instead of an
        // error (useful for automation that never wants an external call).
        if (b.fallbackToLocalWithoutConsent === true) {
          composer = new DeterministicComposer(input);
        } else {
          // No external request happens. Tell the client exactly what to
          // confirm (provider + the digest of the payload that would be sent).
          throw new ConsentRequiredError(
            `Report uses the external "${selected.name}" composer. Explicit consent is required before any data leaves this machine.`,
            { provider: selected.name, external: true, contextDigest: digest },
          );
        }
      }
    }

    // Semantic composition: deterministic by default; an optional LLM receives
    // ONLY the structured ReportContext (never raw sessions/commands/code).
    // composeReport validates the result and falls back to the deterministic
    // composer if validation fails or the LLM errors.
    const composed = await composeReport(composer, input, context);
    const id = newId("rep");
    db.run(
      `INSERT INTO reports(id,kind,style,length,language,provider,range_start,range_end,filters_json,content,input_json,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.kind, input.style, input.length, input.resolvedLanguage, composed.composer, input.range.start, input.range.end,
       JSON.stringify(b), composed.content, JSON.stringify(input), nowIso()],
    );
    return {
      id, content: composed.content, provider: composed.composer,
      fellBack: composed.fellBack, sections: composed.sections,
      redactionCount, input,
    };
  });

  // Report history (most recent first). Metadata only — content on demand.
  router.get("/api/reports", () => {
    const rows = db.all<Record<string, unknown>>(
      `SELECT id, kind, style, length, language, provider, range_start, range_end, created_at,
              filters_json
       FROM reports ORDER BY created_at DESC LIMIT 100`,
    );
    return rows.map((r) => {
      let projectIds: string[] = [];
      try { const f = JSON.parse(String(r.filters_json ?? "{}")); if (Array.isArray(f.projectIds)) projectIds = f.projectIds; } catch { /* ignore */ }
      return {
        id: r.id, kind: r.kind, style: r.style, length: r.length,
        language: r.language ?? null, provider: r.provider,
        rangeStart: r.range_start, rangeEnd: r.range_end,
        createdAt: r.created_at, projectIds,
      };
    });
  });

  router.get("/api/reports/:id", ({ params }) => {
    const r = db.get<Record<string, unknown>>(`SELECT * FROM reports WHERE id=?`, [params.id]);
    if (!r) throw new ValidationError("report not found");
    return {
      id: r.id, kind: r.kind, style: r.style, length: r.length,
      language: r.language ?? null, provider: r.provider,
      content: r.content, createdAt: r.created_at,
      rangeStart: r.range_start, rangeEnd: r.range_end,
      input: JSON.parse(String(r.input_json ?? "{}")),
    };
  });
}

function resolveRange(
  kind: ReportKind,
  b: Record<string, unknown>,
  tz: string,
): { start: string; end: string } {
  if (b.start && b.end) {
    return { start: isoDate(b.start, "start"), end: isoDate(b.end, "end") };
  }
  const now = new Date();
  // End of the current local day, so activities recorded later today are included.
  const end = endOfDay(now, tz);
  if (kind === "daily") {
    const start = localMidnight(now, tz);
    return { start, end };
  }
  if (kind === "weekly" || kind === "review") return { start: new Date(Date.now() - 7 * 864e5).toISOString(), end };
  if (kind === "monthly" || kind === "executive") return { start: new Date(Date.now() - 30 * 864e5).toISOString(), end };
  // help_me_remember and custom default to the last 7 days when no explicit
  // range is provided (the UI normally supplies start/end).
  return { start: new Date(Date.now() - 7 * 864e5).toISOString(), end };
}

function endOfDay(d: Date, tz: string): string {
  try {
    const k = dayKey(d.toISOString(), tz);
    return new Date(`${k}T23:59:59.999Z`).toISOString();
  } catch {
    return new Date(d.toISOString().slice(0, 10) + "T23:59:59.999Z").toISOString();
  }
}

function localMidnight(d: Date, tz: string): string {
  try {
    const k = dayKey(d.toISOString(), tz); // YYYY-MM-DD
    // Interpret local midnight as UTC start-of-day for simplicity of range math.
    return new Date(`${k}T00:00:00.000Z`).toISOString();
  } catch {
    return new Date(d.toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString();
  }
}
