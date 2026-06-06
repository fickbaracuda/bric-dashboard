import { NavLink, useNavigate } from 'react-router-dom';
import { logout, getUser } from '../utils/auth';

const menus = [
  { label: 'Unit Scoreboard',   to: '/scoreboard', icon: '⬡' },
  { label: 'Payment Agent',    to: '/payment-agent',  icon: '◎' },
  { label: 'Dompet Digital',   to: '/dompet-digital', icon: '◈' },
  { label: 'Winme & InstaQris', to: '/winme',         icon: '⚡' },
  { label: 'Kelola User',       to: '/users',      icon: '👥', adminOnly: true },
];

export default function Sidebar({ onClose }) {
  const navigate  = useNavigate();
  const user      = getUser();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="sidebar-inner">
      {/* Close button — mobile only */}
      <button className="sidebar-close" onClick={onClose}>✕</button>

      {/* Logo */}
      <div className="sidebar-logo-wrap">
        <div className="sidebar-logo">BRIC</div>
        <div className="sidebar-logo-sub">Bisnis Retail Insight Center</div>
      </div>

      <div className="sidebar-divider" />

      {/* Navigation */}
      <nav className="sidebar-nav">
        <div className="sidebar-nav-label">MENU</div>
        {menus.filter(m => !m.adminOnly || user?.role === 'admin').map(m => (
          <NavLink
            key={m.to}
            to={m.to}
            onClick={onClose}
            className={({ isActive }) =>
              'sidebar-link' + (isActive ? ' sidebar-link--active' : '')
            }
          >
            <span className="sidebar-icon">{m.icon}</span>
            <span>{m.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* User info at bottom */}
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
          <button className="sidebar-logout" onClick={handleLogout} title="Keluar">⏻</button>
        </div>
      </div>
    </div>
  );
}
