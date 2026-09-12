/**
 * Tiny HTTP router over node:http. Framework-agnostic so it can be replaced by
 * Express in the canonical stack without touching handlers. Supports path
 * params (:id), JSON body parsing, and JSON responses.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { ValidationError, logger } from "@devrecap/shared";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; parts: string[]; handler: Handler; raw?: boolean; }

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler, raw = false): void {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler, raw });
  }
  get(p: string, h: Handler) { this.add("GET", p, h); }
  post(p: string, h: Handler) { this.add("POST", p, h); }
  patch(p: string, h: Handler) { this.add("PATCH", p, h); }
  delete(p: string, h: Handler) { this.add("DELETE", p, h); }
  /** Register a POST route that receives the RAW request stream (no JSON body
   *  buffering) — used for streaming binary uploads. */
  postRaw(p: string, h: Handler) { this.add("POST", p, h, true); }

  private match(method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = pathname.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const rp = route.parts[i];
        if (rp.startsWith(":")) params[rp.slice(1)] = decodeURIComponent(parts[i]);
        else if (rp !== parts[i]) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return undefined;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = this.match(req.method ?? "GET", url.pathname);
    if (!m) return false;

    let body: unknown = undefined;
    // Raw routes receive the request stream directly (streaming uploads).
    if (!m.route.raw && (req.method === "POST" || req.method === "PATCH")) {
      body = await readJson(req);
    }
    const ctx: Ctx = { req, res, params: m.params, query: url.searchParams, body };
    try {
      const result = await m.route.handler(ctx);
      if (!res.writableEnded) sendJson(res, 200, result ?? { ok: true });
    } catch (e) {
      // Any error may carry an HTTP `status` (ValidationError=400,
      // ConsentRequiredError=409, …). Structured errors may also expose a
      // machine-readable `code` and `details` for the client to react to.
      const err = e as { status?: number; code?: string; details?: unknown };
      const status = typeof err.status === "number" ? err.status : 500;
      if (status >= 500) logger.error("route error", { path: url.pathname, error: String(e) });
      const payload: Record<string, unknown> = { error: e instanceof Error ? e.message : String(e) };
      if (typeof err.code === "string") payload.code = err.code;
      if (err.details && typeof err.details === "object") payload.details = err.details;
      sendJson(res, status, payload);
    }
    return true;
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const s = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}
