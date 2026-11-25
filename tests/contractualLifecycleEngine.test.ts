import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROP_FIRMS_2026 } from '../src/data/propFirms2026.ts';
import {
  runContractualLifecycleSimulation,
  type LifecycleAccountConfig,
  type LifecycleScenario,
} from '../src/utils/contractualLifecycleEngine.ts';

const original = DEFAULT_PROP_FIRMS_2026.find((item) => item.id === 'lucid-50k-flex');
assert.ok(original);
const firm = {
  ...original,
  evaluationRules: {
    ...original.evaluationRules,
    phase1TargetUsd: { ...original.evaluationRules.phase1TargetUsd, value: 100, status: 'verified' as const },
    minTradingDays: { ...original.evaluationRules.minTradingDays, value: 1, status: 'verified' as const },
    consistency: { ...original.evaluationRules.consistency, methodology: 'none' as const },
    dailyLossLimit: { ...original.evaluationRules.dailyLossLimit, methodology: 'none' as const },
    maxDrawdown: { ...original.evaluationRules.maxDrawdown, methodology: 'static' as const, amountUsd: { ...original.evaluationRules.maxDrawdown.amountUsd, value: 1000, status: 'verified' as const }, basis: 'balance' as const },
  },
  fundedRules: {
    ...original.fundedRules,
    dailyLossLimit: { ...original.fundedRules.dailyLossLimit, methodology: 'none' as const },
    maxDrawdown: { ...original.fundedRules.maxDrawdown, methodology: 'static' as const, amountUsd: { ...original.fundedRules.maxDrawdown.amountUsd, value: 1000, status: 'verified' as const }, basis: 'balance' as const },
    payoutCycleDays: { ...original.fundedRules.payoutCycleDays, value: 1, status: 'verified' as const },
    minProfitableDays: { ...original.fundedRules.minProfitableDays, value: 1, status: 'verified' as const },
    minDailyProfitUsd: { ...original.fundedRules.minDailyProfitUsd, value: 1, status: 'verified' as const },
    profitBufferUsd: { ...original.fundedRules.profitBufferUsd, value: 0, status: 'verified' as const },
    minWithdrawalUsd: { ...original.fundedRules.minWithdrawalUsd, value: 1, status: 'verified' as const },
    maxPayoutUsd: { ...original.fundedRules.maxPayoutUsd, value: 1000, status: 'verified' as const },
    maxWithdrawalPct: { ...original.fundedRules.maxWithdrawalPct, value: 100, status: 'verified' as const },
    consistency: { ...original.fundedRules.consistency, methodology: 'none' as const },
  },
};

const account: LifecycleAccountConfig = {
  accountId: 'A-1', firm, initialPhase: 'evaluation_phase_1',
};
function scenario(id: string, pnl: number, overrides: Partial<LifecycleScenario['accounts']['A-1']['path']> = {}): LifecycleScenario {
  return {
    scenarioId: id,
    accounts: {
      'A-1': {
        outcome: { grossPnlUsd: pnl, outcomeType: pnl >= 0 ? 'win' : 'loss', accountStatus: 'active', payoutStatus: 'not_eligible' },
        path: { dailyPnlUsd: pnl, sessionId: 'session-1', ...overrides },
      },
    },
  };
}

test('evaluation phase advances when target, minimum days and consistency are met', () => {
  const result = runContractualLifecycleSimulation({ accounts: [account], scenarios: [scenario('pass', 100)] });
  assert.equal(result.terminalAccounts['A-1'].phase, 'evaluation_phase_2');
  assert.equal(result.transitions[0].to, 'evaluation_phase_2');
});

test('static drawdown breach is absorbing and prevents phase progression', () => {
  const result = runContractualLifecycleSimulation({ accounts: [account], scenarios: [scenario('loss', -1000)] });
  assert.equal(result.terminalAccounts['A-1'].status, 'breached');
  assert.equal(result.terminalAccounts['A-1'].balanceUsd, 49000);
  assert.equal(result.terminalAccounts['A-1'].equityUsd, 49000);
  assert.equal(result.terminalAccounts['A-1'].cumulativeProfitUsd, -1000);
  assert.match(result.steps[0].violationReason ?? '', /max_drawdown/);
  assert.equal(result.transitions[0].to, 'breached');
});

test('session ID change resets the daily loss baseline', () => {
  const dailyLossFirm = {
    ...firm,
    evaluationRules: {
      ...firm.evaluationRules,
      dailyLossLimit: { ...firm.evaluationRules.dailyLossLimit, methodology: 'balance_based' as const, amountUsd: { ...firm.evaluationRules.dailyLossLimit.amountUsd, value: 100, status: 'verified' as const } },
    },
  };
  const result = runContractualLifecycleSimulation({
    accounts: [{ ...account, firm: dailyLossFirm }],
    scenarios: [scenario('day-1', -60), scenario('day-2', -60, { sessionId: 'session-2' })],
  });
  assert.equal(result.terminalAccounts['A-1'].status, 'active');
  assert.equal(result.steps[1].dailyLossUsedUsd, 60);
});

test('trailing EOD high-water mark ratchets the drawdown floor', () => {
  const trailingFirm = {
    ...firm,
    evaluationRules: {
      ...firm.evaluationRules,
      maxDrawdown: { ...firm.evaluationRules.maxDrawdown, methodology: 'trailing_eod' as const, amountUsd: { ...firm.evaluationRules.maxDrawdown.amountUsd, value: 100, status: 'verified' as const }, basis: 'balance' as const },
    },
  };
  const result = runContractualLifecycleSimulation({
    accounts: [{ ...account, firm: trailingFirm }],
    scenarios: [scenario('gain', 200), scenario('giveback', -150)],
  });
  assert.equal(result.steps[0].drawdownFloorUsd, 50100);
  assert.equal(result.terminalAccounts['A-1'].status, 'breached');
});

test('realized withdrawals require a payout opportunity and reset the payout cycle', () => {
  const fundedAccount: LifecycleAccountConfig = { ...account, initialPhase: 'funded', initialBalanceUsd: 50100, initialEquityUsd: 50100, initialCumulativeProfitUsd: 100 };
  const payoutScenario: LifecycleScenario = {
    scenarioId: 'withdraw',
    accounts: {
      'A-1': {
        outcome: { grossPnlUsd: 100, outcomeType: 'win', accountStatus: 'active', payoutStatus: 'approved' },
        path: { dailyPnlUsd: 100, sessionId: 'session-1', realizedPayoutUsd: 50 },
      },
    },
  };
  const result = runContractualLifecycleSimulation({ accounts: [fundedAccount], scenarios: [payoutScenario] });
  assert.equal(result.totalRealizedPayoutUsd, 50);
  assert.equal(result.terminalAccounts['A-1'].payoutCycleElapsedDays, 0);
  assert.equal(result.terminalAccounts['A-1'].balanceUsd, 50150);
});

test('fails closed when drawdown methodology is unknown', () => {
  const unknownFirm = {
    ...firm,
    evaluationRules: {
      ...firm.evaluationRules,
      maxDrawdown: { ...firm.evaluationRules.maxDrawdown, methodology: 'trailing_intraday' as const, amountUsd: { ...firm.evaluationRules.maxDrawdown.amountUsd, status: 'missing' as const, value: null } },
    },
  };
  assert.throws(() => runContractualLifecycleSimulation({ accounts: [{ ...account, firm: unknownFirm }], scenarios: [scenario('x', 1)] }), /missing or invalid/);
});
