import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect, useRef }        from 'react';
import { logout, getUser }                     from '../utils/auth';
import { getMembers }                          from '../services/api';

const MENU_BEFORE = [
  { label: 'Unit Scoreboard', to: '/scoreboard', icon: 'ti-trophy' },
];
const MENU_AFTER = [
  { label: 'Payment Agent',  to: '/payment-agent',  icon: 'ti-building-bank' },
  { label: 'Dompet Digital', to: '/dompet-digital', icon: 'ti-wallet'        },
  { label: 'Kelola User',    to: '/users',           icon: 'ti-users', adminOnly: true },
];

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

export default function Sidebar({ onClose }) {
  const navigate  = useNavigate();
  const location  = useLocation();
  const user      = getUser();
  const [members, setMembers] = useState([]);

  /* Buka accordion otomatis jika sedang di /winme atau /anggota/:id */
  const isWinmePath = location.pathname === '/winme' ||
                      location.pathname.startsWith('/anggota/');
  const [open, setOpen] = useState(isWinmePath);

  /* Ref untuk height animation */
  const submenuRef = useRef(null);
  const [height, setHeight]   = useState(isWinmePath ? 'auto' : '0px');
  const [animate, setAnimate] = useState(false);

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

  /* Saat open berubah, set height dari scrollHeight */
  useEffect(() => {
    if (!submenuRef.current) return;
    setAnimate(true);
    if (open) {
      setHeight(submenuRef.current.scrollHeight + 'px');
      /* Setelah animasi selesai, biarkan auto agar resize tidak memotong */
      const t = setTimeout(() => setHeight('auto'), 260);
      return () => clearTimeout(t);
    } else {
      /* Paksa dari auto → px dulu sebelum collapse */
      setHeight(submenuRef.current.scrollHeight + 'px');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setHeight('0px'));
      });
    }
  }, [open]);

  /* Auto-buka jika navigasi ke winme/anggota */
  useEffect(() => {
    if (isWinmePath) setOpen(true);
  }, [location.pathname]);

  const hasMember = members.length > 0;

  function handleWinmeClick(e) {
    /* Jika ada member, klik header = toggle accordion.
       Tetap navigasi ke /winme (NavLink handle itu). */
    if (hasMember) {
      setOpen(o => !o);
    }
  }

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

        {MENU_BEFORE.map(m => (
          <NavLink
            key={m.to} to={m.to} onClick={onClose}
            className={({ isActive }) =>
              'sidebar-link' + (isActive ? ' sidebar-link--active' : '')
            }
          >
            <i className={`ti ${m.icon}`} aria-hidden="true" />
            <span>{m.label}</span>
          </NavLink>
        ))}

        {/* ── Winme accordion trigger ── */}
        <div className="sidebar-accordion-wrap">
          <NavLink
            to="/winme"
            onClick={e => { handleWinmeClick(e); onClose(); }}
            className={({ isActive }) =>
              'sidebar-link sidebar-link-accordion' +
              (isActive || isWinmePath ? ' sidebar-link--active' : '')
            }
          >
            <i className="ti ti-bolt" aria-hidden="true" />
            <span style={{ flex: 1 }}>Winme &amp; InstaQris</span>
            {hasMember && (
              <i
                className={'ti ti-chevron-down sidebar-chevron' + (open ? ' sidebar-chevron--open' : '')}
                aria-hidden="true"
                onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(o => !o); }}
              />
            )}
          </NavLink>

          {/* ── Submenu accordion ── */}
          <div
            ref={submenuRef}
            className={'sidebar-submenu' + (animate ? ' sidebar-submenu--animate' : '')}
            style={{ height, overflow: 'hidden' }}
          >
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
        </div>

        {MENU_AFTER.filter(m => !m.adminOnly || user?.role === 'admin').map(m => (
          <NavLink
            key={m.to} to={m.to} onClick={onClose}
            className={({ isActive }) =>
              'sidebar-link' + (isActive ? ' sidebar-link--active' : '')
            }
          >
            <i className={`ti ${m.icon}`} aria-hidden="true" />
            <span>{m.label}</span>
          </NavLink>
        ))}
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
