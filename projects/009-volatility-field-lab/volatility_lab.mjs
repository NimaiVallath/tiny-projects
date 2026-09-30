const FLOOR = 1e-12;
const LAMBDA = 0.94;
const WINDOW = 20;
const ALPHAS = [0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.15, 0.18, 0.2];
const BETAS = [0.7, 0.75, 0.8, 0.84, 0.88, 0.9, 0.92, 0.94, 0.96, 0.97];

export function parseReturnsCsv(source) {
  const rows = [];
  let cells = [], field = "", quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted && char === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { cells.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      cells.push(field); field = "";
      if (cells.some((item) => item.trim())) rows.push(cells);
      cells = [];
      if (char === "\r" && source[i + 1] === "\n") i += 1;
    } else field += char;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  cells.push(field);
  if (cells.some((item) => item.trim())) rows.push(cells);
  if (!rows.length) throw new Error("CSV is empty.");
  const headers = rows.shift().map((item) => item.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error("CSV has duplicate column names.");
  for (const required of ["date", "return_pct"]) if (!headers.includes(required)) throw new Error(`CSV needs a '${required}' column.`);
  const seen = new Set();
  const values = rows.map((row, index) => {
    if (row.length !== headers.length) throw new Error(`Row ${index + 2} has ${row.length} fields; expected ${headers.length}.`);
    const entry = Object.fromEntries(headers.map((key, column) => [key, row[column].trim()]));
    const date = new Date(`${entry.date}T00:00:00Z`);
    const raw = Number(entry.return_pct);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== entry.date || entry.return_pct === "" || !Number.isFinite(raw) || Math.abs(raw) > 100)
      throw new Error(`Invalid date or percentage return at row ${index + 2}.`);
    if (seen.has(entry.date)) throw new Error(`Duplicate date ${entry.date}.`);
    seen.add(entry.date);
    return { date: entry.date, value: raw / 100 };
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (values.length < 40) throw new Error("Use at least 40 dated returns so the time-ordered holdout is meaningful.");
  return values;
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
function meanSquare(values) {
  if (values.length === 0) return 0;
  return mean(values.map((value) => value ** 2));
}

export function fitGarch(returns) {
  if (!Array.isArray(returns) || returns.length < 20 || returns.some((value) => !Number.isFinite(value)))
    throw new Error("GARCH fitting needs at least 20 finite training returns.");
  const longRunVariance = Math.max(meanSquare(returns), FLOOR);
  let best = null;
  for (const alpha of ALPHAS) for (const beta of BETAS) {
    if (alpha + beta >= 0.995) continue;
    const omega = longRunVariance * (1 - alpha - beta);
    let conditionalVariance = longRunVariance;
    let logLikelihood = 0;
    for (let i = 1; i < returns.length; i += 1) {
      conditionalVariance = Math.max(omega + alpha * returns[i - 1] ** 2 + beta * conditionalVariance, FLOOR);
      logLikelihood += Math.log(conditionalVariance) + returns[i] ** 2 / conditionalVariance;
    }
    if (best === null || logLikelihood < best.loss) best = { alpha, beta, omega, longRunVariance, loss: logLikelihood };
  }
  if (best === null) throw new Error("Could not fit a stationary GARCH baseline.");
  let varianceState = best.longRunVariance;
  for (let i = 1; i < returns.length; i += 1) varianceState = Math.max(best.omega + best.alpha * returns[i - 1] ** 2 + best.beta * varianceState, FLOOR);
  varianceState = Math.max(best.omega + best.alpha * returns.at(-1) ** 2 + best.beta * varianceState, FLOOR);
  return { ...best, nextVariance: varianceState };
}

function ewmaForecast(returns, targetIndex) {
  const seed = Math.min(WINDOW, targetIndex);
  let current = Math.max(meanSquare(returns.slice(0, seed)), FLOOR);
  for (let i = seed; i < targetIndex; i += 1) current = LAMBDA * current + (1 - LAMBDA) * returns[i] ** 2;
  return current;
}

function rollingForecast(returns, targetIndex) {
  const observations = returns.slice(Math.max(0, targetIndex - WINDOW), targetIndex);
  return Math.max(meanSquare(observations), FLOOR);
}

export function evaluateReturns(rows) {
  if (!Array.isArray(rows) || rows.length < 40) throw new Error("At least 40 dated returns are required.");
  const values = rows.map((row) => typeof row === "number" ? row : row.value);
  if (values.some((value) => !Number.isFinite(value))) throw new Error("Returns must all be finite numbers.");
  const splitIndex = Math.max(20, Math.floor(values.length * 0.8));
  if (splitIndex >= values.length) throw new Error("The time-ordered holdout has no observations.");
  const training = values.slice(0, splitIndex);
  const garch = fitGarch(training);
  const test = [];
  let garchState = garch.nextVariance;
  for (let index = splitIndex; index < values.length; index += 1) {
    test.push({
      date: rows[index].date ?? String(index + 1),
      realized: values[index],
      rolling: rollingForecast(values, index),
      ewma: ewmaForecast(values, index),
      garch: garchState,
    });
    garchState = Math.max(garch.omega + garch.alpha * values[index] ** 2 + garch.beta * garchState, FLOOR);
  }
  const metrics = Object.fromEntries(["rolling", "ewma", "garch"].map((model) => {
    const forecasts = test.map((entry) => entry[model]);
    const qlike = mean(test.map((entry, i) => Math.log(forecasts[i]) + entry.realized ** 2 / forecasts[i]));
    const maeVariance = mean(test.map((entry, i) => Math.abs(entry.realized ** 2 - forecasts[i])));
    const breaches95 = test.filter((entry, i) => entry.realized < -1.645 * Math.sqrt(forecasts[i])).length;
    return [model, { qlike, maeVariance, breaches95 }];
  }));
  const allFit = fitGarch(values);
  return {
    splitIndex,
    trainCount: splitIndex,
    testCount: test.length,
    holdoutStart: rows[splitIndex].date ?? String(splitIndex + 1),
    holdoutEnd: rows[rows.length - 1].date ?? String(rows.length),
    fitted: { alpha: garch.alpha, beta: garch.beta, persistence: garch.alpha + garch.beta },
    metrics,
    test,
    next: {
      rolling: rollingForecast(values, values.length),
      ewma: ewmaForecast(values, values.length),
      garch: allFit.nextVariance,
    },
  };
}

export function annualizedVolatility(varianceValue) {
  return Math.sqrt(Math.max(varianceValue, 0)) * Math.sqrt(252) * 100;
}

export function makeDemoCsv() {
  const lines = ["date,return_pct"];
  const date = new Date("2025-01-02T12:00:00Z");
  for (let index = 0; index < 120; index += 1) {
    const volatility = index < 34 ? 0.55 : index < 56 ? 1.8 : index < 82 ? 0.78 : index < 98 ? 2.2 : 0.65;
    const wave = Math.sin(index * 1.37) + 0.55 * Math.sin(index * 0.61) + 0.25 * Math.cos(index * 0.19);
    lines.push(`${date.toISOString().slice(0, 10)},${(volatility * wave).toFixed(3)}`);
    date.setUTCDate(date.getUTCDate() + 1);
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
  }
  return lines.join("\n");
}
