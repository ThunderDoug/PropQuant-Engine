import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROP_FIRMS_2026 } from '../src/data/propFirms2026.ts';
import {
  calculateContractualPayoff,
  evaluateJointScenarioContractualPayoffs,
  type ContractualPayoffInput,
} from '../src/utils/contractualPayoffEngine.ts';
import type { JointScenarioDefinition } from '../src/utils/contractualPayoffEngine.ts';

const firm = DEFAULT_PROP_FIRMS_2026.find((item) => item.id === 'apex-50k');
assert.ok(firm, 'Apex 50K fixture must exist');

function fundedInput(overrides: Partial<ContractualPayoffInput> = {}): ContractualPayoffInput {
  return {
    firm,
    accountState: {
      phase: 'funded',
      cumulativeProfitUsd: 3600,
      priorDailyPnlUsd: Array.from({ length: 8 }, () => 450),
    },
    scenarioOutcome: {
      grossPnlUsd: 0,
      outcomeType: 'flat',
      accountStatus: 'active',
      payoutStatus: 'eligible',
    },
    ...overrides,
  };
}

test('applies nonlinear funded payout buffer, withdrawal cap and profit split', () => {
  const result = calculateContractualPayoff(fundedInput());
  assert.equal(result.payoutContractuallyEligible, true);
  assert.equal(result.contractualTraderPayoutUsd, 900);
  assert.equal(result.grossWithdrawableUsd, 1000);
  assert.equal(result.retainedAccountProfitUsd, 2600);
});

test('does not pay an account marked breached even when gross profit is positive', () => {
  const result = calculateContractualPayoff(
    fundedInput({
      scenarioOutcome: {
        grossPnlUsd: 1000,
        outcomeType: 'win',
        accountStatus: 'breached',
        payoutStatus: 'eligible',
      },
    })
  );
  assert.equal(result.contractualTraderPayoutUsd, 0);
  assert.equal(result.payoutPermittedByScenarioStatus, false);
});

test('scenario payout restrictions override otherwise eligible contract economics', () => {
  const result = calculateContractualPayoff(
    fundedInput({
      scenarioOutcome: {
        grossPnlUsd: 0,
        outcomeType: 'flat',
        accountStatus: 'active',
        payoutStatus: 'blocked',
      },
    })
  );
  assert.equal(result.payoutContractuallyEligible, true);
  assert.equal(result.contractualTraderPayoutUsd, 0);
  assert.equal(result.payoutPermittedByScenarioStatus, false);
});

test('keeps pending and approved payouts as contractual amounts, not realized cash', () => {
  const pending = calculateContractualPayoff(
    fundedInput({
      scenarioOutcome: {
        grossPnlUsd: 0,
        outcomeType: 'flat',
        accountStatus: 'active',
        payoutStatus: 'pending',
      },
    })
  );
  assert.equal(pending.contractualTraderPayoutUsd, 900);
  assert.equal(pending.payoutStatus, 'pending');
});

test('evaluation phase has no withdrawal and checks target, minimum days and consistency', () => {
  const result = calculateContractualPayoff({
    firm,
    accountState: {
      phase: 'evaluation_phase_1',
      cumulativeProfitUsd: 3000,
      priorDailyPnlUsd: [1500],
      priorTradingDays: 1,
    },
    scenarioOutcome: {
      grossPnlUsd: 1500,
      outcomeType: 'win',
      accountStatus: 'active',
      payoutStatus: 'not_eligible',
    },
  });
  assert.equal(result.phasePassed, true);
  assert.equal(result.contractualTraderPayoutUsd, 0);
});

test('joint scenario evaluator aggregates independent firm contracts by account', () => {
  const scenario: JointScenarioDefinition = {
    scenarioId: 'pair-win',
    outcomes: {
      'A-1': {
        grossPnlUsd: 0,
        outcomeType: 'flat',
        accountStatus: 'active',
        payoutStatus: 'eligible',
      },
      'B-1': {
        grossPnlUsd: -100,
        outcomeType: 'loss',
        accountStatus: 'active',
        payoutStatus: 'blocked',
      },
    },
  };
  const summary = evaluateJointScenarioContractualPayoffs(
    scenario,
    [
      {
        accountId: 'A-1',
        firmId: firm.firmId,
        state: {
          phase: 'funded',
          cumulativeProfitUsd: 3600,
          priorDailyPnlUsd: Array.from({ length: 8 }, () => 450),
        },
      },
      {
        accountId: 'B-1',
        firmId: firm.firmId,
        state: {
          phase: 'funded',
          cumulativeProfitUsd: 0,
          priorDailyPnlUsd: [],
        },
      },
    ],
    { [firm.firmId]: firm }
  );
  assert.equal(summary.accountsContractuallyPayoutEligible, 1);
  assert.equal(summary.accountsWithZeroContractualPayout, 1);
  assert.equal(summary.totalPotentialTraderPayoutUsd, 900);
});

test('rejects missing firm contracts and missing account outcomes', () => {
  const scenario: JointScenarioDefinition = { scenarioId: 'bad', outcomes: {} };
  assert.throws(
    () =>
      evaluateJointScenarioContractualPayoffs(
        scenario,
        [{ accountId: 'A-1', firmId: 'missing', state: { phase: 'funded', cumulativeProfitUsd: 0 } }],
        {}
      ),
    /Missing firm contract/
  );
});
