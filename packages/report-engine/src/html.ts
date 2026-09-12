import type { ActivitySummary, ReportInput } from "@devrecap/shared";
import type { AnalysisItem, ReportAnalysis } from "./analysis.ts";

export interface HtmlReportOptions { locale?: "en" | "pt-BR"; title?: string; }

export function renderHtmlReport(input: ReportInput, analysis: ReportAnalysis, options: HtmlReportOptions = {}): string {
  const pt = options.locale === "pt-BR";
  const activities = input.projects.flatMap((p) => p.activities);
  const byId = new Map(activities.map((a) => [a.id, a]));
  const done = activities.filter((a) => a.status === "completed").length;
  const evidence = activities.reduce((n, a) => n + a.evidenceCount, 0);
  const section = (title: string, items: AnalysisItem[]) => items.length ? `<section><h2>${esc(title)}</h2><div class="grid">${items.map((item) => card(item, byId)).join("")}</div></section>` : "";
  const labels = pt ? { focus:"Foco principal", highlights:"Principais entregas", investigations:"Investigações", progress:"Em andamento", blockers:"Bloqueios", next:"Próximos passos", projects:"Projetos", activities:"Atividades", completed:"Concluídas", evidence:"Evidências" } : { focus:"Main focus", highlights:"Key deliveries", investigations:"Investigations", progress:"In progress", blockers:"Blockers", next:"Next steps", projects:"Projects", activities:"Activities", completed:"Completed", evidence:"Evidence" };
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(options.title ?? analysis.headline)}</title><style>body{margin:0;background:#f3f4f6;color:#16181d;font-family:Arial,sans-serif}.page{max-width:1000px;margin:32px auto;background:white;border-radius:22px;overflow:hidden;box-shadow:0 18px 48px #0001}header{padding:48px;background:linear-gradient(135deg,#fff,#eef0f3)}h1{font-size:46px;line-height:1;margin:12px 0}header p{font-size:18px;color:#555;max-width:800px}.brand{font-weight:800;letter-spacing:.18em}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:20px 48px;border-top:1px solid #eee;border-bottom:1px solid #eee}.metric{background:#f7f8fa;padding:16px;border-radius:12px}.metric b{display:block;font-size:28px}.metric span{font-size:12px;color:#666}main{padding:12px 48px 48px}section{padding:24px 0;border-bottom:1px solid #eee}.focus{background:#20242b;color:white;padding:24px;border-radius:16px;margin-top:20px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.card{border:1px solid #e3e5e8;border-radius:14px;padding:18px}.card h3{margin:0 0 8px}.card p{color:#59606b}.refs{font-size:11px;color:#737984;margin-top:12px}@media(max-width:700px){.page{margin:0;border-radius:0}.metrics,.grid{grid-template-columns:1fr 1fr}header,main,.metrics{padding-left:22px;padding-right:22px}}@media print{@page{size:A4;margin:12mm}body{background:white}.page{margin:0;box-shadow:none}.card,.focus{break-inside:avoid}}</style></head><body><article class="page"><header><div class="brand">DEVRECAP</div><h1>${esc(analysis.headline)}</h1><p>${esc(analysis.executiveSummary)}</p><small>${esc(input.range.start.slice(0,10))} → ${esc(input.range.end.slice(0,10))}</small></header><div class="metrics">${metric(input.projects.length,labels.projects)}${metric(activities.length,labels.activities)}${metric(done,labels.completed)}${metric(evidence,labels.evidence)}</div><main>${analysis.mainFocus ? `<section class="focus"><small>${esc(labels.focus)}</small><h2>${esc(analysis.mainFocus.title)}</h2><p>${esc(analysis.mainFocus.narrative)}</p></section>` : ""}${section(labels.highlights,analysis.highlights)}${section(labels.investigations,analysis.investigations)}${section(labels.progress,analysis.inProgress)}${section(labels.blockers,analysis.blockers)}${section(labels.next,analysis.nextSteps)}</main></article></body></html>`;
}

function card(item: AnalysisItem, byId: Map<string, ActivitySummary>): string {
  const refs = item.activityIds.map((id) => byId.get(id)?.title).filter(Boolean).join(" · ");
  return `<article class="card"><h3>${esc(item.title)}</h3><p>${esc(item.narrative)}</p><div class="refs">${esc(refs)}</div></article>`;
}
function metric(value:number,label:string){return `<div class="metric"><b>${value}</b><span>${esc(label)}</span></div>`}
function esc(value:string){return value.replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c] ?? c)}
