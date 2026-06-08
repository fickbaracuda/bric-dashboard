import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect, useRef }        from 'react';
import { logout, getUser }                     from '../utils/auth';
import { getMembers }                          from '../services/api';

function getInisial(nama) {
  const w = nama.trim().split(' ');
  return w.length >= 2
    ? (w[0][0] + w[1][0]).toUpperCase()
    : nama.substring(0, 2).toUpperCase();
}

function getStatusColor(member) {
  const valid = (member.targets || []).filter(t => t.pencapaian_terakhir?.pct_revenue > 0);
  if (!valid.length) return '#9CA3AF';
  const avg = valid.reduce((s, t) =>
    s + parseFloat(t.pencapaian_terakhir?.pct_revenue || 0), 0) / valid.length;
  if (avg >= 100) return '#1D9E75';
  if (avg >= 80)  return '#F59E0B';
  if (avg >= 70)  return '#EF4444';
  return '#DC2626';
}

function getStatusLabel(member) {
  const valid = (member.targets || []).filter(t => t.pencapaian_terakhir?.pct_revenue > 0);
  if (!valid.length) return 'Belum ada data pencapaian';
  const avg = valid.reduce((s, t) =>
    s + parseFloat(t.pencapaian_terakhir?.pct_revenue || 0), 0) / valid.length;
  return `Avg pencapaian: ${avg.toFixed(1)}%`;
}

/* ── Reusable animated accordion ── */
function Accordion({ open, children }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(open ? 'auto' : '0px');
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    if (!ref.current) return;
    if (open) {
      setHeight(ref.current.scrollHeight + 'px');
      const t = setTimeout(() => setHeight('auto'), 260);
      return () => clearTimeout(t);
    } else {
      setHeight(ref.current.scrollHeight + 'px');
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setHeight('0px'))
      );
    }
  }, [open]);

  return (
    <div
      ref={ref}
      style={{ height, overflow: 'hidden', transition: 'height 0.25s ease' }}
    >
      {children}
    </div>
  );
}

export default function Sidebar({ onClose }) {
  const navigate  = useNavigate();
  const location  = useLocation();
  const user      = getUser();
  const [members, setMembers] = useState([]);

  const isWinmePath    = location.pathname === '/winme';
  const isTimPath      = location.pathname === '/scoreboard-tim' ||
                         location.pathname.startsWith('/anggota/');

  /* Winme accordion — buka jika di /winme, /scoreboard-tim, atau /anggota/* */
  const [winmeOpen, setWinmeOpen] = useState(isWinmePath || isTimPath);
  /* Scoreboard Tim accordion — buka jika di /scoreboard-tim atau /anggota/* */
  const [timOpen,   setTimOpen]   = useState(isTimPath);

  useEffect(() => {
    if (isWinmePath || isTimPath) setWinmeOpen(true);
    if (isTimPath) setTimOpen(true);
  }, [location.pathname]);

  const loadMembers = () => {
    getMembers('winme_instaqris')
      .then(data => setMembers(data))
      .catch(() => setMembers([]));
  };

  useEffect(() => {
    loadMembers();
    const handler = () => loadMembers();
    window.addEventListener('membersUpdated', handler);
    return () => window.removeEventListener('membersUpdated', handler);
  }, []);

  const hasMember = members.length > 0;

  return (
    <div className="sidebar-inner">
      <button className="sidebar-close" onClick={onClose}>✕</button>

      <div className="sidebar-logo-wrap">
        <div className="sidebar-logo">BRIC</div>
        <div className="sidebar-logo-sub">Bisnis Retail Insight Center</div>
      </div>

      <div className="sidebar-divider" />

      <nav className="sidebar-nav">
        <div className="sidebar-nav-label">MENU</div>

        {/* Unit Scoreboard */}
        <NavLink to="/scoreboard" onClick={onClose}
          className={({ isActive }) => 'sidebar-link' + (isActive ? ' sidebar-link--active' : '')}>
          <i className="ti ti-trophy" aria-hidden="true" />
          <span>Unit Scoreboard</span>
        </NavLink>

        {/* ── Winme & InstaQris (level 1 accordion) ── */}
        <div className="sidebar-accordion-wrap">
          <NavLink
            to="/winme"
            onClick={() => { setWinmeOpen(o => !o); onClose(); }}
            className={({ isActive }) =>
              'sidebar-link sidebar-link-accordion' +
              (isActive || isWinmePath || isTimPath ? ' sidebar-link--active' : '')
            }
          >
            <i className="ti ti-bolt" aria-hidden="true" />
            <span style={{ flex: 1 }}>Winme &amp; InstaQris</span>
            <i
              className={'ti ti-chevron-down sidebar-chevron' + (winmeOpen ? ' sidebar-chevron--open' : '')}
              onClick={e => { e.preventDefault(); e.stopPropagation(); setWinmeOpen(o => !o); }}
              aria-hidden="true"
            />
          </NavLink>

          <Accordion open={winmeOpen}>
            <div className="sidebar-submenu">

              {/* ── Scoreboard Tim (level 2 accordion) ── */}
              <div className="sidebar-accordion-wrap">
                <NavLink
                  to="/scoreboard-tim"
                  onClick={() => { if (hasMember) setTimOpen(o => !o); onClose(); }}
                  className={({ isActive }) =>
                    'sidebar-link sidebar-link-accordion sidebar-link-sub' +
                    (isActive || isTimPath ? ' sidebar-link--active' : '')
                  }
                >
                  <i className="ti ti-users" aria-hidden="true" />
                  <span style={{ flex: 1 }}>Scoreboard Tim</span>
                  {hasMember && (
                    <i
                      className={'ti ti-chevron-down sidebar-chevron' + (timOpen ? ' sidebar-chevron--open' : '')}
                      onClick={e => { e.preventDefault(); e.stopPropagation(); setTimOpen(o => !o); }}
                      aria-hidden="true"
                    />
                  )}
                </NavLink>

                <Accordion open={timOpen && hasMember}>
                  <div className="sidebar-submenu sidebar-submenu--deep">
                    {members.map(m => (
                      <NavLink
                        key={m.id} to={`/anggota/${m.id}`} onClick={onClose}
                        className={({ isActive }) =>
                          'sidebar-link sidebar-link-member' + (isActive ? ' sidebar-link--active' : '')
                        }
                        title={getStatusLabel(m)}
                      >
                        <div className="sidebar-avatar-sm" style={{ background: m.avatar_warna }}>
                          {getInisial(m.nama)}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="sidebar-member-name">{m.nama}</div>
                          <div className="sidebar-member-role">
                            {m.posisi === 'leader' ? 'Leader' : 'Tim'}
                          </div>
                        </div>
                        <span className="sidebar-status-dot" style={{ background: getStatusColor(m) }} />
                      </NavLink>
                    ))}
                  </div>
                </Accordion>
              </div>

            </div>
          </Accordion>
        </div>

        {/* Payment Agent */}
        <NavLink to="/payment-agent" onClick={onClose}
          className={({ isActive }) => 'sidebar-link' + (isActive ? ' sidebar-link--active' : '')}>
          <i className="ti ti-building-bank" aria-hidden="true" />
          <span>Payment Agent</span>
        </NavLink>

        {/* Dompet Digital */}
        <NavLink to="/dompet-digital" onClick={onClose}
          className={({ isActive }) => 'sidebar-link' + (isActive ? ' sidebar-link--active' : '')}>
          <i className="ti ti-wallet" aria-hidden="true" />
          <span>Dompet Digital</span>
        </NavLink>

        {/* Kelola User (admin only) */}
        {user?.role === 'admin' && (
          <NavLink to="/users" onClick={onClose}
            className={({ isActive }) => 'sidebar-link' + (isActive ? ' sidebar-link--active' : '')}>
            <i className="ti ti-users" aria-hidden="true" />
            <span>Kelola User</span>
          </NavLink>
        )}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-divider" />
        <div className="sidebar-user">
          <div className="sidebar-user-avatar">
            {user?.username?.[0]?.toUpperCase() || 'U'}
          </div>
          <div className="sidebar-user-info">
            <div className="sidebar-user-name">{user?.username || 'User'}</div>
            <div className="sidebar-user-role">{user?.role || 'viewer'}</div>
          </div>
          <button
            className="sidebar-logout"
            onClick={() => { logout(); navigate('/login', { replace: true }); }}
            title="Keluar"
          >
            <i className="ti ti-power" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
