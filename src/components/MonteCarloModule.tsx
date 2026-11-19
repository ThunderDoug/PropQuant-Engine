import {
  Activity,
  Dices,
  MessageSquare,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  ArbitrageInputs,
  ConsultIntent,
  FundedMethod101Inputs,
  MonteCarloSummary,
  PropFirmPreset,
  RandomSizingMode,
} from '../types/quant';
import {
  formatFactor,
  formatUsd,
  runMonteCarloSimulation,
} from '../utils/quantEngine';

interface MonteCarloModuleProps {
  firm: PropFirmPreset;
  arbitrageInputs: ArbitrageInputs;
  hedgeFactor: number;
  desiredRiskUsd: number;
  hedgeDuringFunded: boolean;
  onToggleHedgeDuringFunded: () => void;
  protectDoubleLoss: boolean;
  onToggleProtectDoubleLoss: () => void;
  funded101Enabled: boolean;
  onToggleFunded101: () => void;
  funded101Inputs: FundedMethod101Inputs;
  onChangeFunded101: (next: FundedMethod101Inputs) => void;
  onSummaryChange?: (summary: MonteCarloSummary) => void;
  onConsultIntent: (intent: ConsultIntent, prompt: string) => void;
}

const RUN_COUNTS = [500, 1000, 2500, 5000] as const;

export function MonteCarloModule({
  firm,
  arbitrageInputs,
  hedgeFactor,
  desiredRiskUsd,
  hedgeDuringFunded,
  onToggleHedgeDuringFunded,
  protectDoubleLoss,
  onToggleProtectDoubleLoss,
  funded101Enabled,
  onToggleFunded101,
  funded101Inputs,
  onChangeFunded101,
  onSummaryChange,
  onConsultIntent,
}: MonteCarloModuleProps) {
  const [numRuns, setNumRuns] = useState<number>(1000);
  const [sizingMode, setSizingMode] = useState<RandomSizingMode>('dd_max_meta_dias');
  const [winRatePct, setWinRatePct] = useState<number>(58);
  const [rewardToRisk, setRewardToRisk] = useState<number>(0.75);
  const [minDaysDivisor, setMinDaysDivisor] = useState<number>(Math.max(1, firm.minTradingDays));
  const [runNonce, setRunNonce] = useState<number>(1);
  const [hoveredBinIndex, setHoveredBinIndex] = useState<number | null>(null);

  useEffect(() => {
    setMinDaysDivisor(Math.max(1, firm.minTradingDays));
  }, [firm.id, firm.minTradingDays]);

  const summary = useMemo(() => {
    void runNonce;
    return runMonteCarloSimulation(firm, arbitrageInputs, hedgeFactor, {
      numRuns,
      sizingMode,
      winRatePct,
      rewardToRisk,
      minDaysDivisor: Math.max(1, minDaysDivisor),
      baseRiskUsd: desiredRiskUsd,
      hedgeDuringFunded,
      funded101Enabled,
      fundedShortTargetUsd: funded101Inputs.shortTargetUsd,
      fundedWinRatePct: funded101Inputs.statisticalWinRatePct,
      fundedActiveDaysTarget: funded101Inputs.activeDaysTarget,
      fundedStopMaxUsd: funded101Inputs.remainingDrawdownUsd,
      protectDoubleLoss,
    });
  }, [
    runNonce,
    firm,
    arbitrageInputs,
    hedgeFactor,
    numRuns,
    sizingMode,
    winRatePct,
    rewardToRisk,
    minDaysDivisor,
    desiredRiskUsd,
    hedgeDuringFunded,
    funded101Enabled,
    funded101Inputs.shortTargetUsd,
    funded101Inputs.statisticalWinRatePct,
    funded101Inputs.activeDaysTarget,
    funded101Inputs.remainingDrawdownUsd,
    protectDoubleLoss,
  ]);

  useEffect(() => {
    onSummaryChange?.(summary);
  }, [summary, onSummaryChange]);

  // SVG Fan Chart Geometry
  const fanW = 720;
  const fanH = 250;
  const padX = 56;
  const padY = 22;
  const innerW = fanW - padX * 2;
  const innerH = fanH - padY * 2;

  const allY = [
    0,
    ...summary.samplePaths.flatMap((p) => p.points),
    ...summary.percentilesByDay.flatMap((d) => [d.p10, d.p50, d.p90]),
  ];
  const yMin = Math.min(...allY);
  const yMax = Math.max(100, ...allY);
  const ySpan = Math.max(1, yMax - yMin);
  const maxDay = Math.max(1, summary.percentilesByDay.length);

  const toX = (day: number) =>
    maxDay === 1 ? padX : padX + ((day - 1) / (maxDay - 1)) * innerW;
  const toY = (val: number) => padY + ((yMax - val) / ySpan) * innerH;
  const zeroY = toY(0);

  const buildCurve = (pts: number[]) =>
    pts.map((v, idx) => `${toX(idx + 1).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');

  const p10Curve = summary.percentilesByDay
    .map((p) => `${toX(p.day).toFixed(1)},${toY(p.p10).toFixed(1)}`)
    .join(' ');
  const p50Curve = summary.percentilesByDay
    .map((p) => `${toX(p.day).toFixed(1)},${toY(p.p50).toFixed(1)}`)
    .join(' ');
  const p90Curve = summary.percentilesByDay
    .map((p) => `${toX(p.day).toFixed(1)},${toY(p.p90).toFixed(1)}`)
    .join(' ');

  const p10p90BandPath =
    summary.percentilesByDay.length > 1
      ? [
          `M ${summary.percentilesByDay
            .map((p) => `${toX(p.day).toFixed(1)} ${toY(p.p90).toFixed(1)}`)
            .join(' L ')}`,
          `L ${[...summary.percentilesByDay]
            .reverse()
            .map((p) => `${toX(p.day).toFixed(1)} ${toY(p.p10).toFixed(1)}`)
            .join(' L ')}`,
          'Z',
        ].join(' ')
      : '';

  const maxHistCount = Math.max(1, ...summary.histogram.map((b) => b.count));

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50 sm:text-3xl text-balance">
            Simulação de Monte Carlo (Estresse Probabilístico)
          </h1>
          <p className="mt-1.5 max-w-3xl text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            Executa{' '}
            <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">
              {numRuns.toLocaleString('pt-BR')}
            </span>{' '}
            jornadas completas aleatórias na mesa{' '}
            <span className="font-semibold">{firm.name} ({firm.model})</span>, aplicando exatamente
            as regras de drawdown ({firm.drawdownType}), consistência, hedge na corretora e transição
            pós-aprovação{funded101Enabled ? ' via Método 10:1' : ''}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setRunNonce((n) => n + 1)}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 active:scale-[0.99] whitespace-nowrap shrink-0"
          >
            <Dices className="h-4 w-4" />
            Gerar Nova Amostra ({numRuns.toLocaleString('pt-BR')}x)
          </button>

          <button
            type="button"
            onClick={() =>
              onConsultIntent(
                'A',
                `Audite esta simulação Monte Carlo (${summary.numRuns} rodadas) para a mesa ${firm.name} (${firm.model}): Taxa de 1º Payout ${summary.payoutSuccessRatePct.toFixed(1)}%, Passam da Avaliação ${summary.evalPassRatePct.toFixed(1)}%, Valor Esperado (EV) ${formatUsd(summary.expectedNetUsd, true)}, Mediana P50 ${formatUsd(summary.medianNetUsd, true)}, P10 ${formatUsd(summary.p10NetUsd, true)}, P90 ${formatUsd(summary.p90NetUsd, true)}, Probabilidade de resultado < $0 de ${summary.negativeOutcomeRatePct.toFixed(1)}% e Capital Real P95 exigido na corretora de ${formatUsd(summary.p95MaxBrokerOutlayUsd)}. Proteção Anti-Loss Duplo: ${protectDoubleLoss ? 'ATIVA' : 'DESATIVADA'}. Funded 10:1: ${funded101Enabled ? `ATIVO (alvo ${formatUsd(funded101Inputs.shortTargetUsd)}, win ${funded101Inputs.statisticalWinRatePct}%)` : 'DESATIVADO'}. Avalie se a estratégia tem expectativa matemática positiva e onde estão os maiores riscos.`
              )
            }
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <MessageSquare className="h-3.5 w-3.5 text-emerald-500" />
            Auditar Monte Carlo com IA
          </button>
        </div>
      </div>

      {/* 4-Column KPI Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Taxa de Sucesso até 1º Payout
          </div>
          <div className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
            {summary.payoutSuccessRatePct.toFixed(1)}%
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Passam da Avaliação:{' '}
            <span className="font-mono font-medium text-slate-700 dark:text-slate-200">
              {summary.evalPassRatePct.toFixed(1)}%
            </span>{' '}
            · Stop: <span className="font-mono">{summary.stopOutRatePct.toFixed(1)}%</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Valor Esperado (EV Médio)
          </div>
          <div
            className={`mt-1.5 font-mono text-2xl font-bold tabular-nums ${
              summary.expectedNetUsd >= 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-amber-600 dark:text-amber-400'
            }`}
          >
            {formatUsd(summary.expectedNetUsd, true)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Mediana (P50):{' '}
            <span className="font-mono font-medium text-slate-700 dark:text-slate-200">
              {formatUsd(summary.medianNetUsd, true)}
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Intervalo P10 — P90 (Líquido)
          </div>
          <div className="mt-1.5 font-mono text-lg font-bold tabular-nums text-slate-900 dark:text-slate-50">
            {formatUsd(summary.p10NetUsd, true)}{' '}
            <span className="text-slate-400 font-normal">a</span>{' '}
            {formatUsd(summary.p90NetUsd, true)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Saídas negativas (&lt;$0):{' '}
            <span
              className={`font-mono font-medium ${
                summary.negativeOutcomeRatePct <= 5
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-400'
              }`}
            >
              {summary.negativeOutcomeRatePct.toFixed(1)}%
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Desembolso Real P95 (Taxa + Corretora)
          </div>
          <div className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">
            {formatUsd(summary.p95MaxBrokerOutlayUsd)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Médio:{' '}
            <span className="font-mono">{formatUsd(summary.avgMaxBrokerOutlayUsd)}</span> ·{' '}
            <span className="font-mono">{summary.avgDaysToFinish.toFixed(1)}d</span> duração
          </div>
        </div>
      </div>

      {/* Main Grid: Parameters (4 cols) + Visual Analytics (8 cols) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left: Simulation Controls */}
        <div className="lg:col-span-4 space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827] space-y-5">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Parâmetros Estocásticos
              </h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Qualquer ajuste recalcula imediatamente toda a distribuição probabilística.
              </p>
            </div>

            {/* Number of runs */}
            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Quantidade de Jornadas (N)
              </span>
              <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                {RUN_COUNTS.map((count) => {
                  const active = numRuns === count;
                  return (
                    <button
                      key={count}
                      type="button"
                      onClick={() => setNumRuns(count)}
                      className={`h-9 rounded-lg border font-mono text-xs font-semibold transition-colors ${
                        active
                          ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 dark:border-slate-800 dark:bg-[#0B0F17] dark:text-slate-400'
                      }`}
                    >
                      {count.toLocaleString('pt-BR')}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Stage 1: Evaluation Rules */}
            <div className="border-t border-slate-200 pt-4 dark:border-slate-800 space-y-3">
              <span className="block text-xs font-semibold text-slate-800 dark:text-slate-200">
                Etapa 1 · Avaliação (Fase 1 / 2)
              </span>

              <div className="grid grid-cols-2 gap-1.5">
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

              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label
                    htmlFor="mc-win-rate"
                    className="block text-[11px] text-slate-500 dark:text-slate-400"
                  >
                    Win Rate (%)
                  </label>
                  <input
                    id="mc-win-rate"
                    type="number"
                    min={10}
                    max={95}
                    step={2}
                    value={winRatePct}
                    onChange={(e) => setWinRatePct(Number(e.target.value))}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-slate-50 px-2 font-mono text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                  />
                </div>
                <div>
                  <label
                    htmlFor="mc-rr"
                    className="block text-[11px] text-slate-500 dark:text-slate-400"
                  >
                    Risco/Retorno
                  </label>
                  <input
                    id="mc-rr"
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
                    htmlFor="mc-days-divisor"
                    className="block text-[11px] text-slate-500 dark:text-slate-400"
                  >
                    Dias p/ TP
                  </label>
                  <input
                    id="mc-days-divisor"
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
            </div>

            {/* Stage 2: Funded 10:1 & Anti-Double-Loss */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-3 dark:border-slate-800 dark:bg-[#0B0F17]">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                    Etapa 2 · Funded 10:1 Automático
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    Assume após passar na avaliação
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={funded101Enabled}
                  aria-label="Ativar Método 10:1 na fase Funded"
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

              {funded101Enabled && (
                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                  <div>
                    <label
                      htmlFor="mc-101-target"
                      className="block text-[10px] text-slate-500 dark:text-slate-400"
                    >
                      TP Prop Firm ($)
                    </label>
                    <input
                      id="mc-101-target"
                      type="number"
                      min={50}
                      max={1000}
                      step={25}
                      value={funded101Inputs.shortTargetUsd}
                      onChange={(e) =>
                        onChangeFunded101({
                          ...funded101Inputs,
                          shortTargetUsd: Number(e.target.value),
                        })
                      }
                      className="mt-1 h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="mc-101-sl"
                      className="block text-[10px] text-slate-500 dark:text-slate-400"
                    >
                      SL Prop Firm (1:10) ($)
                    </label>
                    <input
                      id="mc-101-sl"
                      type="number"
                      min={100}
                      step={100}
                      value={funded101Inputs.remainingDrawdownUsd}
                      onChange={(e) =>
                        onChangeFunded101({
                          ...funded101Inputs,
                          remainingDrawdownUsd: Number(e.target.value),
                        })
                      }
                      className="mt-1 h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="mc-101-win"
                      className="block text-[10px] text-slate-500 dark:text-slate-400"
                    >
                      Win Funded (%)
                    </label>
                    <input
                      id="mc-101-win"
                      type="number"
                      min={50}
                      max={99}
                      step={1}
                      value={funded101Inputs.statisticalWinRatePct}
                      onChange={(e) =>
                        onChangeFunded101({
                          ...funded101Inputs,
                          statisticalWinRatePct: Number(e.target.value),
                        })
                      }
                      className="mt-1 h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="mc-101-days"
                      className="block text-[10px] text-slate-500 dark:text-slate-400"
                    >
                      Dias Ativos
                    </label>
                    <input
                      id="mc-101-days"
                      type="number"
                      min={1}
                      max={30}
                      step={1}
                      value={funded101Inputs.activeDaysTarget}
                      onChange={(e) =>
                        onChangeFunded101({
                          ...funded101Inputs,
                          activeDaysTarget: Number(e.target.value),
                        })
                      }
                      className="mt-1 h-8 w-full rounded border border-slate-300 bg-white px-2 font-mono text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100"
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <span className="text-[11px] text-slate-600 dark:text-slate-300">
                  Seguro Hedge na Funded
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={hedgeDuringFunded}
                  aria-label="Ativar hedge na fase Funded"
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

              <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <div>
                  <span className="block text-[11px] font-medium text-slate-700 dark:text-slate-200">
                    Proteção Anti-Loss Duplo (F Dinâmico)
                  </span>
                  <span className="block text-[10px] text-slate-500 dark:text-slate-400">
                    Zera risco de prejuízo simultâneo na mesa e corretora
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={protectDoubleLoss}
                  aria-label="Ativar proteção anti-loss duplo"
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

            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-[#0B0F17] dark:text-slate-400 flex items-center justify-between">
              <span>Fator Base (F):</span>
              <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                {formatFactor(hedgeFactor)}x
              </span>
            </div>
          </div>
        </div>

        {/* Right: Fan Chart + Histogram + Outcome Breakdown */}
        <div className="lg:col-span-8 space-y-6">
          {/* Fan Chart */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-emerald-500" />
                  Cone de Patrimônio Líquido (P10 / Mediana P50 / P90)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Evolução diária do caixa consolidado (Mesa + Corretora − Taxa) em{' '}
                  {summary.samplePaths.length} trajetórias representativas.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-[11px]">
                <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <span className="h-2 w-3 rounded-sm bg-emerald-500" />
                  P90
                </span>
                <span className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-200">
                  <span className="h-2 w-3 rounded-sm bg-sky-500" />
                  Mediana (P50)
                </span>
                <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                  <span className="h-2 w-3 rounded-sm bg-amber-500" />
                  P10
                </span>
              </div>
            </div>

            <div className="mt-4 overflow-x-auto">
              <svg
                viewBox={`0 0 ${fanW} ${fanH}`}
                className="w-full min-w-[540px]"
                role="img"
                aria-label="Gráfico de cone Monte Carlo com percentis P10, P50 e P90"
              >
                {/* Horizontal Reference Lines */}
                {[yMax, (yMax + yMin) / 2, yMin].map((val, idx) => (
                  <g key={idx}>
                    <line
                      x1={padX}
                      x2={fanW - padX}
                      y1={toY(val)}
                      y2={toY(val)}
                      className="stroke-slate-200 dark:stroke-slate-800"
                      strokeWidth={1}
                    />
                    <text
                      x={padX - 6}
                      y={toY(val) + 3}
                      textAnchor="end"
                      className="fill-slate-400 font-mono text-[10px]"
                    >
                      {val >= 0 ? `+$${Math.round(val)}` : `-$${Math.round(Math.abs(val))}`}
                    </text>
                  </g>
                ))}

                {/* Zero Baseline */}
                {zeroY >= padY && zeroY <= fanH - padY && (
                  <line
                    x1={padX}
                    x2={fanW - padX}
                    y1={zeroY}
                    y2={zeroY}
                    stroke="#64748b"
                    strokeDasharray="4 4"
                    strokeWidth={1.2}
                  />
                )}

                {/* Shaded P10-P90 Fan */}
                {p10p90BandPath && (
                  <path
                    d={p10p90BandPath}
                    fill="#10b981"
                    fillOpacity={0.09}
                  />
                )}

                {/* Sample trajectories */}
                {summary.samplePaths.map((path) => (
                  <polyline
                    key={path.id}
                    fill="none"
                    stroke={
                      path.outcome === 'Aprovado para Saque'
                        ? '#10b981'
                        : path.outcome === 'Reprovado (Stop)'
                        ? '#f59e0b'
                        : '#94a3b8'
                    }
                    strokeOpacity={0.28}
                    strokeWidth={1.2}
                    points={buildCurve(path.points)}
                  />
                ))}

                {/* Percentile Lines */}
                <polyline
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  points={p10Curve}
                />
                <polyline
                  fill="none"
                  stroke="#0ea5e9"
                  strokeWidth={2.5}
                  points={p50Curve}
                />
                <polyline
                  fill="none"
                  stroke="#10b981"
                  strokeWidth={2.2}
                  points={p90Curve}
                />

                {/* Day axis labels */}
                {[1, Math.ceil(maxDay / 2), maxDay].map((dayVal, idx) => (
                  <text
                    key={idx}
                    x={toX(dayVal)}
                    y={fanH - 4}
                    textAnchor="middle"
                    className="fill-slate-400 font-mono text-[10px]"
                  >
                    D{dayVal}
                  </text>
                ))}
              </svg>
            </div>
          </div>

          {/* Histogram Distribution */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                  <Activity className="h-4 w-4 text-sky-500" />
                  Distribuição dos Resultados Finais ($ USD)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Mínimo observado:{' '}
                  <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                    {formatUsd(summary.minNetUsd, true)}
                  </span>{' '}
                  · Máximo observado:{' '}
                  <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                    {formatUsd(summary.maxNetUsd, true)}
                  </span>
                </p>
              </div>
              {hoveredBinIndex !== null && summary.histogram[hoveredBinIndex] && (
                <div className="font-mono text-xs text-slate-700 dark:text-slate-200">
                  Faixa {formatUsd(summary.histogram[hoveredBinIndex].minUsd, true)} a{' '}
                  {formatUsd(summary.histogram[hoveredBinIndex].maxUsd, true)}:{' '}
                  <strong>{summary.histogram[hoveredBinIndex].count}</strong> (
                  {summary.histogram[hoveredBinIndex].pct.toFixed(1)}%)
                </div>
              )}
            </div>

            <div className="mt-5 grid grid-cols-9 gap-2 items-end h-40">
              {summary.histogram.map((bin, idx) => {
                const barHeightPct = Math.max(4, (bin.count / maxHistCount) * 100);
                const mid = (bin.minUsd + bin.maxUsd) / 2;
                const isPositive = mid >= 0;
                return (
                  <div
                    key={idx}
                    onMouseEnter={() => setHoveredBinIndex(idx)}
                    onMouseLeave={() => setHoveredBinIndex(null)}
                    className="flex h-full flex-col items-center justify-end gap-1.5 group cursor-default"
                  >
                    <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                      {bin.pct >= 1 ? `${bin.pct.toFixed(0)}%` : bin.count > 0 ? '<1%' : '0%'}
                    </span>
                    <div className="w-full flex-1 flex items-end">
                      <div
                        style={{ height: `${barHeightPct}%` }}
                        className={`w-full rounded-t-md transition-opacity ${
                          isPositive
                            ? 'bg-emerald-500/80 group-hover:bg-emerald-500'
                            : 'bg-amber-500/80 group-hover:bg-amber-500'
                        }`}
                      />
                    </div>
                    <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400 truncate max-w-full">
                      {bin.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Outcome Breakdown Table */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden dark:border-slate-800 dark:bg-[#111827]">
            <div className="border-b border-slate-200 px-6 py-4 dark:border-slate-800 flex items-center justify-between">
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-500" />
                Detalhamento por Desfecho ({summary.numRuns.toLocaleString('pt-BR')} Simulações)
              </h2>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Anti-Loss Duplo:{' '}
                <strong className={protectDoubleLoss ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                  {protectDoubleLoss ? 'Ativo' : 'Desativado'}
                </strong>
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-500 dark:bg-[#0B0F17] dark:text-slate-400">
                  <tr>
                    <th className="px-6 py-3 font-medium">Desfecho</th>
                    <th className="px-4 py-3 font-medium text-right">Jornadas</th>
                    <th className="px-4 py-3 font-medium text-right">Probabilidade</th>
                    <th className="px-6 py-3 font-medium text-right">Resultado Médio / Leitura</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  <tr>
                    <td className="px-6 py-3.5 font-semibold text-emerald-600 dark:text-emerald-400">
                      1º Payout Concluído (Cenário B)
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                      {summary.payoutCount.toLocaleString('pt-BR')}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
                      {summary.payoutSuccessRatePct.toFixed(1)}%
                    </td>
                    <td className="px-6 py-3.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                      {summary.payoutCount > 0 ? formatUsd(summary.avgPayoutNetUsd, true) : '—'}
                    </td>
                  </tr>

                  <tr>
                    <td className="px-6 py-3.5 font-semibold text-slate-800 dark:text-slate-200">
                      Stop na Avaliação (Fase 1 / 2 · Cenário A)
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                      {summary.stopInEvalCount.toLocaleString('pt-BR')}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {((summary.stopInEvalCount / summary.numRuns) * 100).toFixed(1)}%
                    </td>
                    <td className="px-6 py-3.5 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {summary.stopInEvalCount + summary.stopInFundedCount > 0
                        ? formatUsd(summary.avgStopNetUsd, true)
                        : '—'}
                    </td>
                  </tr>

                  <tr>
                    <td className="px-6 py-3.5 font-semibold text-amber-600 dark:text-amber-400">
                      Stop na Conta Funded (Cisne Negro)
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                      {summary.stopInFundedCount.toLocaleString('pt-BR')}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-amber-600 dark:text-amber-400">
                      {((summary.stopInFundedCount / summary.numRuns) * 100).toFixed(1)}%
                    </td>
                    <td className="px-6 py-3.5 text-right text-slate-500 dark:text-slate-400">
                      {protectDoubleLoss
                        ? 'Coberto por F dinâmico'
                        : hedgeDuringFunded
                        ? 'Risco de Trailing/Split sem ajuste F'
                        : 'Sem hedge na Funded'}
                    </td>
                  </tr>

                  {summary.incompleteCount > 0 && (
                    <tr>
                      <td className="px-6 py-3.5 font-medium text-slate-500 dark:text-slate-400">
                        Em Andamento (acima de 50 dias)
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        {summary.incompleteCount.toLocaleString('pt-BR')}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        {((summary.incompleteCount / summary.numRuns) * 100).toFixed(1)}%
                      </td>
                      <td className="px-6 py-3.5 text-right text-slate-500 dark:text-slate-400">
                        Jornada lenta / consistência
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
