import { useState, useRef, useEffect } from 'react';
import { sendAiMessage } from '../services/api';

const SUGGESTIONS = [
  'Apa itu status On Track dan Unggul?',
  'Bagaimana cara meningkatkan pencapaian KPI?',
  'Apa perbedaan Revenue Target RKAP vs pencapaian?',
  'Tips analisa performa tim yang efektif?',
];

function TypingDots() {
  return (
    <div className="aic-bubble aic-bubble-ai aic-typing">
      <span /><span /><span />
    </div>
  );
}

function Bubble({ msg }) {
  const isAi = msg.role === 'ai';
  return (
    <div className={'aic-row ' + (isAi ? 'aic-row-ai' : 'aic-row-user')}>
      {isAi && (
        <div className="aic-avatar-ai">
          <i className="ti ti-sparkles" />
        </div>
      )}
      <div className={'aic-bubble ' + (isAi ? 'aic-bubble-ai' : 'aic-bubble-user')}>
        {msg.text.split('\n').map((line, i) => (
          <span key={i}>{line}{i < msg.text.split('\n').length - 1 && <br />}</span>
        ))}
      </div>
    </div>
  );
}

export default function AiChat() {
  const [open,    setOpen]    = useState(false);
  const [input,   setInput]   = useState('');
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  /* Auto-scroll ke bawah saat ada pesan baru */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, loading]);

  /* Fokus input saat panel dibuka */
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open]);

  async function send(text) {
    const msg = (text || input).trim();
    if (!msg || loading) return;
    setInput('');
    setError('');

    const newHistory = [...history, { role: 'user', text: msg }];
    setHistory(newHistory);
    setLoading(true);

    try {
      const { reply } = await sendAiMessage(msg, history);
      setHistory(h => [...h, { role: 'ai', text: reply }]);
    } catch (err) {
      const msg = err.response?.data?.error || 'Gagal mendapat respons. Coba lagi.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  function clearChat() {
    setHistory([]);
    setError('');
  }

  return (
    <>
      {/* ── Floating Button ── */}
      <button
        className={'aic-fab ' + (open ? 'aic-fab--open' : '')}
        onClick={() => setOpen(o => !o)}
        title={open ? 'Tutup AI Chat' : 'Tanya AI'}
        aria-label="AI Chat"
      >
        <i className={'ti ' + (open ? 'ti-x' : 'ti-message-chatbot')} />
        {!open && history.length === 0 && (
          <span className="aic-fab-label">Tanya AI</span>
        )}
        {!open && history.length > 0 && (
          <span className="aic-fab-badge">{history.filter(h => h.role === 'ai').length}</span>
        )}
      </button>

      {/* ── Chat Panel ── */}
      <div className={'aic-panel ' + (open ? 'aic-panel--open' : '')}>
        {/* Header */}
        <div className="aic-header">
          <div className="aic-header-left">
            <div className="aic-header-icon">
              <i className="ti ti-sparkles" />
            </div>
            <div>
              <div className="aic-header-title">BRIC AI Assistant</div>
              <div className="aic-header-sub">Powered by Gemini · Selalu siap membantu</div>
            </div>
          </div>
          <div className="aic-header-actions">
            {history.length > 0 && (
              <button className="aic-icon-btn" onClick={clearChat} title="Hapus percakapan">
                <i className="ti ti-trash" />
              </button>
            )}
            <button className="aic-icon-btn" onClick={() => setOpen(false)} title="Tutup">
              <i className="ti ti-x" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="aic-messages">
          {/* Welcome state */}
          {history.length === 0 && (
            <div className="aic-welcome">
              <div className="aic-welcome-icon">
                <i className="ti ti-robot" />
              </div>
              <div className="aic-welcome-title">Halo! Saya BRIC AI</div>
              <div className="aic-welcome-sub">
                Tanyakan apa saja seputar dashboard, data performa, atau strategi bisnis.
              </div>
              <div className="aic-suggestions">
                {SUGGESTIONS.map((s, i) => (
                  <button key={i} className="aic-suggestion" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Chat history */}
          {history.map((msg, i) => <Bubble key={i} msg={msg} />)}

          {/* Typing indicator */}
          {loading && <div className="aic-row aic-row-ai"><div className="aic-avatar-ai"><i className="ti ti-sparkles" /></div><TypingDots /></div>}

          {/* Error */}
          {error && (
            <div className="aic-error">
              <i className="ti ti-alert-circle" /> {error}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="aic-input-wrap">
          <textarea
            ref={inputRef}
            className="aic-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ketik pertanyaan... (Enter untuk kirim)"
            rows={1}
            maxLength={2000}
            disabled={loading}
          />
          <button
            className="aic-send"
            onClick={() => send()}
            disabled={!input.trim() || loading}
            title="Kirim (Enter)"
          >
            {loading
              ? <i className="ti ti-loader-2 aic-spin" />
              : <i className="ti ti-send" />
            }
          </button>
        </div>
        <div className="aic-footer-note">
          Gemini 1.5 Flash · Respons dapat berbeda tiap sesi
        </div>
      </div>
    </>
  );
}
