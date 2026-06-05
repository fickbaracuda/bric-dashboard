import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import { getScoreboard } from '../services/api';

/* ── helpers ── */
function fmtRev(n) {
  if (!n && n !== 0) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return sign + 'Rp ' + (abs / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return sign + 'Rp ' + (abs / 1e9).toFixed(2) + 'M';
  if (abs >= 1e6)  return sign + 'Rp ' + (abs / 1e6).toFixed(0) + 'jt';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}

function fmtRevShort(n) {
  if (!n && n !== 0) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '+';
  if (abs >= 1e12) return sign + 'Rp ' + (abs / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return sign + 'Rp ' + (abs / 1e9).toFixed(0) + 'M';
  if (abs >= 1e6)  return sign + 'Rp ' + (abs / 1e6).toFixed(0) + 'jt';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}

function barColor(status) {
  return { Aman: '#1D9E75', Waspada: '#F59E0B', Awas: '#EF4444', Kritis: '#DC2626' }[status] || '#9CA3AF';
}
function pillClass(status) {
  return { Aman: 'pill-aman', Waspada: 'pill-waspada', Awas: 'pill-awas', Kritis: 'pill-kritis' }[status] || 'pill-kritis';
}

function ProgressBar({ pct, color }) {
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: Math.min(pct || 0, 100) + '%', background: color }} />
    </div>
  );
}

const BULAN_OPTIONS = ['JAN_2026','FEB_2026','MAR_2026','APR_2026','MEI_2026','JUN_2026'];
const FILTERS = ['Semua','Aman','Waspada','Kritis'];

/* ── Summary card ── */
function SumCard({ label, main, sub, subColor, badge, badgeColor }) {
  return (
    <div className="sum-card">
      <div className="sum-label">{label}</div>
      <div className="sum-main">{main}</div>
      {sub && <div className="sum-sub" style={{ color: subColor || 'var(--text-4)' }}>{sub}</div>}
      {badge && (
        <div className="sum-badge" style={{ background: badgeColor || '#F3F4F6', color: badgeColor ? '#fff' : 'var(--text-3)' }}>
          {badge}
        </div>
      )}
    </div>
  );
}

export default function Scoreboard() {
  const [data,    setData]    = useState(null);
  const [metric,  setMetric]  = useState('kpi');
  const [bulan,   setBulan]   = useState('JUN_2026');
  const [filter,  setFilter]  = useState('Semua');
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    setLoading(true); setError(null);
    getScoreboard(bulan, metric)
      .then(d  => { setData(d);          setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [bulan, metric]);

  const s            = data?.summary || {};
  const allRows      = data?.all_rows || [];
  const daysElapsed  = data?.days_elapsed || 0;
  const bulanLabel   = bulan.replace('_', ' ');

  // Table rows — apply filter (skip filter for subtotal rows)
  const tableRows = allRows.filter(r => {
    if (r.is_subtotal) return true; // always show subtotals
    if (filter === 'Semua') return true;
    return r.status === filter;
  });

  return (
    <Layout syncedAt={data?.synced_at} bulan={bulan}>

      {/* ── Page header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Pencapaian Bisnis — {bulanLabel}</h1>
          <p className="page-sub">
            Data per 1–{daysElapsed} {bulanLabel} · {s.unit_total || 0} unit aktif
          </p>
        </div>
        <div className="header-controls">
          <select className="select-input" value={bulan} onChange={e => setBulan(e.target.value)}>
            {BULAN_OPTIONS.map(b => <option key={b} value={b}>{b.replace('_', ' ')}</option>)}
          </select>
        </div>
      </div>

      {error && <div className="alert-error">⚠ {error}</div>}

      {loading ? (
        <div className="skeleton-grid">
          {[...Array(6)].map((_, i) => <div key={i} className="skeleton-card" />)}
        </div>
      ) : (
        <>
          {/* ── Summary cards ── */}
          <div className="sum-grid">
            <SumCard
              label="REVENUE JUNI"
              main={fmtRev(s.revenue_juni)}
              sub={s.delta_vs_mei ? fmtRevShort(s.delta_vs_mei) + ' vs Mei' : null}
              subColor={s.delta_vs_mei >= 0 ? '#1D9E75' : '#EF4444'}
            />
            <SumCard
              label="AVG REV / HARI"
              main={fmtRev(s.avg_rev_hari)}
              sub={`${daysElapsed} hari berjalan`}
            />
            <SumCard
              label="EST % KPI JUNI"
              main={<span style={{ color: s.est_kpi_juni >= 100 ? '#1D9E75' : '#EF4444' }}>{s.est_kpi_juni?.toFixed(2)}%</span>}
              sub={s.est_kpi_juni >= 100 ? '↗ Di atas target' : '↘ Di bawah target'}
              subColor={s.est_kpi_juni >= 100 ? '#1D9E75' : '#EF4444'}
            />
            <SumCard
              label="REAL % KPI"
              main={s.real_kpi?.toFixed(2) + '%'}
              sub="Akumulasi berjalan"
            />
            <SumCard
              label="UNIT AMAN"
              main={<span style={{ color: '#1D9E75', fontSize: '28px', fontWeight: 800 }}>{s.unit_aman}</span>}
              sub={`dari ${s.unit_total} unit`}
            />
            <SumCard
              label="UNIT KRITIS"
              main={<span style={{ color: '#DC2626', fontSize: '28px', fontWeight: 800 }}>{s.unit_kritis}</span>}
              sub="Perlu perhatian segera"
              subColor="#DC2626"
            />
          </div>

          {/* ── Table ── */}
          <section className="section">
            <div className="table-header-row">
              <h2 className="section-title" style={{ marginBottom: 0 }}>Detail pencapaian per poin</h2>
              <div className="filter-tabs">
                {FILTERS.map(f => (
                  <button
                    key={f}
                    className={`filter-tab${filter === f ? ' filter-tab--active' : ''}`}
                    onClick={() => setFilter(f)}
                  >{f}</button>
                ))}
              </div>
            </div>

            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="ranking-table">
                <thead>
                  <tr>
                    <th>POIN / UNIT</th>
                    <th>REV JUNI</th>
                    <th>TARGET RKAP</th>
                    <th>EST REV JUNI</th>
                    <th>REAL KPI</th>
                    <th style={{ minWidth: 120 }}>PROGRES</th>
                    <th>EST KPI</th>
                    <th>STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((row, i) => {
                    const pct = row.target_rkap > 0 ? (row.juni / row.target_rkap) * 100 : 0;
                    const isTotal = row.nama === 'REVENUE BISNIS BMS';
                    const isSub   = row.is_subtotal && !isTotal;
                    return (
                      <tr
                        key={i}
                        className={`table-row${isTotal ? ' row-total' : isSub ? ' row-subtotal' : ''}`}
                      >
                        <td className={`td-nama${isTotal ? ' td-nama--total' : isSub ? ' td-nama--sub' : ''}`}>
                          {row.nama}
                        </td>
                        <td>{fmtRev(row.juni)}</td>
                        <td>{fmtRev(row.target_rkap)}</td>
                        <td>{fmtRev(row.est_rev_juni)}</td>
                        <td>{row.real_kpi?.toFixed(2)}%</td>
                        <td>
                          <ProgressBar pct={pct} color={barColor(row.status)} />
                        </td>
                        <td>
                          <strong style={{ color: row.est_kpi_juni >= 100 ? '#1D9E75' : row.est_kpi_juni >= 80 ? '#F59E0B' : '#EF4444' }}>
                            {row.est_kpi_juni?.toFixed(2)}%
                          </strong>
                        </td>
                        <td>
                          {row.status && !isSub && !isTotal
                            ? <span className={`pill ${pillClass(row.status)}`}>{row.status}</span>
                            : <span style={{ fontWeight: 600, color: barColor(row.status) }}>{row.status}</span>
                          }
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </Layout>
  );
}
