import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../../components/Layout';
import { wbGetWarrooms, wbDeleteWarroom, wbGenerate } from '../../services/wbApi';
import { SCORE_STATUS_COLORS, BU_COLORS, BUSINESS_UNITS } from '../../services/wbRegistry';

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

export default function WBLibrary() {
  const navigate = useNavigate();
  const [warrooms,  setWarrooms]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [filterBU,  setFilterBU]  = useState('');
  const [syncing,   setSyncing]   = useState({});
  const [deleting,  setDeleting]  = useState(null);

  const load = () => {
    setLoading(true);
    wbGetWarrooms()
      .then(setWarrooms)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const filtered = warrooms.filter(w => {
    const q = search.toLowerCase();
    const matchSearch = !q || w.name.toLowerCase().includes(q) || w.business_unit.toLowerCase().includes(q);
    const matchBU = !filterBU || w.business_unit === filterBU;
    return matchSearch && matchBU;
  });

  const handleSync = async (w) => {
    setSyncing(s => ({ ...s, [w.id]: true }));
    try {
      await wbGenerate(w.id);
      load();
    } catch (e) {
      alert('Sync gagal: ' + e.message);
    } finally {
      setSyncing(s => ({ ...s, [w.id]: false }));
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Hapus warroom ini? Semua data snapshot, alert, dan action akan ikut terhapus.')) return;
    setDeleting(id);
    try {
      await wbDeleteWarroom(id);
      load();
    } catch (e) {
      alert('Hapus gagal: ' + e.message);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <Layout>
      <div className="wb-page">
        <div className="wb-page-header">
          <div>
            <h1 className="wb-page-title">
              <i className="ti ti-books" style={{ color: '#1D9E75' }} />
              Warroom Library
            </h1>
            <p className="wb-page-sub">Semua warroom yang sudah dibuat</p>
          </div>
          <button className="wb-btn-primary" onClick={() => navigate('/warroom-builder/create')}>
            <i className="ti ti-plus" /> Buat Warroom Baru
          </button>
        </div>

        {/* Filter Bar */}
        <div className="wb-filter-bar">
          <div className="wb-search-wrap">
            <i className="ti ti-search" />
            <input
              className="wb-search"
              placeholder="Cari nama warroom..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select className="wb-select" value={filterBU} onChange={e => setFilterBU(e.target.value)}>
            <option value="">Semua Business Unit</option>
            {BUSINESS_UNITS.map(bu => <option key={bu} value={bu}>{bu}</option>)}
          </select>
          <span className="wb-count-label">{filtered.length} warroom</span>
        </div>

        {loading ? (
          <div className="wb-loading"><i className="ti ti-loader wb-spin" /> Memuat...</div>
        ) : filtered.length === 0 ? (
          <div className="wb-empty">
            <i className="ti ti-books" />
            <p>{search || filterBU ? 'Tidak ada warroom yang sesuai filter.' : 'Belum ada warroom. Buat sekarang!'}</p>
            {!search && !filterBU && (
              <button className="wb-btn-primary" onClick={() => navigate('/warroom-builder/create')}>
                <i className="ti ti-plus" /> Buat Warroom Pertama
              </button>
            )}
          </div>
        ) : (
          <div className="wb-library-table-wrap">
            <table className="wb-table">
              <thead>
                <tr>
                  <th>Nama Warroom</th>
                  <th>Business Unit</th>
                  <th>Entity Type</th>
                  <th>Score</th>
                  <th>Alert Kritis</th>
                  <th>Open Actions</th>
                  <th>Last Sync</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(w => {
                  const color    = w.color || BU_COLORS[w.business_unit] || '#6B7280';
                  const scoreCol = SCORE_STATUS_COLORS[w.score_status] || '#9CA3AF';
                  const criticals = parseInt(w.critical_alerts || 0);
                  return (
                    <tr key={w.id} className="wb-table-row" onClick={() => navigate(`/warroom-builder/${w.id}`)}>
                      <td>
                        <div className="wb-table-name">
                          <div className="wb-dot" style={{ background: color }} />
                          <span>{w.name}</span>
                        </div>
                      </td>
                      <td>
                        <span className="wb-bu-badge" style={{ background: color + '20', color }}>{w.business_unit}</span>
                      </td>
                      <td>
                        <span className="wb-entity-badge">{w.entity_type}</span>
                      </td>
                      <td>
                        {w.score != null ? (
                          <span className="wb-score-inline" style={{ color: scoreCol }}>
                            <b>{w.score}</b> <span style={{ fontSize: 11, color: scoreCol }}>{w.score_status}</span>
                          </span>
                        ) : <span className="wb-muted">—</span>}
                      </td>
                      <td>
                        {criticals > 0
                          ? <span style={{ color: '#EF4444', fontWeight: 600 }}>{criticals}</span>
                          : <span className="wb-muted">0</span>}
                      </td>
                      <td>
                        <span>{parseInt(w.open_actions || 0)}</span>
                      </td>
                      <td>
                        <span className="wb-muted">{timeSince(w.last_synced_at)}</span>
                      </td>
                      <td onClick={e => e.stopPropagation()}>
                        <div className="wb-row-actions">
                          <button
                            className="wb-btn-icon"
                            title="Sync sekarang"
                            disabled={syncing[w.id]}
                            onClick={() => handleSync(w)}
                          >
                            <i className={`ti ti-refresh ${syncing[w.id] ? 'wb-spin' : ''}`} />
                          </button>
                          <button
                            className="wb-btn-icon wb-btn-icon-danger"
                            title="Hapus warroom"
                            disabled={deleting === w.id}
                            onClick={() => handleDelete(w.id)}
                          >
                            <i className="ti ti-trash" />
                          </button>
                        </div>
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
