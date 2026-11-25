/**
 * Phase 10 — Path-dependent contractual account lifecycle.
 *
 * Unlike the Phase 2 one-step payoff evaluator, this engine maintains account
 * equity/balance high-water marks, session loss baselines, lifecycle transitions,
 * and explicit realized withdrawals across a chronological scenario path.
 */

import type { PropFirmPreset, DrawdownMethodology } from '../types/quant.ts';
import {
  calculateContractualPayoff,
  type ContractualAccountState,
  type ContractualPayoffPhase,
} from './contractualPayoffEngine.ts';
import type { JointAccountOutcome } from './jointScenarioEngine.ts';

export type LifecycleStatus = 'active' | 'breached' | 'restricted' | 'terminated';

export interface LifecycleAccountConfig {
  accountId: string;
  firm: PropFirmPreset;
  initialPhase: ContractualPayoffPhase;
  initialBalanceUsd?: number;
  initialEquityUsd?: number;
  initialCumulativeProfitUsd?: number;
  initialHighWaterMarkUsd?: number;
  initialSessionId?: string;
  initialSessionStartBalanceUsd?: number;
  initialSessionStartEquityUsd?: number;
  initialPayoutCycleElapsedDays?: number;
  initialPriorDailyPnlUsd?: number[];
  initialPriorTradingDays?: number;
}

export interface LifecycleScenarioAccount {
  /** Net account P&L for this trading day, before any explicit withdrawal. */
  dailyPnlUsd: number;
  /** Highest intraday P&L excursion from the day's opening balance/equity. */
  intradayPeakPnlUsd?: number;
  /** Lowest intraday P&L excursion from the day's opening balance/equity. */
  intradayAdversePnlUsd?: number;
  /**
   * Caller-generated session key. A new key resets daily-loss baselines.
   * Generate it using the contract's resetTime and timezone.
   */
  sessionId: string;
  /** Explicit cash already received by the trader and withdrawn from account equity. */
  realizedPayoutUsd?: number;
}

export interface LifecycleScenario {
  scenarioId: string;
  accounts: Record<string, {
    outcome: JointAccountOutcome;
    path: LifecycleScenarioAccount;
  }>;
}

export interface LifecyclePortfolioStopRules {
  /** Positive loss threshold applied to cumulative trading P&L across accounts. */
  maxPortfolioLossUsd?: number;
  /** Stop after a day when fewer than this many accounts remain active. */
  minimumActiveAccounts?: number;
}

export interface ContractualLifecycleConfig {
  accounts: LifecycleAccountConfig[];
  /** Ordered, chronological path. These are path steps, not independent samples. */
  scenarios: LifecycleScenario[];
  /** Optional portfolio-level stop conditions evaluated after each complete day. */
  portfolioStopRules?: LifecyclePortfolioStopRules;
}

export interface LifecycleScenarioSnapshot {
  scenarioId: string;
  cumulativePortfolioPnlUsd: number;
  activeAccountCount: number;
  accountStatuses: Record<string, LifecycleStatus>;
  realizedPayoutUsd: number;
  contractualPayoutOpportunityUsd: number;
}

export interface LifecycleTransition {
  scenarioId: string;
  accountId: string;
  from: ContractualPayoffPhase | 'active';
  to: ContractualPayoffPhase | 'breached' | 'restricted' | 'terminated';
  reason: string;
}

export interface LifecycleStepResult {
  scenarioId: string;
  accountId: string;
  phase: ContractualPayoffPhase;
  status: LifecycleStatus;
  dailyPnlUsd: number;
  balanceUsd: number;
  equityUsd: number;
  highWaterMarkUsd: number;
  drawdownFloorUsd: number;
  drawdownRemainingUsd: number;
  dailyLossUsedUsd: number;
  dailyLossRemainingUsd: number | null;
  payoutCycleElapsedDays: number;
  phasePassed: boolean;
  contractualPayoutOpportunityUsd: number;
  realizedPayoutUsd: number;
  violationReason: string | null;
}

export interface ContractualLifecycleResult {
  steps: LifecycleStepResult[];
  transitions: LifecycleTransition[];
  scenarioSnapshots: LifecycleScenarioSnapshot[];
  processedScenarioCount: number;
  stoppedEarly: boolean;
  portfolioStopReason: 'portfolio_loss_limit' | 'minimum_active_accounts' | null;
  terminalAccounts: Record<string, {
    phase: ContractualPayoffPhase;
    status: LifecycleStatus;
    balanceUsd: number;
    equityUsd: number;
    highWaterMarkUsd: number;
    cumulativeProfitUsd: number;
    payoutCycleElapsedDays: number;
    realizedPayoutTotalUsd: number;
  }>;
  totalRealizedPayoutUsd: number;
  totalContractualPayoutOpportunityUsd: number;
  breachedAccounts: string[];
  modelingNotes: string[];
}

interface RuntimeAccount {
  phase: ContractualPayoffPhase;
  status: LifecycleStatus;
  balanceUsd: number;
  equityUsd: number;
  highWaterMarkUsd: number;
  cumulativeProfitUsd: number;
  sessionId: string;
  sessionStartBalanceUsd: number;
  sessionStartEquityUsd: number;
  payoutCycleElapsedDays: number;
  priorDailyPnlUsd: number[];
  priorTradingDays: number;
  realizedPayoutTotalUsd: number;
}

const EPSILON = 1e-8;
const DRAW_DOWN_METHODS = new Set<DrawdownMethodology>([
  'static', 'trailing_eod', 'trailing_intraday',
  'trailing_eod_locked', 'trailing_intraday_locked',
]);

function finite(value: number): boolean { return Number.isFinite(value); }

function requiredRuleValue(
  value: { value: number | null; status: string },
  label: string
): number {
  if (value.value === null || !finite(value.value) || value.value <= 0 || value.status === 'missing') {
    throw new Error(`Cannot simulate contractual lifecycle: ${label} is missing or invalid.`);
  }
  return value.value;
}

function getRules(account: LifecycleAccountConfig) {
  const funded = account.initialPhase === 'funded';
  const rules = funded ? account.firm.fundedRules : account.firm.evaluationRules;
  const drawdown = rules.maxDrawdown;
  const dailyLoss = rules.dailyLossLimit;
  if (!DRAW_DOWN_METHODS.has(drawdown.methodology)) {
    throw new Error(`Unsupported drawdown methodology "${drawdown.methodology}" for ${account.accountId}.`);
  }
  const drawdownUsd = requiredRuleValue(drawdown.amountUsd, `${account.accountId} maxDrawdown.amountUsd`);
  if ((drawdown.methodology.endsWith('_locked')) &&
      (drawdown.lockOffsetUsd === null || !finite(drawdown.lockOffsetUsd) || drawdown.lockOffsetUsd < 0)) {
    throw new Error(`Locked drawdown for ${account.accountId} requires a non-negative lockOffsetUsd.`);
  }
  let dailyLossUsd: number | null = null;
  if (dailyLoss.methodology === 'unknown') {
    throw new Error(`Unknown daily-loss methodology for ${account.accountId}; simulation fails closed.`);
  }
  if (dailyLoss.methodology !== 'none') {
    dailyLossUsd = requiredRuleValue(dailyLoss.amountUsd, `${account.accountId} dailyLossLimit.amountUsd`);
  }
  if (funded) requiredRuleValue(account.firm.fundedRules.payoutCycleDays, `${account.accountId} payoutCycleDays`);
  return { drawdown, drawdownUsd, dailyLoss, dailyLossUsd };
}

function drawdownFloor(
  account: LifecycleAccountConfig,
  runtime: RuntimeAccount,
  intradayPeakPnlUsd: number,
): number {
  const { drawdown, drawdownUsd } = getRules({ ...account, initialPhase: runtime.phase });
  const initial = account.firm.accountSize;
  if (drawdown.methodology === 'static') return initial - drawdownUsd;

  const intraday = drawdown.methodology.includes('intraday');
  const drawdownBasis = drawdown.basis === 'equity' ? runtime.equityUsd : runtime.balanceUsd;
  const peak = intraday
    ? Math.max(runtime.highWaterMarkUsd, drawdownBasis + intradayPeakPnlUsd)
    : runtime.highWaterMarkUsd;
  let floor = peak - drawdownUsd;
  if (drawdown.methodology.endsWith('_locked')) {
    const lockAt = initial + (drawdown.lockOffsetUsd as number);
    if (peak >= lockAt) floor = Math.max(floor, initial);
  }
  return floor;
}

function validate(config: ContractualLifecycleConfig): void {
  const errors: string[] = [];
  if (!Array.isArray(config.accounts) || config.accounts.length === 0) errors.push('At least one account is required.');
  if (!Array.isArray(config.scenarios) || config.scenarios.length === 0) errors.push('At least one chronological scenario is required.');
  const ids = new Set<string>();
  const scenarioIds = new Set<string>();
  for (const account of config.accounts ?? []) {
    if (!account.accountId?.trim() || ids.has(account.accountId)) errors.push(`Invalid or duplicate accountId "${account.accountId}".`);
    ids.add(account.accountId);
    if (!Number.isInteger(account.initialPayoutCycleElapsedDays ?? 0) || (account.initialPayoutCycleElapsedDays ?? 0) < 0) errors.push('Invalid initial payout-cycle day count for ' + account.accountId + '.');
    if (!Number.isInteger(account.initialPriorTradingDays ?? 0) || (account.initialPriorTradingDays ?? 0) < 0) errors.push('Invalid initial trading-day count for ' + account.accountId + '.');
    if (!account.firm) errors.push(`Missing firm contract for "${account.accountId}".`);
    if (!finite(account.firm?.accountSize) || (account.firm?.accountSize ?? 0) <= 0) errors.push(`Invalid account size for "${account.accountId}".`);
    for (const value of [account.initialBalanceUsd, account.initialEquityUsd, account.initialCumulativeProfitUsd, account.initialHighWaterMarkUsd, account.initialSessionStartBalanceUsd, account.initialSessionStartEquityUsd]) {
      if (value !== undefined && !finite(value)) errors.push(`Non-finite initial state for "${account.accountId}".`);
    }
  }
  for (const scenario of config.scenarios ?? []) {
    if (!scenario.scenarioId?.trim() || scenarioIds.has(scenario.scenarioId)) errors.push('Invalid or duplicate scenarioId ' + scenario.scenarioId + '.');
    scenarioIds.add(scenario.scenarioId);
    for (const id of ids) {
      const entry = scenario.accounts?.[id];
      if (!entry) { errors.push(`Scenario "${scenario.scenarioId}" missing account "${id}".`); continue; }
      if (!finite(entry.path.dailyPnlUsd) || !entry.path.sessionId?.trim()) errors.push(`Scenario "${scenario.scenarioId}" has invalid daily P&L or sessionId for "${id}".`);
      if (Math.abs(entry.outcome.grossPnlUsd - entry.path.dailyPnlUsd) > EPSILON) errors.push('Scenario ' + scenario.scenarioId + ' outcome P&L must match dailyPnlUsd for ' + id + '.');
      for (const value of [entry.path.intradayPeakPnlUsd, entry.path.intradayAdversePnlUsd, entry.path.realizedPayoutUsd]) {
        if (value !== undefined && !finite(value)) errors.push(`Scenario "${scenario.scenarioId}" has non-finite path data for "${id}".`);
      }
      if ((entry.path.realizedPayoutUsd ?? 0) < 0) errors.push(`Scenario "${scenario.scenarioId}" has negative realized payout for "${id}".`);
      if ((entry.path.intradayPeakPnlUsd ?? 0) < (entry.path.intradayAdversePnlUsd ?? 0)) errors.push(`Scenario "${scenario.scenarioId}" intraday peak is below adverse excursion for "${id}".`);
    }
    for (const id of Object.keys(scenario.accounts ?? {})) if (!ids.has(id)) errors.push(`Scenario "${scenario.scenarioId}" has unknown account "${id}".`);
  }
  const stopRules = config.portfolioStopRules;
  if (stopRules?.maxPortfolioLossUsd !== undefined &&
      (!finite(stopRules.maxPortfolioLossUsd) || stopRules.maxPortfolioLossUsd <= 0)) {
    errors.push('maxPortfolioLossUsd must be positive and finite.');
  }
  if (stopRules?.minimumActiveAccounts !== undefined &&
      (!Number.isInteger(stopRules.minimumActiveAccounts) ||
       stopRules.minimumActiveAccounts < 1 ||
       stopRules.minimumActiveAccounts > (config.accounts?.length ?? 0))) {
    errors.push('minimumActiveAccounts must be between one and the account count.');
  }
  if (errors.length) throw new Error(`Invalid contractual lifecycle configuration: ${errors.join(' ')}`);
}

/**
 * Deterministic chronological lifecycle replay. Unlike Monte Carlo, the input
 * scenario list is consumed in the exact order supplied.
 */
export function runContractualLifecycleSimulation(
  config: ContractualLifecycleConfig
): ContractualLifecycleResult {
  validate(config);
  const runtimes: Record<string, RuntimeAccount> = {};
  for (const account of config.accounts) {
    const balance = account.initialBalanceUsd ?? account.firm.accountSize;
    const equity = account.initialEquityUsd ?? balance;
    runtimes[account.accountId] = {
      phase: account.initialPhase,
      status: 'active',
      balanceUsd: balance,
      equityUsd: equity,
      highWaterMarkUsd: account.initialHighWaterMarkUsd ?? (
        getRules(account).drawdown.basis === 'equity' ? equity : balance
      ),
      cumulativeProfitUsd: account.initialCumulativeProfitUsd ?? balance - account.firm.accountSize,
      sessionId: account.initialSessionId ?? '',
      sessionStartBalanceUsd: account.initialSessionStartBalanceUsd ?? balance,
      sessionStartEquityUsd: account.initialSessionStartEquityUsd ?? equity,
      payoutCycleElapsedDays: account.initialPayoutCycleElapsedDays ?? 0,
      priorDailyPnlUsd: [...(account.initialPriorDailyPnlUsd ?? [])],
      priorTradingDays: account.initialPriorTradingDays ?? 0,
      realizedPayoutTotalUsd: 0,
    };
  }

  const steps: LifecycleStepResult[] = [];
  const transitions: LifecycleTransition[] = [];
  const scenarioSnapshots: LifecycleScenarioSnapshot[] = [];
  let totalRealizedPayoutUsd = 0;
  let totalContractualPayoutOpportunityUsd = 0;
  let cumulativePortfolioPnlUsd = config.accounts.reduce((sum, account) => {
    const balance = account.initialBalanceUsd ?? account.firm.accountSize;
    return sum + (account.initialCumulativeProfitUsd ?? balance - account.firm.accountSize);
  }, 0);
  let portfolioStopReason: ContractualLifecycleResult['portfolioStopReason'] = null;

  for (const scenario of config.scenarios) {
    let scenarioRealizedPayoutUsd = 0;
    let scenarioPayoutOpportunityUsd = 0;
    for (const account of config.accounts) {
      const id = account.accountId;
      const state = runtimes[id];
      const { outcome, path } = scenario.accounts[id];
      if (state.status !== 'active') continue;
      cumulativePortfolioPnlUsd += path.dailyPnlUsd;

      // Unknown drawdown/daily-loss mechanics are rejected before this path step.
      getRules({ ...account, initialPhase: state.phase });
      const openingBalance = state.balanceUsd;
      const openingEquity = state.equityUsd;
      if (path.sessionId !== state.sessionId) {
        state.sessionId = path.sessionId;
        state.sessionStartBalanceUsd = openingBalance;
        state.sessionStartEquityUsd = openingEquity;
      }

      const dailyPnl = path.dailyPnlUsd;
      const peakPnl = path.intradayPeakPnlUsd ?? Math.max(0, dailyPnl);
      const adversePnl = path.intradayAdversePnlUsd ?? Math.min(0, dailyPnl);
      const dailyRules = getRules({ ...account, initialPhase: state.phase });
      const dailyLossUsed = dailyRules.dailyLossUsd === null ? 0 : Math.max(
        0,
        dailyRules.dailyLoss.methodology === 'equity_based'
          ? Math.max(0, state.sessionStartEquityUsd - (openingEquity + adversePnl))
          : Math.max(0, state.sessionStartBalanceUsd - (openingBalance + Math.min(0, adversePnl)))
      );
      const dailyLossRemaining = dailyRules.dailyLossUsd === null
        ? null
        : dailyRules.dailyLossUsd - dailyLossUsed;
      const candidateEquity = openingEquity + dailyPnl;
      const candidateBalance = openingBalance + dailyPnl;
      const floor = drawdownFloor(account, state, peakPnl);
      const adverseEquity = openingEquity + adversePnl;
      const adverseBalance = openingBalance + adversePnl;
      const intradayDrawdown = dailyRules.drawdown.methodology.includes('intraday');
      const drawdownTestValue = dailyRules.drawdown.basis === 'equity'
        ? (intradayDrawdown ? adverseEquity : candidateEquity)
        : (intradayDrawdown ? adverseBalance : candidateBalance);
      let violation: string | null = null;
      if (dailyLossRemaining !== null && dailyLossRemaining <= EPSILON) violation = 'daily_loss_limit_breached';
      if (drawdownTestValue <= floor + EPSILON) violation = violation
        ? `${violation};max_drawdown_breached`
        : 'max_drawdown_breached';

      const nextCumulative = state.cumulativeProfitUsd + dailyPnl;
      const payoff = calculateContractualPayoff({
        firm: account.firm,
        accountState: {
          phase: state.phase,
          cumulativeProfitUsd: state.cumulativeProfitUsd,
          priorDailyPnlUsd: state.priorDailyPnlUsd,
          priorTradingDays: state.priorTradingDays,
        } satisfies ContractualAccountState,
        scenarioOutcome: { ...outcome, grossPnlUsd: dailyPnl, accountStatus: violation ? 'breached' : outcome.accountStatus },
      });

      if (!violation && outcome.accountStatus !== 'active') violation = `scenario_account_status_${outcome.accountStatus}`;
      // Record the actual breach-day P&L in terminal account balances. A breach is
      // absorbing, but it must not erase the loss that caused the breach.
      state.balanceUsd = candidateBalance;
      state.equityUsd = candidateEquity;
      state.cumulativeProfitUsd = nextCumulative;
      state.priorDailyPnlUsd.push(dailyPnl);
      state.priorTradingDays += 1;

      if (violation) {
        state.status = outcome.accountStatus === 'restricted' || outcome.accountStatus === 'terminated' ? outcome.accountStatus : 'breached';
        transitions.push({ scenarioId: scenario.scenarioId, accountId: id, from: state.phase, to: state.status, reason: violation });
      } else {
        const highWaterMarkBasis = dailyRules.drawdown.methodology.includes('intraday')
          ? (dailyRules.drawdown.basis === 'equity'
            ? openingEquity + peakPnl
            : openingBalance + peakPnl)
          : (dailyRules.drawdown.basis === 'equity' ? state.equityUsd : state.balanceUsd);
        state.highWaterMarkUsd = Math.max(state.highWaterMarkUsd, highWaterMarkBasis);
        state.payoutCycleElapsedDays += 1;
      }

      let realizedPayout = 0;
      if (!violation && state.phase === 'funded') {
        const cycleDays = account.firm.fundedRules.payoutCycleDays.value;
        const cycleReady = cycleDays !== null && state.payoutCycleElapsedDays >= cycleDays;
        const requested = path.realizedPayoutUsd ?? 0;
        if (requested > EPSILON) {
          if (!cycleReady) throw new Error(`Realized payout for "${id}" precedes the contractual payout cycle.`);
          if (!payoff.payoutContractuallyEligible || requested > payoff.contractualTraderPayoutUsd + EPSILON) {
            throw new Error(`Realized payout for "${id}" exceeds the contractual payout opportunity.`);
          }
          realizedPayout = requested;
          state.balanceUsd -= requested;
          state.equityUsd -= requested;
          state.cumulativeProfitUsd -= requested;
          state.realizedPayoutTotalUsd += requested;
          totalRealizedPayoutUsd += requested;
          scenarioRealizedPayoutUsd += requested;
          state.payoutCycleElapsedDays = 0;
          const postPayoutFloor = drawdownFloor(account, state, 0);
          const postPayoutValue = dailyRules.drawdown.basis === 'equity' ? state.equityUsd : state.balanceUsd;
          if (postPayoutValue <= postPayoutFloor + EPSILON) {
            state.status = 'breached';
            violation = 'post_payout_drawdown_breached';
            transitions.push({ scenarioId: scenario.scenarioId, accountId: id, from: state.phase, to: 'breached', reason: violation });
          }
        }
      } else if ((path.realizedPayoutUsd ?? 0) > EPSILON) {
        throw new Error(`Realized payout supplied for non-funded or failed account "${id}".`);
      }

      if (!violation && payoff.phasePassed) {
        if (state.phase === 'evaluation_phase_1') {
          state.phase = 'evaluation_phase_2';
          state.priorDailyPnlUsd = [];
          state.priorTradingDays = 0;
          transitions.push({ scenarioId: scenario.scenarioId, accountId: id, from: 'evaluation_phase_1', to: 'evaluation_phase_2', reason: 'phase_1_target_days_and_consistency_satisfied' });
        } else if (state.phase === 'evaluation_phase_2') {
          state.phase = 'funded';
          state.priorDailyPnlUsd = [];
          state.priorTradingDays = 0;
          state.payoutCycleElapsedDays = 0;
          transitions.push({ scenarioId: scenario.scenarioId, accountId: id, from: 'evaluation_phase_2', to: 'funded', reason: 'phase_2_target_days_and_consistency_satisfied' });
        }
      }

      const displayRules = getRules({ ...account, initialPhase: state.phase });
      const currentFloor = drawdownFloor(account, state, 0);
      const payoutCycleDays = account.firm.fundedRules.payoutCycleDays.value;
      const payoutOpportunity = state.phase === 'funded' && payoff.payoutContractuallyEligible &&
        (payoutCycleDays === null || state.payoutCycleElapsedDays >= payoutCycleDays || realizedPayout > EPSILON)
        ? payoff.contractualTraderPayoutUsd : 0;
      totalContractualPayoutOpportunityUsd += payoutOpportunity;
      scenarioPayoutOpportunityUsd += payoutOpportunity;
      steps.push({
        scenarioId: scenario.scenarioId,
        accountId: id,
        phase: state.phase,
        status: state.status,
        dailyPnlUsd: dailyPnl,
        balanceUsd: state.balanceUsd,
        equityUsd: state.equityUsd,
        highWaterMarkUsd: state.highWaterMarkUsd,
        drawdownFloorUsd: currentFloor,
        drawdownRemainingUsd: Math.max(0, ((displayRules.drawdown.basis === 'equity' ? state.equityUsd : state.balanceUsd) - currentFloor)),
        dailyLossUsedUsd: dailyLossUsed,
        dailyLossRemainingUsd: dailyLossRemaining,
        payoutCycleElapsedDays: state.payoutCycleElapsedDays,
        phasePassed: payoff.phasePassed,
        contractualPayoutOpportunityUsd: payoutOpportunity,
        realizedPayoutUsd: realizedPayout,
        violationReason: violation,
      });
    }

    const accountStatuses = Object.fromEntries(
      config.accounts.map((account) => [account.accountId, runtimes[account.accountId].status])
    ) as Record<string, LifecycleStatus>;
    const activeAccountCount = Object.values(accountStatuses).filter((status) => status === 'active').length;
    scenarioSnapshots.push({
      scenarioId: scenario.scenarioId,
      cumulativePortfolioPnlUsd,
      activeAccountCount,
      accountStatuses,
      realizedPayoutUsd: scenarioRealizedPayoutUsd,
      contractualPayoutOpportunityUsd: scenarioPayoutOpportunityUsd,
    });

    const stopRules = config.portfolioStopRules;
    if (stopRules?.maxPortfolioLossUsd !== undefined &&
        cumulativePortfolioPnlUsd <= -stopRules.maxPortfolioLossUsd + EPSILON) {
      portfolioStopReason = 'portfolio_loss_limit';
      break;
    }
    if (stopRules?.minimumActiveAccounts !== undefined &&
        activeAccountCount < stopRules.minimumActiveAccounts) {
      portfolioStopReason = 'minimum_active_accounts';
      break;
    }
  }

  const terminalAccounts = Object.fromEntries(config.accounts.map((account) => {
    const state = runtimes[account.accountId];
    return [account.accountId, {
      phase: state.phase,
      status: state.status,
      balanceUsd: state.balanceUsd,
      equityUsd: state.equityUsd,
      highWaterMarkUsd: state.highWaterMarkUsd,
      cumulativeProfitUsd: state.cumulativeProfitUsd,
      payoutCycleElapsedDays: state.payoutCycleElapsedDays,
      realizedPayoutTotalUsd: state.realizedPayoutTotalUsd,
    }];
  }));
  return {
    steps,
    transitions,
    scenarioSnapshots,
    processedScenarioCount: scenarioSnapshots.length,
    stoppedEarly: portfolioStopReason !== null,
    portfolioStopReason,
    terminalAccounts,
    totalRealizedPayoutUsd,
    totalContractualPayoutOpportunityUsd,
    breachedAccounts: config.accounts.filter((a) => runtimes[a.accountId].status !== 'active').map((a) => a.accountId),
    modelingNotes: [
      'Scenario order is chronological and deterministic; no Monte Carlo sampling is performed by this lifecycle replay.',
      'Optional portfolio stop rules are evaluated only after all configured accounts have processed the same trading-day scenario.',
      'Breach-day P&L is retained in terminal balance, equity and cumulative profit even though the account status is absorbing.',
      'Session IDs must be generated by the caller using each contract resetTime and timezone; the engine resets daily baselines when the ID changes.',
      'Trailing EOD high-water marks update only after a non-breaching daily close; trailing intraday drawdown uses the supplied intraday peak and adverse excursion.',
      'Locked trailing drawdown locks at the initial account balance once the high-water mark reaches initial balance plus lockOffsetUsd.',
      'Daily P&L is net of commissions/fees if the caller includes them; the engine does not infer transaction costs.',
      'A payout opportunity is not cash. Only explicit realizedPayoutUsd is recorded as received and deducted from account balance.',
      'Realized payout is accepted only when it does not exceed the contractual trader payout returned by the Phase 2 evaluator and the payout cycle is satisfied.',
      'Contract rules are versioned by the supplied firm preset contractVersion; historical rule changes require separate account configurations and replay segmentation.',
      'The model uses supplied daily and intraday excursions; it does not reconstruct tick-level equity paths.',
    ],
  };
}
