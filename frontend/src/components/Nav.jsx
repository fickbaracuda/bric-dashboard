import { NavLink } from 'react-router-dom';

const menus = [
  { label: 'Dashboard', to: '/dashboard' },
  { label: 'Unit Scoreboard', to: '/scoreboard' },
  { label: 'Tren Harian', to: '/tren' },
  { label: 'Per Unit', to: '/per-unit' },
  { label: 'Laporan', to: '/laporan' },
];

export default function Nav() {
  return (
    <nav className="nav">
      {menus.map(m => (
        <NavLink
          key={m.to}
          to={m.to}
          className={({ isActive }) => 'nav-item' + (isActive ? ' nav-item--active' : '')}
        >
          {m.label}
        </NavLink>
      ))}
    </nav>
  );
}
