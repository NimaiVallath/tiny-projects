#!/usr/bin/env node
/** Robust, dependency-free diagnostics for newline-delimited request logs. */

import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_FIELDS = ['timestamp', 'method', 'route', 'duration_ms', 'status'];

function assertEntry(entry, lineNumber) {
  const where = `line ${lineNumber}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${where}: expected a JSON object`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in entry)) throw new Error(`${where}: missing ${field}`);
  }
  if (typeof entry.timestamp !== 'string' || Number.isNaN(Date.parse(entry.timestamp))) {
    throw new Error(`${where}: timestamp must be an ISO-compatible date`);
  }
  if (typeof entry.method !== 'string' || !/^[A-Z]+$/.test(entry.method)) {
    throw new Error(`${where}: method must contain uppercase letters`);
  }
  if (typeof entry.route !== 'string' || !entry.route.startsWith('/')) {
    throw new Error(`${where}: route must start with /`);
  }
  if (!Number.isFinite(entry.duration_ms) || entry.duration_ms < 0) {
    throw new Error(`${where}: duration_ms must be a nonnegative number`);
  }
  if (!Number.isInteger(entry.status) || entry.status < 100 || entry.status > 599) {
    throw new Error(`${where}: status must be an integer from 100 to 599`);
  }
}

export function parseJsonl(text) {
  const entries = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new Error(`line ${index + 1}: invalid JSON (${error.message})`);
    }
    assertEntry(entry, index + 1);
    entries.push({
      timestamp: entry.timestamp,
      method: entry.method,
      route: entry.route,
      duration_ms: entry.duration_ms,
      status: entry.status,
    });
  }
  if (!entries.length) throw new Error('input contains no request records');
  return entries;
}

export function percentile(values, fraction) {
  if (!values.length) throw new Error('percentile requires at least one value');
  if (fraction < 0 || fraction > 1) throw new Error('percentile fraction must be 0–1');
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function medianAbsoluteDeviation(values, median) {
  return percentile(values.map((value) => Math.abs(value - median)), 0.5);
}

function isOutlier(value, median, mad) {
  if (mad > 0) return 0.6745 * Math.abs(value - median) / mad > 3.5;
  // Identical baselines have MAD 0. Preserve sensitivity to a lone slow request.
  return value > median + Math.max(50, median * 0.5);
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}

export function analyze(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error('analyze requires at least one request record');
  }

  const grouped = new Map();
  for (const entry of entries) {
    const key = `${entry.method} ${entry.route}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }

  const routes = [...grouped.entries()].map(([key, records]) => {
    const durations = records.map(({ duration_ms }) => duration_ms);
    const median = percentile(durations, 0.5);
    const mad = medianAbsoluteDeviation(durations, median);
    const outliers = records.filter(({ duration_ms }) => isOutlier(duration_ms, median, mad));
    const errorCount = records.filter(({ status }) => status >= 500).length;
    return {
      key,
      method: records[0].method,
      route: records[0].route,
      count: records.length,
      p50_ms: rounded(median),
      p95_ms: rounded(percentile(durations, 0.95)),
      max_ms: Math.max(...durations),
      error_count: errorCount,
      error_rate: rounded(errorCount / records.length * 100),
      outlier_count: outliers.length,
      outliers: outliers
        .map(({ timestamp, duration_ms, status }) => ({ timestamp, duration_ms, status }))
        .sort((a, b) => b.duration_ms - a.duration_ms),
    };
  }).sort((a, b) => b.p95_ms - a.p95_ms || a.key.localeCompare(b.key));

  const durations = entries.map(({ duration_ms }) => duration_ms);
  const errorCount = entries.filter(({ status }) => status >= 500).length;
  const timestamps = entries
    .map(({ timestamp }) => timestamp)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    summary: {
      requests: entries.length,
      routes: routes.length,
      p50_ms: rounded(percentile(durations, 0.5)),
      p95_ms: rounded(percentile(durations, 0.95)),
      error_count: errorCount,
      error_rate: rounded(errorCount / entries.length * 100),
      outlier_count: routes.reduce((sum, route) => sum + route.outlier_count, 0),
      first_timestamp: timestamps[0],
      last_timestamp: timestamps.at(-1),
    },
    routes,
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function metric(label, value, detail) {
  return `<article class="metric">
          <p>${escapeHtml(label)}</p>
          <strong>${escapeHtml(value)}</strong>
          <span>${escapeHtml(detail)}</span>
        </article>`;
}

export function renderHtml(report, sourceName = 'request log') {
  const { summary, routes } = report;
  const maximumP95 = Math.max(...routes.map(({ p95_ms }) => p95_ms), 1);
  const routeRows = routes.map((route) => {
    const width = Math.max(3, Math.round(route.p95_ms / maximumP95 * 100));
    const health = route.error_count > 0 ? 'error' : route.outlier_count > 0 ? 'warn' : 'good';
    const signal = route.error_count > 0
      ? `${route.error_rate}% server errors`
      : route.outlier_count > 0
        ? `${route.outlier_count} latency outlier`
        : 'No detected issue';
    return `<tr>
              <th scope="row"><code>${escapeHtml(route.method)}</code> ${escapeHtml(route.route)}</th>
              <td>${route.count}</td>
              <td>${route.p50_ms} ms</td>
              <td>
                <span class="bar-label">${route.p95_ms} ms</span>
                <span class="bar-track" aria-hidden="true"><span style="width:${width}%"></span></span>
              </td>
              <td><span class="signal ${health}">${escapeHtml(signal)}</span></td>
            </tr>`;
  }).join('\n');

  const outlierRows = routes.flatMap((route) => route.outliers.map((outlier) => `<tr>
              <th scope="row"><code>${escapeHtml(route.method)}</code> ${escapeHtml(route.route)}</th>
              <td>${escapeHtml(outlier.timestamp)}</td>
              <td>${outlier.duration_ms} ms</td>
              <td>${outlier.status}</td>
            </tr>`)).join('\n');

  const outlierSection = outlierRows
    ? `<table>
          <caption>Requests whose latency differs sharply from their own route's baseline</caption>
          <thead><tr><th scope="col">Route</th><th scope="col">Timestamp</th><th scope="col">Duration</th><th scope="col">Status</th></tr></thead>
          <tbody>${outlierRows}</tbody>
        </table>`
    : '<p class="empty">No latency outliers were detected.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Latency Lantern — request diagnostics</title>
  <style>
    :root { color-scheme: dark; --ink:#f8f3e7; --muted:#aaa8a0; --panel:#1c2026; --line:#343941; --amber:#ffbd4a; --mint:#72d6a0; --coral:#ff7b72; }
    * { box-sizing:border-box; }
    body { margin:0; background:#101318; color:var(--ink); font:16px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background:radial-gradient(circle at 74% 8%,#ffbd4a1f,transparent 28rem); }
    main { position:relative; width:min(1120px,calc(100% - 2rem)); margin:0 auto; padding:5rem 0; }
    header { display:grid; grid-template-columns:1fr auto; gap:2rem; align-items:end; border-bottom:1px solid var(--line); padding-bottom:2rem; }
    .eyebrow { color:var(--amber); letter-spacing:.14em; text-transform:uppercase; font-size:.78rem; }
    h1,h2,p { margin-top:0; } h1 { margin-bottom:.5rem; font:clamp(2.6rem,7vw,5.5rem)/.95 Georgia,serif; letter-spacing:-.05em; }
    header p { color:var(--muted); max-width:54rem; margin-bottom:0; }
    .status { border:1px solid var(--amber); color:var(--amber); padding:.55rem .8rem; white-space:nowrap; }
    .metrics { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--line); border:1px solid var(--line); margin:2rem 0 4rem; }
    .metric { background:var(--panel); padding:1.25rem; } .metric p,.metric span { color:var(--muted); font-size:.78rem; }
    .metric p { margin:0 0 1rem; text-transform:uppercase; letter-spacing:.08em; } .metric strong { display:block; color:var(--ink); font-size:2rem; }
    section { margin-top:4rem; } h2 { font:2rem/1.1 Georgia,serif; letter-spacing:-.02em; }
    .section-note { color:var(--muted); max-width:48rem; }
    .table-wrap { overflow-x:auto; border:1px solid var(--line); }
    table { width:100%; border-collapse:collapse; background:var(--panel); } caption { text-align:left; color:var(--muted); padding:1rem; }
    th,td { text-align:left; padding:1rem; border-bottom:1px solid var(--line); white-space:nowrap; } thead { color:var(--muted); font-size:.76rem; text-transform:uppercase; letter-spacing:.08em; }
    tbody tr:last-child th,tbody tr:last-child td { border-bottom:0; } code { color:var(--amber); }
    .bar-label { display:inline-block; width:5.4rem; } .bar-track { display:inline-block; width:9rem; height:.5rem; vertical-align:middle; background:#30343b; }
    .bar-track span { display:block; height:100%; background:var(--amber); }
    .signal { display:inline-block; border:1px solid; padding:.2rem .45rem; font-size:.76rem; } .good { color:var(--mint); } .warn { color:var(--amber); } .error { color:var(--coral); }
    .method { display:grid; grid-template-columns:repeat(3,1fr); gap:1rem; } .method article { border-top:1px solid var(--line); padding-top:1rem; }
    .method strong { color:var(--amber); } .method p,.empty,footer { color:var(--muted); }
    footer { border-top:1px solid var(--line); margin-top:5rem; padding-top:1.25rem; font-size:.78rem; display:flex; justify-content:space-between; gap:1rem; }
    @media (max-width:760px) { main{padding:2.5rem 0} header{grid-template-columns:1fr}.status{justify-self:start}.metrics{grid-template-columns:1fr 1fr}.method{grid-template-columns:1fr}.bar-track{display:none} }
  </style>
</head>
<body>
  <main>
    <header>
      <div><p class="eyebrow">Request diagnostics / ${escapeHtml(sourceName)}</p><h1>Latency Lantern</h1><p>A compact view of tail latency, server errors, and route-specific anomalies—without averaging away the interesting parts.</p></div>
      <div class="status">${summary.error_count || summary.outlier_count ? '● signals found' : '○ baseline clear'}</div>
    </header>
    <section class="metrics" aria-label="Request summary">
      ${metric('Requests', summary.requests, `${summary.routes} routes`)}
      ${metric('Median', `${summary.p50_ms} ms`, 'overall p50')}
      ${metric('Tail latency', `${summary.p95_ms} ms`, 'overall p95')}
      ${metric('Server errors', `${summary.error_rate}%`, `${summary.error_count} responses`)}
    </section>
    <section aria-labelledby="routes-heading"><h2 id="routes-heading">Route health</h2><p class="section-note">Sorted by p95 so the slowest user experience rises to the top. Each bar is scaled against the slowest route in this report.</p><div class="table-wrap"><table><caption>${summary.requests} requests observed from ${escapeHtml(summary.first_timestamp)} to ${escapeHtml(summary.last_timestamp)}</caption><thead><tr><th scope="col">Route</th><th scope="col">Count</th><th scope="col">p50</th><th scope="col">p95</th><th scope="col">Signal</th></tr></thead><tbody>${routeRows}</tbody></table></div></section>
    <section aria-labelledby="outliers-heading"><h2 id="outliers-heading">Outlier log</h2><p class="section-note">Anomalies are judged within each route, so a naturally expensive checkout is not compared with a lightweight profile read.</p><div class="table-wrap">${outlierSection}</div></section>
    <section aria-labelledby="method-heading"><h2 id="method-heading">How the lantern works</h2><div class="method"><article><strong>01 / resist averages</strong><p>Median and 95th percentile preserve the typical and tail experiences separately.</p></article><article><strong>02 / local baselines</strong><p>Modified z-scores use each route's median absolute deviation, reducing distortion from the outliers being detected.</p></article><article><strong>03 / honest scope</strong><p>This report describes one input window. It does not claim a service-level objective or infer root causes.</p></article></div></section>
    <footer><span>Generated by Latency Lantern</span><span>Self-contained · no telemetry · no network calls</span></footer>
  </main>
</body>
</html>\n`;
}

function usage() {
  return 'Usage: node latency_lantern.mjs input.jsonl [--json output.json | --html output.html]';
}

async function main() {
  const args = process.argv.slice(2);
  const validFormat = args[1] === '--json' || args[1] === '--html';
  if (!args.length || args.length > 3 || (args.length > 1 && !validFormat)) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    if (validFormat && !args[2]) throw new Error(`${args[1]} requires an output path`);
    if (validFormat && resolve(args[0]) === resolve(args[2])) {
      throw new Error('input and output paths must differ');
    }
    const report = analyze(parseJsonl(await readFile(args[0], 'utf8')));
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (validFormat) {
      const output = args[1] === '--json' ? json : renderHtml(report, basename(args[0]));
      await writeFile(args[2], output, 'utf8');
      console.log(`Analyzed ${report.summary.requests} requests across ${report.summary.routes} routes`);
    } else {
      process.stdout.write(json);
    }
  } catch (error) {
    console.error(`Latency Lantern: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
