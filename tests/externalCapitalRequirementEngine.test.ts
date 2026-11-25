import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMinimumExternalCapital,
  type ExternalCapitalScenario,
} from '../src/utils/externalCapitalRequirementEngine.ts';

const scenarios: ExternalCapitalScenario[] = [
  {
    scenarioId: 'contained-drawdown',
    probability: 0.7,
    periods: [
      { period: 1, netCashFlowUsd: -200 },
      { period: 2, netCashFlowUsd: 300 },
    ],
  },
  {
    scenarioId: 'deep-temporary-drawdown',
    probability: 0.2,
    periods: [
      { period: 1, netCashFlowUsd: -1200 },
      { period: 2, netCashFlowUsd: 500 },
    ],
  },
  {
    scenarioId: 'severe-drawdown',
    probability: 0.1,
    periods: [
      { period: 1, netCashFlowUsd: -2000 },
      { period: 2, netCashFlowUsd: 500 },
    ],
  },
];

test('calculates pathwise external funding from the peak cumulative deficit', () => {
  const result = calculateMinimumExternalCapital(scenarios, {
    availableCapitalUsd: 1000,
    minimumReserveUsd: 100,
    confidenceLevel: 0.8,
    externalFundingBudgetUsd: 500,
  });

  assert.equal(result.modeledPeriods, 2);
  assert.equal(result.scenarios[0].externalCapitalRequiredUsd, 0);
  assert.equal(result.scenarios[1].peakCumulativeCashDeficitUsd, 1200);
  assert.equal(result.scenarios[1].requiredStartingCapitalUsd, 1300);
  assert.equal(result.scenarios[1].externalCapitalRequiredUsd, 300);
  assert.equal(result.scenarios[2].externalCapitalRequiredUsd, 1100);
  assert.equal(result.scenarios[2].periodOfPeakDeficit, 1);
});

test('reports weighted funding quantile, tail mean, and budget coverage', () => {
  const result = calculateMinimumExternalCapital(scenarios, {
    availableCapitalUsd: 1000,
    minimumReserveUsd: 100,
    confidenceLevel: 0.8,
    externalFundingBudgetUsd: 500,
  });

  assert.equal(result.recommendedExternalCapitalUsd, 300);
  assert.equal(result.valueAtRiskFundingRequirementUsd, 300);
  assert.equal(result.conditionalTailMeanFundingRequirementUsd, 700);
  assert.equal(result.expectedExternalCapitalRequiredUsd, 170);
  assert.equal(result.probabilityAvailableCapitalIsSufficient, 0.7);
  assert.equal(result.probabilityOfFundingShortfall, 0.3);
  assert.equal(result.probabilityFundingBudgetIsSufficient, 0.9);
  assert.equal(result.maximumFundingGapUsd, 600);
  assert.equal(result.status, 'funding_shortfall');
});

test('does not treat positive ending cash as proof of survival through the path', () => {
  const result = calculateMinimumExternalCapital([
    {
      scenarioId: 'temporary-insolvency',
      probability: 1,
      periods: [
        { period: 1, netCashFlowUsd: -1500 },
        { period: 2, netCashFlowUsd: 2000 },
      ],
    },
  ], { availableCapitalUsd: 1000 });

  assert.equal(result.scenarios[0].endingCashBalanceUsd, 1500);
  assert.equal(result.scenarios[0].minimumCashBalanceUsd, -500);
  assert.equal(result.scenarios[0].survivesWithAvailableCapital, false);
  assert.equal(result.scenarios[0].externalCapitalRequiredUsd, 500);
});

test('returns feasible when available cash preserves the required reserve in every scenario', () => {
  const result = calculateMinimumExternalCapital(scenarios, {
    availableCapitalUsd: 2500,
    minimumReserveUsd: 100,
  });
  assert.equal(result.status, 'feasible');
  assert.equal(result.probabilityAvailableCapitalIsSufficient, 1);
  assert.equal(result.probabilityOfFundingShortfall, 0);
});

test('rejects unnormalized joint probabilities and inconsistent horizons', () => {
  assert.throws(
    () => calculateMinimumExternalCapital(
      [{ ...scenarios[0], probability: 0.5 }],
      { availableCapitalUsd: 1000 },
    ),
    /probabilities must sum to 1/,
  );
  assert.throws(
    () => calculateMinimumExternalCapital(
      [scenarios[0], { ...scenarios[1], periods: [{ period: 1, netCashFlowUsd: 0 }] }],
      { availableCapitalUsd: 1000 },
    ),
    /same number of periods/,
  );
});

test('rejects duplicate and non-increasing period indices', () => {
  assert.throws(
    () => calculateMinimumExternalCapital(
      [{
        scenarioId: 'invalid-path',
        probability: 1,
        periods: [
          { period: 2, netCashFlowUsd: -100 },
          { period: 2, netCashFlowUsd: 100 },
        ],
      }],
      { availableCapitalUsd: 1000 },
    ),
    /duplicate period|strictly increasing/,
  );
});
