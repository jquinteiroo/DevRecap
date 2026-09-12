import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function json(path: string): any {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

test("portable plugin manifest exposes DevRecap as an AI-native productivity plugin", () => {
  const manifest = json("plugin.json");
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(manifest.name, "devrecap");
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.extensions?.["com.openai"]?.interface?.displayName, "DevRecap");
  assert.equal(manifest.extensions?.["com.openai"]?.interface?.category, "Productivity");
  assert.match(manifest.extensions?.["com.openai"]?.interface?.shortDescription ?? "", /AI-written work recaps/i);
});

test("repo marketplace points at the portable plugin root with install metadata", () => {
  const marketplace = json(".agents/plugins/marketplace.json");
  assert.equal(marketplace.name, "devrecap-marketplace");
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, "devrecap");
  assert.equal(entry.source.source, "local");
  assert.equal(entry.source.path, "./");
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
  assert.equal(entry.category, "Productivity");
});

test("portable skill keeps host AI synthesis as the preferred report path", () => {
  const skill = readFileSync(resolve(root, "skills/devrecap/SKILL.md"), "utf8");
  assert.match(skill, /AI-first report pipeline/i);
  assert.match(skill, /contract\.facts/);
  assert.match(skill, /\.devrecap\/analysis\.json/);
  assert.match(skill, /Never promote `in_progress`, `blocked`, or `unknown` work to completed/);
  assert.match(skill, /scripts\/devrecap-plugin\.mjs/);
});

test("marketplace runner boots the CLI on Node 24 without noisy workspace-link output", () => {
  const result = spawnSync(process.execPath, [resolve(root, "scripts/devrecap-plugin.mjs"), "--help"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DevRecap — terminal-first developer work recap/);
  assert.doesNotMatch(result.stdout, /^linked @devrecap/m);
});
