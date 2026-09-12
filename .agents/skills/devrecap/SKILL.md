---
name: devrecap
description: Reconstruct developer work from explicitly authorized local Codex/Claude history and read-only Git metadata, then turn evidence-backed activities into polished developer recaps.
---

# DevRecap

Invoke explicitly as `$devrecap`.

DevRecap has two separate responsibilities:

- **DevRecap CLI = factual layer.** It collects only explicitly authorized local sources, parses them, determines accepted Activities, statuses, evidence, projects and workstreams.
- **The current coding agent = report-writing layer.** When this skill is invoked inside Codex, YOU are expected to turn those structured facts into the polished report. Do not delegate the writing back to the deterministic CLI unless AI synthesis cannot be completed.

The final HTML should read like a strong work report, not like telemetry.

## Consent comes first

Before any local collector is used, DevRecap CLI setup must already exist. If `devrecap prepare` reports that setup is required, stop and ask the user to run:

`devrecap setup`

Never bypass setup, never scan local history yourself as a workaround, and never enable a source the user did not authorize.

## AI-first workflow

When the user asks for a recap, daily, review, "what did I do?", or help remembering a period:

1. Resolve the requested period faithfully. If natural-language resolution produces a shorter range than requested, rerun with an explicit equivalent such as `last 14 days` or exact dates.
2. Run `devrecap prepare --request "<user request>" --out .devrecap/run.json`.
   - Inside the DevRecap source repository on Windows PowerShell, `npm.cmd run recap -- prepare --request "<user request>" --out .devrecap/run.json` is valid.
   - Do **not** use direct convenience commands such as `devrecap remember` or `devrecap week` as the final result inside the skill; those commands intentionally use the deterministic fallback writer.
3. Read `.devrecap/run.json`.
4. Analyze only `contract.facts`, `contract.allowedActivityIds`, and the structured accepted data in the prepared run. Raw transcripts are not part of the writing workflow.
5. Write `.devrecap/analysis.json` matching `contract.outputShape` at presentation quality.
6. Run `devrecap render --run .devrecap/run.json --analysis .devrecap/analysis.json --out reports/devrecap.html`.
7. Add `--pdf reports/devrecap.pdf` only when PDF was requested.
8. Return the generated path plus a concise conversational recap.

## What a good DevRecap report feels like

Write like a strong technical teammate who reviewed the developer's work history and is helping them remember the period.

Use this editorial shape:

- **headline**: describe what characterized the period instead of showing a raw activity count;
- **executiveSummary**: one polished opening paragraph covering the main fronts and overall state;
- **mainFocus**: summarize the most important front with context, what happened and where it ended;
- **detail sections**: consolidate related Activities into a small number of meaningful work fronts;
- **highlights**: only completed work backed by evidence;
- **investigations**: unresolved investigation fronts;
- **inProgress**: implementation or changes that were worked on but are not proven complete;
- **blockers** and **nextSteps**: only when explicitly supported.

For each narrative, prefer 2–4 useful sentences that cover the context/problem, what was changed or investigated, why it mattered when the evidence supports that interpretation, and the factual state at the end of the period.

### Synthesis rules

- Combine related Activities into one narrative item when they clearly describe the same objective. Reference all supporting `activityIds`.
- Rewrite weak parser-generated labels into natural language when the structured facts support a better description.
- A title such as `Investigated the API`, `Investigated the project`, a filename, or a command count is a clue, not the final headline.
- Use project name, objective, activity summaries, categories, workstream context, technical terms, validation and status together to infer the clearest grounded description.
- Never invent a business purpose, feature name, root cause, outcome, blocker or next step that is not supported by the structured facts.
- Never change `in_progress`, `blocked`, or `unknown` work into completed work.
- Use shipped/delivered/completed language only when completion or commit evidence supports it.
- Highlights/key deliveries may reference only completed activities.
- Do not repeat the same Activity in multiple detail sections; it may also appear in `mainFocus` only as a high-level overview.
- Only populate `nextSteps` when the prepared facts contain an explicit evidence-backed next step.
- Do not make filenames, number of files, number of commands, raw shell commands or implementation noise the main story.
- Avoid database-like prose such as "the workstream grouped N activities" unless the count itself matters.
- Preserve meaningful proper names such as Codex, Claude, DocuSign, Laravel, Vue, PDF, API, SQL, GitHub and product/project names.
- Write in the user's requested language. If the request is in Portuguese, write natural Brazilian Portuguese.

## Report style by intent

### `daily`
Keep it concise and speakable. Prefer 2–4 meaningful points covering what changed, what is being worked on, and blockers. Aim for roughly a 30–60 second standup.

### `review`
Emphasize outcomes, shipped work, meaningful progress, validation, and impact that is actually supported by the facts. Do not turn raw activity volume into achievement.

### `remember` / "what did I work on?"
This is the richest mode. Reconstruct the story of the work so the developer can remember it later. For each major front, explain the objective/context, what was done, useful technical clues, and the evidence-backed current state.

## Quality check before render

Before writing `.devrecap/analysis.json`, verify:

- Would this report help someone remember the actual work, rather than merely list telemetry?
- Are related Activities consolidated sensibly?
- Are titles natural and specific where the evidence permits?
- Is every statement grounded in the supplied structured facts?
- Are incomplete activities described honestly?
- Are there any fake next steps?
- Are filenames/command counts dominating the prose? If yes, rewrite.
- Does every analysis item reference one or more valid `activityIds`?
- Would the resulting HTML be presentable without manually rewriting it afterward?

If the structured evidence is ambiguous, prefer a clear but conservative sentence such as "Houve investigação no fluxo de integração" rather than inventing a specific objective.

## Rendering rule

The host AI's validated wording is the canonical wording for Skill-generated reports. Preserve the AI-written headline, executive summary, titles and narratives through render. Deterministic semantic polishing is for deterministic fallback reports, not for replacing a good host-AI synthesis.

## Privacy and safety

DevRecap is explicit-invocation only. Do not create background monitoring. Do not expose raw transcripts, credentials, source code, secrets, or full command outputs to improve prose. Do not run project code. Git access by the CLI is read-only.

If agent analysis genuinely cannot be produced, use the deterministic fallback. The deterministic report is a safety net, not the preferred Skill experience.
