import {
  AlertTriangle,
  Download,
  Edit3,
  MessageSquare,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import {
  ArbitrageViability,
  ConsultIntent,
  DrawdownType,
  PropFirmCategory,
  PropFirmPreset,
  SavedSimulation,
} from '../types/quant';
import { exportSimulationsToCsv, formatFactor, formatLot, formatUsd } from '../utils/quantEngine';

interface PropFirmsModuleProps {
  firms: PropFirmPreset[];
  selectedFirmId: string;
  onApplyFirm: (firm: PropFirmPreset) => void;
  onSaveFirm: (firm: PropFirmPreset) => void;
  onDeleteFirm: (firmId: string) => void;
  onResetFirms: () => void;
  simulations: SavedSimulation[];
  onLoadSimulation: (sim: SavedSimulation) => void;
  onDeleteSimulation: (simId: string) => void;
  onClearSimulations: () => void;
  onConsultIntent: (intent: ConsultIntent, prompt: string) => void;
}

const EMPTY_FIRM: PropFirmPreset = {
  id: '',
  name: '',
  model: '',
  category: 'CFD / Forex',
  accountSize: 100000,
  phase1TargetUsd: 8000,
  phase2TargetUsd: 5000,
  dailyLossLimitUsd: 5000,
  maxDrawdownUsd: 10000,
  drawdownType: 'Estático',
  minTradingDays: 0,
  profitSplitPct: 80,
  consistencyRulePct: null,
  evaluationFeeUsd: 400,
  refundOnFirstPayout: true,
  viability: 'Ideal',
  rulesSummary: '',
  operationalAlert: '',
  isCustom: true,
};

export function PropFirmsModule({
  firms,
  selectedFirmId,
  onApplyFirm,
  onSaveFirm,
  onDeleteFirm,
  onResetFirms,
  simulations,
  onLoadSimulation,
  onDeleteSimulation,
  onClearSimulations,
  onConsultIntent,
}: PropFirmsModuleProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'Todas' | PropFirmCategory>('Todas');
  const [companyFilter, setCompanyFilter] = useState<string>('Todas');
  const [editingFirm, setEditingFirm] = useState<PropFirmPreset | null>(null);

  const uniqueCompanies = Array.from(new Set(firms.map((f) => f.name)));

  const filteredFirms = firms.filter((firm) => {
    const matchesCategory = categoryFilter === 'Todas' || firm.category === categoryFilter;
    const matchesCompany = companyFilter === 'Todas' || firm.name === companyFilter;
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !q ||
      firm.name.toLowerCase().includes(q) ||
      firm.model.toLowerCase().includes(q) ||
      firm.drawdownType.toLowerCase().includes(q);
    return matchesCategory && matchesCompany && matchesSearch;
  });

  const handleOpenCreate = () => {
    setEditingFirm({
      ...EMPTY_FIRM,
      id: `custom-${Date.now()}`,
    });
  };

  const handleSubmitEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingFirm || !editingFirm.name.trim()) return;
    onSaveFirm(editingFirm);
    setEditingFirm(null);
  };

  const handleDownloadCsv = () => {
    if (simulations.length === 0) return;
    const csv = exportSimulationsToCsv(simulations);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `propquant-simulacoes-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadJson = () => {
    if (simulations.length === 0) return;
    const blob = new Blob([JSON.stringify(simulations, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `propquant-simulacoes-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-10">
      {/* Header & Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50 sm:text-3xl text-balance">
            Banco de Regras de Prop Firms (2026) e Histórico
          </h1>
          <p className="mt-1.5 max-w-3xl text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            Consulte, edite ou cadastre regras de mesas proprietárias para aplicar diretamente na simulação. Modelos com <strong className="text-red-600 dark:text-red-400">Trailing Intradiário</strong> são sinalizados por incompatibilidade com arbitragem.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() =>
              onConsultIntent(
                'D',
                'Compare as regras da mesa selecionada atualmente com as melhores alternativas para arbitragem em 2026 (ex: Lucid Trading, Funding Pips, FTMO), destacando riscos de consistência e drawdown.'
              )
            }
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <MessageSquare className="h-3.5 w-3.5 text-emerald-500" />
            Analisar Viabilidade com IA
          </button>

          <button
            type="button"
            onClick={handleOpenCreate}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-3.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5" />
            Nova Mesa
          </button>

          <button
            type="button"
            onClick={onResetFirms}
            title="Restaurar banco de regras padrão 2026"
            className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-[#111827] dark:text-slate-300 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Restaurar 2026
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1 rounded-lg bg-slate-200/70 p-1 dark:bg-[#111827] dark:border dark:border-slate-800 w-fit">
          {(['Todas', 'CFD / Forex', 'Futuros'] as const).map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategoryFilter(cat)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                categoryFilter === cat
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-50'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <select
            aria-label="Filtrar por Prop Firm"
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
            className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100"
          >
            <option value="Todas">Todas as Prop Firms ({uniqueCompanies.length})</option>
            {uniqueCompanies.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filtrar plano ou drawdown..."
              className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100"
            />
          </div>
        </div>
      </div>

      {/* Prop Firms Table */}
      <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
        {filteredFirms.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Nenhuma mesa encontrada para os filtros aplicados.
            </p>
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setCategoryFilter('Todas');
                setCompanyFilter('Todas');
              }}
              className="mt-3 text-xs font-semibold text-emerald-600 hover:underline dark:text-emerald-400"
            >
              Limpar filtros
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="px-5 py-3">Mesa & Modelo</th>
                  <th className="px-4 py-3 text-right">Conta</th>
                  <th className="px-4 py-3 text-right">Meta Total</th>
                  <th className="px-4 py-3 text-right">Drawdown (DD)</th>
                  <th className="px-4 py-3">Tipo de Drawdown</th>
                  <th className="px-4 py-3 text-right">Taxa (T)</th>
                  <th className="px-4 py-3 text-right">Split</th>
                  <th className="px-4 py-3">Viabilidade</th>
                  <th className="px-5 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80">
                {filteredFirms.map((firm) => {
                  const isSelected = firm.id === selectedFirmId;
                  const totalTarget = firm.phase1TargetUsd + firm.phase2TargetUsd;
                  return (
                    <tr
                      key={firm.id}
                      className={
                        isSelected
                          ? 'bg-emerald-500/5'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }
                    >
                      <td className="px-5 py-3.5">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">
                          {firm.name}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {firm.model} · {firm.category}
                          {firm.consistencyRulePct
                            ? ` · Consistência ${firm.consistencyRulePct}%`
                            : ''}
                          {firm.minTradingDays > 0 ? ` · ${firm.minTradingDays}d mín.` : ''}
                        </div>
                        {firm.viability === 'Incompatível' ? (
                          <div className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            {firm.operationalAlert || 'Distorção de pico intradiário'}
                          </div>
                        ) : (
                          firm.operationalAlert && (
                            <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300/90 max-w-md">
                              {firm.operationalAlert}
                            </div>
                          )
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-slate-800 dark:text-slate-200">
                        {formatUsd(firm.accountSize)}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-slate-800 dark:text-slate-200">
                        {formatUsd(totalTarget)}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-slate-800 dark:text-slate-200">
                        {formatUsd(firm.maxDrawdownUsd)}
                      </td>
                      <td className="px-4 py-3.5 text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">
                        {firm.drawdownType}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-slate-800 dark:text-slate-200">
                        {formatUsd(firm.evaluationFeeUsd)}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-slate-800 dark:text-slate-200">
                        {firm.profitSplitPct}%
                      </td>
                      <td className="px-4 py-3.5 text-xs font-semibold whitespace-nowrap">
                        <span
                          className={
                            firm.viability === 'Ideal'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : firm.viability === 'Moderada'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-red-600 dark:text-red-400'
                          }
                        >
                          {firm.viability}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onApplyFirm(firm)}
                            className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                              isSelected
                                ? 'bg-emerald-600 text-white'
                                : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
                            }`}
                          >
                            {isSelected ? 'Ativa' : 'Aplicar'}
                          </button>
                          <button
                            type="button"
                            aria-label={`Editar ${firm.name}`}
                            onClick={() => setEditingFirm({ ...firm })}
                            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </button>
                          {firm.isCustom && (
                            <button
                              type="button"
                              aria-label={`Excluir ${firm.name}`}
                              onClick={() => onDeleteFirm(firm.id)}
                              className="rounded-md p-1.5 text-red-500 hover:bg-red-500/10"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Saved Simulations History */}
      <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Histórico de Simulações Salvas ({simulations.length})
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Persistido localmente no navegador para comparação rápida entre setups e corretoras.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={simulations.length === 0}
              onClick={handleDownloadCsv}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5" />
              Exportar CSV
            </button>
            <button
              type="button"
              disabled={simulations.length === 0}
              onClick={handleDownloadJson}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5" />
              JSON
            </button>
            {simulations.length > 0 && (
              <button
                type="button"
                onClick={onClearSimulations}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-500/30 px-3 text-xs font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
              >
                Limpar histórico
              </button>
            )}
          </div>
        </div>

        {simulations.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Nenhuma simulação salva ainda. Ajuste os parâmetros na barra superior e clique em{' '}
              <strong className="text-slate-800 dark:text-slate-200">Salvar simulação</strong> para registrar cenários aqui.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="px-6 py-3">Data / Mesa</th>
                  <th className="px-4 py-3 text-right">Fator F</th>
                  <th className="px-4 py-3 text-right">Cenário A</th>
                  <th className="px-4 py-3 text-right">Cenário B (1º)</th>
                  <th className="px-4 py-3 text-right">L_M / L_C ({simulations[0]?.instrumentId})</th>
                  <th className="px-4 py-3 text-right">Depósito Real</th>
                  <th className="px-6 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80">
                {simulations.map((sim) => (
                  <tr key={sim.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="px-6 py-3">
                      <div className="font-medium text-slate-900 dark:text-slate-100">
                        {sim.firmName} — {sim.firmModel}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {new Date(sim.createdAt).toLocaleString('pt-BR')} · Bônus {sim.bonusPct}%
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-800 dark:text-slate-200">
                      {formatFactor(sim.hedgeFactor)}x
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-emerald-600 dark:text-emerald-400">
                      {formatUsd(sim.scenarioANet, true)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-mono ${
                        sim.scenarioBFirstNet >= 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {formatUsd(sim.scenarioBFirstNet, true)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-800 dark:text-slate-200">
                      {formatLot(sim.propFirmLot)} / {formatLot(sim.brokerHedgeLot)} ({sim.instrumentId})
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-900 dark:text-slate-100">
                      {formatUsd(sim.realDepositUsd)}
                    </td>
                    <td className="px-6 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onLoadSimulation(sim)}
                          className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          Carregar
                        </button>
                        <button
                          type="button"
                          aria-label="Excluir simulação"
                          onClick={() => onDeleteSimulation(sim.id)}
                          className="rounded-md p-1.5 text-red-500 hover:bg-red-500/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit / Create Firm Modal */}
      {editingFirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-firm-title"
        >
          <form
            onSubmit={handleSubmitEdit}
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-[#111827]"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-4 dark:border-slate-800">
              <h3
                id="edit-firm-title"
                className="font-display text-lg font-semibold text-slate-900 dark:text-slate-50"
              >
                {editingFirm.name ? `Editar Regra — ${editingFirm.name}` : 'Cadastrar Nova Mesa'}
              </h3>
              <button
                type="button"
                aria-label="Fechar modal"
                onClick={() => setEditingFirm(null)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Nome da Mesa
                </label>
                <input
                  required
                  type="text"
                  value={editingFirm.name}
                  onChange={(e) => setEditingFirm({ ...editingFirm, name: e.target.value })}
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Modelo / Plano
                </label>
                <input
                  required
                  type="text"
                  value={editingFirm.model}
                  onChange={(e) => setEditingFirm({ ...editingFirm, model: e.target.value })}
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Categoria
                </label>
                <select
                  value={editingFirm.category}
                  onChange={(e) =>
                    setEditingFirm({
                      ...editingFirm,
                      category: e.target.value as PropFirmCategory,
                    })
                  }
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                >
                  <option value="CFD / Forex">CFD / Forex</option>
                  <option value="Futuros">Futuros</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Tipo de Drawdown
                </label>
                <select
                  value={editingFirm.drawdownType}
                  onChange={(e) =>
                    setEditingFirm({
                      ...editingFirm,
                      drawdownType: e.target.value as DrawdownType,
                    })
                  }
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                >
                  <option value="Estático">Estático</option>
                  <option value="Trailing EOD">Trailing EOD</option>
                  <option value="Trailing Intradiário">Trailing Intradiário</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Tamanho da Conta ($)
                </label>
                <input
                  type="number"
                  min={1000}
                  value={editingFirm.accountSize}
                  onChange={(e) =>
                    setEditingFirm({ ...editingFirm, accountSize: Number(e.target.value) })
                  }
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Drawdown Máximo ($)
                </label>
                <input
                  type="number"
                  min={100}
                  value={editingFirm.maxDrawdownUsd}
                  onChange={(e) =>
                    setEditingFirm({ ...editingFirm, maxDrawdownUsd: Number(e.target.value) })
                  }
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Meta Fase 1 ($)
                </label>
                <input
                  type="number"
                  min={0}
                  value={editingFirm.phase1TargetUsd}
                  onChange={(e) =>
                    setEditingFirm({ ...editingFirm, phase1TargetUsd: Number(e.target.value) })
                  }
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Meta Fase 2 ($)
                </label>
                <input
                  type="number"
                  min={0}
                  value={editingFirm.phase2TargetUsd}
                  onChange={(e) =>
                    setEditingFirm({ ...editingFirm, phase2TargetUsd: Number(e.target.value) })
                  }
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Taxa de Inscrição ($)
                </label>
                <input
                  type="number"
                  min={0}
                  value={editingFirm.evaluationFeeUsd}
                  onChange={(e) =>
                    setEditingFirm({ ...editingFirm, evaluationFeeUsd: Number(e.target.value) })
                  }
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Profit Split (%)
                </label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={editingFirm.profitSplitPct}
                  onChange={(e) =>
                    setEditingFirm({ ...editingFirm, profitSplitPct: Number(e.target.value) })
                  }
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Viabilidade para Arbitragem
                </label>
                <select
                  value={editingFirm.viability}
                  onChange={(e) =>
                    setEditingFirm({
                      ...editingFirm,
                      viability: e.target.value as ArbitrageViability,
                    })
                  }
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                >
                  <option value="Ideal">Ideal</option>
                  <option value="Moderada">Moderada</option>
                  <option value="Incompatível">Incompatível</option>
                </select>
              </div>

              <div className="flex items-center gap-3 pt-6">
                <input
                  id="edit-refund"
                  type="checkbox"
                  checked={editingFirm.refundOnFirstPayout}
                  onChange={(e) =>
                    setEditingFirm({ ...editingFirm, refundOnFirstPayout: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                />
                <label
                  htmlFor="edit-refund"
                  className="text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Reembolsa taxa no 1º payout
                </label>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Resumo das Regras e Notas Contratuais
                </label>
                <textarea
                  rows={2}
                  value={editingFirm.rulesSummary}
                  onChange={(e) =>
                    setEditingFirm({ ...editingFirm, rulesSummary: e.target.value })
                  }
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Alerta Operacional (Opcional)
                </label>
                <input
                  type="text"
                  value={editingFirm.operationalAlert ?? ''}
                  onChange={(e) =>
                    setEditingFirm({ ...editingFirm, operationalAlert: e.target.value })
                  }
                  placeholder="Ex: Regra de consistência de 30% ou Trailing EOD"
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-100"
                />
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setEditingFirm(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
              >
                Salvar Regra
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
