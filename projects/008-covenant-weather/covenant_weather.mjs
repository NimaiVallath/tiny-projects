export const DEFAULT_CASE = Object.freeze({
  revenue: 240, ebitdaMargin: 0.18, debt: 210, cash: 18,
  annualInterest: 13.2, floatingShare: 0.55, maxNetLeverage: 5,
  minInterestCoverage: 2.5,
});

export function validateCase(input) {
  const fields = Object.keys(DEFAULT_CASE);
  const values = {};
  for (const field of fields) {
    const value = Number(input[field]);
    if (!Number.isFinite(value)) throw new Error(`${field} must be a finite number.`);
    if (value < 0) throw new Error(`${field} cannot be negative.`);
    values[field] = value;
  }
  if (values.revenue <= 0) throw new Error("Revenue must be greater than zero.");
  if (values.debt <= 0) throw new Error("Debt must be greater than zero.");
  if (values.ebitdaMargin > 1) throw new Error("EBITDA margin must be between 0% and 100%.");
  if (values.floatingShare > 1) throw new Error("Floating-rate debt share must be between 0% and 100%.");
  if (values.maxNetLeverage <= 0 || values.minInterestCoverage <= 0) throw new Error("Covenant limits must be greater than zero.");
  return values;
}

export function calculateCase(input, { revenueShock = 0, rateShockBps = 0 } = {}) {
  const borrower = validateCase(input);
  if (!Number.isFinite(revenueShock) || revenueShock < -1 || revenueShock > 1) throw new Error("Revenue shock must be from −100% to +100%.");
  if (!Number.isFinite(rateShockBps) || rateShockBps < 0 || rateShockBps > 3000) throw new Error("Rate shock must be from 0 to 3,000 basis points.");
  const revenue = borrower.revenue * (1 + revenueShock);
  const ebitda = revenue * borrower.ebitdaMargin;
  const incrementalInterest = borrower.debt * borrower.floatingShare * rateShockBps / 10_000;
  const interest = borrower.annualInterest + incrementalInterest;
  const netDebt = borrower.debt - borrower.cash;
  const netLeverage = ebitda > 0 ? netDebt / ebitda : null;
  const interestCoverage = interest > 0 ? ebitda / interest : null;
  const leverageHeadroom = netLeverage === null ? null : borrower.maxNetLeverage - netLeverage;
  const coverageHeadroom = interestCoverage === null ? null : interestCoverage - borrower.minInterestCoverage;
  return {
    revenue, ebitda, netDebt, interest, incrementalInterest, netLeverage,
    interestCoverage, leverageHeadroom, coverageHeadroom,
    leverageBreach: netLeverage === null || netLeverage > borrower.maxNetLeverage,
    coverageBreach: interestCoverage === null || interestCoverage < borrower.minInterestCoverage,
  };
}

export function buildSensitivity(input, { revenueShocks = [-0.4, -0.3, -0.2, -0.1, 0], rateShocksBps = [0, 100, 200, 300, 400] } = {}) {
  const borrower = validateCase(input);
  return {
    revenueShocks: [...revenueShocks],
    rateShocksBps: [...rateShocksBps],
    cells: revenueShocks.map((revenueShock) => rateShocksBps.map((rateShockBps) => ({
      revenueShock,
      rateShockBps,
      ...calculateCase(borrower, { revenueShock, rateShockBps }),
    }))),
  };
}

export function describeRisk(result) {
  if (result.leverageBreach && result.coverageBreach) return "Both limits breached";
  if (result.leverageBreach) return "Leverage limit breached";
  if (result.coverageBreach) return "Coverage limit breached";
  const leverageNear = result.leverageHeadroom !== null && result.leverageHeadroom < 0.5;
  const coverageNear = result.coverageHeadroom !== null && result.coverageHeadroom < 0.5;
  return leverageNear || coverageNear ? "Within limits · thin headroom" : "Within both limits";
}
