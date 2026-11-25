import test from 'node:test';
import assert from 'node:assert/strict';
import {
  optimizeMultiFirmCapitalAllocation,
  type CapitalAllocationCandidate,
  type CapitalAllocationScenario,
} from '../src/utils/multiFirmCapitalAllocationEngine.ts';

const candidates: CapitalAllocationCandidate[] = [
  { candidateId: 'a', accountId: 'a-1', firmId: 'firm-a', capitalRequiredUsd: 100, maxUnits: 2 },
  { candidateId: 'b', accountId: 'b-1', firmId: 'firm-b', capitalRequiredUsd: 100, maxUnits: 2 },
  { candidateId: 'c', accountId: 'c-1', firmId: 'firm-c', capitalRequiredUsd: 100, maxUnits: 1 },
];

const scenarios: CapitalAllocationScenario[] = [
  {
    scenarioId: 'base',
    probability: 0.8,
    outcomes: {
      a: { netPnlUsd: 80, survives: true },
      b: { netPnlUsd: 65, survives: true },
      c: { netPnlUsd: 50, survives: true },
    },
  },
  {
    scenarioId: 'stress',
    probability: 0.2,
    outcomes: {
      a: { netPnlUsd: -120, survives: false },
      b: { netPnlUsd: -20, survives: true },
      c: { netPnlUsd: -10, survives: true },
    },
  },
];

test('maximizes expected net P&L under a capital budget', () => {
  const result = optimizeMultiFirmCapitalAllocation(candidates, scenarios, {
    capitalBudgetUsd: 200,
  });
  assert.equal(result.status, 'optimal');
  assert.equal(result.committedCapitalUsd, 200);
  assert.equal(result.expectedNetPnlUsd, 96);
  assert.deepEqual(result.allocation.map((line) => line.candidateId), ['b']);
  assert.equal(result.allocation[0].units, 2);
});

test('enforces firm concentration and minimum firm diversification', () => {
  const result = optimizeMultiFirmCapitalAllocation(candidates, scenarios, {
    capitalBudgetUsd: 200,
    maxFirmCapitalSharePct: 50,
    minimumDistinctFirms: 2,
  });
  assert.equal(result.status, 'optimal');
  assert.equal(new Set(result.allocation.map((line) => line.firmId)).size, 2);
  assert.ok(result.allocation.every((line) => line.committedCapitalUsd <= 100));
});

test('enforces portfolio survival and loss-probability constraints', () => {
  const result = optimizeMultiFirmCapitalAllocation(candidates, scenarios, {
    capitalBudgetUsd: 200,
    minimumPortfolioSurvivalProbability: 0.8,
    maximumProbabilityOfLoss: 0.2,
  });
  assert.equal(result.status, 'optimal');
  assert.ok(result.portfolioSurvivalProbability >= 0.8);
  assert.ok(result.probabilityOfLoss <= 0.2);
  assert.ok(!result.allocation.some((line) => line.candidateId === 'a'));
});

test('uses CVaR risk aversion and capital opportunity cost in the objective', () => {
  const result = optimizeMultiFirmCapitalAllocation(candidates, scenarios, {
    capitalBudgetUsd: 200,
    riskAversion: 0.5,
    capitalCostRate: 0.1,
  });
  assert.equal(result.status, 'optimal');
  assert.ok(result.conditionalValueAtRiskLossUsd >= 0);
  assert.equal(result.capitalOpportunityCostUsd, result.committedCapitalUsd * 0.1);
  assert.equal(
    result.objectiveValueUsd,
    result.expectedNetPnlUsd - 0.5 * result.conditionalValueAtRiskLossUsd
  );
});

test('returns infeasible when hard constraints cannot be satisfied', () => {
  const result = optimizeMultiFirmCapitalAllocation(candidates, scenarios, {
    capitalBudgetUsd: 100,
    minimumDistinctFirms: 2,
    minimumPortfolioSurvivalProbability: 1,
  });
  assert.equal(result.status, 'infeasible');
  assert.deepEqual(result.allocation, []);
});

test('rejects incomplete or invalid joint scenario matrices', () => {
  assert.throws(
    () => optimizeMultiFirmCapitalAllocation(candidates, [{ ...scenarios[0], probability: 0.5 }], {
      capitalBudgetUsd: 200,
    }),
    /probabilities must sum to 1/
  );
  assert.throws(
    () => optimizeMultiFirmCapitalAllocation(candidates, [{
      ...scenarios[0],
      outcomes: { a: scenarios[0].outcomes.a, c: scenarios[0].outcomes.c },
    }, scenarios[1]], { capitalBudgetUsd: 200 }),
    /missing candidate "b"/
  );
  assert.throws(
    () => optimizeMultiFirmCapitalAllocation(candidates, scenarios, {
      capitalBudgetUsd: 200,
      maxSearchNodes: 1,
    }),
    /exceeded maxSearchNodes/
  );
});

test('capital cost and scenario payoffs are evaluated for the complete selected portfolio', () => {
  const result = optimizeMultiFirmCapitalAllocation(candidates, scenarios, {
    capitalBudgetUsd: 100,
    capitalCostRate: 0.05,
  });
  assert.equal(result.status, 'optimal');
  assert.equal(result.committedCapitalUsd, 100);
  assert.equal(result.capitalOpportunityCostUsd, 5);
  assert.equal(result.scenarioNetPnlUsd.base, 60);
  assert.equal(result.scenarioNetPnlUsd.stress, -25);
  assert.equal(result.scenarioSurvival.stress, true);
});
