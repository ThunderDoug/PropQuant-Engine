import { Check, Copy, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { INSTRUMENT_SPECS } from '../data/propFirms2026';
import {
  ConsultIntent,
  InstrumentId,
  TradeSizingInputs,
  TradeSizingOutputs,
} from '../types/quant';
import { formatFactor, formatLot, formatUsd } from '../utils/quantEngine';

interface TradeSizingModuleProps {
  inputs: TradeSizingInputs;
  outputs: TradeSizingOutputs;
  hedgeFactor: number;
  onChange: (next: TradeSizingInputs) => void;
  onConsultIntent: (intent: ConsultIntent, prompt: string) => void;
}

export function TradeSizingModule({
  inputs,
  outputs,
  hedgeFactor,
  onChange,
  onConsultIntent,
}: TradeSizingModuleProps) {
  const [copiedKey, setCopiedKey] = useState<'lm' | 'lc' | null>(null);

  const selectedSpec =
    INSTRUMENT_SPECS.find((spec) => spec.id === inputs.instrumentId) ?? INSTRUMENT_SPECS[0];

  const handleCopy = async (val: string, key: 'lm' | 'lc') => {
    try {
      await navigator.clipboard.writeText(val);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      // Clipboard fallback not critical
    }
  };

  // Sensitivity rows around the user's stop loss
  const stopMultipliers = [0.5, 0.75, 1, 1.25, 1.5, 2];

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50 sm:text-3xl text-balance">
            Dimensionamento Trade-a-Trade
          </h1>
          <p className="mt-1.5 max-w-3xl text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            Converta risco financeiro em lotes exatos para MetaTrader ou NinjaTrader em índices americanos, ouro e pares de Forex, sincronizando o lote da Mesa (<span className="font-mono">L_M</span>) com a ponta oposta na Corretora (<span className="font-mono">L_C = L_M × F</span>).
          </p>
        </div>

        <button
          type="button"
          onClick={() =>
            onConsultIntent(
              'B',
              `Valide o dimensionamento trade-a-trade atual para ${selectedSpec.label} com Stop Loss de ${inputs.stopLossPoints} ${selectedSpec.unitLabel} e risco de $${inputs.desiredRiskUsd}, confirmando especificações de contrato e risco de slippage.`
            )
          }
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
        >
          <MessageSquare className="h-3.5 w-3.5 text-emerald-500" />
          Validar Ordem com IA
        </button>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Controls */}
        <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
          <div className="flex items-center justify-between border-b border-slate-200 pb-4 dark:border-slate-800">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Parâmetros da Operação
            </h2>
            <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
              Módulo 2
            </span>
          </div>

          <div className="mt-5 space-y-4">
            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Ativo / Contrato Standard
              </span>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {INSTRUMENT_SPECS.map((spec) => {
                  const active = spec.id === inputs.instrumentId;
                  return (
                    <button
                      key={spec.id}
                      type="button"
                      onClick={() => onChange({ ...inputs, instrumentId: spec.id as InstrumentId })}
                      className={`rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors whitespace-nowrap truncate ${
                        active
                          ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 dark:border-slate-800 dark:bg-[#0B0F17] dark:text-slate-300 dark:hover:border-slate-700'
                      }`}
                    >
                      {spec.symbol}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {selectedSpec.description}
              </p>
            </div>

            {inputs.instrumentId === 'CUSTOM' && (
              <div>
                <label
                  htmlFor="input-custom-tick"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Valor do Ponto / Tick por 1.0 Lote ($)
                </label>
                <div className="relative mt-1.5">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                    $
                  </span>
                  <input
                    id="input-custom-tick"
                    type="number"
                    min={0.01}
                    step="0.5"
                    value={inputs.customPointValueUsd}
                    onChange={(e) =>
                      onChange({ ...inputs, customPointValueUsd: Number(e.target.value) })
                    }
                    className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-7 pr-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="input-risk-usd"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Risco Desejado na Mesa (USD)
                </label>
                <div className="relative mt-1.5">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                    $
                  </span>
                  <input
                    id="input-risk-usd"
                    type="number"
                    min={1}
                    step="50"
                    value={inputs.desiredRiskUsd}
                    onChange={(e) =>
                      onChange({ ...inputs, desiredRiskUsd: Number(e.target.value) })
                    }
                    className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 pl-7 pr-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="input-sl-points"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Stop Loss ({selectedSpec.unitLabel})
                </label>
                <input
                  id="input-sl-points"
                  type="number"
                  min={0.1}
                  step="1"
                  value={inputs.stopLossPoints}
                  onChange={(e) =>
                    onChange({ ...inputs, stopLossPoints: Number(e.target.value) })
                  }
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>
            </div>

            {!outputs.isValid && outputs.validationError && (
              <p className="text-xs text-red-600 dark:text-red-400">{outputs.validationError}</p>
            )}

            <div className="border-t border-slate-200 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
              Nota: Caso sua corretora utilize microlotes de índices ou especificações diferentes de contrato, selecione{' '}
              <strong className="text-slate-700 dark:text-slate-200">CUSTOM</strong> e informe o Tick Value exato da plataforma.
            </div>
          </div>
        </div>

        {/* Outputs & Conversion Matrix */}
        <div className="lg:col-span-7 space-y-6">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Lote na Mesa Proprietária (L_M)
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy(formatLot(outputs.propFirmLot), 'lm')}
                  className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
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
              <div className="mt-3 font-mono text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                {formatLot(outputs.propFirmLot)}{' '}
                <span className="text-sm font-normal text-slate-500 dark:text-slate-400">lotes</span>
              </div>
              <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                Exposição por ponto/pip:{' '}
                <span className="font-mono text-slate-800 dark:text-slate-200">
                  {formatUsd(outputs.riskPerPointUsd)}
                </span>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Lote Oposto na Corretora (L_C)
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy(formatLot(outputs.brokerHedgeLot), 'lc')}
                  className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
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
              <div className="mt-3 font-mono text-4xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
                {formatLot(outputs.brokerHedgeLot)}{' '}
                <span className="text-sm font-normal text-slate-500 dark:text-slate-400">lotes</span>
              </div>
              <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                Multiplicador aplicado:{' '}
                <span className="font-mono text-slate-800 dark:text-slate-200">
                  F = {formatFactor(hedgeFactor)}x
                </span>
              </div>
            </div>
          </div>

          {/* Stop Loss Sensitivity Matrix */}
          <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
            <div className="border-b border-slate-200 px-6 py-4 dark:border-slate-800">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Grade de Sensibilidade de Lotes por Distância de Stop
              </h3>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Mantendo o risco fixo de {formatUsd(inputs.desiredRiskUsd)} em {selectedSpec.label}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="px-6 py-3">Stop Loss ({selectedSpec.unitLabel})</th>
                    <th className="px-6 py-3 text-right">Lote Mesa (L_M)</th>
                    <th className="px-6 py-3 text-right">Lote Hedge (L_C)</th>
                    <th className="px-6 py-3 text-right">Risco Mesa</th>
                    <th className="px-6 py-3 text-right">Retorno Hedge no Stop</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80">
                  {stopMultipliers.map((mult) => {
                    const sl = Math.max(0.5, Number((inputs.stopLossPoints * mult).toFixed(1)));
                    const lm =
                      outputs.effectivePointValueUsd > 0
                        ? inputs.desiredRiskUsd / (sl * outputs.effectivePointValueUsd)
                        : 0;
                    const lc = lm * hedgeFactor;
                    const hedgeReturn = inputs.desiredRiskUsd * hedgeFactor;
                    const isCurrent = mult === 1;
                    return (
                      <tr
                        key={mult}
                        className={
                          isCurrent
                            ? 'bg-emerald-500/5 font-medium'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                        }
                      >
                        <td className="px-6 py-2.5 font-mono text-slate-900 dark:text-slate-100">
                          {sl.toFixed(1)} {isCurrent && <span className="ml-2 text-xs font-sans text-emerald-600 dark:text-emerald-400">(Atual)</span>}
                        </td>
                        <td className="px-6 py-2.5 text-right font-mono text-slate-800 dark:text-slate-200">
                          {formatLot(lm)}
                        </td>
                        <td className="px-6 py-2.5 text-right font-mono text-emerald-600 dark:text-emerald-400">
                          {formatLot(lc)}
                        </td>
                        <td className="px-6 py-2.5 text-right font-mono text-red-600 dark:text-red-400">
                          {formatUsd(-inputs.desiredRiskUsd)}
                        </td>
                        <td className="px-6 py-2.5 text-right font-mono text-emerald-600 dark:text-emerald-400">
                          {formatUsd(hedgeReturn, true)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Standard Conversion Reference Table */}
          <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
            <div className="border-b border-slate-200 px-6 py-4 dark:border-slate-800">
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Tabela de Conversão de Contratos CFDs Standard
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="px-6 py-2.5">Instrumento</th>
                    <th className="px-6 py-2.5">Unidade</th>
                    <th className="px-6 py-2.5 text-right">Valor por 1.0 Lote</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80">
                  {INSTRUMENT_SPECS.filter((s) => s.id !== 'CUSTOM').map((spec) => (
                    <tr key={spec.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-6 py-2.5 font-medium text-slate-800 dark:text-slate-200">
                        {spec.label}
                      </td>
                      <td className="px-6 py-2.5 text-slate-600 dark:text-slate-400">
                        1.0 {spec.unitLabel}
                      </td>
                      <td className="px-6 py-2.5 text-right font-mono text-slate-900 dark:text-slate-100">
                        {formatUsd(spec.pointValuePerStandardLot)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
