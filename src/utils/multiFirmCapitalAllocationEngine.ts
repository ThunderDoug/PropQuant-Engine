/**
 * Phase 4 — Multi-firm capital allocation.
 *
 * Performs deterministic exhaustive integer allocation over user-supplied
 * account candidates and complete joint scenario outcomes. It does not infer
 * probabilities, contract costs, or account payoffs.
 */

export interface CapitalAllocationCandidate {
  candidateId: string;
  accountId: string;
  firmId: string;
  /** Upfront external capital required for one account/unit. */
  capitalRequiredUsd: number;
  /** Maximum number of identical units/accounts represented by this candidate. */
  maxUnits: number;
}

export interface CapitalAllocationScenarioOutcome {
  /** Net scenario P&L per allocated unit, before capital opportunity cost. */
  netPnlUsd: number;
  /** Whether this candidate's account remains operational in this scenario. */
  survives: boolean;
}

export interface CapitalAllocationScenario {
  scenarioId: string;
  probability: number;
  /** Must contain an outcome for every candidate, including zero-unit candidates. */
  outcomes: Record<string, CapitalAllocationScenarioOutcome>;
}

export interface CapitalAllocationConstraints {
  /** Maximum total upfront external capital. */
  capitalBudgetUsd: number;
  /** Optional maximum share of committed capital allocated to one firm (0–100). */
  maxFirmCapitalSharePct?: number;
  /** Minimum number of distinct firms represented in the allocation. Defaults to 1. */
  minimumDistinctFirms?: number;
  /** Optional minimum probability that every selected account survives. */
  minimumPortfolioSurvivalProbability?: number;
  /** Optional maximum probability that net portfolio P&L is negative. */
  maximumProbabilityOfLoss?: number;
  /** Optional maximum CVaR loss at the configured confidence level. */
  maximumCvarLossUsd?: number;
  /** CVaR confidence level. Defaults to 0.95. */
  cvarConfidenceLevel?: number;
  /** Opportunity-cost rate applied to committed capital over the modeled horizon. */
  capitalCostRate?: number;
  /** Objective = expected net P&L − riskAversion × CVaR loss. Defaults to 0. */
  riskAversion?: number;
  /** Hard safety limit; exceeding it throws rather than returning a false optimum. */
  maxSearchNodes?: number;
}

export interface CapitalAllocationLine {
  candidateId: string;
  accountId: string;
  firmId: string;
  units: number;
  committedCapitalUsd: number;
}

export interface CapitalAllocationResult {
  status: 'optimal' | 'infeasible';
  allocation: CapitalAllocationLine[];
  searchNodes: number;
  committedCapitalUsd: number;
  unusedCapitalUsd: number;
  expectedGrossPnlUsd: number;
  capitalOpportunityCostUsd: number;
  expectedNetPnlUsd: number;
  expectedNetReturnOnCapitalPct: number | null;
  probabilityOfLoss: number;
  portfolioSurvivalProbability: number;
  valueAtRiskLossUsd: number;
  conditionalValueAtRiskLossUsd: number;
  worstScenarioNetPnlUsd: number;
  objectiveValueUsd: number;
  scenarioNetPnlUsd: Record<string, number>;
  scenarioSurvival: Record<string, boolean>;
}

const EPSILON = 1e-9;

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function weightedQuantile(
  values: Array<{ loss: number; probability: number }>,
  quantile: number
): number {
  const sorted = [...values].sort((a, b) => a.loss - b.loss);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.probability;
    if (cumulative + EPSILON >= quantile) return item.loss;
  }
  return sorted.length ? sorted[sorted.length - 1].loss : 0;
}

/** Expected loss in the worst (1 − confidence) probability tail, with fractional boundary mass. */
function weightedCvar(
  values: Array<{ loss: number; probability: number }>,
  confidence: number
): number {
  const tailMass = 1 - confidence;
  if (tailMass <= 0) return Math.max(0, ...values.map((item) => item.loss));
  const sorted = [...values].sort((a, b) => b.loss - a.loss);
  let remaining = tailMass;
  let weightedLoss = 0;
  for (const item of sorted) {
    const mass = Math.min(remaining, item.probability);
    weightedLoss += item.loss * mass;
    remaining -= mass;
    if (remaining <= EPSILON) break;
  }
  return weightedLoss / tailMass;
}

function validateInputs(
  candidates: CapitalAllocationCandidate[],
  scenarios: CapitalAllocationScenario[],
  constraints: CapitalAllocationConstraints
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    errors.push('At least one capital allocation candidate is required.');
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    errors.push('At least one joint scenario is required.');
  }
  if (!isFiniteNonNegative(constraints.capitalBudgetUsd)) {
    errors.push('capitalBudgetUsd must be finite and non-negative.');
  }
  const ids = new Set<string>();
  for (const candidate of candidates ?? []) {
    if (!candidate.candidateId?.trim()) errors.push('Every candidate requires candidateId.');
    if (ids.has(candidate.candidateId)) errors.push(`Duplicate candidateId "${candidate.candidateId}".`);
    ids.add(candidate.candidateId);
    if (!candidate.accountId?.trim()) errors.push(`Candidate "${candidate.candidateId}" requires accountId.`);
    if (!candidate.firmId?.trim()) errors.push(`Candidate "${candidate.candidateId}" requires firmId.`);
    if (!Number.isFinite(candidate.capitalRequiredUsd) || candidate.capitalRequiredUsd <= 0) {
      errors.push(`Candidate "${candidate.candidateId}" capitalRequiredUsd must be positive and finite.`);
    }
    if (!Number.isInteger(candidate.maxUnits) || candidate.maxUnits < 0) {
      errors.push(`Candidate "${candidate.candidateId}" maxUnits must be a non-negative integer.`);
    }
  }

  const scenarioIds = new Set<string>();
  let probabilityTotal = 0;
  for (const scenario of scenarios ?? []) {
    if (!scenario.scenarioId?.trim()) errors.push('Every scenario requires scenarioId.');
    if (scenarioIds.has(scenario.scenarioId)) errors.push(`Duplicate scenarioId "${scenario.scenarioId}".`);
    scenarioIds.add(scenario.scenarioId);
    if (!Number.isFinite(scenario.probability) || scenario.probability < 0) {
      errors.push(`Scenario "${scenario.scenarioId}" has an invalid probability.`);
    } else {
      probabilityTotal += scenario.probability;
    }
    for (const candidate of candidates ?? []) {
      const outcome = scenario.outcomes?.[candidate.candidateId];
      if (!outcome) {
        errors.push(`Scenario "${scenario.scenarioId}" is missing candidate "${candidate.candidateId}".`);
        continue;
      }
      if (!Number.isFinite(outcome.netPnlUsd) || typeof outcome.survives !== 'boolean') {
        errors.push(`Scenario "${scenario.scenarioId}" has an invalid outcome for "${candidate.candidateId}".`);
      }
    }
    for (const candidateId of Object.keys(scenario.outcomes ?? {})) {
      if (!ids.has(candidateId)) {
        errors.push(`Scenario "${scenario.scenarioId}" contains unknown candidate "${candidateId}".`);
      }
    }
  }
  if (Math.abs(probabilityTotal - 1) > 1e-9) {
    errors.push(`Joint scenario probabilities must sum to 1 (received ${probabilityTotal}).`);
  }

  const share = constraints.maxFirmCapitalSharePct;
  if (share !== undefined && (!Number.isFinite(share) || share <= 0 || share > 100)) {
    errors.push('maxFirmCapitalSharePct must be greater than 0 and at most 100.');
  }
  const minFirms = constraints.minimumDistinctFirms ?? 1;
  if (!Number.isInteger(minFirms) || minFirms < 1) {
    errors.push('minimumDistinctFirms must be a positive integer.');
  }
  const minSurvival = constraints.minimumPortfolioSurvivalProbability;
  if (minSurvival !== undefined && (!Number.isFinite(minSurvival) || minSurvival < 0 || minSurvival > 1)) {
    errors.push('minimumPortfolioSurvivalProbability must be between 0 and 1.');
  }
  const maxLoss = constraints.maximumProbabilityOfLoss;
  if (maxLoss !== undefined && (!Number.isFinite(maxLoss) || maxLoss < 0 || maxLoss > 1)) {
    errors.push('maximumProbabilityOfLoss must be between 0 and 1.');
  }
  const confidence = constraints.cvarConfidenceLevel ?? 0.95;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence >= 1) {
    errors.push('cvarConfidenceLevel must be in [0, 1).');
  }
  if (constraints.maximumCvarLossUsd !== undefined && !isFiniteNonNegative(constraints.maximumCvarLossUsd)) {
    errors.push('maximumCvarLossUsd must be non-negative and finite.');
  }
  if (constraints.capitalCostRate !== undefined && !isFiniteNonNegative(constraints.capitalCostRate)) {
    errors.push('capitalCostRate must be non-negative and finite.');
  }
  if (constraints.riskAversion !== undefined && !isFiniteNonNegative(constraints.riskAversion)) {
    errors.push('riskAversion must be non-negative and finite.');
  }
  const maxNodes = constraints.maxSearchNodes ?? 1_000_000;
  if (!Number.isInteger(maxNodes) || maxNodes <= 0) errors.push('maxSearchNodes must be a positive integer.');
  return errors;
}

/**
 * Finds the exact best feasible integer allocation by exhaustive enumeration.
 * Candidate payoffs are evaluated jointly under each supplied portfolio scenario.
 */
export function optimizeMultiFirmCapitalAllocation(
  candidates: CapitalAllocationCandidate[],
  scenarios: CapitalAllocationScenario[],
  constraints: CapitalAllocationConstraints
): CapitalAllocationResult {
  const errors = validateInputs(candidates, scenarios, constraints);
  if (errors.length) throw new Error(`Invalid capital allocation input: ${errors.join(' ')}`);

  const maxNodes = constraints.maxSearchNodes ?? 1_000_000;
  const capitalCostRate = constraints.capitalCostRate ?? 0;
  const riskAversion = constraints.riskAversion ?? 0;
  const confidence = constraints.cvarConfidenceLevel ?? 0.95;
  const minimumFirms = constraints.minimumDistinctFirms ?? 1;
  const units = new Array<number>(candidates.length).fill(0);
  const firmCapital: Record<string, number> = {};
  let searchNodes = 0;
  const bestHolder: { value: CapitalAllocationResult | null } = { value: null };

  const evaluate = (capital: number): CapitalAllocationResult | null => {
    const activeIndexes = candidates.map((_, index) => index).filter((index) => units[index] > 0);
    const activeFirms = new Set(activeIndexes.map((index) => candidates[index].firmId));
    if (activeFirms.size < minimumFirms) return null;
    if (capital > constraints.capitalBudgetUsd + EPSILON) return null;

    const maxShare = constraints.maxFirmCapitalSharePct;
    if (maxShare !== undefined && capital > EPSILON) {
      for (const firmId of activeFirms) {
        if ((firmCapital[firmId] ?? 0) / capital * 100 > maxShare + EPSILON) return null;
      }
    }

    const capitalCost = capital * capitalCostRate;
    const scenarioPnl: Record<string, number> = {};
    const scenarioSurvival: Record<string, boolean> = {};
    const lossDistribution: Array<{ loss: number; probability: number }> = [];
    let expectedGross = 0;
    let probabilityLoss = 0;
    let survivalProbability = 0;
    let worst = Number.POSITIVE_INFINITY;

    for (const scenario of scenarios) {
      let grossPnl = 0;
      let survives = true;
      for (const index of activeIndexes) {
        const candidate = candidates[index];
        const outcome = scenario.outcomes[candidate.candidateId];
        grossPnl += outcome.netPnlUsd * units[index];
        if (!outcome.survives) survives = false;
      }
      const netPnl = grossPnl - capitalCost;
      scenarioPnl[scenario.scenarioId] = netPnl;
      scenarioSurvival[scenario.scenarioId] = survives;
      expectedGross += grossPnl * scenario.probability;
      if (netPnl < 0) probabilityLoss += scenario.probability;
      if (survives) survivalProbability += scenario.probability;
      worst = Math.min(worst, netPnl);
      lossDistribution.push({ loss: -netPnl, probability: scenario.probability });
    }

    const expectedNet = expectedGross - capitalCost;
    const varLoss = Math.max(0, weightedQuantile(lossDistribution, confidence));
    const cvarLoss = Math.max(0, weightedCvar(lossDistribution, confidence));
    if (
      constraints.minimumPortfolioSurvivalProbability !== undefined &&
      survivalProbability + EPSILON < constraints.minimumPortfolioSurvivalProbability
    ) return null;
    if (
      constraints.maximumProbabilityOfLoss !== undefined &&
      probabilityLoss > constraints.maximumProbabilityOfLoss + EPSILON
    ) return null;
    if (
      constraints.maximumCvarLossUsd !== undefined &&
      cvarLoss > constraints.maximumCvarLossUsd + EPSILON
    ) return null;

    const allocation = activeIndexes.map((index) => ({
      candidateId: candidates[index].candidateId,
      accountId: candidates[index].accountId,
      firmId: candidates[index].firmId,
      units: units[index],
      committedCapitalUsd: candidates[index].capitalRequiredUsd * units[index],
    }));
    const objective = expectedNet - riskAversion * cvarLoss;
    return {
      status: 'optimal',
      allocation,
      searchNodes,
      committedCapitalUsd: capital,
      unusedCapitalUsd: Math.max(0, constraints.capitalBudgetUsd - capital),
      expectedGrossPnlUsd: expectedGross,
      capitalOpportunityCostUsd: capitalCost,
      expectedNetPnlUsd: expectedNet,
      expectedNetReturnOnCapitalPct: capital > 0 ? expectedNet / capital * 100 : null,
      probabilityOfLoss: probabilityLoss,
      portfolioSurvivalProbability: survivalProbability,
      valueAtRiskLossUsd: varLoss,
      conditionalValueAtRiskLossUsd: cvarLoss,
      worstScenarioNetPnlUsd: worst,
      objectiveValueUsd: objective,
      scenarioNetPnlUsd: scenarioPnl,
      scenarioSurvival,
    };
  };

  const visit = (index: number, capital: number): void => {
    searchNodes += 1;
    if (searchNodes > maxNodes) {
      throw new Error(`Capital allocation search exceeded maxSearchNodes (${maxNodes}); no optimality claim is available.`);
    }
    if (index === candidates.length) {
      const result = evaluate(capital);
      if (
        result &&
        (!bestHolder.value ||
          result.objectiveValueUsd > bestHolder.value.objectiveValueUsd + EPSILON ||
          (Math.abs(result.objectiveValueUsd - bestHolder.value.objectiveValueUsd) <= EPSILON &&
            result.committedCapitalUsd < bestHolder.value.committedCapitalUsd - EPSILON))
      ) bestHolder.value = result;
      return;
    }

    const candidate = candidates[index];
    for (let count = 0; count <= candidate.maxUnits; count += 1) {
      const nextCapital = capital + candidate.capitalRequiredUsd * count;
      if (nextCapital > constraints.capitalBudgetUsd + EPSILON) break;
      units[index] = count;
      firmCapital[candidate.firmId] = (firmCapital[candidate.firmId] ?? 0) +
        candidate.capitalRequiredUsd * count;
      visit(index + 1, nextCapital);
      firmCapital[candidate.firmId] -= candidate.capitalRequiredUsd * count;
    }
    units[index] = 0;
  };

  visit(0, 0);
  const best = bestHolder.value;
  if (!best) {
    return {
      status: 'infeasible',
      allocation: [],
      searchNodes,
      committedCapitalUsd: 0,
      unusedCapitalUsd: constraints.capitalBudgetUsd,
      expectedGrossPnlUsd: 0,
      capitalOpportunityCostUsd: 0,
      expectedNetPnlUsd: 0,
      expectedNetReturnOnCapitalPct: null,
      probabilityOfLoss: 0,
      portfolioSurvivalProbability: 0,
      valueAtRiskLossUsd: 0,
      conditionalValueAtRiskLossUsd: 0,
      worstScenarioNetPnlUsd: 0,
      objectiveValueUsd: Number.NEGATIVE_INFINITY,
      scenarioNetPnlUsd: {},
      scenarioSurvival: {},
    };
  }
  return { ...best, searchNodes };
}
