import test from "node:test";
import assert from "node:assert/strict";
import type { Activity, Project } from "@devrecap/shared";
import {
  buildDeterministicAnalysis,
  buildReportInput,
  renderHtmlReport,
  validateReportAnalysis,
} from "@devrecap/report-engine";

const PROJECTS: Project[] = [
  { id: "p1", name: "billing", displayName: "Billing", type: "work", createdAt: "2026-09-01T00:00:00Z" },
];

function activity(id: string, startedAt: string, partial: Partial<Activity> = {}): Activity {
  return {
    id,
    source: "codex",
    projectId: "p1",
    startedAt,
    endedAt: startedAt,
    category: "investigation",
    title: "Investigated the API",
    summary: "Made changes in app.js. Ran 50 commands. Encountered errors in n-async.",
    status: "in_progress",
    confidence: 0.72,
    reviewState: "pending",
    evidence: [{ id: `e-${id}`, activityId: id, kind: "shell_command", label: "evidence" }],
    metadata: {
      workKind: "primary",
      topicKey: "api",
      objective: "Investigate the API",
      intents: ["investigar por que a API não retorna os dados corretos"],
      filesModified: ["src/app.js"],
      topicProfile: {
        domainTerms: ["api"], technologies: ["laravel"], components: [], actions: ["investigate"], primarySignal: "api",
      },
    },
    ...partial,
  } as Activity;
}

function build(activities: Activity[]) {
  return buildReportInput(activities, PROJECTS, {
    kind: "help_me_remember",
    style: "professional",
    length: "detailed",
    language: "auto",
    range: { start: "2026-09-10T00:00:00Z", end: "2026-09-12T23:59:59Z" },
    redactionEnabled: true,
  }).input;
}

test("deterministic recap consolidates repeated generic fronts instead of repeating API cards", () => {
  const input = build([
    activity("a1", "2026-09-10T08:00:00Z"),
    activity("a2", "2026-09-10T20:00:00Z"),
    activity("a3", "2026-09-12T08:00:00Z"),
  ]);

  // Force three separate report-time fronts to reproduce the real long-period
  // failure mode even if the lower-level Workstream engine has already learned
  // to group this particular fixture more aggressively.
  const base = input.workstreams[0];
  const byId = new Map(input.projects.flatMap((p) => p.activities).map((a) => [a.id, a]));
  input.workstreams = ["a1", "a2", "a3"].map((id, i) => ({
    ...base,
    id: `w${i + 1}`,
    activities: [byId.get(id)!],
    significance: base.significance / 3,
    startedAt: byId.get(id)!.startedAt,
    endedAt: byId.get(id)!.endedAt ?? byId.get(id)!.startedAt,
  }));

  const analysis = buildDeterministicAnalysis(input);
  assert.equal(analysis.investigations.length, 1, "repeated API investigation fronts should be one recap item");
  assert.equal(analysis.inProgress.length, 0, "investigation work must not be repeated again under In progress");
  assert.deepEqual(new Set(analysis.investigations[0].activityIds), new Set(["a1", "a2", "a3"]));
});

test("deterministic recap uses objective-level prose, not telemetry artifacts", () => {
  const input = build([activity("a1", "2026-09-10T08:00:00Z")]);
  const analysis = buildDeterministicAnalysis(input);
  const text = [analysis.mainFocus?.title, analysis.mainFocus?.narrative, ...analysis.investigations.map((x) => `${x.title} ${x.narrative}`)].join(" ");
  assert.doesNotMatch(text, /app\.js|n-async|Ran 50 commands|50 commands/i);
  assert.match(text, /API|Billing|Laravel/i);
});

test("in-progress work does not fabricate a next step", () => {
  const input = build([activity("a1", "2026-09-10T08:00:00Z")]);
  assert.deepEqual(input.nextSteps, [], "buildReportInput must not invent Continue: <title>");
  const analysis = buildDeterministicAnalysis(input);
  assert.deepEqual(analysis.nextSteps, []);
});

test("validator partitions one activity into only one detail section", () => {
  const input = build([activity("a1", "2026-09-10T08:00:00Z")]);
  const raw = {
    headline: "x",
    executiveSummary: "x",
    summaryActivityIds: ["a1"],
    investigations: [{ title: "Investigated API", narrative: "Investigated API behavior.", activityIds: ["a1"], confidence: 0.8 }],
    inProgress: [{ title: "API work", narrative: "API work is in progress.", activityIds: ["a1"], confidence: 0.8 }],
    highlights: [], blockers: [], nextSteps: [],
  };
  const validated = validateReportAnalysis(input, raw);
  const detailIds = [
    ...validated.highlights,
    ...validated.investigations,
    ...validated.inProgress,
    ...validated.blockers,
    ...validated.nextSteps,
  ].flatMap((x) => x.activityIds);
  assert.equal(detailIds.filter((id) => id === "a1").length, 1, "an activity must not be repeated across detail sections");
});

test("validator rejects invented next steps when input has none", () => {
  const input = build([activity("a1", "2026-09-10T08:00:00Z")]);
  const raw = {
    headline: "x",
    executiveSummary: "x",
    summaryActivityIds: ["a1"],
    highlights: [], investigations: [], inProgress: [], blockers: [],
    nextSteps: [{ title: "Next", narrative: "Continue or verify the API.", activityIds: ["a1"], confidence: 0.8 }],
  };
  assert.deepEqual(validateReportAnalysis(input, raw).nextSteps, []);
});

test("HTML follows the resolved work language when report language is auto", () => {
  const input = build([activity("a1", "2026-09-10T08:00:00Z")]);
  assert.equal(input.resolvedLanguage, "pt");
  const analysis = buildDeterministicAnalysis(input);
  const html = renderHtmlReport(input, analysis, { locale: "en" });
  assert.match(html, /Investigações|Em andamento|Foco principal/);
  assert.match(analysis.headline, /atividade relevante/);
  assert.doesNotMatch(html, />Investigations</);
});

test("weak conversational objective never becomes the workstream title", () => {
  const bad = activity("bad1", "2026-09-11T09:00:00Z", {
    category: "bugfix",
    title: "Worked on a fix for the project",
    metadata: {
      workKind: "primary",
      topicKey: "app",
      objective: "Fix the deste traga",
      intents: ["quero que deste resultado traga os dados"],
      filesModified: Array.from({ length: 40 }, (_, i) => `src/part-${i}.ts`),
      topicProfile: {
        domainTerms: ["deste", "traga"], technologies: ["vue", "pdf"], components: [], actions: ["fix"], primarySignal: "vue",
      },
    },
  });
  const input = build([bad]);
  const analysis = buildDeterministicAnalysis(input);
  const text = `${analysis.mainFocus?.title} ${analysis.mainFocus?.narrative}`;
  assert.doesNotMatch(text, /deste|traga/i);
  assert.doesNotMatch(text, /40\s+arquivos|40\s+files/i);
  assert.match(text, /Billing/i, "honest project context is preferred over a nonsense objective");
});

test("tooling residue such as 'main event' falls back to an honest investigation label", () => {
  const bad = activity("bad2", "2026-09-11T10:00:00Z", {
    title: "Investigated the project",
    metadata: {
      workKind: "primary",
      topicKey: "app",
      objective: "Investigate the main event",
      intents: ["preciso investigar o fluxo"],
      topicProfile: {
        domainTerms: ["main", "event"], technologies: [], components: [], actions: ["investigate"], primarySignal: "main",
      },
    },
  });
  const input = build([bad]);
  const analysis = buildDeterministicAnalysis(input);
  const text = `${analysis.mainFocus?.title} ${analysis.mainFocus?.narrative}`;
  assert.doesNotMatch(text, /main event/i);
  assert.match(text, /Investigação em Billing/i);
});

test("known product casing is normalized without inventing a new objective", () => {
  const a = activity("codex1", "2026-09-11T11:00:00Z", {
    metadata: {
      workKind: "primary",
      topicKey: "app",
      objective: "Investigate the codex plugin",
      intents: ["investigar o codex plugin"],
      topicProfile: {
        domainTerms: ["plugin"], technologies: ["codex"], components: [], actions: ["investigate"], primarySignal: "codex",
      },
    },
  });
  const analysis = buildDeterministicAnalysis(build([a]));
  assert.match(analysis.mainFocus?.title ?? "", /Codex/);
});

test("Portuguese summary uses natural plurals instead of '(s)' placeholders", () => {
  const analysis = buildDeterministicAnalysis(build([
    activity("p1", "2026-09-10T08:00:00Z"),
    activity("p2", "2026-09-10T09:00:00Z"),
  ]));
  assert.doesNotMatch(analysis.executiveSummary, /\(s\)|\(is\)/);
  assert.match(analysis.executiveSummary, /projeto|projetos/);
});

test("commit-like file titles are presented as human-readable deliveries", () => {
  const readme = activity("git1", "2026-09-12T09:00:00Z", {
    source: "git",
    category: "git",
    title: "Readme.md",
    summary: "Readme.md",
    status: "completed",
    confidence: 0.95,
    metadata: {
      workKind: "support",
      topicKey: "git",
      gitAction: "committed",
      committed: true,
      objective: "",
      intents: ["preciso atualizar o README"],
      topicProfile: { domainTerms: [], technologies: [], components: [], actions: [], primarySignal: "" },
    },
  });
  const analysis = buildDeterministicAnalysis(build([readme]));
  assert.ok(analysis.highlights.some((h) => /Atualização do README/i.test(h.title)));
});
