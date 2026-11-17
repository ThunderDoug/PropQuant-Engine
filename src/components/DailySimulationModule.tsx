import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Dices,
  MessageSquare,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { INSTRUMENT_SPECS } from '../data/propFirms2026';
import {
  ArbitrageInputs,
  ConsultIntent,
  DailySimulationSummary,
  DailyTradeEntry,
  FundedMethod101Inputs,
  FundedMethod101Outputs,
  InstrumentId,
  PropFirmPreset,
  RandomSizingMode,
} from '../types/quant';
import {
  formatFactor,
  formatLot,
  formatUsd,
  RandomSimulationOptions,
} from '../utils/quantEngine';

interface DailySimulationModuleProps {
  firm: PropFirmPreset;
  entries: DailyTradeEntry[];
  summary: DailySimulationSummary;
  arbitrageInputs: ArbitrageInputs;
  hedgeFactor: number;
  drawdownUsd: number;
  desiredRiskUsd: number;
  hedgeDuringFunded: boolean;
  onToggleHedgeDuringFunded: () => void;
  protectDoubleLoss: boolean;
  onToggleProtectDoubleLoss: () => void;
  funded101Enabled: boolean;
  onToggleFunded101: () => void;
  funded101Inputs: FundedMethod101Inputs;
  funded101Outputs: FundedMethod101Outputs;
  onChangeFunded101: (next: FundedMethod101Inputs) => void;
  instrumentId: InstrumentId;
  customPointValueUsd: number;
  onChangeInstrument: (id: InstrumentId, customVal?: number) => void;
  onAddEntry: (entry: DailyTradeEntry) => void;
  onUpdateEntry: (id: string, mesaPnlUsd: number, intradayPeakOffsetUsd: number) => void;
  onRemoveEntry: (id: string) => void;
  onRunRandomSimulation: (options: RandomSimulationOptions) => void;
  onLoadApprovalPreset: () => void;
  onLoadStopOutPreset: () => void;
  onClearEntries: () => void;
  onConsultIntent: (intent: ConsultIntent, prompt: string) => void;
}

export function DailySimulationModule({
  firm,
  entries,
  summary,
  arbitrageInputs,
  hedgeFactor,
  drawdownUsd,
  desiredRiskUsd,
  hedgeDuringFunded,
  onToggleHedgeDuringFunded,
  protectDoubleLoss,
  onToggleProtectDoubleLoss,
  funded101Enabled,
  onToggleFunded101,
  funded101Inputs,
  funded101Outputs,
  onChangeFunded101,
  instrumentId,
  customPointValueUsd,
  onChangeInstrument,
  onAddEntry,
  onUpdateEntry,
  onRemoveEntry,
  onRunRandomSimulation,
  onLoadApprovalPreset,
  onLoadStopOutPreset,
  onClearEntries,
  onConsultIntent,
}: DailySimulationModuleProps) {
  const [newPnl, setNewPnl] = useState<number>(Math.round(desiredRiskUsd * 2));
  const [newPeakOffset, setNewPeakOffset] = useState<number>(0);
  const [newNote, setNewNote] = useState<string>('');
  const [sizingMode, setSizingMode] = useState<RandomSizingMode>('dd_max_meta_dias');
  const [winRatePct, setWinRatePct] = useState<number>(58);
  const [rewardToRisk, setRewardToRisk] = useState<number>(0.75);
  const [minDaysDivisor, setMinDaysDivisor] = useState<number>(Math.max(1, firm.minTradingDays));
  const [randomRunCount, setRandomRunCount] = useState<number>(0);
  const [copiedKey, setCopiedKey] = useState<'lm' | 'lc' | null>(null);

  useEffect(() => {
    setMinDaysDivisor(Math.max(1, firm.minTradingDays));
  }, [firm.id, firm.minTradingDays]);

  const selectedSpec =
    INSTRUMENT_SPECS.find((s) => s.id === instrumentId) ?? INSTRUMENT_SPECS[0];

  const safeDaysDivisor = Math.max(1, minDaysDivisor);
  const evalTargetPreview =
    summary.currentPhase === 'Fase 2' && firm.phase2TargetUsd > 0
      ? firm.phase2TargetUsd
      : firm.phase1TargetUsd > 0
      ? firm.phase1TargetUsd
      : Math.max(100, arbitrageInputs.totalTargetUsd);

  const isCurrentlyInFunded101 = summary.currentPhase === 'Funded' && funded101Enabled;

  const previewTp = isCurrentlyInFunded101
    ? Math.round(funded101Inputs.shortTargetUsd)
    : sizingMode === 'dd_max_rr'
    ? Math.round(drawdownUsd * rewardToRisk)
    : sizingMode === 'fixed_risk'
    ? Math.round(desiredRiskUsd * rewardToRisk)
    : Math.round(evalTargetPreview / safeDaysDivisor);

  const previewSl = isCurrentlyInFunded101
    ? Math.round(funded101Inputs.remainingDrawdownUsd)
    : sizingMode === 'meta_dias_rr'
    ? Math.round(previewTp / Math.max(0.1, rewardToRisk))
    : sizingMode === 'fixed_risk'
    ? Math.round(desiredRiskUsd)
    : Math.round(drawdownUsd);

  const previewEffectiveRr = previewSl > 0 ? previewTp / previewSl : 0;

  const handleRandomRun = () => {
    setRandomRunCount((c) => c + 1);
    onRunRandomSimulation({
      sizingMode,
      winRatePct,
      rewardToRisk,
      minDaysDivisor: safeDaysDivisor,
      baseRiskUsd: desiredRiskUsd,
      hedgeDuringFunded,
      funded101Enabled,
      fundedShortTargetUsd: funded101Inputs.shortTargetUsd,
      fundedWinRatePct: funded101Inputs.statisticalWinRatePct,
      fundedActiveDaysTarget: funded101Inputs.activeDaysTarget,
      fundedStopMaxUsd: funded101Inputs.remainingDrawdownUsd,
      protectDoubleLoss,
    });
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!Number.isFinite(newPnl)) return;
    onAddEntry({
      id: `day-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      mesaPnlUsd: newPnl,
      intradayPeakOffsetUsd: Math.max(0, newPeakOffset),
      note: newNote.trim() || undefined,
    });
    setNewNote('');
  };

  const handleCopy = async (val: string, key: 'lm' | 'lc') => {
    try {
      await navigator.clipboard.writeText(val);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      // Clipboard unavailable
    }
  };

  // Build SVG chart points
  const steps = summary.steps;
  const svgW = 720;
  const svgH = 220;
  const padX = 52;
  const padY = 22;
  const innerW = svgW - padX * 2;
  const innerH = svgH - padY * 2;

  const chartSeries = steps.map((s) => ({
    day: s.dayIndex,
    mesaPnl: s.mesaPhasePnlUsd,
    brokerCum: s.brokerCumulativePnlUsd,
    netCombined: s.combinedNetCashflowUsd,
    phaseAdvancedTo: s.phaseAdvancedTo,
  }));

  const allY = chartSeries.flatMap((p) => [p.mesaPnl, p.brokerCum, p.netCombined]);
  const yMin = Math.min(0, ...allY);
  const yMax = Math.max(100, ...allY);
  const ySpan = Math.max(1, yMax - yMin);
  const maxDay = Math.max(1, chartSeries.length);

  const toX = (day: number) => padX + ((day - 1) / Math.max(1, maxDay - 1)) * innerW;
  const toY = (val: number) => padY + ((yMax - val) / ySpan) * innerH;
  const zeroY = toY(0);

  const buildPath = (selector: (p: (typeof chartSeries)[number]) => number) =>
    chartSeries
      .map(
        (p, idx) =>
          `${idx === 0 && maxDay === 1 ? padX : toX(p.day).toFixed(1)},${toY(selector(p)).toFixed(1)}`
      )
      .join(' ');

  const progressPct =
    summary.currentPhaseTargetUsd > 0
      ? Math.max(
          0,
          Math.min(100, (summary.currentPhasePnlUsd / summary.currentPhaseTargetUsd) * 100)
        )
      : 0;

  const effectivePointVal =
    instrumentId === 'CUSTOM' ? customPointValueUsd : selectedSpec.pointValuePerStandardLot;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50 sm:text-3xl text-balance">
            Simulador Dia-a-Dia (Avaliação até Funded · Método 10:1)
          </h1>
          <p className="mt-1.5 max-w-3xl text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            Simule a jornada completa entre <span className="font-semibold">Fase 1</span>,{' '}
            {firm.phase2TargetUsd > 0 && (
              <>
                <span className="font-semibold">Fase 2</span> e{' '}
              </>
            )}
            <span className="font-semibold">Conta Funded</span>. Ao avançar para Funded, o{' '}
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">
              Método 10:1 (R:R Negativo)
            </span>{' '}
            assume o controle com alvos curtos ({formatUsd(funded101Inputs.shortTargetUsd, true)}/dia) para validar os dias mínimos de calendário até o 1º Payout.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleRandomRun}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 active:scale-[0.99] whitespace-nowrap shrink-0"
          >
            <Dices className="h-4 w-4" />
            Simular Cenário Aleatório
            {randomRunCount > 0 && (
              <span className="font-mono text-[11px] opacity-90">#{randomRunCount}</span>
            )}
          </button>

          <button
            type="button"
            onClick={() =>
              onConsultIntent(
                funded101Enabled ? 'E' : 'A',
                `Audite minha simulação dia-a-dia na mesa ${firm.name} (${firm.model}): Status "${summary.status}", ${summary.totalDays} dias simulados, fase atual "${summary.currentPhase}", hedge acumulado ${formatUsd(summary.brokerCumulativePnlUsd)} e resultado líquido final ${formatUsd(summary.finalNetOutcomeUsd)}. Método 10:1 pós-aprovação está ${funded101Enabled ? `ATIVO (alvo ${formatUsd(funded101Inputs.shortTargetUsd, true)}, acerto ${funded101Inputs.statisticalWinRatePct}%, ${funded101Inputs.activeDaysTarget}d, L_M=${formatLot(funded101Outputs.propFirmLot)}, L_C=${formatLot(funded101Outputs.brokerHedgeLot)})` : 'DESATIVADO'}. Analise risco de avaliação, transição para Funded e Dia Normal vs. Dia de Falha.`
              )
            }
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <MessageSquare className="h-3.5 w-3.5 text-emerald-500" />
            Auditar Jornada + 10:1 com IA
          </button>
        </div>
      </div>

      {/* Status Alert Banners */}
      {summary.status === 'Reprovado (Stop)' && (
        <div
          role="alert"
          className="rounded-xl border border-red-500/40 bg-red-500/10 px-5 py-3.5 text-sm text-red-700 dark:text-red-300 flex items-start gap-3"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <div className="font-semibold">
              Conta Reprovada no Dia {summary.totalDays} ({summary.currentPhase})
            </div>
            <p className="mt-0.5 text-xs">
              {summary.failureReason} No hedge da corretora, o ganho acumulado foi de{' '}
              <span className="font-mono font-semibold">
                {formatUsd(summary.brokerCumulativePnlUsd, true)}
              </span>
              , resultando em líquido de{' '}
              <span className="font-mono font-semibold">
                {formatUsd(summary.finalNetOutcomeUsd, true)}
              </span>
              .
            </p>
          </div>
        </div>
      )}

      {summary.status === 'Aprovado para Saque' && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-5 py-3.5 text-sm text-emerald-800 dark:text-emerald-200 flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div>
            <div className="font-semibold">
              Jornada Concluída — Elegível ao 1º Saque no Dia {summary.totalDays}
            </div>
            <p className="mt-0.5 text-xs">
              Avaliação e dias ativos na Funded ({funded101Enabled ? 'via Método 10:1' : 'via Meta Padrão'}) cumpridos. Resultado líquido consolidado após split ({firm.profitSplitPct}%) e hedge acumulado:{' '}
              <span className="font-mono font-semibold">
                {formatUsd(summary.finalNetOutcomeUsd, true)}
              </span>
              .
            </p>
          </div>
        </div>
      )}

      {summary.consistencyViolated && summary.status === 'Em Andamento' && (
        <div
          role="alert"
          className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-5 py-3 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2.5"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Regra de consistência ativa ({summary.consistencyLimitPct}%): seu maior dia positivo nesta fase representa{' '}
            <strong className="font-mono">{summary.consistencyRatioPct?.toFixed(1)}%</strong> do lucro positivo acumulado. Adicione mais dias positivos equilibrados para liberar o avanço de fase.
          </span>
        </div>
      )}

      {/* 4-Column KPI Summary */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
          <div className="text-xs text-slate-500 dark:text-slate-400">Etapa & Status</div>
          <div className="mt-1.5 font-display text-xl font-bold text-slate-900 dark:text-slate-50">
            {summary.currentPhase}
            {summary.currentPhase === 'Funded' && funded101Enabled ? ' · 10:1' : ''}
          </div>
          <div
            className={`mt-1 text-xs font-medium ${
              summary.status === 'Aprovado para Saque'
                ? 'text-emerald-600 dark:text-emerald-400'
                : summary.status === 'Reprovado (Stop)'
                ? 'text-red-600 dark:text-red-400'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            {summary.status} · {summary.totalDays} dias totais
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Progresso na {summary.currentPhase}</span>
            <span className="font-mono tabular-nums">{progressPct.toFixed(0)}%</span>
          </div>
          <div className="mt-1.5 font-mono text-xl font-bold tabular-nums text-slate-900 dark:text-slate-50">
            {formatUsd(summary.currentPhasePnlUsd, true)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Meta: <span className="font-mono">{formatUsd(summary.currentPhaseTargetUsd)}</span> ·{' '}
            {summary.daysInCurrentPhase}/{summary.minTradingDaysRequired}d mín.
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Hedge Acumulado na Corretora
          </div>
          <div
            className={`mt-1.5 font-mono text-xl font-bold tabular-nums ${
              summary.brokerCumulativePnlUsd >= 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-600 dark:text-red-400'
            }`}
          >
            {formatUsd(summary.brokerCumulativePnlUsd, true)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Fator aplicado: <span className="font-mono">{formatFactor(hedgeFactor)}x</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Resultado Líquido Consolidado
          </div>
          <div
            className={`mt-1.5 font-mono text-xl font-bold tabular-nums ${
              summary.finalNetOutcomeUsd >= 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-amber-600 dark:text-amber-400'
            }`}
          >
            {formatUsd(summary.finalNetOutcomeUsd, true)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {summary.consistencyLimitPct !== null
              ? `Consistência atual: ${
                  summary.consistencyRatioPct !== null
                    ? `${summary.consistencyRatioPct.toFixed(1)}%`
                    : '—'
                } / máx ${summary.consistencyLimitPct}%`
              : 'Sem regra de consistência'}
          </div>
        </div>
      </div>

      {/* Controls + Chart Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left: Add Day & Random Simulation Engine */}
        <div className="lg:col-span-4 space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Simular Novo Dia Operado
            </h2>

            <form onSubmit={handleAdd} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="daily-pnl-input"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Resultado na Mesa no Dia (USD)
                </label>
                <div className="relative mt-1.5">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                    $
                  </span>
                  <input
                    id="daily-pnl-input"
                    type="number"
                    step="50"
                    value={newPnl}
                    onChange={(e) => setNewPnl(Number(e.target.value))}
                    className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-7 pr-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {[
                    { label: '+2R', val: Math.round(desiredRiskUsd * 2) },
                    { label: '+1R', val: Math.round(desiredRiskUsd) },
                    { label: `10:1 (+$${funded101Inputs.shortTargetUsd})`, val: Math.round(funded101Inputs.shortTargetUsd) },
                    { label: '-1R', val: -Math.round(desiredRiskUsd) },
                  ].map((btn) => (
                    <button
                      key={btn.label}
                      type="button"
                      onClick={() => setNewPnl(btn.val)}
                      className="rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-700 hover:border-emerald-500 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-300"
                    >
                      {btn.label}
                    </button>
                  ))}
                </div>
              </div>

              {firm.drawdownType === 'Trailing Intradiário' && (
                <div>
                  <label
                    htmlFor="daily-peak-input"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Pico Flutuante Intradiário (+USD antes de fechar)
                  </label>
                  <div className="relative mt-1.5">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                      +$
                    </span>
                    <input
                      id="daily-peak-input"
                      type="number"
                      min={0}
                      step="50"
                      value={newPeakOffset}
                      onChange={(e) => setNewPeakOffset(Number(e.target.value))}
                      className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-8 pr-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                    />
                  </div>
                </div>
              )}

              <div>
                <label
                  htmlFor="daily-note-input"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Observação (Opcional)
                </label>
                <input
                  id="daily-note-input"
                  type="text"
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Ex: Abertura NY US100"
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>

              <button
                type="submit"
                disabled={summary.status !== 'Em Andamento'}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
              >
                <Plus className="h-4 w-4" />
                {summary.status === 'Em Andamento'
                  ? `Adicionar Dia ${entries.length + 1}`
                  : 'Jornada Encerrada (Reinicie ou Remova)'}
              </button>
            </form>

            {/* Etapa 1: Avaliação */}
            <div className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Etapa 1 · Regras da Avaliação (Fase 1 / 2)
                </span>
                {randomRunCount > 0 && (
                  <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
                    Rodada #{randomRunCount}
                  </span>
                )}
              </div>

              <div>
                <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                  Modelo de Stop Loss e Take Profit na Avaliação
                </span>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  {(
                    [
                      { id: 'dd_max_meta_dias', label: 'DD Máx + Meta ÷ Dias' },
                      { id: 'dd_max_rr', label: 'DD Máx + R:R (0.75)' },
                      { id: 'meta_dias_rr', label: 'Meta ÷ Dias + R:R' },
                      { id: 'fixed_risk', label: 'Risco Fixo ($)' },
                    ] as const
                  ).map((mode) => {
                    const active = sizingMode === mode.id;
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        onClick={() => setSizingMode(mode.id)}
                        className={`rounded-md border px-2.5 py-1.5 text-left text-[11px] font-medium transition-colors whitespace-nowrap truncate ${
                          active
                            ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 dark:border-slate-800 dark:bg-[#0B0F17] dark:text-slate-400'
                        }`}
                      >
                        {mode.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label
                    htmlFor="sim-win-rate"
                    className="block text-[11px] text-slate-500 dark:text-slate-400"
                  >
                    Win Rate (%)
                  </label>
                  <input
                    id="sim-win-rate"
                    type="number"
                    min={10}
                    max={95}
                    step={5}
                    value={winRatePct}
                    onChange={(e) => setWinRatePct(Number(e.target.value))}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-slate-50 px-2 font-mono text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                  />
                </div>
                <div>
                  <label
                    htmlFor="sim-rr"
                    className="block text-[11px] text-slate-500 dark:text-slate-400"
                  >
                    Risco/Retorno
                  </label>
                  <input
                    id="sim-rr"
                    type="number"
                    min={0.1}
                    max={5}
                    step={0.05}
                    value={rewardToRisk}
                    onChange={(e) => setRewardToRisk(Number(e.target.value))}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-slate-50 px-2 font-mono text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                  />
                </div>
                <div>
                  <label
                    htmlFor="sim-days-divisor"
                    className="block text-[11px] text-slate-500 dark:text-slate-400"
                  >
                    Dias p/ TP
                  </label>
                  <input
                    id="sim-days-divisor"
                    type="number"
                    min={1}
                    max={30}
                    step={1}
                    value={minDaysDivisor}
                    onChange={(e) => setMinDaysDivisor(Number(e.target.value))}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-slate-50 px-2 font-mono text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                  />
                </div>
              </div>

              {/* Etapa 2: Transição automática para Funded 10:1 */}
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2.5 dark:border-slate-800 dark:bg-[#0B0F17]">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Etapa 2 · Pós-Aprovação (Funded 10:1)
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      Ativa automaticamente ao chegar na Conta Funded
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={funded101Enabled}
                    aria-label="Ativar Método 10:1 ao avançar para Funded"
                    onClick={onToggleFunded101}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                      funded101Enabled ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        funded101Enabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-200 dark:border-slate-800">
                  <span className="text-[11px] text-slate-600 dark:text-slate-300">
                    Seguro Hedge na Funded (L_C = L_M × F)
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={hedgeDuringFunded}
                    aria-label="Manter seguro hedge ativo na fase Funded"
                    onClick={onToggleHedgeDuringFunded}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      hedgeDuringFunded ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        hedgeDuringFunded ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-200 dark:border-slate-800">
                  <div>
                    <span className="block text-[11px] font-medium text-slate-700 dark:text-slate-200">
                      Proteção Anti-Loss Duplo (F Dinâmico)
                    </span>
                    <span className="block text-[10px] text-slate-500 dark:text-slate-400">
                      Ajusta F para cobrir taxa T + hedge gasto antes do stop
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={protectDoubleLoss}
                    aria-label="Ativar proteção anti-loss duplo com fator F dinâmico"
                    onClick={onToggleProtectDoubleLoss}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      protectDoubleLoss ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        protectDoubleLoss ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Preview TP/SL */}
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] dark:border-slate-800 dark:bg-[#0B0F17]">
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-300">
                  <span>
                    TP ({isCurrentlyInFunded101 ? 'Funded 10:1' : summary.currentPhase})
                  </span>
                  <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                    {formatUsd(previewTp, true)}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-slate-600 dark:text-slate-300">
                  <span>SL (Stop Dia)</span>
                  <span className="font-mono font-semibold text-red-600 dark:text-red-400">
                    {formatUsd(-previewSl)}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-slate-500 dark:text-slate-400">
                  <span>R:R efetivo da etapa atual</span>
                  <span className="font-mono">{previewEffectiveRr.toFixed(2)}:1</span>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2">
                <button
                  type="button"
                  onClick={handleRandomRun}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-500"
                >
                  <Dices className="h-3.5 w-3.5" />
                  Simular Novo Resultado Aleatório
                </button>
                <button
                  type="button"
                  onClick={onLoadApprovalPreset}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <Play className="h-3.5 w-3.5 text-emerald-500" />
                  Jornada Fixa de Aprovação (Cenário B)
                </button>
                <button
                  type="button"
                  onClick={onLoadStopOutPreset}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  Jornada Fixa de Stop (Cenário A)
                </button>
                <button
                  type="button"
                  onClick={onClearEntries}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-500 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-800"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Zerar Dias
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Dual Equity Curve + Day-by-Day Table */}
        <div className="lg:col-span-8 space-y-6">
          {/* SVG Curve */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
            <div className="flex flex-col gap-2 border-b border-slate-200 pb-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                  Evolução Dia-a-Dia: Mesa vs. Hedge na Corretora
                </h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Curva de P&L na fase atual da mesa comparada ao hedge acumulado e transição automática para Funded
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-3 bg-slate-400 inline-block" /> P&L Mesa (Fase)
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-3 bg-emerald-500 inline-block" /> Hedge Acumulado
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-3 bg-amber-500 inline-block" /> Líquido Combinado
                </span>
              </div>
            </div>

            {chartSeries.length === 0 ? (
              <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                Adicione dias operados ou carregue uma trajetória pronta ao lado para visualizar a curva.
              </div>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <svg
                  viewBox={`0 0 ${svgW} ${svgH}`}
                  className="w-full min-w-[500px] h-auto"
                  role="img"
                  aria-label="Evolução dia-a-dia de P&L na mesa e hedge na corretora"
                >
                  <line
                    x1={padX}
                    y1={zeroY}
                    x2={svgW - padX}
                    y2={zeroY}
                    stroke="currentColor"
                    className="text-slate-300 dark:text-slate-700"
                    strokeDasharray="4 4"
                    strokeWidth={1}
                  />

                  {chartSeries
                    .filter((p) => p.phaseAdvancedTo)
                    .map((p) => (
                      <g key={`phase-${p.day}`}>
                        <line
                          x1={toX(p.day)}
                          y1={padY}
                          x2={toX(p.day)}
                          y2={svgH - padY}
                          stroke="#10B981"
                          strokeDasharray="3 3"
                          strokeOpacity={0.5}
                          strokeWidth={1}
                        />
                        <text
                          x={toX(p.day) + 4}
                          y={padY + 10}
                          className="fill-emerald-600 dark:fill-emerald-400 text-[10px] font-mono"
                        >
                          → {p.phaseAdvancedTo}
                        </text>
                      </g>
                    ))}

                  {chartSeries.length > 1 && (
                    <>
                      <polyline
                        fill="none"
                        stroke="#94A3B8"
                        strokeWidth={1.75}
                        points={buildPath((p) => p.mesaPnl)}
                      />
                      <polyline
                        fill="none"
                        stroke="#10B981"
                        strokeWidth={2.25}
                        points={buildPath((p) => p.brokerCum)}
                      />
                      <polyline
                        fill="none"
                        stroke="#F59E0B"
                        strokeWidth={2}
                        strokeDasharray="5 3"
                        points={buildPath((p) => p.netCombined)}
                      />
                    </>
                  )}

                  {chartSeries.map((p) => (
                    <g key={`pts-${p.day}`}>
                      <circle
                        cx={chartSeries.length === 1 ? padX : toX(p.day)}
                        cy={toY(p.brokerCum)}
                        r={3}
                        fill="#10B981"
                      />
                      <circle
                        cx={chartSeries.length === 1 ? padX : toX(p.day)}
                        cy={toY(p.netCombined)}
                        r={3}
                        fill="#F59E0B"
                      />
                    </g>
                  ))}

                  <text
                    x={padX}
                    y={svgH - 4}
                    className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
                  >
                    Dia 1
                  </text>
                  <text
                    x={svgW - padX}
                    y={svgH - 4}
                    textAnchor="end"
                    className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
                  >
                    Dia {chartSeries.length}
                  </text>
                  <text
                    x={padX - 6}
                    y={zeroY + 3}
                    textAnchor="end"
                    className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
                  >
                    $0
                  </text>
                </svg>
              </div>
            )}
          </div>

          {/* Day-by-Day Ledger Table */}
          <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
            <div className="border-b border-slate-200 px-6 py-4 dark:border-slate-800 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Livro Diário da Operação ({steps.length} dias)
              </h3>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Edite o P&L de qualquer dia para recalcular toda a jornada
              </span>
            </div>

            {steps.length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Nenhum dia registrado ainda.
                </p>
                <button
                  type="button"
                  onClick={onLoadApprovalPreset}
                  className="mt-3 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
                >
                  Gerar Jornada de Aprovação
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <th className="px-4 py-3">Dia</th>
                      <th className="px-3 py-3">Etapa</th>
                      <th className="px-3 py-3 text-right">P&L Mesa ($)</th>
                      <th className="px-3 py-3 text-right">P&L Fase</th>
                      <th className="px-3 py-3 text-right">DD Restante</th>
                      <th className="px-3 py-3 text-right">F Dia</th>
                      <th className="px-3 py-3 text-right">Hedge Dia</th>
                      <th className="px-3 py-3 text-right">Hedge Acum.</th>
                      <th className="px-3 py-3 text-right">Líquido</th>
                      <th className="px-4 py-3">Evento</th>
                      <th className="px-3 py-3 text-right"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80">
                    {steps.map((step) => (
                      <tr
                        key={step.entryId}
                        className={
                          step.violationReason
                            ? 'bg-red-500/5'
                            : step.phaseAdvancedTo
                            ? 'bg-emerald-500/5'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                        }
                      >
                        <td className="px-4 py-2.5 font-mono font-semibold text-slate-900 dark:text-slate-100">
                          D{step.dayIndex}
                        </td>
                        <td className="px-3 py-2.5 text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          {step.phase}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <input
                            type="number"
                            aria-label={`P&L do dia ${step.dayIndex}`}
                            value={step.mesaPnlUsd}
                            onChange={(e) =>
                              onUpdateEntry(
                                step.entryId,
                                Number(e.target.value),
                                step.intradayPeakOffsetUsd
                              )
                            }
                            className={`h-8 w-24 rounded border border-slate-300 bg-slate-50 px-2 text-right font-mono text-xs focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] ${
                              step.mesaPnlUsd >= 0
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-red-600 dark:text-red-400'
                            }`}
                          />
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
                          {formatUsd(step.mesaPhasePnlUsd, true)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                          {formatUsd(step.drawdownRemainingUsd)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                          {formatFactor(step.appliedHedgeFactor)}x
                        </td>
                        <td
                          className={`px-3 py-2.5 text-right font-mono tabular-nums ${
                            step.brokerDailyPnlUsd >= 0
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-red-600 dark:text-red-400'
                          }`}
                        >
                          {formatUsd(step.brokerDailyPnlUsd, true)}
                        </td>
                        <td
                          className={`px-3 py-2.5 text-right font-mono tabular-nums font-medium ${
                            step.brokerCumulativePnlUsd >= 0
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-red-600 dark:text-red-400'
                          }`}
                        >
                          {formatUsd(step.brokerCumulativePnlUsd, true)}
                        </td>
                        <td
                          className={`px-3 py-2.5 text-right font-mono tabular-nums font-semibold ${
                            step.combinedNetCashflowUsd >= 0
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          {formatUsd(step.combinedNetCashflowUsd, true)}
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {step.violationReason ? (
                            <span className="font-medium text-red-600 dark:text-red-400">
                              Stop: {step.violationReason}
                            </span>
                          ) : step.phaseAdvancedTo ? (
                            <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                              Avançou para {step.phaseAdvancedTo}
                              {step.phaseAdvancedTo === 'Funded' && funded101Enabled
                                ? ' (Inicia 10:1)'
                                : ''}
                            </span>
                          ) : (
                            <span className="text-slate-500 dark:text-slate-400">
                              {step.note || 'Operação regular'}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <button
                            type="button"
                            aria-label={`Remover dia ${step.dayIndex}`}
                            onClick={() => onRemoveEntry(step.entryId)}
                            className="rounded p-1 text-slate-400 hover:bg-red-500/10 hover:text-red-500"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Etapa 2 Integrated Section: Pós-Aprovação (Conta Funded · Método 10:1 / R:R Negativo) */}
      <section className="space-y-6 border-t border-slate-200 pt-8 dark:border-slate-800">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="font-display text-xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
              Pós-Aprovação: Conta Funded & Método 10:1 (Validação de Calendário)
            </h2>
            <p className="mt-1 max-w-3xl text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Englobado após concluir a avaliação: prioriza a sobrevivência até o 1º Payout com alvo curto diário (<span className="font-mono">+$100 a +$200</span>, acerto 90%+), Stop de Segurança amplo no drawdown remanescente e hedge (<span className="font-mono">L_C = L_M × F</span>) como seguro contra cisnes negros.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
              {funded101Enabled ? 'Ativo ao avançar para Funded' : 'Desativado (Meta Padrão na Funded)'}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={funded101Enabled}
              onClick={onToggleFunded101}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                funded101Enabled ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  funded101Enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
          {/* Left: Method 10:1 Parameters */}
          <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827] space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3 dark:border-slate-800">
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Parâmetros da Operação 10:1 na Funded
              </h3>
              <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                R:R 1 : {funded101Outputs.impliedNegativeRatio.toFixed(1)}
              </span>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="m5-short-target"
                  className="text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Alvo Curto Diário na Mesa (Take)
                </label>
                <div className="flex items-center gap-1">
                  {[100, 150, 200].map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => onChangeFunded101({ ...funded101Inputs, shortTargetUsd: val })}
                      className={`rounded px-2 py-0.5 font-mono text-[11px] border ${
                        funded101Inputs.shortTargetUsd === val
                          ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400'
                      }`}
                    >
                      +${val}
                    </button>
                  ))}
                </div>
              </div>
              <div className="relative mt-1.5">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                  $
                </span>
                <input
                  id="m5-short-target"
                  type="number"
                  min={25}
                  step="25"
                  value={funded101Inputs.shortTargetUsd}
                  onChange={(e) =>
                    onChangeFunded101({ ...funded101Inputs, shortTargetUsd: Number(e.target.value) })
                  }
                  className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-7 pr-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="m5-remaining-dd"
                  className="text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Stop de Segurança / DD Remanescente (USD)
                </label>
                <button
                  type="button"
                  onClick={() =>
                    onChangeFunded101({
                      ...funded101Inputs,
                      remainingDrawdownUsd: arbitrageInputs.drawdownUsd,
                    })
                  }
                  className="text-[11px] font-medium text-emerald-600 hover:underline dark:text-emerald-400"
                >
                  Sincronizar DD ({formatUsd(arbitrageInputs.drawdownUsd)})
                </button>
              </div>
              <div className="relative mt-1.5">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                  $
                </span>
                <input
                  id="m5-remaining-dd"
                  type="number"
                  min={100}
                  step="100"
                  value={funded101Inputs.remainingDrawdownUsd}
                  onChange={(e) =>
                    onChangeFunded101({
                      ...funded101Inputs,
                      remainingDrawdownUsd: Number(e.target.value),
                    })
                  }
                  className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-7 pr-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>
            </div>

            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Ativo Operado na Funded
              </span>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                {INSTRUMENT_SPECS.map((spec) => {
                  const active = spec.id === instrumentId;
                  return (
                    <button
                      key={spec.id}
                      type="button"
                      onClick={() => onChangeInstrument(spec.id)}
                      className={`rounded-md border px-2.5 py-1.5 text-left text-xs font-medium transition-colors whitespace-nowrap truncate ${
                        active
                          ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-[#0B0F17] dark:text-slate-300'
                      }`}
                    >
                      {spec.symbol}
                    </button>
                  );
                })}
              </div>
            </div>

            {instrumentId === 'CUSTOM' && (
              <div>
                <label
                  htmlFor="m5-custom-tick"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Valor do Ponto por 1.0 Lote ($)
                </label>
                <input
                  id="m5-custom-tick"
                  type="number"
                  min={0.01}
                  step="0.5"
                  value={customPointValueUsd}
                  onChange={(e) => onChangeInstrument('CUSTOM', Number(e.target.value))}
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>
            )}

            <div className="grid grid-cols-3 gap-2.5">
              <div>
                <label
                  htmlFor="m5-sl-points"
                  className="block text-[11px] font-medium text-slate-700 dark:text-slate-300"
                >
                  Stop ({selectedSpec.unitLabel})
                </label>
                <input
                  id="m5-sl-points"
                  type="number"
                  min={1}
                  step="10"
                  value={funded101Inputs.stopLossPoints}
                  onChange={(e) =>
                    onChangeFunded101({ ...funded101Inputs, stopLossPoints: Number(e.target.value) })
                  }
                  className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-slate-50 px-2.5 font-mono text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>
              <div>
                <label
                  htmlFor="m5-active-days"
                  className="block text-[11px] font-medium text-slate-700 dark:text-slate-300"
                >
                  Dias Funded
                </label>
                <input
                  id="m5-active-days"
                  type="number"
                  min={1}
                  max={30}
                  step="1"
                  value={funded101Inputs.activeDaysTarget}
                  onChange={(e) =>
                    onChangeFunded101({
                      ...funded101Inputs,
                      activeDaysTarget: Number(e.target.value),
                    })
                  }
                  className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-slate-50 px-2.5 font-mono text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>
              <div>
                <label
                  htmlFor="m5-win-rate"
                  className="block text-[11px] font-medium text-slate-700 dark:text-slate-300"
                >
                  Acerto (%)
                </label>
                <input
                  id="m5-win-rate"
                  type="number"
                  min={50}
                  max={99}
                  step="1"
                  value={funded101Inputs.statisticalWinRatePct}
                  onChange={(e) =>
                    onChangeFunded101({
                      ...funded101Inputs,
                      statisticalWinRatePct: Number(e.target.value),
                    })
                  }
                  className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-slate-50 px-2.5 font-mono text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>
            </div>

            {!funded101Outputs.isValid && funded101Outputs.validationError && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {funded101Outputs.validationError}
              </p>
            )}
          </div>

          {/* Right: Lots + Normal Day vs Failure Day Summary */}
          <div className="lg:col-span-7 space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500 dark:text-slate-400">Lote Mesa (L_M)</span>
                  <button
                    type="button"
                    onClick={() => handleCopy(formatLot(funded101Outputs.propFirmLot), 'lm')}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                  >
                    {copiedKey === 'lm' ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-500" /> Copiado
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" /> Copiar
                      </>
                    )}
                  </button>
                </div>
                <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">
                  {formatLot(funded101Outputs.propFirmLot)}
                </div>
                <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  Stop_Max ÷ ({funded101Inputs.stopLossPoints} × ${effectivePointVal})
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Lote Corretora (L_C)
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy(formatLot(funded101Outputs.brokerHedgeLot), 'lc')}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                  >
                    {copiedKey === 'lc' ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-500" /> Copiado
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" /> Copiar
                      </>
                    )}
                  </button>
                </div>
                <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {hedgeDuringFunded ? formatLot(funded101Outputs.brokerHedgeLot) : '0.00'}
                </div>
                <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  {hedgeDuringFunded
                    ? `Seguro F = ${formatFactor(hedgeFactor)}x`
                    : 'Seguro Hedge desligado na Funded'}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Take Curto ({selectedSpec.unitLabel})
                </div>
                <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">
                  {funded101Outputs.takeProfitPoints.toFixed(1)}
                </div>
                <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  Distância p/ {formatUsd(funded101Inputs.shortTargetUsd, true)}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {/* Dia Normal */}
              <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
                <div className="flex items-baseline justify-between">
                  <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                    Dia Normal (Meta Curta)
                  </h3>
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {funded101Inputs.statisticalWinRatePct}% prob.
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Alvo de {funded101Outputs.takeProfitPoints.toFixed(1)} {selectedSpec.unitLabel} batido rapidamente para validar 1 dia ativo.
                </p>

                <dl className="mt-4 space-y-2 text-xs sm:text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-600 dark:text-slate-400">Ganho na Mesa</dt>
                    <dd className="font-mono font-medium text-emerald-600 dark:text-emerald-400">
                      {formatUsd(funded101Outputs.normalDay.mesaGainUsd, true)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-600 dark:text-slate-400">Custo de Hedge</dt>
                    <dd className="font-mono font-medium text-red-600 dark:text-red-400">
                      {hedgeDuringFunded ? formatUsd(funded101Outputs.normalDay.hedgeCostUsd) : '$0,00'}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-600 dark:text-slate-400">
                      Líquido/Dia (Split {arbitrageInputs.profitSplitPct}%)
                    </dt>
                    <dd className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                      {formatUsd(
                        hedgeDuringFunded
                          ? funded101Outputs.normalDay.netAfterSplitUsd
                          : funded101Outputs.normalDay.mesaGainUsd *
                              (arbitrageInputs.profitSplitPct / 100),
                        true
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between border-t border-slate-200 pt-2.5 text-xs dark:border-slate-800">
                    <dt className="font-semibold text-slate-900 dark:text-slate-100">
                      Em {funded101Inputs.activeDaysTarget} Dias Normais
                    </dt>
                    <dd className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                      {formatUsd(funded101Outputs.normalDay.calendarMesaTotalUsd, true)} mesa
                    </dd>
                  </div>
                </dl>
              </div>

              {/* Dia de Falha */}
              <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
                <div className="flex items-baseline justify-between">
                  <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                    Dia de Falha (Cisne Negro)
                  </h3>
                  <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                    {hedgeDuringFunded ? 'Seguro acionado' : 'Sem seguro'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Drawdown atingido na mesa; com hedge ativo, o take oposto na corretora cobre a operação.
                </p>

                <dl className="mt-4 space-y-2 text-xs sm:text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-600 dark:text-slate-400">
                      {(arbitrageInputs.hedgeFactorMode ?? 'include_dd') === 'fee_only'
                        ? 'DD na Mesa (Virtual)'
                        : 'Perda na Mesa'}
                    </dt>
                    <dd
                      className={`font-mono font-medium ${
                        (arbitrageInputs.hedgeFactorMode ?? 'include_dd') === 'fee_only'
                          ? 'text-slate-500 dark:text-slate-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {(arbitrageInputs.hedgeFactorMode ?? 'include_dd') === 'fee_only'
                        ? '$0,00'
                        : formatUsd(funded101Outputs.failureDay.mesaLossUsd)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-600 dark:text-slate-400">Take do Seguro (L_C)</dt>
                    <dd className="font-mono font-medium text-emerald-600 dark:text-emerald-400">
                      {hedgeDuringFunded
                        ? formatUsd(funded101Outputs.failureDay.brokerInsuranceGainUsd, true)
                        : '$0,00'}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-600 dark:text-slate-400">Líquido (Sem Taxa)</dt>
                    <dd className="font-mono font-medium text-emerald-600 dark:text-emerald-400">
                      {hedgeDuringFunded
                        ? formatUsd(funded101Outputs.failureDay.netBeforeFeeUsd, true)
                        : formatUsd(funded101Outputs.failureDay.mesaLossUsd)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between border-t border-slate-200 pt-2.5 text-xs dark:border-slate-800">
                    <dt className="font-semibold text-slate-900 dark:text-slate-100">
                      Líquido Final (Após Taxa T)
                    </dt>
                    <dd
                      className={`font-mono font-bold ${
                        (hedgeDuringFunded
                          ? funded101Outputs.failureDay.netAfterFeeUsd
                          : funded101Outputs.failureDay.mesaLossUsd -
                            arbitrageInputs.evaluationFeeUsd) >= 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {formatUsd(
                        hedgeDuringFunded
                          ? funded101Outputs.failureDay.netAfterFeeUsd
                          : funded101Outputs.failureDay.mesaLossUsd -
                              arbitrageInputs.evaluationFeeUsd,
                        true
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
