import { INSTRUMENT_SPECS } from '../data/propFirms2026.ts';
import type {
  AccountLifecycleState,
  ArbitrageInputs,
  ArbitrageOutputs,
  ArbitragePayoffPoint,
  CapitalBonusInputs,
  CapitalBonusOutputs,
  ConsistencyRule,
  DailySimulationStep,
  DailySimulationSummary,
  DailyTradeEntry,
  DrawdownRule,
  FundedMethod101Inputs,
  FundedMethod101Outputs,
  InstrumentId,
  JourneyPhase,
  JourneyStatus,
  MonteCarloHistogramBin,
  MonteCarloPercentilePoint,
  MonteCarloSamplePath,
  MonteCarloSummary,
  PayoutEligibilityResult,
  PayoutHedgeContext,
  PhaseTransitionEvent,
  PropFirmPreset,
  RandomSizingMode,
  SavedSimulation,
  StepPreviewOutputs,
  TradeSizingInputs,
  TradeSizingOutputs,
  TradeSizingSensitivityRow,
} from '../types/quant.ts';
import { validateFirmContract } from './contractual.ts';
import { sanitizeCsvCell } from './security.ts';

// ---------------------------------------------------------------------------
// Financial Precision & Rounding Policies
// ---------------------------------------------------------------------------

export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  const adjusted = value + Math.sign(value) * 1e-9;
  const rounded = Math.round(adjusted * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function roundCurrency(value: number): number {
  return roundTo(value, 2);
}

export function roundLots(value: number): number {
  return roundTo(value, 2);
}

export function roundFactor(value: number): number {
  return roundTo(value, 4);
}

export function roundPoints(value: number, tickPrecision = 1): number {
  return roundTo(value, Math.max(0, Math.min(6, tickPrecision)));
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

// Deterministic Seeded PRNG (Mulberry32) for reproducible Monte Carlo runs
export function createSeededPrng(seedInput?: number): { next: () => number; seed: number } {
  const seed =
    typeof seedInput === 'number' && Number.isFinite(seedInput)
      ? (Math.trunc(seedInput) >>> 0) || 1
      : ((Date.now() ^ 0x9e3779b9) >>> 0) || 1;
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, seed };
}

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------

export function formatUsd(value: number, showSign = false): string {
  const safe = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(safe);
  const formatted = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(abs);

  if (safe < 0) return `-$${formatted}`;
  if (showSign && safe > 0) return `+$${formatted}`;
  return `$${formatted}`;
}

export function formatLot(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(2);
}

export function formatFactor(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(4);
}

// ---------------------------------------------------------------------------
// Module 1: Arbitrage & Asymmetric Hedging Engine
// ---------------------------------------------------------------------------

export function calculateArbitrage(inputs: ArbitrageInputs): ArbitrageOutputs {
  const {
    hedgeFactorMode = 'include_dd',
    drawdownUsd,
    evaluationFeeUsd,
    activationFeeUsd = 0,
    additionalProfitUsd,
    totalTargetUsd,
    payoutGrossProfitUsd,
    profitSplitPct,
    refundOnFirstPayout,
  } = inputs;

  const emptyResult = (validationError: string): ArbitrageOutputs => ({
    isValid: false,
    validationError,
    hedgeFactor: 0,
    scenarioA: { propFirmLoss: 0, feeCost: 0, brokerGain: 0, netResult: 0 },
    scenarioB: {
      accumulatedHedgeLoss: 0,
      evaluationFeePaid: 0,
      activationFeePaid: 0,
      grossPayout: 0,
      feeRefund: 0,
      firstPayoutNet: 0,
      subsequentPayoutNet: 0,
      breakEvenProfitNeeded: 0,
    },
  });

  if (!Number.isFinite(drawdownUsd) || drawdownUsd <= 0) {
    return emptyResult('O Limite de Drawdown Total (DD) deve ser maior que $0.');
  }

  if (
    !isFiniteNonNegative(evaluationFeeUsd) ||
    !isFiniteNonNegative(activationFeeUsd) ||
    !isFiniteNonNegative(additionalProfitUsd) ||
    !isFiniteNonNegative(totalTargetUsd) ||
    !isFiniteNonNegative(payoutGrossProfitUsd) ||
    !Number.isFinite(profitSplitPct) ||
    profitSplitPct <= 0 ||
    profitSplitPct > 100
  ) {
    return emptyResult(
      'Verifique os valores informados: taxas, lucros e metas devem ser finitos e não negativos, e o Profit Split deve estar entre 1% e 100%.'
    );
  }

  // Modo 'include_dd': F = (DD + T_eval + L_adic) / DD
  // Modo 'fee_only': F = (T_eval + L_adic) / DD (DD da mesa é virtual; desembolso real na avaliação é apenas T_eval)
  const isFeeOnly = hedgeFactorMode === 'fee_only';
  const rawHedgeFactor = isFeeOnly
    ? (evaluationFeeUsd + additionalProfitUsd) / drawdownUsd
    : (drawdownUsd + evaluationFeeUsd + additionalProfitUsd) / drawdownUsd;
  const hedgeFactor = roundTo(rawHedgeFactor, 8);

  // Cenário A — Reprovação na Avaliação (Stop atingido antes de ativar Funded, sem taxa de ativação)
  const propFirmLoss = isFeeOnly ? 0 : roundCurrency(-drawdownUsd);
  const feeCost = roundCurrency(-evaluationFeeUsd);
  const brokerGain = roundCurrency(drawdownUsd * hedgeFactor);
  const scenarioANet = roundCurrency(propFirmLoss + feeCost + brokerGain);

  // Cenário B — Aprovação, Ativação Funded e 1º Payout (contabiliza T_eval + T_act pagos)
  const splitRatio = profitSplitPct / 100;
  const accumulatedHedgeLoss = roundCurrency(totalTargetUsd * hedgeFactor);
  const evaluationFeePaid = roundCurrency(evaluationFeeUsd);
  const activationFeePaid = roundCurrency(activationFeeUsd);
  const grossPayout = roundCurrency(payoutGrossProfitUsd * splitRatio);
  const feeRefund = refundOnFirstPayout ? evaluationFeePaid : 0;
  const firstPayoutNet = roundCurrency(
    grossPayout + feeRefund - evaluationFeePaid - activationFeePaid - accumulatedHedgeLoss
  );
  const subsequentPayoutNet = roundCurrency(payoutGrossProfitUsd * splitRatio);

  const breakEvenProfitNeeded = roundCurrency(
    Math.max(0, (accumulatedHedgeLoss + evaluationFeePaid + activationFeePaid - feeRefund) / splitRatio)
  );

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
      evaluationFeePaid,
      activationFeePaid,
      grossPayout,
      feeRefund,
      firstPayoutNet,
      subsequentPayoutNet,
      breakEvenProfitNeeded,
    },
  };
}

export function calculateArbitragePayoffCurve(
  inputs: ArbitrageInputs,
  outputs: ArbitrageOutputs,
  steps = 16
): ArbitragePayoffPoint[] {
  const safeSteps = Math.max(4, Math.min(64, Math.round(steps)));
  const dd = Math.max(1, Number.isFinite(inputs.drawdownUsd) ? inputs.drawdownUsd : 1);
  const target = Math.max(1, Number.isFinite(inputs.totalTargetUsd) ? inputs.totalTargetUsd : 1);
  const f = outputs.isValid ? outputs.hedgeFactor : 1;
  const isFeeOnly = (inputs.hedgeFactorMode ?? 'include_dd') === 'fee_only';
  const evalFee = isFiniteNonNegative(inputs.evaluationFeeUsd) ? inputs.evaluationFeeUsd : 0;

  const xMin = -dd;
  const xMax = target;

  return Array.from({ length: safeSteps + 1 }, (_, i) => {
    const mesaExcursion = roundCurrency(xMin + ((xMax - xMin) * i) / safeSteps);
    const hedgePnl = roundCurrency(-mesaExcursion * f);
    const combinedFloating = roundCurrency(
      isFeeOnly ? hedgePnl - evalFee : mesaExcursion + hedgePnl - evalFee
    );
    return { mesaExcursion, hedgePnl, combinedFloating };
  });
}

// ---------------------------------------------------------------------------
// Module 2: Trade-by-Trade Sizing
// ---------------------------------------------------------------------------

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
    inputs.desiredRiskUsd <= 0 ||
    !Number.isFinite(hedgeFactor) ||
    hedgeFactor < 0
  ) {
    return {
      isValid: false,
      validationError: 'Risco ($), Stop Loss, Valor do Ponto e Fator de Hedge precisam ser válidos e positivos.',
      effectivePointValueUsd: Math.max(0, Number.isFinite(effectivePointValueUsd) ? effectivePointValueUsd : 0),
      propFirmLot: 0,
      brokerHedgeLot: 0,
      riskPerPointUsd: 0,
    };
  }

  const propFirmLot = roundTo(inputs.desiredRiskUsd / (inputs.stopLossPoints * effectivePointValueUsd), 4);
  const brokerHedgeLot = roundTo(propFirmLot * hedgeFactor, 4);
  const riskPerPointUsd = roundCurrency(propFirmLot * effectivePointValueUsd);

  return {
    isValid: true,
    effectivePointValueUsd,
    propFirmLot,
    brokerHedgeLot,
    riskPerPointUsd,
  };
}

export function calculateTradeSizingSensitivityMatrix(
  inputs: TradeSizingInputs,
  outputs: TradeSizingOutputs,
  hedgeFactor: number
): TradeSizingSensitivityRow[] {
  const spec = INSTRUMENT_SPECS.find((item) => item.id === inputs.instrumentId);
  const tickPrecision = spec?.tickPrecision ?? 1;
  const multipliers = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const safeRisk = isFiniteNonNegative(inputs.desiredRiskUsd) ? inputs.desiredRiskUsd : 0;
  const safeFactor = isFiniteNonNegative(hedgeFactor) ? hedgeFactor : 0;
  const safeSl = Number.isFinite(inputs.stopLossPoints) && inputs.stopLossPoints > 0 ? inputs.stopLossPoints : 1;

  return multipliers.map((mult) => {
    const sl = Math.max(0.5, roundPoints(safeSl * mult, Math.min(2, tickPrecision)));
    const lm =
      outputs.effectivePointValueUsd > 0
        ? roundTo(safeRisk / (sl * outputs.effectivePointValueUsd), 4)
        : 0;
    const lc = roundTo(lm * safeFactor, 4);
    const hedgeReturnOnStopUsd = roundCurrency(safeRisk * safeFactor);

    return {
      stopLossPoints: sl,
      isCurrent: mult === 1,
      propFirmLot: lm,
      brokerHedgeLot: lc,
      mesaRiskUsd: roundCurrency(safeRisk),
      hedgeReturnOnStopUsd,
    };
  });
}

// ---------------------------------------------------------------------------
// Module 3: Capital & Deposit Bonus Optimizer
// ---------------------------------------------------------------------------

export function calculateCapitalBonus(
  inputs: CapitalBonusInputs,
  drawdownUsd: number,
  hedgeFactor: number
): CapitalBonusOutputs {
  if (
    !isFiniteNonNegative(drawdownUsd) ||
    !isFiniteNonNegative(inputs.phase1TargetUsd) ||
    !isFiniteNonNegative(hedgeFactor) ||
    !Number.isFinite(inputs.customBonusPct)
  ) {
    return {
      isValid: false,
      validationError: 'Drawdown, Meta Fase 1, Fator de Hedge e Bônus devem ser números válidos e não negativos.',
      requiredEquityUsd: 0,
      bonusCreditPct: 0,
      realDepositUsd: 0,
      bonusCreditUsd: 0,
      maxSafeFloatingLossUsd: 0,
      realCoverageInsufficient: false,
      comparison: {
        noBonusDeposit: 0,
        noBonusCredit: 0,
        noBonusSavings: 0,
        bonus50Deposit: 0,
        bonus50Credit: 0,
        bonus50Savings: 0,
        bonus100Deposit: 0,
        bonus100Credit: 0,
        bonus100Savings: 0,
      },
    };
  }

  const requiredEquityUsd = roundCurrency(
    inputs.basis === 'dd_buffer_15'
      ? drawdownUsd * hedgeFactor * 1.15
      : inputs.phase1TargetUsd * hedgeFactor * 1.10
  );

  let bonusCreditPct = 0;
  if (inputs.bonusType === 'bonus_50') bonusCreditPct = 50;
  else if (inputs.bonusType === 'bonus_100') bonusCreditPct = 100;
  else if (inputs.bonusType === 'custom') {
    bonusCreditPct = Math.max(0, Math.min(200, inputs.customBonusPct));
  }

  const divisor = 1 + bonusCreditPct / 100;
  const realDepositUsd = roundCurrency(requiredEquityUsd / divisor);
  const bonusCreditUsd = roundCurrency(requiredEquityUsd - realDepositUsd);

  const bonus50Deposit = roundCurrency(requiredEquityUsd / 1.5);
  const bonus100Deposit = roundCurrency(requiredEquityUsd / 2);

  return {
    isValid: true,
    requiredEquityUsd,
    bonusCreditPct,
    realDepositUsd,
    bonusCreditUsd,
    maxSafeFloatingLossUsd: realDepositUsd,
    realCoverageInsufficient: realDepositUsd < roundCurrency(drawdownUsd * hedgeFactor),
    comparison: {
      noBonusDeposit: requiredEquityUsd,
      noBonusCredit: 0,
      noBonusSavings: 0,
      bonus50Deposit,
      bonus50Credit: roundCurrency(requiredEquityUsd - bonus50Deposit),
      bonus50Savings: roundCurrency(requiredEquityUsd - bonus50Deposit),
      bonus100Deposit,
      bonus100Credit: roundCurrency(requiredEquityUsd - bonus100Deposit),
      bonus100Savings: roundCurrency(requiredEquityUsd - bonus100Deposit),
    },
  };
}

// ---------------------------------------------------------------------------
// Secure CSV Export (CWE-1236 Protected)
// ---------------------------------------------------------------------------

export function exportSimulationsToCsv(simulations: SavedSimulation[]): string {
  const headers = [
    'ID',
    'Data',
    'Mesa',
    'Modelo',
    'Versao_Contrato',
    'Drawdown_USD',
    'Taxa_Avaliacao_USD',
    'Taxa_Ativacao_USD',
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
    sanitizeCsvCell(sim.id),
    sanitizeCsvCell(sim.createdAt),
    sanitizeCsvCell(sim.firmName),
    sanitizeCsvCell(sim.firmModel),
    sanitizeCsvCell(sim.contractVersion ?? 'legacy'),
    sanitizeCsvCell(sim.arbitrageInputs.drawdownUsd.toFixed(2)),
    sanitizeCsvCell(sim.arbitrageInputs.evaluationFeeUsd.toFixed(2)),
    sanitizeCsvCell((sim.arbitrageInputs.activationFeeUsd ?? 0).toFixed(2)),
    sanitizeCsvCell(sim.arbitrageInputs.additionalProfitUsd.toFixed(2)),
    sanitizeCsvCell(sim.arbitrageInputs.totalTargetUsd.toFixed(2)),
    sanitizeCsvCell(sim.hedgeFactor.toFixed(4)),
    sanitizeCsvCell(sim.scenarioANet.toFixed(2)),
    sanitizeCsvCell(sim.scenarioBFirstNet.toFixed(2)),
    sanitizeCsvCell(sim.instrumentId),
    sanitizeCsvCell(sim.propFirmLot.toFixed(2)),
    sanitizeCsvCell(sim.brokerHedgeLot.toFixed(2)),
    sanitizeCsvCell(sim.requiredEquityUsd.toFixed(2)),
    sanitizeCsvCell(sim.realDepositUsd.toFixed(2)),
    sanitizeCsvCell(sim.bonusPct.toFixed(0)),
  ]);

  return [headers.map((h) => sanitizeCsvCell(h)).join(','), ...rows.map((r) => r.join(','))].join('\n');
}

// ---------------------------------------------------------------------------
// Consistency, Drawdown & Payout Eligibility Sub-Engines
// ---------------------------------------------------------------------------

export interface ConsistencyEvaluation {
  ratioPct: number | null;
  limitPct: number | null;
  passed: boolean;
  violated: boolean;
}

export function evaluateConsistency(
  positiveDays: number[],
  netPhaseProfit: number,
  phaseTarget: number,
  rule: ConsistencyRule
): ConsistencyEvaluation {
  if (rule.methodology === 'none') {
    return {
      ratioPct: null,
      limitPct: null,
      passed: true,
      violated: false,
    };
  }

  const limitPct = rule.pct.value;

  if (rule.methodology === 'unknown' || rule.pct.status === 'missing' || limitPct === null) {
    return {
      ratioPct: null,
      limitPct: limitPct,
      passed: false,
      violated: false,
    };
  }

  const maxDay = positiveDays.length > 0 ? Math.max(...positiveDays) : 0;
  let ratioPct: number | null = null;

  if (rule.methodology === 'best_day_over_gross_positive') {
    const totalPos = positiveDays.reduce((acc, v) => acc + v, 0);
    ratioPct = totalPos > 0 ? roundTo((maxDay / totalPos) * 100, 2) : null;
  } else if (rule.methodology === 'best_day_over_net_profit') {
    if (netPhaseProfit <= 0) {
      ratioPct = maxDay > 0 ? 100 : null;
    } else {
      ratioPct = roundTo((maxDay / netPhaseProfit) * 100, 2);
    }
  } else if (rule.methodology === 'best_day_over_target') {
    const denom = phaseTarget > 0 ? phaseTarget : Math.max(netPhaseProfit, 1);
    ratioPct = positiveDays.length > 0 ? roundTo((maxDay / denom) * 100, 2) : null;
  }

  const violated = ratioPct !== null && ratioPct > limitPct + 1e-6;
  const passed = ratioPct !== null && !violated;

  return {
    ratioPct,
    limitPct,
    passed,
    violated,
  };
}

export function computePhaseDrawdownFloor(
  accountSize: number,
  ddLimit: number,
  rule: DrawdownRule,
  hwm: number
): number {
  const safeDd = Math.max(1, ddLimit);
  if (rule.methodology === 'static') {
    return roundCurrency(accountSize - safeDd);
  }
  const lockCap = accountSize + (rule.lockOffsetUsd ?? 0);
  return roundCurrency(Math.min(lockCap, hwm - safeDd));
}

export function evaluatePayoutEligibility(
  phaseEquity: number,
  fundedSteps: Array<{ netMesaPnlUsd: number }>,
  firm: PropFirmPreset,
  overrideProfitSplitPct?: number,
  overrideFundedTargetUsd?: number,
  hedgeContext?: PayoutHedgeContext
): PayoutEligibilityResult {
  const rules = firm.fundedRules;
  const currentProfitUsd = roundCurrency(phaseEquity - firm.accountSize);
  const blockedReasons: string[] = [];

  // 1. Profit Split
  const splitPct =
    overrideProfitSplitPct !== undefined && Number.isFinite(overrideProfitSplitPct) && overrideProfitSplitPct > 0
      ? overrideProfitSplitPct
      : (rules.profitSplitPct.value ?? firm.profitSplitPct);
  const splitRatio = Math.max(0, Math.min(100, splitPct)) / 100;

  // 2. Profit Buffer
  let requiredBufferUsd = 0;
  if (rules.profitBufferUsd.status === 'missing' || rules.profitBufferUsd.value === null) {
    blockedReasons.push('Buffer mínimo obrigatório na conta Funded ausente no contrato.');
  } else {
    requiredBufferUsd = Math.max(0, rules.profitBufferUsd.value);
  }

  // 3. Minimum daily profit & qualifying profitable days
  let minDailyProfitRequiredUsd = 0;
  if (rules.minDailyProfitUsd.status === 'missing' || rules.minDailyProfitUsd.value === null) {
    blockedReasons.push('Lucro mínimo diário qualificado ausente no contrato.');
  } else {
    minDailyProfitRequiredUsd = Math.max(0, rules.minDailyProfitUsd.value);
  }

  let requiredProfitableDays = 0;
  if (rules.minProfitableDays.status === 'missing' || rules.minProfitableDays.value === null) {
    blockedReasons.push('Mínimo de dias lucrativos para payout ausente no contrato.');
  } else {
    requiredProfitableDays = Math.max(0, rules.minProfitableDays.value);
  }

  const qualifyingDaysCount = fundedSteps.filter((s) =>
    minDailyProfitRequiredUsd > 0
      ? s.netMesaPnlUsd >= minDailyProfitRequiredUsd
      : s.netMesaPnlUsd > 0
  ).length;

  if (requiredProfitableDays > 0 && qualifyingDaysCount < requiredProfitableDays) {
    blockedReasons.push(
      `Dias qualificados insuficientes: ${qualifyingDaysCount}/${requiredProfitableDays} (mínimo ${formatUsd(
        minDailyProfitRequiredUsd > 0 ? minDailyProfitRequiredUsd : 1
      )}/dia).`
    );
  }

  // 4. Payout Cycle Days
  const cycleDays = rules.payoutCycleDays.value;
  if (cycleDays !== null && cycleDays > 0 && fundedSteps.length < cycleDays) {
    blockedReasons.push(
      `Ciclo mínimo da conta Funded não cumprido: ${fundedSteps.length}/${cycleDays} dia(s).`
    );
  }

  // 5. Buffer check & optional non-10:1 payout gross target
  if (currentProfitUsd <= 0) {
    blockedReasons.push('Conta Funded sem lucro líquido positivo para saque.');
  } else if (currentProfitUsd <= requiredBufferUsd) {
    blockedReasons.push(
      `Lucro atual (${formatUsd(currentProfitUsd)}) ainda não supera o buffer retido obrigatório de ${formatUsd(
        requiredBufferUsd
      )}.`
    );
  }

  if (
    overrideFundedTargetUsd !== undefined &&
    overrideFundedTargetUsd > 0 &&
    currentProfitUsd < overrideFundedTargetUsd
  ) {
    blockedReasons.push(
      `Lucro atual (${formatUsd(currentProfitUsd)}) abaixo da meta projetada de saque (${formatUsd(
        overrideFundedTargetUsd
      )}).`
    );
  }

  // 6. Consistency check in Funded
  const positiveDays = fundedSteps
    .map((s) => s.netMesaPnlUsd)
    .filter((v) => v > 0);

  const consistencyEval = evaluateConsistency(
    positiveDays,
    currentProfitUsd,
    overrideFundedTargetUsd ?? Math.max(currentProfitUsd, 1),
    rules.consistency
  );

  if (rules.consistency.methodology === 'unknown' || rules.consistency.pct.status === 'missing') {
    blockedReasons.push('Metodologia ou limite de consistência Funded ausente no contrato.');
  } else if (!consistencyEval.passed && rules.consistency.methodology !== 'none') {
    blockedReasons.push(
      `Consistência Funded violada (${consistencyEval.ratioPct?.toFixed(1) ?? '—'}% > máx ${
        consistencyEval.limitPct ?? '—'
      }%).`
    );
  }

  // 7. Withdrawal Caps & Minimum Withdrawal
  const withdrawableAboveBufferUsd = roundCurrency(Math.max(0, currentProfitUsd - requiredBufferUsd));
  const maxPct =
    rules.maxWithdrawalPct.value !== null && rules.maxWithdrawalPct.value > 0
      ? Math.min(100, rules.maxWithdrawalPct.value)
      : 100;
  let grossEligibleWithdrawalUsd = roundCurrency(withdrawableAboveBufferUsd * (maxPct / 100));

  if (rules.maxPayoutUsd.value !== null && rules.maxPayoutUsd.value > 0) {
    grossEligibleWithdrawalUsd = roundCurrency(
      Math.min(grossEligibleWithdrawalUsd, rules.maxPayoutUsd.value)
    );
  }

  if (rules.minWithdrawalUsd.status === 'missing' || rules.minWithdrawalUsd.value === null) {
    blockedReasons.push('Valor mínimo de saque ausente no contrato.');
  } else if (grossEligibleWithdrawalUsd < rules.minWithdrawalUsd.value) {
    blockedReasons.push(
      `Saque bruto disponível (${formatUsd(grossEligibleWithdrawalUsd)}) abaixo do mínimo contratual de ${formatUsd(
        rules.minWithdrawalUsd.value
      )}.`
    );
  }

  const isContractuallyEligible = blockedReasons.length === 0;

  const netTraderPayoutUsd = roundCurrency(grossEligibleWithdrawalUsd * splitRatio);
  const retainedBalanceUsd = roundCurrency(
    firm.accountSize + Math.max(0, currentProfitUsd - grossEligibleWithdrawalUsd)
  );
  const postPayoutFloor = computePhaseDrawdownFloor(
    firm.accountSize,
    rules.maxDrawdown.amountUsd.value ?? firm.maxDrawdownUsd,
    rules.maxDrawdown,
    phaseEquity
  );
  const postPayoutDrawdownRemainingUsd = roundCurrency(Math.max(0, retainedBalanceUsd - postPayoutFloor));

  // 8. Consolidated Break-even Analysis (Prop Firm Payout vs. Accumulated Broker Hedge + Fees)
  const brokerPnl = hedgeContext?.brokerCumulativePnlUsd ?? 0;
  const feesPaid = hedgeContext?.feesPaidCumulativeUsd ?? 0;
  const feeRefund = hedgeContext?.feeRefundUsd ?? 0;
  const priorPayouts = hedgeContext?.payoutsReceivedCumulativeUsd ?? 0;
  const netCostToRecoverUsd = Math.max(0, feesPaid - feeRefund - brokerPnl - priorPayouts);
  const requiredNetPayoutToBreakEvenUsd = roundCurrency(netCostToRecoverUsd);
  const projectedConsolidatedNetUsd = roundCurrency(
    priorPayouts + netTraderPayoutUsd + feeRefund - feesPaid + brokerPnl
  );
  const coversHedgeAndFees =
    netCostToRecoverUsd > 0
      ? projectedConsolidatedNetUsd > 0
      : projectedConsolidatedNetUsd >= 0;

  const requiredGrossWithdrawalForBreakEven =
    splitRatio > 0 ? requiredNetPayoutToBreakEvenUsd / splitRatio : 0;
  const isSinglePayoutCappedBelowBreakEven =
    rules.maxPayoutUsd.value !== null &&
    rules.maxPayoutUsd.value > 0 &&
    requiredGrossWithdrawalForBreakEven > rules.maxPayoutUsd.value;

  const withdrawableRatio = maxPct > 0 ? maxPct / 100 : 1;
  const requiredGrossProfitToBreakEvenUsd = roundCurrency(
    requiredNetPayoutToBreakEvenUsd > 0
      ? requiredBufferUsd + requiredGrossWithdrawalForBreakEven / withdrawableRatio
      : 0
  );
  const additionalGrossProfitForBreakEvenUsd = roundCurrency(
    Math.max(0, requiredGrossProfitToBreakEvenUsd - currentProfitUsd)
  );

  const marginalPayoutCaptureRatio = splitRatio * withdrawableRatio;
  const hedgeBlocksBreakEven = Boolean(
    hedgeContext?.hedgeDuringFunded &&
      !coversHedgeAndFees &&
      (hedgeContext.effectiveFundedHedgeFactor ?? 0) >= marginalPayoutCaptureRatio
  );

  if (hedgeContext?.requireHedgeCoverage && !coversHedgeAndFees) {
    if (isSinglePayoutCappedBelowBreakEven && rules.maxPayoutUsd.value !== null) {
      blockedReasons.push(
        `Teto de saque da mesa (${formatUsd(rules.maxPayoutUsd.value)}) impede cobrir hedge + taxas em um único saque (necessário ${formatUsd(
          requiredNetPayoutToBreakEvenUsd
        )} líquido; consolidado atual: ${formatUsd(projectedConsolidatedNetUsd, true)}).`
      );
    } else {
      blockedReasons.push(
        `Saque líquido atual (${formatUsd(netTraderPayoutUsd)}) ainda não deixa o consolidado positivo após hedge + taxas (necessário > ${formatUsd(
          requiredNetPayoutToBreakEvenUsd
        )} líquido / faltam ${formatUsd(
          additionalGrossProfitForBreakEvenUsd
        )} bruto na Funded; consolidado: ${formatUsd(projectedConsolidatedNetUsd, true)}).`
      );
    }
  }

  return {
    isEligible: blockedReasons.length === 0,
    isContractuallyEligible,
    coversHedgeAndFees,
    blockedReasons,
    qualifyingDaysCount,
    requiredProfitableDays,
    minDailyProfitRequiredUsd,
    currentProfitUsd,
    requiredBufferUsd,
    withdrawableAboveBufferUsd,
    grossEligibleWithdrawalUsd,
    profitSplitPct: splitPct,
    netTraderPayoutUsd,
    retainedBalanceUsd,
    postPayoutDrawdownRemainingUsd,
    consistencyRatioPct: consistencyEval.ratioPct,
    consistencyLimitPct: consistencyEval.limitPct,
    consistencyPassed: consistencyEval.passed,
    requiredNetPayoutToBreakEvenUsd,
    requiredGrossProfitToBreakEvenUsd,
    additionalGrossProfitForBreakEvenUsd,
    projectedConsolidatedNetUsd,
    isSinglePayoutCappedBelowBreakEven,
    hedgeBlocksBreakEven,
  };
}

// ---------------------------------------------------------------------------
// Phase-by-Phase Chronological Simulator & State Machine
// ---------------------------------------------------------------------------

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
  protectDoubleLoss = true,
  requireHedgeCoverageForPayout = false
): DailySimulationSummary {
  const contractValidation = validateFirmContract(firm);
  const isFeeOnly = (arbitrageInputs.hedgeFactorMode ?? 'include_dd') === 'fee_only';
  const evalFeeUsd = isFiniteNonNegative(arbitrageInputs.evaluationFeeUsd)
    ? roundCurrency(arbitrageInputs.evaluationFeeUsd)
    : firm.evaluationFeeUsd;
  const activationFeeUsd = isFiniteNonNegative(arbitrageInputs.activationFeeUsd)
    ? roundCurrency(arbitrageInputs.activationFeeUsd)
    : firm.activationFeeUsd;

  const evalDdLimit = Math.max(
    1,
    Number.isFinite(arbitrageInputs.drawdownUsd) && arbitrageInputs.drawdownUsd > 0
      ? arbitrageInputs.drawdownUsd
      : firm.evaluationRules.maxDrawdown.amountUsd.value ?? firm.maxDrawdownUsd
  );
  const fundedDdLimit = Math.max(
    1,
    firm.fundedRules.maxDrawdown.amountUsd.value ?? evalDdLimit
  );

  const phase1Target =
    (firm.evaluationRules.phase1TargetUsd.value ?? firm.phase1TargetUsd) > 0
      ? (firm.evaluationRules.phase1TargetUsd.value ?? firm.phase1TargetUsd)
      : arbitrageInputs.totalTargetUsd;
  const phase2Target = firm.evaluationRules.phase2TargetUsd.value ?? firm.phase2TargetUsd;

  const evalMinDays = firm.evaluationRules.minTradingDays.value ?? firm.minTradingDays;
  const fundedMinQualifyingDays = Math.max(
    firm.fundedRules.minProfitableDays.value ?? 1,
    firm.fundedRules.payoutCycleDays.value ?? 1
  );
  const fundedMinDaysTarget = funded101?.enabled
    ? Math.max(fundedMinQualifyingDays, Math.max(1, funded101.activeDaysTarget))
    : fundedMinQualifyingDays;
  const fundedTargetUsd = funded101?.enabled
    ? 0 // Em 10:1, elegibilidade é avaliada pelo PayoutEligibilityEngine (buffer, dias qualificados, saque mínimo)
    : Math.max(100, arbitrageInputs.payoutGrossProfitUsd);

  const isInstant = firm.evaluationType === 'Instant' || (phase1Target <= 0 && phase2Target <= 0);
  let currentPhase: JourneyPhase = isInstant ? 'Funded' : 'Fase 1';
  let lifecycleState: AccountLifecycleState = isInstant ? 'funded_trading' : 'evaluation_phase_1';
  let status: JourneyStatus = 'Em Andamento';
  let phaseEquity = firm.accountSize;
  let phaseHighWaterMark = firm.accountSize;
  let daysInPhase = 0;
  let phasePositiveDays: number[] = [];
  let fundedPhaseSteps: Array<{ netMesaPnlUsd: number }> = [];
  let brokerCumulativePnl = 0;
  let feesPaidCumulativeUsd = roundCurrency(evalFeeUsd + (isInstant ? activationFeeUsd : 0));
  let payoutsCount = 0;
  let payoutsReceivedTotalUsd = 0;
  let feeRefundReceivedUsd = 0;
  let failureReason: string | undefined;
  let payoutEligibility: PayoutEligibilityResult | null = null;
  const transitions: PhaseTransitionEvent[] = [];

  const getActiveRulesForPhase = (phase: JourneyPhase) => {
    if (phase === 'Funded') {
      return {
        ddLimit: fundedDdLimit,
        ddRule: firm.fundedRules.maxDrawdown,
        dailyLossLimit: firm.fundedRules.dailyLossLimit.amountUsd.value ?? 0,
        consistencyRule: firm.fundedRules.consistency,
        minDays: fundedMinDaysTarget,
        targetUsd: fundedTargetUsd,
      };
    }
    return {
      ddLimit: evalDdLimit,
      ddRule: firm.evaluationRules.maxDrawdown,
      dailyLossLimit: firm.evaluationRules.dailyLossLimit.amountUsd.value ?? 0,
      consistencyRule: firm.evaluationRules.consistency,
      minDays: evalMinDays,
      targetUsd: phase === 'Fase 1' ? phase1Target : phase2Target,
    };
  };

  const steps: DailySimulationStep[] = [];

  for (let i = 0; i < entries.length; i++) {
    if (status !== 'Em Andamento') break;

    const entry = entries[i];
    const activePhase = currentPhase;
    const activeRules = getActiveRulesForPhase(activePhase);
    const isHedgeActiveToday = activePhase !== 'Funded' || hedgeDuringFunded;

    const floorBefore = computePhaseDrawdownFloor(
      firm.accountSize,
      activeRules.ddLimit,
      activeRules.ddRule,
      phaseHighWaterMark
    );
    const remainingToFloorBefore = Math.max(1, roundCurrency(phaseEquity - floorBefore));
    const effectiveLiquidationLoss =
      activeRules.dailyLossLimit > 0
        ? Math.min(remainingToFloorBefore, activeRules.dailyLossLimit)
        : remainingToFloorBefore;

    const isFunded101Step = activePhase === 'Funded' && Boolean(funded101?.enabled);
    const slRiskDenominator =
      isFunded101Step && funded101?.stopMaxUsd && funded101.stopMaxUsd > 0
        ? Math.min(effectiveLiquidationLoss, Math.max(50, funded101.stopMaxUsd))
        : effectiveLiquidationLoss;

    let appliedHedgeFactor = 0;
    if (isHedgeActiveToday) {
      if (protectDoubleLoss) {
        // Cobre integralmente: perda do stop (activeDdLimit em include_dd) + taxas + L_adic - hedge ganho - saques já recebidos
        const projectedLossOnStop = isFeeOnly ? 0 : activeRules.ddLimit;
        const neededBrokerGain =
          projectedLossOnStop +
          feesPaidCumulativeUsd +
          arbitrageInputs.additionalProfitUsd -
          brokerCumulativePnl -
          payoutsReceivedTotalUsd -
          feeRefundReceivedUsd;
        appliedHedgeFactor = roundTo(Math.max(0, neededBrokerGain / slRiskDenominator), 6);
      } else {
        appliedHedgeFactor = hedgeFactor;
      }
    }

    const commissionAndFeesUsd = isFiniteNonNegative(entry.commissionAndFeesUsd ?? 0)
      ? roundCurrency(entry.commissionAndFeesUsd ?? 0)
      : 0;
    const netMesaPnlUsd = roundCurrency(entry.mesaPnlUsd - commissionAndFeesUsd);

    // O hedge espelha o P&L líquido operado na mesa. Em dias de perda, o TP do hedge na corretora
    // executa no limite máximo de stop/liquidação da mesa (slRiskDenominator), evitando lucro fantasma
    // quando o valor digitado excede o limite de perda diária ou drawdown contratual.
    const mirroredMesaPnlForBroker =
      netMesaPnlUsd < 0 ? -Math.min(-netMesaPnlUsd, slRiskDenominator) : netMesaPnlUsd;
    const brokerDailyPnl = isHedgeActiveToday
      ? roundCurrency(-mirroredMesaPnlForBroker * appliedHedgeFactor)
      : 0;
    brokerCumulativePnl = roundCurrency(brokerCumulativePnl + brokerDailyPnl);

    daysInPhase += 1;

    // Drawdown cronológico: considera Trailing Intradiário (pico flutuante) e MAE intradiária opcional
    const isIntradayDd =
      activeRules.ddRule.methodology === 'trailing_intraday' ||
      activeRules.ddRule.methodology === 'trailing_intraday_locked';
    const isTrailingEod =
      activeRules.ddRule.methodology === 'trailing_eod' ||
      activeRules.ddRule.methodology === 'trailing_eod_locked';

    let effectiveHwm = phaseHighWaterMark;
    if (isIntradayDd && entry.intradayPeakOffsetUsd > 0) {
      effectiveHwm = Math.max(effectiveHwm, roundCurrency(phaseEquity + entry.intradayPeakOffsetUsd));
    }

    const intradayWorstEquity =
      entry.intradayAdverseOffsetUsd && entry.intradayAdverseOffsetUsd > 0
        ? roundCurrency(phaseEquity - entry.intradayAdverseOffsetUsd)
        : phaseEquity + Math.min(0, netMesaPnlUsd);

    const nextEquity = roundCurrency(phaseEquity + netMesaPnlUsd);
    if (isTrailingEod || isIntradayDd) {
      effectiveHwm = Math.max(effectiveHwm, nextEquity);
    }

    const floorUsd = computePhaseDrawdownFloor(
      firm.accountSize,
      activeRules.ddLimit,
      activeRules.ddRule,
      effectiveHwm
    );
    const drawdownRemaining = roundCurrency(Math.max(0, nextEquity - floorUsd));
    const phasePnl = roundCurrency(nextEquity - firm.accountSize);

    if (netMesaPnlUsd > 0) {
      phasePositiveDays.push(netMesaPnlUsd);
    }
    if (activePhase === 'Funded') {
      fundedPhaseSteps.push({ netMesaPnlUsd });
    }

    let violationReason: string | undefined;
    const worstDailyLoss = Math.min(netMesaPnlUsd, -(entry.intradayAdverseOffsetUsd ?? 0));
    if (activeRules.dailyLossLimit > 0 && worstDailyLoss <= -activeRules.dailyLossLimit) {
      violationReason = `Perda diária excedeu o limite de ${formatUsd(activeRules.dailyLossLimit)}.`;
    } else if (nextEquity <= floorUsd || (isIntradayDd && intradayWorstEquity <= floorUsd)) {
      violationReason =
        isIntradayDd && entry.intradayPeakOffsetUsd > 0
          ? `Trailing Intradiário violado após pico intradiário elevar o piso para ${formatUsd(floorUsd)}.`
          : `Drawdown máximo atingido (piso ${formatUsd(floorUsd)}).`;
    }

    let phaseAdvancedTo: JourneyPhase | undefined;
    let stepPayoutExecutedUsd: number | undefined;
    let stepPayoutNumber: number | undefined;
    let stepLifecycleState: AccountLifecycleState = lifecycleState;

    if (violationReason) {
      status = 'Reprovado (Stop)';
      transitions.push({
        dayIndex: i + 1,
        from: lifecycleState,
        to: 'account_breached',
        reason: violationReason,
        preconditionsMet: true,
      });
      lifecycleState = 'account_breached';
      stepLifecycleState = 'account_breached';
      failureReason = violationReason;
      phaseEquity = nextEquity;
      phaseHighWaterMark = effectiveHwm;
    } else {
      phaseEquity = nextEquity;
      phaseHighWaterMark = effectiveHwm;

      if (activePhase === 'Fase 1' || activePhase === 'Fase 2') {
        const metTarget = phasePnl >= activeRules.targetUsd;
        const metMinDays = daysInPhase >= activeRules.minDays;
        const evalConsistency = evaluateConsistency(
          phasePositiveDays,
          phasePnl,
          activeRules.targetUsd,
          activeRules.consistencyRule
        );

        if (metTarget && metMinDays && evalConsistency.passed) {
          if (activePhase === 'Fase 1' && phase2Target > 0) {
            phaseAdvancedTo = 'Fase 2';
            transitions.push({
              dayIndex: i + 1,
              from: lifecycleState,
              to: 'evaluation_phase_2',
              reason: 'Meta e consistência da Fase 1 concluídas.',
              preconditionsMet: true,
            });
            lifecycleState = 'evaluation_phase_2';
            currentPhase = 'Fase 2';
          } else {
            phaseAdvancedTo = 'Funded';
            transitions.push(
              {
                dayIndex: i + 1,
                from: lifecycleState,
                to: 'evaluation_completed',
                reason: 'Avaliação aprovada integralmente.',
                preconditionsMet: true,
              },
              {
                dayIndex: i + 1,
                from: 'evaluation_completed',
                to: 'funded_activation',
                reason:
                  activationFeeUsd > 0
                    ? `Taxa de ativação Funded aplicada (${formatUsd(activationFeeUsd)}).`
                    : 'Ativação da conta Funded sem taxa adicional.',
                preconditionsMet: true,
              },
              {
                dayIndex: i + 1,
                from: 'funded_activation',
                to: 'funded_trading',
                reason: 'Conta Funded iniciada.',
                preconditionsMet: true,
              }
            );
            feesPaidCumulativeUsd = roundCurrency(feesPaidCumulativeUsd + activationFeeUsd);
            lifecycleState = 'funded_trading';
            currentPhase = 'Funded';
          }
          stepLifecycleState = lifecycleState;
          phaseEquity = firm.accountSize;
          phaseHighWaterMark = firm.accountSize;
          daysInPhase = 0;
          phasePositiveDays = [];
          fundedPhaseSteps = [];
        }
      } else {
        // Em Funded: usa exclusivamente o PayoutEligibilityEngine (nunca aprova apenas por dias corridos!)
        const pendingFeeRefund =
          payoutsCount === 0 && arbitrageInputs.refundOnFirstPayout ? evalFeeUsd : 0;
        const totalFeeRefundIfPayoutToday = roundCurrency(feeRefundReceivedUsd + pendingFeeRefund);
        const eligibility = evaluatePayoutEligibility(
          phaseEquity,
          fundedPhaseSteps,
          firm,
          arbitrageInputs.profitSplitPct,
          funded101?.enabled ? undefined : fundedTargetUsd,
          {
            brokerCumulativePnlUsd: brokerCumulativePnl,
            feesPaidCumulativeUsd,
            feeRefundUsd: totalFeeRefundIfPayoutToday,
            payoutsReceivedCumulativeUsd: payoutsReceivedTotalUsd,
            requireHedgeCoverage: requireHedgeCoverageForPayout,
            hedgeDuringFunded,
            effectiveFundedHedgeFactor: appliedHedgeFactor,
          }
        );
        payoutEligibility = eligibility;

        if (eligibility.isEligible) {
          payoutsCount += 1;
          payoutsReceivedTotalUsd = roundCurrency(
            payoutsReceivedTotalUsd + eligibility.netTraderPayoutUsd
          );
          feeRefundReceivedUsd = totalFeeRefundIfPayoutToday;
          stepPayoutExecutedUsd = eligibility.netTraderPayoutUsd;
          stepPayoutNumber = payoutsCount;
          phaseEquity = eligibility.retainedBalanceUsd;
          status = 'Aprovado para Saque';
          transitions.push({
            dayIndex: i + 1,
            from: lifecycleState,
            to: 'payout_eligible',
            reason: `Saque #${payoutsCount} liberado (${formatUsd(eligibility.netTraderPayoutUsd)} líquido após split ${eligibility.profitSplitPct}%).`,
            preconditionsMet: true,
          });
          lifecycleState = 'payout_eligible';
          stepLifecycleState = 'payout_eligible';
        } else if (
          requireHedgeCoverageForPayout &&
          eligibility.isContractuallyEligible &&
          !eligibility.coversHedgeAndFees &&
          (hedgeDuringFunded || eligibility.isSinglePayoutCappedBelowBreakEven) &&
          eligibility.postPayoutDrawdownRemainingUsd >= 50
        ) {
          // Executa saque intermediário do ciclo atual para abater o custo do hedge (reduzindo F no ciclo seguinte)
          // e mantém a conta Funded operando até o saldo consolidado ficar estritamente positivo (> $0).
          payoutsCount += 1;
          payoutsReceivedTotalUsd = roundCurrency(
            payoutsReceivedTotalUsd + eligibility.netTraderPayoutUsd
          );
          feeRefundReceivedUsd = totalFeeRefundIfPayoutToday;
          stepPayoutExecutedUsd = eligibility.netTraderPayoutUsd;
          stepPayoutNumber = payoutsCount;
          phaseEquity = eligibility.retainedBalanceUsd;
          daysInPhase = 0;
          phasePositiveDays = [];
          fundedPhaseSteps = [];
          transitions.push(
            {
              dayIndex: i + 1,
              from: lifecycleState,
              to: 'payout_approved',
              reason: `Saque #${payoutsCount} executado (${formatUsd(eligibility.netTraderPayoutUsd)} líquido); consolidado em ${formatUsd(eligibility.projectedConsolidatedNetUsd, true)} — segue para ciclo #${payoutsCount + 1}.`,
              preconditionsMet: true,
            },
            {
              dayIndex: i + 1,
              from: 'payout_approved',
              to: 'funded_trading',
              reason: `Ciclo #${payoutsCount + 1} iniciado com saldo retido de ${formatUsd(phaseEquity)}.`,
              preconditionsMet: true,
            }
          );
          lifecycleState = 'funded_trading';
          stepLifecycleState = 'payout_approved';
        }
      }
    }

    // Fluxo de caixa líquido consolidado até o final deste dia
    let combinedNetCashflowUsd = roundCurrency(
      payoutsReceivedTotalUsd + feeRefundReceivedUsd + brokerCumulativePnl - feesPaidCumulativeUsd
    );
    if (status === 'Reprovado (Stop)' && !isFeeOnly) {
      combinedNetCashflowUsd = roundCurrency(combinedNetCashflowUsd - activeRules.ddLimit);
    }

    steps.push({
      dayIndex: i + 1,
      entryId: entry.id,
      phase: activePhase,
      lifecycleState: stepLifecycleState,
      mesaPnlUsd: entry.mesaPnlUsd,
      commissionAndFeesUsd,
      netMesaPnlUsd,
      intradayPeakOffsetUsd: entry.intradayPeakOffsetUsd,
      mesaPhaseEquityUsd: nextEquity,
      mesaPhasePnlUsd: phasePnl,
      drawdownFloorUsd: floorUsd,
      drawdownRemainingUsd: drawdownRemaining,
      brokerDailyPnlUsd: brokerDailyPnl,
      brokerCumulativePnlUsd: brokerCumulativePnl,
      appliedHedgeFactor,
      feesPaidCumulativeUsd,
      combinedNetCashflowUsd,
      phaseAdvancedTo,
      payoutExecutedUsd: stepPayoutExecutedUsd,
      payoutNumber: stepPayoutNumber,
      violationReason,
      note: entry.note,
    });
  }

  const lastStep = steps[steps.length - 1];
  const currentPhaseRules = getActiveRulesForPhase(currentPhase);
  const currentPhasePnlUsd =
    status === 'Em Andamento' && lastStep?.phaseAdvancedTo
      ? 0
      : roundCurrency(phaseEquity - firm.accountSize);

  if (currentPhase === 'Funded' && (!payoutEligibility || lastStep?.payoutExecutedUsd !== undefined)) {
    const pendingFeeRefund =
      payoutsCount === 0 && arbitrageInputs.refundOnFirstPayout ? evalFeeUsd : 0;
    const totalFeeRefundIfPayoutToday = roundCurrency(feeRefundReceivedUsd + pendingFeeRefund);
    if (status !== 'Aprovado para Saque') {
      payoutEligibility = evaluatePayoutEligibility(
        phaseEquity,
        fundedPhaseSteps,
        firm,
        arbitrageInputs.profitSplitPct,
        funded101?.enabled ? undefined : fundedTargetUsd,
        {
          brokerCumulativePnlUsd: brokerCumulativePnl,
          feesPaidCumulativeUsd,
          feeRefundUsd: totalFeeRefundIfPayoutToday,
          payoutsReceivedCumulativeUsd: payoutsReceivedTotalUsd,
          requireHedgeCoverage: requireHedgeCoverageForPayout,
          hedgeDuringFunded,
          effectiveFundedHedgeFactor: hedgeDuringFunded ? hedgeFactor : 0,
        }
      );
    }
  }

  const consistencyEval = evaluateConsistency(
    phasePositiveDays,
    currentPhasePnlUsd,
    currentPhaseRules.targetUsd,
    currentPhaseRules.consistencyRule
  );

  let finalNetOutcomeUsd = roundCurrency(
    payoutsReceivedTotalUsd + feeRefundReceivedUsd + brokerCumulativePnl - feesPaidCumulativeUsd
  );
  if (status === 'Reprovado (Stop)') {
    const breachedPhaseRules = getActiveRulesForPhase(lastStep?.phase ?? currentPhase);
    finalNetOutcomeUsd = roundCurrency(
      finalNetOutcomeUsd - (isFeeOnly ? 0 : breachedPhaseRules.ddLimit)
    );
  }

  return {
    status,
    lifecycleState,
    currentPhase,
    steps,
    transitions,
    totalDays: steps.length,
    daysInCurrentPhase: daysInPhase,
    minTradingDaysRequired: currentPhaseRules.minDays,
    currentPhasePnlUsd,
    currentPhaseTargetUsd: currentPhaseRules.targetUsd,
    consistencyRatioPct: consistencyEval.ratioPct,
    consistencyLimitPct: consistencyEval.limitPct,
    consistencyMethodology: currentPhaseRules.consistencyRule.methodology,
    consistencyViolated: consistencyEval.violated,
    feesPaidTotalUsd: feesPaidCumulativeUsd,
    brokerCumulativePnlUsd: brokerCumulativePnl,
    payoutsCount,
    payoutsReceivedTotalUsd,
    finalNetOutcomeUsd,
    payoutEligibility,
    contractValidation,
    failureReason,
  };
}

export function calculateStepPreview(
  summary: DailySimulationSummary,
  firm: PropFirmPreset,
  arbitrageInputs: ArbitrageInputs,
  sizingMode: RandomSizingMode,
  rewardToRisk: number,
  daysDivisor: number,
  desiredRiskUsd: number,
  funded101Enabled: boolean,
  funded101Inputs: FundedMethod101Inputs
): StepPreviewOutputs {
  const safeDivisor = Math.max(1, Math.round(daysDivisor));
  const safeRr = Math.max(0.1, rewardToRisk);
  const drawdownUsd =
    summary.currentPhase === 'Funded'
      ? (firm.fundedRules.maxDrawdown.amountUsd.value ?? arbitrageInputs.drawdownUsd)
      : arbitrageInputs.drawdownUsd;

  const targetPreview =
    summary.currentPhase === 'Funded'
      ? Math.max(100, arbitrageInputs.payoutGrossProfitUsd)
      : summary.currentPhase === 'Fase 2' && firm.phase2TargetUsd > 0
      ? firm.phase2TargetUsd
      : firm.phase1TargetUsd > 0
      ? firm.phase1TargetUsd
      : Math.max(100, arbitrageInputs.totalTargetUsd);

  const isFunded101Active = summary.currentPhase === 'Funded' && funded101Enabled;

  const tpUsd = isFunded101Active
    ? Math.round(funded101Inputs.shortTargetUsd)
    : sizingMode === 'dd_max_rr'
    ? Math.round(drawdownUsd * safeRr)
    : sizingMode === 'fixed_risk'
    ? Math.round(desiredRiskUsd * safeRr)
    : Math.round(targetPreview / safeDivisor);

  const slUsd = isFunded101Active
    ? Math.round(funded101Inputs.remainingDrawdownUsd)
    : sizingMode === 'meta_dias_rr'
    ? Math.round(tpUsd / safeRr)
    : sizingMode === 'fixed_risk'
    ? Math.round(desiredRiskUsd)
    : Math.round(drawdownUsd);

  const effectiveRr = slUsd > 0 ? roundTo(tpUsd / slUsd, 2) : 0;

  const phaseLabel = isFunded101Active
    ? 'Funded 1:10'
    : summary.currentPhase === 'Funded'
    ? 'Funded · 10:1 Desligado'
    : summary.currentPhase;

  return {
    phaseLabel,
    tpUsd,
    slUsd,
    effectiveRr,
    isFunded101Active,
  };
}

// ---------------------------------------------------------------------------
// Preset & Stochastic Trajectory Generators
// ---------------------------------------------------------------------------

export function generateApprovalTrajectory(
  firm: PropFirmPreset,
  arbitrageInputs: ArbitrageInputs,
  funded101?: Funded101StageConfig,
  options?: {
    hedgeFactor?: number;
    hedgeDuringFunded?: boolean;
    protectDoubleLoss?: boolean;
    requireHedgeCoverageForPayout?: boolean;
  }
): DailyTradeEntry[] {
  const entries: DailyTradeEntry[] = [];
  const p1Target =
    (firm.evaluationRules.phase1TargetUsd.value ?? firm.phase1TargetUsd) > 0
      ? (firm.evaluationRules.phase1TargetUsd.value ?? firm.phase1TargetUsd)
      : arbitrageInputs.totalTargetUsd;
  const p2Target = firm.evaluationRules.phase2TargetUsd.value ?? firm.phase2TargetUsd;
  const evalConsistency = firm.evaluationRules.consistency.pct.value;
  const evalMinDays = firm.evaluationRules.minTradingDays.value ?? firm.minTradingDays;

  const buildPhaseDays = (
    target: number,
    minDays: number,
    consistencyPct: number | null,
    prefix: string
  ) => {
    const minConsistentWinDays =
      consistencyPct && consistencyPct > 0 ? Math.ceil(100 / consistencyPct) + 1 : 3;
    const count = Math.max(minDays, minConsistentWinDays + 1);
    const lossAmount = Math.round(Math.min(target * 0.2, arbitrageInputs.drawdownUsd * 0.25));
    const totalNeeded = target + (count >= 3 ? lossAmount : 0);
    const winDays = count >= 3 ? count - 1 : count;
    const perWin = Math.ceil(totalNeeded / Math.max(1, winDays));

    let accumulated = 0;
    for (let i = 0; i < count; i++) {
      if (i === 1 && count >= 3) {
        accumulated -= lossAmount;
        entries.push({
          id: `${prefix}-loss-${i}`,
          mesaPnlUsd: -lossAmount,
          intradayPeakOffsetUsd: 0,
          note: `${prefix} · Stop controlado`,
        });
      } else {
        const remaining = target - accumulated;
        const amount = i === count - 1 ? Math.max(perWin, remaining) : perWin;
        accumulated += amount;
        entries.push({
          id: `${prefix}-win-${i}`,
          mesaPnlUsd: Math.round(amount),
          intradayPeakOffsetUsd: Math.round(amount * 0.2),
          note: `${prefix} · Dia positivo`,
        });
      }
    }
  };

  if (firm.evaluationType !== 'Instant') {
    if (p1Target > 0) {
      buildPhaseDays(p1Target, evalMinDays, evalConsistency, 'Fase 1');
    }
    if (p2Target > 0) {
      buildPhaseDays(p2Target, evalMinDays, evalConsistency, 'Fase 2');
    }
  }

  const minDaily = firm.fundedRules.minDailyProfitUsd.value ?? 0;

  // Quando exige cobertura do hedge + taxas até ficar positivo, gera dias Funded dinamicamente
  // (incluindo múltiplos ciclos de saque) até runDailySimulation encerrar positivo.
  if (options?.requireHedgeCoverageForPayout) {
    const fEst = options.hedgeFactor ?? calculateArbitrage(arbitrageInputs).hedgeFactor;
    const hedgeInFunded = options.hedgeDuringFunded ?? false;
    const protect = options.protectDoubleLoss ?? true;
    const dailyTp = funded101?.enabled
      ? Math.max(50, Math.round(funded101.shortTargetUsd), minDaily)
      : Math.max(200, Math.round(arbitrageInputs.payoutGrossProfitUsd / 4), minDaily);

    const maxFundedDays = 60;
    for (let d = 1; d <= maxFundedDays; d++) {
      const sim = runDailySimulation(
        entries,
        firm,
        arbitrageInputs,
        fEst,
        hedgeInFunded,
        funded101,
        protect,
        true
      );
      if (sim.status !== 'Em Andamento') break;
      entries.push({
        id: `Funded-pos-${d}`,
        mesaPnlUsd: dailyTp,
        intradayPeakOffsetUsd: Math.round(dailyTp * 0.15),
        note: funded101?.enabled ? 'Funded (10:1) · Meta curta' : 'Funded · Dia positivo',
      });
    }
    return entries;
  }

  // Modo padrão (1º saque contratual na mesa)
  const fundedMinDays = Math.max(
    firm.fundedRules.minProfitableDays.value ?? 1,
    firm.fundedRules.payoutCycleDays.value ?? 1,
    1
  );
  const bufferUsd = firm.fundedRules.profitBufferUsd.value ?? 0;
  const minW = firm.fundedRules.minWithdrawalUsd.value ?? 100;
  const maxWPct =
    firm.fundedRules.maxWithdrawalPct.value && firm.fundedRules.maxWithdrawalPct.value > 0
      ? firm.fundedRules.maxWithdrawalPct.value
      : 100;
  const neededAboveBuffer = Math.ceil(minW / (maxWPct / 100));
  const minProfitForPayout = bufferUsd + neededAboveBuffer;
  const fundedConsistency = firm.fundedRules.consistency.pct.value;

  if (funded101?.enabled) {
    const dailyTp = Math.max(50, Math.round(funded101.shortTargetUsd), minDaily);
    const daysForProfit = Math.ceil(minProfitForPayout / dailyTp);
    const minConsistentDays =
      fundedConsistency && fundedConsistency > 0 ? Math.ceil(100 / fundedConsistency) + 1 : 1;
    const days = Math.min(
      60,
      Math.max(funded101.activeDaysTarget, fundedMinDays, daysForProfit, minConsistentDays)
    );

    for (let d = 1; d <= days; d++) {
      entries.push({
        id: `Funded-101-${d}`,
        mesaPnlUsd: dailyTp,
        intradayPeakOffsetUsd: Math.round(dailyTp * 0.15),
        note: 'Funded (10:1) · Meta curta',
      });
    }
  } else {
    const fundedTarget = Math.max(
      500,
      arbitrageInputs.payoutGrossProfitUsd,
      minProfitForPayout
    );
    buildPhaseDays(fundedTarget, Math.max(2, fundedMinDays), fundedConsistency, 'Funded');
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
  requireHedgeCoverageForPayout?: boolean;
  seed?: number;
}

export function generateRandomTrajectory(
  firm: PropFirmPreset,
  arbitrageInputs: ArbitrageInputs,
  hedgeFactor: number,
  options: RandomSimulationOptions = {}
): DailyTradeEntry[] {
  const { next: rand, seed } = createSeededPrng(options.seed);
  const sizingMode: RandomSizingMode = options.sizingMode ?? 'dd_max_meta_dias';
  const evalWinRate = Math.max(5, Math.min(95, options.winRatePct ?? 58)) / 100;
  const rr = Math.max(0.1, Math.min(6, options.rewardToRisk ?? 0.75));
  const daysDivisor = Math.max(1, Math.round(options.minDaysDivisor ?? Math.max(1, firm.minTradingDays)));
  const ddMax = Math.max(50, arbitrageInputs.drawdownUsd);
  const fallbackRisk = Math.max(50, Math.round(ddMax * 0.2));
  const baseRisk = Math.max(25, options.baseRiskUsd ?? fallbackRisk);
  const hedgeDuringFunded = options.hedgeDuringFunded ?? false;
  const protectDoubleLoss = options.protectDoubleLoss ?? true;
  const requireHedgeCoverageForPayout = options.requireHedgeCoverageForPayout ?? false;

  const shortTarget = Math.max(50, options.fundedShortTargetUsd ?? 150);
  const funded101Config: Funded101StageConfig = {
    enabled: options.funded101Enabled ?? true,
    activeDaysTarget: Math.max(1, options.fundedActiveDaysTarget ?? Math.max(5, firm.minTradingDays)),
    shortTargetUsd: shortTarget,
    stopMaxUsd: Math.max(50, options.fundedStopMaxUsd ?? Math.min(ddMax, shortTarget * 10)),
  };
  const fundedStopMax = funded101Config.stopMaxUsd ?? ddMax;
  const fundedWinRate = Math.max(50, Math.min(99, options.fundedWinRatePct ?? 92)) / 100;

  const p1Target =
    (firm.evaluationRules.phase1TargetUsd.value ?? firm.phase1TargetUsd) > 0
      ? (firm.evaluationRules.phase1TargetUsd.value ?? firm.phase1TargetUsd)
      : arbitrageInputs.totalTargetUsd;
  const p2Target = firm.evaluationRules.phase2TargetUsd.value ?? firm.phase2TargetUsd;
  const fundedTarget = Math.max(100, arbitrageInputs.payoutGrossProfitUsd);

  const getPhaseTarget = (phase: JourneyPhase) => {
    if (phase === 'Fase 1') return p1Target;
    if (phase === 'Fase 2') return p2Target;
    return fundedTarget;
  };

  const entries: DailyTradeEntry[] = [];
  const maxDays = requireHedgeCoverageForPayout ? 90 : 45;

  for (let day = 1; day <= maxDays; day++) {
    const prevSim = runDailySimulation(
      entries,
      firm,
      arbitrageInputs,
      hedgeFactor,
      hedgeDuringFunded,
      funded101Config,
      protectDoubleLoss,
      requireHedgeCoverageForPayout
    );
    if (prevSim.status !== 'Em Andamento') {
      break;
    }

    const currentPhase = prevSim.currentPhase;
    const phaseTarget = getPhaseTarget(currentPhase);
    const lastStep = prevSim.steps[prevSim.steps.length - 1];
    const phaseDd =
      currentPhase === 'Funded'
        ? (firm.fundedRules.maxDrawdown.amountUsd.value ?? ddMax)
        : ddMax;
    const currentEquity =
      lastStep && !lastStep.phaseAdvancedTo ? lastStep.mesaPhaseEquityUsd : firm.accountSize;
    const currentFloor =
      lastStep && !lastStep.phaseAdvancedTo
        ? lastStep.drawdownFloorUsd
        : firm.accountSize - phaseDd;
    const remainingToFloor = Math.max(10, currentEquity - currentFloor);

    const isFunded101Day = currentPhase === 'Funded' && funded101Config.enabled;
    let tpUsd = Math.round(phaseTarget / daysDivisor);
    let slUsd = Math.round(phaseDd);

    if (isFunded101Day) {
      tpUsd = Math.round(funded101Config.shortTargetUsd);
      slUsd = Math.round(Math.min(fundedStopMax, remainingToFloor));
    } else if (sizingMode === 'dd_max_meta_dias') {
      tpUsd = Math.max(10, Math.round(phaseTarget / daysDivisor));
      slUsd = Math.round(phaseDd);
    } else if (sizingMode === 'dd_max_rr') {
      slUsd = Math.round(phaseDd);
      tpUsd = Math.max(10, Math.round(slUsd * rr));
    } else if (sizingMode === 'meta_dias_rr') {
      tpUsd = Math.max(10, Math.round(phaseTarget / daysDivisor));
      slUsd = Math.max(10, Math.round(tpUsd / rr));
    } else {
      const variance = 0.65 + rand() * 0.75;
      slUsd = Math.round((baseRisk * variance) / 10) * 10;
      tpUsd = Math.round((baseRisk * rr * variance) / 10) * 10;
    }

    const isWin = rand() < (isFunded101Day ? fundedWinRate : evalWinRate);
    const rawPnl = isWin ? tpUsd : -Math.min(slUsd, remainingToFloor);

    const activeDdMethodology =
      currentPhase === 'Funded'
        ? firm.fundedRules.maxDrawdown.methodology
        : firm.evaluationRules.maxDrawdown.methodology;
    const isIntraday =
      activeDdMethodology === 'trailing_intraday' ||
      activeDdMethodology === 'trailing_intraday_locked';

    const intradayPeakOffsetUsd = isIntraday
      ? Math.round(tpUsd * (0.25 + rand() * 0.6))
      : isWin
      ? Math.round(tpUsd * (0.05 + rand() * 0.15))
      : 0;

    entries.push({
      id: `rand-${seed}-${day}`,
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

// ---------------------------------------------------------------------------
// Module 5: Funded 10:1 / 1:10 Method Sizing
// ---------------------------------------------------------------------------

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
  const totalFees =
    (isFiniteNonNegative(arbitrageInputs.evaluationFeeUsd) ? arbitrageInputs.evaluationFeeUsd : 0) +
    (isFiniteNonNegative(arbitrageInputs.activationFeeUsd) ? arbitrageInputs.activationFeeUsd : 0);

  const effectiveHedgeFactor = protectDoubleLoss
    ? roundTo(
        Math.max(
          0,
          ((isFeeOnly ? 0 : inputs.remainingDrawdownUsd) +
            totalFees +
            arbitrageInputs.additionalProfitUsd) /
            inputs.remainingDrawdownUsd
        ),
        8
      )
    : Math.max(0, hedgeFactor);

  const propFirmLot = roundTo(inputs.remainingDrawdownUsd / (inputs.stopLossPoints * pointValue), 4);
  const brokerHedgeLot = roundTo(propFirmLot * effectiveHedgeFactor, 4);
  const takeProfitPoints = roundPoints(
    inputs.shortTargetUsd / (propFirmLot * pointValue),
    spec?.tickPrecision ?? 1
  );
  const impliedNegativeRatio = roundTo(inputs.remainingDrawdownUsd / inputs.shortTargetUsd, 2);

  const splitRatio = arbitrageInputs.profitSplitPct / 100;
  const days = Math.max(1, Math.round(inputs.activeDaysTarget));

  const mesaGainUsd = roundCurrency(inputs.shortTargetUsd);
  const hedgeCostUsd = roundCurrency(-(inputs.shortTargetUsd * effectiveHedgeFactor));
  const netAfterSplitUsd = roundCurrency(mesaGainUsd * splitRatio + hedgeCostUsd);

  const calendarMesaTotalUsd = roundCurrency(mesaGainUsd * days);
  const calendarHedgeCostTotalUsd = roundCurrency(hedgeCostUsd * days);
  const calendarNetAfterSplitUsd = roundCurrency(calendarMesaTotalUsd * splitRatio + calendarHedgeCostTotalUsd);

  const mesaLossUsd = isFeeOnly ? 0 : roundCurrency(-inputs.remainingDrawdownUsd);
  const brokerInsuranceGainUsd = roundCurrency(inputs.remainingDrawdownUsd * effectiveHedgeFactor);
  const netBeforeFeeUsd = roundCurrency(mesaLossUsd + brokerInsuranceGainUsd);
  const netAfterFeeUsd = roundCurrency(netBeforeFeeUsd - totalFees);

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

// ---------------------------------------------------------------------------
// Module 6: Seeded Monte Carlo Stochastic Stress Engine
// ---------------------------------------------------------------------------

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
  const { next: rand, seed: seedUsed } = createSeededPrng(options.seed);
  const numRuns = Math.max(100, Math.min(10000, Math.round(options.numRuns ?? 1000)));
  const requireHedgeCoverageForPayout = options.requireHedgeCoverageForPayout ?? false;
  const maxDays = Math.max(
    15,
    Math.min(120, Math.round(options.maxDays ?? (requireHedgeCoverageForPayout ? 90 : 50)))
  );

  const sizingMode: RandomSizingMode = options.sizingMode ?? 'dd_max_meta_dias';
  const evalWinRate = Math.max(5, Math.min(95, options.winRatePct ?? 58)) / 100;
  const rr = Math.max(0.1, Math.min(6, options.rewardToRisk ?? 0.75));
  const evalMinDays = firm.evaluationRules.minTradingDays.value ?? firm.minTradingDays;
  const daysDivisor = Math.max(1, Math.round(options.minDaysDivisor ?? Math.max(1, evalMinDays)));
  const evalDdLimit = Math.max(50, arbitrageInputs.drawdownUsd);
  const fundedDdLimit = Math.max(
    50,
    firm.fundedRules.maxDrawdown.amountUsd.value ?? evalDdLimit
  );
  const fallbackRisk = Math.max(50, Math.round(evalDdLimit * 0.2));
  const baseRisk = Math.max(25, options.baseRiskUsd ?? fallbackRisk);
  const hedgeDuringFunded = options.hedgeDuringFunded ?? true;
  const protectDoubleLoss = options.protectDoubleLoss ?? true;
  const isFeeOnly = (arbitrageInputs.hedgeFactorMode ?? 'include_dd') === 'fee_only';
  const evalFee = isFiniteNonNegative(arbitrageInputs.evaluationFeeUsd)
    ? arbitrageInputs.evaluationFeeUsd
    : firm.evaluationFeeUsd;
  const activationFee = isFiniteNonNegative(arbitrageInputs.activationFeeUsd)
    ? arbitrageInputs.activationFeeUsd
    : firm.activationFeeUsd;
  const addProfit = isFiniteNonNegative(arbitrageInputs.additionalProfitUsd)
    ? arbitrageInputs.additionalProfitUsd
    : 0;
  const feeRefundAmount = arbitrageInputs.refundOnFirstPayout ? evalFee : 0;

  const funded101Enabled = options.funded101Enabled ?? true;
  const fundedShortTarget = Math.max(50, options.fundedShortTargetUsd ?? 150);
  const fundedStopMax = Math.max(
    50,
    options.fundedStopMaxUsd ?? Math.min(fundedDdLimit, fundedShortTarget * 10)
  );
  const fundedWinRate = Math.max(50, Math.min(99, options.fundedWinRatePct ?? 92)) / 100;

  const phase1Target =
    (firm.evaluationRules.phase1TargetUsd.value ?? firm.phase1TargetUsd) > 0
      ? (firm.evaluationRules.phase1TargetUsd.value ?? firm.phase1TargetUsd)
      : arbitrageInputs.totalTargetUsd;
  const phase2Target = firm.evaluationRules.phase2TargetUsd.value ?? firm.phase2TargetUsd;
  const fundedTarget = funded101Enabled
    ? 0
    : Math.max(100, arbitrageInputs.payoutGrossProfitUsd);

  const isInstant = firm.evaluationType === 'Instant' || (phase1Target <= 0 && phase2Target <= 0);

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
    let currentPhase: JourneyPhase = isInstant ? 'Funded' : 'Fase 1';
    let status: JourneyStatus = 'Em Andamento';
    let phaseEquity = firm.accountSize;
    let phaseHighWaterMark = firm.accountSize;
    let daysInPhase = 0;
    let phasePositiveDays: number[] = [];
    let fundedSteps: Array<{ netMesaPnlUsd: number }> = [];
    let brokerCumulativePnl = 0;
    let feesPaidCumulativeUsd = evalFee + (isInstant ? activationFee : 0);
    let payoutsCount = 0;
    let payoutsReceivedTotalUsd = 0;
    let feeRefundReceivedUsd = 0;
    let passedEval = isInstant;
    let stoppedInEval = false;
    let stoppedInFunded = false;
    let maxBrokerOutlayUsd = feesPaidCumulativeUsd;
    let finalNetUsd = -feesPaidCumulativeUsd;
    let daysTaken = 0;
    const series: number[] = [];

    for (let day = 1; day <= maxDays; day++) {
      if (status !== 'Em Andamento') break;

      const activePhase = currentPhase;
      const isFunded = activePhase === 'Funded';
      const activeDdLimit = isFunded ? fundedDdLimit : evalDdLimit;
      const activeDdRule = isFunded
        ? firm.fundedRules.maxDrawdown
        : firm.evaluationRules.maxDrawdown;
      const activeDailyLoss = isFunded
        ? (firm.fundedRules.dailyLossLimit.amountUsd.value ?? 0)
        : (firm.evaluationRules.dailyLossLimit.amountUsd.value ?? 0);
      const isHedgeActiveToday = !isFunded || hedgeDuringFunded;

      const floorBefore = computePhaseDrawdownFloor(
        firm.accountSize,
        activeDdLimit,
        activeDdRule,
        phaseHighWaterMark
      );
      const remainingToFloorBefore = Math.max(10, phaseEquity - floorBefore);
      const effectiveLiquidationLoss =
        activeDailyLoss > 0
          ? Math.min(remainingToFloorBefore, activeDailyLoss)
          : remainingToFloorBefore;

      const isFunded101Day = isFunded && funded101Enabled;
      const slRiskDenominator = isFunded101Day
        ? Math.min(effectiveLiquidationLoss, fundedStopMax)
        : effectiveLiquidationLoss;

      let appliedHedgeFactor = 0;
      if (isHedgeActiveToday) {
        if (protectDoubleLoss) {
          const projectedLossOnStop = isFeeOnly ? 0 : activeDdLimit;
          const neededBrokerGain =
            projectedLossOnStop +
            feesPaidCumulativeUsd +
            addProfit -
            brokerCumulativePnl -
            payoutsReceivedTotalUsd -
            feeRefundReceivedUsd;
          appliedHedgeFactor = Math.max(0, neededBrokerGain / slRiskDenominator);
        } else {
          appliedHedgeFactor = hedgeFactor;
        }
      }

      const phaseTarget =
        activePhase === 'Fase 1'
          ? phase1Target
          : activePhase === 'Fase 2'
          ? phase2Target
          : fundedTarget;

      let tpUsd = Math.round(phaseTarget / daysDivisor);
      let slUsd = Math.round(activeDdLimit);

      if (isFunded101Day) {
        tpUsd = Math.round(fundedShortTarget);
        slUsd = Math.round(Math.min(fundedStopMax, remainingToFloorBefore));
      } else if (sizingMode === 'dd_max_meta_dias') {
        tpUsd = Math.max(10, Math.round(phaseTarget / daysDivisor));
        slUsd = Math.round(activeDdLimit);
      } else if (sizingMode === 'dd_max_rr') {
        slUsd = Math.round(activeDdLimit);
        tpUsd = Math.max(10, Math.round(slUsd * rr));
      } else if (sizingMode === 'meta_dias_rr') {
        tpUsd = Math.max(10, Math.round(phaseTarget / daysDivisor));
        slUsd = Math.max(10, Math.round(tpUsd / rr));
      } else {
        const variance = 0.65 + rand() * 0.75;
        slUsd = Math.round((baseRisk * variance) / 10) * 10;
        tpUsd = Math.round((baseRisk * rr * variance) / 10) * 10;
      }

      const isWin = rand() < (isFunded101Day ? fundedWinRate : evalWinRate);
      const mesaPnlUsd = isWin ? tpUsd : -Math.min(slUsd, remainingToFloorBefore);
      const isIntraday =
        activeDdRule.methodology === 'trailing_intraday' ||
        activeDdRule.methodology === 'trailing_intraday_locked';
      const isTrailing =
        isIntraday ||
        activeDdRule.methodology === 'trailing_eod' ||
        activeDdRule.methodology === 'trailing_eod_locked';

      const intradayPeakOffsetUsd = isIntraday
        ? Math.round(tpUsd * (0.25 + rand() * 0.6))
        : isWin
        ? Math.round(tpUsd * (0.05 + rand() * 0.15))
        : 0;

      const brokerDailyPnl = isHedgeActiveToday ? -mesaPnlUsd * appliedHedgeFactor : 0;
      brokerCumulativePnl += brokerDailyPnl;
      maxBrokerOutlayUsd = Math.max(
        maxBrokerOutlayUsd,
        feesPaidCumulativeUsd - brokerCumulativePnl
      );

      daysInPhase += 1;
      daysTaken = day;

      let effectiveHwm = phaseHighWaterMark;
      if (isIntraday && intradayPeakOffsetUsd > 0) {
        effectiveHwm = Math.max(effectiveHwm, phaseEquity + intradayPeakOffsetUsd);
      }

      const nextEquity = phaseEquity + mesaPnlUsd;
      if (isTrailing) {
        effectiveHwm = Math.max(effectiveHwm, nextEquity);
      }

      const floorUsd = computePhaseDrawdownFloor(
        firm.accountSize,
        activeDdLimit,
        activeDdRule,
        effectiveHwm
      );
      const phasePnl = nextEquity - firm.accountSize;

      if (mesaPnlUsd > 0) {
        phasePositiveDays.push(mesaPnlUsd);
      }
      if (isFunded) {
        fundedSteps.push({ netMesaPnlUsd: mesaPnlUsd });
      }

      const violatedDaily = activeDailyLoss > 0 && mesaPnlUsd <= -activeDailyLoss;
      const violatedFloor = nextEquity <= floorUsd;

      if (violatedDaily || violatedFloor) {
        status = 'Reprovado (Stop)';
        if (isFunded) stoppedInFunded = true;
        else stoppedInEval = true;
        phaseEquity = nextEquity;
        phaseHighWaterMark = effectiveHwm;
      } else {
        phaseEquity = nextEquity;
        phaseHighWaterMark = effectiveHwm;

        if (!isFunded) {
          const evalConsistency = evaluateConsistency(
            phasePositiveDays,
            phasePnl,
            phaseTarget,
            firm.evaluationRules.consistency
          );
          if (phasePnl >= phaseTarget && daysInPhase >= evalMinDays && evalConsistency.passed) {
            if (activePhase === 'Fase 1' && phase2Target > 0) {
              currentPhase = 'Fase 2';
            } else {
              passedEval = true;
              currentPhase = 'Funded';
              feesPaidCumulativeUsd += activationFee;
            }
            phaseEquity = firm.accountSize;
            phaseHighWaterMark = firm.accountSize;
            daysInPhase = 0;
            phasePositiveDays = [];
            fundedSteps = [];
          }
        } else {
          const pendingFeeRefund = payoutsCount === 0 ? feeRefundAmount : 0;
          const totalFeeRefundIfPayoutToday = feeRefundReceivedUsd + pendingFeeRefund;
          const eligibility = evaluatePayoutEligibility(
            phaseEquity,
            fundedSteps,
            firm,
            arbitrageInputs.profitSplitPct,
            funded101Enabled ? undefined : fundedTarget,
            {
              brokerCumulativePnlUsd: brokerCumulativePnl,
              feesPaidCumulativeUsd,
              feeRefundUsd: totalFeeRefundIfPayoutToday,
              payoutsReceivedCumulativeUsd: payoutsReceivedTotalUsd,
              requireHedgeCoverage: requireHedgeCoverageForPayout,
              hedgeDuringFunded,
              effectiveFundedHedgeFactor: appliedHedgeFactor,
            }
          );
          if (eligibility.isEligible) {
            payoutsCount += 1;
            payoutsReceivedTotalUsd += eligibility.netTraderPayoutUsd;
            feeRefundReceivedUsd = totalFeeRefundIfPayoutToday;
            phaseEquity = eligibility.retainedBalanceUsd;
            status = 'Aprovado para Saque';
          } else if (
            requireHedgeCoverageForPayout &&
            eligibility.isContractuallyEligible &&
            !eligibility.coversHedgeAndFees &&
            (hedgeDuringFunded || eligibility.isSinglePayoutCappedBelowBreakEven) &&
            eligibility.postPayoutDrawdownRemainingUsd >= 50
          ) {
            payoutsCount += 1;
            payoutsReceivedTotalUsd += eligibility.netTraderPayoutUsd;
            feeRefundReceivedUsd = totalFeeRefundIfPayoutToday;
            phaseEquity = eligibility.retainedBalanceUsd;
            daysInPhase = 0;
            phasePositiveDays = [];
            fundedSteps = [];
          }
        }
      }

      let combinedNet =
        payoutsReceivedTotalUsd + feeRefundReceivedUsd + brokerCumulativePnl - feesPaidCumulativeUsd;
      if (status === 'Reprovado (Stop)' && !isFeeOnly) {
        combinedNet -= activeDdLimit;
      }

      finalNetUsd = roundCurrency(combinedNet);
      series.push(finalNetUsd);
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
      maxBrokerOutlayUsd: roundCurrency(maxBrokerOutlayUsd),
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

  const expectedNetUsd = roundCurrency(sumNet / numRuns);
  const medianNetUsd = roundCurrency(getQuantile(sortedNets, 0.5));
  const p10NetUsd = roundCurrency(getQuantile(sortedNets, 0.1));
  const p90NetUsd = roundCurrency(getQuantile(sortedNets, 0.9));
  const minNetUsd = roundCurrency(sortedNets[0] ?? 0);
  const maxNetUsd = roundCurrency(sortedNets[sortedNets.length - 1] ?? 0);
  const p95MaxBrokerOutlayUsd = roundCurrency(getQuantile(sortedOutlays, 0.95));

  const stopCount = stopInEvalCount + stopInFundedCount;
  const avgPayoutNetUsd = payoutCount > 0 ? roundCurrency(sumPayoutNet / payoutCount) : 0;
  const avgStopNetUsd = stopCount > 0 ? roundCurrency(sumStopNet / stopCount) : 0;

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
      p10: roundCurrency(getQuantile(sortedDay, 0.1)),
      p50: roundCurrency(getQuantile(sortedDay, 0.5)),
      p90: roundCurrency(getQuantile(sortedDay, 0.9)),
    });
  }

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
      const binMin = roundCurrency(minNetUsd + b * step);
      const binMax = roundCurrency(minNetUsd + (b + 1) * step);
      const mid = (binMin + binMax) / 2;
      histogram.push({
        label: `${mid >= 0 ? '+' : '-'}$${Math.round(Math.abs(mid))}`,
        minUsd: binMin,
        maxUsd: binMax,
        count: counts[b],
        pct: roundTo((counts[b] / numRuns) * 100, 2),
      });
    }
  }

  return {
    numRuns,
    seedUsed,
    evalPassRatePct: roundTo((evalPassedCount / numRuns) * 100, 2),
    payoutSuccessRatePct: roundTo((payoutCount / numRuns) * 100, 2),
    stopOutRatePct: roundTo((stopCount / numRuns) * 100, 2),
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
    negativeOutcomeRatePct: roundTo((negativeOutcomeCount / numRuns) * 100, 2),
    avgDaysToFinish: roundTo(sumDays / numRuns, 2),
    avgMaxBrokerOutlayUsd: roundCurrency(sumOutlay / numRuns),
    p95MaxBrokerOutlayUsd,
    avgPayoutNetUsd,
    avgStopNetUsd,
    samplePaths,
    percentilesByDay,
    histogram,
  };
}
