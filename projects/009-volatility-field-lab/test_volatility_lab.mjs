import test from "node:test";
import assert from "node:assert/strict";
import { annualizedVolatility, evaluateReturns, fitGarch, makeDemoCsv, parseReturnsCsv } from "./volatility_lab.mjs";

const sample = parseReturnsCsv(makeDemoCsv());

test("demo is deterministic and explicitly shaped into changing volatility regimes", () => {
  assert.equal(makeDemoCsv(), makeDemoCsv());
  assert.equal(sample.length, 120);
  assert.ok(Math.max(...sample.slice(34, 56).map((row) => Math.abs(row.value))) > Math.max(...sample.slice(0, 34).map((row) => Math.abs(row.value))));
});

test("CSV validates, sorts chronology, handles quotes, and rejects invalid rows", () => {
  const rows = parseReturnsCsv("date,return_pct\r\n2025-01-03,\"-1.25\"\r\n2025-01-02,0.5\r\n" + makeDemoCsv().split("\n").slice(3).join("\n"));
  assert.equal(rows[0].date, "2025-01-02");
  assert.equal(rows[0].value, 0.005);
  assert.throws(() => parseReturnsCsv(makeDemoCsv().replace("return_pct", "value")), /return_pct/);
  assert.throws(() => parseReturnsCsv(makeDemoCsv().replace("2025-01-02,", "2025-02-31,")), /Invalid date/);
  assert.throws(() => parseReturnsCsv(`${makeDemoCsv()}\n2025-01-02,0.1`), /Duplicate date/);
  assert.throws(() => parseReturnsCsv("date,return_pct\n2025-01-01,1"), /at least 40/);
});

test("GARCH fit stays stationary and produces finite positive variance", () => {
  const fit = fitGarch(sample.slice(0, 80).map((row) => row.value));
  assert.ok(fit.alpha > 0);
  assert.ok(fit.beta > 0);
  assert.ok(fit.alpha + fit.beta < 0.995);
  assert.ok(fit.omega > 0);
  assert.ok(Number.isFinite(fit.nextVariance) && fit.nextVariance > 0);
});

test("holdout is chronological, out-of-sample, and reports comparable scores", () => {
  const result = evaluateReturns(sample);
  assert.equal(result.trainCount + result.testCount, sample.length);
  assert.equal(result.testCount, 24);
  assert.equal(result.holdoutStart, sample[result.splitIndex].date);
  assert.deepEqual(Object.keys(result.metrics).sort(), ["ewma", "garch", "rolling"]);
  for (const metric of Object.values(result.metrics)) {
    assert.ok(Number.isFinite(metric.qlike));
    assert.ok(Number.isFinite(metric.maeVariance));
    assert.ok(metric.breaches95 >= 0 && metric.breaches95 <= result.testCount);
  }
  assert.ok(result.test.every((row) => row.date >= result.holdoutStart));
  assert.ok(Object.values(result.next).every((value) => Number.isFinite(value) && value > 0));
});

test("the first holdout forecast cannot see that date's realized return", () => {
  const changed = sample.map((row) => ({ ...row }));
  const original = evaluateReturns(sample);
  changed[original.splitIndex].value *= 12;
  const counterfactual = evaluateReturns(changed);
  for (const model of ["rolling", "ewma", "garch"]) assert.equal(counterfactual.test[0][model], original.test[0][model]);
  assert.notEqual(counterfactual.test[0].realized, original.test[0].realized);
});

test("annualization converts daily decimal volatility to a percentage", () => {
  assert.ok(Math.abs(annualizedVolatility(0.01 ** 2) - 15.874507866) < 1e-6);
  assert.equal(annualizedVolatility(-3), 0);
});
