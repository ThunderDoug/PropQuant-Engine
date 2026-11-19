export type ThemeMode = 'dark' | 'light';

export type WorkspaceSection =
  | 'arbitrage'
  | 'sizing'
  | 'capital'
  | 'daily'
  | 'montecarlo'
  | 'firms';

export type PropFirmCategory = 'CFD / Forex' | 'Futuros';

export type DrawdownType = 'Estático' | 'Trailing EOD' | 'Trailing Intradiário';

export type ArbitrageViability = 'Ideal' | 'Moderada' | 'Incompatível';

export interface PropFirmPreset {
  id: string;
  name: string;
  model: string;
  category: PropFirmCategory;
  accountSize: number;
  phase1TargetUsd: number;
  phase2TargetUsd: number;
  dailyLossLimitUsd: number;
  maxDrawdownUsd: number;
  drawdownType: DrawdownType;
  minTradingDays: number;
  profitSplitPct: number;
  consistencyRulePct: number | null;
  evaluationFeeUsd: number;
  refundOnFirstPayout: boolean;
  viability: ArbitrageViability;
  rulesSummary: string;
  operationalAlert?: string;
  isCustom?: boolean;
}

export type InstrumentId = 'US30' | 'US100' | 'US500' | 'FX_MAJOR' | 'XAUUSD' | 'CUSTOM';

export interface InstrumentSpec {
  id: InstrumentId;
  symbol: string;
  label: string;
  unitLabel: string;
  pointValuePerStandardLot: number;
  description: string;
}

export type HedgeFactorMode = 'include_dd' | 'fee_only';

export interface ArbitrageInputs {
  hedgeFactorMode: HedgeFactorMode;
  drawdownUsd: number;
  evaluationFeeUsd: number;
  additionalProfitUsd: number;
  totalTargetUsd: number;
  payoutGrossProfitUsd: number;
  profitSplitPct: number;
  refundOnFirstPayout: boolean;
}

export interface ArbitrageOutputs {
  isValid: boolean;
  validationError?: string;
  hedgeFactor: number;
  scenarioA: {
    propFirmLoss: number;
    feeCost: number;
    brokerGain: number;
    netResult: number;
  };
  scenarioB: {
    accumulatedHedgeLoss: number;
    grossPayout: number;
    feeRefund: number;
    firstPayoutNet: number;
    subsequentPayoutNet: number;
    breakEvenProfitNeeded: number;
  };
}

export interface TradeSizingInputs {
  instrumentId: InstrumentId;
  customPointValueUsd: number;
  desiredRiskUsd: number;
  stopLossPoints: number;
}

export interface TradeSizingOutputs {
  isValid: boolean;
  validationError?: string;
  effectivePointValueUsd: number;
  propFirmLot: number;
  brokerHedgeLot: number;
  riskPerPointUsd: number;
}

export type MarginCalculationBasis = 'dd_buffer_15' | 'phase1_buffer_10';

export type BonusPresetType = 'none' | 'bonus_50' | 'bonus_100' | 'custom';

export interface CapitalBonusInputs {
  basis: MarginCalculationBasis;
  phase1TargetUsd: number;
  bonusType: BonusPresetType;
  customBonusPct: number;
}

export interface CapitalBonusOutputs {
  requiredEquityUsd: number;
  bonusCreditPct: number;
  realDepositUsd: number;
  bonusCreditUsd: number;
  maxSafeFloatingLossUsd: number;
  comparison: {
    noBonusDeposit: number;
    bonus50Deposit: number;
    bonus100Deposit: number;
  };
}

export interface SavedSimulation {
  id: string;
  createdAt: string;
  firmName: string;
  firmModel: string;
  arbitrageInputs: ArbitrageInputs;
  hedgeFactor: number;
  scenarioANet: number;
  scenarioBFirstNet: number;
  instrumentId: InstrumentId;
  propFirmLot: number;
  brokerHedgeLot: number;
  requiredEquityUsd: number;
  realDepositUsd: number;
  bonusPct: number;
}

export type ConsultIntent = 'A' | 'B' | 'C' | 'D' | 'E' | 'CUSTOM';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  intent?: ConsultIntent;
  timestamp: string;
  error?: boolean;
}

export type JourneyPhase = 'Fase 1' | 'Fase 2' | 'Funded';

export type JourneyStatus = 'Em Andamento' | 'Aprovado para Saque' | 'Reprovado (Stop)';

export interface DailyTradeEntry {
  id: string;
  mesaPnlUsd: number;
  intradayPeakOffsetUsd: number;
  note?: string;
}

export interface DailySimulationStep {
  dayIndex: number;
  entryId: string;
  phase: JourneyPhase;
  mesaPnlUsd: number;
  intradayPeakOffsetUsd: number;
  mesaPhaseEquityUsd: number;
  mesaPhasePnlUsd: number;
  drawdownFloorUsd: number;
  drawdownRemainingUsd: number;
  brokerDailyPnlUsd: number;
  brokerCumulativePnlUsd: number;
  appliedHedgeFactor: number;
  combinedNetCashflowUsd: number;
  phaseAdvancedTo?: JourneyPhase;
  violationReason?: string;
  note?: string;
}

export interface DailySimulationSummary {
  status: JourneyStatus;
  currentPhase: JourneyPhase;
  steps: DailySimulationStep[];
  totalDays: number;
  daysInCurrentPhase: number;
  minTradingDaysRequired: number;
  currentPhasePnlUsd: number;
  currentPhaseTargetUsd: number;
  consistencyRatioPct: number | null;
  consistencyLimitPct: number | null;
  consistencyViolated: boolean;
  brokerCumulativePnlUsd: number;
  finalNetOutcomeUsd: number;
  failureReason?: string;
}

export type RandomSizingMode =
  | 'dd_max_meta_dias'
  | 'dd_max_rr'
  | 'meta_dias_rr'
  | 'fixed_risk';

export interface FundedMethod101Inputs {
  shortTargetUsd: number;
  remainingDrawdownUsd: number;
  stopLossPoints: number;
  activeDaysTarget: number;
  statisticalWinRatePct: number;
}

export interface FundedMethod101Outputs {
  isValid: boolean;
  validationError?: string;
  effectiveHedgeFactor: number;
  propFirmLot: number;
  brokerHedgeLot: number;
  takeProfitPoints: number;
  impliedNegativeRatio: number;
  normalDay: {
    mesaGainUsd: number;
    hedgeCostUsd: number;
    netAfterSplitUsd: number;
    calendarMesaTotalUsd: number;
    calendarHedgeCostTotalUsd: number;
    calendarNetAfterSplitUsd: number;
  };
  failureDay: {
    mesaLossUsd: number;
    brokerInsuranceGainUsd: number;
    netBeforeFeeUsd: number;
    netAfterFeeUsd: number;
  };
}

export interface MonteCarloSamplePath {
  id: number;
  outcome: JourneyStatus;
  finalNetUsd: number;
  points: number[];
}

export interface MonteCarloHistogramBin {
  label: string;
  minUsd: number;
  maxUsd: number;
  count: number;
  pct: number;
}

export interface MonteCarloPercentilePoint {
  day: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface MonteCarloSummary {
  numRuns: number;
  evalPassRatePct: number;
  payoutSuccessRatePct: number;
  stopOutRatePct: number;
  stopInEvalCount: number;
  stopInFundedCount: number;
  payoutCount: number;
  incompleteCount: number;
  expectedNetUsd: number;
  medianNetUsd: number;
  p10NetUsd: number;
  p90NetUsd: number;
  minNetUsd: number;
  maxNetUsd: number;
  negativeOutcomeRatePct: number;
  avgDaysToFinish: number;
  avgMaxBrokerOutlayUsd: number;
  p95MaxBrokerOutlayUsd: number;
  avgPayoutNetUsd: number;
  avgStopNetUsd: number;
  samplePaths: MonteCarloSamplePath[];
  percentilesByDay: MonteCarloPercentilePoint[];
  histogram: MonteCarloHistogramBin[];
}


