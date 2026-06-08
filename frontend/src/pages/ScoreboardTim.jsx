import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import LeaderManagement from '../components/LeaderManagement';

export default function ScoreboardTim() {
  const navigate = useNavigate();
  return (
    <Layout>
      <div className="page-header">
        <div>
          <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-users" style={{ color: '#7F77DD' }} />
            Scoreboard Tim
            <span className="pill pill-aman" style={{ fontSize: 11 }}>WINME&amp;INSTAQRIS</span>
          </div>
          <div className="page-sub">Kelola anggota, target, dan pencapaian harian tim</div>
        </div>
      </div>
      <LeaderManagement navigate={navigate} />
    </Layout>
  );
}
