import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../../components/Layout';
import { wbGetAllAlerts, wbResolveAlert } from '../../services/wbApi';
import { ALERT_LEVEL_COLORS, BU_COLORS } from '../../services/wbRegistry';

function timeSince(ts) {
  if (!ts) return '—';
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m}m lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}j lalu`;
  return `${Math.floor(h/24)}h lalu`;
}

const LEVEL_ICONS = {
  critical: 'ti-alert-triangle',
  warning:  'ti-alert-circle',
  info:     'ti-info-circle',
};

export default function WBAlerts() {
  const navigate   = useNavigate();
  const [alerts,   setAlerts]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [resolved, setResolved] = useState(false);
  const [levelFilter, setLevelFilter] = useState('');
  const [resolving, setResolving] = useState(null);

  const load = () => {
    setLoading(true);
    wbGetAllAlerts(resolved)
      .then(setAlerts)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [resolved]);

  const filtered = levelFilter ? alerts.filter(a => a.level === levelFilter) : alerts;

  const handleResolve = async (al) => {
    setResolving(al.id);
    try {
      await wbResolveAlert(al.warroom_id, al.id);
      load();
    } catch (e) {
      alert('Gagal resolve: ' + e.message);
    } finally {
      setResolving(null);
    }
  };

  return (
    <Layout>
      <div className="wb-page">
        <div className="wb-page-header">
          <div>
            <h1 className="wb-page-title">
              <i className="ti ti-bell-ringing" style={{ color: '#EF4444' }} />
              Alert Center
            </h1>
            <p className="wb-page-sub">Semua alert lintas warroom</p>
          </div>
        </div>

        <div className="wb-filter-bar">
          <button
            className={`wb-tab-btn ${!resolved ? 'wb-tab-btn--active' : ''}`}
            onClick={() => setResolved(false)}
            style={{ borderBottomColor: !resolved ? '#EF4444' : undefined }}
          >
            <i className="ti ti-bell" /> Active
          </button>
          <button
            className={`wb-tab-btn ${resolved ? 'wb-tab-btn--active' : ''}`}
            onClick={() => setResolved(true)}
            style={{ borderBottomColor: resolved ? '#1D9E75' : undefined }}
          >
            <i className="ti ti-check" /> Resolved
          </button>
          <select className="wb-select" value={levelFilter} onChange={e => setLevelFilter(e.target.value)}>
            <option value="">Semua Level</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
          <span className="wb-count-label">{filtered.length} alert</span>
        </div>

        {loading ? (
          <div className="wb-loading"><i className="ti ti-loader wb-spin" /> Memuat...</div>
        ) : filtered.length === 0 ? (
          <div className="wb-empty">
            <i className="ti ti-bell-off" />
            <p>{resolved ? 'Belum ada alert yang resolved.' : 'Tidak ada alert aktif.'}</p>
          </div>
        ) : (
          <div className="wb-alert-list-full">
            {filtered.map(al => {
              const color = ALERT_LEVEL_COLORS[al.level] || '#6B7280';
              const buColor = al.color || BU_COLORS[al.business_unit] || '#6B7280';
              return (
                <div key={al.id} className={`wb-alert-full-item wb-alert-${al.level}`}>
                  <div className="wb-alert-full-icon">
                    <i className={`ti ${LEVEL_ICONS[al.level] || 'ti-bell'}`} style={{ color }} />
                  </div>
                  <div className="wb-alert-full-body">
                    <div className="wb-alert-full-title">{al.title}</div>
                    <div className="wb-alert-full-msg">{al.message}</div>
                    <div className="wb-alert-full-meta">
                      <span className="wb-bu-badge" style={{ background: buColor + '20', color: buColor, cursor: 'pointer' }}
                        onClick={() => navigate(`/warroom-builder/${al.warroom_id}`)}>
                        {al.warroom_name}
                      </span>
                      <span className="wb-muted">{timeSince(al.created_at)}</span>
                      {al.metric_value != null && (
                        <span className="wb-muted">nilai: {al.metric_value}</span>
                      )}
                    </div>
                  </div>
                  <div className="wb-alert-full-actions">
                    <span className="wb-alert-level-badge" style={{ background: color + '20', color }}>
                      {al.level}
                    </span>
                    {!resolved && (
                      <button
                        className="wb-btn-ghost wb-btn-sm"
                        disabled={resolving === al.id}
                        onClick={() => handleResolve(al)}
                      >
                        {resolving === al.id ? <i className="ti ti-loader wb-spin" /> : 'Resolve'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}
