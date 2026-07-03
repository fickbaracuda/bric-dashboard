import { useState, useEffect, useRef } from 'react';
import Sidebar from './Sidebar';
import AiChat from './AiChat';
import { pingPresence } from '../services/api';
import { resolveInitialTheme, setTheme } from '../utils/theme';

/* Avatar color berdasarkan hash username */
const AVATAR_COLORS = [
  '#7F77DD','#1D9E75','#378ADD','#EF4444',
  '#F59E0B','#D85A30','#6D28D9','#0891B2',
];
function avatarColor(name = '') {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[h];
}
function initials(name = '') {
  return name.slice(0, 2).toUpperCase();
}

const ROLE_LABEL = {
  admin:    'Admin',
  viewer:   'Viewer',
  operator: 'Operator',
};

function formatSync(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleString('id-ID', {
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit'
  });
}

export default function Layout({ children, syncedAt, bulan, gsheetUrl, gsheetLabel }) {
  const [open, setOpen]               = useState(false);
  const [activeUsers, setActiveUsers] = useState([]);
  const [theme, setThemeState]        = useState(resolveInitialTheme);
  const timerRef                      = useRef(null);
  const sidebarRef                    = useRef(null);
  const syncStr                       = formatSync(syncedAt);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
  }

  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      const w = entry.borderBoxSize[0].inlineSize;
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  async function doPing() {
    try {
      const users = await pingPresence();
      setActiveUsers(users);
    } catch {
      /* silent — jangan crash jika presence gagal */
    }
  }

  useEffect(() => {
    doPing();
    timerRef.current = setInterval(doPing, 30_000);
    return () => clearInterval(timerRef.current);
  }, []);

  return (
    <div className="layout">
      <aside ref={sidebarRef} className={`sidebar ${open ? 'sidebar--open' : ''}`}>
        <Sidebar onClose={() => setOpen(false)} />
      </aside>

      {open && (
        <div className="sidebar-overlay" onClick={() => setOpen(false)} />
      )}

      <div className="layout-main">
        <header className="topbar">
          <button className="hamburger" onClick={() => setOpen(true)} aria-label="Menu">
            <span /><span /><span />
          </button>
          <div className="topbar-right">
            <button
              className="theme-toggle"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Ganti ke mode terang' : 'Ganti ke mode malam'}
              title={theme === 'dark' ? 'Mode Terang' : 'Mode Malam'}
            >
              <i className={theme === 'dark' ? 'ti ti-sun' : 'ti ti-moon'} />
            </button>
            {syncStr && (
              <span className="chip chip-sync">
                <span className="chip-dot" />
                Sync {syncStr}
              </span>
            )}
            {bulan && (
              <span className="chip chip-bulan">{bulan.replace('_', ' ')}</span>
            )}
          </div>
        </header>

        <main className="main-content">
          {children}
        </main>

        {/* AI Chat floating button */}
        <AiChat />

        {/* GSheet link bar */}
        {gsheetUrl && (
          <div className="gsheet-bar">
            <span className="gsheet-bar-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
            </span>
            <span className="gsheet-bar-label">Sumber Data{gsheetLabel ? ` · ${gsheetLabel}` : ''}</span>
            <a
              href={gsheetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="gsheet-bar-link"
            >
              Buka Google Sheet <i className="ti ti-external-link" style={{ fontSize: 11 }} />
            </a>
            <span className="gsheet-bar-note">Data diperbarui otomatis via Apps Script</span>
          </div>
        )}

        {/* Footer — siapa yang sedang aktif membuka dashboard */}
        <footer className="presence-footer">
          <span className="presence-label">
            <i className="ti ti-users" />
            {activeUsers.length} aktif
          </span>
          <div className="presence-list">
            {activeUsers.map(u => (
              <div key={u.username} className="presence-user" title={`${u.username} · ${ROLE_LABEL[u.role] || u.role}`}>
                <span
                  className="presence-avatar"
                  style={{ background: avatarColor(u.username) }}
                >
                  {initials(u.username)}
                </span>
                <span className="presence-name">{u.username}</span>
                <span className="presence-dot" />
              </div>
            ))}
          </div>
        </footer>
      </div>
    </div>
  );
}
