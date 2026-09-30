export function parseCsv(source) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted && char === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      row.push(cell); cell = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      if (char === "\r" && source[i + 1] === "\n") i += 1;
    } else cell += char;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (!rows.length) throw new Error("CSV is empty.");
  const headers = rows.shift().map((value) => value.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error("CSV has duplicate column names.");
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`Row ${index + 2} has ${values.length} fields; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((key, column) => [key, values[column].trim()]));
  });
}

const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};
export function readArticles(csv) {
  const rows = parseCsv(csv);
  for (const key of ["date", "ticker", "headline", "sentiment"]) if (!(key in rows[0])) throw new Error(`Articles need a '${key}' column.`);
  return rows.map((row, index) => {
    const score = Number(row.sentiment);
    if (!validDate(row.date) || !row.ticker || !row.headline || !Number.isFinite(score) || score < -1 || score > 1)
      throw new Error(`Invalid article at row ${index + 2}; check date, ticker, headline, and score (-1 to 1).`);
    return { ...row, ticker: row.ticker.toUpperCase(), sentiment: score };
  });
}

export function readPrices(csv) {
  const rows = parseCsv(csv);
  for (const key of ["date", "ticker", "close"]) if (!(key in rows[0])) throw new Error(`Prices need a '${key}' column.`);
  const seen = new Set();
  const prices = rows.map((row, index) => {
    const close = Number(row.close), key = `${row.ticker.toUpperCase()}|${row.date}`;
    if (!validDate(row.date) || !row.ticker || !Number.isFinite(close) || close <= 0) throw new Error(`Invalid price at row ${index + 2}; check date, ticker, and positive close.`);
    if (seen.has(key)) throw new Error(`Duplicate closing price for ${key.replace("|", " on ")}.`);
    seen.add(key);
    return { date: row.date, ticker: row.ticker.toUpperCase(), close };
  });
  return prices.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.date.localeCompare(b.date));
}

export function analyze(articles, prices, horizons = [1, 5]) {
  const byTicker = new Map();
  for (const price of prices) {
    if (!byTicker.has(price.ticker)) byTicker.set(price.ticker, []);
    byTicker.get(price.ticker).push(price);
  }
  const events = articles.map((article) => {
    const series = byTicker.get(article.ticker) ?? [];
    let anchor = -1;
    for (let i = 0; i < series.length && series[i].date <= article.date; i += 1) anchor = i;
    const windows = Object.fromEntries(horizons.map((horizon) => {
      const endpoint = anchor + horizon;
      return [horizon, anchor >= 0 && endpoint < series.length
        ? (series[endpoint].close / series[anchor].close - 1) * 100 : null];
    }));
    return { ...article, anchor: anchor >= 0 ? series[anchor].date : null, returns: windows };
  });
  const buckets = [
    { label: "Negative", test: (score) => score < -0.2 },
    { label: "Neutral", test: (score) => score >= -0.2 && score <= 0.2 },
    { label: "Positive", test: (score) => score > 0.2 },
  ].map(({ label, test }) => {
    const rows = events.filter((event) => test(event.sentiment) && event.returns[1] !== null);
    return { label, count: rows.length, mean1d: rows.length ? rows.reduce((sum, row) => sum + row.returns[1], 0) / rows.length : null };
  });
  const matched = events.filter((event) => event.returns[1] !== null);
  return { events, buckets, summary: { articles: articles.length, matched1d: matched.length, unmatched1d: articles.length - matched.length, tickers: new Set(articles.map((row) => row.ticker)).size } };
}

export function rankCorrelation(pairs) {
  const usable = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (usable.length < 2) return null;
  const ranks = (column) => {
    const sorted = usable.map((pair, index) => ({ value: pair[column], index })).sort((a, b) => a.value - b.value);
    const result = Array(usable.length);
    for (let start = 0; start < sorted.length;) {
      let end = start + 1;
      while (end < sorted.length && sorted[end].value === sorted[start].value) end += 1;
      const rank = (start + end - 1) / 2 + 1;
      for (let i = start; i < end; i += 1) result[sorted[i].index] = rank;
      start = end;
    }
    return result;
  };
  const x = ranks(0), y = ranks(1), mx = x.reduce((a, b) => a + b) / x.length, my = y.reduce((a, b) => a + b) / y.length;
  const covariance = x.reduce((sum, value, i) => sum + (value - mx) * (y[i] - my), 0);
  const denominator = Math.sqrt(x.reduce((sum, value) => sum + (value - mx) ** 2, 0) * y.reduce((sum, value) => sum + (value - my) ** 2, 0));
  return denominator === 0 ? null : covariance / denominator;
}
