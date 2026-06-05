import { useState } from 'react';
import Sidebar from './Sidebar';

function formatSync(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleString('id-ID', {
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit'
  });
}

export default function Layout({ children, syncedAt, bulan }) {
  const [open, setOpen] = useState(false);
  const syncStr = formatSync(syncedAt);

  return (
    <div className="layout">
      {/* Sidebar */}
      <aside className={`sidebar ${open ? 'sidebar--open' : ''}`}>
        <Sidebar onClose={() => setOpen(false)} />
      </aside>

      {/* Mobile overlay */}
      {open && (
        <div className="sidebar-overlay" onClick={() => setOpen(false)} />
      )}

      {/* Main area */}
      <div className="layout-main">
        <header className="topbar">
          <button className="hamburger" onClick={() => setOpen(true)} aria-label="Menu">
            <span /><span /><span />
          </button>
          <div className="topbar-right">
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
      </div>
    </div>
  );
}
