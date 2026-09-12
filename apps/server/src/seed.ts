/**
 * Demo/seed data.
 *
 * Populates realistic projects and evidence-backed activities so the UI can be
 * developed and demoed without real Codex history. Idempotent-ish: it clears
 * demo rows (tagged via metadata.demo) before re-inserting.
 */

import type { Activity, DB, Evidence, Project } from "@devrecap/shared";
import { newId, nowIso, toEpoch } from "@devrecap/shared";
import { insertActivity, upsertProject, upsertCommit } from "./store.ts";

function iso(day: string, time: string): string {
  return new Date(`${day}T${time}:00.000Z`).toISOString();
}

export function seedDemoData(db: DB): { projects: number; activities: number } {
  // Clear prior demo data.
  const demoActs = db.all<{ id: string }>(
    `SELECT id FROM activities WHERE metadata LIKE '%"demo":true%'`,
  );
  db.tx(() => {
    for (const a of demoActs) db.run(`DELETE FROM evidence WHERE activity_id=?`, [a.id]);
    db.run(`DELETE FROM activities WHERE metadata LIKE '%"demo":true%'`);
    db.run(`DELETE FROM commits WHERE id LIKE 'demo_%'`);
  });

  const day = new Date().toISOString().slice(0, 10);
  // All demo data uses fictional, generic names. No real project/company names.
  const projects: Project[] = [
    { id: "prj_demo_dashboard", name: "sample-dashboard", displayName: "Sample Dashboard", type: "work", rootPath: "/home/user/example-project", gitRemote: "git@github.com:example/repository.git", detectedFrom: "demo", createdAt: nowIso() },
    { id: "prj_demo_api", name: "demo-api", displayName: "Demo API", type: "work", rootPath: "/home/user/demo-api", detectedFrom: "demo", createdAt: nowIso() },
    { id: "prj_demo_search", name: "docs-search", displayName: "Docs Search", type: "work", rootPath: "/home/user/docs-search", detectedFrom: "demo", createdAt: nowIso() },
    { id: "prj_demo_course", name: "coursework-project", displayName: "Coursework Project", type: "university", rootPath: "/home/user/coursework", detectedFrom: "demo", createdAt: nowIso() },
    { id: "prj_demo_weekend", name: "weekend-project", displayName: "Weekend Project", type: "personal", rootPath: "/home/user/weekend", detectedFrom: "demo", createdAt: nowIso() },
  ];
  for (const p of projects) upsertProject(db, p);

  interface Spec {
    project: string; time: string; category: Activity["category"]; status: Activity["status"];
    title: string; summary: string; confidence: number; review: Activity["reviewState"];
    ev: { kind: Evidence["kind"]; label: string; detail?: string }[];
  }
  const specs: Spec[] = [
    { project: "prj_demo_dashboard", time: "08:17", category: "investigation", status: "completed", confidence: 0.86, review: "approved",
      title: "Investigated item filtering issue in Sample Dashboard",
      summary: "Traced item selection logic; found the filter ignored inactive items. Touched SampleDashboard.tsx.",
      ev: [{ kind: "codex_message", label: "User request", detail: "Item selection in the sample dashboard is broken." }, { kind: "shell_command", label: "grep itemId", detail: "grep -rn itemId src/components/SampleDashboard.tsx" }] },
    { project: "prj_demo_dashboard", time: "08:42", category: "bugfix", status: "completed", confidence: 0.94, review: "approved",
      title: "Fixed item selection behavior in Sample Dashboard",
      summary: "Corrected the item filter and updated WidgetController.ts. Tests passing; committed.",
      ev: [{ kind: "edited_file", label: "Edited SampleDashboard.tsx", detail: "src/components/SampleDashboard.tsx" }, { kind: "edited_file", label: "Edited WidgetController.ts", detail: "src/controllers/WidgetController.ts" }, { kind: "test_run", label: "Tests passed", detail: "npm test -- --filter=SampleDashboardTest — 4 passed" }, { kind: "git_commit", label: "Commit dc48b95", detail: "fix(sample-dashboard): item selection" }] },
    { project: "prj_demo_dashboard", time: "09:20", category: "bugfix", status: "completed", confidence: 0.8, review: "approved",
      title: "Improved error handling in report generation",
      summary: "Wrapped PDF generation in try/catch and surfaced a friendly error. Touched ReportPdf.ts.",
      ev: [{ kind: "edited_file", label: "Edited ReportPdf.ts", detail: "src/services/ReportPdf.ts" }, { kind: "codex_message", label: "User request", detail: "Report PDF generation throws on a missing template." }] },
    { project: "prj_demo_api", time: "10:21", category: "investigation", status: "in_progress", confidence: 0.62, review: "approved",
      title: "Investigated missing API client dependency",
      summary: "Diagnosed an ApiClient dependency error; the demo-api-client package was not installed.",
      ev: [{ kind: "error", label: "Dependency error", detail: "Cannot find module 'demo-api-client'" }, { kind: "shell_command", label: "list packages", detail: "npm ls | grep demo-api-client" }] },
    { project: "prj_demo_api", time: "11:05", category: "configuration", status: "completed", confidence: 0.7, review: "approved",
      title: "Reviewed API webhook configuration",
      summary: "Checked webhook endpoints and payload template mapping.",
      ev: [{ kind: "codex_message", label: "User request", detail: "Verify the demo API webhook endpoint configuration." }] },
    { project: "prj_demo_search", time: "13:40", category: "feature", status: "completed", confidence: 0.82, review: "approved",
      title: "Added document search functionality",
      summary: "Implemented a search endpoint and wired it to the UI. Touched SearchController.ts and search.tsx.",
      ev: [{ kind: "edited_file", label: "Edited SearchController.ts", detail: "src/controllers/SearchController.ts" }, { kind: "edited_file", label: "Edited search.tsx", detail: "src/pages/search.tsx" }] },
    { project: "prj_demo_search", time: "14:30", category: "other", status: "unknown", confidence: 0.38, review: "pending",
      title: "Ran a database query",
      summary: "Executed an ad-hoc query against the documents table; purpose unclear.",
      ev: [{ kind: "shell_command", label: "psql query", detail: "psql -c 'select count(*) from documents'" }] },
    { project: "prj_demo_dashboard", time: "15:10", category: "other", status: "unknown", confidence: 0.34, review: "pending",
      title: "Modified SampleDashboard.tsx",
      summary: "A single edit to SampleDashboard.tsx with no surrounding context.",
      ev: [{ kind: "edited_file", label: "Edited SampleDashboard.tsx", detail: "src/components/SampleDashboard.tsx" }] },
    { project: "prj_demo_course", time: "19:00", category: "feature", status: "completed", confidence: 0.75, review: "approved",
      title: "Built catalog page (coursework project)",
      summary: "Created a catalog listing for a coursework project.",
      ev: [{ kind: "edited_file", label: "Edited Catalog.jsx", detail: "src/Catalog.jsx" }] },
    { project: "prj_demo_weekend", time: "21:30", category: "documentation", status: "completed", confidence: 0.6, review: "approved",
      title: "Updated personal project README",
      summary: "Wrote setup instructions for a personal side project.",
      ev: [{ kind: "edited_file", label: "Edited README.md", detail: "README.md" }] },
  ];

  let count = 0;
  for (const s of specs) {
    const startedAt = iso(day, s.time);
    const id = newId("act");
    const activity: Activity = {
      id, source: "codex", projectId: s.project, startedAt, endedAt: startedAt,
      category: s.category, title: s.title, summary: s.summary, status: s.status,
      confidence: s.confidence, reviewState: s.review, metadata: { demo: true },
    };
    const evidence: Evidence[] = s.ev.map((e) => ({
      id: newId("evd"), activityId: id, kind: e.kind, label: e.label, detail: e.detail,
      ts: startedAt, tsEpoch: toEpoch(startedAt),
      refType: e.kind === "git_commit" ? "commit" : "raw_event",
    }));
    insertActivity(db, activity, evidence);
    count++;
  }

  // A demo commit backing the bugfix.
  upsertCommit(db, {
    id: "demo_dc48b95", repositoryId: "demo_repo", projectId: "prj_demo_dashboard",
    hash: "dc48b95e1f2a3b4c5d6e7f8091a2b3c4d5e6f708",
    authorName: "Dev", authorEmail: "dev@example.com",
    committedAt: iso(day, "09:15"), committedEpoch: toEpoch(iso(day, "09:15")),
    message: "fix(sample-dashboard): item selection", branch: "main",
    files: ["src/components/SampleDashboard.tsx", "src/controllers/WidgetController.ts"],
  });

  return { projects: projects.length, activities: count };
}
