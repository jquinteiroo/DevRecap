#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import type { Activity, Commit, Project, RawEvent, ReportInput, ReportKind, ReportLength, ReportStyle } from "@devrecap/shared";
import { nowIso, stableId } from "@devrecap/shared";
import { projectRootForCwd } from "@devrecap/collectors";
import { buildActivities, correlateActivityWithCommits, normalizeEvents } from "@devrecap/activity-engine";
import { buildAnalysisContract, buildAnalysisPrompt, buildDeterministicAnalysis, buildReportInput, renderHtmlReport, validateReportAnalysis } from "@devrecap/report-engine";
import { cliConfigPath, effectiveSources, readCliConfig, requireCliConfig, writeCliConfig, type CliSourcePermissions } from "./config.ts";
import { inferReportKind, resolveCliInvocation, resolveRange, type CommandPreset } from "./commands.ts";
import { collectAuthorizedSources } from "./source-runner.ts";

interface CliOptions {
  request: string;
  from?: string;
  to?: string;
  out?: string;
  run?: string;
  analysis?: string;
  pdf?: string;
  style: ReportStyle;
  length: ReportLength;
  locale: "en" | "pt-BR";
  git: boolean;
  codex: boolean;
  claude: boolean;
  kind?: ReportKind;
}

interface PreparedRun {
  version: 1;
  request: string;
  locale: "en" | "pt-BR";
  generatedAt: string;
  sources: {
    codexSessions: number;
    claudeSessions: number;
    gitRepositories: number;
    gitCommits: number;
    warnings: string[];
  };
  input: ReportInput;
  contract: ReturnType<typeof buildAnalysisContract>;
  prompt: string;
}

async function main(): Promise<void> {
  const invocation = resolveCliInvocation(process.argv.slice(2));
  if (invocation.operation === "help") return printHelp();
  if (invocation.operation === "setup") return setupCommand(invocation.args);
  if (invocation.operation === "sources") return sourcesCommand();
  if (invocation.operation === "prepare") { prepareCommand(parseOptions(invocation.args, invocation.preset)); return; }
  if (invocation.operation === "render") { renderCommand(parseOptions(invocation.args, invocation.preset)); return; }
  reportCommand(parseOptions(invocation.args, invocation.preset));
}

main().catch((error) => {
  process.stderr.write(`DevRecap error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function setupCommand(args: string[]): Promise<void> {
  const current = readCliConfig();
  const explicit = parseSetupFlags(args, current?.sources);
  let sources: CliSourcePermissions;

  process.stdout.write("\nDevRecap setup\n\n");
  process.stdout.write("DevRecap can use local developer history to reconstruct your work.\n\n");
  process.stdout.write("It will only read sources you authorize, never modify Codex/Claude history,\n");
  process.stdout.write("never modify Git repositories, never run project code, and never create background watchers.\n\n");

  if (explicit) {
    sources = explicit;
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Interactive setup requires a terminal. Use `devrecap setup --codex --git --no-claude` (choose your sources explicitly).");
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      sources = {
        codex: await askYesNo(rl, "Allow read-only access to Codex session history?", current?.sources.codex ?? false),
        claude: await askYesNo(rl, "Allow read-only access to Claude Code session history?", current?.sources.claude ?? false),
        git: await askYesNo(rl, "Allow read-only Git history for detected projects?", current?.sources.git ?? false),
      };
    } finally {
      rl.close();
    }
  }

  const config = writeCliConfig(sources);
  process.stdout.write(`\n✓ Configuration saved to ${cliConfigPath()}\n`);
  process.stdout.write(`  Codex: ${config.sources.codex ? "enabled" : "disabled"}\n`);
  process.stdout.write(`  Claude Code: ${config.sources.claude ? "enabled" : "disabled"}\n`);
  process.stdout.write(`  Git: ${config.sources.git ? "enabled (read-only)" : "disabled"}\n`);
  process.stdout.write("\nRun `devrecap sources` to review these permissions.\n");
}

function sourcesCommand(): void {
  const config = readCliConfig();
  process.stdout.write("\nDevRecap sources\n\n");
  if (!config) {
    process.stdout.write("Codex       not authorized\n");
    process.stdout.write("Claude Code  not authorized\n");
    process.stdout.write("Git          not authorized\n\n");
    process.stdout.write("No local source was inspected. Run `devrecap setup` to choose what DevRecap may read.\n");
    return;
  }

  const codexRoot = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME, "sessions") : resolve(homedir(), ".codex", "sessions");
  const claudeRoot = resolve(homedir(), ".claude", "projects");
  process.stdout.write(`Codex       ${config.sources.codex ? `enabled  (${codexRoot})` : "disabled"}\n`);
  process.stdout.write(`Claude Code  ${config.sources.claude ? `enabled  (${claudeRoot})` : "disabled"}\n`);
  process.stdout.write(`Git          ${config.sources.git ? "enabled  (read-only; detected projects only)" : "disabled"}\n`);
  process.stdout.write(`\nConfig: ${cliConfigPath()}\n`);
  process.stdout.write("No files or repositories were modified.\n");
}

function prepareCommand(options: CliOptions): PreparedRun {
  // IMPORTANT: require consent before invoking ANY local collector.
  const config = requireCliConfig();
  const enabled = effectiveSources(config, { codex: options.codex, claude: options.claude, git: options.git });
  const range = resolveRange(options.request, options.from, options.to);
  const collected = collectAuthorizedSources(range, enabled);
  const { codex, claude, git } = collected;
  const sessionEvents = [...codex.events, ...claude.events];
  const gitRoots = git.repositories.map((r) => r.root);
  const projectByRoot = new Map<string, Project>();

  for (const event of sessionEvents) {
    const root = projectRootForCwd(event.cwd, gitRoots);
    if (root) ensureProject(projectByRoot, root, git.repositories.find((r) => r.root === root)?.gitRemote);
  }
  for (const repo of git.repositories) ensureProject(projectByRoot, repo.root, repo.gitRemote);
  if (!projectByRoot.size) ensureProject(projectByRoot, resolve(process.cwd()));

  const activities: Activity[] = [];
  activities.push(...buildSessionActivities(codex.events, "codex", projectByRoot, gitRoots));
  activities.push(...buildSessionActivities(claude.events, "claude", projectByRoot, gitRoots));

  const allCommits: Commit[] = [];
  for (const repo of git.repositories) {
    const project = projectByRoot.get(repo.root)!;
    for (const commit of repo.commits) allCommits.push({ ...commit, projectId: project.id });
  }

  const matchedCommitIds = new Set<string>();
  for (const activity of activities) {
    const candidates = allCommits.filter((c) => c.projectId === activity.projectId);
    const result = correlateActivityWithCommits(activity, candidates);
    for (const evidence of result.evidence) if (evidence.refId) matchedCommitIds.add(evidence.refId);
    if (result.evidence.length) activity.evidence = [...(activity.evidence ?? []), ...result.evidence];
    activity.confidence = Math.min(0.99, Number((activity.confidence + result.confidenceDelta).toFixed(2)));
    if (result.statusToCompleted && activity.status !== "blocked") activity.status = "completed";
  }

  for (const repo of git.repositories) {
    const project = projectByRoot.get(repo.root)!;
    const unmatched = repo.events.filter((event) => !matchedCommitIds.has((event.data as Commit).id));
    if (!unmatched.length) continue;
    const built = buildActivities(normalizeEvents(unmatched), "git", { projectId: project.id });
    for (const item of built) {
      item.activity.evidence = item.evidence;
      activities.push(item.activity);
    }
  }

  const projects = [...projectByRoot.values()];
  const kind = inferReportKind(options.request, range, options.kind);
  const { input } = buildReportInput(activities, projects, {
    kind,
    style: options.style,
    length: options.length,
    range,
    redactionEnabled: true,
  });
  const prompt = buildAnalysisPrompt(input, { request: options.request, language: options.locale });
  const prepared: PreparedRun = {
    version: 1,
    request: options.request,
    locale: options.locale,
    generatedAt: nowIso(),
    sources: {
      codexSessions: codex.filesRead,
      claudeSessions: claude.filesRead,
      gitRepositories: git.repositories.length,
      gitCommits: allCommits.length,
      warnings: [...codex.warnings, ...claude.warnings, ...git.warnings],
    },
    input,
    contract: buildAnalysisContract(input, { request: options.request, language: options.locale }),
    prompt,
  };
  const out = resolve(options.out ?? ".devrecap/run.json");
  writeJson(out, prepared);
  printPrepared(prepared, out);
  return prepared;
}

function renderCommand(options: CliOptions): void {
  const runPath = resolve(options.run ?? ".devrecap/run.json");
  if (!existsSync(runPath)) throw new Error(`Prepared run not found: ${runPath}`);
  const run = JSON.parse(readFileSync(runPath, "utf8")) as PreparedRun;
  const analysisPath = options.analysis ? resolve(options.analysis) : resolve(".devrecap/analysis.json");
  const rawAnalysis = existsSync(analysisPath) ? JSON.parse(readFileSync(analysisPath, "utf8")) : buildDeterministicAnalysis(run.input);
  const analysis = validateReportAnalysis(run.input, rawAnalysis);
  const htmlPath = resolve(options.out ?? defaultReportName(run.input));
  mkdirSync(dirname(htmlPath), { recursive: true });
  writeFileSync(htmlPath, renderHtmlReport(run.input, analysis, { locale: run.locale }), "utf8");
  process.stdout.write(`\n✓ HTML report: ${htmlPath}\n`);
  if (options.pdf) {
    const pdfPath = resolve(options.pdf);
    if (printPdf(htmlPath, pdfPath)) process.stdout.write(`✓ PDF report: ${pdfPath}\n`);
    else process.stdout.write("! PDF skipped: no Chrome/Chromium executable was found. The HTML is print-ready.\n");
  }
}

function reportCommand(options: CliOptions): void {
  const runPath = resolve(".devrecap/run.json");
  const prepared = prepareCommand({ ...options, out: runPath });
  const analysisPath = resolve(".devrecap/analysis.json");
  writeJson(analysisPath, buildDeterministicAnalysis(prepared.input));
  printTerminalRecap(prepared);
  renderCommand({ ...options, run: runPath, analysis: analysisPath, out: options.out ?? defaultReportName(prepared.input) });
  process.stdout.write("\nTip: through the DevRecap skill, Codex/Claude can analyze run.prompt before render for a richer report.\n");
}

function buildSessionActivities(events: RawEvent[], source: "codex" | "claude", projects: Map<string, Project>, gitRoots: string[]): Activity[] {
  const groups = new Map<string, RawEvent[]>();
  for (const event of events) {
    const root = projectRootForCwd(event.cwd, gitRoots) ?? resolve(process.cwd());
    if (!projects.has(root)) ensureProject(projects, root);
    const key = `${source}\u0000${root}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const out: Activity[] = [];
  for (const [key, raw] of groups) {
    const root = key.split("\u0000")[1];
    const project = projects.get(root)!;
    const built = buildActivities(normalizeEvents(raw), source as unknown as Activity["source"], { projectId: project.id });
    for (const item of built) {
      item.activity.evidence = item.evidence;
      const m = (item.activity.metadata ?? {}) as Record<string, unknown>;
      m.files = uniqueStrings(m.filesModified, m.filesCreated, m.filesDeleted, m.filesRead);
      item.activity.metadata = m;
      out.push(item.activity);
    }
  }
  return out;
}

function ensureProject(map: Map<string, Project>, root: string, gitRemote?: string): Project {
  const normalized = resolve(root);
  const existing = map.get(normalized);
  if (existing) return existing;
  const project: Project = {
    id: stableId("prj", normalized),
    name: basename(normalized) || normalized,
    displayName: basename(normalized) || normalized,
    type: "other",
    rootPath: normalized,
    gitRemote,
    detectedFrom: "terminal-collector",
    createdAt: nowIso(),
  };
  map.set(normalized, project);
  return project;
}

function parseOptions(args: string[], preset?: CommandPreset): CliOptions {
  const values: Record<string, string | boolean> = {};
  const requestParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) { requestParts.push(arg); continue; }
    if (arg === "--no-git") { values.git = false; continue; }
    if (arg === "--no-codex") { values.codex = false; continue; }
    if (arg === "--no-claude") { values.claude = false; continue; }
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) values[key] = inline;
    else if (args[i + 1] && !args[i + 1].startsWith("--")) values[key] = args[++i];
    else values[key] = true;
  }

  const positional = requestParts.join(" ").trim();
  const request = String(values.request ?? positional || preset?.request || "this week");
  const style = oneOf(values.style, ["spoken", "professional", "executive", "technical"], preset?.style ?? "professional") as ReportStyle;
  const length = oneOf(values.length, ["short", "normal", "detailed"], preset?.length ?? "normal") as ReportLength;
  const locale = String(values.lang ?? "") === "pt-BR" || looksPortuguese(request) ? "pt-BR" : "en";
  const kind = typeof values.kind === "string" ? values.kind as ReportKind : preset?.kind;
  return {
    request,
    from: stringValue(values.from),
    to: stringValue(values.to),
    out: stringValue(values.out),
    run: stringValue(values.run),
    analysis: stringValue(values.analysis),
    pdf: stringValue(values.pdf),
    style,
    length,
    locale,
    git: values.git !== false,
    codex: values.codex !== false,
    claude: values.claude !== false,
    kind,
  };
}

function parseSetupFlags(args: string[], current?: CliSourcePermissions): CliSourcePermissions | null {
  const hasSourceFlag = args.some((a) => ["--all", "--codex", "--claude", "--git", "--no-codex", "--no-claude", "--no-git"].includes(a));
  if (!hasSourceFlag) return null;
  const out: CliSourcePermissions = current ? { ...current } : { codex: false, claude: false, git: false };
  if (args.includes("--all")) out.codex = out.claude = out.git = true;
  if (args.includes("--codex")) out.codex = true;
  if (args.includes("--claude")) out.claude = true;
  if (args.includes("--git")) out.git = true;
  if (args.includes("--no-codex")) out.codex = false;
  if (args.includes("--no-claude")) out.claude = false;
  if (args.includes("--no-git")) out.git = false;
  return out;
}

async function askYesNo(rl: ReturnType<typeof createInterface>, question: string, current: boolean): Promise<boolean> {
  const suffix = current ? " [Y/n] " : " [y/N] ";
  const answer = (await rl.question(question + suffix)).trim().toLowerCase();
  if (!answer) return current;
  return answer === "y" || answer === "yes" || answer === "s" || answer === "sim";
}

function printTerminalRecap(run: PreparedRun): void {
  const pt = run.locale === "pt-BR";
  const main = run.input.workstreams.filter((w) => w.workKind === "primary").slice(0, 5);
  const open = run.input.workstreams.filter((w) => ["in_progress", "blocked", "partially_completed", "unconfirmed"].includes(w.status)).slice(0, 5);
  const total = run.input.projects.reduce((n, p) => n + p.activities.length, 0);

  process.stdout.write(`\n${pt ? "DevRecap — resumo" : "DevRecap — recap"} ${run.input.range.start.slice(0, 10)} → ${run.input.range.end.slice(0, 10)}\n`);
  if (main.length) {
    process.stdout.write(`\n${pt ? "Principais frentes" : "Main work"}\n`);
    for (const w of main) process.stdout.write(`• ${w.objective || w.title}\n`);
  }
  if (open.length) {
    process.stdout.write(`\n${pt ? "Ainda em aberto" : "Still open"}\n`);
    for (const w of open) process.stdout.write(`• ${w.objective || w.title} (${w.status})\n`);
  }
  process.stdout.write(`\n${run.sources.codexSessions + run.sources.claudeSessions} ${pt ? "sessões analisadas" : "sessions analyzed"}\n`);
  process.stdout.write(`${total} ${pt ? "atividades significativas" : "meaningful activities"}\n`);
  process.stdout.write(`${run.sources.gitCommits} ${pt ? "commits correlacionados/lidos" : "Git commits read/correlated"}\n`);
}

function looksPortuguese(text: string): boolean {
  return /\b(essa|esta|semana|hoje|relatório|relatorio|atividades|últimos|ultimos|dias|meu|minhas|lembrar|revisão|revisao)\b/i.test(text);
}

function stringValue(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function oneOf(v: string | boolean | undefined, allowed: string[], fallback: string): string {
  const s = String(v ?? "");
  return allowed.includes(s) ? s : fallback;
}

function uniqueStrings(...values: unknown[]): string[] {
  return [...new Set(values.flatMap((v) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []))];
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function defaultReportName(input: ReportInput): string {
  return `reports/devrecap-${input.range.start.slice(0, 10)}_${input.range.end.slice(0, 10)}.html`;
}

function printPrepared(run: PreparedRun, path: string): void {
  const total = run.input.projects.reduce((n, p) => n + p.activities.length, 0);
  process.stdout.write(`\nDevRecap prepared ${run.input.range.start.slice(0, 10)} → ${run.input.range.end.slice(0, 10)}\n`);
  process.stdout.write(`✓ Codex transcripts: ${run.sources.codexSessions}\n`);
  process.stdout.write(`✓ Claude transcripts: ${run.sources.claudeSessions}\n`);
  process.stdout.write(`✓ Git commits: ${run.sources.gitCommits}\n`);
  process.stdout.write(`✓ Meaningful activities: ${total}\n`);
  process.stdout.write(`✓ AI contract: ${path}\n`);
  for (const w of run.sources.warnings.slice(0, 5)) process.stdout.write(`! ${w}\n`);
}

function printPdf(htmlPath: string, pdfPath: string): boolean {
  mkdirSync(dirname(pdfPath), { recursive: true });
  const candidates = [process.env.CHROME_PATH, "google-chrome", "chromium", "chromium-browser", "chrome"].filter((x): x is string => Boolean(x));
  for (const binary of candidates) {
    try {
      execFileSync(binary, ["--headless", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href], { stdio: "ignore" });
      if (existsSync(pdfPath)) return true;
    } catch {}
  }
  return false;
}

function printHelp(): void {
  process.stdout.write(`DevRecap — terminal-first developer work recap\n\nUsage:\n  devrecap setup\n  devrecap sources\n  devrecap today\n  devrecap week\n  devrecap month\n  devrecap daily\n  devrecap remember [\"last 14 days\"]\n  devrecap review [--from YYYY-MM-DD --to YYYY-MM-DD]\n  devrecap \"essa semana\"\n\nSkill pipeline:\n  devrecap prepare --request \"this week\" --out .devrecap/run.json\n  devrecap render --run .devrecap/run.json --analysis .devrecap/analysis.json --out report.html\n\nSetup flags (for non-interactive use):\n  --all | --codex | --claude | --git | --no-codex | --no-claude | --no-git\n\nReport options:\n  --from YYYY-MM-DD\n  --to YYYY-MM-DD\n  --style professional|executive|technical|spoken\n  --length short|normal|detailed\n  --lang pt-BR|en\n  --out <file.html>\n  --pdf <file.pdf>\n  --no-git | --no-codex | --no-claude\n\nPrivacy:\n  Local collectors never run before `devrecap setup`. The web app remains manual-import only.\n`);
}
