import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { analyze, parseJsonl, percentile, renderHtml } from './latency_lantern.mjs';

const scriptPath = fileURLToPath(new URL('./latency_lantern.mjs', import.meta.url));
const samplePath = fileURLToPath(new URL('./examples/fictional-requests.jsonl', import.meta.url));

test('parser skips blank lines and keeps only the documented fields', () => {
  const input = '\n' + JSON.stringify({
    timestamp: '2026-09-17T10:00:00Z', method: 'GET', route: '/x',
    duration_ms: 12, status: 200, ignored: 'value',
  }) + '\n';
  assert.deepEqual(parseJsonl(input), [{
    timestamp: '2026-09-17T10:00:00Z', method: 'GET', route: '/x',
    duration_ms: 12, status: 200,
  }]);
});

test('parser reports source line for malformed and invalid records', () => {
  assert.throws(() => parseJsonl('\nnope'), /line 2: invalid JSON/);
  assert.throws(() => parseJsonl('{"timestamp":"bad"}'), /line 1: missing method/);
  const invalid = { timestamp: '2026-09-17T10:00:00Z', method: 'get', route: 'x', duration_ms: -1, status: 700 };
  assert.throws(() => parseJsonl(JSON.stringify(invalid)), /method must contain uppercase/);
  assert.throws(() => parseJsonl('\n\n'), /no request records/);
});

test('percentile uses linear interpolation without mutating input', () => {
  const values = [40, 10, 30, 20];
  assert.equal(percentile(values, 0.5), 25);
  assert.equal(percentile(values, 0.95), 38.5);
  assert.deepEqual(values, [40, 10, 30, 20]);
});

test('analysis groups routes and calculates robust anomalies and errors', async () => {
  const entries = parseJsonl(await readFile(samplePath, 'utf8'));
  const report = analyze(entries);
  assert.equal(report.summary.requests, 20);
  assert.equal(report.summary.routes, 3);
  assert.equal(report.summary.error_count, 2);
  assert.equal(report.summary.error_rate, 10);
  assert.equal(report.summary.outlier_count, 1);
  assert.equal(report.routes[0].key, 'GET /api/search');
  assert.equal(report.routes[0].outliers[0].duration_ms, 884);
  const checkout = report.routes.find(({ route }) => route === '/checkout');
  assert.equal(checkout.error_rate, 33.3);
});

test('zero-variance baseline still catches a lone slow request', () => {
  const base = { timestamp: '2026-09-17T10:00:00Z', method: 'GET', route: '/x', status: 200 };
  const report = analyze([100, 100, 100, 1000].map((duration_ms) => ({ ...base, duration_ms })));
  assert.equal(report.summary.outlier_count, 1);
});

test('CLI emits JSON and writes an explicit output file', async () => {
  const stdoutRun = spawnSync(process.execPath, [scriptPath, samplePath], { encoding: 'utf8' });
  assert.equal(stdoutRun.status, 0, stdoutRun.stderr);
  assert.equal(JSON.parse(stdoutRun.stdout).summary.requests, 20);

  const directory = await mkdtemp(join(tmpdir(), 'latency-lantern-'));
  try {
    const output = join(directory, 'report.json');
    const fileRun = spawnSync(process.execPath, [scriptPath, samplePath, '--json', output], { encoding: 'utf8' });
    assert.equal(fileRun.status, 0, fileRun.stderr);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).summary.routes, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTML report is semantic, self-contained, and escapes source data', async () => {
  const entries = parseJsonl(await readFile(samplePath, 'utf8'));
  const report = analyze(entries.map((entry) => (
    entry.route === '/api/profile' ? { ...entry, route: '/api/<profile>' } : entry
  )));
  const html = renderHtml(report, '<production & test>');
  assert.match(html, /<!doctype html>/);
  assert.match(html, /<caption>/);
  assert.match(html, /scope="col"/);
  assert.match(html, /&lt;production &amp; test&gt;/);
  assert.match(html, /\/api\/&lt;profile&gt;/);
  assert.doesNotMatch(html, /<script|https?:\/\//);
});

test('CLI writes a standalone HTML report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latency-lantern-html-'));
  try {
    const output = join(directory, 'report.html');
    const run = spawnSync(process.execPath, [scriptPath, samplePath, '--html', output], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const html = await readFile(output, 'utf8');
    assert.match(html, /Latency Lantern/);
    assert.match(html, /GET<\/code> \/api\/search/);
    assert.match(html, /33\.3% server errors/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
