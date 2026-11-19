# PropQuant Engine

Plataforma quantitativa para modelagem de **arbitragem de liquidez**, **hedging assimétrico**, **dimensionamento trade-a-trade**, **gestão de capital com bônus** e **simulação estocástica (dia a dia e Monte Carlo)** voltada a avaliações e contas financiadas (*Funded*) em mesas proprietárias (*Prop Firms*) de CFD/Forex e Futuros.

---

## Principais Módulos

### 1. Arbitragem & Hedging Assimétrico (`ArbitrageModule`)
Calcula o **Fator de Proteção (`F`)** entre a conta da Mesa Proprietária e a conta Hedge na corretora própria, suportando dois modos contábeis:
- **Cobertura Total (com DD):** `F = (DD + T + L_adic) / DD`
- **Caixa Real (apenas Taxa + Lucro):** `F = (T + L_adic) / DD` (considera o drawdown da avaliação como virtual, cobrindo o desembolso real da taxa `T` + lucro adicional `L_adic`)

Apresenta em tempo real:
- **Cenário A (Reprovação / Stop):** ganho na corretora cobrindo o custo da avaliação e garantindo `+L_adic`.
- **Cenário B (Aprovação e 1º Payout):** custo acumulado do hedge, reembolso de taxa (quando aplicável), ponto de equilíbrio (*break-even*) e projeção dos payouts subsequentes.
- Curva de sensibilidade de *payoff* (`-DD` até `+Meta_Total`).

### 2. Dimensionamento Trade-a-Trade (`TradeSizingModule`)
Calcula os lotes exatos para execução sincronizada entre a mesa e a corretora:
- `L_M = Risco_Desejado_USD / (Stop_Loss_Pontos * Valor_do_Ponto_por_1_Lote)`
- `L_C = L_M * F`
- Perfis prontos para **US30**, **US100**, **US500**, **EUR/USD (FX Majors)**, **XAU/USD** e ativo **Customizável**.

### 3. Capital Próprio & Bônus de Depósito (`CapitalBonusModule`)
Dimensiona a equidade necessária na conta Hedge (`DD * F * 1.15` ou `Meta_Fase1 * F * 1.10`) e compara depósitos reais com bônus de **0%**, **50%**, **100%** ou percentual customizado, destacando o limite seguro de perda flutuante diante da regra de **Auto Stop-Out**.

### 4. Simulador Diário + Modo Funded 10:1 (`DailySimulationModule`)
Simula a jornada completa **Fase 1 → Fase 2 → Conta Funded → 1º Payout**, respeitando:
- Tipos de drawdown: **Estático**, **Trailing EOD** e **Trailing Intradiário** (com pico flutuante);
- **Limite de Perda Diária** e **Regra de Consistência (%)**;
- **Proteção Anti-Loss Duplo (`F` Dinâmico):** recalcula `F` a cada dia para impedir prejuízo simultâneo na mesa e na corretora após avanço de fase ou movimentação do Trailing;
- **Pós-Aprovação · Método 10:1 / 1:10:** ao entrar em **Funded**, alterna automaticamente para operações de alvo curto na Prop Firm (ex.: `+$150` de TP e `-$1.500` de SL em proporção **1:10**) espelhadas em **10:1** na Conta Hedge (`F` ajustado para cobrir o SL, a taxa `T`, o hedge acumulado e `L_adic`), com comparativo de **Dia Normal** vs. **Dia de Falha (Cisne Negro)**.

### 5. Simulação de Monte Carlo (`MonteCarloModule`)
Executa de **500 a 5.000 jornadas aleatórias completas** aplicando as mesmas regras contratuais da mesa selecionada, gerando:
- Taxa de aprovação na avaliação e taxa de chegada ao **1º Payout**;
- **Valor Esperado (EV médio)**, **Mediana (P50)**, intervalo **P10–P90** e probabilidade de resultado negativo;
- **Desembolso Real P95** estimado (taxa + fluxo negativo máximo na corretora);
- **Cone de Patrimônio Líquido** (trajetórias de amostra + curvas P10/P50/P90), **Histograma de Resultados Finais** e tabela detalhada por desfecho.

### 6. Catálogo de Mesas Proprietárias & Histórico (`PropFirmsModule`)
- Seleção em cascata (**Prop Firm → Plano**) na barra de contexto superior;
- Catálogo com presets de mesas de **CFD/Forex** e **Futuros** (incluindo contas de **$10K a $25K** e planos maiores), com suporte para criar, editar, excluir e restaurar presets;
- Salvamento de simulações em `localStorage` com exportação para **CSV**.

### 7. Consultor Quantitativo com IA (`AiConsultantDrawer`)
Painel lateral com streaming via Server-Sent Events (SSE) integrado ao snapshot atual do workspace (mesa selecionada, arbitragem, lotes, capital, simulação diária, Funded 10:1 e Monte Carlo) para auditoria matemática e revisão de regras contratuais.

---

## Stack Tecnológica

- **Frontend:** React 19, TypeScript, Vite 8, Tailwind CSS v4, Lucide React
- **Backend:** Node.js, Express 4, `tsx`
- **IA (Server-Side):** `@google/genai` via rota proxy `/api/quant/consult` (SSE)
- **Persistência Local:** `localStorage` (tema claro/escuro, catálogo de mesas e histórico de simulações)

---

## Estrutura do Projeto

```text
.
├── server.ts                        # Servidor Express + middleware Vite (dev) + rota /api/quant/consult
├── vite.config.ts                   # Configuração do Vite e Tailwind CSS v4
├── index.html                       # Ponto de entrada HTML
├── .env.example                     # Exemplo de variáveis de ambiente
└── src/
    ├── App.tsx                      # Estado global do workspace e navegação entre módulos
    ├── main.tsx                     # Inicialização React
    ├── index.css                    # Estilos globais e tema Tailwind
    ├── types/
    │   └── quant.ts                 # Tipos e interfaces do motor quantitativo
    ├── data/
    │   └── propFirms2026.ts         # Catálogo de mesas proprietárias e especificações de ativos
    ├── utils/
    │   └── quantEngine.ts           # Fórmulas financeiras, simulador diário, 10:1 e Monte Carlo
    └── components/
        ├── Header.tsx               # Barra de navegação superior
        ├── ContextToolbar.tsx       # Seletor Prop Firm → Plano, tema e resumo rápido
        ├── ArbitrageModule.tsx      # Módulo 1: Motor de Arbitragem
        ├── TradeSizingModule.tsx    # Módulo 2: Dimensionamento Trade-a-Trade
        ├── CapitalBonusModule.tsx   # Módulo 3: Capital & Bônus
        ├── DailySimulationModule.tsx# Simulador Dia-a-Dia + Módulo 5 (Funded 10:1)
        ├── MonteCarloModule.tsx     # Simulação Probabilística de Monte Carlo
        ├── PropFirmsModule.tsx      # Gestão de Mesas e Histórico/CSV
        └── AiConsultantDrawer.tsx   # Drawer do Consultor Quantitativo com IA
```

---

## Configuração e Execução Local

### Pré-requisitos
- **Node.js 20+**
- **npm** (ou gerenciador compatível)

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar variáveis de ambiente
Crie um arquivo `.env` na raiz do projeto com base no `.env.example`:

```env
GEMINI_API_KEY="sua_chave_de_api_aqui"
APP_URL="http://localhost:3000"
```

> **Nota:** A chave `GEMINI_API_KEY` é utilizada exclusivamente no servidor (`server.ts`) para a rota `/api/quant/consult`. Todos os módulos de cálculo, simulação diária e Monte Carlo funcionam localmente no navegador mesmo sem a chave configurada.

### 3. Executar em desenvolvimento
```bash
npm run dev
```
A aplicação estará disponível em `http://localhost:3000`.

### Scripts disponíveis
| Comando | Descrição |
| --- | --- |
| `npm run dev` | Inicia o servidor Express com Vite em modo desenvolvimento na porta `3000` |
| `npm run build` | Gera o bundle de produção em `dist/` |
| `npm run start` | Inicia o servidor Node (`server.ts`) em produção |
| `npm run lint` | Executa verificação de tipos TypeScript (`tsc --noEmit`) |
| `npm run clean` | Remove os artefatos de build (`dist/`) |

---

## API do Servidor

### `POST /api/quant/consult`
Endpoint em *Server-Sent Events* (`text/event-stream`) utilizado pelo Consultor Quantitativo.

- **Body (JSON):**
  - `messages`: histórico de mensagens `{ role: 'user' | 'assistant', content: string }[]`
  - `workspaceContext`: snapshot opcional dos parâmetros atuais do workspace
  - `intent`: código de intenção rápida (`A`, `B`, `C`, `D`, `E` ou `CUSTOM`)
- **Eventos SSE:** `delta` (trechos de texto em streaming), `done` (conclusão) e `error` (mensagem de erro).

---

## Aviso Legal

Este projeto tem finalidade estritamente educacional e de apoio à modelagem matemática de risco. As regras de mesas proprietárias (drawdown, consistência, dias mínimos, split e taxas) e condições de corretoras podem ser alteradas sem aviso prévio — valide sempre os termos contratuais vigentes antes de operar capital real.
