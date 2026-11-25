import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROP_FIRMS_2026 } from '../src/data/propFirms2026.ts';
import {
  runPathDependentPortfolioMonteCarlo,
  type PathDependentJointScenario,
  type PathDependentMonteCarloConfig,
  type PathDependentPortfolioAccount,
} from '../src/utils/pathDependentPortfolioMonteCarloEngine.ts';

const original = DEFAULT_PROP_FIRMS_2026.find((item) => item.id === 'lucid-50k-flex');
assert.ok(original);

const firm = {
  ...original,
  evaluationRules: {
    ...original.evaluationRules,
    phase1TargetUsd: { ...original.evaluationRules.phase1TargetUsd, value: 1000, status: 'verified' as const },
    minTradingDays: { ...original.evaluationRules.minTradingDays, value: 1, status: 'verified' as const },
    consistency: { ...original.evaluationRules.consistency, methodology: 'none' as const },
    dailyLossLimit: { ...original.evaluationRules.dailyLossLimit, methodology: 'none' as const },
    maxDrawdown: {
      ...original.evaluationRules.maxDrawdown,
      methodology: 'static' as const,
      amountUsd: { ...original.evaluationRules.maxDrawdown.amountUsd, value: 1000, status: 'verified' as const },
      basis: 'balance' as const,
    },
  },
  fundedRules: {
    ...original.fundedRules,
    dailyLossLimit: { ...original.fundedRules.dailyLossLimit, methodology: 'none' as const },
    maxDrawdown: {
      ...original.fundedRules.maxDrawdown,
      methodology: 'static' as const,
      amountUsd: { ...original.fundedRules.maxDrawdown.amountUsd, value: 1000, status: 'verified' as const },
      basis: 'balance' as const,
    },
  },
};

const account: PathDependentPortfolioAccount = {
  accountId: 'A-1',
  firm,
  initialPhase: 'evaluation_phase_1',
  hedgeRatio: 1,
};

function jointScenario(
  scenarioId: string,
  pnlUsd: number,
  extras: Partial<PathDependentJointScenario> = {},
): PathDependentJointScenario {
  return {
    scenarioId,
    probability: 1,
    marketEvent: 'single test market event',
    outcomes: {
      'A-1': {
        grossPnlUsd: pnlUsd,
        outcomeType: pnlUsd > 0 ? 'win' : pnlUsd < 0 ? 'loss' : 'flat',
        accountStatus: 'active',
        payoutStatus: 'not_eligible',
      },
    },
    accountPaths: {
      'A-1': { sessionId: 'session-1' },
    },
    ...extras,
  };
}

function config(
  scenario: PathDependentJointScenario,
  overrides: Partial<PathDependentMonteCarloConfig> = {},
): PathDependentMonteCarloConfig {
  return {
    accounts: [account],
    scenarios: [scenario],
    iterations: 20,
    horizonPeriods: 3,
    seed: 12345,
    availableCashUsd: 100,
    ...overrides,
  };
}

test('seeded path-dependent Monte Carlo replay is reproducible', () => {
  const input = config(jointScenario('up-day', 25));
  const first = runPathDependentPortfolioMonteCarlo(input);
  const second = runPathDependentPortfolioMonteCarlo(input);

  assert.deepEqual(first, second);
  assert.equal(first.seedUsed, 12345);
  assert.equal(first.expectedGrossTradingPnlUsd, 75);
  assert.equal(first.portfolioSurvivalProbability, 1);
});

test('cash deficit includes upfront commitments and explicit cash flows only', () => {
  const input = config(
    jointScenario('fee-day', 10, {
      cashFlows: { 'A-1': { cashOutflowUsd: 5, realizedCashInflowUsd: 2 } },
    }),
    {
      iterations: 1,
      horizonPeriods: 1,
      availableCashUsd: 10,
      accounts: [{ ...account, upfrontCashCommitmentUsd: 20 }],
      samplePathCount: 1,
    },
  );
  const result = runPathDependentPortfolioMonteCarlo(input);

  assert.equal(result.expectedExternalCapitalRequiredUsd, 13);
  assert.equal(result.externalCapitalRequiredP50Usd, 13);
  assert.equal(result.endingCashBalanceMeanUsd, -13);
  assert.equal(result.samplePaths[0].minimumCashBalanceUsd, -13);
});

test('portfolio loss stop truncates the chronological path after the trigger period', () => {
  const input = config(jointScenario('loss-day', -500), {
    iterations: 1,
    horizonPeriods: 5,
    maxPortfolioLossUsd: 400,
    samplePathCount: 1,
  });
  const result = runPathDependentPortfolioMonteCarlo(input);

  assert.equal(result.portfolioStopProbability, 1);
  assert.equal(result.failureAttribution.portfolioLossLimitStops, 1);
  assert.equal(result.samplePaths[0].periodsSimulated, 1);
  assert.equal(result.samplePaths[0].portfolioStopReason, 'portfolio_loss_limit');
  assert.equal(result.expectedGrossTradingPnlUsd, -500);
});

test('minimum active-account stop is triggered by a path-dependent drawdown breach', () => {
  const input = config(jointScenario('drawdown-day', -1000), {
    iterations: 1,
    horizonPeriods: 4,
    minimumActiveAccounts: 1,
    samplePathCount: 1,
  });
  const result = runPathDependentPortfolioMonteCarlo(input);

  assert.equal(result.failureAttribution.accountBreaches, 1);
  assert.equal(result.failureAttribution.minimumActiveAccountStops, 1);
  assert.equal(result.samplePaths[0].periodsSimulated, 1);
  assert.equal(result.samplePaths[0].terminalAccountStatus['A-1'], 'breached');
  // The breach-day loss must remain visible in terminal account equity/balance.
  assert.equal(result.samplePaths[0].terminalAccountBalanceUsd['A-1'], 49000);
  assert.equal(result.expectedGrossTradingPnlUsd, -1000);
});

test('contractual payout opportunity is not cash; only a validated withdrawal increases cash', () => {
  const fundedFirm = {
    ...firm,
    fundedRules: {
      ...firm.fundedRules,
      dailyLossLimit: { ...firm.fundedRules.dailyLossLimit, methodology: 'none' as const },
      payoutCycleDays: { ...firm.fundedRules.payoutCycleDays, value: 1, status: 'verified' as const },
      minProfitableDays: { ...firm.fundedRules.minProfitableDays, value: 1, status: 'verified' as const },
      minDailyProfitUsd: { ...firm.fundedRules.minDailyProfitUsd, value: 1, status: 'verified' as const },
      profitBufferUsd: { ...firm.fundedRules.profitBufferUsd, value: 0, status: 'verified' as const },
      minWithdrawalUsd: { ...firm.fundedRules.minWithdrawalUsd, value: 1, status: 'verified' as const },
      maxPayoutUsd: { ...firm.fundedRules.maxPayoutUsd, value: 1000, status: 'verified' as const },
      maxWithdrawalPct: { ...firm.fundedRules.maxWithdrawalPct, value: 100, status: 'verified' as const },
      consistency: { ...firm.fundedRules.consistency, methodology: 'none' as const },
    },
  };
  const fundedAccount: PathDependentPortfolioAccount = {
    ...account,
    firm: fundedFirm,
    initialPhase: 'funded',
    initialBalanceUsd: 50100,
    initialEquityUsd: 50100,
    initialCumulativeProfitUsd: 100,
  };
  const approved = jointScenario('approved-payout-day', 100, {
    outcomes: {
      'A-1': {
        grossPnlUsd: 100,
        outcomeType: 'win',
        accountStatus: 'active',
        payoutStatus: 'approved',
      },
    },
  });

  const opportunityOnly = runPathDependentPortfolioMonteCarlo(config(approved, {
    accounts: [fundedAccount],
    iterations: 1,
    horizonPeriods: 1,
    availableCashUsd: 10,
  }));
  assert.ok(opportunityOnly.expectedContractualPayoutOpportunityUsd > 0);
  assert.equal(opportunityOnly.expectedRealizedPayoutUsd, 0);
  assert.equal(opportunityOnly.endingCashBalanceMeanUsd, 10);

  const realized = jointScenario('realized-payout-day', 100, {
    outcomes: {
      'A-1': {
        grossPnlUsd: 100,
        outcomeType: 'win',
        accountStatus: 'active',
        payoutStatus: 'approved',
      },
    },
    accountPaths: {
      'A-1': { sessionId: 'session-1', realizedPayoutUsd: 50 },
    },
  });
  const withWithdrawal = runPathDependentPortfolioMonteCarlo(config(realized, {
    accounts: [fundedAccount],
    iterations: 1,
    horizonPeriods: 1,
    availableCashUsd: 10,
    samplePathCount: 1,
  }));
  assert.equal(withWithdrawal.expectedRealizedPayoutUsd, 50);
  assert.equal(withWithdrawal.endingCashBalanceMeanUsd, 60);
  assert.equal(withWithdrawal.samplePaths[0].terminalAccountBalanceUsd['A-1'], 50150);
});

test('period-specific session IDs reset the contractual daily-loss clock', () => {
  const dailyLossFirm = {
    ...firm,
    evaluationRules: {
      ...firm.evaluationRules,
      dailyLossLimit: {
        ...firm.evaluationRules.dailyLossLimit,
        methodology: 'balance_based' as const,
        amountUsd: { ...firm.evaluationRules.dailyLossLimit.amountUsd, value: 100, status: 'verified' as const },
      },
    },
  };
  const sessionAccount: PathDependentPortfolioAccount = { ...account, firm: dailyLossFirm };
  const scenario = jointScenario('loss-day', -60, {
    accountPaths: {
      'A-1': { sessionId: 'fallback', sessionIdByPeriod: ['session-1', 'session-2', 'session-3'] },
    },
  });
  const result = runPathDependentPortfolioMonteCarlo(config(scenario, {
    accounts: [sessionAccount],
    iterations: 1,
    horizonPeriods: 2,
    minimumActiveAccounts: 1,
    samplePathCount: 1,
  }));

  assert.equal(result.samplePaths[0].terminalAccountStatus['A-1'], 'active');
  assert.equal(result.samplePaths[0].periodsSimulated, 2);
});

test('rejects incomplete session calendars and invalid cash flows', () => {
  const incomplete = jointScenario('bad-session', 10, {
    accountPaths: {
      'A-1': { sessionId: 'fallback', sessionIdByPeriod: ['only-one'] },
    },
  });
  assert.throws(
    () => runPathDependentPortfolioMonteCarlo(config(incomplete, { horizonPeriods: 2 })),
    /sessionIdByPeriod/,
  );

  const invalidCash = jointScenario('bad-cash', 10, {
    cashFlows: { 'A-1': { cashOutflowUsd: -1 } },
  });
  assert.throws(
    () => runPathDependentPortfolioMonteCarlo(config(invalidCash)),
    /invalid cashOutflowUsd/,
  );

  const dailyLossFirm = {
    ...firm,
    evaluationRules: {
      ...firm.evaluationRules,
      dailyLossLimit: { ...firm.evaluationRules.dailyLossLimit, methodology: 'balance_based' as const },
    },
  };
  const noCalendarAccount: PathDependentPortfolioAccount = { ...account, firm: dailyLossFirm };
  assert.throws(
    () => runPathDependentPortfolioMonteCarlo(config(jointScenario('daily-loss', -10), {
      accounts: [noCalendarAccount],
      iterations: 1,
      horizonPeriods: 2,
    })),
    /requires sessionIdByPeriod/,
  );
});
