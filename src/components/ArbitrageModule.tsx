import { ArrowRight, Calculator, MessageSquare } from 'lucide-react';
import { ArbitrageInputs, ArbitrageOutputs, ConsultIntent, HedgeFactorMode } from '../types/quant';
import { formatFactor, formatUsd } from '../utils/quantEngine';

interface ArbitrageModuleProps {
  inputs: ArbitrageInputs;
  outputs: ArbitrageOutputs;
  onChange: (next: ArbitrageInputs) => void;
  onConsultIntent: (intent: ConsultIntent, prompt: string) => void;
}

export function ArbitrageModule({
  inputs,
  outputs,
  onChange,
  onConsultIntent,
}: ArbitrageModuleProps) {
  const updateField = <K extends keyof ArbitrageInputs>(key: K, value: ArbitrageInputs[K]) => {
    onChange({ ...inputs, [key]: value });
  };

  // Build SVG Payoff Sensitivity Curve from -DD (Reprovação) to +Meta_Total (Aprovação)
  const dd = Math.max(1, inputs.drawdownUsd);
  const target = Math.max(1, inputs.totalTargetUsd);
  const f = outputs.isValid ? outputs.hedgeFactor : 1;

  const isFeeOnly = (inputs.hedgeFactorMode ?? 'include_dd') === 'fee_only';

  // Curve points: X goes from -DD (Stop na Mesa) to +Meta_Total (Aprovação na Mesa)
  const steps = 16;
  const xMin = -dd;
  const xMax = target;
  const points = Array.from({ length: steps + 1 }, (_, i) => {
    const mesaExcursion = xMin + ((xMax - xMin) * i) / steps;
    const hedgePnl = -mesaExcursion * f;
    // Em modo 'fee_only', o DD da mesa é virtual (sem saída real de caixa antes do payout),
    // então o fluxo líquido real até o stop é hedgePnl - T (em -DD, resulta em +L_adic).
    const combinedFloating = isFeeOnly
      ? hedgePnl - inputs.evaluationFeeUsd
      : mesaExcursion + hedgePnl - inputs.evaluationFeeUsd;
    return { mesaExcursion, hedgePnl, combinedFloating };
  });

  const allValues = points.flatMap((p) => [p.mesaExcursion, p.hedgePnl, p.combinedFloating]);
  const yMin = Math.min(...allValues, -dd * 1.1);
  const yMax = Math.max(...allValues, dd * f * 1.1);
  const yRange = Math.max(1, yMax - yMin);

  const svgWidth = 640;
  const svgHeight = 220;
  const padX = 48;
  const padY = 20;
  const innerW = svgWidth - padX * 2;
  const innerH = svgHeight - padY * 2;

  const toX = (val: number) => padX + ((val - xMin) / (xMax - xMin)) * innerW;
  const toY = (val: number) => padY + ((yMax - val) / yRange) * innerH;
  const zeroY = toY(0);

  const buildPolyline = (selector: (p: (typeof points)[number]) => number) =>
    points.map((p) => `${toX(p.mesaExcursion).toFixed(1)},${toY(selector(p)).toFixed(1)}`).join(' ');

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50 sm:text-3xl text-balance">
            Motor de Arbitragem e Hedging Assimétrico
          </h1>
          <p className="mt-1.5 max-w-3xl text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            Calcule o Fator de Proteção (<span className="font-mono">F</span>) para proteger a taxa de inscrição e garantir lucro líquido (<span className="font-mono">+L_adic</span>) caso o limite de drawdown da mesa seja atingido, além de projetar o retorno líquido nos saques após aprovação.
          </p>
        </div>

        <button
          type="button"
          onClick={() =>
            onConsultIntent(
              'A',
              'Execute uma auditoria quantitativa completa desta simulação de arbitragem (Cenário A e Cenário B), avaliando se o Fator de Hedge e o ponto de equilíbrio estão saudáveis.'
            )
          }
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
        >
          <MessageSquare className="h-3.5 w-3.5 text-emerald-500" />
          Auditar Cenário com IA
        </button>
      </div>

      {!outputs.isValid && outputs.validationError && (
        <div
          role="alert"
          className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300"
        >
          {outputs.validationError}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Input Parameters Column */}
        <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
          <div className="flex items-center justify-between border-b border-slate-200 pb-4 dark:border-slate-800">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Parâmetros da Avaliação e Hedge
            </h2>
            <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
              Módulo 1
            </span>
          </div>

          {/* Hedge Factor Mode Selector */}
          <div className="mt-5">
            <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Composição do Fator de Proteção (F)
            </span>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(
                [
                  {
                    id: 'include_dd',
                    title: 'DD + T + L_adic',
                    subtitle: 'Cobertura total (inclui DD)',
                  },
                  {
                    id: 'fee_only',
                    title: 'Só T + L_adic',
                    subtitle: 'Caixa real (DD virtual)',
                  },
                ] as const
              ).map((mode) => {
                const active = (inputs.hedgeFactorMode ?? 'include_dd') === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => updateField('hedgeFactorMode', mode.id as HedgeFactorMode)}
                    className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                      active
                        ? 'border-emerald-500 bg-emerald-500/10'
                        : 'border-slate-200 bg-slate-50 hover:border-slate-300 dark:border-slate-800 dark:bg-[#0B0F17] dark:hover:border-slate-700'
                    }`}
                  >
                    <div
                      className={`font-mono text-xs font-semibold ${
                        active
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : 'text-slate-800 dark:text-slate-200'
                      }`}
                    >
                      {mode.title}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                      {mode.subtitle}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="input-dd"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Drawdown Total da Mesa (DD)
              </label>
              <div className="relative mt-1.5">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                  $
                </span>
                <input
                  id="input-dd"
                  type="number"
                  min={1}
                  step="50"
                  value={inputs.drawdownUsd}
                  onChange={(e) => updateField('drawdownUsd', Number(e.target.value))}
                  className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-7 pr-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100 dark:focus:bg-[#0B0F17]"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="input-fee"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Taxa de Inscrição (T)
              </label>
              <div className="relative mt-1.5">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                  $
                </span>
                <input
                  id="input-fee"
                  type="number"
                  min={0}
                  step="10"
                  value={inputs.evaluationFeeUsd}
                  onChange={(e) => updateField('evaluationFeeUsd', Number(e.target.value))}
                  className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-7 pr-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="input-ladic"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Lucro Adicional no Stop (L_adic)
              </label>
              <div className="relative mt-1.5">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                  $
                </span>
                <input
                  id="input-ladic"
                  type="number"
                  min={0}
                  step="25"
                  value={inputs.additionalProfitUsd}
                  onChange={(e) => updateField('additionalProfitUsd', Number(e.target.value))}
                  className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-7 pr-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="input-meta-total"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Meta Total Avaliação (Meta_Total)
              </label>
              <div className="relative mt-1.5">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                  $
                </span>
                <input
                  id="input-meta-total"
                  type="number"
                  min={0}
                  step="100"
                  value={inputs.totalTargetUsd}
                  onChange={(e) => updateField('totalTargetUsd', Number(e.target.value))}
                  className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-7 pr-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="input-lucro-gerado"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Lucro Gerado na Conta Funded
              </label>
              <div className="relative mt-1.5">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                  $
                </span>
                <input
                  id="input-lucro-gerado"
                  type="number"
                  min={0}
                  step="250"
                  value={inputs.payoutGrossProfitUsd}
                  onChange={(e) => updateField('payoutGrossProfitUsd', Number(e.target.value))}
                  className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-7 pr-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="input-split"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Profit Split da Mesa (%)
              </label>
              <div className="relative mt-1.5">
                <input
                  id="input-split"
                  type="number"
                  min={1}
                  max={100}
                  step="5"
                  value={inputs.profitSplitPct}
                  onChange={(e) => updateField('profitSplitPct', Number(e.target.value))}
                  className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-3 pr-8 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                  %
                </span>
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-4 dark:border-slate-800">
            <label
              htmlFor="toggle-refund"
              className="text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Reembolso da taxa (+T) no 1º payout
            </label>
            <button
              id="toggle-refund"
              type="button"
              role="switch"
              aria-checked={inputs.refundOnFirstPayout}
              onClick={() => updateField('refundOnFirstPayout', !inputs.refundOnFirstPayout)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                inputs.refundOnFirstPayout
                  ? 'bg-emerald-600'
                  : 'bg-slate-300 dark:bg-slate-700'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  inputs.refundOnFirstPayout ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Transparent Formula Strip */}
          <div className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-800">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
              <Calculator className="h-3.5 w-3.5" />
              Fórmula do Fator de Proteção de Hedge ({isFeeOnly ? 'Só T + L_adic' : 'Com DD'})
            </div>
            <div className="mt-2 font-mono text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
              {isFeeOnly ? (
                <>
                  F = (T + L_adic) / DD = ({formatUsd(inputs.evaluationFeeUsd)} +{' '}
                  {formatUsd(inputs.additionalProfitUsd)}) / {formatUsd(inputs.drawdownUsd)} ={' '}
                </>
              ) : (
                <>
                  F = (DD + T + L_adic) / DD = ({formatUsd(inputs.drawdownUsd)} +{' '}
                  {formatUsd(inputs.evaluationFeeUsd)} + {formatUsd(inputs.additionalProfitUsd)}) /{' '}
                  {formatUsd(inputs.drawdownUsd)} ={' '}
                </>
              )}
              <strong className="text-emerald-600 dark:text-emerald-400">
                {formatFactor(outputs.hedgeFactor)}
              </strong>
            </div>
          </div>
        </div>

        {/* Outputs & Scenarios Column */}
        <div className="lg:col-span-7 space-y-6">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {/* Cenário A */}
            <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
              <div className="flex items-baseline justify-between">
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                  Cenário A — Reprovação na Mesa
                </h3>
                <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  Stop atingido
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                A conta da mesa é reprovada no limite de drawdown; o ganho oposto na corretora cobre o prejuízo e a taxa.
              </p>

              <dl className="mt-5 space-y-2.5 text-sm">
                <div className="flex items-center justify-between">
                  <dt className="text-slate-600 dark:text-slate-400">
                    {isFeeOnly ? 'Drawdown na Mesa (Virtual)' : 'Perda na Mesa (-DD)'}
                  </dt>
                  <dd
                    className={`font-mono font-medium ${
                      isFeeOnly
                        ? 'text-slate-500 dark:text-slate-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {isFeeOnly ? '$0,00' : formatUsd(outputs.scenarioA.propFirmLoss)}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-slate-600 dark:text-slate-400">Custo da Taxa (-T)</dt>
                  <dd className="font-mono font-medium text-red-600 dark:text-red-400">
                    {formatUsd(outputs.scenarioA.feeCost)}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-slate-600 dark:text-slate-400">Ganho na Corretora (DD × F)</dt>
                  <dd className="font-mono font-medium text-emerald-600 dark:text-emerald-400">
                    {formatUsd(outputs.scenarioA.brokerGain, true)}
                  </dd>
                </div>
                <div className="flex items-center justify-between border-t border-slate-200 pt-3 dark:border-slate-800">
                  <dt className="font-semibold text-slate-900 dark:text-slate-100">
                    Resultado Líquido Final
                  </dt>
                  <dd className="font-mono text-lg font-bold text-emerald-600 dark:text-emerald-400">
                    {formatUsd(outputs.scenarioA.netResult, true)}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Cenário B */}
            <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
              <div className="flex items-baseline justify-between">
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                  Cenário B — Aprovação e Payout
                </h3>
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Split {inputs.profitSplitPct}%
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Meta batida na mesa gera perda proporcional no hedge da corretora durante as fases de avaliação.
              </p>

              <dl className="mt-5 space-y-2.5 text-sm">
                <div className="flex items-center justify-between">
                  <dt className="text-slate-600 dark:text-slate-400">Hedge Acumulado (-Meta × F)</dt>
                  <dd className="font-mono font-medium text-red-600 dark:text-red-400">
                    {formatUsd(-outputs.scenarioB.accumulatedHedgeLoss)}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-slate-600 dark:text-slate-400">Payout Bruto da Mesa</dt>
                  <dd className="font-mono font-medium text-emerald-600 dark:text-emerald-400">
                    {formatUsd(outputs.scenarioB.grossPayout, true)}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-slate-600 dark:text-slate-400">Reembolso da Taxa (+T)</dt>
                  <dd className="font-mono font-medium text-slate-700 dark:text-slate-300">
                    {formatUsd(outputs.scenarioB.feeRefund, true)}
                  </dd>
                </div>
                <div className="flex items-center justify-between border-t border-slate-200 pt-3 dark:border-slate-800">
                  <dt className="font-semibold text-slate-900 dark:text-slate-100">
                    Líquido no 1º Payout
                  </dt>
                  <dd
                    className={`font-mono text-lg font-bold ${
                      outputs.scenarioB.firstPayoutNet >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {formatUsd(outputs.scenarioB.firstPayoutNet, true)}
                  </dd>
                </div>
                <div className="flex items-center justify-between pt-1 text-xs">
                  <dt className="text-slate-500 dark:text-slate-400">Payouts Seguintes (Puros)</dt>
                  <dd className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                    {formatUsd(outputs.scenarioB.subsequentPayoutNet, true)}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Break-even & Payoff Sensitivity Chart */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 pb-4 dark:border-slate-800">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                  Curva de Exposição Assimétrica (Mesa vs. Hedge)
                </h3>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Break-even do 1º saque exige{' '}
                  <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                    {formatUsd(outputs.scenarioB.breakEvenProfitNeeded)}
                  </span>{' '}
                  de lucro bruto na conta financiada.
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-3 bg-emerald-500 inline-block" /> Hedge Corretora
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-3 bg-slate-400 inline-block" /> Mesa Prop
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-3 bg-amber-500 inline-block" /> Líquido Combinado
                </span>
              </div>
            </div>

            <div className="mt-4 overflow-x-auto">
              <svg
                viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                className="w-full min-w-[480px] h-auto"
                role="img"
                aria-label="Gráfico comparativo de exposição entre Mesa Proprietária, Corretora Hedge e Resultado Líquido"
              >
                {/* Zero baseline */}
                <line
                  x1={padX}
                  y1={zeroY}
                  x2={svgWidth - padX}
                  y2={zeroY}
                  stroke="currentColor"
                  className="text-slate-300 dark:text-slate-700"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                />
                {/* Vertical axis at 0 excursion */}
                {xMin < 0 && xMax > 0 && (
                  <line
                    x1={toX(0)}
                    y1={padY}
                    x2={toX(0)}
                    y2={svgHeight - padY}
                    stroke="currentColor"
                    className="text-slate-200 dark:text-slate-800"
                    strokeWidth={1}
                  />
                )}

                {/* Mesa line */}
                <polyline
                  fill="none"
                  stroke="#94A3B8"
                  strokeWidth={1.75}
                  points={buildPolyline((p) => p.mesaExcursion)}
                />

                {/* Hedge line */}
                <polyline
                  fill="none"
                  stroke="#10B981"
                  strokeWidth={2.25}
                  points={buildPolyline((p) => p.hedgePnl)}
                />

                {/* Combined Net line */}
                <polyline
                  fill="none"
                  stroke="#F59E0B"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                  points={buildPolyline((p) => p.combinedFloating)}
                />

                {/* Labels */}
                <text
                  x={padX}
                  y={svgHeight - 4}
                  className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
                >
                  Stop (-DD: {formatUsd(-dd)})
                </text>
                <text
                  x={svgWidth - padX}
                  y={svgHeight - 4}
                  textAnchor="end"
                  className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
                >
                  Meta (+{formatUsd(target)})
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

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
              <span>
                No Cenário A (-DD), o ganho de{' '}
                <strong className="font-mono text-emerald-600 dark:text-emerald-400">
                  {formatUsd(outputs.scenarioA.brokerGain)}
                </strong>{' '}
                {isFeeOnly
                  ? 'cobre integralmente a taxa de inscrição (DD virtual), deixando '
                  : 'absorve integralmente o drawdown e a taxa, deixando '}
                <strong className="font-mono text-emerald-600 dark:text-emerald-400">
                  {formatUsd(outputs.scenarioA.netResult, true)}
                </strong>
                .
              </span>
              <span className="inline-flex items-center gap-1 font-medium text-slate-700 dark:text-slate-300">
                Fator aplicado aos lotes <ArrowRight className="h-3 w-3" />{' '}
                <span className="font-mono">{formatFactor(outputs.hedgeFactor)}x</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
