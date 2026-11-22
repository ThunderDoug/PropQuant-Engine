import { AlertCircle, RotateCcw, Send, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ChatMessage, ConsultIntent } from '../types/quant';

interface AiConsultantDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceContext: Record<string, unknown>;
  pendingTrigger: { intent: ConsultIntent; prompt: string; nonce: number } | null;
}

const QUICK_INTENTS: Array<{ intent: ConsultIntent; label: string; prompt: string }> = [
  {
    intent: 'A',
    label: '[A] Simulação Completa',
    prompt:
      'Execute a simulação completa de arbitragem (Mesa vs. Corretora) para os parâmetros atuais do workspace, com tabela de entradas/saídas e balanço líquido nos Cenários A e B.',
  },
  {
    intent: 'B',
    label: '[B] Lotes Trade-a-Trade',
    prompt:
      'Calcule e valide os lotes exatos (L_M e L_C) para o ativo selecionado, detalhando o risco por ponto/pip e orientações de execução no MetaTrader/NinjaTrader.',
  },
  {
    intent: 'C',
    label: '[C] Capital & Bônus',
    prompt:
      'Dimensione o capital próprio necessário com bônus de 50% e 100%, avaliando explicitamente o risco de Auto Stop-Out diante da perda flutuante máxima.',
  },
  {
    intent: 'D',
    label: '[D] Viabilidade Contratual',
    prompt:
      'Analise a viabilidade contratual da mesa selecionada para arbitragem de liquidez, verificando tipo de drawdown, consistência e possíveis armadilhas operacionais.',
  },
  {
    intent: 'E',
    label: '[E] Modo Funded 10:1',
    prompt:
      'Gere o plano de execução do Módulo 5 (Modo Funded & Dias Mínimos / Método 10:1) com os lotes exatos L_M e L_C, demonstrando Dia Normal vs. Dia de Falha até o 1º Payout.',
  },
];

function renderFormattedLine(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={idx} className="font-semibold text-slate-900 dark:text-slate-50">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={idx}
          className="rounded bg-slate-200/70 px-1.5 py-0.5 font-mono text-xs text-slate-800 dark:bg-slate-800 dark:text-emerald-300"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

function MarkdownLite({ content }: { content: string }) {
  const lines = content.split('\n');
  const blocks: Array<{ type: 'table' | 'lines'; rows: string[] }> = [];

  for (const line of lines) {
    const isTableLine = line.trim().startsWith('|') && line.trim().endsWith('|');
    const lastBlock = blocks[blocks.length - 1];
    if (isTableLine) {
      if (lastBlock && lastBlock.type === 'table') {
        lastBlock.rows.push(line);
      } else {
        blocks.push({ type: 'table', rows: [line] });
      }
    } else {
      if (lastBlock && lastBlock.type === 'lines') {
        lastBlock.rows.push(line);
      } else {
        blocks.push({ type: 'lines', rows: [line] });
      }
    }
  }

  return (
    <div className="space-y-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
      {blocks.map((block, bIdx) => {
        if (block.type === 'table' && block.rows.length >= 2) {
          const parseRow = (row: string) =>
            row
              .trim()
              .slice(1, -1)
              .split('|')
              .map((cell) => cell.trim());

          const headers = parseRow(block.rows[0]);
          const dataRows = block.rows
            .slice(1)
            .filter((r) => !/^\|[\s:-]+\|/.test(r.trim()))
            .map(parseRow);

          return (
            <div
              key={bIdx}
              className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700"
            >
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-100 dark:bg-slate-800/80">
                  <tr>
                    {headers.map((h, hIdx) => (
                      <th
                        key={hIdx}
                        className="px-3 py-2 font-semibold text-slate-800 dark:text-slate-100"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {dataRows.map((cells, rIdx) => (
                    <tr key={rIdx}>
                      {cells.map((cell, cIdx) => (
                        <td
                          key={cIdx}
                          className="px-3 py-2 font-mono text-slate-700 dark:text-slate-300"
                        >
                          {renderFormattedLine(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        return (
          <div key={bIdx} className="space-y-1.5">
            {block.rows.map((line, lIdx) => {
              const trimmed = line.trim();
              if (!trimmed) return <div key={lIdx} className="h-1" />;
              if (trimmed.startsWith('### ')) {
                return (
                  <h4
                    key={lIdx}
                    className="pt-2 font-display text-sm font-semibold text-slate-900 dark:text-slate-100"
                  >
                    {trimmed.slice(4)}
                  </h4>
                );
              }
              if (trimmed.startsWith('## ')) {
                return (
                  <h3
                    key={lIdx}
                    className="pt-2 font-display text-base font-bold text-slate-900 dark:text-slate-50"
                  >
                    {trimmed.slice(3)}
                  </h3>
                );
              }
              if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
                return (
                  <div key={lIdx} className="flex items-start gap-2 pl-1">
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-emerald-500" />
                    <div>{renderFormattedLine(trimmed.slice(2))}</div>
                  </div>
                );
              }
              return <p key={lIdx}>{renderFormattedLine(trimmed)}</p>;
            })}
          </div>
        );
      })}
    </div>
  );
}

export function AiConsultantDrawer({
  isOpen,
  onClose,
  workspaceContext,
  pendingTrigger,
}: AiConsultantDrawerProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const lastNonceRef = useRef<number>(0);
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  useEffect(() => {
    if (!isOpen && abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, [isOpen]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const handleCancelStream = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  };

  const sendConsult = async (promptText: string, intent: ConsultIntent = 'CUSTOM') => {
    const trimmed = promptText.trim();
    if (!trimmed || isStreaming) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
      intent,
      timestamp: new Date().toISOString(),
    };

    const assistantMsgId = `assistant-${Date.now() + 1}`;
    const placeholderAssistant: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
    };

    const conversationHistory = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setMessages((prev) => [...prev, userMsg, placeholderAssistant]);
    setInput('');
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch('/api/quant/consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          messages: conversationHistory,
          workspaceContext,
          intent,
        }),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.error || `Erro HTTP ${response.status} ao consultar o servidor.`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Stream de resposta indisponível.');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const rawEvent of events) {
          const eventLine = rawEvent
            .split('\n')
            .find((l) => l.startsWith('event:'))
            ?.slice(6)
            .trim();
          const dataLine = rawEvent
            .split('\n')
            .find((l) => l.startsWith('data:'))
            ?.slice(5)
            .trim();

          if (!dataLine) continue;
          const parsed = JSON.parse(dataLine);

          if (eventLine === 'chunk' && typeof parsed.text === 'string') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId ? { ...m, content: m.content + parsed.text } : m
              )
            );
          } else if (eventLine === 'error') {
            throw new Error(parsed.error || 'Falha durante a geração da análise.');
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId && !m.content
              ? { ...m, content: 'Consulta cancelada pelo usuário.' }
              : m
          )
        );
      } else {
        const errMsg =
          err instanceof Error
            ? err.message
            : 'Não foi possível concluir a consulta quantitativa.';
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, content: errMsg, error: true }
              : m
          )
        );
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsStreaming(false);
    }
  };

  useEffect(() => {
    if (isOpen && pendingTrigger && pendingTrigger.nonce !== lastNonceRef.current) {
      lastNonceRef.current = pendingTrigger.nonce;
      void sendConsult(pendingTrigger.prompt, pendingTrigger.intent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, pendingTrigger]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="Consultor Quantitativo de IA"
    >
      <div className="flex h-full w-full max-w-2xl flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-[#0B0F17]">
        {/* Drawer Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-50">
              Consultor Quantitativo IA
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Prop Firm Quant & Hedging Engine · Contexto da simulação conectado
            </p>
          </div>
          <div className="flex items-center gap-2">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => setMessages([])}
                disabled={isStreaming}
                title="Reiniciar conversa"
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-300 px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Limpar
              </button>
            )}
            <button
              type="button"
              aria-label="Fechar consultor"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Protocol Quick Intents + Context Preview Toggle */}
        <div className="border-b border-slate-200 bg-slate-50/70 px-6 py-3 dark:border-slate-800 dark:bg-[#111827]">
          <div className="flex flex-wrap items-center gap-2">
            {QUICK_INTENTS.map((item) => (
              <button
                key={item.intent}
                type="button"
                disabled={isStreaming}
                onClick={() => sendConsult(item.prompt, item.intent)}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-emerald-500 hover:text-emerald-700 disabled:opacity-40 dark:border-slate-700 dark:bg-[#0B0F17] dark:text-slate-300 dark:hover:border-emerald-500 dark:hover:text-emerald-300 whitespace-nowrap"
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowContext((prev) => !prev)}
              className="ml-auto text-xs font-medium text-slate-500 underline-offset-4 hover:underline dark:text-slate-400"
            >
              {showContext ? 'Ocultar snapshot' : 'Ver snapshot enviado'}
            </button>
          </div>

          {showContext && (
            <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-slate-200 bg-white p-3 font-mono text-[11px] text-slate-700 dark:border-slate-800 dark:bg-[#090D16] dark:text-slate-300">
              {JSON.stringify(workspaceContext, null, 2)}
            </pre>
          )}
        </div>

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {messages.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-800 dark:bg-[#111827]">
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Pronto para análise quantitativa e auditoria de risco
              </h3>
              <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Selecione um dos protocolos acima (<span className="font-mono">[A]</span> a{' '}
                <span className="font-mono">[D]</span>) ou faça uma pergunta específica sobre lotes no MetaTrader/NinjaTrader, metas, bônus de corretoras ou regras contratuais. Todos os números do seu painel atual são enviados automaticamente como contexto.
              </p>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={
                  msg.role === 'user'
                    ? 'ml-8 rounded-xl border border-slate-200 bg-slate-100 p-4 text-sm text-slate-900 dark:border-slate-800 dark:bg-[#161F30] dark:text-slate-100'
                    : 'rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]'
                }
              >
                <div className="mb-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-semibold">
                    {msg.role === 'user' ? 'Trader' : 'Prop Firm Quant & Hedging Engine'}
                  </span>
                  <span className="font-mono">
                    {new Date(msg.timestamp).toLocaleTimeString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>

                {msg.error ? (
                  <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{msg.content}</span>
                  </div>
                ) : msg.role === 'user' ? (
                  <p className="text-sm leading-relaxed">{msg.content}</p>
                ) : msg.content ? (
                  <MarkdownLite content={msg.content} />
                ) : (
                  <div className="space-y-2 py-1">
                    <div className="h-3 w-3/4 rounded bg-slate-200 dark:bg-slate-800" />
                    <div className="h-3 w-1/2 rounded bg-slate-200 dark:bg-slate-800" />
                  </div>
                )}
              </div>
            ))
          )}
          <div ref={endOfMessagesRef} />
        </div>

        {/* Input Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendConsult(input, 'CUSTOM');
          }}
          className="border-t border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-[#0B0F17]"
        >
          <div className="flex items-end gap-3">
            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendConsult(input, 'CUSTOM');
                }
              }}
              placeholder="Pergunte sobre hedge, lotes em US30/US100/XAUUSD, bônus ou regras..."
              className="flex-1 resize-none rounded-lg border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-[#111827] dark:text-slate-100"
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={handleCancelStream}
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-4 text-xs font-semibold text-red-600 transition-colors hover:bg-red-500/20 dark:text-red-400 whitespace-nowrap shrink-0"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                Cancelar
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="inline-flex h-11 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                <Send className="h-3.5 w-3.5" />
                Enviar
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
