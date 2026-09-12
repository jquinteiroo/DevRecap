import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

test("Skill-generated reports keep host-AI wording instead of deterministic semantic rewriting", () => {
  const index = read("packages/report-engine/src/index.ts");

  assert.match(index, /buildAnalysisPrompt,[\s\S]*validateReportAnalysis,[\s\S]*from "\.\/analysis\.ts"/);
  assert.match(index, /buildDeterministicAnalysis,[\s\S]*from "\.\/analysis-quality\.ts"/);
  assert.doesNotMatch(index, /buildDeterministicAnalysis,\s*validateReportAnalysis,\s*\}\s*from "\.\/analysis-quality\.ts"/);
});

test("HTML renderer presents AI synthesis as long-form report content", () => {
  const html = read("packages/report-engine/src/html.ts");

  assert.match(html, /Resumo executivo/);
  assert.match(html, /analysis\.executiveSummary/);
  assert.match(html, /analysis\.headline/);
  assert.match(html, /class=\"stack\"/);
  assert.match(html, /<details class=\"refs\">/);
  assert.match(html, /split\(\/\\n\\s\*\\n\/g\)/);
});

test("marketplace skill treats polished AI prose as the final deliverable", () => {
  const skill = read("skills/devrecap/SKILL.md");

  assert.match(skill, /The final HTML is the deliverable/i);
  assert.match(skill, /headline.*raw activity count/i);
  assert.match(skill, /executiveSummary.*polished opening paragraph/i);
  assert.match(skill, /canonical wording/i);
  assert.match(skill, /presentation quality/i);
});
