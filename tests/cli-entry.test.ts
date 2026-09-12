import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(process.cwd(), "apps", "cli", "src", "index.ts");

test("CLI entrypoint parses and prints help on Node 24", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DevRecap — terminal-first developer work recap/);
  assert.match(result.stdout, /devrecap setup/);
});

test("non-interactive setup can persist explicit source consent", () => {
  const root = mkdtempSync(join(tmpdir(), "devrecap-cli-entry-"));
  const config = join(root, "config.json");

  try {
    const result = spawnSync(
      process.execPath,
      [cli, "setup", "--codex", "--no-claude", "--git"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, DEVRECAP_CONFIG: config },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Codex: enabled/);
    assert.match(result.stdout, /Claude Code: disabled/);
    assert.match(result.stdout, /Git: enabled \(read-only\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
