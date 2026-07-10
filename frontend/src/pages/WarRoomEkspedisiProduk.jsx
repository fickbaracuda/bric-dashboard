import { useState, useEffect, useMemo, useCallback } from 'react';
import Layout from '../components/Layout';
import {
  getEkspedisiProdukMonths, getEkspedisiProdukAnalytics, getEkspedisiProdukOutlets,
  getEkspedisiProdukProductDetail, getEkspedisiProdukOutletDetail,
} from '../services/api';

const COLOR = '#0EA5E9';
const TABS = [
  { key: 'overview', label: 'Ringkasan', icon: 'ti-layout-dashboard' },
  { key: 'produk', label: 'Produk', icon: 'ti-list-details' },
  { key: 'outlet', label: 'Outlet', icon: 'ti-building-store' },
  { key: 'growth', label: 'Growth & Deviasi', icon: 'ti-trending-up' },
  { key: 'dq', label: 'Kualitas Data', icon: 'ti-database-cog' },
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
function fmtDate(v) {
  if (!v) return '-';
  const iso = String(v).slice(0, 10);
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return '-';
  return `${d}/${m}/${y}`;
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

/* ─── Metadata presentasi (frontend-only) ─── */
const STATUS_META = {
  naik:          { label: 'Naik',            color: '#059669', bg: '#DCFCE7' },
  turun:         { label: 'Turun',           color: '#DC2626', bg: '#FEE2E2' },
  stabil:        { label: 'Stabil',          color: '#3B82F6', bg: '#DBEAFE' },
  zero_activity: { label: 'Tanpa Aktivitas', color: '#B45309', bg: '#FEF3C7' },
  no_data:       { label: 'Belum Ada Data',  color: '#6B7280', bg: '#F3F4F6' },
};
function statusMeta(s) { return STATUS_META[s] || STATUS_META.no_data; }

const PRIORITY_META = {
  P0: { label: 'Selamatkan Produk Turun', color: '#DC2626' },
  P1: { label: 'Optimasi Produk Aktif',   color: '#F59E0B' },
  P2: { label: 'Jaga Momentum',           color: '#3B82F6' },
  P3: { label: 'Scale Produk Naik',       color: '#059669' },
  P4: { label: 'Data Quality',            color: '#6B7280' },
};
function priorityMeta(p) { return PRIORITY_META[p] || { label: p || '-', color: '#9CA3AF' }; }

const SEVERITY_META = {
  high:   { label: 'Tinggi', color: '#DC2626', bg: '#FEE2E2' },
  medium: { label: 'Sedang', color: '#B45309', bg: '#FEF3C7' },
  low:    { label: 'Rendah', color: '#1D4ED8', bg: '#DBEAFE' },
};
function severityMeta(s) { return SEVERITY_META[s] || SEVERITY_META.low; }

const JENIS_OPTIONS = ['COD', 'CASHLESS', 'REGULER', 'CARGO', 'EXPRESS', 'LAINNYA'];
function classifyJenis(idProduk, produk) {
  const s = `${idProduk || ''} ${produk || ''}`.toUpperCase();
  if (s.includes('COD')) return 'COD';
  if (s.includes('CASHLESS') || s.includes('CLSS')) return 'CASHLESS';
  if (s.includes('CARGO') || s.includes('CRG')) return 'CARGO';
  if (s.includes('EXPRESS') || s.includes('EXP')) return 'EXPRESS';
  if (s.includes('REGULER') || s.includes('REGULAR') || s.includes('REG')) return 'REGULER';
  return 'LAINNYA';
}
function classifyGrowth(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'no_data';
  if (pct > 0.05) return 'naik';
  if (pct < -0.05) return 'turun';
  return 'stabil';
}

/* ─── UI atoms ─── */
function KPICard({ label, value, sub, alert }) {
  return (
    <div className={'eprod-kpi-card' + (alert ? ' eprod-kpi-card--alert' : '')}>
      <div className="eprod-kpi-label">{label}</div>
      <div className="eprod-kpi-value">{value}</div>
      {sub && <div className="eprod-kpi-sub">{sub}</div>}
    </div>
  );
}
function StatusBadge({ status }) {
  const m = statusMeta(status);
  return <span className="eprod-status-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}
function PriorityChip({ priority }) {
  const pm = priorityMeta(priority);
  return <span className="eprod-priority-chip" style={{ background: pm.color }}>{priority || '-'}</span>;
}
function GrowthStat({ label, pct }) {
  const n = Number(pct);
  const known = pct !== null && pct !== undefined && Number.isFinite(n);
  const color = !known ? 'var(--text-muted, var(--text-4))' : (n >= 0 ? '#059669' : '#DC2626');
  return (
    <div className="eprod-growth-stat">
      <div className="eprod-growth-label">{label}</div>
      <div className="eprod-growth-value" style={{ color }}>{known ? fmtPct(n) : 'Belum ada data'}</div>
    </div>
  );
}
function SortableTh({ label, sortKey, sort, onSort, style }) {
  const active = sort.key === sortKey;
  const icon = active ? (sort.dir === 'asc' ? 'ti-sort-ascending' : 'ti-sort-descending') : 'ti-arrows-sort';
  return (
    <th className={'eprod-sort-th' + (active ? ' eprod-sort-th--active' : '')} onClick={() => onSort(sortKey)} style={style}>
      <span>{label}</span> <i className={`ti ${icon}`} aria-hidden="true" />
    </th>
  );
}
function Pagination({ page, pageSize, total, onPage, onPageSize, pageSizeOptions }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="eprod-pagination">
      <button disabled={page <= 1} onClick={() => onPage(Math.max(1, page - 1))}>Sebelumnya</button>
      <span>Halaman {page} dari {totalPages} ({fmtN(total)} baris)</span>
      <button disabled={page >= totalPages} onClick={() => onPage(Math.min(totalPages, page + 1))}>Berikutnya</button>
      <select className="eprod-select eprod-select-sm" value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>
        {pageSizeOptions.map(sz => <option key={sz} value={sz}>{sz} / halaman</option>)}
      </select>
    </div>
  );
}
function Modal({ title, onClose, children, wide }) {
  return (
    <div className="eprod-modal-overlay" onClick={onClose}>
      <div className={'eprod-modal' + (wide ? ' eprod-modal--wide' : '')} onClick={e => e.stopPropagation()}>
        <div className="eprod-modal-header">
          <div className="eprod-modal-title">{title}</div>
          <button className="eprod-modal-close" onClick={onClose}><i className="ti ti-x" /> Tutup</button>
        </div>
        <div className="eprod-modal-body">{children}</div>
      </div>
    </div>
  );
}
function TopList({ title, icon, rows, valueKey, valueFmt, onSelect }) {
  return (
    <div className="eprod-toplist">
      <div className="eprod-toplist-title"><i className={icon} style={{ color: COLOR }} /> {title}</div>
      {rows.length === 0 && <div className="eprod-empty-sub">Belum ada data.</div>}
      {rows.length > 0 && (
        <ol className="eprod-toplist-items">
          {rows.map((r, i) => (
            <li key={i} onClick={() => onSelect?.(r.id_produk)} className="eprod-toplist-item">
              <span className="eprod-toplist-name">{r.produk || r.id_produk}</span>
              <span className="eprod-toplist-value">{valueFmt(r[valueKey])}</span>
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
  const summary = analytics?.summary;
  const topProducts = analytics?.top_products || {};
  const insights = Array.isArray(analytics?.insights) ? analytics.insights.slice(0, 5) : [];
  const actionSummary = Array.isArray(analytics?.action_summary) ? analytics.action_summary : [];
  const dataQuality = Array.isArray(analytics?.data_quality) ? analytics.data_quality : [];
  const formulaErrorCheck = dataQuality.find(d => d.key === 'formula_error_count');
  const hasFormulaError = formulaErrorCheck && Number(formulaErrorCheck.count) > 0;

  return (
    <>
      {hasFormulaError && (
        <div className="eprod-warning-banner">
          <i className="ti ti-alert-triangle" />
          <div>Google Sheet masih memiliki formula error. Angka terkait akan dibaca sebagai null/0 agar dashboard tidak error.</div>
        </div>
      )}

      <div className="eprod-kpi-grid">
        <KPICard label="Total Produk" value={fmtN(summary?.total_produk)} />
        <KPICard label="MAT" value={fmtN(summary?.total_mat)} />
        <KPICard label="Jumlah Bill" value={fmtN(summary?.total_jml_bill)} />
        <KPICard label="Total Margin" value={fmtRp(summary?.total_margin_fp)} />
        <KPICard label="Rata-rata Margin/Bill" value={fmtRp(summary?.avg_margin_per_bill)} />
        <KPICard label="Avg Bill / MAT" value={fmtN(summary?.avg_bill_per_mat)} />
        <KPICard label="Naik" value={fmtN(summary?.produk_naik_vs_previous_count)} />
        <KPICard label="Turun" value={fmtN(summary?.produk_turun_vs_previous_count)} alert={(summary?.produk_turun_vs_previous_count || 0) > 0} />
        <KPICard label="Produk Margin 0" value={fmtN(summary?.produk_margin_0_count)} alert={(summary?.produk_margin_0_count || 0) > 0} />
      </div>

      <div className="eprod-panel">
        <div className="eprod-panel-title"><i className="ti ti-trending-up" style={{ color: COLOR }} /> Growth Summary</div>
        <div className="eprod-growth-row">
          <GrowthStat label={`Margin vs ${meta?.previous_bulan_label || 'Bulan Sebelumnya'}`} pct={summary?.margin_growth_vs_previous_pct} />
          <GrowthStat label={`Bill vs ${meta?.previous_bulan_label || 'Bulan Sebelumnya'}`} pct={summary?.bill_growth_vs_previous_pct} />
          <GrowthStat label={`MAT vs ${meta?.previous_bulan_label || 'Bulan Sebelumnya'}`} pct={summary?.mat_growth_vs_previous_pct} />
          <GrowthStat label="Margin vs Mei" pct={summary?.margin_growth_vs_may_pct} />
          <GrowthStat label="Margin vs Juni" pct={summary?.margin_growth_vs_june_pct} />
        </div>
      </div>

      <div className="eprod-panel">
        <div className="eprod-panel-title"><i className="ti ti-trophy" style={{ color: COLOR }} /> Top Products</div>
        <div className="eprod-toplist-grid">
          <TopList title="Top by Margin" icon="ti ti-coin" rows={topProducts.top_by_margin || []} valueKey="margin_fp" valueFmt={fmtRp} onSelect={onOpenDetail} />
          <TopList title="Top by Bill" icon="ti ti-receipt" rows={topProducts.top_by_bill || []} valueKey="jml_bill" valueFmt={fmtN} onSelect={onOpenDetail} />
          <TopList title="Top by MAT" icon="ti ti-users" rows={topProducts.top_by_mat || []} valueKey="mat" valueFmt={fmtN} onSelect={onOpenDetail} />
          <TopList title="Top Growth" icon="ti ti-arrow-up-right" rows={topProducts.top_growth || []} valueKey="margin_growth_pct" valueFmt={fmtPct} onSelect={onOpenDetail} />
          <TopList title="Top Decline" icon="ti ti-arrow-down-right" rows={topProducts.top_decline || []} valueKey="margin_growth_pct" valueFmt={fmtPct} onSelect={onOpenDetail} />
        </div>
      </div>

      <div className="eprod-panel">
        <div className="eprod-panel-title"><i className="ti ti-bulb" style={{ color: COLOR }} /> Insight</div>
        {insights.length === 0 && <div className="eprod-empty-sub">Tidak ada insight khusus untuk bulan ini.</div>}
        <div className="eprod-insight-grid">
          {insights.map((ins, i) => {
            const sm = severityMeta(ins.severity);
            return (
              <div key={i} className="eprod-insight-card" style={{ '--ins-color': sm.color }}>
                <span className="eprod-severity-badge" style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>
                <div className="eprod-insight-desc">{ins.text}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="eprod-panel">
        <div className="eprod-panel-title"><i className="ti ti-list-check" style={{ color: COLOR }} /> Action Summary</div>
        {actionSummary.length === 0 && <div className="eprod-empty-sub">Tidak ada aksi prioritas untuk bulan ini.</div>}
        <div className="eprod-action-grid">
          {actionSummary.map((a, i) => {
            const pm = priorityMeta(a.priority);
            return (
              <div key={i} className="eprod-action-card" style={{ '--ac-color': pm.color }}>
                <div className="eprod-action-top">
                  <span className="eprod-priority-badge" style={{ background: pm.color }}>{a.priority} · {pm.label}</span>
                  <span className="eprod-action-count">{fmtN(a.count)}</span>
                </div>
                <div className="eprod-action-title">{a.title}</div>
                {a.recommendation && <div className="eprod-action-reko">{a.recommendation}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 2 — Produk
   ═══════════════════════════════════════════════════════════════════════ */
const PRODUK_SORT_DEFAULT = { key: 'margin_fp', dir: 'desc' };
function ProdukTab({ products, bulan, onOpenDetail, onJumpToOutlet }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('semua');
  const [priorityFilter, setPriorityFilter] = useState('semua');
  const [jenisFilter, setJenisFilter] = useState('semua');
  const [sort, setSort] = useState(PRODUK_SORT_DEFAULT);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  const enriched = useMemo(() => products.map(p => ({ ...p, jenis: classifyJenis(p.id_produk, p.produk) })), [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched.filter(p => {
      if (q && !(`${p.id_produk} ${p.produk || ''}`.toLowerCase().includes(q))) return false;
      if (statusFilter !== 'semua' && p.status !== statusFilter) return false;
      if (priorityFilter !== 'semua' && p.priority !== priorityFilter) return false;
      if (jenisFilter !== 'semua' && p.jenis !== jenisFilter) return false;
      return true;
    });
  }, [enriched, search, statusFilter, priorityFilter, jenisFilter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'string') return mul * av.localeCompare(bv);
      return mul * ((av || 0) - (bv || 0));
    });
    return arr;
  }, [filtered, sort]);

  useEffect(() => { setPage(1); }, [search, statusFilter, priorityFilter, jenisFilter, pageSize, sort]);

  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);

  const handleSort = useCallback((key) => {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' });
  }, []);

  const handleReset = () => {
    setSearch(''); setStatusFilter('semua'); setPriorityFilter('semua'); setJenisFilter('semua'); setSort(PRODUK_SORT_DEFAULT);
  };

  const handleExport = () => {
    const headers = ['id_produk', 'produk', 'mat', 'jml_bill', 'margin_fp', 'avg_margin_per_bill', 'avg_bill_per_mat', 'previous_margin_fp', 'margin_growth_value', 'margin_growth_pct', 'bill_growth_pct', 'mat_growth_pct', 'vs_mei', 'vs_jun', 'status', 'priority', 'recommendation'];
    downloadCsv(`produk-ekspedisi-${bulan || 'export'}.csv`, headers, sorted);
  };

  return (
    <div className="eprod-panel">
      <div className="eprod-panel-title-row">
        <div className="eprod-panel-title"><i className="ti ti-list-details" style={{ color: COLOR }} /> Product Performance</div>
        <div className="eprod-toolbar-actions">
          <button className="eprod-btn" onClick={handleReset}><i className="ti ti-refresh" /> Reset Filter</button>
          <button className="eprod-btn eprod-btn-primary" onClick={handleExport}><i className="ti ti-download" /> Export CSV</button>
        </div>
      </div>

      <div className="eprod-filter-row">
        <input className="eprod-search-input" placeholder="Cari ID Produk / nama produk..." value={search} onChange={e => setSearch(e.target.value)} />
        <select className="eprod-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="semua">Semua Status</option>
          <option value="naik">Naik</option>
          <option value="turun">Turun</option>
          <option value="stabil">Stabil</option>
          <option value="zero_activity">Tanpa Aktivitas</option>
          <option value="no_data">Belum Ada Data</option>
        </select>
        <select className="eprod-select" value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}>
          <option value="semua">Semua Prioritas</option>
          {['P0', 'P1', 'P2', 'P3', 'P4'].map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="eprod-select" value={jenisFilter} onChange={e => setJenisFilter(e.target.value)}>
          <option value="semua">Semua Jenis</option>
          {JENIS_OPTIONS.map(j => <option key={j} value={j}>{j}</option>)}
        </select>
      </div>

      <div className="eprod-filter-count">Menampilkan {fmtN(pageRows.length)} dari {fmtN(sorted.length)} produk (total {fmtN(products.length)})</div>

      {sorted.length === 0 && <div className="eprod-empty-sub">Tidak ada produk yang cocok dengan filter ini.</div>}
      {sorted.length > 0 && (
        <div className="eprod-table-wrap">
          <table className="eprod-table">
            <thead>
              <tr>
                <SortableTh label="ID Produk" sortKey="id_produk" sort={sort} onSort={handleSort} />
                <SortableTh label="Produk" sortKey="produk" sort={sort} onSort={handleSort} />
                <SortableTh label="MAT" sortKey="mat" sort={sort} onSort={handleSort} />
                <SortableTh label="Jml Bill" sortKey="jml_bill" sort={sort} onSort={handleSort} />
                <SortableTh label="Margin FP" sortKey="margin_fp" sort={sort} onSort={handleSort} />
                <SortableTh label="Avg Margin/Bill" sortKey="avg_margin_per_bill" sort={sort} onSort={handleSort} />
                <SortableTh label="Growth Margin" sortKey="margin_growth_pct" sort={sort} onSort={handleSort} />
                <th>Vs Mei</th><th>Vs Jun</th><th>Status</th><th>Prioritas</th><th>Rekomendasi</th><th></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((p, i) => (
                <tr key={i} className="eprod-row-clickable" onClick={() => onOpenDetail(p.id_produk)}>
                  <td>{p.id_produk}</td>
                  <td>{p.produk || '-'}</td>
                  <td>{fmtN(p.mat)}</td>
                  <td>{fmtN(p.jml_bill)}</td>
                  <td>{fmtRp(p.margin_fp)}</td>
                  <td>{fmtRp(p.avg_margin_per_bill)}</td>
                  <td style={{ color: p.margin_growth_pct == null ? undefined : (p.margin_growth_pct >= 0 ? '#059669' : '#DC2626') }}>
                    {p.margin_growth_pct == null ? '-' : fmtPct(p.margin_growth_pct)}
                  </td>
                  <td>{fmtRp(p.vs_mei)}</td>
                  <td>{fmtRp(p.vs_jun)}</td>
                  <td><StatusBadge status={p.status} /></td>
                  <td><PriorityChip priority={p.priority} /></td>
                  <td className="eprod-reko-cell">{p.recommendation}</td>
                  <td>
                    <div className="eprod-row-actions">
                      <button className="eprod-link-btn" onClick={e => { e.stopPropagation(); onOpenDetail(p.id_produk); }}>Lihat Detail</button>
                      <button className="eprod-link-btn" onClick={e => { e.stopPropagation(); onJumpToOutlet(p.id_produk); }}>Lihat Outlet</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sorted.length > 0 && (
        <Pagination page={page} pageSize={pageSize} total={sorted.length} onPage={setPage} onPageSize={setPageSize} pageSizeOptions={[10, 25, 50, 100]} />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 3 — Outlet
   ═══════════════════════════════════════════════════════════════════════ */
const OUTLET_SORT_DEFAULT = { key: 'tanggal', dir: 'desc' };
function OutletTab({ bulan, products, produkFilter, onProdukFilterChange, onOpenOutletDetail }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(OUTLET_SORT_DEFAULT);
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { setPage(1); }, [bulan, produkFilter, search, sort, pageSize]);

  useEffect(() => {
    if (!bulan) return;
    setLoading(true); setError(null);
    getEkspedisiProdukOutlets({
      bulan, id_produk: produkFilter || undefined, page, limit: pageSize,
      search: search || undefined, sort_by: sort.key, sort_dir: sort.dir,
    })
      .then(res => { setRows(res.rows || []); setTotal(res.meta?.total || 0); })
      .catch(e => setError(e.message || 'Gagal memuat detail outlet'))
      .finally(() => setLoading(false));
  }, [bulan, produkFilter, page, pageSize, search, sort]);

  const handleSort = useCallback((key) => {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' });
  }, []);

  const handleReset = () => {
    setSearch(''); onProdukFilterChange(''); setSort(OUTLET_SORT_DEFAULT); setPageSize(50);
  };

  return (
    <div className="eprod-panel">
      <div className="eprod-panel-title-row">
        <div className="eprod-panel-title"><i className="ti ti-building-store" style={{ color: COLOR }} /> Detail Outlet per Produk</div>
        <div className="eprod-toolbar-actions">
          <button className="eprod-btn" onClick={handleReset}><i className="ti ti-refresh" /> Reset Filter</button>
        </div>
      </div>

      <div className="eprod-filter-row">
        <input className="eprod-search-input" placeholder="Cari ID Outlet / ID Produk..." value={search} onChange={e => setSearch(e.target.value)} />
        <select className="eprod-select" value={produkFilter || ''} onChange={e => onProdukFilterChange(e.target.value)}>
          <option value="">Semua Produk</option>
          {products.map(p => <option key={p.id_produk} value={p.id_produk}>{p.produk || p.id_produk}</option>)}
        </select>
      </div>

      {loading && <div className="eprod-empty-sub">Memuat...</div>}
      {!loading && error && <div className="eprod-empty-sub">Gagal memuat: {error}</div>}
      {!loading && !error && rows.length === 0 && <div className="eprod-empty-sub">Belum ada detail outlet untuk filter ini.</div>}
      {!loading && !error && rows.length > 0 && (<>
        <div className="eprod-filter-count">Menampilkan {fmtN(rows.length)} dari {fmtN(total)} baris</div>
        <div className="eprod-table-wrap">
          <table className="eprod-table">
            <thead>
              <tr>
                <SortableTh label="Tanggal" sortKey="tanggal" sort={sort} onSort={handleSort} />
                <SortableTh label="ID Outlet" sortKey="id_outlet" sort={sort} onSort={handleSort} />
                <SortableTh label="ID Produk" sortKey="id_produk" sort={sort} onSort={handleSort} />
                <th>Produk</th>
                <SortableTh label="Jml Bill" sortKey="jml_bill" sort={sort} onSort={handleSort} />
                <SortableTh label="Margin FP" sortKey="margin_fp" sort={sort} onSort={handleSort} />
                <SortableTh label="Avg Margin/Bill" sortKey="avg_margin_per_bill" sort={sort} onSort={handleSort} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="eprod-row-clickable" onClick={() => onOpenOutletDetail(r.id_outlet)}>
                  <td>{fmtDate(r.tanggal)}</td>
                  <td>{r.id_outlet}</td>
                  <td>{r.id_produk}</td>
                  <td>{r.produk || '-'}</td>
                  <td>{fmtN(r.jml_bill)}</td>
                  <td>{fmtRp(r.margin_fp)}</td>
                  <td>{fmtRp(r.avg_margin_per_bill)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} pageSizeOptions={[25, 50, 100, 500]} />
      </>)}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 4 — Growth & Deviasi
   ═══════════════════════════════════════════════════════════════════════ */
function GrowthTab({ availableMonths, onOpenDetail }) {
  const [monthsData, setMonthsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('semua');
  const [sort, setSort] = useState({ key: 'vs_jun', dir: 'desc' });

  const compareMonths = useMemo(() => availableMonths.slice(-3), [availableMonths]);

  useEffect(() => {
    if (!compareMonths.length) { setLoading(false); return; }
    setLoading(true); setError(null);
    Promise.all(compareMonths.map(m => getEkspedisiProdukAnalytics(m.bulan)))
      .then(results => setMonthsData(results))
      .catch(e => setError(e.message || 'Gagal memuat data growth'))
      .finally(() => setLoading(false));
  }, [compareMonths.map(m => m.bulan).join(',')]);

  const rows = useMemo(() => {
    if (!monthsData || !monthsData.length) return [];
    const latestIdx = monthsData.length - 1;
    const latestResult = monthsData[latestIdx];
    const latestProducts = Array.isArray(latestResult?.products) ? latestResult.products : [];
    const map = new Map();
    monthsData.forEach((res, idx) => {
      const bulanKey = compareMonths[idx]?.bulan;
      (Array.isArray(res?.products) ? res.products : []).forEach(p => {
        if (!map.has(p.id_produk)) map.set(p.id_produk, { id_produk: p.id_produk, produk: p.produk, marginByMonth: {} });
        map.get(p.id_produk).marginByMonth[bulanKey] = p.margin_fp;
      });
    });
    const meiBulan = compareMonths[0]?.bulan;
    const junBulan = compareMonths[1]?.bulan;
    const julBulan = compareMonths[compareMonths.length - 1]?.bulan;

    return [...map.values()].map(row => {
      const marginMei = compareMonths.length >= 3 ? row.marginByMonth[meiBulan] ?? null : null;
      const marginJun = row.marginByMonth[junBulan] ?? null;
      const marginJul = row.marginByMonth[julBulan] ?? null;
      const vsMei = (marginJul !== null && marginMei !== null) ? marginJul - marginMei : null;
      const vsJun = (marginJul !== null && marginJun !== null) ? marginJul - marginJun : null;
      const growthPctMei = (marginMei && marginMei !== 0) ? vsMei / marginMei : null;
      const growthPctJun = (marginJun && marginJun !== 0) ? vsJun / marginJun : null;
      const latestEntry = latestProducts.find(p => p.id_produk === row.id_produk);
      return {
        id_produk: row.id_produk,
        produk: row.produk,
        margin_mei: marginMei, margin_jun: marginJun, margin_jul: marginJul,
        vs_mei: vsMei, vs_jun: vsJun,
        growth_pct_mei: growthPctMei, growth_pct_jun: growthPctJun,
        status: latestEntry?.status || classifyGrowth(growthPctJun),
      };
    });
  }, [monthsData, compareMonths]);

  const filtered = useMemo(() => rows.filter(r => filter === 'semua' || r.status === filter), [rows, filter]);
  const sorted = useMemo(() => {
    const arr = [...filtered];
    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return mul * (av - bv);
    });
    return arr;
  }, [filtered, sort]);

  const handleSort = useCallback((key) => {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' });
  }, []);

  const rankNaikMei = useMemo(() => [...rows].filter(r => r.vs_mei > 0).sort((a, b) => b.vs_mei - a.vs_mei).slice(0, 5), [rows]);
  const rankTurunMei = useMemo(() => [...rows].filter(r => r.vs_mei < 0).sort((a, b) => a.vs_mei - b.vs_mei).slice(0, 5), [rows]);
  const rankNaikJun = useMemo(() => [...rows].filter(r => r.vs_jun > 0).sort((a, b) => b.vs_jun - a.vs_jun).slice(0, 5), [rows]);
  const rankTurunJun = useMemo(() => [...rows].filter(r => r.vs_jun < 0).sort((a, b) => a.vs_jun - b.vs_jun).slice(0, 5), [rows]);

  if (loading) return <div className="eprod-empty-sub">Memuat data growth...</div>;
  if (error) return <div className="eprod-empty-sub">Gagal memuat: {error}</div>;
  if (!compareMonths.length) return <div className="eprod-empty-sub">Belum ada bulan yang tersedia untuk perbandingan.</div>;

  return (
    <>
      <div className="eprod-panel">
        <div className="eprod-panel-title"><i className="ti ti-medal" style={{ color: COLOR }} /> Ranking Growth</div>
        <div className="eprod-toplist-grid">
          <TopList title={`Naik Terbesar vs ${compareMonths[0]?.label || 'Mei'}`} icon="ti ti-arrow-up-right" rows={rankNaikMei} valueKey="vs_mei" valueFmt={fmtRp} onSelect={onOpenDetail} />
          <TopList title={`Turun Terbesar vs ${compareMonths[0]?.label || 'Mei'}`} icon="ti ti-arrow-down-right" rows={rankTurunMei} valueKey="vs_mei" valueFmt={fmtRp} onSelect={onOpenDetail} />
          <TopList title={`Naik Terbesar vs ${compareMonths[1]?.label || 'Juni'}`} icon="ti ti-arrow-up-right" rows={rankNaikJun} valueKey="vs_jun" valueFmt={fmtRp} onSelect={onOpenDetail} />
          <TopList title={`Turun Terbesar vs ${compareMonths[1]?.label || 'Juni'}`} icon="ti ti-arrow-down-right" rows={rankTurunJun} valueKey="vs_jun" valueFmt={fmtRp} onSelect={onOpenDetail} />
        </div>
      </div>

      <div className="eprod-panel">
        <div className="eprod-panel-title-row">
          <div className="eprod-panel-title"><i className="ti ti-arrows-diff" style={{ color: COLOR }} /> Tabel Growth per Produk</div>
          <select className="eprod-select" value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="semua">Semua</option>
            <option value="naik">Naik Saja</option>
            <option value="turun">Turun Saja</option>
          </select>
        </div>
        {sorted.length === 0 && <div className="eprod-empty-sub">Tidak ada data untuk filter ini.</div>}
        {sorted.length > 0 && (
          <div className="eprod-table-wrap">
            <table className="eprod-table">
              <thead>
                <tr>
                  <th>ID Produk</th><th>Produk</th>
                  <th>Margin {compareMonths[0]?.label || 'Mei'}</th>
                  <th>Margin {compareMonths[1]?.label || 'Juni'}</th>
                  <th>Margin {compareMonths[2]?.label || 'Juli'}</th>
                  <SortableTh label="Vs Mei" sortKey="vs_mei" sort={sort} onSort={handleSort} />
                  <SortableTh label="Vs Juni" sortKey="vs_jun" sort={sort} onSort={handleSort} />
                  <th>Growth % vs Mei</th><th>Growth % vs Juni</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={i} className="eprod-row-clickable" onClick={() => onOpenDetail(r.id_produk)}>
                    <td>{r.id_produk}</td>
                    <td>{r.produk || '-'}</td>
                    <td>{fmtRp(r.margin_mei)}</td>
                    <td>{fmtRp(r.margin_jun)}</td>
                    <td>{fmtRp(r.margin_jul)}</td>
                    <td style={{ color: r.vs_mei == null ? undefined : (r.vs_mei >= 0 ? '#059669' : '#DC2626') }}>{fmtRp(r.vs_mei)}</td>
                    <td style={{ color: r.vs_jun == null ? undefined : (r.vs_jun >= 0 ? '#059669' : '#DC2626') }}>{fmtRp(r.vs_jun)}</td>
                    <td>{r.growth_pct_mei == null ? '-' : fmtPct(r.growth_pct_mei)}</td>
                    <td>{r.growth_pct_jun == null ? '-' : fmtPct(r.growth_pct_jun)}</td>
                    <td><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 5 — Kualitas Data
   ═══════════════════════════════════════════════════════════════════════ */
function DataQualityTab({ analytics, meta }) {
  const dataQuality = Array.isArray(analytics?.data_quality) ? analytics.data_quality : [];
  const products = Array.isArray(analytics?.products) ? analytics.products : [];
  const outletSummary = analytics?.outlet_summary || {};
  const mismatchCheck = dataQuality.find(d => d.key === 'total_mismatch_summary_vs_outlet');
  const hasMismatch = mismatchCheck && Number(mismatchCheck.count) > 0;

  return (
    <>
      <div className="eprod-panel">
        <div className="eprod-panel-title"><i className="ti ti-clipboard-check" style={{ color: COLOR }} /> Catatan Validasi Data</div>
        <div className="eprod-dq-note-grid">
          <div><span className="eprod-dq-note-label">Jumlah Summary Rows</span><span className="eprod-dq-note-value">{fmtN(products.length)}</span></div>
          <div><span className="eprod-dq-note-label">Jumlah Outlet Rows</span><span className="eprod-dq-note-value">{fmtN(outletSummary.outlet_rows)}</span></div>
          <div><span className="eprod-dq-note-label">Bulan Tersedia</span><span className="eprod-dq-note-value">{(meta?.available_months || []).map(m => m.label).join(', ') || 'Belum ada data'}</span></div>
          <div><span className="eprod-dq-note-label">Last Sync</span><span className="eprod-dq-note-value">{fmtDateTime(meta?.last_sync)}</span></div>
          <div><span className="eprod-dq-note-label">Source Sheet</span><span className="eprod-dq-note-value">Rev per produk &amp; Rev produk per outlet</span></div>
        </div>
        {hasMismatch ? (
          <div className="eprod-warning-banner" style={{ marginTop: 12 }}>
            <i className="ti ti-alert-triangle" />
            <div>Ada {fmtN(mismatchCheck.count)} produk dengan selisih Jml Bill antara Summary vs Outlet &gt;20% — ini bisa disebabkan beda cakupan data (mis. transaksi belum semua tercatat per outlet), bukan berarti error fatal. Cek detail di panel Data Quality di bawah.</div>
          </div>
        ) : (
          <div className="eprod-empty-sub" style={{ marginTop: 12 }}>Tidak ada mismatch Summary vs Outlet yang terdeteksi.</div>
        )}
      </div>

      <div className="eprod-panel">
        <div className="eprod-panel-title"><i className="ti ti-database-cog" style={{ color: COLOR }} /> Data Quality</div>
        {dataQuality.filter(d => Number(d.count) > 0).length === 0 && (
          <div className="eprod-empty-sub">Tidak ada isu kualitas data untuk bulan ini.</div>
        )}
        <div className="eprod-dq-list">
          {dataQuality.filter(d => Number(d.count) > 0).map((d, i) => {
            const sm = severityMeta(d.severity);
            return (
              <div key={i} className="eprod-dq-item" style={{ '--dq-color': sm.color }}>
                <div className="eprod-dq-top">
                  <div className="eprod-dq-title">{d.label}</div>
                  <span className="eprod-severity-badge" style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>
                  <div className="eprod-dq-count">{fmtN(d.count)}</div>
                </div>
                {d.recommendation && <div className="eprod-dq-note">{d.recommendation}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Modal: Detail Produk
   ═══════════════════════════════════════════════════════════════════════ */
function ProductDetailModal({ bulan, idProduk, onClose, onJumpToOutlet }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true); setError(null);
    getEkspedisiProdukProductDetail({ bulan, id_produk: idProduk })
      .then(setData)
      .catch(e => setError(e.message || 'Gagal memuat detail produk'))
      .finally(() => setLoading(false));
  }, [bulan, idProduk]);

  const p = data?.product;

  return (
    <Modal title={`Detail Produk — ${idProduk}`} onClose={onClose}>
      {loading && <div className="eprod-empty-sub">Memuat...</div>}
      {!loading && error && <div className="eprod-empty-sub">Gagal memuat: {error}</div>}
      {!loading && !error && data?.empty && <div className="eprod-empty-sub">{data.message || 'Belum ada data.'}</div>}
      {!loading && !error && !data?.empty && p && (<>
        <div className="eprod-detail-grid">
          <div><span className="eprod-detail-label">ID Produk</span><span className="eprod-detail-value">{p.id_produk}</span></div>
          <div><span className="eprod-detail-label">Produk</span><span className="eprod-detail-value">{p.produk || '-'}</span></div>
          <div><span className="eprod-detail-label">MAT</span><span className="eprod-detail-value">{fmtN(p.mat)}</span></div>
          <div><span className="eprod-detail-label">Jml Bill</span><span className="eprod-detail-value">{fmtN(p.jml_bill)}</span></div>
          <div><span className="eprod-detail-label">Margin</span><span className="eprod-detail-value">{fmtRpFull(p.margin_fp)}</span></div>
          <div><span className="eprod-detail-label">Avg Margin/Bill</span><span className="eprod-detail-value">{fmtRp(p.avg_margin_per_bill)}</span></div>
          <div><span className="eprod-detail-label">Vs Mei</span><span className="eprod-detail-value">{fmtRp(p.vs_mei)}</span></div>
          <div><span className="eprod-detail-label">Vs Jun</span><span className="eprod-detail-value">{fmtRp(p.vs_jun)}</span></div>
        </div>

        {Array.isArray(data.monthly) && data.monthly.length > 0 && (
          <div className="eprod-detail-section">
            <div className="eprod-detail-section-title">Histori Bulanan</div>
            <div className="eprod-table-wrap">
              <table className="eprod-table">
                <thead><tr><th>Bulan</th><th>MAT</th><th>Jml Bill</th><th>Margin</th></tr></thead>
                <tbody>
                  {data.monthly.map((m, i) => (
                    <tr key={i}><td>{m.bulan_label}</td><td>{fmtN(m.mat)}</td><td>{fmtN(m.jml_bill)}</td><td>{fmtRp(m.margin_fp)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="eprod-detail-section">
          <div className="eprod-detail-section-title">Top Outlet Produk Ini</div>
          {(!data.top_outlets || data.top_outlets.length === 0) && <div className="eprod-empty-sub">Belum ada detail outlet untuk produk ini.</div>}
          {data.top_outlets && data.top_outlets.length > 0 && (
            <div className="eprod-table-wrap">
              <table className="eprod-table">
                <thead><tr><th>ID Outlet</th><th>Jml Bill</th><th>Margin</th></tr></thead>
                <tbody>
                  {data.top_outlets.map((o, i) => (
                    <tr key={i}><td>{o.id_outlet}</td><td>{fmtN(o.jml_bill)}</td><td>{fmtRp(o.margin_fp)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <button className="eprod-btn eprod-btn-primary" onClick={() => onJumpToOutlet(p.id_produk)}>
          <i className="ti ti-building-store" /> Lihat Semua Outlet Produk Ini
        </button>
      </>)}
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Modal: Detail Outlet
   ═══════════════════════════════════════════════════════════════════════ */
function OutletDetailModal({ bulan, idOutlet, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true); setError(null);
    getEkspedisiProdukOutletDetail({ bulan, id_outlet: idOutlet })
      .then(setData)
      .catch(e => setError(e.message || 'Gagal memuat detail outlet'))
      .finally(() => setLoading(false));
  }, [bulan, idOutlet]);

  return (
    <Modal title={`Detail Outlet — ${idOutlet}`} onClose={onClose}>
      {loading && <div className="eprod-empty-sub">Memuat...</div>}
      {!loading && error && <div className="eprod-empty-sub">Gagal memuat: {error}</div>}
      {!loading && !error && data?.empty && <div className="eprod-empty-sub">{data.message || 'Belum ada data.'}</div>}
      {!loading && !error && !data?.empty && data && (<>
        <div className="eprod-detail-grid">
          <div><span className="eprod-detail-label">ID Outlet</span><span className="eprod-detail-value">{data.outlet?.id_outlet}</span></div>
          <div><span className="eprod-detail-label">Jumlah Produk</span><span className="eprod-detail-value">{fmtN(data.summary?.product_count)}</span></div>
          <div><span className="eprod-detail-label">Total Bill</span><span className="eprod-detail-value">{fmtN(data.summary?.total_bill)}</span></div>
          <div><span className="eprod-detail-label">Total Margin</span><span className="eprod-detail-value">{fmtRpFull(data.summary?.total_margin)}</span></div>
        </div>
        <div className="eprod-detail-section">
          <div className="eprod-detail-section-title">Produk yang Digunakan Outlet Ini</div>
          {(!data.products || data.products.length === 0) && <div className="eprod-empty-sub">Belum ada data produk untuk outlet ini.</div>}
          {data.products && data.products.length > 0 && (
            <div className="eprod-table-wrap">
              <table className="eprod-table">
                <thead><tr><th>ID Produk</th><th>Produk</th><th>Jml Bill</th><th>Margin</th><th>Avg Margin/Bill</th><th>Transaksi Terakhir</th></tr></thead>
                <tbody>
                  {data.products.map((p, i) => (
                    <tr key={i}>
                      <td>{p.id_produk}</td><td>{p.produk || '-'}</td><td>{fmtN(p.jml_bill)}</td>
                      <td>{fmtRp(p.margin_fp)}</td><td>{fmtRp(p.avg_margin_per_bill)}</td><td>{fmtDate(p.last_tanggal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </>)}
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Main
   ═══════════════════════════════════════════════════════════════════════ */
export default function WarRoomEkspedisiProduk() {
  const [months, setMonths] = useState([]);
  const [bulan, setBulan] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [monthsLoaded, setMonthsLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [outletProdukFilter, setOutletProdukFilter] = useState('');
  const [detailProdukId, setDetailProdukId] = useState(null);
  const [detailOutletId, setDetailOutletId] = useState(null);

  useEffect(() => {
    getEkspedisiProdukMonths()
      .then(res => {
        const list = Array.isArray(res) ? res : [];
        setMonths(list);
        setMonthsLoaded(true);
        if (list.length) setBulan(list[list.length - 1].bulan);
        else setLoading(false);
      })
      .catch(e => { setError(e.message || 'Gagal memuat daftar bulan'); setMonthsLoaded(true); setLoading(false); });
  }, []);

  useEffect(() => {
    if (!bulan) return;
    setLoading(true); setError(null);
    getEkspedisiProdukAnalytics(bulan)
      .then(setAnalytics)
      .catch(e => setError(e.message || 'Gagal memuat analytics'))
      .finally(() => setLoading(false));
  }, [bulan]);

  const isEmpty = monthsLoaded && !error && (months.length === 0 || analytics?.empty === true);
  const meta = analytics?.meta;
  const products = Array.isArray(analytics?.products) ? analytics.products : [];

  const handleJumpToOutlet = useCallback((idProduk) => {
    setOutletProdukFilter(idProduk || '');
    setDetailProdukId(null);
    setActiveTab('outlet');
  }, []);

  const handleOpenDetail = useCallback((idProduk) => { if (idProduk) setDetailProdukId(idProduk); }, []);
  const handleOpenOutletDetail = useCallback((idOutlet) => { if (idOutlet) setDetailOutletId(idOutlet); }, []);

  return (
    <Layout>
      <div className="eprod-page">

        <div className="eprod-header">
          <div className="eprod-header-left">
            <i className="ti ti-package" style={{ color: COLOR, fontSize: 24 }} />
            <div>
              <div className="eprod-header-title">Produk Ekspedisi</div>
              <div className="eprod-header-sub">Monitoring performa produk ekspedisi berdasarkan MAT, jumlah bill, margin, pertumbuhan bulanan, dan kontribusi outlet.</div>
            </div>
          </div>
          <div className="eprod-header-right">
            {months.length > 0 && (
              <select className="eprod-select" value={bulan || ''} onChange={e => setBulan(e.target.value)}>
                {months.map(m => <option key={m.bulan} value={m.bulan}>{m.label || m.bulan}</option>)}
              </select>
            )}
            {meta?.day_number != null && <span className="eprod-badge">Day {meta.day_number}</span>}
            {meta?.last_sync && (
              <span className="eprod-badge eprod-badge-sync"><i className="ti ti-refresh" /> Sync terakhir: {fmtDateTime(meta.last_sync)}</span>
            )}
          </div>
        </div>

        {loading && <div className="eprod-loading"><i className="ti ti-loader-2 eprod-spin" /> Memuat data...</div>}
        {!loading && error && <div className="eprod-error"><i className="ti ti-alert-circle" /> {error}</div>}
        {!loading && !error && months.length === 0 && (
          <div className="eprod-empty">
            <i className="ti ti-package" />
            <div>Data Produk Ekspedisi belum tersedia. Jalankan sync Google Sheet terlebih dahulu.</div>
          </div>
        )}
        {!loading && !error && months.length > 0 && analytics?.empty === true && (
          <div className="eprod-empty">
            <i className="ti ti-calendar-off" />
            <div>Bulan belum tersedia.</div>
          </div>
        )}

        {!loading && !error && !isEmpty && analytics && (<>
          <div className="eprod-tabs">
            {TABS.map(t => (
              <button key={t.key} className={'eprod-tab-btn' + (activeTab === t.key ? ' eprod-tab-btn--active' : '')} onClick={() => setActiveTab(t.key)}>
                <i className={`ti ${t.icon}`} /> {t.label}
              </button>
            ))}
          </div>

          {activeTab === 'overview' && <OverviewTab analytics={analytics} meta={meta} onOpenDetail={handleOpenDetail} />}
          {activeTab === 'produk' && <ProdukTab products={products} bulan={bulan} onOpenDetail={handleOpenDetail} onJumpToOutlet={handleJumpToOutlet} />}
          {activeTab === 'outlet' && (
            <OutletTab
              bulan={bulan} products={products} produkFilter={outletProdukFilter}
              onProdukFilterChange={setOutletProdukFilter} onOpenOutletDetail={handleOpenOutletDetail}
            />
          )}
          {activeTab === 'growth' && <GrowthTab availableMonths={meta?.available_months || []} onOpenDetail={handleOpenDetail} />}
          {activeTab === 'dq' && <DataQualityTab analytics={analytics} meta={meta} />}
        </>)}

        {detailProdukId && (
          <ProductDetailModal bulan={bulan} idProduk={detailProdukId} onClose={() => setDetailProdukId(null)} onJumpToOutlet={handleJumpToOutlet} />
        )}
        {detailOutletId && (
          <OutletDetailModal bulan={bulan} idOutlet={detailOutletId} onClose={() => setDetailOutletId(null)} />
        )}
      </div>
    </Layout>
  );
}
