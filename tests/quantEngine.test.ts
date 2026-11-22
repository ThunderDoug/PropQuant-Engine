import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_PROP_FIRMS_2026 } from '../src/data/propFirms2026.ts';
import type { ArbitrageInputs, DailyTradeEntry, PropFirmPreset } from '../src/types/quant.ts';
import {
  buildFirmPreset,
  makeConsistencyRule,
  makeDrawdownRule,
  makeMissing,
} from '../src/utils/contractual.ts';
import {
  calculateArbitrage,
  calculateArbitragePayoffCurve,
  calculateCapitalBonus,
  calculateFundedMethod101,
  calculateStepPreview,
  calculateTradeSizing,
  calculateTradeSizingSensitivityMatrix,
  computePhaseDrawdownFloor,
  evaluateConsistency,
  evaluatePayoutEligibility,
  exportSimulationsToCsv,
  generateApprovalTrajectory,
  roundCurrency,
  runDailySimulation,
  runMonteCarloSimulation,
} from '../src/utils/quantEngine.ts';

function makeTestFirm(overrides?: Partial<PropFirmPreset>): PropFirmPreset {
  const base = DEFAULT_PROP_FIRMS_2026.find((f) => f.id === 'lucid-50k-flex') ?? DEFAULT_PROP_FIRMS_2026[0];
  return { ...base, ...overrides };
}

describe('Quant Engine — Financial Precision & Input Validation', () => {
  it('rounds currency without IEEE-754 negative zero or cent drift', () => {
    assert.equal(roundCurrency(0.1 + 0.2), 0.3);
    assert.equal(roundCurrency(1.005), 1.01);
    assert.equal(Object.is(roundCurrency(-0.0001), -0), false);
    assert.equal(roundCurrency(Number.NaN), 0);
  });

  it('rejects invalid arbitrage inputs (zero DD, negative fees, non-finite values, invalid split)', () => {
    const base: ArbitrageInputs = {
      hedgeFactorMode: 'include_dd',
      drawdownUsd: 2000,
      evaluationFeeUsd: 100,
      activationFeeUsd: 0,
      additionalProfitUsd: 150,
      totalTargetUsd: 3000,
      payoutGrossProfitUsd: 4000,
      profitSplitPct: 90,
      refundOnFirstPayout: false,
    };

    assert.equal(calculateArbitrage({ ...base, drawdownUsd: 0 }).isValid, false);
    assert.equal(calculateArbitrage({ ...base, drawdownUsd: Number.NaN }).isValid, false);
    assert.equal(calculateArbitrage({ ...base, evaluationFeeUsd: -10 }).isValid, false);
    assert.equal(calculateArbitrage({ ...base, activationFeeUsd: -50 }).isValid, false);
    assert.equal(calculateArbitrage({ ...base, profitSplitPct: 0 }).isValid, false);
    assert.equal(calculateArbitrage({ ...base, profitSplitPct: 101 }).isValid, false);
  });
});

describe('Quant Engine — Module 1 Arbitrage (Scenario A & Corrected Scenario B)', () => {
  it('guarantees Scenario A net === +L_adic in both include_dd and fee_only modes', () => {
    const base: ArbitrageInputs = {
      hedgeFactorMode: 'include_dd',
      drawdownUsd: 2000,
      evaluationFeeUsd: 100,
      activationFeeUsd: 149,
      additionalProfitUsd: 150,
      totalTargetUsd: 3000,
      payoutGrossProfitUsd: 4000,
      profitSplitPct: 90,
      refundOnFirstPayout: false,
    };

    const resFull = calculateArbitrage(base);
    assert.equal(resFull.isValid, true);
    assert.equal(resFull.hedgeFactor, (2000 + 100 + 150) / 2000);
    assert.equal(resFull.scenarioA.netResult, 150);

    const resFeeOnly = calculateArbitrage({ ...base, hedgeFactorMode: 'fee_only' });
    assert.equal(resFeeOnly.isValid, true);
    assert.equal(resFeeOnly.hedgeFactor, (100 + 150) / 2000);
    assert.equal(resFeeOnly.scenarioA.propFirmLoss, 0);
    assert.equal(resFeeOnly.scenarioA.netResult, 150);
  });

  it('properly deducts T_eval and T_act in Scenario B and applies refund only when enabled', () => {
    const inputs: ArbitrageInputs = {
      hedgeFactorMode: 'fee_only',
      drawdownUsd: 2000,
      evaluationFeeUsd: 100,
      activationFeeUsd: 150,
      additionalProfitUsd: 100,
      totalTargetUsd: 3000,
      payoutGrossProfitUsd: 2000,
      profitSplitPct: 80,
      refundOnFirstPayout: false,
    };

    // F = (100 + 100) / 2000 = 0.1
    // Hedge loss = 3000 * 0.1 = 300
    // Gross payout = 2000 * 0.8 = 1600
    // First payout net = 1600 + 0 - 100 - 150 - 300 = 1050
    const noRefund = calculateArbitrage(inputs);
    assert.equal(noRefund.scenarioB.accumulatedHedgeLoss, 300);
    assert.equal(noRefund.scenarioB.evaluationFeePaid, 100);
    assert.equal(noRefund.scenarioB.activationFeePaid, 150);
    assert.equal(noRefund.scenarioB.firstPayoutNet, 1050);
    // Break-even: (300 + 100 + 150) / 0.8 = 687.50
    assert.equal(noRefund.scenarioB.breakEvenProfitNeeded, 687.5);

    // With refund of T_eval (+100): net = 1150, break-even = (300 + 100 + 150 - 100) / 0.8 = 562.50
    const withRefund = calculateArbitrage({ ...inputs, refundOnFirstPayout: true });
    assert.equal(withRefund.scenarioB.feeRefund, 100);
    assert.equal(withRefund.scenarioB.firstPayoutNet, 1150);
    assert.equal(withRefund.scenarioB.breakEvenProfitNeeded, 562.5);
  });

  it('computes centralized payoff sensitivity curve endpoints matching Scenario A', () => {
    const inputs: ArbitrageInputs = {
      hedgeFactorMode: 'include_dd',
      drawdownUsd: 2000,
      evaluationFeeUsd: 98,
      activationFeeUsd: 0,
      additionalProfitUsd: 150,
      totalTargetUsd: 3000,
      payoutGrossProfitUsd: 4000,
      profitSplitPct: 90,
      refundOnFirstPayout: false,
    };
    const out = calculateArbitrage(inputs);
    const curve = calculateArbitragePayoffCurve(inputs, out, 16);
    assert.equal(curve.length, 17);
    assert.equal(curve[0].mesaExcursion, -2000);
    assert.equal(curve[0].combinedFloating, 150);
    assert.equal(curve[curve.length - 1].mesaExcursion, 3000);
  });
});

describe('Quant Engine — Module 2 & 3 (Trade Sizing & Capital Bonus)', () => {
  it('computes trade sizing and sensitivity matrix centrally', () => {
    const sizingInputs = {
      instrumentId: 'US100' as const,
      customPointValueUsd: 1,
      desiredRiskUsd: 500,
      stopLossPoints: 25,
    };
    const out = calculateTradeSizing(sizingInputs, 1.125);
    assert.equal(out.isValid, true);
    assert.equal(out.propFirmLot, 20);
    assert.equal(out.brokerHedgeLot, 22.5);

    const matrix = calculateTradeSizingSensitivityMatrix(sizingInputs, out, 1.125);
    assert.equal(matrix.length, 6);
    const currentRow = matrix.find((r) => r.isCurrent);
    assert.ok(currentRow);
    assert.equal(currentRow.propFirmLot, 20);
    assert.equal(currentRow.brokerHedgeLot, 22.5);
  });

  it('flags realCoverageInsufficient when bonus reduces real deposit below full DD*F risk', () => {
    const out = calculateCapitalBonus(
      {
        basis: 'dd_buffer_15',
        phase1TargetUsd: 3000,
        bonusType: 'bonus_100',
        customBonusPct: 50,
      },
      2000,
      1.125
    );
    assert.equal(out.isValid, true);
    assert.equal(out.requiredEquityUsd, 2587.5);
    assert.equal(out.realDepositUsd, 1293.75);
    assert.equal(out.realCoverageInsufficient, true);
    assert.equal(out.comparison.bonus100Savings, 1293.75);
  });
});

describe('Quant Engine — Consistency & Drawdown Methodologies', () => {
  it('dispatches all consistency methodologies accurately and fails closed on unknown', () => {
    const positiveDays = [1200, 600, 600]; // sum=2400, max=1200

    const noneRes = evaluateConsistency(positiveDays, 2000, 3000, makeConsistencyRule(null, 'none'));
    assert.equal(noneRes.passed, true);

    // 1200 / 2400 = 50% (gross positive) vs 1200 / 2000 = 60% (net profit)
    const grossRule = makeConsistencyRule(50, 'best_day_over_gross_positive');
    const netRule = makeConsistencyRule(50, 'best_day_over_net_profit');
    const targetRule = makeConsistencyRule(50, 'best_day_over_target');

    assert.equal(evaluateConsistency(positiveDays, 2000, 3000, grossRule).passed, true);
    assert.equal(evaluateConsistency(positiveDays, 2000, 3000, netRule).passed, false);
    assert.equal(evaluateConsistency(positiveDays, 2000, 3000, netRule).violated, true);
    // 1200 / 3000 = 40% <= 50%
    assert.equal(evaluateConsistency(positiveDays, 2000, 3000, targetRule).passed, true);

    const unknownRule = makeConsistencyRule(null, 'unknown', 'missing');
    assert.equal(evaluateConsistency(positiveDays, 2000, 3000, unknownRule).passed, false);
  });

  it('respects static, trailing, and locked (+$100) drawdown floors', () => {
    const staticRule = makeDrawdownRule(2000, 'static', 'balance', null);
    assert.equal(computePhaseDrawdownFloor(50000, 2000, staticRule, 55000), 48000);

    const eodRule = makeDrawdownRule(2000, 'trailing_eod', 'balance', null);
    assert.equal(computePhaseDrawdownFloor(50000, 2000, eodRule, 51000), 49000);
    assert.equal(computePhaseDrawdownFloor(50000, 2000, eodRule, 54000), 50000);

    const eodLocked100 = makeDrawdownRule(2000, 'trailing_eod_locked', 'balance', 100);
    assert.equal(computePhaseDrawdownFloor(50000, 2000, eodLocked100, 54000), 50100);
  });
});

describe('Quant Engine — Payout Eligibility, State Machine & Anti-Double-Loss', () => {
  it('blocks payout eligibility when buffer, min profitable days, or missing rules are unmet', () => {
    // Apex 50K has $2,600 safety net buffer & 8 qualifying days
    const apex = DEFAULT_PROP_FIRMS_2026.find((f) => f.id === 'apex-50k');
    assert.ok(apex);

    // 8 profitable days of $200 = $1,600 profit (< $2,600 buffer) -> MUST NOT be eligible!
    const lowProfitSteps = Array.from({ length: 8 }, () => ({ netMesaPnlUsd: 200 }));
    const blocked = evaluatePayoutEligibility(51600, lowProfitSteps, apex);
    assert.equal(blocked.isEligible, false);
    assert.ok(blocked.blockedReasons.some((r) => r.includes('buffer')));

    // 8 profitable days of $450 = $3,600 profit (> $2,600 buffer, $1,000 withdrawable >= $500 min, 12.5% consistency <= 30%) -> ELIGIBLE
    const goodSteps = Array.from({ length: 8 }, () => ({ netMesaPnlUsd: 450 }));
    const eligible = evaluatePayoutEligibility(53600, goodSteps, apex);
    assert.equal(eligible.isEligible, true);
    assert.equal(eligible.grossEligibleWithdrawalUsd, 1000);
    assert.equal(eligible.netTraderPayoutUsd, 900); // 90% modeled profit split on $1,000 gross eligible

    // Missing payout contract field fails closed
    const incompleteFirm = buildFirmPreset({
      ...makeTestFirm(),
      id: 'missing-buffer-test',
      fundedRules: {
        ...makeTestFirm().fundedRules,
        profitBufferUsd: makeMissing('Buffer ausente'),
      },
    });
    const failedClosed = evaluatePayoutEligibility(55000, goodSteps, incompleteFirm);
    assert.equal(failedClosed.isEligible, false);
    assert.ok(failedClosed.blockedReasons.some((r) => r.includes('ausente')));
  });

  it('charges activation fee ONLY on Funded transition and not on Eval stop-out', () => {
    const topstep = DEFAULT_PROP_FIRMS_2026.find((f) => f.id === 'topstep-50k');
    assert.ok(topstep);
    assert.equal(topstep.activationFeeUsd, 149);

    const arb: ArbitrageInputs = {
      hedgeFactorMode: 'include_dd',
      drawdownUsd: 2000,
      evaluationFeeUsd: 49,
      activationFeeUsd: 149,
      additionalProfitUsd: 150,
      totalTargetUsd: 3000,
      payoutGrossProfitUsd: 2000,
      profitSplitPct: 90,
      refundOnFirstPayout: false,
    };
    const arbOut = calculateArbitrage(arb);

    // Scenario A: Stop in Phase 1 -> Activation fee NOT paid!
    const stopSim = runDailySimulation(
      [{ id: 'd1', mesaPnlUsd: -2000, intradayPeakOffsetUsd: 0 }],
      topstep,
      arb,
      arbOut.hedgeFactor,
      true,
      undefined,
      true
    );
    assert.equal(stopSim.status, 'Reprovado (Stop)');
    assert.equal(stopSim.lifecycleState, 'account_breached');
    assert.equal(stopSim.feesPaidTotalUsd, 49);
    assert.equal(stopSim.finalNetOutcomeUsd, 150);

    // Advance Eval -> Activation fee ($149) added upon entering Funded!
    const passEvalEntries: DailyTradeEntry[] = [
      { id: 'e1', mesaPnlUsd: 1500, intradayPeakOffsetUsd: 0 },
      { id: 'e2', mesaPnlUsd: 1500, intradayPeakOffsetUsd: 0 },
    ];
    const fundedSim = runDailySimulation(
      passEvalEntries,
      topstep,
      arb,
      arbOut.hedgeFactor,
      true,
      { enabled: true, activeDaysTarget: 5, shortTargetUsd: 200, stopMaxUsd: 1500 },
      true
    );
    assert.equal(fundedSim.currentPhase, 'Funded');
    assert.equal(fundedSim.lifecycleState, 'funded_trading');
    assert.equal(fundedSim.feesPaidTotalUsd, 49 + 149);
    assert.ok(fundedSim.transitions.some((t) => t.to === 'funded_activation'));
  });

  it('REGRESSION: prevents double loss on Funded 10:1 stop after winning Eval + Funded days', () => {
    const firm = makeTestFirm();
    const arb: ArbitrageInputs = {
      hedgeFactorMode: 'include_dd',
      drawdownUsd: 2000,
      evaluationFeeUsd: 98,
      activationFeeUsd: 0,
      additionalProfitUsd: 150,
      totalTargetUsd: 3000,
      payoutGrossProfitUsd: 2000,
      profitSplitPct: 90,
      refundOnFirstPayout: false,
    };
    const arbOut = calculateArbitrage(arb);

    // D1-D2 pass Eval (+1500, +1500), D3-D6 win Funded 10:1 (+150/day), D7 hits Funded 1:10 stop (-1500 or -2000 breach)
    const entries: DailyTradeEntry[] = [
      { id: 'd1', mesaPnlUsd: 1500, intradayPeakOffsetUsd: 0 },
      { id: 'd2', mesaPnlUsd: 1500, intradayPeakOffsetUsd: 0 },
      { id: 'd3', mesaPnlUsd: 150, intradayPeakOffsetUsd: 0 },
      { id: 'd4', mesaPnlUsd: 150, intradayPeakOffsetUsd: 0 },
      { id: 'd5', mesaPnlUsd: 150, intradayPeakOffsetUsd: 0 },
      { id: 'd6', mesaPnlUsd: 150, intradayPeakOffsetUsd: 0 },
      { id: 'd7', mesaPnlUsd: -2600, intradayPeakOffsetUsd: 0 }, // full breach on Funded
    ];

    const sim = runDailySimulation(
      entries,
      firm,
      arb,
      arbOut.hedgeFactor,
      true,
      { enabled: true, activeDaysTarget: 5, shortTargetUsd: 150, stopMaxUsd: 1500 },
      true
    );

    assert.equal(sim.status, 'Reprovado (Stop)');
    assert.equal(sim.currentPhase, 'Funded');
    // With protectDoubleLoss=true, combined net outcome on stop must be >= +L_adic ($150) — NEVER a double loss!
    assert.ok(
      sim.finalNetOutcomeUsd >= arb.additionalProfitUsd - 0.01,
      `Expected finalNetOutcomeUsd (${sim.finalNetOutcomeUsd}) >= +${arb.additionalProfitUsd}`
    );
  });

  it('switches drawdown methodology between Eval (EOD) and Funded (Intraday) for MFFU Rapid', () => {
    const mffuRapid = DEFAULT_PROP_FIRMS_2026.find((f) => f.id === 'mffu-rapid-intraday-50k');
    assert.ok(mffuRapid);
    assert.equal(mffuRapid.evaluationRules.maxDrawdown.methodology, 'trailing_eod');
    assert.equal(mffuRapid.fundedRules.maxDrawdown.methodology, 'trailing_intraday_locked');

    const arb: ArbitrageInputs = {
      hedgeFactorMode: 'fee_only',
      drawdownUsd: 2000,
      evaluationFeeUsd: 149,
      activationFeeUsd: 0,
      additionalProfitUsd: 100,
      totalTargetUsd: 3000,
      payoutGrossProfitUsd: 3000,
      profitSplitPct: 90,
      refundOnFirstPayout: false,
    };
    const arbOut = calculateArbitrage(arb);

    // Eval day 1: +1500, day 2: +1500 (50% consistency passes) -> Funded
    // Funded day 3: intraday peak +$1,800 raises floor to $49,800; closing -$300 (equity $49,700 <= $49,800) MUST breach!
    const sim = runDailySimulation(
      [
        { id: 'e1', mesaPnlUsd: 1500, intradayPeakOffsetUsd: 1800 }, // EOD ignores intraday peak in Eval!
        { id: 'e2', mesaPnlUsd: 1500, intradayPeakOffsetUsd: 0 },
        { id: 'f1', mesaPnlUsd: -300, intradayPeakOffsetUsd: 1800 }, // Intraday trailing breaches in Funded!
      ],
      mffuRapid,
      arb,
      arbOut.hedgeFactor,
      true,
      undefined,
      true
    );

    assert.equal(sim.steps[0].violationReason, undefined);
    assert.equal(sim.steps[1].phaseAdvancedTo, 'Funded');
    assert.equal(sim.status, 'Reprovado (Stop)');
    assert.equal(sim.steps[2].phase, 'Funded');
    assert.ok(sim.steps[2].violationReason?.includes('Trailing Intradiário'));
  });

  it('calculates Funded 10:1 sizing accounting for both T_eval and T_act', () => {
    const arb: ArbitrageInputs = {
      hedgeFactorMode: 'include_dd',
      drawdownUsd: 2000,
      evaluationFeeUsd: 49,
      activationFeeUsd: 149,
      additionalProfitUsd: 150,
      totalTargetUsd: 3000,
      payoutGrossProfitUsd: 2000,
      profitSplitPct: 90,
      refundOnFirstPayout: false,
    };
    const out = calculateFundedMethod101(
      {
        shortTargetUsd: 150,
        remainingDrawdownUsd: 1500,
        stopLossPoints: 100,
        activeDaysTarget: 5,
        statisticalWinRatePct: 92,
      },
      'US100',
      1,
      arb,
      1.1,
      true
    );
    assert.equal(out.isValid, true);
    assert.equal(out.impliedNegativeRatio, 10);
    // Failure day net after T_eval + T_act must equal +L_adic ($150)
    assert.equal(out.failureDay.netAfterFeeUsd, 150);
  });

  it('computes centralized step preview matching Funded 10:1 vs Eval modes', () => {
    const firm = makeTestFirm();
    const arb: ArbitrageInputs = {
      hedgeFactorMode: 'include_dd',
      drawdownUsd: 2000,
      evaluationFeeUsd: 98,
      activationFeeUsd: 0,
      additionalProfitUsd: 150,
      totalTargetUsd: 3000,
      payoutGrossProfitUsd: 2000,
      profitSplitPct: 90,
      refundOnFirstPayout: false,
    };
    const entries = generateApprovalTrajectory(firm, arb, {
      enabled: true,
      activeDaysTarget: 5,
      shortTargetUsd: 150,
    });
    const summary = runDailySimulation(entries, firm, arb, 1.124, true, {
      enabled: true,
      activeDaysTarget: 5,
      shortTargetUsd: 150,
    });
    assert.equal(summary.status, 'Aprovado para Saque');

    const preview = calculateStepPreview(
      summary,
      firm,
      arb,
      'dd_max_meta_dias',
      0.75,
      3,
      500,
      true,
      {
        shortTargetUsd: 150,
        remainingDrawdownUsd: 1500,
        stopLossPoints: 100,
        activeDaysTarget: 5,
        statisticalWinRatePct: 92,
      }
    );
    assert.equal(preview.isFunded101Active, true);
    assert.equal(preview.tpUsd, 150);
    assert.equal(preview.slUsd, 1500);
    assert.equal(preview.effectiveRr, 0.1);
  });
});

describe('Quant Engine — Seeded Monte Carlo Determinism & CSV Security', () => {
  it('produces identical Monte Carlo distributions for the same seed', () => {
    const firm = makeTestFirm();
    const arb: ArbitrageInputs = {
      hedgeFactorMode: 'include_dd',
      drawdownUsd: 2000,
      evaluationFeeUsd: 98,
      activationFeeUsd: 0,
      additionalProfitUsd: 150,
      totalTargetUsd: 3000,
      payoutGrossProfitUsd: 2000,
      profitSplitPct: 90,
      refundOnFirstPayout: false,
    };
    const out = calculateArbitrage(arb);

    const runA = runMonteCarloSimulation(firm, arb, out.hedgeFactor, {
      numRuns: 200,
      seed: 424242,
      funded101Enabled: true,
      fundedShortTargetUsd: 200,
      fundedStopMaxUsd: 1500,
    });
    const runB = runMonteCarloSimulation(firm, arb, out.hedgeFactor, {
      numRuns: 200,
      seed: 424242,
      funded101Enabled: true,
      fundedShortTargetUsd: 200,
      fundedStopMaxUsd: 1500,
    });

    assert.equal(runA.seedUsed, 424242);
    assert.deepEqual(runA, runB);
    assert.equal(
      runA.payoutCount + runA.stopInEvalCount + runA.stopInFundedCount + runA.incompleteCount,
      200
    );
  });

  it('neutralizes CSV formula injection payloads during simulation export', () => {
    const csv = exportSimulationsToCsv([
      {
        id: 'sim-1',
        createdAt: '2026-11-21T00:00:00Z',
        firmName: '=CMD|" /C calc"!A0',
        firmModel: '+HYPERLINK("http://evil.example","click")',
        contractVersion: '2026.11',
        arbitrageInputs: {
          hedgeFactorMode: 'include_dd',
          drawdownUsd: 2000,
          evaluationFeeUsd: 98,
          activationFeeUsd: 0,
          additionalProfitUsd: 150,
          totalTargetUsd: 3000,
          payoutGrossProfitUsd: 4000,
          profitSplitPct: 90,
          refundOnFirstPayout: false,
        },
        hedgeFactor: 1.124,
        scenarioANet: 150,
        scenarioBFirstNet: 129.99,
        instrumentId: 'US100',
        propFirmLot: 20,
        brokerHedgeLot: 22.48,
        requiredEquityUsd: 2585.2,
        realDepositUsd: 1292.6,
        bonusPct: 100,
      },
    ]);

    assert.ok(csv.includes(`"'=CMD|"" /C calc""!A0"`));
    assert.ok(csv.includes(`"'+HYPERLINK(""http://evil.example"",""click"")"`));
  });
});

describe('Quant Engine — Consolidated Hedge Break-even & Payout Gating', () => {
  it('computes exact break-even requirements and detects maxPayout cap below break-even', () => {
    const firm = makeTestFirm(); // lucid-50k-flex: 90% split, 0 buffer, 50% maxWithdrawalPct, maxPayoutUsd = 2000
    const steps = [
      { netMesaPnlUsd: 300 },
      { netMesaPnlUsd: 300 },
      { netMesaPnlUsd: 300 },
      { netMesaPnlUsd: 300 },
      { netMesaPnlUsd: 300 },
    ]; // $1,500 gross -> 50% = $750 gross withdrawal -> 90% split = $675 net payout

    const evalWithHedge = evaluatePayoutEligibility(51500, steps, firm, 90, undefined, {
      brokerCumulativePnlUsd: -2500,
      feesPaidCumulativeUsd: 200,
      feeRefundUsd: 0,
      requireHedgeCoverage: false,
      hedgeDuringFunded: true,
      effectiveFundedHedgeFactor: 1.15,
    });

    assert.equal(evalWithHedge.isContractuallyEligible, true);
    assert.equal(evalWithHedge.isEligible, true); // gating OFF -> eligible on firm
    assert.equal(evalWithHedge.coversHedgeAndFees, false); // $675 - $2,700 = -$2,025
    assert.equal(evalWithHedge.requiredNetPayoutToBreakEvenUsd, 2700);
    assert.equal(evalWithHedge.requiredGrossProfitToBreakEvenUsd, 6000); // (2700 / 0.90) / 0.50
    assert.equal(evalWithHedge.additionalGrossProfitForBreakEvenUsd, 4500); // 6000 - 1500
    assert.equal(evalWithHedge.projectedConsolidatedNetUsd, -2025);
    assert.equal(evalWithHedge.isSinglePayoutCappedBelowBreakEven, true); // 3000 > maxPayoutUsd (2000)
    assert.equal(evalWithHedge.hedgeBlocksBreakEven, true); // F=1.15 >= 0.90 * 0.50
  });

  it('continues trading Funded when requireHedgeCoverageForPayout is ON until consolidated net >= 0', () => {
    const uncappedFirm = buildFirmPreset({
      ...makeTestFirm(),
      id: 'uncapped-payout-test',
      fundedRules: {
        ...makeTestFirm().fundedRules,
        maxPayoutUsd: { value: null, status: 'verified', effectiveDate: '2026-11-01' },
      },
    });
    const arb: ArbitrageInputs = {
      hedgeFactorMode: 'fee_only',
      drawdownUsd: 2000,
      evaluationFeeUsd: 100,
      activationFeeUsd: 0,
      additionalProfitUsd: 200,
      totalTargetUsd: 3000,
      payoutGrossProfitUsd: 2000,
      profitSplitPct: 90,
      refundOnFirstPayout: false,
    };
    const arbOut = calculateArbitrage(arb); // F = 300 / 2000 = 0.15 -> Eval hedge loss = -$450; total cost = $550 -> needs $1,222.22 gross Funded profit (50% * 90%)

    // 2 eval days (+1500 each), then 5 Funded days of $200 (= $1,000 gross -> $450 net -> -$100 consolidated), then 2 more days of $200 (= $1,400 gross -> $630 net -> +$80 consolidated)
    const entries: DailyTradeEntry[] = [
      { id: 'e1', mesaPnlUsd: 1500, intradayPeakOffsetUsd: 0 },
      { id: 'e2', mesaPnlUsd: 1500, intradayPeakOffsetUsd: 0 },
      { id: 'f1', mesaPnlUsd: 200, intradayPeakOffsetUsd: 0 },
      { id: 'f2', mesaPnlUsd: 200, intradayPeakOffsetUsd: 0 },
      { id: 'f3', mesaPnlUsd: 200, intradayPeakOffsetUsd: 0 },
      { id: 'f4', mesaPnlUsd: 200, intradayPeakOffsetUsd: 0 },
      { id: 'f5', mesaPnlUsd: 200, intradayPeakOffsetUsd: 0 },
      { id: 'f6', mesaPnlUsd: 200, intradayPeakOffsetUsd: 0 },
      { id: 'f7', mesaPnlUsd: 200, intradayPeakOffsetUsd: 0 },
    ];

    // Without hedge-coverage gating: stops on day 7 (5th Funded day, $1,000 gross -> -$100 consolidated net)
    const simEarly = runDailySimulation(
      entries,
      uncappedFirm,
      arb,
      arbOut.hedgeFactor,
      false,
      { enabled: true, activeDaysTarget: 5, shortTargetUsd: 200 },
      false,
      false
    );
    assert.equal(simEarly.status, 'Aprovado para Saque');
    assert.equal(simEarly.totalDays, 7);
    assert.equal(simEarly.payoutEligibility?.isContractuallyEligible, true);
    assert.equal(simEarly.payoutEligibility?.coversHedgeAndFees, false);
    assert.equal(simEarly.finalNetOutcomeUsd, -100);

    // With hedge-coverage gating ON: continues past day 7 & 8 and closes on day 9 once consolidated net >= 0 (+$80)
    const simCovered = runDailySimulation(
      entries,
      uncappedFirm,
      arb,
      arbOut.hedgeFactor,
      false,
      { enabled: true, activeDaysTarget: 5, shortTargetUsd: 200 },
      false,
      true
    );
    assert.equal(simCovered.status, 'Aprovado para Saque');
    assert.equal(simCovered.totalDays, 9);
    assert.equal(simCovered.payoutEligibility?.isContractuallyEligible, true);
    assert.equal(simCovered.payoutEligibility?.coversHedgeAndFees, true);
    assert.equal(simCovered.finalNetOutcomeUsd, 80);
  });

  it('executes intermediate multi-cycle payouts on hedged Funded, drops F after payout, and continues until positive (> $0)', () => {
    const lucid = makeTestFirm(); // lucid-50k-flex: $98 eval fee, $2k static DD, 5d >= $150, 50% withdrawable, 90% split
    const arb: ArbitrageInputs = {
      hedgeFactorMode: 'fee_only',
      drawdownUsd: 2000,
      evaluationFeeUsd: 98,
      activationFeeUsd: 0,
      additionalProfitUsd: 150,
      totalTargetUsd: 3000,
      payoutGrossProfitUsd: 2000,
      profitSplitPct: 90,
      refundOnFirstPayout: false,
    };
    const arbOut = calculateArbitrage(arb); // F = (98+150)/2000 = 0.124

    // Exact user screenshot setup: D1 +$3,000 passes Eval, followed by +$200/day in Funded with hedge + anti-double-loss ON
    const entries: DailyTradeEntry[] = [
      { id: 'd1', mesaPnlUsd: 3000, intradayPeakOffsetUsd: 0 },
      ...Array.from({ length: 20 }, (_, idx) => ({
        id: `f-${idx + 1}`,
        mesaPnlUsd: 200,
        intradayPeakOffsetUsd: 0,
      })),
    ];

    const sim = runDailySimulation(
      entries,
      lucid,
      arb,
      arbOut.hedgeFactor,
      true,
      { enabled: true, activeDaysTarget: 5, shortTargetUsd: 200, stopMaxUsd: 2000 },
      true,
      true
    );

    // D6 (index 5): Payout #1 = +$450, consolidated = -$398.51 (continues!)
    assert.equal(sim.steps[5].payoutNumber, 1);
    assert.equal(sim.steps[5].payoutExecutedUsd, 450);
    assert.equal(sim.steps[5].combinedNetCashflowUsd, -398.51);
    assert.equal(sim.steps[5].lifecycleState, 'payout_approved');

    // D7 (index 6): Dynamic F MUST drop sharply after Payout #1 reduced uncovered cost!
    assert.ok(
      sim.steps[6].appliedHedgeFactor < sim.steps[5].appliedHedgeFactor,
      `Expected D7 F (${sim.steps[6].appliedHedgeFactor}) < D6 F (${sim.steps[5].appliedHedgeFactor})`
    );

    // D11 (index 10): Payout #2 = +$675 (50% of $1,500 * 90%), still negative -> continues!
    assert.equal(sim.steps[10].payoutNumber, 2);
    assert.equal(sim.steps[10].payoutExecutedUsd, 675);

    // D16 (index 15): Payout #3 brings consolidated net strictly positive (> $0) and finishes!
    assert.equal(sim.status, 'Aprovado para Saque');
    assert.equal(sim.totalDays, 16);
    assert.equal(sim.payoutsCount, 3);
    assert.ok(sim.finalNetOutcomeUsd > 0, `Expected finalNetOutcomeUsd (${sim.finalNetOutcomeUsd}) > 0`);

    // Anti-double-loss check: stopping out during Cycle 2 (D9, equity $50,900 -> floor $48,000) MUST still yield exact +$150.00!
    const stopInCycle2 = runDailySimulation(
      [...entries.slice(0, 8), { id: 'stop-d9', mesaPnlUsd: -2900, intradayPeakOffsetUsd: 0 }],
      lucid,
      arb,
      arbOut.hedgeFactor,
      true,
      { enabled: true, activeDaysTarget: 5, shortTargetUsd: 200, stopMaxUsd: 2000 },
      true,
      true
    );
    assert.equal(stopInCycle2.status, 'Reprovado (Stop)');
    assert.equal(stopInCycle2.payoutsCount, 1);
    assert.equal(stopInCycle2.finalNetOutcomeUsd, 150);
  });
});

