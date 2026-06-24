import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Scoreboard from './pages/Scoreboard';
import UserManagement from './pages/UserManagement';
import WinmeInstaqris from './pages/WinmeInstaqris';
import PaymentAgent from './pages/PaymentAgent';
import DompetDigital from './pages/DompetDigital';
import AnggotaDetail from './pages/AnggotaDetail';
import ScoreboardTim from './pages/ScoreboardTim';
import LeaderScoreboard from './pages/LeaderScoreboard';
import WarRoom from './pages/WarRoom';
import WarRoomSpeedcash from './pages/WarRoomSpeedcash';
import WarRoomEkspedisi from './pages/WarRoomEkspedisi';
import WarRoomFastpay from './pages/WarRoomFastpay';
import WarRoomFarming from './pages/WarRoomFarming';
import WarRoomPAProduk from './pages/WarRoomPAProduk';
import WarRoomMgmPa from './pages/WarRoomMgmPa';
import WarRoomDmFastpay from './pages/WarRoomDmFastpay';
import WarRoomInstaqrisTrx from './pages/WarRoomInstaqrisTrx';
import WarRoomAsdp from './pages/WarRoomAsdp';
import WarRoomBumdes from './pages/WarRoomBumdes';
import WarRoomLpd from './pages/WarRoomLpd';
import WarRoomHunter from './pages/WarRoomHunter';
import WarRoomIqRaw  from './pages/WarRoomIqRaw';
import WarRoomQris   from './pages/WarRoomQris';
import ServerMonitor from './pages/ServerMonitor';
import DataRaw from './pages/DataRaw';
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
        <Route path="/scoreboard"        element={<ProtectedRoute><Scoreboard /></ProtectedRoute>} />
        <Route path="/leader-scoreboard" element={<ProtectedRoute><LeaderScoreboard /></ProtectedRoute>} />
        <Route path="/winme"          element={<ProtectedRoute><WinmeInstaqris /></ProtectedRoute>} />
        <Route path="/payment-agent"  element={<ProtectedRoute><PaymentAgent /></ProtectedRoute>} />
        <Route path="/dompet-digital" element={<ProtectedRoute><DompetDigital /></ProtectedRoute>} />
        <Route path="/users"      element={<ProtectedRoute><UserManagement /></ProtectedRoute>} />
        <Route path="/anggota/:id"     element={<ProtectedRoute><AnggotaDetail /></ProtectedRoute>} />
        <Route path="/scoreboard-tim" element={<ProtectedRoute><ScoreboardTim /></ProtectedRoute>} />
        <Route path="/scoreboard-tim-pa" element={<ProtectedRoute><ScoreboardTim unit="payment_agent" unitLabel="PAYMENT AGENT" unitColor="#639922" /></ProtectedRoute>} />
        <Route path="/scoreboard-tim-sc" element={<ProtectedRoute><ScoreboardTim unit="speedcash" unitLabel="SPEEDCASH" unitColor="#EF4444" /></ProtectedRoute>} />
        <Route path="/data-raw"            element={<ProtectedRoute><DataRaw /></ProtectedRoute>} />
        <Route path="/war-room/instaqris" element={<ProtectedRoute><WarRoom /></ProtectedRoute>} />
        <Route path="/war-room/speedcash"   element={<ProtectedRoute><WarRoomSpeedcash /></ProtectedRoute>} />
        <Route path="/war-room/ekspedisi"      element={<ProtectedRoute><WarRoomEkspedisi /></ProtectedRoute>} />
        <Route path="/war-room/fastpayglobal" element={<ProtectedRoute><WarRoomFastpay /></ProtectedRoute>} />
        <Route path="/war-room/farming"       element={<ProtectedRoute><WarRoomFarming /></ProtectedRoute>} />
        <Route path="/war-room/pa-produk"    element={<ProtectedRoute><WarRoomPAProduk /></ProtectedRoute>} />
        <Route path="/war-room/mgm-pa"        element={<ProtectedRoute><WarRoomMgmPa /></ProtectedRoute>} />
        <Route path="/war-room/dm-fastpay"     element={<ProtectedRoute><WarRoomDmFastpay /></ProtectedRoute>} />
        <Route path="/war-room/instaqris-trx" element={<ProtectedRoute><WarRoomInstaqrisTrx /></ProtectedRoute>} />
        <Route path="/war-room/asdp"           element={<ProtectedRoute><WarRoomAsdp /></ProtectedRoute>} />
        <Route path="/war-room/bumdes"         element={<ProtectedRoute><WarRoomBumdes /></ProtectedRoute>} />
        <Route path="/war-room/lpd"            element={<ProtectedRoute><WarRoomLpd /></ProtectedRoute>} />
        <Route path="/war-room/hunter"        element={<ProtectedRoute><WarRoomHunter /></ProtectedRoute>} />
        <Route path="/war-room/iq-raw"          element={<ProtectedRoute><WarRoomIqRaw /></ProtectedRoute>} />
        <Route path="/war-room/penerbitan-qris" element={<ProtectedRoute><WarRoomQris /></ProtectedRoute>} />
        <Route path="/server-monitor"          element={<ProtectedRoute><ServerMonitor /></ProtectedRoute>} />
        <Route path="/dashboard"  element={<ProtectedRoute><ComingSoon title="Dashboard Pencapaian" /></ProtectedRoute>} />
        <Route path="/tren"       element={<ProtectedRoute><ComingSoon title="Tren Harian" /></ProtectedRoute>} />
        <Route path="/per-unit"   element={<ProtectedRoute><ComingSoon title="Per Unit" /></ProtectedRoute>} />
        <Route path="/laporan"    element={<ProtectedRoute><ComingSoon title="Laporan" /></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  );
}
