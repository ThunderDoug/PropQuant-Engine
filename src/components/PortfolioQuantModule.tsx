import {
  AlertTriangle,
  Dices,
  Layers,
  MessageSquare,
  Plus,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ArbitrageInputs, ConsultIntent, PropFirmPreset } from '../types/quant';
import { validateFirmContract } from '../utils/contractual';
import {
  optimizeContractAwareHedgeRatios,
  type HedgeRatioAccount,
  type HedgeRatioScenario,
} from '../utils/contractAwareHedgeRatioEngine';
import {
  evaluateJointScenarioContractualPayoffs,
  type ContractualPayoffPhase,
} from '../utils/contractualPayoffEngine';
import {
  optimizeContractualPayoffAllocation,
  type ContractAccountSlot,
  type ContractOptimizationScenario,
} from '../utils/contractualPayoffOptimizationEngine';
import {
  calculateMinimumExternalCapital,
  type ExternalCapitalScenario,
} from '../utils/externalCapitalRequirementEngine';
import {
  validateJointScenarioMatrix,
  type JointAccountOutcome,
  type JointAccountStatus,
  type JointOutcomeType,
  type JointPayoutStatus,
  type JointScenarioTemplate,
} from '../utils/jointScenarioEngine';
import {
  optimizeMultiFirmCapitalAllocation,
  type CapitalAllocationCandidate,
  type CapitalAllocationScenario,
} from '../utils/multiFirmCapitalAllocationEngine';
import {
  calculateParetoFrontier,
  type ParetoConfiguration,
} from '../utils/paretoFrontierEngine';
import {
  runPathDependentPortfolioMonteCarlo,
  type PathDependentJointScenario,
  type PathDependentPortfolioAccount,
} from '../utils/pathDependentPortfolioMonteCarloEngine';
import { runPortfolioSurvivalAnalysis } from '../utils/portfolioSurvivalEngine';
import { formatFactor, formatUsd } from '../utils/quantEngine';
import {
  runUnifiedPortfolioSimulation,
  type UnifiedPortfolioAccount,
  type UnifiedPortfolioScenario,
} from '../utils/unifiedPortfolioSimulationEngine';

export interface PortfolioQuantSummarySnapshot {
  accountCount: number;
  distinctFirms: number;
  scenarioCount: number;
  portfolioSurvivalProbabilityPct: number | null;
  externalCapitalP95Usd: number | null;
  expectedContractualPayoutOpportunityUsd: number | null;
  expectedRealizedPayoutUsd: number | null;
  endingCashMedianUsd: number | null;
  paretoFrontierCount: number;
}

interface PortfolioQuantModuleProps {
  firms: PropFirmPreset[];
  activeFirm: PropFirmPreset;
  arbitrageInputs: ArbitrageInputs;
  hedgeFactor: number;
  onSummaryChange?: (snapshot: PortfolioQuantSummarySnapshot) => void;
  onConsultIntent: (intent: ConsultIntent, prompt: string) => void;
}

type PortfolioTab = 'simulation' | 'survival_liquidity' | 'optimization' | 'allocation_pareto';

interface EditablePortfolioAccount {
  accountId: string;
  firmPresetId: string;
  phase: ContractualPayoffPhase;
  cumulativeProfitUsd: number;
  priorTradingDays: number;
  hedgeRatio: number;
  ratioMin: number;
  ratioMax: number;
  ratioStep: number;
  maxLossUsd: number;
  upfrontCashCommitmentUsd: number;
  maxUnits: number;
}

interface EditableScenarioOutcome {
  grossPnlUsd: number;
  accountStatus: JointAccountStatus;
  payoutStatus: JointPayoutStatus;
  cashOutflowUsd: number;
  realizedCashInflowUsd: number;
  realizedPayoutUsd: number;
}

interface EditableJointScenario {
  scenarioId: string;
  probability: number;
  marketEvent: string;
  commonShockId: string;
  outcomes: Record<string, EditableScenarioOutcome>;
}

const PHASE_LABELS: Record<ContractualPayoffPhase, string> = {
  evaluation_phase_1: 'Avaliação Fase 1',
  evaluation_phase_2: 'Avaliação Fase 2',
  funded: 'Funded',
};

const ACCOUNT_STATUS_LABELS: Record<JointAccountStatus, string> = {
  active: 'Ativa',
  breached: 'Rompida',
  restricted: 'Restrita',
  terminated: 'Encerrada',
};

const PAYOUT_STATUS_LABELS: Record<JointPayoutStatus, string> = {
  eligible: 'Elegível',
  not_eligible: 'Inelegível',
  pending: 'Pendente',
  approved: 'Aprovado',
  blocked: 'Bloqueado',
  rejected: 'Rejeitado',
};

function inferOutcomeType(grossPnlUsd: number): JointOutcomeType {
  if (grossPnlUsd > 0) return 'win';
  if (grossPnlUsd < 0) return 'loss';
  return 'flat';
}

function formatPct(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

function pickInitialFirms(firms: PropFirmPreset[], activeFirm: PropFirmPreset): [PropFirmPreset, PropFirmPreset] {
  const completeFirms = firms.filter((item) => {
    const validation = validateFirmContract(item);
    return (
      validation.isCompleteForSimulation &&
      (item.fundedRules.payoutCycleDays.value ?? 0) > 0 &&
      item.evaluationRules.dailyLossLimit.methodology !== 'unknown' &&
      item.fundedRules.dailyLossLimit.methodology !== 'unknown'
    );
  });

  const primary = completeFirms.find((item) => item.id === activeFirm.id) ?? completeFirms[0] ?? activeFirm;
  const secondary =
    completeFirms.find((item) => item.firmId !== primary.firmId) ??
    firms.find((item) => item.firmId !== primary.firmId) ??
    primary;

  return [primary, secondary];
}

function buildInitialAccounts(
  firms: PropFirmPreset[],
  activeFirm: PropFirmPreset,
  hedgeFactor: number
): EditablePortfolioAccount[] {
  const [firmA, firmB] = pickInitialFirms(firms, activeFirm);
  const clampedRatio = Math.max(0.25, Math.min(2, Number(Math.max(0.5, hedgeFactor).toFixed(2))));

  return [
    {
      accountId: 'A-1',
      firmPresetId: firmA.id,
      phase: 'funded',
      cumulativeProfitUsd: Math.max(1200, (firmA.fundedRules.profitBufferUsd.value ?? 0) + 1000),
      priorTradingDays: Math.max(5, firmA.fundedRules.minProfitableDays.value ?? 5),
      hedgeRatio: 1,
      ratioMin: 0.5,
      ratioMax: 1.5,
      ratioStep: 0.5,
      maxLossUsd: Math.max(500, firmA.fundedRules.maxDrawdown.amountUsd.value ?? firmA.maxDrawdownUsd),
      upfrontCashCommitmentUsd: Math.max(0, firmA.evaluationFeeUsd + firmA.activationFeeUsd),
      maxUnits: 3,
    },
    {
      accountId: 'B-1',
      firmPresetId: firmB.id,
      phase: 'funded',
      cumulativeProfitUsd: Math.max(1200, (firmB.fundedRules.profitBufferUsd.value ?? 0) + 1000),
      priorTradingDays: Math.max(5, firmB.fundedRules.minProfitableDays.value ?? 5),
      hedgeRatio: clampedRatio > 0 ? 1 : 1,
      ratioMin: 0.5,
      ratioMax: 1.5,
      ratioStep: 0.5,
      maxLossUsd: Math.max(500, firmB.fundedRules.maxDrawdown.amountUsd.value ?? firmB.maxDrawdownUsd),
      upfrontCashCommitmentUsd: Math.max(0, firmB.evaluationFeeUsd + firmB.activationFeeUsd),
      maxUnits: 3,
    },
  ];
}

function buildInitialScenarios(accounts: EditablePortfolioAccount[]): EditableJointScenario[] {
  const aId = accounts[0]?.accountId ?? 'A-1';
  const bId = accounts[1]?.accountId ?? 'B-1';
  return [
    {
      scenarioId: 'tendencia-favoravel',
      probability: 0.52,
      marketEvent: 'Dia direcional favorável com janela de saque aberta',
      commonShockId: '',
      outcomes: {
        [aId]: {
          grossPnlUsd: 350,
          accountStatus: 'active',
          payoutStatus: 'eligible',
          cashOutflowUsd: 80,
          realizedCashInflowUsd: 0,
          realizedPayoutUsd: 0,
        },
        [bId]: {
          grossPnlUsd: 280,
          accountStatus: 'active',
          payoutStatus: 'eligible',
          cashOutflowUsd: 70,
          realizedCashInflowUsd: 0,
          realizedPayoutUsd: 0,
        },
      },
    },
    {
      scenarioId: 'divergencia-hedge',
      probability: 0.28,
      marketEvent: 'Divergência entre mesas (hedge parcial em caixa)',
      commonShockId: '',
      outcomes: {
        [aId]: {
          grossPnlUsd: 420,
          accountStatus: 'active',
          payoutStatus: 'eligible',
          cashOutflowUsd: 95,
          realizedCashInflowUsd: 260,
          realizedPayoutUsd: 0,
        },
        [bId]: {
          grossPnlUsd: -480,
          accountStatus: 'active',
          payoutStatus: 'not_eligible',
          cashOutflowUsd: 110,
          realizedCashInflowUsd: 0,
          realizedPayoutUsd: 0,
        },
      },
    },
    {
      scenarioId: 'choque-correlacionado',
      probability: 0.14,
      marketEvent: 'Choque macro correlacionado (drawdown conjunto)',
      commonShockId: 'macro-cpi-shock',
      outcomes: {
        [aId]: {
          grossPnlUsd: -750,
          accountStatus: 'active',
          payoutStatus: 'blocked',
          cashOutflowUsd: 220,
          realizedCashInflowUsd: 0,
          realizedPayoutUsd: 0,
        },
        [bId]: {
          grossPnlUsd: -680,
          accountStatus: 'active',
          payoutStatus: 'blocked',
          cashOutflowUsd: 200,
          realizedCashInflowUsd: 0,
          realizedPayoutUsd: 0,
        },
      },
    },
    {
      scenarioId: 'cauda-ruptura',
      probability: 0.06,
      marketEvent: 'Evento de cauda com bloqueio/ruptura parcial',
      commonShockId: 'tail-gap-event',
      outcomes: {
        [aId]: {
          grossPnlUsd: -1400,
          accountStatus: 'breached',
          payoutStatus: 'blocked',
          cashOutflowUsd: 350,
          realizedCashInflowUsd: 450,
          realizedPayoutUsd: 0,
        },
        [bId]: {
          grossPnlUsd: -900,
          accountStatus: 'active',
          payoutStatus: 'blocked',
          cashOutflowUsd: 240,
          realizedCashInflowUsd: 0,
          realizedPayoutUsd: 0,
        },
      },
    },
  ];
}

function buildPriorDailyPnl(cumulativeProfitUsd: number, days: number): number[] {
  const count = Math.max(0, Math.round(days));
  if (count === 0) return [];
  const perDay = Number((cumulativeProfitUsd / count).toFixed(2));
  return Array.from({ length: count }, () => perDay);
}

function safeRun<T>(fn: () => T): { data: T | null; error: string | null } {
  try {
    return { data: fn(), error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Erro desconhecido ao executar motor quantitativo.',
    };
  }
}

export function PortfolioQuantModule({
  firms,
  activeFirm,
  arbitrageInputs,
  hedgeFactor,
  onSummaryChange,
  onConsultIntent,
}: PortfolioQuantModuleProps) {
  const [activeTab, setActiveTab] = useState<PortfolioTab>('simulation');
  const [accounts, setAccounts] = useState<EditablePortfolioAccount[]>(() =>
    buildInitialAccounts(firms, activeFirm, hedgeFactor)
  );
  const [scenarios, setScenarios] = useState<EditableJointScenario[]>(() =>
    buildInitialScenarios(buildInitialAccounts(firms, activeFirm, hedgeFactor))
  );

  // Simulation parameters (Phases 3, 9, 10, 11)
  const [iterations, setIterations] = useState<number>(400);
  const [horizonPeriods, setHorizonPeriods] = useState<number>(10);
  const [availableCashUsd, setAvailableCashUsd] = useState<number>(() =>
    Math.max(1500, Math.round(arbitrageInputs.drawdownUsd * 1.25))
  );
  const [seed, setSeed] = useState<number>(202611);
  const [minimumActiveAccounts, setMinimumActiveAccounts] = useState<number>(1);
  const [maxPortfolioLossUsd, setMaxPortfolioLossUsd] = useState<number>(4500);

  // External capital parameters (Phase 5)
  const [minimumReserveUsd, setMinimumReserveUsd] = useState<number>(300);
  const [confidenceLevelPct, setConfidenceLevelPct] = useState<number>(90);
  const [externalFundingBudgetUsd, setExternalFundingBudgetUsd] = useState<number>(2000);

  // Optimization parameters (Phases 7 & 8)
  const [maxProbCombinedLossPct, setMaxProbCombinedLossPct] = useState<number>(45);
  const [maxWorstCaseLossUsd, setMaxWorstCaseLossUsd] = useState<number>(3000);
  const [minDistinctFirmsOpt, setMinDistinctFirmsOpt] = useState<number>(2);
  const [maxAccountsPerFirmOpt, setMaxAccountsPerFirmOpt] = useState<number>(1);
  const [requireCompleteContracts, setRequireCompleteContracts] = useState<boolean>(true);

  // Capital allocation & Pareto parameters (Phases 4 & 6)
  const [capitalBudgetUsd, setCapitalBudgetUsd] = useState<number>(3000);
  const [maxFirmSharePct, setMaxFirmSharePct] = useState<number>(65);
  const [minSurvivalProbPct, setMinSurvivalProbPct] = useState<number>(75);
  const [riskAversion, setRiskAversion] = useState<number>(0.25);
  const [capitalCostRatePct, setCapitalCostRatePct] = useState<number>(2);
  const [hoveredParetoId, setHoveredParetoId] = useState<string | null>(null);

  const firmMap = useMemo(() => new Map(firms.map((item) => [item.id, item])), [firms]);

  const resolvedAccounts = useMemo(
    () =>
      accounts.map((acc) => ({
        ...acc,
        firm: firmMap.get(acc.firmPresetId) ?? activeFirm,
      })),
    [accounts, firmMap, activeFirm]
  );

  // Clamp minimumActiveAccounts safely whenever account count changes
  const effectiveMinActiveAccounts = Math.max(
    1,
    Math.min(minimumActiveAccounts, Math.max(1, resolvedAccounts.length))
  );

  const probabilitySum = useMemo(
    () => scenarios.reduce((sum, s) => sum + (Number.isFinite(s.probability) ? s.probability : 0), 0),
    [scenarios]
  );

  // Phase 1: Joint Scenario Matrix templates & validation
  const phase1Definitions = useMemo(
    () =>
      resolvedAccounts.map((acc) => ({
        accountId: acc.accountId,
        firmId: acc.firm.firmId,
      })),
    [resolvedAccounts]
  );

  const phase1Templates: JointScenarioTemplate[] = useMemo(
    () =>
      scenarios.map((scenario) => {
        const outcomes: Record<string, JointAccountOutcome> = {};
        for (const acc of resolvedAccounts) {
          const raw = scenario.outcomes[acc.accountId] ?? {
            grossPnlUsd: 0,
            accountStatus: 'active' as JointAccountStatus,
            payoutStatus: 'not_eligible' as JointPayoutStatus,
            cashOutflowUsd: 0,
            realizedCashInflowUsd: 0,
            realizedPayoutUsd: 0,
          };
          outcomes[acc.accountId] = {
            grossPnlUsd: raw.grossPnlUsd,
            outcomeType: inferOutcomeType(raw.grossPnlUsd),
            accountStatus: raw.accountStatus,
            payoutStatus: raw.payoutStatus,
          };
        }
        return {
          scenarioId: scenario.scenarioId,
          probability: scenario.probability,
          marketEvent: scenario.marketEvent,
          commonShockId: scenario.commonShockId.trim() ? scenario.commonShockId.trim() : null,
          outcomes,
        };
      }),
    [scenarios, resolvedAccounts]
  );

  const matrixValidation = useMemo(
    () => validateJointScenarioMatrix(phase1Definitions, phase1Templates),
    [phase1Definitions, phase1Templates]
  );

  // Phase 2: Nonlinear Contractual Payoff per joint scenario
  const phase2Results = useMemo(() => {
    if (!matrixValidation.isValid) {
      return { data: null, error: matrixValidation.errors.join(' ') };
    }
    return safeRun(() => {
      const firmsById: Record<string, PropFirmPreset> = {};
      const configs = resolvedAccounts.map((acc) => {
        // Key by unique accountId-scoped firm key when two presets share the same firmId
        const scopedFirmKey = `${acc.firm.firmId}::${acc.firm.id}`;
        firmsById[scopedFirmKey] = acc.firm;
        return {
          accountId: acc.accountId,
          firmId: scopedFirmKey,
          state: {
            phase: acc.phase,
            cumulativeProfitUsd: acc.cumulativeProfitUsd,
            priorDailyPnlUsd: buildPriorDailyPnl(acc.cumulativeProfitUsd, acc.priorTradingDays),
            priorTradingDays: acc.priorTradingDays,
          },
        };
      });
      return phase1Templates.map((scenario) => ({
        probability: scenario.probability,
        marketEvent: scenario.marketEvent,
        summary: evaluateJointScenarioContractualPayoffs(
          { scenarioId: scenario.scenarioId, outcomes: scenario.outcomes },
          configs,
          firmsById
        ),
      }));
    });
  }, [matrixValidation, resolvedAccounts, phase1Templates]);

  // Phase 11 (internally calls Phase 10 Contractual Lifecycle Engine)
  const phase11Result = useMemo(() => {
    if (!matrixValidation.isValid) {
      return { data: null, error: matrixValidation.errors.join(' ') };
    }
    return safeRun(() => {
      const sessionIds = Array.from({ length: horizonPeriods }, (_, index) => `day-${index + 1}`);
      const mcAccounts: PathDependentPortfolioAccount[] = resolvedAccounts.map((acc) => {
        const initialBalance = acc.firm.accountSize + acc.cumulativeProfitUsd;
        return {
          accountId: acc.accountId,
          firm: acc.firm,
          initialPhase: acc.phase,
          initialBalanceUsd: initialBalance,
          initialEquityUsd: initialBalance,
          initialCumulativeProfitUsd: acc.cumulativeProfitUsd,
          initialHighWaterMarkUsd: Math.max(acc.firm.accountSize, initialBalance),
          initialPriorDailyPnlUsd: buildPriorDailyPnl(acc.cumulativeProfitUsd, acc.priorTradingDays),
          initialPriorTradingDays: acc.priorTradingDays,
          initialPayoutCycleElapsedDays: Math.max(0, Math.round(acc.priorTradingDays)),
          hedgeRatio: acc.hedgeRatio,
          upfrontCashCommitmentUsd: acc.upfrontCashCommitmentUsd,
        };
      });

      const mcScenarios: PathDependentJointScenario[] = scenarios.map((scenario, idx) => {
        const template = phase1Templates[idx];
        const accountPaths: PathDependentJointScenario['accountPaths'] = {};
        const cashFlows: NonNullable<PathDependentJointScenario['cashFlows']> = {};

        for (const acc of resolvedAccounts) {
          const raw = scenario.outcomes[acc.accountId];
          const gross = raw?.grossPnlUsd ?? 0;
          accountPaths[acc.accountId] = {
            sessionId: 'day-1',
            sessionIdByPeriod: sessionIds,
            intradayPeakPnlUsd: Math.max(0, gross),
            intradayAdversePnlUsd: Math.min(0, gross),
            realizedPayoutUsd: Math.max(0, raw?.realizedPayoutUsd ?? 0),
          };
          cashFlows[acc.accountId] = {
            cashOutflowUsd: Math.max(0, raw?.cashOutflowUsd ?? 0),
            realizedCashInflowUsd: Math.max(0, raw?.realizedCashInflowUsd ?? 0),
          };
        }

        return {
          ...template,
          accountPaths,
          cashFlows,
        };
      });

      return runPathDependentPortfolioMonteCarlo({
        accounts: mcAccounts,
        scenarios: mcScenarios,
        iterations,
        horizonPeriods,
        seed,
        availableCashUsd,
        minimumActiveAccounts: effectiveMinActiveAccounts,
        maxPortfolioLossUsd: maxPortfolioLossUsd > 0 ? maxPortfolioLossUsd : null,
        samplePathCount: Math.min(8, iterations),
      });
    });
  }, [
    matrixValidation,
    resolvedAccounts,
    scenarios,
    phase1Templates,
    iterations,
    horizonPeriods,
    seed,
    availableCashUsd,
    effectiveMinActiveAccounts,
    maxPortfolioLossUsd,
  ]);

  // Phase 9: Unified Portfolio Simulation
  const phase9Result = useMemo(() => {
    if (!matrixValidation.isValid) {
      return { data: null, error: matrixValidation.errors.join(' ') };
    }
    return safeRun(() => {
      const unifiedAccounts: UnifiedPortfolioAccount[] = resolvedAccounts.map((acc) => ({
        accountId: acc.accountId,
        firmId: acc.firm.firmId,
        firm: acc.firm,
        accountState: {
          phase: acc.phase,
          cumulativeProfitUsd: acc.cumulativeProfitUsd,
          priorDailyPnlUsd: buildPriorDailyPnl(acc.cumulativeProfitUsd, acc.priorTradingDays),
          priorTradingDays: acc.priorTradingDays,
        },
        hedgeRatio: acc.hedgeRatio,
        maxLossUsd: acc.maxLossUsd,
        upfrontCashCommitmentUsd: acc.upfrontCashCommitmentUsd,
        initialCumulativePnlUsd: 0,
      }));

      const unifiedScenarios: UnifiedPortfolioScenario[] = scenarios.map((scenario, idx) => {
        const cashFlows: NonNullable<UnifiedPortfolioScenario['cashFlows']> = {};
        for (const acc of resolvedAccounts) {
          const raw = scenario.outcomes[acc.accountId];
          cashFlows[acc.accountId] = {
            cashOutflowUsd: Math.max(0, raw?.cashOutflowUsd ?? 0),
            realizedCashInflowUsd:
              Math.max(0, raw?.realizedCashInflowUsd ?? 0) +
              Math.max(0, raw?.realizedPayoutUsd ?? 0),
          };
        }
        return {
          ...phase1Templates[idx],
          cashFlows,
        };
      });

      return runUnifiedPortfolioSimulation({
        accounts: unifiedAccounts,
        scenarios: unifiedScenarios,
        iterations,
        horizonPeriods,
        seed,
        availableCashUsd,
        minimumActiveAccounts: effectiveMinActiveAccounts,
        maxPortfolioLossUsd: maxPortfolioLossUsd > 0 ? maxPortfolioLossUsd : null,
        samplePathCount: 0,
      });
    });
  }, [
    matrixValidation,
    resolvedAccounts,
    scenarios,
    phase1Templates,
    iterations,
    horizonPeriods,
    seed,
    availableCashUsd,
    effectiveMinActiveAccounts,
    maxPortfolioLossUsd,
  ]);

  // Phase 3: Multi-Firm Portfolio Survival Analysis
  const phase3Result = useMemo(() => {
    if (!matrixValidation.isValid) {
      return { data: null, error: matrixValidation.errors.join(' ') };
    }
    return safeRun(() =>
      runPortfolioSurvivalAnalysis({
        accounts: resolvedAccounts.map((acc) => ({
          accountId: acc.accountId,
          firmId: acc.firm.firmId,
          maxLossUsd: acc.maxLossUsd,
          initialCumulativePnlUsd: 0,
        })),
        scenarios: phase1Templates,
        iterations,
        horizonPeriods,
        seed,
        minimumActiveAccounts: effectiveMinActiveAccounts,
        maxPortfolioLossUsd: maxPortfolioLossUsd > 0 ? maxPortfolioLossUsd : null,
      })
    );
  }, [
    matrixValidation,
    resolvedAccounts,
    phase1Templates,
    iterations,
    horizonPeriods,
    seed,
    effectiveMinActiveAccounts,
    maxPortfolioLossUsd,
  ]);

  // Phase 5: Minimum External Capital Requirement
  const phase5Result = useMemo(() => {
    if (!matrixValidation.isValid) {
      return { data: null, error: matrixValidation.errors.join(' ') };
    }
    return safeRun(() => {
      const totalUpfrontOutflow = resolvedAccounts.reduce(
        (sum, acc) => sum + Math.max(0, acc.upfrontCashCommitmentUsd),
        0
      );
      const extScenarios: ExternalCapitalScenario[] = scenarios.map((scenario) => {
        const netPeriodFlow = resolvedAccounts.reduce((sum, acc) => {
          const raw = scenario.outcomes[acc.accountId];
          const inflow =
            Math.max(0, raw?.realizedCashInflowUsd ?? 0) +
            Math.max(0, raw?.realizedPayoutUsd ?? 0);
          const outflow = Math.max(0, raw?.cashOutflowUsd ?? 0);
          return sum + (inflow - outflow);
        }, 0);

        // Period 1 includes upfront commitments + operational period 1; periods 2..N reflect recurring horizon stress
        const periods = Array.from({ length: Math.min(horizonPeriods, 12) }, (_, idx) => ({
          period: idx + 1,
          netCashFlowUsd: idx === 0 ? netPeriodFlow - totalUpfrontOutflow : netPeriodFlow,
        }));

        return {
          scenarioId: scenario.scenarioId,
          probability: scenario.probability,
          periods,
        };
      });

      return calculateMinimumExternalCapital(extScenarios, {
        availableCapitalUsd: availableCashUsd,
        minimumReserveUsd,
        confidenceLevel: Math.max(0.5, Math.min(0.99, confidenceLevelPct / 100)),
        externalFundingBudgetUsd,
      });
    });
  }, [
    matrixValidation,
    resolvedAccounts,
    scenarios,
    horizonPeriods,
    availableCashUsd,
    minimumReserveUsd,
    confidenceLevelPct,
    externalFundingBudgetUsd,
  ]);

  // Phase 8: Contract-Aware Hedge Ratio Optimization
  const phase8Result = useMemo(() => {
    if (!matrixValidation.isValid) {
      return { data: null, error: matrixValidation.errors.join(' ') };
    }
    return safeRun(() => {
      const hrAccounts: HedgeRatioAccount[] = resolvedAccounts.map((acc) => ({
        accountId: acc.accountId,
        firm: acc.firm,
        accountState: {
          phase: acc.phase,
          cumulativeProfitUsd: acc.cumulativeProfitUsd,
          priorDailyPnlUsd: buildPriorDailyPnl(acc.cumulativeProfitUsd, acc.priorTradingDays),
          priorTradingDays: acc.priorTradingDays,
        },
        ratio: {
          min: acc.ratioMin,
          max: acc.ratioMax,
          step: acc.ratioStep,
        },
      }));
      const hrScenarios: HedgeRatioScenario[] = phase1Templates.map((scenario) => ({
        scenarioId: scenario.scenarioId,
        probability: scenario.probability,
        outcomes: scenario.outcomes,
      }));
      return optimizeContractAwareHedgeRatios(hrAccounts, hrScenarios, {
        constraints: {
          maxProbabilityOfCombinedLoss: Math.max(0, Math.min(1, maxProbCombinedLossPct / 100)),
          maxWorstCaseCombinedLossUsd: maxWorstCaseLossUsd,
          maxSearchNodes: 50_000,
        },
      });
    });
  }, [
    matrixValidation,
    resolvedAccounts,
    phase1Templates,
    maxProbCombinedLossPct,
    maxWorstCaseLossUsd,
  ]);

  // Phase 7: Contractual Payoff Optimization across candidate prop firms
  const phase7Result = useMemo(() => {
    if (!matrixValidation.isValid) {
      return { data: null, error: matrixValidation.errors.join(' ') };
    }
    return safeRun(() => {
      // Build a curated pool of up to 6 distinct candidate firms (always including currently selected firms)
      const selectedFirmIds = new Set(resolvedAccounts.map((a) => a.firm.id));
      const candidatePool: PropFirmPreset[] = [];
      const seenPresetIds = new Set<string>();
      for (const acc of resolvedAccounts) {
        if (!seenPresetIds.has(acc.firm.id)) {
          seenPresetIds.add(acc.firm.id);
          candidatePool.push(acc.firm);
        }
      }
      for (const preset of firms) {
        if (candidatePool.length >= 6) break;
        if (seenPresetIds.has(preset.id)) continue;
        if (preset.viability !== 'Incompatível' || selectedFirmIds.has(preset.id)) {
          seenPresetIds.add(preset.id);
          candidatePool.push(preset);
        }
      }

      const slots: ContractAccountSlot[] = resolvedAccounts.map((acc) => ({
        accountId: acc.accountId,
        alternatives: candidatePool.map((candidateFirm) => ({
          alternativeId: candidateFirm.id,
          firm: candidateFirm,
          accountState: {
            phase: acc.phase,
            cumulativeProfitUsd: acc.cumulativeProfitUsd,
            priorDailyPnlUsd: buildPriorDailyPnl(acc.cumulativeProfitUsd, acc.priorTradingDays),
            priorTradingDays: acc.priorTradingDays,
          },
        })),
      }));

      const optScenarios: ContractOptimizationScenario[] = phase1Templates.map((scenario) => ({
        scenarioId: scenario.scenarioId,
        probability: scenario.probability,
        outcomes: scenario.outcomes,
      }));

      return optimizeContractualPayoffAllocation(slots, optScenarios, {
        constraints: {
          minimumDistinctFirms: Math.max(1, Math.min(minDistinctFirmsOpt, resolvedAccounts.length)),
          maximumAccountsPerFirm: Math.max(1, maxAccountsPerFirmOpt),
          requireCompleteContracts,
          maxSearchNodes: 50_000,
        },
      });
    });
  }, [
    matrixValidation,
    resolvedAccounts,
    firms,
    phase1Templates,
    minDistinctFirmsOpt,
    maxAccountsPerFirmOpt,
    requireCompleteContracts,
  ]);

  // Phase 4: Multi-Firm Capital Allocation + Phase 6: Pareto Frontier
  const phase4And6Results = useMemo(() => {
    if (!matrixValidation.isValid) {
      return { data: null, error: matrixValidation.errors.join(' ') };
    }
    return safeRun(() => {
      const candidates: CapitalAllocationCandidate[] = resolvedAccounts.map((acc) => ({
        candidateId: `cand-${acc.accountId}`,
        accountId: acc.accountId,
        firmId: acc.firm.firmId,
        capitalRequiredUsd: Math.max(
          100,
          acc.upfrontCashCommitmentUsd + Math.round(acc.maxLossUsd * 0.25)
        ),
        maxUnits: Math.max(1, Math.min(4, acc.maxUnits)),
      }));

      const allocScenarios: CapitalAllocationScenario[] = scenarios.map((scenario, idx) => {
        const outcomes: CapitalAllocationScenario['outcomes'] = {};
        for (const acc of resolvedAccounts) {
          const raw = scenario.outcomes[acc.accountId];
          const templateOutcome = phase1Templates[idx].outcomes[acc.accountId];
          const netPnlUsd =
            (templateOutcome?.grossPnlUsd ?? 0) * acc.hedgeRatio +
            Math.max(0, raw?.realizedCashInflowUsd ?? 0) -
            Math.max(0, raw?.cashOutflowUsd ?? 0);
          outcomes[`cand-${acc.accountId}`] = {
            netPnlUsd,
            survives: templateOutcome?.accountStatus === 'active',
          };
        }
        return {
          scenarioId: scenario.scenarioId,
          probability: scenario.probability,
          outcomes,
        };
      });

      const distinctAvailableFirms = new Set(candidates.map((c) => c.firmId)).size;
      const baseMinFirms = Math.max(1, Math.min(minDistinctFirmsOpt, distinctAvailableFirms));

      const allocation = optimizeMultiFirmCapitalAllocation(candidates, allocScenarios, {
        capitalBudgetUsd,
        maxFirmCapitalSharePct: maxFirmSharePct,
        minimumDistinctFirms: baseMinFirms,
        minimumPortfolioSurvivalProbability: Math.max(0, Math.min(1, minSurvivalProbPct / 100)),
        riskAversion,
        capitalCostRate: Math.max(0, capitalCostRatePct / 100),
        cvarConfidenceLevel: Math.max(0.5, Math.min(0.99, confidenceLevelPct / 100)),
        maxSearchNodes: 50_000,
      });

      // Generate multi-profile configurations for Phase 6 Pareto Frontier comparison
      const profiles = [
        { id: 'Conservador (50% orçamento)', budgetFactor: 0.5, aversion: 0.8, maxShare: 60 },
        { id: 'Defensivo (75% orçamento)', budgetFactor: 0.75, aversion: 0.5, maxShare: 60 },
        { id: 'Balanceado (Atual)', budgetFactor: 1.0, aversion: riskAversion, maxShare: maxFirmSharePct },
        { id: 'Crescimento (125% orçamento)', budgetFactor: 1.25, aversion: 0.1, maxShare: 75 },
        { id: 'Agressivo (160% orçamento)', budgetFactor: 1.6, aversion: 0.0, maxShare: 100 },
        { id: 'Alta Diversificação', budgetFactor: 1.1, aversion: 0.35, maxShare: 50 },
      ];

      const paretoConfigs: ParetoConfiguration[] = [];
      for (const profile of profiles) {
        const res = optimizeMultiFirmCapitalAllocation(candidates, allocScenarios, {
          capitalBudgetUsd: Math.max(250, Math.round(capitalBudgetUsd * profile.budgetFactor)),
          maxFirmCapitalSharePct: profile.maxShare,
          minimumDistinctFirms: 1,
          riskAversion: profile.aversion,
          capitalCostRate: Math.max(0, capitalCostRatePct / 100),
          cvarConfidenceLevel: Math.max(0.5, Math.min(0.99, confidenceLevelPct / 100)),
          maxSearchNodes: 25_000,
        });
        if (res.status === 'optimal') {
          const activeFirms = new Set(res.allocation.filter((l) => l.units > 0).map((l) => l.firmId)).size;
          const activeAccts = res.allocation.reduce((sum, l) => sum + l.units, 0);
          const worstLoss = Math.max(0, -res.worstScenarioNetPnlUsd);
          const cvarLoss = Math.min(worstLoss, Math.max(0, res.conditionalValueAtRiskLossUsd));
          paretoConfigs.push({
            configurationId: profile.id,
            externalCapitalRequiredUsd: res.committedCapitalUsd,
            expectedNetProfitUsd: Number(res.expectedNetPnlUsd.toFixed(2)),
            portfolioSurvivalProbability: res.portfolioSurvivalProbability,
            probabilityOfLoss: res.probabilityOfLoss,
            cvarLossUsd: Number(cvarLoss.toFixed(2)),
            worstCaseLossUsd: Number(worstLoss.toFixed(2)),
            activeFirmCount: activeFirms,
            activeAccountCount: activeAccts,
          });
        }
      }

      const pareto =
        paretoConfigs.length > 0
          ? calculateParetoFrontier(paretoConfigs, {
              constraints: {
                maxExternalCapitalUsd: Math.round(capitalBudgetUsd * 1.4),
                minPortfolioSurvivalProbability: Math.max(0, Math.min(1, minSurvivalProbPct / 100)),
              },
            })
          : null;

      return { allocation, pareto };
    });
  }, [
    matrixValidation,
    resolvedAccounts,
    scenarios,
    phase1Templates,
    capitalBudgetUsd,
    maxFirmSharePct,
    minDistinctFirmsOpt,
    minSurvivalProbPct,
    riskAversion,
    capitalCostRatePct,
    confidenceLevelPct,
  ]);

  // Publish summary snapshot to App workspaceContext for AI Consultant
  useEffect(() => {
    if (!onSummaryChange) return;
    const distinctFirms = new Set(resolvedAccounts.map((acc) => acc.firm.firmId)).size;
    const mc = phase11Result.data;
    onSummaryChange({
      accountCount: resolvedAccounts.length,
      distinctFirms,
      scenarioCount: scenarios.length,
      portfolioSurvivalProbabilityPct: mc ? Number((mc.portfolioSurvivalProbability * 100).toFixed(1)) : null,
      externalCapitalP95Usd: mc ? Number(mc.externalCapitalRequiredP95Usd.toFixed(2)) : null,
      expectedContractualPayoutOpportunityUsd: mc
        ? Number(mc.expectedContractualPayoutOpportunityUsd.toFixed(2))
        : null,
      expectedRealizedPayoutUsd: mc ? Number(mc.expectedRealizedPayoutUsd.toFixed(2)) : null,
      endingCashMedianUsd: mc ? Number(mc.endingCashBalanceP50Usd.toFixed(2)) : null,
      paretoFrontierCount: phase4And6Results.data?.pareto?.frontierCount ?? 0,
    });
  }, [onSummaryChange, resolvedAccounts, scenarios.length, phase11Result.data, phase4And6Results.data]);

  // Handlers for editing portfolio accounts & joint scenarios
  const handleAddAccount = () => {
    if (accounts.length >= 4) return;
    const nextIdx = accounts.length + 1;
    const letter = String.fromCharCode(64 + nextIdx);
    const nextId = `${letter}-1`;
    const usedFirmIds = new Set(resolvedAccounts.map((a) => a.firm.firmId));
    const candidateFirm =
      firms.find((f) => !usedFirmIds.has(f.firmId) && validateFirmContract(f).isCompleteForSimulation) ??
      activeFirm;

    const newAcc: EditablePortfolioAccount = {
      accountId: nextId,
      firmPresetId: candidateFirm.id,
      phase: 'funded',
      cumulativeProfitUsd: Math.max(1000, (candidateFirm.fundedRules.profitBufferUsd.value ?? 0) + 800),
      priorTradingDays: Math.max(5, candidateFirm.fundedRules.minProfitableDays.value ?? 5),
      hedgeRatio: 1,
      ratioMin: 0.5,
      ratioMax: 1.5,
      ratioStep: 0.5,
      maxLossUsd: Math.max(500, candidateFirm.fundedRules.maxDrawdown.amountUsd.value ?? candidateFirm.maxDrawdownUsd),
      upfrontCashCommitmentUsd: Math.max(0, candidateFirm.evaluationFeeUsd + candidateFirm.activationFeeUsd),
      maxUnits: 2,
    };

    setAccounts((prev) => [...prev, newAcc]);
    setScenarios((prev) =>
      prev.map((scenario) => ({
        ...scenario,
        outcomes: {
          ...scenario.outcomes,
          [nextId]: {
            grossPnlUsd: scenario.probability >= 0.25 ? 250 : -500,
            accountStatus: 'active',
            payoutStatus: scenario.probability >= 0.25 ? 'eligible' : 'blocked',
            cashOutflowUsd: 75,
            realizedCashInflowUsd: 0,
            realizedPayoutUsd: 0,
          },
        },
      }))
    );
  };

  const handleRemoveAccount = (accountId: string) => {
    if (accounts.length <= 1) return;
    setAccounts((prev) => prev.filter((item) => item.accountId !== accountId));
    setScenarios((prev) =>
      prev.map((scenario) => {
        const nextOutcomes = { ...scenario.outcomes };
        delete nextOutcomes[accountId];
        return { ...scenario, outcomes: nextOutcomes };
      })
    );
  };

  const handleUpdateAccount = (
    accountId: string,
    patch: Partial<EditablePortfolioAccount>
  ) => {
    setAccounts((prev) =>
      prev.map((item) => {
        if (item.accountId !== accountId) return item;
        const next = { ...item, ...patch };
        if (patch.firmPresetId) {
          const nextFirm = firmMap.get(patch.firmPresetId);
          if (nextFirm) {
            next.maxLossUsd = Math.max(
              500,
              nextFirm.fundedRules.maxDrawdown.amountUsd.value ?? nextFirm.maxDrawdownUsd
            );
            next.upfrontCashCommitmentUsd = Math.max(
              0,
              nextFirm.evaluationFeeUsd + nextFirm.activationFeeUsd
            );
          }
        }
        return next;
      })
    );
  };

  const handleUpdateScenario = (
    scenarioId: string,
    patch: Partial<Omit<EditableJointScenario, 'outcomes'>>
  ) => {
    setScenarios((prev) =>
      prev.map((s) => (s.scenarioId === scenarioId ? { ...s, ...patch } : s))
    );
  };

  const handleUpdateScenarioOutcome = (
    scenarioId: string,
    accountId: string,
    patch: Partial<EditableScenarioOutcome>
  ) => {
    setScenarios((prev) =>
      prev.map((s) => {
        if (s.scenarioId !== scenarioId) return s;
        const current = s.outcomes[accountId] ?? {
          grossPnlUsd: 0,
          accountStatus: 'active' as JointAccountStatus,
          payoutStatus: 'not_eligible' as JointPayoutStatus,
          cashOutflowUsd: 0,
          realizedCashInflowUsd: 0,
          realizedPayoutUsd: 0,
        };
        return {
          ...s,
          outcomes: {
            ...s.outcomes,
            [accountId]: { ...current, ...patch },
          },
        };
      })
    );
  };

  const handleNormalizeProbabilities = () => {
    if (scenarios.length === 0) return;
    const total = scenarios.reduce((sum, s) => sum + Math.max(0, s.probability), 0);
    if (total <= 0) {
      const equal = Number((1 / scenarios.length).toFixed(4));
      setScenarios((prev) =>
        prev.map((s, idx) => ({
          ...s,
          probability:
            idx === prev.length - 1
              ? Number((1 - equal * (prev.length - 1)).toFixed(4))
              : equal,
        }))
      );
      return;
    }
    let running = 0;
    setScenarios((prev) =>
      prev.map((s, idx) => {
        if (idx === prev.length - 1) {
          return { ...s, probability: Math.max(0, Number((1 - running).toFixed(4))) };
        }
        const normalized = Number((Math.max(0, s.probability) / total).toFixed(4));
        running += normalized;
        return { ...s, probability: normalized };
      })
    );
  };

  const handleAddScenario = () => {
    const idx = scenarios.length + 1;
    const newOutcomes: Record<string, EditableScenarioOutcome> = {};
    for (const acc of accounts) {
      newOutcomes[acc.accountId] = {
        grossPnlUsd: 0,
        accountStatus: 'active',
        payoutStatus: 'not_eligible',
        cashOutflowUsd: 50,
        realizedCashInflowUsd: 0,
        realizedPayoutUsd: 0,
      };
    }
    setScenarios((prev) => [
      ...prev,
      {
        scenarioId: `cenario-${idx}`,
        probability: 0,
        marketEvent: `Cenário personalizado ${idx}`,
        commonShockId: '',
        outcomes: newOutcomes,
      },
    ]);
  };

  const handleRemoveScenario = (scenarioId: string) => {
    if (scenarios.length <= 1) return;
    setScenarios((prev) => prev.filter((s) => s.scenarioId !== scenarioId));
  };

  const handleApplyOptimalHedgeRatios = () => {
    const optimal = phase8Result.data;
    if (!optimal || optimal.status !== 'optimal') return;
    const ratioByAccount = new Map(optimal.allocation.map((item) => [item.accountId, item.ratio]));
    setAccounts((prev) =>
      prev.map((acc) => ({
        ...acc,
        hedgeRatio: ratioByAccount.get(acc.accountId) ?? acc.hedgeRatio,
      }))
    );
  };

  const handleApplyOptimalContracts = () => {
    const optimal = phase7Result.data;
    if (!optimal || optimal.status !== 'optimal') return;
    const presetByAccount = new Map(
      optimal.allocation.map((item) => [item.accountId, item.alternativeId])
    );
    setAccounts((prev) =>
      prev.map((acc) => {
        const nextPresetId = presetByAccount.get(acc.accountId);
        if (!nextPresetId) return acc;
        const nextFirm = firmMap.get(nextPresetId);
        return {
          ...acc,
          firmPresetId: nextPresetId,
          maxLossUsd: nextFirm
            ? Math.max(500, nextFirm.fundedRules.maxDrawdown.amountUsd.value ?? nextFirm.maxDrawdownUsd)
            : acc.maxLossUsd,
          upfrontCashCommitmentUsd: nextFirm
            ? Math.max(0, nextFirm.evaluationFeeUsd + nextFirm.activationFeeUsd)
            : acc.upfrontCashCommitmentUsd,
        };
      })
    );
  };

  const distinctFirmCount = useMemo(
    () => new Set(resolvedAccounts.map((acc) => acc.firm.firmId)).size,
    [resolvedAccounts]
  );

  // Pareto SVG Geometry
  const paretoChartData = useMemo(() => {
    const pareto = phase4And6Results.data?.pareto;
    if (!pareto) return null;
    const allItems = [
      ...pareto.frontier.map((item) => ({ ...item, bucket: 'frontier' as const })),
      ...pareto.dominated.map((item) => ({ ...item, bucket: 'dominated' as const })),
      ...pareto.infeasible.map((item) => ({ ...item, bucket: 'infeasible' as const })),
    ];
    if (allItems.length === 0) return null;

    const xs = allItems.map((i) => i.configuration.externalCapitalRequiredUsd);
    const ys = allItems.map((i) => i.configuration.expectedNetProfitUsd);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys, 0);
    const maxY = Math.max(...ys, 100);
    const padX = Math.max(100, (maxX - minX) * 0.15);
    const padY = Math.max(50, (maxY - minY) * 0.18);

    const xDomainMin = Math.max(0, minX - padX);
    const xDomainMax = maxX + padX;
    const yDomainMin = minY - padY;
    const yDomainMax = maxY + padY;

    const width = 620;
    const height = 270;
    const margin = { top: 20, right: 24, bottom: 40, left: 68 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    const scaleX = (x: number) =>
      margin.left + ((x - xDomainMin) / Math.max(1, xDomainMax - xDomainMin)) * plotW;
    const scaleY = (y: number) =>
      margin.top + plotH - ((y - yDomainMin) / Math.max(1, yDomainMax - yDomainMin)) * plotH;

    const frontierPoints = allItems
      .filter((i) => i.bucket === 'frontier')
      .sort((a, b) => a.configuration.externalCapitalRequiredUsd - b.configuration.externalCapitalRequiredUsd);

    return {
      width,
      height,
      margin,
      allItems,
      frontierPoints,
      scaleX,
      scaleY,
      xTicks: [0, 0.33, 0.66, 1].map((t) => xDomainMin + t * (xDomainMax - xDomainMin)),
      yTicks: [0, 0.33, 0.66, 1].map((t) => yDomainMin + t * (yDomainMax - yDomainMin)),
    };
  }, [phase4And6Results.data]);

  const TABS: Array<{ id: PortfolioTab; label: string; subtitle: string }> = [
    {
      id: 'simulation',
      label: 'Monte Carlo & Ciclo de Vida',
      subtitle: 'Fases 1, 2, 9, 10 e 11',
    },
    {
      id: 'survival_liquidity',
      label: 'Sobrevivência & Liquidez',
      subtitle: 'Fases 3 e 5',
    },
    {
      id: 'optimization',
      label: 'Hedge Ratio & Contratos',
      subtitle: 'Fases 7 e 8',
    },
    {
      id: 'allocation_pareto',
      label: 'Alocação & Pareto',
      subtitle: 'Fases 4 e 6',
    },
  ];

  return (
    <div className="space-y-8">
      {/* Header Section */}
      <section className="flex flex-col gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end lg:justify-between dark:border-slate-800">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            Motor Quantitativo Multi-Mesa · Fases 1 a 11 · {resolvedAccounts.length} contas ·{' '}
            {distinctFirmCount} {distinctFirmCount === 1 ? 'mesa' : 'mesas'} · {scenarios.length} cenários conjuntos
          </p>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl dark:text-white text-balance">
            Portfólio Multi-Mesa, Sobrevivência e Otimização Contratual
          </h1>
          <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
            Simulação conjunta dependente de trajetória com regras contratuais não lineares, livro-caixa separado de
            payout potencial, matriz de contágio entre contas, otimização de hedge ratio e fronteira de Pareto.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() =>
              onConsultIntent(
                'CUSTOM',
                `Analise meu portfólio multi-mesa (${resolvedAccounts.length} contas em ${distinctFirmCount} mesas, ${scenarios.length} cenários conjuntos, horizonte ${horizonPeriods} períodos, caixa disponível ${formatUsd(availableCashUsd)}). Avalie sobrevivência conjunta, capital externo P95, risco de contágio e otimização de hedge ratios.`
              )
            }
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0 dark:border-slate-700 dark:bg-[#0F1624] dark:text-slate-200 dark:hover:bg-slate-800/80"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Auditar Portfólio com IA
          </button>
        </div>
      </section>

      {/* Shared Portfolio Builder + Joint Scenario Matrix (Phase 1) */}
      <section className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* Accounts Configuration */}
        <div className="xl:col-span-5 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                1. Contas do Portfólio Multi-Mesa
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Cada conta carrega o contrato real da mesa e multiplicador de exposição.
              </p>
            </div>
            <button
              type="button"
              onClick={handleAddAccount}
              disabled={accounts.length >= 4}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap shrink-0 dark:bg-emerald-600 dark:hover:bg-emerald-500"
            >
              <Plus className="h-3.5 w-3.5" />
              Adicionar Conta
            </button>
          </div>

          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {resolvedAccounts.map((acc) => {
              const validation = validateFirmContract(acc.firm);
              return (
                <div key={acc.accountId} className="py-4 first:pt-0 last:pb-0 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-semibold text-slate-900 dark:text-white">
                        {acc.accountId}
                      </span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-600 dark:text-slate-300 truncate max-w-[200px]">
                        {acc.firm.name} ({acc.firm.model})
                      </span>
                      {!validation.isCompleteForSimulation && (
                        <>
                          <span className="text-slate-400">·</span>
                          <span className="font-medium text-amber-600 dark:text-amber-400">
                            Contrato incompleto
                          </span>
                        </>
                      )}
                    </div>
                    {accounts.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveAccount(acc.accountId)}
                        aria-label={`Remover conta ${acc.accountId}`}
                        className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-rose-600 dark:hover:bg-slate-800 dark:hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                    <label className="col-span-2 sm:col-span-2 space-y-1">
                      <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        Mesa / Plano
                      </span>
                      <select
                        value={acc.firmPresetId}
                        onChange={(e) =>
                          handleUpdateAccount(acc.accountId, { firmPresetId: e.target.value })
                        }
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      >
                        {firms.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name} — {preset.model}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1">
                      <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        Fase Inicial
                      </span>
                      <select
                        value={acc.phase}
                        onChange={(e) =>
                          handleUpdateAccount(acc.accountId, {
                            phase: e.target.value as ContractualPayoffPhase,
                          })
                        }
                        className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      >
                        {(Object.keys(PHASE_LABELS) as ContractualPayoffPhase[]).map((phase) => (
                          <option key={phase} value={phase}>
                            {PHASE_LABELS[phase]}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1">
                      <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        Lucro Acum. ($)
                      </span>
                      <input
                        type="number"
                        step="100"
                        value={acc.cumulativeProfitUsd}
                        onChange={(e) =>
                          handleUpdateAccount(acc.accountId, {
                            cumulativeProfitUsd: Number(e.target.value) || 0,
                          })
                        }
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      />
                    </label>

                    <label className="space-y-1">
                      <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        Hedge Ratio (×)
                      </span>
                      <input
                        type="number"
                        min="0"
                        max="5"
                        step="0.1"
                        value={acc.hedgeRatio}
                        onChange={(e) =>
                          handleUpdateAccount(acc.accountId, {
                            hedgeRatio: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      />
                    </label>

                    <label className="space-y-1">
                      <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        Stop Perda ($)
                      </span>
                      <input
                        type="number"
                        min="100"
                        step="100"
                        value={acc.maxLossUsd}
                        onChange={(e) =>
                          handleUpdateAccount(acc.accountId, {
                            maxLossUsd: Math.max(100, Number(e.target.value) || 100),
                          })
                        }
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      />
                    </label>

                    <label className="space-y-1">
                      <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        Dias Prévios
                      </span>
                      <input
                        type="number"
                        min="0"
                        max="60"
                        step="1"
                        value={acc.priorTradingDays}
                        onChange={(e) =>
                          handleUpdateAccount(acc.accountId, {
                            priorTradingDays: Math.max(0, Math.round(Number(e.target.value) || 0)),
                          })
                        }
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      />
                    </label>

                    <label className="space-y-1">
                      <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        Taxas Iniciais ($)
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="10"
                        value={acc.upfrontCashCommitmentUsd}
                        onChange={(e) =>
                          handleUpdateAccount(acc.accountId, {
                            upfrontCashCommitmentUsd: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      />
                    </label>

                    <label className="space-y-1">
                      <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        Máx. Unidades
                      </span>
                      <input
                        type="number"
                        min="1"
                        max="4"
                        step="1"
                        value={acc.maxUnits}
                        onChange={(e) =>
                          handleUpdateAccount(acc.accountId, {
                            maxUnits: Math.max(1, Math.min(4, Math.round(Number(e.target.value) || 1))),
                          })
                        }
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Phase 1 Joint Scenario Matrix Editor */}
        <div className="xl:col-span-7 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                2. Matriz de Cenários Conjuntos (Fase 1)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Probabilidades explícitas de eventos conjuntos — correlações de cauda não são assumidas independentes.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`font-mono text-xs tabular-nums font-medium ${
                  Math.abs(probabilitySum - 1) <= 1e-4
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-rose-600 dark:text-rose-400'
                }`}
              >
                Soma: {(probabilitySum * 100).toFixed(1)}%
              </span>
              {Math.abs(probabilitySum - 1) > 1e-4 && (
                <button
                  type="button"
                  onClick={handleNormalizeProbabilities}
                  className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 whitespace-nowrap shrink-0 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300"
                >
                  Normalizar 100%
                </button>
              )}
              <button
                type="button"
                onClick={handleAddScenario}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <Plus className="h-3.5 w-3.5" />
                Cenário
              </button>
            </div>
          </div>

          {!matrixValidation.isValid && (
            <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-0.5">
                <p className="font-semibold">Validação Fail-Closed da Matriz Conjunta</p>
                <p>{matrixValidation.errors.join(' ')}</p>
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="py-2 pr-3 font-medium">Cenário / Evento</th>
                  <th className="py-2 px-2 font-medium text-right">Prob.</th>
                  {resolvedAccounts.map((acc) => (
                    <th key={acc.accountId} className="py-2 px-2 font-medium">
                      {acc.accountId} (P&amp;L · Status · Caixa)
                    </th>
                  ))}
                  <th className="py-2 pl-2 font-medium text-right">Ação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {scenarios.map((scenario) => (
                  <tr
                    key={scenario.scenarioId}
                    className="align-top transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-900/40"
                  >
                    <td className="py-2.5 pr-3">
                      <input
                        type="text"
                        value={scenario.scenarioId}
                        onChange={(e) =>
                          handleUpdateScenario(scenario.scenarioId, {
                            scenarioId: e.target.value,
                          })
                        }
                        className="mb-1 w-36 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px] font-medium text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      />
                      <input
                        type="text"
                        value={scenario.marketEvent}
                        onChange={(e) =>
                          handleUpdateScenario(scenario.scenarioId, {
                            marketEvent: e.target.value,
                          })
                        }
                        className="block w-44 rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] text-slate-500 hover:border-slate-200 focus:border-emerald-500 focus:bg-white focus:outline-none dark:text-slate-400 dark:hover:border-slate-700 dark:focus:bg-slate-900"
                      />
                    </td>

                    <td className="py-2.5 px-2 text-right">
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        value={scenario.probability}
                        onChange={(e) =>
                          handleUpdateScenario(scenario.scenarioId, {
                            probability: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                        className="w-16 rounded border border-slate-300 bg-white px-2 py-1 text-right font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      />
                    </td>

                    {resolvedAccounts.map((acc) => {
                      const outcome = scenario.outcomes[acc.accountId] ?? {
                        grossPnlUsd: 0,
                        accountStatus: 'active' as JointAccountStatus,
                        payoutStatus: 'not_eligible' as JointPayoutStatus,
                        cashOutflowUsd: 0,
                        realizedCashInflowUsd: 0,
                        realizedPayoutUsd: 0,
                      };
                      return (
                        <td key={acc.accountId} className="py-2.5 px-2">
                          <div className="space-y-1.5 min-w-[165px]">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="number"
                                step="50"
                                value={outcome.grossPnlUsd}
                                onChange={(e) =>
                                  handleUpdateScenarioOutcome(scenario.scenarioId, acc.accountId, {
                                    grossPnlUsd: Number(e.target.value) || 0,
                                  })
                                }
                                title="P&L Bruto ($)"
                                className={`w-20 rounded border border-slate-300 bg-white px-1.5 py-1 text-right font-mono text-xs tabular-nums focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 ${
                                  outcome.grossPnlUsd > 0
                                    ? 'text-emerald-700 dark:text-emerald-400'
                                    : outcome.grossPnlUsd < 0
                                    ? 'text-rose-600 dark:text-rose-400'
                                    : 'text-slate-700 dark:text-slate-200'
                                }`}
                              />
                              <select
                                value={outcome.accountStatus}
                                onChange={(e) =>
                                  handleUpdateScenarioOutcome(scenario.scenarioId, acc.accountId, {
                                    accountStatus: e.target.value as JointAccountStatus,
                                  })
                                }
                                title="Status da Conta"
                                className="flex-1 rounded border border-slate-300 bg-white px-1.5 py-1 text-[11px] text-slate-700 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                              >
                                {(Object.keys(ACCOUNT_STATUS_LABELS) as JointAccountStatus[]).map((st) => (
                                  <option key={st} value={st}>
                                    {ACCOUNT_STATUS_LABELS[st]}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <select
                                value={outcome.payoutStatus}
                                onChange={(e) =>
                                  handleUpdateScenarioOutcome(scenario.scenarioId, acc.accountId, {
                                    payoutStatus: e.target.value as JointPayoutStatus,
                                  })
                                }
                                title="Status de Saque no Cenário"
                                className="w-24 rounded border border-slate-200 bg-slate-50 px-1 py-0.5 text-[11px] text-slate-600 focus:border-emerald-500 focus:outline-none dark:border-slate-700/80 dark:bg-slate-950 dark:text-slate-300"
                              >
                                {(Object.keys(PAYOUT_STATUS_LABELS) as JointPayoutStatus[]).map((ps) => (
                                  <option key={ps} value={ps}>
                                    {PAYOUT_STATUS_LABELS[ps]}
                                  </option>
                                ))}
                              </select>
                              <input
                                type="number"
                                min="0"
                                step="25"
                                value={outcome.cashOutflowUsd}
                                onChange={(e) =>
                                  handleUpdateScenarioOutcome(scenario.scenarioId, acc.accountId, {
                                    cashOutflowUsd: Math.max(0, Number(e.target.value) || 0),
                                  })
                                }
                                title="Saída de Caixa Explícita ($)"
                                placeholder="Saída $"
                                className="w-16 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-right font-mono text-[11px] tabular-nums text-slate-600 focus:border-emerald-500 focus:outline-none dark:border-slate-700/80 dark:bg-slate-950 dark:text-slate-300"
                              />
                              <input
                                type="number"
                                min="0"
                                step="25"
                                value={outcome.realizedCashInflowUsd}
                                onChange={(e) =>
                                  handleUpdateScenarioOutcome(scenario.scenarioId, acc.accountId, {
                                    realizedCashInflowUsd: Math.max(0, Number(e.target.value) || 0),
                                  })
                                }
                                title="Entrada Realizada em Caixa ($)"
                                placeholder="Entrada $"
                                className="w-16 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-right font-mono text-[11px] tabular-nums text-emerald-700 focus:border-emerald-500 focus:outline-none dark:border-slate-700/80 dark:bg-slate-950 dark:text-emerald-400"
                              />
                            </div>
                          </div>
                        </td>
                      );
                    })}

                    <td className="py-2.5 pl-2 text-right">
                      {scenarios.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveScenario(scenario.scenarioId)}
                          aria-label={`Remover cenário ${scenario.scenarioId}`}
                          className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-rose-600 dark:hover:bg-slate-800 dark:hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-slate-500 dark:text-slate-400">
            Campos por conta: linha 1 = P&amp;L bruto ($) e status da conta; linha 2 = status contratual de saque, saída de caixa explícita ($) e entrada realizada em caixa ($).
          </p>
        </div>
      </section>

      {/* Segmented Analysis Navigation */}
      <nav
        aria-label="Análises do Portfólio Multi-Mesa"
        className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-100/80 p-1.5 dark:border-slate-800 dark:bg-[#0D1320]"
      >
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 min-w-[180px] rounded-lg px-4 py-2 text-left transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-emerald-500 ${
                active
                  ? 'bg-white text-slate-950 shadow-xs dark:bg-slate-800 dark:text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              <div className="text-xs font-semibold">{tab.label}</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">{tab.subtitle}</div>
            </button>
          );
        })}
      </nav>

      {/* TAB 1: Unified Simulation & Path-Dependent Lifecycle Monte Carlo (Phases 1, 2, 9, 10, 11) */}
      {activeTab === 'simulation' && (
        <div className="space-y-6">
          {/* Controls Strip */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Iterações MC
                </span>
                <select
                  value={iterations}
                  onChange={(e) => setIterations(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  {[200, 400, 800, 1500].map((val) => (
                    <option key={val} value={val}>
                      {val} trajetórias
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Horizonte (Dias)
                </span>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={horizonPeriods}
                  onChange={(e) =>
                    setHorizonPeriods(Math.max(1, Math.min(60, Math.round(Number(e.target.value) || 1))))
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Caixa Disponível ($)
                </span>
                <input
                  type="number"
                  min="0"
                  step="100"
                  value={availableCashUsd}
                  onChange={(e) => setAvailableCashUsd(Math.max(0, Number(e.target.value) || 0))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Stop Portfólio ($)
                </span>
                <input
                  type="number"
                  min="0"
                  step="250"
                  value={maxPortfolioLossUsd}
                  onChange={(e) => setMaxPortfolioLossUsd(Math.max(0, Number(e.target.value) || 0))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Mín. Contas Ativas
                </span>
                <input
                  type="number"
                  min="1"
                  max={Math.max(1, resolvedAccounts.length)}
                  value={effectiveMinActiveAccounts}
                  onChange={(e) =>
                    setMinimumActiveAccounts(
                      Math.max(1, Math.min(resolvedAccounts.length, Math.round(Number(e.target.value) || 1)))
                    )
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              <div className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Semente Determinística
                </span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    value={seed}
                    onChange={(e) => setSeed(Math.trunc(Number(e.target.value) || 1))}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                  <button
                    type="button"
                    onClick={() => setSeed((prev) => prev + 17)}
                    title="Sortear nova semente"
                    className="rounded-lg border border-slate-300 p-2 text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    <Dices className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {phase11Result.error ? (
            <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1">
                <p className="font-semibold">Motor de Ciclo de Vida Contratual (Fases 10–11) bloqueado em Fail-Closed</p>
                <p>{phase11Result.error}</p>
              </div>
            </div>
          ) : phase11Result.data ? (
            <>
              {/* 4 KPI Summary Strip */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Sobrevivência do Portfólio (Fase 11)
                  </p>
                  <p className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-slate-950 dark:text-white">
                    {formatPct(phase11Result.data.portfolioSurvivalProbability)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Média de {phase11Result.data.averagePeriodsSimulated.toFixed(1)}/{horizonPeriods} dias · Stop:{' '}
                    {formatPct(phase11Result.data.portfolioStopProbability)}
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Capital Externo Exigido (P95)
                  </p>
                  <p className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-slate-950 dark:text-white">
                    {formatUsd(phase11Result.data.externalCapitalRequiredP95Usd)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Mediana P50: {formatUsd(phase11Result.data.externalCapitalRequiredP50Usd)} · Máx:{' '}
                    {formatUsd(phase11Result.data.maximumExternalCapitalRequiredUsd)}
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Caixa Final Mediano (P50)
                  </p>
                  <p
                    className={`mt-1.5 font-mono text-2xl font-bold tabular-nums ${
                      phase11Result.data.endingCashBalanceP50Usd >= availableCashUsd
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {formatUsd(phase11Result.data.endingCashBalanceP50Usd)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    P05: {formatUsd(phase11Result.data.endingCashBalanceP05Usd)} · P95:{' '}
                    {formatUsd(phase11Result.data.endingCashBalanceP95Usd)}
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Payout Contratual Potencial (Não Realizado)
                  </p>
                  <p className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {formatUsd(phase11Result.data.expectedContractualPayoutOpportunityUsd)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Oportunidade: {formatPct(phase11Result.data.payoutOpportunityProbability)} · Realizado:{' '}
                    {formatUsd(phase11Result.data.expectedRealizedPayoutUsd)}
                  </p>
                </div>
              </div>

              {/* Survival Breakdown + Failure Attribution + Phase 9 Cross-check */}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
                <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Sobrevivência por Conta e Atribuição de Falhas (Fases 10 &amp; 11)
                    </h3>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      Seed {phase11Result.data.seedUsed} · {phase11Result.data.iterations} rodadas
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                          <th className="py-2 pr-3 font-medium">Conta</th>
                          <th className="py-2 px-3 font-medium">Mesa</th>
                          <th className="py-2 px-3 font-medium text-right">Sobrevivência (F11)</th>
                          <th className="py-2 pl-3 font-medium text-right">Sobrevivência (F9)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                        {resolvedAccounts.map((acc) => {
                          const f11Surv = phase11Result.data!.accountSurvivalProbability[acc.accountId] ?? 0;
                          const f9Surv = phase9Result.data?.accountSurvivalProbability[acc.accountId] ?? null;
                          return (
                            <tr key={acc.accountId}>
                              <td className="py-2.5 pr-3 font-mono font-semibold text-slate-900 dark:text-slate-100">
                                {acc.accountId}
                              </td>
                              <td className="py-2.5 px-3 text-slate-600 dark:text-slate-300">
                                {acc.firm.name} · {PHASE_LABELS[acc.phase]}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono tabular-nums font-medium text-slate-900 dark:text-white">
                                {formatPct(f11Surv)}
                              </td>
                              <td className="py-2.5 pl-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                                {f9Surv !== null ? formatPct(f9Surv) : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-200 pt-4 text-xs sm:grid-cols-5 dark:border-slate-800">
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Rupturas DD</p>
                      <p className="font-mono font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                        {phase11Result.data.failureAttribution.accountBreaches}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Restrições</p>
                      <p className="font-mono font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                        {phase11Result.data.failureAttribution.accountRestrictions}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Encerramentos</p>
                      <p className="font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                        {phase11Result.data.failureAttribution.accountTerminations}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Stop Portfólio</p>
                      <p className="font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                        {phase11Result.data.failureAttribution.portfolioLossLimitStops}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Mín. Contas</p>
                      <p className="font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                        {phase11Result.data.failureAttribution.minimumActiveAccountStops}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Phase 2 Nonlinear Contractual Payoff Summary */}
                <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
                  <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Payoff Contratual Não Linear por Cenário (Fase 2)
                  </h3>
                  <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                    Aplica buffer, teto de saque, consistência e profit split de cada mesa — sem confundir com caixa realizado.
                  </p>

                  {phase2Results.data ? (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                            <th className="py-2 pr-2 font-medium">Cenário</th>
                            <th className="py-2 px-2 font-medium text-right">P&amp;L Bruto</th>
                            <th className="py-2 px-2 font-medium text-right">Payout Potencial</th>
                            <th className="py-2 pl-2 font-medium text-right">Elegíveis</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                          {phase2Results.data.map(({ summary, probability }) => (
                            <tr key={summary.scenarioId}>
                              <td className="py-2 pr-2 font-mono text-[11px] text-slate-900 dark:text-slate-100">
                                {summary.scenarioId}{' '}
                                <span className="text-slate-400">({(probability * 100).toFixed(0)}%)</span>
                              </td>
                              <td
                                className={`py-2 px-2 text-right font-mono tabular-nums ${
                                  summary.totalGrossPnlUsd >= 0
                                    ? 'text-emerald-700 dark:text-emerald-400'
                                    : 'text-rose-600 dark:text-rose-400'
                                }`}
                              >
                                {formatUsd(summary.totalGrossPnlUsd)}
                              </td>
                              <td className="py-2 px-2 text-right font-mono tabular-nums font-medium text-slate-900 dark:text-white">
                                {formatUsd(summary.totalPotentialTraderPayoutUsd)}
                              </td>
                              <td className="py-2 pl-2 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                                {summary.accountsContractuallyPayoutEligible}/{resolvedAccounts.length}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-xs text-amber-700 dark:text-amber-400">{phase2Results.error}</p>
                  )}
                </div>
              </div>

              {/* Auditable Sample Paths (Phase 11) */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Trajetórias Auditáveis (Amostra Determinística · Fase 11)
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Cada linha reproduz o ciclo de vida contratual completo dia a dia (HWM, drawdown floor e livro-caixa).
                    </p>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                        <th className="py-2 pr-3 font-medium">Rodada</th>
                        <th className="py-2 px-3 font-medium">Resultado</th>
                        <th className="py-2 px-3 font-medium text-right">Dias</th>
                        <th className="py-2 px-3 font-medium text-right">P&amp;L Trading</th>
                        <th className="py-2 px-3 font-medium text-right">Payout Potencial</th>
                        <th className="py-2 px-3 font-medium text-right">Caixa Mín.</th>
                        <th className="py-2 px-3 font-medium text-right">Cap. Externo</th>
                        <th className="py-2 pl-3 font-medium text-right">Caixa Final</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                      {phase11Result.data.samplePaths.map((path) => (
                        <tr key={path.iteration} className="hover:bg-slate-50/70 dark:hover:bg-slate-900/40">
                          <td className="py-2 pr-3 font-mono tabular-nums text-slate-600 dark:text-slate-300">
                            #{path.iteration + 1}
                          </td>
                          <td className="py-2 px-3">
                            <span
                              className={`font-medium ${
                                path.portfolioSurvived
                                  ? 'text-emerald-700 dark:text-emerald-400'
                                  : 'text-rose-600 dark:text-rose-400'
                              }`}
                            >
                              {path.portfolioSurvived
                                ? 'Sobreviveu'
                                : path.portfolioStopReason === 'portfolio_loss_limit'
                                ? 'Stop Portfólio'
                                : 'Stop Contas Ativas'}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                            {path.periodsSimulated}
                          </td>
                          <td
                            className={`py-2 px-3 text-right font-mono tabular-nums ${
                              path.grossTradingPnlUsd >= 0
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : 'text-rose-600 dark:text-rose-400'
                            }`}
                          >
                            {formatUsd(path.grossTradingPnlUsd)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100">
                            {formatUsd(path.contractualPayoutOpportunityUsd)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                            {formatUsd(path.minimumCashBalanceUsd)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-amber-700 dark:text-amber-400">
                            {formatUsd(path.externalCapitalRequiredUsd)}
                          </td>
                          <td className="py-2 pl-3 text-right font-mono tabular-nums font-medium text-slate-950 dark:text-white">
                            {formatUsd(path.endingCashBalanceUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}
        </div>
      )}

      {/* TAB 2: Survival & External Capital Liquidity (Phases 3 & 5) */}
      {activeTab === 'survival_liquidity' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Reserva Mínima de Caixa ($)
                </span>
                <input
                  type="number"
                  min="0"
                  step="50"
                  value={minimumReserveUsd}
                  onChange={(e) => setMinimumReserveUsd(Math.max(0, Number(e.target.value) || 0))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Confiança VaR / CVaR Liquidez (%)
                </span>
                <input
                  type="number"
                  min="50"
                  max="99"
                  step="1"
                  value={confidenceLevelPct}
                  onChange={(e) =>
                    setConfidenceLevelPct(Math.max(50, Math.min(99, Number(e.target.value) || 90)))
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Orçamento de Capital Externo ($)
                </span>
                <input
                  type="number"
                  min="0"
                  step="100"
                  value={externalFundingBudgetUsd}
                  onChange={(e) =>
                    setExternalFundingBudgetUsd(Math.max(0, Number(e.target.value) || 0))
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>
            </div>
          </div>

          {(phase3Result.error || phase5Result.error) && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200">
              {phase3Result.error ?? phase5Result.error}
            </div>
          )}

          {phase3Result.data && phase5Result.data && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Sobrevivência Multi-Período (Fase 3)
                  </p>
                  <p className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-slate-950 dark:text-white">
                    {formatPct(phase3Result.data.portfolioSurvivalProbability)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    IC 95%: {formatPct(phase3Result.data.survivalConfidenceInterval95.lower)} –{' '}
                    {formatPct(phase3Result.data.survivalConfidenceInterval95.upper)}
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Tempo Médio até 1ª Falha
                  </p>
                  <p className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-slate-950 dark:text-white">
                    {phase3Result.data.meanTimeToFirstAccountFailure !== null
                      ? `${phase3Result.data.meanTimeToFirstAccountFailure.toFixed(1)} dias`
                      : 'Sem falhas'}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    P&amp;L Terminal Mediano: {formatUsd(phase3Result.data.terminalPortfolioPnlP50Usd)}
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Capital Externo Recomendado (VaR {confidenceLevelPct}%)
                  </p>
                  <p className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-slate-950 dark:text-white">
                    {formatUsd(phase5Result.data.recommendedExternalCapitalUsd)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Status:{' '}
                    <span
                      className={
                        phase5Result.data.status === 'feasible'
                          ? 'font-medium text-emerald-700 dark:text-emerald-400'
                          : 'font-medium text-amber-700 dark:text-amber-400'
                      }
                    >
                      {phase5Result.data.status === 'feasible' ? 'Caixa Suficiente' : 'Exige Aporte Externo'}
                    </span>
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    CVaR de Liquidez (Cauda {100 - confidenceLevelPct}%)
                  </p>
                  <p className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-400">
                    {formatUsd(phase5Result.data.conditionalTailMeanFundingRequirementUsd)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Cobertura do Orçamento:{' '}
                    {phase5Result.data.probabilityFundingBudgetIsSufficient !== null
                      ? formatPct(phase5Result.data.probabilityFundingBudgetIsSufficient)
                      : '—'}{' '}
                    · Gap Máx: {formatUsd(phase5Result.data.maximumFundingGapUsd)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
                {/* Pairwise Contagion Matrix (Phase 3) */}
                <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
                  <div className="mb-3 flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Matriz de Contágio e Falhas Pareadas (Fase 3)
                    </h3>
                  </div>

                  {phase3Result.data.pairwiseFailures.length === 0 ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Adicione pelo menos 2 contas no portfólio para medir correlação de falhas pareadas.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                            <th className="py-2 pr-2 font-medium">Par</th>
                            <th className="py-2 px-2 font-medium text-right">P(A ∩ B)</th>
                            <th className="py-2 px-2 font-medium text-right">P(A | B)</th>
                            <th className="py-2 pl-2 font-medium text-right">P(B | A)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                          {phase3Result.data.pairwiseFailures.map((pair) => (
                            <tr key={`${pair.accountA}-${pair.accountB}`}>
                              <td className="py-2 pr-2 font-mono font-medium text-slate-900 dark:text-slate-100">
                                {pair.accountA} × {pair.accountB}
                              </td>
                              <td className="py-2 px-2 text-right font-mono tabular-nums text-rose-600 dark:text-rose-400">
                                {formatPct(pair.jointFailureProbability)}
                              </td>
                              <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                                {pair.conditionalFailureProbabilityA_given_B !== null
                                  ? formatPct(pair.conditionalFailureProbabilityA_given_B)
                                  : '—'}
                              </td>
                              <td className="py-2 pl-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                                {pair.conditionalFailureProbabilityB_given_A !== null
                                  ? formatPct(pair.conditionalFailureProbabilityB_given_A)
                                  : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Pathwise External Funding Table (Phase 5) */}
                <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
                  <h3 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Déficit de Pico e Exigência de Capital Externo por Cenário (Fase 5)
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] border-collapse text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                          <th className="py-2 pr-2 font-medium">Cenário</th>
                          <th className="py-2 px-2 font-medium text-right">Déficit Pico</th>
                          <th className="py-2 px-2 font-medium text-right">Cap. Inicial Req.</th>
                          <th className="py-2 px-2 font-medium text-right">Cap. Externo</th>
                          <th className="py-2 px-2 font-medium text-right">Caixa Mín.</th>
                          <th className="py-2 pl-2 font-medium text-right">Sobrevive Caixa</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                        {phase5Result.data.scenarios.map((row) => (
                          <tr key={row.scenarioId}>
                            <td className="py-2 pr-2 font-mono text-[11px] text-slate-900 dark:text-slate-100">
                              {row.scenarioId}{' '}
                              <span className="text-slate-400">({(row.probability * 100).toFixed(0)}%)</span>
                            </td>
                            <td className="py-2 px-2 text-right font-mono tabular-nums text-rose-600 dark:text-rose-400">
                              {formatUsd(row.peakCumulativeCashDeficitUsd)}
                            </td>
                            <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                              {formatUsd(row.requiredStartingCapitalUsd)}
                            </td>
                            <td className="py-2 px-2 text-right font-mono tabular-nums font-medium text-amber-700 dark:text-amber-400">
                              {formatUsd(row.externalCapitalRequiredUsd)}
                            </td>
                            <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                              {formatUsd(row.minimumCashBalanceUsd)}
                            </td>
                            <td className="py-2 pl-2 text-right font-medium">
                              <span
                                className={
                                  row.survivesWithAvailableCapital
                                    ? 'text-emerald-700 dark:text-emerald-400'
                                    : 'text-rose-600 dark:text-rose-400'
                                }
                              >
                                {row.survivesWithAvailableCapital ? 'Sim' : 'Déficit'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB 3: Contract-Aware Hedge Ratio & Contractual Payoff Optimization (Phases 7 & 8) */}
      {activeTab === 'optimization' && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {/* Phase 8: Contract-Aware Hedge Ratio Optimization */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-5 dark:border-slate-800 dark:bg-[#0F1624]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Otimizador de Hedge Ratios Ciente de Contrato (Fase 8)
                  </h3>
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Busca exaustiva na grade discreta de multiplicadores por conta sobre a matriz conjunta.
                </p>
              </div>
              {phase8Result.data?.status === 'optimal' && (
                <button
                  type="button"
                  onClick={handleApplyOptimalHedgeRatios}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 whitespace-nowrap shrink-0"
                >
                  Aplicar Ratios
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Prob. Máx. Perda Combinada (%)
                </span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="5"
                  value={maxProbCombinedLossPct}
                  onChange={(e) =>
                    setMaxProbCombinedLossPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Perda Máx. Pior Caso ($)
                </span>
                <input
                  type="number"
                  min="0"
                  step="100"
                  value={maxWorstCaseLossUsd}
                  onChange={(e) => setMaxWorstCaseLossUsd(Math.max(0, Number(e.target.value) || 0))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>
            </div>

            {/* Per-account ratio grid bounds */}
            <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
              <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                Grade de Busca por Conta (Mín · Máx · Passo)
              </p>
              {accounts.map((acc) => (
                <div key={acc.accountId} className="grid grid-cols-4 items-center gap-2 text-xs">
                  <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                    {acc.accountId}
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.25"
                    value={acc.ratioMin}
                    onChange={(e) =>
                      handleUpdateAccount(acc.accountId, {
                        ratioMin: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                    title="Ratio Mínimo"
                    className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs tabular-nums dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.25"
                    value={acc.ratioMax}
                    onChange={(e) =>
                      handleUpdateAccount(acc.accountId, {
                        ratioMax: Math.max(acc.ratioMin, Number(e.target.value) || acc.ratioMin),
                      })
                    }
                    title="Ratio Máximo"
                    className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs tabular-nums dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                  <input
                    type="number"
                    min="0.1"
                    step="0.25"
                    value={acc.ratioStep}
                    onChange={(e) =>
                      handleUpdateAccount(acc.accountId, {
                        ratioStep: Math.max(0.1, Number(e.target.value) || 0.5),
                      })
                    }
                    title="Passo da Grade"
                    className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs tabular-nums dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </div>
              ))}
            </div>

            {phase8Result.error ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200">
                {phase8Result.error}
              </div>
            ) : phase8Result.data ? (
              phase8Result.data.status === 'optimal' && phase8Result.data.metrics ? (
                <div className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800">
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Payout Contratual Esperado</p>
                      <p className="font-mono text-base font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                        {formatUsd(phase8Result.data.metrics.expectedContractualTraderPayoutUsd)}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">P&amp;L Bruto Combinado</p>
                      <p className="font-mono text-base font-bold tabular-nums text-slate-950 dark:text-white">
                        {formatUsd(phase8Result.data.metrics.expectedCombinedGrossPnlUsd)}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Prob. Perda Combinada</p>
                      <p className="font-mono text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                        {formatPct(phase8Result.data.metrics.probabilityOfCombinedLoss)}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Pior Perda Combinada</p>
                      <p className="font-mono text-sm font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                        {formatUsd(phase8Result.data.metrics.worstCaseCombinedLossUsd)}
                      </p>
                    </div>
                  </div>

                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                        <th className="py-1.5 font-medium">Conta</th>
                        <th className="py-1.5 font-medium">Mesa</th>
                        <th className="py-1.5 font-medium text-right">Ratio Ótimo</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                      {phase8Result.data.allocation.map((line) => (
                        <tr key={line.accountId}>
                          <td className="py-2 font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {line.accountId}
                          </td>
                          <td className="py-2 text-slate-600 dark:text-slate-300">{line.firmName}</td>
                          <td className="py-2 text-right font-mono font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                            {formatFactor(line.ratio)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Avaliados {phase8Result.data.searchNodes} vetores · {phase8Result.data.feasibleCandidates} viáveis.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
                  <p className="font-semibold">Inviável sob as restrições atuais</p>
                  <p className="mt-1">{phase8Result.data.reason}</p>
                </div>
              )
            ) : null}
          </div>

          {/* Phase 7: Contractual Payoff Allocation Optimization */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-5 dark:border-slate-800 dark:bg-[#0F1624]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Seleção Ótima de Contratos de Mesa (Fase 7)
                  </h3>
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Compara alternativas do catálogo sob a mesma matriz conjunta, respeitando diversificação e completude contratual.
                </p>
              </div>
              {phase7Result.data?.status === 'optimal' && (
                <button
                  type="button"
                  onClick={handleApplyOptimalContracts}
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0 dark:bg-emerald-600 dark:hover:bg-emerald-500"
                >
                  Aplicar Contratos
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Mín. Mesas Distintas
                </span>
                <input
                  type="number"
                  min="1"
                  max={Math.max(1, resolvedAccounts.length)}
                  value={Math.min(minDistinctFirmsOpt, resolvedAccounts.length)}
                  onChange={(e) =>
                    setMinDistinctFirmsOpt(Math.max(1, Math.round(Number(e.target.value) || 1)))
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Máx. Contas / Mesa
                </span>
                <input
                  type="number"
                  min="1"
                  max="4"
                  value={maxAccountsPerFirmOpt}
                  onChange={(e) =>
                    setMaxAccountsPerFirmOpt(Math.max(1, Math.round(Number(e.target.value) || 1)))
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              <div className="flex items-end pb-1">
                <button
                  type="button"
                  onClick={() => setRequireCompleteContracts((v) => !v)}
                  className={`w-full rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    requireCompleteContracts
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-800 dark:border-emerald-500/70 dark:bg-emerald-950/50 dark:text-emerald-300'
                      : 'border-slate-300 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
                  }`}
                >
                  Fail-Closed: {requireCompleteContracts ? 'Ativo' : 'Flexível'}
                </button>
              </div>
            </div>

            {phase7Result.error ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200">
                {phase7Result.error}
              </div>
            ) : phase7Result.data ? (
              phase7Result.data.status === 'optimal' ? (
                <div className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800">
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Payout Esperado</p>
                      <p className="font-mono text-base font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                        {formatUsd(phase7Result.data.expectedContractualTraderPayoutUsd ?? 0)}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Oport. Saque</p>
                      <p className="font-mono text-base font-bold tabular-nums text-slate-950 dark:text-white">
                        {formatPct(phase7Result.data.payoutOpportunityProbability ?? 0)}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500 dark:text-slate-400">Mesas Distintas</p>
                      <p className="font-mono text-base font-bold tabular-nums text-slate-950 dark:text-white">
                        {phase7Result.data.distinctFirmCount ?? 0}
                      </p>
                    </div>
                  </div>

                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                        <th className="py-1.5 font-medium">Conta</th>
                        <th className="py-1.5 font-medium">Contrato Selecionado</th>
                        <th className="py-1.5 font-medium text-right">Completude</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                      {phase7Result.data.allocation.map((line) => {
                        const diag = phase7Result.data!.alternativeDiagnostics.find(
                          (d) =>
                            d.accountId === line.accountId && d.alternativeId === line.alternativeId
                        );
                        return (
                          <tr key={line.accountId}>
                            <td className="py-2 font-mono font-semibold text-slate-900 dark:text-slate-100">
                              {line.accountId}
                            </td>
                            <td className="py-2 text-slate-700 dark:text-slate-200">
                              {line.firmName}{' '}
                              <span className="font-mono text-[11px] text-slate-400">
                                ({line.alternativeId})
                              </span>
                            </td>
                            <td className="py-2 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                              {diag ? formatPct(diag.contractCompletenessProbability, 0) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Combinações avaliadas: {phase7Result.data.searchNodes} · Completude conjunta:{' '}
                    {formatPct(phase7Result.data.contractCompletenessProbability ?? 0, 0)}.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
                  <p className="font-semibold">Nenhuma alocação contratual viável</p>
                  <p className="mt-1">{phase7Result.data.reason}</p>
                </div>
              )
            ) : null}
          </div>
        </div>
      )}

      {/* TAB 4: Multi-Firm Capital Allocation & Pareto Frontier (Phases 4 & 6) */}
      {activeTab === 'allocation_pareto' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#0F1624]">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Orçamento de Capital ($)
                </span>
                <input
                  type="number"
                  min="250"
                  step="250"
                  value={capitalBudgetUsd}
                  onChange={(e) => setCapitalBudgetUsd(Math.max(250, Number(e.target.value) || 250))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Máx. por Mesa (%)
                </span>
                <input
                  type="number"
                  min="20"
                  max="100"
                  step="5"
                  value={maxFirmSharePct}
                  onChange={(e) =>
                    setMaxFirmSharePct(Math.max(20, Math.min(100, Number(e.target.value) || 65)))
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Sobrevivência Mín. (%)
                </span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="5"
                  value={minSurvivalProbPct}
                  onChange={(e) =>
                    setMinSurvivalProbPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Aversão a Risco (λ CVaR)
                </span>
                <input
                  type="number"
                  min="0"
                  max="3"
                  step="0.05"
                  value={riskAversion}
                  onChange={(e) => setRiskAversion(Math.max(0, Number(e.target.value) || 0))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Custo de Oportunidade (%)
                </span>
                <input
                  type="number"
                  min="0"
                  max="30"
                  step="0.5"
                  value={capitalCostRatePct}
                  onChange={(e) => setCapitalCostRatePct(Math.max(0, Number(e.target.value) || 0))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>
            </div>
          </div>

          {phase4And6Results.error ? (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200">
              {phase4And6Results.error}
            </div>
          ) : phase4And6Results.data ? (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              {/* Phase 4 Integer Capital Allocation */}
              <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-4 dark:border-slate-800 dark:bg-[#0F1624]">
                <div className="flex items-center gap-2">
                  <Scale className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Alocação Inteira Multi-Mesa (Fase 4)
                  </h3>
                </div>

                {phase4And6Results.data.allocation.status === 'optimal' ? (
                  <>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <p className="text-slate-500 dark:text-slate-400">Capital Comprometido</p>
                        <p className="font-mono text-lg font-bold tabular-nums text-slate-950 dark:text-white">
                          {formatUsd(phase4And6Results.data.allocation.committedCapitalUsd)}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-500 dark:text-slate-400">P&amp;L Líquido Esperado</p>
                        <p
                          className={`font-mono text-lg font-bold tabular-nums ${
                            phase4And6Results.data.allocation.expectedNetPnlUsd >= 0
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {formatUsd(phase4And6Results.data.allocation.expectedNetPnlUsd)}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-500 dark:text-slate-400">CVaR Perda ({confidenceLevelPct}%)</p>
                        <p className="font-mono text-sm font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                          {formatUsd(phase4And6Results.data.allocation.conditionalValueAtRiskLossUsd)}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-500 dark:text-slate-400">Retorno s/ Capital</p>
                        <p className="font-mono text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                          {phase4And6Results.data.allocation.expectedNetReturnOnCapitalPct !== null
                            ? `${phase4And6Results.data.allocation.expectedNetReturnOnCapitalPct.toFixed(1)}%`
                            : '—'}
                        </p>
                      </div>
                    </div>

                    <table className="w-full border-collapse text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                          <th className="py-1.5 font-medium">Conta</th>
                          <th className="py-1.5 font-medium">Mesa</th>
                          <th className="py-1.5 font-medium text-right">Unidades</th>
                          <th className="py-1.5 font-medium text-right">Capital</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                        {phase4And6Results.data.allocation.allocation.map((line) => (
                          <tr key={line.candidateId}>
                            <td className="py-2 font-mono font-semibold text-slate-900 dark:text-slate-100">
                              {line.accountId}
                            </td>
                            <td className="py-2 text-slate-600 dark:text-slate-300">{line.firmId}</td>
                            <td className="py-2 text-right font-mono font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                              {line.units}×
                            </td>
                            <td className="py-2 text-right font-mono tabular-nums text-slate-900 dark:text-white">
                              {formatUsd(line.committedCapitalUsd)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Sobrevivência conjunta: {formatPct(phase4And6Results.data.allocation.portfolioSurvivalProbability)} ·
                      Caixa livre: {formatUsd(phase4And6Results.data.allocation.unusedCapitalUsd)} · Nós:{' '}
                      {phase4And6Results.data.allocation.searchNodes}.
                    </p>
                  </>
                ) : (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
                    Nenhuma combinação inteira satisfaz simultaneamente o orçamento, concentração máxima por mesa e
                    sobrevivência mínima configurados.
                  </div>
                )}
              </div>

              {/* Phase 6 Pareto Frontier Visualization + Table */}
              <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-5 space-y-4 dark:border-slate-800 dark:bg-[#0F1624]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Fronteira de Pareto Multi-Objetivo (Fase 6)
                    </h3>
                  </div>
                  {phase4And6Results.data.pareto && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      Fronteira: {phase4And6Results.data.pareto.frontierCount} · Dominadas:{' '}
                      {phase4And6Results.data.pareto.dominated.length} · Inviáveis:{' '}
                      {phase4And6Results.data.pareto.infeasibleConfigurationCount}
                    </span>
                  )}
                </div>

                {paretoChartData && (
                  <div className="overflow-x-auto">
                    <svg
                      viewBox={`0 0 ${paretoChartData.width} ${paretoChartData.height}`}
                      className="h-auto w-full max-w-[680px]"
                      role="img"
                      aria-label="Gráfico de Fronteira de Pareto: Capital Externo versus Lucro Líquido Esperado"
                    >
                      {/* Gridlines */}
                      {paretoChartData.yTicks.map((tick, idx) => {
                        const y = paretoChartData.scaleY(tick);
                        return (
                          <g key={`y-${idx}`}>
                            <line
                              x1={paretoChartData.margin.left}
                              x2={paretoChartData.width - paretoChartData.margin.right}
                              y1={y}
                              y2={y}
                              className="stroke-slate-200 dark:stroke-slate-800"
                              strokeDasharray="3 3"
                            />
                            <text
                              x={paretoChartData.margin.left - 8}
                              y={y + 4}
                              textAnchor="end"
                              className="fill-slate-500 font-mono text-[10px] dark:fill-slate-400"
                            >
                              {formatUsd(tick)}
                            </text>
                          </g>
                        );
                      })}
                      {paretoChartData.xTicks.map((tick, idx) => {
                        const x = paretoChartData.scaleX(tick);
                        return (
                          <text
                            key={`x-${idx}`}
                            x={x}
                            y={paretoChartData.height - 12}
                            textAnchor="middle"
                            className="fill-slate-500 font-mono text-[10px] dark:fill-slate-400"
                          >
                            {formatUsd(tick)}
                          </text>
                        );
                      })}

                      {/* Pareto Frontier Polyline */}
                      {paretoChartData.frontierPoints.length > 1 && (
                        <polyline
                          fill="none"
                          stroke="#10b981"
                          strokeWidth="2"
                          points={paretoChartData.frontierPoints
                            .map(
                              (pt) =>
                                `${paretoChartData.scaleX(pt.configuration.externalCapitalRequiredUsd)},${paretoChartData.scaleY(pt.configuration.expectedNetProfitUsd)}`
                            )
                            .join(' ')}
                        />
                      )}

                      {/* Points */}
                      {paretoChartData.allItems.map((item) => {
                        const cx = paretoChartData.scaleX(item.configuration.externalCapitalRequiredUsd);
                        const cy = paretoChartData.scaleY(item.configuration.expectedNetProfitUsd);
                        const hovered = hoveredParetoId === item.configuration.configurationId;
                        const fill =
                          item.bucket === 'frontier'
                            ? '#10b981'
                            : item.bucket === 'dominated'
                            ? '#64748b'
                            : '#e11d48';
                        return (
                          <g
                            key={item.configuration.configurationId}
                            onMouseEnter={() => setHoveredParetoId(item.configuration.configurationId)}
                            onMouseLeave={() => setHoveredParetoId(null)}
                            className="cursor-pointer"
                          >
                            <circle
                              cx={cx}
                              cy={cy}
                              r={hovered ? 7 : 5}
                              fill={fill}
                              stroke="#ffffff"
                              strokeWidth="1.5"
                            />
                            <text
                              x={cx + 8}
                              y={cy - 6}
                              className="fill-slate-700 text-[10px] font-medium dark:fill-slate-300"
                            >
                              {item.configuration.configurationId.split(' ')[0]}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                )}

                {phase4And6Results.data.pareto && (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[540px] border-collapse text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                          <th className="py-2 pr-2 font-medium">Perfil</th>
                          <th className="py-2 px-2 font-medium">Classificação</th>
                          <th className="py-2 px-2 font-medium text-right">Cap. Externo</th>
                          <th className="py-2 px-2 font-medium text-right">Lucro Esp.</th>
                          <th className="py-2 px-2 font-medium text-right">CVaR Perda</th>
                          <th className="py-2 pl-2 font-medium text-right">Sobrev.</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                        {[
                          ...phase4And6Results.data.pareto.frontier,
                          ...phase4And6Results.data.pareto.dominated,
                          ...phase4And6Results.data.pareto.infeasible,
                        ].map((item) => {
                          const label = !item.feasible
                            ? 'Inviável'
                            : item.dominated
                            ? `Dominada (${item.dominatedBy.length})`
                            : 'Fronteira Ótima';
                          const colorClass = !item.feasible
                            ? 'text-rose-600 dark:text-rose-400'
                            : item.dominated
                            ? 'text-slate-500 dark:text-slate-400'
                            : 'text-emerald-700 dark:text-emerald-400 font-semibold';
                          return (
                            <tr
                              key={item.configuration.configurationId}
                              onMouseEnter={() =>
                                setHoveredParetoId(item.configuration.configurationId)
                              }
                              onMouseLeave={() => setHoveredParetoId(null)}
                              className={
                                hoveredParetoId === item.configuration.configurationId
                                  ? 'bg-slate-50 dark:bg-slate-900/60'
                                  : ''
                              }
                            >
                              <td className="py-2 pr-2 font-medium text-slate-900 dark:text-slate-100">
                                {item.configuration.configurationId}
                              </td>
                              <td className={`py-2 px-2 ${colorClass}`}>{label}</td>
                              <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                                {formatUsd(item.configuration.externalCapitalRequiredUsd)}
                              </td>
                              <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-900 dark:text-white">
                                {formatUsd(item.configuration.expectedNetProfitUsd)}
                              </td>
                              <td className="py-2 px-2 text-right font-mono tabular-nums text-amber-700 dark:text-amber-400">
                                {formatUsd(item.configuration.cvarLossUsd)}
                              </td>
                              <td className="py-2 pl-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                                {formatPct(item.configuration.portfolioSurvivalProbability)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
