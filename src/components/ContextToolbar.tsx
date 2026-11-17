import { BookmarkPlus, Check, Moon, Sun, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { PropFirmPreset, ThemeMode } from '../types/quant';
import { formatFactor, formatLot, formatUsd } from '../utils/quantEngine';

interface ContextToolbarProps {
  firms: PropFirmPreset[];
  selectedFirmId: string;
  onSelectFirm: (firmId: string) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onSaveSimulation: () => void;
  hedgeFactor: number;
  propFirmLot: number;
  brokerHedgeLot: number;
  realDepositUsd: number;
}

export function ContextToolbar({
  firms,
  selectedFirmId,
  onSelectFirm,
  theme,
  onToggleTheme,
  onSaveSimulation,
  hedgeFactor,
  propFirmLot,
  brokerHedgeLot,
  realDepositUsd,
}: ContextToolbarProps) {
  const [savedFeedback, setSavedFeedback] = useState(false);
  const activeFirm = firms.find((f) => f.id === selectedFirmId) ?? firms[0];

  const firmNames = Array.from(new Set(firms.map((f) => f.name)));
  const selectedCompanyName = activeFirm?.name ?? firmNames[0] ?? '';
  const plansForCompany = firms.filter((f) => f.name === selectedCompanyName);

  const handleSelectCompany = (companyName: string) => {
    const firstPlan = firms.find((f) => f.name === companyName);
    if (firstPlan) {
      onSelectFirm(firstPlan.id);
    }
  };

  const handleSave = () => {
    onSaveSimulation();
    setSavedFeedback(true);
    window.setTimeout(() => setSavedFeedback(false), 1800);
  };

  return (
    <section
      aria-label="Barra de contexto da simulação"
      className="border-b border-slate-200 bg-slate-100/70 dark:border-slate-800/80 dark:bg-[#0D1320]"
    >
      <div className="mx-auto flex max-w-[1440px] flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1 min-w-[180px] sm:min-w-[200px]">
            <label
              htmlFor="active-firm-company-select"
              className="text-xs font-medium text-slate-500 dark:text-slate-400"
            >
              Prop Firm
            </label>
            <select
              id="active-firm-company-select"
              value={selectedCompanyName}
              onChange={(e) => handleSelectCompany(e.target.value)}
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 transition-colors focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100"
            >
              {firmNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1 min-w-[210px] sm:min-w-[250px]">
            <label
              htmlFor="active-plan-select"
              className="text-xs font-medium text-slate-500 dark:text-slate-400"
            >
              Plano ({plansForCompany.length})
            </label>
            <select
              id="active-plan-select"
              value={activeFirm?.id ?? ''}
              onChange={(e) => onSelectFirm(e.target.value)}
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 transition-colors focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100"
            >
              {plansForCompany.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.model} ({plan.drawdownType})
                </option>
              ))}
            </select>
          </div>

          {activeFirm && (
            <div className="flex items-center gap-2 pb-2.5 text-xs text-slate-600 dark:text-slate-400">
              <span>{activeFirm.category}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{formatUsd(activeFirm.accountSize)}</span>
              <span aria-hidden="true">·</span>
              <span
                className={
                  activeFirm.viability === 'Ideal'
                    ? 'font-medium text-emerald-600 dark:text-emerald-400'
                    : activeFirm.viability === 'Moderada'
                    ? 'font-medium text-amber-600 dark:text-amber-400'
                    : 'font-medium text-red-600 dark:text-red-400'
                }
              >
                {activeFirm.viability}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-4 lg:gap-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-6">
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400">Fator de Hedge (F)</div>
              <div className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-50">
                {formatFactor(hedgeFactor)}x
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400">Lote Mesa (L_M)</div>
              <div className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-50">
                {formatLot(propFirmLot)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400">Lote Corretora (L_C)</div>
              <div className="font-mono text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                {formatLot(brokerHedgeLot)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400">Depósito Real</div>
              <div className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-50">
                {formatUsd(realDepositUsd)}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-[#111827] dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              {savedFeedback ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                  Salvo no histórico
                </>
              ) : (
                <>
                  <BookmarkPlus className="h-3.5 w-3.5" />
                  Salvar simulação
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro'}
              title={theme === 'dark' ? 'Alternar para modo claro' : 'Alternar para modo escuro'}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-[#111827] dark:text-slate-200 dark:hover:bg-slate-800 shrink-0"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      {activeFirm?.operationalAlert && (
        <div
          role="alert"
          className={`border-t px-4 py-2.5 sm:px-6 lg:px-8 ${
            activeFirm.viability === 'Incompatível'
              ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300'
          }`}
        >
          <div className="mx-auto flex max-w-[1440px] items-start gap-2.5 text-xs leading-relaxed">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong className="font-semibold">{activeFirm.name}:</strong>{' '}
              {activeFirm.operationalAlert}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
