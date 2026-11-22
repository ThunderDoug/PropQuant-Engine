import type {
  ArbitrageViability,
  ConsistencyMethodology,
  ConsistencyRule,
  ContractualPricing,
  ContractualValidationResult,
  ContractualValue,
  DailyLossMethodology,
  DailyLossRule,
  DrawdownMethodology,
  DrawdownRule,
  DrawdownType,
  EvaluationRules,
  EvaluationType,
  FundedAccountRules,
  PropFirmCategory,
  PropFirmPreset,
  VerificationStatus,
} from '../types/quant.ts';

export function makeVerified(
  value: null,
  effectiveDate?: string,
  methodology?: string,
  sourceUrl?: string
): ContractualValue<never>;
export function makeVerified<T>(
  value: T | null,
  effectiveDate?: string,
  methodology?: string,
  sourceUrl?: string
): ContractualValue<NonNullable<T>>;
export function makeVerified<T>(
  value: T | null,
  effectiveDate = '2026-11-01',
  methodology?: string,
  sourceUrl?: string
): ContractualValue<NonNullable<T>> {
  return {
    value: value as NonNullable<T> | null,
    status: 'verified',
    methodology,
    effectiveDate,
    lastVerifiedDate: effectiveDate,
    sourceUrl,
  };
}

export function makeUnverified(
  value: null,
  effectiveDate?: string,
  missingReason?: string,
  methodology?: string
): ContractualValue<never>;
export function makeUnverified<T>(
  value: T | null,
  effectiveDate?: string,
  missingReason?: string,
  methodology?: string
): ContractualValue<NonNullable<T>>;
export function makeUnverified<T>(
  value: T | null,
  effectiveDate = '2026-11-01',
  missingReason?: string,
  methodology?: string
): ContractualValue<NonNullable<T>> {
  return {
    value: value as NonNullable<T> | null,
    status: 'unverified',
    methodology,
    effectiveDate,
    missingReason,
  };
}

export function makeMissing<T = never>(
  missingReason: string,
  effectiveDate = '2026-11-01',
  methodology?: string
): ContractualValue<T> {
  return {
    value: null,
    status: 'missing',
    methodology,
    effectiveDate,
    missingReason,
  };
}

export function makeUserAssumed(
  value: null,
  methodology?: string,
  effectiveDate?: string
): ContractualValue<never>;
export function makeUserAssumed<T>(
  value: T | null,
  methodology?: string,
  effectiveDate?: string
): ContractualValue<NonNullable<T>>;
export function makeUserAssumed<T>(
  value: T | null,
  methodology?: string,
  effectiveDate = new Date().toISOString().slice(0, 10)
): ContractualValue<NonNullable<T>> {
  return {
    value: value as NonNullable<T> | null,
    status: 'user_assumed',
    methodology,
    effectiveDate,
  };
}

export function drawdownMethodologyToUiLabel(methodology: DrawdownMethodology): DrawdownType {
  switch (methodology) {
    case 'static':
      return 'Estático';
    case 'trailing_eod':
    case 'trailing_eod_locked':
      return 'Trailing EOD';
    case 'trailing_intraday':
    case 'trailing_intraday_locked':
      return 'Trailing Intradiário';
  }
}

export function uiLabelToDrawdownMethodology(label: DrawdownType): DrawdownMethodology {
  switch (label) {
    case 'Estático':
      return 'static';
    case 'Trailing EOD':
      return 'trailing_eod';
    case 'Trailing Intradiário':
      return 'trailing_intraday';
  }
}

export function makeDailyLossRule(
  amountUsd: number | null,
  methodology: DailyLossMethodology,
  status: VerificationStatus = 'verified',
  resetTime = '17:00',
  timezone = 'America/New_York',
  effectiveDate = '2026-11-01',
  missingReason?: string
): DailyLossRule {
  return {
    amountUsd: {
      value: methodology === 'none' ? null : amountUsd,
      status,
      methodology,
      effectiveDate,
      lastVerifiedDate: status === 'verified' ? effectiveDate : undefined,
      missingReason,
    },
    methodology,
    resetTime,
    timezone,
  };
}

export function makeDrawdownRule(
  amountUsd: number | null,
  methodology: DrawdownMethodology,
  basis: 'balance' | 'equity' = 'equity',
  lockOffsetUsd: number | null = null,
  status: VerificationStatus = 'verified',
  effectiveDate = '2026-11-01',
  missingReason?: string
): DrawdownRule {
  return {
    amountUsd: {
      value: amountUsd,
      status,
      methodology,
      effectiveDate,
      lastVerifiedDate: status === 'verified' ? effectiveDate : undefined,
      missingReason,
    },
    methodology,
    basis,
    lockOffsetUsd,
  };
}

export function makeConsistencyRule(
  pct: number | null,
  methodology: ConsistencyMethodology,
  status: VerificationStatus = 'verified',
  effectiveDate = '2026-11-01',
  missingReason?: string
): ConsistencyRule {
  return {
    pct: {
      value: methodology === 'none' ? null : pct,
      status,
      methodology,
      effectiveDate,
      lastVerifiedDate: status === 'verified' ? effectiveDate : undefined,
      missingReason,
    },
    methodology,
  };
}

export interface FirmSeedSpec {
  id: string;
  firmId: string;
  planId: string;
  name: string;
  model: string;
  category: PropFirmCategory;
  evaluationType: EvaluationType;
  accountSize: number;
  contractVersion?: string;
  effectiveDate?: string;
  lastVerificationDate?: string;
  verificationStatus?: VerificationStatus;
  sourceUrls?: string[];
  pricing: ContractualPricing;
  evaluationRules: EvaluationRules;
  fundedRules: FundedAccountRules;
  viability: ArbitrageViability;
  rulesSummary: string;
  operationalAlert?: string;
  isCustom?: boolean;
}

export function buildFirmPreset(spec: FirmSeedSpec): PropFirmPreset {
  const effectiveDate = spec.effectiveDate ?? '2026-11-01';
  const evalDdVal = spec.evaluationRules.maxDrawdown.amountUsd.value ?? 0;
  const evalDailyLossVal = spec.evaluationRules.dailyLossLimit.amountUsd.value ?? 0;
  const evalFeeVal = spec.pricing.evaluationFee.value ?? 0;
  const actFeeVal = spec.pricing.activationFee.value ?? 0;
  const p1Val = spec.evaluationRules.phase1TargetUsd.value ?? 0;
  const p2Val = spec.evaluationRules.phase2TargetUsd.value ?? 0;
  const minDaysVal = spec.evaluationRules.minTradingDays.value ?? 0;
  const splitVal = spec.fundedRules.profitSplitPct.value ?? 80;
  const refundVal = spec.fundedRules.refundOnFirstPayout.value ?? false;

  // For legacy flat compatibility, keep effective consistency pct if active in eval or funded
  const flatConsistency =
    spec.evaluationRules.consistency.pct.value ??
    spec.fundedRules.consistency.pct.value ??
    null;

  // If either eval or funded is trailing intraday, reflect highest risk type in summary badge
  const effectiveDrawdownType =
    spec.fundedRules.maxDrawdown.methodology === 'trailing_intraday' ||
    spec.fundedRules.maxDrawdown.methodology === 'trailing_intraday_locked' ||
    spec.evaluationRules.maxDrawdown.methodology === 'trailing_intraday' ||
    spec.evaluationRules.maxDrawdown.methodology === 'trailing_intraday_locked'
      ? 'Trailing Intradiário'
      : drawdownMethodologyToUiLabel(spec.evaluationRules.maxDrawdown.methodology);

  return {
    id: spec.id,
    firmId: spec.firmId,
    planId: spec.planId,
    name: spec.name,
    model: spec.model,
    category: spec.category,
    evaluationType: spec.evaluationType,
    accountSize: spec.accountSize,
    contractVersion: spec.contractVersion ?? '2026.11',
    effectiveDate,
    lastVerificationDate: spec.lastVerificationDate ?? effectiveDate,
    verificationStatus: spec.verificationStatus ?? 'verified',
    sourceUrls: spec.sourceUrls ?? [],
    pricing: spec.pricing,
    evaluationRules: spec.evaluationRules,
    fundedRules: spec.fundedRules,
    phase1TargetUsd: p1Val,
    phase2TargetUsd: p2Val,
    dailyLossLimitUsd: evalDailyLossVal,
    maxDrawdownUsd: evalDdVal,
    drawdownType: effectiveDrawdownType,
    minTradingDays: minDaysVal,
    profitSplitPct: splitVal,
    consistencyRulePct: flatConsistency,
    evaluationFeeUsd: evalFeeVal,
    activationFeeUsd: actFeeVal,
    refundOnFirstPayout: refundVal,
    viability: spec.viability,
    rulesSummary: spec.rulesSummary,
    operationalAlert: spec.operationalAlert,
    isCustom: spec.isCustom,
  };
}

/**
 * Safely migrates legacy v1 flat PropFirmPreset objects (e.g. from older localStorage)
 * to the normalized contractual schema without losing custom user data.
 */
export function normalizePropFirmPreset(raw: Partial<PropFirmPreset> & { id: string; name: string; model: string }): PropFirmPreset {
  if (raw.pricing && raw.evaluationRules && raw.fundedRules) {
    return raw as PropFirmPreset;
  }

  const today = new Date().toISOString().slice(0, 10);
  const accountSize = typeof raw.accountSize === 'number' && raw.accountSize > 0 ? raw.accountSize : 50000;
  const p1 = typeof raw.phase1TargetUsd === 'number' ? raw.phase1TargetUsd : 3000;
  const p2 = typeof raw.phase2TargetUsd === 'number' ? raw.phase2TargetUsd : 0;
  const dd = typeof raw.maxDrawdownUsd === 'number' && raw.maxDrawdownUsd > 0 ? raw.maxDrawdownUsd : 2000;
  const dailyLoss = typeof raw.dailyLossLimitUsd === 'number' && raw.dailyLossLimitUsd > 0 ? raw.dailyLossLimitUsd : null;
  const ddType: DrawdownType = raw.drawdownType ?? 'Estático';
  const ddMethod = uiLabelToDrawdownMethodology(ddType);
  const minDays = typeof raw.minTradingDays === 'number' ? raw.minTradingDays : 0;
  const split = typeof raw.profitSplitPct === 'number' && raw.profitSplitPct > 0 ? raw.profitSplitPct : 80;
  const evalFee = typeof raw.evaluationFeeUsd === 'number' ? raw.evaluationFeeUsd : 0;
  const actFee = typeof raw.activationFeeUsd === 'number' ? raw.activationFeeUsd : 0;
  const refund = Boolean(raw.refundOnFirstPayout);
  const consistency = raw.consistencyRulePct ?? null;
  const status: VerificationStatus = raw.isCustom ? 'user_assumed' : 'historical';

  return buildFirmPreset({
    id: raw.id,
    firmId: raw.firmId ?? raw.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    planId: raw.planId ?? raw.id,
    name: raw.name,
    model: raw.model,
    category: raw.category ?? 'CFD / Forex',
    evaluationType: p2 > 0 ? '2-Step' : '1-Step',
    accountSize,
    contractVersion: raw.contractVersion ?? 'legacy-migrated',
    effectiveDate: raw.effectiveDate ?? today,
    lastVerificationDate: raw.lastVerificationDate ?? today,
    verificationStatus: raw.verificationStatus ?? status,
    sourceUrls: raw.sourceUrls ?? [],
    pricing: {
      currency: 'USD',
      evaluationFee: { value: evalFee, status, effectiveDate: today },
      activationFee: { value: actFee, status, effectiveDate: today },
      resetFee: makeMissing('Taxa de reset não informada no registro legado', today),
      monthlySubscription: { value: 0, status, effectiveDate: today },
    },
    evaluationRules: {
      phase1TargetUsd: { value: p1, status, effectiveDate: today },
      phase2TargetUsd: { value: p2 > 0 ? p2 : null, status, effectiveDate: today },
      dailyLossLimit: makeDailyLossRule(
        dailyLoss,
        dailyLoss ? 'balance_based' : 'none',
        status,
        '17:00',
        'America/New_York',
        today
      ),
      maxDrawdown: makeDrawdownRule(dd, ddMethod, 'equity', null, status, today),
      minTradingDays: { value: minDays, status, effectiveDate: today },
      maxTradingDays: makeConsistencyRule(null, 'none', status, today).pct,
      consistency: makeConsistencyRule(
        consistency,
        consistency ? 'best_day_over_net_profit' : 'none',
        status,
        today
      ),
      permittedStrategies: ['Hedge / Arbitragem permitida sob confirmação contratual'],
      newsTradingRestricted: null,
      weekendHoldingRestricted: null,
    },
    fundedRules: {
      dailyLossLimit: makeDailyLossRule(
        dailyLoss,
        dailyLoss ? 'balance_based' : 'none',
        status,
        '17:00',
        'America/New_York',
        today
      ),
      maxDrawdown: makeDrawdownRule(dd, ddMethod, 'equity', null, status, today),
      consistency: makeConsistencyRule(
        consistency,
        consistency ? 'best_day_over_net_profit' : 'none',
        status,
        today
      ),
      profitBufferUsd: { value: 0, status, effectiveDate: today },
      minProfitableDays: { value: Math.max(1, minDays), status, effectiveDate: today },
      minDailyProfitUsd: { value: 0, status, effectiveDate: today },
      minWithdrawalUsd: { value: 100, status, effectiveDate: today },
      maxPayoutUsd: makeMissing('Teto de payout não especificado no registro legado', today),
      maxWithdrawalPct: makeMissing('Percentual máximo de saque não especificado', today),
      payoutFrequency: 'Sob demanda / ciclo da mesa',
      payoutCycleDays: { value: Math.max(1, minDays), status, effectiveDate: today },
      profitSplitPct: { value: split, status, effectiveDate: today },
      refundOnFirstPayout: { value: refund, status, effectiveDate: today },
    },
    viability: raw.viability ?? 'Moderada',
    rulesSummary: raw.rulesSummary ?? '',
    operationalAlert: raw.operationalAlert,
    isCustom: raw.isCustom,
  });
}

/**
 * Audits contractual completeness and integrity so the engine fails closed
 * when critical rules are missing instead of converting unknowns into 0.
 */
export function validateFirmContract(firm: PropFirmPreset): ContractualValidationResult {
  const missingCriticalFields: string[] = [];
  const unverifiedWarnings: string[] = [];
  const userAssumedFields: string[] = [];

  const inspect = <T>(label: string, field: ContractualValue<T>, critical: boolean) => {
    if (field.status === 'missing') {
      const reason = field.missingReason ? ` (${field.missingReason})` : '';
      if (critical) {
        missingCriticalFields.push(`${label}${reason}`);
      } else {
        unverifiedWarnings.push(`${label} ausente${reason}`);
      }
    } else if (field.status === 'unverified') {
      unverifiedWarnings.push(`${label} pendente de verificação oficial`);
    } else if (field.status === 'user_assumed') {
      userAssumedFields.push(label);
    }
  };

  inspect('Taxa de Avaliação (T)', firm.pricing.evaluationFee, true);
  inspect('Taxa de Ativação Funded', firm.pricing.activationFee, false);
  inspect('Meta Fase 1', firm.evaluationRules.phase1TargetUsd, true);
  inspect('Drawdown Máximo (Avaliação)', firm.evaluationRules.maxDrawdown.amountUsd, true);
  inspect('Drawdown Máximo (Funded)', firm.fundedRules.maxDrawdown.amountUsd, true);
  inspect('Profit Split (%)', firm.fundedRules.profitSplitPct, true);
  inspect('Consistência (Avaliação)', firm.evaluationRules.consistency.pct, false);
  inspect('Consistência (Funded)', firm.fundedRules.consistency.pct, false);
  inspect('Buffer de Lucro (Funded)', firm.fundedRules.profitBufferUsd, false);
  inspect('Mín. Dias Lucrativos (Payout)', firm.fundedRules.minProfitableDays, false);
  inspect('Lucro Mínimo Diário (Payout)', firm.fundedRules.minDailyProfitUsd, false);
  inspect('Teto de Payout', firm.fundedRules.maxPayoutUsd, false);

  if (firm.evaluationRules.dailyLossLimit.methodology === 'unknown') {
    unverifiedWarnings.push('Metodologia de Daily Loss na Avaliação desconhecida');
  }
  if (firm.fundedRules.dailyLossLimit.methodology === 'unknown') {
    unverifiedWarnings.push('Metodologia de Daily Loss na Funded desconhecida');
  }

  return {
    isCompleteForSimulation: missingCriticalFields.length === 0,
    missingCriticalFields,
    unverifiedWarnings,
    userAssumedFields,
  };
}
