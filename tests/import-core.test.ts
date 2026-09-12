import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, deflateRawSync } from "node:zlib";
import { rmSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectFileType, gunzip, unzip, safeArchiveName, prepareStoredImport,
  sanitizeFilename, sha256, hashFileSync, ImportLimitError,
} from "@devrecap/import-core";

const JSONL = Buffer.from(
  '{"type":"session_meta","payload":{"id":"s1","cwd":"/p"}}\n' +
  '{"type":"response_item","payload":{"type":"message","role":"user","content":"hi"}}\n',
  "utf8",
);

/** Build a minimal ZIP with configurable entries (STORE=0 / DEFLATE=8). */
function makeZip(entries: [string, Buffer, number, number?][]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const [name, data, method, flags = 0] of entries) {
    const nb = Buffer.from(name, "utf8");
    const comp = method === 8 ? deflateRawSync(data) : data;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(flags, 6); lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(comp.length, 18); lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nb.length, 26);
    chunks.push(lfh, nb, comp);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(flags, 8); cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(comp.length, 20); cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nb.length, 28); cdh.writeUInt32LE(off, 42);
    central.push(cdh, nb);
    off += lfh.length + nb.length + comp.length;
  }
  let cdLen = 0;
  for (const c of central) cdLen += c.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdLen, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, ...central, eocd]);
}

// --- detection & decompression ---------------------------------------------

test("detectFileType uses magic bytes over extension", () => {
  assert.equal(detectFileType("x.jsonl", JSONL), "jsonl");
  assert.equal(detectFileType("mislabeled.txt", gzipSync(JSONL)), "gz");
  assert.equal(detectFileType("mislabeled.txt", makeZip([["a.jsonl", JSONL, 0]])), "zip");
  assert.equal(detectFileType("notes.txt", Buffer.from("hello")), "txt");
});

test("gunzip round-trips", () => {
  assert.equal(gunzip(gzipSync(JSONL)).toString("utf8"), JSONL.toString("utf8"));
});

test("unzip extracts STORE and DEFLATE members, skips directories", () => {
  const zip = makeZip([["sessions/a.jsonl", JSONL, 0], ["sessions/b.jsonl", JSONL, 8]]);
  const { members } = unzip(zip);
  assert.equal(members.length, 2);
  assert.deepEqual(members.map((m) => m.name).sort(), ["sessions/a.jsonl", "sessions/b.jsonl"]);
});

// --- ZIP security ----------------------------------------------------------

test("safeArchiveName rejects traversal, absolute, drive, and UNC paths", () => {
  assert.equal(safeArchiveName("../../etc/passwd"), null);
  assert.equal(safeArchiveName("/etc/passwd"), null);
  assert.equal(safeArchiveName("C:/windows/system32"), null);
  assert.equal(safeArchiveName("\\\\server\\share"), null);
  assert.equal(safeArchiveName("a/../../b"), null);
  assert.equal(safeArchiveName("sessions/./rollout.jsonl"), "sessions/rollout.jsonl");
});

test("unzip throws ImportLimitError on a ZIP-slip entry", () => {
  const zip = makeZip([["../evil.jsonl", JSONL, 0]]);
  assert.throws(() => unzip(zip), (e: unknown) => e instanceof ImportLimitError && (e as ImportLimitError).code === "ZIP_SLIP");
});

test("unzip skips encrypted entries with a reason (does not throw)", () => {
  const GP_ENCRYPTED = 0x0001;
  const zip = makeZip([["secret.jsonl", JSONL, 0, GP_ENCRYPTED], ["ok.jsonl", JSONL, 0]]);
  const { members, skipped } = unzip(zip);
  assert.equal(members.length, 1);
  assert.equal(members[0].name, "ok.jsonl");
  assert.ok(skipped.some((s) => /encrypted/i.test(s.reason)));
});

test("unzip handles a multi-entry archive within limits", () => {
  const zip = makeZip([["a.jsonl", JSONL, 0], ["b.jsonl", JSONL, 0], ["c.jsonl", JSONL, 8]]);
  const { members } = unzip(zip);
  assert.equal(members.length, 3);
});

test("unzip detects a compression-ratio bomb", () => {
  // 8 MB of zeros compresses to ~8 KB (above the min-compressed threshold) →
  // ratio ~1028x, far above the 200x limit → rejected as a zip-bomb.
  const bomb = Buffer.alloc(8 * 1024 * 1024, 0);
  const zip = makeZip([["bomb.jsonl", bomb, 8]]);
  assert.throws(() => unzip(zip), (e: unknown) => e instanceof ImportLimitError && (e as ImportLimitError).code === "MAX_COMPRESSION_RATIO");
});

// --- filename sanitization -------------------------------------------------

test("sanitizeFilename strips paths, control chars, and leading dots", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("/abs/rollout.jsonl"), "rollout.jsonl");
  assert.equal(sanitizeFilename("weird\u0000name.jsonl"), "weirdname.jsonl");
  assert.equal(sanitizeFilename("...hidden"), "hidden");
  assert.equal(sanitizeFilename(""), "upload.bin");
  assert.ok(!sanitizeFilename("a".repeat(500)).includes("/"));
});

// --- hashing ---------------------------------------------------------------

test("sha256 and streaming hashFileSync agree", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-hash-"));
  try {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, JSONL);
    const inMem = sha256(JSONL);
    const streamed = hashFileSync(p);
    assert.equal(streamed.hash, inMem);
    assert.equal(streamed.size, JSONL.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- prepareStoredImport (file-based expansion) ----------------------------

function storeFile(dir: string, importId: string, filename: string, bytes: Buffer): string {
  const impDir = join(dir, "imports", importId);
  mkdirSync(impDir, { recursive: true });
  const p = join(impDir, filename);
  writeFileSync(p, bytes);
  return p;
}

test("prepareStoredImport: plain jsonl → single streamable member (path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-prep-"));
  try {
    const stored = storeFile(dir, "imp1", "rollout.jsonl", JSONL);
    const prep = prepareStoredImport(dir, "imp1", stored, "rollout.jsonl");
    assert.equal(prep.fileType, "jsonl");
    assert.equal(prep.members.length, 1);
    assert.equal(prep.members[0].path, stored);
    assert.ok(!prep.members[0].gunzip);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prepareStoredImport: zip → member files written under the import dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-prep2-"));
  try {
    const impDir = join(dir, "imports", "imp2");
    const zip = makeZip([["a/rollout-1.jsonl", JSONL, 0], ["a/rollout-2.jsonl.gz", gzipSync(JSONL), 8]]);
    const stored = storeFile(dir, "imp2", "sessions.zip", zip);
    const prep = prepareStoredImport(dir, "imp2", stored, "sessions.zip");
    assert.equal(prep.fileType, "zip");
    assert.equal(prep.members.length, 2, "both members expanded (gz decompressed)");
    for (const m of prep.members) {
      assert.ok(m.path && existsSync(m.path), "member written to disk");
      assert.ok(m.path.startsWith(impDir), "member stays inside the import directory");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prepareStoredImport: gz → single streamable member with gunzip flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-prep3-"));
  try {
    const stored = storeFile(dir, "imp3", "rollout.jsonl.gz", gzipSync(JSONL));
    const prep = prepareStoredImport(dir, "imp3", stored, "rollout.jsonl.gz");
    assert.equal(prep.fileType, "gz");
    assert.equal(prep.members.length, 1);
    assert.equal(prep.members[0].gunzip, true);
    assert.equal(prep.members[0].path, stored);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
