/**
 * Phase 3 — Multi-firm portfolio survival analysis.
 *
 * Simulates complete joint scenarios over a multi-period horizon. Correlation
 * is inherited from Phase 1 joint scenario probabilities; marginal outcomes
 * are never sampled independently.
 *
 * Account and portfolio loss limits are explicit simulation inputs. This
 * module does not infer broker hedge P&L or contractual drawdown mechanics.
 */

import {
  createJointScenarioPrng,
  sampleJointScenario,
  validateJointScenarioMatrix,
  type JointAccountDefinition,
  type JointAccountStatus,
  type JointScenarioTemplate,
} from './jointScenarioEngine.ts';

export interface SurvivalAccountConfig extends JointAccountDefinition {
  /** Positive USD loss budget. Breach occurs when cumulative P&L <= -maxLossUsd. */
  maxLossUsd: number;
  /** P&L accumulated before the simulated horizon. Defaults to zero. */
  initialCumulativePnlUsd?: number;
}

export interface PortfolioSurvivalConfig {
  accounts: SurvivalAccountConfig[];
  scenarios: JointScenarioTemplate[];
  iterations: number;
  /** Number of sequential joint market events simulated per path. */
  horizonPeriods: number;
  seed: number;
  /** Portfolio fails when active accounts fall below this count. Defaults to one. */
  minimumActiveAccounts?: number;
  /** Optional positive USD portfolio loss budget. */
  maxPortfolioLossUsd?: number | null;
}

export type SurvivalFailureCause =
  | 'account_status_event'
  | 'account_loss_limit'
  | 'portfolio_loss_limit'
  | 'minimum_active_accounts';

export interface SurvivalAccountSummary {
  firmId: string;
  survivalProbability: number;
  failureProbability: number;
  meanFailurePeriod: number | null;
  failureCauseCounts: Record<SurvivalFailureCause, number>;
  terminalCumulativePnlMeanUsd: number;
  terminalCumulativePnlP05Usd: number;
  terminalCumulativePnlP50Usd: number;
  terminalCumulativePnlP95Usd: number;
}

export interface FirmSurvivalSummary {
  accountCount: number;
  allAccountsSurvivalProbability: number;
  atLeastOneAccountSurvivalProbability: number;
}

export interface PairwiseFailureSummary {
  accountA: string;
  accountB: string;
  jointFailureProbability: number;
  conditionalFailureProbabilityA_given_B: number | null;
  conditionalFailureProbabilityB_given_A: number | null;
}

export interface PortfolioSurvivalSummary {
  iterations: number;
  horizonPeriods: number;
  seedUsed: number;
  portfolioSurvivalProbability: number;
  portfolioFailureProbability: number;
  survivalStandardError: number;
  survivalConfidenceInterval95: { lower: number; upper: number };
  meanPeriodsSurvived: number;
  meanTimeToFirstAccountFailure: number | null;
  portfolioFailureCauseCounts: Record<SurvivalFailureCause, number>;
  accountSurvival: Record<string, SurvivalAccountSummary>;
  firmSurvival: Record<string, FirmSurvivalSummary>;
  pairwiseFailures: PairwiseFailureSummary[];
  timeToFirstAccountFailureCounts: Record<number, number>;
  terminalPortfolioPnlMeanUsd: number;
  terminalPortfolioPnlP05Usd: number;
  terminalPortfolioPnlP50Usd: number;
  terminalPortfolioPnlP95Usd: number;
}

const FAILURE_CAUSES: SurvivalFailureCause[] = [
  'account_status_event',
  'account_loss_limit',
  'portfolio_loss_limit',
  'minimum_active_accounts',
];

const ACCOUNT_FAILURE_STATES = new Set<JointAccountStatus>([
  'breached',
  'restricted',
  'terminated',
]);

function quantile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function validateConfig(config: PortfolioSurvivalConfig): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(config.iterations) || config.iterations <= 0) {
    errors.push('iterations must be a positive integer.');
  }
  if (!Number.isInteger(config.horizonPeriods) || config.horizonPeriods <= 0) {
    errors.push('horizonPeriods must be a positive integer.');
  }
  if (!Number.isFinite(config.seed)) errors.push('seed must be finite.');
  if (!Array.isArray(config.accounts) || config.accounts.length === 0) {
    errors.push('At least one account is required.');
  }

  const ids = new Set<string>();
  for (const account of config.accounts ?? []) {
    if (!account.accountId?.trim()) errors.push('Every account requires accountId.');
    if (ids.has(account.accountId)) errors.push(`Duplicate accountId "${account.accountId}".`);
    ids.add(account.accountId);
    if (!account.firmId?.trim()) errors.push(`Account "${account.accountId}" requires firmId.`);
    if (!Number.isFinite(account.maxLossUsd) || account.maxLossUsd <= 0) {
      errors.push(`Account "${account.accountId}" maxLossUsd must be positive and finite.`);
    }
    if (
      account.initialCumulativePnlUsd !== undefined &&
      !Number.isFinite(account.initialCumulativePnlUsd)
    ) {
      errors.push(`Account "${account.accountId}" initial P&L must be finite.`);
    }
  }

  const minimum = config.minimumActiveAccounts ?? 1;
  if (!Number.isInteger(minimum) || minimum < 1 || minimum > config.accounts.length) {
    errors.push('minimumActiveAccounts must be an integer between 1 and account count.');
  }
  if (
    config.maxPortfolioLossUsd !== undefined &&
    config.maxPortfolioLossUsd !== null &&
    (!Number.isFinite(config.maxPortfolioLossUsd) || config.maxPortfolioLossUsd <= 0)
  ) {
    errors.push('maxPortfolioLossUsd must be positive and finite when provided.');
  }

  const matrix = validateJointScenarioMatrix(
    config.accounts,
    config.scenarios
  );
  errors.push(...matrix.errors);
  return errors;
}

/**
 * Runs seeded multi-period portfolio survival Monte Carlo.
 * Every time step samples one complete joint portfolio scenario.
 */
export function runPortfolioSurvivalAnalysis(
  config: PortfolioSurvivalConfig
): PortfolioSurvivalSummary {
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`Invalid survival configuration: ${errors.join(' ')}`);

  const minimumActive = config.minimumActiveAccounts ?? 1;
  const prng = createJointScenarioPrng(config.seed);
  const accountIds = config.accounts.map((account) => account.accountId);
  const accountConfig = new Map(config.accounts.map((account) => [account.accountId, account]));

  const accountPnlSamples: Record<string, number[]> = Object.fromEntries(
    accountIds.map((id) => [id, []])
  );
  const accountFailurePeriods: Record<string, number[]> = Object.fromEntries(
    accountIds.map((id) => [id, []])
  );
  const accountFailureCauses: Record<string, Record<SurvivalFailureCause, number>> =
    Object.fromEntries(
      accountIds.map((id) => [
        id,
        Object.fromEntries(FAILURE_CAUSES.map((cause) => [cause, 0])) as Record<
          SurvivalFailureCause,
          number
        >,
      ])
    );

  const firmIds = [...new Set(config.accounts.map((account) => account.firmId))];
  const firmAllSurvived: Record<string, number> = Object.fromEntries(firmIds.map((id) => [id, 0]));
  const firmAnySurvived: Record<string, number> = Object.fromEntries(firmIds.map((id) => [id, 0]));
  const pairFailureCounts: Record<string, number> = {};
  const pairIds: Array<[string, string]> = [];
  for (let i = 0; i < accountIds.length; i += 1) {
    for (let j = i + 1; j < accountIds.length; j += 1) {
      const a = accountIds[i];
      const b = accountIds[j];
      pairIds.push([a, b]);
      pairFailureCounts[`${a}::${b}`] = 0;
    }
  }

  const timeToFirstFailureCounts: Record<number, number> = Object.fromEntries(
    Array.from({ length: config.horizonPeriods }, (_, index) => [index + 1, 0])
  );
  const portfolioFailureCauseCounts = Object.fromEntries(
    FAILURE_CAUSES.map((cause) => [cause, 0])
  ) as Record<SurvivalFailureCause, number>;

  const portfolioPnlSamples: number[] = [];
  const periodsSurvivedSamples: number[] = [];
  const firstFailurePeriods: number[] = [];
  let portfolioSurvivals = 0;

  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    const pnl: Record<string, number> = Object.fromEntries(
      config.accounts.map((account) => [
        account.accountId,
        account.initialCumulativePnlUsd ?? 0,
      ])
    );
    const status: Record<string, JointAccountStatus> = Object.fromEntries(
      accountIds.map((id) => [id, 'active'])
    );
    const failurePeriod: Record<string, number | null> = Object.fromEntries(
      accountIds.map((id) => [id, null])
    );
    const failureCause: Record<string, SurvivalFailureCause | null> = Object.fromEntries(
      accountIds.map((id) => [id, null])
    );

    let portfolioPnl = Object.values(pnl).reduce((sum, value) => sum + value, 0);
    let portfolioFailed = false;
    let portfolioFailureCause: SurvivalFailureCause | null = null;
    let periodsSurvived = 0;
    let firstAccountFailure: number | null = null;

    for (let period = 1; period <= config.horizonPeriods; period += 1) {
      const sampled = sampleJointScenario(config.scenarios, prng.next);

      for (const accountId of accountIds) {
        if (status[accountId] !== 'active') continue;
        const outcome = sampled.outcomes[accountId];
        pnl[accountId] += outcome.grossPnlUsd;

        if (ACCOUNT_FAILURE_STATES.has(outcome.accountStatus)) {
          status[accountId] = outcome.accountStatus;
          failurePeriod[accountId] = period;
          failureCause[accountId] = 'account_status_event';
        } else if (pnl[accountId] <= -(accountConfig.get(accountId)!.maxLossUsd)) {
          status[accountId] = 'breached';
          failurePeriod[accountId] = period;
          failureCause[accountId] = 'account_loss_limit';
        }
      }

      const newlyFailed = accountIds.filter((id) => failurePeriod[id] === period);
      if (firstAccountFailure === null && newlyFailed.length > 0) {
        firstAccountFailure = period;
      }

      portfolioPnl = Object.values(pnl).reduce((sum, value) => sum + value, 0);
      const activeCount = accountIds.filter((id) => status[id] === 'active').length;

      if (
        config.maxPortfolioLossUsd !== undefined &&
        config.maxPortfolioLossUsd !== null &&
        portfolioPnl <= -config.maxPortfolioLossUsd
      ) {
        portfolioFailed = true;
        portfolioFailureCause = 'portfolio_loss_limit';
      } else if (activeCount < minimumActive) {
        portfolioFailed = true;
        portfolioFailureCause = 'minimum_active_accounts';
      }

      periodsSurvived = period;
      if (portfolioFailed) break;
    }

    if (firstAccountFailure !== null) {
      firstFailurePeriods.push(firstAccountFailure);
      timeToFirstFailureCounts[firstAccountFailure] += 1;
    }
    if (!portfolioFailed) portfolioSurvivals += 1;
    else if (portfolioFailureCause) portfolioFailureCauseCounts[portfolioFailureCause] += 1;

    periodsSurvivedSamples.push(periodsSurvived);
    portfolioPnlSamples.push(portfolioPnl);

    for (const accountId of accountIds) {
      accountPnlSamples[accountId].push(pnl[accountId]);
      if (failurePeriod[accountId] !== null) {
        accountFailurePeriods[accountId].push(failurePeriod[accountId]!);
        accountFailureCauses[accountId][failureCause[accountId]!] += 1;
      }
    }

    for (const firmId of firmIds) {
      const firmAccounts = config.accounts.filter((account) => account.firmId === firmId);
      const active = firmAccounts.filter((account) => status[account.accountId] === 'active').length;
      if (active === firmAccounts.length) firmAllSurvived[firmId] += 1;
      if (active > 0) firmAnySurvived[firmId] += 1;
    }

    for (const [a, b] of pairIds) {
      if (failurePeriod[a] !== null && failurePeriod[b] !== null) {
        pairFailureCounts[`${a}::${b}`] += 1;
      }
    }
  }

  const survivalProbability = portfolioSurvivals / config.iterations;
  const standardError = Math.sqrt(
    (survivalProbability * (1 - survivalProbability)) / config.iterations
  );
  const accountSurvival: Record<string, SurvivalAccountSummary> = {};

  for (const account of config.accounts) {
    const id = account.accountId;
    const failures = accountFailurePeriods[id];
    const pnlSamples = accountPnlSamples[id];
    accountSurvival[id] = {
      firmId: account.firmId,
      survivalProbability: 1 - failures.length / config.iterations,
      failureProbability: failures.length / config.iterations,
      meanFailurePeriod: failures.length ? mean(failures) : null,
      failureCauseCounts: accountFailureCauses[id],
      terminalCumulativePnlMeanUsd: mean(pnlSamples),
      terminalCumulativePnlP05Usd: quantile(pnlSamples, 0.05),
      terminalCumulativePnlP50Usd: quantile(pnlSamples, 0.5),
      terminalCumulativePnlP95Usd: quantile(pnlSamples, 0.95),
    };
  }

  const firmSurvival: Record<string, FirmSurvivalSummary> = {};
  for (const firmId of firmIds) {
    const count = config.accounts.filter((account) => account.firmId === firmId).length;
    firmSurvival[firmId] = {
      accountCount: count,
      allAccountsSurvivalProbability: firmAllSurvived[firmId] / config.iterations,
      atLeastOneAccountSurvivalProbability: firmAnySurvived[firmId] / config.iterations,
    };
  }

  const pairwiseFailures = pairIds.map(([a, b]) => {
    const joint = pairFailureCounts[`${a}::${b}`];
    const failA = accountFailurePeriods[a].length;
    const failB = accountFailurePeriods[b].length;
    return {
      accountA: a,
      accountB: b,
      jointFailureProbability: joint / config.iterations,
      conditionalFailureProbabilityA_given_B: failB ? joint / failB : null,
      conditionalFailureProbabilityB_given_A: failA ? joint / failA : null,
    };
  });

  return {
    iterations: config.iterations,
    horizonPeriods: config.horizonPeriods,
    seedUsed: prng.seed,
    portfolioSurvivalProbability: survivalProbability,
    portfolioFailureProbability: 1 - survivalProbability,
    survivalStandardError: standardError,
    survivalConfidenceInterval95: {
      lower: Math.max(0, survivalProbability - 1.96 * standardError),
      upper: Math.min(1, survivalProbability + 1.96 * standardError),
    },
    meanPeriodsSurvived: mean(periodsSurvivedSamples),
    meanTimeToFirstAccountFailure: firstFailurePeriods.length
      ? mean(firstFailurePeriods)
      : null,
    portfolioFailureCauseCounts,
    accountSurvival,
    firmSurvival,
    pairwiseFailures,
    timeToFirstAccountFailureCounts: timeToFirstFailureCounts,
    terminalPortfolioPnlMeanUsd: mean(portfolioPnlSamples),
    terminalPortfolioPnlP05Usd: quantile(portfolioPnlSamples, 0.05),
    terminalPortfolioPnlP50Usd: quantile(portfolioPnlSamples, 0.5),
    terminalPortfolioPnlP95Usd: quantile(portfolioPnlSamples, 0.95),
  };
}
