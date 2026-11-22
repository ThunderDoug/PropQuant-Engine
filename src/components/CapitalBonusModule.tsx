import { AlertTriangle, MessageSquare, ShieldAlert } from 'lucide-react';
import {
  BonusPresetType,
  CapitalBonusInputs,
  CapitalBonusOutputs,
  ConsultIntent,
  MarginCalculationBasis,
} from '../types/quant';
import { formatFactor, formatUsd } from '../utils/quantEngine';

interface CapitalBonusModuleProps {
  inputs: CapitalBonusInputs;
  outputs: CapitalBonusOutputs;
  drawdownUsd: number;
  hedgeFactor: number;
  onChange: (next: CapitalBonusInputs) => void;
  onConsultIntent: (intent: ConsultIntent, prompt: string) => void;
}

export function CapitalBonusModule({
  inputs,
  outputs,
  drawdownUsd,
  hedgeFactor,
  onChange,
  onConsultIntent,
}: CapitalBonusModuleProps) {
  const realCoverageInsufficient = outputs.realCoverageInsufficient;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50 sm:text-3xl text-balance">
            Otimizador de Capital Próprio e Bônus de Depósito
          </h1>
          <p className="mt-1.5 max-w-3xl text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            Determine a equidade total necessária na corretora pessoal para suportar a variação máxima do hedge com amortecimento de margem e compare a redução de desembolso com créditos de bônus (50% ou 100%).
          </p>
        </div>

        <button
          type="button"
          onClick={() =>
            onConsultIntent(
              'C',
              `Analise o risco de Auto Stop-Out para esta estrutura de capital: Equidade necessária $${outputs.requiredEquityUsd.toFixed(2)}, Depósito real $${outputs.realDepositUsd.toFixed(2)}, Bônus ${outputs.bonusCreditPct}% e perda máxima de hedge em aprovação vs. stop.`
            )
          }
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
        >
          <MessageSquare className="h-3.5 w-3.5 text-emerald-500" />
          Avaliar Risco de Stop-Out com IA
        </button>
      </div>

      {/* Mandatory Operational Warning */}
      <div
        role="alert"
        className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-5 text-amber-900 dark:text-amber-200"
      >
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1 text-sm leading-relaxed">
            <div className="font-display font-semibold">
              Alerta Operacional Obrigatório — Regra de Auto Stop-Out do Bônus
            </div>
            <p className="text-xs sm:text-sm text-amber-800 dark:text-amber-300/90">
              O crédito de bônus é cancelado automaticamente pela corretora caso o seu saldo em dinheiro real (<span className="font-mono">Balance Real</span>) seja zerado por perdas flutuantes. O capital depositado em dinheiro vivo (<span className="font-mono font-semibold">{formatUsd(outputs.realDepositUsd)}</span>) deve sempre cobrir a perda flutuante máxima projetada da operação na corretora, utilizando o crédito apenas como margem livre adicional.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Configuration Panel */}
        <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
          <div className="flex items-center justify-between border-b border-slate-200 pb-4 dark:border-slate-800">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Parâmetros de Margem e Bônus
            </h2>
            <span className="font-mono text-xs text-slate-500 dark:text-slate-400">Módulo 3</span>
          </div>

          <div className="mt-5 space-y-5">
            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Base de Cálculo da Equidade Necessária
              </span>
              <div className="mt-2 grid grid-cols-1 gap-2">
                {(
                  [
                    {
                      id: 'dd_buffer_15',
                      title: 'Drawdown × F × 1.15 (Amortecimento 15%)',
                      formula: `${formatUsd(drawdownUsd)} × ${formatFactor(hedgeFactor)} × 1.15`,
                    },
                    {
                      id: 'phase1_buffer_10',
                      title: 'Meta Fase 1 × F × 1.10 (Amortecimento 10%)',
                      formula: `${formatUsd(inputs.phase1TargetUsd)} × ${formatFactor(hedgeFactor)} × 1.10`,
                    },
                  ] as const
                ).map((opt) => {
                  const active = inputs.basis === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() =>
                        onChange({ ...inputs, basis: opt.id as MarginCalculationBasis })
                      }
                      className={`rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
                        active
                          ? 'border-emerald-500 bg-emerald-500/10'
                          : 'border-slate-200 bg-slate-50 hover:border-slate-300 dark:border-slate-800 dark:bg-[#0B0F17] dark:hover:border-slate-700'
                      }`}
                    >
                      <div
                        className={`text-xs font-semibold ${
                          active
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : 'text-slate-800 dark:text-slate-200'
                        }`}
                      >
                        {opt.title}
                      </div>
                      <div className="mt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {opt.formula}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {inputs.basis === 'phase1_buffer_10' && (
              <div>
                <label
                  htmlFor="input-phase1-target"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Meta da Fase 1 (USD)
                </label>
                <div className="relative mt-1.5">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                    $
                  </span>
                  <input
                    id="input-phase1-target"
                    type="number"
                    min={100}
                    step="100"
                    value={inputs.phase1TargetUsd}
                    onChange={(e) =>
                      onChange({ ...inputs, phase1TargetUsd: Number(e.target.value) })
                    }
                    className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-7 pr-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                  />
                </div>
              </div>
            )}

            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Estrutura de Bônus de Depósito
              </span>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {(
                  [
                    { id: 'none', label: 'Sem Bônus (0%)' },
                    { id: 'bonus_50', label: '50% (ex: Vantage)' },
                    { id: 'bonus_100', label: '100% (ex: Switch)' },
                    { id: 'custom', label: 'Personalizado (%)' },
                  ] as const
                ).map((preset) => {
                  const active = inputs.bonusType === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() =>
                        onChange({ ...inputs, bonusType: preset.id as BonusPresetType })
                      }
                      className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap truncate ${
                        active
                          ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 dark:border-slate-800 dark:bg-[#0B0F17] dark:text-slate-300 dark:hover:border-slate-700'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {inputs.bonusType === 'custom' && (
              <div>
                <label
                  htmlFor="input-custom-bonus"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Percentual de Bônus Customizado (%)
                </label>
                <div className="relative mt-1.5">
                  <input
                    id="input-custom-bonus"
                    type="number"
                    min={0}
                    max={200}
                    step="5"
                    value={inputs.customBonusPct}
                    onChange={(e) =>
                      onChange({ ...inputs, customBonusPct: Number(e.target.value) })
                    }
                    className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-3 pr-8 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                    %
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Output Summary & Comparison */}
        <div className="lg:col-span-7 space-y-6">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Equidade Total Necessária
              </div>
              <div className="mt-2 font-mono text-2xl font-bold text-slate-900 dark:text-slate-50">
                {formatUsd(outputs.requiredEquityUsd)}
              </div>
              <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                Margem + amortecimento
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Depósito Real Exigido
              </div>
              <div className="mt-2 font-mono text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                {formatUsd(outputs.realDepositUsd)}
              </div>
              <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                Desembolso em caixa
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Crédito de Bônus ({outputs.bonusCreditPct}%)
              </div>
              <div className="mt-2 font-mono text-2xl font-bold text-slate-900 dark:text-slate-50">
                {formatUsd(outputs.bonusCreditUsd)}
              </div>
              <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                Margem de crédito
              </div>
            </div>
          </div>

          {/* Comparative Table */}
          <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
            <div className="border-b border-slate-200 px-6 py-4 dark:border-slate-800">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Comparativo de Eficiência de Capital por Modalidade
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="px-6 py-3">Modalidade na Corretora</th>
                    <th className="px-6 py-3 text-right">Fórmula</th>
                    <th className="px-6 py-3 text-right">Depósito Real</th>
                    <th className="px-6 py-3 text-right">Crédito Adicional</th>
                    <th className="px-6 py-3 text-right">Economia de Caixa</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80">
                  {[
                    {
                      label: 'Sem Bônus (Conta Pura)',
                      formula: 'Equidade / 1.0',
                      deposit: outputs.comparison.noBonusDeposit,
                      credit: outputs.comparison.noBonusCredit,
                      savings: outputs.comparison.noBonusSavings,
                      isActive: inputs.bonusType === 'none',
                    },
                    {
                      label: 'Bônus 50% (ex: Vantage Markets)',
                      formula: 'Equidade / 1.5',
                      deposit: outputs.comparison.bonus50Deposit,
                      credit: outputs.comparison.bonus50Credit,
                      savings: outputs.comparison.bonus50Savings,
                      isActive: inputs.bonusType === 'bonus_50',
                    },
                    {
                      label: 'Bônus 100% (ex: Switch Markets)',
                      formula: 'Equidade / 2.0',
                      deposit: outputs.comparison.bonus100Deposit,
                      credit: outputs.comparison.bonus100Credit,
                      savings: outputs.comparison.bonus100Savings,
                      isActive: inputs.bonusType === 'bonus_100',
                    },
                  ].map((row) => (
                    <tr
                      key={row.label}
                      className={
                        row.isActive
                          ? 'bg-emerald-500/5 font-medium'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }
                    >
                      <td className="px-6 py-3 text-slate-900 dark:text-slate-100">{row.label}</td>
                      <td className="px-6 py-3 text-right font-mono text-xs text-slate-500 dark:text-slate-400">
                        {row.formula}
                      </td>
                      <td className="px-6 py-3 text-right font-mono text-slate-900 dark:text-slate-100">
                        {formatUsd(row.deposit)}
                      </td>
                      <td className="px-6 py-3 text-right font-mono text-slate-600 dark:text-slate-300">
                        {formatUsd(row.credit)}
                      </td>
                      <td className="px-6 py-3 text-right font-mono text-emerald-600 dark:text-emerald-400">
                        {row.savings > 0 ? formatUsd(row.savings, true) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Floating Loss Safety Check */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Verificação de Sobrevivência a Flutuação Máxima (Auto Stop-Out)
            </h3>
            <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Caso a mesa avance até a meta da Fase 1 (<span className="font-mono">{formatUsd(inputs.phase1TargetUsd)}</span>), a perda acumulada esperada no hedge da corretora será de aproximadamente{' '}
              <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                {formatUsd(inputs.phase1TargetUsd * hedgeFactor)}
              </span>
              . Compare este valor com o seu saldo real depositado ({formatUsd(outputs.realDepositUsd)}) antes de alocar bônus agressivos.
            </p>

            {realCoverageInsufficient && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Atenção: o depósito em dinheiro real ({formatUsd(outputs.realDepositUsd)}) está abaixo de 100% do risco cheio de hedge (<span className="font-mono">{formatUsd(drawdownUsd * hedgeFactor)}</span>). Certifique-se de que a alavancagem e o fatiamento das metas não zere o saldo real antes do bônus atuar.
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
