/**
 * Phase 8 — Contract-aware hedge ratio optimization.
 *
 * Searches a bounded, discretized vector of non-negative exposure multipliers.
 * Each candidate is evaluated against the same complete joint scenario matrix
 * and the canonical Phase 2 contractual payoff function.
 *
 * This is scenario analysis only: no orders are generated or executed.
 */

import type { PropFirmPreset } from '../types/quant.ts';
import {
  calculateContractualPayoff,
  type ContractualAccountState,
  type ContractualPayoffResult,
} from './contractualPayoffEngine.ts';
import type { JointAccountOutcome } from './jointScenarioEngine.ts';

export interface HedgeRatioAccount {
  accountId: string;
  firm: PropFirmPreset;
  accountState: ContractualAccountState;
  /** Multiplies this account's signed scenario P&L. Opposing signs must be encoded in source P&L. */
  ratio: { min: number; max: number; step: number };
}

export interface HedgeRatioScenario {
  scenarioId: string;
  probability: number;
  outcomes: Record<string, JointAccountOutcome>;
}

export interface HedgeRatioConstraints {
  maxProbabilityOfCombinedLoss?: number;
  maxWorstCaseCombinedLossUsd?: number;
  minExpectedContractualPayoutUsd?: number;
  minPayoutOpportunityProbability?: number;
  /** Maximum absolute combined gross loss in any supplied scenario. */
  maxScenarioGrossLossUsd?: number;
  maxSearchNodes?: number;
}

export interface HedgeRatioOptimizationOptions {
  constraints?: HedgeRatioConstraints;
  tolerance?: number;
}

export interface HedgeRatioAllocation {
  accountId: string;
  firmId: string;
  firmName: string;
  ratio: number;
}

export interface HedgeRatioScenarioResult {
  scenarioId: string;
  probability: number;
  combinedGrossPnlUsd: number;
  contractualTraderPayoutUsd: number;
  combinedLoss: boolean;
  payoutOpportunity: boolean;
  accountResults: Record<string, ContractualPayoffResult>;
}

export interface HedgeRatioCandidateMetrics {
  expectedCombinedGrossPnlUsd: number;
  expectedContractualTraderPayoutUsd: number;
  probabilityOfCombinedLoss: number;
  worstCaseCombinedLossUsd: number;
  payoutOpportunityProbability: number;
}

export interface HedgeRatioOptimizationResult {
  status: 'optimal' | 'infeasible';
  allocation: HedgeRatioAllocation[];
  metrics: HedgeRatioCandidateMetrics | null;
  scenarioResults: HedgeRatioScenarioResult[];
  searchNodes: number;
  feasibleCandidates: number;
  objectivePriority: string[];
  reason: string | null;
}

interface EvaluatedCandidate {
  ratios: number[];
  metrics: HedgeRatioCandidateMetrics;
  scenarioResults: HedgeRatioScenarioResult[];
  key: string;
}

const EPSILON = 1e-9;
const OBJECTIVE_PRIORITY = [
  '1. Maximize expected contractual trader payout (potential payout, not received cash).',
  '2. Maximize expected combined gross P&L.',
  '3. Minimize probability of negative combined gross P&L.',
  '4. Minimize worst-case combined gross loss.',
  '5. Deterministic lexical tie-break on ratio vector.',
];

function inProbabilityRange(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validate(
  accounts: HedgeRatioAccount[],
  scenarios: HedgeRatioScenario[],
  constraints: HedgeRatioConstraints
): void {
  const errors: string[] = [];
  if (!Array.isArray(accounts) || accounts.length === 0) errors.push('At least one account is required.');
  if (!Array.isArray(scenarios) || scenarios.length === 0) errors.push('At least one joint scenario is required.');

  const accountIds = new Set<string>();
  for (const account of accounts ?? []) {
    if (!account.accountId?.trim() || accountIds.has(account.accountId)) {
      errors.push(`Invalid or duplicate accountId "${account.accountId}".`);
    }
    accountIds.add(account.accountId);
    if (!account.firm?.firmId || !account.accountState) {
      errors.push(`Account "${account.accountId}" requires a firm and account state.`);
    }
    const { min, max, step } = account.ratio;
    if (![min, max, step].every(Number.isFinite) || min < 0 || max < min || step <= 0) {
      errors.push(`Account "${account.accountId}" has invalid ratio bounds or step.`);
    }
    const intervals = (max - min) / step;
    if (Math.abs(intervals - Math.round(intervals)) > 1e-7) {
      errors.push(`Account "${account.accountId}" ratio range must be divisible by step.`);
    }
    if (!Number.isFinite(account.accountState.cumulativeProfitUsd) ||
        (account.accountState.priorDailyPnlUsd ?? []).some((value) => !Number.isFinite(value))) {
      errors.push(`Account "${account.accountId}" has invalid account-state P&L.`);
    }
  }

  const scenarioIds = new Set<string>();
  let probabilityTotal = 0;
  for (const scenario of scenarios ?? []) {
    if (!scenario.scenarioId?.trim() || scenarioIds.has(scenario.scenarioId)) {
      errors.push(`Invalid or duplicate scenarioId "${scenario.scenarioId}".`);
    }
    scenarioIds.add(scenario.scenarioId);
    if (!Number.isFinite(scenario.probability) || scenario.probability < 0) {
      errors.push(`Scenario "${scenario.scenarioId}" has invalid probability.`);
    } else probabilityTotal += scenario.probability;

    for (const accountId of accountIds) {
      if (!(accountId in scenario.outcomes)) {
        errors.push(`Scenario "${scenario.scenarioId}" is missing account "${accountId}".`);
      }
    }
    for (const [accountId, outcome] of Object.entries(scenario.outcomes)) {
      if (!accountIds.has(accountId)) {
        errors.push(`Scenario "${scenario.scenarioId}" contains unknown account "${accountId}".`);
      } else if (!Number.isFinite(outcome.grossPnlUsd)) {
        errors.push(`Scenario "${scenario.scenarioId}" has non-finite P&L for "${accountId}".`);
      }
    }
  }
  if (Math.abs(probabilityTotal - 1) > EPSILON) {
    errors.push(`Joint scenario probabilities must sum to 1 (received ${probabilityTotal}).`);
  }

  for (const [key, value] of Object.entries(constraints)) {
    if (key === 'maxSearchNodes') {
      if (!Number.isInteger(value) || (value as number) < 1) errors.push('maxSearchNodes must be a positive integer.');
    } else if (key === 'maxProbabilityOfCombinedLoss' || key === 'minPayoutOpportunityProbability') {
      if (!inProbabilityRange(value as number)) errors.push(`${key} must be between 0 and 1.`);
    } else if (!Number.isFinite(value) || (value as number) < 0) {
      errors.push(`${key} must be finite and non-negative.`);
    }
  }
  if (errors.length) throw new Error(`Invalid hedge ratio optimization input: ${errors.join(' ')}`);
}

function evaluateCandidate(
  ratios: number[],
  accounts: HedgeRatioAccount[],
  scenarios: HedgeRatioScenario[]
): EvaluatedCandidate {
  const scenarioResults = scenarios.map((scenario) => {
    const accountResults: Record<string, ContractualPayoffResult> = {};
    let combinedGrossPnlUsd = 0;
    let contractualTraderPayoutUsd = 0;

    accounts.forEach((account, index) => {
      const sourceOutcome = scenario.outcomes[account.accountId];
      const scaledOutcome: JointAccountOutcome = {
        ...sourceOutcome,
        grossPnlUsd: sourceOutcome.grossPnlUsd * ratios[index],
      };
      const result = calculateContractualPayoff({
        firm: account.firm,
        accountState: account.accountState,
        scenarioOutcome: scaledOutcome,
      });
      accountResults[account.accountId] = result;
      combinedGrossPnlUsd += result.inputPnlUsd;
      contractualTraderPayoutUsd += result.contractualTraderPayoutUsd;
    });

    return {
      scenarioId: scenario.scenarioId,
      probability: scenario.probability,
      combinedGrossPnlUsd,
      contractualTraderPayoutUsd,
      combinedLoss: combinedGrossPnlUsd < -EPSILON,
      payoutOpportunity: contractualTraderPayoutUsd > EPSILON,
      accountResults,
    };
  });

  let expectedCombinedGrossPnlUsd = 0;
  let expectedContractualTraderPayoutUsd = 0;
  let probabilityOfCombinedLoss = 0;
  let worstCaseCombinedLossUsd = 0;
  let payoutOpportunityProbability = 0;

  scenarioResults.forEach((result) => {
    expectedCombinedGrossPnlUsd += result.combinedGrossPnlUsd * result.probability;
    expectedContractualTraderPayoutUsd += result.contractualTraderPayoutUsd * result.probability;
    if (result.combinedLoss) probabilityOfCombinedLoss += result.probability;
    if (result.payoutOpportunity) payoutOpportunityProbability += result.probability;
    worstCaseCombinedLossUsd = Math.max(worstCaseCombinedLossUsd, -result.combinedGrossPnlUsd);
  });

  const key = ratios.map((ratio) => ratio.toFixed(10)).join('|');
  return {
    ratios,
    metrics: {
      expectedCombinedGrossPnlUsd,
      expectedContractualTraderPayoutUsd,
      probabilityOfCombinedLoss,
      worstCaseCombinedLossUsd,
      payoutOpportunityProbability,
    },
    scenarioResults,
    key,
  };
}

function isFeasible(
  candidate: EvaluatedCandidate,
  constraints: HedgeRatioConstraints,
  tolerance: number
): boolean {
  const m = candidate.metrics;
  if (constraints.maxProbabilityOfCombinedLoss !== undefined &&
      m.probabilityOfCombinedLoss > constraints.maxProbabilityOfCombinedLoss + tolerance) return false;
  if (constraints.maxWorstCaseCombinedLossUsd !== undefined &&
      m.worstCaseCombinedLossUsd > constraints.maxWorstCaseCombinedLossUsd + tolerance) return false;
  if (constraints.minExpectedContractualPayoutUsd !== undefined &&
      m.expectedContractualTraderPayoutUsd + tolerance < constraints.minExpectedContractualPayoutUsd) return false;
  if (constraints.minPayoutOpportunityProbability !== undefined &&
      m.payoutOpportunityProbability + tolerance < constraints.minPayoutOpportunityProbability) return false;
  if (constraints.maxScenarioGrossLossUsd !== undefined &&
      m.worstCaseCombinedLossUsd > constraints.maxScenarioGrossLossUsd + tolerance) return false;
  return true;
}

function isBetter(
  candidate: EvaluatedCandidate,
  incumbent: EvaluatedCandidate | null,
  tolerance: number
): boolean {
  if (!incumbent) return true;
  const left = candidate.metrics;
  const right = incumbent.metrics;
  const objectives: Array<[number, number, 'max' | 'min']> = [
    [left.expectedContractualTraderPayoutUsd, right.expectedContractualTraderPayoutUsd, 'max'],
    [left.expectedCombinedGrossPnlUsd, right.expectedCombinedGrossPnlUsd, 'max'],
    [left.probabilityOfCombinedLoss, right.probabilityOfCombinedLoss, 'min'],
    [left.worstCaseCombinedLossUsd, right.worstCaseCombinedLossUsd, 'min'],
  ];
  for (const [a, b, direction] of objectives) {
    if (direction === 'max' && a > b + tolerance) return true;
    if (direction === 'max' && a < b - tolerance) return false;
    if (direction === 'min' && a < b - tolerance) return true;
    if (direction === 'min' && a > b + tolerance) return false;
  }
  return candidate.key.localeCompare(incumbent.key) < 0;
}

/**
 * Exhaustively evaluates a discrete grid of account-level exposure multipliers.
 * Each ratio scales the signed P&L for that account; it does not change market
 * direction. Encode opposing hedge directions in the source scenario P&L.
 */
export function optimizeContractAwareHedgeRatios(
  accounts: HedgeRatioAccount[],
  scenarios: HedgeRatioScenario[],
  options: HedgeRatioOptimizationOptions = {}
): HedgeRatioOptimizationResult {
  const constraints = options.constraints ?? {};
  const tolerance = options.tolerance ?? EPSILON;
  validate(accounts, scenarios, constraints);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('tolerance must be finite and non-negative.');
  }

  const grids = accounts.map((account) => {
    const count = Math.round((account.ratio.max - account.ratio.min) / account.ratio.step);
    return Array.from({ length: count + 1 }, (_, index) =>
      Number((account.ratio.min + index * account.ratio.step).toFixed(10))
    );
  });
  const maxNodes = constraints.maxSearchNodes ?? 250_000;
  const ratios: number[] = [];
  let searchNodes = 0;
  let feasibleCandidates = 0;
  let best: EvaluatedCandidate | null = null;

  const visit = (index: number): void => {
    if (index === accounts.length) {
      searchNodes += 1;
      if (searchNodes > maxNodes) {
        throw new Error(`Hedge ratio search limit exceeded (${maxNodes}); no optimality claim is available.`);
      }
      const candidate = evaluateCandidate([...ratios], accounts, scenarios);
      if (isFeasible(candidate, constraints, tolerance)) {
        feasibleCandidates += 1;
        if (isBetter(candidate, best, tolerance)) best = candidate;
      }
      return;
    }
    for (const ratio of grids[index]) {
      ratios.push(ratio);
      visit(index + 1);
      ratios.pop();
    }
  };
  visit(0);

  if (!best) {
    return {
      status: 'infeasible',
      allocation: [],
      metrics: null,
      scenarioResults: [],
      searchNodes,
      feasibleCandidates,
      objectivePriority: OBJECTIVE_PRIORITY,
      reason: 'No hedge ratio vector satisfies the configured contractual and portfolio loss constraints.',
    };
  }

  const winner = best as EvaluatedCandidate;
  return {
    status: 'optimal',
    allocation: winner.ratios.map((ratio, index) => ({
      accountId: accounts[index].accountId,
      firmId: accounts[index].firm.firmId,
      firmName: accounts[index].firm.name,
      ratio,
    })),
    metrics: winner.metrics,
    scenarioResults: winner.scenarioResults,
    searchNodes,
    feasibleCandidates,
    objectivePriority: OBJECTIVE_PRIORITY,
    reason: null,
  };
}
