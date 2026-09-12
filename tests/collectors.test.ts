import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectClaudeSessions } from "@devrecap/collectors";
import { normalizeEvents } from "@devrecap/activity-engine";

test("Claude collector feeds the shared event pipeline", () => {
  const root = mkdtempSync(join(tmpdir(), "devrecap-claude-"));
  try {
    const project = join(root, "project"); mkdirSync(project);
    writeFileSync(join(project, "session.jsonl"), [
      { type: "user", timestamp: "2026-09-10T10:00:00.000Z", cwd: "/tmp/project", sessionId: "s1", message: { role: "user", content: "corrija o bug" } },
      { type: "assistant", timestamp: "2026-09-10T10:01:00.000Z", cwd: "/tmp/project", sessionId: "s1", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/app.ts", old_string: "a", new_string: "b" } }] } },
      { type: "user", timestamp: "2026-09-10T10:02:00.000Z", cwd: "/tmp/project", sessionId: "s1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "success" }] } }
    ].map((r) => JSON.stringify(r)).join("\n"));
    const collection = collectClaudeSessions({ start: "2026-09-10T00:00:00.000Z", end: "2026-09-10T23:59:59.999Z" }, root);
    assert.equal(collection.filesRead, 1);
    const normalized = normalizeEvents(collection.events);
    assert.ok(normalized.some((e) => e.kind === "user_request"));
    assert.ok(normalized.some((e) => e.kind === "file_edit"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
