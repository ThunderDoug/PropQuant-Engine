import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  isAllowedOrigin,
  mapSafeServerError,
  SlidingWindowRateLimiter,
  validateConsultPayload,
} from './src/utils/security.ts';

const isDev = process.env.NODE_ENV !== 'production';
const envPort = Number(process.env.PORT);
const PORT = isDev
  ? 3000
  : Number.isFinite(envPort) && envPort > 0
  ? envPort
  : 3000;

const CONSULT_TIMEOUT_MS = 45_000;
const consultRateLimiter = new SlidingWindowRateLimiter(20, 60_000);

const SYSTEM_INSTRUCTION = `Você é o "Prop Firm Quant & Hedging Engine", um assistente computacional e consultor sênior de engenharia de risco financeiro especializado em:
1. Modelagem matemática de avaliações em mesas proprietárias (Forex, CFDs e Futuros).
2. Estratégia de Arbitragem de Liquidez e Hedging Assimétrico com Capital Próprio.
3. Dimensionamento de lotes trade-a-trade para índices americanos (US30, US100, US500), commodities (XAU/USD) e Forex.
4. Otimização de margem utilizando bônus de corretoras e gestão rigorosa de regras contratuais separadas entre Avaliação e Conta Funded (Drawdown Estático, Trailing EOD com/sem trava, Trailing Intradiário, Consistência, Buffers e Elegibilidade de Payout).

MÓDULO 1: MOTOR DE ARBITRAGEM E HEDGING (MESA VS. CORRETORA)
- Modo Cobertura Total (com DD): F = (DD + T_eval + L_adic) / DD (Perda Mesa = -DD; Taxa Eval = -T_eval; Ganho Corretora = DD * F = DD + T_eval + L_adic; Líquido = +L_adic)
- Modo Caixa Real (só T + L_adic): F = (T_eval + L_adic) / DD (Como DD da avaliação é virtual, perda real na mesa = $0; Taxa Eval = -T_eval; Ganho Corretora = DD * F = T_eval + L_adic; Líquido Real = +L_adic)
- Respeite sempre o modo selecionado pelo trader no snapshot (hedgeFactorMode: 'include_dd' ou 'fee_only').
- L_C = L_M * F
- Cenário B — Aprovação e 1º Payout: Prejuízo Acumulado de Hedge = -Meta_Total * F; Taxas Pagas = -(T_eval + T_ativacao); Payout Bruto Elegível = Lucro_Sacavel * Profit_Split(%); Reembolso = +T_eval (se aplicável no 1º saque); Fluxo Líquido 1º Payout = (Payout Bruto + Reembolso) - T_eval - T_ativacao - (Meta_Total * F).

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

MÓDULO 4: INTEGRIDADE CONTRATUAL (AVALIAÇÃO VS. FUNDED)
- Nunca presuma que regras não verificadas (missing) são zero ou ilimitadas; alerte o trader sobre campos pendentes.
- Separe explicitamente as regras da Avaliação das regras da Conta Funded (ex.: mudança de EOD para Trailing Intradiário pós-aprovação, consistência diferenciada, buffer obrigatório de lucro, mínimo de dias lucrativos acima do piso diário, teto de saque e taxa de ativação cobrada apenas na transição para Funded).

MÓDULO 5: MODO FUNDED & DIAS MÍNIMOS (MÉTODO 10:1 / 1:10)
- Na Prop Firm (1:10): alvo curto diário (+$100 a +$200) com Stop Loss amplo (até o SL 1:10 ou drawdown remanescente).
- Na Conta Hedge (10:1): L_C = L_M * F, garantindo que em Dia de Falha (cisne negro) o Take 10:1 na corretora cubra o SL da mesa (em modo include_dd), as taxas pagas (T_eval + T_ativacao), o hedge prévio acumulado e L_adic.

PROTOCOLO DE RESPOSTA:
Responda sempre em Português (pt-BR), com tom analítico, quantitativo e focado em preservação de capital. Formate os resultados com tabelas claras em Markdown, valores exatos de L_M e L_C, demonstração do Balanço Líquido nos Cenários A e B e alertas contratuais aplicáveis (drawdown, consistência, elegibilidade de payout, campos contratuais ausentes e auto stop-out).`;

function logServerEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  meta: Record<string, unknown> = {}
) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...meta,
  };
  const serialized = JSON.stringify(entry);
  if (level === 'error') {
    console.error(serialized);
  } else if (level === 'warn') {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Security headers (iframe-compatible for AI Studio preview)
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  next();
});

// Origin / CORS validation for API routes
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
  if (!isAllowedOrigin(origin, host, process.env.APP_URL)) {
    logServerEvent('warn', 'api_origin_rejected', { origin, path: req.path });
    res.status(403).json({ error: 'Origem da requisição não autorizada.' });
    return;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: '128kb' }));

// Handle malformed JSON payloads safely without leaking stack traces
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON malformado no corpo da requisição.' });
    return;
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'Tamanho da requisição excedeu o limite permitido (128 KB).' });
    return;
  }
  next(err);
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'propquant-engine',
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
  });
});

app.post('/api/quant/consult', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const clientIp = getClientIp(req);
  const rateDecision = consultRateLimiter.check(clientIp);
  res.setHeader('X-RateLimit-Remaining', String(rateDecision.remaining));

  if (!rateDecision.allowed) {
    res.setHeader('Retry-After', String(rateDecision.retryAfterSeconds));
    logServerEvent('warn', 'consult_rate_limited', { clientIp });
    res.status(429).json({
      error: `Limite de consultas atingido. Aguarde ${rateDecision.retryAfterSeconds}s antes de tentar novamente.`,
    });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error: 'Consultor IA indisponível no momento: GEMINI_API_KEY não configurada no servidor.',
    });
    return;
  }

  const validation = validateConsultPayload(req.body);
  if (!validation.ok || !validation.messages) {
    res.status(400).json({ error: validation.error || 'Requisição inválida.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const abortController = new AbortController();
  let clientDisconnected = false;

  const timeoutHandle = setTimeout(() => {
    abortController.abort();
  }, CONSULT_TIMEOUT_MS);

  res.on('close', () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      abortController.abort();
    }
  });

  const sendEvent = (event: string, payload: unknown) => {
    if (clientDisconnected || res.writableEnded) return;
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

    const contextBlock = validation.workspaceContext
      ? `\n\n[SNAPSHOT ATUAL DO WORKSPACE DO TRADER]\n${JSON.stringify(validation.workspaceContext, null, 2)}`
      : '';

    const intentHeader =
      validation.intent && validation.intent !== 'CUSTOM'
        ? `[INTENÇÃO PROTOCOLO: ${validation.intent}]\n`
        : '';

    const contents = validation.messages.map((msg, idx) => {
      const isLastUser = idx === validation.messages!.length - 1 && msg.role === 'user';
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
        abortSignal: abortController.signal,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MEDIUM,
        },
      },
    });

    for await (const chunk of stream) {
      if (clientDisconnected || abortController.signal.aborted) break;
      if (chunk.text) {
        sendEvent('chunk', { text: chunk.text });
      }
    }

    if (!clientDisconnected && !abortController.signal.aborted) {
      sendEvent('done', { ok: true });
      logServerEvent('info', 'consult_completed', {
        durationMs: Date.now() - startedAt,
        intent: validation.intent,
      });
    }
    if (!res.writableEnded) {
      res.end();
    }
  } catch (err: unknown) {
    if (clientDisconnected) {
      logServerEvent('info', 'consult_client_aborted', {
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const mapped = mapSafeServerError(err);
    logServerEvent('error', 'consult_failed', {
      code: mapped.code,
      status: mapped.status,
      durationMs: Date.now() - startedAt,
    });
    sendEvent('error', { error: mapped.publicMessage, code: mapped.code });
    if (!res.writableEnded) {
      res.end();
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
});

// Fallback unexpected API error handler (never expose internal exception details)
app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const mapped = mapSafeServerError(err);
  logServerEvent('error', 'api_unhandled_error', { code: mapped.code });
  if (!res.headersSent) {
    res.status(mapped.status).json({ error: mapped.publicMessage });
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
      logServerEvent('error', 'vite_middleware_init_failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
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
    logServerEvent('info', 'server_listening', {
      port: PORT,
      mode: isDev ? 'development' : 'production',
    });
  });
}

startServer();
