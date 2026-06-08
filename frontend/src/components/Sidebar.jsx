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

/* ── Accordion submenu dengan animasi height ── */
function AccordionMenu({ to, icon, label, children, autoOpenPaths = [] }) {
  const location   = useLocation();
  const submenuRef = useRef(null);
  const isActivePath = autoOpenPaths.some(p =>
    location.pathname === p || location.pathname.startsWith(p + '/')
  );
  const [open, setOpen]     = useState(isActivePath);
  const [height, setHeight] = useState(isActivePath ? 'auto' : '0px');
  const [didMount, setDidMount] = useState(false);

  useEffect(() => { setDidMount(true); }, []);

  useEffect(() => {
    if (isActivePath && !open) setOpen(true);
  }, [location.pathname]);

  useEffect(() => {
    if (!submenuRef.current || !didMount) return;
    if (open) {
      setHeight(submenuRef.current.scrollHeight + 'px');
      const t = setTimeout(() => setHeight('auto'), 260);
      return () => clearTimeout(t);
    } else {
      setHeight(submenuRef.current.scrollHeight + 'px');
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setHeight('0px'))
      );
    }
  }, [open]);

  const hasChildren = !!children;

  return (
    <div className="sidebar-accordion-wrap">
      <NavLink
        to={to}
        className={({ isActive }) =>
          'sidebar-link sidebar-link-accordion' +
          (isActive || isActivePath ? ' sidebar-link--active' : '')
        }
      >
        <i className={`ti ${icon}`} aria-hidden="true" />
        <span style={{ flex: 1 }}>{label}</span>
        {hasChildren && (
          <i
            className={'ti ti-chevron-down sidebar-chevron' + (open ? ' sidebar-chevron--open' : '')}
            aria-hidden="true"
            onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(o => !o); }}
          />
        )}
      </NavLink>

      {hasChildren && (
        <div
          ref={submenuRef}
          className="sidebar-submenu sidebar-submenu--animate"
          style={{ height, overflow: 'hidden' }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export default function Sidebar({ onClose }) {
  const navigate = useNavigate();
  const user     = getUser();
  const [members, setMembers] = useState([]);

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
        <NavLink
          to="/scoreboard" onClick={onClose}
          className={({ isActive }) =>
            'sidebar-link' + (isActive ? ' sidebar-link--active' : '')
          }
        >
          <i className="ti ti-trophy" aria-hidden="true" />
          <span>Unit Scoreboard</span>
        </NavLink>

        {/* Winme & InstaQris — plain link, no accordion */}
        <NavLink
          to="/winme" onClick={onClose}
          className={({ isActive }) =>
            'sidebar-link' + (isActive ? ' sidebar-link--active' : '')
          }
        >
          <i className="ti ti-bolt" aria-hidden="true" />
          <span>Winme &amp; InstaQris</span>
        </NavLink>

        {/* Scoreboard Tim — accordion dengan member links */}
        <AccordionMenu
          to="/scoreboard-tim"
          icon="ti-users"
          label="Scoreboard Tim"
          autoOpenPaths={['/scoreboard-tim', '/anggota']}
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
        </AccordionMenu>

        {/* Payment Agent */}
        <NavLink
          to="/payment-agent" onClick={onClose}
          className={({ isActive }) =>
            'sidebar-link' + (isActive ? ' sidebar-link--active' : '')
          }
        >
          <i className="ti ti-building-bank" aria-hidden="true" />
          <span>Payment Agent</span>
        </NavLink>

        {/* Dompet Digital */}
        <NavLink
          to="/dompet-digital" onClick={onClose}
          className={({ isActive }) =>
            'sidebar-link' + (isActive ? ' sidebar-link--active' : '')
          }
        >
          <i className="ti ti-wallet" aria-hidden="true" />
          <span>Dompet Digital</span>
        </NavLink>

        {/* Kelola User (admin only) */}
        {user?.role === 'admin' && (
          <NavLink
            to="/users" onClick={onClose}
            className={({ isActive }) =>
              'sidebar-link' + (isActive ? ' sidebar-link--active' : '')
            }
          >
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
