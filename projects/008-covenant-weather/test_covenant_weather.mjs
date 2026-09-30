import test from "node:test";
import assert from "node:assert/strict";
import { buildSensitivity, calculateCase, DEFAULT_CASE, describeRisk, validateCase } from "./covenant_weather.mjs";

test("baseline reproduces the stated net leverage and interest coverage math", () => {
  const result = calculateCase(DEFAULT_CASE);
  assert.equal(result.revenue, 240);
  assert.ok(Math.abs(result.ebitda - 43.2) < 1e-10);
  assert.equal(result.netDebt, 192);
  assert.ok(Math.abs(result.netLeverage - 4.4444444444) < 1e-9);
  assert.ok(Math.abs(result.interestCoverage - 3.2727272727) < 1e-9);
  assert.equal(describeRisk(result), "Within both limits");
});

test("a downside/rate shock cannot improve either ratio", () => {
  const baseline = calculateCase(DEFAULT_CASE);
  const stress = calculateCase(DEFAULT_CASE, { revenueShock: -0.25, rateShockBps: 300 });
  assert.ok(stress.netLeverage > baseline.netLeverage);
  assert.ok(stress.interestCoverage < baseline.interestCoverage);
  assert.equal(stress.leverageBreach, true);
  assert.equal(stress.coverageBreach, true);
  assert.equal(describeRisk(stress), "Both limits breached");
});

test("zero EBITDA is a breach with a null ratio, never Infinity or NaN", () => {
  const result = calculateCase(DEFAULT_CASE, { revenueShock: -1 });
  assert.equal(result.netLeverage, null);
  assert.equal(result.interestCoverage, 0);
  assert.equal(result.leverageBreach, true);
  assert.equal(Number.isFinite(result.interestCoverage), true);
});

test("validation rejects nonsensical snapshots and stress bounds", () => {
  assert.throws(() => validateCase({ ...DEFAULT_CASE, floatingShare: 1.1 }), /between 0% and 100%/);
  assert.equal(calculateCase({ ...DEFAULT_CASE, cash: 220 }).netDebt, -10);
  assert.throws(() => calculateCase(DEFAULT_CASE, { revenueShock: -1.1 }), /Revenue shock/);
  assert.throws(() => calculateCase(DEFAULT_CASE, { rateShockBps: 3500 }), /Rate shock/);
});

test("sensitivity cells preserve shock axes and scenario values", () => {
  const map = buildSensitivity(DEFAULT_CASE, { revenueShocks: [-0.2, 0], rateShocksBps: [0, 200] });
  assert.deepEqual(map.revenueShocks, [-0.2, 0]);
  assert.deepEqual(map.rateShocksBps, [0, 200]);
  assert.equal(map.cells[0][1].rateShockBps, 200);
  assert.equal(map.cells[0][0].revenueShock, -0.2);
  assert.equal(map.cells[0][1].interest, DEFAULT_CASE.annualInterest + DEFAULT_CASE.debt * DEFAULT_CASE.floatingShare * 0.02);
});
