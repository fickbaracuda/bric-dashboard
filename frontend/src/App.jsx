import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Scoreboard from './pages/Scoreboard';
import ProtectedRoute from './components/ProtectedRoute';

function ComingSoon({ title }) {
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center', color: '#888780' }}>
      <div style={{ fontSize: '32px', marginBottom: '12px' }}>🚧</div>
      <div style={{ fontWeight: 600, fontSize: '16px', color: '#1A1917' }}>{title}</div>
      <div style={{ marginTop: '6px', fontSize: '14px' }}>Halaman ini sedang dalam pengembangan</div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Navigate to="/scoreboard" replace />} />
        <Route path="/scoreboard" element={<ProtectedRoute><Scoreboard /></ProtectedRoute>} />
        <Route path="/dashboard" element={<ProtectedRoute><ComingSoon title="Dashboard Pencapaian" /></ProtectedRoute>} />
        <Route path="/tren"      element={<ProtectedRoute><ComingSoon title="Tren Harian" /></ProtectedRoute>} />
        <Route path="/per-unit"  element={<ProtectedRoute><ComingSoon title="Per Unit" /></ProtectedRoute>} />
        <Route path="/laporan"   element={<ProtectedRoute><ComingSoon title="Laporan" /></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  );
}
