/**
 * Phase 7 — Contractual payoff optimization across prop-firm alternatives.
 *
 * Enumerates one contract alternative per account slot, evaluates every
 * alternative against the same complete joint scenario matrix using the
 * Phase 2 contractual payoff engine, and selects the best feasible allocation.
 *
 * Contractual payout is potential/eligible payout, not realized cash.
 */

import type { PropFirmPreset } from '../types/quant.ts';
import {
  calculateContractualPayoff,
  type ContractualAccountState,
  type ContractualPayoffResult,
} from './contractualPayoffEngine.ts';
import type { JointAccountOutcome } from './jointScenarioEngine.ts';

export interface ContractAlternative {
  alternativeId: string;
  firm: PropFirmPreset;
  accountState: ContractualAccountState;
}

export interface ContractAccountSlot {
  accountId: string;
  /** Available firm/plan/account-contract alternatives for this slot. */
  alternatives: ContractAlternative[];
}

export interface ContractOptimizationScenario {
  scenarioId: string;
  /** Probability of this complete joint multi-account outcome. */
  probability: number;
  outcomes: Record<string, JointAccountOutcome>;
}

export interface ContractOptimizationConstraints {
  /** Minimum probability that at least one account has a positive contractual payout. */
  minimumPayoutOpportunityProbability?: number;
  /** Maximum probability that no account has a positive contractual payout. */
  maximumZeroPayoutProbability?: number;
  /** Minimum probability that every selected contract is complete for simulation. */
  minimumContractCompletenessProbability?: number;
  /** Minimum number of distinct firms across the selected contract alternatives. */
  minimumDistinctFirms?: number;
  /** Maximum selected account slots assigned to the same firm. */
  maximumAccountsPerFirm?: number;
  /** Defaults to true; any alternative incomplete in a scenario cannot be selected. */
  requireCompleteContracts?: boolean;
  /** Hard exhaustive-search limit. Exceeding it throws and returns no optimality claim. */
  maxSearchNodes?: number;
}

export interface ContractOptimizationOptions {
  constraints?: ContractOptimizationConstraints;
  /** Absolute comparison tolerance for objective tie-breaking. Defaults to 1e-9. */
  tolerance?: number;
}

export interface ContractAlternativeDiagnostic {
  accountId: string;
  alternativeId: string;
  firmId: string;
  firmName: string;
  phase: ContractualAccountState['phase'];
  expectedContractualTraderPayoutUsd: number;
  payoutOpportunityProbability: number;
  evaluationPassProbability: number;
  contractCompletenessProbability: number;
  incompleteScenarioIds: string[];
  contractWarnings: string[];
}

export interface ContractOptimizationAllocationLine {
  accountId: string;
  alternativeId: string;
  firmId: string;
  firmName: string;
  phase: ContractualAccountState['phase'];
}

export interface ContractOptimizationScenarioResult {
  scenarioId: string;
  probability: number;
  grossPnlUsd: number;
  contractualTraderPayoutUsd: number;
  payoutOpportunity: boolean;
  allContractsComplete: boolean;
  evaluationPassCount: number;
  accountResults: Record<string, ContractualPayoffResult>;
}

export interface ContractualPayoffOptimizationResult {
  status: 'optimal' | 'infeasible';
  allocation: ContractOptimizationAllocationLine[];
  searchNodes: number;
  expectedGrossPnlUsd: number | null;
  expectedContractualTraderPayoutUsd: number | null;
  payoutOpportunityProbability: number | null;
  zeroPayoutProbability: number | null;
  evaluationPassProbabilityByAccount: Record<string, number> | null;
  expectedEvaluationPassCount: number | null;
  contractCompletenessProbability: number | null;
  distinctFirmCount: number | null;
  scenarioResults: ContractOptimizationScenarioResult[];
  contractWarnings: string[];
  reason: string | null;
  alternativeDiagnostics: ContractAlternativeDiagnostic[];
  objectivePriority: string[];
}

interface EvaluatedAlternative {
  accountId: string;
  alternative: ContractAlternative;
  scenarioResults: ContractualPayoffResult[];
  diagnostic: ContractAlternativeDiagnostic;
}

interface EvaluatedAssignment {
  selected: EvaluatedAlternative[];
  scenarioResults: ContractOptimizationScenarioResult[];
  expectedGrossPnlUsd: number;
  expectedContractualTraderPayoutUsd: number;
  payoutOpportunityProbability: number;
  zeroPayoutProbability: number;
  evaluationPassProbabilityByAccount: Record<string, number>;
  expectedEvaluationPassCount: number;
  contractCompletenessProbability: number;
  distinctFirmCount: number;
  contractWarnings: string[];
  key: string;
}

const EPSILON = 1e-9;
const ACCOUNT_STATUSES = ['active', 'breached', 'restricted', 'terminated'] as const;
const PAYOUT_STATUSES = ['not_eligible', 'eligible', 'pending', 'approved', 'rejected', 'blocked'] as const;
const OUTCOME_TYPES = ['win', 'loss', 'partial_win', 'partial_loss', 'flat'] as const;
const OBJECTIVE_PRIORITY = [
  '1. Maximize expected contractual trader payout (potential payout, not received cash).',
  '2. Maximize probability of at least one positive contractual payout.',
  '3. Maximize expected evaluation passes.',
  '4. Maximize contract completeness probability.',
  '5. Deterministic lexical tie-break on selected alternative identifiers.',
];

function probabilityInRange(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateInputs(
  slots: ContractAccountSlot[],
  scenarios: ContractOptimizationScenario[],
  constraints: ContractOptimizationConstraints
): void {
  const errors: string[] = [];
  if (!Array.isArray(slots) || slots.length === 0) {
    errors.push('At least one account slot is required.');
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    errors.push('At least one complete joint scenario is required.');
  }

  const accountIds = new Set<string>();
  for (const slot of slots ?? []) {
    if (!slot.accountId?.trim()) errors.push('Every account slot requires accountId.');
    if (accountIds.has(slot.accountId)) errors.push(`Duplicate accountId "${slot.accountId}".`);
    accountIds.add(slot.accountId);
    if (!Array.isArray(slot.alternatives) || slot.alternatives.length === 0) {
      errors.push(`Account "${slot.accountId}" requires at least one contract alternative.`);
      continue;
    }
    const alternativeIds = new Set<string>();
    for (const alternative of slot.alternatives) {
      if (!alternative.alternativeId?.trim()) {
        errors.push(`Account "${slot.accountId}" has an alternative without alternativeId.`);
      }
      if (alternativeIds.has(alternative.alternativeId)) {
        errors.push(`Account "${slot.accountId}" has duplicate alternativeId "${alternative.alternativeId}".`);
      }
      alternativeIds.add(alternative.alternativeId);
      if (!alternative.firm?.firmId || !alternative.firm.name) {
        errors.push(`Alternative "${alternative.alternativeId}" requires a valid firm contract.`);
      }
      const state = alternative.accountState;
      if (!state || !['evaluation_phase_1', 'evaluation_phase_2', 'funded'].includes(state.phase)) {
        errors.push(`Alternative "${alternative.alternativeId}" has an invalid account phase.`);
        continue;
      }
      if (!Number.isFinite(state.cumulativeProfitUsd)) {
        errors.push(`Alternative "${alternative.alternativeId}" cumulativeProfitUsd must be finite.`);
      }
      if (state.priorTradingDays !== undefined &&
          (!Number.isInteger(state.priorTradingDays) || state.priorTradingDays < 0)) {
        errors.push(`Alternative "${alternative.alternativeId}" priorTradingDays must be a non-negative integer.`);
      }
      if (state.targetOverrideUsd !== undefined &&
          (!Number.isFinite(state.targetOverrideUsd) || state.targetOverrideUsd < 0)) {
        errors.push(`Alternative "${alternative.alternativeId}" targetOverrideUsd must be non-negative and finite.`);
      }
      if ((state.priorDailyPnlUsd ?? []).some((value) => !Number.isFinite(value))) {
        errors.push(`Alternative "${alternative.alternativeId}" priorDailyPnlUsd contains a non-finite value.`);
      }
    }
  }

  const scenarioIds = new Set<string>();
  let probabilityTotal = 0;
  for (const scenario of scenarios ?? []) {
    if (!scenario.scenarioId?.trim()) errors.push('Every scenario requires scenarioId.');
    if (scenarioIds.has(scenario.scenarioId)) {
      errors.push(`Duplicate scenarioId "${scenario.scenarioId}".`);
    }
    scenarioIds.add(scenario.scenarioId);
    if (!Number.isFinite(scenario.probability) || scenario.probability < 0) {
      errors.push(`Scenario "${scenario.scenarioId}" has an invalid probability.`);
    } else {
      probabilityTotal += scenario.probability;
    }
    if (!scenario.outcomes || typeof scenario.outcomes !== 'object' || Array.isArray(scenario.outcomes)) {
      errors.push(`Scenario "${scenario.scenarioId}" has invalid outcomes.`);
      continue;
    }
    for (const accountId of accountIds) {
      if (!(accountId in scenario.outcomes)) {
        errors.push(`Scenario "${scenario.scenarioId}" is missing account "${accountId}".`);
      }
    }
    for (const [accountId, outcome] of Object.entries(scenario.outcomes)) {
      if (!accountIds.has(accountId)) {
        errors.push(`Scenario "${scenario.scenarioId}" contains unconfigured account "${accountId}".`);
        continue;
      }
      if (!Number.isFinite(outcome.grossPnlUsd) ||
          !OUTCOME_TYPES.includes(outcome.outcomeType) ||
          !ACCOUNT_STATUSES.includes(outcome.accountStatus) ||
          !PAYOUT_STATUSES.includes(outcome.payoutStatus)) {
        errors.push(`Scenario "${scenario.scenarioId}" has an invalid outcome for account "${accountId}".`);
      }
    }
  }
  if (Math.abs(probabilityTotal - 1) > EPSILON) {
    errors.push(`Joint scenario probabilities must sum to 1 (received ${probabilityTotal}).`);
  }

  const minOpportunity = constraints.minimumPayoutOpportunityProbability;
  if (minOpportunity !== undefined && !probabilityInRange(minOpportunity)) {
    errors.push('minimumPayoutOpportunityProbability must be between 0 and 1.');
  }
  const maxZero = constraints.maximumZeroPayoutProbability;
  if (maxZero !== undefined && !probabilityInRange(maxZero)) {
    errors.push('maximumZeroPayoutProbability must be between 0 and 1.');
  }
  const minCompleteness = constraints.minimumContractCompletenessProbability;
  if (minCompleteness !== undefined && !probabilityInRange(minCompleteness)) {
    errors.push('minimumContractCompletenessProbability must be between 0 and 1.');
  }
  const minFirms = constraints.minimumDistinctFirms ?? 1;
  if (!Number.isInteger(minFirms) || minFirms < 1) {
    errors.push('minimumDistinctFirms must be a positive integer.');
  }
  if (constraints.maximumAccountsPerFirm !== undefined &&
      (!Number.isInteger(constraints.maximumAccountsPerFirm) || constraints.maximumAccountsPerFirm < 1)) {
    errors.push('maximumAccountsPerFirm must be a positive integer.');
  }
  const maxNodes = constraints.maxSearchNodes ?? 100_000;
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    errors.push('maxSearchNodes must be a positive integer.');
  }
  if (errors.length) throw new Error(`Invalid contractual optimization input: ${errors.join(' ')}`);
}

function evaluateAlternatives(
  slots: ContractAccountSlot[],
  scenarios: ContractOptimizationScenario[]
): EvaluatedAlternative[] {
  const evaluated: EvaluatedAlternative[] = [];
  for (const slot of slots) {
    for (const alternative of slot.alternatives) {
      const scenarioResults = scenarios.map((scenario) =>
        calculateContractualPayoff({
          firm: alternative.firm,
          accountState: alternative.accountState,
          scenarioOutcome: scenario.outcomes[slot.accountId],
        })
      );
      let expectedPayout = 0;
      let payoutOpportunityProbability = 0;
      let evaluationPassProbability = 0;
      let contractCompletenessProbability = 0;
      const incompleteScenarioIds: string[] = [];
      const warnings = new Set<string>();

      scenarioResults.forEach((result, index) => {
        const probability = scenarios[index].probability;
        expectedPayout += result.contractualTraderPayoutUsd * probability;
        if (result.contractualTraderPayoutUsd > EPSILON) payoutOpportunityProbability += probability;
        if (result.phasePassed) evaluationPassProbability += probability;
        if (result.contractCompleteForSimulation) contractCompletenessProbability += probability;
        else incompleteScenarioIds.push(scenarios[index].scenarioId);
        result.contractWarnings.forEach((warning) => warnings.add(warning));
      });

      evaluated.push({
        accountId: slot.accountId,
        alternative,
        scenarioResults,
        diagnostic: {
          accountId: slot.accountId,
          alternativeId: alternative.alternativeId,
          firmId: alternative.firm.firmId,
          firmName: alternative.firm.name,
          phase: alternative.accountState.phase,
          expectedContractualTraderPayoutUsd: expectedPayout,
          payoutOpportunityProbability: payoutOpportunityProbability,
          evaluationPassProbability,
          contractCompletenessProbability,
          incompleteScenarioIds,
          contractWarnings: [...warnings].sort(),
        },
      });
    }
  }
  return evaluated;
}

function buildAssignment(
  selected: EvaluatedAlternative[],
  slots: ContractAccountSlot[],
  scenarios: ContractOptimizationScenario[]
): EvaluatedAssignment {
  const snapshot = [...selected];
  const byAccount = new Map(snapshot.map((item) => [item.accountId, item]));
  const scenarioResults: ContractOptimizationScenarioResult[] = scenarios.map((scenario, scenarioIndex) => {
    const accountResults: Record<string, ContractualPayoffResult> = {};
    let grossPnlUsd = 0;
    let contractualTraderPayoutUsd = 0;
    let allContractsComplete = true;
    let evaluationPassCount = 0;
    for (const slot of slots) {
      const selectedAlternative = byAccount.get(slot.accountId)!;
      const result = selectedAlternative.scenarioResults[scenarioIndex];
      accountResults[slot.accountId] = result;
      grossPnlUsd += result.inputPnlUsd;
      contractualTraderPayoutUsd += result.contractualTraderPayoutUsd;
      allContractsComplete = allContractsComplete && result.contractCompleteForSimulation;
      if (result.phasePassed) evaluationPassCount += 1;
    }
    return {
      scenarioId: scenario.scenarioId,
      probability: scenario.probability,
      grossPnlUsd,
      contractualTraderPayoutUsd,
      payoutOpportunity: contractualTraderPayoutUsd > EPSILON,
      allContractsComplete,
      evaluationPassCount,
      accountResults,
    };
  });

  let expectedGrossPnlUsd = 0;
  let expectedContractualTraderPayoutUsd = 0;
  let payoutOpportunityProbability = 0;
  let contractCompletenessProbability = 0;
  let expectedEvaluationPassCount = 0;
  const evaluationPassProbabilityByAccount: Record<string, number> = {};
  const warnings = new Set<string>();

  for (const slot of slots) evaluationPassProbabilityByAccount[slot.accountId] = 0;
  scenarioResults.forEach((result) => {
    const probability = result.probability;
    expectedGrossPnlUsd += result.grossPnlUsd * probability;
    expectedContractualTraderPayoutUsd += result.contractualTraderPayoutUsd * probability;
    if (result.payoutOpportunity) payoutOpportunityProbability += probability;
    if (result.allContractsComplete) contractCompletenessProbability += probability;
    expectedEvaluationPassCount += result.evaluationPassCount * probability;
    for (const [accountId, accountResult] of Object.entries(result.accountResults)) {
      if (accountResult.phasePassed) evaluationPassProbabilityByAccount[accountId] += probability;
      accountResult.contractWarnings.forEach((warning) => warnings.add(warning));
    }
  });

  const distinctFirmCount = new Set(snapshot.map((item) => item.alternative.firm.firmId)).size;
  const allocationKey = snapshot
    .map((item) => `${item.accountId}:${item.alternative.alternativeId}`)
    .sort()
    .join('|');

  return {
    selected: snapshot,
    scenarioResults,
    expectedGrossPnlUsd,
    expectedContractualTraderPayoutUsd,
    payoutOpportunityProbability,
    zeroPayoutProbability: 1 - payoutOpportunityProbability,
    evaluationPassProbabilityByAccount,
    expectedEvaluationPassCount,
    contractCompletenessProbability,
    distinctFirmCount,
    contractWarnings: [...warnings].sort(),
    key: allocationKey,
  };
}

function assignmentIsFeasible(
  assignment: EvaluatedAssignment,
  constraints: ContractOptimizationConstraints
): boolean {
  if (assignment.distinctFirmCount < (constraints.minimumDistinctFirms ?? 1)) return false;
  if (constraints.maximumAccountsPerFirm !== undefined) {
    const counts = new Map<string, number>();
    for (const item of assignment.selected) {
      const firmId = item.alternative.firm.firmId;
      counts.set(firmId, (counts.get(firmId) ?? 0) + 1);
    }
    if ([...counts.values()].some((count) => count > constraints.maximumAccountsPerFirm!)) return false;
  }
  if (constraints.minimumPayoutOpportunityProbability !== undefined &&
      assignment.payoutOpportunityProbability + EPSILON < constraints.minimumPayoutOpportunityProbability) return false;
  if (constraints.maximumZeroPayoutProbability !== undefined &&
      assignment.zeroPayoutProbability > constraints.maximumZeroPayoutProbability + EPSILON) return false;
  if (constraints.minimumContractCompletenessProbability !== undefined &&
      assignment.contractCompletenessProbability + EPSILON < constraints.minimumContractCompletenessProbability) return false;
  if (constraints.requireCompleteContracts !== false &&
      assignment.contractCompletenessProbability < 1 - EPSILON) return false;
  return true;
}

function isBetter(
  candidate: EvaluatedAssignment,
  incumbent: EvaluatedAssignment | null,
  tolerance: number
): boolean {
  if (!incumbent) return true;
  const comparisons: Array<[number, number]> = [
    [candidate.expectedContractualTraderPayoutUsd, incumbent.expectedContractualTraderPayoutUsd],
    [candidate.payoutOpportunityProbability, incumbent.payoutOpportunityProbability],
    [candidate.expectedEvaluationPassCount, incumbent.expectedEvaluationPassCount],
    [candidate.contractCompletenessProbability, incumbent.contractCompletenessProbability],
  ];
  for (const [left, right] of comparisons) {
    if (left > right + tolerance) return true;
    if (left < right - tolerance) return false;
  }
  return candidate.key.localeCompare(incumbent.key) < 0;
}

/**
 * Enumerates one contractual alternative per account slot.
 *
 * The primary objective is expected contractual trader payout. Ties are
 * resolved lexicographically by payout opportunity, evaluation progression,
 * completeness, and finally a stable identifier key. No fees, realized cash,
 * or broker hedge P&L are inferred.
 */
export function optimizeContractualPayoffAllocation(
  slots: ContractAccountSlot[],
  scenarios: ContractOptimizationScenario[],
  options: ContractOptimizationOptions = {}
): ContractualPayoffOptimizationResult {
  const constraints = options.constraints ?? {};
  const tolerance = options.tolerance ?? EPSILON;
  validateInputs(slots, scenarios, constraints);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('tolerance must be finite and non-negative.');
  }

  const evaluatedAlternatives = evaluateAlternatives(slots, scenarios);
  const alternativeDiagnostics = evaluatedAlternatives.map((item) => item.diagnostic);
  const optionsByAccount = slots.map((slot) =>
    evaluatedAlternatives.filter((item) => item.accountId === slot.accountId)
  );
  const maxNodes = constraints.maxSearchNodes ?? 100_000;
  const selected: EvaluatedAlternative[] = [];
  let searchNodes = 0;
  let best: EvaluatedAssignment | null = null;

  const visit = (slotIndex: number): void => {
    if (slotIndex === slots.length) {
      searchNodes += 1;
      if (searchNodes > maxNodes) {
        throw new Error(
          `Contract optimization search limit exceeded (${maxNodes} complete allocations); no optimality claim is available.`
        );
      }
      const assignment = buildAssignment([...selected], slots, scenarios);
      if (assignmentIsFeasible(assignment, constraints) &&
          isBetter(assignment, best, tolerance)) {
        best = assignment;
      }
      return;
    }

    for (const alternative of optionsByAccount[slotIndex]) {
      if (constraints.requireCompleteContracts !== false &&
          alternative.diagnostic.contractCompletenessProbability < 1 - EPSILON) {
        continue;
      }
      selected.push(alternative);
      visit(slotIndex + 1);
      selected.pop();
    }
  };

  visit(0);

  if (!best) {
    return {
      status: 'infeasible',
      allocation: [],
      searchNodes,
      expectedGrossPnlUsd: null,
      expectedContractualTraderPayoutUsd: null,
      payoutOpportunityProbability: null,
      zeroPayoutProbability: null,
      evaluationPassProbabilityByAccount: null,
      expectedEvaluationPassCount: null,
      contractCompletenessProbability: null,
      distinctFirmCount: null,
      scenarioResults: [],
      contractWarnings: [],
      reason: 'No complete contract assignment satisfies the configured contractual, diversification, and payout-opportunity constraints.',
      alternativeDiagnostics,
      objectivePriority: OBJECTIVE_PRIORITY,
    };
  }

  const winner = best as EvaluatedAssignment;
  return {
    status: 'optimal',
    allocation: winner.selected.map((item) => ({
      accountId: item.accountId,
      alternativeId: item.alternative.alternativeId,
      firmId: item.alternative.firm.firmId,
      firmName: item.alternative.firm.name,
      phase: item.alternative.accountState.phase,
    })),
    searchNodes,
    expectedGrossPnlUsd: winner.expectedGrossPnlUsd,
    expectedContractualTraderPayoutUsd: winner.expectedContractualTraderPayoutUsd,
    payoutOpportunityProbability: winner.payoutOpportunityProbability,
    zeroPayoutProbability: winner.zeroPayoutProbability,
    evaluationPassProbabilityByAccount: winner.evaluationPassProbabilityByAccount,
    expectedEvaluationPassCount: winner.expectedEvaluationPassCount,
    contractCompletenessProbability: winner.contractCompletenessProbability,
    distinctFirmCount: winner.distinctFirmCount,
    scenarioResults: winner.scenarioResults,
    contractWarnings: winner.contractWarnings,
    reason: null,
    alternativeDiagnostics,
    objectivePriority: OBJECTIVE_PRIORITY,
  };
}
