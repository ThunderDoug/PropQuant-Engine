import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runJointScenarioSimulation,
  sampleJointScenario,
  validateJointScenarioMatrix,
  type JointAccountDefinition,
  type JointScenarioTemplate,
} from '../src/utils/jointScenarioEngine.ts';

const accounts: JointAccountDefinition[] = [
  { accountId: 'A-1', firmId: 'Firm-A' },
  { accountId: 'B-1', firmId: 'Firm-B' },
];

const scenarios: JointScenarioTemplate[] = [
  {
    scenarioId: 'win-win',
    probability: 0.25,
    marketEvent: 'normal-positive',
    outcomes: {
      'A-1': {
        grossPnlUsd: 500,
        outcomeType: 'win',
        accountStatus: 'active',
        payoutStatus: 'eligible',
      },
      'B-1': {
        grossPnlUsd: 400,
        outcomeType: 'win',
        accountStatus: 'active',
        payoutStatus: 'eligible',
      },
    },
  },
  {
    scenarioId: 'win-loss',
    probability: 0.25,
    marketEvent: 'directional-move',
    outcomes: {
      'A-1': {
        grossPnlUsd: 500,
        outcomeType: 'win',
        accountStatus: 'active',
        payoutStatus: 'eligible',
      },
      'B-1': {
        grossPnlUsd: -400,
        outcomeType: 'loss',
        accountStatus: 'active',
        payoutStatus: 'not_eligible',
      },
    },
  },
  {
    scenarioId: 'loss-win',
    probability: 0.25,
    marketEvent: 'reversal',
    outcomes: {
      'A-1': {
        grossPnlUsd: -500,
        outcomeType: 'loss',
        accountStatus: 'active',
        payoutStatus: 'not_eligible',
      },
      'B-1': {
        grossPnlUsd: 400,
        outcomeType: 'win',
        accountStatus: 'active',
        payoutStatus: 'eligible',
      },
    },
  },
  {
    scenarioId: 'common-failure',
    probability: 0.25,
    marketEvent: 'systemic-adverse',
    commonShockId: 'shock-001',
    outcomes: {
      'A-1': {
        grossPnlUsd: -1000,
        outcomeType: 'loss',
        accountStatus: 'breached',
        payoutStatus: 'blocked',
      },
      'B-1': {
        grossPnlUsd: -800,
        outcomeType: 'loss',
        accountStatus: 'breached',
        payoutStatus: 'blocked',
      },
    },
  },
];

test('validates complete joint matrices and normalized probabilities', () => {
  const result = validateJointScenarioMatrix(accounts, scenarios);
  assert.equal(result.isValid, true);
  assert.equal(result.probabilityTotal, 1);
  assert.deepEqual(result.errors, []);
});

test('rejects missing accounts and probability totals different from one', () => {
  const invalid = [
    {
      ...scenarios[0],
      probability: 0.2,
      outcomes: { 'A-1': scenarios[0].outcomes['A-1'] },
    },
  ];
  const result = validateJointScenarioMatrix(accounts, invalid);
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((error) => error.includes('must sum to 1')));
  assert.ok(result.errors.some((error) => error.includes('missing account "B-1"')));
});

test('samples a complete portfolio outcome, preserving common shock metadata', () => {
  const sampled = sampleJointScenario(scenarios, () => 0.99);
  assert.equal(sampled.scenarioId, 'common-failure');
  assert.equal(sampled.commonShockId, 'shock-001');
  assert.equal(sampled.outcomes['A-1'].accountStatus, 'breached');
  assert.equal(sampled.outcomes['B-1'].payoutStatus, 'blocked');
});

test('replays identical results with the same seed', () => {
  const first = runJointScenarioSimulation(accounts, scenarios, 500, 12345);
  const second = runJointScenarioSimulation(accounts, scenarios, 500, 12345);
  assert.deepEqual(first, second);
  assert.equal(first.iterations, 500);
  assert.equal(first.seedUsed, 12345);
});

test('tracks marginal account outcomes from the sampled joint paths', () => {
  const result = runJointScenarioSimulation(accounts, scenarios, 1000, 77);
  for (const account of accounts) {
    const counts = result.accountOutcomeCounts[account.accountId];
    assert.equal(
      Object.values(counts).reduce((total, count) => total + count, 0),
      1000
    );
  }
  assert.equal(
    Object.values(result.scenarioCounts).reduce((total, count) => total + count, 0),
    1000
  );
});

test('rejects invalid iteration counts and invalid random values', () => {
  assert.throws(
    () => runJointScenarioSimulation(accounts, scenarios, 0, 1),
    /positive integer/
  );
  assert.throws(() => sampleJointScenario(scenarios, () => 1), /\[0, 1\)/);
});
