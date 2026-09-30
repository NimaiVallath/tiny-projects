const { buildSensitivity, calculateCase, DEFAULT_CASE, validateCase } = globalThis.CovenantWeather;

const $ = (selector) => document.querySelector(selector);
const fields = Object.keys(DEFAULT_CASE);
const formatRatio = (value) => value === null ? "—" : `${value.toFixed(2)}×`;
const formatMoney = (value) => `$${value.toFixed(1)}m`;

function readCase() {
  return validateCase(Object.fromEntries(fields.map((field) => {
    const input = $(`#${field}`);
    if (input.value.trim() === "") throw new Error(`${input.labels[0].childNodes[0].textContent.trim()} is required.`);
    const value = Number(input.value);
    return [field, field === "ebitdaMargin" || field === "floatingShare" ? value / 100 : value];
  })));
}

function statusFor(result) {
  if (result.leverageBreach && result.coverageBreach) return { className: "bad", label: "Both limits breached" };
  if (result.leverageBreach || result.coverageBreach) return { className: "thin", label: "One limit breached" };
  if ((result.leverageHeadroom ?? 0) < 0.5 || (result.coverageHeadroom ?? 0) < 0.5) return { className: "thin", label: "Within limits · thin headroom" };
  return { className: "good", label: "Within both limits" };
}

function renderMetrics(result, borrower) {
  const leverageHeadroom = result.leverageHeadroom === null ? "Not meaningful" : `${result.leverageHeadroom >= 0 ? "+" : ""}${result.leverageHeadroom.toFixed(2)}× to limit`;
  const coverageHeadroom = result.coverageHeadroom === null ? "Not meaningful" : `${result.coverageHeadroom >= 0 ? "+" : ""}${result.coverageHeadroom.toFixed(2)}× to floor`;
  $("#baseline-metrics").innerHTML = [
    ["NET LEVERAGE", formatRatio(result.netLeverage), `${leverageHeadroom} · max ${borrower.maxNetLeverage.toFixed(2)}×`],
    ["INTEREST COVER", formatRatio(result.interestCoverage), `${coverageHeadroom} · min ${borrower.minInterestCoverage.toFixed(2)}×`],
    ["STRESSED EBITDA", formatMoney(result.ebitda), `${(borrower.ebitdaMargin * 100).toFixed(1)}% margin`],
    ["ANNUAL INTEREST", formatMoney(result.interest), `${formatMoney(result.incrementalInterest)} added`],
  ].map(([label, value, note]) => `<article class="metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
}

function renderSensitivity(borrower, map) {
  const headers = map.rateShocksBps.map((bps) => `<th scope="col">+${bps} bp</th>`).join("");
  const rows = map.cells.map((cells, row) => `<tr><th scope="row">−${Math.abs(map.revenueShocks[row] * 100)}% revenue</th>${cells.map((cell) => {
    const status = statusFor(cell);
    const label = `${status.label}; net leverage ${formatRatio(cell.netLeverage)}; interest coverage ${formatRatio(cell.interestCoverage)}`;
    const count = Number(cell.leverageBreach) + Number(cell.coverageBreach);
    const shortStatus = count === 2 ? "2 breaches" : count === 1 ? "1 breach" : status.className === "thin" ? "Thin room" : "Within limits";
    return `<td><div class="cell ${status.className}" aria-label="${label}"><strong>${formatRatio(cell.netLeverage)} · ${formatRatio(cell.interestCoverage)}</strong><span>${shortStatus}</span></div></td>`;
  }).join("")}</tr>`).join("");
  $("#sensitivity-table").innerHTML = `<thead><tr><th scope="col">Revenue ↓ / rate →</th>${headers}</tr></thead><tbody>${rows}</tbody>`;
}

function render() {
  const error = $("#error");
  try {
    const borrower = readCase();
    const revenueShock = Number($("#revenue-shock").value) / 100;
    const rateShockBps = Number($("#rate-shock").value);
    const base = calculateCase(borrower);
    const scenario = calculateCase(borrower, { revenueShock, rateShockBps });
    const baseStatus = statusFor(base);
    const scenarioStatus = statusFor(scenario);
    error.hidden = true;
    $("#baseline-status").className = `status-pill ${baseStatus.className}`;
    $("#baseline-status").textContent = baseStatus.label;
    renderMetrics(base, borrower);
    $("#revenue-output").textContent = `${revenueShock > 0 ? "+" : revenueShock < 0 ? "−" : ""}${Math.abs(revenueShock * 100)}%`;
    $("#rate-output").textContent = `+${rateShockBps} bp`;
    $("#scenario-result").className = `scenario-result ${scenarioStatus.className}`;
    $("#scenario-result").innerHTML = `<strong>${scenarioStatus.label}</strong><br>At this setting: ${formatRatio(scenario.netLeverage)} net leverage and ${formatRatio(scenario.interestCoverage)} interest cover. Revenue ${formatMoney(scenario.revenue)} · EBITDA ${formatMoney(scenario.ebitda)} · annual interest ${formatMoney(scenario.interest)}.`;
    renderSensitivity(borrower, buildSensitivity(borrower));
  } catch (problem) { error.textContent = problem.message; error.hidden = false; }
}

$("#borrower-form").addEventListener("input", render);
$("#revenue-shock").addEventListener("input", render);
$("#rate-shock").addEventListener("input", render);
$("#reset").addEventListener("click", () => {
  for (const field of fields) $(`#${field}`).value = DEFAULT_CASE[field] * (field === "ebitdaMargin" || field === "floatingShare" ? 100 : 1);
  $("#revenue-shock").value = -20;
  $("#rate-shock").value = 200;
  render();
});
render();
