import { INSTRUMENT_SPECS } from '../data/propFirms2026';
import {
  ArbitrageInputs,
  ArbitrageOutputs,
  CapitalBonusInputs,
  CapitalBonusOutputs,
  DailySimulationStep,
  DailySimulationSummary,
  DailyTradeEntry,
  FundedMethod101Inputs,
  FundedMethod101Outputs,
  InstrumentId,
  JourneyPhase,
  JourneyStatus,
  MonteCarloHistogramBin,
  MonteCarloPercentilePoint,
  MonteCarloSamplePath,
  MonteCarloSummary,
  PropFirmPreset,
  RandomSizingMode,
  SavedSimulation,
  TradeSizingInputs,
  TradeSizingOutputs,
} from '../types/quant';

export function calculateArbitrage(inputs: ArbitrageInputs): ArbitrageOutputs {
  const {
    hedgeFactorMode = 'include_dd',
    drawdownUsd,
    evaluationFeeUsd,
    additionalProfitUsd,
    totalTargetUsd,
    payoutGrossProfitUsd,
    profitSplitPct,
    refundOnFirstPayout,
  } = inputs;

  if (!Number.isFinite(drawdownUsd) || drawdownUsd <= 0) {
    return {
      isValid: false,
      validationError: 'O Limite de Drawdown Total (DD) deve ser maior que $0.',
      hedgeFactor: 0,
      scenarioA: { propFirmLoss: 0, feeCost: 0, brokerGain: 0, netResult: 0 },
      scenarioB: {
        accumulatedHedgeLoss: 0,
        grossPayout: 0,
        feeRefund: 0,
        firstPayoutNet: 0,
        subsequentPayoutNet: 0,
        breakEvenProfitNeeded: 0,
      },
    };
  }

  if (
    evaluationFeeUsd < 0 ||
    additionalProfitUsd < 0 ||
    totalTargetUsd < 0 ||
    payoutGrossProfitUsd < 0 ||
    profitSplitPct <= 0 ||
    profitSplitPct > 100
  ) {
    return {
      isValid: false,
      validationError: 'Verifique os valores informados: taxas e metas não podem ser negativas e o Profit Split deve estar entre 1% e 100%.',
      hedgeFactor: 0,
      scenarioA: { propFirmLoss: 0, feeCost: 0, brokerGain: 0, netResult: 0 },
      scenarioB: {
        accumulatedHedgeLoss: 0,
        grossPayout: 0,
        feeRefund: 0,
        firstPayoutNet: 0,
        subsequentPayoutNet: 0,
        breakEvenProfitNeeded: 0,
      },
    };
  }

  // Modo 'include_dd': F = (DD + T + L_adic) / DD
  // Modo 'fee_only': F = (T + L_adic) / DD (DD da mesa é virtual; desembolso real é apenas T)
  const isFeeOnly = hedgeFactorMode === 'fee_only';
  const hedgeFactor = isFeeOnly
    ? (evaluationFeeUsd + additionalProfitUsd) / drawdownUsd
    : (drawdownUsd + evaluationFeeUsd + additionalProfitUsd) / drawdownUsd;

  // Cenário A — Reprovação na Mesa (Stop atingido)
  const propFirmLoss = isFeeOnly ? 0 : -drawdownUsd;
  const feeCost = -evaluationFeeUsd;
  const brokerGain = drawdownUsd * hedgeFactor;
  const scenarioANet = propFirmLoss + feeCost + brokerGain; // = +L_adic em ambos os modos

  // Cenário B — Aprovação e Payout
  const splitRatio = profitSplitPct / 100;
  const accumulatedHedgeLoss = totalTargetUsd * hedgeFactor;
  const grossPayout = payoutGrossProfitUsd * splitRatio;
  const feeRefund = refundOnFirstPayout ? evaluationFeeUsd : 0;
  const firstPayoutNet = grossPayout + feeRefund - accumulatedHedgeLoss;
  const subsequentPayoutNet = payoutGrossProfitUsd * splitRatio;

  const breakEvenProfitNeeded = Math.max(0, (accumulatedHedgeLoss - feeRefund) / splitRatio);

  return {
    isValid: true,
    hedgeFactor,
    scenarioA: {
      propFirmLoss,
      feeCost,
      brokerGain,
      netResult: scenarioANet,
    },
    scenarioB: {
      accumulatedHedgeLoss,
      grossPayout,
      feeRefund,
      firstPayoutNet,
      subsequentPayoutNet,
      breakEvenProfitNeeded,
    },
  };
}

export function calculateTradeSizing(
  inputs: TradeSizingInputs,
  hedgeFactor: number
): TradeSizingOutputs {
  const spec = INSTRUMENT_SPECS.find((item) => item.id === inputs.instrumentId);
  const effectivePointValueUsd =
    inputs.instrumentId === 'CUSTOM'
      ? inputs.customPointValueUsd
      : (spec?.pointValuePerStandardLot ?? 1);

  if (
    !Number.isFinite(inputs.stopLossPoints) ||
    inputs.stopLossPoints <= 0 ||
    !Number.isFinite(effectivePointValueUsd) ||
    effectivePointValueUsd <= 0 ||
    !Number.isFinite(inputs.desiredRiskUsd) ||
    inputs.desiredRiskUsd <= 0
  ) {
    return {
      isValid: false,
      validationError: 'Risco ($), Stop Loss e Valor do Ponto precisam ser maiores que zero.',
      effectivePointValueUsd: Math.max(0, effectivePointValueUsd || 0),
      propFirmLot: 0,
      brokerHedgeLot: 0,
      riskPerPointUsd: 0,
    };
  }

  // L_M = Risco_Desejado_USD / (Stop_Loss_Pontos_ou_Pips * Valor_do_Ponto_por_1_Lote)
  const propFirmLot = inputs.desiredRiskUsd / (inputs.stopLossPoints * effectivePointValueUsd);
  // L_C = L_M * F
  const brokerHedgeLot = propFirmLot * Math.max(0, hedgeFactor);
  const riskPerPointUsd = propFirmLot * effectivePointValueUsd;

  return {
    isValid: true,
    effectivePointValueUsd,
    propFirmLot,
    brokerHedgeLot,
    riskPerPointUsd,
  };
}

export function calculateCapitalBonus(
  inputs: CapitalBonusInputs,
  drawdownUsd: number,
  hedgeFactor: number
): CapitalBonusOutputs {
  const safeDD = Math.max(0, drawdownUsd);
  const safePhase1 = Math.max(0, inputs.phase1TargetUsd);
  const safeFactor = Math.max(0, hedgeFactor);

  // Equidade_Necessaria = DD * F * 1.15 (ou Meta_Fase1 * F * 1.10)
  const requiredEquityUsd =
    inputs.basis === 'dd_buffer_15'
      ? safeDD * safeFactor * 1.15
      : safePhase1 * safeFactor * 1.10;

  let bonusCreditPct = 0;
  if (inputs.bonusType === 'bonus_50') bonusCreditPct = 50;
  else if (inputs.bonusType === 'bonus_100') bonusCreditPct = 100;
  else if (inputs.bonusType === 'custom') bonusCreditPct = Math.max(0, Math.min(200, inputs.customBonusPct));

  const divisor = 1 + bonusCreditPct / 100;
  const realDepositUsd = requiredEquityUsd / divisor;
  const bonusCreditUsd = requiredEquityUsd - realDepositUsd;

  return {
    requiredEquityUsd,
    bonusCreditPct,
    realDepositUsd,
    bonusCreditUsd,
    maxSafeFloatingLossUsd: realDepositUsd,
    comparison: {
      noBonusDeposit: requiredEquityUsd,
      bonus50Deposit: requiredEquityUsd / 1.5,
      bonus100Deposit: requiredEquityUsd / 2,
    },
  };
}

export function formatUsd(value: number, showSign = false): string {
  const abs = Math.abs(value);
  const formatted = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(abs);

  if (value < 0) return `-$${formatted}`;
  if (showSign && value > 0) return `+$${formatted}`;
  return `$${formatted}`;
}

export function formatLot(value: number): string {
  return value.toFixed(2);
}

export function formatFactor(value: number): string {
  return value.toFixed(4);
}

export function exportSimulationsToCsv(simulations: SavedSimulation[]): string {
  const headers = [
    'ID',
    'Data',
    'Mesa',
    'Modelo',
    'Drawdown_USD',
    'Taxa_USD',
    'Lucro_Adic_USD',
    'Meta_Total_USD',
    'Fator_F',
    'Cenario_A_Liquido_USD',
    'Cenario_B_1Payout_USD',
    'Ativo',
    'Lote_Mesa_LM',
    'Lote_Corretora_LC',
    'Equidade_Necessaria_USD',
    'Deposito_Real_USD',
    'Bonus_Pct',
  ];

  const rows = simulations.map((sim) => [
    sim.id,
    sim.createdAt,
    `"${sim.firmName.replace(/"/g, '""')}"`,
    `"${sim.firmModel.replace(/"/g, '""')}"`,
    sim.arbitrageInputs.drawdownUsd.toFixed(2),
    sim.arbitrageInputs.evaluationFeeUsd.toFixed(2),
    sim.arbitrageInputs.additionalProfitUsd.toFixed(2),
    sim.arbitrageInputs.totalTargetUsd.toFixed(2),
    sim.hedgeFactor.toFixed(4),
    sim.scenarioANet.toFixed(2),
    sim.scenarioBFirstNet.toFixed(2),
    sim.instrumentId,
    sim.propFirmLot.toFixed(2),
    sim.brokerHedgeLot.toFixed(2),
    sim.requiredEquityUsd.toFixed(2),
    sim.realDepositUsd.toFixed(2),
    sim.bonusPct.toFixed(0),
  ]);

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

export interface Funded101StageConfig {
  enabled: boolean;
  activeDaysTarget: number;
  shortTargetUsd: number;
  stopMaxUsd?: number;
}

export function runDailySimulation(
  entries: DailyTradeEntry[],
  firm: PropFirmPreset,
  arbitrageInputs: ArbitrageInputs,
  hedgeFactor: number,
  hedgeDuringFunded = false,
  funded101?: Funded101StageConfig,
  protectDoubleLoss = true
): DailySimulationSummary {
  const isFeeOnly = (arbitrageInputs.hedgeFactorMode ?? 'include_dd') === 'fee_only';
  const ddLimit = Math.max(1, arbitrageInputs.drawdownUsd);
  const splitRatio = arbitrageInputs.profitSplitPct / 100;
  const phase1Target =
    firm.phase1TargetUsd > 0 ? firm.phase1TargetUsd : arbitrageInputs.totalTargetUsd;
  const phase2Target = firm.phase2TargetUsd;
  const fundedMinDays = funded101?.enabled
    ? Math.max(firm.minTradingDays, Math.max(1, funded101.activeDaysTarget))
    : firm.minTradingDays;
  const fundedTarget = funded101?.enabled
    ? Math.max(50, funded101.shortTargetUsd) * fundedMinDays
    : Math.max(100, arbitrageInputs.payoutGrossProfitUsd);

  let currentPhase: JourneyPhase = 'Fase 1';
  let status: JourneyStatus = 'Em Andamento';
  let phaseEquity = firm.accountSize;
  let phaseHighWaterMark = firm.accountSize;
  let daysInPhase = 0;
  let phasePositiveDays: number[] = [];
  let brokerCumulativePnl = 0;
  let failureReason: string | undefined;

  const getTargetForPhase = (phase: JourneyPhase) => {
    if (phase === 'Fase 1') return phase1Target;
    if (phase === 'Fase 2') return phase2Target;
    return fundedTarget;
  };

  const computeFloor = (hwm: number) => {
    if (firm.drawdownType === 'Estático') {
      return firm.accountSize - ddLimit;
    }
    return Math.min(firm.accountSize, hwm - ddLimit);
  };

  const steps: DailySimulationStep[] = [];

  for (let i = 0; i < entries.length; i++) {
    if (status !== 'Em Andamento') break;

    const entry = entries[i];
    const activePhase = currentPhase;
    const isHedgeActiveToday = activePhase !== 'Funded' || hedgeDuringFunded;

    const floorBefore = computeFloor(phaseHighWaterMark);
    const remainingToFloorBefore = Math.max(1, phaseEquity - floorBefore);
    const effectiveLiquidationLoss =
      firm.dailyLossLimitUsd > 0
        ? Math.min(remainingToFloorBefore, firm.dailyLossLimitUsd)
        : remainingToFloorBefore;

    const isFunded101Step = activePhase === 'Funded' && Boolean(funded101?.enabled);
    const slRiskDenominator =
      isFunded101Step && funded101?.stopMaxUsd && funded101.stopMaxUsd > 0
        ? Math.min(effectiveLiquidationLoss, Math.max(50, funded101.stopMaxUsd))
        : effectiveLiquidationLoss;

    let appliedHedgeFactor = 0;
    if (isHedgeActiveToday) {
      if (protectDoubleLoss) {
        const projectedLossOnStop = isFeeOnly
          ? 0
          : ddLimit - remainingToFloorBefore + slRiskDenominator;
        const neededBrokerGain =
          projectedLossOnStop +
          arbitrageInputs.evaluationFeeUsd +
          arbitrageInputs.additionalProfitUsd -
          brokerCumulativePnl;
        appliedHedgeFactor = Math.max(0, neededBrokerGain / slRiskDenominator);
      } else {
        appliedHedgeFactor = hedgeFactor;
      }
    }

    const brokerDailyPnl = isHedgeActiveToday ? -entry.mesaPnlUsd * appliedHedgeFactor : 0;
    brokerCumulativePnl += brokerDailyPnl;

    daysInPhase += 1;

    // For Trailing Intradiário, floating positive excursion pulls HWM before close
    let effectiveHwm = phaseHighWaterMark;
    if (firm.drawdownType === 'Trailing Intradiário' && entry.intradayPeakOffsetUsd > 0) {
      effectiveHwm = Math.max(effectiveHwm, phaseEquity + entry.intradayPeakOffsetUsd);
    }

    const nextEquity = phaseEquity + entry.mesaPnlUsd;
    if (firm.drawdownType === 'Trailing EOD' || firm.drawdownType === 'Trailing Intradiário') {
      effectiveHwm = Math.max(effectiveHwm, nextEquity);
    }

    const floorUsd = computeFloor(effectiveHwm);
    const drawdownRemaining = Math.max(0, nextEquity - floorUsd);
    const phasePnl = nextEquity - firm.accountSize;

    if (entry.mesaPnlUsd > 0) {
      phasePositiveDays.push(entry.mesaPnlUsd);
    }

    let violationReason: string | undefined;
    if (firm.dailyLossLimitUsd > 0 && entry.mesaPnlUsd <= -firm.dailyLossLimitUsd) {
      violationReason = `Perda diária excedeu o limite de ${formatUsd(firm.dailyLossLimitUsd)}.`;
    } else if (nextEquity <= floorUsd) {
      violationReason =
        firm.drawdownType === 'Trailing Intradiário' && entry.intradayPeakOffsetUsd > 0
          ? `Trailing Intradiário violado após pico intradiário elevar o piso para ${formatUsd(floorUsd)}.`
          : `Drawdown máximo atingido (piso ${formatUsd(floorUsd)}).`;
    }

    let phaseAdvancedTo: JourneyPhase | undefined;
    const phaseTarget = getTargetForPhase(activePhase);

    if (violationReason) {
      status = 'Reprovado (Stop)';
      failureReason = violationReason;
      phaseEquity = nextEquity;
      phaseHighWaterMark = effectiveHwm;
    } else {
      phaseEquity = nextEquity;
      phaseHighWaterMark = effectiveHwm;

      const requiredDays = activePhase === 'Funded' ? fundedMinDays : firm.minTradingDays;
      const metTarget =
        activePhase === 'Funded' && funded101?.enabled
          ? phasePnl > 0
          : phasePnl >= phaseTarget;
      const metMinDays = daysInPhase >= requiredDays;

      const totalPos = phasePositiveDays.reduce((acc, v) => acc + v, 0);
      const maxDay = phasePositiveDays.length > 0 ? Math.max(...phasePositiveDays) : 0;
      const consistencyPct = totalPos > 0 ? (maxDay / totalPos) * 100 : 0;
      const consistencyOk =
        firm.consistencyRulePct === null || consistencyPct <= firm.consistencyRulePct;

      if (metTarget && metMinDays && consistencyOk) {
        if (activePhase === 'Fase 1') {
          const nextPhase: JourneyPhase = phase2Target > 0 ? 'Fase 2' : 'Funded';
          phaseAdvancedTo = nextPhase;
          currentPhase = nextPhase;
          phaseEquity = firm.accountSize;
          phaseHighWaterMark = firm.accountSize;
          daysInPhase = 0;
          phasePositiveDays = [];
        } else if (activePhase === 'Fase 2') {
          phaseAdvancedTo = 'Funded';
          currentPhase = 'Funded';
          phaseEquity = firm.accountSize;
          phaseHighWaterMark = firm.accountSize;
          daysInPhase = 0;
          phasePositiveDays = [];
        } else {
          status = 'Aprovado para Saque';
        }
      }
    }

    // Combined net cashflow snapshot at end of this day
    let combinedNetCashflowUsd = brokerCumulativePnl - arbitrageInputs.evaluationFeeUsd;
    if (status === 'Reprovado (Stop)' && !isFeeOnly) {
      combinedNetCashflowUsd -= ddLimit;
    } else if (status === 'Aprovado para Saque') {
      const grossPayout = Math.max(0, phasePnl) * splitRatio;
      const feeRefund = arbitrageInputs.refundOnFirstPayout
        ? arbitrageInputs.evaluationFeeUsd
        : 0;
      combinedNetCashflowUsd = grossPayout + feeRefund + brokerCumulativePnl;
    }

    steps.push({
      dayIndex: i + 1,
      entryId: entry.id,
      phase: activePhase,
      mesaPnlUsd: entry.mesaPnlUsd,
      intradayPeakOffsetUsd: entry.intradayPeakOffsetUsd,
      mesaPhaseEquityUsd: nextEquity,
      mesaPhasePnlUsd: phasePnl,
      drawdownFloorUsd: floorUsd,
      drawdownRemainingUsd: drawdownRemaining,
      brokerDailyPnlUsd: brokerDailyPnl,
      brokerCumulativePnlUsd: brokerCumulativePnl,
      appliedHedgeFactor,
      combinedNetCashflowUsd,
      phaseAdvancedTo,
      violationReason,
      note: entry.note,
    });
  }

  const lastStep = steps[steps.length - 1];
  const currentPhasePnlUsd =
    status === 'Em Andamento' && lastStep?.phaseAdvancedTo
      ? 0
      : lastStep?.mesaPhasePnlUsd ?? 0;

  const totalPosInPhase = phasePositiveDays.reduce((acc, v) => acc + v, 0);
  const maxPosDay = phasePositiveDays.length > 0 ? Math.max(...phasePositiveDays) : 0;
  const consistencyRatioPct =
    totalPosInPhase > 0 ? (maxPosDay / totalPosInPhase) * 100 : null;
  const consistencyViolated =
    firm.consistencyRulePct !== null &&
    consistencyRatioPct !== null &&
    consistencyRatioPct > firm.consistencyRulePct;

  let finalNetOutcomeUsd = brokerCumulativePnl - arbitrageInputs.evaluationFeeUsd;
  if (status === 'Reprovado (Stop)') {
    finalNetOutcomeUsd =
      (isFeeOnly ? 0 : -ddLimit) - arbitrageInputs.evaluationFeeUsd + brokerCumulativePnl;
  } else if (status === 'Aprovado para Saque') {
    const fundedPnl = Math.max(0, lastStep?.mesaPhasePnlUsd ?? fundedTarget);
    const grossPayout = fundedPnl * splitRatio;
    const feeRefund = arbitrageInputs.refundOnFirstPayout
      ? arbitrageInputs.evaluationFeeUsd
      : 0;
    finalNetOutcomeUsd = grossPayout + feeRefund + brokerCumulativePnl;
  }

  return {
    status,
    currentPhase,
    steps,
    totalDays: steps.length,
    daysInCurrentPhase: daysInPhase,
    minTradingDaysRequired: currentPhase === 'Funded' ? fundedMinDays : firm.minTradingDays,
    currentPhasePnlUsd,
    currentPhaseTargetUsd: getTargetForPhase(currentPhase),
    consistencyRatioPct,
    consistencyLimitPct: firm.consistencyRulePct,
    consistencyViolated,
    brokerCumulativePnlUsd: brokerCumulativePnl,
    finalNetOutcomeUsd,
    failureReason,
  };
}

export function generateApprovalTrajectory(
  firm: PropFirmPreset,
  arbitrageInputs: ArbitrageInputs,
  funded101?: Funded101StageConfig
): DailyTradeEntry[] {
  const entries: DailyTradeEntry[] = [];
  const p1Target =
    firm.phase1TargetUsd > 0 ? firm.phase1TargetUsd : arbitrageInputs.totalTargetUsd;
  const p2Target = firm.phase2TargetUsd;
  const fundedTarget = Math.max(500, arbitrageInputs.payoutGrossProfitUsd);

  const buildPhaseDays = (target: number, minDays: number, prefix: string) => {
    const minConsistentWinDays = firm.consistencyRulePct
      ? Math.ceil(100 / firm.consistencyRulePct) + 1
      : 3;
    const count = Math.max(minDays, minConsistentWinDays + 1);
    const lossAmount = Math.round(Math.min(target * 0.2, arbitrageInputs.drawdownUsd * 0.25));
    const totalNeeded = target + lossAmount;
    const winDays = count - 1;
    const perWin = Math.ceil(totalNeeded / Math.max(1, winDays));

    for (let i = 0; i < count; i++) {
      if (i === 1 && count >= 3) {
        entries.push({
          id: `${prefix}-loss-${i}`,
          mesaPnlUsd: -lossAmount,
          intradayPeakOffsetUsd: 0,
          note: `${prefix} · Stop controlado`,
        });
      } else {
        const remaining =
          target -
          entries
            .filter((e) => e.id.startsWith(prefix))
            .reduce((acc, e) => acc + e.mesaPnlUsd, 0);
        const amount = i === count - 1 ? Math.max(perWin, remaining) : perWin;
        entries.push({
          id: `${prefix}-win-${i}`,
          mesaPnlUsd: Math.round(amount),
          intradayPeakOffsetUsd: Math.round(amount * 0.2),
          note: `${prefix} · Dia positivo`,
        });
      }
    }
  };

  buildPhaseDays(p1Target, firm.minTradingDays, 'Fase 1');
  if (p2Target > 0) {
    buildPhaseDays(p2Target, firm.minTradingDays, 'Fase 2');
  }

  if (funded101?.enabled) {
    const days = Math.max(firm.minTradingDays, Math.max(1, funded101.activeDaysTarget));
    const target101 = Math.max(50, Math.round(funded101.shortTargetUsd));
    for (let d = 1; d <= days; d++) {
      entries.push({
        id: `Funded-101-${d}`,
        mesaPnlUsd: target101,
        intradayPeakOffsetUsd: Math.round(target101 * 0.15),
        note: 'Funded (10:1) · Meta curta',
      });
    }
  } else {
    buildPhaseDays(fundedTarget, Math.max(2, firm.minTradingDays), 'Funded');
  }

  return entries;
}

export function generateStopOutTrajectory(
  firm: PropFirmPreset,
  arbitrageInputs: ArbitrageInputs
): DailyTradeEntry[] {
  const dd = arbitrageInputs.drawdownUsd;
  if (firm.drawdownType === 'Trailing Intradiário') {
    return [
      {
        id: `stop-1-${Date.now()}`,
        mesaPnlUsd: Math.round(dd * 0.35),
        intradayPeakOffsetUsd: Math.round(dd * 0.55),
        note: 'Dia positivo com pico intradiário puxando Trailing',
      },
      {
        id: `stop-2-${Date.now()}`,
        mesaPnlUsd: -Math.round(dd * 0.65),
        intradayPeakOffsetUsd: Math.round(dd * 0.45),
        note: 'Pico flutuante seguido de reversão — viola Trailing Intradiário',
      },
    ];
  }

  const step1 = -Math.round(dd * 0.4);
  const step2 = Math.round(dd * 0.2);
  const step3 = -(dd - Math.abs(step1) + step2);
  return [
    {
      id: `stop-1-${Date.now()}`,
      mesaPnlUsd: step1,
      intradayPeakOffsetUsd: 0,
      note: 'Dia 1 · Recuo inicial',
    },
    {
      id: `stop-2-${Date.now()}`,
      mesaPnlUsd: step2,
      intradayPeakOffsetUsd: 0,
      note: 'Dia 2 · Recuperação parcial',
    },
    {
      id: `stop-3-${Date.now()}`,
      mesaPnlUsd: step3,
      intradayPeakOffsetUsd: 0,
      note: 'Dia 3 · Stop de Drawdown (Cenário A)',
    },
  ];
}

export interface RandomSimulationOptions {
  sizingMode?: RandomSizingMode;
  winRatePct?: number;
  rewardToRisk?: number;
  minDaysDivisor?: number;
  baseRiskUsd?: number;
  hedgeDuringFunded?: boolean;
  funded101Enabled?: boolean;
  fundedShortTargetUsd?: number;
  fundedWinRatePct?: number;
  fundedActiveDaysTarget?: number;
  fundedStopMaxUsd?: number;
  protectDoubleLoss?: boolean;
}

export function generateRandomTrajectory(
  firm: PropFirmPreset,
  arbitrageInputs: ArbitrageInputs,
  hedgeFactor: number,
  options: RandomSimulationOptions = {}
): DailyTradeEntry[] {
  const sizingMode: RandomSizingMode = options.sizingMode ?? 'dd_max_meta_dias';
  const evalWinRate = Math.max(5, Math.min(95, options.winRatePct ?? 58)) / 100;
  const rr = Math.max(0.1, Math.min(6, options.rewardToRisk ?? 0.75));
  const daysDivisor = Math.max(1, Math.round(options.minDaysDivisor ?? Math.max(1, firm.minTradingDays)));
  const ddMax = Math.max(50, arbitrageInputs.drawdownUsd);
  const fallbackRisk = Math.max(50, Math.round(ddMax * 0.2));
  const baseRisk = Math.max(25, options.baseRiskUsd ?? fallbackRisk);
  const hedgeDuringFunded = options.hedgeDuringFunded ?? false;
  const protectDoubleLoss = options.protectDoubleLoss ?? true;

  const funded101Config: Funded101StageConfig = {
    enabled: options.funded101Enabled ?? true,
    activeDaysTarget: Math.max(1, options.fundedActiveDaysTarget ?? Math.max(5, firm.minTradingDays)),
    shortTargetUsd: Math.max(50, options.fundedShortTargetUsd ?? 150),
    stopMaxUsd: Math.max(50, options.fundedStopMaxUsd ?? Math.min(ddMax, (options.fundedShortTargetUsd ?? 150) * 10)),
  };
  const fundedStopMax = funded101Config.stopMaxUsd ?? ddMax;
  const fundedWinRate = Math.max(50, Math.min(99, options.fundedWinRatePct ?? 92)) / 100;

  const p1Target =
    firm.phase1TargetUsd > 0 ? firm.phase1TargetUsd : arbitrageInputs.totalTargetUsd;
  const p2Target = firm.phase2TargetUsd;
  const fundedTarget = Math.max(100, arbitrageInputs.payoutGrossProfitUsd);

  const getPhaseTarget = (phase: JourneyPhase) => {
    if (phase === 'Fase 1') return p1Target;
    if (phase === 'Fase 2') return p2Target;
    return fundedTarget;
  };

  const entries: DailyTradeEntry[] = [];
  const runNonce = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const maxDays = 45;

  for (let day = 1; day <= maxDays; day++) {
    const prevSim = runDailySimulation(
      entries,
      firm,
      arbitrageInputs,
      hedgeFactor,
      hedgeDuringFunded,
      funded101Config,
      protectDoubleLoss
    );
    if (prevSim.status !== 'Em Andamento') {
      break;
    }

    const currentPhase = prevSim.currentPhase;
    const phaseTarget = getPhaseTarget(currentPhase);
    const lastStep = prevSim.steps[prevSim.steps.length - 1];
    const currentEquity =
      lastStep && !lastStep.phaseAdvancedTo ? lastStep.mesaPhaseEquityUsd : firm.accountSize;
    const currentFloor =
      lastStep && !lastStep.phaseAdvancedTo
        ? lastStep.drawdownFloorUsd
        : firm.accountSize - ddMax;
    const remainingToFloor = Math.max(10, currentEquity - currentFloor);

    const isFunded101Day = currentPhase === 'Funded' && funded101Config.enabled;
    let tpUsd = Math.round(phaseTarget / daysDivisor);
    let slUsd = Math.round(ddMax);

    if (isFunded101Day) {
      tpUsd = Math.round(funded101Config.shortTargetUsd);
      slUsd = Math.round(Math.min(fundedStopMax, remainingToFloor));
    } else if (sizingMode === 'dd_max_meta_dias') {
      tpUsd = Math.max(10, Math.round(phaseTarget / daysDivisor));
      slUsd = Math.round(ddMax);
    } else if (sizingMode === 'dd_max_rr') {
      slUsd = Math.round(ddMax);
      tpUsd = Math.max(10, Math.round(slUsd * rr));
    } else if (sizingMode === 'meta_dias_rr') {
      tpUsd = Math.max(10, Math.round(phaseTarget / daysDivisor));
      slUsd = Math.max(10, Math.round(tpUsd / rr));
    } else {
      const variance = 0.65 + Math.random() * 0.75;
      slUsd = Math.round((baseRisk * variance) / 10) * 10;
      tpUsd = Math.round((baseRisk * rr * variance) / 10) * 10;
    }

    const isWin = Math.random() < (isFunded101Day ? fundedWinRate : evalWinRate);
    const rawPnl = isWin ? tpUsd : -Math.min(slUsd, remainingToFloor);

    const intradayPeakOffsetUsd =
      firm.drawdownType === 'Trailing Intradiário'
        ? Math.round(tpUsd * (0.25 + Math.random() * 0.6))
        : isWin
        ? Math.round(tpUsd * (0.05 + Math.random() * 0.15))
        : 0;

    entries.push({
      id: `rand-${runNonce}-${day}`,
      mesaPnlUsd: rawPnl,
      intradayPeakOffsetUsd,
      note: isFunded101Day
        ? isWin
          ? `Funded (10:1) · Dia Normal (+${formatUsd(tpUsd)})`
          : `Funded (10:1) · Cisne Negro (${formatUsd(rawPnl)})`
        : isWin
        ? `${currentPhase} · Take Profit (+${formatUsd(tpUsd)})`
        : `${currentPhase} · Stop Loss (${formatUsd(rawPnl)})`,
    });

    const nextSim = runDailySimulation(
      entries,
      firm,
      arbitrageInputs,
      hedgeFactor,
      hedgeDuringFunded,
      funded101Config,
      protectDoubleLoss
    );
    if (nextSim.status !== 'Em Andamento') {
      break;
    }
  }

  return entries;
}

export function calculateFundedMethod101(
  inputs: FundedMethod101Inputs,
  instrumentId: InstrumentId,
  customPointValueUsd: number,
  arbitrageInputs: ArbitrageInputs,
  hedgeFactor: number,
  protectDoubleLoss = true
): FundedMethod101Outputs {
  const spec = INSTRUMENT_SPECS.find((item) => item.id === instrumentId);
  const pointValue =
    instrumentId === 'CUSTOM'
      ? customPointValueUsd
      : (spec?.pointValuePerStandardLot ?? 1);

  if (
    !Number.isFinite(inputs.shortTargetUsd) ||
    inputs.shortTargetUsd <= 0 ||
    !Number.isFinite(inputs.remainingDrawdownUsd) ||
    inputs.remainingDrawdownUsd <= 0 ||
    !Number.isFinite(inputs.stopLossPoints) ||
    inputs.stopLossPoints <= 0 ||
    !Number.isFinite(pointValue) ||
    pointValue <= 0
  ) {
    return {
      isValid: false,
      validationError:
        'Alvo curto, drawdown remanescente, stop loss em pontos e valor do ponto devem ser maiores que zero.',
      effectiveHedgeFactor: 0,
      propFirmLot: 0,
      brokerHedgeLot: 0,
      takeProfitPoints: 0,
      impliedNegativeRatio: 0,
      normalDay: {
        mesaGainUsd: 0,
        hedgeCostUsd: 0,
        netAfterSplitUsd: 0,
        calendarMesaTotalUsd: 0,
        calendarHedgeCostTotalUsd: 0,
        calendarNetAfterSplitUsd: 0,
      },
      failureDay: {
        mesaLossUsd: 0,
        brokerInsuranceGainUsd: 0,
        netBeforeFeeUsd: 0,
        netAfterFeeUsd: 0,
      },
    };
  }

  const isFeeOnly = (arbitrageInputs.hedgeFactorMode ?? 'include_dd') === 'fee_only';
  const effectiveHedgeFactor = protectDoubleLoss
    ? Math.max(
        0,
        ((isFeeOnly ? 0 : inputs.remainingDrawdownUsd) +
          arbitrageInputs.evaluationFeeUsd +
          arbitrageInputs.additionalProfitUsd) /
          inputs.remainingDrawdownUsd
      )
    : Math.max(0, hedgeFactor);

  // L_M = Stop_Max_USD / (Stop_Loss_Pontos * Valor_Ponto)
  const propFirmLot = inputs.remainingDrawdownUsd / (inputs.stopLossPoints * pointValue);
  // L_C = L_M * F_10:1
  const brokerHedgeLot = propFirmLot * effectiveHedgeFactor;
  // Distância do Take Profit em pontos/pips para atingir o Alvo Curto com L_M
  const takeProfitPoints = inputs.shortTargetUsd / (propFirmLot * pointValue);
  const impliedNegativeRatio = inputs.remainingDrawdownUsd / inputs.shortTargetUsd;

  const splitRatio = arbitrageInputs.profitSplitPct / 100;
  const days = Math.max(1, Math.round(inputs.activeDaysTarget));

  // Dia Normal (Win na Prop Firm -> SL na Conta Hedge)
  const mesaGainUsd = inputs.shortTargetUsd;
  const hedgeCostUsd = -(inputs.shortTargetUsd * effectiveHedgeFactor);
  const netAfterSplitUsd = mesaGainUsd * splitRatio + hedgeCostUsd;

  const calendarMesaTotalUsd = mesaGainUsd * days;
  const calendarHedgeCostTotalUsd = hedgeCostUsd * days;
  const calendarNetAfterSplitUsd = calendarMesaTotalUsd * splitRatio + calendarHedgeCostTotalUsd;

  // Dia de Falha / Cisne Negro (SL 1:10 na Prop Firm -> TP 10:1 na Conta Hedge)
  const mesaLossUsd = isFeeOnly ? 0 : -inputs.remainingDrawdownUsd;
  const brokerInsuranceGainUsd = inputs.remainingDrawdownUsd * effectiveHedgeFactor;
  const netBeforeFeeUsd = mesaLossUsd + brokerInsuranceGainUsd;
  const netAfterFeeUsd = netBeforeFeeUsd - arbitrageInputs.evaluationFeeUsd;

  return {
    isValid: true,
    effectiveHedgeFactor,
    propFirmLot,
    brokerHedgeLot,
    takeProfitPoints,
    impliedNegativeRatio,
    normalDay: {
      mesaGainUsd,
      hedgeCostUsd,
      netAfterSplitUsd,
      calendarMesaTotalUsd,
      calendarHedgeCostTotalUsd,
      calendarNetAfterSplitUsd,
    },
    failureDay: {
      mesaLossUsd,
      brokerInsuranceGainUsd,
      netBeforeFeeUsd,
      netAfterFeeUsd,
    },
  };
}

export interface MonteCarloOptions extends RandomSimulationOptions {
  numRuns?: number;
  maxDays?: number;
}

function getQuantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

export function runMonteCarloSimulation(
  firm: PropFirmPreset,
  arbitrageInputs: ArbitrageInputs,
  hedgeFactor: number,
  options: MonteCarloOptions = {}
): MonteCarloSummary {
  const numRuns = Math.max(100, Math.min(10000, Math.round(options.numRuns ?? 1000)));
  const maxDays = Math.max(15, Math.min(90, Math.round(options.maxDays ?? 50)));

  const sizingMode: RandomSizingMode = options.sizingMode ?? 'dd_max_meta_dias';
  const evalWinRate = Math.max(5, Math.min(95, options.winRatePct ?? 58)) / 100;
  const rr = Math.max(0.1, Math.min(6, options.rewardToRisk ?? 0.75));
  const daysDivisor = Math.max(1, Math.round(options.minDaysDivisor ?? Math.max(1, firm.minTradingDays)));
  const ddLimit = Math.max(50, arbitrageInputs.drawdownUsd);
  const fallbackRisk = Math.max(50, Math.round(ddLimit * 0.2));
  const baseRisk = Math.max(25, options.baseRiskUsd ?? fallbackRisk);
  const hedgeDuringFunded = options.hedgeDuringFunded ?? true;
  const protectDoubleLoss = options.protectDoubleLoss ?? true;
  const isFeeOnly = (arbitrageInputs.hedgeFactorMode ?? 'include_dd') === 'fee_only';
  const splitRatio = arbitrageInputs.profitSplitPct / 100;
  const evalFee = arbitrageInputs.evaluationFeeUsd;
  const addProfit = arbitrageInputs.additionalProfitUsd;
  const feeRefundAmount = arbitrageInputs.refundOnFirstPayout ? evalFee : 0;

  const funded101Enabled = options.funded101Enabled ?? true;
  const fundedShortTarget = Math.max(50, options.fundedShortTargetUsd ?? 150);
  const fundedActiveDays = Math.max(
    firm.minTradingDays,
    Math.max(1, Math.round(options.fundedActiveDaysTarget ?? Math.max(5, firm.minTradingDays)))
  );
  const fundedStopMax = Math.max(50, options.fundedStopMaxUsd ?? ddLimit);
  const fundedWinRate = Math.max(50, Math.min(99, options.fundedWinRatePct ?? 92)) / 100;

  const phase1Target =
    firm.phase1TargetUsd > 0 ? firm.phase1TargetUsd : arbitrageInputs.totalTargetUsd;
  const phase2Target = firm.phase2TargetUsd;
  const fundedTarget = funded101Enabled
    ? fundedShortTarget * fundedActiveDays
    : Math.max(100, arbitrageInputs.payoutGrossProfitUsd);

  const getTargetForPhase = (phase: JourneyPhase) => {
    if (phase === 'Fase 1') return phase1Target;
    if (phase === 'Fase 2') return phase2Target;
    return fundedTarget;
  };

  const computeFloor = (hwm: number) => {
    if (firm.drawdownType === 'Estático') {
      return firm.accountSize - ddLimit;
    }
    return Math.min(firm.accountSize, hwm - ddLimit);
  };

  interface RunResult {
    id: number;
    status: JourneyStatus;
    stoppedInEval: boolean;
    stoppedInFunded: boolean;
    passedEval: boolean;
    finalNetUsd: number;
    daysTaken: number;
    maxBrokerOutlayUsd: number;
    series: number[];
  }

  const results: RunResult[] = new Array(numRuns);
  let longestDay = 1;

  for (let r = 0; r < numRuns; r++) {
    let currentPhase: JourneyPhase = 'Fase 1';
    let status: JourneyStatus = 'Em Andamento';
    let phaseEquity = firm.accountSize;
    let phaseHighWaterMark = firm.accountSize;
    let daysInPhase = 0;
    let totalPosInPhase = 0;
    let maxPosDayInPhase = 0;
    let brokerCumulativePnl = 0;
    let passedEval = false;
    let stoppedInEval = false;
    let stoppedInFunded = false;
    let maxBrokerOutlayUsd = evalFee;
    let finalNetUsd = -evalFee;
    let daysTaken = 0;
    const series: number[] = [];

    for (let day = 1; day <= maxDays; day++) {
      if (status !== 'Em Andamento') break;

      const activePhase = currentPhase;
      const isHedgeActiveToday = activePhase !== 'Funded' || hedgeDuringFunded;
      const floorBefore = computeFloor(phaseHighWaterMark);
      const remainingToFloorBefore = Math.max(10, phaseEquity - floorBefore);
      const effectiveLiquidationLoss =
        firm.dailyLossLimitUsd > 0
          ? Math.min(remainingToFloorBefore, firm.dailyLossLimitUsd)
          : remainingToFloorBefore;

      const isFunded101Day = activePhase === 'Funded' && funded101Enabled;
      const slRiskDenominator = isFunded101Day
        ? Math.min(effectiveLiquidationLoss, fundedStopMax)
        : effectiveLiquidationLoss;

      let appliedHedgeFactor = 0;
      if (isHedgeActiveToday) {
        if (protectDoubleLoss) {
          const projectedLossOnStop = isFeeOnly
            ? 0
            : ddLimit - remainingToFloorBefore + slRiskDenominator;
          const neededBrokerGain =
            projectedLossOnStop + evalFee + addProfit - brokerCumulativePnl;
          appliedHedgeFactor = Math.max(0, neededBrokerGain / slRiskDenominator);
        } else {
          appliedHedgeFactor = hedgeFactor;
        }
      }

      const phaseTarget = getTargetForPhase(activePhase);

      let tpUsd = Math.round(phaseTarget / daysDivisor);
      let slUsd = Math.round(ddLimit);

      if (isFunded101Day) {
        tpUsd = Math.round(fundedShortTarget);
        slUsd = Math.round(Math.min(fundedStopMax, remainingToFloorBefore));
      } else if (sizingMode === 'dd_max_meta_dias') {
        tpUsd = Math.max(10, Math.round(phaseTarget / daysDivisor));
        slUsd = Math.round(ddLimit);
      } else if (sizingMode === 'dd_max_rr') {
        slUsd = Math.round(ddLimit);
        tpUsd = Math.max(10, Math.round(slUsd * rr));
      } else if (sizingMode === 'meta_dias_rr') {
        tpUsd = Math.max(10, Math.round(phaseTarget / daysDivisor));
        slUsd = Math.max(10, Math.round(tpUsd / rr));
      } else {
        const variance = 0.65 + Math.random() * 0.75;
        slUsd = Math.round((baseRisk * variance) / 10) * 10;
        tpUsd = Math.round((baseRisk * rr * variance) / 10) * 10;
      }

      const isWin = Math.random() < (isFunded101Day ? fundedWinRate : evalWinRate);
      const mesaPnlUsd = isWin ? tpUsd : -Math.min(slUsd, remainingToFloorBefore);
      const intradayPeakOffsetUsd =
        firm.drawdownType === 'Trailing Intradiário'
          ? Math.round(tpUsd * (0.25 + Math.random() * 0.6))
          : isWin
          ? Math.round(tpUsd * (0.05 + Math.random() * 0.15))
          : 0;

      const brokerDailyPnl = isHedgeActiveToday ? -mesaPnlUsd * appliedHedgeFactor : 0;
      brokerCumulativePnl += brokerDailyPnl;
      maxBrokerOutlayUsd = Math.max(maxBrokerOutlayUsd, evalFee - brokerCumulativePnl);

      daysInPhase += 1;
      daysTaken = day;

      let effectiveHwm = phaseHighWaterMark;
      if (firm.drawdownType === 'Trailing Intradiário' && intradayPeakOffsetUsd > 0) {
        effectiveHwm = Math.max(effectiveHwm, phaseEquity + intradayPeakOffsetUsd);
      }

      const nextEquity = phaseEquity + mesaPnlUsd;
      if (firm.drawdownType === 'Trailing EOD' || firm.drawdownType === 'Trailing Intradiário') {
        effectiveHwm = Math.max(effectiveHwm, nextEquity);
      }

      const floorUsd = computeFloor(effectiveHwm);
      const phasePnl = nextEquity - firm.accountSize;

      if (mesaPnlUsd > 0) {
        totalPosInPhase += mesaPnlUsd;
        if (mesaPnlUsd > maxPosDayInPhase) maxPosDayInPhase = mesaPnlUsd;
      }

      const violatedDaily =
        firm.dailyLossLimitUsd > 0 && mesaPnlUsd <= -firm.dailyLossLimitUsd;
      const violatedFloor = nextEquity <= floorUsd;

      if (violatedDaily || violatedFloor) {
        status = 'Reprovado (Stop)';
        if (activePhase === 'Funded') {
          stoppedInFunded = true;
        } else {
          stoppedInEval = true;
        }
        phaseEquity = nextEquity;
        phaseHighWaterMark = effectiveHwm;
      } else {
        phaseEquity = nextEquity;
        phaseHighWaterMark = effectiveHwm;

        const requiredDays = activePhase === 'Funded' ? fundedActiveDays : firm.minTradingDays;
        const metTarget =
          activePhase === 'Funded' && funded101Enabled
            ? phasePnl > 0
            : phasePnl >= phaseTarget;
        const metMinDays = daysInPhase >= requiredDays;
        const consistencyPct = totalPosInPhase > 0 ? (maxPosDayInPhase / totalPosInPhase) * 100 : 0;
        const consistencyOk =
          firm.consistencyRulePct === null || consistencyPct <= firm.consistencyRulePct;

        if (metTarget && metMinDays && consistencyOk) {
          if (activePhase === 'Fase 1') {
            const nextPhase: JourneyPhase = phase2Target > 0 ? 'Fase 2' : 'Funded';
            if (nextPhase === 'Funded') passedEval = true;
            currentPhase = nextPhase;
            phaseEquity = firm.accountSize;
            phaseHighWaterMark = firm.accountSize;
            daysInPhase = 0;
            totalPosInPhase = 0;
            maxPosDayInPhase = 0;
          } else if (activePhase === 'Fase 2') {
            passedEval = true;
            currentPhase = 'Funded';
            phaseEquity = firm.accountSize;
            phaseHighWaterMark = firm.accountSize;
            daysInPhase = 0;
            totalPosInPhase = 0;
            maxPosDayInPhase = 0;
          } else {
            status = 'Aprovado para Saque';
          }
        }
      }

      let combinedNet = brokerCumulativePnl - evalFee;
      if (status === 'Reprovado (Stop)' && !isFeeOnly) {
        combinedNet -= ddLimit;
      } else if (status === 'Aprovado para Saque') {
        const grossPayout = Math.max(0, phasePnl) * splitRatio;
        combinedNet = grossPayout + feeRefundAmount + brokerCumulativePnl;
      }

      finalNetUsd = combinedNet;
      series.push(combinedNet);
    }

    if (series.length > longestDay) longestDay = series.length;

    results[r] = {
      id: r,
      status,
      stoppedInEval,
      stoppedInFunded,
      passedEval,
      finalNetUsd,
      daysTaken,
      maxBrokerOutlayUsd,
      series,
    };
  }

  let payoutCount = 0;
  let stopInEvalCount = 0;
  let stopInFundedCount = 0;
  let incompleteCount = 0;
  let evalPassedCount = 0;
  let negativeOutcomeCount = 0;

  let sumNet = 0;
  let sumDays = 0;
  let sumOutlay = 0;
  let sumPayoutNet = 0;
  let sumStopNet = 0;

  const finalNets: number[] = new Array(numRuns);
  const outlays: number[] = new Array(numRuns);

  for (let i = 0; i < numRuns; i++) {
    const res = results[i];
    finalNets[i] = res.finalNetUsd;
    outlays[i] = res.maxBrokerOutlayUsd;
    sumNet += res.finalNetUsd;
    sumDays += res.daysTaken;
    sumOutlay += res.maxBrokerOutlayUsd;
    if (res.finalNetUsd < 0) negativeOutcomeCount++;
    if (res.passedEval) evalPassedCount++;
    if (res.status === 'Aprovado para Saque') {
      payoutCount++;
      sumPayoutNet += res.finalNetUsd;
    } else if (res.status === 'Reprovado (Stop)') {
      sumStopNet += res.finalNetUsd;
      if (res.stoppedInFunded) stopInFundedCount++;
      else stopInEvalCount++;
    } else {
      incompleteCount++;
    }
  }

  const sortedNets = [...finalNets].sort((a, b) => a - b);
  const sortedOutlays = [...outlays].sort((a, b) => a - b);

  const expectedNetUsd = sumNet / numRuns;
  const medianNetUsd = getQuantile(sortedNets, 0.5);
  const p10NetUsd = getQuantile(sortedNets, 0.1);
  const p90NetUsd = getQuantile(sortedNets, 0.9);
  const minNetUsd = sortedNets[0] ?? 0;
  const maxNetUsd = sortedNets[sortedNets.length - 1] ?? 0;
  const p95MaxBrokerOutlayUsd = getQuantile(sortedOutlays, 0.95);

  const stopCount = stopInEvalCount + stopInFundedCount;
  const avgPayoutNetUsd = payoutCount > 0 ? sumPayoutNet / payoutCount : 0;
  const avgStopNetUsd = stopCount > 0 ? sumStopNet / stopCount : 0;

  // Build daily percentile curves (carrying forward completed runs' final net)
  const percentilesByDay: MonteCarloPercentilePoint[] = [];
  const dayValues = new Array<number>(numRuns);
  for (let d = 0; d < longestDay; d++) {
    for (let r = 0; r < numRuns; r++) {
      const s = results[r].series;
      dayValues[r] = d < s.length ? s[d] : s[s.length - 1] ?? results[r].finalNetUsd;
    }
    const sortedDay = [...dayValues].sort((a, b) => a - b);
    percentilesByDay.push({
      day: d + 1,
      p10: getQuantile(sortedDay, 0.1),
      p50: getQuantile(sortedDay, 0.5),
      p90: getQuantile(sortedDay, 0.9),
    });
  }

  // Stratified sample of 24 paths sorted by final net outcome
  const sortedResults = [...results].sort((a, b) => a.finalNetUsd - b.finalNetUsd);
  const sampleCount = Math.min(24, numRuns);
  const samplePaths: MonteCarloSamplePath[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const idx =
      sampleCount === 1
        ? 0
        : Math.round((i / (sampleCount - 1)) * (sortedResults.length - 1));
    const picked = sortedResults[idx];
    samplePaths.push({
      id: picked.id,
      outcome: picked.status,
      finalNetUsd: picked.finalNetUsd,
      points: picked.series,
    });
  }

  // Build 9-bin histogram
  const binCount = 9;
  const span = maxNetUsd - minNetUsd;
  const histogram: MonteCarloHistogramBin[] = [];
  if (span < 1) {
    histogram.push({
      label: formatUsd(minNetUsd, true),
      minUsd: minNetUsd,
      maxUsd: maxNetUsd,
      count: numRuns,
      pct: 100,
    });
  } else {
    const step = span / binCount;
    const counts = new Array<number>(binCount).fill(0);
    for (let i = 0; i < numRuns; i++) {
      const val = finalNets[i];
      const rawBin = Math.floor((val - minNetUsd) / step);
      const binIdx = Math.max(0, Math.min(binCount - 1, rawBin));
      counts[binIdx] += 1;
    }
    for (let b = 0; b < binCount; b++) {
      const binMin = minNetUsd + b * step;
      const binMax = minNetUsd + (b + 1) * step;
      const mid = (binMin + binMax) / 2;
      histogram.push({
        label: `${mid >= 0 ? '+' : '-'}$${Math.round(Math.abs(mid))}`,
        minUsd: binMin,
        maxUsd: binMax,
        count: counts[b],
        pct: (counts[b] / numRuns) * 100,
      });
    }
  }

  return {
    numRuns,
    evalPassRatePct: (evalPassedCount / numRuns) * 100,
    payoutSuccessRatePct: (payoutCount / numRuns) * 100,
    stopOutRatePct: (stopCount / numRuns) * 100,
    stopInEvalCount,
    stopInFundedCount,
    payoutCount,
    incompleteCount,
    expectedNetUsd,
    medianNetUsd,
    p10NetUsd,
    p90NetUsd,
    minNetUsd,
    maxNetUsd,
    negativeOutcomeRatePct: (negativeOutcomeCount / numRuns) * 100,
    avgDaysToFinish: sumDays / numRuns,
    avgMaxBrokerOutlayUsd: sumOutlay / numRuns,
    p95MaxBrokerOutlayUsd,
    avgPayoutNetUsd,
    avgStopNetUsd,
    samplePaths,
    percentilesByDay,
    histogram,
  };
}




