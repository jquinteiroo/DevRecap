/** Page views. Each returns a DOM node; `ctx.navigate` / `ctx.rerender` drive nav. */
import { h, api, toast } from "./dom.mjs";
import {
  activityCard, categoryBadge, statusBadge, confBadge, fmtDay, fmtTime,
  label, selectFrom, evidenceToggle,
} from "./components.mjs";

function loading() { return h("div", { class: "muted" }, h("span", { class: "spinner" }), " Loading…"); }
function pageHead(title, sub) {
  return h("div", { class: "page-head" },
    h("h1", { class: "page-title" }, title),
    sub ? h("div", { class: "page-sub" }, sub) : null);
}

// --- Dashboard -------------------------------------------------------------
export async function DashboardView(ctx) {
  const root = h("div", {}, pageHead("Dashboard", ""), loading());
  try {
    const d = await api.get("/dashboard");
    const stat = (num, lbl) => h("div", { class: "card stat" },
      h("div", { class: "stat-num" }, num), h("div", { class: "stat-label" }, lbl));
    const recentList = (d.todays.length ? d.todays : d.recent);
    root.replaceChildren(
      pageHead("Today", d.today),
      h("div", { class: "grid grid-stats" },
        stat(d.counts.detected, "activities detected"),
        stat(d.counts.projects, "active projects"),
        stat(d.counts.completed, "completed"),
        stat(d.counts.inProgress, "in progress"),
        stat(d.counts.investigation, "investigations"),
        stat(d.counts.pendingReview, "need review"),
      ),
      h("div", { class: "row-between", style: { marginTop: "24px" } },
        h("div", { class: "section-title", style: { margin: 0 } }, "Recent activity"),
        h("div", { class: "btn-row" },
          h("button", { class: "btn sm primary", onclick: () => ctx.navigate("import") }, "↑ Import Work History"),
          h("button", { class: "btn sm", onclick: () => ctx.navigate("reports") }, "Generate report →"),
          h("button", { class: "btn sm", onclick: () => ctx.navigate("review") },
            d.counts.pendingReview ? `Review inbox (${d.counts.pendingReview})` : "Review inbox"),
        ),
      ),
      recentList.length
        ? h("div", {}, ...recentList.map((a) => h("div", { class: "act-row" },
            h("div", { class: "act-time" }, fmtTime(a.startedAt)),
            h("div", { class: "act-body" },
              h("div", { class: "act-title" }, a.title),
              h("div", { class: "act-meta" },
                a.projectName ? h("span", { class: "badge" }, a.projectName) : null,
                categoryBadge(a.category), statusBadge(a.status), confBadge(a.confidence)),
            ))))
        : emptyState(ctx),
    );
  } catch (e) { root.replaceChildren(pageHead("Dashboard"), errorCard(e)); }
  return root;
}

function emptyState(ctx) {
  return h("div", { class: "empty" },
    h("div", { style: { fontSize: "15px", fontWeight: "600", marginBottom: "6px", color: "var(--text)" } },
      "No work history imported yet."),
    h("div", { style: { marginBottom: "16px" } },
      "Import Codex session files to generate your first activity timeline."),
    h("div", { class: "btn-row", style: { justifyContent: "center" } },
      h("button", { class: "btn primary", onclick: () => ctx.navigate("import") }, "↑  Import Files"),
      h("button", { class: "btn ghost", onclick: async () => { await api.post("/seed"); toast("Demo data loaded"); ctx.rerender(); } }, "Load demo data"),
    ),
    h("div", { class: "faint", style: { marginTop: "16px", fontSize: "12px" } },
      "DevRecap only analyzes files you explicitly import. It never connects to Codex or scans your machine."),
  );
}
function errorCard(e) { return h("div", { class: "card", style: { borderColor: "var(--red)" } }, "Error: " + (e.message || e)); }

// --- Timeline --------------------------------------------------------------
export async function TimelineView(ctx) {
  const root = h("div", {}, pageHead("Timeline", "Reconstructed work, chronologically"), loading());
  const filters = ctx.state.timelineFilters || {};
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  try {
    const [projects, days] = await Promise.all([api.get("/projects"), api.get(`/timeline?${qs}`)]);
    const setF = (k, v) => { ctx.state.timelineFilters = { ...filters, [k]: v }; ctx.rerender(); };
    root.replaceChildren(
      pageHead("Timeline", "Reconstructed work, chronologically"),
      h("div", { class: "toolbar" },
        filterSelect("Project", "projectId", filters, [["", "All projects"], ...projects.map((p) => [p.id, p.displayName])], setF),
        filterSelect("Category", "category", filters, cats(), setF),
        filterSelect("Status", "status", filters, statuses(), setF),
        filterSelect("Source", "source", filters, [["",""],["codex","codex"],["git","git"],["manual","manual"]], setF),
      ),
      days.length
        ? h("div", {}, ...days.map((d) => h("div", { class: "tl-day" },
            h("div", { class: "tl-daylabel" }, fmtDay(d.items[0]?.startedAt || d.day + "T00:00:00Z")),
            ...d.items.map((a) => h("div", { class: "tl-item" },
              h("div", { class: "act-time" }, fmtTime(a.startedAt)),
              h("div", { class: "act-body" },
                h("div", { class: "act-title" }, a.title),
                h("div", { class: "act-meta" },
                  a.projectName ? h("span", { class: "badge" }, a.projectName) : null,
                  categoryBadge(a.category), statusBadge(a.status), confBadge(a.confidence)),
                h("div", { style: { marginTop: "6px" } }, evidenceToggle(a.id)),
              ))),
          )))
        : h("div", { class: "empty" }, "No activities for these filters."),
    );
  } catch (e) { root.replaceChildren(pageHead("Timeline"), errorCard(e)); }
  return root;
}

// --- Review Inbox ----------------------------------------------------------
export async function ReviewView(ctx) {
  const root = h("div", {}, pageHead("Review Inbox", "Approve, edit, merge, or ignore detected activities"), loading());
  try {
    const projects = new Map((await api.get("/projects")).map((p) => [p.id, p.displayName]));
    const acts = await api.get("/activities?reviewState=pending&limit=500");
    const decorated = acts.map((a) => ({ ...a, projectName: a.projectId ? projects.get(a.projectId) : undefined }));
    const selected = new Set();
    const listEl = h("div");
    const rerenderLocal = () => ctx.rerender();
    const onSelect = (id, on) => { on ? selected.add(id) : selected.delete(id); mergeBtn.disabled = selected.size < 2; };
    const mergeBtn = h("button", { class: "btn", disabled: true, onclick: async () => {
      try { await api.post("/activities/merge", { ids: [...selected] }); toast("Merged"); rerenderLocal(); }
      catch (e) { toast("Error: " + e.message); }
    } }, "Merge selected");
    listEl.replaceChildren(
      decorated.length
        ? h("div", {}, ...decorated.map((a) => activityCard(a, { review: true, selectable: true, onSelect, onChange: rerenderLocal })))
        : h("div", { class: "empty" }, "Nothing to review. Detected activities appear here when confidence is low."),
    );
    root.replaceChildren(
      pageHead("Review Inbox", `${decorated.length} pending`),
      h("div", { class: "toolbar" }, mergeBtn, h("span", { class: "faint" }, "Select 2+ to merge related work into one activity.")),
      listEl,
    );
  } catch (e) { root.replaceChildren(pageHead("Review Inbox"), errorCard(e)); }
  return root;
}

// --- Projects --------------------------------------------------------------
export async function ProjectsView(ctx) {
  const root = h("div", {}, pageHead("Projects", "Grouped from Codex working dirs & Git repos"), loading());
  try {
    const projects = await api.get("/projects");
    root.replaceChildren(
      pageHead("Projects", `${projects.length} detected`),
      projects.length
        ? h("div", { class: "grid", style: { gridTemplateColumns: "1fr" } },
            ...projects.map((p) => {
              const nameInput = h("input", { value: p.displayName });
              const typeSel = selectFrom(["work", "personal", "university", "other"], p.type);
              return h("div", { class: "card row-between" },
                h("div", { style: { flex: "2" } },
                  h("div", { class: "row-between" }, nameInput),
                  h("div", { class: "faint", style: { marginTop: "6px", fontFamily: "var(--mono)", fontSize: "11px" } }, p.rootPath || p.name)),
                h("div", { style: { minWidth: "130px" } }, typeSel),
                h("div", { class: "badge" }, `${p.activityCount} activities`),
                h("button", { class: "btn sm primary", onclick: async () => {
                  try { await api.patch(`/projects/${p.id}`, { displayName: nameInput.value, type: typeSel.value }); toast("Saved"); }
                  catch (e) { toast("Error: " + e.message); }
                } }, "Save"),
              );
            }))
        : emptyState(ctx),
    );
  } catch (e) { root.replaceChildren(pageHead("Projects"), errorCard(e)); }
  return root;
}

// --- Search ----------------------------------------------------------------
export async function SearchView(ctx) {
  const q = ctx.state.searchQuery || "";
  const input = h("input", { class: "search-box", placeholder: "Search: dashboard, api, database, deployment…", value: q });
  const results = h("div", {});
  const run = async () => {
    ctx.state.searchQuery = input.value;
    results.replaceChildren(loading());
    try {
      const acts = await api.get(`/search?q=${encodeURIComponent(input.value)}`);
      results.replaceChildren(acts.length
        ? h("div", {}, ...acts.map((a) => activityCard(a, {})))
        : h("div", { class: "empty" }, "No matches."));
    } catch (e) { results.replaceChildren(errorCard(e)); }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  const root = h("div", {},
    pageHead("Search", "Across all detected activities"),
    h("div", { class: "toolbar" }, input, h("button", { class: "btn primary", onclick: run }, "Search")),
    results,
  );
  if (q) run();
  return root;
}

// --- Reports ---------------------------------------------------------------
// Friendly report-type labels (value → label). Help Me Remember first.
const REPORT_TYPES = [
  ["help_me_remember", "Help Me Remember"],
  ["daily", "Daily"],
  ["review", "Weekly Review"],
  ["executive", "Executive Summary"],
  ["custom", "Custom Range"],
];
// Types that use an explicit start/end date range in the UI.
const DATE_RANGE_TYPES = new Set(["help_me_remember", "review", "executive", "custom"]);
const LANGUAGE_LABELS = [["auto", "Auto"], ["pt", "Português"], ["en", "English"]];

function labeledSelect(pairs, value) {
  const sel = h("select", {}, ...pairs.map(([v, t]) =>
    h("option", { value: v, selected: v === value }, t)));
  return sel;
}

export async function ReportsView(ctx) {
  const root = h("div", {}, pageHead("Reports", "Evidence-grounded, generated locally"), loading());
  try {
    const [settings, projects] = await Promise.all([api.get("/settings"), api.get("/projects")]);

    const kind = labeledSelect(REPORT_TYPES, "help_me_remember");
    const length = selectFrom(["short", "normal", "detailed"], "detailed");
    const language = labeledSelect(LANGUAGE_LABELS, settings.defaultLanguage || "auto");
    const style = selectFrom(["spoken", "professional", "executive", "technical"], settings.defaultStyle);
    const duration = selectFrom(["30", "60", "90"], String(settings.dailyDurationSeconds));
    const start = h("input", { type: "date" });
    const end = h("input", { type: "date" });
    const workOnly = h("input", { type: "checkbox", checked: true });
    const approvedOnly = h("input", { type: "checkbox" });

    // Projects multi-select (checkbox list). Empty selection = all projects.
    const projectChecks = projects.map((p) => ({
      p, box: h("input", { type: "checkbox", value: p.id }),
    }));

    const out = h("div");
    const preview = h("div");
    const historyBox = h("div");

    const selectedProjectIds = () => projectChecks.filter((c) => c.box.checked).map((c) => c.p.id);

    const gatherBody = () => ({
      kind: kind.value, style: style.value, length: length.value, language: language.value,
      durationSeconds: Number(duration.value),
      workOnly: workOnly.checked, approvedOnly: approvedOnly.checked,
      projectIds: selectedProjectIds(),
      ...(DATE_RANGE_TYPES.has(kind.value) && start.value && end.value
        ? { start: new Date(start.value).toISOString(), end: new Date(end.value + "T23:59:59Z").toISOString() }
        : {}),
    });

    const doPreview = async () => {
      preview.replaceChildren(loading());
      try {
        const p = await api.post("/reports/preview", gatherBody());
        const pill = p.external
          ? h("span", { class: "pill-info warn" }, `⚠ Composer "${p.composer}" is EXTERNAL — exactly this structured context would be sent off-machine`)
          : h("span", { class: "pill-info safe" }, `✓ Composer "${p.composer}" is fully local — nothing leaves this machine`);
        preview.replaceChildren(
          h("div", { class: "section-title" }, "AI payload preview (structured ReportContext)"),
          h("div", { class: "act-summary faint", style: { marginBottom: "6px" } },
            "This is the ONLY data a semantic composer receives — distilled facts (objectives, statuses, counts, technical terms). No raw sessions, commands, file contents, or code."),
          h("div", { class: "btn-row", style: { marginBottom: "8px" } }, pill,
            h("span", { class: "pill-info" }, `${p.redactionCount} secrets redacted`)),
          h("div", { class: "payload" }, JSON.stringify(p.context, null, 2)),
        );
      } catch (e) { preview.replaceChildren(errorCard(e)); }
    };

    const renderReport = (r) => {
      out.replaceChildren(
        h("div", { class: "row-between" },
          h("div", { class: "section-title", style: { margin: 0 } }, "Report"),
          h("div", { class: "btn-row" },
            h("span", { class: "pill-info" }, `composer: ${r.provider}`),
            r.fellBack ? h("span", { class: "pill-info warn" }, "fell back to deterministic") : null,
            r.input?.resolvedLanguage ? h("span", { class: "pill-info" }, `lang: ${r.input.resolvedLanguage}`) : null,
            h("button", { class: "btn sm primary", onclick: () => { navigator.clipboard?.writeText(r.content); toast("Report copied"); } }, "Copy report"),
          )),
        // Clean reading view of the generated narrative.
        h("div", { class: "report-out" }, r.content),
        // Optional chronological detail (synthesis stays the main view).
        timelinePanel(r.input?.timeline || []),
        // Traceability: workstreams → activities → evidence.
        workstreamsPanel(r.input?.workstreams || []),
      );
      loadHistory();
    };

    // Render the exact sanitized payload + provider, and require an explicit
    // click before anything is sent to an EXTERNAL provider. Resolves with the
    // consent token on confirm, or null on cancel (no request is made).
    const requestConsent = (p) => new Promise((resolve) => {
      const proceed = h("button", { class: "btn primary", onclick: () => { cleanup(); resolve({ confirmed: true, contextDigest: p.contextDigest }); } },
        `Send to ${p.composer} & generate`);
      const cancel = h("button", { class: "btn", onclick: () => { cleanup(); resolve(null); } }, "Cancel — keep local");
      const panel = h("div", { class: "card", style: { marginTop: "12px", borderColor: "var(--red)" } },
        h("div", { class: "section-title", style: { margin: 0 } }, `⚠ Confirm sending to EXTERNAL provider "${p.composer}"`),
        h("div", { class: "act-summary faint", style: { margin: "6px 0" } },
          "This is the EXACT sanitized structured context that would leave your machine. " +
          "No raw sessions, commands, file contents, or code are included. Nothing is sent unless you confirm."),
        h("div", { class: "btn-row", style: { marginBottom: "8px" } },
          h("span", { class: "pill-info warn" }, `provider: ${p.composer} (external)`),
          h("span", { class: "pill-info" }, `${p.redactionCount} secrets redacted`)),
        h("div", { class: "payload" }, JSON.stringify(p.context, null, 2)),
        h("div", { class: "btn-row", style: { marginTop: "10px" } }, proceed, cancel),
      );
      const cleanup = () => { if (panel.parentNode) panel.parentNode.removeChild(panel); };
      out.replaceChildren(panel);
    });

    const doGenerate = async () => {
      out.replaceChildren(loading());
      try {
        const bodyReq = gatherBody();
        // Always resolve the composer + exact payload first.
        const p = await api.post("/reports/preview", bodyReq);
        if (p.external) {
          // EXTERNAL: show the payload + provider and require explicit consent.
          const consent = await requestConsent(p);
          if (!consent) { out.replaceChildren(); toast("Cancelled — nothing was sent"); return; }
          out.replaceChildren(loading());
          renderReport(await api.post("/reports", { ...bodyReq, consent }));
        } else {
          // LOCAL/deterministic: no consent needed, nothing leaves the machine.
          renderReport(await api.post("/reports", bodyReq));
        }
      } catch (e) { out.replaceChildren(errorCard(e)); }
    };

    const loadHistory = async () => {
      try {
        const rows = await api.get("/reports");
        if (!rows.length) { historyBox.replaceChildren(); return; }
        historyBox.replaceChildren(
          h("div", { class: "section-title" }, "Report history"),
          h("div", {}, ...rows.map((r) => h("div", { class: "card row-between", style: { marginBottom: "8px" } },
            h("div", {},
              h("div", { class: "act-title" }, (REPORT_TYPES.find(([v]) => v === r.kind)?.[1]) || r.kind),
              h("div", { class: "act-meta" },
                h("span", { class: "faint" }, `${(r.rangeStart||"").slice(0,10)} → ${(r.rangeEnd||"").slice(0,10)}`),
                r.language ? h("span", { class: "badge" }, r.language) : null,
                h("span", { class: "faint" }, `· ${fmtDay(r.createdAt)}`),
                r.projectIds && r.projectIds.length ? h("span", { class: "faint" }, `· ${r.projectIds.length} project(s)`) : null,
              )),
            h("button", { class: "btn sm", onclick: async () => {
              try { renderReport(await api.get(`/reports/${r.id}`)); window.scrollTo(0, 0); }
              catch (e) { toast("Error: " + e.message); }
            } }, "Reopen"),
          ))),
        );
      } catch { /* history is best-effort */ }
    };

    const dateFields = h("div", { class: "inline-fields", style: { display: DATE_RANGE_TYPES.has(kind.value) ? "flex" : "none" } },
      label("Start date", start), label("End date", end));
    const durationField = label("Daily duration (s)", duration);
    durationField.style.display = kind.value === "daily" ? "" : "none";
    kind.addEventListener("change", () => {
      dateFields.style.display = DATE_RANGE_TYPES.has(kind.value) ? "flex" : "none";
      durationField.style.display = kind.value === "daily" ? "" : "none";
    });

    root.replaceChildren(
      pageHead("Reports", "Help Me Remember · Daily · Weekly Review · Executive · Custom — generated locally"),
      h("div", { class: "card" },
        h("div", { class: "inline-fields" },
          label("Report type", kind), label("Length", length), label("Language", language),
          label("Style", style), durationField),
        dateFields,
        projects.length
          ? h("div", { style: { marginTop: "10px" } },
              h("div", { class: "diag-h" }, "Projects (none selected = all)"),
              h("div", { class: "btn-row" }, ...projectChecks.map((c) =>
                h("label", { class: "checkbox-row" }, c.box, h("span", {}, c.p.displayName)))))
          : null,
        h("div", { class: "btn-row", style: { marginTop: "8px" } },
          h("label", { class: "checkbox-row" }, workOnly, h("span", {}, "Work only (exclude personal & university)")),
          h("label", { class: "checkbox-row" }, approvedOnly, h("span", {}, "Approved activities only")),
        ),
        h("div", { class: "btn-row", style: { marginTop: "14px" } },
          h("button", { class: "btn primary", onclick: doGenerate }, "Generate report"),
          settings.showPayloadPreview ? h("button", { class: "btn", onclick: doPreview }, "Preview AI payload") : null,
        ),
      ),
      out, preview, historyBox,
    );
    loadHistory();
  } catch (e) { root.replaceChildren(pageHead("Reports"), errorCard(e)); }
  return root;
}

/** Traceability panel: workstreams → source activities → evidence (on demand). */
function workstreamsPanel(workstreams) {
  if (!workstreams || !workstreams.length) return null;
  return h("div", { class: "card", style: { marginTop: "12px" } },
    h("div", { class: "section-title" }, "Source workstreams & activities"),
    ...workstreams.map((w) => {
      const body = h("div", { style: { display: "none", marginTop: "6px", paddingLeft: "10px" } });
      let loaded = false;
      const toggle = () => {
        const open = body.style.display !== "none";
        body.style.display = open ? "none" : "block";
        if (!open && !loaded) {
          loaded = true;
          // Safe workstream diagnostics: counts/labels only (no raw content).
          const signals = (w.topicSignals || []).slice(0, 6);
          const diag = signals.length
            ? h("div", { class: "diag-shape", style: { marginBottom: "6px" } },
                "Topic signals: " + signals.map((s) => `${s.term} (${s.count})`).join(", ") +
                ` · status: ${w.status}`)
            : null;
          body.replaceChildren(diag, ...w.activities.map((a) => activityTrace(a)));
        }
      };
      return h("div", { class: "card", style: { marginBottom: "8px", background: "var(--bg-elev-2)" } },
        h("div", { class: "row-between", style: { cursor: "pointer" }, onclick: toggle },
          h("div", { class: "act-title" }, w.title),
          h("div", { class: "act-meta" },
            statusBadge(w.status),
            w.workKind ? h("span", { class: `badge wk-${w.workKind}` }, workKindLabel(w.workKind)) : null,
            h("span", { class: "faint" }, `${w.activities.length} activit${w.activities.length === 1 ? "y" : "ies"}`),
            ...(w.techTerms || []).slice(0, 5).map((t) => h("span", { class: "badge" }, t)),
          )),
        body,
      );
    }),
  );
}

/** Human label for a work-kind classification. */
function workKindLabel(k) {
  return k === "primary" ? "main work"
    : k === "support" ? "support"
    : k === "operational" ? "operational" : k;
}

/**
 * Optional "View timeline" detail — the report body is a synthesis, but the
 * chronological steps remain available here for memory detail (types/labels
 * only; no raw content).
 */
function timelinePanel(timeline) {
  if (!timeline || !timeline.length) return null;
  const body = h("div", { style: { display: "none", marginTop: "8px" } },
    ...timeline.map((t) => h("div", { class: "diag-shape" },
      `${t.time || "--:--"} — ${t.title}` + (t.workKind ? ` [${workKindLabel(t.workKind)}]` : ""))));
  const btn = h("button", { class: "btn sm ghost", onclick: () => {
    const open = body.style.display !== "none";
    body.style.display = open ? "none" : "block";
    btn.textContent = open ? "View timeline" : "Hide timeline";
  } }, "View timeline");
  return h("div", { class: "card", style: { marginTop: "12px", background: "var(--bg-elev-2)" } },
    h("div", { class: "row-between" },
      h("div", { class: "section-title", style: { margin: 0 } }, "Timeline"), btn),
    body,
  );
}

/** One activity row inside a workstream, expandable to its evidence. */
function activityTrace(a) {
  const evBox = h("div", { style: { display: "none", marginTop: "4px", paddingLeft: "10px" } });
  let loaded = false;
  const toggleEv = async () => {
    const open = evBox.style.display !== "none";
    evBox.style.display = open ? "none" : "block";
    if (!open && !loaded) {
      loaded = true;
      evBox.replaceChildren(loading());
      try {
        const ev = await api.get(`/activities/${a.id}/evidence`);
        evBox.replaceChildren(...(ev.length
          ? ev.map((e) => h("div", { class: "diag-shape" },
              `${e.eventType || e.kind}${e.sourceFilename ? " · " + e.sourceFilename : ""}${e.excerpt ? " — " + e.excerpt : ""}`))
          : [h("div", { class: "faint" }, "No evidence rows.")]));
      } catch (e) { evBox.replaceChildren(h("div", { class: "conf low" }, "Error: " + e.message)); }
    }
  };
  return h("div", { style: { marginBottom: "6px" } },
    h("div", { class: "row-between", style: { cursor: "pointer" }, onclick: toggleEv },
      h("div", {},
        h("div", { class: "act-title", style: { fontSize: "13px" } }, a.title),
        a.summary ? h("div", { class: "act-summary faint" }, a.summary) : null),
      h("div", { class: "act-meta" }, statusBadge(a.status),
        h("span", { class: "faint" }, `${a.evidenceCount} evidence`))),
    evBox,
  );
}

// --- Add Activity (manual) -------------------------------------------------
export async function AddActivityView(ctx) {
  const root = h("div", {}, pageHead("Add activity", ""), loading());
  try {
    const projects = await api.get("/projects");
    const project = selectFrom(["", ...projects.map((p) => p.id)], "");
    // relabel options with names
    [...project.options].forEach((o, i) => { if (i === 0) o.textContent = "(no project)"; else o.textContent = projects[i - 1].displayName; });
    const title = h("input", { placeholder: "Validated deployment in staging" });
    const summary = h("textarea", {}, "");
    const category = selectFrom(["feature","bugfix","investigation","refactor","testing","documentation","git","deployment","configuration","database","other"], "other");
    const status = selectFrom(["completed", "in_progress", "blocked", "unknown"], "completed");
    root.replaceChildren(
      pageHead("Add activity", "Manual entries appear alongside detected ones"),
      h("div", { class: "card" },
        label("Project", project),
        label("Title", title),
        label("Description", summary),
        h("div", { class: "inline-fields" }, label("Category", category), label("Status", status)),
        h("button", { class: "btn primary", onclick: async () => {
          if (!title.value.trim()) { toast("Title required"); return; }
          try {
            await api.post("/activities", {
              projectId: project.value || undefined, title: title.value,
              summary: summary.value, category: category.value, status: status.value,
            });
            toast("Activity added"); ctx.navigate("timeline");
          } catch (e) { toast("Error: " + e.message); }
        } }, "Add activity"),
      ),
    );
  } catch (e) { root.replaceChildren(pageHead("Add activity"), errorCard(e)); }
  return root;
}

// --- Settings --------------------------------------------------------------
export async function SettingsView(ctx) {
  const root = h("div", {}, pageHead("Settings", ""), loading());
  try {
    const s = await api.get("/settings");
    const timezone = h("input", { value: s.timezone });
    const aiProvider = selectFrom(["deterministic", "openai", "ollama"], s.aiProvider);
    const aiModel = h("input", { value: s.aiModel || "", placeholder: "gpt-4o-mini / llama3.1" });
    // The raw key is NEVER sent to the browser. Show only whether one is set +
    // a masked hint. Leaving the field blank on save PRESERVES the stored key.
    const keyPlaceholder = s.openaiApiKeyFromEnv
      ? "Set via DEVRECAP_OPENAI_API_KEY (environment)"
      : s.openaiApiKeySet
        ? `Configured (${s.openaiApiKeyMasked}) — leave blank to keep`
        : "sk-… (stored locally; env var recommended)";
    const openaiApiKey = h("input", { type: "password", value: "", placeholder: keyPlaceholder, disabled: s.openaiApiKeyFromEnv });
    const clearKey = h("input", { type: "checkbox" });
    const ollamaEndpoint = h("input", { value: s.ollamaEndpoint });
    const redaction = h("input", { type: "checkbox", checked: s.redactionEnabled });
    const payloadPreview = h("input", { type: "checkbox", checked: s.showPayloadPreview });
    const reviewThreshold = h("input", { type: "number", step: "0.05", min: "0", max: "1", value: s.reviewThreshold });
    const defaultStyle = selectFrom(["spoken", "professional", "executive", "technical"], s.defaultStyle);
    const defaultLength = selectFrom(["short", "normal", "detailed"], s.defaultLength);
    const dailyDuration = selectFrom(["30", "60", "90"], String(s.dailyDurationSeconds));

    const save = async () => {
      try {
        await api.post("/settings", {
          timezone: timezone.value,
          aiProvider: aiProvider.value, aiModel: aiModel.value,
          // Blank = preserve existing key; a value replaces it; the checkbox
          // explicitly clears it. The raw key is never round-tripped to the UI.
          ...(openaiApiKey.value ? { openaiApiKey: openaiApiKey.value } : {}),
          clearOpenaiApiKey: clearKey.checked,
          ollamaEndpoint: ollamaEndpoint.value,
          redactionEnabled: redaction.checked, showPayloadPreview: payloadPreview.checked,
          defaultStyle: defaultStyle.value, defaultLength: defaultLength.value,
          dailyDurationSeconds: Number(dailyDuration.value),
          reviewThreshold: Number(reviewThreshold.value),
        });
        toast("Settings saved");
        ctx.rerender();
      } catch (e) { toast("Error: " + e.message); }
    };

    root.replaceChildren(
      pageHead("Settings", ""),
      h("div", { class: "section-title" }, "Data & privacy"),
      h("div", { class: "card" },
        h("div", { class: "pill-info safe", style: { marginBottom: "12px" } },
          "DevRecap only analyzes files you import. It never connects to Codex, scans your machine, or accesses Git repositories."),
        h("div", { class: "btn-row" },
          h("button", { class: "btn primary", onclick: () => ctx.navigate("import") }, "↑ Import files"),
          h("button", { class: "btn", onclick: () => ctx.navigate("imports") }, "View import history"),
        )),
      h("div", { class: "section-title" }, "General"),
      h("div", { class: "card" },
        label("Timezone (IANA)", timezone)),
      h("div", { class: "section-title" }, "AI provider (optional)"),
      h("div", { class: "card" },
        h("div", { class: "inline-fields" }, label("Provider", aiProvider), label("Model", aiModel)),
        label("OpenAI API key", openaiApiKey),
        s.openaiApiKeyFromEnv
          ? h("div", { class: "pill-info safe" }, "Key is provided via the DEVRECAP_OPENAI_API_KEY environment variable (recommended) and is not stored in the database.")
          : h("label", { class: "checkbox-row", style: { marginTop: "6px" } }, clearKey, h("span", {}, "Clear the stored API key")),
        label("Ollama endpoint", ollamaEndpoint),
        h("div", { class: "pill-info" }, "The report generator is DETERMINISTIC and fully local by default. An external provider is OPTIONAL and is only ever contacted after you explicitly confirm the exact sanitized payload shown in the preview. Raw imported data (sessions, commands, file contents, code) is NEVER sent."),
        h("div", { class: "pill-info faint" }, "For security, prefer setting the key via the DEVRECAP_OPENAI_API_KEY environment variable. Keys saved here are stored in a local SQLite file in plaintext.")),
      h("div", { class: "section-title" }, "Privacy"),
      h("div", { class: "card" },
        h("label", { class: "checkbox-row", style: { marginBottom: "10px" } }, redaction, h("span", {}, "Redaction enabled (mask secrets as [REDACTED])")),
        h("label", { class: "checkbox-row" }, payloadPreview, h("span", {}, "Show external AI payload preview before sending"))),
      h("div", { class: "section-title" }, "Reports & review"),
      h("div", { class: "card" },
        h("div", { class: "inline-fields" }, label("Default style", defaultStyle), label("Default length", defaultLength), label("Daily duration (s)", dailyDuration)),
        label("Review threshold (activities below this confidence go to the inbox)", reviewThreshold)),
      h("div", { class: "btn-row", style: { marginTop: "16px" } },
        h("button", { class: "btn primary", onclick: save }, "Save settings")),
    );
  } catch (e) { root.replaceChildren(pageHead("Settings"), errorCard(e)); }
  return root;
}

// --- Import ----------------------------------------------------------------

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Two-phase import UI:
 *   1. Select files → each File is UPLOADED as a raw binary body (no base64,
 *      no whole-file-in-memory JSON) to POST /api/imports/upload. The upload
 *      streams straight to disk on the server.
 *   2. The user explicitly clicks "Analyze" per uploaded import.
 */
export async function ImportView(ctx) {
  const root = h("div", {});
  // rows: { file, status: 'queued'|'uploading'|'uploaded'|'duplicate'|'error',
  //         importId?, size, message? }
  let rows = [];

  const dropzone = h("div", {
    class: "dropzone",
    ondragover: (e) => { e.preventDefault(); dropzone.classList.add("drag"); },
    ondragleave: () => dropzone.classList.remove("drag"),
    ondrop: (e) => {
      e.preventDefault(); dropzone.classList.remove("drag");
      queueFiles([...(e.dataTransfer?.files || [])]);
    },
  },
    h("div", { style: { fontSize: "15px", fontWeight: "600" } }, "Drag files here"),
    h("div", { class: "faint", style: { margin: "6px 0 14px" } }, "or"),
    h("button", { class: "btn primary", onclick: () => picker.click() }, "Select files"),
    h("div", { class: "faint", style: { marginTop: "14px", fontSize: "12px" } },
      "Supported: JSONL · JSON · ZIP · GZ · TXT"),
  );
  const picker = h("input", {
    type: "file", multiple: true, style: { display: "none" },
    accept: ".jsonl,.json,.txt,.log,.gz,.zip,.ndjson",
    onchange: (e) => { queueFiles([...(e.target.files || [])]); picker.value = ""; },
  });

  const fileList = h("div");
  const actionRow = h("div");

  function queueFiles(files) {
    for (const f of files) rows.push({ file: f, status: "queued", size: f.size });
    render();
    // upload each queued file immediately (streamed), but DO NOT analyze.
    rows.filter((r) => r.status === "queued").forEach(uploadRow);
  }

  async function uploadRow(row) {
    row.status = "uploading"; render();
    try {
      const res = await fetch(`/api/imports/upload?filename=${encodeURIComponent(row.file.name)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: row.file, // the browser streams the File; no base64
      });
      const j = await res.json();
      if (!res.ok) { row.status = "error"; row.message = j.error || res.statusText; render(); return; }
      if (j.duplicate) {
        row.status = "duplicate";
        row.duplicate = j.existing;
        render();
        return;
      }
      row.status = "uploaded";
      row.importId = j.import.id;
    } catch (e) {
      row.status = "error"; row.message = String(e);
    }
    render();
  }

  async function forceReupload(row) {
    row.status = "uploading"; render();
    try {
      const res = await fetch(`/api/imports/upload?allowDuplicates=true&filename=${encodeURIComponent(row.file.name)}`, {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: row.file,
      });
      const j = await res.json();
      if (!res.ok) { row.status = "error"; row.message = j.error; render(); return; }
      row.status = "uploaded"; row.importId = j.import.id; row.duplicate = undefined;
    } catch (e) { row.status = "error"; row.message = String(e); }
    render();
  }

  async function analyzeAll() {
    const pending = rows.filter((r) => r.status === "uploaded" && r.importId);
    if (pending.length === 0) { toast("Nothing to analyze"); return; }
    actionRow.replaceChildren(loading());
    let totalActs = 0;
    for (const r of pending) {
      r.status = "analyzing"; render();
      try {
        const res = await api.post(`/imports/${r.importId}/analyze`, {});
        r.status = res.import.status; // completed | partial | failed
        r.result = res.import; r.warnings = res.warnings;
        totalActs += res.import.activityCount || 0;
      } catch (e) { r.status = "error"; r.message = String(e); }
      render();
    }
    toast(`Analyzed ${pending.length} file(s), ${totalActs} activities`);
  }

  function statusPill(r) {
    if (r.status === "uploading") return h("span", { class: "pill-info" }, h("span", { class: "spinner" }), " uploading…");
    if (r.status === "analyzing") return h("span", { class: "pill-info" }, h("span", { class: "spinner" }), " analyzing…");
    if (r.status === "uploaded") return h("span", { class: "badge cat-investigation" }, "uploaded — ready");
    if (r.status === "duplicate") return h("span", { class: "badge cat-bugfix" }, "already imported");
    if (r.status === "completed") return h("span", { class: "badge cat-testing" }, "completed");
    if (r.status === "partial") return h("span", { class: "badge cat-investigation" }, "partial");
    if (r.status === "failed" || r.status === "error") return h("span", { class: "badge cat-bugfix" }, r.status);
    return h("span", { class: "badge" }, r.status);
  }

  function render() {
    if (rows.length === 0) { fileList.replaceChildren(); actionRow.replaceChildren(); return; }
    fileList.replaceChildren(
      h("div", { class: "section-title" }, "Files"),
      ...rows.map((r, i) => h("div", { class: "act-row", style: { alignItems: "center" } },
        h("div", { style: { flex: 1 } },
          h("div", { class: "act-title" }, r.file.name),
          h("div", { class: "act-meta" },
            statusPill(r),
            h("span", { class: "faint" }, fmtBytes(r.size)),
            r.result ? h("span", { class: "faint" }, `${r.result.eventCount} events · ${r.result.activityCount} activities`) : null,
            r.duplicate ? h("span", { class: "faint" }, `imported ${fmtDay(r.duplicate.importedAt)} (${r.duplicate.status})`) : null,
            r.message ? h("span", { class: "conf low" }, r.message) : null,
            (r.warnings && r.warnings.length) ? h("span", { class: "conf mid" }, `${r.warnings.length} warning(s)`) : null,
          )),
        r.status === "duplicate" ? h("button", { class: "btn sm", onclick: () => forceReupload(r) }, "Import again") : null,
        h("button", { class: "btn sm ghost", onclick: () => { rows.splice(i, 1); render(); } }, "Remove"),
      )),
    );
    const readyCount = rows.filter((r) => r.status === "uploaded").length;
    actionRow.replaceChildren(
      h("div", { class: "btn-row" },
        h("button", { class: "btn primary", disabled: readyCount === 0, onclick: analyzeAll },
          readyCount ? `Analyze ${readyCount} file(s)` : "Analyze"),
        h("button", { class: "btn ghost", onclick: () => { rows = []; render(); } }, "Clear"),
        h("button", { class: "btn", onclick: () => ctx.navigate("imports") }, "Import History →"),
      ),
      h("div", { class: "faint", style: { marginTop: "10px", fontSize: "12px" } },
        "Files upload as you add them, but nothing is analyzed until you click Analyze. Uploads stream to DevRecap's local storage; your original files are never modified."),
    );
  }

  root.replaceChildren(
    pageHead("Import Work History", "Analyze files you export from Codex — no tool connection, ever"),
    dropzone, picker,
    fileList,
    actionRow,
    h("div", { class: "card", style: { marginTop: "20px" } },
      h("div", { class: "section-title", style: { marginTop: 0 } }, "How to export Codex sessions"),
      h("div", { class: "muted", style: { fontSize: "12.5px" } },
        "Copy your Codex rollout files (e.g. ", h("code", {}, "rollout-*.jsonl"),
        ") and drop them here. You can also drop a ", h("code", {}, ".zip"), " or ",
        h("code", {}, ".gz"), " archive of sessions, or a git-log text export created with ",
        h("code", {}, "git log --stat > git-history.txt"), ".")),
  );
  return root;
}

// --- Import History --------------------------------------------------------
export async function ImportHistoryView(ctx) {
  const root = h("div", {}, pageHead("Import History", ""), loading());
  try {
    const imports = await api.get("/imports");
    const statusBadgeFor = (s) => {
      const cls = s === "completed" ? "cat-testing"
        : s === "partial" ? "cat-investigation"
        : s === "failed" ? "cat-bugfix"
        : s === "uploaded" ? "cat-feature" : "";
      const label = s === "uploaded" ? "uploaded — not analyzed" : s;
      return h("span", { class: `badge ${cls}` }, label);
    };
    root.replaceChildren(
      pageHead("Import History", `${imports.length} import(s)`),
      h("div", { class: "btn-row", style: { marginBottom: "16px" } },
        h("button", { class: "btn primary", onclick: () => ctx.navigate("import") }, "↑ Import more"),
      ),
      imports.length
        ? h("div", {}, ...imports.map((imp) => h("div", { class: "card row-between", style: { marginBottom: "10px" } },
            h("div", { style: { flex: 1 } },
              h("div", { class: "act-title" }, imp.originalFilename),
              h("div", { class: "act-meta" },
                statusBadgeFor(imp.status),
                imp.detectedFormat ? h("span", { class: "badge" }, imp.detectedFormat) : null,
                imp.fileType && imp.fileType !== "unknown" ? h("span", { class: "badge" }, imp.fileType) : null,
                h("span", { class: "faint" }, `${fmtBytes(imp.size)} · ${fmtDay(imp.importedAt)}`),
              ),
              imp.status !== "uploaded"
                ? h("div", { class: "act-summary" },
                    `${imp.eventCount} events · ${imp.activityCount} activities` +
                    (imp.errorCount ? ` · ${imp.errorCount} malformed record(s)` : "") +
                    (imp.warningCount ? ` · ${imp.warningCount} warning(s)` : ""))
                : h("div", { class: "act-summary faint" }, "Uploaded and waiting — click Analyze to process it."),
              imp.error ? h("div", { class: "act-meta" }, h("span", { class: "conf low" }, imp.error)) : null,
            ),
            h("div", { class: "btn-row" },
              imp.status === "uploaded"
                ? h("button", { class: "btn sm primary", onclick: async () => {
                    toast("Analyzing…");
                    try { await api.post(`/imports/${imp.id}/analyze`, {}); toast("Analyzed"); ctx.rerender(); }
                    catch (e) { toast("Error: " + e.message); }
                  } }, "Analyze")
                : null,
              // Re-run the CURRENT extraction logic against the stored copy.
              // Keeps the original file; regenerates only derived activities.
              imp.status !== "uploaded"
                ? h("button", { class: "btn sm", onclick: async () => {
                    if (!confirm(`Re-analyze "${imp.originalFilename}"? This discards its ${imp.activityCount} derived activities and rebuilds them from the same stored file. The original import file is kept.`)) return;
                    toast("Re-analyzing…");
                    try {
                      const r = await api.post(`/imports/${imp.id}/reanalyze`, {});
                      toast(`Re-analyzed: ${r.import.activityCount} activities from ${r.import.eventCount} events`);
                      ctx.rerender();
                    } catch (e) { toast("Error: " + e.message); }
                  } }, "Re-analyze")
                : null,
              // Safe counts-only diagnostics (no raw content shown).
              imp.status !== "uploaded"
                ? h("button", { class: "btn sm ghost", onclick: () => toggleDiagnostics(imp) }, "Diagnostics")
                : null,
              h("button", {
                class: "btn sm ghost danger",
                onclick: async () => {
                  if (!confirm(`Delete "${imp.originalFilename}" and all ${imp.activityCount} activities from it? This also removes DevRecap's stored copy.`)) return;
                  try {
                    const r = await api.send("DELETE", `/imports/${imp.id}`);
                    toast(r.fileError ? `Deleted DB records, but file removal failed: ${r.fileError}` : "Import deleted (records + stored copy)");
                    ctx.rerender();
                  } catch (e) { toast("Error: " + e.message); }
                },
              }, "Delete"),
            ),
            // Per-import diagnostics panel (populated lazily on demand).
            h("div", { class: "diag-slot", id: `diag-${imp.id}`, style: { display: "none", flexBasis: "100%", width: "100%", marginTop: "10px" } }),
          )))
        : h("div", { class: "empty" },
            h("div", { style: { marginBottom: "12px" } }, "No imports yet."),
            h("button", { class: "btn primary", onclick: () => ctx.navigate("import") }, "↑ Import Files")),
    );
  } catch (e) { root.replaceChildren(pageHead("Import History"), errorCard(e)); }
  return root;
}

/**
 * Toggle the counts-only diagnostics panel for one import. Fetches lazily the
 * first time it's opened. The payload is COUNTS + sanitized SHAPES only — it
 * never contains raw event content, commands, file paths, or message text.
 */
async function toggleDiagnostics(imp) {
  const slot = document.getElementById(`diag-${imp.id}`);
  if (!slot) return;
  if (slot.style.display !== "none") { slot.style.display = "none"; return; }
  slot.style.display = "block";
  if (slot.dataset.loaded === "1") return;
  slot.replaceChildren(loading());
  try {
    const res = await api.get(`/imports/${imp.id}/diagnostics`);
    slot.dataset.loaded = "1";
    slot.replaceChildren(renderDiagnostics(res.diagnostics));
  } catch (e) {
    slot.replaceChildren(h("div", { class: "conf low" }, "Could not load diagnostics: " + e.message));
  }
}

/** Render a diagnostics object (counts + sanitized shapes) into a compact card. */
function renderDiagnostics(d) {
  if (!d) return h("div", { class: "muted" }, "No diagnostics recorded for this import (re-analyze to generate them).");

  const num = (n) => (typeof n === "number" ? n : 0);
  // A labeled table of key → count, sorted by count desc.
  const countTable = (obj) => {
    const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return h("div", { class: "faint" }, "—");
    return h("table", { class: "diag-table" },
      ...entries.map(([k, v]) => h("tr", {},
        h("td", { class: "diag-k" }, k),
        h("td", { class: "diag-v" }, String(v)))));
  };

  const section = (title, body) => h("div", { class: "diag-section" },
    h("div", { class: "diag-h" }, title), body);

  // Task-engine funnel summary line.
  const funnel = h("div", { class: "diag-funnel" },
    h("span", { class: "badge" }, `candidates: ${num(d.candidatesCreated)}`),
    h("span", { class: "badge cat-testing" }, `accepted: ${num(d.activitiesAccepted)}`),
    h("span", { class: "badge cat-bugfix" }, `rejected: ${num(d.candidatesRejected)}`),
  );

  // Sanitized sample shapes — types only, never content.
  const shapes = Array.isArray(d.sampleShapes) ? d.sampleShapes : [];
  const shapeList = shapes.length
    ? h("div", { class: "diag-shapes" }, ...shapes.map((s) => h("code", { class: "diag-shape" },
        [s.rootType, s.payloadType, s.itemType].filter(Boolean).join("/") +
        (s.toolName ? ` · tool=${s.toolName}` : "") +
        (Array.isArray(s.contentTypes) && s.contentTypes.length ? ` · [${s.contentTypes.join(",")}]` : ""))))
    : h("div", { class: "faint" }, "—");

  // When zero activities were accepted, explain WHY as plainly as the counts
  // allow, so a real rollout that still yields nothing is diagnosable at a glance.
  let zeroBanner = null;
  if (num(d.activitiesAccepted) === 0) {
    const totalRaw = Object.values(d.rawShapes || {}).reduce((a, b) => a + b, 0);
    const totalClassifiedWork =
      num((d.classified || {}).USER_INTENT) + num((d.classified || {}).FILE_EDIT) +
      num((d.classified || {}).FILE_READ) + num((d.classified || {}).TEST_RUN) +
      num((d.classified || {}).TEST_RESULT) + num((d.classified || {}).GIT_EVENT) +
      num((d.classified || {}).COMMAND);
    let why;
    if (totalRaw === 0) why = "No events were parsed from this file — it may be empty, not a Codex rollout, or all records were malformed.";
    else if (num(d.candidatesCreated) === 0 && totalClassifiedWork === 0)
      why = "Events parsed, but NONE classified as work (all noise/metadata). If this is a real rollout, an event shape below is still unrecognized — check ‘Raw event shapes’ for an UNKNOWN or unexpected type.";
    else if (num(d.candidatesCreated) === 0)
      why = "Work events were classified but no task candidate opened (likely no user intent and only incidental reads). Check ‘Classified events’ and ‘Normalized kinds’.";
    else
      why = "Task candidates were created but ALL were rejected. See ‘Rejection reasons’ below.";
    zeroBanner = h("div", { class: "diag-zero" },
      h("strong", {}, "0 activities produced. "), why);
  }

  return h("div", { class: "card diag-card" },
    h("div", { class: "diag-title" }, "Extraction diagnostics ",
      h("span", { class: "faint" }, "— counts only, no raw content")),
    zeroBanner,
    h("div", { class: "diag-grid" },
      section("Parser", h("div", { class: "act-summary" },
        `${num(d.parserWarnings)} warning(s) · ${num(d.malformedRecords)} malformed record(s)`)),
      section("Task engine", funnel),
    ),
    section("Rejection reasons", countTable(d.rejectionReasons)),
    h("div", { class: "diag-grid" },
      section("Raw event shapes", countTable(d.rawShapes)),
      section("Classified events", countTable(d.classified)),
    ),
    section("Normalized kinds", countTable(d.normalizedKinds)),
    section("Sample shapes (types only)", shapeList),
  );
}

// --- filter helpers --------------------------------------------------------
function filterSelect(lbl, key, filters, options, setF) {
  const sel = h("select", { onchange: (e) => setF(key, e.target.value) },
    ...options.map(([v, t]) => h("option", { value: v, selected: filters[key] === v }, t || `All ${lbl.toLowerCase()}`)));
  return sel;
}
function cats() { return [["", "All categories"], ...["feature","bugfix","investigation","refactor","testing","documentation","git","deployment","configuration","database","other"].map((c) => [c, c])]; }
function statuses() { return [["", "All statuses"], ...["completed","in_progress","blocked","unknown"].map((s) => [s, s])]; }
