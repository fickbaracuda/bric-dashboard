import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../../components/Layout';
import { wbGetAllActions, wbUpdateAction } from '../../services/wbApi';
import { ACTION_TYPE_LABELS, ACTION_STATUS_LABELS, BU_COLORS } from '../../services/wbRegistry';

const STATUS_COLORS = {
  open: '#F59E0B', in_progress: '#3B82F6', done: '#1D9E75', blocked: '#EF4444',
};

export default function WBActions() {
  const navigate = useNavigate();
  const [actions,  setActions]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [status,   setStatus]   = useState('open');
  const [type,     setType]     = useState('');
  const [updating, setUpdating] = useState(null);

  const load = () => {
    setLoading(true);
    const params = {};
    if (status) params.status = status;
    if (type)   params.action_type = type;
    wbGetAllActions(params)
      .then(setActions)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [status, type]);

  const handleStatus = async (ac, newStatus) => {
    setUpdating(ac.id);
    try {
      await wbUpdateAction(ac.warroom_id, ac.id, { status: newStatus });
      load();
    } catch (e) {
      alert('Gagal update: ' + e.message);
    } finally {
      setUpdating(null);
    }
  };

  return (
    <Layout>
      <div className="wb-page">
        <div className="wb-page-header">
          <div>
            <h1 className="wb-page-title">
              <i className="ti ti-checklist" style={{ color: '#F59E0B' }} />
              Action Center
            </h1>
            <p className="wb-page-sub">Semua action item lintas warroom</p>
          </div>
        </div>

        <div className="wb-filter-bar">
          <select className="wb-select" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">Semua Status</option>
            {Object.entries(ACTION_STATUS_LABELS).map(([v, l]) =>
              <option key={v} value={v}>{l}</option>
            )}
          </select>
          <select className="wb-select" value={type} onChange={e => setType(e.target.value)}>
            <option value="">Semua Tipe</option>
            {Object.entries(ACTION_TYPE_LABELS).map(([v, l]) =>
              <option key={v} value={v}>{l}</option>
            )}
          </select>
          <span className="wb-count-label">{actions.length} action</span>
        </div>

        {loading ? (
          <div className="wb-loading"><i className="ti ti-loader wb-spin" /> Memuat...</div>
        ) : actions.length === 0 ? (
          <div className="wb-empty">
            <i className="ti ti-checklist" />
            <p>Tidak ada action item dengan filter ini.</p>
          </div>
        ) : (
          <div className="wb-table-wrap">
            <table className="wb-table">
              <thead>
                <tr>
                  <th>Warroom</th>
                  <th>Tipe</th>
                  <th>Entity</th>
                  <th>Issue</th>
                  <th>Rekomendasi</th>
                  <th>PIC</th>
                  <th>Due Date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {actions.map(ac => {
                  const color = ac.color || BU_COLORS[ac.business_unit] || '#6B7280';
                  return (
                    <tr key={ac.id} className="wb-table-row">
                      <td>
                        <div className="wb-table-name" style={{ cursor: 'pointer' }}
                          onClick={() => navigate(`/warroom-builder/${ac.warroom_id}`)}>
                          <div className="wb-dot" style={{ background: color }} />
                          <span style={{ fontSize: 12 }}>{ac.warroom_name}</span>
                        </div>
                      </td>
                      <td>
                        <span style={{ fontSize: 12 }}>{ACTION_TYPE_LABELS[ac.action_type] || ac.action_type}</span>
                      </td>
                      <td>
                        <div className="wb-action-entity">{ac.entity_name || ac.entity_id || '—'}</div>
                      </td>
                      <td style={{ fontSize: 12, maxWidth: 200 }}>{ac.issue}</td>
                      <td style={{ fontSize: 12, maxWidth: 200 }}>{ac.recommendation}</td>
                      <td style={{ fontSize: 12 }}>{ac.pic || '—'}</td>
                      <td style={{ fontSize: 12 }}>{ac.due_date || '—'}</td>
                      <td>
                        <select
                          className="wb-select wb-select-sm"
                          value={ac.status}
                          disabled={updating === ac.id}
                          onChange={e => handleStatus(ac, e.target.value)}
                          style={{ color: STATUS_COLORS[ac.status] }}
                        >
                          {Object.entries(ACTION_STATUS_LABELS).map(([v, l]) =>
                            <option key={v} value={v}>{l}</option>
                          )}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}
