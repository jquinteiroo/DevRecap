---
name: devrecap
description: Generate an evidence-backed work recap from local Claude/Codex sessions and Git, with AI analysis followed by presentation-ready HTML/PDF rendering.
---

# DevRecap

When invoked as `/devrecap`, use the DevRecap CLI as the factual layer and this Claude session as the analysis layer.

1. Run `devrecap prepare --request "$ARGUMENTS" --out .devrecap/run.json` (or `npm run recap -- prepare --request "$ARGUMENTS" --out .devrecap/run.json` inside the DevRecap source repository).
2. Read `.devrecap/run.json` and follow `contract.rules` exactly.
3. Analyze only `contract.facts`. Write one JSON object matching `contract.outputShape` to `.devrecap/analysis.json`.
4. Every item must reference valid `activityIds`. Never promote unconfirmed work to completed work, and distinguish work attempted from work delivered.
5. Run `devrecap render --run .devrecap/run.json --analysis .devrecap/analysis.json --out reports/devrecap.html`. Add `--pdf reports/devrecap.pdf` if PDF was requested.
6. Report the output paths and a short recap. Do not expose raw transcripts or credentials.
