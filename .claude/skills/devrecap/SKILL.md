---
name: devrecap
description: Generate polished evidence-backed developer recaps from local sources explicitly authorized through DevRecap setup.
---

# DevRecap

When invoked as `/devrecap`, use the DevRecap CLI as the factual layer and Claude as the report-writing layer.

The CLI decides what happened. Claude turns those grounded facts into a report that actually helps the developer remember the work. The AI-written wording is the preferred final report content; deterministic prose is only the fallback.

## Consent

Before collecting local history, the user must have completed `devrecap setup`. If `devrecap prepare` says setup is required, stop and ask the user to run setup. Never bypass the CLI permission model or inspect local history independently.

## AI-first workflow

1. Resolve the requested period faithfully. If automatic resolution produces a shorter range than requested, rerun with an explicit equivalent such as `last 14 days` or exact dates.
2. Run `devrecap prepare --request "<requested period or recap>" --out .devrecap/run.json`.
3. Read `.devrecap/run.json` and follow `contract.rules`.
4. Analyze only `contract.facts`, `contract.allowedActivityIds`, and the structured accepted data in the prepared run.
5. Write one JSON object matching `contract.outputShape` to `.devrecap/analysis.json` at presentation quality.
6. Run `devrecap render --run .devrecap/run.json --analysis .devrecap/analysis.json --out reports/devrecap.html`.
7. Add `--pdf reports/devrecap.pdf` only if PDF was requested.
8. Return the generated path and a short conversational recap.

Inside the Skill, do not use `devrecap remember`, `devrecap week`, `devrecap daily`, or similar convenience commands as the final result. Those commands intentionally produce the deterministic fallback writer. Use `prepare → Claude synthesis → render` instead.

## Writing goal

Write like a strong technical teammate who reviewed the developer's work history and is helping them remember the period.

Use this editorial shape:

- **headline**: describe what characterized the period instead of a raw activity count;
- **executiveSummary**: one polished opening paragraph covering the main fronts and overall completion state;
- **mainFocus**: explain the most important front with context, what happened and where it ended;
- **detail sections**: consolidate related Activities into a small number of meaningful work narratives;
- **highlights**: only completed work backed by evidence;
- **investigations**: unresolved investigation fronts;
- **inProgress**: implementation or changes that were worked on but are not proven complete;
- **blockers** and **nextSteps**: only when explicitly supported.

For each narrative, prefer 2–4 useful sentences covering the context/problem, what was changed or investigated, why it mattered when supported by evidence, and the factual state at the end of the period.

## Synthesis rules

- Combine related Activities into one narrative item when they describe the same objective, referencing all supporting `activityIds`.
- Rewrite weak parser labels into natural language when the structured facts support a better description.
- Treat labels such as `Investigated the API`, `Investigated the project`, filenames, command names and counts as clues, not final wording.
- Use project name, objective, summaries, categories, workstream context, technical terms, validation and status together to produce the clearest grounded description.
- Never invent a business purpose, feature name, root cause, result, blocker or next step.
- Never promote `in_progress`, `blocked`, or `unknown` work to completed.
- Use shipped/delivered/completed language only when completion or commit evidence supports it.
- Highlights/key deliveries may reference only completed activities.
- Do not repeat one Activity across multiple detail sections; it may also appear in `mainFocus` only as a high-level overview.
- Only populate `nextSteps` when the prepared facts contain an explicit evidence-backed next step.
- Do not make filenames, number of files, number of commands, raw shell commands or telemetry the main story.
- Avoid database-like prose such as "the workstream grouped N activities" unless that count is genuinely useful.
- Preserve useful proper names and technical terms such as Codex, Claude, DocuSign, Laravel, Vue, PDF, API, SQL and GitHub.
- Write in the user's requested language. For Portuguese requests, use natural Brazilian Portuguese.

## Style by request

### Daily
Concise and speakable, normally 2–4 meaningful points for a 30–60 second standup.

### Review
Emphasize evidence-backed outcomes, shipped work, meaningful progress and validation. Activity volume is not an achievement by itself.

### Remember / what did I work on?
Use the richest synthesis. Reconstruct each major workstream with context, what was done, useful technical clues and its current state so the developer can genuinely remember the work later.

## Quality gate

Before rendering, verify that:

- the result reads like a work recap, not telemetry;
- related Activities are sensibly consolidated;
- titles are natural and as specific as the evidence permits;
- every claim is grounded in structured facts;
- incomplete work is described honestly;
- there are no invented next steps;
- every analysis item references valid `activityIds`;
- the final HTML should be presentable without manually rewriting it after render.

When evidence is ambiguous, prefer a conservative but readable description over a specific invention.

## Rendering rule

Preserve the validated AI-written headline, executive summary, titles and narratives through the final render. Deterministic semantic polishing is for fallback reports, not for replacing a good Claude synthesis.

DevRecap is explicit-invocation only. Do not create background monitoring, run project code, expose raw transcripts or bypass the CLI's read-only source rules.
