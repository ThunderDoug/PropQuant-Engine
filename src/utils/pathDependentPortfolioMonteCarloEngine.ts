/**
 * Phase 11 — Unified path-dependent Monte Carlo portfolio simulation.
 *
 * Samples complete joint portfolio outcomes over time, applies account exposure
 * multipliers, and replays every sampled path through the Phase 10 contractual
 * lifecycle engine. The cash ledger is separate from trading P&L and contractual
 * payout opportunity; only explicit cash flows and validated realized payouts
 * count as cash received.
 */

import type { LifecycleStatus, LifecycleAccountConfig, LifecycleScenario } from './contractualLifecycleEngine.ts';
import {
  runContractualLifecycleSimulation,
  type ContractualLifecycleResult,
} from './contractualLifecycleEngine.ts';
import {
  createJointScenarioPrng,
  validateJointScenarioMatrix,
  type JointAccountDefinition,
  type JointScenarioTemplate,
} from './jointScenarioEngine.ts';

export interface PathDependentPortfolioAccount extends LifecycleAccountConfig {
  /** Non-negative multiplier applied to signed daily P&L and intraday excursions. */
  hedgeRatio: number;
  /** Explicit upfront cash commitment, such as evaluation or activation fees. */
  upfrontCashCommitmentUsd?: number;
}

export interface PathDependentScenarioAccountPath {
  /**
   * Default session identifier. Supply sessionIdByPeriod for exact reset-calendar
   * control when the same joint scenario template may be sampled on many days.
   */
  sessionId: string;
  /** Optional absolute-period session IDs, indexed from zero. Must cover the full horizon. */
  sessionIdByPeriod?: string[];
  /** Intraday excursions in the source outcome's P&L units, before hedgeRatio. */
  intradayPeakPnlUsd?: number;
  intradayAdversePnlUsd?: number;
  /** Explicit cash already received and withdrawn from the prop-firm account. */
  realizedPayoutUsd?: number;
}

export interface PathDependentScenarioCashFlow {
  /** Explicit cash paid during this period; never inferred from trading P&L. */
  cashOutflowUsd?: number;
  /**
   * Explicit non-payout cash received during this period. Excludes
   * PathDependentScenarioAccountPath.realizedPayoutUsd to prevent double counting.
   */
  realizedCashInflowUsd?: number;
}

export interface PathDependentJointScenario extends JointScenarioTemplate {
  /** Required path mechanics keyed by account ID. */
  accountPaths: Record<string, PathDependentScenarioAccountPath>;
  /** Optional explicit cash ledger entries keyed by account ID. */
  cashFlows?: Record<string, PathDependentScenarioCashFlow>;
}

export interface PathDependentMonteCarloConfig {
  accounts: PathDependentPortfolioAccount[];
  scenarios: PathDependentJointScenario[];
  iterations: number;
  horizonPeriods: number;
  seed: number;
  availableCashUsd: number;
  /** Defaults to one: stop once fewer than one account remains active. */
  minimumActiveAccounts?: number;
  /** Optional positive cumulative portfolio trading-loss stop threshold. */
  maxPortfolioLossUsd?: number | null;
  /** Number of detailed paths retained for audit; defaults to zero. */
  samplePathCount?: number;
}

export interface PathDependentMonteCarloSamplePath {
  iteration: number;
  scenarioIds: string[];
  terminalAccountStatus: Record<string, LifecycleStatus>;
  terminalAccountBalanceUsd: Record<string, number>;
  terminalAccountEquityUsd: Record<string, number>;
  terminalAccountCumulativePnlUsd: Record<string, number>;
  endingCashBalanceUsd: number;
  minimumCashBalanceUsd: number;
  externalCapitalRequiredUsd: number;
  grossTradingPnlUsd: number;
  realizedPayoutUsd: number;
  contractualPayoutOpportunityUsd: number;
  portfolioSurvived: boolean;
  portfolioStopReason: ContractualLifecycleResult['portfolioStopReason'];
  periodsSimulated: number;
}

export interface PathDependentMonteCarloResult {
  iterations: number;
  requestedHorizonPeriods: number;
  seedUsed: number;
  accountCount: number;
  firmCount: number;
  portfolioSurvivalProbability: number;
  portfolioStopProbability: number;
  accountSurvivalProbability: Record<string, number>;
  firmAllAccountsSurvivalProbability: Record<string, number>;
  expectedGrossTradingPnlUsd: number;
  expectedRealizedPayoutUsd: number;
  realizedPayoutProbability: number;
  expectedContractualPayoutOpportunityUsd: number;
  payoutOpportunityProbability: number;
  expectedExternalCapitalRequiredUsd: number;
  externalCapitalRequiredP50Usd: number;
  externalCapitalRequiredP95Usd: number;
  maximumExternalCapitalRequiredUsd: number;
  endingCashBalanceMeanUsd: number;
  endingCashBalanceP05Usd: number;
  endingCashBalanceP50Usd: number;
  endingCashBalanceP95Usd: number;
  averagePeriodsSimulated: number;
  failureAttribution: {
    accountBreaches: number;
    accountRestrictions: number;
    accountTerminations: number;
    portfolioLossLimitStops: number;
    minimumActiveAccountStops: number;
  };
  samplePaths: PathDependentMonteCarloSamplePath[];
  modelingNotes: string[];
}

const EPSILON = 1e-8;

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function quantile(values: number[], probability: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function validateConfig(config: PathDependentMonteCarloConfig): void {
  const errors: string[] = [];
  if (!Number.isInteger(config.iterations) || config.iterations < 1) {
    errors.push('iterations must be a positive integer.');
  }
  if (!Number.isInteger(config.horizonPeriods) || config.horizonPeriods < 1) {
    errors.push('horizonPeriods must be a positive integer.');
  }
  if (!Number.isFinite(config.seed)) errors.push('seed must be finite.');
  if (!Number.isFinite(config.availableCashUsd) || config.availableCashUsd < 0) {
    errors.push('availableCashUsd must be finite and non-negative.');
  }
  if (!Array.isArray(config.accounts) || config.accounts.length === 0) {
    errors.push('At least one account is required.');
  }
  if (!Number.isInteger(config.samplePathCount ?? 0) ||
      (config.samplePathCount ?? 0) < 0 ||
      (config.samplePathCount ?? 0) > config.iterations) {
    errors.push('samplePathCount must be an integer between zero and iterations.');
  }

  const accountIds = new Set<string>();
  for (const account of config.accounts ?? []) {
    if (!account.accountId?.trim() || accountIds.has(account.accountId)) {
      errors.push('Account IDs must be non-empty and unique.');
    }
    accountIds.add(account.accountId);
    if (!Number.isFinite(account.hedgeRatio) || account.hedgeRatio < 0) {
      errors.push('Account ' + account.accountId + ' hedgeRatio must be finite and non-negative.');
    }
    if (account.upfrontCashCommitmentUsd !== undefined &&
        (!Number.isFinite(account.upfrontCashCommitmentUsd) || account.upfrontCashCommitmentUsd < 0)) {
      errors.push('Account ' + account.accountId + ' upfrontCashCommitmentUsd must be non-negative.');
    }
  }

  const minimum = config.minimumActiveAccounts ?? 1;
  if (!Number.isInteger(minimum) || minimum < 1 || minimum > (config.accounts?.length ?? 0)) {
    errors.push('minimumActiveAccounts must be between one and the account count.');
  }
  if (config.maxPortfolioLossUsd != null &&
      (!Number.isFinite(config.maxPortfolioLossUsd) || config.maxPortfolioLossUsd <= 0)) {
    errors.push('maxPortfolioLossUsd must be positive and finite.');
  }

  const definitions: JointAccountDefinition[] = (config.accounts ?? []).map((account) => ({
    accountId: account.accountId,
    firmId: account.firm?.firmId ?? '',
  }));
  const matrixValidation = validateJointScenarioMatrix(definitions, config.scenarios);
  errors.push(...matrixValidation.errors);

  for (const scenario of config.scenarios ?? []) {
    for (const account of config.accounts ?? []) {
      const id = account.accountId;
      const path = scenario.accountPaths?.[id];
      if (!path) {
        errors.push('Scenario "' + scenario.scenarioId + '" is missing account path "' + id + '".');
        continue;
      }
      if (!path.sessionId?.trim()) {
        errors.push('Scenario "' + scenario.scenarioId + '" has an empty sessionId for "' + id + '".');
      }
      if (path.sessionIdByPeriod !== undefined) {
        if (!Array.isArray(path.sessionIdByPeriod) ||
            path.sessionIdByPeriod.length < config.horizonPeriods ||
            path.sessionIdByPeriod.slice(0, config.horizonPeriods).some((value) => !value?.trim())) {
          errors.push('Scenario "' + scenario.scenarioId + '" sessionIdByPeriod must contain a non-empty ID for every horizon period (' + id + ').');
        }
      }
      for (const [field, value] of Object.entries({
        intradayPeakPnlUsd: path.intradayPeakPnlUsd,
        intradayAdversePnlUsd: path.intradayAdversePnlUsd,
        realizedPayoutUsd: path.realizedPayoutUsd,
      })) {
        if (value !== undefined && !Number.isFinite(value)) {
          errors.push('Scenario "' + scenario.scenarioId + '" has non-finite ' + field + ' for "' + id + '".');
        }
      }
      if ((path.realizedPayoutUsd ?? 0) < 0) {
        errors.push('Scenario "' + scenario.scenarioId + '" has a negative realized payout for "' + id + '".');
      }
      if ((path.intradayPeakPnlUsd ?? 0) < (path.intradayAdversePnlUsd ?? 0)) {
        errors.push('Scenario "' + scenario.scenarioId + '" intraday peak is below adverse excursion for "' + id + '".');
      }
      const scaledPnl = scenario.outcomes[id].grossPnlUsd * account.hedgeRatio;
      if (!Number.isFinite(scaledPnl)) {
        errors.push('Scenario "' + scenario.scenarioId + '" produces non-finite scaled P&L for "' + id + '".');
      }
    }

    for (const id of Object.keys(scenario.accountPaths ?? {})) {
      if (!accountIds.has(id)) errors.push('Scenario "' + scenario.scenarioId + '" has path data for unknown account "' + id + '".');
    }
    for (const [accountId, flow] of Object.entries(scenario.cashFlows ?? {})) {
      if (!accountIds.has(accountId)) {
        errors.push('Scenario "' + scenario.scenarioId + '" has cash flow for unknown account "' + accountId + '".');
      }
      for (const [field, value] of Object.entries(flow)) {
        if (!Number.isFinite(value) || value < 0) {
          errors.push('Scenario "' + scenario.scenarioId + '" has invalid ' + field + ' for "' + accountId + '".');
        }
      }
    }
  }

  if (errors.length) {
    throw new Error('Invalid path-dependent Monte Carlo configuration: ' + errors.join(' '));
  }
}

function buildLifecycleScenarios(
  selectedScenarios: PathDependentJointScenario[],
  accounts: PathDependentPortfolioAccount[],
  firstPeriodIndex: number,
  iteration: number,
): LifecycleScenario[] {
  return selectedScenarios.map((scenario, relativeIndex) => {
    const periodIndex = firstPeriodIndex + relativeIndex;
    const accountsForPeriod: LifecycleScenario['accounts'] = {};
    for (const account of accounts) {
      const id = account.accountId;
      const sourceOutcome = scenario.outcomes[id];
      const pathTemplate = scenario.accountPaths[id];
      const scaledPnl = sourceOutcome.grossPnlUsd * account.hedgeRatio;
      const path: LifecycleScenario['accounts'][string]['path'] = {
        dailyPnlUsd: scaledPnl,
        sessionId: pathTemplate.sessionIdByPeriod?.[periodIndex] ?? pathTemplate.sessionId,
      };
      if (pathTemplate.intradayPeakPnlUsd !== undefined) {
        path.intradayPeakPnlUsd = pathTemplate.intradayPeakPnlUsd * account.hedgeRatio;
      }
      if (pathTemplate.intradayAdversePnlUsd !== undefined) {
        path.intradayAdversePnlUsd = pathTemplate.intradayAdversePnlUsd * account.hedgeRatio;
      }
      if (pathTemplate.realizedPayoutUsd !== undefined) {
        path.realizedPayoutUsd = pathTemplate.realizedPayoutUsd;
      }
      accountsForPeriod[id] = {
        outcome: { ...sourceOutcome, grossPnlUsd: scaledPnl },
        path,
      };
    }
    return {
      // A sampled joint template may recur. Give each chronological occurrence
      // a unique ID because the deterministic lifecycle engine validates IDs.
      scenarioId: 'iteration-' + iteration + '-period-' + periodIndex + '-' + scenario.scenarioId,
      accounts: accountsForPeriod,
    };
  });
}

/**
 * Runs seeded Monte Carlo paths. Each period draws one complete joint scenario
 * with replacement, preserving the input cross-account dependence for that
 * period. Phase 10 then applies contractual lifecycle rules in chronological
 * order and enforces optional portfolio stop conditions.
 */
export function runPathDependentPortfolioMonteCarlo(
  config: PathDependentMonteCarloConfig,
): PathDependentMonteCarloResult {
  validateConfig(config);

  const seedUsed = (Math.trunc(config.seed) >>> 0) || 1;
  const random = createJointScenarioPrng(seedUsed);
  const accountIds = config.accounts.map((account) => account.accountId);
  const firmIds = [...new Set(config.accounts.map((account) => account.firm.firmId))];

  const accountSurvivors: Record<string, number> = Object.fromEntries(accountIds.map((id) => [id, 0]));
  const firmSurvivors: Record<string, number> = Object.fromEntries(firmIds.map((id) => [id, 0]));
  const grossPnlValues: number[] = [];
  const realizedPayoutValues: number[] = [];
  const payoutOpportunityValues: number[] = [];
  const externalCapitalValues: number[] = [];
  const endingCashValues: number[] = [];
  const periodsSimulatedValues: number[] = [];
  const samplePaths: PathDependentMonteCarloSamplePath[] = [];
  const failureAttribution = {
    accountBreaches: 0,
    accountRestrictions: 0,
    accountTerminations: 0,
    portfolioLossLimitStops: 0,
    minimumActiveAccountStops: 0,
  };
  let portfolioSurvivals = 0;
  let payoutOpportunityCount = 0;
  let realizedPayoutCount = 0;

  const upfrontCommitments = config.accounts.reduce(
    (sum, account) => sum + (account.upfrontCashCommitmentUsd ?? 0),
    0,
  );
  const initialCumulativePnl = config.accounts.reduce((sum, account) => {
    const balance = account.initialBalanceUsd ?? account.firm.accountSize;
    return sum + (account.initialCumulativeProfitUsd ?? balance - account.firm.accountSize);
  }, 0);

  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    const selectedScenarios: PathDependentJointScenario[] = [];
    for (let period = 0; period < config.horizonPeriods; period += 1) {
      const draw = random.next();
      let cumulativeProbability = 0;
      let selected = config.scenarios[config.scenarios.length - 1];
      for (const scenario of config.scenarios) {
        cumulativeProbability += scenario.probability;
        if (draw < cumulativeProbability) {
          selected = scenario;
          break;
        }
      }
      selectedScenarios.push(selected);
    }

    const lifecycleScenarios = buildLifecycleScenarios(selectedScenarios, config.accounts, 0, iteration);
    const lifecycle = runContractualLifecycleSimulation({
      accounts: config.accounts,
      scenarios: lifecycleScenarios,
      portfolioStopRules: {
        minimumActiveAccounts: config.minimumActiveAccounts ?? 1,
        ...(config.maxPortfolioLossUsd == null ? {} : { maxPortfolioLossUsd: config.maxPortfolioLossUsd }),
      },
    });

    const processedPeriods = lifecycle.processedScenarioCount;
    let cash = config.availableCashUsd - upfrontCommitments;
    let minimumCash = cash;
    for (let period = 0; period < processedPeriods; period += 1) {
      const sampledScenario = selectedScenarios[period];
      for (const accountId of accountIds) {
        const flow = sampledScenario.cashFlows?.[accountId];
        cash += (flow?.realizedCashInflowUsd ?? 0) - (flow?.cashOutflowUsd ?? 0);
      }
      // This amount is validated by Phase 10 as an actual account withdrawal;
      // it is counted as trader cash only after that lifecycle replay succeeds.
      cash += lifecycle.scenarioSnapshots[period].realizedPayoutUsd;
      minimumCash = Math.min(minimumCash, cash);
    }

    const requiredExternalCapital = Math.max(0, -minimumCash);
    const terminalStatuses: Record<string, LifecycleStatus> = {};
    const terminalBalances: Record<string, number> = {};
    const terminalEquities: Record<string, number> = {};
    const terminalCumulativePnl: Record<string, number> = {};
    for (const account of config.accounts) {
      const terminal = lifecycle.terminalAccounts[account.accountId];
      terminalStatuses[account.accountId] = terminal.status;
      terminalBalances[account.accountId] = terminal.balanceUsd;
      terminalEquities[account.accountId] = terminal.equityUsd;
      terminalCumulativePnl[account.accountId] = terminal.cumulativeProfitUsd;
      if (terminal.status === 'active') accountSurvivors[account.accountId] += 1;
    }
    for (const firmId of firmIds) {
      const firmAccounts = config.accounts.filter((account) => account.firm.firmId === firmId);
      if (firmAccounts.every((account) => terminalStatuses[account.accountId] === 'active')) {
        firmSurvivors[firmId] += 1;
      }
    }

    for (const transition of lifecycle.transitions) {
      if (transition.to === 'breached') failureAttribution.accountBreaches += 1;
      else if (transition.to === 'restricted') failureAttribution.accountRestrictions += 1;
      else if (transition.to === 'terminated') failureAttribution.accountTerminations += 1;
    }
    if (lifecycle.portfolioStopReason === 'portfolio_loss_limit') {
      failureAttribution.portfolioLossLimitStops += 1;
    } else if (lifecycle.portfolioStopReason === 'minimum_active_accounts') {
      failureAttribution.minimumActiveAccountStops += 1;
    }

    const lastSnapshot = lifecycle.scenarioSnapshots[lifecycle.scenarioSnapshots.length - 1];
    const grossTradingPnl = (lastSnapshot?.cumulativePortfolioPnlUsd ?? initialCumulativePnl)
      - initialCumulativePnl;
    const realizedPayout = lifecycle.totalRealizedPayoutUsd;
    const contractualOpportunity = lifecycle.totalContractualPayoutOpportunityUsd;
    const portfolioSurvived = !lifecycle.stoppedEarly;

    grossPnlValues.push(grossTradingPnl);
    realizedPayoutValues.push(realizedPayout);
    payoutOpportunityValues.push(contractualOpportunity);
    externalCapitalValues.push(requiredExternalCapital);
    endingCashValues.push(cash);
    periodsSimulatedValues.push(processedPeriods);
    if (portfolioSurvived) portfolioSurvivals += 1;
    if (contractualOpportunity > EPSILON) payoutOpportunityCount += 1;
    if (realizedPayout > EPSILON) realizedPayoutCount += 1;

    if (samplePaths.length < (config.samplePathCount ?? 0)) {
      samplePaths.push({
        iteration,
        scenarioIds: selectedScenarios.slice(0, processedPeriods).map((scenario) => scenario.scenarioId),
        terminalAccountStatus: terminalStatuses,
        terminalAccountBalanceUsd: terminalBalances,
        terminalAccountEquityUsd: terminalEquities,
        terminalAccountCumulativePnlUsd: terminalCumulativePnl,
        endingCashBalanceUsd: cash,
        minimumCashBalanceUsd: minimumCash,
        externalCapitalRequiredUsd: requiredExternalCapital,
        grossTradingPnlUsd: grossTradingPnl,
        realizedPayoutUsd: realizedPayout,
        contractualPayoutOpportunityUsd: contractualOpportunity,
        portfolioSurvived,
        portfolioStopReason: lifecycle.portfolioStopReason,
        periodsSimulated: processedPeriods,
      });
    }
  }

  const survivalProbability = portfolioSurvivals / config.iterations;
  return {
    iterations: config.iterations,
    requestedHorizonPeriods: config.horizonPeriods,
    seedUsed,
    accountCount: accountIds.length,
    firmCount: firmIds.length,
    portfolioSurvivalProbability: survivalProbability,
    portfolioStopProbability: 1 - survivalProbability,
    accountSurvivalProbability: Object.fromEntries(
      accountIds.map((id) => [id, accountSurvivors[id] / config.iterations]),
    ),
    firmAllAccountsSurvivalProbability: Object.fromEntries(
      firmIds.map((id) => [id, firmSurvivors[id] / config.iterations]),
    ),
    expectedGrossTradingPnlUsd: mean(grossPnlValues),
    expectedRealizedPayoutUsd: mean(realizedPayoutValues),
    realizedPayoutProbability: realizedPayoutCount / config.iterations,
    expectedContractualPayoutOpportunityUsd: mean(payoutOpportunityValues),
    payoutOpportunityProbability: payoutOpportunityCount / config.iterations,
    expectedExternalCapitalRequiredUsd: mean(externalCapitalValues),
    externalCapitalRequiredP50Usd: quantile(externalCapitalValues, 0.5),
    externalCapitalRequiredP95Usd: quantile(externalCapitalValues, 0.95),
    maximumExternalCapitalRequiredUsd: externalCapitalValues.reduce((maximum, value) => Math.max(maximum, value), 0),
    endingCashBalanceMeanUsd: mean(endingCashValues),
    endingCashBalanceP05Usd: quantile(endingCashValues, 0.05),
    endingCashBalanceP50Usd: quantile(endingCashValues, 0.5),
    endingCashBalanceP95Usd: quantile(endingCashValues, 0.95),
    averagePeriodsSimulated: mean(periodsSimulatedValues),
    failureAttribution,
    samplePaths,
    modelingNotes: [
      'Each Monte Carlo period samples one complete joint scenario with replacement; within-period cross-account dependence is preserved.',
      'Scenario draws are independent and stationary across periods. Serial dependence, regimes and Markov transitions are not inferred.',
      'Phase 10 replays each sampled path chronologically, including evaluation progression, drawdown, daily-loss sessions, payout cycles and explicit realized withdrawals.',
      'Hedge ratios are non-negative exposure multipliers; scenario signs already encode long/short direction.',
      'Intraday excursions are multiplied by the same hedge ratio as daily P&L; realized payout amounts are explicit fixed cash amounts and are not scaled.',
      'Session IDs must be generated from each contract resetTime/timezone. sessionIdByPeriod should be used when a scenario template can recur across multiple session dates.',
      'Contractual payout opportunity is not cash. Only Phase 10-validated realizedPayoutUsd and explicitly supplied non-payout cash inflows enter the cash ledger.',
      'Cash outflows/inflows are applied for every sampled period and configured account, even after account failure; set future flows to zero in the scenario inputs when they should cease.',
      'External capital required is the maximum cash deficit after upfront commitments and explicit cash flows. No hypothetical injection is added to the cash balance.',
      'Portfolio loss stops use cumulative account trading P&L and exclude realized withdrawals and cash fees; fees affect cash only when explicitly entered as cash outflows.',
      'A portfolio stop is evaluated after all configured accounts process the same sampled period. Account failures are absorbing within each replay.',
      'Monte Carlo probabilities are conditional on the supplied joint scenario matrix and static versioned firm contracts; they are not forecasts or guarantees.',
      'Unknown or incomplete critical contractual drawdown, daily-loss or payout-cycle rules fail closed in the Phase 10 lifecycle engine.',
    ],
  };
}
