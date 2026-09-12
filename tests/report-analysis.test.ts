import test from "node:test";
import assert from "node:assert/strict";
import type { ReportInput } from "@devrecap/shared";
import { buildAnalysisContract, buildDeterministicAnalysis, renderHtmlReport, validateReportAnalysis } from "@devrecap/report-engine";

const input: ReportInput = {
  kind: "weekly", style: "professional", length: "normal", language: "pt", resolvedLanguage: "pt",
  range: { start: "2026-09-07T00:00:00.000Z", end: "2026-09-10T23:59:59.000Z" },
  projects: [{ id: "p1", name: "DevRecap", type: "other", activities: [
    { id: "a1", title: "Implemented terminal collector", summary: "Modified 4 files. Outcome: completed.", category: "feature", status: "completed", confidence: 0.95, startedAt: "2026-09-09T10:00:00.000Z", evidenceCount: 7 },
    { id: "a2", title: "Investigated PDF export", summary: "Inspected browser options. Outcome: in progress / unconfirmed.", category: "investigation", status: "in_progress", confidence: 0.7, startedAt: "2026-09-10T10:00:00.000Z", evidenceCount: 3 }
  ] }],
  workstreams: [], timeline: [], blockers: [], nextSteps: ["Continue: Investigated PDF export"], generatedAt: "2026-09-10T12:00:00.000Z"
};

test("analysis contract exposes only known activity ids", () => {
  const contract = buildAnalysisContract(input, { language: "pt-BR" });
  assert.deepEqual(contract.allowedActivityIds.sort(), ["a1", "a2"]);
});

test("validator drops hallucinated and semantically invalid analysis items", () => {
  const analysis = validateReportAnalysis(input, {
    headline: "Semana produtiva", executiveSummary: "Entrega validada e investigação em andamento.", summaryActivityIds: ["a1", "fake"],
    highlights: [
      { title: "Entrega", narrative: "Collector concluído.", activityIds: ["a1"], confidence: 0.99 },
      { title: "Inventado", narrative: "Produção publicada.", activityIds: ["fake"], confidence: 1 },
      { title: "Entrega indevida", narrative: "PDF entregue.", activityIds: ["a2"], confidence: 1 }
    ]
  });
  assert.deepEqual(analysis.summaryActivityIds, ["a1"]);
  assert.equal(analysis.highlights.length, 1);
  assert.deepEqual(analysis.highlights[0].activityIds, ["a1"]);
});

test("deterministic fallback renders without AI", () => {
  const html = renderHtmlReport(input, buildDeterministicAnalysis(input), { locale: "pt-BR" });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /DEVRECAP/);
  assert.doesNotMatch(html, /undefined/);
});
