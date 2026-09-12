# DevRecap

**Terminal-first, local-first developer work recaps with evidence behind every claim.**

DevRecap reconstructs what you worked on from coding-assistant history and Git metadata, turns it into meaningful Activities and Workstreams, and produces recaps for dailies, weekly reviews, sprint reviews, memory refreshes, and personal work journals.

The product now has two intentionally different modes:

- **CLI / Skill mode** — optional local Codex, Claude Code, and read-only Git collectors. These collectors run only after explicit `devrecap setup` authorization.
- **Web mode** — manual file import only. The browser/server never scans local development folders automatically.

---

## Terminal quick start

Requirements: **Node.js 24 LTS** (`>=24.0.0`).

```bash
npm run setup
npm run recap -- setup
npm run recap -- sources
npm run recap -- today
```

During setup, choose exactly which local sources DevRecap may read:

```text
DevRecap setup

[ ] Codex session history
[ ] Claude Code session history
[ ] Git history for detected projects
```

The selection is saved locally in `~/.devrecap/config.json` (or the path set by `DEVRECAP_CONFIG`). No local collector runs before this configuration exists.

### Terminal commands

```bash
# Simple time ranges
npm run recap -- today
npm run recap -- week
npm run recap -- month

# Product-oriented recaps
npm run recap -- daily
npm run recap -- remember "last 14 days"
npm run recap -- review --from 2026-09-01 --to 2026-09-12

# Legacy free-form mode remains supported
npm run recap -- "essa semana"
```

`daily` uses a short spoken-style report. `remember` defaults to a detailed Help Me Remember report. `review` produces a professional review-oriented recap.

Every direct report prints a concise recap in the terminal and also writes a presentation-ready HTML report.

---

## Skill workflow

DevRecap ships Skill definitions for coding agents. The core architecture is:

```text
DevRecap CLI = factual layer
Coding agent = language / analysis layer
```

The Skill never asks an agent to infer work from raw transcripts. Instead it runs:

```text
devrecap prepare
      ↓
accepted Activities + evidence-backed contract
      ↓
agent analyzes only allowed facts
      ↓
devrecap render
```

Inside this repository:

```bash
npm run recap -- prepare --request "this week" --out .devrecap/run.json
npm run recap -- render --run .devrecap/run.json --analysis .devrecap/analysis.json --out reports/devrecap.html
```

If setup has not been completed, `prepare` stops before any collector is invoked and asks the user to run `devrecap setup`.

---

## Privacy model

### CLI / Skill mode

Local collection is **explicit, source-by-source, and read-only**.

After authorization, DevRecap may read:

- Codex session JSONL under the configured Codex home;
- Claude Code session JSONL under the user's Claude projects directory;
- Git metadata for detected project directories.

DevRecap CLI does **not**:

- modify Codex or Claude history;
- create filesystem watchers or background sync;
- run project/application code;
- execute commands found inside transcripts;
- run mutating Git commands;
- upload raw transcripts automatically.

Git access is protected by a centralized read-only allowlist. Current allowed query shapes are limited to operations such as `rev-parse --show-toplevel`, reading Git identity, `git log`, `remote get-url origin`, and `branch --show-current`. Commands such as `add`, `commit`, `push`, `pull`, `switch`, `checkout`, `reset`, `restore`, `merge`, `rebase`, and `clean` are refused before Git is invoked.

### Web mode

The web application remains **manual-import only**.

```text
select file
  ↓
upload to local DevRecap storage
  ↓
explicit Analyze click
  ↓
parse → Activities → Evidence → Workstreams → Reports
```

The web server does not automatically inspect `~/.codex`, `~/.claude`, or repositories.

---

## How the evidence pipeline works

```text
Codex / Claude / Git facts
        ↓
Raw events
        ↓
Normalization + classification
        ↓
TaskCandidates
        ↓
Evidence-backed Activities
        ↓
TopicProfiles
        ↓
Objective-based Workstreams
        ↓
ReportContext / analysis contract
        ↓
Deterministic or agent-assisted wording
        ↓
Traceable recap
```

DevRecap prefers uncertainty over invented completion. File edits or commands alone are not enough to claim delivery; completion requires stronger independent evidence.

---

## Web application

Run the visual interface with:

```bash
npm run dev
# http://localhost:3737
```

The web app supports manual imports (`.jsonl`, `.json`, `.txt`, `.gz`, `.zip`), Timeline, Review Inbox, evidence inspection, import diagnostics, Projects, Search, and report generation.

Imported files are copied into DevRecap's own local storage and the originals are never modified. Deleting an import removes its derived activities/evidence and DevRecap's stored copy.

---

## Reports and optional AI

Deterministic report generation is the default. The web report engine also supports optional OpenAI-compatible / Ollama semantic composition using a sanitized `ReportContext` only.

External AI is consent-gated: the server requires approval tied to the exact sanitized payload digest that was previewed. Raw session files, full command output, source code, credentials, and repository contents are not sent as composer input.

The terminal Skill model is separate: the CLI prepares an evidence-backed contract and the coding agent is instructed to analyze only the allowed facts.

---

## Useful scripts

| Command | Purpose |
|---|---|
| `npm run setup` | Link local workspace packages |
| `npm run recap -- ...` | Run the terminal CLI |
| `npm run dev` | Start local web UI/API |
| `npm test` | Run the full Node test suite |
| `npm run smoke` | Server health smoke test |
| `npm run typecheck` | Type-check when TypeScript tooling is installed |

---

## Repository layout

```text
apps/
  cli/       terminal-first DevRecap commands + Skill factual layer
  server/    local API + manual import orchestrator
  web/       visual interface
packages/
  collectors/      authorized Codex / Claude / read-only Git collection
  codex-parser/    Codex rollout parsing
  git-parser/      Git-log text parsing
  activity-engine/ normalization, evidence, Activities, TopicProfiles
  report-engine/   Workstreams, contracts, report composition/validation
  import-core/     manual web import safety/storage
  shared/          domain types, SQLite, settings, validation
.agents/skills/devrecap/   agent Skill definition
.claude/skills/devrecap/   Claude Skill definition
```

---

## Current product direction

DevRecap is becoming a **developer Skill you can live in from the terminal**:

```text
devrecap setup
devrecap sources
devrecap today
devrecap daily
devrecap remember
devrecap review
```

The web UI remains the advanced visual/audit interface. Distribution through a published npm package, `npx`, and a dedicated `devrecap skill install` workflow is planned as a later productization phase after the terminal behavior is stable.
