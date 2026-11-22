import { useEffect, useMemo, useState } from 'react';
import { AiConsultantDrawer } from './components/AiConsultantDrawer';
import { ArbitrageModule } from './components/ArbitrageModule';
import { CapitalBonusModule } from './components/CapitalBonusModule';
import { ContextToolbar } from './components/ContextToolbar';
import { DailySimulationModule } from './components/DailySimulationModule';
import { Header } from './components/Header';
import { MonteCarloModule } from './components/MonteCarloModule';
import { PropFirmsModule } from './components/PropFirmsModule';
import { TradeSizingModule } from './components/TradeSizingModule';
import { DEFAULT_PROP_FIRMS_2026 } from './data/propFirms2026';
import {
  ArbitrageInputs,
  CapitalBonusInputs,
  ConsultIntent,
  DailyTradeEntry,
  FundedMethod101Inputs,
  MonteCarloSummary,
  PropFirmPreset,
  SavedSimulation,
  ThemeMode,
  TradeSizingInputs,
  WorkspaceSection,
} from './types/quant';
import { normalizePropFirmPreset, validateFirmContract } from './utils/contractual';
import {
  calculateArbitrage,
  calculateCapitalBonus,
  calculateFundedMethod101,
  calculateTradeSizing,
  generateApprovalTrajectory,
  generateRandomTrajectory,
  generateStopOutTrajectory,
  runDailySimulation,
} from './utils/quantEngine';

const STORAGE_KEYS = {
  theme: 'propquant_theme_v1',
  firms: 'propquant_firms_2026_v1',
  firmsCatalogVersion: 'propquant_firms_catalog_v2',
  simulations: 'propquant_simulations_v1',
};

const CURRENT_CATALOG_VERSION = '2026-nov-contractual-v3';

function loadStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function loadMergedFirms(): PropFirmPreset[] {
  const stored = loadStoredJson<Array<Partial<PropFirmPreset> & { id: string; name: string; model: string }> | null>(
    STORAGE_KEYS.firms,
    null
  );
  if (!stored || !Array.isArray(stored) || stored.length === 0) {
    window.localStorage.setItem(STORAGE_KEYS.firmsCatalogVersion, CURRENT_CATALOG_VERSION);
    return DEFAULT_PROP_FIRMS_2026;
  }

  const version = window.localStorage.getItem(STORAGE_KEYS.firmsCatalogVersion);
  if (version === CURRENT_CATALOG_VERSION) {
    return stored.map((item) => normalizePropFirmPreset(item));
  }

  // Upgrade catalog safely: preserve custom firms and user-assumed overrides while upgrading official presets
  const defaultsMap = new Map(DEFAULT_PROP_FIRMS_2026.map((f) => [f.id, f]));
  const migrated: PropFirmPreset[] = [];
  const seenIds = new Set<string>();

  for (const raw of stored) {
    const normalized = normalizePropFirmPreset(raw);
    seenIds.add(normalized.id);
    if (normalized.isCustom || normalized.verificationStatus === 'user_assumed') {
      migrated.push(normalized);
    } else {
      migrated.push(defaultsMap.get(normalized.id) ?? normalized);
    }
  }

  for (const def of DEFAULT_PROP_FIRMS_2026) {
    if (!seenIds.has(def.id)) {
      migrated.push(def);
    }
  }

  window.localStorage.setItem(STORAGE_KEYS.firmsCatalogVersion, CURRENT_CATALOG_VERSION);
  return migrated;
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const stored = window.localStorage.getItem(STORAGE_KEYS.theme);
    return stored === 'light' ? 'light' : 'dark';
  });

  const [activeSection, setActiveSection] = useState<WorkspaceSection>('arbitrage');

  const [firms, setFirms] = useState<PropFirmPreset[]>(loadMergedFirms);

  const [selectedFirmId, setSelectedFirmId] = useState<string>(
    () => firms[0]?.id ?? 'lucid-50k-flex'
  );

  const activeFirm = useMemo(
    () => firms.find((f) => f.id === selectedFirmId) ?? firms[0],
    [firms, selectedFirmId]
  );

  const [arbitrageInputs, setArbitrageInputs] = useState<ArbitrageInputs>(() => {
    const first = DEFAULT_PROP_FIRMS_2026[0];
    return {
      hedgeFactorMode: 'include_dd',
      drawdownUsd: first.maxDrawdownUsd,
      evaluationFeeUsd: first.evaluationFeeUsd,
      activationFeeUsd: first.activationFeeUsd,
      additionalProfitUsd: 150,
      totalTargetUsd: first.phase1TargetUsd + first.phase2TargetUsd,
      payoutGrossProfitUsd: 4000,
      profitSplitPct: first.profitSplitPct,
      refundOnFirstPayout: first.refundOnFirstPayout,
    };
  });

  const [tradeSizingInputs, setTradeSizingInputs] = useState<TradeSizingInputs>({
    instrumentId: 'US100',
    customPointValueUsd: 1.0,
    desiredRiskUsd: 500,
    stopLossPoints: 25,
  });

  const [capitalBonusInputs, setCapitalBonusInputs] = useState<CapitalBonusInputs>(() => ({
    basis: 'dd_buffer_15',
    phase1TargetUsd: DEFAULT_PROP_FIRMS_2026[0].phase1TargetUsd,
    bonusType: 'bonus_100',
    customBonusPct: 50,
  }));

  const [simulations, setSimulations] = useState<SavedSimulation[]>(() =>
    loadStoredJson<SavedSimulation[]>(STORAGE_KEYS.simulations, [])
  );

  const [hedgeDuringFunded, setHedgeDuringFunded] = useState(true);

  const [protectDoubleLoss, setProtectDoubleLoss] = useState(true);

  const [requireHedgeCoverageForPayout, setRequireHedgeCoverageForPayout] = useState(true);

  const [funded101Enabled, setFunded101Enabled] = useState(true);

  const [funded101Inputs, setFunded101Inputs] = useState<FundedMethod101Inputs>(() => ({
    shortTargetUsd: 150,
    remainingDrawdownUsd: Math.min(DEFAULT_PROP_FIRMS_2026[0].maxDrawdownUsd, 150 * 10),
    stopLossPoints: 100,
    activeDaysTarget: Math.max(5, DEFAULT_PROP_FIRMS_2026[0].minTradingDays),
    statisticalWinRatePct: 92,
  }));

  const [dailyEntries, setDailyEntries] = useState<DailyTradeEntry[]>(() =>
    generateApprovalTrajectory(
      DEFAULT_PROP_FIRMS_2026[0],
      {
        hedgeFactorMode: 'include_dd',
        drawdownUsd: DEFAULT_PROP_FIRMS_2026[0].maxDrawdownUsd,
        evaluationFeeUsd: DEFAULT_PROP_FIRMS_2026[0].evaluationFeeUsd,
        activationFeeUsd: DEFAULT_PROP_FIRMS_2026[0].activationFeeUsd,
        additionalProfitUsd: 150,
        totalTargetUsd:
          DEFAULT_PROP_FIRMS_2026[0].phase1TargetUsd + DEFAULT_PROP_FIRMS_2026[0].phase2TargetUsd,
        payoutGrossProfitUsd: 4000,
        profitSplitPct: DEFAULT_PROP_FIRMS_2026[0].profitSplitPct,
        refundOnFirstPayout: DEFAULT_PROP_FIRMS_2026[0].refundOnFirstPayout,
      },
      {
        enabled: true,
        activeDaysTarget: Math.max(5, DEFAULT_PROP_FIRMS_2026[0].minTradingDays),
        shortTargetUsd: 150,
      },
      {
        hedgeDuringFunded: true,
        protectDoubleLoss: true,
        requireHedgeCoverageForPayout: true,
      }
    )
  );

  const [monteCarloSummary, setMonteCarloSummary] = useState<MonteCarloSummary | null>(null);

  const [isConsultantOpen, setIsConsultantOpen] = useState(false);
  const [pendingTrigger, setPendingTrigger] = useState<{
    intent: ConsultIntent;
    prompt: string;
    nonce: number;
  } | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    window.localStorage.setItem(STORAGE_KEYS.theme, theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.firms, JSON.stringify(firms));
  }, [firms]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.simulations, JSON.stringify(simulations));
  }, [simulations]);

  const arbitrageOutputs = useMemo(
    () => calculateArbitrage(arbitrageInputs),
    [arbitrageInputs]
  );

  const tradeSizingOutputs = useMemo(
    () => calculateTradeSizing(tradeSizingInputs, arbitrageOutputs.hedgeFactor),
    [tradeSizingInputs, arbitrageOutputs.hedgeFactor]
  );

  const capitalBonusOutputs = useMemo(
    () =>
      calculateCapitalBonus(
        capitalBonusInputs,
        arbitrageInputs.drawdownUsd,
        arbitrageOutputs.hedgeFactor
      ),
    [capitalBonusInputs, arbitrageInputs.drawdownUsd, arbitrageOutputs.hedgeFactor]
  );

  const funded101Config = useMemo(
    () => ({
      enabled: funded101Enabled,
      activeDaysTarget: funded101Inputs.activeDaysTarget,
      shortTargetUsd: funded101Inputs.shortTargetUsd,
      stopMaxUsd: funded101Inputs.remainingDrawdownUsd,
    }),
    [
      funded101Enabled,
      funded101Inputs.activeDaysTarget,
      funded101Inputs.shortTargetUsd,
      funded101Inputs.remainingDrawdownUsd,
    ]
  );

  const dailySummary = useMemo(
    () =>
      activeFirm
        ? runDailySimulation(
            dailyEntries,
            activeFirm,
            arbitrageInputs,
            arbitrageOutputs.hedgeFactor,
            hedgeDuringFunded,
            funded101Config,
            protectDoubleLoss,
            requireHedgeCoverageForPayout
          )
        : null,
    [
      dailyEntries,
      activeFirm,
      arbitrageInputs,
      arbitrageOutputs.hedgeFactor,
      hedgeDuringFunded,
      funded101Config,
      protectDoubleLoss,
      requireHedgeCoverageForPayout,
    ]
  );

  const funded101Outputs = useMemo(
    () =>
      calculateFundedMethod101(
        funded101Inputs,
        tradeSizingInputs.instrumentId,
        tradeSizingInputs.customPointValueUsd,
        arbitrageInputs,
        arbitrageOutputs.hedgeFactor,
        protectDoubleLoss
      ),
    [
      funded101Inputs,
      tradeSizingInputs.instrumentId,
      tradeSizingInputs.customPointValueUsd,
      arbitrageInputs,
      arbitrageOutputs.hedgeFactor,
      protectDoubleLoss,
    ]
  );

  const contractValidation = useMemo(
    () => (activeFirm ? validateFirmContract(activeFirm) : null),
    [activeFirm]
  );

  const applyFirmToSimulation = (firm: PropFirmPreset) => {
    setSelectedFirmId(firm.id);
    const totalTarget = firm.phase1TargetUsd + firm.phase2TargetUsd;
    const nextArb: ArbitrageInputs = {
      ...arbitrageInputs,
      drawdownUsd: firm.maxDrawdownUsd,
      evaluationFeeUsd: firm.evaluationFeeUsd,
      activationFeeUsd: firm.activationFeeUsd,
      totalTargetUsd: totalTarget,
      profitSplitPct: firm.profitSplitPct,
      refundOnFirstPayout: firm.refundOnFirstPayout,
    };
    setArbitrageInputs(nextArb);
    setCapitalBonusInputs((prev) => ({
      ...prev,
      phase1TargetUsd: firm.phase1TargetUsd > 0 ? firm.phase1TargetUsd : totalTarget,
    }));
    const nextDays = Math.max(5, firm.minTradingDays);
    setFunded101Inputs((prev) => ({
      ...prev,
      remainingDrawdownUsd: Math.min(firm.maxDrawdownUsd, Math.max(100, prev.shortTargetUsd * 10)),
      activeDaysTarget: nextDays,
    }));
    setDailyEntries(
      generateApprovalTrajectory(
        firm,
        nextArb,
        {
          enabled: funded101Enabled,
          activeDaysTarget: nextDays,
          shortTargetUsd: funded101Inputs.shortTargetUsd,
        },
        {
          hedgeDuringFunded,
          protectDoubleLoss,
          requireHedgeCoverageForPayout,
        }
      )
    );
  };

  const handleSelectFirm = (firmId: string) => {
    const found = firms.find((f) => f.id === firmId);
    if (found) applyFirmToSimulation(found);
  };

  const handleSaveFirm = (firm: PropFirmPreset) => {
    setFirms((prev) => {
      const exists = prev.some((item) => item.id === firm.id);
      if (exists) {
        return prev.map((item) => (item.id === firm.id ? firm : item));
      }
      return [firm, ...prev];
    });
    if (firm.id === selectedFirmId) {
      applyFirmToSimulation(firm);
    }
  };

  const handleDeleteFirm = (firmId: string) => {
    setFirms((prev) => {
      const remaining = prev.filter((item) => item.id !== firmId);
      if (selectedFirmId === firmId && remaining[0]) {
        applyFirmToSimulation(remaining[0]);
      }
      return remaining;
    });
  };

  const handleResetFirms = () => {
    setFirms(DEFAULT_PROP_FIRMS_2026);
    applyFirmToSimulation(DEFAULT_PROP_FIRMS_2026[0]);
  };

  const handleSaveSimulation = () => {
    if (!activeFirm) return;
    const record: SavedSimulation = {
      id: `sim-${Date.now()}`,
      createdAt: new Date().toISOString(),
      firmName: activeFirm.name,
      firmModel: activeFirm.model,
      contractVersion: activeFirm.contractVersion,
      arbitrageInputs: { ...arbitrageInputs },
      hedgeFactor: arbitrageOutputs.hedgeFactor,
      scenarioANet: arbitrageOutputs.scenarioA.netResult,
      scenarioBFirstNet: arbitrageOutputs.scenarioB.firstPayoutNet,
      instrumentId: tradeSizingInputs.instrumentId,
      propFirmLot: tradeSizingOutputs.propFirmLot,
      brokerHedgeLot: tradeSizingOutputs.brokerHedgeLot,
      requiredEquityUsd: capitalBonusOutputs.requiredEquityUsd,
      realDepositUsd: capitalBonusOutputs.realDepositUsd,
      bonusPct: capitalBonusOutputs.bonusCreditPct,
    };
    setSimulations((prev) => [record, ...prev]);
  };

  const handleLoadSimulation = (sim: SavedSimulation) => {
    setArbitrageInputs({
      ...sim.arbitrageInputs,
      activationFeeUsd: sim.arbitrageInputs.activationFeeUsd ?? 0,
      hedgeFactorMode: sim.arbitrageInputs.hedgeFactorMode ?? 'include_dd',
    });
    setTradeSizingInputs((prev) => ({ ...prev, instrumentId: sim.instrumentId }));
    const matchingFirm = firms.find(
      (f) => f.name === sim.firmName && f.model === sim.firmModel
    );
    if (matchingFirm) setSelectedFirmId(matchingFirm.id);
    setActiveSection('arbitrage');
  };

  const handleConsultIntent = (intent: ConsultIntent, prompt: string) => {
    setPendingTrigger({ intent, prompt, nonce: Date.now() });
    setIsConsultantOpen(true);
  };

  const workspaceContext = useMemo(
    () => ({
      mesaSelecionada: activeFirm
        ? {
            nome: activeFirm.name,
            modelo: activeFirm.model,
            categoria: activeFirm.category,
            tipoAvaliacao: activeFirm.evaluationType,
            contaUSD: activeFirm.accountSize,
            drawdownAvaliacao: activeFirm.evaluationRules.maxDrawdown,
            drawdownFunded: activeFirm.fundedRules.maxDrawdown,
            consistenciaAvaliacao: activeFirm.evaluationRules.consistency,
            consistenciaFunded: activeFirm.fundedRules.consistency,
            taxaAtivacaoUSD: activeFirm.activationFeeUsd,
            bufferLucroFundedUSD: activeFirm.fundedRules.profitBufferUsd.value,
            diasMinimos: activeFirm.minTradingDays,
            viabilidade: activeFirm.viability,
            statusVerificacao: activeFirm.verificationStatus,
            camposAusentesCriticos: contractValidation?.missingCriticalFields ?? [],
          }
        : null,
      modulo1Arbitragem: {
        entradas: arbitrageInputs,
        fatorHedgeF: Number(arbitrageOutputs.hedgeFactor.toFixed(4)),
        cenarioAReprovacaoLiquido: Number(arbitrageOutputs.scenarioA.netResult.toFixed(2)),
        cenarioBPrimeiroPayoutLiquido: Number(
          arbitrageOutputs.scenarioB.firstPayoutNet.toFixed(2)
        ),
        cenarioBPayoutsSeguintes: Number(
          arbitrageOutputs.scenarioB.subsequentPayoutNet.toFixed(2)
        ),
      },
      modulo2TradeATrade: {
        ativo: tradeSizingInputs.instrumentId,
        riscoUSD: tradeSizingInputs.desiredRiskUsd,
        stopLoss: tradeSizingInputs.stopLossPoints,
        loteMesa_LM: Number(tradeSizingOutputs.propFirmLot.toFixed(2)),
        loteCorretora_LC: Number(tradeSizingOutputs.brokerHedgeLot.toFixed(2)),
      },
      modulo3CapitalBonus: {
        baseCalculo: capitalBonusInputs.basis,
        equidadeNecessariaUSD: Number(capitalBonusOutputs.requiredEquityUsd.toFixed(2)),
        bonusPct: capitalBonusOutputs.bonusCreditPct,
        depositoRealExigidoUSD: Number(capitalBonusOutputs.realDepositUsd.toFixed(2)),
      },
      simulacaoDiaria: dailySummary
        ? {
            status: dailySummary.status,
            estadoMaquina: dailySummary.lifecycleState,
            faseAtual: dailySummary.currentPhase,
            diasSimulados: dailySummary.totalDays,
            taxasPagasTotaisUSD: dailySummary.feesPaidTotalUsd,
            protecaoAntiLossDuplo: protectDoubleLoss,
            hedgeAcumuladoUSD: Number(dailySummary.brokerCumulativePnlUsd.toFixed(2)),
            resultadoLiquidoFinalUSD: Number(dailySummary.finalNetOutcomeUsd.toFixed(2)),
            consistenciaAtualPct: dailySummary.consistencyRatioPct
              ? Number(dailySummary.consistencyRatioPct.toFixed(1))
              : null,
            elegibilidadePayout: dailySummary.payoutEligibility,
          }
        : null,
      modulo5Funded10_1: {
        funded101Ativo: funded101Enabled,
        seguroHedgeFundedAtivo: hedgeDuringFunded,
        alvoCurtoUSD: funded101Inputs.shortTargetUsd,
        stopSegurancaUSD: funded101Inputs.remainingDrawdownUsd,
        stopLossPontos: funded101Inputs.stopLossPoints,
        diasAtivosAlvo: funded101Inputs.activeDaysTarget,
        loteMesa_LM: Number(funded101Outputs.propFirmLot.toFixed(2)),
        loteCorretora_LC: Number(funded101Outputs.brokerHedgeLot.toFixed(2)),
        takePontos: Number(funded101Outputs.takeProfitPoints.toFixed(1)),
        diaNormalLiquidoUSD: Number(funded101Outputs.normalDay.netAfterSplitUsd.toFixed(2)),
        diaFalhaLiquidoSemTaxaUSD: Number(funded101Outputs.failureDay.netBeforeFeeUsd.toFixed(2)),
      },
      monteCarlo: monteCarloSummary
        ? {
            rodadas: monteCarloSummary.numRuns,
            taxaPrimeiroPayoutPct: Number(monteCarloSummary.payoutSuccessRatePct.toFixed(1)),
            taxaAprovacaoAvaliacaoPct: Number(monteCarloSummary.evalPassRatePct.toFixed(1)),
            valorEsperadoEV_USD: Number(monteCarloSummary.expectedNetUsd.toFixed(2)),
            medianaP50_USD: Number(monteCarloSummary.medianNetUsd.toFixed(2)),
            p10_USD: Number(monteCarloSummary.p10NetUsd.toFixed(2)),
            p90_USD: Number(monteCarloSummary.p90NetUsd.toFixed(2)),
            capitalRealP95_USD: Number(monteCarloSummary.p95MaxBrokerOutlayUsd.toFixed(2)),
          }
        : null,
    }),
    [
      activeFirm,
      arbitrageInputs,
      arbitrageOutputs,
      tradeSizingInputs,
      tradeSizingOutputs,
      capitalBonusInputs,
      capitalBonusOutputs,
      dailySummary,
      contractValidation,
      protectDoubleLoss,
      funded101Enabled,
      hedgeDuringFunded,
      funded101Inputs,
      funded101Outputs,
      monteCarloSummary,
    ]
  );

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-[#090D16] dark:text-slate-100">
      <Header
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        onOpenConsultant={() => setIsConsultantOpen(true)}
      />

      <ContextToolbar
        firms={firms}
        selectedFirmId={selectedFirmId}
        onSelectFirm={handleSelectFirm}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onSaveSimulation={handleSaveSimulation}
        hedgeFactor={arbitrageOutputs.hedgeFactor}
        propFirmLot={tradeSizingOutputs.propFirmLot}
        brokerHedgeLot={tradeSizingOutputs.brokerHedgeLot}
        realDepositUsd={capitalBonusOutputs.realDepositUsd}
      />

      <main className="flex-1">
        <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-6 lg:px-8">
          {activeSection === 'arbitrage' && (
            <ArbitrageModule
              inputs={arbitrageInputs}
              outputs={arbitrageOutputs}
              contractValidation={contractValidation}
              onChange={setArbitrageInputs}
              onConsultIntent={handleConsultIntent}
            />
          )}

          {activeSection === 'sizing' && (
            <TradeSizingModule
              inputs={tradeSizingInputs}
              outputs={tradeSizingOutputs}
              hedgeFactor={arbitrageOutputs.hedgeFactor}
              onChange={setTradeSizingInputs}
              onConsultIntent={handleConsultIntent}
            />
          )}

          {activeSection === 'capital' && (
            <CapitalBonusModule
              inputs={capitalBonusInputs}
              outputs={capitalBonusOutputs}
              drawdownUsd={arbitrageInputs.drawdownUsd}
              hedgeFactor={arbitrageOutputs.hedgeFactor}
              onChange={setCapitalBonusInputs}
              onConsultIntent={handleConsultIntent}
            />
          )}

          {activeSection === 'daily' && activeFirm && dailySummary && (
            <DailySimulationModule
              firm={activeFirm}
              entries={dailyEntries}
              summary={dailySummary}
              arbitrageInputs={arbitrageInputs}
              hedgeFactor={arbitrageOutputs.hedgeFactor}
              drawdownUsd={arbitrageInputs.drawdownUsd}
              desiredRiskUsd={tradeSizingInputs.desiredRiskUsd}
              hedgeDuringFunded={hedgeDuringFunded}
              onToggleHedgeDuringFunded={() => setHedgeDuringFunded((v) => !v)}
              protectDoubleLoss={protectDoubleLoss}
              onToggleProtectDoubleLoss={() => setProtectDoubleLoss((v) => !v)}
              requireHedgeCoverageForPayout={requireHedgeCoverageForPayout}
              onToggleRequireHedgeCoverageForPayout={() =>
                setRequireHedgeCoverageForPayout((v) => !v)
              }
              funded101Enabled={funded101Enabled}
              onToggleFunded101={() => setFunded101Enabled((v) => !v)}
              funded101Inputs={funded101Inputs}
              funded101Outputs={funded101Outputs}
              onChangeFunded101={setFunded101Inputs}
              instrumentId={tradeSizingInputs.instrumentId}
              customPointValueUsd={tradeSizingInputs.customPointValueUsd}
              onChangeInstrument={(id, customVal) =>
                setTradeSizingInputs((prev) => ({
                  ...prev,
                  instrumentId: id,
                  customPointValueUsd:
                    customVal !== undefined ? customVal : prev.customPointValueUsd,
                }))
              }
              onAddEntry={(entry) => setDailyEntries((prev) => [...prev, entry])}
              onUpdateEntry={(id, mesaPnlUsd, intradayPeakOffsetUsd) =>
                setDailyEntries((prev) =>
                  prev.map((item) =>
                    item.id === id ? { ...item, mesaPnlUsd, intradayPeakOffsetUsd } : item
                  )
                )
              }
              onRemoveEntry={(id) =>
                setDailyEntries((prev) => prev.filter((item) => item.id !== id))
              }
              onRunRandomSimulation={(options) =>
                setDailyEntries(
                  generateRandomTrajectory(
                    activeFirm,
                    arbitrageInputs,
                    arbitrageOutputs.hedgeFactor,
                    options
                  )
                )
              }
              onLoadApprovalPreset={() =>
                setDailyEntries(
                  generateApprovalTrajectory(activeFirm, arbitrageInputs, funded101Config, {
                    hedgeFactor: arbitrageOutputs.hedgeFactor,
                    hedgeDuringFunded,
                    protectDoubleLoss,
                    requireHedgeCoverageForPayout,
                  })
                )
              }
              onLoadStopOutPreset={() =>
                setDailyEntries(generateStopOutTrajectory(activeFirm, arbitrageInputs))
              }
              onClearEntries={() => setDailyEntries([])}
              onConsultIntent={handleConsultIntent}
            />
          )}

          {activeSection === 'montecarlo' && activeFirm && (
            <MonteCarloModule
              firm={activeFirm}
              arbitrageInputs={arbitrageInputs}
              hedgeFactor={arbitrageOutputs.hedgeFactor}
              desiredRiskUsd={tradeSizingInputs.desiredRiskUsd}
              hedgeDuringFunded={hedgeDuringFunded}
              onToggleHedgeDuringFunded={() => setHedgeDuringFunded((v) => !v)}
              protectDoubleLoss={protectDoubleLoss}
              onToggleProtectDoubleLoss={() => setProtectDoubleLoss((v) => !v)}
              requireHedgeCoverageForPayout={requireHedgeCoverageForPayout}
              onToggleRequireHedgeCoverageForPayout={() =>
                setRequireHedgeCoverageForPayout((v) => !v)
              }
              funded101Enabled={funded101Enabled}
              onToggleFunded101={() => setFunded101Enabled((v) => !v)}
              funded101Inputs={funded101Inputs}
              onChangeFunded101={setFunded101Inputs}
              onSummaryChange={setMonteCarloSummary}
              onConsultIntent={handleConsultIntent}
            />
          )}

          {activeSection === 'firms' && (
            <PropFirmsModule
              firms={firms}
              selectedFirmId={selectedFirmId}
              onApplyFirm={(firm) => {
                applyFirmToSimulation(firm);
                setActiveSection('arbitrage');
              }}
              onSaveFirm={handleSaveFirm}
              onDeleteFirm={handleDeleteFirm}
              onResetFirms={handleResetFirms}
              simulations={simulations}
              onLoadSimulation={handleLoadSimulation}
              onDeleteSimulation={(id) =>
                setSimulations((prev) => prev.filter((item) => item.id !== id))
              }
              onClearSimulations={() => setSimulations([])}
              onConsultIntent={handleConsultIntent}
            />
          )}
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white py-5 dark:border-slate-800/80 dark:bg-[#090D16]">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-2 px-4 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8 dark:text-slate-400">
          <span>
            PropQuant Engine — Modelagem Quantitativa de Arbitragem e Hedging Assimétrico (USD).
          </span>
          <span>
            Simulações financeiras para apoio operacional; valide sempre as regras contratuais vigentes da mesa e da corretora.
          </span>
        </div>
      </footer>

      <AiConsultantDrawer
        isOpen={isConsultantOpen}
        onClose={() => setIsConsultantOpen(false)}
        workspaceContext={workspaceContext}
        pendingTrigger={pendingTrigger}
      />
    </div>
  );
}
