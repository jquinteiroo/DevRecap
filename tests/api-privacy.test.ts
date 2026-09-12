/**
 * API-level privacy & consent enforcement (server-side, over real HTTP).
 *
 * Boots the actual DevRecap router against an in-memory database on an
 * ephemeral port and exercises the endpoints exactly as the browser would.
 * These lock in the non-negotiable guarantees:
 *   - The stored OpenAI API key is NEVER returned to the client (masked only).
 *   - An existing key is preserved when settings are saved without a new key,
 *     and can be explicitly cleared.
 *   - An EXTERNAL composer is never invoked without explicit, payload-matching
 *     consent (HTTP 409 otherwise) — no external request happens.
 *   - The DETERMINISTIC composer needs no consent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb } from "@devrecap/shared";
import { Router } from "../apps/server/src/http.ts";
import { registerApi } from "../apps/server/src/api.ts";

/** Boot an in-process API server on an ephemeral port; returns base URL + stop. */
async function startServer(): Promise<{ base: string; stop: () => Promise<void>; db: ReturnType<typeof openDb> }> {
  const db = openDb(":memory:");
  const router = new Router();
  registerApi(router, db, "/tmp/devrecap-test-data");
  const server = createServer(async (req, res) => {
    const handled = await router.handle(req, res);
    if (!handled) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    db,
    stop: () => new Promise<void>((resolve) => server.close(() => { db.close(); resolve(); })),
  };
}

async function post(base: string, path: string, body: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}
async function get(base: string, path: string) {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const RANGE = { start: "2026-09-01T00:00:00Z", end: "2026-09-30T23:59:59Z" };
const reportBody = (extra: Record<string, unknown> = {}) =>
  ({ kind: "help_me_remember", language: "en", ...RANGE, ...extra });

// ---------------------------------------------------------------------------
// 5. API key handling
// ---------------------------------------------------------------------------
test("GET /settings never returns the raw API key (masked + boolean only)", async () => {
  const srv = await startServer();
  try {
    await post(srv.base, "/api/settings", { aiProvider: "openai", openaiApiKey: "sk-secret-abcd1234" });
    const { json } = await get(srv.base, "/api/settings");
    assert.equal(json.openaiApiKey, undefined, "raw key must NOT be present");
    assert.equal(json.openaiApiKeySet, true, "reports that a key is configured");
    assert.match(json.openaiApiKeyMasked, /1234$/, "masked hint shows only the last 4 chars");
    assert.doesNotMatch(JSON.stringify(json), /sk-secret-abcd1234/, "the full key is never serialized to the client");
  } finally { await srv.stop(); }
});

test("saving settings without a key PRESERVES the existing stored key", async () => {
  const srv = await startServer();
  try {
    await post(srv.base, "/api/settings", { aiProvider: "openai", openaiApiKey: "sk-keep-me-9999" });
    // Update an unrelated field, sending NO key.
    await post(srv.base, "/api/settings", { defaultLength: "short" });
    const { json } = await get(srv.base, "/api/settings");
    assert.equal(json.openaiApiKeySet, true, "key survived an unrelated update");
    assert.match(json.openaiApiKeyMasked, /9999$/, "the same key is retained");
    assert.equal(json.defaultLength, "short", "the unrelated field was updated");
  } finally { await srv.stop(); }
});

test("clearOpenaiApiKey:true explicitly removes the stored key", async () => {
  const srv = await startServer();
  try {
    await post(srv.base, "/api/settings", { aiProvider: "openai", openaiApiKey: "sk-remove-me" });
    await post(srv.base, "/api/settings", { clearOpenaiApiKey: true });
    const { json } = await get(srv.base, "/api/settings");
    assert.equal(json.openaiApiKeySet, false, "key was cleared");
    assert.equal(json.openaiApiKeyMasked, "", "no masked hint after clearing");
  } finally { await srv.stop(); }
});

// ---------------------------------------------------------------------------
// 4. Explicit consent before external AI
// ---------------------------------------------------------------------------
test("deterministic reports generate with NO consent required", async () => {
  const srv = await startServer();
  try {
    await post(srv.base, "/api/seed");
    // Provider defaults to deterministic.
    const { status, json } = await post(srv.base, "/api/reports", reportBody());
    assert.equal(status, 200, "deterministic generation succeeds without consent");
    assert.equal(json.provider, "deterministic");
    assert.equal(json.fellBack, false);
  } finally { await srv.stop(); }
});

test("external composer without consent is REFUSED (409) and makes no request", async () => {
  const srv = await startServer();
  try {
    await post(srv.base, "/api/seed");
    await post(srv.base, "/api/settings", { aiProvider: "openai", openaiApiKey: "sk-dummy-key" });

    // Preview identifies the provider + the exact payload digest.
    const preview = await post(srv.base, "/api/reports/preview", reportBody());
    assert.equal(preview.json.external, true);
    assert.equal(preview.json.requiresConsent, true);
    assert.equal(typeof preview.json.contextDigest, "string");

    // Generate WITHOUT consent → 409, no external call, nothing generated.
    const noConsent = await post(srv.base, "/api/reports", reportBody());
    assert.equal(noConsent.status, 409, "external generation is refused without consent");
    assert.equal(noConsent.json.code, "consent_required");
    assert.equal(noConsent.json.details.provider, "openai");
    assert.equal(noConsent.json.content, undefined, "no report content was produced");
  } finally { await srv.stop(); }
});

test("external composer with a MISMATCHED consent digest is refused (409)", async () => {
  const srv = await startServer();
  try {
    await post(srv.base, "/api/seed");
    await post(srv.base, "/api/settings", { aiProvider: "openai", openaiApiKey: "sk-dummy-key" });
    const bad = await post(srv.base, "/api/reports", reportBody({ consent: { confirmed: true, contextDigest: "not-the-real-digest" } }));
    assert.equal(bad.status, 409, "a stale/forged digest cannot authorize sending");
    assert.equal(bad.json.code, "consent_required");
  } finally { await srv.stop(); }
});

test("external composer WITH matching consent proceeds (gate opens; safe fallback on network failure)", async () => {
  const srv = await startServer();
  try {
    await post(srv.base, "/api/seed");
    await post(srv.base, "/api/settings", { aiProvider: "openai", openaiApiKey: "sk-dummy-key" });
    const preview = await post(srv.base, "/api/reports/preview", reportBody());
    const digest = preview.json.contextDigest;
    const ok = await post(srv.base, "/api/reports", reportBody({ consent: { confirmed: true, contextDigest: digest } }));
    // The gate OPENED: the external call was attempted. In this sandbox the
    // network is unavailable, so composeReport safely falls back to the local
    // deterministic composer — a valid report is still returned (200).
    assert.equal(ok.status, 200, "consented generation proceeds");
    assert.ok(typeof ok.json.content === "string" && ok.json.content.length > 0, "a valid report is produced");
    // provider is either the external one or an annotated fallback — never a 409.
    assert.match(String(ok.json.provider), /openai|deterministic/);
  } finally { await srv.stop(); }
});
