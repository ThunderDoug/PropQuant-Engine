/**
 * Phase 2 — Nonlinear contractual payoff functions.
 *
 * Converts Phase 1 gross account outcomes into firm-specific contractual
 * results. This module never treats an approved/eligible payout as received
 * cash; realized cash belongs to the later cash-ledger phase.
 */

import type { PropFirmPreset } from '../types/quant.ts';
import {
  evaluatePayoutEligibility,
  roundCurrency,
  validateFirmContract,
} from './quantEngine.ts';
import type {
  JointAccountOutcome,
  JointScenarioDefinition,
} from './jointScenarioEngine.ts';

export type ContractualPayoffPhase =
  | 'evaluation_phase_1'
  | 'evaluation_phase_2'
  | 'funded';

export interface ContractualAccountState {
  phase: ContractualPayoffPhase;
  /** Accumulated account P&L before the current joint scenario. */
  cumulativeProfitUsd: number;
  /** Prior trading-day P&L values for qualifying-day and consistency rules. */
  priorDailyPnlUsd?: number[];
  /** Number of elapsed trading days in the current evaluation phase. */
  priorTradingDays?: number;
  /** Optional override for the phase target when modeling a custom plan. */
  targetOverrideUsd?: number;
}

export interface ContractualPayoffInput {
  firm: PropFirmPreset;
  accountState: ContractualAccountState;
  scenarioOutcome: JointAccountOutcome;
}

export interface ContractualPayoffResult {
  firmId: string;
  firmName: string;
  phase: ContractualPayoffPhase;
  accountStatus: JointAccountOutcome['accountStatus'];
  inputPnlUsd: number;
  cumulativeProfitAfterScenarioUsd: number;
  phasePassed: boolean;
  phaseTargetUsd: number | null;
  targetRemainingUsd: number | null;
  consistencyRatioPct: number | null;
  consistencyLimitPct: number | null;
  consistencyPassed: boolean | null;
  payoutContractuallyEligible: boolean;
  payoutPermittedByScenarioStatus: boolean;
  payoutStatus: JointAccountOutcome['payoutStatus'];
  grossWithdrawableUsd: number;
  contractualTraderPayoutUsd: number;
  payoutBlockedReasons: string[];
  retainedAccountProfitUsd: number;
  postPayoutDrawdownRemainingUsd: number | null;
  contractCompleteForSimulation: boolean;
  contractWarnings: string[];
}

export interface JointScenarioDefinition {
  scenarioId: string;
  outcomes: Record<string, JointAccountOutcome>;
}

export interface JointAccountContractConfig {
  accountId: string;
  firmId: string;
  state: ContractualAccountState;
}

export interface JointContractualPayoffSummary {
  scenarioId: string;
  accountResults: Record<string, ContractualPayoffResult>;
  totalGrossPnlUsd: number;
  totalPotentialTraderPayoutUsd: number;
  accountsPassedEvaluation: number;
  accountsContractuallyPayoutEligible: number;
  accountsWithZeroContractualPayout: number;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function evaluateConsistencyLocally(
  positiveDays: number[],
  netProfitUsd: number,
  targetUsd: number,
  rule: PropFirmPreset['fundedRules']['consistency']
): { passed: boolean; ratioPct: number | null; limitPct: number | null } {
  if (rule.methodology === 'none') {
    return { passed: true, ratioPct: null, limitPct: null };
  }

  const limit = rule.pct.value;
  if (
    rule.methodology === 'unknown' ||
    rule.pct.status === 'missing' ||
    limit === null ||
    !Number.isFinite(limit)
  ) {
    return { passed: false, ratioPct: null, limitPct: limit };
  }

  const positives = positiveDays.filter((value) => Number.isFinite(value) && value > 0);
  const bestDay = positives.length ? Math.max(...positives) : 0;
  let denominator = 0;

  switch (rule.methodology) {
    case 'best_day_over_gross_positive':
      denominator = positives.reduce((sum, value) => sum + value, 0);
      break;
    case 'best_day_over_net_profit':
      denominator = netProfitUsd;
      break;
    case 'best_day_over_target':
      denominator = targetUsd > 0 ? targetUsd : Math.max(netProfitUsd, 1);
      break;
    default:
      return { passed: false, ratioPct: null, limitPct: limit };
  }

  if (denominator <= 0 || positives.length === 0) {
    return { passed: false, ratioPct: null, limitPct: limit };
  }

  const ratio = roundCurrency((bestDay / denominator) * 100);
  return {
    passed: ratio <= limit + 1e-6,
    ratioPct: ratio,
    limitPct: limit,
  };
}

function blockedResult(
  input: ContractualPayoffInput,
  reasons: string[],
  warnings: string[],
  complete: boolean
): ContractualPayoffResult {
  const { firm, accountState, scenarioOutcome } = input;
  const cumulative = roundCurrency(
    accountState.cumulativeProfitUsd + scenarioOutcome.grossPnlUsd
  );
  return {
    firmId: firm.firmId,
    firmName: firm.name,
    phase: accountState.phase,
    accountStatus: scenarioOutcome.accountStatus,
    inputPnlUsd: roundCurrency(scenarioOutcome.grossPnlUsd),
    cumulativeProfitAfterScenarioUsd: cumulative,
    phasePassed: false,
    phaseTargetUsd: null,
    targetRemainingUsd: null,
    consistencyRatioPct: null,
    consistencyLimitPct: null,
    consistencyPassed: null,
    payoutContractuallyEligible: false,
    payoutPermittedByScenarioStatus: false,
    payoutStatus: scenarioOutcome.payoutStatus,
    grossWithdrawableUsd: 0,
    contractualTraderPayoutUsd: 0,
    payoutBlockedReasons: reasons,
    retainedAccountProfitUsd: Math.max(0, cumulative),
    postPayoutDrawdownRemainingUsd: null,
    contractCompleteForSimulation: complete,
    contractWarnings: warnings,
  };
}

/**
 * Evaluates one account's contractual result for one joint scenario.
 * The function is pure: it does not mutate the firm, account state, or scenario.
 */
export function calculateContractualPayoff(
  input: ContractualPayoffInput
): ContractualPayoffResult {
  const { firm, accountState, scenarioOutcome } = input;
  const validation = validateFirmContract(firm);
  const warnings = [
    ...validation.unverifiedWarnings,
    ...validation.userAssumedFields.map((field) => `${field} is user-assumed.`),
  ];

  if (
    !Number.isFinite(scenarioOutcome.grossPnlUsd) ||
    !Number.isFinite(accountState.cumulativeProfitUsd) ||
    !finiteNonNegative(accountState.priorTradingDays ?? 0) ||
    (accountState.priorDailyPnlUsd ?? []).some((value) => !Number.isFinite(value))
  ) {
    return blockedResult(
      input,
      ['Invalid or non-finite account/scenario input.'],
      warnings,
      false
    );
  }

  if (scenarioOutcome.accountStatus !== 'active') {
    return blockedResult(
      input,
      [`Account status "${scenarioOutcome.accountStatus}" prevents contractual payout.`],
      warnings,
      validation.isCompleteForSimulation
    );
  }

  const cumulativeProfit = roundCurrency(
    accountState.cumulativeProfitUsd + scenarioOutcome.grossPnlUsd
  );

  if (accountState.phase === 'evaluation_phase_1' || accountState.phase === 'evaluation_phase_2') {
    const rules = firm.evaluationRules;
    const targetValue =
      accountState.targetOverrideUsd ??
      (accountState.phase === 'evaluation_phase_1'
        ? rules.phase1TargetUsd.value
        : rules.phase2TargetUsd.value);
    const targetField =
      accountState.phase === 'evaluation_phase_1'
        ? rules.phase1TargetUsd
        : rules.phase2TargetUsd;
    const minDaysField = rules.minTradingDays;
    const minDays = minDaysField.value;

    const dailyPnl = [
      ...(accountState.priorDailyPnlUsd ?? []),
      scenarioOutcome.grossPnlUsd,
    ];
    const positiveDays = dailyPnl.filter((value) => value > 0);
    const consistency = evaluateConsistencyLocally(
      positiveDays,
      cumulativeProfit,
      targetValue ?? 0,
      rules.consistency
    );
    const elapsedDays = (accountState.priorTradingDays ?? 0) + 1;
    const blockers: string[] = [];

    if (targetField.status === 'missing' || targetValue === null || targetValue === undefined) {
      blockers.push('Evaluation target is missing; phase progression cannot be certified.');
    }
    if (minDaysField.status === 'missing' || minDays === null) {
      blockers.push('Minimum trading days are missing; phase progression cannot be certified.');
    }
    if (targetValue !== null && targetValue !== undefined && cumulativeProfit < targetValue) {
      blockers.push('Evaluation profit target has not been reached.');
    }
    if (minDays !== null && elapsedDays < minDays) {
      blockers.push(`Minimum trading days not met: ${elapsedDays}/${minDays}.`);
    }
    if (!consistency.passed) {
      blockers.push('Evaluation consistency requirement has not been satisfied.');
    }

    const phasePassed = blockers.length === 0;
    return {
      firmId: firm.firmId,
      firmName: firm.name,
      phase: accountState.phase,
      accountStatus: scenarioOutcome.accountStatus,
      inputPnlUsd: roundCurrency(scenarioOutcome.grossPnlUsd),
      cumulativeProfitAfterScenarioUsd: cumulativeProfit,
      phasePassed,
      phaseTargetUsd: targetValue ?? null,
      targetRemainingUsd:
        targetValue === null || targetValue === undefined
          ? null
          : roundCurrency(Math.max(0, targetValue - cumulativeProfit)),
      consistencyRatioPct: consistency.ratioPct,
      consistencyLimitPct: consistency.limitPct,
      consistencyPassed: consistency.passed,
      payoutContractuallyEligible: false,
      payoutPermittedByScenarioStatus: false,
      payoutStatus: scenarioOutcome.payoutStatus,
      grossWithdrawableUsd: 0,
      contractualTraderPayoutUsd: 0,
      payoutBlockedReasons: blockers,
      retainedAccountProfitUsd: Math.max(0, cumulativeProfit),
      postPayoutDrawdownRemainingUsd: null,
      contractCompleteForSimulation: validation.isCompleteForSimulation,
      contractWarnings: warnings,
    };
  }

  const fundedSteps = [
    ...(accountState.priorDailyPnlUsd ?? []).map((netMesaPnlUsd) => ({ netMesaPnlUsd })),
    { netMesaPnlUsd: scenarioOutcome.grossPnlUsd },
  ];
  const payout = evaluatePayoutEligibility(
    roundCurrency(firm.accountSize + cumulativeProfit),
    fundedSteps,
    firm
  );

  const scenarioAllowsPayout =
    scenarioOutcome.payoutStatus === 'eligible' ||
    scenarioOutcome.payoutStatus === 'pending' ||
    scenarioOutcome.payoutStatus === 'approved';

  const blockers = [...payout.blockedReasons];
  if (!scenarioAllowsPayout) {
    blockers.push(`Scenario payout status "${scenarioOutcome.payoutStatus}" does not permit a payout.`);
  }

  const payable = payout.isContractuallyEligible && scenarioAllowsPayout;
  return {
    firmId: firm.firmId,
    firmName: firm.name,
    phase: 'funded',
    accountStatus: scenarioOutcome.accountStatus,
    inputPnlUsd: roundCurrency(scenarioOutcome.grossPnlUsd),
    cumulativeProfitAfterScenarioUsd: cumulativeProfit,
    phasePassed: false,
    phaseTargetUsd: null,
    targetRemainingUsd: null,
    consistencyRatioPct: payout.consistencyRatioPct,
    consistencyLimitPct: payout.consistencyLimitPct,
    consistencyPassed: payout.consistencyPassed,
    payoutContractuallyEligible: payout.isContractuallyEligible,
    payoutPermittedByScenarioStatus: scenarioAllowsPayout,
    payoutStatus: scenarioOutcome.payoutStatus,
    grossWithdrawableUsd: payout.grossEligibleWithdrawalUsd,
    contractualTraderPayoutUsd: payable ? payout.netTraderPayoutUsd : 0,
    payoutBlockedReasons: blockers,
    retainedAccountProfitUsd: roundCurrency(
      Math.max(0, cumulativeProfit - (payable ? payout.grossEligibleWithdrawalUsd : 0))
    ),
    postPayoutDrawdownRemainingUsd: payable
      ? payout.postPayoutDrawdownRemainingUsd
      : null,
    contractCompleteForSimulation: validation.isCompleteForSimulation,
    contractWarnings: warnings,
  };
}

/** Applies the firm-specific payoff function to every account in a Phase 1 scenario. */
export function evaluateJointScenarioContractualPayoffs(
  scenario: JointScenarioDefinition,
  accounts: JointAccountContractConfig[],
  firmsById: Record<string, PropFirmPreset>
): JointContractualPayoffSummary {
  const accountResults: Record<string, ContractualPayoffResult> = {};
  const configuredIds = new Set<string>();

  for (const account of accounts) {
    if (!account.accountId.trim() || configuredIds.has(account.accountId)) {
      throw new Error(`Invalid or duplicate accountId "${account.accountId}".`);
    }
    configuredIds.add(account.accountId);

    const firm = firmsById[account.firmId];
    const outcome = scenario.outcomes[account.accountId];
    if (!firm) throw new Error(`Missing firm contract "${account.firmId}".`);
    if (!outcome) throw new Error(`Scenario "${scenario.scenarioId}" is missing account "${account.accountId}".`);

    accountResults[account.accountId] = calculateContractualPayoff({
      firm,
      accountState: account.state,
      scenarioOutcome: outcome,
    });
  }

  for (const accountId of Object.keys(scenario.outcomes)) {
    if (!configuredIds.has(accountId)) {
      throw new Error(`Scenario contains unconfigured account "${accountId}".`);
    }
  }

  const results = Object.values(accountResults);
  return {
    scenarioId: scenario.scenarioId,
    accountResults,
    totalGrossPnlUsd: roundCurrency(
      results.reduce((sum, result) => sum + result.inputPnlUsd, 0)
    ),
    totalPotentialTraderPayoutUsd: roundCurrency(
      results.reduce((sum, result) => sum + result.contractualTraderPayoutUsd, 0)
    ),
    accountsPassedEvaluation: results.filter((result) => result.phasePassed).length,
    accountsContractuallyPayoutEligible: results.filter(
      (result) => result.payoutContractuallyEligible && result.payoutPermittedByScenarioStatus
    ).length,
    accountsWithZeroContractualPayout: results.filter(
      (result) => result.contractualTraderPayoutUsd === 0
    ).length,
  };
}
