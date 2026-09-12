/** Reusable UI pieces: badges, activity cards, evidence panels. */
import { h, api, toast } from "./dom.mjs";

export function fmtTime(iso) {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  } catch { return (iso || "").slice(11, 16); }
}
export function fmtDay(iso) {
  try {
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));
  } catch { return (iso || "").slice(0, 10); }
}

export function confClass(c) { return c >= 0.75 ? "high" : c >= 0.5 ? "mid" : "low"; }

export function categoryBadge(cat) {
  return h("span", { class: `badge cat-${cat}` }, cat);
}
export function statusBadge(status) {
  return h("span", { class: "badge" }, h("span", { class: `dot ${status}` }), status.replace("_", " "));
}
export function confBadge(c) {
  return h("span", { class: `conf ${confClass(c)}` }, c.toFixed(2));
}

/** Expandable evidence panel; lazy-loads on first open. */
export function evidenceToggle(activityId) {
  const container = h("div");
  let open = false;
  const btn = h("button", {
    class: "btn sm ghost",
    onclick: async () => {
      open = !open;
      if (!open) { container.replaceChildren(); btn.textContent = "View evidence"; return; }
      btn.textContent = "Hide evidence";
      container.replaceChildren(h("span", { class: "faint" }, "Loading evidence…"));
      try {
        const ev = await api.get(`/activities/${activityId}/evidence`);
        if (!ev.length) { container.replaceChildren(h("div", { class: "faint" }, "No evidence recorded.")); return; }
        container.replaceChildren(
          h("div", { class: "evidence-list" },
            ...ev.map((e) => {
              const meta = [
                e.sourceFilename ? `src: ${e.sourceFilename}` : null,
                e.sessionId ? `session: ${e.sessionId}` : null,
                e.eventType ? `type: ${e.eventType}` : null,
                e.ts ? `at ${fmtTime(e.ts)}` : null,
              ].filter(Boolean).join("  ·  ");
              return h("div", { class: "evidence-item" },
                h("span", { class: "ekind" }, e.kind),
                h("div", {},
                  h("div", {}, e.label),
                  meta ? h("div", { class: "faint", style: { fontSize: "11px" } }, meta) : null,
                  e.excerpt ? h("div", { class: "edetail" }, e.excerpt) : null,
                ),
              );
            }),
          ),
        );
      } catch (err) { container.replaceChildren(h("div", { class: "faint" }, String(err))); }
    },
  }, "View evidence");
  return h("div", {}, btn, container);
}

/** A rich activity card with optional review actions and selection checkbox. */
export function activityCard(a, opts = {}) {
  const { onChange, selectable, selected, onSelect } = opts;
  const review = async (patch, label) => {
    try { await api.patch(`/activities/${a.id}`, patch); toast(label); onChange && onChange(); }
    catch (e) { toast("Error: " + e.message); }
  };
  const actions = opts.review ? h("div", { class: "act-actions" },
    h("button", { class: "btn sm primary", onclick: () => review({ reviewState: "approved" }, "Approved") }, "Approve"),
    h("button", { class: "btn sm", onclick: () => editActivity(a, onChange) }, "Edit"),
    h("button", { class: "btn sm ghost danger", onclick: () => review({ reviewState: "ignored" }, "Ignored") }, "Ignore"),
  ) : null;

  const reasoning = Array.isArray(a.metadata?.reasoning) ? a.metadata.reasoning : [];
  return h("div", { class: "act-row" },
    selectable ? h("input", { type: "checkbox", class: "sel-check", checked: selected, onchange: (e) => onSelect && onSelect(a.id, e.target.checked) }) : null,
    h("div", { class: "act-time" }, fmtTime(a.startedAt)),
    h("div", { class: "act-body" },
      h("div", { class: "act-title" }, a.title),
      a.summary ? h("div", { class: "act-summary" }, a.summary) : null,
      h("div", { class: "act-meta" },
        a.projectName ? h("span", { class: "badge" }, a.projectName) : null,
        categoryBadge(a.category),
        statusBadge(a.status),
        confBadge(a.confidence),
        h("span", { class: "faint" }, a.source),
      ),
      reasoning.length ? whyToggle(reasoning) : null,
      h("div", { class: "act-actions", style: { marginTop: "8px" } },
        evidenceToggle(a.id),
        actions,
      ),
    ),
  );
}

/** Collapsible deterministic "Why?" explanation (NOT LLM reasoning). */
function whyToggle(reasons) {
  const body = h("div");
  let open = false;
  const btn = h("button", { class: "btn sm ghost", style: { marginTop: "6px" }, onclick: () => {
    open = !open;
    if (!open) { body.replaceChildren(); btn.textContent = "Why?"; return; }
    btn.textContent = "Hide reasoning";
    body.replaceChildren(
      h("ul", { class: "why-list" }, ...reasons.map((r) => h("li", {}, r))),
    );
  } }, "Why?");
  return h("div", {}, btn, body);
}

/** Inline edit via prompt-free small form rendered into a toast-like card. */
function editActivity(a, onChange) {
  const title = h("input", { value: a.title });
  const summary = h("textarea", {}, a.summary || "");
  const category = selectFrom(["feature","bugfix","investigation","refactor","testing","documentation","git","deployment","configuration","database","other"], a.category);
  const status = selectFrom(["completed","in_progress","blocked","unknown"], a.status);
  const panel = h("div", { class: "toast", style: { width: "420px", maxWidth: "90vw" } },
    h("div", { class: "section-title", style: { margin: "0 0 10px" } }, "Edit activity"),
    label("Title", title),
    label("Summary", summary),
    h("div", { class: "inline-fields" }, label("Category", category), label("Status", status)),
    h("div", { class: "btn-row", style: { marginTop: "8px" } },
      h("button", { class: "btn primary", onclick: async () => {
        try {
          await api.patch(`/activities/${a.id}`, {
            title: title.value, summary: summary.value,
            category: category.value, status: status.value, reviewState: "edited",
          });
          panel.remove(); toast("Saved"); onChange && onChange();
        } catch (e) { toast("Error: " + e.message); }
      } }, "Save"),
      h("button", { class: "btn ghost", onclick: () => panel.remove() }, "Cancel"),
    ),
  );
  document.body.appendChild(panel);
}

export function label(text, control) {
  return h("label", { class: "field" }, h("span", { class: "lbl" }, text), control);
}
export function selectFrom(options, value) {
  return h("select", {}, ...options.map((o) => h("option", { value: o, selected: o === value }, o)));
}
