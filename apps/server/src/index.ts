/**
 * DevRecap server entry.
 *
 * Serves the local API (node:http) and the static web UI. Local-first: binds to
 * 127.0.0.1 by default so nothing is exposed off-machine. No auth by design for
 * the MVP (single local user).
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, resolve, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, logger, setLogLevel } from "@devrecap/shared";
import type { LogLevel } from "@devrecap/shared";
import { Router } from "./http.ts";
import { registerApi } from "./api.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");
const WEB_DIR = resolve(ROOT, "apps", "web");
const DATA_DIR = process.env.DEVRECAP_DATA || resolve(ROOT, "data");
const DB_PATH = process.env.DEVRECAP_DB || resolve(DATA_DIR, "devrecap.db");
const PORT = Number(process.env.PORT || process.env.DEVRECAP_PORT || 3737);
const HOST = process.env.DEVRECAP_HOST || "127.0.0.1";

if (process.env.DEVRECAP_LOG_LEVEL) setLogLevel(process.env.DEVRECAP_LOG_LEVEL as LogLevel);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(pathname: string, res: import("node:http").ServerResponse): Promise<boolean> {
  // Prevent path traversal; resolve within WEB_DIR.
  let rel = pathname === "/" ? "/index.html" : pathname;
  const full = normalize(join(WEB_DIR, rel));
  if (!full.startsWith(WEB_DIR)) {
    res.writeHead(403).end("forbidden");
    return true;
  }
  try {
    const s = await stat(full);
    if (s.isDirectory()) return serveStatic(join(rel, "index.html"), res);
    const data = await readFile(full);
    res.writeHead(200, { "content-type": MIME[extname(full)] || "application/octet-stream" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  const db = openDb(DB_PATH);
  logger.info("DevRecap starting", { db: DB_PATH, dataDir: DATA_DIR, port: PORT, mode: "manual-import" });

  const router = new Router();
  registerApi(router, db, DATA_DIR);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        const handled = await router.handle(req, res);
        if (!handled) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        }
        return;
      }
      // Static, with SPA fallback to index.html for unknown non-file paths.
      const served = await serveStatic(url.pathname, res);
      if (!served) {
        if (!extname(url.pathname)) {
          await serveStatic("/index.html", res);
        } else {
          res.writeHead(404).end("not found");
        }
      }
    } catch (e) {
      logger.error("server error", { error: String(e) });
      if (!res.writableEnded) res.writeHead(500).end("internal error");
    }
  });

  server.listen(PORT, HOST, () => {
    logger.info("DevRecap listening", { url: `http://${HOST}:${PORT}` });
    process.stdout.write(`\n  DevRecap → http://${HOST}:${PORT}\n\n`);
  });

  const shutdown = () => {
    logger.info("shutting down");
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 1000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
