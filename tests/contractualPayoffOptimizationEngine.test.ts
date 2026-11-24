import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROP_FIRMS_2026 } from '../src/data/propFirms2026.ts';
import type { PropFirmPreset } from '../src/types/quant.ts';
import {
  optimizeContractualPayoffAllocation,
  type ContractAccountSlot,
  type ContractOptimizationScenario,
} from '../src/utils/contractualPayoffOptimizationEngine.ts';

const baseFirm = DEFAULT_PROP_FIRMS_2026.find((item) => item.id === 'apex-50k');
assert.ok(baseFirm, 'Apex 50K fixture must exist');

function contractVariant(
  firmId: string,
  name: string,
  profitBufferUsd: number
): PropFirmPreset {
  return {
    ...baseFirm,
    id: firmId,
    firmId,
    name,
    fundedRules: {
      ...baseFirm.fundedRules,
      profitBufferUsd: {
        ...baseFirm.fundedRules.profitBufferUsd,
        value: profitBufferUsd,
      },
    },
  };
}

const lowBufferFirm = contractVariant('test-low-buffer', 'Low Buffer Contract', 0);
const highBufferFirm = contractVariant('test-high-buffer', 'High Buffer Contract', 3400);

const fundedState = {
  phase: 'funded' as const,
  cumulativeProfitUsd: 3600,
  priorDailyPnlUsd: Array.from({ length: 8 }, () => 450),
};

function slot(accountId: string, alternatives?: ContractAccountSlot['alternatives']): ContractAccountSlot {
  return {
    accountId,
    alternatives: alternatives ?? [
      { alternativeId: 'low-buffer', firm: lowBufferFirm, accountState: fundedState },
      { alternativeId: 'high-buffer', firm: highBufferFirm, accountState: fundedState },
    ],
  };
}

const scenarios: ContractOptimizationScenario[] = [
  {
    scenarioId: 'payout-window-open',
    probability: 0.75,
    outcomes: {
      'A-1': { grossPnlUsd: 0, outcomeType: 'flat', accountStatus: 'active', payoutStatus: 'eligible' },
      'B-1': { grossPnlUsd: 0, outcomeType: 'flat', accountStatus: 'active', payoutStatus: 'eligible' },
    },
  },
  {
    scenarioId: 'payout-restricted',
    probability: 0.25,
    outcomes: {
      'A-1': { grossPnlUsd: 0, outcomeType: 'flat', accountStatus: 'active', payoutStatus: 'blocked' },
      'B-1': { grossPnlUsd: 0, outcomeType: 'flat', accountStatus: 'active', payoutStatus: 'blocked' },
    },
  },
];

test('chooses the contract alternative with the higher expected nonlinear payout', () => {
  const result = optimizeContractualPayoffAllocation(
    [slot('A-1', [
      { alternativeId: 'low-buffer', firm: lowBufferFirm, accountState: fundedState },
      { alternativeId: 'high-buffer', firm: highBufferFirm, accountState: fundedState },
    ])],
    scenarios,
    { constraints: { requireCompleteContracts: false } },
  );

  assert.equal(result.status, 'optimal');
  assert.equal(result.allocation[0].alternativeId, 'low-buffer');
  const low = result.alternativeDiagnostics.find((item) => item.alternativeId === 'low-buffer');
  const high = result.alternativeDiagnostics.find((item) => item.alternativeId === 'high-buffer');
  assert.ok(low && high);
  assert.ok(low.expectedContractualTraderPayoutUsd > high.expectedContractualTraderPayoutUsd);
  assert.equal(result.payoutOpportunityProbability, 0.75);
  assert.equal(result.zeroPayoutProbability, 0.25);
});

test('preserves pending payouts as contractual potential, not realized cash', () => {
  const pendingScenarios: ContractOptimizationScenario[] = [{
    scenarioId: 'pending',
    probability: 1,
    outcomes: {
      'A-1': { grossPnlUsd: 0, outcomeType: 'flat', accountStatus: 'active', payoutStatus: 'pending' },
    },
  }];
  const result = optimizeContractualPayoffAllocation(
    [slot('A-1', [
      { alternativeId: 'low-buffer', firm: lowBufferFirm, accountState: fundedState },
    ])],
    pendingScenarios,
    { constraints: { requireCompleteContracts: false } },
  );
  assert.equal(result.status, 'optimal');
  assert.ok((result.expectedContractualTraderPayoutUsd ?? 0) > 0);
  assert.equal(result.scenarioResults[0].accountResults['A-1'].payoutStatus, 'pending');
  assert.equal(result.scenarioResults[0].accountResults['A-1'].contractualTraderPayoutUsd,
    result.scenarioResults[0].contractualTraderPayoutUsd);
});

test('enforces firm diversification and maximum accounts per firm', () => {
  const result = optimizeContractualPayoffAllocation(
    [slot('A-1'), slot('B-1')],
    scenarios,
    {
      constraints: {
        requireCompleteContracts: false,
        minimumDistinctFirms: 2,
        maximumAccountsPerFirm: 1,
      },
    },
  );
  assert.equal(result.status, 'optimal');
  assert.equal(result.distinctFirmCount, 2);
  assert.equal(new Set(result.allocation.map((line) => line.firmId)).size, 2);
});

test('returns infeasible when payout opportunity constraints cannot be met', () => {
  const result = optimizeContractualPayoffAllocation(
    [slot('A-1', [
      { alternativeId: 'low-buffer', firm: lowBufferFirm, accountState: fundedState },
    ])],
    scenarios,
    {
      constraints: {
        requireCompleteContracts: false,
        minimumPayoutOpportunityProbability: 0.8,
      },
    },
  );
  assert.equal(result.status, 'infeasible');
  assert.equal(result.allocation.length, 0);
  assert.ok(result.reason);
});

test('fails closed by default when a contract is incomplete for simulation', () => {
  const incompleteFirm: PropFirmPreset = {
    ...lowBufferFirm,
    fundedRules: {
      ...lowBufferFirm.fundedRules,
      maxDrawdown: {
        ...lowBufferFirm.fundedRules.maxDrawdown,
        amountUsd: {
          ...lowBufferFirm.fundedRules.maxDrawdown.amountUsd,
          value: null,
          status: 'missing',
          missingReason: 'Test missing critical drawdown rule',
        },
      },
    },
  };
  const result = optimizeContractualPayoffAllocation(
    [slot('A-1', [
      { alternativeId: 'incomplete', firm: incompleteFirm, accountState: fundedState },
    ])],
    scenarios,
  );
  assert.equal(result.status, 'infeasible');
  assert.equal(result.alternativeDiagnostics[0].contractCompletenessProbability, 0);
  assert.deepEqual(result.alternativeDiagnostics[0].incompleteScenarioIds, [
    'payout-window-open',
    'payout-restricted',
  ]);
});

test('rejects invalid joint scenario probabilities and incomplete account coverage', () => {
  assert.throws(
    () => optimizeContractualPayoffAllocation(
      [slot('A-1')],
      [{ ...scenarios[0], probability: 0.5 }],
      { constraints: { requireCompleteContracts: false } },
    ),
    /probabilities must sum to 1/,
  );
  assert.throws(
    () => optimizeContractualPayoffAllocation(
      [slot('A-1')],
      [{ scenarioId: 'missing-account', probability: 1, outcomes: {} }],
      { constraints: { requireCompleteContracts: false } },
    ),
    /missing account "A-1"/,
  );
});

test('refuses to claim optimality after the exhaustive search node limit', () => {
  assert.throws(
    () => optimizeContractualPayoffAllocation(
      [slot('A-1'), slot('B-1')],
      scenarios,
      { constraints: { requireCompleteContracts: false, maxSearchNodes: 2 } },
    ),
    /search limit exceeded.*no optimality claim/i,
  );
});
