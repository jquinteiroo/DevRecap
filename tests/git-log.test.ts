import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGitLogText, GitLogAdapter, looksLikeGitLog } from "@devrecap/git-parser";

const FIXTURE = join(process.cwd(), "fixtures", "git-log.txt");

test("parseGitLogText parses commits, messages, and changed files from --stat export", () => {
  const text = readFileSync(FIXTURE, "utf8");
  const commits = parseGitLogText(text, { repositoryId: "r1", projectId: "p1" });
  assert.equal(commits.length, 2);

  const fix = commits.find((c) => c.message.startsWith("fix"));
  assert.ok(fix);
  assert.equal(fix.authorName, "Dev Tester");
  assert.equal(fix.authorEmail, "dev@example.com");
  assert.ok(fix.message.includes("Corrected the item filter"), "multi-line body preserved");
  assert.ok(fix.files.includes("src/components/SampleDashboard.tsx"));
  assert.ok(fix.files.includes("src/controllers/WidgetController.ts"));
  assert.ok(fix.committedEpoch > 0);

  const feat = commits.find((c) => c.message.startsWith("feat"));
  assert.deepEqual(feat?.files, ["src/services/demo-api/ApiClient.ts"]);
});

test("parseGitLogText tolerates empty / garbage input without throwing", () => {
  assert.deepEqual(parseGitLogText(""), []);
  assert.deepEqual(parseGitLogText("not a git log at all\njust text"), []);
});

test("GitLogAdapter detects git-log text and emits git_commit events", () => {
  const text = readFileSync(FIXTURE, "utf8");
  const a = new GitLogAdapter();
  assert.ok(a.detect(text, "git-history.txt") > 0.5);
  const res = a.parseContent(text);
  assert.equal(res.events.length, 2);
  assert.equal(res.events[0].rootType, "git");
  assert.equal(res.events[0].payloadType, "git_commit");
});

test("looksLikeGitLog does NOT misclassify Codex JSON", () => {
  const codex = '{"type":"session_meta","payload":{"id":"s"}}';
  assert.ok(looksLikeGitLog(codex, "rollout.jsonl") < 0.3);
});
