/**
 * Phase 5 — Minimum external capital requirement.
 *
 * Computes pathwise liquidity funding requirements from complete joint
 * portfolio cash-flow scenarios. Scenario cash flows must represent cash
 * actually available to operations at each period, not unrealized P&L.
 */

export interface ExternalCapitalPeriod {
  period: number;
  /** Net cash flow available to operations during this period (USD). */
  netCashFlowUsd: number;
}

export interface ExternalCapitalScenario {
  scenarioId: string;
  probability: number;
  /** Ordered cash-flow path for the full modeled horizon. */
  periods: ExternalCapitalPeriod[];
}

export interface ExternalCapitalConstraints {
  /** Cash already available at the start of period 0. */
  availableCapitalUsd: number;
  /** Additional liquidity reserve required above the modeled cash deficit. */
  minimumReserveUsd?: number;
  /** Probability level used for the recommended funding requirement. Defaults to 0.95. */
  confidenceLevel?: number;
  /** Optional maximum external funding the operator can raise. */
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
    if (cumulative + EPSILON >= confidence) return item.value;
  }
  return sorted.length ? sorted[sorted.length - 1].value : 0;
}

/** Probability-weighted mean of the worst (1-confidence) funding-requirement tail. */
function weightedTailMean(
  values: Array<{ value: number; probability: number }>,
  confidence: number
): number {
  const tailMass = 1 - confidence;
  if (tailMass <= 0) return Math.max(0, ...values.map((item) => item.value));
  const sorted = [...values].sort((a, b) => b.value - a.value);
  let remaining = tailMass;
  let weighted = 0;
  for (const item of sorted) {
    const mass = Math.min(remaining, item.probability);
    weighted += item.value * mass;
    remaining -= mass;
    if (remaining <= EPSILON) break;
  }
  return weighted / tailMass;
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
  const reserve = constraints.minimumReserveUsd ?? 0;
  if (!finiteNonNegative(reserve)) errors.push('minimumReserveUsd must be finite and non-negative.');
  const confidence = constraints.confidenceLevel ?? 0.95;
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    errors.push('confidenceLevel must be greater than 0 and less than 1.');
  }
  if (
    constraints.externalFundingBudgetUsd !== undefined &&
    !finiteNonNegative(constraints.externalFundingBudgetUsd)
  ) errors.push('externalFundingBudgetUsd must be finite and non-negative.');

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
    const seenPeriods = new Set<number>();
    scenario.periods.forEach((item, index) => {
      if (!Number.isInteger(item.period) || item.period < 1) {
        errors.push(`Scenario "${scenario.scenarioId}" contains an invalid period index.`);
      }
      if (seenPeriods.has(item.period)) errors.push(`Scenario "${scenario.scenarioId}" contains duplicate period ${item.period}.`);
      seenPeriods.add(item.period);
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
 * Computes the minimum starting cash required in each complete scenario path.
 * Required starting capital equals the maximum cumulative cash deficit plus
 * the reserve. External capital is the amount above cash already available.
 */
export function calculateMinimumExternalCapital(
  scenarios: ExternalCapitalScenario[],
  constraints: ExternalCapitalConstraints
): ExternalCapitalRequirementResult {
  const modeledPeriods = validate(scenarios, constraints);
  const reserve = constraints.minimumReserveUsd ?? 0;
  const confidence = constraints.confidenceLevel ?? 0.95;
  const available = constraints.availableCapitalUsd;

  const scenarioResults: ExternalCapitalScenarioResult[] = scenarios.map((scenario) => {
    let cumulativeFlow = 0;
    let minimumCashBeforeFunding = available;
    let peakDeficit = 0;
    let periodOfPeakDeficit = scenario.periods[0].period;
    for (const item of scenario.periods) {
      cumulativeFlow += item.netCashFlowUsd;
      const cash = available + cumulativeFlow;
      if (cash < minimumCashBeforeFunding) minimumCashBeforeFunding = cash;
      const deficit = Math.max(0, -cumulativeFlow);
      if (deficit > peakDeficit) {
        peakDeficit = deficit;
        periodOfPeakDeficit = item.period;
      }
    }
    const requiredStarting = peakDeficit + reserve;
    const externalRequired = Math.max(0, requiredStarting - available);
    const fundingGap = Math.max(0, externalRequired);
    const minimumCash = available + cumulativeFlow - Math.max(0, cumulativeFlow - Math.min(0, cumulativeFlow));
    // Minimum cash is evaluated on the unfunded path; reserve is a separate policy buffer.
    const minCashPath = Math.min(
      available,
      ...scenario.periods.reduce<number[]>((balances, item, index) => {
        const prior = index === 0 ? available : balances[index - 1];
        balances.push(prior + item.netCashFlowUsd);
        return balances;
      }, [])
    );
    return {
      scenarioId: scenario.scenarioId,
      probability: scenario.probability,
      peakCumulativeCashDeficitUsd: peakDeficit,
      requiredStartingCapitalUsd: requiredStarting,
      externalCapitalRequiredUsd: externalRequired,
      fundingGapUsd: fundingGap,
      survivesWithAvailableCapital: minCashPath + EPSILON >= 0 && minCashPath + EPSILON >= reserve,
      minimumCashBalanceUsd: minCashPath,
      endingCashBalanceUsd: available + cumulativeFlow,
      periodOfPeakDeficit,
    };
  });

  const distribution = scenarioResults.map((item) => ({
    value: item.externalCapitalRequiredUsd,
    probability: item.probability,
  }));
  const expected = distribution.reduce((sum, item) => sum + item.value * item.probability, 0);
  const recommended = weightedQuantile(distribution, confidence);
  const tailMean = weightedTailMean(distribution, confidence);
  const sufficientProbability = scenarioResults.reduce(
    (sum, item) => sum + (item.externalCapitalRequiredUsd <= EPSILON ? item.probability : 0), 0
  );
  const budget = constraints.externalFundingBudgetUsd;
  const budgetSufficient = budget === undefined ? null : scenarioResults.reduce(
    (sum, item) => sum + (item.externalCapitalRequiredUsd <= budget + EPSILON ? item.probability : 0), 0
  );
  const worst = Math.max(...distribution.map((item) => item.value));
  const maximumGap = Math.max(0, worst - (budget ?? worst));

  return {
    status: recommended <= EPSILON ? 'feasible' : 'funding_shortfall',
    modeledPeriods,
    availableCapitalUsd: available,
    minimumReserveUsd: reserve,
    expectedExternalCapitalRequiredUsd: expected,
    recommendedExternalCapitalUsd: recommended,
    worstCaseExternalCapitalRequiredUsd: worst,
    probabilityAvailableCapitalIsSufficient: sufficientProbability,
    probabilityOfFundingShortfall: 1 - sufficientProbability,
    probabilityFundingBudgetIsSufficient: budgetSufficient,
    fundingBudgetUsd: budget ?? null,
    valueAtRiskFundingRequirementUsd: recommended,
    conditionalTailMeanFundingRequirementUsd: tailMean,
    maximumFundingGapUsd: maximumGap,
    scenarios: scenarioResults,
  };
}
