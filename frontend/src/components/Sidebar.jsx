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

/* ── Animated height accordion ── */
function Accordion({ open, children }) {
  const ref     = useRef(null);
  const mounted = useRef(false);
  const [height, setHeight] = useState(open ? 'auto' : '0px');

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
    <div ref={ref} style={{ height, overflow: 'hidden', transition: 'height 0.25s ease' }}>
      {children}
    </div>
  );
}

/* ── Per-leader accordion: leader row + tim rows di bawahnya ── */
function LeaderAccordion({ leader, timList, onClose, currentPath }) {
  const hasTim     = timList.length > 0;
  const isTimActive = timList.some(t => currentPath === `/anggota/${t.id}`);
  const [open, setOpen] = useState(isTimActive);

  useEffect(() => {
    if (isTimActive) setOpen(true);
  }, [currentPath]);

  return (
    <div className="sidebar-leader-group">
      {/* Leader row */}
      <div className="sidebar-leader-row">
        <NavLink
          to={`/anggota/${leader.id}`} onClick={onClose}
          className={({ isActive }) =>
            'sidebar-link sidebar-link-member sidebar-link-leader-item' +
            (isActive ? ' sidebar-link--active' : '')
          }
          title={getStatusLabel(leader)}
          style={{ flex: 1 }}
        >
          <div className="sidebar-avatar-sm" style={{ background: leader.avatar_warna }}>
            {getInisial(leader.nama)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="sidebar-member-name">{leader.nama}</div>
            <div className="sidebar-member-role" style={{ color: '#7F77DD', fontWeight: 600 }}>
              Leader {hasTim && <span style={{ color: '#9CA3AF', fontWeight: 400 }}>· {timList.length} tim</span>}
            </div>
          </div>
          <span className="sidebar-status-dot" style={{ background: getStatusColor(leader) }} />
        </NavLink>
        {hasTim && (
          <button
            className="sidebar-leader-chevron"
            onClick={() => setOpen(o => !o)}
            title={open ? 'Sembunyikan tim' : 'Tampilkan tim'}
          >
            <i className={'ti ti-chevron-down sidebar-chevron' + (open ? ' sidebar-chevron--open' : '')} />
          </button>
        )}
      </div>

      {/* Tim rows — accordion */}
      {hasTim && (
        <Accordion open={open}>
          <div className="sidebar-tim-list">
            {timList.map(tim => (
              <NavLink
                key={tim.id} to={`/anggota/${tim.id}`} onClick={onClose}
                className={({ isActive }) =>
                  'sidebar-link sidebar-link-member sidebar-link-tim-item' +
                  (isActive ? ' sidebar-link--active' : '')
                }
                title={getStatusLabel(tim)}
              >
                <div className="sidebar-avatar-sm sidebar-avatar-tim"
                  style={{ background: tim.avatar_warna }}>
                  {getInisial(tim.nama)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="sidebar-member-name">{tim.nama}</div>
                  <div className="sidebar-member-role">Tim</div>
                </div>
                <span className="sidebar-status-dot" style={{ background: getStatusColor(tim) }} />
              </NavLink>
            ))}
          </div>
        </Accordion>
      )}
    </div>
  );
}

/* ── Main Sidebar ── */
export default function Sidebar({ onClose }) {
  const navigate  = useNavigate();
  const location  = useLocation();
  const user      = getUser();
  const [members, setMembers] = useState([]);

  const isWinmePath = location.pathname === '/winme';
  const isTimPath   = location.pathname === '/scoreboard-tim' ||
                      location.pathname.startsWith('/anggota/');

  const [winmeOpen, setWinmeOpen] = useState(isWinmePath || isTimPath);
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

  const leaders  = members.filter(m => m.posisi === 'leader');
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

        <div className="sidebar-menu-sep" />

        {/* ── Winme & InstaQris — level 1 accordion ── */}
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

              {/* ── Scoreboard Tim — level 2 accordion ── */}
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

                    {/* Tiap leader punya accordion tim-nya sendiri */}
                    {leaders.map(leader => {
                      const timList = members.filter(
                        m => m.posisi === 'tim' && String(m.leader_id) === String(leader.id)
                      );
                      return (
                        <LeaderAccordion
                          key={leader.id}
                          leader={leader}
                          timList={timList}
                          onClose={onClose}
                          currentPath={location.pathname}
                        />
                      );
                    })}

                    {/* Tim tanpa leader (fallback) */}
                    {members.filter(m => m.posisi === 'tim' && !m.leader_id).map(tim => (
                      <NavLink
                        key={tim.id} to={`/anggota/${tim.id}`} onClick={onClose}
                        className={({ isActive }) =>
                          'sidebar-link sidebar-link-member' + (isActive ? ' sidebar-link--active' : '')
                        }
                        title={getStatusLabel(tim)}
                      >
                        <div className="sidebar-avatar-sm" style={{ background: tim.avatar_warna }}>
                          {getInisial(tim.nama)}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="sidebar-member-name">{tim.nama}</div>
                          <div className="sidebar-member-role">Tim</div>
                        </div>
                        <span className="sidebar-status-dot" style={{ background: getStatusColor(tim) }} />
                      </NavLink>
                    ))}

                  </div>
                </Accordion>
              </div>

            </div>
          </Accordion>
        </div>

        <div className="sidebar-menu-sep" />

        {/* Payment Agent */}
        <NavLink to="/payment-agent" onClick={onClose}
          className={({ isActive }) => 'sidebar-link' + (isActive ? ' sidebar-link--active' : '')}>
          <i className="ti ti-building-bank" aria-hidden="true" />
          <span>Payment Agent</span>
        </NavLink>

        <div className="sidebar-menu-sep" />

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
