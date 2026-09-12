---
name: devrecap
description: Reconstruct developer work from explicitly authorized local Codex/Claude history and read-only Git metadata, then generate evidence-backed terminal/HTML/PDF recaps.
---

# DevRecap

Invoke explicitly as `$devrecap`. DevRecap is terminal-first: the CLI is the factual layer and the current coding agent is the analysis/language layer.

## Consent comes first

Before any local collector is used, DevRecap CLI setup must already exist. If `devrecap prepare` reports that setup is required, stop and ask the user to run:

`devrecap setup`

Never bypass setup, never scan local history yourself as a workaround, and never enable a source the user did not authorize.

## Workflow

1. Resolve the requested period and intent (daily, remember, review, custom range).
2. Run `devrecap prepare --request "<user request>" --out .devrecap/run.json`. Inside the DevRecap source repository, `npm run recap -- prepare --request "<user request>" --out .devrecap/run.json` is also valid.
3. Read `.devrecap/run.json` and analyze only `contract.facts` / the allowed structured facts.
4. Write one JSON object matching `contract.outputShape` to `.devrecap/analysis.json`.
5. Every analysis item must reference one or more IDs from `contract.allowedActivityIds`. Never promote `in_progress`, `blocked`, or `unknown` work to completed. Use shipped/delivered language only when completion or commit evidence supports it.
6. Prefer outcomes, fixes, features, investigations, validation, blockers, and useful next steps over command-by-command narration.
7. Run `devrecap render --run .devrecap/run.json --analysis .devrecap/analysis.json --out reports/devrecap.html`. Add `--pdf reports/devrecap.pdf` when PDF was requested.
8. Return the generated paths and a concise recap.

Useful direct CLI commands include `devrecap today`, `devrecap daily`, `devrecap week`, `devrecap remember "last 14 days"`, and `devrecap review`.

DevRecap is explicit-invocation only. Do not create background monitoring. Do not expose raw transcripts, credentials, source code, or secrets to improve prose. Do not run project code. Git access by the CLI is read-only. If AI analysis fails, use the deterministic fallback instead of inventing content.
