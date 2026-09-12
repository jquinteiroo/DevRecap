---
name: devrecap
description: Reconstruct coding work from local Codex/Claude sessions and Git, analyze only evidence-backed activities, and generate presentation-ready HTML/PDF work reports.
---

# DevRecap

In Codex, invoke this skill explicitly as `$devrecap`. Use the DevRecap CLI as the factual layer and the current coding agent as the analysis layer.

1. Resolve the requested period from natural language such as "today", "this week", or "last 7 days".
2. Run `devrecap prepare --request "<user request>" --out .devrecap/run.json`. Inside the DevRecap source repository, `npm run recap -- prepare --request "<user request>" --out .devrecap/run.json` is also valid.
3. Read `.devrecap/run.json` and analyze only `contract.facts`.
4. Write one JSON object matching `contract.outputShape` to `.devrecap/analysis.json`.
5. Every analysis item must reference one or more IDs from `contract.allowedActivityIds`. Never promote `in_progress`, `blocked`, or `unknown` work to completed. Use shipped/delivered language only when completion or commit evidence supports it.
6. Prefer outcomes, fixes, features, investigations, validation, blockers, and useful next steps over command-by-command narration.
7. Run `devrecap render --run .devrecap/run.json --analysis .devrecap/analysis.json --out reports/devrecap.html`. Add `--pdf reports/devrecap.pdf` when PDF was requested.
8. Return the generated paths and a short recap.

DevRecap is explicit-invocation only. Do not create background monitoring. Do not expose raw transcripts, credentials, or secrets to improve prose. If AI analysis fails, use the deterministic fallback instead of inventing content.
