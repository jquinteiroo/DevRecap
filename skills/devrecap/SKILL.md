---
name: devrecap
description: Reconstruct developer work from explicitly authorized local Codex/Claude history and read-only Git evidence, then use the host AI to write polished, evidence-backed recaps.
---

# DevRecap

DevRecap is an AI-native work-reconstruction skill. The bundled CLI is the factual layer; the current Codex/Claude model is the writing and synthesis layer.

The preferred experience is not a deterministic CLI report. Use the host AI to transform structured Activities and Workstreams into a coherent report, while preserving evidence-backed status exactly.

## What to do when invoked

Interpret requests such as:

- "what did I work on this week?"
- "prepare my daily"
- "help me remember the last 14 days"
- "prepare my sprint review"
- "give me a detailed recap of last month"

Resolve the requested period and reporting intent, then follow the AI-first pipeline below.

## Find the bundled DevRecap runner

Prefer `devrecap` when that command already exists on PATH.

If it is not available, this plugin bundles the DevRecap source and a runner. Determine the plugin root from this skill file: the plugin root is two directories above `skills/devrecap/SKILL.md`.

Run the bundled CLI with:

`node <plugin-root>/scripts/devrecap-plugin.mjs <args>`

The bundled runner prepares the local workspace links automatically. Node.js 24+ is required.

Inside the DevRecap source repository, `npm.cmd run recap -- <args>` is valid on Windows PowerShell and `npm run recap -- <args>` is valid where `npm` is directly executable.

## Consent comes first

Before any local collector is used, DevRecap setup must already exist.

Run the factual preparation step. If it reports that setup is required, stop collection and ask the user to authorize sources by running either:

`devrecap setup`

or, when using the bundled plugin runner:

`node <plugin-root>/scripts/devrecap-plugin.mjs setup`

Never bypass setup. Never inspect Codex history, Claude history, or Git repositories yourself as a workaround. Never enable a source the user did not authorize.

## AI-first report pipeline

1. Resolve the requested period faithfully. If the natural-language resolver produces a shorter range than the user asked for, rerun `prepare` with an explicit equivalent period such as `last 14 days` or explicit `--from/--to` dates.
2. Run `prepare` and write `.devrecap/run.json` in the current project/workspace.
3. Read `.devrecap/run.json`.
4. Analyze only `contract.facts` and obey `contract.rules`.
5. Use the host model to synthesize a human-quality report and write one JSON object matching `contract.outputShape` to `.devrecap/analysis.json`.
6. Every analysis item must reference one or more IDs from `contract.allowedActivityIds`.
7. Run `render` with the AI-generated analysis to create the final HTML, and PDF when requested.
8. Return the generated path plus a concise natural-language recap.

Typical commands:

`devrecap prepare --request "last 14 days" --out .devrecap/run.json`

`devrecap render --run .devrecap/run.json --analysis .devrecap/analysis.json --out reports/devrecap.html`

When using the bundled runner, replace `devrecap` with:

`node <plugin-root>/scripts/devrecap-plugin.mjs`

## Writing brief for the AI

The final HTML is the deliverable. Write `.devrecap/analysis.json` at presentation quality before rendering it.

The report should feel like a capable teammate reconstructed the work from evidence, not like a telemetry export. Aim for the same quality as a polished work report written directly by the host model.

Use this editorial shape:

- **headline**: a concise description of what characterized the period, not a raw activity count;
- **executiveSummary**: one polished opening paragraph explaining the period, the main work fronts and the overall completion state;
- **mainFocus**: a short overview of the most important work front, with context, what was done and its current state;
- **detail sections**: group related Activities into a small number of meaningful fronts and write natural narratives that explain the work rather than merely naming it;
- **highlights**: only evidence-backed completed work;
- **investigations**: unresolved investigation fronts;
- **inProgress**: implementation or changes that were worked on but are not proven complete;
- **blockers** and **nextSteps**: only when explicitly supported by the facts.

For each narrative, prefer 2–4 useful sentences covering as applicable:

1. the context or problem;
2. what was changed, investigated or validated;
3. why the work mattered or what behavior was being pursued, when supported by evidence;
4. the evidence-backed state at the end of the period.

Prefer:

- coherent work fronts instead of one card per low-level activity;
- the user's likely objective when the structured evidence supports it;
- useful context explaining what was changed, investigated, validated, delivered, or left open;
- natural language in the user's requested language;
- concise technical context when it helps memory;
- a clear distinction between completed, in-progress, blocked, and unconfirmed work;
- concrete deliveries and outcomes over filenames, command counts, raw parser labels or activity counts.

Do not make the prose sound like a database summary. Avoid phrases such as "the workstream grouped N activities" unless the count itself is genuinely useful. Do not lead with file counts or command counts. Do not repeat raw titles like "Investigated the API" when the structured facts support a clearer explanation.

You may rewrite weak activity titles such as "Investigated the project" into a clearer description only when the structured facts support that interpretation. Merge related activities when their Workstreams, project, topic signals, files, timing, or evidence show that they belong to the same work front.

Do not expose raw transcripts just to improve prose. Do not narrate command-by-command execution unless the user explicitly asks for technical evidence.

## Hard evidence rules

- Never invent work, outcomes, blockers, next steps, or completion.
- Never promote `in_progress`, `blocked`, or `unknown` work to completed.
- Use shipped/delivered/completed language only when completion or commit evidence supports it.
- Highlights/key deliveries must be supported by completed activities.
- Do not repeat the same activity across multiple detail sections unless it is used only in `mainFocus` as a high-level overview and then once in the appropriate detailed section.
- Only include next steps when `facts.nextSteps` contains an explicit evidence-backed next step.
- Keep all referenced IDs inside `contract.allowedActivityIds`.
- The CLI's local Git access is read-only. Do not run project code or commands copied from transcripts.

## Rendering rule

The host AI's validated wording is the canonical wording for Skill-generated reports. Rendering should preserve the AI-written headline, executive summary, titles and narratives. Deterministic semantic polishing is a fallback for deterministic CLI reports, not a reason to replace a good host-AI synthesis.

## Fallback

If AI synthesis fails, use the deterministic analysis produced by DevRecap rather than inventing content. The deterministic path is a safety fallback; for normal Skill usage, prefer host-AI synthesis.

DevRecap is explicit-invocation only. Do not create background monitoring, watchers, hooks, or automatic collection outside the user's request.
