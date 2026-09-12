import type { ActivitySummary, ReportInput } from "@devrecap/shared";

export interface AnalysisItem { title: string; narrative: string; activityIds: string[]; confidence: number; }
export interface ReportAnalysis { version: 1; headline: string; executiveSummary: string; summaryActivityIds: string[]; mainFocus?: AnalysisItem; highlights: AnalysisItem[]; investigations: AnalysisItem[]; inProgress: AnalysisItem[]; blockers: AnalysisItem[]; nextSteps: AnalysisItem[]; }
export interface AnalysisOptions { language?: string; request?: string; }
export interface AnalysisContract { version: 1; language: string; rules: string[]; allowedActivityIds: string[]; outputShape: Record<string, unknown>; facts: ReportInput; }

export function buildAnalysisContract(input: ReportInput, options: AnalysisOptions = {}): AnalysisContract {
  const allowedActivityIds = input.projects.flatMap((p) => p.activities.map((a) => a.id));
  return { version: 1, language: options.language ?? "auto", allowedActivityIds, rules: ["Use only the supplied facts.", "Every analysis item must reference one or more allowed activityIds.", "Never change an in_progress, blocked, or unknown activity into completed work.", "Session activity means worked on; shipped/delivered language requires completion or commit evidence.", "Highlights/key deliveries may reference only completed activities.", "In-progress, blocker, and investigation sections must match the referenced activities' evidence-backed state.", "Prefer meaningful outcomes over command-by-command narration.", "Return JSON only."], outputShape: { headline: "string", executiveSummary: "string", summaryActivityIds: ["act_id"], mainFocus: { title: "string", narrative: "string", activityIds: ["act_id"], confidence: 0.9 }, highlights: [], investigations: [], inProgress: [], blockers: [], nextSteps: [] }, facts: input };
}

export function buildAnalysisPrompt(input: ReportInput, options: AnalysisOptions = {}): string {
  const contract = buildAnalysisContract(input, options);
  return ["You are the DevRecap analysis layer.", options.request ? `User request: ${options.request}` : "", `Language: ${contract.language}.`, "Analyze only the contract facts. Never invent work. Return exactly one JSON object matching outputShape, and cite allowed activityIds in every item.", JSON.stringify(contract, null, 2)].filter(Boolean).join("\n");
}

export function validateReportAnalysis(input: ReportInput, raw: unknown): ReportAnalysis {
  const fallback = buildDeterministicAnalysis(input);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const o = raw as Record<string, unknown>;
  const activities = input.projects.flatMap((p) => p.activities);
  const byId = new Map(activities.map((a) => [a.id, a]));
  const known = new Set(byId.keys());
  const summaryIds = ids(o.summaryActivityIds, known);
  const list = (value: unknown, max = 8, predicate?: (a: ActivitySummary) => boolean) => validateItems(value, known, byId, max, predicate);
  const highlights = list(o.highlights, 8, (a) => a.status === "completed");
  const investigations = list(o.investigations, 8, (a) => a.category === "investigation");
  const inProgress = list(o.inProgress, 8, (a) => a.status === "in_progress" || a.status === "unknown");
  const blockers = list(o.blockers, 6, (a) => a.status === "blocked");
  const nextSteps = list(o.nextSteps, 6, (a) => a.status !== "completed");
  return {
    version: 1,
    headline: text(o.headline, fallback.headline, 140),
    executiveSummary: text(o.executiveSummary, fallback.executiveSummary, 1400),
    summaryActivityIds: summaryIds.length ? summaryIds : fallback.summaryActivityIds,
    mainFocus: validateItem(o.mainFocus, known, byId) ?? fallback.mainFocus,
    highlights: highlights.length ? highlights : fallback.highlights,
    investigations: investigations.length ? investigations : fallback.investigations,
    inProgress: inProgress.length ? inProgress : fallback.inProgress,
    blockers: blockers.length ? blockers : fallback.blockers,
    nextSteps: nextSteps.length ? nextSteps : fallback.nextSteps,
  };
}

export function buildDeterministicAnalysis(input: ReportInput): ReportAnalysis {
  const all = input.projects.flatMap((p) => p.activities);
  const done = all.filter((a) => a.status === "completed");
  const inv = all.filter((a) => a.category === "investigation");
  const open = all.filter((a) => a.status === "in_progress" || a.status === "unknown");
  const blocked = all.filter((a) => a.status === "blocked");
  const ranked = [...all].sort((a,b) => score(b)-score(a));
  const period = `${input.range.start.slice(0,10)} → ${input.range.end.slice(0,10)}`;
  return { version: 1, headline: all.length ? `DevRecap — ${all.length} meaningful activities` : "DevRecap — no meaningful activity detected", executiveSummary: all.length ? `DevRecap reconstructed ${all.length} meaningful activities across ${input.projects.length} project(s) for ${period}. ${done.length} have completion evidence; ${open.length} remain in progress or unconfirmed.` : `No evidence-backed development activity was detected for ${period}.`, summaryActivityIds: ranked.slice(0,8).map((a)=>a.id), mainFocus: ranked[0] ? item(ranked[0], ranked[0].summary) : undefined, highlights: done.slice(0,8).map((a)=>item(a,a.summary)), investigations: inv.slice(0,8).map((a)=>item(a,a.summary)), inProgress: open.slice(0,8).map((a)=>item(a,a.summary)), blockers: blocked.slice(0,6).map((a)=>item(a,a.summary)), nextSteps: open.slice(0,6).map((a)=>item(a,`Continue or verify: ${a.title}`)) };
}
function item(a: ActivitySummary, narrative: string): AnalysisItem { return { title:a.title, narrative, activityIds:[a.id], confidence:clamp(a.confidence) }; }
function score(a: ActivitySummary): number { return (a.status === "completed" ? 4 : a.status === "in_progress" ? 3 : a.status === "blocked" ? 2 : 1) + (a.category === "feature" || a.category === "bugfix" ? 3 : 1) + Math.min(a.evidenceCount,8)/8 + a.confidence; }
function validateItems(raw: unknown, known: Set<string>, byId: Map<string, ActivitySummary>, max: number, predicate?: (a: ActivitySummary) => boolean): AnalysisItem[] { if (!Array.isArray(raw)) return []; const out:AnalysisItem[]=[]; for (const x of raw) { const v=validateItem(x,known,byId,predicate); if(v) out.push(v); if(out.length>=max) break; } return out; }
function validateItem(raw: unknown, known: Set<string>, byId: Map<string, ActivitySummary>, predicate?: (a: ActivitySummary) => boolean): AnalysisItem | undefined { if(!raw||typeof raw!=="object"||Array.isArray(raw)) return; const o=raw as Record<string,unknown>; const activityIds=ids(o.activityIds,known); if(!activityIds.length) return; if (predicate && !activityIds.every((id) => { const a=byId.get(id); return !!a && predicate(a); })) return; const narrative=text(o.narrative,"",1200); if(!narrative) return; return { title:text(o.title,"Activity",180), narrative, activityIds, confidence:typeof o.confidence==="number"?clamp(o.confidence):0.7 }; }
function ids(raw: unknown, known:Set<string>):string[]{ return Array.isArray(raw)?[...new Set(raw.filter((x):x is string=>typeof x==="string"&&known.has(x)))]:[]; }
function text(raw: unknown, fallback:string, max:number):string { if(typeof raw!=="string") return fallback; const t=raw.replace(/\s+/g," ").trim(); if(!t) return fallback; return t.length>max?`${t.slice(0,max-1)}…`:t; }
function clamp(n:number):number{return Math.max(0,Math.min(1,Number(n.toFixed(2))))}
