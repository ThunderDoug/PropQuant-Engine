import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROP_FIRMS_2026 } from '../src/data/propFirms2026.ts';
import {
  optimizeContractAwareHedgeRatios,
  type HedgeRatioAccount,
  type HedgeRatioScenario,
} from '../src/utils/contractAwareHedgeRatioEngine.ts';

const firm = DEFAULT_PROP_FIRMS_2026.find((item) => item.id === 'lucid-50k-flex');
assert.ok(firm, 'Lucid 50K Flex fixture must exist');

const account: HedgeRatioAccount = {
  accountId: 'A-1',
  firm,
  accountState: {
    phase: 'evaluation_phase_1',
    cumulativeProfitUsd: 0,
    priorTradingDays: 0,
    priorDailyPnlUsd: [],
  },
  ratio: { min: 0, max: 2, step: 1 },
};

const scenarios: HedgeRatioScenario[] = [
  {
    scenarioId: 'up',
    probability: 0.6,
    outcomes: {
      'A-1': { grossPnlUsd: 100, outcomeType: 'win', accountStatus: 'active', payoutStatus: 'not_eligible' },
    },
  },
  {
    scenarioId: 'down',
    probability: 0.4,
    outcomes: {
      'A-1': { grossPnlUsd: -50, outcomeType: 'loss', accountStatus: 'active', payoutStatus: 'not_eligible' },
    },
  },
];

test('searches the full discrete ratio grid and scales signed scenario P&L', () => {
  const result = optimizeContractAwareHedgeRatios([account], scenarios);
  assert.equal(result.status, 'optimal');
  assert.equal(result.searchNodes, 3);
  assert.equal(result.feasibleCandidates, 3);
  assert.equal(result.allocation[0].ratio, 2);
  assert.equal(result.scenarioResults[0].combinedGrossPnlUsd, 200);
  assert.equal(result.scenarioResults[1].combinedGrossPnlUsd, -100);
  assert.equal(result.metrics?.expectedCombinedGrossPnlUsd, 80);
  assert.equal(result.metrics?.probabilityOfCombinedLoss, 0.4);
});

test('enforces worst-case loss constraints before selecting a ratio vector', () => {
  const result = optimizeContractAwareHedgeRatios([account], scenarios, {
    constraints: { maxWorstCaseCombinedLossUsd: 50 },
  });
  assert.equal(result.status, 'optimal');
  assert.equal(result.allocation[0].ratio, 1);
  assert.equal(result.metrics?.worstCaseCombinedLossUsd, 50);
});

test('supports account-specific asymmetric hedge ratios', () => {
  const second: HedgeRatioAccount = {
    ...account,
    accountId: 'B-1',
    ratio: { min: 0, max: 1, step: 1 },
  };
  const jointScenarios: HedgeRatioScenario[] = scenarios.map((scenario) => ({
    ...scenario,
    outcomes: {
      ...scenario.outcomes,
      'B-1': {
        ...scenario.outcomes['A-1'],
        grossPnlUsd: -scenario.outcomes['A-1'].grossPnlUsd * 0.5,
      },
    },
  }));
  const result = optimizeContractAwareHedgeRatios([account, second], jointScenarios);
  assert.equal(result.status, 'optimal');
  assert.equal(result.allocation.length, 2);
  assert.equal(result.searchNodes, 6);
  assert.equal(result.scenarioResults.length, 2);
});

test('returns infeasible when no ratio vector meets the loss-probability constraint', () => {
  const result = optimizeContractAwareHedgeRatios([account], scenarios, {
    constraints: { maxProbabilityOfCombinedLoss: 0.3 },
  });
  assert.equal(result.status, 'infeasible');
  assert.equal(result.allocation.length, 0);
  assert.equal(result.metrics, null);
});

test('refuses to claim optimality when the exhaustive search limit is exceeded', () => {
  assert.throws(
    () => optimizeContractAwareHedgeRatios([account], scenarios, {
      constraints: { maxSearchNodes: 2 },
    }),
    /search limit exceeded.*no optimality claim/i,
  );
});

test('rejects invalid scenario probability totals and non-divisible ratio grids', () => {
  assert.throws(
    () => optimizeContractAwareHedgeRatios([account], [{ ...scenarios[0], probability: 0.5 }]),
    /probabilities must sum to 1/,
  );
  assert.throws(
    () => optimizeContractAwareHedgeRatios(
      [{ ...account, ratio: { min: 0, max: 1, step: 0.3 } }],
      scenarios,
    ),
    /range must be divisible by step/,
  );
});

test('rejects missing account outcomes in a joint scenario', () => {
  assert.throws(
    () => optimizeContractAwareHedgeRatios(
      [account],
      [{ scenarioId: 'missing', probability: 1, outcomes: {} }],
    ),
    /missing account "A-1"/,
  );
});
