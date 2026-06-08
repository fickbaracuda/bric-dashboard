import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import { getMembers } from '../services/api';

/* ── Constants ── */
const UNIT_INFO = {
  winme_instaqris: { label: 'Winme & InstaQris', color: '#7F77DD' },
  payment_agent:   { label: 'Payment Agent',      color: '#639922' },
  speedcash:       { label: 'SpeedCash',          color: '#EF4444' },
};

const FILTERS = [
  { key: 'all',            label: 'Semua Unit' },
  { key: 'winme_instaqris', label: 'Winme & InstaQris' },
  { key: 'payment_agent',  label: 'Payment Agent' },
  { key: 'speedcash',      label: 'SpeedCash' },
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
  if (pct >= 100) return '#1D9E75';
  if (pct >= 80)  return '#F59E0B';
  if (pct >= 70)  return '#F97316';
  return '#EF4444';
}

function statusInfo(pct) {
  if (pct === null) return { label: 'Belum Ada Data', cls: 'st-nodata' };
  if (pct >= 100) return { label: 'Unggul',          cls: 'st-unggul' };
  if (pct >= 80)  return { label: 'On Track',         cls: 'st-ontrack' };
  if (pct >= 70)  return { label: 'Waspada',          cls: 'st-waspada' };
  return           { label: 'Perlu Perhatian',  cls: 'st-danger' };
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
function RankBadge({ rank }) {
  if (rank === 1) return <div className="ls-rank ls-rank-gold">🥇</div>;
  if (rank === 2) return <div className="ls-rank ls-rank-silver">🥈</div>;
  if (rank === 3) return <div className="ls-rank ls-rank-bronze">🥉</div>;
  return <div className="ls-rank ls-rank-n">{rank}</div>;
}

/* ── Leader Card ── */
function LeaderCard({ leader, navigate }) {
  const pct      = leader.avgPct;
  const si       = statusInfo(pct);
  const unitInfo = UNIT_INFO[leader.unit] || { label: leader.unit, color: '#7F77DD' };
  const rec      = generateRec(leader, pct);
  const barPct   = Math.min(pct ?? 0, 100);

  return (
    <div className="ls-card" onClick={() => navigate(`/anggota/${leader.id}`)}>
      {/* ── Main row ── */}
      <div className="ls-card-main">
        <RankBadge rank={leader.rank} />

        <div className="ls-avatar" style={{ background: leader.avatar_warna }}>
          {getInisial(leader.nama)}
        </div>

        <div className="ls-card-body">
          {/* Top: name + meta + pct */}
          <div className="ls-card-top">
            <div className="ls-card-left">
              <div className="ls-name">{leader.nama}</div>
              <div className="ls-meta">
                <span className="ls-unit-badge"
                  style={{ background: unitInfo.color + '18', color: unitInfo.color, border: `0.5px solid ${unitInfo.color}44` }}>
                  {unitInfo.label}
                </span>
                {leader.fungsi && <span className="ls-fungsi">{leader.fungsi}</span>}
                {leader.timCount > 0 && (
                  <span className="ls-tim-count">
                    <i className="ti ti-users" /> {leader.timCount} anggota tim
                  </span>
                )}
              </div>
            </div>
            <div className="ls-card-right">
              <div className="ls-pct" style={{ color: pctColor(pct) }}>
                {pct !== null ? pct.toFixed(1) + '%' : '—'}
              </div>
              <span className={`st-status-badge ${si.cls}`}>{si.label}</span>
            </div>
          </div>

          {/* Progress bar */}
          <div className="ls-progress-bg">
            <div className="ls-progress-fill"
              style={{ width: barPct + '%', background: pctColor(pct) }} />
          </div>

          {/* Revenue stats */}
          <div className="ls-rev-row">
            <div className="ls-rev-item">
              <span className="ls-rev-lbl">Target</span>
              <span className="ls-rev-val">{leader.targetRev > 0 ? fmtRev(leader.targetRev) : '—'}</span>
            </div>
            <div className="ls-rev-sep" />
            <div className="ls-rev-item">
              <span className="ls-rev-lbl">Pencapaian</span>
              <span className="ls-rev-val" style={{ color: pctColor(pct) }}>
                {leader.totalRev > 0 ? fmtRev(leader.totalRev) : '—'}
              </span>
            </div>
            <div className="ls-rev-sep" />
            <div className="ls-rev-item">
              <span className="ls-rev-lbl">Jumlah Target</span>
              <span className="ls-rev-val">{(leader.targets || []).length} target</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Rekomendasi ── */}
      <div className="ls-rec">
        <i className="ti ti-bulb" style={{ color: pctColor(pct), fontSize: 14, flexShrink: 0, marginTop: 2 }} />
        <span>{rec}</span>
      </div>
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

  /* Build ranked list from all leaders (rank = overall position) */
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

  /* Summary stats */
  const withData = allLeaders.filter(l => l.avgPct !== null);
  const grupAvg  = withData.length
    ? withData.reduce((s, l) => s + l.avgPct, 0) / withData.length : null;
  const onTrack = withData.filter(l => l.avgPct >= 80).length;
  const atRisk  = withData.filter(l => l.avgPct < 70).length;

  return (
    <Layout>
      <div className="page-header">
        <div>
          <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-medal" style={{ color: '#F59E0B' }} />
            Leader Scoreboard
          </div>
          <div className="page-sub">
            Ranking pencapaian leader lintas unit · {allLeaders.length} leader terdaftar
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
          {/* Stats row */}
          <div className="st-stats-row" style={{ marginBottom: 16 }}>
            <div className="st-stat-card">
              <div className="st-stat-icon" style={{ background: '#FEF3C7', color: '#D97706' }}>
                <i className="ti ti-crown" />
              </div>
              <div>
                <div className="st-stat-val">{allLeaders.length}</div>
                <div className="st-stat-lbl">Total Leader</div>
              </div>
            </div>
            <div className="st-stat-card">
              <div className="st-stat-icon" style={{ background: '#F0FBF7', color: '#1D9E75' }}>
                <i className="ti ti-chart-line" />
              </div>
              <div>
                <div className="st-stat-val" style={{ color: pctColor(grupAvg) }}>
                  {grupAvg !== null ? grupAvg.toFixed(1) + '%' : '—'}
                </div>
                <div className="st-stat-lbl">Avg Pencapaian</div>
              </div>
            </div>
            <div className="st-stat-card">
              <div className="st-stat-icon" style={{ background: '#F0FBF7', color: '#1D9E75' }}>
                <i className="ti ti-circle-check" />
              </div>
              <div>
                <div className="st-stat-val" style={{ color: '#1D9E75' }}>{onTrack}</div>
                <div className="st-stat-lbl">On Track (≥80%)</div>
              </div>
            </div>
            <div className="st-stat-card">
              <div className="st-stat-icon" style={{ background: '#FEF2F2', color: '#EF4444' }}>
                <i className="ti ti-alert-triangle" />
              </div>
              <div>
                <div className="st-stat-val" style={{ color: '#EF4444' }}>{atRisk}</div>
                <div className="st-stat-lbl">Perlu Perhatian</div>
              </div>
            </div>
          </div>

          {/* Filter tabs */}
          <div className="ls-filter-row">
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

          {/* Legend */}
          <div className="st-legend" style={{ marginBottom: 16 }}>
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

          {/* Cards */}
          {filtered.length === 0 ? (
            <div className="st-empty">
              <i className="ti ti-crown" style={{ fontSize: 40, color: '#D1D5DB' }} />
              <div style={{ fontSize: 15, fontWeight: 600, color: '#374151' }}>
                Belum ada leader di unit ini
              </div>
            </div>
          ) : (
            <div className="ls-cards">
              {filtered.map(leader => (
                <LeaderCard key={`${leader.unit}-${leader.id}`} leader={leader} navigate={navigate} />
              ))}
            </div>
          )}
        </>
      )}
    </Layout>
  );
}
