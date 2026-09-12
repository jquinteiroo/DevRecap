/** DevRecap SPA entry: sidebar navigation + hash router + view rendering. */
import { h, mount, api } from "./lib/dom.mjs";
import {
  DashboardView, TimelineView, ReviewView, ProjectsView,
  SearchView, ReportsView, AddActivityView, SettingsView,
  ImportView, ImportHistoryView,
} from "./lib/views.mjs";

const ROUTES = {
  dashboard: { label: "Dashboard", ico: "◧", view: DashboardView },
  import: { label: "Import", ico: "↑", view: ImportView },
  timeline: { label: "Timeline", ico: "≡", view: TimelineView },
  review: { label: "Review Inbox", ico: "✓", view: ReviewView },
  imports: { label: "Import History", ico: "▦", view: ImportHistoryView },
  projects: { label: "Projects", ico: "◆", view: ProjectsView },
  reports: { label: "Reports", ico: "▤", view: ReportsView },
  search: { label: "Search", ico: "⌕", view: SearchView },
  add: { label: "Add activity", ico: "+", view: AddActivityView },
  settings: { label: "Settings", ico: "⚙", view: SettingsView },
};

const state = { timelineFilters: {}, searchQuery: "", pendingCount: 0 };

function currentRoute() {
  const hash = (location.hash || "#dashboard").slice(1).split("?")[0];
  return ROUTES[hash] ? hash : "dashboard";
}

function navigate(route) { location.hash = `#${route}`; }

async function refreshPendingBadge() {
  try {
    const d = await api.get("/dashboard");
    state.pendingCount = d.counts.pendingReview || 0;
  } catch { /* ignore */ }
}

function sidebar(route) {
  return h("aside", { class: "sidebar" },
    h("div", { class: "brand" },
      h("div", { class: "brand-mark" }, "D"),
      h("div", { class: "brand-name" }, "DevRecap")),
    ...Object.entries(ROUTES).map(([key, r]) =>
      h("button", {
        class: `nav-item ${route === key ? "active" : ""}`,
        onclick: () => navigate(key),
      },
        h("span", { class: "ico" }, r.ico),
        h("span", {}, r.label),
        key === "review" && state.pendingCount ? h("span", { class: "nav-badge" }, state.pendingCount) : null,
      )),
    h("div", { class: "sidebar-spacer" }),
    h("div", { class: "sidebar-foot" }, "Local-first · Evidence-based", h("br"), "v0.1.0"),
  );
}

let rendering = false;
async function render() {
  if (rendering) return;
  rendering = true;
  const route = currentRoute();
  const ctx = { state, navigate, rerender: render };
  const main = h("main", { class: "main" }, h("div", { class: "muted" }, "Loading…"));
  const app = h("div", { class: "app" }, sidebar(route), main);
  mount(document.getElementById("app"), app);
  try {
    const node = await ROUTES[route].view(ctx);
    main.replaceChildren(node);
  } catch (e) {
    main.replaceChildren(h("div", { class: "card", style: { borderColor: "var(--red)" } }, "Error: " + (e.message || e)));
  }
  rendering = false;
}

window.addEventListener("hashchange", render);
(async () => {
  await refreshPendingBadge();
  await render();
  // keep the review badge fresh
  setInterval(refreshPendingBadge, 15000);
})();
