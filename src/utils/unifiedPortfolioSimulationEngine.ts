/**
 * Phase 9 — Unified multi-firm portfolio simulation.
 *
 * Integrates joint scenario sampling, account-level exposure multipliers,
 * contractual payoff evaluation, account/portfolio survival and an explicit
 * cash ledger. Cash receipts are supplied separately and are never inferred
 * from contractual payout eligibility.
 */

import type { PropFirmPreset } from '../types/quant.ts';
import {
  calculateContractualPayoff,
  type ContractualAccountState,
  type ContractualPayoffResult,
} from './contractualPayoffEngine.ts';
import {
  createJointScenarioPrng,
  validateJointScenarioMatrix,
  type JointAccountDefinition,
  type JointAccountStatus,
  type JointScenarioTemplate,
} from './jointScenarioEngine.ts';

export interface UnifiedPortfolioAccount extends JointAccountDefinition {
  firm: PropFirmPreset;
  accountState: ContractualAccountState;
  /** Non-negative exposure multiplier. Signed direction is encoded in scenario P&L. */
  hedgeRatio: number;
  /** Positive cumulative account loss threshold. */
  maxLossUsd: number;
  /** Explicit upfront cash commitment (fees, activation, or other user-defined costs). */
  upfrontCashCommitmentUsd?: number;
  /** P&L accumulated before the simulation horizon. */
  initialCumulativePnlUsd?: number;
}

export interface UnifiedScenarioCashFlow {
  /** Explicit cash paid during this period; never inferred from account P&L. */
  cashOutflowUsd?: number;
  /** Explicit cash actually received during this period; never inferred from a contractual payout. */
  realizedCashInflowUsd?: number;
}

export interface UnifiedPortfolioScenario extends JointScenarioTemplate {
  /** Optional, explicit cash ledger entries keyed by account ID. */
  cashFlows?: Record<string, UnifiedScenarioCashFlow>;
}

export interface UnifiedPortfolioSimulationConfig {
  accounts: UnifiedPortfolioAccount[];
  scenarios: UnifiedPortfolioScenario[];
  iterations: number;
  horizonPeriods: number;
  seed: number;
  /** Cash available before upfront commitments and simulated cash flows. */
  availableCashUsd: number;
  minimumActiveAccounts?: number;
  maxPortfolioLossUsd?: number | null;
  /** Number of individual paths to retain for deterministic audit/replay. Defaults to 0. */
  samplePathCount?: number;
}

export interface UnifiedPortfolioSamplePath {
  iteration: number;
  scenarioIds: string[];
  terminalAccountStatus: Record<string, JointAccountStatus>;
  terminalAccountPnlUsd: Record<string, number>;
  endingCashBalanceUsd: number;
  minimumCashBalanceUsd: number;
  externalCapitalRequiredUsd: number;
  maximumObservedContractualPayoutOpportunityUsd: number;
  portfolioSurvived: boolean;
  periodsSimulated: number;
}

export interface UnifiedPortfolioSimulationResult {
  iterations: number;
  horizonPeriods: number;
  seedUsed: number;
  accountCount: number;
  firmCount: number;
  portfolioSurvivalProbability: number;
  portfolioFailureProbability: number;
  accountSurvivalProbability: Record<string, number>;
  firmAllAccountsSurvivalProbability: Record<string, number>;
  expectedGrossPnlUsd: number;
  expectedMaximumContractualPayoutOpportunityUsd: number;
  payoutOpportunityProbability: number;
  /** Distribution of the peak cash deficit; receipts are explicit cash flows only. */
  expectedExternalCapitalRequiredUsd: number;
  externalCapitalRequiredP50Usd: number;
  externalCapitalRequiredP95Usd: number;
  maximumExternalCapitalRequiredUsd: number;
  endingCashBalanceMeanUsd: number;
  endingCashBalanceP05Usd: number;
  endingCashBalanceP50Usd: number;
  endingCashBalanceP95Usd: number;
  portfolioFailureCounts: {
    accountLossLimit: number;
    accountStatusEvent: number;
    portfolioLossLimit: number;
    minimumActiveAccounts: number;
  };
  samplePaths: UnifiedPortfolioSamplePath[];
  modelingNotes: string[];
}

const EPSILON = 1e-9;
const FAILED_STATUSES = new Set<JointAccountStatus>(['breached', 'restricted', 'terminated']);

function quantile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * p;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function validateConfig(config: UnifiedPortfolioSimulationConfig): void {
  const errors: string[] = [];
  if (!Number.isInteger(config.iterations) || config.iterations < 1) errors.push('iterations must be a positive integer.');
  if (!Number.isInteger(config.horizonPeriods) || config.horizonPeriods < 1) errors.push('horizonPeriods must be a positive integer.');
  if (!Number.isFinite(config.seed)) errors.push('seed must be finite.');
  if (!Number.isFinite(config.availableCashUsd) || config.availableCashUsd < 0) errors.push('availableCashUsd must be finite and non-negative.');
  if (!Array.isArray(config.accounts) || config.accounts.length === 0) errors.push('At least one account is required.');
  if (!Number.isInteger(config.samplePathCount ?? 0) || (config.samplePathCount ?? 0) < 0 || (config.samplePathCount ?? 0) > config.iterations) {
    errors.push('samplePathCount must be an integer between zero and iterations.');
  }

  const ids = new Set<string>();
  for (const account of config.accounts ?? []) {
    if (!account.accountId?.trim() || ids.has(account.accountId)) errors.push(`Invalid or duplicate accountId "${account.accountId}".`);
    ids.add(account.accountId);
    if (!account.firm || account.firm.firmId !== account.firmId) errors.push(`Account "${account.accountId}" firmId must match its firm contract.`);
    if (!Number.isFinite(account.hedgeRatio) || account.hedgeRatio < 0) errors.push(`Account "${account.accountId}" hedgeRatio must be finite and non-negative.`);
    if (!Number.isFinite(account.maxLossUsd) || account.maxLossUsd <= 0) errors.push(`Account "${account.accountId}" maxLossUsd must be positive and finite.`);
    if (!Number.isFinite(account.accountState?.cumulativeProfitUsd)) errors.push(`Account "${account.accountId}" requires finite cumulative contractual P&L.`);
    if (account.upfrontCashCommitmentUsd !== undefined && (!Number.isFinite(account.upfrontCashCommitmentUsd) || account.upfrontCashCommitmentUsd < 0)) errors.push(`Account "${account.accountId}" upfrontCashCommitmentUsd must be non-negative.`);
    if (account.initialCumulativePnlUsd !== undefined && !Number.isFinite(account.initialCumulativePnlUsd)) errors.push(`Account "${account.accountId}" initialCumulativePnlUsd must be finite.`);
  }

  const minimum = config.minimumActiveAccounts ?? 1;
  if (!Number.isInteger(minimum) || minimum < 1 || minimum > config.accounts.length) errors.push('minimumActiveAccounts must be between one and the account count.');
  if (config.maxPortfolioLossUsd != null && (!Number.isFinite(config.maxPortfolioLossUsd) || config.maxPortfolioLossUsd <= 0)) errors.push('maxPortfolioLossUsd must be positive and finite.');
  const matrix = validateJointScenarioMatrix(config.accounts, config.scenarios);
  errors.push(...matrix.errors);

  for (const scenario of config.scenarios ?? []) {
    for (const [accountId, flow] of Object.entries(scenario.cashFlows ?? {})) {
      if (!ids.has(accountId)) errors.push(`Scenario "${scenario.scenarioId}" has cash flow for unknown account "${accountId}".`);
      for (const [field, value] of Object.entries(flow)) {
        if (!Number.isFinite(value) || value < 0) errors.push(`Scenario "${scenario.scenarioId}" has invalid ${field} for "${accountId}".`);
      }
    }
  }
  if (errors.length) throw new Error(`Invalid unified portfolio configuration: ${errors.join(' ')}`);
}

/**
 * Runs reproducible portfolio paths. Each period samples one complete joint
 * scenario, applies the configured account ratios, and advances cumulative
 * P&L. The contractual phase is intentionally not auto-transitioned: Phase 2
 * is a pure one-step evaluator and phase transitions require explicit rules.
 */
export function runUnifiedPortfolioSimulation(
  config: UnifiedPortfolioSimulationConfig
): UnifiedPortfolioSimulationResult {
  validateConfig(config);
  const seed = (Math.trunc(config.seed) >>> 0) || 1;
  const random = createJointScenarioPrng(seed);
  const ids = config.accounts.map((account) => account.accountId);
  const firmIds = [...new Set(config.accounts.map((account) => account.firmId))];
  const accountSurvivors: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  const firmSurvivors: Record<string, number> = Object.fromEntries(firmIds.map((id) => [id, 0]));
  const capitalRequired: number[] = [];
  const endingCash: number[] = [];
  const grossPnl: number[] = [];
  const maximumPayoutOpportunity: number[] = [];
  const failureCounts = { accountLossLimit: 0, accountStatusEvent: 0, portfolioLossLimit: 0, minimumActiveAccounts: 0 };
  const samplePaths: UnifiedPortfolioSamplePath[] = [];
  let portfolioSurvivals = 0;
  let payoutOpportunityCount = 0;
  let accountStatusFailures = 0;
  let accountLossFailures = 0;

  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    const cumulativePnl: Record<string, number> = Object.fromEntries(config.accounts.map((a) => [a.accountId, a.initialCumulativePnlUsd ?? a.accountState.cumulativeProfitUsd]));
    const states: Record<string, ContractualAccountState> = Object.fromEntries(config.accounts.map((a) => [a.accountId, {
      ...a.accountState,
      priorDailyPnlUsd: [...(a.accountState.priorDailyPnlUsd ?? [])],
    }]));
    const status: Record<string, JointAccountStatus> = Object.fromEntries(ids.map((id) => [id, 'active']));
    let cash = config.availableCashUsd - config.accounts.reduce((sum, a) => sum + (a.upfrontCashCommitmentUsd ?? 0), 0);
    let minimumCash = cash;
    let totalGrossPnl = 0;
    let peakPayoutOpportunity = 0;
    let portfolioFailed = false;
    const scenarioIds: string[] = [];
    let periodsSimulated = 0;

    for (let period = 0; period < config.horizonPeriods; period += 1) {
      const draw = random.next();
      let cumulativeProbability = 0;
      let selected = config.scenarios[config.scenarios.length - 1];
      for (const scenario of config.scenarios) {
        cumulativeProbability += scenario.probability;
        if (draw < cumulativeProbability) { selected = scenario; break; }
      }
      scenarioIds.push(selected.scenarioId);
      periodsSimulated += 1;

      let periodPnl = 0;
      let periodPotentialPayout = 0;
      for (const account of config.accounts) {
        const id = account.accountId;
        const flow = selected.cashFlows?.[id];
        cash += (flow?.realizedCashInflowUsd ?? 0) - (flow?.cashOutflowUsd ?? 0);
        if (status[id] !== 'active') continue;

        const source = selected.outcomes[id];
        const scaledPnl = source.grossPnlUsd * account.hedgeRatio;
        const scaledOutcome = { ...source, grossPnlUsd: scaledPnl };
        const payoff: ContractualPayoffResult = calculateContractualPayoff({
          firm: account.firm,
          accountState: states[id],
          scenarioOutcome: scaledOutcome,
        });
        cumulativePnl[id] += scaledPnl;
        periodPnl += scaledPnl;
        totalGrossPnl += scaledPnl;
        states[id] = {
          ...states[id],
          cumulativeProfitUsd: cumulativePnl[id],
          priorDailyPnlUsd: [...(states[id].priorDailyPnlUsd ?? []), scaledPnl],
          priorTradingDays: (states[id].priorTradingDays ?? 0) + 1,
        };
        periodPotentialPayout += payoff.contractualTraderPayoutUsd;

        if (FAILED_STATUSES.has(source.accountStatus)) {
          status[id] = source.accountStatus;
          accountStatusFailures += 1;
        } else if (cumulativePnl[id] <= -account.maxLossUsd) {
          status[id] = 'breached';
          accountLossFailures += 1;
        }
      }

      peakPayoutOpportunity = Math.max(peakPayoutOpportunity, periodPotentialPayout);
      cash = Number(cash.toFixed(8));
      minimumCash = Math.min(minimumCash, cash);
      const portfolioPnl = Object.values(cumulativePnl).reduce((sum, value) => sum + value, 0);
      const activeCount = ids.filter((id) => status[id] === 'active').length;
      if (config.maxPortfolioLossUsd != null && portfolioPnl <= -config.maxPortfolioLossUsd) {
        portfolioFailed = true;
        failureCounts.portfolioLossLimit += 1;
      } else if (activeCount < (config.minimumActiveAccounts ?? 1)) {
        portfolioFailed = true;
        failureCounts.minimumActiveAccounts += 1;
      }
      if (portfolioFailed) break;
      void periodPnl;
    }

    if (!portfolioFailed) portfolioSurvivals += 1;
    ids.forEach((id) => { if (status[id] === 'active') accountSurvivors[id] += 1; });
    firmIds.forEach((firmId) => {
      const firmAccounts = config.accounts.filter((a) => a.firmId === firmId);
      if (firmAccounts.every((a) => status[a.accountId] === 'active')) firmSurvivors[firmId] += 1;
    });
    const required = Math.max(0, -minimumCash);
    capitalRequired.push(required);
    endingCash.push(cash);
    grossPnl.push(totalGrossPnl);
    maximumPayoutOpportunity.push(peakPayoutOpportunity);
    if (peakPayoutOpportunity > EPSILON) payoutOpportunityCount += 1;

    if (samplePaths.length < (config.samplePathCount ?? 0)) {
      samplePaths.push({
        iteration,
        scenarioIds,
        terminalAccountStatus: { ...status },
        terminalAccountPnlUsd: { ...cumulativePnl },
        endingCashBalanceUsd: cash,
        minimumCashBalanceUsd: minimumCash,
        externalCapitalRequiredUsd: required,
        maximumObservedContractualPayoutOpportunityUsd: peakPayoutOpportunity,
        portfolioSurvived: !portfolioFailed,
        periodsSimulated,
      });
    }
  }

  failureCounts.accountLossLimit = accountLossFailures;
  failureCounts.accountStatusEvent = accountStatusFailures;
  const survival = portfolioSurvivals / config.iterations;
  return {
    iterations: config.iterations,
    horizonPeriods: config.horizonPeriods,
    seedUsed: seed,
    accountCount: ids.length,
    firmCount: firmIds.length,
    portfolioSurvivalProbability: survival,
    portfolioFailureProbability: 1 - survival,
    accountSurvivalProbability: Object.fromEntries(ids.map((id) => [id, accountSurvivors[id] / config.iterations])),
    firmAllAccountsSurvivalProbability: Object.fromEntries(firmIds.map((id) => [id, firmSurvivors[id] / config.iterations])),
    expectedGrossPnlUsd: mean(grossPnl),
    expectedMaximumContractualPayoutOpportunityUsd: mean(maximumPayoutOpportunity),
    payoutOpportunityProbability: payoutOpportunityCount / config.iterations,
    expectedExternalCapitalRequiredUsd: mean(capitalRequired),
    externalCapitalRequiredP50Usd: quantile(capitalRequired, 0.5),
    externalCapitalRequiredP95Usd: quantile(capitalRequired, 0.95),
    maximumExternalCapitalRequiredUsd: Math.max(...capitalRequired),
    endingCashBalanceMeanUsd: mean(endingCash),
    endingCashBalanceP05Usd: quantile(endingCash, 0.05),
    endingCashBalanceP50Usd: quantile(endingCash, 0.5),
    endingCashBalanceP95Usd: quantile(endingCash, 0.95),
    portfolioFailureCounts: failureCounts,
    samplePaths,
    modelingNotes: [
      'Joint outcomes are sampled as complete portfolio scenarios; cross-account dependence is preserved.',
      'Account P&L is multiplied by the configured non-negative hedge ratio; source scenario signs encode direction.',
      'Contractual payout is a potential snapshot, not cash received. It is not added to the cash ledger.',
      'Only explicitly supplied realizedCashInflowUsd values count as cash receipts.',
      'Upfront commitments and scenario cash flows are explicit user inputs; missing cash-flow entries are zero.',
      'Account loss limits use cumulative scenario P&L, not intraday equity or trailing drawdown.',
      'Contractual phase transitions, payout-cycle resets, withdrawals, fees not supplied as cash flows, and hedge rebalancing are not inferred.',
      'External capital required is the maximum cumulative cash deficit before any hypothetical injection; it is not a financing recommendation.',
      'Monte Carlo probabilities are conditional on the supplied scenario matrix and are not forecasts or guarantees.',
    ],
  };
}
