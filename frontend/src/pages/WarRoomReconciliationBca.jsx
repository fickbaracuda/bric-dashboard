import { useState, useEffect, useCallback, useRef } from 'react';
import Layout from '../components/Layout';
import {
  getReconciliationBcaAnalytics, getReconciliationBcaTransactions, exportReconciliationBca,
  resolveReconciliationBca, getReconciliationBcaLogs, getReconciliationBcaRawBank,
  getReconciliationBcaRawFp, getReconciliationBcaResolutionHistory, getReconciliationBcaDailyReport,
  requestReconciliationSync, getBcaPeriodicBalanceNeeds,
} from '../services/api';
import BalanceRequestButton from '../components/reconciliation/BalanceRequestButton';
import PeriodicBalanceNeeds from '../components/reconciliation/PeriodicBalanceNeeds';

// Halaman ini REUSE layout/komponen generik "wrr-*" yang sudah dibangun utk
// Rekonsiliasi OCBC/Mandiri/BRI/BRI BI-FAST/BNI existing — MODUL BARU,
// TERPISAH, TIDAK mengubah file/route/adapter bank lain sama sekali.
//
// Beda mendasar dari bank lain: matching key = id_transaksi FP <-> ID hasil
// ekstraksi dari "Keterangan" (angka setelah slash TERAKHIR), TIDAK ada
// konsep fee terpisah (bank_fee selalu 0), TIDAK ada FP coverage window
// (scope_mode selalu FULL_BUSINESS_DATE), dan validasi saldo memakai
// vocabulary sendiri (BALANCE_CONTINUITY_OK/MISMATCH/ORDERING_UNCERTAIN/
// INSUFFICIENT_DATA — lihat backend/src/reconciliation/bcaAdapter.js).
const COLOR = '#0033A0';
const TABS = [
  { key: 'summary', label: 'Ringkasan', icon: 'ti-report-money' },
  { key: 'matched', label: 'Matched', icon: 'ti-circle-check' },
  { key: 'fp-not-found', label: 'FP Tidak Ditemukan di Bank', icon: 'ti-file-off' },
  { key: 'bank-not-found', label: 'Bank Tidak Ditemukan di FP', icon: 'ti-building-bank' },
  { key: 'mismatch', label: 'Amount Mismatch', icon: 'ti-alert-triangle' },
  { key: 'duplicate', label: 'Duplicate', icon: 'ti-copy' },
  { key: 'credit', label: 'Credit & Reversal', icon: 'ti-cash' },
  { key: 'unparseable', label: 'Unparseable', icon: 'ti-help-circle' },
  { key: 'semua', label: 'Semua Transaksi', icon: 'ti-list-details' },
  { key: 'raw', label: 'Audit Sync', icon: 'ti-database' },
  { key: 'balance-needs', label: 'Kebutuhan Saldo', icon: 'ti-report-money' },
  { key: 'daily-report', label: 'Laporan Harian', icon: 'ti-file-report' },
];

const EXCEPTION_STATUSES = [
  'FP_NOT_FOUND_IN_BANK', 'BANK_NOT_FOUND_IN_FP', 'AMOUNT_MISMATCH',
  'DUPLICATE_FP_TRANSACTION_ID', 'DUPLICATE_BANK_TRANSACTION_ID',
  'MULTIPLE_BANK_ROWS_SAME_ID', 'UNPARSEABLE_REFERENCE', 'UNKNOWN', 'REQUIRES_MAPPING_REVIEW',
];
const ALL_STATUSES = ['MATCHED', 'MATCHED_AMOUNT_EXACT', 'CREDIT_TRANSACTION', 'REVERSAL', ...EXCEPTION_STATUSES];

/* Peta tab -> filter status tetap (lihat spec section 16). */
const TAB_STATUS_FILTER = {
  matched: ['MATCHED', 'MATCHED_AMOUNT_EXACT'],
  'fp-not-found': ['FP_NOT_FOUND_IN_BANK'],
  'bank-not-found': ['BANK_NOT_FOUND_IN_FP'],
  mismatch: ['AMOUNT_MISMATCH'],
  duplicate: ['DUPLICATE_FP_TRANSACTION_ID', 'DUPLICATE_BANK_TRANSACTION_ID', 'MULTIPLE_BANK_ROWS_SAME_ID'],
  credit: ['CREDIT_TRANSACTION', 'REVERSAL'],
  unparseable: ['UNPARSEABLE_REFERENCE', 'UNKNOWN', 'REQUIRES_MAPPING_REVIEW'],
};

/* ─── Format helpers (identik dgn OCBC/Mandiri/BRI/BNI existing) ─── */
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
function maskAccountNo(v) {
  const s = String(v || '').trim();
  if (s.length <= 6) return s || '-';
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(s.length - 8, 3))}${s.slice(-4)}`;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const STATUS_META = {
  MATCHED:                       { label: 'Matched',                    color: '#059669', bg: '#DCFCE7' },
  MATCHED_AMOUNT_EXACT:          { label: 'Matched (Amount Exact)',      color: '#059669', bg: '#DCFCE7' },
  FP_NOT_FOUND_IN_BANK:          { label: 'FP Tidak Ditemukan di Bank',  color: '#B45309', bg: '#FEF3C7' },
  BANK_NOT_FOUND_IN_FP:          { label: 'Bank Tidak Ditemukan di FP',  color: '#EA580C', bg: '#FFEDD5' },
  AMOUNT_MISMATCH:               { label: 'Amount Mismatch',             color: '#DC2626', bg: '#FEE2E2' },
  DUPLICATE_FP_TRANSACTION_ID:   { label: 'Duplicate FP Transaction ID', color: '#BE123C', bg: '#FFE4E6' },
  DUPLICATE_BANK_TRANSACTION_ID: { label: 'Duplicate Bank Transaction ID', color: '#BE123C', bg: '#FFE4E6' },
  MULTIPLE_BANK_ROWS_SAME_ID:    { label: 'Multiple Bank Rows (Same ID)', color: '#6B7280', bg: '#F3F4F6' },
  CREDIT_TRANSACTION:            { label: 'Credit Transaction',          color: '#2563EB', bg: '#DBEAFE' },
  REVERSAL:                      { label: 'Reversal',                   color: '#9333EA', bg: '#F3E8FF' },
  UNPARSEABLE_REFERENCE:         { label: 'Unparseable Reference',       color: '#7C3AED', bg: '#F5F3FF' },
  UNKNOWN:                       { label: 'Unknown',                    color: '#6B7280', bg: '#F3F4F6' },
  REQUIRES_MAPPING_REVIEW:       { label: 'Requires Mapping Review',     color: '#2563EB', bg: '#DBEAFE' },
};
function statusMeta(s) { return STATUS_META[s] || STATUS_META.UNKNOWN; }
function StatusBadge({ status }) {
  if (!status) return <span className="wrr-status-badge" style={{ background: '#F3F4F6', color: '#9CA3AF' }}>-</span>;
  const m = statusMeta(status);
  return <span className="wrr-status-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}

/* ─── UI atoms (identik dgn OCBC/Mandiri/BNI) ─── */
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
   TAB — Ringkasan
   ═══════════════════════════════════════════════════════════════════════ */
function MiniExceptionTable({ title, statuses, date }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!date) return;
    const myId = ++requestIdRef.current;
    setLoading(true);
    getReconciliationBcaTransactions({ date, status: statuses.join(','), limit: 100, sort: 'updated_at', order: 'desc' })
      .then(res => { if (myId === requestIdRef.current) setRows(res.rows || []); })
      .catch(() => { if (myId === requestIdRef.current) setRows([]); })
      .finally(() => { if (myId === requestIdRef.current) setLoading(false); });
  }, [date, statuses]);

  return (
    <div className="wrr-panel wrr-mini-panel">
      <div className="wrr-panel-title"><i className="ti ti-alert-triangle" style={{ color: COLOR }} /> {title}</div>
      {loading && <div className="wrr-empty-sub">Memuat...</div>}
      {!loading && rows.length === 0 && <div className="wrr-empty-sub">Tidak ada data.</div>}
      {!loading && rows.length > 0 && (
        <div className="wrr-table-wrap wrr-mini-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>ID / Reference</th><th>Nominal</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}><td>{r.id_transaksi || r.reference_no || '-'}</td><td>{fmtRp(r.fp_nominal !== null ? r.fp_nominal : r.bank_principal)}</td></tr>
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
  const bc = analytics?.balance_continuity;
  const cb = analytics?.current_balance;
  const dq = analytics?.data_quality_warning;
  return (
    <>
      <div className="wrr-kpi-grid">
        <KPICard label="Total Data FP" value={fmtN(s?.total_data_fp)} />
        <KPICard label="Total Mutasi BCA" value={fmtN(s?.total_mutasi_bca)} />
        <KPICard label="Matched" value={fmtN(s?.matched)} />
        <KPICard label="FP Tidak Ditemukan di Bank" value={fmtN(s?.fp_not_found_in_bank_count)} alert={(s?.fp_not_found_in_bank_count || 0) > 0} />
        <KPICard label="Bank Tidak Ditemukan di FP" value={fmtN(s?.bank_not_found_in_fp_count)} alert={(s?.bank_not_found_in_fp_count || 0) > 0} />
        <KPICard label="Amount Mismatch" value={fmtN(s?.amount_mismatch_count)} alert={(s?.amount_mismatch_count || 0) > 0} />
        <KPICard label="Duplicate" value={fmtN(s?.duplicate_count)} alert={(s?.duplicate_count || 0) > 0} />
        <KPICard label="Unparseable" value={fmtN(s?.unparseable_count)} alert={(s?.unparseable_count || 0) > 0} />
        <KPICard label="Total Nominal FP" value={fmtRp(s?.total_nominal_fp)} />
        <KPICard label="Total Debit BCA" value={fmtRp(s?.total_debit_bca)} />
        <KPICard label="Selisih Nominal" value={fmtRp(s?.selisih_nominal)} alert={Math.abs(Number(s?.selisih_nominal) || 0) > 0} />
        <KPICard label="Saldo BCA Terakhir" value={fmtRpFull(analytics?.saldo_bca_terakhir)} info="Sumber: Saldo Akhir dari footer sheet Data Bank BCA (bank-computed), fallback ke saldo baris terakhir menurut urutan terverifikasi kalau footer tidak tersedia." />
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-scale" style={{ color: COLOR }} /> Validasi Kontinuitas Saldo
          <InfoIcon text="Pengecekan TERPISAH dari matching FP — balance[i] = balance[i-1] - debit[i] + credit[i], arah urutan (ASC/DESC) dideteksi otomatis, tidak diasumsikan." /></div>
        {!bc ? <div className="wrr-empty-sub">Belum ada data.</div> : (
          <div className="wrr-dq-note-grid">
            <div><span className="wrr-dq-note-label">Status</span><span className="wrr-dq-note-value">{bc.status}</span></div>
            <div><span className="wrr-dq-note-label">Arah Urutan Terdeteksi</span><span className="wrr-dq-note-value">{bc.direction || '-'}</span></div>
            <div><span className="wrr-dq-note-label">Baris Diperiksa</span><span className="wrr-dq-note-value">{fmtN(bc.checked)}</span></div>
            <div><span className="wrr-dq-note-label">Baris Cocok</span><span className="wrr-dq-note-value">{fmtN(bc.matched)}</span></div>
            <div><span className="wrr-dq-note-label">Mismatch</span><span className="wrr-dq-note-value">{fmtN(bc.mismatch_count)}</span></div>
          </div>
        )}
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-building-bank" style={{ color: COLOR }} /> Saldo Rekening
          <InfoIcon text="saldo_awal/saldo_akhir dibaca APA ADANYA dari footer sheet Data Bank BCA (angka resmi bank), BUKAN dihitung ulang dari total transaksi FP." /></div>
        {!cb ? <div className="wrr-empty-sub">Belum ada data.</div> : (
          <div className="wrr-dq-note-grid">
            <div><span className="wrr-dq-note-label">Saldo Awal</span><span className="wrr-dq-note-value">{fmtRpFull(cb.saldo_awal)}</span></div>
            <div><span className="wrr-dq-note-label">Saldo Akhir</span><span className="wrr-dq-note-value">{fmtRpFull(cb.saldo_akhir)}</span></div>
            <div><span className="wrr-dq-note-label">Mutasi Debet</span><span className="wrr-dq-note-value">{fmtRpFull(cb.mutasi_debet_total)} ({fmtN(cb.mutasi_debet_count)} baris)</span></div>
            <div><span className="wrr-dq-note-label">Mutasi Kredit</span><span className="wrr-dq-note-value">{fmtRpFull(cb.mutasi_kredit_total)} ({fmtN(cb.mutasi_kredit_count)} baris)</span></div>
            <div><span className="wrr-dq-note-label">Sumber</span><span className="wrr-dq-note-value">{cb.source === 'sheet_footer' ? 'Footer Sheet (resmi)' : 'Fallback urutan baris'}</span></div>
          </div>
        )}
      </div>

      {dq && (
        <div className="wrr-panel">
          <div className="wrr-panel-title"><i className="ti ti-shield-check" style={{ color: COLOR }} /> Data Quality Warning</div>
          {!dq.has_issue ? (
            <div className="wrr-empty-sub">Tidak ditemukan pelanggaran integritas data.</div>
          ) : (
            <div className="wrr-warning-banner wrr-warning-banner-amber">
              <i className="ti ti-alert-triangle" />
              <div><p style={{ margin: 0 }}>{dq.message}</p></div>
            </div>
          )}
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
        <MiniExceptionTable title="FP Tidak Ditemukan di Bank" statuses={['FP_NOT_FOUND_IN_BANK']} date={date} />
        <MiniExceptionTable title="Bank Tidak Ditemukan di FP" statuses={['BANK_NOT_FOUND_IN_FP']} date={date} />
        <MiniExceptionTable title="Amount Mismatch" statuses={['AMOUNT_MISMATCH']} date={date} />
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Tabel bersama — dipakai oleh tab Matched/FP Tidak Ditemukan/Bank Tidak
   Ditemukan/Amount Mismatch/Duplicate/Credit & Reversal/Unparseable/Semua
   Transaksi (parameterized by fixedStatuses).
   ═══════════════════════════════════════════════════════════════════════ */
function ReconTable({ date, fixedStatuses, allowFilter, onOpenAudit }) {
  const [statusFilter, setStatusFilter] = useState('semua');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'updated_at', dir: 'desc' });
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
    const statusParam = fixedStatuses ? fixedStatuses.join(',') : (statusFilter !== 'semua' ? statusFilter : undefined);
    getReconciliationBcaTransactions({
      date, status: statusParam, search: search || undefined,
      page, limit: pageSize, sort: sort.key, order: sort.dir,
    })
      .then(res => { if (myId !== requestIdRef.current) return; setRows(res.rows || []); setTotal(res.meta?.total || 0); })
      .catch(e => { if (myId === requestIdRef.current) setError(e.message || 'Gagal memuat data'); })
      .finally(() => { if (myId === requestIdRef.current) setLoading(false); });
  }, [date, statusFilter, search, sort, page, pageSize, fixedStatuses]);

  const handleSort = useCallback((key) => {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' });
  }, []);

  return (
    <div className="wrr-panel">
      <div className="wrr-filter-row">
        <input className="wrr-search-input" placeholder="Cari ID Transaksi / Reference / Outlet / Catatan..." value={search} onChange={e => setSearch(e.target.value)} />
        {allowFilter && (
          <select className="wrr-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="semua">Semua Status</option>
            {ALL_STATUSES.map(s => <option key={s} value={s}>{statusMeta(s).label}</option>)}
          </select>
        )}
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
                <SortableTh label="ID Transaksi FP" sortKey="id_transaksi" sort={sort} onSort={handleSort} />
                <th>ID Hasil Ekstraksi BCA</th>
                <th>Produk</th><th>Outlet</th><th>Biller</th>
                <SortableTh label="Nominal FP" sortKey="fp_nominal" sort={sort} onSort={handleSort} />
                <SortableTh label="Debit BCA" sortKey="bank_principal" sort={sort} onSort={handleSort} />
                <SortableTh label="Selisih" sortKey="variance_principal" sort={sort} onSort={handleSort} />
                <th>Waktu FP</th>
                <SortableTh label="Tanggal Bank" sortKey="bank_transaction_date" sort={sort} onSort={handleSort} />
                <SortableTh label="Status" sortKey="recon_status" sort={sort} onSort={handleSort} />
                <th>Alasan</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.id_transaksi || '-'}</td>
                  <td>{r.reference_no || '-'}</td>
                  <td>{r.id_produk || '-'}</td>
                  <td>{r.id_outlet || '-'}</td>
                  <td>{r.id_biller || '-'}</td>
                  <td>{fmtRp(r.fp_nominal)}</td>
                  <td>{fmtRp(r.bank_principal)}</td>
                  <td style={{ color: r.variance_principal ? '#DC2626' : undefined }}>{r.variance_principal === null ? '-' : fmtRp(r.variance_principal)}</td>
                  <td>{fmtDateTime(r.fp_time_response)}</td>
                  <td>{fmtDate(r.bank_transaction_date)}</td>
                  <td><StatusBadge status={r.recon_status} /></td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 260 }}>{r.notes || '-'}</td>
                  <td>
                    <div className="wrr-row-actions">
                      <button className="wrr-link-btn" onClick={() => setResolveTarget(r)}>Resolve</button>
                      <button className="wrr-link-btn" onClick={() => onOpenAudit(r.id)}>Riwayat</button>
                    </div>
                  </td>
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
    if (!notes.trim()) { setError('Catatan (alasan override) wajib diisi.'); return; }
    setSaving(true); setError(null);
    resolveReconciliationBca(target.id, { status, notes })
      .then(() => onResolved())
      .catch(e => setError(e.response?.data?.error || e.message || 'Gagal menyimpan'))
      .finally(() => setSaving(false));
  };

  return (
    <Modal title={`Resolve — ${target.id_transaksi || target.reference_no || target.id}`} onClose={onClose}>
      <div className="wrr-detail-grid" style={{ marginBottom: 16 }}>
        <div><span className="wrr-detail-label">ID Transaksi FP</span><span className="wrr-detail-value">{target.id_transaksi || '-'}</span></div>
        <div><span className="wrr-detail-label">ID Hasil Ekstraksi BCA</span><span className="wrr-detail-value">{target.reference_no || '-'}</span></div>
        <div><span className="wrr-detail-label">Nominal FP</span><span className="wrr-detail-value">{fmtRp(target.fp_nominal)}</span></div>
        <div><span className="wrr-detail-label">Status Saat Ini (otomatis)</span><span className="wrr-detail-value"><StatusBadge status={target.recon_status} /></span></div>
      </div>
      <label className="wrr-form-label">Status Baru (final_status)</label>
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
    getReconciliationBcaLogs(id).then(setLogs).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [id]);

  return (
    <Modal title="Riwayat Audit — automatic_status vs final_status" onClose={onClose}>
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
   TAB — Audit Sync (Raw Data FP/Bank BCA/Sync History/Resolution History)
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
    const loader = subTab === 'fp' ? getReconciliationBcaRawFp({ date, limit: 500 })
      : subTab === 'bank' ? getReconciliationBcaRawBank({ date, limit: 500 })
      : subTab === 'resolution' ? getReconciliationBcaResolutionHistory({ date })
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
            <i className="ti ti-download" /> {exporting ? 'Mengekspor...' : 'Export Hasil (CSV)'}
          </button>
        </div>
        <div className="wrr-dq-note-grid">
          <div><span className="wrr-dq-note-label">Batch No</span><span className="wrr-dq-note-value">{meta?.batch_no || '-'}</span></div>
          <div><span className="wrr-dq-note-label">Jumlah Baris FP</span><span className="wrr-dq-note-value">{fmtN(meta?.fp_row_count)}</span></div>
          <div><span className="wrr-dq-note-label">Jumlah Baris Bank</span><span className="wrr-dq-note-value">{fmtN(meta?.bank_row_count)}</span></div>
          <div><span className="wrr-dq-note-label">Sync Terakhir</span><span className="wrr-dq-note-value">{fmtDateTime(meta?.last_sync)}</span></div>
          <div><span className="wrr-dq-note-label">No. Rekening (masked)</span><span className="wrr-dq-note-value">{meta?.account_no ? maskAccountNo(meta.account_no) : 'Tidak tersedia'}</span></div>
        </div>
      </div>

      <div className="wrr-tabs" style={{ marginBottom: 12 }}>
        {[{ key: 'fp', label: 'Raw Data FP' }, { key: 'bank', label: 'Raw Data Bank BCA' }, { key: 'history', label: 'Sync History' }, { key: 'resolution', label: 'Resolution History' }].map(t => (
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
                <th>Row (Source Row)</th><th>Tanggal Transaksi</th><th>Keterangan</th>
                <th>Debit</th><th>Credit</th><th>Saldo Setelah Transaksi</th>
                <th>ID Hasil Ekstraksi</th><th>Row Type</th><th>Extraction Method</th>
              </tr>
            </thead>
            <tbody>
              {rawBank.map((r, i) => (
                <tr key={i}>
                  <td>{r.source_row_number ?? '-'}</td><td>{fmtDate(r.transaction_date)}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 360 }}>{r.description || '-'}</td>
                  <td>{fmtRp(r.debit)}</td><td>{fmtRp(r.credit)}</td><td>{fmtRpFull(r.balance)}</td>
                  <td>{r.extracted_transaction_id || '-'}</td><td>{r.bank_row_type || '-'}</td><td>{r.extraction_method || '-'}</td>
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
                  <td>{fmtDateTime(l.created_at)}</td><td>{l.id_transaksi || l.reference_no || '-'}</td><td>{l.action}</td>
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
   TAB — Laporan Harian
   ═══════════════════════════════════════════════════════════════════════ */
const HEALTH_META = {
  GREEN:  { label: 'GREEN',  color: '#059669', bg: '#DCFCE7' },
  YELLOW: { label: 'YELLOW', color: '#B45309', bg: '#FEF3C7' },
  RED:    { label: 'RED',    color: '#DC2626', bg: '#FEE2E2' },
};
function buildDailyReportCopyText(report) {
  const lines = [
    `Laporan Rekonsiliasi BCA — ${fmtDate(report.meta?.date)}`,
    `Status: ${report.health_status} (${report.report_status === 'RUNNING' ? 'Berjalan' : 'Selesai'})`,
    '', report.ringkasan_direktur, '',
    `Total Transaksi FP: ${fmtN(report.total_fp)}`,
    `Total Nominal FP: ${fmtRp(report.total_nominal_fp)}`,
    `Berhasil Direkonsiliasi: ${fmtN(report.matched_transaksi)}`,
    `Valid Match Rate: ${fmtPct(report.valid_match_rate_transaction)}`,
    `Actionable Exception: ${fmtN(report.actionable_exception_count)}`,
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
    getReconciliationBcaDailyReport({ date: d })
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
    return <div className="wrr-empty"><i className="ti ti-file-report" /><div>{report?.message || 'Belum ada data rekonsiliasi BCA untuk tanggal ini.'}</div></div>;
  }

  const hm = HEALTH_META[report.health_status] || HEALTH_META.YELLOW;

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
          <div className="wrr-daily-report-title">Laporan Rekonsiliasi Harian — Bank BCA</div>
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
        <KPICard label="Total Transaksi FP" value={fmtN(report.total_fp)} />
        <KPICard label="Total Nominal FP" value={fmtRp(report.total_nominal_fp)} />
        <KPICard label="Berhasil Direkonsiliasi" value={fmtN(report.matched_transaksi)} />
        <KPICard label="Valid Match Rate" value={fmtPct(report.valid_match_rate_transaction)} />
        <KPICard label="Actionable Exception" value={fmtN(report.actionable_exception_count)} alert={report.actionable_exception_count > 0} />
        <KPICard label="Validasi Saldo" value={report.balance_continuity?.status || '-'} />
        <KPICard label="Saldo Akhir" value={fmtRpFull(report.current_balance?.saldo_akhir)} />
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
              <thead><tr><th>ID Transaksi</th><th>Reference</th><th>Nominal</th><th>Status</th><th>Outlet</th><th>Produk</th></tr></thead>
              <tbody>
                {report.top_10_exception.map((r, i) => (
                  <tr key={i}>
                    <td>{r.id_transaksi || '-'}</td><td>{r.reference_no || '-'}</td>
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
export default function WarRoomReconciliationBca() {
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
    getReconciliationBcaAnalytics(d ? { date: d } : {})
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
    exportReconciliationBca({ date: date || undefined })
      .then(blob => downloadBlob(blob, `reconciliation-bca-${date || 'export'}.csv`))
      .catch(e => setError(e.message || 'Gagal export CSV'))
      .finally(() => setExporting(false));
  };

  const handleSyncNow = () => {
    setSyncRequesting(true); setSyncRequestMsg(null);
    requestReconciliationSync('BCA')
      .then(res => setSyncRequestMsg(res.message || 'Permintaan sync terkirim.'))
      .catch(e => setSyncRequestMsg(e.response?.data?.error || e.message || 'Gagal mengirim permintaan sync.'))
      .finally(() => setSyncRequesting(false));
  };

  const isEmpty = !loading && !error && analytics?.empty === true;
  const recentBatches = analytics?.recent_batches || [];
  const activeBatchDate = analytics?.active_batch?.business_date || date;
  const meta = analytics?.meta;

  return (
    <Layout>
      <div className="wrr-page">
        <div className="wrr-header">
          <div className="wrr-header-left">
            <i className="ti ti-building-bank" style={{ color: COLOR, fontSize: 24 }} />
            <div>
              <div className="wrr-header-title">Rekonsiliasi BCA{activeBatchDate ? ` — ${fmtDate(activeBatchDate)}` : ''}</div>
              <div className="wrr-header-sub">Pencocokan transaksi Data FP dengan mutasi rekening BCA.{meta?.account_no ? ` No. rekening ${maskAccountNo(meta.account_no)}.` : ''}</div>
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
              <i className="ti ti-refresh-alert" /> {syncRequesting ? 'Mengirim...' : 'Sync Data'}
            </button>
            <button className="wrr-btn" onClick={handleRefresh}><i className="ti ti-refresh" /> Refresh</button>
            {analytics?.meta?.last_sync && (
              <span className="wrr-badge wrr-badge-sync"><i className="ti ti-plug-connected" /> Sync: {fmtDateTime(analytics.meta.last_sync)}</span>
            )}
            <BalanceRequestButton bankCode="BCA" />
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
          {activeTab === 'semua' && <ReconTable date={date} fixedStatuses={null} allowFilter onOpenAudit={setAuditId} />}
          {TAB_STATUS_FILTER[activeTab] && (
            <ReconTable date={date} fixedStatuses={TAB_STATUS_FILTER[activeTab]} allowFilter={false} onOpenAudit={setAuditId} />
          )}
          {activeTab === 'raw' && <RawDataTab analytics={analytics} date={date} onExport={handleExport} exporting={exporting} />}
          {activeTab === 'balance-needs' && (
            <PeriodicBalanceNeeds bankCode="BCA" bankLabel="BCA" themeColor={COLOR} fetchData={getBcaPeriodicBalanceNeeds} supportsFundingComparison={false} defaultRange="7d" />
          )}
          {activeTab === 'daily-report' && <DailyReportTab date={date} />}
        </>)}

        {auditId && <AuditLogModal id={auditId} onClose={() => setAuditId(null)} />}
      </div>
    </Layout>
  );
}
