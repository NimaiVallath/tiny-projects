const { annualizedVolatility, evaluateReturns, makeDemoCsv, parseReturnsCsv } = globalThis.VolatilityFieldLab;

const $ = (selector) => document.querySelector(selector);
const models = [
  ["rolling", "Rolling 20", "Window variance · quick to inspect"],
  ["ewma", "EWMA", "λ = 0.94 · faster response"],
  ["garch", "GARCH(1,1)", "Gaussian grid fit · stationary"],
];
let source = makeDemoCsv();
let isDemo = true;

function renderChart(result) {
  const width = 900, height = 225, pad = { left: 42, right: 14, top: 18, bottom: 29 };
  const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
  const values = result.test.map((row) => row.realized * 100);
  const bands = result.test.map((row) => 1.645 * Math.sqrt(row.garch) * 100);
  const extent = Math.max(...values.map(Math.abs), ...bands, 0.1) * 1.2;
  const x = (index) => pad.left + index / Math.max(result.test.length - 1, 1) * plotW;
  const y = (value) => pad.top + (extent - value) / (2 * extent) * plotH;
  const upper = bands.map((band, index) => `${x(index)},${y(band)}`).join(" ");
  const lower = [...bands].reverse().map((band, offset) => `${x(bands.length - 1 - offset)},${y(-band)}`).join(" ");
  const actual = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const ticks = [-extent, 0, extent];
  const grid = ticks.map((tick) => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(tick)}" y2="${y(tick)}" stroke="#e7e9e4"/><text x="${pad.left - 7}" y="${y(tick) + 3}" text-anchor="end" fill="#747c7d" font-size="10" font-family="ui-monospace,monospace">${tick.toFixed(1)}%</text>`).join("");
  $("#chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-desc"><title id="chart-title">Realized holdout returns and GARCH reference band</title><desc id="chart-desc">${result.testCount} holdout observations. The shaded band is plus or minus 1.645 forecast standard deviations; the line is the realized daily percentage return.</desc>${grid}<polygon points="${upper} ${lower}" fill="#d6e9e2" opacity=".9"/><path d="${actual}" fill="none" stroke="#242b31" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><text x="${pad.left}" y="${height - 7}" fill="#747c7d" font-size="10" font-family="ui-monospace,monospace">${result.holdoutStart}</text><text x="${width - pad.right}" y="${height - 7}" text-anchor="end" fill="#747c7d" font-size="10" font-family="ui-monospace,monospace">${result.holdoutEnd}</text></svg>`;
}

function render() {
  const error = $("#error"), results = $("#results");
  try {
    const rows = parseReturnsCsv(source);
    const result = evaluateReturns(rows);
    const bestQlike = models.reduce((best, [key]) => result.metrics[key].qlike < result.metrics[best].qlike ? key : best, models[0][0]);
    error.hidden = true; results.hidden = false;
    $("#sample-warning").textContent = isDemo
      ? "This generated demo intentionally changes volatility regimes. It is a teaching series, not observed market data."
      : "Imported returns are analyzed locally. Verify date spacing, return definitions, and instrument adjustments before interpreting the comparison.";
    $("#summary").innerHTML = [
      ["TRAINING WINDOW", `${result.trainCount} sessions`],
      ["LATER HOLDOUT", `${result.testCount} sessions`],
      ["GARCH PERSISTENCE", `${result.fitted.persistence.toFixed(3)} · α ${result.fitted.alpha.toFixed(2)} + β ${result.fitted.beta.toFixed(2)}`],
    ].map(([label, value]) => `<article class="summary-card"><span>${label}</span><strong>${value}</strong></article>`).join("");
    $("#forecast-cards").innerHTML = models.map(([key, title, note]) => `<article class="forecast ${key === bestQlike ? "best" : ""}"><span>${title}${key === bestQlike ? " · lowest holdout QLIKE" : ""}</span><strong>${annualizedVolatility(result.next[key]).toFixed(1)}%</strong><small>${note}</small></article>`).join("");
    $("#holdout-dates").textContent = `${result.holdoutStart} — ${result.holdoutEnd}`;
    $("#score-rows").innerHTML = models.map(([key, title, note]) => `<tr><td class="model-name">${title}<span class="model-note">${note}</span></td><td class="number">${result.metrics[key].qlike.toFixed(3)}</td><td class="number">${result.metrics[key].maeVariance.toFixed(7)}</td><td class="number">${result.metrics[key].breaches95} / ${result.testCount}</td></tr>`).join("");
    renderChart(result);
    $("#sample-warning").hidden = false;
  } catch (problem) { results.hidden = true; error.textContent = problem.message; error.hidden = false; }
}

$("#load-demo").addEventListener("click", () => {
  source = makeDemoCsv(); isDemo = true; $("#filename").textContent = "Fictional regime-shift series · 120 rows"; render();
});
$("#analyze").addEventListener("click", render);
$("#csv-file").addEventListener("change", async (event) => {
  const file = event.target.files[0]; if (!file) return;
  try { source = await file.text(); isDemo = false; $("#filename").textContent = file.name; render(); }
  catch { $("#error").textContent = "Could not read that CSV file."; $("#error").hidden = false; }
});
render();
