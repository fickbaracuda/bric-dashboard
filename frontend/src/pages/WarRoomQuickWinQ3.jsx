import { useState, useEffect, useMemo } from 'react';
import Layout from '../components/Layout';
import { getQuickWinQ3Periods, getQuickWinQ3Analytics } from '../services/api';

const COLOR = '#7F77DD';
const WEEKLY_DEFAULT_LIMIT = 25;

/* ─── Format helpers ─── */
function fmtN(v) {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) return '-';
  return n.toLocaleString('id-ID');
}
function fmtRp(v) {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}Rp ${(abs / 1e9).toFixed(1)}M`;
  if (abs >= 1e6) return `${sign}Rp ${(abs / 1e6).toFixed(1)}jt`;
  if (abs >= 1e3) return `${sign}Rp ${(abs / 1e3).toFixed(0)}rb`;
  return `${sign}Rp ${Math.round(abs)}`;
}
function fmtPct(v, digits = 1) {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) return '-';
  const pct = Math.abs(n) <= 1.5 ? n * 100 : n; // backend kirim decimal 0..1 (kadang >1 utk overperform)
  return `${pct.toFixed(digits)}%`;
}
function fmtDate(v) {
  if (!v) return '-';
  const iso = String(v).slice(0, 10);
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return '-';
  return `${d}/${m}/${y}`;
}
function fmtDateTime(v) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ─── Metadata presentasi (frontend-only) ─── */
const STATUS_META = {
  aman:        { label: 'Aman',            color: '#059669', bg: '#DCFCE7' },
  waspada:     { label: 'Waspada',         color: '#B45309', bg: '#FEF3C7' },
  kritis:      { label: 'Kritis',          color: '#DC2626', bg: '#FEE2E2' },
  overperform: { label: 'Overperform',     color: '#7C3AED', bg: '#F5F3FF' },
  no_data:     { label: 'Tidak Ada Data',  color: '#6B7280', bg: '#F3F4F6' },
};
function statusMeta(s) { return STATUS_META[s] || STATUS_META.no_data; }

const PRIORITY_META = {
  P0: { label: 'Kritis',                    color: '#DC2626' },
  P1: { label: 'Waspada',                   color: '#F59E0B' },
  P2: { label: 'Jaga Momentum',             color: '#3B82F6' },
  P3: { label: 'Benchmark / Overperform',   color: '#7C3AED' },
  P4: { label: 'Data Quality',              color: '#6B7280' },
};
function priorityMeta(p) { return PRIORITY_META[p] || { label: p || '-', color: '#9CA3AF' }; }

const SEVERITY_META = {
  high:   { label: 'Tinggi', color: '#DC2626', bg: '#FEE2E2' },
  medium: { label: 'Sedang', color: '#B45309', bg: '#FEF3C7' },
  low:    { label: 'Rendah', color: '#1D4ED8', bg: '#DBEAFE' },
};
function severityMeta(s) { return SEVERITY_META[s] || SEVERITY_META.low; }

const DQ_SEVERITY_META = {
  high:   { label: 'Tinggi', color: '#DC2626' },
  medium: { label: 'Sedang', color: '#B45309' },
  low:    { label: 'Aman',   color: '#059669' },
};
function dqSeverityMeta(s) { return DQ_SEVERITY_META[s] || DQ_SEVERITY_META.low; }

const PRODUCT_COLOR = { Winme: '#378ADD', InstaQRIS: '#1D9E75' };
function productColor(p) { return PRODUCT_COLOR[p] || '#7F77DD'; }

/* ─── UI atoms ─── */
function KPICard({ label, value, sub, alert }) {
  return (
    <div className={'qw3-kpi-card' + (alert ? ' qw3-kpi-card--alert' : '')}>
      <div className="qw3-kpi-label">{label}</div>
      <div className="qw3-kpi-value">{value}</div>
      {sub && <div className="qw3-kpi-sub">{sub}</div>}
    </div>
  );
}

function ProgressBar({ pct, color }) {
  const n = Number(pct);
  const width = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.abs(n) <= 1.5 ? n * 100 : n)) : 0;
  return (
    <div className="qw3-progress-track">
      <div className="qw3-progress-fill" style={{ width: `${width}%`, background: color || COLOR }} />
    </div>
  );
}

function StatusBadge({ status }) {
  const m = statusMeta(status);
  return <span className="qw3-status-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}

function ProductFilterBar({ value, onChange, products }) {
  const options = ['all', ...products];
  const LABEL = { all: 'Semua Produk' };
  return (
    <div className="qw3-filter-bar">
      {options.map(p => (
        <button
          key={p}
          className={'qw3-filter-btn' + (value === p ? ' qw3-filter-btn--active' : '')}
          onClick={() => onChange(p)}
        >
          {LABEL[p] || p}
        </button>
      ))}
    </div>
  );
}

/* ─── Main ─── */
export default function WarRoomQuickWinQ3() {
  const [periods, setPeriods] = useState([]);
  const [periode, setPeriode] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [periodsLoaded, setPeriodsLoaded] = useState(false);
  const [productFilter, setProductFilter] = useState('all');
  const [weeklyShowAll, setWeeklyShowAll] = useState(false);

  useEffect(() => {
    getQuickWinQ3Periods()
      .then(res => {
        const list = Array.isArray(res) ? res : [];
        setPeriods(list);
        setPeriodsLoaded(true);
        if (list.length) setPeriode(list[0].periode);
        else setLoading(false);
      })
      .catch(e => { setError(e.message || 'Gagal memuat daftar periode'); setPeriodsLoaded(true); setLoading(false); });
  }, []);

  useEffect(() => {
    if (!periode) return;
    setLoading(true); setError(null);
    getQuickWinQ3Analytics(periode)
      .then(setAnalytics)
      .catch(e => setError(e.message || 'Gagal memuat analytics'))
      .finally(() => setLoading(false));
  }, [periode]);

  const isEmpty = periodsLoaded && !error && (periods.length === 0 || analytics?.empty === true);

  const meta = analytics?.meta;
  const summary = analytics?.summary;
  const products = Array.isArray(analytics?.products) ? analytics.products : [];
  const quickwins = Array.isArray(analytics?.quickwins) ? analytics.quickwins : [];
  const monthlyBreakdown = Array.isArray(analytics?.monthly_breakdown) ? analytics.monthly_breakdown : [];
  const weeklyBreakdown = Array.isArray(analytics?.weekly_breakdown) ? analytics.weekly_breakdown : [];
  const insights = Array.isArray(analytics?.insights) ? analytics.insights.slice(0, 5) : [];
  const actionSummary = Array.isArray(analytics?.action_summary) ? analytics.action_summary : [];
  const dataQuality = Array.isArray(analytics?.data_quality) ? analytics.data_quality : [];

  const productNames = useMemo(() => products.map(p => p.product).filter(Boolean), [products]);

  const quickwinsFiltered = useMemo(
    () => quickwins.filter(q => productFilter === 'all' || q.product === productFilter),
    [quickwins, productFilter]
  );
  const monthlyFiltered = useMemo(
    () => monthlyBreakdown.filter(m => productFilter === 'all' || m.product === productFilter),
    [monthlyBreakdown, productFilter]
  );
  const weeklyFiltered = useMemo(
    () => weeklyBreakdown.filter(w => productFilter === 'all' || w.product === productFilter),
    [weeklyBreakdown, productFilter]
  );
  const weeklyVisible = weeklyShowAll ? weeklyFiltered : weeklyFiltered.slice(0, WEEKLY_DEFAULT_LIMIT);
  const actionSummaryFiltered = useMemo(
    () => actionSummary.filter(a => productFilter === 'all' || !a.product || a.product === productFilter),
    [actionSummary, productFilter]
  );

  const formulaErrorCheck = dataQuality.find(d => d.key === 'formula_error_count');
  const hasFormulaError = formulaErrorCheck && Number(formulaErrorCheck.count) > 0;

  const monthlyGrouped = useMemo(() => {
    const map = new Map();
    monthlyFiltered.forEach(m => {
      const key = `${m.product}|${m.month_key}`;
      if (!map.has(key)) map.set(key, { product: m.product, month_key: m.month_key, month_label: m.month_label, rows: [] });
      map.get(key).rows.push(m);
    });
    return [...map.values()].sort((a, b) => (a.product + a.month_key).localeCompare(b.product + b.month_key));
  }, [monthlyFiltered]);

  return (
    <Layout>
      <div className="qw3-page">

        {/* Header / Hero */}
        <div className="qw3-header">
          <div className="qw3-header-left">
            <i className="ti ti-target-arrow" style={{ color: COLOR, fontSize: 24 }} />
            <div>
              <div className="qw3-header-title">Quick Win Q3 IQWM</div>
              <div className="qw3-header-sub">Monitoring target, realisasi, gap, estimasi akhir Q3, PIC, dan prioritas aksi Quick Win Winme & InstaQRIS.</div>
            </div>
          </div>
          <div className="qw3-header-right">
            {periods.length > 0 && (
              <select className="qw3-select" value={periode || ''} onChange={e => setPeriode(e.target.value)}>
                {periods.map(p => <option key={p.periode} value={p.periode}>{p.label || p.periode}</option>)}
              </select>
            )}
            {meta?.last_sync && (
              <span className="qw3-badge qw3-badge-sync">
                <i className="ti ti-refresh" /> Sync terakhir: {fmtDateTime(meta.last_sync)}
              </span>
            )}
          </div>
        </div>

        {/* States */}
        {loading && <div className="qw3-loading"><i className="ti ti-loader-2 qw3-spin" /> Memuat data...</div>}
        {!loading && error && <div className="qw3-error"><i className="ti ti-alert-circle" /> {error}</div>}
        {!loading && !error && periods.length === 0 && (
          <div className="qw3-empty">
            <i className="ti ti-target-arrow" />
            <div>Data Quick Win Q3 belum tersedia. Jalankan migration dan sync Google Sheet terlebih dahulu.</div>
          </div>
        )}
        {!loading && !error && periods.length > 0 && analytics?.empty === true && (
          <div className="qw3-empty">
            <i className="ti ti-calendar-off" />
            <div>Tidak ada periode Quick Win Q3 yang tersedia.</div>
          </div>
        )}

        {!loading && !error && !isEmpty && analytics && (<>

          {/* Progress Waktu Q3 */}
          <div className="qw3-panel">
            <div className="qw3-panel-title"><i className="ti ti-hourglass" style={{ color: COLOR }} /> Progress Waktu Q3</div>
            <div className="qw3-time-row">
              <div className="qw3-time-info">
                <div>Hari ke-<strong>{fmtN(meta?.days_elapsed)}</strong> dari <strong>{fmtN(meta?.total_days)}</strong> hari ({meta?.period_start ? fmtDate(meta.period_start) : '-'} s/d {meta?.period_end ? fmtDate(meta.period_end) : '-'})</div>
                <div className="qw3-time-sub">Per tanggal (as of date): <strong>{fmtDate(meta?.as_of_date)}</strong></div>
              </div>
              <div className="qw3-time-pct">{fmtPct(meta?.progress_time_pct)}</div>
            </div>
            <ProgressBar pct={meta?.progress_time_pct} color={COLOR} />
          </div>

          {/* Data quality warning banner */}
          {hasFormulaError && (
            <div className="qw3-warning-banner">
              <i className="ti ti-alert-triangle" />
              <div>Google Sheet masih memiliki formula error. Angka terkait akan dibaca sebagai null/0 agar dashboard tidak error.</div>
            </div>
          )}

          {/* Executive KPI Cards */}
          <div className="qw3-kpi-grid">
            <KPICard label="Target Revenue Q3" value={fmtRp(summary?.total_target_revenue_q3)} />
            <KPICard label="Realisasi Revenue" value={fmtRp(summary?.total_realization_revenue)} />
            <KPICard label="% Revenue Achievement" value={fmtPct(summary?.revenue_achievement_pct)} />
            <KPICard label="Estimasi Akhir Q3" value={fmtRp(summary?.total_estimated_end_q3)} sub={`${fmtPct(summary?.estimated_achievement_pct)} dari target`} />
            <KPICard label="Gap ke Target" value={fmtRp(summary?.total_gap_revenue)} alert={(summary?.total_gap_revenue || 0) > 0} />
            <KPICard label="Quick Win Total" value={fmtN(summary?.quickwin_count)} sub={`${fmtN(summary?.products_count)} produk`} />
            <KPICard label="Quick Win Kritis" value={fmtN(summary?.quickwin_kritis_count)} alert={(summary?.quickwin_kritis_count || 0) > 0} />
            <KPICard label="Quick Win Waspada" value={fmtN(summary?.quickwin_waspada_count)} />
            <KPICard label="Aman / Overperform" value={`${fmtN(summary?.quickwin_aman_count)} / ${fmtN(summary?.quickwin_overperform_count)}`} />
          </div>

          {/* Product Summary */}
          <div className="qw3-panel">
            <div className="qw3-panel-title"><i className="ti ti-scale" style={{ color: COLOR }} /> Perbandingan Produk</div>
            {products.length === 0 && <div className="qw3-empty-sub">Belum ada data produk.</div>}
            <div className="qw3-product-grid">
              {products.map((p, i) => (
                <div key={i} className="qw3-product-card" style={{ '--pc-color': productColor(p.product) }}>
                  <div className="qw3-product-top">
                    <div className="qw3-product-name">{p.product}</div>
                    <StatusBadge status={p.status} />
                  </div>
                  <div className="qw3-product-stats">
                    <div><span className="qw3-product-stat-label">Target Revenue</span><span className="qw3-product-stat-value">{fmtRp(p.target_revenue)}</span></div>
                    <div><span className="qw3-product-stat-label">Realisasi</span><span className="qw3-product-stat-value">{fmtRp(p.realization_revenue)}</span></div>
                    <div><span className="qw3-product-stat-label">Estimasi Akhir Q3</span><span className="qw3-product-stat-value">{fmtRp(p.estimated_end_q3)}</span></div>
                    <div><span className="qw3-product-stat-label">Gap</span><span className="qw3-product-stat-value">{fmtRp(p.gap_revenue)}</span></div>
                  </div>
                  <ProgressBar pct={p.revenue_achievement_pct} color={productColor(p.product)} />
                  <div className="qw3-product-pct">{fmtPct(p.revenue_achievement_pct)} tercapai · {fmtN(p.quickwin_count)} Quick Win</div>
                  {p.pic_list?.length > 0 && <div className="qw3-product-pic">PIC: {p.pic_list.join(', ')}</div>}
                </div>
              ))}
            </div>
          </div>

          {/* Filter Product */}
          <ProductFilterBar value={productFilter} onChange={setProductFilter} products={productNames} />

          {/* Quick Win Cards */}
          <div className="qw3-panel">
            <div className="qw3-panel-title"><i className="ti ti-rocket" style={{ color: COLOR }} /> Daftar Quick Win</div>
            {quickwinsFiltered.length === 0 && <div className="qw3-empty-sub">Tidak ada Quick Win untuk filter ini.</div>}
            <div className="qw3-quickwin-grid">
              {quickwinsFiltered.map((q, i) => {
                const sm = statusMeta(q.status);
                return (
                  <div key={i} className="qw3-quickwin-card" style={{ '--qwc-color': sm.color }}>
                    <div className="qw3-quickwin-top">
                      <span className="qw3-quickwin-product" style={{ color: productColor(q.product) }}>{q.product} · #{q.quickwin_no}</span>
                      <StatusBadge status={q.status} />
                    </div>
                    <div className="qw3-quickwin-title">{q.point_quickwin}</div>
                    {q.target_label && <div className="qw3-quickwin-target-label">Target: {q.target_label}</div>}
                    <div className="qw3-quickwin-stats">
                      <div><span className="qw3-qw-stat-label">Realisasi Target</span><span className="qw3-qw-stat-value">{fmtN(q.realization_target)} ({fmtPct(q.realization_target_pct)})</span></div>
                      <div><span className="qw3-qw-stat-label">Realisasi Revenue</span><span className="qw3-qw-stat-value">{fmtRp(q.realization_revenue)} ({fmtPct(q.realization_revenue_pct)})</span></div>
                      <div><span className="qw3-qw-stat-label">Target Revenue</span><span className="qw3-qw-stat-value">{fmtRp(q.target_revenue)}</span></div>
                      <div><span className="qw3-qw-stat-label">Estimasi Akhir Q3</span><span className="qw3-qw-stat-value">{fmtRp(q.estimated_end_q3)}</span></div>
                      <div><span className="qw3-qw-stat-label">Gap Revenue</span><span className="qw3-qw-stat-value">{fmtRp(q.revenue_gap)}</span></div>
                      <div><span className="qw3-qw-stat-label">Gap vs Pace</span><span className="qw3-qw-stat-value">{fmtRp(q.pace_gap)}</span></div>
                    </div>
                    <ProgressBar pct={q.realization_revenue_pct} color={sm.color} />
                    <div className="qw3-quickwin-foot">
                      <span><i className="ti ti-user" /> PIC: {q.pic || '-'}</span>
                      <span className="qw3-priority-chip" style={{ background: priorityMeta(q.priority).color }}>{q.priority}</span>
                    </div>
                    {q.recommendation && <div className="qw3-quickwin-reko"><i className="ti ti-bulb" /> {q.recommendation}</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Monthly Breakdown */}
          <div className="qw3-panel">
            <div className="qw3-panel-title"><i className="ti ti-calendar-stats" style={{ color: COLOR }} /> Breakdown Bulanan</div>
            {monthlyGrouped.length === 0 && <div className="qw3-empty-sub">Breakdown belum tersedia atau parser Apps Script perlu dicek.</div>}
            {monthlyGrouped.length > 0 && (
              <div className="qw3-table-wrap">
                <table className="qw3-table">
                  <thead>
                    <tr><th>Produk</th><th>Bulan</th><th>Metric</th><th>Target</th><th>Realisasi</th><th>%</th><th>Gap</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {monthlyGrouped.map((grp, gi) => (
                      grp.rows.map((m, i) => (
                        <tr key={gi + '-' + i}>
                          {i === 0 && <td rowSpan={grp.rows.length} style={{ color: productColor(grp.product), fontWeight: 700 }}>{grp.product}</td>}
                          {i === 0 && <td rowSpan={grp.rows.length}>{grp.month_label}</td>}
                          <td>{m.metric_label}</td>
                          <td>{fmtN(m.target_value)}</td>
                          <td>{fmtN(m.realization_value)}</td>
                          <td>{fmtPct(m.realization_pct)}</td>
                          <td>{fmtN(m.gap_value)}</td>
                          <td><StatusBadge status={m.status} /></td>
                        </tr>
                      ))
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Weekly Breakdown */}
          <div className="qw3-panel">
            <div className="qw3-panel-title"><i className="ti ti-calendar-week" style={{ color: COLOR }} /> Breakdown Mingguan</div>
            {weeklyFiltered.length === 0 && <div className="qw3-empty-sub">Breakdown belum tersedia atau parser Apps Script perlu dicek.</div>}
            {weeklyFiltered.length > 0 && (<>
              <div className="qw3-filter-count">Menampilkan {fmtN(weeklyVisible.length)} dari {fmtN(weeklyFiltered.length)} baris</div>
              <div className="qw3-table-wrap">
                <table className="qw3-table">
                  <thead>
                    <tr><th>Produk</th><th>QW</th><th>Metric</th><th>Bulan</th><th>Minggu</th><th>Target</th><th>Realisasi</th><th>%</th><th>Gap</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {weeklyVisible.map((w, i) => (
                      <tr key={i}>
                        <td style={{ color: productColor(w.product), fontWeight: 700 }}>{w.product}</td>
                        <td>{w.quickwin_no ?? '-'}</td>
                        <td>{w.metric_label}</td>
                        <td>{w.month_label}</td>
                        <td>{w.week_label}</td>
                        <td>{fmtN(w.target_value)}</td>
                        <td>{w.realization_value === null ? <span className="qw3-na">belum terjadi</span> : fmtN(w.realization_value)}</td>
                        <td>{fmtPct(w.realization_pct)}</td>
                        <td>{fmtN(w.gap_value)}</td>
                        <td><StatusBadge status={w.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {weeklyFiltered.length > WEEKLY_DEFAULT_LIMIT && (
                <button className="qw3-toggle-btn" onClick={() => setWeeklyShowAll(v => !v)}>
                  {weeklyShowAll ? 'Tampilkan Lebih Sedikit' : `Lihat Semua (${fmtN(weeklyFiltered.length)})`}
                </button>
              )}
            </>)}
          </div>

          {/* Insight */}
          <div className="qw3-panel">
            <div className="qw3-panel-title"><i className="ti ti-bulb" style={{ color: COLOR }} /> Insight</div>
            {insights.length === 0 && <div className="qw3-empty-sub">Tidak ada insight khusus untuk periode ini.</div>}
            <div className="qw3-insight-grid">
              {insights.map((ins, i) => {
                const sm = severityMeta(ins.severity);
                return (
                  <div key={i} className="qw3-insight-card" style={{ '--ins-color': sm.color }}>
                    <div className="qw3-insight-top">
                      <div className="qw3-insight-title">{ins.title}</div>
                      <span className="qw3-severity-badge" style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>
                    </div>
                    <div className="qw3-insight-desc">{ins.description}</div>
                    {ins.recommendation && <div className="qw3-insight-reko"><i className="ti ti-arrow-right" /> {ins.recommendation}</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Action Summary */}
          <div className="qw3-panel">
            <div className="qw3-panel-title"><i className="ti ti-list-check" style={{ color: COLOR }} /> Prioritas Aksi</div>
            {actionSummaryFiltered.length === 0 && <div className="qw3-empty-sub">Tidak ada aksi prioritas untuk filter ini.</div>}
            <div className="qw3-action-grid">
              {actionSummaryFiltered.map((a, i) => {
                const pm = priorityMeta(a.priority);
                return (
                  <div key={i} className="qw3-action-card" style={{ '--ac-color': pm.color }}>
                    <div className="qw3-action-top">
                      <span className="qw3-priority-badge" style={{ background: pm.color }}>{a.priority} · {pm.label}</span>
                      <span className="qw3-action-count">{fmtN(a.count)}</span>
                    </div>
                    <div className="qw3-action-title">{a.title}{a.product ? ` (${a.product}${a.quickwin_no ? ' #' + a.quickwin_no : ''})` : ''}</div>
                    {a.recommendation && <div className="qw3-action-reko">{a.recommendation}</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Data Quality */}
          <div className="qw3-panel">
            <div className="qw3-panel-title"><i className="ti ti-database-cog" style={{ color: COLOR }} /> Kualitas Data</div>
            {dataQuality.filter(d => Number(d.count) > 0).length === 0 && (
              <div className="qw3-empty-sub">Tidak ada isu kualitas data untuk periode ini.</div>
            )}
            <div className="qw3-dq-list">
              {dataQuality.filter(d => Number(d.count) > 0).map((d, i) => {
                const sm = dqSeverityMeta(d.severity);
                return (
                  <div key={i} className="qw3-dq-item" style={{ '--dq-color': sm.color }}>
                    <div className="qw3-dq-top">
                      <div className="qw3-dq-title">{d.label}</div>
                      <span className="qw3-severity-badge" style={{ background: sm.color + '22', color: sm.color }}>{sm.label}</span>
                      <div className="qw3-dq-count">{fmtN(d.count)}</div>
                    </div>
                    {d.recommendation && <div className="qw3-dq-note">{d.recommendation}</div>}
                  </div>
                );
              })}
            </div>
          </div>

        </>)}
      </div>
    </Layout>
  );
}
