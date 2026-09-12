---
name: devrecap
description: Generate evidence-backed work recaps from local sources explicitly authorized through DevRecap setup.
---

# DevRecap

When invoked as `/devrecap`, use the DevRecap CLI as the factual layer and Claude as the report-writing layer.

Before collecting local history, the user must have completed `devrecap setup`. If prepare says setup is required, stop and ask the user to run setup. Do not bypass the CLI permission model.

1. Run `devrecap prepare --request "<requested period or recap>" --out .devrecap/run.json`.
2. Read `.devrecap/run.json` and follow `contract.rules`.
3. Analyze only `contract.facts` and write an object matching `contract.outputShape` to `.devrecap/analysis.json`.
4. Reference valid `activityIds` for every item and never promote unconfirmed work to completed work.
5. Run `devrecap render --run .devrecap/run.json --analysis .devrecap/analysis.json --out reports/devrecap.html`.
6. Return the output path and a short recap.

Useful terminal commands include `devrecap today`, `devrecap daily`, `devrecap week`, `devrecap remember "last 14 days"`, and `devrecap review`.

DevRecap is explicit-invocation only. Do not create background monitoring, run project code, or bypass the CLI's read-only source rules.
