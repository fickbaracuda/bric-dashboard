import { Navigate, useLocation } from 'react-router-dom';
import { isLoggedIn, getUser } from '../utils/auth';

// Unit OP (Tim Operation) & FA (Finance) HANYA boleh akses menu Rekonsiliasi
// dan submenu-nya — pembatasan SUNGGUHAN di sini (bukan cuma sembunyikan
// link di Sidebar.jsx), supaya mengetik URL lain langsung di address bar
// tetap di-redirect balik, bukan cuma disembunyikan dari menu.
const RECON_ONLY_UNITS = ['OP', 'FA'];
const RECONCILIATION_PATHS = [
  '/war-room/rekonsiliasi-ocbc',
  '/war-room/rekonsiliasi/mandiri',
  '/war-room/rekonsiliasi/bri',
  '/war-room/rekonsiliasi/bri-bifast',
  '/war-room/rekonsiliasi/bni',
];
const DEFAULT_RECONCILIATION_PATH = '/war-room/rekonsiliasi-ocbc';

export default function ProtectedRoute({ children }) {
  const location = useLocation();
  if (!isLoggedIn()) return <Navigate to="/login" replace />;

  const user = getUser();
  if (RECON_ONLY_UNITS.includes(user?.unit) && !RECONCILIATION_PATHS.includes(location.pathname)) {
    return <Navigate to={DEFAULT_RECONCILIATION_PATH} replace />;
  }

  return children;
}
