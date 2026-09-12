---
name: devrecap
description: Reconstruct developer work from explicitly authorized local Codex/Claude history and read-only Git metadata, then turn evidence-backed activities into polished developer recaps.
---

# DevRecap

Invoke explicitly as `$devrecap`.

DevRecap has two separate responsibilities:

- **DevRecap CLI = factual layer.** It collects only explicitly authorized local sources, parses them, determines accepted Activities, statuses, evidence, projects and workstreams.
- **The current coding agent = report-writing layer.** When this skill is invoked inside Codex, YOU are expected to turn those structured facts into the polished report. Do not delegate the writing back to the deterministic CLI unless AI synthesis cannot be completed.

The goal is not to dump telemetry. The goal is to help the developer remember what they actually worked on.

## Consent comes first

Before any local collector is used, DevRecap CLI setup must already exist. If `devrecap prepare` reports that setup is required, stop and ask the user to run:

`devrecap setup`

Never bypass setup, never scan local history yourself as a workaround, and never enable a source the user did not authorize.

## AI-first workflow

When the user asks for a recap, daily, review, "what did I do?", or help remembering a period:

1. Run `devrecap prepare --request "<user request>" --out .devrecap/run.json`.
   - Inside the DevRecap source repository, `npm run recap -- prepare --request "<user request>" --out .devrecap/run.json` is also valid.
   - Do **not** use the direct convenience commands (`devrecap remember`, `devrecap week`, etc.) as the final result inside the skill, because those commands intentionally use the deterministic fallback writer.
2. Read `.devrecap/run.json`.
3. Analyze only `contract.facts`, `contract.allowedActivityIds`, and the structured accepted data in the prepared run. Raw transcripts are not part of the writing workflow.
4. Write `.devrecap/analysis.json` matching `contract.outputShape`.
5. Run `devrecap render --run .devrecap/run.json --analysis .devrecap/analysis.json --out reports/devrecap.html`.
6. Add `--pdf reports/devrecap.pdf` only when PDF was requested.
7. Return the generated path plus a concise conversational recap.

## What a good DevRecap report feels like

Write like a strong technical teammate who reviewed the developer's work history and is helping them remember the period.

The report should answer, when evidence supports it:

- What problem or objective was being worked on?
- What did the developer actually change, investigate, validate or organize?
- What was the meaningful result or current state?
- What technical context is useful for remembering the work?
- What remained unresolved, blocked or unconfirmed?

Prefer a few coherent work narratives over many tiny activity cards.

### Synthesis rules

- Combine related Activities into one narrative item when they clearly describe the same objective. Reference all supporting `activityIds`.
- Rewrite weak parser-generated labels into natural language when the structured facts support a better description.
- A title such as `Investigated the API`, `Investigated the project`, a filename, or a command count is a clue, not necessarily the final headline.
- Use project name, objective, activity summaries, categories, workstream context, technical terms, validation and status together to infer the clearest grounded description.
- Never invent a business purpose, feature name, root cause, outcome, blocker or next step that is not supported by the structured facts.
- Never change `in_progress`, `blocked`, or `unknown` work into completed work.
- Use shipped/delivered/completed language only when completion or commit evidence supports it.
- Highlights/key deliveries may reference only completed activities.
- Do not repeat the same Activity in multiple detail sections.
- Only populate `nextSteps` when the prepared facts contain an explicit evidence-backed next step.
- Do not make filenames, number of files, number of commands, raw shell commands or implementation noise the main story.
- Technical details are useful only when they help the developer remember the work.
- Preserve meaningful proper names such as Codex, Claude, DocuSign, Laravel, Vue, PDF, API, SQL, GitHub and product/project names.
- Write in the user's requested language. If the request is in Portuguese, write natural Brazilian Portuguese.

## Report style by intent

### `daily`
Keep it concise and speakable. Prefer 2–4 meaningful points covering what changed, what is being worked on, and blockers. Aim for roughly a 30–60 second standup.

### `review`
Emphasize outcomes, shipped work, meaningful progress, validation, and impact that is actually supported by the facts. Do not turn raw activity volume into achievement.

### `remember` / "what did I work on?"
This is the richest mode. Reconstruct the story of the work so the developer can remember it later. For each major front, explain the objective/context, what was done, useful technical clues, and the evidence-backed current state. It is acceptable to be more detailed here.

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

If the structured evidence is ambiguous, prefer a clear but conservative sentence such as "Houve investigação no fluxo de integração" rather than inventing a specific objective.

## Privacy and safety

DevRecap is explicit-invocation only. Do not create background monitoring. Do not expose raw transcripts, credentials, source code, secrets, or full command outputs to improve prose. Do not run project code. Git access by the CLI is read-only.

If agent analysis genuinely cannot be produced, use the deterministic fallback. The deterministic report is a safety net, not the preferred Skill experience.
