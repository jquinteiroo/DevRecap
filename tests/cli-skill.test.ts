import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveSources,
  readCliConfig,
  requireCliConfig,
  SetupRequiredError,
  writeCliConfig,
} from "../apps/cli/src/config.ts";
import { resolveCliInvocation, resolveRange } from "../apps/cli/src/commands.ts";
import { collectAuthorizedSources, type SourceCollectorDeps } from "../apps/cli/src/source-runner.ts";

test("CLI collectors require explicit setup before local access", () => {
  const root = mkdtempSync(join(tmpdir(), "devrecap-cli-config-"));
  const path = join(root, "config.json");
  try {
    assert.equal(readCliConfig(path), null);
    assert.throws(() => requireCliConfig(path), (error: unknown) => error instanceof SetupRequiredError);
    const saved = writeCliConfig({ codex: true, claude: false, git: true }, path, new Date("2026-09-12T12:00:00Z"));
    assert.deepEqual(saved.sources, { codex: true, claude: false, git: true });
    assert.deepEqual(requireCliConfig(path).sources, saved.sources);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source permissions can only narrow what setup authorized", () => {
  const config = { version: 1 as const, sources: { codex: true, claude: false, git: true }, consentedAt: "2026-09-12T12:00:00Z" };
  assert.deepEqual(
    effectiveSources(config, { codex: false, claude: true, git: true }),
    { codex: false, claude: false, git: true },
  );
});

test("disabled collectors are never invoked", () => {
  const calls = { codex: 0, claude: 0, git: 0, discover: 0 };
  const deps = {
    collectCodexSessions: () => { calls.codex++; return { source: "codex", events: [], filesRead: 1, malformed: 0, warnings: [] }; },
    collectClaudeSessions: () => { calls.claude++; return { source: "claude", events: [], filesRead: 1, malformed: 0, warnings: [] }; },
    discoverProjectDirectories: () => { calls.discover++; return ["/tmp/demo"]; },
    collectGitHistory: () => { calls.git++; return { repositories: [], warnings: [] }; },
  } as unknown as SourceCollectorDeps;
  const range = { start: "2026-09-12T00:00:00Z", end: "2026-09-12T23:59:59Z" };

  collectAuthorizedSources(range, { codex: true, claude: false, git: false }, deps);
  assert.deepEqual(calls, { codex: 1, claude: 0, git: 0, discover: 0 });
});

test("enabled collectors run and Git discovery only occurs when Git is authorized", () => {
  const calls = { codex: 0, claude: 0, git: 0, discover: 0 };
  const deps = {
    collectCodexSessions: () => { calls.codex++; return { source: "codex", events: [], filesRead: 1, malformed: 0, warnings: [] }; },
    collectClaudeSessions: () => { calls.claude++; return { source: "claude", events: [], filesRead: 1, malformed: 0, warnings: [] }; },
    discoverProjectDirectories: () => { calls.discover++; return ["/tmp/demo"]; },
    collectGitHistory: () => { calls.git++; return { repositories: [], warnings: [] }; },
  } as unknown as SourceCollectorDeps;
  const range = { start: "2026-09-12T00:00:00Z", end: "2026-09-12T23:59:59Z" };

  collectAuthorizedSources(range, { codex: true, claude: true, git: true }, deps);
  assert.deepEqual(calls, { codex: 1, claude: 1, git: 1, discover: 1 });
});

test("terminal-first aliases map to the existing report pipeline", () => {
  assert.deepEqual(resolveCliInvocation(["today"]).preset, { request: "today", kind: "daily" });
  assert.deepEqual(resolveCliInvocation(["week"]).preset, { request: "this week", kind: "weekly" });
  assert.deepEqual(resolveCliInvocation(["month"]).preset, { request: "this month", kind: "monthly" });
  assert.equal(resolveCliInvocation(["daily"]).preset?.style, "spoken");
  assert.equal(resolveCliInvocation(["daily"]).preset?.length, "short");
  assert.equal(resolveCliInvocation(["remember"]).preset?.kind, "help_me_remember");
  assert.equal(resolveCliInvocation(["remember"]).preset?.length, "detailed");
  assert.equal(resolveCliInvocation(["review"]).preset?.kind, "review");
  assert.deepEqual(resolveCliInvocation(["last 14 days"]), { operation: "report", args: ["last 14 days"] });
});

test("today/week/month resolve to the expected calendar windows", () => {
  const now = new Date("2026-09-12T15:30:00Z");
  const today = resolveRange("today", undefined, undefined, now);
  const week = resolveRange("this week", undefined, undefined, now);
  const month = resolveRange("this month", undefined, undefined, now);
  assert.equal(today.end, now.toISOString());
  assert.equal(week.end, now.toISOString());
  assert.equal(month.end, now.toISOString());
  assert.ok(Date.parse(today.start) <= Date.parse(today.end));
  assert.ok(Date.parse(week.start) <= Date.parse(today.start));
  assert.ok(Date.parse(month.start) <= Date.parse(week.start));
});
