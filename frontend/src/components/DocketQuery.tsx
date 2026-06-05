import { useState, useRef, useEffect } from 'react';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface Message {
  role: 'user' | 'assistant' | 'status';
  content: string;
  cost?: { calls: number; input_tokens: number; output_tokens: number; cost: number };
  step1?: { answered_from_metadata: boolean; regex_hits: number; content_requested: number };
}

interface DocketQueryProps {
  dealId: string;
  focusEntry?: string;  // document_id of currently expanded filing
}

// Lightweight markdown → HTML (bold, italic, links, tables, lists, headings, blockquotes)
function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line
    if (!trimmed) { i++; continue; }

    // Horizontal rule
    if (/^(---|\*\*\*|___)$/.test(trimmed)) {
      html.push('<hr class="dq-hr"/>');
      i++;
      continue;
    }

    // Headings
    if (trimmed.startsWith('### ')) {
      html.push(`<h4 class="dq-h3">${inlineMarkdown(trimmed.slice(4))}</h4>`);
      i++; continue;
    }
    if (trimmed.startsWith('## ')) {
      html.push(`<h3 class="dq-h2">${inlineMarkdown(trimmed.slice(3))}</h3>`);
      i++; continue;
    }
    if (trimmed.startsWith('# ')) {
      html.push(`<h2 class="dq-h1">${inlineMarkdown(trimmed.slice(2))}</h2>`);
      i++; continue;
    }

    // Tables
    if (trimmed.startsWith('|') && trimmed.includes('|', 1)) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      html.push(renderTable(tableLines));
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('> ')) {
      html.push(`<blockquote class="dq-quote">${inlineMarkdown(trimmed.slice(2))}</blockquote>`);
      i++; continue;
    }

    // Bullet list
    const bulletMatch = trimmed.match(/^[-*]\s+(.*)/);
    if (bulletMatch) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const m = lines[i].trim().match(/^[-*]\s+(.*)/);
        if (m) items.push(m[1]);
        i++;
      }
      html.push('<ul class="dq-list">' + items.map(it => `<li>${inlineMarkdown(it)}</li>`).join('') + '</ul>');
      continue;
    }

    // Numbered list
    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
    if (numMatch) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const m = lines[i].trim().match(/^\d+\.\s+(.*)/);
        if (m) items.push(m[1]);
        i++;
      }
      html.push('<ol class="dq-list">' + items.map(it => `<li>${inlineMarkdown(it)}</li>`).join('') + '</ol>');
      continue;
    }

    // Regular paragraph
    html.push(`<p class="dq-p">${inlineMarkdown(trimmed)}</p>`);
    i++;
  }

  return html.join('');
}

function inlineMarkdown(text: string): string {
  // Escape HTML
  let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function renderTable(lines: string[]): string {
  const dataRows: string[][] = [];
  for (const line of lines) {
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    // Skip separator rows
    if (cells.every(c => /^[-:]+$/.test(c))) continue;
    dataRows.push(cells);
  }
  if (dataRows.length === 0) return '';

  let html = '<table class="dq-table"><thead><tr>';
  for (const cell of dataRows[0]) {
    html += `<th>${inlineMarkdown(cell)}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (let r = 1; r < dataRows.length; r++) {
    html += `<tr class="${r % 2 === 0 ? 'even' : 'odd'}">`;
    for (const cell of dataRows[r]) {
      html += `<td>${inlineMarkdown(cell)}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}


export default function DocketQuery({ dealId, focusEntry }: DocketQueryProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [ready, setReady] = useState<boolean | null>(null);
  const [entryCount, setEntryCount] = useState(0);
  const [model, setModel] = useState<'haiku' | 'sonnet' | 'opus'>('sonnet');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Check if engine is ready
  useEffect(() => {
    fetch(`${API_BASE}/api/deals/${dealId}/docket-query/status`, { headers: authHeaders() })
      .then(r => r.json())
      .then(data => {
        setReady(data.ready);
        setEntryCount(data.entry_count);
      })
      .catch(() => setReady(false));
  }, [dealId]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, statusText]);

  const sendQuery = async () => {
    const question = input.trim();
    if (!question || loading) return;

    setInput('');
    setLoading(true);
    setStatusText('');

    // Add user message
    const newMessages: Message[] = [...messages, { role: 'user', content: question }];
    setMessages(newMessages);

    // Build history for API (previous Q&A pairs)
    const history: { role: string; content: string }[] = [];
    for (const msg of messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        history.push({ role: msg.role, content: msg.content });
      }
    }

    try {
      const response = await fetch(`${API_BASE}/api/deals/${dealId}/docket-query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ question, history, model, focus_entry: focusEntry || null }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let answerText = '';
      let costInfo: Message['cost'] = undefined;
      let step1Info: Message['step1'] = undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const eventLines = buffer.split('\n');
        buffer = '';

        for (let li = 0; li < eventLines.length; li++) {
          const eLine = eventLines[li];
          if (eLine.startsWith('data: ')) {
            try {
              const data = JSON.parse(eLine.slice(6));

              if (data.type === 'status') {
                setStatusText(data.message);
              } else if (data.type === 'chunk') {
                answerText += data.content;
                // Update the assistant message in-place
                setMessages(prev => {
                  const updated = [...prev];
                  const lastIdx = updated.length - 1;
                  if (lastIdx >= 0 && updated[lastIdx].role === 'assistant') {
                    updated[lastIdx] = { ...updated[lastIdx], content: answerText };
                  } else {
                    updated.push({ role: 'assistant', content: answerText });
                  }
                  return updated;
                });
              } else if (data.type === 'answer') {
                // Full answer (metadata-only path)
                answerText = data.content;
                setMessages(prev => [...prev, { role: 'assistant', content: answerText }]);
              } else if (data.type === 'done') {
                costInfo = data.cost;
                step1Info = data.step1;
                setStatusText('');
                // Update last assistant message with cost
                setMessages(prev => {
                  const updated = [...prev];
                  const lastIdx = updated.length - 1;
                  if (lastIdx >= 0 && updated[lastIdx].role === 'assistant') {
                    updated[lastIdx] = { ...updated[lastIdx], cost: costInfo, step1: step1Info };
                  }
                  return updated;
                });
              }
            } catch {
              // Partial JSON, put back in buffer
              buffer = eventLines.slice(li).join('\n');
              break;
            }
          }
        }
      }

      // If no assistant message was added (edge case), add one
      setMessages(prev => {
        if (prev.length > 0 && prev[prev.length - 1].role === 'user' && answerText) {
          return [...prev, { role: 'assistant', content: answerText, cost: costInfo, step1: step1Info }];
        }
        return prev;
      });

    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
      }]);
    } finally {
      setLoading(false);
      setStatusText('');
      inputRef.current?.focus();
    }
  };

  const clearHistory = () => {
    setMessages([]);
  };

  if (ready === null) {
    return <div className="dq-loading">Checking query engine...</div>;
  }

  if (!ready) {
    return <div className="dq-unavailable">Query engine not available for this docket.</div>;
  }

  return (
    <div className="docket-query-panel">
      <div className="dq-header">
        <span className="dq-title">Docket Q&A</span>
        <span className="dq-meta">{entryCount} entries</span>
        <div className="dq-model-select">
          {(['haiku', 'sonnet', 'opus'] as const).map(m => (
            <button
              key={m}
              className={`dq-model-btn ${model === m ? 'active' : ''}`}
              onClick={() => setModel(m)}
            >{m}</button>
          ))}
        </div>
        {messages.length > 0 && (
          <button className="dq-clear-btn" onClick={clearHistory}>Clear</button>
        )}
      </div>

      <div className="dq-messages">
        {messages.length === 0 && (
          <div className="dq-empty">
            <p>Ask questions about this docket.</p>
            <div className="dq-suggestions">
              <button onClick={() => { setInput('Who are the main opponents of this merger?'); }}>
                Who opposes?
              </button>
              <button onClick={() => { setInput('What conditions has the STB imposed or discussed?'); }}>
                STB conditions?
              </button>
              <button onClick={() => { setInput('What environmental concerns have been raised?'); }}>
                Environmental?
              </button>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`dq-message dq-${msg.role}`}>
            {msg.role === 'user' && (
              <div className="dq-user-bubble">{msg.content}</div>
            )}
            {msg.role === 'assistant' && (
              <div className="dq-assistant-bubble">
                <div
                  className="dq-answer-content"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                />
                {msg.cost && (
                  <div className="dq-cost-line">
                    {msg.step1?.answered_from_metadata ? 'metadata' : `${msg.step1?.content_requested} entries`}
                    {msg.step1 && msg.step1.regex_hits > 0 && ` · ${msg.step1.regex_hits} regex hits`}
                    {' · '}${msg.cost.cost.toFixed(4)}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {statusText && (
          <div className="dq-status-line">
            <span className="dq-spinner" />
            {statusText}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="dq-input-bar">
        <input
          ref={inputRef}
          type="text"
          className="dq-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') sendQuery(); }}
          placeholder="Ask about this docket..."
          disabled={loading}
        />
        <button
          className="dq-send-btn"
          onClick={sendQuery}
          disabled={loading || !input.trim()}
        >
          {loading ? '...' : 'Ask'}
        </button>
      </div>
    </div>
  );
}
