import { analyze, rankCorrelation, readArticles, readPrices } from "./news_signal.mjs";

const demoArticles = `date,ticker,headline,sentiment
2026-02-02,ALFA,Quarterly outlook raised after strong renewals,0.82
2026-02-04,ALFA,Factory delay prompts cautious guidance,-0.71
2026-02-06,ALFA,Board approves expanded repurchase,0.54
2026-02-03,BRAVO,New contract adds multi-year backlog,0.63
2026-02-05,BRAVO,Regulator opens review of billing practices,-0.88
2026-02-09,BRAVO,Company reaffirms annual outlook,0.21
2026-02-10,CHARLIE,Debt refinancing completed ahead of schedule,0.74
2026-02-12,CHARLIE,Customer concentration remains a concern,-0.42`;
const demoPrices = `date,ticker,close
2026-01-30,ALFA,100
2026-02-02,ALFA,101
2026-02-03,ALFA,102
2026-02-04,ALFA,99
2026-02-05,ALFA,98
2026-02-06,ALFA,100
2026-02-09,ALFA,101
2026-02-10,ALFA,100
2026-02-11,ALFA,102
2026-02-12,ALFA,103
2026-02-13,ALFA,102
2026-02-02,BRAVO,50
2026-02-03,BRAVO,51
2026-02-04,BRAVO,52
2026-02-05,BRAVO,49
2026-02-06,BRAVO,48
2026-02-09,BRAVO,49
2026-02-10,BRAVO,50
2026-02-11,BRAVO,50.5
2026-02-12,BRAVO,49.5
2026-02-13,BRAVO,50
2026-02-16,CHARLIE,80
2026-02-17,CHARLIE,81
2026-02-18,CHARLIE,80
2026-02-19,CHARLIE,82`;

const $ = (selector) => document.querySelector(selector);
const articlesInput = $("#articles"), pricesInput = $("#prices");
const pct = (value) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
function render() {
  const error = $("#error"), report = $("#report");
  try {
    const articles = readArticles(articlesInput.value), prices = readPrices(pricesInput.value);
    const result = analyze(articles, prices);
    const correlation = rankCorrelation(result.events.map((event) => [event.sentiment, event.returns[1]]));
    error.hidden = true; report.hidden = false;
    $("#summary").innerHTML = [["ARTICLES", result.summary.articles], ["1-DAY MATCH", `${result.summary.matched1d} / ${result.summary.articles}`], ["ISSUERS", result.summary.tickers], ["NO WINDOW", result.summary.unmatched1d]].map(([label, value]) => `<article class="metric"><span>${label}</span><strong>${value}</strong></article>`).join("");
    const maxAbs = Math.max(...result.buckets.map((bucket) => Math.abs(bucket.mean1d ?? 0)), 0.1);
    const colors = { Negative: "var(--red)", Neutral: "var(--amber)", Positive: "var(--green)" };
    $("#buckets").innerHTML = result.buckets.map((bucket) => `<div class="bucket"><span class="bucket-name">${bucket.label} · ${bucket.count}</span><div class="track" aria-label="${bucket.label}: ${bucket.count} observations"><div class="fill" style="width:${Math.abs(bucket.mean1d ?? 0) / maxAbs * 100}%;background:${colors[bucket.label]}"></div></div><span class="bucket-value ${bucket.mean1d === null ? "neutral" : bucket.mean1d > 0 ? "positive" : "negative"}">${pct(bucket.mean1d)}</span></div>`).join("");
    $("#correlation").className = `correlation-value${correlation === null ? " missing" : ""}`;
    $("#correlation").textContent = correlation === null ? "Not enough variation" : correlation.toFixed(2);
    $("#corr-note").textContent = correlation === null ? "Requires at least two matched, non-constant observations." : `${result.summary.matched1d} matched event${result.summary.matched1d === 1 ? "" : "s"} · small samples are unstable.`;
    const filter = $("#ticker-filter"), previous = filter.value;
    filter.innerHTML = `<option value="*">All issuers</option>${[...new Set(articles.map((event) => event.ticker))].sort().map((ticker) => `<option value="${ticker}">${ticker}</option>`).join("")}`;
    if ([...filter.options].some((option) => option.value === previous)) filter.value = previous;
    const visible = result.events.filter((event) => filter.value === "*" || filter.value === event.ticker);
    $("#event-rows").innerHTML = visible.map((event) => `<tr><td class="mono">${event.date}</td><td><strong>${event.ticker}</strong></td><td class="headline">${escapeHtml(event.headline)}</td><td class="mono ${event.sentiment > .2 ? "positive" : event.sentiment < -.2 ? "negative" : "neutral"}">${event.sentiment.toFixed(2)}</td><td class="mono">${event.anchor ?? "No prior close"}</td><td class="mono ${event.returns[1] === null ? "neutral" : event.returns[1] >= 0 ? "positive" : "negative"}">${pct(event.returns[1])}</td><td class="mono ${event.returns[5] === null ? "neutral" : event.returns[5] >= 0 ? "positive" : "negative"}">${pct(event.returns[5])}</td></tr>`).join("");
  } catch (problem) { report.hidden = true; error.textContent = problem.message; error.hidden = false; }
}
function escapeHtml(value) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }

$("#demo").addEventListener("click", () => { articlesInput.value = demoArticles; pricesInput.value = demoPrices; $("#article-name").textContent = "Fictional demo"; $("#price-name").textContent = "Fictional demo"; render(); });
$("#analyze").addEventListener("click", render);
$("#ticker-filter").addEventListener("change", render);
for (const [inputId, textarea, nameId] of [["#article-file", articlesInput, "#article-name"], ["#price-file", pricesInput, "#price-name"]]) $(inputId).addEventListener("change", async (event) => {
  const file = event.target.files[0]; if (!file) return;
  try { textarea.value = await file.text(); $(nameId).textContent = file.name; }
  catch { $("#error").textContent = "Could not read that file."; $("#error").hidden = false; }
});
$("#demo").click();
