import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROP_FIRMS_2026 } from '../src/data/propFirms2026.ts';
import {
  runUnifiedPortfolioSimulation,
  type UnifiedPortfolioAccount,
  type UnifiedPortfolioScenario,
} from '../src/utils/unifiedPortfolioSimulationEngine.ts';

const firm = DEFAULT_PROP_FIRMS_2026.find((item) => item.id === 'lucid-50k-flex');
assert.ok(firm);

const accounts: UnifiedPortfolioAccount[] = [{
  accountId: 'A-1',
  firmId: firm.firmId,
  firm,
  accountState: { phase: 'evaluation_phase_1', cumulativeProfitUsd: 0, priorTradingDays: 0, priorDailyPnlUsd: [] },
  hedgeRatio: 1,
  maxLossUsd: 500,
  upfrontCashCommitmentUsd: 100,
}];

const flat: UnifiedPortfolioScenario = {
  scenarioId: 'flat',
  probability: 1,
  marketEvent: 'flat',
  outcomes: {
    'A-1': { grossPnlUsd: 50, outcomeType: 'win', accountStatus: 'active', payoutStatus: 'not_eligible' },
  },
  cashFlows: { 'A-1': { cashOutflowUsd: 10, realizedCashInflowUsd: 0 } },
};

function run(overrides: Partial<Parameters<typeof runUnifiedPortfolioSimulation>[0]> = {}) {
  return runUnifiedPortfolioSimulation({
    accounts,
    scenarios: [flat],
    iterations: 10,
    horizonPeriods: 2,
    seed: 7,
    availableCashUsd: 200,
    samplePathCount: 2,
    ...overrides,
  });
}

test('integrates contractual account evaluation, scenario sampling and cash commitments', () => {
  const result = run();
  assert.equal(result.portfolioSurvivalProbability, 1);
  assert.equal(result.accountSurvivalProbability['A-1'], 1);
  assert.equal(result.expectedGrossPnlUsd, 100);
  assert.equal(result.expectedExternalCapitalRequiredUsd, 0);
  assert.equal(result.samplePaths.length, 2);
  assert.deepEqual(result.samplePaths[0].scenarioIds, ['flat', 'flat']);
});

test('computes external capital from explicit cash deficits, not potential payouts', () => {
  const result = run({
    availableCashUsd: 0,
    accounts: [{ ...accounts[0], upfrontCashCommitmentUsd: 100 }],
    scenarios: [{
      ...flat,
      cashFlows: { 'A-1': { cashOutflowUsd: 25, realizedCashInflowUsd: 0 } },
    }],
  });
  assert.equal(result.expectedExternalCapitalRequiredUsd, 150);
  assert.equal(result.samplePaths[0].endingCashBalanceUsd, -150);
});

test('only explicit realized cash inflows reduce the required external capital', () => {
  const result = run({
    availableCashUsd: 0,
    accounts: [{ ...accounts[0], upfrontCashCommitmentUsd: 100 }],
    scenarios: [{
      ...flat,
      cashFlows: { 'A-1': { cashOutflowUsd: 25, realizedCashInflowUsd: 50 } },
    }],
  });
  assert.equal(result.expectedExternalCapitalRequiredUsd, 100);
  assert.equal(result.samplePaths[0].endingCashBalanceUsd, -100);
});

test('account loss limits are absorbing and can terminate the portfolio', () => {
  const loss: UnifiedPortfolioScenario = {
    scenarioId: 'loss',
    probability: 1,
    marketEvent: 'loss',
    outcomes: {
      'A-1': { grossPnlUsd: -500, outcomeType: 'loss', accountStatus: 'active', payoutStatus: 'blocked' },
    },
  };
  const result = run({ scenarios: [loss] });
  assert.equal(result.accountSurvivalProbability['A-1'], 0);
  assert.equal(result.portfolioSurvivalProbability, 0);
  assert.equal(result.portfolioFailureCounts.accountLossLimit, 10);
});

test('seeded replay is deterministic and records selected joint scenarios', () => {
  const first = run();
  const second = run();
  assert.deepEqual(first, second);
});

test('rejects incomplete matrices, invalid ratios and unknown cash-flow account IDs', () => {
  assert.throws(() => run({ accounts: [{ ...accounts[0], hedgeRatio: -1 }] }), /hedgeRatio/);
  assert.throws(() => run({ scenarios: [{ ...flat, outcomes: {} }] }), /missing account/);
  assert.throws(() => run({
    scenarios: [{ ...flat, cashFlows: { UNKNOWN: { cashOutflowUsd: 1 } } }],
  }), /unknown account/);
});
