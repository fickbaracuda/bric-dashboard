import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import { getMembers } from '../services/api';

const UNIT_INFO = {
  winme_instaqris: { label: 'Winme & InstaQris', short: 'Winme',  color: '#7F77DD' },
  payment_agent:   { label: 'Payment Agent',      short: 'PA',     color: '#639922' },
  speedcash:       { label: 'SpeedCash',           short: 'SC',     color: '#EF4444' },
};

const FILTERS = [
  { key: 'all',             label: 'Semua Unit' },
  { key: 'winme_instaqris', label: 'Winme & InstaQris' },
  { key: 'payment_agent',   label: 'Payment Agent' },
  { key: 'speedcash',       label: 'SpeedCash' },
];

/* ── Helpers ── */
function fmtRev(n) {
  if (!n && n !== 0) return '—';
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + 'Rp ' + (abs / 1e9).toFixed(2) + 'M';
  if (abs >= 1e6) return sign + 'Rp ' + (abs / 1e6).toFixed(1) + 'jt';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}

function getInisial(nama) {
  const w = nama.trim().split(' ');
  return w.length >= 2 ? (w[0][0] + w[1][0]).toUpperCase() : nama.substring(0, 2).toUpperCase();
}
function getAvgPct(member) {
  const valid = (member.targets || []).filter(t => t.pencapaian_terakhir?.pct_revenue > 0);
  if (!valid.length) return null;
  return valid.reduce((s, t) => s + parseFloat(t.pencapaian_terakhir.pct_revenue), 0) / valid.length;
}
function getTotalRev(member) {
  return (member.targets || []).reduce((s, t) =>
    s + parseFloat(t.pencapaian_terakhir?.pencapaian_revenue || 0), 0);
}
function getTargetRev(member) {
  return (member.targets || []).reduce((s, t) =>
    s + parseFloat(t.target_revenue || 0), 0);
}
function pctColor(pct) {
  if (pct === null) return '#9CA3AF';
  if (pct >= 100)   return '#1D9E75';
  if (pct >= 80)    return '#F59E0B';
  if (pct >= 70)    return '#F97316';
  return '#EF4444';
}
function statusInfo(pct) {
  if (pct === null) return { label: 'Belum Ada Data', cls: 'st-nodata' };
  if (pct >= 100)   return { label: 'Unggul',         cls: 'st-unggul' };
  if (pct >= 80)    return { label: 'On Track',        cls: 'st-ontrack' };
  if (pct >= 70)    return { label: 'Waspada',         cls: 'st-waspada' };
  return             { label: 'Perlu Perhatian',  cls: 'st-danger' };
}
function generateRec(leader, pct) {
  const name  = leader.nama.split(' ')[0];
  const lemah = (leader.targets || [])
    .filter(t => t.pencapaian_terakhir?.pct_revenue && parseFloat(t.pencapaian_terakhir.pct_revenue) < 80)
    .map(t => t.nama_target);
  if (pct === null)
    return `${name} belum memiliki data pencapaian. Segera input target dan pencapaian harian untuk mulai tracking performa.`;
  if (pct >= 100)
    return `${name} tampil luar biasa dengan rata-rata ${pct.toFixed(1)}%. Pertahankan momentum dan pertimbangkan target yang lebih ambisius di periode berikutnya.`;
  if (pct >= 80)
    return `${name} on-track (${pct.toFixed(1)}%). ${lemah.length ? `Fokus akselerasi pada ${lemah.join(' dan ')} untuk mendorong angka ke 100%.` : 'Pertahankan konsistensi dan dorong menuju 100%.'}`;
  if (pct >= 70)
    return `${name} waspada (${pct.toFixed(1)}%). ${lemah.length ? `Evaluasi hambatan di ${lemah.join(', ')} —` : 'Perlu'} susun rencana aksi mingguan dan review bersama tim segera.`;
  return `${name} perlu perhatian segera (${pct.toFixed(1)}%). Review seluruh hambatan${lemah.length ? ` khususnya di ${lemah.join(' dan ')}` : ''}, dan buat rencana recovery terstruktur bersama atasan.`;
}

/* ── Rank Badge ── */
function RankBadge({ rank, size = 'md' }) {
  const emoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : null;
  const cls   = `lsc-rank lsc-rank-${size} ${rank <= 3 ? 'lsc-rank-medal' : 'lsc-rank-n'}`;
  return <div className={cls}>{emoji ?? rank}</div>;
}

/* ── Compact Grid Card ── */
function LeaderCard({ leader, navigate }) {
  const pct    = leader.avgPct;
  const si     = statusInfo(pct);
  const ui     = UNIT_INFO[leader.unit] || { label: leader.unit, color: '#7F77DD' };
  const barPct = Math.min(pct ?? 0, 100);

  return (
    <div className="lsc-card" onClick={() => navigate(`/anggota/${leader.id}`)}>
      {/* Rank badge absolute top-left */}
      <div className="lsc-card-rank">
        <RankBadge rank={leader.rank} size="sm" />
      </div>

      {/* Avatar + name */}
      <div className="lsc-card-head">
        <div className="lsc-avatar" style={{ background: leader.avatar_warna }}>
          {getInisial(leader.nama)}
        </div>
        <div className="lsc-card-info">
          <div className="lsc-name">{leader.nama}</div>
          <div className="lsc-meta">
            <span className="lsc-unit-badge"
              style={{ background: ui.color + '18', color: ui.color, borderColor: ui.color + '44' }}>
              {ui.short}
            </span>
            {leader.fungsi && <span className="lsc-fungsi">{leader.fungsi}</span>}
          </div>
        </div>
        <div className="lsc-pct" style={{ color: pctColor(pct) }}>
          {pct !== null ? pct.toFixed(1) + '%' : '—'}
        </div>
      </div>

      {/* Progress bar */}
      <div className="lsc-prog-bg">
        <div className="lsc-prog-fill" style={{ width: barPct + '%', background: pctColor(pct) }} />
      </div>

      {/* Stats row */}
      <div className="lsc-card-stats">
        <div className="lsc-stat">
          <span className="lsc-stat-lbl">Target</span>
          <span className="lsc-stat-val">{leader.targetRev > 0 ? fmtRev(leader.targetRev) : '—'}</span>
        </div>
        <div className="lsc-stat-sep" />
        <div className="lsc-stat">
          <span className="lsc-stat-lbl">Pencapaian</span>
          <span className="lsc-stat-val" style={{ color: pctColor(pct) }}>
            {leader.totalRev > 0 ? fmtRev(leader.totalRev) : '—'}
          </span>
        </div>
        <div className="lsc-stat-sep" />
        <div className="lsc-stat">
          <span className="lsc-stat-lbl">Tim</span>
          <span className="lsc-stat-val">{leader.timCount} orang</span>
        </div>
      </div>

      {/* Status badge */}
      <div className="lsc-card-footer">
        <span className={`st-status-badge ${si.cls}`}>{si.label}</span>
        <span className="lsc-detail-hint">Lihat detail <i className="ti ti-chevron-right" /></span>
      </div>
    </div>
  );
}

/* ── Scoreboard Table ── */
function ScoreboardTable({ leaders, navigate }) {
  const [sortKey, setSortKey] = useState('rank');
  const [sortDir, setSortDir] = useState('asc');

  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }

  const sorted = [...leaders].sort((a, b) => {
    let va, vb;
    if (sortKey === 'rank')    { va = a.rank;      vb = b.rank; }
    else if (sortKey === 'pct')     { va = a.avgPct ?? -1;  vb = b.avgPct ?? -1; }
    else if (sortKey === 'target')  { va = a.targetRev;     vb = b.targetRev; }
    else if (sortKey === 'pencapaian') { va = a.totalRev;   vb = b.totalRev; }
    else if (sortKey === 'tim')    { va = a.timCount;    vb = b.timCount; }
    else if (sortKey === 'nama')   { va = a.nama;        vb = b.nama; return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va); }
    return sortDir === 'asc' ? va - vb : vb - va;
  });

  function Th({ label, k }) {
    const active = sortKey === k;
    return (
      <th className={'lsc-th' + (active ? ' lsc-th--active' : '')} onClick={() => toggleSort(k)}>
        {label}
        <i className={`ti ti-${active ? (sortDir === 'asc' ? 'arrow-up' : 'arrow-down') : 'arrows-sort'}`}
          style={{ marginLeft: 4, fontSize: 11, opacity: active ? 1 : 0.35 }} />
      </th>
    );
  }

  return (
    <div className="lsc-table-wrap">
      <table className="lsc-table">
        <thead>
          <tr>
            <Th label="Rank"       k="rank" />
            <Th label="Leader"     k="nama" />
            <th className="lsc-th">Unit</th>
            <th className="lsc-th">Fungsi</th>
            <Th label="Tim"        k="tim" />
            <Th label="Target"     k="target" />
            <Th label="Pencapaian" k="pencapaian" />
            <Th label="%"          k="pct" />
            <th className="lsc-th">Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(l => {
            const si = statusInfo(l.avgPct);
            const ui = UNIT_INFO[l.unit] || { label: l.unit, color: '#7F77DD' };
            return (
              <tr key={`${l.unit}-${l.id}`} className="lsc-tr"
                onClick={() => navigate(`/anggota/${l.id}`)}>
                <td className="lsc-td lsc-td-rank">
                  <RankBadge rank={l.rank} size="xs" />
                </td>
                <td className="lsc-td">
                  <div className="lsc-tr-leader">
                    <div className="lsc-avatar lsc-avatar-sm" style={{ background: l.avatar_warna }}>
                      {getInisial(l.nama)}
                    </div>
                    <span className="lsc-tr-name">{l.nama}</span>
                  </div>
                </td>
                <td className="lsc-td">
                  <span className="lsc-unit-badge"
                    style={{ background: ui.color + '18', color: ui.color, borderColor: ui.color + '44' }}>
                    {ui.short}
                  </span>
                </td>
                <td className="lsc-td lsc-td-fungsi">{l.fungsi || '—'}</td>
                <td className="lsc-td lsc-td-center">{l.timCount}</td>
                <td className="lsc-td lsc-td-num">{l.targetRev > 0 ? fmtRev(l.targetRev) : '—'}</td>
                <td className="lsc-td lsc-td-num" style={{ color: pctColor(l.avgPct) }}>
                  {l.totalRev > 0 ? fmtRev(l.totalRev) : '—'}
                </td>
                <td className="lsc-td lsc-td-pct" style={{ color: pctColor(l.avgPct), fontWeight: 700 }}>
                  {l.avgPct !== null ? l.avgPct.toFixed(1) + '%' : '—'}
                </td>
                <td className="lsc-td">
                  <span className={`st-status-badge ${si.cls}`}>{si.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Main Page ── */
export default function LeaderScoreboard() {
  const navigate = useNavigate();
  const [allData, setAllData] = useState({ winme_instaqris: [], payment_agent: [], speedcash: [] });
  const [loading, setLoading] = useState(true);
  const [filter,  setFilter]  = useState('all');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getMembers('winme_instaqris'),
      getMembers('payment_agent'),
      getMembers('speedcash'),
    ]).then(([winme, pa, sc]) => {
      setAllData({ winme_instaqris: winme, payment_agent: pa, speedcash: sc });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const allLeaders = Object.entries(allData)
    .flatMap(([unit, members]) =>
      members
        .filter(m => m.posisi === 'leader')
        .map(m => ({
          ...m, unit,
          timCount:  members.filter(t => t.posisi === 'tim' && String(t.leader_id) === String(m.id)).length,
          avgPct:    getAvgPct(m),
          totalRev:  getTotalRev(m),
          targetRev: getTargetRev(m),
        }))
    )
    .sort((a, b) => (b.avgPct ?? -1) - (a.avgPct ?? -1))
    .map((l, idx) => ({ ...l, rank: idx + 1 }));

  const filtered = filter === 'all'
    ? allLeaders
    : allLeaders.filter(l => l.unit === filter);

  /* Summary */
  const withData  = allLeaders.filter(l => l.avgPct !== null);
  const grupAvg   = withData.length ? withData.reduce((s, l) => s + l.avgPct, 0) / withData.length : null;
  const onTrack   = withData.filter(l => l.avgPct >= 80).length;
  const atRisk    = withData.filter(l => l.avgPct < 70).length;
  const totalTim  = allLeaders.reduce((s, l) => s + l.timCount, 0);
  const totalRev  = allLeaders.reduce((s, l) => s + l.totalRev, 0);
  const totalTgt  = allLeaders.reduce((s, l) => s + l.targetRev, 0);

  /* Leaders yang butuh rekomendasi (pct < 80 atau belum ada data) */
  const needRec   = filtered.filter(l => l.avgPct === null || l.avgPct < 80);

  return (
    <Layout>
      <div className="page-header">
        <div>
          <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-medal" style={{ color: '#F59E0B' }} />
            Leader Scoreboard
          </div>
          <div className="page-sub">
            Ranking pencapaian leader lintas unit · {allLeaders.length} leader · {totalTim} anggota tim
          </div>
        </div>
      </div>

      {loading ? (
        <div className="loading-wrap">
          <div className="loading-spinner" />
          <div className="loading-text">Memuat data leader...</div>
        </div>
      ) : (
        <>
          {/* ── Stats Row ── */}
          <div className="lsc-stats-row">
            <div className="lsc-stat-card">
              <div className="lsc-stat-icon" style={{ background: '#FEF3C7', color: '#D97706' }}>
                <i className="ti ti-crown" />
              </div>
              <div>
                <div className="lsc-stat-val">{allLeaders.length}</div>
                <div className="lsc-stat-lbl">Total Leader</div>
              </div>
            </div>
            <div className="lsc-stat-card">
              <div className="lsc-stat-icon" style={{ background: '#EEF2FF', color: '#6366F1' }}>
                <i className="ti ti-users" />
              </div>
              <div>
                <div className="lsc-stat-val">{totalTim}</div>
                <div className="lsc-stat-lbl">Total Anggota Tim</div>
              </div>
            </div>
            <div className="lsc-stat-card">
              <div className="lsc-stat-icon" style={{ background: '#F0FBF7', color: '#1D9E75' }}>
                <i className="ti ti-chart-line" />
              </div>
              <div>
                <div className="lsc-stat-val" style={{ color: pctColor(grupAvg) }}>
                  {grupAvg !== null ? grupAvg.toFixed(1) + '%' : '—'}
                </div>
                <div className="lsc-stat-lbl">Avg Pencapaian</div>
              </div>
            </div>
            <div className="lsc-stat-card">
              <div className="lsc-stat-icon" style={{ background: '#F0FBF7', color: '#1D9E75' }}>
                <i className="ti ti-circle-check" />
              </div>
              <div>
                <div className="lsc-stat-val" style={{ color: '#1D9E75' }}>{onTrack}</div>
                <div className="lsc-stat-lbl">On Track (≥80%)</div>
              </div>
            </div>
            <div className="lsc-stat-card">
              <div className="lsc-stat-icon" style={{ background: '#FEF2F2', color: '#EF4444' }}>
                <i className="ti ti-alert-triangle" />
              </div>
              <div>
                <div className="lsc-stat-val" style={{ color: '#EF4444' }}>{atRisk}</div>
                <div className="lsc-stat-lbl">Perlu Perhatian</div>
              </div>
            </div>
            <div className="lsc-stat-card">
              <div className="lsc-stat-icon" style={{ background: '#F0FBF7', color: '#1D9E75' }}>
                <i className="ti ti-report-money" />
              </div>
              <div>
                <div className="lsc-stat-val" style={{ fontSize: 15 }}>
                  {totalTgt > 0 ? fmtRev(totalRev) : '—'}
                </div>
                <div className="lsc-stat-lbl">Total Pencapaian</div>
              </div>
            </div>
          </div>

          {/* ── Filter & Legend ── */}
          <div className="lsc-toolbar">
            <div className="ls-filter-row" style={{ margin: 0 }}>
              {FILTERS.map(f => (
                <button key={f.key}
                  className={'ls-filter-btn' + (filter === f.key ? ' ls-filter-btn--active' : '')}
                  onClick={() => setFilter(f.key)}>
                  {f.label}
                  {f.key !== 'all' && (
                    <span className="ls-filter-count">
                      {allLeaders.filter(l => l.unit === f.key).length}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="st-legend" style={{ margin: 0 }}>
              {[
                { cls: 'st-unggul',  label: 'Unggul ≥100%' },
                { cls: 'st-ontrack', label: 'On Track ≥80%' },
                { cls: 'st-waspada', label: 'Waspada ≥70%' },
                { cls: 'st-danger',  label: 'Perlu Perhatian <70%' },
                { cls: 'st-nodata',  label: 'Belum Ada Data' },
              ].map(s => (
                <span key={s.cls} className={`st-status-badge ${s.cls}`}>{s.label}</span>
              ))}
            </div>
          </div>

          {/* ── Card Grid ── */}
          {filtered.length === 0 ? (
            <div className="st-empty">
              <i className="ti ti-crown" style={{ fontSize: 40, color: '#D1D5DB' }} />
              <div style={{ fontSize: 15, fontWeight: 600, color: '#374151' }}>
                Belum ada leader di unit ini
              </div>
            </div>
          ) : (
            <>
              <div className="lsc-grid">
                {filtered.map(leader => (
                  <LeaderCard key={`${leader.unit}-${leader.id}`} leader={leader} navigate={navigate} />
                ))}
              </div>

              {/* ── Scoreboard Table ── */}
              <div className="lsc-section">
                <div className="lsc-section-head">
                  <i className="ti ti-table" />
                  Tabel Scoreboard
                  <span className="lsc-section-sub">Klik kolom untuk mengurutkan · Klik baris untuk detail</span>
                </div>
                <ScoreboardTable leaders={filtered} navigate={navigate} />
              </div>

              {/* ── Rekomendasi ── */}
              {needRec.length > 0 && (
                <div className="lsc-section">
                  <div className="lsc-section-head">
                    <i className="ti ti-bulb" style={{ color: '#F59E0B' }} />
                    Rekomendasi & Analisa
                    <span className="lsc-section-sub">{needRec.length} leader membutuhkan perhatian</span>
                  </div>
                  <div className="lsc-recs">
                    {needRec.map(l => {
                      const si = statusInfo(l.avgPct);
                      const ui = UNIT_INFO[l.unit] || { label: l.unit, color: '#7F77DD' };
                      return (
                        <div key={`${l.unit}-${l.id}`} className="lsc-rec-card"
                          onClick={() => navigate(`/anggota/${l.id}`)}>
                          <div className="lsc-rec-head">
                            <RankBadge rank={l.rank} size="xs" />
                            <div className="lsc-avatar lsc-avatar-sm" style={{ background: l.avatar_warna }}>
                              {getInisial(l.nama)}
                            </div>
                            <div className="lsc-rec-leader">
                              <span className="lsc-rec-name">{l.nama}</span>
                              <span className="lsc-unit-badge"
                                style={{ background: ui.color + '18', color: ui.color, borderColor: ui.color + '44' }}>
                                {ui.short}
                              </span>
                            </div>
                            <span className={`st-status-badge ${si.cls}`} style={{ marginLeft: 'auto' }}>
                              {si.label}
                            </span>
                            <span className="lsc-rec-pct" style={{ color: pctColor(l.avgPct) }}>
                              {l.avgPct !== null ? l.avgPct.toFixed(1) + '%' : '—'}
                            </span>
                          </div>
                          <div className="lsc-rec-body">
                            <i className="ti ti-alert-circle"
                              style={{ color: pctColor(l.avgPct), flexShrink: 0, marginTop: 2 }} />
                            <span>{generateRec(l, l.avgPct)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Layout>
  );
}
