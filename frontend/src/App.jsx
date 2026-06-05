import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Scoreboard from './pages/Scoreboard';
import UserManagement from './pages/UserManagement';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';

function ComingSoon({ title }) {
  return (
    <Layout>
      <div className="empty-state">
        <div className="empty-icon">🚧</div>
        <div className="empty-title">{title}</div>
        <div className="empty-sub">Halaman ini sedang dalam pengembangan</div>
      </div>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login"    element={<Login />} />
        <Route path="/"         element={<Navigate to="/scoreboard" replace />} />
        <Route path="/scoreboard" element={<ProtectedRoute><Scoreboard /></ProtectedRoute>} />
        <Route path="/users"      element={<ProtectedRoute><UserManagement /></ProtectedRoute>} />
        <Route path="/dashboard"  element={<ProtectedRoute><ComingSoon title="Dashboard Pencapaian" /></ProtectedRoute>} />
        <Route path="/tren"       element={<ProtectedRoute><ComingSoon title="Tren Harian" /></ProtectedRoute>} />
        <Route path="/per-unit"   element={<ProtectedRoute><ComingSoon title="Per Unit" /></ProtectedRoute>} />
        <Route path="/laporan"    element={<ProtectedRoute><ComingSoon title="Laporan" /></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  );
}
