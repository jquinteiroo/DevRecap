# DevRecap — Codex Marketplace Guide

DevRecap now ships as a portable Agent Plugin plus a repository marketplace for Codex/ChatGPT plugin testing and private distribution.

## What the marketplace package contains

- `plugin.json` — portable Agent Plugins manifest.
- `skills/devrecap/SKILL.md` — AI-first DevRecap skill used by the installed plugin.
- `.agents/plugins/marketplace.json` — repository marketplace catalog.
- `scripts/devrecap-plugin.mjs` — bundled runner that boots the factual CLI without a global npm install.

The plugin source is the repository root, so the installed package also contains the DevRecap collectors, activity engine, report engine, and CLI needed by the skill.

## Add the GitHub marketplace to Codex

```bash
codex plugin marketplace add jquinteiroo/devrecap --ref main
```

Inspect configured marketplaces:

```bash
codex plugin marketplace list
```

Then open the Plugins surface in a supported Codex/ChatGPT client, find **DevRecap** under the DevRecap marketplace, and install it.

After repository updates, refresh the marketplace with:

```bash
codex plugin marketplace upgrade devrecap-marketplace
```

## First use

Invoke the installed skill and ask for a recap, for example:

```text
$devrecap

Me ajuda a lembrar tudo que trabalhei nas últimas duas semanas.
Quero um relatório detalhado em português.
```

On first use, DevRecap will require explicit authorization for local sources. The skill must not bypass this setup.

The bundled plugin runner is:

```bash
node <plugin-root>/scripts/devrecap-plugin.mjs setup
```

The skill derives `<plugin-root>` from its installed location automatically when the `devrecap` command is not already on PATH.

## Why the Skill uses AI

The CLI determines facts: Activities, Workstreams, completion evidence, Git correlation, and allowed source IDs.

The host model writes the report from those structured facts:

```text
local evidence
  ↓
DevRecap factual pipeline
  ↓
contract.facts
  ↓
Codex / Claude synthesis
  ↓
validated analysis.json
  ↓
HTML / PDF
```

This keeps completion and evidence deterministic while letting the installed AI produce a much more natural and useful report.

## Public directory status

This repository marketplace is suitable for local testing, GitHub-based marketplace import, and workspace/private distribution.

It is **not automatically listed in the universal public Plugins Directory**. Public listing requires a separate OpenAI plugin submission and review after the package and user experience are validated.

## Requirements

- Node.js 24 or newer
- Git
- Codex/ChatGPT client with plugin marketplace support
- Optional Chrome/Chromium for direct PDF rendering

See `PRIVACY.md` for the local-source and AI-processing privacy model.
