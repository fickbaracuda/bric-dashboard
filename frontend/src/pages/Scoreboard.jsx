import { useState, useEffect } from 'react';
import Topbar from '../components/Topbar';
import Nav from '../components/Nav';
import { getScoreboard } from '../services/api';

function fmtRev(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1e12) return 'Rp ' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return 'Rp ' + (n / 1e9).toFixed(1) + 'M';
  if (n >= 1e6)  return 'Rp ' + (n / 1e6).toFixed(1) + 'jt';
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

function barColor(status) {
  const map = { Aman: '#1D9E75', Waspada: '#EF9F27', Awas: '#D85A30', Kritis: '#E24B4A' };
  return map[status] || '#888780';
}

function pillClass(status) {
  const map = { Aman: 'pill-aman', Waspada: 'pill-waspada', Awas: 'pill-awas', Kritis: 'pill-kritis' };
  return map[status] || 'pill-kritis';
}

function getInisial(nama) {
  const words = nama.trim().split(' ');
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return nama.substring(0, 2).toUpperCase();
}

const avatarColors = [
  '#1D9E75','#378ADD','#5DCAA5','#7F77DD',
  '#EF9F27','#D4537E','#888780','#BA7517',
  '#D85A30','#993C1D','#E24B4A','#A32D2D','#791F1F'
];

const BULAN_OPTIONS = [
  'JAN_2026','FEB_2026','MAR_2026','APR_2026','MEI_2026','JUN_2026'
];

function DeltaBadge({ delta }) {
  if (delta > 0) return <span className="delta-badge delta-up">↑ Naik</span>;
  if (delta < 0) return <span className="delta-badge delta-down">↓ Turun</span>;
  return <span className="delta-badge delta-flat">→ Tetap</span>;
}

function ProgressBar({ pct, color }) {
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: Math.min(pct || 0, 100) + '%', background: color }} />
    </div>
  );
}

function PodiumCard({ unit, rank, metric }) {
  const borderColors = { 1: '#BA7517', 2: '#888780', 3: '#D85A30' };
  const skor = metric === 'rev' ? fmtRev(unit.rev_juni) : (unit.est_kpi_juni?.toFixed(2) + '%');
  const skorSub = metric === 'rev' ? (unit.est_kpi_juni?.toFixed(2) + '%') : fmtRev(unit.rev_juni);
  const pct = unit.target_rkap > 0 ? (unit.rev_juni / unit.target_rkap) * 100 : 0;
  const color = avatarColors[(rank - 1) % avatarColors.length];

  return (
    <div className={`podium-card podium-rank-${rank}`} style={{ borderColor: borderColors[rank] }}>
      <div className="podium-badge">
        <span>{rank === 1 ? '👑' : rank === 2 ? '🥈' : '🥉'}</span>
        <span className="podium-rank-num">#{rank}</span>
      </div>
      <div className="podium-avatar" style={{ background: color }}>
        {getInisial(unit.nama)}
      </div>
      <div className="podium-nama">{unit.nama}</div>
      <div className="podium-skor">{skor}</div>
      <div className="podium-skor-sub">{skorSub}</div>
      <ProgressBar pct={pct} color={barColor(unit.status)} />
      <span className={`pill ${pillClass(unit.status)}`}>{unit.status}</span>
    </div>
  );
}

function UnitCard({ unit, index, metric }) {
  const skor = metric === 'rev' ? fmtRev(unit.rev_juni) : (unit.est_kpi_juni?.toFixed(2) + '%');
  const pct = unit.target_rkap > 0 ? (unit.rev_juni / unit.target_rkap) * 100 : 0;
  const color = avatarColors[index % avatarColors.length];

  return (
    <div className="unit-card">
      <div className="unit-card-left">
        <span className="unit-rank">#{unit.rank}</span>
        <div className="unit-avatar" style={{ background: color }}>{getInisial(unit.nama)}</div>
        <div className="unit-info">
          <div className="unit-nama">{unit.nama}</div>
          <DeltaBadge delta={unit.delta_rank} />
        </div>
      </div>
      <div className="unit-card-right">
        <ProgressBar pct={pct} color={barColor(unit.status)} />
        <div className="unit-card-bottom">
          <span className={`pill ${pillClass(unit.status)}`}>{unit.status}</span>
          <span className="unit-skor">{skor}</span>
        </div>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return <div className="skeleton-card" />;
}

export default function Scoreboard() {
  const [data, setData] = useState(null);
  const [metric, setMetric] = useState('kpi');
  const [bulan, setBulan] = useState('JUN_2026');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getScoreboard(bulan, metric)
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [bulan, metric]);

  const rankings = data?.rankings || [];
  const top3 = rankings.slice(0, 3);
  const rest = rankings.slice(3);
  const summary = data?.summary;

  return (
    <div className="page-wrap">
      <Topbar syncedAt={data?.synced_at} bulan={bulan} />
      <Nav />

      <main className="main-content">
        <div className="page-header">
          <div>
            <h1 className="page-title">Unit Scoreboard — {bulan.replace('_', ' ')}</h1>
            <p className="page-sub">
              Ranking pencapaian per unit · {rankings.length} unit aktif (subtotal & total dikecualikan)
            </p>
          </div>
          <div className="header-controls">
            <select
              className="bulan-select"
              value={bulan}
              onChange={e => setBulan(e.target.value)}
            >
              {BULAN_OPTIONS.map(b => (
                <option key={b} value={b}>{b.replace('_', ' ')}</option>
              ))}
            </select>
            <div className="metric-toggle">
              <button
                className={`metric-btn${metric === 'kpi' ? ' metric-btn--active' : ''}`}
                onClick={() => setMetric('kpi')}
              >Est % KPI</button>
              <button
                className={`metric-btn${metric === 'rev' ? ' metric-btn--active' : ''}`}
                onClick={() => setMetric('rev')}
              >Revenue</button>
            </div>
          </div>
        </div>

        {error && (
          <div className="error-box">
            ⚠️ Gagal memuat data: {error}
          </div>
        )}

        {loading ? (
          <div className="skeleton-wrap">
            {[...Array(8)].map((_, i) => <SkeletonCard key={i} />)}
          </div>
        ) : (
          <>
            {summary && (
              <div className="summary-grid">
                <div className="summary-card">
                  <div className="summary-label">Unit Terbaik</div>
                  <div className="summary-value">{summary.unit_terbaik?.nama || '—'}</div>
                  <div className="summary-sub" style={{ color: '#1D9E75', fontWeight: 600 }}>
                    {summary.unit_terbaik?.nilai?.toFixed(2)}%
                  </div>
                </div>
                <div className="summary-card">
                  <div className="summary-label">Unit Terendah</div>
                  <div className="summary-value">{summary.unit_terendah?.nama || '—'}</div>
                  <div className="summary-sub" style={{ color: '#E24B4A', fontWeight: 600 }}>
                    {summary.unit_terendah?.nilai?.toFixed(2)}%
                  </div>
                </div>
                <div className="summary-card">
                  <div className="summary-label">Di Atas Target</div>
                  <div className="summary-value summary-value--big" style={{ color: '#1D9E75' }}>
                    {summary.unit_di_atas_target}
                  </div>
                  <div className="summary-sub">unit ≥ 100%</div>
                </div>
                <div className="summary-card">
                  <div className="summary-label">Rata-rata Est KPI</div>
                  <div className="summary-value summary-value--big">
                    {summary.rata_rata_est_kpi?.toFixed(2)}%
                  </div>
                  <div className="summary-sub">semua unit</div>
                </div>
              </div>
            )}

            {top3.length >= 3 && (
              <div className="podium-section">
                <h2 className="section-title">Podium 3 Besar</h2>
                <div className="podium-layout">
                  <PodiumCard unit={top3[1]} rank={2} metric={metric} />
                  <PodiumCard unit={top3[0]} rank={1} metric={metric} />
                  <PodiumCard unit={top3[2]} rank={3} metric={metric} />
                </div>
              </div>
            )}

            {rest.length > 0 && (
              <div className="units-section">
                <h2 className="section-title">Ranking Selengkapnya</h2>
                <div className="units-grid">
                  {rest.map((u, i) => (
                    <UnitCard key={u.nama} unit={u} index={i + 3} metric={metric} />
                  ))}
                </div>
              </div>
            )}

            {rankings.length > 0 && (
              <div className="table-section">
                <h2 className="section-title">Tabel Ranking Lengkap</h2>
                <div className="table-wrap">
                  <table className="ranking-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Unit</th>
                        <th>Revenue Juni</th>
                        <th>Target RKAP</th>
                        <th>Real KPI</th>
                        <th>Est KPI</th>
                        <th>Progress</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rankings.map((u, i) => {
                        const pct = u.target_rkap > 0 ? (u.rev_juni / u.target_rkap) * 100 : 0;
                        return (
                          <tr key={u.nama} className="table-row">
                            <td className="td-rank">
                              {u.rank === 1 ? '👑' : u.rank === 2 ? '🥈' : u.rank === 3 ? '🥉' : u.rank}
                            </td>
                            <td>
                              <div className="td-unit-inner">
                                <div className="td-avatar" style={{ background: avatarColors[i % avatarColors.length] }}>
                                  {u.inisial}
                                </div>
                                <span>{u.nama}</span>
                              </div>
                            </td>
                            <td>{fmtRev(u.rev_juni)}</td>
                            <td>{fmtRev(u.target_rkap)}</td>
                            <td>{u.real_kpi?.toFixed(2)}%</td>
                            <td><strong>{u.est_kpi_juni?.toFixed(2)}%</strong></td>
                            <td style={{ minWidth: 100 }}>
                              <ProgressBar pct={pct} color={barColor(u.status)} />
                            </td>
                            <td>
                              <span className={`pill ${pillClass(u.status)}`}>{u.status}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {rankings.length === 0 && !error && (
              <div className="empty-box">
                Belum ada data untuk {bulan.replace('_', ' ')}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
