import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Layout from '../components/Layout';
import Chart from 'chart.js/auto';
import {
  getFarmingSnapshots, getFarmingAnalytics, getFarmingActionQueue, getFarmingOutlets,
  getFarmingOutletDetail, getFarmingTrendline, getFarmingDataQuality, upsertFarmingFollowup,
} from '../services/api';

const COLOR = '#10B981';
const TABS = [
  { key: 'command', label: 'Command Center', icon: 'ti-layout-dashboard' },
  { key: 'queue', label: 'Action Queue', icon: 'ti-list-check' },
  { key: 'growth', label: 'Growth & Decline', icon: 'ti-trending-up' },
  { key: 'arpu', label: 'ARPU & Monetization', icon: 'ti-coin' },
  { key: 'explorer', label: 'Outlet Explorer', icon: 'ti-building-store' },
  { key: 'trend', label: 'Daily Trend', icon: 'ti-chart-line' },
  { key: 'dq', label: 'Data Quality', icon: 'ti-database-cog' },
];

/* ─── Format helpers ─── */
function fmtN(v) { const n = Number(v); return (v === null || v === undefined || !Number.isFinite(n)) ? '-' : n.toLocaleString('id-ID'); }
function fmtRp(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n); const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}Rp ${(abs / 1e9).toFixed(1)}M`;
  if (abs >= 1e6) return `${sign}Rp ${(abs / 1e6).toFixed(1)}jt`;
  if (abs >= 1e3) return `${sign}Rp ${(abs / 1e3).toFixed(0)}rb`;
  return `${sign}Rp ${Math.round(abs)}`;
}
function fmtRpFull(v) { const n = Number(v); return (v === null || v === undefined || !Number.isFinite(n)) ? '-' : `Rp ${Math.round(n).toLocaleString('id-ID')}`; }
function fmtPct(v, digits = 1) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '-';
  const pct = Math.abs(n) <= 1.5 ? n * 100 : n;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}
function fmtDateTime(v) {
  if (!v) return 'Belum ada data';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function csvEscape(v) { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function downloadCsv(filename, headers, rows) {
  const lines = [headers.join(',')].concat(rows.map(r => headers.map(h => csvEscape(r[h])).join(',')));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ─── Metadata presentasi (frontend-only, tidak ada logic bisnis) ─── */
const STATUS_META = {
  churned:          { label: 'Churned',          color: '#9CA3AF', bg: '#F3F4F6' },
  new_active:       { label: 'Baru Aktif',       color: '#2563EB', bg: '#DBEAFE' },
  critical_decline: { label: 'Critical Decline', color: '#991B1B', bg: '#FEE2E2' },
  declining:        { label: 'Declining',        color: '#DC2626', bg: '#FEE2E2' },
  rocket_growth:    { label: 'Rocket Growth',    color: '#7C3AED', bg: '#EDE9FE' },
  growing:          { label: 'Growing',          color: '#059669', bg: '#DCFCE7' },
  stable:           { label: 'Stable',           color: '#3B82F6', bg: '#DBEAFE' },
  zero_activity:    { label: 'Zero Activity',    color: '#6B7280', bg: '#F3F4F6' },
  unknown:          { label: 'Unknown',          color: '#6B7280', bg: '#F3F4F6' },
};
function statusMeta(s) { return STATUS_META[s] || STATUS_META.unknown; }
const PRIORITY_META = {
  P0: { label: 'Hubungi Hari Ini', color: '#DC2626' },
  P1: { label: 'Follow-up Cepat',  color: '#F59E0B' },
  P2: { label: 'Optimasi',         color: '#059669' },
  P3: { label: 'Maintain',         color: '#6B7280' },
};
function priorityMeta(p) { return PRIORITY_META[p] || { label: p || '-', color: '#9CA3AF' }; }
const ARPU_LAYER_COLOR = { 'Top ARPU': '#7C3AED', 'High ARPU': '#F59E0B', 'Mid ARPU': '#3B82F6', 'Low ARPU': '#9CA3AF' };
const FOLLOWUP_STATUSES = ['OPEN', 'CONTACTED', 'WAITING_RESPONSE', 'ACTION_PLANNED', 'RECOVERED', 'CLOSED'];

/* ─── UI atoms ─── */
function KPICard({ label, value, sub, alert }) {
  return (
    <div className={'farm-cc-kpi-card' + (alert ? ' farm-cc-kpi-card--alert' : '')}>
      <div className="farm-cc-kpi-label">{label}</div>
      <div className="farm-cc-kpi-value">{value}</div>
      {sub && <div className="farm-cc-kpi-sub">{sub}</div>}
    </div>
  );
}
function StatusBadge({ status }) { const m = statusMeta(status); return <span className="farm-cc-status-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>; }
function PriorityChip({ priority }) { const pm = priorityMeta(priority); return <span className="farm-cc-priority-chip" style={{ background: pm.color }} title={pm.label}>{priority || '-'}</span>; }
function SortableTh({ label, sortKey, sort, onSort, style }) {
  const active = sort.key === sortKey;
  const icon = active ? (sort.dir === 'asc' ? 'ti-sort-ascending' : 'ti-sort-descending') : 'ti-arrows-sort';
  return (
    <th className={'farm-cc-sort-th' + (active ? ' farm-cc-sort-th--active' : '')} onClick={() => onSort(sortKey)} style={style}>
      <span>{label}</span> <i className={`ti ${icon}`} aria-hidden="true" />
    </th>
  );
}
function Pagination({ page, pageSize, total, onPage, onPageSize, pageSizeOptions }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="farm-cc-pagination">
      <button disabled={page <= 1} onClick={() => onPage(Math.max(1, page - 1))}>Sebelumnya</button>
      <span>Halaman {page} dari {totalPages} ({fmtN(total)} outlet)</span>
      <button disabled={page >= totalPages} onClick={() => onPage(Math.min(totalPages, page + 1))}>Berikutnya</button>
      <select className="farm-cc-select farm-cc-select-sm" value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>
        {pageSizeOptions.map(sz => <option key={sz} value={sz}>{sz} / halaman</option>)}
      </select>
    </div>
  );
}
function HBarChart({ id, labels, values, colors, formatFn }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: colors || COLOR, borderRadius: 3 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => formatFn ? formatFn(ctx.parsed.x) : fmtN(ctx.parsed.x) } } },
        scales: { x: { grid: { color: 'rgba(128,128,128,.15)' } }, y: { ticks: { font: { size: 11 } } } },
      },
    });
    return () => chart.destroy();
  }, [id, JSON.stringify(labels), JSON.stringify(values)]);
  return <canvas key={id} ref={ref} />;
}
function LineChart({ id, labels, datasets }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'line',
      data: { labels, datasets: datasets.map(d => ({ ...d, tension: 0.3, borderWidth: 2, pointRadius: 2 })) },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
        scales: { y: { grid: { color: 'rgba(128,128,128,.15)' } }, x: { grid: { display: false } } },
      },
    });
    return () => chart.destroy();
  }, [id, JSON.stringify(labels)]);
  return <canvas key={id} ref={ref} />;
}
function ScatterChart({ id, points }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = new Chart(ref.current, {
      type: 'scatter',
      data: { datasets: [{ label: 'Outlet', data: points, backgroundColor: 'rgba(16,185,129,.55)' }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => `${ctx.raw.label}: Dev TRX ${fmtN(ctx.raw.x)}, Dev Rev ${fmtRp(ctx.raw.y)}` } },
        },
        scales: {
          x: { title: { display: true, text: 'Dev TRX' }, grid: { color: 'rgba(128,128,128,.15)' } },
          y: { title: { display: true, text: 'Dev Revenue' }, grid: { color: 'rgba(128,128,128,.15)' } },
        },
      },
    });
    return () => chart.destroy();
  }, [id, JSON.stringify(points)]);
  return <canvas key={id} ref={ref} />;
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 1 — Command Center
   ═══════════════════════════════════════════════════════════════════════ */
function CommandCenterTab({ analytics, onOpenDetail }) {
  const s = analytics?.summary || {};
  const meta = analytics?.meta || {};
  const labels = meta.labels || {};
  const priorityCounts = analytics?.priority_counts || {};
  const statusCounts = analytics?.status_counts || {};
  const arpuDist = analytics?.arpu_distribution || [];
  const topDecline = (analytics?.top_decline || []).slice(0, 10);
  const topGrowth = (analytics?.top_growth || []).slice(0, 10);
  const scatterPoints = (analytics?.top_decline || []).concat(analytics?.top_growth || [])
    .map(r => ({ x: Number(r.calculated_dev_trx) || 0, y: Number(r.calculated_dev_revenue) || 0, label: r.id_outlet }));
  const actionPreview = analytics?.action_queue_preview || [];
  const insights = analytics?.insights || [];

  return (
    <>
      <div className="farm-cc-kpi-grid">
        <KPICard label="Total Outlet Farming" value={fmtN(s.total_outlet_farming)} />
        <KPICard label="Outlet Aktif Periode Ini" value={fmtN(s.outlet_aktif_current)} />
        <KPICard label="Total TRX Periode Ini" value={fmtN(s.total_trx_current)} />
        <KPICard label="Total Revenue Periode Ini" value={fmtRp(s.total_revenue_current)} />
        <KPICard label="Deviasi TRX" value={fmtN(s.dev_trx)} sub={fmtPct(s.dev_trx_pct)} alert={(s.dev_trx || 0) < 0} />
        <KPICard label="Deviasi Revenue" value={fmtRp(s.dev_revenue)} sub={fmtPct(s.dev_revenue_pct)} alert={(s.dev_revenue || 0) < 0} />
        <KPICard label="Revenue at Risk" value={fmtRp(s.revenue_at_risk)} alert={(s.revenue_at_risk || 0) > 0} />
        <KPICard label="Outlet P0" value={fmtN(s.outlet_p0_count)} alert={(s.outlet_p0_count || 0) > 0} />
        <KPICard label="High/Top ARPU at Risk" value={fmtN(s.high_top_arpu_at_risk_count)} alert={(s.high_top_arpu_at_risk_count || 0) > 0} />
        <KPICard label="Volume No Revenue" value={fmtN(s.volume_no_revenue_count)} alert={(s.volume_no_revenue_count || 0) > 0} />
      </div>

      <div className="farm-cc-panel">
        <div className="farm-cc-panel-title"><i className="ti ti-chart-pie" style={{ color: COLOR }} /> Distribusi Priority & ARPU</div>
        <div className="farm-cc-chart-grid-2">
          <div>
            <div className="farm-cc-chart-subtitle">Priority Distribution</div>
            <div className="farm-cc-chart-box-sm">
              <HBarChart id="priority-dist" labels={Object.keys(priorityCounts)} values={Object.values(priorityCounts)}
                colors={Object.keys(priorityCounts).map(k => priorityMeta(k).color)} />
            </div>
          </div>
          <div>
            <div className="farm-cc-chart-subtitle">ARPU Layer Distribution (jml outlet)</div>
            <div className="farm-cc-chart-box-sm">
              <HBarChart id="arpu-dist" labels={arpuDist.map(a => a.layer_arpu)} values={arpuDist.map(a => a.outlet_count)}
                colors={arpuDist.map(a => ARPU_LAYER_COLOR[a.layer_arpu] || '#9CA3AF')} />
            </div>
          </div>
        </div>
      </div>

      <div className="farm-cc-panel">
        <div className="farm-cc-panel-title"><i className="ti ti-arrows-diff" style={{ color: COLOR }} /> Top Revenue Movement</div>
        <div className="farm-cc-chart-grid-2">
          <div>
            <div className="farm-cc-chart-subtitle">Top Revenue Decline</div>
            <div className="farm-cc-chart-box">
              <HBarChart id="top-decline" labels={topDecline.map(r => r.id_outlet)} values={topDecline.map(r => Number(r.calculated_dev_revenue))} colors="#DC2626" formatFn={fmtRp} />
            </div>
          </div>
          <div>
            <div className="farm-cc-chart-subtitle">Top Revenue Growth</div>
            <div className="farm-cc-chart-box">
              <HBarChart id="top-growth" labels={topGrowth.map(r => r.id_outlet)} values={topGrowth.map(r => Number(r.calculated_dev_revenue))} colors="#059669" formatFn={fmtRp} />
            </div>
          </div>
        </div>
      </div>

      <div className="farm-cc-panel">
        <div className="farm-cc-panel-title"><i className="ti ti-chart-scatter" style={{ color: COLOR }} /> Dev TRX vs Dev Revenue</div>
        <div className="farm-cc-chart-box"><ScatterChart id="dev-scatter" points={scatterPoints} /></div>
      </div>

      <div className="farm-cc-panel">
        <div className="farm-cc-panel-title"><i className="ti ti-flag" style={{ color: COLOR }} /> Top 10 Action Queue</div>
        <table className="farm-cc-table">
          <thead><tr><th>Priority</th><th>ID Outlet</th><th>Layer ARPU</th><th>Status</th><th>Dev Revenue</th><th>Rekomendasi</th></tr></thead>
          <tbody>
            {actionPreview.map(r => (
              <tr key={r.id_outlet} className="farm-cc-clickable-row" onClick={() => onOpenDetail(r.id_outlet)}>
                <td><PriorityChip priority={r.priority} /></td>
                <td>{r.id_outlet}</td>
                <td>{r.layer_arpu || '-'}</td>
                <td><StatusBadge status={r.status} /></td>
                <td style={{ color: (r.calculated_dev_revenue || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtRp(r.calculated_dev_revenue)}</td>
                <td className="farm-cc-reco-cell">{r.recommended_action || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="farm-cc-panel">
        <div className="farm-cc-panel-title"><i className="ti ti-bulb" style={{ color: COLOR }} /> Automated Insights</div>
        <ul className="farm-cc-insight-list">{insights.map((t, i) => <li key={i}><span className="farm-cc-insight-dot" />{t}</li>)}</ul>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 2 — Action Queue
   ═══════════════════════════════════════════════════════════════════════ */
function ActionQueueTab({ snapshotDate, meta, onOpenDetail }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ priority: 'semua', layer_arpu: 'semua', status: 'semua', segment: 'semua', anomaly: 'semua', search: '' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    setLoading(true);
    const params = { snapshot_date: snapshotDate, page, limit: pageSize };
    Object.entries(filters).forEach(([k, v]) => { if (v && v !== 'semua') params[k] = v; });
    getFarmingActionQueue(params).then(res => { setRows(res.rows || []); setTotal(res.total || 0); }).finally(() => setLoading(false));
  }, [snapshotDate, filters, page, pageSize]);

  useEffect(() => { setPage(1); }, [filters]);

  const exportCsv = () => downloadCsv('farming-action-queue.csv',
    ['id_outlet', 'layer_arpu', 'status', 'segment', 'priority', 'previous_period_trx', 'current_period_trx', 'calculated_dev_trx', 'previous_period_revenue', 'current_period_revenue', 'calculated_dev_revenue', 'recommended_action'],
    rows);

  return (
    <>
      <div className="farm-cc-toolbar">
        <input className="farm-cc-input" placeholder="Cari outlet..." value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
        <select className="farm-cc-select" value={filters.priority} onChange={e => setFilters(f => ({ ...f, priority: e.target.value }))}>
          <option value="semua">Semua Priority</option>
          {Object.keys(PRIORITY_META).map(p => <option key={p} value={p}>{p} — {PRIORITY_META[p].label}</option>)}
        </select>
        <select className="farm-cc-select" value={filters.layer_arpu} onChange={e => setFilters(f => ({ ...f, layer_arpu: e.target.value }))}>
          <option value="semua">Semua Layer ARPU</option>
          {Object.keys(ARPU_LAYER_COLOR).map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <select className="farm-cc-select" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
          <option value="semua">Semua Status</option>
          {Object.keys(STATUS_META).map(k => <option key={k} value={k}>{STATUS_META[k].label}</option>)}
        </select>
        <select className="farm-cc-select" value={filters.anomaly} onChange={e => setFilters(f => ({ ...f, anomaly: e.target.value }))}>
          <option value="semua">Semua Anomali</option>
          <option value="volume_no_revenue">Volume No Revenue</option>
        </select>
        <button className="farm-cc-btn farm-cc-btn--primary" onClick={exportCsv}><i className="ti ti-download" /> Export CSV</button>
      </div>

      <div className="farm-cc-table-wrap">
        <table className="farm-cc-table">
          <thead>
            <tr>
              <th>Priority</th><th>ID Outlet</th><th>Layer ARPU</th><th>Status</th><th>Segment</th>
              <th>{`TRX ${meta?.labels?.previous_period || 'Previous'}`}</th>
              <th>{`TRX ${meta?.labels?.current_period || 'Current'}`}</th>
              <th>Dev TRX</th>
              <th>{`Rev ${meta?.labels?.previous_period || 'Previous'}`}</th>
              <th>{`Rev ${meta?.labels?.current_period || 'Current'}`}</th>
              <th>Dev Rev</th><th>Revenue at Risk</th><th>Reason</th><th>Rekomendasi</th><th>Follow-up</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={15} className="farm-cc-empty-sub">Memuat...</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={15} className="farm-cc-empty-sub">Tidak ada outlet yang cocok dengan filter.</td></tr>}
            {!loading && rows.map(r => (
              <tr key={r.id_outlet}>
                <td><PriorityChip priority={r.priority} /></td>
                <td><button className="farm-cc-link-btn" onClick={() => onOpenDetail(r.id_outlet)}>{r.id_outlet}</button></td>
                <td>{r.layer_arpu || '-'}</td>
                <td><StatusBadge status={r.status} /></td>
                <td>{r.segment}</td>
                <td>{fmtN(r.previous_period_trx)}</td>
                <td>{fmtN(r.current_period_trx)}</td>
                <td style={{ color: (r.calculated_dev_trx || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtN(r.calculated_dev_trx)}</td>
                <td>{fmtRp(r.previous_period_revenue)}</td>
                <td>{fmtRp(r.current_period_revenue)}</td>
                <td style={{ color: (r.calculated_dev_revenue || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtRp(r.calculated_dev_revenue)}</td>
                <td>{fmtRp((r.previous_period_revenue || 0) - (r.current_period_revenue || 0) > 0 && ['declining', 'critical_decline', 'churned'].includes(r.status) ? (r.previous_period_revenue - r.current_period_revenue) : 0)}</td>
                <td className="farm-cc-reason-cell">{Array.isArray(r.reason_codes) ? r.reason_codes.join(', ') : (r.reason_codes ? JSON.parse(r.reason_codes).join(', ') : '-')}</td>
                <td className="farm-cc-reco-cell">{r.recommended_action}</td>
                <td>{r.followup_status ? <span className="farm-cc-followup-chip">{r.followup_status}</span> : <span className="farm-cc-empty-sub">-</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} pageSizeOptions={[25, 50, 100, 200]} />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 3 — Growth & Decline
   ═══════════════════════════════════════════════════════════════════════ */
const QUADRANT_LABEL = {
  healthy_growth: { label: 'Healthy Growth', desc: 'TRX naik + Revenue naik', color: '#059669' },
  monetization_problem: { label: 'Monetization Problem', desc: 'TRX naik + Revenue turun', color: '#F59E0B' },
  better_yield: { label: 'Better Yield', desc: 'TRX turun + Revenue naik', color: '#3B82F6' },
  rescue_required: { label: 'Rescue Required', desc: 'TRX turun + Revenue turun', color: '#DC2626' },
};
function quadrantOf(devTrx, devRevenue) {
  if (devTrx >= 0 && devRevenue >= 0) return 'healthy_growth';
  if (devTrx >= 0 && devRevenue < 0) return 'monetization_problem';
  if (devTrx < 0 && devRevenue >= 0) return 'better_yield';
  return 'rescue_required';
}

function GrowthDeclineTab({ analytics, onOpenDetail }) {
  const [filter, setFilter] = useState('semua');
  const topGrowth = analytics?.top_growth || [];
  const topDecline = analytics?.top_decline || [];
  const statusCounts = analytics?.status_counts || {};
  const allRows = useMemo(() => [...topGrowth, ...topDecline].map(r => ({ ...r, quadrant: quadrantOf(Number(r.calculated_dev_trx) || 0, Number(r.calculated_dev_revenue) || 0) })), [topGrowth, topDecline]);
  const filtered = filter === 'semua' ? allRows : allRows.filter(r => r.quadrant === filter);

  return (
    <>
      <div className="farm-cc-panel">
        <div className="farm-cc-panel-title"><i className="ti ti-grid-dots" style={{ color: COLOR }} /> Kuadran Growth & Decline</div>
        <div className="farm-cc-quadrant-grid">
          {Object.entries(QUADRANT_LABEL).map(([key, q]) => (
            <button key={key} className={'farm-cc-quadrant-card' + (filter === key ? ' farm-cc-quadrant-card--active' : '')}
              style={{ borderColor: q.color }} onClick={() => setFilter(filter === key ? 'semua' : key)}>
              <div className="farm-cc-quadrant-title" style={{ color: q.color }}>{q.label}</div>
              <div className="farm-cc-quadrant-desc">{q.desc}</div>
              <div className="farm-cc-quadrant-count">{allRows.filter(r => r.quadrant === key).length} outlet (top list)</div>
            </button>
          ))}
        </div>
      </div>

      <div className="farm-cc-panel">
        <div className="farm-cc-panel-title"><i className="ti ti-chart-bar" style={{ color: COLOR }} /> Status Distribution</div>
        <div className="farm-cc-chart-box">
          <HBarChart id="status-dist" labels={Object.keys(statusCounts).map(k => statusMeta(k).label)} values={Object.values(statusCounts)}
            colors={Object.keys(statusCounts).map(k => statusMeta(k).color)} />
        </div>
      </div>

      <div className="farm-cc-table-wrap">
        <table className="farm-cc-table">
          <thead><tr><th>ID Outlet</th><th>Layer ARPU</th><th>Dev TRX</th><th>Dev Revenue</th><th>Kuadran</th><th>Status</th></tr></thead>
          <tbody>
            {filtered.length === 0 && <tr><td colSpan={6} className="farm-cc-empty-sub">Tidak ada data.</td></tr>}
            {filtered.map(r => (
              <tr key={r.id_outlet} className="farm-cc-clickable-row" onClick={() => onOpenDetail(r.id_outlet)}>
                <td>{r.id_outlet}</td>
                <td>{r.layer_arpu || '-'}</td>
                <td style={{ color: (r.calculated_dev_trx || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtN(r.calculated_dev_trx)}</td>
                <td style={{ color: (r.calculated_dev_revenue || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtRp(r.calculated_dev_revenue)}</td>
                <td><span style={{ color: QUADRANT_LABEL[r.quadrant].color, fontWeight: 700 }}>{QUADRANT_LABEL[r.quadrant].label}</span></td>
                <td><StatusBadge status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 4 — ARPU & Monetization
   ═══════════════════════════════════════════════════════════════════════ */
function ArpuTab({ analytics }) {
  const arpuDist = analytics?.arpu_distribution || [];
  const totalRevenue = arpuDist.reduce((s, a) => s + (a.current_revenue || 0), 0);
  const totalTrx = arpuDist.reduce((s, a) => s + (a.current_trx || 0), 0);

  return (
    <>
      <div className="farm-cc-kpi-grid">
        {arpuDist.map(a => (
          <KPICard key={a.layer_arpu} label={a.layer_arpu} value={`${fmtN(a.outlet_count)} outlet`}
            sub={`Rev: ${fmtRp(a.current_revenue)} · TRX: ${fmtN(a.current_trx)}`} alert={a.at_risk_count > 0} />
        ))}
      </div>

      <div className="farm-cc-table-wrap">
        <table className="farm-cc-table">
          <thead><tr><th>Layer ARPU</th><th>Jml Outlet</th><th>Kontribusi Revenue</th><th>% Revenue</th><th>Kontribusi TRX</th><th>% TRX</th><th>ARPT</th><th>At Risk</th></tr></thead>
          <tbody>
            {arpuDist.map(a => (
              <tr key={a.layer_arpu}>
                <td><span style={{ color: ARPU_LAYER_COLOR[a.layer_arpu] || '#6B7280', fontWeight: 700 }}>{a.layer_arpu}</span></td>
                <td>{fmtN(a.outlet_count)}</td>
                <td>{fmtRp(a.current_revenue)}</td>
                <td>{fmtPct(totalRevenue > 0 ? a.current_revenue / totalRevenue : null)}</td>
                <td>{fmtN(a.current_trx)}</td>
                <td>{fmtPct(totalTrx > 0 ? a.current_trx / totalTrx : null)}</td>
                <td>{fmtRp(a.current_trx > 0 ? a.current_revenue / a.current_trx : null)}</td>
                <td style={{ color: a.at_risk_count > 0 ? '#DC2626' : 'inherit' }}>{fmtN(a.at_risk_count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="farm-cc-info-banner">
        <i className="ti ti-info-circle" />
        <div>High/Top ARPU At Risk & Upgrade Opportunity (Low/Mid ARPU bertumbuh) bisa dilihat lengkap di tab Action Queue dengan filter Layer ARPU + Segment.</div>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 5 — Outlet Explorer
   ═══════════════════════════════════════════════════════════════════════ */
function ExplorerTab({ snapshotDate, meta, onOpenDetail }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'current_period_revenue', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    setLoading(true);
    getFarmingOutlets({ snapshot_date: snapshotDate, page, limit: pageSize, search, sort: sort.key, order: sort.dir })
      .then(res => { setRows(res.rows || []); setTotal(res.total || 0); }).finally(() => setLoading(false));
  }, [snapshotDate, search, sort, page, pageSize]);

  useEffect(() => { setPage(1); }, [search]);
  const handleSort = (key) => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  const baseLabel = meta?.labels?.baseline_full || 'Baseline';
  const prevLabel = meta?.labels?.previous_period || 'Previous';
  const curLabel = meta?.labels?.current_period || 'Current';

  return (
    <>
      <div className="farm-cc-toolbar">
        <input className="farm-cc-input" placeholder="Cari ID Outlet..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="farm-cc-table-wrap">
        <table className="farm-cc-table">
          <thead>
            <tr>
              <th>ID Outlet</th><th>Layer ARPU</th>
              <th>{`TRX ${baseLabel}`}</th><th>{`Rev ${baseLabel}`}</th>
              <th>{`TRX ${prevLabel}`}</th><th>{`Rev ${prevLabel}`}</th>
              <SortableTh label={`TRX ${curLabel}`} sortKey="current_period_trx" sort={sort} onSort={handleSort} />
              <SortableTh label={`Rev ${curLabel}`} sortKey="current_period_revenue" sort={sort} onSort={handleSort} />
              <SortableTh label="Dev TRX" sortKey="calculated_dev_trx" sort={sort} onSort={handleSort} />
              <SortableTh label="Dev Rev" sortKey="calculated_dev_revenue" sort={sort} onSort={handleSort} />
              <th>ARPT Previous</th><th>ARPT Current</th><th>Status</th><th>Priority</th><th>Segment</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={15} className="farm-cc-empty-sub">Memuat...</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={15} className="farm-cc-empty-sub">Tidak ada outlet.</td></tr>}
            {!loading && rows.map(r => (
              <tr key={r.id_outlet}>
                <td><button className="farm-cc-link-btn" onClick={() => onOpenDetail(r.id_outlet)}>{r.id_outlet}</button></td>
                <td>{r.layer_arpu || '-'}</td>
                <td>{fmtN(r.baseline_full_trx)}</td>
                <td>{fmtRp(r.baseline_full_revenue)}</td>
                <td>{fmtN(r.previous_period_trx)}</td>
                <td>{fmtRp(r.previous_period_revenue)}</td>
                <td>{fmtN(r.current_period_trx)}</td>
                <td>{fmtRp(r.current_period_revenue)}</td>
                <td style={{ color: (r.calculated_dev_trx || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtN(r.calculated_dev_trx)}</td>
                <td style={{ color: (r.calculated_dev_revenue || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtRp(r.calculated_dev_revenue)}</td>
                <td>{fmtRp(r.previous_arpt)}</td>
                <td>{fmtRp(r.current_arpt)}</td>
                <td><StatusBadge status={r.status} /></td>
                <td><PriorityChip priority={r.priority} /></td>
                <td>{r.segment}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} pageSizeOptions={[25, 50, 100, 200]} />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 6 — Daily Trend
   ═══════════════════════════════════════════════════════════════════════ */
function TrendTab() {
  const [trend, setTrend] = useState(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getFarmingTrendline({ days }).then(setTrend).finally(() => setLoading(false));
  }, [days]);

  const daily = trend?.daily || [];
  const labels = daily.map(d => d.snapshot_date);

  return (
    <>
      <div className="farm-cc-toolbar">
        <select className="farm-cc-select" value={days} onChange={e => setDays(Number(e.target.value))}>
          <option value={14}>14 hari terakhir</option>
          <option value={30}>30 hari terakhir</option>
          <option value={60}>60 hari terakhir</option>
          <option value={90}>90 hari terakhir</option>
        </select>
      </div>
      {loading && <div className="farm-cc-loading"><i className="ti ti-loader-2 farm-cc-spin" /> Memuat tren...</div>}
      {!loading && !daily.length && <div className="farm-cc-empty-sub">Belum cukup histori snapshot untuk tren harian.</div>}
      {!loading && daily.length > 0 && (
        <>
          <div className="farm-cc-panel">
            <div className="farm-cc-panel-title"><i className="ti ti-chart-line" style={{ color: COLOR }} /> TRX & Revenue Harian</div>
            <div className="farm-cc-chart-box">
              <LineChart id="trend-trx-rev" labels={labels} datasets={[
                { label: 'Total TRX Current Period', data: daily.map(d => d.total_current_trx), borderColor: '#3B82F6', backgroundColor: 'rgba(59,130,246,.15)' },
              ]} />
            </div>
          </div>
          <div className="farm-cc-panel">
            <div className="farm-cc-panel-title"><i className="ti ti-alert-triangle" style={{ color: COLOR }} /> Revenue at Risk & P0 Trend</div>
            <div className="farm-cc-chart-box">
              <LineChart id="trend-risk" labels={labels} datasets={[
                { label: 'Revenue at Risk', data: daily.map(d => d.revenue_at_risk), borderColor: '#DC2626', backgroundColor: 'rgba(220,38,38,.15)', yAxisID: 'y' },
              ]} />
            </div>
          </div>
          <div className="farm-cc-panel">
            <div className="farm-cc-panel-title"><i className="ti ti-list-check" style={{ color: COLOR }} /> Jumlah P0 / Declining / Anomali</div>
            <div className="farm-cc-chart-box">
              <LineChart id="trend-counts" labels={labels} datasets={[
                { label: 'P0', data: daily.map(d => d.p0_count), borderColor: '#DC2626', backgroundColor: 'rgba(220,38,38,.1)' },
                { label: 'Declining', data: daily.map(d => d.declining_count), borderColor: '#F59E0B', backgroundColor: 'rgba(245,158,11,.1)' },
                { label: 'Anomali', data: daily.map(d => d.anomaly_count), borderColor: '#7C3AED', backgroundColor: 'rgba(124,58,237,.1)' },
              ]} />
            </div>
          </div>
        </>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 7 — Data Quality
   ═══════════════════════════════════════════════════════════════════════ */
function DataQualityTab({ dq }) {
  if (!dq) return <div className="farm-cc-empty-sub">Memuat...</div>;
  const checks = [
    { label: 'Baris diterima (sync terakhir)', value: fmtN(dq.rows_received) },
    { label: 'Baris valid', value: fmtN(dq.rows_valid) },
    { label: 'Baris di-skip (ID Outlet kosong)', value: fmtN(dq.rows_skipped), alert: (dq.rows_skipped || 0) > 0 },
    { label: 'Duplicate ID Outlet', value: fmtN(dq.duplicate_outlet_count), alert: (dq.duplicate_outlet_count || 0) > 0 },
    { label: 'Unknown Layer ARPU', value: fmtN(dq.unknown_layer_arpu_count), alert: (dq.unknown_layer_arpu_count || 0) > 0 },
    { label: 'Malformed Numeric', value: fmtN(dq.malformed_numeric_count), alert: (dq.malformed_numeric_count || 0) > 0 },
    { label: 'Dev TRX Mismatch (sheet vs calculated)', value: fmtN(dq.dev_trx_mismatch_count), alert: (dq.dev_trx_mismatch_count || 0) > 0 },
    { label: 'Dev Revenue Mismatch (sheet vs calculated)', value: fmtN(dq.dev_revenue_mismatch_count), alert: (dq.dev_revenue_mismatch_count || 0) > 0 },
  ];
  return (
    <>
      <div className="farm-cc-badge-row">
        <span className="farm-cc-badge farm-cc-badge--sync"><i className="ti ti-refresh" /> Sync terakhir: {fmtDateTime(dq.last_sync)}</span>
        <span className="farm-cc-badge farm-cc-badge--info">Status: {dq.sync_status || '-'}</span>
      </div>

      <div className="farm-cc-dq-grid">
        {checks.map(c => (
          <div key={c.label} className={'farm-cc-dq-card' + (c.alert ? ' farm-cc-dq-card--alert' : '')}>
            <div className="farm-cc-dq-value">{c.value}</div>
            <div className="farm-cc-dq-label">{c.label}</div>
          </div>
        ))}
      </div>

      {(dq.parse_warnings || []).length > 0 && (
        <div className="farm-cc-panel">
          <div className="farm-cc-panel-title"><i className="ti ti-alert-triangle" style={{ color: '#F59E0B' }} /> Parse Warnings</div>
          <ul className="farm-cc-simple-list">{dq.parse_warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}

      <div className="farm-cc-panel">
        <div className="farm-cc-panel-title"><i className="ti ti-history" style={{ color: COLOR }} /> Sync History (20 terakhir)</div>
        <table className="farm-cc-table">
          <thead><tr><th>Waktu</th><th>Status</th><th>Diterima</th><th>Valid</th><th>Skip</th><th>Insert</th><th>Update</th></tr></thead>
          <tbody>
            {(dq.sync_history || []).map(h => (
              <tr key={h.sync_batch_id}>
                <td>{fmtDateTime(h.synced_at)}</td>
                <td>{h.status}</td>
                <td>{fmtN(h.rows_received)}</td>
                <td>{fmtN(h.rows_valid)}</td>
                <td>{fmtN(h.rows_skipped)}</td>
                <td>{fmtN(h.rows_inserted)}</td>
                <td>{fmtN(h.rows_updated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="farm-cc-panel">
        <div className="farm-cc-panel-title"><i className="ti ti-code" style={{ color: COLOR }} /> Header Asli Sheet (Audit)</div>
        <pre className="farm-cc-raw-headers">{JSON.stringify(dq.original_headers || [], null, 2)}</pre>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Outlet Detail Drawer
   ═══════════════════════════════════════════════════════════════════════ */
function OutletDetailDrawer({ idOutlet, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [followupForm, setFollowupForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!idOutlet) return;
    setLoading(true);
    getFarmingOutletDetail(idOutlet).then(d => {
      setDetail(d);
      setFollowupForm(d?.followup || { id_outlet: idOutlet, pic: '', is_contacted: false, followup_status: 'OPEN', followup_date: '', notes: '' });
    }).finally(() => setLoading(false));
  }, [idOutlet]);

  if (!idOutlet) return null;

  const saveFollowup = () => {
    setSaving(true);
    upsertFarmingFollowup({ ...followupForm, id_outlet: idOutlet })
      .then(res => setFollowupForm(res))
      .finally(() => setSaving(false));
  };

  return (
    <div className="farm-cc-drawer-overlay" onClick={onClose}>
      <div className="farm-cc-drawer" onClick={e => e.stopPropagation()}>
        <div className="farm-cc-drawer-header">
          <div className="farm-cc-drawer-title"><i className="ti ti-building-store" /> {idOutlet}</div>
          <button className="farm-cc-drawer-close" onClick={onClose}><i className="ti ti-x" /></button>
        </div>
        <div className="farm-cc-drawer-body">
          {loading && <div className="farm-cc-loading"><i className="ti ti-loader-2 farm-cc-spin" /> Memuat...</div>}
          {!loading && detail?.empty && <div className="farm-cc-empty-sub">{detail.message}</div>}
          {!loading && detail && !detail.empty && (
            <>
              <div className="farm-cc-drawer-summary">
                <div><span>Layer ARPU</span><b>{detail.outlet.layer_arpu || '-'}</b></div>
                <div><span>Status</span><StatusBadge status={detail.outlet.status} /></div>
                <div><span>Priority</span><PriorityChip priority={detail.outlet.priority} /></div>
                <div><span>Segment</span><b>{detail.outlet.segment}</b></div>
              </div>

              <div className="farm-cc-drawer-section-title">Perbandingan Periode</div>
              <table className="farm-cc-table">
                <thead><tr><th></th><th>TRX</th><th>Revenue</th><th>ARPT</th></tr></thead>
                <tbody>
                  <tr><td>Baseline Full</td><td>{fmtN(detail.latest_snapshot.baseline_full_trx)}</td><td>{fmtRpFull(detail.latest_snapshot.baseline_full_revenue)}</td><td>-</td></tr>
                  <tr><td>Previous Period</td><td>{fmtN(detail.latest_snapshot.previous_period_trx)}</td><td>{fmtRpFull(detail.latest_snapshot.previous_period_revenue)}</td><td>{fmtRpFull(detail.latest_snapshot.previous_arpt)}</td></tr>
                  <tr><td>Current Period</td><td>{fmtN(detail.latest_snapshot.current_period_trx)}</td><td>{fmtRpFull(detail.latest_snapshot.current_period_revenue)}</td><td>{fmtRpFull(detail.latest_snapshot.current_arpt)}</td></tr>
                </tbody>
              </table>

              <div className="farm-cc-drawer-section-title">Histori Snapshot ({detail.history.length} hari)</div>
              <div className="farm-cc-chart-box-sm">
                <LineChart id={`detail-history-${idOutlet}`} labels={detail.history.map(h => String(h.snapshot_date).slice(0, 10))}
                  datasets={[{ label: 'Revenue Current Period', data: detail.history.map(h => h.current_period_revenue), borderColor: COLOR, backgroundColor: 'rgba(16,185,129,.15)' }]} />
              </div>

              <div className="farm-cc-drawer-section-title">Follow-up Operasional</div>
              <div className="farm-cc-followup-form">
                <label>PIC<input className="farm-cc-input" value={followupForm.pic || ''} onChange={e => setFollowupForm(f => ({ ...f, pic: e.target.value }))} /></label>
                <label>Status
                  <select className="farm-cc-select" value={followupForm.followup_status || 'OPEN'} onChange={e => setFollowupForm(f => ({ ...f, followup_status: e.target.value }))}>
                    {FOLLOWUP_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <label>Tanggal Follow-up<input type="date" className="farm-cc-input" value={followupForm.followup_date ? String(followupForm.followup_date).slice(0, 10) : ''} onChange={e => setFollowupForm(f => ({ ...f, followup_date: e.target.value }))} /></label>
                <label className="farm-cc-checkbox-label"><input type="checkbox" checked={!!followupForm.is_contacted} onChange={e => setFollowupForm(f => ({ ...f, is_contacted: e.target.checked }))} /> Sudah dihubungi</label>
                <label>Catatan<textarea className="farm-cc-input" rows={3} value={followupForm.notes || ''} onChange={e => setFollowupForm(f => ({ ...f, notes: e.target.value }))} /></label>
                <button className="farm-cc-btn farm-cc-btn--primary" disabled={saving} onClick={saveFollowup}>{saving ? 'Menyimpan...' : 'Simpan Follow-up'}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   PAGE
   ═══════════════════════════════════════════════════════════════════════ */
export default function WarRoomFarming() {
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotDate, setSnapshotDate] = useState('latest');
  const [analytics, setAnalytics] = useState(null);
  const [dataQuality, setDataQuality] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('command');
  const [selectedOutlet, setSelectedOutlet] = useState(null);

  useEffect(() => { getFarmingSnapshots().then(setSnapshots).catch(() => setSnapshots([])); }, []);

  const load = useCallback((sd) => {
    setLoading(true); setError(null);
    Promise.all([getFarmingAnalytics(sd), getFarmingDataQuality({ snapshot_date: sd })])
      .then(([a, dq]) => { setAnalytics(a); setDataQuality(dq); })
      .catch(e => setError(e?.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(snapshotDate); }, [snapshotDate, load]);

  const meta = analytics?.meta;

  return (
    <Layout>
      <div className="farm-cc-page">
        <div className="farm-cc-header">
          <div className="farm-cc-header-left">
            <i className="ti ti-plant-2" style={{ fontSize: 22, color: COLOR }} />
            <div>
              <div className="farm-cc-header-title">Farming Fastpay Command Center</div>
              <div className="farm-cc-header-sub">
                {meta?.labels ? `Perbandingan ${meta.labels.comparison} · Baseline penuh: ${meta.labels.baseline_full}` : 'Daily outlet rescue, revenue recovery, dan ARPU optimization untuk outlet Farming.'}
              </div>
              <div className="farm-cc-header-sync">Terakhir diperbarui: {fmtDateTime(meta?.synced_at)}</div>
            </div>
          </div>
          <div className="farm-cc-header-right">
            <select className="farm-cc-select" value={snapshotDate} onChange={e => setSnapshotDate(e.target.value)}>
              <option value="latest">Terbaru</option>
              {snapshots.map(s => <option key={s.snapshot_date} value={String(s.snapshot_date).slice(0, 10)}>{s.label} ({s.outlet_count} outlet)</option>)}
            </select>
            <button className="farm-cc-btn" onClick={() => load(snapshotDate)}><i className="ti ti-refresh" /> Refresh</button>
            <a className="farm-cc-btn" href="https://docs.google.com/spreadsheets/d/1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw/edit" target="_blank" rel="noreferrer"><i className="ti ti-external-link" /> Sumber Data</a>
          </div>
        </div>

        <div className="farm-cc-tabs">
          {TABS.map(t => (
            <button key={t.key} className={'farm-cc-tab-btn' + (tab === t.key ? ' farm-cc-tab-btn--active' : '')} onClick={() => setTab(t.key)}>
              <i className={`ti ${t.icon}`} /> {t.label}
            </button>
          ))}
        </div>

        {loading && <div className="farm-cc-loading"><i className="ti ti-loader-2 farm-cc-spin" /> Memuat data Farming...</div>}
        {!loading && error && <div className="farm-cc-error"><i className="ti ti-alert-triangle" /> {error}</div>}
        {!loading && !error && analytics?.empty && (
          <div className="farm-cc-empty"><i className="ti ti-mood-empty" /><div>{analytics.message || 'Data Farming belum tersedia. Jalankan sync Google Sheet terlebih dahulu.'}</div></div>
        )}

        {!loading && !error && analytics && !analytics.empty && (
          <>
            {tab === 'command' && <CommandCenterTab analytics={analytics} onOpenDetail={setSelectedOutlet} />}
            {tab === 'queue' && <ActionQueueTab snapshotDate={snapshotDate} meta={meta} onOpenDetail={setSelectedOutlet} />}
            {tab === 'growth' && <GrowthDeclineTab analytics={analytics} onOpenDetail={setSelectedOutlet} />}
            {tab === 'arpu' && <ArpuTab analytics={analytics} />}
            {tab === 'explorer' && <ExplorerTab snapshotDate={snapshotDate} meta={meta} onOpenDetail={setSelectedOutlet} />}
            {tab === 'trend' && <TrendTab />}
            {tab === 'dq' && <DataQualityTab dq={dataQuality} />}
          </>
        )}

        <OutletDetailDrawer idOutlet={selectedOutlet} onClose={() => setSelectedOutlet(null)} />
      </div>
    </Layout>
  );
}
