#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Activity, Commit, Project, RawEvent, ReportInput, ReportLength, ReportStyle } from "@devrecap/shared";
import { nowIso, stableId } from "@devrecap/shared";
import { collectClaudeSessions, collectCodexSessions, collectGitHistory, discoverProjectDirectories, projectRootForCwd } from "@devrecap/collectors";
import { buildActivities, correlateActivityWithCommits, normalizeEvents } from "@devrecap/activity-engine";
import { buildAnalysisContract, buildAnalysisPrompt, buildDeterministicAnalysis, buildReportInput, renderHtmlReport, validateReportAnalysis } from "@devrecap/report-engine";

interface CliOptions { request: string; from?: string; to?: string; out?: string; run?: string; analysis?: string; pdf?: string; style: ReportStyle; length: ReportLength; locale: "en" | "pt-BR"; git: boolean; codex: boolean; claude: boolean; }
interface PreparedRun { version: 1; request: string; locale: "en" | "pt-BR"; generatedAt: string; sources: { codexSessions: number; claudeSessions: number; gitRepositories: number; gitCommits: number; warnings: string[]; }; input: ReportInput; contract: ReturnType<typeof buildAnalysisContract>; prompt: string; }

const argv = process.argv.slice(2);
const knownCommands = new Set(["prepare", "render", "report", "help", "--help", "-h"]);
const first = argv[0] ?? "help";
const command = knownCommands.has(first) ? first : "report";
const rest = knownCommands.has(first) ? argv.slice(1) : argv;

try {
  if (command === "help" || command === "--help" || command === "-h") printHelp();
  else if (command === "prepare") prepareCommand(parseOptions(rest));
  else if (command === "render") renderCommand(parseOptions(rest));
  else reportCommand(parseOptions(rest));
} catch (error) {
  process.stderr.write(`DevRecap error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function prepareCommand(options: CliOptions): PreparedRun {
  const range = resolveRange(options.request, options.from, options.to);
  const codex = options.codex ? collectCodexSessions(range) : emptySession("codex");
  const claude = options.claude ? collectClaudeSessions(range) : emptySession("claude");
  const sessionEvents = [...codex.events, ...claude.events];
  const directories = discoverProjectDirectories(sessionEvents, true);
  const git = options.git ? collectGitHistory(directories, range) : { repositories: [], warnings: [] };
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
    for (const item of built) { item.activity.evidence = item.evidence; activities.push(item.activity); }
  }

  const projects = [...projectByRoot.values()];
  const { input } = buildReportInput(activities, projects, { kind: reportKind(options.request, range), style: options.style, length: options.length, range, redactionEnabled: true });
  const prompt = buildAnalysisPrompt(input, { request: options.request, language: options.locale });
  const prepared: PreparedRun = {
    version: 1, request: options.request, locale: options.locale, generatedAt: nowIso(),
    sources: { codexSessions: codex.filesRead, claudeSessions: claude.filesRead, gitRepositories: git.repositories.length, gitCommits: allCommits.length, warnings: [...codex.warnings, ...claude.warnings, ...git.warnings] },
    input, contract: buildAnalysisContract(input, { request: options.request, language: options.locale }), prompt,
  };
  const out = resolve(options.out ?? ".devrecap/run.json"); writeJson(out, prepared); printPrepared(prepared, out); return prepared;
}

function renderCommand(options: CliOptions): void {
  const runPath = resolve(options.run ?? ".devrecap/run.json");
  if (!existsSync(runPath)) throw new Error(`Prepared run not found: ${runPath}`);
  const run = JSON.parse(readFileSync(runPath, "utf8")) as PreparedRun;
  const analysisPath = options.analysis ? resolve(options.analysis) : resolve(".devrecap/analysis.json");
  const rawAnalysis = existsSync(analysisPath) ? JSON.parse(readFileSync(analysisPath, "utf8")) : buildDeterministicAnalysis(run.input);
  const analysis = validateReportAnalysis(run.input, rawAnalysis);
  const htmlPath = resolve(options.out ?? defaultReportName(run.input));
  mkdirSync(dirname(htmlPath), { recursive: true }); writeFileSync(htmlPath, renderHtmlReport(run.input, analysis, { locale: run.locale }), "utf8");
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
  const analysisPath = resolve(".devrecap/analysis.json"); writeJson(analysisPath, buildDeterministicAnalysis(prepared.input));
  renderCommand({ ...options, run: runPath, analysis: analysisPath, out: options.out ?? defaultReportName(prepared.input) });
  process.stdout.write("\nTip: through the DevRecap skill, Codex/Claude analyzes run.prompt before render for a richer report.\n");
}

function buildSessionActivities(events: RawEvent[], source: "codex" | "claude", projects: Map<string, Project>, gitRoots: string[]): Activity[] {
  const groups = new Map<string, RawEvent[]>();
  for (const event of events) {
    const root = projectRootForCwd(event.cwd, gitRoots) ?? resolve(process.cwd()); if (!projects.has(root)) ensureProject(projects, root);
    const key = `${source}\u0000${root}`; const group = groups.get(key) ?? []; group.push(event); groups.set(key, group);
  }
  const out: Activity[] = [];
  for (const [key, raw] of groups) {
    const root = key.split("\u0000")[1]; const project = projects.get(root)!;
    const built = buildActivities(normalizeEvents(raw), source as unknown as Activity["source"], { projectId: project.id });
    for (const item of built) {
      item.activity.evidence = item.evidence;
      const m = (item.activity.metadata ?? {}) as Record<string, unknown>; m.files = uniqueStrings(m.filesModified, m.filesCreated, m.filesDeleted, m.filesRead); item.activity.metadata = m; out.push(item.activity);
    }
  }
  return out;
}

function ensureProject(map: Map<string, Project>, root: string, gitRemote?: string): Project {
  const normalized = resolve(root); const existing = map.get(normalized); if (existing) return existing;
  const project: Project = { id: stableId("prj", normalized), name: basename(normalized) || normalized, displayName: basename(normalized) || normalized, type: "other", rootPath: normalized, gitRemote, detectedFrom: "terminal-collector", createdAt: nowIso() };
  map.set(normalized, project); return project;
}

function parseOptions(args: string[]): CliOptions {
  const values: Record<string, string | boolean> = {}; const requestParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]; if (!arg.startsWith("--")) { requestParts.push(arg); continue; }
    if (arg === "--no-git") { values.git = false; continue; } if (arg === "--no-codex") { values.codex = false; continue; } if (arg === "--no-claude") { values.claude = false; continue; }
    const [key, inline] = arg.slice(2).split("=", 2); if (inline !== undefined) values[key] = inline; else if (args[i + 1] && !args[i + 1].startsWith("--")) values[key] = args[++i]; else values[key] = true;
  }
  const request = String(values.request ?? (requestParts.join(" ") || "this week"));
  const style = oneOf(values.style, ["spoken", "professional", "executive", "technical"], "professional") as ReportStyle;
  const length = oneOf(values.length, ["short", "normal", "detailed"], "normal") as ReportLength;
  const locale = String(values.lang ?? "") === "pt-BR" || looksPortuguese(request) ? "pt-BR" : "en";
  return { request, from: stringValue(values.from), to: stringValue(values.to), out: stringValue(values.out), run: stringValue(values.run), analysis: stringValue(values.analysis), pdf: stringValue(values.pdf), style, length, locale, git: values.git !== false, codex: values.codex !== false, claude: values.claude !== false };
}

function resolveRange(request: string, from?: string, to?: string): { start: string; end: string } {
  if (from || to) return { start: from ? startOfDate(from) : startOfToday().toISOString(), end: to ? endOfDate(to) : new Date().toISOString() };
  const now = new Date(); if (/\b(hoje|today)\b/i.test(request)) return { start: startOfToday().toISOString(), end: now.toISOString() };
  const matchPt = /(?:últimos|ultimos)\s+(\d+)\s+dias/i.exec(request); const matchEn = /last\s+(\d+)\s+days/i.exec(request); const days = Number(matchPt?.[1] ?? matchEn?.[1]);
  if (Number.isFinite(days) && days > 0) { const start = startOfToday(); start.setDate(start.getDate() - (days - 1)); return { start: start.toISOString(), end: now.toISOString() }; }
  const start = startOfToday(); const day = start.getDay(); start.setDate(start.getDate() - (day === 0 ? 6 : day - 1)); return { start: start.toISOString(), end: now.toISOString() };
}
function reportKind(request:string, range:{start:string;end:string}): "daily"|"weekly"|"custom"|"monthly" { if(/\b(hoje|today)\b/i.test(request))return "daily"; if(/\b(mês|mes|month)\b/i.test(request))return "monthly"; return (Date.parse(range.end)-Date.parse(range.start))/86_400_000<=7.5?"weekly":"custom"; }
function startOfToday():Date{const d=new Date();d.setHours(0,0,0,0);return d}
function startOfDate(value:string):string{const d=new Date(`${value}T00:00:00`);if(!Number.isFinite(d.getTime()))throw new Error(`Invalid date: ${value}`);return d.toISOString()}
function endOfDate(value:string):string{const d=new Date(`${value}T23:59:59.999`);if(!Number.isFinite(d.getTime()))throw new Error(`Invalid date: ${value}`);return d.toISOString()}
function looksPortuguese(text:string):boolean{return /\b(essa|esta|semana|hoje|relatório|relatorio|atividades|últimos|ultimos|dias|meu|minhas)\b/i.test(text)}
function stringValue(v:string|boolean|undefined):string|undefined{return typeof v==="string"?v:undefined}
function oneOf(v:string|boolean|undefined,a:string[],f:string):string{const s=String(v??"");return a.includes(s)?s:f}
function uniqueStrings(...values:unknown[]):string[]{return [...new Set(values.flatMap((v)=>Array.isArray(v)?v.filter((x):x is string=>typeof x==="string"):[]))]}
function writeJson(path:string,value:unknown):void{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2),"utf8")}
function emptySession(source:"codex"|"claude"){return {source,events:[] as RawEvent[],filesRead:0,malformed:0,warnings:[] as string[]}}
function defaultReportName(input:ReportInput):string{return `reports/devrecap-${input.range.start.slice(0,10)}_${input.range.end.slice(0,10)}.html`}
function printPrepared(run:PreparedRun,path:string):void{const total=run.input.projects.reduce((n,p)=>n+p.activities.length,0);process.stdout.write(`\nDevRecap prepared ${run.input.range.start.slice(0,10)} → ${run.input.range.end.slice(0,10)}\n✓ Codex transcripts: ${run.sources.codexSessions}\n✓ Claude transcripts: ${run.sources.claudeSessions}\n✓ Git commits: ${run.sources.gitCommits}\n✓ Meaningful activities: ${total}\n✓ AI contract: ${path}\n`);for(const w of run.sources.warnings.slice(0,5))process.stdout.write(`! ${w}\n`)}
function printPdf(htmlPath:string,pdfPath:string):boolean{mkdirSync(dirname(pdfPath),{recursive:true});const candidates=[process.env.CHROME_PATH,"google-chrome","chromium","chromium-browser","chrome"].filter((x):x is string=>Boolean(x));for(const binary of candidates){try{execFileSync(binary,["--headless","--disable-gpu","--no-pdf-header-footer",`--print-to-pdf=${pdfPath}`,pathToFileURL(htmlPath).href],{stdio:"ignore"});if(existsSync(pdfPath))return true}catch{}}return false}
function printHelp():void{process.stdout.write(`DevRecap terminal recap\n\nUsage:\n  devrecap "essa semana"\n  devrecap prepare "essa semana" --out .devrecap/run.json\n  devrecap render --run .devrecap/run.json --analysis .devrecap/analysis.json --out report.html --pdf report.pdf\n\nOptions:\n  --from YYYY-MM-DD\n  --to YYYY-MM-DD\n  --style professional|executive|technical|spoken\n  --length short|normal|detailed\n  --lang pt-BR|en\n  --no-codex | --no-claude | --no-git\n`)}
