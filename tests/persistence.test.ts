import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, nowIso } from "@devrecap/shared";
import type { Activity, Evidence } from "@devrecap/shared";
import {
  insertActivity, getActivity, listActivities, updateActivity,
  upsertProject, listProjects, upsertCommit, listCommits,
} from "../apps/server/src/store.ts";

function db() { return openDb(":memory:"); }

test("migrations run and schema_version is recorded", () => {
  const d = db();
  const row = d.get<{ value: string }>("SELECT value FROM settings WHERE key='schema_version'");
  assert.ok(row);
  assert.ok(Number(JSON.parse(row.value)) >= 1);
  d.close();
});

test("insert + read activity with evidence round-trips", () => {
  const d = db();
  const a: Activity = {
    id: "a1", source: "codex", projectId: "p1", startedAt: nowIso(),
    category: "bugfix", title: "Fix X", summary: "did X", status: "completed",
    confidence: 0.9, reviewState: "pending", metadata: { files: ["x.ts"] },
  };
  const ev: Evidence[] = [
    { id: "e1", activityId: "a1", kind: "edited_file", label: "Edited x.ts", detail: "x.ts" },
    { id: "e2", activityId: "a1", kind: "git_commit", label: "Commit abc", detail: "fix" },
  ];
  insertActivity(d, a, ev);
  const got = getActivity(d, "a1");
  assert.equal(got?.title, "Fix X");
  assert.equal(got?.evidence?.length, 2);
  assert.deepEqual((got?.metadata as { files: string[] }).files, ["x.ts"]);
  d.close();
});

test("listActivities filters by project, status, search, and excludes merged", () => {
  const d = db();
  const mk = (id: string, projectId: string, status: Activity["status"], title: string, review: Activity["reviewState"] = "pending"): Activity => ({
    id, source: "codex", projectId, startedAt: nowIso(), category: "feature",
    title, summary: "", status, confidence: 0.7, reviewState: review,
  });
  insertActivity(d, mk("a1", "p1", "completed", "Demo API work"), []);
  insertActivity(d, mk("a2", "p2", "in_progress", "other thing"), []);
  insertActivity(d, mk("a3", "p1", "completed", "merged away", "merged"), []);

  assert.equal(listActivities(d, { projectId: "p1" }).length, 1, "p1 minus merged");
  assert.equal(listActivities(d, { status: "in_progress" }).length, 1);
  assert.equal(listActivities(d, { search: "Demo API" }).length, 1);
  assert.equal(listActivities(d, { includeMerged: true }).length, 3);
  d.close();
});

test("updateActivity changes review state", () => {
  const d = db();
  insertActivity(d, {
    id: "a1", source: "codex", startedAt: nowIso(), category: "other",
    title: "t", summary: "", status: "unknown", confidence: 0.3, reviewState: "pending",
  }, []);
  const updated = updateActivity(d, "a1", { reviewState: "approved", status: "completed" });
  assert.equal(updated?.reviewState, "approved");
  assert.equal(updated?.status, "completed");
  d.close();
});

test("projects and commits persist", () => {
  const d = db();
  upsertProject(d, { id: "p1", name: "x", displayName: "X", type: "work", rootPath: "/x", createdAt: nowIso() });
  assert.equal(listProjects(d).length, 1);
  upsertCommit(d, {
    id: "c1", repositoryId: "r1", projectId: "p1", hash: "abc",
    committedAt: nowIso(), committedEpoch: Date.now(), message: "m", files: ["a.ts"],
  });
  const commits = listCommits(d, "p1");
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].files, ["a.ts"]);
  d.close();
});
