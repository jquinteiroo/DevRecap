#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const major = Number(process.versions.node.split(".")[0] ?? 0);
if (!Number.isFinite(major) || major < 24) {
  process.stderr.write(`DevRecap requires Node.js 24 or newer. Current version: ${process.version}\n`);
  process.exitCode = 1;
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  // Marketplace installs bundle the full DevRecap source tree. Create the
  // lightweight workspace links before loading the TypeScript CLI so the user
  // does not need npm install or a globally linked devrecap binary.
  process.env.DEVRECAP_LINK_QUIET = "1";
  await import(pathToFileURL(join(root, "scripts", "link-workspaces.mjs")).href);
  await import(pathToFileURL(join(root, "apps", "cli", "src", "index.ts")).href);
}
