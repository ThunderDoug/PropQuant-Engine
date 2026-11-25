/**
 * Phase 5 — Minimum external capital requirement.
 *
 * Computes pathwise liquidity funding requirements from complete joint
 * portfolio cash-flow scenarios. Cash flows must be operational cash receipts
 * and payments, not unrealized trading P&L or merely eligible withdrawals.
 */

export interface ExternalCapitalPeriod {
  period: number;
  netCashFlowUsd: number;
}

export interface ExternalCapitalScenario {
  scenarioId: string;
  probability: number;
  periods: ExternalCapitalPeriod[];
}

export interface ExternalCapitalConstraints {
  availableCapitalUsd: number;
  minimumReserveUsd?: number;
  confidenceLevel?: number;
  externalFundingBudgetUsd?: number;
}

export interface ExternalCapitalScenarioResult {
  scenarioId: string;
  probability: number;
  peakCumulativeCashDeficitUsd: number;
  requiredStartingCapitalUsd: number;
  externalCapitalRequiredUsd: number;
  fundingGapUsd: number;
  survivesWithAvailableCapital: boolean;
  minimumCashBalanceUsd: number;
  endingCashBalanceUsd: number;
  periodOfPeakDeficit: number;
}

export interface ExternalCapitalRequirementResult {
  status: 'feasible' | 'funding_shortfall';
  modeledPeriods: number;
  availableCapitalUsd: number;
  minimumReserveUsd: number;
  expectedExternalCapitalRequiredUsd: number;
  recommendedExternalCapitalUsd: number;
  worstCaseExternalCapitalRequiredUsd: number;
  probabilityAvailableCapitalIsSufficient: number;
  probabilityOfFundingShortfall: number;
  probabilityFundingBudgetIsSufficient: number | null;
  fundingBudgetUsd: number | null;
  valueAtRiskFundingRequirementUsd: number;
  conditionalTailMeanFundingRequirementUsd: number;
  maximumFundingGapUsd: number;
  scenarios: ExternalCapitalScenarioResult[];
}

const EPSILON = 1e-9;

function roundTo(value: number, decimals = 10): number {
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function clampProbability(value: number): number {
  const rounded = roundTo(value, 10);
  if (rounded <= EPSILON) return 0;
  if (rounded >= 1 - EPSILON) return 1;
  return rounded;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function weightedQuantile(
  values: Array<{ value: number; probability: number }>,
  confidence: number
): number {
  const sorted = [...values].sort((a, b) => a.value - b.value);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.probability;
    if (cumulative + EPSILON >= confidence) return roundTo(item.value, 10);
  }
  return sorted.length ? roundTo(sorted[sorted.length - 1].value, 10) : 0;
}

/** Probability-weighted mean of the worst (1-confidence) funding-requirement tail. */
function weightedTailMean(
  values: Array<{ value: number; probability: number }>,
  confidence: number
): number {
  const tailMass = roundTo(1 - confidence, 12);
  const sorted = [...values].sort((a, b) => b.value - a.value);
  let remaining = tailMass;
  let weighted = 0;
  for (const item of sorted) {
    const mass = Math.min(remaining, item.probability);
    weighted += item.value * mass;
    remaining = Math.max(0, roundTo(remaining - mass, 12));
    if (remaining <= EPSILON) break;
  }
  return tailMass > 0 ? roundTo(weighted / tailMass, 10) : roundTo(sorted[0]?.value ?? 0, 10);
}

function validate(
  scenarios: ExternalCapitalScenario[],
  constraints: ExternalCapitalConstraints
): number {
  const errors: string[] = [];
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    errors.push('At least one joint cash-flow scenario is required.');
  }
  if (!finiteNonNegative(constraints.availableCapitalUsd)) {
    errors.push('availableCapitalUsd must be finite and non-negative.');
  }
  if (!finiteNonNegative(constraints.minimumReserveUsd ?? 0)) {
    errors.push('minimumReserveUsd must be finite and non-negative.');
  }
  const confidence = constraints.confidenceLevel ?? 0.95;
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    errors.push('confidenceLevel must be greater than 0 and less than 1.');
  }
  if (constraints.externalFundingBudgetUsd !== undefined &&
      !finiteNonNegative(constraints.externalFundingBudgetUsd)) {
    errors.push('externalFundingBudgetUsd must be finite and non-negative.');
  }

  const ids = new Set<string>();
  let probabilityTotal = 0;
  let expectedPeriods: number | null = null;
  for (const scenario of scenarios ?? []) {
    if (!scenario.scenarioId?.trim()) errors.push('Every scenario requires scenarioId.');
    if (ids.has(scenario.scenarioId)) errors.push(`Duplicate scenarioId "${scenario.scenarioId}".`);
    ids.add(scenario.scenarioId);
    if (!Number.isFinite(scenario.probability) || scenario.probability < 0) {
      errors.push(`Scenario "${scenario.scenarioId}" has an invalid probability.`);
    } else probabilityTotal += scenario.probability;
    if (!Array.isArray(scenario.periods) || scenario.periods.length === 0) {
      errors.push(`Scenario "${scenario.scenarioId}" requires at least one period.`);
      continue;
    }
    if (expectedPeriods === null) expectedPeriods = scenario.periods.length;
    if (scenario.periods.length !== expectedPeriods) {
      errors.push('All scenarios must cover the same number of periods.');
    }
    scenario.periods.forEach((item, index) => {
      if (!Number.isInteger(item.period) || item.period < 1) {
        errors.push(`Scenario "${scenario.scenarioId}" contains an invalid period index.`);
      }
      if (!Number.isFinite(item.netCashFlowUsd)) {
        errors.push(`Scenario "${scenario.scenarioId}" has non-finite cash flow at period ${item.period}.`);
      }
      if (index > 0 && item.period <= scenario.periods[index - 1].period) {
        errors.push(`Scenario "${scenario.scenarioId}" periods must be strictly increasing.`);
      }
    });
  }
  if (Math.abs(probabilityTotal - 1) > EPSILON) {
    errors.push(`Joint scenario probabilities must sum to 1 (received ${probabilityTotal}).`);
  }
  if (errors.length) throw new Error(`Invalid external capital input: ${errors.join(' ')}`);
  return expectedPeriods ?? 0;
}

/**
 * Pathwise required starting capital = maximum cumulative cash deficit + reserve.
 * External capital required is the amount above capital already available.
 */
export function calculateMinimumExternalCapital(
  scenarios: ExternalCapitalScenario[],
  constraints: ExternalCapitalConstraints
): ExternalCapitalRequirementResult {
  const modeledPeriods = validate(scenarios, constraints);
  const reserve = constraints.minimumReserveUsd ?? 0;
  const confidence = constraints.confidenceLevel ?? 0.95;
  const available = constraints.availableCapitalUsd;
  const budget = constraints.externalFundingBudgetUsd;

  const scenarioResults: ExternalCapitalScenarioResult[] = scenarios.map((scenario) => {
    let cumulativeFlow = 0;
    let minimumCash = available;
    let peakDeficit = 0;
    let periodOfPeakDeficit = scenario.periods[0].period;
    for (const item of scenario.periods) {
      cumulativeFlow += item.netCashFlowUsd;
      const cash = available + cumulativeFlow;
      minimumCash = Math.min(minimumCash, cash);
      const deficit = Math.max(0, -cumulativeFlow);
      if (deficit > peakDeficit) {
        peakDeficit = deficit;
        periodOfPeakDeficit = item.period;
      }
    }
    const requiredStarting = peakDeficit + reserve;
    const externalRequired = Math.max(0, requiredStarting - available);
    return {
      scenarioId: scenario.scenarioId,
      probability: scenario.probability,
      peakCumulativeCashDeficitUsd: peakDeficit,
      requiredStartingCapitalUsd: requiredStarting,
      externalCapitalRequiredUsd: externalRequired,
      fundingGapUsd: Math.max(0, externalRequired - (budget ?? externalRequired)),
      survivesWithAvailableCapital: minimumCash + EPSILON >= reserve,
      minimumCashBalanceUsd: minimumCash,
      endingCashBalanceUsd: available + cumulativeFlow,
      periodOfPeakDeficit,
    };
  });

  const distribution = scenarioResults.map((item) => ({
    value: item.externalCapitalRequiredUsd,
    probability: item.probability,
  }));
  const expected = roundTo(
    distribution.reduce((sum, item) => sum + item.value * item.probability, 0),
    10
  );
  const recommended = weightedQuantile(distribution, confidence);
  const tailMean = weightedTailMean(distribution, confidence);
  const sufficientProbability = clampProbability(
    scenarioResults.reduce(
      (sum, item) => sum + (item.survivesWithAvailableCapital ? item.probability : 0),
      0
    )
  );
  const budgetSufficient =
    budget === undefined
      ? null
      : clampProbability(
          scenarioResults.reduce(
            (sum, item) => sum + (item.externalCapitalRequiredUsd <= budget + EPSILON ? item.probability : 0),
            0
          )
        );
  const worst = roundTo(Math.max(...distribution.map((item) => item.value)), 10);
  const maximumGap = roundTo(Math.max(0, worst - (budget ?? worst)), 10);

  return {
    status: sufficientProbability >= 1 - EPSILON ? 'feasible' : 'funding_shortfall',
    modeledPeriods,
    availableCapitalUsd: available,
    minimumReserveUsd: reserve,
    expectedExternalCapitalRequiredUsd: expected,
    recommendedExternalCapitalUsd: recommended,
    worstCaseExternalCapitalRequiredUsd: worst,
    probabilityAvailableCapitalIsSufficient: sufficientProbability,
    probabilityOfFundingShortfall: clampProbability(1 - sufficientProbability),
    probabilityFundingBudgetIsSufficient: budgetSufficient,
    fundingBudgetUsd: budget ?? null,
    valueAtRiskFundingRequirementUsd: recommended,
    conditionalTailMeanFundingRequirementUsd: tailMean,
    maximumFundingGapUsd: maximumGap,
    scenarios: scenarioResults,
  };
}
