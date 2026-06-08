import { useState, useRef, useEffect, useCallback } from 'react';
import { sendAiMessage, getAiContext, saveChatMessage, getChatHistory, deleteChatHistory } from '../services/api';

/* ─ Page detection ─ */
function getPageInfo() {
  const path = window.location.pathname;
  let page      = 'scoreboard';
  let member_id = null;

  if (path === '/' || path.startsWith('/scoreboard') && !path.startsWith('/scoreboard-tim'))
    page = 'scoreboard';
  else if (path.startsWith('/scoreboard-tim')) page = 'scoreboard-tim';
  else if (path.startsWith('/winme'))          page = 'winme';
  else if (path.startsWith('/payment-agent'))  page = 'payment-agent';
  else if (path.startsWith('/dompet-digital')) page = 'dompet';
  else if (path.startsWith('/anggota/')) {
    page = 'anggota';
    member_id = path.split('/')[2] || null;
  } else if (path.startsWith('/leader-scoreboard')) page = 'leader-scoreboard';

  return { page, member_id };
}

function getCurrentBulan() {
  const now   = new Date();
  const month = now.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  return `${month}_${now.getFullYear()}`;
}

/* ─ Quick Questions per halaman ─ */
const QUICK_QUESTIONS = {
  scoreboard: [
    'Unit mana yang paling kritis saat ini?',
    'Analisa 3 unit KPI terendah bulan ini',
    'Berapa total gap BMS ke target?',
    'Proyeksikan akhir bulan jika tren berlanjut',
  ],
  winme: [
    'Analisa kondisi Winme vs target bulan ini',
    'Performa InstaQris dibanding Winme?',
    'Berapa gap Winme ke target dan sisa harinya?',
    'Strategi akselerasi InstaQris minggu ini',
  ],
  'payment-agent': [
    'Analisa pace Payment Agent hari ini',
    'Berapa rata-rata harian untuk tutup gap?',
    'Kondisi Payment Agent vs target RKAP?',
    'Rekomendasi konkret akselerasi revenue',
  ],
  dompet: [
    'Sub-unit mana yang paling bermasalah?',
    'Analisa SpeedCash vs Travel B2C vs Pulsagram',
    'Berapa kontribusi tiap sub-unit ke grup?',
    'Strategi recover sub-unit di bawah target',
  ],
  'scoreboard-tim': [
    'Leader mana yang paling on track?',
    'Siapa yang paling butuh perhatian segera?',
    'Bandingkan performa antar leader',
    'Analisa distribusi beban antar tim',
  ],
  'leader-scoreboard': [
    'Siapa leader dengan KPI tertinggi?',
    'Leader mana yang butuh intervensi sekarang?',
    'Analisa gap pencapaian lintas leader',
    'Rekomendasi coaching untuk leader bermasalah',
  ],
  anggota: [
    'Analisa kondisi anggota ini sekarang',
    'Tren pencapaian 7 hari terakhir?',
    'Gap ke target dan strategi mengatasinya?',
    'Rekomendasi konkret untuk naikkan KPI',
  ],
  default: [
    'Analisa kondisi BMS secara keseluruhan',
    'Unit mana yang perlu perhatian segera?',
    'Proyeksi akhir bulan ini?',
    'Prioritas tindakan untuk minggu ini',
  ],
};

function getWelcomeMessage(page) {
  const messages = {
    scoreboard:          'Data seluruh unit sudah saya baca. Tanya tentang performa, gap, atau proyeksi akhir bulan.',
    winme:               'Data Winme & InstaQris sudah dimuat. Siap analisa performa, gap, dan strategi.',
    'payment-agent':     'Data Payment Agent sudah saya baca. Mau analisa pace, gap ke target, atau strategi akselerasi?',
    dompet:              'Data SpeedCash, Travel B2C, Pulsagram sudah dimuat. Siap analisa sub-unit mana saja.',
    'scoreboard-tim':    'Data scoreboard tim sudah dimuat. Mau bandingkan performa antar leader?',
    'leader-scoreboard': 'Data semua leader sudah saya baca. Siap analisa ranking, gap, dan rekomendasi coaching.',
    anggota:             'Profil dan pencapaian anggota sudah saya baca. Tanya apa saja tentang kondisinya.',
    default:             'Halo! Saya BRIC AI. Tanyakan apa saja seputar data performa dan strategi bisnis BMS.',
  };
  return messages[page] || messages.default;
}

/* ─ Sub-components ─ */
function TypingDots() {
  return (
    <div className="aic-bubble aic-bubble-ai aic-typing">
      <span /><span /><span />
    </div>
  );
}

function Bubble({ msg }) {
  const isAi = msg.role === 'ai';
  const lines = msg.text.split('\n');
  return (
    <div className={'aic-row ' + (isAi ? 'aic-row-ai' : 'aic-row-user')}>
      {isAi && <div className="aic-avatar-ai"><i className="ti ti-sparkles" /></div>}
      <div className={'aic-bubble ' + (isAi ? 'aic-bubble-ai' : 'aic-bubble-user')}>
        {lines.map((line, i) => (
          <span key={i}>{line}{i < lines.length - 1 && <br />}</span>
        ))}
      </div>
    </div>
  );
}

/* ─ Main Component ─ */
export default function AiChat() {
  const [open,           setOpen]          = useState(false);
  const [input,          setInput]         = useState('');
  const [history,        setHistory]       = useState([]);
  const [loading,        setLoading]       = useState(false);
  const [error,          setError]         = useState('');
  const [systemPrompt,   setSystemPrompt]  = useState('');
  const [pageQuestions,  setPageQuestions] = useState(QUICK_QUESTIONS.default);
  const [welcomeMsg,     setWelcomeMsg]    = useState(getWelcomeMessage('default'));
  const [contextLoading, setCtxLoading]   = useState(false);
  const [currentPage,    setCurrentPage]   = useState('default');
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, loading]);

  const loadContextAndHistory = useCallback(async () => {
    const { page, member_id } = getPageInfo();
    setCurrentPage(page);
    setPageQuestions(QUICK_QUESTIONS[page] || QUICK_QUESTIONS.default);
    setWelcomeMsg(getWelcomeMessage(page));
    setCtxLoading(true);

    try {
      const params = { page, bulan: getCurrentBulan() };
      if (member_id) params.member_id = member_id;

      const [ctxRes, histRes] = await Promise.all([
        getAiContext(params),
        getChatHistory({ page, limit: 20 }),
      ]);

      if (ctxRes?.systemPrompt) setSystemPrompt(ctxRes.systemPrompt);

      if (histRes?.length) {
        setHistory(histRes.map(h => ({
          role: h.role === 'model' ? 'ai' : 'user',
          text: h.message,
        })));
      }
    } catch (err) {
      console.warn('AI context load failed:', err.message);
    } finally {
      setCtxLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadContextAndHistory();
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [open, loadContextAndHistory]);

  async function send(text) {
    const msg = (text || input).trim();
    if (!msg || loading) return;
    setInput('');
    setError('');

    const newHistory = [...history, { role: 'user', text: msg }];
    setHistory(newHistory);
    setLoading(true);

    try {
      const { reply } = await sendAiMessage(msg, history, systemPrompt);
      setHistory(h => [...h, { role: 'ai', text: reply }]);

      /* Simpan ke DB (silent) */
      const page = currentPage;
      saveChatMessage({ role: 'user',  message: msg,   page }).catch(() => {});
      saveChatMessage({ role: 'model', message: reply, page }).catch(() => {});
    } catch (err) {
      const status = err.response?.status;
      const serverMsg = err.response?.data?.error;
      let errMsg = serverMsg || 'Gagal mendapat respons. Coba lagi.';
      if (status === 503) errMsg = 'AI sedang padat permintaan. Tunggu beberapa detik lalu kirim ulang.';
      if (status === 429) errMsg = 'Terlalu banyak pesan. Tunggu sebentar lalu coba lagi.';
      setError(errMsg);
    } finally {
      setLoading(false);
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  async function clearChat() {
    setHistory([]);
    setError('');
    deleteChatHistory(currentPage).catch(() => {});
  }

  const hasHistory = history.length > 0;

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
        {!open && !hasHistory && <span className="aic-fab-label">Tanya AI</span>}
        {!open && hasHistory && (
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
              <div className="aic-header-sub">Powered by Gemini 2.5 · Data real-time</div>
            </div>
          </div>
          <div className="aic-header-actions">
            {hasHistory && (
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
          {!hasHistory && (
            <div className="aic-welcome">
              <div className="aic-welcome-icon">
                <i className="ti ti-robot" />
              </div>
              <div className="aic-welcome-title">Halo! Saya BRIC AI</div>
              <div className="aic-welcome-sub">
                {contextLoading
                  ? 'Membaca data dashboard...'
                  : welcomeMsg
                }
              </div>
              {!contextLoading && (
                <div className="aic-suggestions">
                  {pageQuestions.map((q, i) => (
                    <button key={i} className="aic-suggestion" onClick={() => send(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              )}
              {contextLoading && (
                <div className="aic-ctx-loading">
                  <i className="ti ti-loader-2 aic-spin" /> Memuat konteks halaman...
                </div>
              )}
            </div>
          )}

          {/* Chat history */}
          {history.map((msg, i) => <Bubble key={i} msg={msg} />)}

          {/* Typing indicator */}
          {loading && (
            <div className="aic-row aic-row-ai">
              <div className="aic-avatar-ai"><i className="ti ti-sparkles" /></div>
              <TypingDots />
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="aic-error">
              <i className="ti ti-alert-circle" /> {error}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Quick question chips (muncul juga saat ada history) */}
        {hasHistory && !loading && (
          <div className="aic-chips-bar">
            {pageQuestions.slice(0, 2).map((q, i) => (
              <button key={i} className="aic-chip" onClick={() => send(q)}>
                {q}
              </button>
            ))}
          </div>
        )}

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
            disabled={loading || contextLoading}
          />
          <button
            className="aic-send"
            onClick={() => send()}
            disabled={!input.trim() || loading || contextLoading}
            title="Kirim (Enter)"
          >
            {loading
              ? <i className="ti ti-loader-2 aic-spin" />
              : <i className="ti ti-send" />
            }
          </button>
        </div>
        <div className="aic-footer-note">
          Gemini 2.5 Flash · Data rahasia internal BMS Retail
        </div>
      </div>
    </>
  );
}
