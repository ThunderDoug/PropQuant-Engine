# PropQuant Engine

Plataforma quantitativa para modelagem de **arbitragem de liquidez**, **hedging assimétrico**, **dimensionamento trade-a-trade**, **gestão de capital com bônus**, **elegibilidade contratual de payout** e **simulação estocástica (dia a dia e Monte Carlo reproduzível)** voltada a avaliações e contas financiadas (*Funded*) em mesas proprietárias (*Prop Firms*) de CFD/Forex e Futuros.

---

## Principais Módulos

### 1. Arbitragem & Hedging Assimétrico (`ArbitrageModule`)
Calcula o **Fator de Proteção (`F`)** entre a conta da Mesa Proprietária e a conta Hedge na corretora própria, suportando dois modos contábeis:
- **Cobertura Total (com DD):** `F = (DD + T_eval + L_adic) / DD`
- **Caixa Real (apenas Taxa + Lucro):** `F = (T_eval + L_adic) / DD`

Contabilidade integrada de fluxo de caixa:
- **Cenário A (Reprovação na Avaliação):** cobra apenas `T_eval` (sem taxa de ativação Funded) e valida `+L_adic` via ganho oposto na corretora.
- **Cenário B (Aprovação, Ativação e 1º Payout):** deduz explicitamente `T_eval`, `T_act` (taxa de ativação Funded, quando aplicável) e o hedge acumulado (`-Meta × F`), somando o reembolso `+T_eval` apenas quando contratualmente aplicável, e calcula o ponto de equilíbrio (*break-even*) exato.
- Curva de sensibilidade de *payoff* centralizada no motor (`calculateArbitragePayoffCurve`).

### 2. Dimensionamento Trade-a-Trade (`TradeSizingModule`)
Calcula os lotes exatos e a matriz de sensibilidade centralizada (`calculateTradeSizingSensitivityMatrix`):
- `L_M = Risco_Desejado_USD / (Stop_Loss_Pontos * Valor_do_Ponto_por_1_Lote)`
- `L_C = L_M * F`
- Perfis prontos com precisão de tick para **US30**, **US100**, **US500**, **EUR/USD**, **XAU/USD** e **CUSTOM**.

### 3. Capital Próprio & Bônus de Depósito (`CapitalBonusModule`)
Dimensiona a equidade necessária na conta Hedge (`DD * F * 1.15` ou `Meta_Fase1 * F * 1.10`) e compara depósitos reais com bônus de **0%**, **50%**, **100%** ou customizado, sinalizando automaticamente (`realCoverageInsufficient`) quando o depósito em dinheiro real não cobre 100% do risco cheio diante da regra de **Auto Stop-Out**.

### 4. Simulador Diário, Máquina de Estados & Modo Funded 10:1 (`DailySimulationModule`)
Executa simulação cronológica passo a passo com **máquina de estados explícita** (`evaluation_phase_1` → `evaluation_phase_2` → `evaluation_completed` → `funded_activation` → `funded_trading` → `payout_eligible` / `account_breached`), respeitando separadamente `evaluationRules` e `fundedRules`:
- **Drawdown Engine:** `static`, `trailing_eod`, `trailing_eod_locked` (com trava `+$100`), `trailing_intraday` e `trailing_intraday_locked` (suportando mesas que trocam EOD na Avaliação para Intradiário na Funded, como MFFU Rapid e Take Profit Trader), além de perdas diárias, picos intradiários, excursões adversas e comissões.
- **Consistency Engine Multi-Metodologia:** `none`, `best_day_over_net_profit`, `best_day_over_gross_positive`, `best_day_over_target` e bloqueio *fail-closed* para `unknown`.
- **Payout Eligibility Engine:** avalia buffer de lucro retido, mínimo de dias lucrativos qualificados, lucro mínimo diário qualificado, ciclo de saque, consistência Funded, saque mínimo, percentual máximo de saque, teto nominal de payout e saldo/drawdown pós-saque — nunca aprova apenas por dias corridos.
- **Proteção Anti-Loss Duplo (`F` Dinâmico):** recalcula `F` diariamente considerando `feesPaidCumulativeUsd` (incluindo taxa de ativação cobrada na transição para Funded), hedge acumulado e `+L_adic`.
- **Pós-Aprovação · Método 10:1 / 1:10:** na Funded, opera TP curto e SL amplo (1:10) na Prop Firm espelhados em 10:1 na Conta Hedge.

### 5. Simulação de Monte Carlo Determinística (`MonteCarloModule`)
Executa de **500 a 5.000 jornadas completas** usando gerador pseudoaleatório com semente reproduzível (**Mulberry32 PRNG**, `seedUsed`), aplicando o mesmo motor contratual de drawdown, consistência, taxas de ativação e elegibilidade de payout.

### 6. Modelo Contratual Normalizado & Histórico (`PropFirmsModule`)
- Separação estruturada entre **Identificação/Preços** (`evaluationFee`, `activationFee`, `resetFee`, `monthlySubscription`), **Regras de Avaliação** e **Regras Funded**.
- Rastreamento explícito de `VerificationStatus` (`verified`, `unverified`, `historical`, `missing`, `user_assumed`) com validação **fail-closed** (`validateFirmContract`): dados ausentes nunca são convertidos silenciosamente em `0` ou regra irrestrita.
- Migração segura de dados legados salvos em `localStorage` (`normalizePropFirmPreset`).
- Exportação para **CSV** com proteção contra **CSV Formula Injection (CWE-1236)** e **JSON**.

### 7. Consultor Quantitativo com IA (`AiConsultantDrawer`)
Painel lateral com streaming via *Server-Sent Events* (SSE), cancelamento limpo via `AbortController` no cliente e no servidor, validação estrita de payload, controle de origem/CORS, cabeçalhos de segurança e *rate limiting* em janela deslizante.

---

## Stack Tecnológica

- **Frontend:** React 19, TypeScript (`strict: true`), Vite 8, Tailwind CSS v4, Lucide React
- **Backend:** Node.js 22+, Express 4, `tsx`
- **IA (Server-Side):** `@google/genai` via rota proxy `/api/quant/consult` (SSE)
- **Testes Automatizados:** Node Test Runner (`tsx --test tests/*.test.ts`) + `node:assert/strict`

---

## Estrutura do Projeto

```text
.
├── server.ts                        # Express + headers de segurança + CORS + rate limit + SSE /api/quant/consult + /api/health
├── vite.config.ts                   # Configuração do Vite e Tailwind CSS v4
├── tsconfig.json                    # TypeScript em modo strict
├── tests/
│   ├── quantEngine.test.ts          # Testes de regressão do motor financeiro, drawdown, consistência, payout e Monte Carlo
│   ├── contractual.test.ts          # Testes de integridade contratual, fail-closed e migração de localStorage
│   └── security.test.ts             # Testes de CSV injection, validação de payload, rate limiter e mapeamento de erros
└── src/
    ├── App.tsx                      # Estado global, migração segura e orquestração dos módulos
    ├── types/quant.ts               # Interfaces contratuais, máquina de estados e tipos quantitativos
    ├── data/propFirms2026.ts        # Catálogo normalizado 2026 (Avaliação vs. Funded) e especificações de ativos
    ├── utils/
    │   ├── contractual.ts           # Builders contratuais, normalizePropFirmPreset e validateFirmContract
    │   ├── quantEngine.ts           # Fonte única de verdade para todos os cálculos financeiros e simulações
    │   └── security.ts              # Sanitização CSV/texto, validação de API, rate limiter e erro seguro
    └── components/                  # Módulos da interface (Arbitrage, Sizing, Capital, Daily, MonteCarlo, PropFirms, Drawer)
```

---

## Configuração, Testes e Execução Local

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar variáveis de ambiente
Crie um arquivo `.env` na raiz com base no `.env.example`:
```env
GEMINI_API_KEY="sua_chave_de_api_aqui"
APP_URL="http://localhost:3000"
```

> **Nota:** `GEMINI_API_KEY` permanece estritamente no servidor (`server.ts`). Todos os cálculos, simulações diárias, validações contratuais e Monte Carlo operam 100% localmente sem depender da chave.

### Scripts disponíveis
| Comando | Descrição |
| --- | --- |
| `npm run dev` | Inicia o servidor Express com Vite em desenvolvimento na porta `3000` |
| `npm test` | Executa toda a suíte de testes automatizados de regressão (`tests/*.test.ts`) |
| `npm run lint` | Executa checagem estrita de tipos TypeScript (`tsc --noEmit`) |
| `npm run build` | Gera o bundle de produção em `dist/` |
| `npm run start` | Inicia o servidor Node (`server.ts`) em produção |
| `npm run clean` | Remove os artefatos de build (`dist/`) |

---

## API do Servidor

### `GET /api/health`
Retorna o status operacional do servidor (`{ status: 'ok', aiConfigured: boolean, timestamp: string }`) sem expor chaves ou exceções internas.

### `POST /api/quant/consult`
Endpoint em *Server-Sent Events* (`text/event-stream`) protegido por validação de payload, limite de 32 KB no snapshot do workspace, limite de 128 KB no corpo JSON, *rate limit* por IP e timeout/cancelamento via `AbortController`.

- **Body (JSON):**
  - `messages`: histórico `{ role: 'user' | 'assistant', content: string }[]` (máx. 30 turnos, 4.000 caracteres/mensagem)
  - `workspaceContext`: snapshot opcional dos parâmetros atuais do workspace
  - `intent`: código de intenção rápida (`A`, `B`, `C`, `D`, `E` ou `CUSTOM`)
- **Eventos SSE:** `chunk` (trechos de texto em streaming), `done` (conclusão) e `error` (mensagem pública segura).

---

## Aviso Legal

Este projeto tem finalidade estritamente educacional e de pesquisa quantitativa de risco. Não possui qualquer integração de execução com dinheiro real. As regras de mesas proprietárias e corretoras podem mudar sem aviso prévio — valide sempre os termos vigentes da mesa antes de operar.
