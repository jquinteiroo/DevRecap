/**
 * Workstream Semantic Grouping V3.
 *
 * Locks the contract that reports name and group workstreams by OBJECTIVE
 * (derived from recurring evidence signals), never by generic grammar, and
 * consolidate duplicates. Deterministic; no hardcoded technologies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Activity, Project, TopicProfile } from "@devrecap/shared";
import { buildReportInput, DeterministicProvider } from "@devrecap/report-engine";

const PROJECTS: Project[] = [
  { id: "p1", name: "app", displayName: "App", type: "work", createdAt: "2026-09-03T00:00:00Z" },
];
const BASE = Date.UTC(2026, 8, 3, 10, 0, 0);
let seq = 0;

function act(opts: {
  title: string;
  status?: Activity["status"];
  offsetMs?: number;
  files?: string[];
  profile?: Partial<TopicProfile>;
  techTerms?: string[];
  workKind?: string;
  gitAction?: string;
  committed?: boolean;
}): Activity {
  const id = `a${++seq}`;
  const started = new Date(BASE + (opts.offsetMs ?? seq * 300000)).toISOString();
  return {
    id, source: "codex", projectId: "p1", startedAt: started, endedAt: started,
    category: "feature", title: opts.title, summary: "", status: opts.status ?? "in_progress",
    confidence: 0.6, reviewState: "pending",
    evidence: [{ id: `e${id}`, activityId: id, kind: "shell_command", label: "x" }],
    metadata: {
      filesModified: opts.files ?? [],
      workKind: opts.workKind ?? "primary",
      topicKey: "app",
      gitAction: opts.gitAction,
      committed: opts.committed === true,
      techTerms: opts.techTerms ?? [],
      topicProfile: {
        domainTerms: opts.profile?.domainTerms ?? [],
        technologies: opts.profile?.technologies ?? [],
        components: opts.profile?.components ?? [],
        actions: opts.profile?.actions ?? [],
        primarySignal: opts.profile?.primarySignal ?? "",
      },
    },
  } as Activity;
}

function report(acts: Activity[], language: "auto" | "en" | "pt" = "pt", kind = "help_me_remember") {
  return buildReportInput(acts, PROJECTS, {
    kind: kind as never, style: "professional", length: "detailed", language,
    range: { start: "2026-09-03T00:00:00Z", end: "2026-09-10T23:59:59Z" },
  }).input;
}
async function render(acts: Activity[], language: "auto" | "en" | "pt" = "pt") {
  const input = report(acts, language);
  return (await new DeterministicProvider().generateReport(input)).content;
}

const GENERIC_RE = /\b(a aplicação|the application|o sistema|the system|o projeto|the project|desenvolvimento geral|general development)\b/i;

// ---------------------------------------------------------------------------
test("generic 'application' groups collapse into specific, named workstreams", () => {
  // Four activities that (pre-V3) all became topicKey 'app' but carry distinct
  // technology signals. They must NOT all be named the same generic thing.
  const acts = [
    act({ title: "Developed the application", files: ["src/docusign/client.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" } }),
    act({ title: "Developed the application", files: ["src/docusign/fields.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" } }),
    act({ title: "Developed the application", files: ["src/pdf/gen.php"], techTerms: ["PDF", "AcroForm"], profile: { technologies: ["pdf", "acroform"], primarySignal: "pdf" } }),
    act({ title: "Developed the application", files: ["docker-compose.yml"], techTerms: ["Docker"], profile: { technologies: ["docker"], primarySignal: "docker" }, workKind: "primary" }),
  ];
  const input = report(acts);
  // Distinct workstreams, none named a generic noun.
  const titles = input.workstreams.map((w) => w.title);
  for (const t of titles) assert.doesNotMatch(t, GENERIC_RE, `workstream named generically: "${t}"`);
  // The DocuSign activities cluster together; PDF and Docker are their own.
  assert.ok(input.workstreams.length >= 2, `expected multiple specific workstreams, got ${titles.join(" | ")}`);
});

test("no duplicate/identical workstream names appear", () => {
  const acts = [
    act({ title: "x", files: ["src/docusign/a.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" } }),
    act({ title: "y", files: ["src/docusign/b.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" }, offsetMs: 600000 }),
    act({ title: "z", files: ["src/docusign/c.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" }, offsetMs: 1200000 }),
  ];
  const input = report(acts);
  const names = input.workstreams.map((w) => w.title.toLowerCase());
  assert.equal(new Set(names).size, names.length, `duplicate workstream names: ${names.join(" | ")}`);
  // All DocuSign work consolidated into ONE workstream.
  assert.equal(input.workstreams.length, 1, `DocuSign work should consolidate, got ${names.join(" | ")}`);
});

test("workstream name comes from recurring technical concept, not generic prompt words", () => {
  const acts = [
    act({ title: "Developed the application", files: ["src/pdf/a.php"], techTerms: ["PDF"], profile: { technologies: ["pdf"], domainTerms: ["contract"], primarySignal: "pdf" } }),
    act({ title: "Developed the application", files: ["src/pdf/b.php"], techTerms: ["PDF", "AcroForm"], profile: { technologies: ["pdf", "acroform"], domainTerms: ["contract"], primarySignal: "pdf" }, offsetMs: 600000 }),
  ];
  const w = report(acts).workstreams[0];
  assert.match(w.title, /PDF|AcroForm|contract/i, `name from concept, got "${w.title}"`);
  assert.doesNotMatch(w.title, GENERIC_RE);
});

test("technical terms alone do NOT force one workstream per technology", () => {
  // Two DocuSign activities + one Docker activity → DocuSign clusters as one
  // objective; Docker is separate. Not 3 tech-per-workstream, not 1 blob.
  const acts = [
    act({ title: "x", files: ["src/docusign/a.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" } }),
    act({ title: "y", files: ["src/docusign/b.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" }, offsetMs: 600000 }),
    act({ title: "z", files: ["docker-compose.yml"], techTerms: ["Docker"], profile: { technologies: ["docker"], primarySignal: "docker" }, offsetMs: 1200000 }),
  ];
  const input = report(acts);
  assert.equal(input.workstreams.length, 2, `DocuSign(1) + Docker(1) = 2 workstreams, got ${input.workstreams.length}`);
  const docusign = input.workstreams.find((w) => /docusign/i.test(w.title))!;
  assert.equal(docusign.activities.length, 2, "both DocuSign activities in one workstream");
});

test("DocuSign work is separated from unrelated environment work", () => {
  const acts = [
    act({ title: "x", files: ["src/docusign/a.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" } }),
    act({ title: "y", files: ["docker-compose.yml", ".env"], techTerms: ["Docker"], profile: { technologies: ["docker"], components: ["docker"], primarySignal: "docker" }, offsetMs: 600000 }),
  ];
  const input = report(acts);
  const docusign = input.workstreams.find((w) => /docusign/i.test(w.title));
  const docker = input.workstreams.find((w) => /docker/i.test(w.title));
  assert.ok(docusign && docker, "DocuSign and Docker are distinct workstreams");
  assert.notEqual(docusign!.id, docker!.id);
});

test("summary mentions specific workstream names (never 'the application')", async () => {
  const content = await render([
    act({ title: "x", files: ["src/docusign/a.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" } }),
    act({ title: "y", files: ["src/pdf/b.php"], techTerms: ["PDF"], profile: { technologies: ["pdf"], primarySignal: "pdf" }, offsetMs: 600000 }),
  ], "pt");
  // Summary section names concrete topics.
  assert.match(content, /DocuSign|PDF/, "summary references specific concepts");
  assert.doesNotMatch(content.split("Principais frentes")[0], GENERIC_RE, "day summary is not generic");
});

test("open items use specific names, never generic 'application'", async () => {
  const content = await render([
    act({ title: "x", status: "in_progress", files: ["src/docusign/a.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" } }),
  ], "pt");
  const openSection = content.split(/O que ficou em aberto/)[1] ?? "";
  if (openSection.trim()) assert.doesNotMatch(openSection, GENERIC_RE, "open items must not be generic");
});

test("Portuguese contraction is natural (na/no, never 'em a')", async () => {
  const content = await render([
    act({ title: "x", files: ["src/ui/page.vue"], techTerms: ["Vue"], profile: { technologies: ["vue"], components: ["ui"], primarySignal: "vue" } }),
  ], "pt");
  assert.doesNotMatch(content, /\bem a \b/i, "must not produce 'em a'");
  assert.doesNotMatch(content, /\bde a \b/i, "must not produce 'de a'");
});

test("aggregated status: mix of completed + unfinished ⇒ partially_completed", () => {
  const acts = [
    act({ title: "x", status: "completed", files: ["src/docusign/a.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" } }),
    act({ title: "y", status: "in_progress", files: ["src/docusign/b.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" }, offsetMs: 600000 }),
  ];
  assert.equal(report(acts).workstreams[0].status, "partially_completed");
});

test("workstream diagnostics: topic signals with counts are exposed", () => {
  const acts = [
    act({ title: "x", files: ["src/docusign/a.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" } }),
    act({ title: "y", files: ["src/docusign/b.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" }, offsetMs: 600000 }),
  ];
  const w = report(acts).workstreams[0];
  assert.ok(Array.isArray(w.topicSignals) && w.topicSignals.length > 0, "topicSignals present");
  for (const s of w.topicSignals) {
    assert.equal(typeof s.term, "string");
    assert.equal(typeof s.count, "number");
  }
  assert.ok(w.topicSignals.some((s) => /docusign/i.test(s.term)), "dominant signal recorded");
});

test("zero-signal activities never leak a generic 'application' label (any language)", async () => {
  // Worst case: no technology, no domain term, generic titles. The workstream
  // must still consolidate and use a neutral LOCALIZED objective label — never
  // "the application" / "a aplicação", and never an English phrase in a PT report.
  const acts = [
    act({ title: "Developed the application", files: ["a1.ts"] }),
    act({ title: "Developed the application", files: ["a2.ts"], offsetMs: 4_000_000 }),
    act({ title: "Developed the application", files: ["a3.ts"], offsetMs: 8_000_000 }),
  ];
  const input = report(acts, "pt");
  assert.equal(input.workstreams.length, 1, "generic activities consolidate into one");
  // The internal title may be the reserved "General development" sentinel,
  // which is localized at render time — but it must never be an app/system noun.
  assert.doesNotMatch(input.workstreams[0].title, /\b(application|aplicação|system|sistema|the project|o projeto)\b/i,
    "workstream title is not a generic app/system noun");
  const content = await render(acts, "pt");
  assert.doesNotMatch(content, /\baplicação\b/i, "no 'aplicação' in the report");
  assert.doesNotMatch(content, /\bapplication\b/i, "no English 'application' in a PT report");
  assert.doesNotMatch(content, /\bDeveloped\b/, "no English verb leaks into a PT report");
  assert.match(content, /Trabalho geral de desenvolvimento/, "uses the localized neutral label");
});

test("component (file-area) is used to name a workstream when no topic term exists", () => {
  // Files under src/editor with no technology term → named from the component.
  const acts = [
    act({ title: "Developed the application", files: ["src/editor/a.ts"], profile: { components: ["editor"], primarySignal: "editor" } }),
    act({ title: "Developed the application", files: ["src/editor/b.ts"], profile: { components: ["editor"], primarySignal: "editor" }, offsetMs: 600000 }),
  ];
  const w = report(acts, "en").workstreams[0];
  assert.match(w.title, /editor/i, `named from component, got "${w.title}"`);
  assert.doesNotMatch(w.title, GENERIC_RE);
});

test("reports remain traceable to source activities", () => {
  const acts = [
    act({ title: "x", files: ["src/docusign/a.php"], techTerms: ["DocuSign"], profile: { technologies: ["docusign"], primarySignal: "docusign" } }),
    act({ title: "y", files: ["src/pdf/b.php"], techTerms: ["PDF"], profile: { technologies: ["pdf"], primarySignal: "pdf" }, offsetMs: 600000 }),
  ];
  const input = report(acts);
  let n = 0;
  for (const w of input.workstreams) for (const a of w.activities) { assert.ok(a.id); n++; }
  assert.equal(n, acts.length, "every activity is preserved under a workstream (lossless)");
});
