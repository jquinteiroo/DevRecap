# DevRecap — Product Requirements

## 1. Vision

DevRecap is a **local-first** developer-productivity tool that reconstructs a
developer's daily/weekly work from their **AI coding-assistant history (Codex)**
and **local Git repositories**, and turns it into **evidence-backed** work
summaries usable for standups, weekly/sprint reviews, monthly summaries,
performance reviews, and personal journals.

## 2. Core principles (non-negotiable)

0. **Manual import only — no tool connection.** This is the primary design rule:
   **DevRecap analyzes documents the user gives it; it does not connect to the
   user's development tools.** DevRecap must never automatically discover,
   access, monitor, watch, connect to, modify, or inspect a local Codex install
   (`~/.codex`, sessions, config, processes, databases), Git repositories, WSL
   directories, or any other developer-tool directory. There is no filesystem
   scanning, no directory watchers, no background sync, and no automatic import.
   **If the user did not explicitly provide the file, DevRecap cannot access it.**
1. **Local-first** — imported files are processed on the user's machine and kept
   in DevRecap's own application data directory. Originals are never modified.
2. **Privacy-conscious** — raw imported contents are never automatically sent to
   an external LLM. Only sanitized, extracted, or explicitly-approved content
   may leave the machine. No telemetry contains imported content.
3. **Evidence-based** — every activity links back to the imported document and
   the raw events that justify it. Nothing is presented as fact without evidence.
4. **No hallucinated work** — the system must not invent accomplishments that
   the source data cannot support. Deterministic extraction first; AI only
   rephrases already-extracted, evidence-backed facts.
5. **Developer-focused** — fast, lightweight, developer-tool aesthetic.

## 3. Primary personas & jobs-to-be-done

- "What did I work on today?" → **Daily standup** report.
- "What did I accomplish this week?" → **Weekly review**, grouped by project.
- "Generate a review for Aug 17–28." → **Custom date range** report.
- "What were my main accomplishments this month?" → **Monthly summary**.
- "Show everything I worked on related to the payments module." → **Search**.

## 4. Functional requirements

### 4.1 Manual import (Codex ingestion)
- The user explicitly provides files via an **Import** screen (drag-and-drop or
  file picker). Two explicit phases: **upload** (file stored) then **analyze**
  (user-triggered). Nothing is analyzed just because it was uploaded.
- Uploads **stream** the raw binary body to disk — no base64, no whole-file
  buffering — with an incremental SHA-256 and a mid-stream max-upload cap.
- Supported inputs: `.jsonl`, `.json`, `.txt`, `.gz`, `.zip` (priority: Codex
  session JSONL). Compressed inputs are unpacked inside DevRecap's own import
  storage under documented safety limits; original files are never modified.
- Detect the file type (magic bytes + extension) and format (Codex JSONL/JSON,
  git-log text, generic).
- Parse each JSONL line independently via a streaming reader (memory-bounded);
  tolerate malformed lines without aborting the import (counted + diagnosed).
  Unknown records are preserved as `unknown` for future parsing.
- Duplicate detection: SHA-256 of file bytes computed while streaming; if the
  same content is imported again, the user is told and may Skip or Import Again.
- Archive safety: reject ZIP-slip/traversal/absolute paths, enforce entry-count,
  per-entry and total uncompressed size, compression-ratio (zip-bomb), and
  nesting-depth limits; skip encrypted entries with a reason. Fail gracefully
  with an explanation.
- Persist raw events (never dropped) linked to their import + source session id.
- Extract: user requests, assistant actions, shell commands, command output,
  edited/referenced files, working directory, errors/investigations, test runs,
  Git-related actions, tool calls, session metadata, likely completed tasks.
- Every import becomes an `ImportedSource` record with lifecycle status
  (`uploaded | processing | completed | partial | failed`) + counts, and can be
  deleted (cascading to its activities and evidence **and** its stored file
  copy).

### 4.1a Explicitly forbidden
- No `~/.codex` discovery, no sessions-folder scanning, no Codex config/process/
  database inspection, no directory watchers, no automatic Git repo access, no
  automatic import of new sessions, no background synchronization. These
  features must not exist.

### 4.2 Activity model
- Normalize raw events into **activities** representing *meaningful work units*,
  not individual chat messages.
- Each activity has: source, project, time span, category, title, summary,
  status, evidence[], confidence, metadata.

### 4.3 Evidence system
- Every activity keeps typed evidence (codex message, shell command, edited
  file, test run, git commit/diff, manual note) with a pointer to the raw row.
- UI exposes **"View evidence"** for every activity and report line.

### 4.4 Git information (manual only)
- DevRecap never runs `git` and never reads a local repository.
- Git data is used only when it appears **inside imported files**: either Git
  actions embedded in Codex logs, or a user-imported `git log` text export
  (e.g. `git log --stat > git-history.txt`). Commits parsed from such imports
  correlate to activities to raise confidence.

### 4.5 Project detection (from imported metadata only)
- Group activities into projects using signals found **inside imported files**:
  Codex `cwd`, git remote/root mentioned in the logs, repo name. DevRecap uses a
  path such as `/home/user/example-project` purely as metadata — it never visits it.
- Projects are renameable and typed: `work | personal | university | other`.
- Work reports exclude `personal` and `university` by default.

### 4.6 Review inbox
- Detected activities can be **Approved / Edited / Merged / Ignored**.
- Low-confidence activities land in the inbox instead of appearing as completed.

### 4.7 Activity merging
- Deterministic grouping by project + time proximity + file overlap + git
  association (semantic similarity as a later enhancement).

### 4.8 Reports
- Types: **Help Me Remember**, **Daily**, **Weekly Review**, **Executive
  Summary**, **Custom Range**, **Monthly Summary**.
- Styles: `spoken | professional | executive | technical`.
- Lengths: `short | normal | detailed`.
- Daily supports a target speaking duration (30/60/90s).
- Approved Activities are grouped into **objective-based Workstreams** (named by
  WHY the work existed, never by a technology collection); technologies are
  surfaced separately as "technical areas".
- Deterministic generation is the default and the source of truth. Output is
  **honest about status** (never claims completion for in-progress work) and
  fully **traceable** (report section → workstream → activities → evidence).
- No inflated corporate language.

### 4.9 Semantic composer (AI layer)
- The report is produced by a **`SemanticReportComposer`**. The default is the
  **`DeterministicComposer`** (local, offline, always valid). An optional
  **external composer** (`openai` | `ollama`) may improve wording. The app never
  hard-depends on an external provider; it selects deterministic unless one is
  explicitly configured, and always falls back to deterministic on failure.
- A composer receives **only** the sanitized `ReportContext` (structured facts:
  objectives, statuses, confidence, short summaries, technical terms, counts) —
  never raw sessions, command output, source code, or imported paths/commands.
- **Post-composition validation** rejects fabricated technical terms, invented
  next-steps, generic/duplicate headings, references to unknown
  workstreams/activities, and **per-workstream completion lies** (claiming an
  unfinished workstream is done). A rejected composition falls back to the
  deterministic composer.

### 4.10 Privacy / redaction / consent
- Redaction layer detects API keys, tokens, passwords, private keys, DB
  connection strings, secrets → replaced with `[REDACTED]`.
- The user can preview the exact sanitized `ReportContext` before anything is
  sent to an external AI.
- **Explicit consent is required and enforced on the server** before any
  external composer runs: the request must carry a consent token matching the
  exact previewed `ReportContext` digest, else the server refuses (`HTTP 409`)
  and makes no external call. The deterministic path needs no consent.
- The OpenAI API key is never returned to the browser (masked hint only) and
  never logged; an omitted key on save preserves the stored one. The
  `DEVRECAP_OPENAI_API_KEY` environment variable is the recommended secure
  configuration and is never persisted to the database.

### 4.11 Search & settings
- Search across activities with filters: project, date range, category, status,
  source.
- Settings: AI (provider/model/endpoint), privacy (redaction, payload preview,
  excluded projects), report defaults, timezone. **No** Codex-dir / repo-dir /
  auto-scan settings exist.

### 4.12 Imports management
- **Import History** screen lists every import with files, format, event counts,
  activities generated, warnings/errors.
- Each import is deletable; deletion cascades to its raw events, activities, and
  the evidence belonging exclusively to it.

## 5. Non-functional requirements

- **Reliability:** malformed line / unreadable session / missing repo / failing
  AI provider / disappearing path / empty repo / changed format must all be
  handled gracefully and logged (never crash the import).
- **Performance:** incremental scans; no full re-read on startup; recent-history
  git only.
- **Security:** never log secrets; never auto-transmit raw session data.
- **Portability:** Windows, WSL2, Linux.
- **Testability:** unit tests with fixtures for parser, scanning, grouping, git,
  project detection, redaction, report input, persistence.

## 6. MVP acceptance criteria (manual-import)

1. Start locally (`npm run dev`), open in browser.
2. Open the Import screen; drag one or more Codex files in.
3. Import `.jsonl` files; import compressed `.gz` / `.zip`.
4. Detect and safely parse Codex events (malformed-tolerant).
5. Store normalized events locally, linked to their import.
6. Detect projects from imported metadata only (never visiting paths).
7. See activities grouped by project and date; review (approve/edit/merge/ignore).
8. View evidence for every activity, traceable to the imported document.
9. Select a period; generate Daily / Weekly / custom-range reports.
10. See Import History; delete an import (cascading to its activities/evidence).
11. Never require a connection to Codex; all source data stays local.

## 7. Out of scope for MVP

Kubernetes, microservices, Redis, cloud DB, message queues, mandatory auth,
cloud hosting, and integrations beyond Codex + Git (Claude Code, Kiro, Cursor,
Gemini, GitHub API, Jira, Linear are future adapters only).
