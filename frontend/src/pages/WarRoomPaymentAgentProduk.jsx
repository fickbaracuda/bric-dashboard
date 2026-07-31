import { useState, useEffect, useMemo, useCallback } from 'react';
import Layout from '../components/Layout';
import {
  getPaymentAgentProdukSnapshots, getPaymentAgentProdukAnalytics, getPaymentAgentProdukDetail,
} from '../services/api';

const COLOR = '#0EA5E9';
const TABS = [
  { key: 'overview', label: 'Overview', icon: 'ti-layout-dashboard' },
  { key: 'ranking', label: 'Product Ranking', icon: 'ti-list-details' },
  { key: 'growth', label: 'Growth & Decline', icon: 'ti-trending-up' },
  { key: 'campaign', label: 'Campaign Priority', icon: 'ti-target-arrow' },
  { key: 'detail', label: 'Product Deep Dive', icon: 'ti-zoom-in' },
  { key: 'dq', label: 'Data Quality', icon: 'ti-database-cog' },
];

/* ─── Format helpers — tidak pernah mengembalikan NaN/Infinity mentah ─── */
function fmtN(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '-';
  return n.toLocaleString('id-ID');
}
function fmtRp(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}Rp ${(abs / 1e9).toFixed(1)}M`;
  if (abs >= 1e6) return `${sign}Rp ${(abs / 1e6).toFixed(1)}jt`;
  if (abs >= 1e3) return `${sign}Rp ${(abs / 1e3).toFixed(0)}rb`;
  return `${sign}Rp ${Math.round(abs)}`;
}
function fmtRpFull(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '-';
  return `Rp ${Math.round(n).toLocaleString('id-ID')}`;
}
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
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(filename, headers, rows) {
  const lines = [headers.join(',')].concat(rows.map(r => headers.map(h => csvEscape(r[h])).join(',')));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ─── Metadata presentasi (frontend-only, tidak ada logic bisnis) ─── */
const STATUS_META = {
  naik:    { label: 'Naik',        color: '#059669', bg: '#DCFCE7' },
  turun:   { label: 'Turun',       color: '#DC2626', bg: '#FEE2E2' },
  stabil:  { label: 'Stabil',      color: '#3B82F6', bg: '#DBEAFE' },
  kritis:  { label: 'Kritis',      color: '#991B1B', bg: '#FEE2E2' },
  no_data: { label: 'Belum Ada Data', color: '#6B7280', bg: '#F3F4F6' },
};
function statusMeta(s) { return STATUS_META[s] || STATUS_META.no_data; }

const PRIORITY_META = {
  P0: { label: 'Selamatkan Revenue',            color: '#DC2626' },
  P1: { label: 'Scale Produk Naik',             color: '#F59E0B' },
  P2: { label: 'Perbaiki Frequency',            color: '#7C3AED' },
  P3: { label: 'Jaga Momentum',                 color: '#059669' },
  P4: { label: 'Data Quality / Low Priority',   color: '#6B7280' },
};
function priorityMeta(p) { return PRIORITY_META[p] || { label: p || '-', color: '#9CA3AF' }; }

const SEVERITY_META = {
  high:   { label: 'Tinggi', color: '#DC2626', bg: '#FEE2E2' },
  medium: { label: 'Sedang', color: '#B45309', bg: '#FEF3C7' },
  low:    { label: 'Rendah', color: '#1D4ED8', bg: '#DBEAFE' },
};
function severityMeta(s) { return SEVERITY_META[s] || SEVERITY_META.low; }

const SEGMENT_OPTIONS = [
  'Core Revenue Driver', 'Growth Product', 'Declining Product', 'High MAT Low Revenue',
  'Low MAT High ARPU', 'Frequency Problem', 'Monetization Problem', 'Low Priority',
];

/* ─── UI atoms ─── */
function KPICard({ label, value, sub, alert }) {
  return (
    <div className={'pa-prod-kpi-card' + (alert ? ' pa-prod-kpi-card--alert' : '')}>
      <div className="pa-prod-kpi-label">{label}</div>
      <div className="pa-prod-kpi-value">{value}</div>
      {sub && <div className="pa-prod-kpi-sub">{sub}</div>}
    </div>
  );
}
function StatusBadge({ status }) {
  const m = statusMeta(status);
  return <span className="pa-prod-status-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}
function PriorityChip({ priority }) {
  const pm = priorityMeta(priority);
  return <span className="pa-prod-priority-chip" style={{ background: pm.color }} title={pm.label}>{priority || '-'}</span>;
}
function GrowthStat({ label, value }) {
  const n = Number(value);
  const known = value !== null && value !== undefined && Number.isFinite(n);
  const color = !known ? 'var(--text-muted)' : (n >= 0 ? '#059669' : '#DC2626');
  return (
    <div className="pa-prod-growth-stat">
      <div className="pa-prod-growth-label">{label}</div>
      <div className="pa-prod-growth-value" style={{ color }}>{known ? fmtPct(n) : 'Belum ada data'}</div>
    </div>
  );
}
function SortableTh({ label, sortKey, sort, onSort, style }) {
  const active = sort.key === sortKey;
  const icon = active ? (sort.dir === 'asc' ? 'ti-sort-ascending' : 'ti-sort-descending') : 'ti-arrows-sort';
  return (
    <th className={'pa-prod-sort-th' + (active ? ' pa-prod-sort-th--active' : '')} onClick={() => onSort(sortKey)} style={style}>
      <span>{label}</span> <i className={`ti ${icon}`} aria-hidden="true" />
    </th>
  );
}
function Pagination({ page, pageSize, total, onPage, onPageSize, pageSizeOptions }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pa-prod-pagination">
      <button disabled={page <= 1} onClick={() => onPage(Math.max(1, page - 1))}>Sebelumnya</button>
      <span>Halaman {page} dari {totalPages} ({fmtN(total)} produk)</span>
      <button disabled={page >= totalPages} onClick={() => onPage(Math.min(totalPages, page + 1))}>Berikutnya</button>
      <select className="pa-prod-select pa-prod-select-sm" value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>
        {pageSizeOptions.map(sz => <option key={sz} value={sz}>{sz} / halaman</option>)}
      </select>
    </div>
  );
}
function TopList({ title, icon, rows, valueKey, valueFmt, onSelect }) {
  return (
    <div className="pa-prod-toplist">
      <div className="pa-prod-toplist-title"><i className={icon} style={{ color: COLOR }} /> {title}</div>
      {(!rows || rows.length === 0) && <div className="pa-prod-empty-sub">Belum ada data.</div>}
      {rows && rows.length > 0 && (
        <ol className="pa-prod-toplist-items">
          {rows.map((r, i) => (
            <li key={i} onClick={() => onSelect?.(r.product_name)} className="pa-prod-toplist-item">
              <span className="pa-prod-toplist-name">{r.product_name || r.product_label}</span>
              <span className="pa-prod-toplist-value">{valueFmt(r[valueKey])}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 1 — Overview
   ═══════════════════════════════════════════════════════════════════════ */
function OverviewTab({ analytics, meta, onOpenDetail }) {
  const summary = analytics?.summary || {};
  const topProducts = analytics?.top_products || {};
  const insights = Array.isArray(analytics?.insights) ? analytics.insights.slice(0, 5) : [];
  const dataQuality = Array.isArray(analytics?.data_quality) ? analytics.data_quality : [];
  const formulaErrorCheck = dataQuality.find(d => d.key === 'formula_error_count');
  const hasFormulaError = formulaErrorCheck && Number(formulaErrorCheck.count) > 0;
  const curLabel = meta?.current_month_label || 'Bulan Berjalan';
  const prevLabel = meta?.previous_month_label || 'Bulan Sebelumnya';
  const baseLabel = meta?.baseline_month_label || 'Bulan Awal';

  return (
    <>
      {hasFormulaError && (
        <div className="pa-prod-warning-banner">
          <i className="ti ti-alert-triangle" />
          <div>Google Sheet masih memiliki formula error. Angka terkait akan dibaca sebagai null agar dashboard tidak error.</div>
        </div>
      )}

      <div className="pa-prod-badge-row">
        <span className="pa-prod-badge pa-prod-badge--info"><i className="ti ti-calendar-stats" /> Fair MTD Comparison — Day {meta?.day_number ?? '?'}</span>
        <span className="pa-prod-badge pa-prod-badge--sync"><i className="ti ti-refresh" /> Sync terakhir: {fmtDateTime(meta?.last_sync)}</span>
      </div>

      <div className="pa-prod-kpi-grid">
        <KPICard label={`Total Revenue ${curLabel}`} value={fmtRp(summary.total_revenue_current)} />
        <KPICard label={`Total TRX ${curLabel}`} value={fmtN(summary.total_trx_current)} />
        <KPICard label={`Total MAT ${curLabel}`} value={fmtN(summary.total_mat_current)} />
        <KPICard label="ARPT" value={fmtRp(summary.arpt_current)} />
        <KPICard label="ATPU" value={fmtN(summary.atpu_current?.toFixed?.(2) ?? summary.atpu_current)} />
        <KPICard label="ARPU" value={fmtRp(summary.arpu_current)} />
        <KPICard label={`Revenue vs ${prevLabel}`} value={fmtRp(summary.revenue_vs_jun)} sub={fmtPct(summary.revenue_growth_vs_jun_pct)} alert={(summary.revenue_vs_jun || 0) < 0} />
        <KPICard label={`Revenue vs ${baseLabel}`} value={fmtRp(summary.revenue_vs_mei)} sub={fmtPct(summary.revenue_growth_vs_mei_pct)} alert={(summary.revenue_vs_mei || 0) < 0} />
      </div>

      <div className="pa-prod-panel">
        <div className="pa-prod-panel-title"><i className="ti ti-trending-up" style={{ color: COLOR }} /> Growth {baseLabel} → {prevLabel} → {curLabel}</div>
        <div className="pa-prod-growth-row">
          <GrowthStat label={`Revenue vs ${prevLabel}`} value={summary.revenue_growth_vs_jun_pct} />
          <GrowthStat label={`Revenue vs ${baseLabel}`} value={summary.revenue_growth_vs_mei_pct} />
          <GrowthStat label={`TRX vs ${prevLabel}`} value={summary.trx_growth_vs_jun_pct} />
          <GrowthStat label={`MAT vs ${prevLabel}`} value={summary.mat_growth_vs_jun_pct} />
        </div>
        <div className="pa-prod-growth-row">
          <div className="pa-prod-growth-stat"><div className="pa-prod-growth-label">Naik</div><div className="pa-prod-growth-value" style={{ color: '#059669' }}>{fmtN(summary.products_up_count)}</div></div>
          <div className="pa-prod-growth-stat"><div className="pa-prod-growth-label">Turun</div><div className="pa-prod-growth-value" style={{ color: '#DC2626' }}>{fmtN(summary.products_down_count)}</div></div>
          <div className="pa-prod-growth-stat"><div className="pa-prod-growth-label">Stabil</div><div className="pa-prod-growth-value" style={{ color: '#3B82F6' }}>{fmtN(summary.products_stable_count)}</div></div>
          <div className="pa-prod-growth-stat"><div className="pa-prod-growth-label">Kritis</div><div className="pa-prod-growth-value" style={{ color: '#991B1B' }}>{fmtN(summary.products_critical_count)}</div></div>
        </div>
      </div>

      <div className="pa-prod-panel">
        <div className="pa-prod-panel-title"><i className="ti ti-trophy" style={{ color: COLOR }} /> Top Products</div>
        <div className="pa-prod-toplist-grid">
          <TopList title="Top by Revenue" icon="ti ti-coin" rows={topProducts.top_by_revenue} valueKey="rev" valueFmt={fmtRp} onSelect={onOpenDetail} />
          <TopList title="Top by TRX" icon="ti ti-receipt" rows={topProducts.top_by_trx} valueKey="trx" valueFmt={fmtN} onSelect={onOpenDetail} />
          <TopList title="Top by MAT" icon="ti ti-users" rows={topProducts.top_by_mat} valueKey="mat" valueFmt={fmtN} onSelect={onOpenDetail} />
          <TopList title={`Top Growth vs ${prevLabel}`} icon="ti ti-arrow-up-right" rows={topProducts.top_growth_vs_jun} valueKey="dev_jun_rev" valueFmt={fmtRp} onSelect={onOpenDetail} />
          <TopList title={`Top Decline vs ${prevLabel}`} icon="ti ti-arrow-down-right" rows={topProducts.top_decline_vs_jun} valueKey="dev_jun_rev" valueFmt={fmtRp} onSelect={onOpenDetail} />
        </div>
      </div>

      <div className="pa-prod-panel">
        <div className="pa-prod-panel-title"><i className="ti ti-bulb" style={{ color: COLOR }} /> Insight Marketing</div>
        {insights.length === 0 && <div className="pa-prod-empty-sub">Belum ada insight.</div>}
        {insights.length > 0 && (
          <ul className="pa-prod-insight-list">
            {insights.map(i => {
              const sm = severityMeta(i.severity);
              return (
                <li key={i.id} className="pa-prod-insight-item">
                  <span className="pa-prod-insight-dot" style={{ background: sm.color }} />
                  <span>{i.text}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 2 — Product Ranking
   ═══════════════════════════════════════════════════════════════════════ */
function RankingTab({ products, meta, onOpenDetail }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('semua');
  const [priorityFilter, setPriorityFilter] = useState('semua');
  const [segmentFilter, setSegmentFilter] = useState('semua');
  const [sort, setSort] = useState({ key: 'rev', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const filtered = useMemo(() => {
    let rows = products || [];
    if (search) {
      const s = search.toLowerCase();
      rows = rows.filter(p => (p.product_name || '').toLowerCase().includes(s) || (p.product_label || '').toLowerCase().includes(s));
    }
    if (statusFilter !== 'semua') rows = rows.filter(p => p.status === statusFilter);
    if (priorityFilter !== 'semua') rows = rows.filter(p => p.priority === priorityFilter);
    if (segmentFilter !== 'semua') rows = rows.filter(p => p.segment === segmentFilter);
    const dir = sort.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => dir * ((a[sort.key] ?? -Infinity) - (b[sort.key] ?? -Infinity)));
    return rows;
  }, [products, search, statusFilter, priorityFilter, segmentFilter, sort]);

  useEffect(() => { setPage(1); }, [search, statusFilter, priorityFilter, segmentFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);
  const handleSort = (key) => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  const resetFilters = () => { setSearch(''); setStatusFilter('semua'); setPriorityFilter('semua'); setSegmentFilter('semua'); setSort({ key: 'rev', dir: 'desc' }); };

  const exportCsv = () => {
    downloadCsv('payment-agent-produk-ranking.csv',
      ['product_name', 'mat', 'trx', 'rev', 'arpt', 'atpu', 'arpu', 'revenue_contribution_pct', 'dev_mei_rev', 'dev_jun_rev', 'status', 'priority', 'segment'],
      filtered);
  };

  return (
    <>
      <div className="pa-prod-toolbar">
        <input className="pa-prod-input" placeholder="Cari produk..." value={search} onChange={e => setSearch(e.target.value)} />
        <select className="pa-prod-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="semua">Semua Status</option>
          <option value="naik">Naik</option>
          <option value="turun">Turun</option>
          <option value="stabil">Stabil</option>
          <option value="kritis">Kritis</option>
          <option value="no_data">Belum Ada Data</option>
        </select>
        <select className="pa-prod-select" value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}>
          <option value="semua">Semua Priority</option>
          {Object.keys(PRIORITY_META).map(p => <option key={p} value={p}>{p} — {PRIORITY_META[p].label}</option>)}
        </select>
        <select className="pa-prod-select" value={segmentFilter} onChange={e => setSegmentFilter(e.target.value)}>
          <option value="semua">Semua Segment</option>
          {SEGMENT_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="pa-prod-btn" onClick={resetFilters}><i className="ti ti-refresh" /> Reset Filter</button>
        <button className="pa-prod-btn pa-prod-btn--primary" onClick={exportCsv}><i className="ti ti-download" /> Export CSV</button>
      </div>

      <div className="pa-prod-table-wrap">
        <table className="pa-prod-table">
          <thead>
            <tr>
              <th>Produk</th>
              <SortableTh label="MAT" sortKey="mat" sort={sort} onSort={handleSort} />
              <SortableTh label="TRX" sortKey="trx" sort={sort} onSort={handleSort} />
              <SortableTh label="REV" sortKey="rev" sort={sort} onSort={handleSort} />
              <SortableTh label="ARPT" sortKey="arpt" sort={sort} onSort={handleSort} />
              <SortableTh label="ATPU" sortKey="atpu" sort={sort} onSort={handleSort} />
              <SortableTh label="ARPU" sortKey="arpu" sort={sort} onSort={handleSort} />
              <SortableTh label="Kontribusi %" sortKey="revenue_contribution_pct" sort={sort} onSort={handleSort} />
              <SortableTh label={`Dev vs ${meta?.baseline_month_label || 'Awal'}`} sortKey="dev_mei_rev" sort={sort} onSort={handleSort} />
              <SortableTh label={`Dev vs ${meta?.previous_month_label || 'Sebelumnya'}`} sortKey="dev_jun_rev" sort={sort} onSort={handleSort} />
              <th>Status</th>
              <th>Priority</th>
              <th>Segment</th>
              <th>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && <tr><td colSpan={13} className="pa-prod-empty-sub">Tidak ada produk yang cocok dengan filter.</td></tr>}
            {pageRows.map(p => (
              <tr key={p.product_label}>
                <td>{p.product_name}</td>
                <td>{fmtN(p.mat)}</td>
                <td>{fmtN(p.trx)}</td>
                <td>{fmtRp(p.rev)}</td>
                <td>{fmtRp(p.arpt)}</td>
                <td>{fmtN(p.atpu)}</td>
                <td>{fmtRp(p.arpu)}</td>
                <td>{fmtPct(p.revenue_contribution_pct)}</td>
                <td style={{ color: (p.dev_mei_rev || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtRp(p.dev_mei_rev)}</td>
                <td style={{ color: (p.dev_jun_rev || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtRp(p.dev_jun_rev)}</td>
                <td><StatusBadge status={p.status} /></td>
                <td><PriorityChip priority={p.priority} /></td>
                <td>{p.segment}</td>
                <td><button className="pa-prod-link-btn" onClick={() => onOpenDetail(p.product_name)}>Detail</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={pageSize} total={filtered.length} onPage={setPage} onPageSize={setPageSize} pageSizeOptions={[10, 25, 50, 100]} />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 3 — Growth & Decline
   ═══════════════════════════════════════════════════════════════════════ */
function GrowthTab({ products, topProducts, meta, onOpenDetail }) {
  const [filter, setFilter] = useState('semua');
  const rows = useMemo(() => {
    let r = products || [];
    if (filter === 'naik') r = r.filter(p => p.status === 'naik');
    else if (filter === 'turun') r = r.filter(p => p.status === 'turun');
    else if (filter === 'high_revenue_declining') r = r.filter(p => p.status === 'turun' && (p.revenue_contribution_pct || 0) >= 0.02);
    else if (filter === 'growth_product') r = r.filter(p => p.segment === 'Growth Product');
    return [...r].sort((a, b) => (b.dev_jun_rev || 0) - (a.dev_jun_rev || 0));
  }, [products, filter]);

  const curLabel = meta?.current_month_label || 'Berjalan';
  const prevLabel = meta?.previous_month_label || 'Sebelumnya';
  const baseLabel = meta?.baseline_month_label || 'Awal';

  return (
    <>
      <div className="pa-prod-panel">
        <div className="pa-prod-panel-title"><i className="ti ti-arrows-diff" style={{ color: COLOR }} /> Ranking Perubahan Revenue</div>
        <div className="pa-prod-toplist-grid">
          <TopList title={`Top Kenaikan vs ${prevLabel}`} icon="ti ti-arrow-up-right" rows={topProducts.top_growth_vs_jun} valueKey="dev_jun_rev" valueFmt={fmtRp} onSelect={onOpenDetail} />
          <TopList title={`Top Penurunan vs ${prevLabel}`} icon="ti ti-arrow-down-right" rows={topProducts.top_decline_vs_jun} valueKey="dev_jun_rev" valueFmt={fmtRp} onSelect={onOpenDetail} />
          <TopList title={`Top Kenaikan vs ${baseLabel}`} icon="ti ti-arrow-up-right" rows={topProducts.top_growth_vs_mei} valueKey="dev_mei_rev" valueFmt={fmtRp} onSelect={onOpenDetail} />
          <TopList title={`Top Penurunan vs ${baseLabel}`} icon="ti ti-arrow-down-right" rows={topProducts.top_decline_vs_mei} valueKey="dev_mei_rev" valueFmt={fmtRp} onSelect={onOpenDetail} />
        </div>
      </div>

      <div className="pa-prod-toolbar">
        <select className="pa-prod-select" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="semua">Semua</option>
          <option value="naik">Naik</option>
          <option value="turun">Turun</option>
          <option value="high_revenue_declining">High Revenue Declining</option>
          <option value="growth_product">Growth Product</option>
        </select>
      </div>

      <div className="pa-prod-table-wrap">
        <table className="pa-prod-table">
          <thead>
            <tr>
              <th>Produk</th>
              <th>{`REV ${baseLabel}`}</th>
              <th>{`REV ${prevLabel}`}</th>
              <th>{`REV ${curLabel}`}</th>
              <th>{`Dev ${baseLabel} vs ${curLabel}`}</th>
              <th>{`Dev ${prevLabel} vs ${curLabel}`}</th>
              <th>{`Growth % vs ${baseLabel}`}</th>
              <th>{`Growth % vs ${prevLabel}`}</th>
              <th>{`TRX Dev vs ${prevLabel}`}</th>
              <th>{`MAT Dev vs ${prevLabel}`}</th>
              <th>{`ARPU Dev vs ${prevLabel}`}</th>
              <th>Status</th>
              <th>Rekomendasi</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={13} className="pa-prod-empty-sub">Tidak ada produk yang cocok dengan filter.</td></tr>}
            {rows.map(p => (
              <tr key={p.product_label} className="pa-prod-clickable-row" onClick={() => onOpenDetail(p.product_name)}>
                <td>{p.product_name}</td>
                <td>{fmtRp(p.mei_rev)}</td>
                <td>{fmtRp(p.jun_rev)}</td>
                <td>{fmtRp(p.rev)}</td>
                <td style={{ color: (p.dev_mei_rev || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtRp(p.dev_mei_rev)}</td>
                <td style={{ color: (p.dev_jun_rev || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtRp(p.dev_jun_rev)}</td>
                <td>{fmtPct(p.revenue_growth_vs_baseline_pct)}</td>
                <td>{fmtPct(p.revenue_growth_vs_previous_pct)}</td>
                <td>{fmtN(p.dev_jun_trx)}</td>
                <td>{fmtN(p.dev_jun_mat)}</td>
                <td>{fmtRp(p.dev_jun_arpu)}</td>
                <td><StatusBadge status={p.status} /></td>
                <td className="pa-prod-reco-cell">{p.recommendation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 4 — Campaign Priority
   ═══════════════════════════════════════════════════════════════════════ */
function CampaignTab({ campaignPriority, onOpenDetail }) {
  const order = ['P0', 'P1', 'P2', 'P3', 'P4'];
  return (
    <div className="pa-prod-campaign-board">
      {order.map(key => {
        const list = campaignPriority?.[key] || [];
        const pm = priorityMeta(key);
        return (
          <div className="pa-prod-campaign-col" key={key}>
            <div className="pa-prod-campaign-col-header" style={{ borderColor: pm.color }}>
              <span className="pa-prod-campaign-col-title" style={{ color: pm.color }}>{key} — {pm.label}</span>
              <span className="pa-prod-campaign-col-count">{list.length}</span>
            </div>
            <div className="pa-prod-campaign-col-body">
              {list.length === 0 && <div className="pa-prod-empty-sub">Tidak ada produk.</div>}
              {list.map(p => (
                <div key={p.product_label} className="pa-prod-campaign-card" onClick={() => onOpenDetail(p.product_name)}>
                  <div className="pa-prod-campaign-card-name">{p.product_name}</div>
                  <div className="pa-prod-campaign-card-rev">{fmtRp(p.rev)}</div>
                  <div className="pa-prod-campaign-card-dev" style={{ color: (p.dev_jun_rev || 0) < 0 ? '#DC2626' : '#059669' }}>
                    {fmtRp(p.dev_jun_rev)} ({fmtPct(p.revenue_growth_vs_previous_pct)})
                  </div>
                  <div className="pa-prod-campaign-card-diag">{p.diagnosis}</div>
                  <div className="pa-prod-campaign-card-reco">{p.recommendation}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 5 — Product Deep Dive
   ═══════════════════════════════════════════════════════════════════════ */
function DetailTab({ snapshotDate, productName, detail, loading }) {
  if (!productName) {
    return <div className="pa-prod-empty"><i className="ti ti-click" /><div>Pilih produk dari tab Product Ranking atau Campaign Priority untuk melihat detail.</div></div>;
  }
  if (loading) return <div className="pa-prod-loading"><i className="ti ti-loader-2 pa-prod-spin" /> Memuat detail produk...</div>;
  if (!detail || detail.empty) return <div className="pa-prod-empty"><i className="ti ti-mood-empty" /><div>{detail?.message || 'Produk tidak ditemukan.'}</div></div>;

  const { product, monthly, deviation, diagnosis, campaign_recommendation: reco, content_angle: angles } = detail;

  return (
    <>
      <div className="pa-prod-panel">
        <div className="pa-prod-panel-title"><i className="ti ti-package" style={{ color: COLOR }} /> {product.product_name}</div>
        <table className="pa-prod-table">
          <thead><tr><th>Bulan</th><th>MAT</th><th>TRX</th><th>REV</th><th>ARPT</th><th>ATPU</th><th>ARPU</th></tr></thead>
          <tbody>
            {monthly.map(m => (
              <tr key={m.month_key}>
                <td>{m.month_label || m.month_key}</td>
                <td>{fmtN(m.mat)}</td><td>{fmtN(m.trx)}</td><td>{fmtRpFull(m.rev)}</td>
                <td>{fmtRp(m.arpt)}</td><td>{fmtN(m.atpu)}</td><td>{fmtRp(m.arpu)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pa-prod-panel">
        <div className="pa-prod-panel-title"><i className="ti ti-arrows-diff" style={{ color: COLOR }} /> Deviasi</div>
        <div className="pa-prod-detail-dev-grid">
          {Object.entries(deviation).map(([key, d]) => (
            <div key={key} className="pa-prod-detail-dev-card">
              <div className="pa-prod-detail-dev-title">{d.compare_label || key}</div>
              <div className="pa-prod-detail-dev-row"><span>MAT</span><b style={{ color: (d.dev_mat || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtN(d.dev_mat)}</b></div>
              <div className="pa-prod-detail-dev-row"><span>TRX</span><b style={{ color: (d.dev_trx || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtN(d.dev_trx)}</b></div>
              <div className="pa-prod-detail-dev-row"><span>REV</span><b style={{ color: (d.dev_rev || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtRp(d.dev_rev)}</b></div>
              <div className="pa-prod-detail-dev-row"><span>ARPT</span><b style={{ color: (d.dev_arpt || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtRp(d.dev_arpt)}</b></div>
              <div className="pa-prod-detail-dev-row"><span>ATPU</span><b style={{ color: (d.dev_atpu || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtN(d.dev_atpu)}</b></div>
              <div className="pa-prod-detail-dev-row"><span>ARPU</span><b style={{ color: (d.dev_arpu || 0) < 0 ? '#DC2626' : '#059669' }}>{fmtRp(d.dev_arpu)}</b></div>
            </div>
          ))}
        </div>
      </div>

      <div className="pa-prod-detail-reco-grid">
        <div className="pa-prod-panel">
          <div className="pa-prod-panel-title"><i className="ti ti-stethoscope" style={{ color: COLOR }} /> Diagnosis</div>
          <ul className="pa-prod-simple-list">{diagnosis.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </div>
        <div className="pa-prod-panel">
          <div className="pa-prod-panel-title"><i className="ti ti-speakerphone" style={{ color: COLOR }} /> Campaign Recommendation</div>
          <ul className="pa-prod-simple-list">{reco.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </div>
        <div className="pa-prod-panel">
          <div className="pa-prod-panel-title"><i className="ti ti-photo" style={{ color: COLOR }} /> Content Angle</div>
          <ul className="pa-prod-simple-list">{angles.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 6 — Data Quality
   ═══════════════════════════════════════════════════════════════════════ */
function DataQualityTab({ dataQuality, meta }) {
  const hasIssue = dataQuality.some(d => d.count > 0);
  const hasParens = true; // catatan statis — angka kurung selalu dianggap negatif oleh parser
  return (
    <>
      <div className="pa-prod-badge-row">
        <span className="pa-prod-badge pa-prod-badge--sync"><i className="ti ti-refresh" /> Sync terakhir: {fmtDateTime(meta?.last_sync)}</span>
        <span className="pa-prod-badge pa-prod-badge--info"><i className="ti ti-calendar" /> Day {meta?.day_number ?? '?'}</span>
        <span className="pa-prod-badge pa-prod-badge--info"><i className="ti ti-link" /> Sheet: {meta?.sheet_name || 'Produk'}</span>
      </div>

      {hasParens && (
        <div className="pa-prod-info-banner">
          <i className="ti ti-info-circle" />
          <div>Angka dalam tanda kurung dibaca sebagai nilai negatif.</div>
        </div>
      )}

      {!hasIssue && (
        <div className="pa-prod-info-banner">
          <i className="ti ti-circle-check" />
          <div>Tidak ada issue data quality yang terdeteksi.</div>
        </div>
      )}

      <div className="pa-prod-table-wrap">
        <table className="pa-prod-table">
          <thead><tr><th>Check</th><th>Jumlah</th><th>Severity</th><th>Rekomendasi</th></tr></thead>
          <tbody>
            {dataQuality.map(c => {
              const sm = severityMeta(c.severity);
              return (
                <tr key={c.key}>
                  <td>{c.label}</td>
                  <td><span className="pa-prod-dq-count" style={{ color: sm.color }}>{fmtN(c.count)}</span></td>
                  <td><span className="pa-prod-status-badge" style={{ background: sm.bg, color: sm.color }}>{sm.label}</span></td>
                  <td>{c.recommendation}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="pa-prod-dq-note">
        {dataQuality.find(d => d.key === 'total_row_mismatch')?.count > 0 && (
          <div className="pa-prod-warning-banner"><i className="ti ti-alert-triangle" /><div>Perlu cek row TOTAL di Google Sheet.</div></div>
        )}
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   PAGE
   ═══════════════════════════════════════════════════════════════════════ */
export default function WarRoomPaymentAgentProduk() {
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotDate, setSnapshotDate] = useState('latest');
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('overview');

  const [selectedProduct, setSelectedProduct] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    getPaymentAgentProdukSnapshots().then(setSnapshots).catch(() => setSnapshots([]));
  }, []);

  const loadAnalytics = useCallback((sd) => {
    setLoading(true);
    setError(null);
    getPaymentAgentProdukAnalytics(sd)
      .then(setAnalytics)
      .catch(e => setError(e?.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadAnalytics(snapshotDate); }, [snapshotDate, loadAnalytics]);

  const handleOpenDetail = useCallback((productName) => {
    if (!productName) return;
    setSelectedProduct(productName);
    setTab('detail');
    setDetailLoading(true);
    getPaymentAgentProdukDetail({ snapshot_date: snapshotDate, product_name: productName })
      .then(setDetail)
      .catch(() => setDetail({ empty: true, message: 'Gagal memuat detail produk.' }))
      .finally(() => setDetailLoading(false));
  }, [snapshotDate]);

  const meta = analytics?.meta;
  const products = analytics?.products || [];

  return (
    <Layout>
      <div className="pa-prod-page">
        <div className="pa-prod-header">
          <div className="pa-prod-header-left">
            <i className="ti ti-shopping-cart-bolt" style={{ fontSize: 22, color: COLOR }} />
            <div>
              <div className="pa-prod-header-title">Produk — Payment Agent</div>
              <div className="pa-prod-header-sub">Monitoring performa produk Payment Agent berdasarkan MAT, TRX, REV, ARPT, ATPU, ARPU, growth, dan prioritas campaign.</div>
            </div>
          </div>
          <div className="pa-prod-header-right">
            <select className="pa-prod-select" value={snapshotDate} onChange={e => setSnapshotDate(e.target.value)}>
              <option value="latest">Terbaru</option>
              {snapshots.map(s => (
                <option key={s.snapshot_date} value={String(s.snapshot_date).slice(0, 10)}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="pa-prod-tabs">
          {TABS.map(t => (
            <button key={t.key} className={'pa-prod-tab-btn' + (tab === t.key ? ' pa-prod-tab-btn--active' : '')} onClick={() => setTab(t.key)}>
              <i className={`ti ${t.icon}`} /> {t.label}
            </button>
          ))}
        </div>

        {loading && <div className="pa-prod-loading"><i className="ti ti-loader-2 pa-prod-spin" /> Memuat data Produk...</div>}
        {!loading && error && <div className="pa-prod-error"><i className="ti ti-alert-triangle" /> {error}</div>}
        {!loading && !error && analytics?.empty && (
          <div className="pa-prod-empty"><i className="ti ti-mood-empty" /><div>{analytics.message || 'Data Produk belum tersedia. Jalankan sync Google Sheet terlebih dahulu.'}</div></div>
        )}

        {!loading && !error && analytics && !analytics.empty && (
          <>
            {tab === 'overview' && <OverviewTab analytics={analytics} meta={meta} onOpenDetail={handleOpenDetail} />}
            {tab === 'ranking' && <RankingTab products={products} meta={meta} onOpenDetail={handleOpenDetail} />}
            {tab === 'growth' && <GrowthTab products={products} topProducts={analytics.top_products || {}} meta={meta} onOpenDetail={handleOpenDetail} />}
            {tab === 'campaign' && <CampaignTab campaignPriority={analytics.campaign_priority} onOpenDetail={handleOpenDetail} />}
            {tab === 'detail' && <DetailTab snapshotDate={snapshotDate} productName={selectedProduct} detail={detail} loading={detailLoading} />}
            {tab === 'dq' && <DataQualityTab dataQuality={analytics.data_quality || []} meta={meta} />}
          </>
        )}
      </div>
    </Layout>
  );
}
