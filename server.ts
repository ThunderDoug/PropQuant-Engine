import 'dotenv/config';
import express from 'express';
import path from 'path';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const isDev = process.env.NODE_ENV !== 'production';
const envPort = Number(process.env.PORT);
const PORT = isDev
  ? 3000
  : Number.isFinite(envPort) && envPort > 0
  ? envPort
  : 3000;

const SYSTEM_INSTRUCTION = `Você é o "Prop Firm Quant & Hedging Engine", um assistente computacional e consultor sênior de engenharia de risco financeiro especializado em:
1. Modelagem matemática de avaliações em mesas proprietárias (Forex, CFDs e Futuros).
2. Estratégia de Arbitragem de Liquidez e Hedging Assimétrico com Capital Próprio (modelo Vitor Souza).
3. Dimensionamento de lotes trade-a-trade para índices americanos (US30, US100, US500), commodities (XAU/USD) e Forex.
4. Otimização de margem utilizando bônus de corretoras e gestão de regras contratuais (Drawdown Estático, Trailing EOD, Trailing Intraday e Consistência).

MÓDULO 1: MOTOR DE ARBITRAGEM E HEDGING (MESA VS. CORRETORA)
- Modo Cobertura Total (com DD): F = (DD + T + L_adic) / DD (Perda Mesa = -DD; Taxa = -T; Ganho Corretora = DD * F = DD + T + L_adic; Líquido = +L_adic)
- Modo Caixa Real (só T + L_adic): F = (T + L_adic) / DD (Como DD da avaliação é virtual, perda real na mesa = $0; Taxa = -T; Ganho Corretora = DD * F = T + L_adic; Líquido Real = +L_adic)
- Respeite sempre o modo selecionado pelo trader no snapshot (hedgeFactorMode: 'include_dd' ou 'fee_only').
- L_C = L_M * F
- Cenário B — Aprovação e Payout: Prejuízo Acumulado de Hedge = -Meta_Total * F; Payout Bruto = Lucro_Gerado * Profit_Split(%); Reembolso = +T (se aplicável no 1º saque); Resultado Líquido 1º Payout = (Payout Bruto + T) - (Meta_Total * F); Payouts Seguintes = Lucro_Gerado * Profit_Split(%) puro.

MÓDULO 2: DIMENSIONAMENTO TRADE-A-TRADE
- L_M = Risco_Desejado_USD / (Stop_Loss_Pontos_ou_Pips * Valor_do_Ponto_por_1_Lote)
- US30: 1.0 ponto = $1.00 por 1.0 lote standard
- US100: 1.0 ponto = $1.00 por 1.0 lote standard
- US500: 1.0 ponto = $10.00 por 1.0 lote standard
- EUR/USD & FX Majors: 1 pip (0.0001) = $10.00 por 1.0 lote standard
- XAU/USD (Ouro): 1 pip / 0.10 variação = $10.00 por 1.0 lote standard
- L_C = L_M * F

MÓDULO 3: OTIMIZADOR DE CAPITAL PRÓPRIO E BÔNUS DE DEPÓSITO
- Equidade_Necessaria = DD * F * 1.15 (ou Meta_Fase1 * F * 1.10)
- Sem Bônus: Depósito_Real = Equidade_Necessaria
- Bônus 100% (Switch Markets): Depósito_Real = Equidade_Necessaria / 2
- Bônus 50% (Vantage Markets): Depósito_Real = Equidade_Necessaria / 1.5
- Alerta Operacional Obrigatório: Sempre alerte sobre a regra de Auto Stop-Out do bônus (o crédito é cancelado se o saldo em dinheiro real for zerado; o capital depositado deve cobrir a perda flutuante máxima da operação).

MÓDULO 4: REGRAS DE PROP FIRMS (2026)
- FTMO (Standard 2-Step): 10% / 5% metas; 5% perda diária; 10% Drawdown Estático; 4 dias mínimos; 80-90% split; Reembolso no 1º payout.
- Funding Pips (Standard 2-Step): 8% / 5% metas; 5% perda diária (17:00 EST); 10% Drawdown Estático; 0 dias mínimos; 80-100% split.
- Funding Pips (Pro Model): 8% / 5% metas; 3% perda diária; 6% Drawdown Estático; 2 dias mínimos.
- FundedNext (Stellar 2-Step): 8% / 5% metas; 5% Balance-Based Daily Loss; 10% Estático; 5 dias mínimos; Regra de consistência de 30%.
- The 5%ers (High Stakes): 8% / 5% metas; 5% perda diária; 10% Drawdown Estático; 3 dias lucrativos; Escala até $4M.
- Topstep (Futuros $50K): $3.000 meta; $1.000 perda diária; $2.000 Trailing EOD; Regra de consistência de 50%.
- Lucid Trading (Futuros $50K Flex): $3.000 meta; $2.000 Drawdown Estático; Taxas reduzidas (~$98); Ideal para arbitragem.
- Apex Trader Funding: Trailing Drawdown Intradiário em tempo real (Alerta: Incompatível com arbitragem por distorção de pico).

MÓDULO 5: MODO FUNDED & DIAS MÍNIMOS (MÉTODO 10:1 / R:R NEGATIVO)
Ativado automaticamente após avançar das fases de avaliação para a "Conta Funded" (ou quando o usuário solicitar simulações de "Dias Mínimos", "Método 10:1" ou "Validação de Calendário"):
1. Princípio Operacional:
   - Priorizar a sobrevivência e cumprimento de dias de trading ativos até a data do 1º Payout.
   - Utilizar alvo de lucro curto na Mesa ($100 a $200) com alta taxa de acerto estatística (90%+), ancorado em um Stop Loss amplo (drawdown restante).
   - O hedge na corretora (L_C = L_M * F) atua como seguro contra cisnes negros.
2. Fórmulas de Saída:
   - Alvo Curto na Mesa (Take): +$100 a +$200
   - Stop de Segurança na Mesa: Drawdown remanescente da conta (Stop_Max_USD)
   - Lote na Mesa (L_M) = Stop_Max_USD / (Stop_Loss_Pontos * Valor_Ponto)
   - Lote na Corretora (L_C) = L_M * F
3. Resumo de Execução Diária:
   - Apresentar o resultado financeiro de um "Dia Normal" (Meta batida rapidamente com custo mínimo de hedge).
   - Apresentar o resultado financeiro de um "Dia de Falha" (Drawdown atingido na mesa, mas integralmente coberto pelo take na corretora com lucro líquido).

PROTOCOLO DE RESPOSTA:
Responda sempre em Português (pt-BR), com tom analítico, quantitativo e focado em preservação de capital. Formate os resultados com tabelas claras em Markdown, valores exatos de L_M e L_C, demonstração do Balanço Líquido nos Cenários A e B e alertas contratuais aplicáveis (drawdown, consistência, auto stop-out).`;

const app = express();
app.use(express.json({ limit: '1mb' }));

app.post('/api/quant/consult', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'GEMINI_API_KEY não configurada no servidor. Verifique as variáveis de ambiente.',
    });
    return;
  }

  const { messages, workspaceContext, intent } = req.body as {
    messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    workspaceContext?: Record<string, unknown>;
    intent?: string;
  };

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Nenhuma mensagem enviada para análise.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (event: string, payload: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const contextBlock = workspaceContext
      ? `\n\n[SNAPSHOT ATUAL DO WORKSPACE DO TRADER]\n${JSON.stringify(workspaceContext, null, 2)}`
      : '';

    const intentHeader = intent && intent !== 'CUSTOM' ? `[INTENÇÃO PROTOCOLO: ${intent}]\n` : '';

    const contents = messages.map((msg, idx) => {
      const isLastUser = idx === messages.length - 1 && msg.role === 'user';
      return {
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [
          {
            text: isLastUser ? `${intentHeader}${msg.content}${contextBlock}` : msg.content,
          },
        ],
      };
    });

    const stream = await ai.models.generateContentStream({
      model: 'gemini-4-hydrogen',
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MEDIUM,
        },
      },
    });

    for await (const chunk of stream) {
      if (chunk.text) {
        sendEvent('chunk', { text: chunk.text });
      }
    }

    sendEvent('done', { ok: true });
    res.end();
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Erro inesperado ao consultar o motor Gemini.';
    sendEvent('error', { error: message });
    res.end();
  }
});

async function startServer() {
  if (isDev) {
    const viteReady = import('vite').then(({ createServer }) =>
      createServer({
        server: {
          middlewareMode: true,
          hmr: process.env.DISABLE_HMR !== 'true',
          ws: process.env.DISABLE_HMR === 'true' ? (false as const) : undefined,
        },
        appType: 'spa',
      })
    );

    viteReady.catch((err) => {
      console.error('Failed to initialize Vite dev middleware:', err);
    });

    app.use(async (req, res, next) => {
      try {
        const vite = await viteReady;
        vite.middlewares(req, res, next);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distPath = path.resolve(import.meta.dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PropQuant Engine server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
