# DevRecap — Technical Design

## 1. Architecture overview

DevRecap is a local monorepo with a thin Node backend, an embedded SQLite
database, and a browser UI. **It is manual-import only**: the sole way data
enters the system is a file the user explicitly uploads. There is no discovery,
scanning, watching, or connection to any developer tool. The high-value core is
the **import → detect → decompress → parse → raw events → activity → evidence →
report** pipeline; the UI is a client over a local HTTP API.

```
   User-provided files (.jsonl/.json/.txt/.gz/.zip)
                        │  (explicit upload — nothing else is ever read)
                        ▼
        ┌────────────────────────────────────────────┐
        │ Import Pipeline                              │
        │  file-type detect · decompress (gz/zip)      │
        │  → import storage (copy) · SHA-256 dedup     │
        └───────────────┬────────────────────────────┘
                        │ decompressed member files
                        ▼
        ┌────────────────────────────────────────────┐
        │ Import Adapters (content → RawEvent[])       │
        │  CodexExportAdapter · GitLogAdapter          │
        │  GenericTextAdapter   (detect by content)    │
        └───────────────┬────────────────────────────┘
                        │ RawEvent[]  (linked to import id)
                        ▼
        ┌────────────────────────────────────────────┐
        │ Normalizer → Activity Engine                 │
        │  grouping · classify · confidence            │
        │  evidence linking · in-log git correlation   │
        └───────────────┬────────────────────────────┘
                        ▼
        ┌──────────────┐   ┌──────────────────────────────┐
        │  SQLite DB   │◀─▶│  Report Engine                │
        │ (node:sqlite)│   │  TopicProfiles · Workstreams · │
        │              │   │  ReportContext · deterministic │
        │              │   │  or optional semantic composer │
        │              │   │  · validation                  │
        └──────┬───────┘   └────────────┬─────────────────┘
               │                         │ (sanitized ReportContext only,
     HTTP API (node:http)                 │  external only w/ explicit consent)
               │                  Redaction / composer transport (fetch)
               │
               ▼
           Web UI (browser)   — Dashboard · Timeline · Activities ·
                                Reports · Imports · Projects · Settings
```

### 1a. Privacy boundary (enforced)
The only filesystem paths DevRecap reads are (a) files handed to the import
endpoint by the user and (b) DevRecap's own application-data / import-storage
directory. It never enumerates, watches, or opens anything else. Paths found
*inside* imported documents (e.g. a Codex `cwd`) are treated as opaque metadata
strings and are never visited.

## 2. Stack decision (and deviation rationale)

**Requested stack:** TypeScript, React, Vite, Node, SQLite, Prisma, Tailwind,
shadcn/ui, Zod.

**Constraint discovered in this environment:** the npm registry and public CDNs
are blocked (HTTP 403 through the sandbox proxy), so no third-party packages can
be installed or loaded. To deliver an app that **actually runs and is verified
here**, the runtime uses **Node built-ins only** and targets **Node 24 LTS**
(`engines.node >= 24.0.0`), where the features it relies on are available
without extra flags:

| Requested            | Used here (built-in)        | Migration path                         |
|----------------------|-----------------------------|----------------------------------------|
| Prisma + better-sqlite3 | `node:sqlite`            | `packages/shared/db` isolates SQL; swap driver |
| Express              | `node:http`                 | Router is framework-agnostic           |
| Vitest / Jest        | `node:test` + `node:assert` | Same test files, change runner          |
| Zod                  | hand-written validators in `shared/validate` | replace with Zod schemas |
| React + Vite + Tailwind | dependency-free ESM UI + utility CSS | components/store map 1:1 to React |

The **architecture is identical** to the canonical stack; only concrete
libraries differ. `package.json` declares the canonical dependencies so that in
an unrestricted environment the project can migrate incrementally. Every
deviation is localized behind an interface (`db`, `httpRouter`, `validate`,
`ui/runtime`) so a swap is mechanical, not a rewrite.

Language: TypeScript authored as ESM. To avoid a bundler/transpiler dependency,
we run `.ts` files **directly** via Node's built-in type stripping — on Node 24
this is on by default (no `--experimental-strip-types` flag), so the type
annotations must stay strippable (no runtime-only TS features: no `enum`,
parameter properties, or namespaces). The UI ships as plain ESM (`.mjs`). `tsc`
provides optional type-checking. Cross-platform CI (windows-latest +
ubuntu-latest, Node 24) runs `npm run setup` + `npm test` + a health smoke.

## 3. Database model (SQLite)

All timestamps stored as ISO-8601 UTC strings (sortable) plus an integer epoch
column where range queries matter.

```
settings(key TEXT PK, value TEXT)              -- JSON values

imports(                                        -- one row per USER-PROVIDED file
  id TEXT PK, batch_id TEXT,                      -- batch groups a multi-file upload
  original_filename TEXT, file_type TEXT,        -- jsonl|json|gz|zip|txt
  stored_path TEXT,                              -- copy inside import storage
  size INTEGER, hash TEXT,                        -- SHA-256 of raw bytes (dedup)
  status TEXT,                                    -- pending|processing|completed|partial|failed
  detected_format TEXT,                           -- codex|git-log|generic|unknown
  event_count INTEGER, activity_count INTEGER,
  error_count INTEGER, warning_count INTEGER,
  error TEXT, imported_at TEXT)

sessions(                                        -- one Codex rollout (per import member)
  id TEXT PK,                                    -- codex session id (payload.id) or derived
  import_id TEXT,                                 -- FK → imports (cascade delete)
  source_member TEXT,                             -- filename within a zip, if any
  cwd TEXT, cli_version TEXT, model TEXT,
  git_branch TEXT, git_commit TEXT,
  started_at TEXT, ended_at TEXT, event_count INTEGER)

raw_events(                                      -- never dropped; audit trail
  id TEXT PK, session_id TEXT,
  import_id TEXT,                                 -- FK → imports (cascade delete)
  seq INTEGER,                                    -- line index within file
  ts TEXT, ts_epoch INTEGER,
  root_type TEXT, payload_type TEXT,             -- unknown types preserved
  role TEXT, tool_name TEXT,
  raw TEXT)                                      -- verbatim JSON line

projects(
  id TEXT PK, name TEXT, display_name TEXT,
  type TEXT,                                     -- work|personal|university|other
  root_path TEXT, git_remote TEXT,
  detected_from TEXT, created_at TEXT)

repositories(
  id TEXT PK, project_id TEXT, root_path TEXT UNIQUE,
  git_remote TEXT, default_branch TEXT,
  last_scanned_at TEXT, last_commit_hash TEXT)

commits(
  id TEXT PK,                                    -- <repo_id>:<hash>
  repository_id TEXT, project_id TEXT,
  hash TEXT, author_name TEXT, author_email TEXT,
  committed_at TEXT, committed_epoch INTEGER,
  message TEXT, branch TEXT, files_json TEXT)    -- changed files as JSON

activities(
  id TEXT PK, source TEXT, project_id TEXT,
  import_id TEXT,                                 -- FK → imports (cascade delete; null for manual)
  started_at TEXT, ended_at TEXT,
  started_epoch INTEGER, ended_epoch INTEGER,
  category TEXT, title TEXT, summary TEXT,
  status TEXT, confidence REAL,
  review_state TEXT,                             -- pending|approved|ignored|edited|merged
  merged_into TEXT,                              -- activity id if merged
  metadata TEXT, created_at TEXT, updated_at TEXT)

evidence(
  id TEXT PK, activity_id TEXT,
  kind TEXT,                                     -- codex_message|shell_command|
                                                 -- edited_file|test_run|git_commit|
                                                 -- git_diff|manual_note|error
  ref_type TEXT, ref_id TEXT,                    -- e.g. raw_event / commit id
  label TEXT, detail TEXT,                       -- human-readable
  ts TEXT, ts_epoch INTEGER)

reports(
  id TEXT PK, kind TEXT,                          -- help_me_remember|daily|weekly|custom|monthly|review|executive
  style TEXT, length TEXT, language TEXT,
  provider TEXT,                                  -- composer name (e.g. "deterministic")
  range_start TEXT, range_end TEXT,
  filters_json TEXT, content TEXT,                -- generated text
  input_json TEXT,                                -- deterministic input snapshot
  created_at TEXT)
```

### Indexes
- `raw_events(session_id)`, `raw_events(ts_epoch)`, `raw_events(payload_type)`
- `activities(project_id)`, `activities(started_epoch)`,
  `activities(source)`, `activities(review_state)`, `activities(status)`
- `evidence(activity_id)`
- `commits(project_id)`, `commits(committed_epoch)`, `commits(repository_id)`
- `sessions(source_id)`, `sessions(started_at)`

Migrations: numbered SQL applied in order; `settings('schema_version')` tracks
the applied version.

## 4. Import-adapter interfaces

Adapters consume the **content** of a user-provided file. They never discover,
open, watch, or connect to the originating tool.

```ts
interface RawEvent {
  sessionId?: string;
  seq: number;
  ts?: string;
  rootType: string;      // 'session_meta' | 'response_item' | 'event_msg' | ...
  payloadType?: string;  // 'message' | 'function_call' | ... | 'unknown'
  role?: string;
  toolName?: string;
  cwd?: string;
  data: unknown;         // parsed payload
  raw: string;           // verbatim line
}

interface ImportSourceAdapter {
  readonly kind: string;                       // 'codex' | 'git-log' | 'generic'
  detect(content: string, filename: string): number;   // 0..1 confidence
  parseContent(content: string): { events: RawEvent[]; malformed: number; sessionId?: string };
}
```

Adapters (MVP): `CodexExportAdapter`, `GitLogAdapter`, `GenericTextAdapter`.
Future: `ClaudeCodeExportAdapter`, `KiroExportAdapter`, `CursorExportAdapter`,
`GeminiExportAdapter` — each consumes user-provided exports only, never
connecting to the source application. The import orchestrator runs every
adapter's `detect()` and routes content to the highest scorer (or the
user-selected format).

### 4a. Streaming upload, storage & decompression
Uploads are **streamed** — never base64-encoded, never held whole in memory:

1. `POST /api/imports/upload` receives the **raw binary body** (`postRaw`
   route; the router does not buffer/parse it). Filename via `?filename=` or
   the `X-Filename` header.
2. The body streams to a temp file while a SHA-256 is computed incrementally and
   `MAX_UPLOAD_BYTES` is enforced mid-stream (the socket is destroyed and the
   partial file discarded on overflow — the whole upload is never retained).
3. On success the temp file is atomically renamed into
   `<dataDir>/imports/<importId>/<sanitized-filename>`. Originals are never
   modified. Filenames are sanitized (path components, control chars, and
   leading dots stripped); a user-supplied path is never trusted.
4. Duplicate detection uses the streamed hash: an identical prior import short-
   circuits (no second copy stored) unless `allowDuplicates=true`.

Decompression is bounded and, where possible, streamed:
- `.gz` is stream-decompressed at parse time
  (`createReadStream → createGunzip → readline`), enforcing
  `MAX_DECOMPRESSED_BYTES` mid-stream.
- `.zip` is expanded by parsing the end-of-central-directory + central directory
  and inflating STORE (0) / DEFLATE (8) members with `node:zlib.inflateRawSync`
  — no external unzip binary, portable to Windows/WSL/Linux. Members are written
  to `<importDir>/members/` and streamed from disk at parse time.

### 4b. Untrusted-archive safety limits (documented & configurable)
All limits live in `packages/import-core/src/limits.ts` and are overridable via
`DEVRECAP_*` environment variables. Violations raise `ImportLimitError` with a
clear reason surfaced to the user.

| Limit | Default | Purpose |
|-------|---------|---------|
| `MAX_UPLOAD_BYTES` | 200 MB | reject oversized uploads (mid-stream) |
| `MAX_DECOMPRESSED_BYTES` | 1 GB | cap gz/zip expansion |
| `MAX_ARCHIVE_ENTRIES` | 10 000 | cap zip entry count |
| `MAX_UNCOMPRESSED_BYTES` | 1 GB | cap total zip expansion |
| `MAX_SINGLE_ENTRY_BYTES` | 512 MB | cap any single entry |
| `MAX_COMPRESSION_RATIO` | 200× | zip-bomb detection (above `RATIO_MIN_COMPRESSED_BYTES` = 4 KB) |
| `MAX_NESTING_DEPTH` | 3 | archive-in-archive guard |

Additional archive protections: **ZIP-slip / path traversal** (`..`), absolute
paths, Windows drive paths, and UNC paths are rejected (`safeArchiveName`);
**encrypted entries** are skipped with a reason (never decrypted); directory,
`__MACOSX`, and hidden entries are skipped. An archive entry can never be
written outside DevRecap's own import directory.

### 4c. Import lifecycle (explicit analyze)
```
FILE SELECTED → UPLOADED (stored, hashed; status 'uploaded')
             → user clicks ANALYZE
             → PROCESSING → COMPLETED | PARTIAL | FAILED
```
A file is **never analyzed just because it was uploaded**. `POST
/api/imports/:id/analyze` is an explicit user action. `partial` means some
malformed records were skipped (with a per-file warning); `failed` means no
parseable events were produced. Every state is shown in Import History.

## 5. Raw event → normalized event → activity

```ts
type NormalizedEventKind =
  | 'user_request' | 'assistant_action' | 'shell_command'
  | 'file_edit' | 'test_run' | 'error' | 'git_op' | 'note';

interface NormalizedEvent {
  sessionId?: string;
  ts: string; tsEpoch: number;
  kind: NormalizedEventKind;
  cwd?: string;
  text?: string;          // request text / message
  command?: string;       // shell command
  files?: string[];       // edited/affected files
  passed?: boolean;       // test result if known
  rawEventSeq: number;    // link back to raw_events.seq
}
```

**Normalizer** maps Codex payloads:
- `response_item.message role=user` → `user_request`
- `response_item.message role=assistant` → `assistant_action`
- `function_call name in {shell, local_shell_call}` → parse `arguments.command`
  → `shell_command`; classify command (test runner, git, edit heuristics)
- `apply_patch` / edit tools / write commands → `file_edit` (extract paths)
- shell output / assistant text matching error patterns → `error`
- git subcommands → `git_op`

Content extraction handles both `content: [{type,text}]` arrays and plain-string
content.

**Activity Engine** (deterministic first):
1. Split a session's normalized events into **segments** by time gaps and by
   `user_request` boundaries (a new user request usually starts a new work unit).
2. Within a segment, collect files, commands, tests, errors, git ops.
3. **Classify category** from signals (tests→testing, git→git, error+edit→bugfix,
   new files→feature, rename/move→refactor, docs paths→documentation, etc.).
4. **Title/summary** deterministically from dominant files + verbs + git message.
5. **Confidence** = weighted sum of evidence strength (see §7).
6. **Evidence** rows created for every contributing signal.
7. **Git correlation**: match commits by cwd/repo + time window + file overlap +
   message similarity → attach `git_commit` evidence and raise confidence.

## 6. Grouping & merging heuristics

Merge candidate activities when they share: same project, time proximity
(default ≤ 20 min gap), overlapping files (Jaccard ≥ 0.3), or a common git
commit. Merged activities keep all evidence; the merge is reversible via
`review_state`/`merged_into`.

## 6b. Activity Extraction V2 (event classification → TaskCandidate → Activity)

An **Activity is meaningful work, not a Codex message.** Extraction runs in
stages (all deterministic, no AI):

1. **Event classification** (`classify.ts`, `classifyRawEvent`). Every RawEvent
   is tagged with an `EventClass` and a `noise` flag:
   `USER_INTENT · ASSISTANT_SUMMARY · FILE_READ · FILE_EDIT · COMMAND ·
   COMMAND_RESULT · TEST_RUN · TEST_RESULT · ERROR · GIT_EVENT · SYSTEM_CONTEXT
   · SESSION_METADATA · TOOL_METADATA · NOISE · UNKNOWN`.
   Infrastructure NOISE — `<environment_context>`, injected `<user_instructions>`
   / system / developer messages, SKILL.md loading, "Codex resume" / session
   bootstrap, `session_meta`, `turn_context`, `token_count` — is flagged and
   **never** becomes an activity (it remains available only as raw evidence).

2. **Normalization** (`StreamingNormalizer`). Meaningful events are mapped to a
   work vocabulary. File involvement carries a `fileOp`:
   `edit`/`create`/`delete` (real work, from write/edit tools & edit commands),
   `read` (grep/cat/read tools & read commands), or `mention` (named in prose —
   **never** counted as work). This fixes the "Touched 42 files (SKILL.md…)"
   class of bug: a file that was only read or mentioned is not a modification.

3. **Task segmentation → `TaskCandidate`** (`engine.ts`). Events are grouped into
   task windows. A *substantive* user intent (not a follow-up) or a long idle
   gap opens a new candidate; follow-ups ("try again", "run the tests", "yes",
   "still not working") stay in the current task. A `TaskCandidate` accumulates
   `intents · filesRead/Modified/Created/Deleted/Mentioned · commands · tests ·
   errors · gitOps · assistantSummaries`.

4. **Candidate → Activity** (`finalizeCandidate`). A candidate with no real work
   signal (e.g. a bare question with no follow-through) produces **nothing**.
   Title/summary are derived from the user's intent plus *confirmed* evidence
   (never from a merely-mentioned file, never "Implemented SKILL.md").

A user prompt is **intent, not completion**: "Can I remove the folder?" with no
subsequent removal yields no completed activity. Quality over quantity — a long
session should yield a few meaningful activities, not dozens of event-shaped
ones.

## 7. Activity status, confidence & reasoning (conservative)

DevRecap prefers "I am not sure" over "The developer completed this" when
evidence is weak. `assess(candidate)` returns `{status, confidence, reasons[]}`;
`reasons` are stored in `metadata.reasoning` and shown via a "Why?" toggle —
**deterministic evidence explanations, never LLM output.**

### Status rules
| Status | Required evidence |
|--------|-------------------|
| `completed` | Strong completion: a passing test **after** edits, OR a Git commit, OR explicit "done/works now" language **with** an edit |
| `in_progress` | Real work occurred (edits, reads, commands, tests, or errors) but completion is not proven |
| `blocked` | The **task itself** ends blocked: explicit blocker language *and* no resolving edit/commit/passing-test afterwards |
| `unknown` | Insufficient evidence to determine outcome |

A lone file edit, a single shell command, opening/reading a file, or an
*incidental* error during debugging does **not** prove completion — and a
mid-task command failure that is later fixed resolves to `completed`, **not**
`blocked`. `blocked` is never derived from an arbitrary error.

### Confidence bands (reflect evidence strength)

| Range | Meaning |
|-------|---------|
| 0.90–0.99 | Strong evidence from multiple corroborating signals |
| 0.70–0.89 | Good evidence, minor uncertainty |
| 0.40–0.69 | Suggestive but requires review |
| < 0.40 | Weak / ambiguous; should not be promoted automatically |

Confidence measures **how well the reconstruction matches real work**, not the
number of events. Structural caps: `unknown` ≤ 0.35; `in_progress` without a
commit or passing test ≤ 0.72 (≤ 0.5 when there were no edits and no tests).
Activities below `reviewThreshold` (default 0.5) route to the Review Inbox;
noise never enters the inbox, and no-work candidates are discarded entirely.

### Deletion
Deleting an import removes **both** the database rows (cascade: sessions,
raw_events, commits, activities → evidence) **and** the physical
`data/imports/<importId>/` directory. The operation is idempotent: if the
directory is already gone, DB cleanup still runs. Real filesystem errors are
reported (not silently swallowed) via `DeleteImportResult.fileError`.

## 8. Report engine (semantic composer pipeline)

Report kinds: `help_me_remember | daily | weekly | custom | monthly | review |
executive`. The pipeline is:

```
approved Activities (in range)
   → buildReportInput  ──►  ReportInput   (deterministic, redacted snapshot:
                                            project groups, TopicProfiles,
                                            objective-based Workstreams, timeline)
   → buildReportContext ─►  ReportContext (SANITIZED structured facts only)
   → SemanticReportComposer.compose(context) → StructuredReport
   → validateComposedReport → (ok) report | (fail) deterministic fallback
```

**Objective-based Workstreams.** `buildReportInput` clusters activities into
workstreams named by their **objective** (WHY the work existed), derived from
each activity's `TopicProfile` (domain terms · technologies · components ·
objective). A workstream is never named after a technology collection ("VUE &
PDF") or a generic word; technologies are surfaced separately as *technical
areas*. Status aggregates conservatively (a completed + an in-progress member →
`partially_completed`).

**`ReportContext` (the only thing a composer sees).** A distilled, sanitized
snapshot: per-activity objective, category, status, confidence, one-line
summary, technical terms, file/error/test **counts**, and real start/end times;
workstreams with their member `activityIds`; the period's technical areas; and
the objectives left open. It contains **no** raw sessions, full command output,
source code, credentials, or the paths/commands found inside imported files.

```ts
interface SemanticReportComposer {
  readonly name: string;
  readonly external: boolean;                 // true ⇒ leaves the machine
  compose(context: ReportContext): Promise<StructuredReport>;
}
```

- **`DeterministicComposer`** — default, local, offline, always valid; the
  source of truth (template rendering per style/length; spoken mode optimized
  for reading aloud within a duration budget).
- **External composer** (`openai` | `ollama`, via `fetch`) — optional; receives
  **only** the `ReportContext` (built by `composePrompt`), never a raw input.
  `selectComposer(settings)` returns deterministic unless one is explicitly
  configured.
- **`composeReport(composer, input, context)`** runs the composer, validates the
  result, and falls back to the deterministic composer on any validation failure
  or network error — so a report is always valid and traceable.

**Validation (`validateComposedReport`)** rejects: empty content, generic or
duplicate headings, references to unknown workstreams/activities, fabricated
technical terms (not in the context), invented next-steps/plans, and
**per-workstream completion lies** — a composer may not claim an *unfinished*
workstream is done just because a *different* workstream in the same report is
(prose is attributed to each section by heading and checked per workstream).

**Consent (server-enforced, see §10).** When the selected composer is external,
the API refuses to send anything unless the request carries a consent token that
matches the exact previewed `ReportContext` digest (`reportContextDigest`,
excluding volatile fields). The deterministic path needs no consent.

## 9. Privacy / redaction

`redact(text)` applies ordered regex rules for: OpenAI/generic API keys, bearer
tokens, AWS keys, private key blocks, JWTs, DB connection strings (`postgres://`,
`mysql://`, `mongodb://` with creds), `password=`/`secret=` assignments, `.env`
style secrets. Replaces the sensitive span with `[REDACTED]`. The payload
preview shows exactly the sanitized `ReportContext` that would be sent.

**API key handling.** The OpenAI API key is never returned to the browser — the
settings endpoint exposes only `openaiApiKeySet` + a masked hint
(`redactSettings`) — and is never logged. Saving settings without a key
preserves the stored one; `clearOpenaiApiKey:true` removes it. The recommended
secure option is the `DEVRECAP_OPENAI_API_KEY` environment variable, which takes
precedence and is **never** written to SQLite. A key entered in the UI is stored
in the local SQLite file in plaintext (the env var avoids that).

## 10. HTTP API (node:http)

REST-ish JSON, all under `/api`:
- `GET  /api/health`
- `GET  /api/settings` (returns a redacted view — never the raw API key) ·
  `POST /api/settings` (omitted/empty key preserves; `clearOpenaiApiKey:true`
  clears)
- `POST /api/imports/upload` (raw streaming binary body; `?filename=` /
  `X-Filename`; `?allowDuplicates`) → stores file as `uploaded`, no analysis
- `GET  /api/imports/check?hash=` (pre-upload duplicate probe)
- `POST /api/imports/:id/analyze` (explicit analysis of an uploaded import)
- `GET  /api/imports` (history) · `GET /api/imports/:id`
- `DELETE /api/imports/:id` (cascade DB + physical dir; reports `filesRemoved`
  / `fileError`)
- `GET  /api/projects` · `PATCH /api/projects/:id`
- `GET  /api/activities` (filters) · `PATCH /api/activities/:id` (review) ·
  `POST /api/activities` (manual) · `POST /api/activities/merge`
- `GET  /api/activities/:id/evidence`
- `GET  /api/timeline`
- `GET  /api/dashboard`
- `GET  /api/search`
- `POST /api/reports/preview` → the exact sanitized `ReportContext` +
  `{ composer, external, requiresConsent, contextDigest, redactionCount }`
- `POST /api/reports` (generate) — an **external** composer requires
  `consent: { confirmed: true, contextDigest }` matching the previewed digest,
  else `HTTP 409 consent_required` and **no external call**; the deterministic
  path needs no consent · `GET /api/reports/:id`
- `POST /api/seed` (demo data)

Static UI served from `apps/web` at `/`.

## 11. Repository structure

```
DevRecap/
  package.json                 # workspaces + scripts (canonical deps declared)
  README.md
  apps/
    server/                    # node:http API + import orchestrator + wiring
      src/{index,http,api,store,import,seed}.ts
    web/                       # dependency-free ESM UI
      index.html · app.mjs · styles.css · lib/{dom,components,views}.mjs
  packages/
    shared/                    # types, db, validate, logger, ids, time
    codex-parser/              # CodexExportAdapter + JSONL/JSON content parser
    git-parser/                # GitLogAdapter (parses `git log` TEXT — never spawns git)
    activity-engine/           # normalize, grouping, classify, confidence, evidence, merge
    report-engine/             # workstreams · ReportContext · deterministic +
                               # optional semantic composer · validation · redaction
    import-core/               # file-type detect, gz/zip decompress, dedup, storage
  data/
    devrecap.db                # created at runtime (gitignored)
    imports/<importId>/…       # verbatim copies of user-provided files (gitignored)
  fixtures/                    # sanitized sample exports for tests
  tests/                       # node:test suites
```

## 12. Error handling & logging

Structured logger with levels `debug|info|warn|error`, JSON lines to stderr,
never logs raw session content or secrets. Import runs record per-file errors in
`imports.error` and continue. Missing or unreadable repos are skipped with a
warning.

## 13. Riskiest technical assumptions

0. **Upload transport for large files.** RESOLVED: uploads now stream the raw
   binary body straight to a temp file (`POST /api/imports/upload`), with an
   incremental SHA-256 and a mid-stream `MAX_UPLOAD_BYTES` cap — no base64, no
   whole-file buffering. ZIP central-directory parsing still requires the zip in
   memory, but the archive safety limits (§4b) bound it. A future milestone
   could add true streaming zip extraction if very large zips become common.
1. **Codex format drift.** Payload shapes vary across CLI versions
   (`function_call` vs `local_shell_call` vs `custom_tool_call`; content array
   vs string; older filenames). *Mitigation:* defensive parser keyed on presence
   of fields, not exact schema; unknown types preserved as raw events; fixtures
   for multiple shapes; malformed lines skipped and counted.
2. **File-edit detection.** Codex expresses edits via `apply_patch`, shell
   `sed`/`tee`, or tool calls; extracting affected paths is heuristic.
   *Mitigation:* multiple extractors + confidence weighting + git correlation as
   ground truth.
3. **Incremental parsing of growing JSONL.** Byte-offset resume assumes
   append-only, UTF-8, newline-terminated records. *Mitigation:* store size +
   mtime + hash; if size shrank or hash of a re-read prefix differs, re-parse
   whole file.
4. **Activity boundaries.** Deciding where one work unit ends is inherently
   fuzzy. *Mitigation:* deterministic gap/request heuristics first, Review Inbox
   for low confidence, human merge/split.
5. **Timezones.** Codex timestamps are UTC (`Z`); local reporting needs local
   day boundaries. *Mitigation:* store UTC epoch + ISO; compute day windows in
   the user's configured timezone.
6. **Git data (imported text only).** DevRecap never runs `git` and never reads
   a repository. Git information is used solely when it appears **inside**
   imported files (Git actions embedded in Codex logs, or a user-imported
   `git log` text export), parsed by `GitLogAdapter`. *Mitigation:* text parsing
   is defensive and correlation is best-effort; absent git data simply lowers
   corroboration, never blocks a report.
