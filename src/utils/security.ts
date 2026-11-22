import type { ConsultIntent } from '../types/quant.ts';

const CSV_FORMULA_PREFIX_REGEX = /^[\s\u0000]*[=+\-@\t\r]/;
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Neutralizes CSV/Spreadsheet Formula Injection (CWE-1236) and formats per RFC 4180.
 */
export function sanitizeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return '""';
  }
  const raw = String(value).replace(CONTROL_CHARS_REGEX, '');
  const neutralized = CSV_FORMULA_PREFIX_REGEX.test(raw) ? `'${raw}` : raw;
  const escaped = neutralized.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Sanitizes free-text user inputs (notes, firm names, chat prompts) against control chars and excessive length.
 */
export function sanitizeTextInput(value: unknown, maxLength = 4000): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS_REGEX, '').trim().slice(0, maxLength);
}

export interface ValidatedConsultMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ValidatedConsultPayload {
  ok: boolean;
  error?: string;
  messages?: ValidatedConsultMessage[];
  intent?: ConsultIntent;
  workspaceContext?: Record<string, unknown>;
}

const VALID_INTENTS = new Set<ConsultIntent>(['A', 'B', 'C', 'D', 'E', 'CUSTOM']);

export function validateConsultPayload(body: unknown): ValidatedConsultPayload {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Corpo da requisição inválido. Esperado objeto JSON.' };
  }

  const record = body as Record<string, unknown>;
  const rawMessages = record.messages;

  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { ok: false, error: 'Nenhuma mensagem enviada para análise.' };
  }

  if (rawMessages.length > 30) {
    return { ok: false, error: 'Histórico de mensagens excedeu o limite máximo de 30 turnos.' };
  }

  const sanitizedMessages: ValidatedConsultMessage[] = [];
  for (const item of rawMessages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: 'Formato de mensagem inválido.' };
    }
    const msg = item as Record<string, unknown>;
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      return { ok: false, error: 'Papel de mensagem não suportado.' };
    }
    const content = sanitizeTextInput(msg.content, 4000);
    if (!content) {
      return { ok: false, error: 'Mensagens não podem estar vazias.' };
    }
    sanitizedMessages.push({
      role: msg.role,
      content,
    });
  }

  const lastMessage = sanitizedMessages[sanitizedMessages.length - 1];
  if (lastMessage.role !== 'user') {
    return { ok: false, error: 'A última mensagem da conversa deve ser do usuário.' };
  }

  let intent: ConsultIntent = 'CUSTOM';
  if (record.intent !== undefined) {
    if (typeof record.intent !== 'string' || !VALID_INTENTS.has(record.intent as ConsultIntent)) {
      return { ok: false, error: 'Código de intenção inválido.' };
    }
    intent = record.intent as ConsultIntent;
  }

  let workspaceContext: Record<string, unknown> | undefined;
  if (record.workspaceContext !== undefined && record.workspaceContext !== null) {
    if (typeof record.workspaceContext !== 'object' || Array.isArray(record.workspaceContext)) {
      return { ok: false, error: 'Contexto do workspace deve ser um objeto JSON válido.' };
    }
    let serialized = '';
    try {
      serialized = JSON.stringify(record.workspaceContext);
    } catch {
      return { ok: false, error: 'Contexto do workspace não serializável.' };
    }
    if (serialized.length > 32768) {
      return { ok: false, error: 'Snapshot do workspace excedeu o limite de 32 KB.' };
    }
    workspaceContext = record.workspaceContext as Record<string, unknown>;
  }

  return {
    ok: true,
    messages: sanitizedMessages,
    intent,
    workspaceContext,
  };
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export class SlidingWindowRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxTrackedKeys: number;
  private readonly buckets = new Map<string, number[]>();

  constructor(maxRequests = 20, windowMs = 60_000, maxTrackedKeys = 2000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.maxTrackedKeys = maxTrackedKeys;
  }

  check(key: string, now = Date.now()): RateLimitDecision {
    const windowStart = now - this.windowMs;
    const existing = this.buckets.get(key) ?? [];
    const active = existing.filter((ts) => ts > windowStart);

    if (active.length >= this.maxRequests) {
      const oldest = active[0] ?? now;
      const retryAfterMs = Math.max(1000, oldest + this.windowMs - now);
      this.buckets.set(key, active);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    active.push(now);
    this.buckets.set(key, active);

    // Bounded eviction to prevent unbounded memory growth
    if (this.buckets.size > this.maxTrackedKeys) {
      for (const [k, timestamps] of this.buckets.entries()) {
        if (timestamps.every((ts) => ts <= windowStart)) {
          this.buckets.delete(k);
        }
        if (this.buckets.size <= this.maxTrackedKeys) break;
      }
      if (this.buckets.size > this.maxTrackedKeys) {
        const firstKey = this.buckets.keys().next().value;
        if (firstKey !== undefined) this.buckets.delete(firstKey);
      }
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - active.length),
      retryAfterSeconds: 0,
    };
  }
}

export function isAllowedOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  appUrl: string | undefined
): boolean {
  // Same-origin non-CORS requests (no Origin header) are allowed
  if (!originHeader) return true;

  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return false;
  }

  if (hostHeader && originUrl.host.toLowerCase() === hostHeader.toLowerCase()) {
    return true;
  }

  if (appUrl && appUrl !== 'MY_APP_URL') {
    try {
      const configured = new URL(appUrl);
      if (originUrl.origin === configured.origin) {
        return true;
      }
    } catch {
      // Ignore malformed APP_URL
    }
  }

  if (
    originUrl.hostname === 'localhost' ||
    originUrl.hostname === '127.0.0.1'
  ) {
    return true;
  }

  return false;
}

export function mapSafeServerError(err: unknown): {
  status: number;
  code: string;
  publicMessage: string;
} {
  if (err instanceof Error && err.name === 'AbortError') {
    return {
      status: 504,
      code: 'UPSTREAM_TIMEOUT',
      publicMessage: 'Tempo limite excedido ao aguardar resposta do motor de IA. Tente novamente.',
    };
  }

  const raw = err instanceof Error ? err.message : '';
  if (/API_KEY_INVALID|401|403|PERMISSION_DENIED/i.test(raw)) {
    return {
      status: 502,
      code: 'GEMINI_AUTH_ERROR',
      publicMessage:
        'Falha de autenticação com o serviço de IA. Verifique a GEMINI_API_KEY nas configurações de Secrets.',
    };
  }
  if (/RESOURCE_EXHAUSTED|429/i.test(raw)) {
    return {
      status: 429,
      code: 'GEMINI_RATE_LIMIT',
      publicMessage:
        'Limite de requisições do serviço de IA atingido temporariamente. Aguarde alguns segundos e tente novamente.',
    };
  }
  if (/NOT_FOUND|404/i.test(raw)) {
    return {
      status: 502,
      code: 'GEMINI_MODEL_UNAVAILABLE',
      publicMessage: 'Modelo de análise indisponível no momento. Tente novamente em instantes.',
    };
  }

  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    publicMessage: 'Não foi possível concluir a análise quantitativa no momento.',
  };
}
