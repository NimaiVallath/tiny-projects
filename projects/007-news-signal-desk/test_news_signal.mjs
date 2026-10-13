import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import "./news_signal.mjs";
const { analyze, parseCsv, rankCorrelation, readArticles, readPrices } = globalThis.NewsSignalDesk;

test("standalone page loads local classic scripts in dependency order", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>/g)].map((match) => match[1]);
  assert.deepEqual(scripts, ["news_signal.mjs", "app.mjs"]);
  for (const script of scripts) assert.ok(existsSync(new URL(script, new URL("./", import.meta.url))));
  assert.doesNotMatch(html, /type="module"/);
});

test("CSV handles commas, quotes, CRLF, and rejects malformed rows", () => {
  assert.deepEqual(parseCsv('name,note\r\nA,"said ""yes"", then left"\r\n'), [{ name: "A", note: 'said "yes", then left' }]);
  assert.throws(() => parseCsv("a,b\n1"), /expected 2/);
  assert.throws(() => parseCsv('a\n"unfinished'), /unclosed/);
});

test("financial inputs validate scores, prices, and duplicate issuer sessions", () => {
  assert.throws(() => readArticles("date,ticker,headline,sentiment\n2026-02-01,A,Title,1.1"), /Invalid article/);
  assert.throws(() => readArticles("date,ticker,headline,sentiment\n2026-02-31,A,Title,0.1"), /Invalid article/);
  assert.throws(() => readPrices("date,ticker,close\n2026-02-01,A,10\n2026-02-01,a,11"), /Duplicate/);
});

test("events anchor to last known close and missing horizons stay null", () => {
  const articles = readArticles("date,ticker,headline,sentiment\n2026-02-01,A,Weekend item,0.7\n2026-02-05,A,Too late,-0.4\n2026-02-02,B,No prices,0.2");
  const prices = readPrices("date,ticker,close\n2026-01-30,A,100\n2026-02-02,A,110\n2026-02-03,A,121\n2026-02-04,A,110");
  const result = analyze(articles, prices);
  assert.equal(result.events[0].anchor, "2026-01-30");
  assert.ok(Math.abs(result.events[0].returns[1] - 10) < 1e-10);
  assert.equal(result.events[0].returns[5], null);
  assert.equal(result.events[1].returns[1], null);
  assert.equal(result.summary.unmatched1d, 2);
});

test("Spearman rank correlation handles ties and constant series", () => {
  assert.ok(Math.abs(rankCorrelation([[1, 4], [2, 3], [2, 2], [4, 1]]) + 0.948683298) < 1e-8);
  assert.equal(rankCorrelation([[1, 2], [1, 3]]), null);
  assert.equal(rankCorrelation([[1, null]]), null);
});
