import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../../components/Layout';
import { wbGetOverview, wbGetWarrooms, wbGetAllAlerts, wbGetAllActions } from '../../services/wbApi';
import { SCORE_STATUS_COLORS, BU_COLORS, ACTION_TYPE_LABELS } from '../../services/wbRegistry';

function fmt(n) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString('id-ID');
}

function timeSince(ts) {
  if (!ts) return '—';
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m} menit lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  return `${Math.floor(h/24)} hari lalu`;
}

function ScoreBadge({ score, status }) {
  const color = SCORE_STATUS_COLORS[status] || '#9CA3AF';
  if (score === null || score === undefined) return <span className="wb-score-badge" style={{ background: '#F3F4F6', color: '#9CA3AF' }}>—</span>;
  return (
    <span className="wb-score-badge" style={{ background: color + '20', color }}>
      {score} · {status}
    </span>
  );
}

function WarroomCard({ w, onClick }) {
  const color    = w.color || BU_COLORS[w.business_unit] || '#6B7280';
  const criticals = parseInt(w.critical_alerts || 0);
  const actions   = parseInt(w.open_actions || 0);
  return (
    <div className="wb-warroom-card" onClick={onClick} style={{ '--wb-accent': color }}>
      <div className="wb-warroom-card-header">
        <div className="wb-warroom-card-dot" style={{ background: color }} />
        <div className="wb-warroom-card-title">{w.name}</div>
        <ScoreBadge score={w.score} status={w.score_status} />
      </div>
      <div className="wb-warroom-card-meta">
        <span className="wb-bu-badge" style={{ background: color + '20', color }}>{w.business_unit}</span>
        <span className="wb-entity-badge">{w.entity_type}</span>
        <span className="wb-model-badge">{w.business_model}</span>
      </div>
      <div className="wb-warroom-card-footer">
        <span className="wb-card-stat">
          <i className="ti ti-bell" /> {criticals > 0 ? <b style={{ color: '#EF4444' }}>{criticals} kritis</b> : '0 alert'}
        </span>
        <span className="wb-card-stat">
          <i className="ti ti-checklist" /> {actions} action
        </span>
        <span className="wb-card-sync">
          <i className="ti ti-refresh" /> {timeSince(w.last_synced_at)}
        </span>
      </div>
    </div>
  );
}

export default function WBOverview() {
  const navigate = useNavigate();
  const [overview, setOverview] = useState(null);
  const [warrooms, setWarrooms] = useState([]);
  const [alerts,   setAlerts]   = useState([]);
  const [actions,  setActions]  = useState([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    Promise.all([
      wbGetOverview(),
      wbGetWarrooms(),
      wbGetAllAlerts(false),
      wbGetAllActions({ status: 'open' }),
    ]).then(([ov, wrs, als, acs]) => {
      setOverview(ov);
      setWarrooms(wrs);
      setAlerts(als.slice(0, 5));
      setActions(acs.slice(0, 5));
    }).catch(console.error)
    .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <Layout>
      <div className="wb-loading"><i className="ti ti-loader wb-spin" /> Memuat Warroom Builder...</div>
    </Layout>
  );

  return (
    <Layout>
      <div className="wb-page">
        {/* Header */}
        <div className="wb-page-header">
          <div>
            <h1 className="wb-page-title">
              <i className="ti ti-layout-dashboard" style={{ color: '#1D9E75' }} />
              Warroom Builder
            </h1>
            <p className="wb-page-sub">
              Buat dashboard war room fleksibel dari Google Sheet untuk berbagai unit bisnis
            </p>
          </div>
          <button className="wb-btn-primary" onClick={() => navigate('/warroom-builder/create')}>
            <i className="ti ti-plus" /> Buat Warroom Baru
          </button>
        </div>

        {/* KPI Row */}
        <div className="wb-kpi-row">
          <div className="wb-kpi-card">
            <div className="wb-kpi-icon" style={{ background: '#1D9E7520' }}>
              <i className="ti ti-layout-dashboard" style={{ color: '#1D9E75' }} />
            </div>
            <div>
              <div className="wb-kpi-val">{overview?.total_warroom ?? '—'}</div>
              <div className="wb-kpi-label">Total Warroom</div>
            </div>
          </div>
          <div className="wb-kpi-card">
            <div className="wb-kpi-icon" style={{ background: '#3B82F620' }}>
              <i className="ti ti-activity" style={{ color: '#3B82F6' }} />
            </div>
            <div>
              <div className="wb-kpi-val">{overview?.active_warroom ?? '—'}</div>
              <div className="wb-kpi-label">Warroom Aktif</div>
            </div>
          </div>
          <div className="wb-kpi-card">
            <div className="wb-kpi-icon" style={{ background: '#EF444420' }}>
              <i className="ti ti-bell-ringing" style={{ color: '#EF4444' }} />
            </div>
            <div>
              <div className="wb-kpi-val" style={{ color: (overview?.critical_alerts || 0) > 0 ? '#EF4444' : undefined }}>
                {overview?.critical_alerts ?? '—'}
              </div>
              <div className="wb-kpi-label">Alert Kritis</div>
            </div>
          </div>
          <div className="wb-kpi-card">
            <div className="wb-kpi-icon" style={{ background: '#F59E0B20' }}>
              <i className="ti ti-checklist" style={{ color: '#F59E0B' }} />
            </div>
            <div>
              <div className="wb-kpi-val">{overview?.open_actions ?? '—'}</div>
              <div className="wb-kpi-label">Open Actions</div>
            </div>
          </div>
          <div className="wb-kpi-card">
            <div className="wb-kpi-icon" style={{ background: '#6B728020' }}>
              <i className="ti ti-refresh" style={{ color: '#6B7280' }} />
            </div>
            <div>
              <div className="wb-kpi-val wb-kpi-val-sm">{timeSince(overview?.last_sync)}</div>
              <div className="wb-kpi-label">Last Sync</div>
            </div>
          </div>
        </div>

        <div className="wb-two-col">
          {/* Warroom List */}
          <div className="wb-section">
            <div className="wb-section-header">
              <h2 className="wb-section-title">Warroom Anda</h2>
              <button className="wb-btn-ghost" onClick={() => navigate('/warroom-builder/library')}>
                Lihat Semua <i className="ti ti-arrow-right" />
              </button>
            </div>
            {warrooms.length === 0 ? (
              <div className="wb-empty">
                <i className="ti ti-layout-dashboard" />
                <p>Belum ada warroom. Buat warroom pertama Anda!</p>
                <button className="wb-btn-primary" onClick={() => navigate('/warroom-builder/create')}>
                  <i className="ti ti-plus" /> Buat Warroom
                </button>
              </div>
            ) : (
              <div className="wb-warroom-grid">
                {warrooms.slice(0, 6).map(w => (
                  <WarroomCard
                    key={w.id}
                    w={w}
                    onClick={() => navigate(`/warroom-builder/${w.id}`)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Alert + Action Side */}
          <div className="wb-side-col">
            {/* Recent Alerts */}
            <div className="wb-card">
              <div className="wb-section-header">
                <h3 className="wb-section-title">Alert Terbaru</h3>
                <button className="wb-btn-ghost" onClick={() => navigate('/warroom-builder/alerts')}>
                  Semua <i className="ti ti-arrow-right" />
                </button>
              </div>
              {alerts.length === 0 ? (
                <div className="wb-empty-sm">Tidak ada alert aktif</div>
              ) : (
                <div className="wb-alert-list">
                  {alerts.map(al => (
                    <div key={al.id} className={`wb-alert-item wb-alert-${al.level}`}>
                      <i className={`ti ${al.level === 'critical' ? 'ti-alert-triangle' : al.level === 'warning' ? 'ti-alert-circle' : 'ti-info-circle'}`} />
                      <div className="wb-alert-body">
                        <div className="wb-alert-title">{al.title}</div>
                        <div className="wb-alert-sub">{al.warroom_name}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Pending Actions */}
            <div className="wb-card" style={{ marginTop: 16 }}>
              <div className="wb-section-header">
                <h3 className="wb-section-title">Pending Actions</h3>
                <button className="wb-btn-ghost" onClick={() => navigate('/warroom-builder/actions')}>
                  Semua <i className="ti ti-arrow-right" />
                </button>
              </div>
              {actions.length === 0 ? (
                <div className="wb-empty-sm">Tidak ada action pending</div>
              ) : (
                <div className="wb-action-list">
                  {actions.map(ac => (
                    <div key={ac.id} className="wb-action-item"
                      onClick={() => navigate(`/warroom-builder/${ac.warroom_id}`)}>
                      <div className="wb-action-type-badge">{ACTION_TYPE_LABELS[ac.action_type] || ac.action_type}</div>
                      <div className="wb-action-entity">{ac.entity_name || ac.entity_id || '—'}</div>
                      <div className="wb-action-warroom">{ac.warroom_name}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
