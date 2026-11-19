import { WorkspaceSection } from '../types/quant';

interface HeaderProps {
  activeSection: WorkspaceSection;
  onSelectSection: (section: WorkspaceSection) => void;
  onOpenConsultant: () => void;
}

const NAV_ITEMS: Array<{ id: WorkspaceSection; label: string }> = [
  { id: 'arbitrage', label: 'Arbitragem' },
  { id: 'sizing', label: 'Trade-a-Trade' },
  { id: 'capital', label: 'Capital & Bônus' },
  { id: 'daily', label: 'Simulador Diário' },
  { id: 'montecarlo', label: 'Monte Carlo' },
  { id: 'firms', label: 'Mesas & Histórico' },
];

export function Header({ activeSection, onSelectSection, onOpenConsultant }: HeaderProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm dark:border-slate-800/90 dark:bg-[#090D16]/95">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-4 py-3 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={() => onSelectSection('arbitrage')}
          className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          PropQuant Engine
        </button>

        <nav
          aria-label="Módulos principais"
          className="hidden md:flex items-center gap-6 text-sm font-medium"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectSection(item.id)}
                className={`relative py-1.5 whitespace-nowrap shrink-0 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-500 ${
                  isActive
                    ? 'text-slate-950 dark:text-white'
                    : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 -bottom-[13px] h-0.5 bg-emerald-600 dark:bg-emerald-500"
                  />
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onOpenConsultant}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition-colors duration-150 hover:bg-emerald-500 active:scale-[0.99] whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
          >
            Consultor IA
          </button>
        </div>
      </div>

      <nav
        aria-label="Módulos móveis"
        className="flex md:hidden items-center gap-4 overflow-x-auto border-t border-slate-200 px-4 py-2 text-xs font-medium dark:border-slate-800/80"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectSection(item.id)}
              className={`py-1 whitespace-nowrap shrink-0 transition-colors ${
                isActive
                  ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
