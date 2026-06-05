import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Scoreboard from './pages/Scoreboard';

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
        <Route path="/" element={<Navigate to="/scoreboard" replace />} />
        <Route path="/scoreboard" element={<Scoreboard />} />
        <Route path="/dashboard" element={<ComingSoon title="Dashboard Pencapaian" />} />
        <Route path="/tren" element={<ComingSoon title="Tren Harian" />} />
        <Route path="/per-unit" element={<ComingSoon title="Per Unit" />} />
        <Route path="/laporan" element={<ComingSoon title="Laporan" />} />
      </Routes>
    </BrowserRouter>
  );
}
