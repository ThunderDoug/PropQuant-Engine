import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runPortfolioSurvivalAnalysis,
  type PortfolioSurvivalConfig,
} from '../src/utils/portfolioSurvivalEngine.ts';
import type { JointScenarioTemplate } from '../src/utils/jointScenarioEngine.ts';

const accounts = [
  { accountId: 'A-1', firmId: 'firm-a', maxLossUsd: 1000 },
  { accountId: 'B-1', firmId: 'firm-b', maxLossUsd: 1000 },
];

function makeConfig(
  scenarios: JointScenarioTemplate[],
  overrides: Partial<PortfolioSurvivalConfig> = {}
): PortfolioSurvivalConfig {
  return {
    accounts,
    scenarios,
    iterations: 100,
    horizonPeriods: 3,
    seed: 42,
    ...overrides,
  };
}

const flatScenario: JointScenarioTemplate = {
  scenarioId: 'flat',
  probability: 1,
  marketEvent: 'quiet-market',
  commonShockId: null,
  outcomes: {
    'A-1': {
      grossPnlUsd: 10,
      outcomeType: 'win',
      accountStatus: 'active',
      payoutStatus: 'not_eligible',
    },
    'B-1': {
      grossPnlUsd: -5,
      outcomeType: 'partial_loss',
      accountStatus: 'active',
      payoutStatus: 'not_eligible',
    },
  },
};

test('all accounts and portfolio survive a deterministic non-breach horizon', () => {
  const result = runPortfolioSurvivalAnalysis(makeConfig([flatScenario]));
  assert.equal(result.portfolioSurvivalProbability, 1);
  assert.equal(result.portfolioFailureProbability, 0);
  assert.equal(result.accountSurvival['A-1'].survivalProbability, 1);
  assert.equal(result.accountSurvival['B-1'].survivalProbability, 1);
  assert.equal(result.meanPeriodsSurvived, 3);
});

test('account failure is absorbing and reduces account and firm survival', () => {
  const scenario: JointScenarioTemplate = {
    scenarioId: 'breach-a',
    probability: 1,
    marketEvent: 'firm-a-account-breach',
    outcomes: {
      'A-1': {
        grossPnlUsd: -100,
        outcomeType: 'loss',
        accountStatus: 'breached',
        payoutStatus: 'blocked',
      },
      'B-1': {
        grossPnlUsd: 0,
        outcomeType: 'flat',
        accountStatus: 'active',
        payoutStatus: 'not_eligible',
      },
    },
  };
  const result = runPortfolioSurvivalAnalysis(
    makeConfig([scenario], { horizonPeriods: 4, minimumActiveAccounts: 1 })
  );
  assert.equal(result.accountSurvival['A-1'].survivalProbability, 0);
  assert.equal(result.accountSurvival['B-1'].survivalProbability, 1);
  assert.equal(result.portfolioSurvivalProbability, 1);
  assert.equal(result.firmSurvival['firm-a'].allAccountsSurvivalProbability, 0);
});

test('portfolio fails when its configured loss limit is breached', () => {
  const scenario: JointScenarioTemplate = {
    scenarioId: 'loss',
    probability: 1,
    marketEvent: 'shared-down-move',
    commonShockId: 'shock-1',
    outcomes: {
      'A-1': {
        grossPnlUsd: -600,
        outcomeType: 'loss',
        accountStatus: 'active',
        payoutStatus: 'not_eligible',
      },
      'B-1': {
        grossPnlUsd: -500,
        outcomeType: 'loss',
        accountStatus: 'active',
        payoutStatus: 'not_eligible',
      },
    },
  };
  const result = runPortfolioSurvivalAnalysis(
    makeConfig([scenario], { maxPortfolioLossUsd: 1000 })
  );
  assert.equal(result.portfolioSurvivalProbability, 0);
  assert.equal(result.portfolioFailureCauseCounts.portfolio_loss_limit, 100);
});

test('joint scenario sampling preserves shared-shock account failures', () => {
  const scenario: JointScenarioTemplate = {
    scenarioId: 'shared-breach',
    probability: 1,
    marketEvent: 'correlated-loss',
    commonShockId: 'systemic-1',
    outcomes: {
      'A-1': {
        grossPnlUsd: -100,
        outcomeType: 'loss',
        accountStatus: 'breached',
        payoutStatus: 'blocked',
      },
      'B-1': {
        grossPnlUsd: -100,
        outcomeType: 'loss',
        accountStatus: 'breached',
        payoutStatus: 'blocked',
      },
    },
  };
  const result = runPortfolioSurvivalAnalysis(makeConfig([scenario]));
  assert.equal(result.pairwiseFailures[0].jointFailureProbability, 1);
  assert.equal(
    result.pairwiseFailures[0].conditionalFailureProbabilityA_given_B,
    1
  );
});

test('seeded replay is deterministic', () => {
  const scenarios: JointScenarioTemplate[] = [
    flatScenario,
    {
      scenarioId: 'stress',
      probability: 0,
      marketEvent: 'stress',
      outcomes: {
        'A-1': {
          grossPnlUsd: -50,
          outcomeType: 'loss',
          accountStatus: 'active',
          payoutStatus: 'not_eligible',
        },
        'B-1': {
          grossPnlUsd: -50,
          outcomeType: 'loss',
          accountStatus: 'active',
          payoutStatus: 'not_eligible',
        },
      },
    },
  ];
  const first = runPortfolioSurvivalAnalysis(makeConfig(scenarios));
  const second = runPortfolioSurvivalAnalysis(makeConfig(scenarios));
  assert.deepEqual(first, second);
});

test('rejects invalid loss limits, probability matrices and iteration counts', () => {
  assert.throws(
    () => runPortfolioSurvivalAnalysis(makeConfig([flatScenario], { iterations: 0 })),
    /iterations/
  );
  assert.throws(
    () =>
      runPortfolioSurvivalAnalysis(
        makeConfig([flatScenario], {
          accounts: [{ accountId: 'A-1', firmId: 'firm-a', maxLossUsd: 0 }, accounts[1]],
        })
      ),
    /maxLossUsd/
  );
  assert.throws(
    () =>
      runPortfolioSurvivalAnalysis(
        makeConfig([{ ...flatScenario, probability: 0.5 }])
      ),
    /probabilities must sum to 1/
  );
});

test('account loss limit triggers an account breach without relying on status input', () => {
  const lossScenario: JointScenarioTemplate = {
    scenarioId: 'loss-limit',
    probability: 1,
    marketEvent: 'loss-limit-event',
    outcomes: {
      'A-1': {
        grossPnlUsd: -1000,
        outcomeType: 'loss',
        accountStatus: 'active',
        payoutStatus: 'not_eligible',
      },
      'B-1': {
        grossPnlUsd: 0,
        outcomeType: 'flat',
        accountStatus: 'active',
        payoutStatus: 'not_eligible',
      },
    },
  };
  const result = runPortfolioSurvivalAnalysis(makeConfig([lossScenario]));
  assert.equal(result.accountSurvival['A-1'].failureProbability, 1);
  assert.equal(result.accountSurvival['A-1'].failureCauseCounts.account_loss_limit, 100);
});
