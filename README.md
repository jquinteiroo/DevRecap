# DevRecap

**Local-first, privacy-conscious, evidence-based developer work summaries.**

DevRecap reconstructs what you actually worked on from your AI coding-assistant
history (OpenAI Codex) and Git activity, and turns it into reports for standups,
weekly/sprint reviews, monthly summaries, performance reviews, and personal
journals — every item traceable to the evidence that produced it.

---

## The one rule that governs everything

> **DevRecap analyzes documents you give it. It does not connect to your
> development tools.**

DevRecap **never**:
- discovers, opens, watches, or scans `~/.codex`, session folders, Codex config,
  processes, or databases;
- reads your Git repositories or runs `git`;
- installs anything into Codex, or runs background sync / watchers;
- sends raw imported content anywhere automatically.

The **only** way data enters DevRecap is a file **you explicitly import**. If you
didn't provide the file, DevRecap can't access it. Imported files are copied into
DevRecap's own local storage and the originals are never modified.

---

## How it works

```
You provide files (.jsonl/.json/.txt/.gz/.zip)
        ↓  (explicit upload — nothing else is ever read)
Import  →  file-type detect  →  decompress (gz/zip)  →  SHA-256 dedup
        ↓
Format detection + safe parser (Codex JSONL / git-log text / generic)
        ↓
Classified events  →  Normalizer  →  task candidates
        ↓
Activity engine (group · classify · confidence · evidence)
        ↓
Evidence-backed Activities  →  Review  →  TopicProfiles
        ↓
Workstreams (objective-based grouping)  →  ReportContext (sanitized facts)
        ↓
Semantic composer  →  validation  →  traceable report
   (deterministic by default; optional external AI only with explicit consent)
```

Nothing is analyzed until you click **Analyze**. Reports are generated locally
and **deterministically by default**. An external AI composer is **optional**
and is only ever contacted after you **explicitly confirm** the exact sanitized
`ReportContext` shown in the preview — and it receives ONLY that structured
context (objectives, statuses, counts, technical terms), never raw sessions,
commands, file contents, or code.

---

## Quick start

Requirements: **Node.js 24 LTS** (`>=24.0.0`). DevRecap runs its `.ts` files
directly using Node's built-in type stripping — no build step, no flags — and
uses the built-in `node:sqlite`. Both are reliably available without extra
flags on Node 24. No database server, no cloud account, no authentication.

```bash
npm run setup      # link workspace packages (one-time, no registry needed)
npm run dev        # start DevRecap
# open http://localhost:3737
```

Then, in the browser:

1. Click **Import Work History** (or the **Import** tab).
2. Drag your Codex session files (`rollout-*.jsonl`, a `.zip`/`.gz` of sessions,
   or a `git log` text export) into the dropzone — or click **Select files**.
   Each file is **uploaded** (streamed to local storage) as you add it, with a
   duplicate check. **Nothing is analyzed yet.**
3. Click **Analyze** — this is the explicit step that parses the file and
   extracts activities. Each import ends in `completed`, `partial` (some
   malformed records skipped), or `failed`, with a clear message.
4. Explore the **Timeline**, triage the **Review Inbox** (uncertain activities
   land here), open **Why?** to see the deterministic reasoning behind an
   activity, and **View evidence** to trace it to the source file/session/event.
5. Generate a **Daily**, **Weekly**, or **custom-range** report under
   **Reports**. Manage or delete imports under **Import History** — deleting an
   import removes its activities, evidence, **and** DevRecap's stored file copy.

Want to try the UI without real data? Click **Load demo data** on the empty
dashboard.

### Exporting data to import

- **Codex sessions:** copy your rollout files (e.g. `~/.codex/sessions/**/rollout-*.jsonl`)
  and drop them in. You can zip or gzip them first — DevRecap unpacks archives
  into its own storage.
- **Git history (optional):** `git log --stat > git-history.txt` and import the
  text file. DevRecap parses the text; it never runs `git` itself.

---

## Scripts

| Command            | What it does                                        |
|--------------------|-----------------------------------------------------|
| `npm run dev`      | Start the local server + UI (`http://localhost:3737`) |
| `npm test`         | Run the `node:test` suite (parser, import, engine, workstreams, report composer, validation, API privacy/consent, persistence) |
| `npm run seed`     | Load demo data into the database                    |
| `npm run typecheck`| Type-check with `tsc` (requires `@types/node`)      |
| `npm run setup`    | (Re)link `@devrecap/*` workspace packages           |

Environment variables: `PORT` (default `3737`), `DEVRECAP_DATA` (data dir,
default `./data`), `DEVRECAP_DB` (SQLite path), `DEVRECAP_LOG_LEVEL`
(`debug|info|warn|error`).

---

## Supported import formats

| Format        | Notes                                                       |
|---------------|-------------------------------------------------------------|
| `.jsonl`      | Codex rollout sessions (primary)                            |
| `.json`       | Codex export wrapped as a JSON array                        |
| `.gz`         | Any of the above, gzip-compressed (auto-decompressed)       |
| `.zip`        | An archive of sessions (parsed natively; members expanded)  |
| `.txt` / git-log | `git log`/`git log --stat` text export                   |

Malformed JSONL lines are skipped and counted (the import is marked *partial*),
never aborting the whole file. Unrecognized records are preserved as `unknown`
for future parser improvements. JSONL is parsed with a **streaming** reader, so
memory use does not scale with file size.

### Import lifecycle

```
select → UPLOADED (streamed to storage, hashed)  →  you click ANALYZE
       →  PROCESSING  →  COMPLETED | PARTIAL | FAILED
```

A file is **never analyzed just because it was uploaded**. Analysis is always an
explicit action.

### Safety limits (untrusted files)

Uploads and archives are treated as untrusted. Limits are enforced while
streaming and are configurable via environment variables:

| Limit (env var) | Default | Purpose |
|-----------------|---------|---------|
| `DEVRECAP_MAX_UPLOAD_BYTES` | 200 MB | max single upload |
| `DEVRECAP_MAX_DECOMPRESSED_BYTES` | 1 GB | max gz/zip expansion |
| `DEVRECAP_MAX_ARCHIVE_ENTRIES` | 10 000 | max zip entries |
| `DEVRECAP_MAX_UNCOMPRESSED_BYTES` | 1 GB | max total zip expansion |
| `DEVRECAP_MAX_SINGLE_ENTRY_BYTES` | 512 MB | max single zip entry |
| `DEVRECAP_MAX_COMPRESSION_RATIO` | 200× | zip-bomb detection |
| `DEVRECAP_MAX_NESTING_DEPTH` | 3 | archive-in-archive guard |

ZIP-slip / path-traversal / absolute / UNC paths are rejected; encrypted entries
are skipped. Violations fail with a clear, human-readable reason.

### Activity status & confidence (conservative)

DevRecap prefers *"not sure"* over *"completed"*. A file edit or a command alone
is **not** proof of completion.

- **completed** — needs ≥ 2 independent completion signals (a Git commit, a
  passing test *after* edits, or an explicit "done" statement).
- **in_progress** — edits or a single weak signal, or a failing test.
- **blocked** — requires explicit blocker language in the session.
- **unknown** — insufficient evidence.

Confidence bands: `0.90–0.99` strong · `0.70–0.89` good · `0.40–0.69` review ·
`< 0.40` weak. Every activity records a deterministic **"Why?"** explanation
(not LLM reasoning) and links to its evidence.

---

## Architecture

Monorepo (npm workspaces). Runtime uses **Node built-ins only** in this
environment — `node:sqlite`, `node:http`, `node:test`, `node:zlib`, `fetch` —
so it runs with **zero third-party installs**. The code is structured to migrate
cleanly to the canonical stack (React + Vite + Tailwind + Prisma + Zod); see
`.kiro/specs/devrecap/design.md` §2.

```
apps/
  server/    node:http API + import orchestrator (store, import, api, index)
  web/       dependency-free ESM UI (Dashboard, Timeline, Review, Import,
             Import History, Projects, Reports, Search, Settings)
packages/
  shared/          types · db (node:sqlite) · migrations · settings · util · validate
  import-core/     file-type detect · gz/zip decompress · dedup · storage
  codex-parser/    CodexExportAdapter + defensive JSONL/JSON content parser
  git-parser/      GitLogAdapter — parses `git log` TEXT (never runs git)
  activity-engine/ normalize · group · classify · confidence · evidence · TopicProfiles
  report-engine/   workstreams · ReportContext · deterministic + optional
                   semantic composer (OpenAI/Ollama) · validation · redaction
data/
  devrecap.db          SQLite (gitignored)
  imports/<importId>/  verbatim copies of the files you imported (gitignored)
fixtures/          sanitized sample exports for tests
tests/             node:test suites
```

### Privacy & evidence

- **Redaction:** API keys, tokens, passwords, private keys, DB connection
  strings, and `.env`-style secrets are masked as `[REDACTED]` before anything
  is shown in a report or sent to an external provider.
- **Sanitized composer input (`ReportContext`):** the only thing any composer
  sees is a distilled, structured snapshot — objectives, statuses, confidence,
  short summaries, technical terms, and file/error/test **counts**. It never
  contains raw sessions, full command output, source code, credentials, or the
  paths/commands that appear inside imported files.
- **Explicit consent for external AI (server-enforced):** when a report uses an
  external composer, the server refuses to send anything (`HTTP 409`) unless the
  request carries a consent token matching the exact `ReportContext` digest the
  user previewed. The deterministic (local) path needs no consent. This is not a
  UI convention — accidental external calls are blocked at the API.
- **API key handling:** the OpenAI key is never returned to the browser (only a
  masked hint + "configured" flag) and never logged. Saving settings without a
  key preserves the existing one. The recommended, most secure option is the
  `DEVRECAP_OPENAI_API_KEY` environment variable, which is never written to the
  database. (A key entered in the UI is stored in the local SQLite file in
  plaintext — the env var avoids that.)
- **Payload preview:** you can inspect the exact sanitized `ReportContext` that
  would be sent to an external AI provider before it is sent.
- **Evidence & traceability:** every activity links back to the imported
  document, session, and the specific events (messages, commands, edits, test
  runs, commits) that justify it; every report section keeps its source
  workstream + activity IDs. Deleting an import cascades to its activities and
  evidence.

---

## Status

The full pipeline is implemented and tested end to end:
**import → parse → classified events → task candidates → evidence-backed
Activities → TopicProfiles → objective-based Workstreams → sanitized
ReportContext → deterministic (or optional, consent-gated semantic) composer →
validation → traceable report.**

- Deterministic report generation is the default and the source of truth.
- The optional external semantic composer (OpenAI-compatible / Ollama) is fully
  implemented behind the `SemanticReportComposer` interface. It is **off unless
  configured** and is **only invoked after explicit, payload-matching user
  consent**; its output is validated and safely falls back to the deterministic
  composer on any validation failure or network error.

See `.kiro/specs/devrecap/tasks.md` for the implemented milestones.

> Note on the build environment: this repo's runtime deliberately depends only
> on Node.js built-ins because the environment it was authored in blocks the npm
> registry. `package.json` declares the intended canonical dependencies for a
> normal environment under `canonicalDependencies`.
