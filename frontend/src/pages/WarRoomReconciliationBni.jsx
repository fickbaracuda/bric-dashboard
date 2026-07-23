import { useState, useEffect, useCallback, useRef } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import {
  getReconciliationBniAnalytics, getReconciliationBniTransactions, exportReconciliationBni,
  resolveReconciliationBni, getReconciliationBniLogs, getReconciliationBniRawBank,
  getReconciliationBniRawFp, getReconciliationBniResolutionHistory, getReconciliationBniDailyReport,
  requestReconciliationSync,
} from '../services/api';
import BalanceRequestButton from '../components/reconciliation/BalanceRequestButton';
import PeriodicBalanceNeeds from '../components/reconciliation/PeriodicBalanceNeeds';
import { getBniPeriodicBalanceNeeds } from '../services/api';

// Halaman ini REUSE layout/komponen generik "wrr-*"/"wrrbri-*" yang sudah
// dibangun utk Rekonsiliasi OCBC/Mandiri/BRI/BRI BI-FAST existing
// (tabs/panel/kpi/table/modal/pagination/confidence-badge/time-bucket) —
// MODUL BARU, TERPISAH, TIDAK mengubah file/route/adapter bank lain sama
// sekali. Beda mendasar: matching key = id_transaksi FP <-> transaction ID
// hasil EKSTRAKSI dari Description (hash "BMS_SNAP API #" & reference
// setelah "/"), scope_mode FP_COVERAGE_WINDOW (bukan full business date).
const COLOR = '#F15A23';
const TABS = [
  { key: 'summary', label: 'Executive Summary', icon: 'ti-report-money' },
  { key: 'hasil', label: 'Hasil Rekonsiliasi', icon: 'ti-list-details' },
  { key: 'exception', label: 'Exception Queue', icon: 'ti-alert-triangle' },
  { key: 'funding', label: 'Saldo & Funding Analysis', icon: 'ti-cash' },
  { key: 'time', label: 'Time & Posting Analysis', icon: 'ti-clock' },
  { key: 'raw', label: 'Raw Data & Audit', icon: 'ti-database' },
  { key: 'balance-needs', label: 'Kebutuhan Saldo', icon: 'ti-report-money' },
  { key: 'daily-report', label: 'Laporan Harian', icon: 'ti-file-report' },
];
const EXCEPTION_STATUSES = [
  'PENDING_BANK', 'FP_ONLY', 'BANK_ONLY', 'NOMINAL_MISMATCH', 'FEE_MISMATCH',
  'DUPLICATE_FP', 'DUPLICATE_BANK', 'REVERSAL', 'NEED_REVIEW',
];
const ALL_STATUSES = ['MATCHED', 'MATCHED_NO_FEE', ...EXCEPTION_STATUSES];

/* ─── Format helpers (identik dgn OCBC/Mandiri/BRI/BRI BI-FAST existing) ─── */
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
  if (!v) return 'Belum ada data';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtSeconds(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '-';
  const n = Number(v);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 60) return `${sign}${abs}dtk`;
  if (abs < 3600) return `${sign}${(abs / 60).toFixed(1)}mnt`;
  return `${sign}${(abs / 3600).toFixed(1)}jam`;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const STATUS_META = {
  MATCHED:           { label: 'Matched',            color: '#059669', bg: '#DCFCE7' },
  MATCHED_NO_FEE:    { label: 'Matched (No Fee)',    color: '#0D9488', bg: '#CCFBF1' },
  PENDING_BANK:      { label: 'Pending Bank',        color: '#B45309', bg: '#FEF3C7' },
  FP_ONLY:           { label: 'FP Only',             color: '#EA580C', bg: '#FFEDD5' },
  BANK_ONLY:         { label: 'Bank Only',           color: '#7C3AED', bg: '#F5F3FF' },
  NOMINAL_MISMATCH:  { label: 'Nominal Mismatch',    color: '#DC2626', bg: '#FEE2E2' },
  FEE_MISMATCH:      { label: 'Fee Mismatch',        color: '#DC2626', bg: '#FEE2E2' },
  DUPLICATE_FP:      { label: 'Duplicate FP',        color: '#BE123C', bg: '#FFE4E6' },
  DUPLICATE_BANK:    { label: 'Duplicate Bank',      color: '#BE123C', bg: '#FFE4E6' },
  REVERSAL:          { label: 'Reversal',            color: '#9333EA', bg: '#F3E8FF' },
  NEED_REVIEW:       { label: 'Need Review',         color: '#6B7280', bg: '#F3F4F6' },
};
function statusMeta(s) { return STATUS_META[s] || STATUS_META.NEED_REVIEW; }
function StatusBadge({ status }) {
  if (!status) return <span className="wrr-status-badge" style={{ background: '#F3F4F6', color: '#9CA3AF' }}>-</span>;
  const m = statusMeta(status);
  return <span className="wrr-status-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}
function ConfidenceBadge({ confidence }) {
  if (!confidence) return <span>-</span>;
  return <span className={`wrrbri-badge wrrbri-badge--${confidence.toLowerCase()}`}>{confidence}</span>;
}
function TimeOrderBadge({ status }) {
  if (!status) return <span>-</span>;
  return <span className={`wrrbri-badge wrrbri-badge--${status.toLowerCase()}`}>{status.replace('_', ' ')}</span>;
}
function CoverageBadge({ status }) {
  if (!status) return <span>-</span>;
  const labels = { INSIDE_FP_COVERAGE: 'Dalam Coverage', OUTSIDE_FP_COVERAGE: 'Luar Coverage', BOUNDARY_PARTIAL: 'Boundary', UNDETERMINED: 'Tidak Diketahui' };
  return <span className={`wrrbri-badge wrrbri-badge--${status.toLowerCase()}`}>{labels[status] || status}</span>;
}

/* ─── UI atoms (identik dgn OCBC) ─── */
function InfoIcon({ text }) {
  if (!text) return null;
  return <span className="wrr-info-icon" tabIndex={0} role="img" aria-label="Info" title={text}>i</span>;
}
function KPICard({ label, value, sub, alert, info }) {
  return (
    <div className={'wrr-kpi-card' + (alert ? ' wrr-kpi-card--alert' : '')}>
      <div className="wrr-kpi-label">{label}<InfoIcon text={info} /></div>
      <div className="wrr-kpi-value">{value}</div>
      {sub && <div className="wrr-kpi-sub">{sub}</div>}
    </div>
  );
}
function SortableTh({ label, sortKey, sort, onSort }) {
  const active = sort.key === sortKey;
  const icon = active ? (sort.dir === 'asc' ? 'ti-sort-ascending' : 'ti-sort-descending') : 'ti-arrows-sort';
  return (
    <th className={'wrr-sort-th' + (active ? ' wrr-sort-th--active' : '')} onClick={() => onSort(sortKey)}>
      <span>{label}</span> <i className={`ti ${icon}`} aria-hidden="true" />
    </th>
  );
}
function Pagination({ page, pageSize, total, onPage, onPageSize, pageSizeOptions }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="wrr-pagination">
      <button disabled={page <= 1} onClick={() => onPage(Math.max(1, page - 1))}>Sebelumnya</button>
      <span>Halaman {page} dari {totalPages} ({fmtN(total)} baris)</span>
      <button disabled={page >= totalPages} onClick={() => onPage(Math.min(totalPages, page + 1))}>Berikutnya</button>
      <select className="wrr-select wrr-select-sm" value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>
        {pageSizeOptions.map(sz => <option key={sz} value={sz}>{sz} / halaman</option>)}
      </select>
    </div>
  );
}
function Modal({ title, onClose, children, wide }) {
  return (
    <div className="wrr-modal-overlay" onClick={onClose}>
      <div className={'wrr-modal' + (wide ? ' wrr-modal--wide' : '')} onClick={e => e.stopPropagation()}>
        <div className="wrr-modal-header">
          <div className="wrr-modal-title">{title}</div>
          <button className="wrr-modal-close" onClick={onClose}><i className="ti ti-x" /> Tutup</button>
        </div>
        <div className="wrr-modal-body">{children}</div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 1 — Executive Summary
   ═══════════════════════════════════════════════════════════════════════ */
function MiniExceptionTable({ title, status, date }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!date) return;
    const myId = ++requestIdRef.current;
    setLoading(true);
    getReconciliationBniTransactions({ date, status, limit: 100, sort: 'updated_at', order: 'desc' })
      .then(res => { if (myId === requestIdRef.current) setRows(res.rows || []); })
      .catch(() => { if (myId === requestIdRef.current) setRows([]); })
      .finally(() => { if (myId === requestIdRef.current) setLoading(false); });
  }, [date, status]);

  return (
    <div className="wrr-panel wrr-mini-panel">
      <div className="wrr-panel-title"><i className="ti ti-alert-triangle" style={{ color: COLOR }} /> {title}</div>
      {loading && <div className="wrr-empty-sub">Memuat...</div>}
      {!loading && rows.length === 0 && <div className="wrr-empty-sub">Tidak ada data.</div>}
      {!loading && rows.length > 0 && (
        <div className="wrr-table-wrap wrr-mini-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>ID Trx</th><th>Nominal</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}><td>{r.id_transaksi || r.extracted_transaction_id || '-'}</td><td>{fmtRp(r.fp_nominal !== null ? r.fp_nominal : r.bank_principal)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryTab({ analytics, date }) {
  const s = analytics?.summary;
  const cov = analytics?.coverage;
  const ext = analytics?.extraction_summary;
  const fund = analytics?.funding_summary;
  const dq = analytics?.data_quality_warning;
  const fb = analytics?.fallback_diagnostics;
  return (
    <>
      <div className="wrr-kpi-grid">
        <KPICard label="Total Transaksi FP" value={fmtN(s?.total_fp)} info="Jumlah total transaksi FP dgn id_biller 141 untuk tanggal ini." />
        <KPICard label="Total Nominal FP" value={fmtRp(s?.total_nominal_fp)} />
        <KPICard label="Matched Transaksi" value={fmtN(s?.matched_count + s?.matched_no_fee)} info="Status MATCHED atau MATCHED_NO_FEE." />
        <KPICard label="Matched Nominal" value={fmtRp(s?.matched_nominal)} />
        <KPICard label="Pending Bank" value={fmtN(s?.pending_bank)} alert={(s?.pending_bank || 0) > 0} />
        <KPICard label="FP Only" value={fmtN(s?.fp_only)} alert={(s?.fp_only || 0) > 0} />
        <KPICard label="Bank Only" value={fmtN(s?.bank_only)} alert={(s?.bank_only || 0) > 0} />
        <KPICard label="Nominal Mismatch" value={fmtN(s?.nominal_mismatch)} alert={(s?.nominal_mismatch || 0) > 0} />
        <KPICard label="Reversal" value={fmtN(s?.reversal)} />
        <KPICard label="Valid Match Rate Transaksi" value={fmtPct(s?.valid_match_rate_transaction)} />
        <KPICard label="Valid Match Rate Nominal" value={fmtPct(s?.valid_match_rate_nominal)} />
        <KPICard label="Actionable Exception" value={fmtN(s?.actionable_exception_count)} alert={(s?.actionable_exception_count || 0) > 0} />
      </div>

      <div className="wrr-two-col-row">
        <div className="wrr-panel">
          <div className="wrr-panel-title"><i className="ti ti-clock-hour-4" style={{ color: COLOR }} /> Coverage Window
            <InfoIcon text="Data FP BNI bisa berupa potongan waktu -- mutasi bank di luar rentang waktu FP (±toleransi) TIDAK PERNAH otomatis dianggap BANK_ONLY." /></div>
          <div className="wrr-dq-note-grid">
            <div><span className="wrr-dq-note-label">Scope Mode</span><span className="wrr-dq-note-value">{cov?.scope_mode || '-'}</span></div>
            <div><span className="wrr-dq-note-label">Toleransi Sebelum</span><span className="wrr-dq-note-value">{fmtN(cov?.coverage_tolerance_before_minutes)} mnt</span></div>
            <div><span className="wrr-dq-note-label">Toleransi Sesudah</span><span className="wrr-dq-note-value">{fmtN(cov?.coverage_tolerance_after_minutes)} mnt</span></div>
            <div><span className="wrr-dq-note-label">Mutasi Bank Luar Coverage</span><span className="wrr-dq-note-value">{fmtN(cov?.outside_coverage_bank_count)}</span></div>
          </div>
        </div>
        <div className="wrr-panel">
          <div className="wrr-panel-title"><i className="ti ti-target" style={{ color: COLOR }} /> Extraction Quality</div>
          <div className="wrr-dq-note-grid">
            <div><span className="wrr-dq-note-label">HIGH</span><span className="wrr-dq-note-value">{fmtN(ext?.high_confidence_count)}</span></div>
            <div><span className="wrr-dq-note-label">MEDIUM</span><span className="wrr-dq-note-value">{fmtN(ext?.medium_confidence_count)}</span></div>
            <div><span className="wrr-dq-note-label">CONFLICT</span><span className="wrr-dq-note-value">{fmtN(ext?.conflict_confidence_count)}</span></div>
            <div><span className="wrr-dq-note-label">NONE</span><span className="wrr-dq-note-value">{fmtN(ext?.none_confidence_count)}</span></div>
          </div>
        </div>
      </div>

      {fb && (
        <div className="wrr-panel">
          <div className="wrr-panel-title"><i className="ti ti-git-merge" style={{ color: COLOR }} /> Fallback Matching (TIER3)
            <InfoIcon text="UNIQUE_TIME_AMOUNT_FALLBACK -- mencocokkan transaksi FASTPAY dgn Description transaction ID tidak lengkap (mis. 'BMS_SNAP API #3562' terpotong) via nominal+waktu unik (selisih <=3 detik), HANYA kalau kandidat FP & bank sama-sama tunggal." /></div>
          <div className="wrr-dq-note-grid">
            <div><span className="wrr-dq-note-label">Kandidat Fallback</span><span className="wrr-dq-note-value">{fmtN(fb.fallback_candidate_count)}</span></div>
            <div><span className="wrr-dq-note-label">Berhasil Matched</span><span className="wrr-dq-note-value">{fmtN(fb.fallback_matched_count)}</span></div>
            <div><span className="wrr-dq-note-label">Ambigu (&gt;1 kandidat)</span><span className="wrr-dq-note-value">{fmtN(fb.fallback_ambiguous_count)}</span></div>
            <div><span className="wrr-dq-note-label">Sisa Belum Cocok</span><span className="wrr-dq-note-value">{fmtN(fb.orphan_unconsumed_fastpay_count)}</span></div>
          </div>
        </div>
      )}

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-building-bank" style={{ color: COLOR }} /> Funding Summary
          <InfoIcon text="Total dana masuk (top-up) hari ini -- BUKAN saldo rekening aktual." /></div>
        <div className="wrr-dq-note-grid">
          <div><span className="wrr-dq-note-label">Total Funding Credit</span><span className="wrr-dq-note-value">{fmtRpFull(fund?.total_funding_credit)}</span></div>
          <div><span className="wrr-dq-note-label">Jumlah Top-up</span><span className="wrr-dq-note-value">{fmtN(fund?.funding_credit_count)}</span></div>
          <div><span className="wrr-dq-note-label">Total Fastpay Debit</span><span className="wrr-dq-note-value">{fmtRpFull(fund?.total_fastpay_debit)}</span></div>
          <div><span className="wrr-dq-note-label">Net Cash Movement</span><span className="wrr-dq-note-value">{fmtRpFull(fund?.net_cash_movement)}</span></div>
        </div>
      </div>

      {dq && (
        <div className={'wrr-panel' + (dq.has_issue ? '' : '')}>
          <div className="wrr-panel-title"><i className="ti ti-shield-check" style={{ color: COLOR }} /> Data Quality Warning</div>
          {!dq.has_issue ? (
            <div className="wrr-empty-sub">Tidak ditemukan pelanggaran integritas data.</div>
          ) : (
            <div className="wrr-warning-banner wrr-warning-banner-amber">
              <i className="ti ti-alert-triangle" />
              <div><p style={{ margin: 0 }}>{dq.message}</p></div>
            </div>
          )}
          <div className="wrr-dq-note-grid" style={{ marginTop: 12 }}>
            <div><span className="wrr-dq-note-label">ID Conflict</span><span className="wrr-dq-note-value">{fmtN(dq.id_conflict_count)}</span></div>
            <div><span className="wrr-dq-note-label">Duplicate Bank Transaction ID</span><span className="wrr-dq-note-value">{fmtN(dq.duplicate_bank_transaction_id_count)}</span></div>
            <div><span className="wrr-dq-note-label">Impossible Time Order</span><span className="wrr-dq-note-value">{fmtN(dq.impossible_time_order_count)}</span></div>
            <div><span className="wrr-dq-note-label">Funding Credit (info)</span><span className="wrr-dq-note-value">{fmtN(dq.funding_credit_count)}</span></div>
            <div><span className="wrr-dq-note-label">Luar Coverage (info)</span><span className="wrr-dq-note-value">{fmtN(dq.outside_coverage_bank_count)}</span></div>
          </div>
        </div>
      )}

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-chart-donut" style={{ color: COLOR }} /> Distribusi Status</div>
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>Status</th><th>Jumlah</th><th>Nominal</th></tr></thead>
            <tbody>
              {(analytics?.status_distribution || []).filter(d => d.count > 0).map((d, i) => (
                <tr key={i}><td><StatusBadge status={d.status} /></td><td>{fmtN(d.count)}</td><td>{fmtRp(d.nominal)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="wrr-mini-panel-row">
        <MiniExceptionTable title="FP Only" status="FP_ONLY" date={date} />
        <MiniExceptionTable title="Bank Only" status="BANK_ONLY" date={date} />
        <MiniExceptionTable title="Reversal" status="REVERSAL" date={date} />
      </div>
      <div className="wrr-mini-panel-row" style={{ gridTemplateColumns: '1fr' }}>
        <MiniExceptionTable title="Need Review" status="NEED_REVIEW" date={date} />
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Tabel bersama — Tab 2 (Hasil Rekonsiliasi) & Tab 3 (Exception Queue)
   ═══════════════════════════════════════════════════════════════════════ */
function ReconTable({ date, scope, onOpenAudit }) {
  const isException = scope === 'exception';
  const [statusFilter, setStatusFilter] = useState('semua');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: isException ? 'fp_nominal' : 'updated_at', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [resolveTarget, setResolveTarget] = useState(null);
  const requestIdRef = useRef(0);

  useEffect(() => { setPage(1); }, [statusFilter, search, sort, pageSize, date]);
  useEffect(() => { setRows([]); setTotal(0); }, [date]);

  useEffect(() => {
    if (!date) return;
    const myId = ++requestIdRef.current;
    setLoading(true); setError(null);
    const statusParam = statusFilter !== 'semua' ? statusFilter : (isException ? EXCEPTION_STATUSES.join(',') : undefined);
    getReconciliationBniTransactions({
      date, status: statusParam, search: search || undefined,
      page, limit: pageSize, sort: sort.key, order: sort.dir,
    })
      .then(res => { if (myId !== requestIdRef.current) return; setRows(res.rows || []); setTotal(res.meta?.total || 0); })
      .catch(e => { if (myId === requestIdRef.current) setError(e.message || 'Gagal memuat data'); })
      .finally(() => { if (myId === requestIdRef.current) setLoading(false); });
  }, [date, statusFilter, search, sort, page, pageSize, isException]);

  const handleSort = useCallback((key) => {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' });
  }, []);
  const statusOptions = isException ? EXCEPTION_STATUSES : ALL_STATUSES;

  return (
    <div className="wrr-panel">
      <div className="wrr-filter-row">
        <input className="wrr-search-input" placeholder="Cari ID Transaksi / Extracted ID / Outlet / Produk..." value={search} onChange={e => setSearch(e.target.value)} />
        <select className="wrr-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="semua">{isException ? 'Semua Exception' : 'Semua Status'}</option>
          {statusOptions.map(s => <option key={s} value={s}>{statusMeta(s).label}</option>)}
        </select>
      </div>

      {loading && <div className="wrr-empty-sub">Memuat...</div>}
      {!loading && error && <div className="wrr-empty-sub">Gagal memuat: {error}</div>}
      {!loading && !error && rows.length === 0 && <div className="wrr-empty-sub">Tidak ada data untuk filter ini.</div>}
      {!loading && !error && rows.length > 0 && (<>
        <div className="wrr-filter-count">Menampilkan {fmtN(rows.length)} dari {fmtN(total)} baris</div>
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead>
              <tr>
                <SortableTh label="ID Transaksi" sortKey="id_transaksi" sort={sort} onSort={handleSort} />
                <th>Produk</th><th>Outlet</th><th>Biller</th>
                <SortableTh label="Nominal FP" sortKey="fp_nominal" sort={sort} onSort={handleSort} />
                <SortableTh label="Debit Bank" sortKey="bank_principal" sort={sort} onSort={handleSort} />
                <th>Principal</th><th>Fee</th>
                <SortableTh label="Selisih" sortKey="variance_principal" sort={sort} onSort={handleSort} />
                <th>Waktu FP</th><th>Post Date</th>
                <SortableTh label="Selisih Waktu" sortKey="time_difference_seconds" sort={sort} onSort={handleSort} />
                <th>Time Order</th><th>Branch</th><th>Journal No.</th>
                <th>Beneficiary Acc.</th><th>Recipient</th>
                <th>ID Hash</th><th>ID Reference</th><th>Confidence</th>
                <th>Matching Method</th><th>Coverage</th>
                <SortableTh label="Status" sortKey="recon_status" sort={sort} onSort={handleSort} />
                {isException && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.id_transaksi || '-'}</td>
                  <td>{r.id_produk || '-'}</td>
                  <td>{r.id_outlet || '-'}</td>
                  <td>{r.id_biller || '-'}</td>
                  <td>{fmtRp(r.fp_nominal)}</td>
                  <td>{fmtRp(r.bank_principal !== null ? r.bank_principal + (r.bank_fee || 0) : null)}</td>
                  <td>{fmtRp(r.bank_principal)}</td>
                  <td>{fmtRp(r.bank_fee)}</td>
                  <td style={{ color: r.variance_principal ? '#DC2626' : undefined }}>{r.variance_principal === null ? '-' : fmtRp(r.variance_principal)}</td>
                  <td>{fmtDateTime(r.fp_time_response)}</td>
                  <td>{fmtDateTime(r.bank_transaction_date)}</td>
                  <td>{fmtSeconds(r.time_difference_seconds)}</td>
                  <td><TimeOrderBadge status={r.time_order_status} /></td>
                  <td>{r.branch || '-'}</td>
                  <td>{r.journal_no || '-'}</td>
                  <td>{r.beneficiary_account || '-'}</td>
                  <td>{r.recipient_name || '-'}</td>
                  <td>{r.transaction_id_from_hash || '-'}</td>
                  <td>{r.transaction_id_from_reference || '-'}</td>
                  <td><ConfidenceBadge confidence={r.extraction_confidence} /></td>
                  <td>{r.matching_method || '-'}</td>
                  <td><CoverageBadge status={r.coverage_status} /></td>
                  <td><StatusBadge status={r.recon_status} /></td>
                  {isException && (
                    <td>
                      <div className="wrr-row-actions">
                        <button className="wrr-link-btn" onClick={() => setResolveTarget(r)}>Resolve</button>
                        <button className="wrr-link-btn" onClick={() => onOpenAudit(r.id)}>Riwayat</button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} pageSizeOptions={[25, 50, 100, 500]} />
      </>)}

      {resolveTarget && (
        <ResolveModal target={resolveTarget} onClose={() => setResolveTarget(null)} onResolved={() => { setResolveTarget(null); setPage(p => p); setSort(s => ({ ...s })); }} />
      )}
    </div>
  );
}

function ResolveModal({ target, onClose, onResolved }) {
  const [status, setStatus] = useState(target.recon_status);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = () => {
    if (!notes.trim()) { setError('Catatan wajib diisi.'); return; }
    setSaving(true); setError(null);
    resolveReconciliationBni(target.id, { status, notes })
      .then(() => onResolved())
      .catch(e => setError(e.response?.data?.error || e.message || 'Gagal menyimpan'))
      .finally(() => setSaving(false));
  };

  return (
    <Modal title={`Resolve — ${target.id_transaksi || target.extracted_transaction_id || target.id}`} onClose={onClose}>
      <div className="wrr-detail-grid" style={{ marginBottom: 16 }}>
        <div><span className="wrr-detail-label">ID Transaksi</span><span className="wrr-detail-value">{target.id_transaksi || '-'}</span></div>
        <div><span className="wrr-detail-label">Extracted ID</span><span className="wrr-detail-value">{target.extracted_transaction_id || '-'}</span></div>
        <div><span className="wrr-detail-label">Nominal FP</span><span className="wrr-detail-value">{fmtRp(target.fp_nominal)}</span></div>
        <div><span className="wrr-detail-label">Status Saat Ini</span><span className="wrr-detail-value"><StatusBadge status={target.recon_status} /></span></div>
      </div>
      <label className="wrr-form-label">Status Baru</label>
      <select className="wrr-select" style={{ width: '100%', marginBottom: 12 }} value={status} onChange={e => setStatus(e.target.value)}>
        {ALL_STATUSES.map(s => <option key={s} value={s}>{statusMeta(s).label}</option>)}
      </select>
      <label className="wrr-form-label">Catatan Penyelesaian (wajib)</label>
      <textarea className="wrr-textarea" rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Jelaskan alasan/penyelesaian..." />
      {error && <div className="wrr-empty-sub" style={{ color: '#DC2626' }}>{error}</div>}
      <div className="wrr-modal-actions">
        <button className="wrr-btn" onClick={onClose} disabled={saving}>Batal</button>
        <button className="wrr-btn wrr-btn-primary" onClick={handleSubmit} disabled={saving}>{saving ? 'Menyimpan...' : 'Simpan'}</button>
      </div>
    </Modal>
  );
}

function AuditLogModal({ id, onClose }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getReconciliationBniLogs(id).then(setLogs).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [id]);

  return (
    <Modal title="Riwayat Audit" onClose={onClose}>
      {loading && <div className="wrr-empty-sub">Memuat...</div>}
      {!loading && error && <div className="wrr-empty-sub">Gagal memuat: {error}</div>}
      {!loading && !error && logs.length === 0 && <div className="wrr-empty-sub">Belum ada riwayat penyelesaian untuk baris ini.</div>}
      {!loading && !error && logs.length > 0 && (
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>Waktu</th><th>Aksi</th><th>Status Sebelum</th><th>Status Sesudah</th><th>Catatan</th><th>Oleh</th></tr></thead>
            <tbody>
              {logs.map((l, i) => (
                <tr key={i}>
                  <td>{fmtDateTime(l.created_at)}</td><td>{l.action}</td>
                  <td><StatusBadge status={l.status_before} /></td><td><StatusBadge status={l.status_after} /></td>
                  <td>{l.notes || '-'}</td><td>{l.created_by || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 4 — Saldo & Funding Analysis
   ═══════════════════════════════════════════════════════════════════════ */
function FundingChart({ date }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (!date) return;
    getReconciliationBniRawBank({ date, limit: 500 }).then(res => setRows(res.rows || [])).catch(() => setRows([]));
  }, [date]);

  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) chartRef.current.destroy();
    const hours = Array.from({ length: 24 }, () => ({ funding: 0, debit: 0 }));
    for (const r of rows) {
      const t = r.transaction_date_time ? new Date(r.transaction_date_time) : null;
      if (!t || Number.isNaN(t.getTime())) continue;
      const hour = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }).format(t)) % 24;
      if (r.bank_row_type === 'FUNDING_CREDIT') hours[hour].funding += Number(r.credit || 0);
      if (r.bank_row_type === 'FASTPAY_DEBIT') hours[hour].debit += Number(r.debit || 0);
    }
    let cumulative = 0;
    const netCumulative = hours.map(h => { cumulative += (h.funding - h.debit); return cumulative; });
    chartRef.current = new Chart(ref.current, {
      type: 'line',
      data: {
        labels: hours.map((_, i) => `${String(i).padStart(2, '0')}:00`),
        datasets: [
          { label: 'Funding Credit', data: hours.map(h => h.funding), borderColor: '#059669', backgroundColor: 'rgba(5,150,105,.1)', fill: true, tension: 0.2 },
          { label: 'Fastpay Debit', data: hours.map(h => h.debit), borderColor: COLOR, backgroundColor: 'rgba(241,90,35,.1)', fill: true, tension: 0.2 },
          { label: 'Net Cash Movement (Kumulatif)', data: netCumulative, borderColor: '#6366F1', borderDash: [5, 4], fill: false, tension: 0.2 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' } }, scales: { y: { ticks: { callback: v => fmtRp(v) } } } },
    });
    return () => { if (chartRef.current) chartRef.current.destroy(); };
  }, [rows]);

  return <div style={{ position: 'relative', height: 320 }}><canvas ref={ref} /></div>;
}

function FundingTab({ analytics, date }) {
  const fund = analytics?.funding_summary;
  const [fundingRows, setFundingRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!date) return;
    setLoading(true);
    getReconciliationBniRawBank({ date, limit: 500 })
      .then(res => setFundingRows((res.rows || []).filter(r => r.bank_row_type === 'FUNDING_CREDIT')))
      .catch(() => setFundingRows([]))
      .finally(() => setLoading(false));
  }, [date]);

  return (
    <>
      <div className="wrr-kpi-grid">
        <KPICard label="Total Funding Credit" value={fmtRp(fund?.total_funding_credit)} />
        <KPICard label="Jumlah Top-up" value={fmtN(fund?.funding_credit_count)} />
        <KPICard label="Total Fastpay Debit" value={fmtRp(fund?.total_fastpay_debit)} />
        <KPICard label="Total Reversal Credit" value={fmtRp(fund?.total_reversal_credit)} />
        <KPICard label="Net Cash Movement" value={fmtRp(fund?.net_cash_movement)} />
        <KPICard label="Top-up Terakhir" value={fmtDateTime(fund?.last_topup_time)} />
      </div>
      <div className="wrr-warning-banner wrr-warning-banner-amber">
        <i className="ti ti-info-circle" />
        <div><p style={{ margin: 0 }}>{fund?.disclaimer || 'Nilai ini menunjukkan arus dana berdasarkan mutasi yang tersedia dan bukan saldo rekening aktual karena data tidak memuat opening balance.'}</p></div>
      </div>
      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-chart-line" style={{ color: COLOR }} /> Arus Dana per Jam</div>
        <FundingChart date={date} />
      </div>
      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-list-details" style={{ color: COLOR }} /> Tabel Funding</div>
        {loading && <div className="wrr-empty-sub">Memuat...</div>}
        {!loading && fundingRows.length === 0 && <div className="wrr-empty-sub">Belum ada funding credit untuk tanggal ini.</div>}
        {!loading && fundingRows.length > 0 && (
          <div className="wrr-table-wrap">
            <table className="wrr-table">
              <thead><tr><th>Post Date</th><th>Value Date</th><th>Branch</th><th>Journal No.</th><th>Description</th><th>Credit</th></tr></thead>
              <tbody>
                {fundingRows.map((r, i) => (
                  <tr key={i}>
                    <td>{fmtDateTime(r.transaction_date_time)}</td><td>{fmtDateTime(r.effective_date_time)}</td>
                    <td>{r.branch || '-'}</td><td>{r.sequence_no || '-'}</td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 400 }}>{r.description || '-'}</td>
                    <td>{fmtRp(r.credit)}</td>
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
   TAB 5 — Time & Posting Analysis
   ═══════════════════════════════════════════════════════════════════════ */
function TimeAnalysisTab({ analytics }) {
  const t = analytics?.time_analysis;
  if (!t) return <div className="wrr-empty-sub">Belum ada data.</div>;
  return (
    <>
      <div className="wrr-kpi-grid">
        <KPICard label="Average" value={fmtSeconds(t.average_seconds)} />
        <KPICard label="Median" value={fmtSeconds(t.median_seconds)} />
        <KPICard label="P95" value={fmtSeconds(t.p95_seconds)} />
        <KPICard label="Maksimum" value={fmtSeconds(t.maximum_seconds)} />
        <KPICard label="Bank Lebih Awal" value={fmtN(t.bank_earlier_count)} />
        <KPICard label="0-60 Detik" value={fmtN(t.bucket_0_60s)} />
        <KPICard label="1-5 Menit" value={fmtN(t.bucket_1_5min)} />
        <KPICard label="5-15 Menit" value={fmtN(t.bucket_5_15min)} />
        <KPICard label=">15 Menit" value={fmtN(t.bucket_over_15min)} alert={(t.bucket_over_15min || 0) > 0} />
        <KPICard label="Impossible Order" value={fmtN(t.impossible_time_order)} alert={(t.impossible_time_order || 0) > 0} />
      </div>
      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-clock-exclamation" style={{ color: COLOR }} /> Top 50 Delayed / Impossible Order</div>
        {(!t.top_50_delayed || t.top_50_delayed.length === 0) ? (
          <div className="wrr-empty-sub">Tidak ada transaksi delayed/impossible order.</div>
        ) : (
          <div className="wrr-table-wrap">
            <table className="wrr-table">
              <thead><tr><th>ID Transaksi</th><th>Extracted ID</th><th>Waktu FP</th><th>Post Date</th><th>Selisih</th><th>Time Order</th><th>Status</th></tr></thead>
              <tbody>
                {t.top_50_delayed.map((r, i) => (
                  <tr key={i}>
                    <td>{r.id_transaksi || '-'}</td><td>{r.extracted_transaction_id || '-'}</td>
                    <td>{fmtDateTime(r.fp_time_response)}</td><td>{fmtDateTime(r.bank_transaction_date)}</td>
                    <td>{fmtSeconds(r.time_difference_seconds)}</td><td><TimeOrderBadge status={r.time_order_status} /></td>
                    <td><StatusBadge status={r.recon_status} /></td>
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
   TAB 6 — Raw Data & Audit (4 sub-tab)
   ═══════════════════════════════════════════════════════════════════════ */
function RawDataTab({ analytics, date, onExport, exporting }) {
  const [subTab, setSubTab] = useState('fp');
  const [rawFp, setRawFp] = useState([]);
  const [rawBank, setRawBank] = useState([]);
  const [resolutionHistory, setResolutionHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const meta = analytics?.meta;
  const recentBatches = analytics?.recent_batches || [];

  useEffect(() => {
    if (!date) return;
    setLoading(true);
    const loader = subTab === 'fp' ? getReconciliationBniRawFp({ date, limit: 500 })
      : subTab === 'bank' ? getReconciliationBniRawBank({ date, limit: 500 })
      : subTab === 'resolution' ? getReconciliationBniResolutionHistory({ date })
      : Promise.resolve(null);
    loader.then(res => {
      if (subTab === 'fp') setRawFp(res?.rows || []);
      else if (subTab === 'bank') setRawBank(res?.rows || []);
      else if (subTab === 'resolution') setResolutionHistory(res || []);
    }).catch(() => {
      if (subTab === 'fp') setRawFp([]); else if (subTab === 'bank') setRawBank([]); else setResolutionHistory([]);
    }).finally(() => setLoading(false));
  }, [date, subTab]);

  return (
    <>
      <div className="wrr-panel">
        <div className="wrr-panel-title-row">
          <div className="wrr-panel-title"><i className="ti ti-database" style={{ color: COLOR }} /> Info Sync Batch Ini</div>
          <button className="wrr-btn wrr-btn-primary" onClick={onExport} disabled={exporting}>
            <i className="ti ti-download" /> {exporting ? 'Mengekspor...' : 'Export CSV'}
          </button>
        </div>
        <div className="wrr-dq-note-grid">
          <div><span className="wrr-dq-note-label">Batch No</span><span className="wrr-dq-note-value">{meta?.batch_no || '-'}</span></div>
          <div><span className="wrr-dq-note-label">Jumlah Baris FP</span><span className="wrr-dq-note-value">{fmtN(meta?.fp_row_count)}</span></div>
          <div><span className="wrr-dq-note-label">Jumlah Baris Bank</span><span className="wrr-dq-note-value">{fmtN(meta?.bank_row_count)}</span></div>
          <div><span className="wrr-dq-note-label">Sync Terakhir</span><span className="wrr-dq-note-value">{fmtDateTime(meta?.last_sync)}</span></div>
          <div><span className="wrr-dq-note-label">Account No.</span><span className="wrr-dq-note-value">{meta?.account_no || 'Tidak tersedia'}</span></div>
        </div>
      </div>

      <div className="wrr-tabs" style={{ marginBottom: 12 }}>
        {[{ key: 'fp', label: 'Raw Data FP' }, { key: 'bank', label: 'Raw Data Bank BNI' }, { key: 'history', label: 'Sync History' }, { key: 'resolution', label: 'Resolution History' }].map(t => (
          <button key={t.key} className={'wrr-tab-btn' + (subTab === t.key ? ' wrr-tab-btn--active' : '')} onClick={() => setSubTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {loading && <div className="wrr-empty-sub">Memuat...</div>}

      {!loading && subTab === 'fp' && (
        <div className="wrr-panel wrr-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>Row</th><th>id_transaksi</th><th>nominal</th><th>id_produk</th><th>time_response</th><th>id_outlet</th><th>id_biller</th></tr></thead>
            <tbody>
              {rawFp.map((r, i) => (
                <tr key={i}><td>{r.source_row_number ?? '-'}</td><td>{r.id_transaksi}</td><td>{fmtRp(r.nominal)}</td><td>{r.id_produk || '-'}</td><td>{fmtDateTime(r.time_response)}</td><td>{r.id_outlet || '-'}</td><td>{r.id_biller || '-'}</td></tr>
              ))}
            </tbody>
          </table>
          {rawFp.length === 0 && <div className="wrr-empty-sub">Belum ada data.</div>}
        </div>
      )}

      {!loading && subTab === 'bank' && (
        <div className="wrr-panel wrr-table-wrap">
          <table className="wrr-table">
            <thead>
              <tr>
                <th>Row</th><th>Post Date</th><th>Value Date</th><th>Branch</th><th>Journal No.</th><th>Description</th>
                <th>Debit</th><th>Credit</th><th>ID Hash</th><th>ID Reference</th><th>Extracted ID</th>
                <th>Confidence</th><th>Conflict</th><th>Beneficiary</th><th>Recipient</th><th>Row Type</th><th>Coverage</th>
              </tr>
            </thead>
            <tbody>
              {rawBank.map((r, i) => (
                <tr key={i}>
                  <td>{r.source_row_number ?? '-'}</td><td>{fmtDateTime(r.transaction_date_time)}</td><td>{fmtDateTime(r.effective_date_time)}</td>
                  <td>{r.branch || '-'}</td><td>{r.sequence_no || '-'}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 320 }}>{r.description || '-'}</td>
                  <td>{fmtRp(r.debit)}</td><td>{fmtRp(r.credit)}</td>
                  <td>{r.transaction_id_from_hash || '-'}</td><td>{r.transaction_id_from_reference || '-'}</td><td>{r.extracted_transaction_id || '-'}</td>
                  <td><ConfidenceBadge confidence={r.extraction_confidence} /></td><td>{r.id_conflict ? 'Ya' : 'Tidak'}</td>
                  <td>{r.beneficiary_account || '-'}</td><td>{r.recipient_name || '-'}</td>
                  <td>{r.bank_row_type || '-'}</td><td><CoverageBadge status={r.coverage_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {rawBank.length === 0 && <div className="wrr-empty-sub">Belum ada data.</div>}
        </div>
      )}

      {!loading && subTab === 'history' && (
        <div className="wrr-panel wrr-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>Batch</th><th>Tanggal</th><th>Bank</th><th>Baris FP</th><th>Baris Bank</th><th>Sync Terakhir</th><th>Status</th></tr></thead>
            <tbody>
              {recentBatches.map((b, i) => (
                <tr key={i}><td>{b.batch_no}</td><td>{fmtDate(b.business_date)}</td><td>{b.bank_code}</td><td>{fmtN(b.fp_row_count)}</td><td>{fmtN(b.bank_row_count)}</td><td>{fmtDateTime(b.synced_at)}</td><td>{b.status}</td></tr>
              ))}
            </tbody>
          </table>
          {recentBatches.length === 0 && <div className="wrr-empty-sub">Belum ada riwayat sync.</div>}
        </div>
      )}

      {!loading && subTab === 'resolution' && (
        <div className="wrr-panel wrr-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>Waktu</th><th>ID Transaksi</th><th>Aksi</th><th>Status Sebelum</th><th>Status Sesudah</th><th>Catatan</th><th>Oleh</th></tr></thead>
            <tbody>
              {resolutionHistory.map((l, i) => (
                <tr key={i}>
                  <td>{fmtDateTime(l.created_at)}</td><td>{l.id_transaksi || l.extracted_transaction_id || '-'}</td><td>{l.action}</td>
                  <td><StatusBadge status={l.status_before} /></td><td><StatusBadge status={l.status_after} /></td>
                  <td>{l.notes || '-'}</td><td>{l.created_by || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {resolutionHistory.length === 0 && <div className="wrr-empty-sub">Belum ada riwayat resolve.</div>}
        </div>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 7 — Laporan Harian
   ═══════════════════════════════════════════════════════════════════════ */
const HEALTH_META = {
  GREEN:  { label: 'GREEN',  color: '#059669', bg: '#DCFCE7' },
  YELLOW: { label: 'YELLOW', color: '#B45309', bg: '#FEF3C7' },
  RED:    { label: 'RED',    color: '#DC2626', bg: '#FEE2E2' },
};
function buildDailyReportCopyText(report) {
  const lines = [
    `Laporan Rekonsiliasi BNI — ${fmtDate(report.meta?.date)}`,
    `Status: ${report.health_status} (${report.report_status === 'RUNNING' ? 'Berjalan' : 'Selesai'})`,
    '', report.ringkasan_direktur, '',
    `Total Transaksi FP: ${fmtN(report.summary?.total_fp)}`,
    `Total Nominal FP: ${fmtRp(report.summary?.total_nominal_fp)}`,
    `Berhasil Direkonsiliasi: ${fmtN(report.summary?.matched_transaksi)}`,
    `Valid Match Rate: ${fmtPct(report.summary?.valid_match_rate_transaction)}`,
    `Actionable Exception: ${fmtN(report.summary?.actionable_exception_count)}`,
    `Total Funding Credit: ${fmtRp(report.funding_summary?.total_funding_credit)}`,
    `Net Cash Movement: ${fmtRp(report.funding_summary?.net_cash_movement)}`,
    '', 'Tindak Lanjut:', ...(report.rekomendasi_tindak_lanjut || []).map(r => `- ${r}`),
  ];
  return lines.join('\n');
}

function DailyReportTab({ date }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copyMsg, setCopyMsg] = useState(null);
  const requestIdRef = useRef(0);

  const loadReport = useCallback((d) => {
    if (!d) return;
    const myId = ++requestIdRef.current;
    setLoading(true); setError(null);
    getReconciliationBniDailyReport({ date: d })
      .then(res => { if (myId === requestIdRef.current) setReport(res); })
      .catch(e => { if (myId === requestIdRef.current) setError(e.message || 'Gagal memuat laporan'); })
      .finally(() => { if (myId === requestIdRef.current) setLoading(false); });
  }, []);

  useEffect(() => { loadReport(date); }, [date, loadReport]);

  const handlePrint = () => window.print();
  const handleCopy = () => {
    if (!report || report.empty) return;
    const text = buildDailyReportCopyText(report);
    (navigator.clipboard?.writeText(text) || Promise.reject())
      .then(() => setCopyMsg('Ringkasan disalin ke clipboard — siap ditempel ke WhatsApp.'))
      .catch(() => setCopyMsg('Gagal menyalin otomatis — salin manual dari Ringkasan Otomatis di bawah.'));
    setTimeout(() => setCopyMsg(null), 5000);
  };

  if (loading) return <div className="wrr-loading"><i className="ti ti-loader-2 wrr-spin" /> Memuat laporan...</div>;
  if (error) return <div className="wrr-error"><i className="ti ti-alert-circle" /> {error}</div>;
  if (!report || report.empty) {
    return <div className="wrr-empty"><i className="ti ti-file-report" /><div>{report?.message || 'Belum ada data rekonsiliasi BNI untuk tanggal ini.'}</div></div>;
  }

  const hm = HEALTH_META[report.health_status] || HEALTH_META.YELLOW;
  const s = report.summary;

  return (
    <div className="wrr-daily-report">
      <div className="wrr-daily-report-toolbar wrr-print-hide">
        <button className="wrr-btn" onClick={() => loadReport(date)}><i className="ti ti-refresh" /> Perbarui Laporan</button>
        <button className="wrr-btn" onClick={handleCopy}><i className="ti ti-copy" /> Salin Ringkasan</button>
        <button className="wrr-btn wrr-btn-primary" onClick={handlePrint}><i className="ti ti-printer" /> Cetak / Simpan PDF</button>
        {copyMsg && <span className="wrr-daily-report-copy-msg">{copyMsg}</span>}
      </div>

      <div className="wrr-daily-report-header">
        <div>
          <div className="wrr-daily-report-title">Laporan Rekonsiliasi Harian — Bank BNI</div>
          <div className="wrr-daily-report-sub">
            Tanggal: <strong>{fmtDate(report.meta?.date)}</strong> &middot; Sync terakhir: <strong>{fmtDateTime(report.active_batch?.synced_at)}</strong> &middot; Laporan dibuat: {fmtDateTime(report.generated_at)}
          </div>
        </div>
        <div className="wrr-daily-report-badges">
          <span className={'wrr-daily-report-status wrr-daily-report-status--' + report.report_status.toLowerCase()}>
            {report.report_status === 'RUNNING' ? 'BERJALAN (HARI INI)' : 'SELESAI'}
          </span>
          <span className="wrr-daily-report-health" style={{ background: hm.bg, color: hm.color }}>{hm.label}</span>
        </div>
      </div>

      <div className="wrr-panel wrr-daily-report-summary-box">
        <div className="wrr-panel-title"><i className="ti ti-sparkles" style={{ color: COLOR }} /> Ringkasan Otomatis untuk Direktur</div>
        <p style={{ margin: 0, lineHeight: 1.6 }}>{report.ringkasan_direktur}</p>
      </div>

      <div className="wrr-kpi-grid">
        <KPICard label="Total Transaksi FP" value={fmtN(s?.total_fp)} />
        <KPICard label="Total Nominal FP" value={fmtRp(s?.total_nominal_fp)} />
        <KPICard label="Berhasil Direkonsiliasi" value={fmtN(s?.matched_transaksi)} />
        <KPICard label="Valid Match Rate" value={fmtPct(s?.valid_match_rate_transaction)} />
        <KPICard label="Actionable Exception" value={fmtN(s?.actionable_exception_count)} alert={s?.actionable_exception_count > 0} />
        <KPICard label="Total Funding Credit" value={fmtRp(report.funding_summary?.total_funding_credit)} />
        <KPICard label="Net Cash Movement" value={fmtRp(report.funding_summary?.net_cash_movement)} />
        <KPICard label="Nominal Reversal" value={fmtRp(report.financial_summary?.reversal_nominal)} />
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-chart-donut" style={{ color: COLOR }} /> Ringkasan Status</div>
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>Status</th><th>Jumlah</th><th>Nominal</th></tr></thead>
            <tbody>
              {(report.status_distribution || []).filter(d => d.count > 0).map((d, i) => (
                <tr key={i}><td><StatusBadge status={d.status} /></td><td>{fmtN(d.count)}</td><td>{fmtRp(d.nominal)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-alert-triangle" style={{ color: COLOR }} /> Top 10 Exception</div>
        {(!report.top_10_exception || report.top_10_exception.length === 0) ? (
          <div className="wrr-empty-sub">Tidak ada exception pada tanggal ini.</div>
        ) : (
          <div className="wrr-table-wrap">
            <table className="wrr-table">
              <thead><tr><th>ID Transaksi</th><th>Recipient</th><th>Nominal</th><th>Status</th><th>Outlet</th><th>Produk</th></tr></thead>
              <tbody>
                {report.top_10_exception.map((r, i) => (
                  <tr key={i}>
                    <td>{r.id_transaksi || r.extracted_transaction_id || '-'}</td><td>{r.recipient_name || '-'}</td>
                    <td>{fmtRp(r.fp_nominal)}</td><td><StatusBadge status={r.recon_status} /></td>
                    <td>{r.id_outlet || '-'}</td><td>{r.id_produk || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-shield-check" style={{ color: COLOR }} /> Pemeriksaan Kualitas Data</div>
        {!report.data_quality_warning?.has_issue ? (
          <div className="wrr-empty-sub">Tidak ditemukan masalah kualitas data.</div>
        ) : (
          <div className="wrr-warning-banner wrr-warning-banner-amber">
            <i className="ti ti-alert-triangle" />
            <div><p style={{ margin: 0 }}>{report.data_quality_warning.message}</p></div>
          </div>
        )}
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-list-check" style={{ color: COLOR }} /> Tindak Lanjut Utama</div>
        <ul className="wrr-daily-report-recommend-list">
          {(report.rekomendasi_tindak_lanjut || []).map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Main
   ═══════════════════════════════════════════════════════════════════════ */
export default function WarRoomReconciliationBni() {
  const [date, setDate] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('summary');
  const [auditId, setAuditId] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [syncRequesting, setSyncRequesting] = useState(false);
  const [syncRequestMsg, setSyncRequestMsg] = useState(null);
  const analyticsRequestIdRef = useRef(0);

  const loadAnalytics = useCallback((d) => {
    const myId = ++analyticsRequestIdRef.current;
    setLoading(true); setError(null);
    getReconciliationBniAnalytics(d ? { date: d } : {})
      .then(res => {
        if (myId !== analyticsRequestIdRef.current) return;
        if (d && res && res.empty === false && res.active_batch && res.active_batch.business_date !== d) {
          setError(`Data integrity error: diminta tanggal ${d}, server mengembalikan batch tanggal ${res.active_batch.business_date}. Hasil tidak ditampilkan.`);
          setAnalytics(null);
          return;
        }
        setAnalytics(res);
        if (!d && res?.meta?.date) setDate(res.meta.date);
      })
      .catch(e => { if (myId === analyticsRequestIdRef.current) setError(e.message || 'Gagal memuat analytics'); })
      .finally(() => { if (myId === analyticsRequestIdRef.current) setLoading(false); });
  }, []);

  useEffect(() => { loadAnalytics(date); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDateChange = (d) => { setDate(d); setAnalytics(null); loadAnalytics(d); };
  const handleRefresh = () => loadAnalytics(date);

  const handleExport = () => {
    setExporting(true);
    exportReconciliationBni({ date: date || undefined })
      .then(blob => downloadBlob(blob, `reconciliation-bni-${date || 'export'}.csv`))
      .catch(e => setError(e.message || 'Gagal export CSV'))
      .finally(() => setExporting(false));
  };

  const handleSyncNow = () => {
    setSyncRequesting(true); setSyncRequestMsg(null);
    requestReconciliationSync('BNI')
      .then(res => setSyncRequestMsg(res.message || 'Permintaan sync terkirim.'))
      .catch(e => setSyncRequestMsg(e.response?.data?.error || e.message || 'Gagal mengirim permintaan sync.'))
      .finally(() => setSyncRequesting(false));
  };

  const isEmpty = !loading && !error && analytics?.empty === true;
  const recentBatches = analytics?.recent_batches || [];
  const activeBatchDate = analytics?.active_batch?.business_date || date;

  return (
    <Layout>
      <div className="wrr-page">
        <div className="wrr-header">
          <div className="wrr-header-left">
            <i className="ti ti-building-bank" style={{ color: COLOR, fontSize: 24 }} />
            <div>
              <div className="wrr-header-title">Rekonsiliasi BNI{activeBatchDate ? ` — ${fmtDate(activeBatchDate)}` : ''}</div>
              <div className="wrr-header-sub">Rekonsiliasi transaksi Fastpay terhadap mutasi Bank BNI — matching transaction ID hasil ekstraksi Description, coverage window, funding analysis.</div>
            </div>
          </div>
          <div className="wrr-header-right">
            {recentBatches.length > 0 && (
              <select className="wrr-select" value={date || ''} onChange={e => handleDateChange(e.target.value)}>
                {recentBatches.map(b => (
                  <option key={b.business_date} value={String(b.business_date).slice(0, 10)}>{fmtDate(b.business_date)}</option>
                ))}
              </select>
            )}
            <button className="wrr-btn" onClick={handleSyncNow} disabled={syncRequesting} title="Bukan sync instan — hanya memicu sync lebih cepat via Apps Script checker.">
              <i className="ti ti-refresh-alert" /> {syncRequesting ? 'Mengirim...' : 'Sync Now'}
            </button>
            <button className="wrr-btn" onClick={handleRefresh}><i className="ti ti-refresh" /> Refresh</button>
            {analytics?.meta?.last_sync && (
              <span className="wrr-badge wrr-badge-sync"><i className="ti ti-plug-connected" /> Sync: {fmtDateTime(analytics.meta.last_sync)}</span>
            )}
            <BalanceRequestButton bankCode="BNI" />
          </div>
        </div>
        {syncRequestMsg && <div className="wrr-empty-sub" style={{ marginBottom: 12 }}>{syncRequestMsg}</div>}

        {loading && <div className="wrr-loading"><i className="ti ti-loader-2 wrr-spin" /> Memuat data...</div>}
        {!loading && error && <div className="wrr-error"><i className="ti ti-alert-circle" /> {error}</div>}
        {!loading && !error && isEmpty && (
          <div className="wrr-empty">
            <i className="ti ti-building-bank" />
            <div>{analytics?.message || 'Data rekonsiliasi belum tersedia. Jalankan sync Google Sheet terlebih dahulu.'}</div>
          </div>
        )}

        {!loading && !error && !isEmpty && analytics && (<>
          <div className="wrr-tabs">
            {TABS.map(t => (
              <button key={t.key} className={'wrr-tab-btn' + (activeTab === t.key ? ' wrr-tab-btn--active' : '')} onClick={() => setActiveTab(t.key)}>
                <i className={`ti ${t.icon}`} /> {t.label}
              </button>
            ))}
          </div>

          {activeTab === 'summary' && <SummaryTab analytics={analytics} date={date} />}
          {activeTab === 'hasil' && <ReconTable date={date} scope="all" onOpenAudit={setAuditId} />}
          {activeTab === 'exception' && <ReconTable date={date} scope="exception" onOpenAudit={setAuditId} />}
          {activeTab === 'funding' && <FundingTab analytics={analytics} date={date} />}
          {activeTab === 'time' && <TimeAnalysisTab analytics={analytics} />}
          {activeTab === 'raw' && <RawDataTab analytics={analytics} date={date} onExport={handleExport} exporting={exporting} />}
          {activeTab === 'balance-needs' && (
            <PeriodicBalanceNeeds bankCode="BNI" bankLabel="BNI" themeColor={COLOR} fetchData={getBniPeriodicBalanceNeeds} supportsFundingComparison defaultRange="7d" />
          )}
          {activeTab === 'daily-report' && <DailyReportTab date={date} />}
        </>)}

        {auditId && <AuditLogModal id={auditId} onClose={() => setAuditId(null)} />}
      </div>
    </Layout>
  );
}
