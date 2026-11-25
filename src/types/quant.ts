export type ThemeMode = 'dark' | 'light';

export type WorkspaceSection =
  | 'arbitrage'
  | 'sizing'
  | 'capital'
  | 'daily'
  | 'montecarlo'
  | 'portfolio'
  | 'firms';

export type PropFirmCategory = 'CFD / Forex' | 'Futuros';

export type EvaluationType = '1-Step' | '2-Step' | 'Instant';

export type DrawdownType = 'Estático' | 'Trailing EOD' | 'Trailing Intradiário';

export type DrawdownMethodology =
  | 'static'
  | 'trailing_eod'
  | 'trailing_intraday'
  | 'trailing_eod_locked'
  | 'trailing_intraday_locked';

export type DailyLossMethodology = 'none' | 'balance_based' | 'equity_based' | 'unknown';

export type ConsistencyMethodology =
  | 'none'
  | 'best_day_over_net_profit'
  | 'best_day_over_gross_positive'
  | 'best_day_over_target'
  | 'unknown';

export type VerificationStatus =
  | 'verified'
  | 'unverified'
  | 'historical'
  | 'missing'
  | 'user_assumed';

export type ArbitrageViability = 'Ideal' | 'Moderada' | 'Incompatível';

export interface ContractualValue<T> {
  value: T | null;
  status: VerificationStatus;
  methodology?: string;
  effectiveDate: string;
  lastVerifiedDate?: string;
  sourceUrl?: string;
  missingReason?: string;
}

export interface ContractualPricing {
  currency: 'USD';
  evaluationFee: ContractualValue<number>;
  activationFee: ContractualValue<number>;
  resetFee: ContractualValue<number>;
  monthlySubscription: ContractualValue<number>;
}

export interface DailyLossRule {
  amountUsd: ContractualValue<number>;
  methodology: DailyLossMethodology;
  resetTime: string;
  timezone: string;
}

export interface DrawdownRule {
  amountUsd: ContractualValue<number>;
  methodology: DrawdownMethodology;
  basis: 'balance' | 'equity';
  lockOffsetUsd: number | null;
}

export interface ConsistencyRule {
  pct: ContractualValue<number>;
  methodology: ConsistencyMethodology;
}

export interface EvaluationRules {
  phase1TargetUsd: ContractualValue<number>;
  phase2TargetUsd: ContractualValue<number>;
  dailyLossLimit: DailyLossRule;
  maxDrawdown: DrawdownRule;
  minTradingDays: ContractualValue<number>;
  maxTradingDays: ContractualValue<number>;
  consistency: ConsistencyRule;
  permittedStrategies: string[];
  newsTradingRestricted: boolean | null;
  weekendHoldingRestricted: boolean | null;
}

export interface FundedAccountRules {
  dailyLossLimit: DailyLossRule;
  maxDrawdown: DrawdownRule;
  consistency: ConsistencyRule;
  profitBufferUsd: ContractualValue<number>;
  minProfitableDays: ContractualValue<number>;
  minDailyProfitUsd: ContractualValue<number>;
  minWithdrawalUsd: ContractualValue<number>;
  maxPayoutUsd: ContractualValue<number>;
  maxWithdrawalPct: ContractualValue<number>;
  payoutFrequency: string;
  payoutCycleDays: ContractualValue<number>;
  profitSplitPct: ContractualValue<number>;
  refundOnFirstPayout: ContractualValue<boolean>;
}

export interface PropFirmPreset {
  id: string;
  firmId: string;
  planId: string;
  name: string;
  model: string;
  category: PropFirmCategory;
  evaluationType: EvaluationType;
  accountSize: number;
  contractVersion: string;
  effectiveDate: string;
  lastVerificationDate: string;
  verificationStatus: VerificationStatus;
  sourceUrls: string[];
  pricing: ContractualPricing;
  evaluationRules: EvaluationRules;
  fundedRules: FundedAccountRules;
  // Synchronized operational projections for quick table display & legacy compatibility
  phase1TargetUsd: number;
  phase2TargetUsd: number;
  dailyLossLimitUsd: number;
  maxDrawdownUsd: number;
  drawdownType: DrawdownType;
  minTradingDays: number;
  profitSplitPct: number;
  consistencyRulePct: number | null;
  evaluationFeeUsd: number;
  activationFeeUsd: number;
  refundOnFirstPayout: boolean;
  viability: ArbitrageViability;
  rulesSummary: string;
  operationalAlert?: string;
  isCustom?: boolean;
}

export interface ContractualValidationResult {
  isCompleteForSimulation: boolean;
  missingCriticalFields: string[];
  unverifiedWarnings: string[];
  userAssumedFields: string[];
}

export type InstrumentId = 'US30' | 'US100' | 'US500' | 'FX_MAJOR' | 'XAUUSD' | 'CUSTOM';

export interface InstrumentSpec {
  id: InstrumentId;
  symbol: string;
  label: string;
  unitLabel: string;
  pointValuePerStandardLot: number;
  tickPrecision: number;
  description: string;
}

export type HedgeFactorMode = 'include_dd' | 'fee_only';

export interface ArbitrageInputs {
  hedgeFactorMode: HedgeFactorMode;
  drawdownUsd: number;
  evaluationFeeUsd: number;
  activationFeeUsd: number;
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
    evaluationFeePaid: number;
    activationFeePaid: number;
    grossPayout: number;
    feeRefund: number;
    firstPayoutNet: number;
    subsequentPayoutNet: number;
    breakEvenProfitNeeded: number;
  };
}

export interface ArbitragePayoffPoint {
  mesaExcursion: number;
  hedgePnl: number;
  combinedFloating: number;
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

export interface TradeSizingSensitivityRow {
  stopLossPoints: number;
  isCurrent: boolean;
  propFirmLot: number;
  brokerHedgeLot: number;
  mesaRiskUsd: number;
  hedgeReturnOnStopUsd: number;
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
  isValid: boolean;
  validationError?: string;
  requiredEquityUsd: number;
  bonusCreditPct: number;
  realDepositUsd: number;
  bonusCreditUsd: number;
  maxSafeFloatingLossUsd: number;
  realCoverageInsufficient: boolean;
  comparison: {
    noBonusDeposit: number;
    noBonusCredit: number;
    noBonusSavings: number;
    bonus50Deposit: number;
    bonus50Credit: number;
    bonus50Savings: number;
    bonus100Deposit: number;
    bonus100Credit: number;
    bonus100Savings: number;
  };
}

export interface SavedSimulation {
  id: string;
  createdAt: string;
  firmName: string;
  firmModel: string;
  contractVersion?: string;
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

export type AccountLifecycleState =
  | 'evaluation_phase_1'
  | 'evaluation_phase_2'
  | 'evaluation_completed'
  | 'funded_activation'
  | 'funded_trading'
  | 'payout_eligible'
  | 'payout_requested'
  | 'payout_approved'
  | 'payout_rejected'
  | 'account_breached'
  | 'account_terminated';

export interface PhaseTransitionEvent {
  dayIndex: number;
  from: AccountLifecycleState;
  to: AccountLifecycleState;
  reason: string;
  preconditionsMet: boolean;
}

export interface PayoutHedgeContext {
  brokerCumulativePnlUsd: number;
  feesPaidCumulativeUsd: number;
  feeRefundUsd: number;
  payoutsReceivedCumulativeUsd?: number;
  requireHedgeCoverage?: boolean;
  hedgeDuringFunded?: boolean;
  effectiveFundedHedgeFactor?: number;
}

export interface PayoutEligibilityResult {
  isEligible: boolean;
  isContractuallyEligible: boolean;
  coversHedgeAndFees: boolean;
  blockedReasons: string[];
  qualifyingDaysCount: number;
  requiredProfitableDays: number;
  minDailyProfitRequiredUsd: number;
  currentProfitUsd: number;
  requiredBufferUsd: number;
  withdrawableAboveBufferUsd: number;
  grossEligibleWithdrawalUsd: number;
  profitSplitPct: number;
  netTraderPayoutUsd: number;
  retainedBalanceUsd: number;
  postPayoutDrawdownRemainingUsd: number;
  consistencyRatioPct: number | null;
  consistencyLimitPct: number | null;
  consistencyPassed: boolean;
  requiredNetPayoutToBreakEvenUsd: number;
  requiredGrossProfitToBreakEvenUsd: number;
  additionalGrossProfitForBreakEvenUsd: number;
  projectedConsolidatedNetUsd: number;
  isSinglePayoutCappedBelowBreakEven: boolean;
  hedgeBlocksBreakEven: boolean;
}

export interface DailyTradeEntry {
  id: string;
  mesaPnlUsd: number;
  intradayPeakOffsetUsd: number;
  intradayAdverseOffsetUsd?: number;
  commissionAndFeesUsd?: number;
  note?: string;
}

export interface DailySimulationStep {
  dayIndex: number;
  entryId: string;
  phase: JourneyPhase;
  lifecycleState: AccountLifecycleState;
  mesaPnlUsd: number;
  commissionAndFeesUsd: number;
  netMesaPnlUsd: number;
  intradayPeakOffsetUsd: number;
  mesaPhaseEquityUsd: number;
  mesaPhasePnlUsd: number;
  drawdownFloorUsd: number;
  drawdownRemainingUsd: number;
  brokerDailyPnlUsd: number;
  brokerCumulativePnlUsd: number;
  appliedHedgeFactor: number;
  feesPaidCumulativeUsd: number;
  combinedNetCashflowUsd: number;
  phaseAdvancedTo?: JourneyPhase;
  payoutExecutedUsd?: number;
  payoutNumber?: number;
  violationReason?: string;
  note?: string;
}

export interface DailySimulationSummary {
  status: JourneyStatus;
  lifecycleState: AccountLifecycleState;
  currentPhase: JourneyPhase;
  steps: DailySimulationStep[];
  transitions: PhaseTransitionEvent[];
  totalDays: number;
  daysInCurrentPhase: number;
  minTradingDaysRequired: number;
  currentPhasePnlUsd: number;
  currentPhaseTargetUsd: number;
  consistencyRatioPct: number | null;
  consistencyLimitPct: number | null;
  consistencyMethodology: ConsistencyMethodology;
  consistencyViolated: boolean;
  feesPaidTotalUsd: number;
  brokerCumulativePnlUsd: number;
  payoutsCount: number;
  payoutsReceivedTotalUsd: number;
  finalNetOutcomeUsd: number;
  payoutEligibility: PayoutEligibilityResult | null;
  contractValidation: ContractualValidationResult;
  failureReason?: string;
}

export type RandomSizingMode =
  | 'dd_max_meta_dias'
  | 'dd_max_rr'
  | 'meta_dias_rr'
  | 'fixed_risk';

export interface StepPreviewOutputs {
  phaseLabel: string;
  tpUsd: number;
  slUsd: number;
  effectiveRr: number;
  isFunded101Active: boolean;
}

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
  seedUsed: number;
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
