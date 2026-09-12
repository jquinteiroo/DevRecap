# DevRecap — Implementation Status

Spec-driven, incremental. Manual-import architecture (no tool connection).
This document reflects what is **implemented today** on `main`.

## Foundation — DONE
- [x] Monorepo (`npm` workspaces); `shared` (types · db · migrations · settings ·
      util · validate); SQLite via `node:sqlite` + numbered migrations;
      `node:http` API + tiny router; dependency-free ESM UI shell.
- [x] Activity engine + typed evidence + conservative confidence bands +
      deterministic "Why?" reasoning.
- [x] Deterministic report engine + redaction layer.

## Manual-import architecture — DONE
- [x] No auto-discovery anywhere: no `~/.codex` scan, no sessions-folder
      scanning, no config/process/db inspection, no directory watchers, no
      automatic Git access, no background sync. (`git-parser` parses `git log`
      **text** only; it never runs `git`.)
- [x] Import pipeline core: file-type detection, decompression (`.gz` via
      `node:zlib`; `.zip` via native central-directory + `inflateRawSync`),
      copy into import storage, streamed SHA-256 dedup.
- [x] Import adapters: `CodexExportAdapter`, `GitLogAdapter`, generic text.
- [x] Import orchestrator + API: streaming binary upload, explicit two-phase
      `upload → analyze`, list/get/delete (cascade to activities, evidence, and
      the stored file copy), re-analyze, counts-only diagnostics.
- [x] Import UI (drag-drop + picker + Analyze + duplicate prompt), Import
      History, evidence viewer, "Why?" explanations.
- [x] Documented, env-configurable safety limits; hardened ZIP
      (slip/absolute/UNC rejection, entry/size/ratio/nesting caps, encrypted
      skip); memory-bounded streaming JSONL parser (malformed-tolerant; unknown
      records preserved).

## Activity Extraction V2 — DONE
- [x] Event-classification layer (`classify.ts`): filters environment context,
      injected instructions, SKILL.md/system/developer messages, session
      bootstrap/resume, and tool/session metadata so they never become
      activities.
- [x] File read/edit/create/delete/mention distinction (a read/mentioned file
      is never counted as a modification).
- [x] `TaskCandidate` intermediate entity + task-window segmentation
      (follow-ups stay in the current task).
- [x] Conservative status (blocked only when the task ends blocked, never from
      an incidental error), category, and interpretation-quality confidence.
- [x] Intent-grounded deterministic titles/summaries; bare questions produce no
      activity. Supports `event_msg`, `item_completed`, and `custom_tool_call`
      Codex shapes.

## Semantic report pipeline — DONE
- [x] **TopicProfiles** per activity (domain terms, technologies, components,
      objective) derived deterministically from evidence.
- [x] **Objective-based Workstreams**: activities cluster by shared objective;
      workstreams are named by WHY the work existed (never a technology
      collection like "VUE & PDF", never a generic term). Technologies are
      surfaced separately as technical areas.
- [x] **`ReportContext`**: a sanitized, structured snapshot (objectives,
      statuses, confidence, short summaries, technical terms, file/error/test
      counts, real start/end times, workstream → activity IDs). Contains no raw
      sessions, command output, source code, credentials, or imported paths.
- [x] **`SemanticReportComposer`** abstraction: `DeterministicComposer`
      (default, local, always valid, source of truth) + optional external
      composer (`openai` | `ollama`) that receives ONLY the `ReportContext`.
- [x] **Post-composition validation** (`validateComposedReport`): rejects
      fabricated technical terms, invented next-steps, generic/duplicate
      headings, unknown workstream/activity references, and **per-workstream**
      completion lies. Rejections fall back to the deterministic composer.

## Stabilization & repository hygiene — DONE
- [x] Cross-platform workspace linking (junction on Windows; no admin / Developer
      Mode required); Linux/macOS unchanged.
- [x] Node 24 LTS is the supported runtime (`engines.node >= 24.0.0`); the app
      runs `.ts` directly via native type stripping (no flags) + `node:sqlite`.
- [x] `ReportContext` preserves the real activity end time (`endedAt`).
- [x] **Server-enforced explicit consent** before any external composer runs
      (consent token must match the previewed `ReportContext` digest; otherwise
      `HTTP 409`, no external call). Deterministic path needs no consent.
- [x] API-key hardening: never returned to the browser (masked hint only), never
      logged, preserved on update, `DEVRECAP_OPENAI_API_KEY` env var supported
      (never persisted).
- [x] Cross-platform GitHub Actions CI (windows-latest + ubuntu-latest, Node 24):
      `npm run setup` + `npm test` + a server health smoke check.
- [x] Full `node:test` suite green (parser, import, engine, workstreams, report
      composer, validation, API privacy/consent, persistence).

## Deferred (future milestones — NOT started)
- Additional export adapters (Claude Code, Kiro, Cursor, Gemini).
- Richer search / onboarding / UI polish.
- Migration to the canonical stack (React + Vite + Tailwind + Prisma + Zod).
- OS keychain storage for the API key (env var is the current secure option).

> Rule going forward: **DevRecap analyzes documents the user gives it. It does
> not connect to the user's development tools.** Paths and commands found inside
> imported files are DATA ONLY.
