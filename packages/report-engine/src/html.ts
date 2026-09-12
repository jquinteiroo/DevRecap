import type { ActivitySummary, ReportInput } from "@devrecap/shared";
import type { AnalysisItem, ReportAnalysis } from "./analysis.ts";

export interface HtmlReportOptions { locale?: "en" | "pt-BR"; title?: string; }

export function renderHtmlReport(input: ReportInput, analysis: ReportAnalysis, options: HtmlReportOptions = {}): string {
  const pt = input.language === "pt" || (input.language === "auto" && (input.resolvedLanguage === "pt" || options.locale === "pt-BR"));
  const activities = input.projects.flatMap((p) => p.activities);
  const byId = new Map(activities.map((a) => [a.id, a]));
  const done = activities.filter((a) => a.status === "completed").length;
  const evidence = activities.reduce((n, a) => n + a.evidenceCount, 0);
  const labels = pt
    ? { summary:"Resumo executivo", focus:"Foco principal", highlights:"Principais entregas", investigations:"Investigações", progress:"Em andamento", blockers:"Bloqueios", next:"Próximos passos", projects:"Projetos", activities:"Atividades", completed:"Concluídas", evidence:"Evidências", refs:"Evidências relacionadas" }
    : { summary:"Executive summary", focus:"Main focus", highlights:"Key deliveries", investigations:"Investigations", progress:"In progress", blockers:"Blockers", next:"Next steps", projects:"Projects", activities:"Activities", completed:"Completed", evidence:"Evidence", refs:"Related evidence" };

  const section = (title: string, items: AnalysisItem[]) => items.length
    ? `<section class="report-section"><h2>${esc(title)}</h2><div class="stack">${items.map((item) => card(item, byId, labels.refs)).join("")}</div></section>`
    : "";

  const summary = analysis.executiveSummary
    ? `<section class="summary"><small>${esc(labels.summary)}</small>${prose(analysis.executiveSummary)}</section>`
    : "";
  const focus = analysis.mainFocus
    ? `<section class="focus"><small>${esc(labels.focus)}</small><h2>${esc(analysis.mainFocus.title)}</h2>${prose(analysis.mainFocus.narrative)}</section>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(options.title ?? analysis.headline)}</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f3f4f6;color:#17191e;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}.page{max-width:980px;margin:32px auto;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 20px 60px #00000012}header{padding:52px 56px 38px;background:linear-gradient(145deg,#ffffff,#f2f4f7)}.brand{font-size:12px;font-weight:800;letter-spacing:.22em;color:#737984}h1{font-size:44px;line-height:1.08;letter-spacing:-.03em;margin:14px 0 18px;max-width:820px}header small{color:#737984;font-size:13px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:18px 56px;border-top:1px solid #eceef1;border-bottom:1px solid #eceef1}.metric{background:#f7f8fa;padding:15px 16px;border-radius:12px}.metric b{display:block;font-size:26px;letter-spacing:-.02em}.metric span{font-size:12px;color:#69707b}main{padding:8px 56px 54px}.summary,.focus,.report-section{padding:30px 0;border-bottom:1px solid #eceef1}.summary small,.focus small{display:block;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#727985;margin-bottom:10px}.summary p{font-size:18px;line-height:1.72;color:#3f4651;max-width:850px}.focus{margin-top:20px;padding:28px 30px;border:1px solid #dedfe3;border-radius:18px;background:#20242b;color:white}.focus small{color:#b8bec8}.focus h2{font-size:26px;line-height:1.2;margin:0 0 14px}.focus p{font-size:16px;line-height:1.72;color:#edf0f4;margin:0 0 12px}.report-section>h2{font-size:25px;letter-spacing:-.02em;margin:0 0 18px}.stack{display:flex;flex-direction:column;gap:14px}.card{border:1px solid #e2e5e9;border-radius:16px;padding:22px 24px;background:#fff}.card h3{font-size:20px;line-height:1.3;margin:0 0 10px;letter-spacing:-.01em}.card p{font-size:15px;line-height:1.72;color:#505864;margin:0 0 12px}.card p:last-of-type{margin-bottom:0}.refs{margin-top:14px;padding-top:12px;border-top:1px solid #eef0f2}.refs summary{cursor:pointer;color:#737984;font-size:11px;font-weight:700;letter-spacing:.04em}.refs div{margin-top:8px;color:#858b94;font-size:11px;line-height:1.55}@media(max-width:700px){.page{margin:0;border-radius:0}.metrics{grid-template-columns:1fr 1fr}header,main,.metrics{padding-left:22px;padding-right:22px}h1{font-size:34px}.summary p{font-size:16px}.focus{padding:22px}.card{padding:18px}}@media print{@page{size:A4;margin:12mm}body{background:white}.page{margin:0;box-shadow:none}.card,.focus{break-inside:avoid}.refs{display:none}}
</style></head><body><article class="page"><header><div class="brand">DEVRECAP</div><h1>${esc(analysis.headline)}</h1><small>${esc(input.range.start.slice(0,10))} → ${esc(input.range.end.slice(0,10))}</small></header><div class="metrics">${metric(input.projects.length,labels.projects)}${metric(activities.length,labels.activities)}${metric(done,labels.completed)}${metric(evidence,labels.evidence)}</div><main>${summary}${focus}${section(labels.highlights,analysis.highlights)}${section(labels.investigations,analysis.investigations)}${section(labels.progress,analysis.inProgress)}${section(labels.blockers,analysis.blockers)}${section(labels.next,analysis.nextSteps)}</main></article></body></html>`;
}

function card(item: AnalysisItem, byId: Map<string, ActivitySummary>, refsLabel: string): string {
  const refs = item.activityIds.map((id) => byId.get(id)?.title).filter(Boolean).join(" · ");
  const evidence = refs ? `<details class="refs"><summary>${esc(refsLabel)}</summary><div>${esc(refs)}</div></details>` : "";
  return `<article class="card"><h3>${esc(item.title)}</h3>${prose(item.narrative)}${evidence}</article>`;
}

function prose(value: string): string {
  return value
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function metric(value:number,label:string){return `<div class="metric"><b>${value}</b><span>${esc(label)}</span></div>`}
function esc(value:string){return value.replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c] ?? c)}
