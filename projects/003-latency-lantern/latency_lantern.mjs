#!/usr/bin/env node
/** Robust, dependency-free diagnostics for newline-delimited request logs. */

import { readFile, writeFile } from 'node:fs/promises';
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
  return {
    summary: {
      requests: entries.length,
      routes: routes.length,
      p50_ms: rounded(percentile(durations, 0.5)),
      p95_ms: rounded(percentile(durations, 0.95)),
      error_count: errorCount,
      error_rate: rounded(errorCount / entries.length * 100),
      outlier_count: routes.reduce((sum, route) => sum + route.outlier_count, 0),
      first_timestamp: entries.map(({ timestamp }) => timestamp).sort()[0],
      last_timestamp: entries.map(({ timestamp }) => timestamp).sort().at(-1),
    },
    routes,
  };
}

function usage() {
  return 'Usage: node latency_lantern.mjs input.jsonl [--json output.json]';
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.length > 3 || (args.length > 1 && args[1] !== '--json')) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    const report = analyze(parseJsonl(await readFile(args[0], 'utf8')));
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args[1] === '--json') {
      if (!args[2]) throw new Error('--json requires an output path');
      await writeFile(args[2], json, 'utf8');
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
