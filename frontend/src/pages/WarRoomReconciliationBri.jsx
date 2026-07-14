import { useState, useEffect, useCallback, useRef } from 'react';
import Layout from '../components/Layout';
import {
  getReconciliationBriAnalytics, getReconciliationBriTransactions, exportReconciliationBriCsv,
  resolveReconciliationBri, getReconciliationBriLogs, getReconciliationBriRawBank,
  getReconciliationBriRawFp, getReconciliationBriResolutionHistory, requestReconciliationSync,
} from '../services/api';

// Halaman ini REUSE layout/komponen generik "wrr-*"/"wrrm-*" yang sudah
// dibangun utk Rekonsiliasi OCBC & Mandiri (tabs/panel/kpi/table/modal/
// pagination/balance-badge/time-bucket/subtabs) — BUKAN spesifik satu bank,
// jadi tidak diduplikasi. Class BARU (prefix wrrbri-*) hanya utk elemen yang
// benar-benar baru di BRI: coverage badge, extraction confidence, id
// conflict, reversal lookup source — lihat index.css.
const COLOR = '#00529C';
const ACCENT = '#0066B3';
const TABS = [
  { key: 'summary', label: 'Executive Summary', icon: 'ti-report-money' },
  { key: 'hasil', label: 'Hasil Rekonsiliasi', icon: 'ti-list-details' },
  { key: 'exception', label: 'Exception Queue', icon: 'ti-alert-triangle' },
  { key: 'fee', label: 'Fee Analysis', icon: 'ti-receipt-2' },
  { key: 'time', label: 'Time & Posting Analysis', icon: 'ti-clock' },
  { key: 'raw', label: 'Raw Data & Audit', icon: 'ti-database' },
];
const EXCEPTION_STATUSES = [
  'PENDING_BANK', 'FP_ONLY', 'BANK_ONLY', 'NOMINAL_MISMATCH', 'FEE_MISMATCH',
  'DUPLICATE_FP', 'DUPLICATE_BANK', 'REVERSAL', 'NEED_REVIEW',
];
const ALL_STATUSES = ['MATCHED', 'MATCHED_NO_FEE', ...EXCEPTION_STATUSES];

/* ─── Format helpers ─── */
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
function fmtMinutes(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '-';
  return `${n.toFixed(0)} menit`;
}

const STATUS_META = {
  MATCHED:           { label: 'Matched',            color: '#059669', bg: '#DCFCE7' },
  MATCHED_NO_FEE:     { label: 'Matched (No Fee)',   color: '#0D9488', bg: '#CCFBF1' },
  PENDING_BANK:       { label: 'Pending Bank',       color: '#B45309', bg: '#FEF3C7' },
  FP_ONLY:            { label: 'FP Only',            color: '#EA580C', bg: '#FFEDD5' },
  BANK_ONLY:          { label: 'Bank Only',          color: '#7C3AED', bg: '#F5F3FF' },
  NOMINAL_MISMATCH:   { label: 'Nominal Mismatch',   color: '#DC2626', bg: '#FEE2E2' },
  FEE_MISMATCH:       { label: 'Fee Mismatch',       color: '#DC2626', bg: '#FEE2E2' },
  DUPLICATE_FP:       { label: 'Duplicate FP',       color: '#BE123C', bg: '#FFE4E6' },
  DUPLICATE_BANK:     { label: 'Duplicate Bank',     color: '#BE123C', bg: '#FFE4E6' },
  REVERSAL:           { label: 'Reversal',           color: '#9333EA', bg: '#F3E8FF' },
  NEED_REVIEW:        { label: 'Need Review',        color: '#6B7280', bg: '#F3F4F6' },
};
function statusMeta(s) { return STATUS_META[s] || STATUS_META.NEED_REVIEW; }

/* ─── UI atoms (sama dengan pola wrr-* OCBC/Mandiri) ─── */
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
function StatusBadge({ status }) {
  const m = statusMeta(status);
  return <span className="wrr-status-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}
function CoverageBadge({ status }) {
  if (!status) return <span>-</span>;
  const label = status === 'IN_FP_COVERAGE' ? 'Dalam Coverage' : 'Di Luar Coverage';
  return <span className={'wrrbri-badge wrrbri-badge--' + status.toLowerCase()}>{label}</span>;
}
function ConfidenceBadge({ confidence }) {
  if (!confidence) return <span>-</span>;
  return <span className={'wrrbri-badge wrrbri-badge--' + confidence.toLowerCase()}>{confidence}</span>;
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
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* Tiga card sejajar di Executive Summary (FP Only / Bank Only / Reversal) —
   pola SAMA dgn Rekonsiliasi OCBC (lihat WarRoomReconciliationOcbc.jsx),
   tabel ringkas ID Trx + Nominal, tinggi seragam & scroll vertikal sendiri
   kalau data banyak (wrr-mini-panel-row / wrr-mini-table-wrap di index.css). */
function StatusMiniTable({ title, status, date, info }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!date) return;
    const myRequestId = ++requestIdRef.current;
    setLoading(true);
    getReconciliationBriTransactions({
      date, status, limit: 200, sort: 'updated_at', order: 'desc',
    })
      .then(res => { if (myRequestId === requestIdRef.current) setRows(res.rows || []); })
      .catch(() => { if (myRequestId === requestIdRef.current) setRows([]); })
      .finally(() => { if (myRequestId === requestIdRef.current) setLoading(false); });
  }, [date, status]);

  return (
    <div className="wrr-panel wrr-mini-panel">
      <div className="wrr-panel-title">
        <i className="ti ti-alert-triangle" style={{ color: COLOR }} /> {title}
        {info && <InfoIcon text={info} />}
      </div>
      {loading && <div className="wrr-empty-sub">Memuat...</div>}
      {!loading && rows.length === 0 && <div className="wrr-empty-sub">Tidak ada data.</div>}
      {!loading && rows.length > 0 && (
        <div className="wrr-table-wrap wrr-mini-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>ID Trx</th><th>Nominal</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.id_transaksi || r.extracted_transaction_id || '-'}</td>
                  <td>{fmtRp(r.fp_nominal !== null ? r.fp_nominal : r.bank_gross_debit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 1 — Executive Summary
   ═══════════════════════════════════════════════════════════════════════ */
function SummaryTab({ analytics, onSelectStatus, date }) {
  const s = analytics?.summary;
  const cov = analytics?.coverage;
  const bv = analytics?.balance_validation;
  const totalException = (analytics?.status_distribution || [])
    .filter(d => EXCEPTION_STATUSES.includes(d.status))
    .reduce((sum, d) => sum + (d.count || 0), 0);
  return (
    <>
      <div className="wrr-panel">
        <div className="wrr-panel-title">
          <i className="ti ti-window" style={{ color: COLOR }} /> Coverage Window
          <InfoIcon text="Rentang waktu yang dianggap valid utk BANK_ONLY/exception — default FP_COVERAGE_WINDOW (waktu FP paling awal/akhir ± toleransi menit). Mutasi BRI di luar rentang ini tidak pernah masuk Exception Queue." />
        </div>
        <div className="wrr-dq-note-grid">
          <div><span className="wrr-dq-note-label">Scope Mode</span><span className="wrr-dq-note-value">{cov?.scope_mode || '-'}</span></div>
          <div><span className="wrr-dq-note-label">Coverage Start</span><span className="wrr-dq-note-value">{fmtDateTime(cov?.coverage_start)}</span></div>
          <div><span className="wrr-dq-note-label">Coverage End</span><span className="wrr-dq-note-value">{fmtDateTime(cov?.coverage_end)}</span></div>
          <div><span className="wrr-dq-note-label">Bank Dalam Coverage</span><span className="wrr-dq-note-value">{fmtN(cov?.bank_in_coverage)}</span></div>
          <div><span className="wrr-dq-note-label">Bank Di Luar Coverage</span><span className="wrr-dq-note-value">{fmtN(cov?.bank_outside_coverage)}</span></div>
          <div><span className="wrr-dq-note-label">Mutasi Di Luar Lingkup (OUT_OF_SCOPE)</span><span className="wrr-dq-note-value">{fmtN(s?.out_of_scope_rows)}</span></div>
        </div>
      </div>

      <div className="wrr-kpi-grid">
        <KPICard label="Total FP" value={fmtN(s?.total_fp)} info="Jumlah total transaksi dari sheet DATA FP utk tanggal yang dipilih." />
        <KPICard label="Total Nominal FP" value={fmtRp(s?.total_fp_nominal)} info="Total nilai (Rupiah) seluruh transaksi FP utk tanggal ini." />
        <KPICard label="ID Transaksi Bank Unik" value={fmtN(s?.unique_bank_transaction_id)} info="Jumlah extracted_transaction_id unik yang berhasil diekstrak dari DESK_TRAN/TRREMK/TLBDS2 mutasi BRI." />
        <KPICard label="Matched Transaksi" value={fmtN((s?.matched_count || 0) + (s?.matched_no_fee || 0))} info="Jumlah transaksi FP yang principal-nya cocok dgn debit BRI (status MATCHED atau MATCHED_NO_FEE)." />
        <KPICard label="Matched Nominal" value={fmtRp(s?.matched_nominal)} info="Total nominal FP dari transaksi yang berhasil dicocokkan ke BRI." />
        <KPICard label="Pending Bank" value={fmtN(s?.pending_bank)} alert={(s?.pending_bank || 0) > 0} info="FP belum ditemukan di BRI, tapi masih dalam grace period (default 30 menit)." />
        <KPICard label="FP Only" value={fmtN(s?.fp_only)} alert={(s?.fp_only || 0) > 0} info="FP tidak ditemukan di BRI setelah grace period selesai." />
        <KPICard label="Bank Only" value={fmtN(s?.bank_only)} alert={(s?.bank_only || 0) > 0} info="Mutasi FASTPAY BRI valid, dalam coverage, tapi tidak ada FP pasangannya." />
        <KPICard label="Nominal Mismatch" value={fmtN(s?.nominal_mismatch)} alert={(s?.nominal_mismatch || 0) > 0} info="Gross debit BRI lebih kecil dari nominal FP — tidak masuk akal sbg principal+fee." />
        <KPICard label="Match Rate Transaksi (Valid)" value={fmtPct(s?.valid_match_rate_transaction)} info="Persentase jumlah transaksi FP yang berhasil dicocokkan." />
        <KPICard label="Match Rate Nominal (Valid)" value={fmtPct(s?.valid_match_rate_nominal)} info="Persentase nilai (Rupiah) transaksi yang berhasil dicocokkan." />
        <KPICard label="Actionable Exception" value={fmtN(totalException)} alert={totalException > 0} info="Total seluruh transaksi berstatus exception (Pending Bank, FP Only, Bank Only, Nominal Mismatch, Fee Mismatch, Duplicate, Reversal, Need Review) yang perlu ditindaklanjuti tim." />
      </div>

      <div className="wrr-mini-panel-row">
        <StatusMiniTable title="FP Only" status="FP_ONLY" date={date}
          info="Transaksi FP yang TIDAK ditemukan di BRI setelah grace period selesai." />
        <StatusMiniTable title="Bank Only" status="BANK_ONLY" date={date}
          info="Mutasi FASTPAY BRI valid, dalam coverage, tapi tidak ada FP pasangannya." />
        <StatusMiniTable title="Reversal" status="REVERSAL" date={date}
          info="Ditemukan mutasi credit/reversal (sebatch atau cross-date lookup) utk id transaksi yang sama." />
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title">
          <i className="ti ti-scale" style={{ color: COLOR }} /> Validasi Saldo BRI
          <InfoIcon text="Per baris mutasi: SALDO_AWAL_MUTASI - MUTASI_DEBET + MUTASI_KREDIT harus sama dgn SALDO_AKHIR_MUTASI. Ini PERINGATAN informatif, TIDAK mengubah recon_status transaksi manapun." />
        </div>
        {!bv ? (
          <div className="wrr-empty-sub">Validasi saldo belum tersedia utk batch ini.</div>
        ) : (
          <div className="wrrm-balance-row">
            <span className={'wrrm-balance-badge wrrm-balance-badge--' + String(bv.status || '').toLowerCase()}>
              {bv.status === 'BALANCED' ? 'SELARAS' : bv.status === 'UNBALANCED' ? 'TIDAK SELARAS' : 'TIDAK DAPAT DIPASTIKAN'}
            </span>
            <span>Baris balanced: {fmtN(bv.balanced_rows)} — unbalanced: {fmtN(bv.unbalanced_rows)} — undetermined: {fmtN(bv.undetermined_rows)}</span>
            <span>Total variance: {fmtRp(bv.total_variance)}</span>
          </div>
        )}
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-chart-donut" style={{ color: COLOR }} /> Distribusi Status</div>
        <div className="wrr-empty-sub" style={{ marginBottom: 8 }}>Klik baris utk lihat daftar transaksinya.</div>
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>Status</th><th>Jumlah Transaksi</th><th>Nominal FP</th></tr></thead>
            <tbody>
              {(analytics?.status_distribution || []).filter(d => d.count > 0).map((d, i) => (
                <tr key={i} className="wrr-row-clickable" onClick={() => onSelectStatus?.(d.status)}>
                  <td><StatusBadge status={d.status} /></td><td>{fmtN(d.count)}</td><td>{fmtRp(d.nominal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Tabel bersama — Tab 2 (Hasil Rekonsiliasi) & Tab 3 (Exception Queue)
   ═══════════════════════════════════════════════════════════════════════ */
function ReconTable({ date, scope, onOpenAudit, initialStatus }) {
  const isException = scope === 'exception';
  const [statusFilter, setStatusFilter] = useState(initialStatus || 'semua');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'updated_at', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [resolveTarget, setResolveTarget] = useState(null);

  useEffect(() => { setPage(1); }, [statusFilter, search, sort, pageSize, date]);

  useEffect(() => {
    if (!date) return;
    setLoading(true); setError(null);
    const statusParam = statusFilter !== 'semua' ? statusFilter : (isException ? EXCEPTION_STATUSES.join(',') : undefined);
    getReconciliationBriTransactions({
      date, status: statusParam, search: search || undefined,
      page, limit: pageSize, sort: sort.key, order: sort.dir,
    })
      .then(res => { setRows(res.rows || []); setTotal(res.meta?.total || 0); })
      .catch(e => setError(e.message || 'Gagal memuat data'))
      .finally(() => setLoading(false));
  }, [date, statusFilter, search, sort, page, pageSize, isException]);

  const handleSort = useCallback((key) => {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' });
  }, []);

  const statusOptions = isException ? EXCEPTION_STATUSES : ALL_STATUSES;

  return (
    <div className="wrr-panel">
      <div className="wrr-filter-row">
        <input className="wrr-search-input" placeholder="Cari ID Transaksi / Outlet / Produk..." value={search} onChange={e => setSearch(e.target.value)} />
        <select className="wrr-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="semua">{isException ? 'Semua Exception' : 'Semua Status'}</option>
          {statusOptions.map(s => <option key={s} value={s}>{statusMeta(s).label}</option>)}
        </select>
      </div>

      {loading && <div className="wrr-empty-sub">Memuat...</div>}
      {!loading && error && <div className="wrr-empty-sub">Gagal memuat: {error}</div>}
      {!loading && !error && rows.length === 0 && <div className="wrr-empty-sub">Tidak ada data utk filter ini.</div>}
      {!loading && !error && rows.length > 0 && (<>
        <div className="wrr-filter-count">Menampilkan {fmtN(rows.length)} dari {fmtN(total)} baris</div>
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead>
              <tr>
                <SortableTh label="ID Transaksi" sortKey="id_transaksi" sort={sort} onSort={handleSort} />
                <th>Produk</th><th>Outlet</th><th>Biller</th>
                <SortableTh label="Nominal FP" sortKey="fp_nominal" sort={sort} onSort={handleSort} />
                <SortableTh label="Gross Debit" sortKey="bank_total_debit" sort={sort} onSort={handleSort} />
                <SortableTh label="Principal" sortKey="bank_principal" sort={sort} onSort={handleSort} />
                <th>Est. Principal</th>
                <SortableTh label="Fee" sortKey="bank_fee" sort={sort} onSort={handleSort} />
                <th>Credit</th>
                <SortableTh label="Selisih Principal" sortKey="variance_principal" sort={sort} onSort={handleSort} />
                <SortableTh label="Selisih Fee" sortKey="variance_fee" sort={sort} onSort={handleSort} />
                <th>Waktu FP</th><th>Waktu BRI</th>
                <SortableTh label="Selisih Waktu" sortKey="time_difference_minutes" sort={sort} onSort={handleSort} />
                <th>Norek</th><th>Extraction</th><th>Coverage</th>
                <SortableTh label="Status" sortKey="recon_status" sort={sort} onSort={handleSort} />
                {isException && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.id_transaksi || r.extracted_transaction_id || '-'}</td>
                  <td>{r.id_produk || '-'}</td>
                  <td>{r.id_outlet || '-'}</td>
                  <td>{r.id_biller || '-'}</td>
                  <td>{fmtRp(r.fp_nominal)}</td>
                  <td>{fmtRp(r.bank_gross_debit)}</td>
                  <td>{fmtRp(r.bank_principal)}</td>
                  <td>{r.estimated_bank_principal !== null ? fmtRp(r.estimated_bank_principal) + ' (est.)' : '-'}</td>
                  <td>{fmtRp(r.bank_fee)}</td>
                  <td>{r.bank_credit ? fmtRp(r.bank_credit) : '-'}</td>
                  <td style={{ color: r.variance_principal ? '#DC2626' : undefined }}>
                    {r.variance_principal === null ? '-' : fmtRp(r.variance_principal)}
                  </td>
                  <td style={{ color: r.variance_fee ? (r.variance_fee === 0 ? undefined : '#DC2626') : undefined }}>
                    {r.variance_fee === null ? '-' : fmtRp(r.variance_fee)}
                  </td>
                  <td>{fmtDateTime(r.fp_time_response)}</td>
                  <td>{fmtDateTime(r.bank_transaction_date)}</td>
                  <td>{r.time_difference_minutes === null || r.time_difference_minutes === undefined ? '-' : fmtMinutes(r.time_difference_minutes)}</td>
                  <td>{r.account_no || '-'}</td>
                  <td>{r.matching_method || '-'}{r.id_conflict ? ' ⚠' : ''}</td>
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
    setSaving(true); setError(null);
    resolveReconciliationBri(target.id, { status, notes: notes || undefined })
      .then(() => onResolved())
      .catch(e => setError(e.response?.data?.error || e.message || 'Gagal menyimpan'))
      .finally(() => setSaving(false));
  };

  return (
    <Modal title={`Resolve — ${target.id_transaksi || target.extracted_transaction_id || target.id}`} onClose={onClose}>
      <div className="wrr-detail-grid" style={{ marginBottom: 16 }}>
        <div><span className="wrr-detail-label">ID Transaksi</span><span className="wrr-detail-value">{target.id_transaksi || target.extracted_transaction_id || '-'}</span></div>
        <div><span className="wrr-detail-label">Norek</span><span className="wrr-detail-value">{target.account_no || '-'}</span></div>
        <div><span className="wrr-detail-label">Nominal FP</span><span className="wrr-detail-value">{fmtRp(target.fp_nominal)}</span></div>
        <div><span className="wrr-detail-label">Status Saat Ini</span><span className="wrr-detail-value"><StatusBadge status={target.recon_status} /></span></div>
      </div>
      <label className="wrr-form-label">Status Baru</label>
      <select className="wrr-select" style={{ width: '100%', marginBottom: 12 }} value={status} onChange={e => setStatus(e.target.value)}>
        {ALL_STATUSES.map(s => <option key={s} value={s}>{statusMeta(s).label}</option>)}
      </select>
      <label className="wrr-form-label">Catatan Penyelesaian</label>
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
    getReconciliationBriLogs(id).then(setLogs).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [id]);

  return (
    <Modal title="Riwayat Audit" onClose={onClose}>
      {loading && <div className="wrr-empty-sub">Memuat...</div>}
      {!loading && error && <div className="wrr-empty-sub">Gagal memuat: {error}</div>}
      {!loading && !error && logs.length === 0 && <div className="wrr-empty-sub">Belum ada riwayat penyelesaian utk baris ini.</div>}
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
   TAB 4 — Fee Analysis
   ═══════════════════════════════════════════════════════════════════════ */
function FeeAnalysisTab({ analytics }) {
  const fa = analytics?.fee_analysis;
  if (!fa) return <div className="wrr-empty-sub">Belum ada data fee utk tanggal ini.</div>;

  const GroupTable = ({ title, rows }) => (
    <div className="wrr-panel">
      <div className="wrr-panel-title"><i className="ti ti-tag" style={{ color: COLOR }} /> {title}</div>
      {(!rows || rows.length === 0) && <div className="wrr-empty-sub">Belum ada data.</div>}
      {rows && rows.length > 0 && (
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>Kategori</th><th>Jumlah Transaksi</th><th>Total Fee</th></tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}><td>{r.key}</td><td>{fmtN(r.count)}</td><td>{fmtRp(r.total_fee)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="wrr-kpi-grid">
        <KPICard label="Expected Fee / Transaksi" value={fmtRpFull(fa.expected_fee)} info="Fee FASTPAY yang seharusnya dikenakan BRI per transaksi (default Rp150, bisa dikonfigurasi per batch)." />
        <KPICard label="Transaksi dengan Fee" value={fmtN(fa.transaction_with_fee_count)} info="Jumlah transaksi yang principal & fee-nya berhasil dipisahkan." />
        <KPICard label="Actual Fee (Total)" value={fmtRp(fa.actual_fee_total)} info="Total fee yang benar-benar terpotong (gross debit - nominal FP)." />
        <KPICard label="Expected Fee (Total)" value={fmtRp(fa.expected_fee_total)} info="Total fee SEHARUSNYA = jumlah transaksi berfee × expected fee." />
        <KPICard label="Fee Variance" value={fmtRp(fa.fee_variance)} alert={Math.abs(fa.fee_variance || 0) > 0} info="Selisih Actual Fee Total dikurangi Expected Fee Total." />
        <KPICard label="Matched Tanpa Fee" value={fmtN(fa.no_fee_count)} info="Transaksi MATCHED_NO_FEE — gross debit persis sama dgn nominal FP." />
        <KPICard label="Fee Tidak Sesuai" value={fmtN(fa.mismatched_fee_count)} alert={(fa.mismatched_fee_count || 0) > 0} info="Jumlah transaksi FEE_MISMATCH." />
      </div>
      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-chart-bar" style={{ color: COLOR }} /> Distribusi Fee</div>
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>Fee</th><th>Jumlah Transaksi</th></tr></thead>
            <tbody>
              {(fa.distribution || []).map((d, i) => (
                <tr key={i}><td>{typeof d.fee === 'number' ? fmtRpFull(d.fee) : d.fee}</td><td>{fmtN(d.count)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <GroupTable title="Fee per Produk" rows={fa.by_produk} />
      <GroupTable title="Fee per Outlet (Top 20)" rows={fa.by_outlet} />
      <GroupTable title="Fee per Biller" rows={fa.by_biller} />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB 5 — Time & Posting Analysis
   ═══════════════════════════════════════════════════════════════════════ */
function TimeAnalysisTab({ analytics }) {
  const ta = analytics?.time_analysis;
  if (!ta) return <div className="wrr-empty-sub">Belum ada data waktu utk tanggal ini.</div>;
  const buckets = [
    { key: 'bucket_0_5', label: '0–5 menit', tone: 'normal' },
    { key: 'bucket_5_15', label: '5–15 menit', tone: 'warning' },
    { key: 'bucket_15_30', label: '15–30 menit', tone: 'delayed' },
    { key: 'bucket_over_30', label: '> 30 menit', tone: 'exception' },
  ];
  return (
    <>
      <div className="wrr-kpi-grid">
        <KPICard label="Rata-rata Selisih Waktu" value={fmtMinutes(ta.average_minutes)} info="Rata-rata selisih (menit) antara time_response FP dan posting BRI, dari transaksi matched." />
        <KPICard label="Median" value={fmtMinutes(ta.median_minutes)} info="Nilai tengah selisih waktu — lebih tahan outlier drpd rata-rata." />
        <KPICard label="P95" value={fmtMinutes(ta.p95_minutes)} info="95% transaksi punya selisih waktu di bawah angka ini." />
        <KPICard label="Maksimum" value={fmtMinutes(ta.maximum_minutes)} info="Selisih waktu terlama pada batch ini." />
      </div>
      <div className="wrr-panel">
        <div className="wrr-panel-title">
          <i className="ti ti-hourglass" style={{ color: COLOR }} /> Distribusi Kategori Keterlambatan
          <InfoIcon text="0-5 menit=normal, 5-15 menit=warning, 15-30 menit=delayed, >30 menit=exception. Indikator kecepatan posting bank, BUKAN pembanding nominal." />
        </div>
        <div className="wrrm-time-bucket-grid">
          {buckets.map(b => (
            <div key={b.key} className={'wrrm-time-bucket-card wrrm-time-bucket-card--' + b.tone}>
              <div className="wrrm-time-bucket-label">{b.label}</div>
              <div className="wrrm-time-bucket-value">{fmtN(ta[b.key])}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-alert-circle" style={{ color: COLOR }} /> Transaksi Posting Terlambat (&gt; 30 menit, Top 50)</div>
        {(!ta.late_postings || ta.late_postings.length === 0) ? (
          <div className="wrr-empty-sub">Tidak ada transaksi dengan keterlambatan posting &gt; 30 menit.</div>
        ) : (
          <div className="wrr-table-wrap">
            <table className="wrr-table">
              <thead><tr><th>ID Transaksi</th><th>Waktu FP</th><th>Waktu BRI</th><th>Selisih Waktu</th><th>Status</th></tr></thead>
              <tbody>
                {ta.late_postings.map((r, i) => (
                  <tr key={i}>
                    <td>{r.id_transaksi || r.extracted_transaction_id || '-'}</td><td>{fmtDateTime(r.fp_time_response)}</td>
                    <td>{fmtDateTime(r.bank_transaction_date)}</td><td>{fmtMinutes(r.time_difference_minutes)}</td>
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
function RawFpSubTab({ date }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const limit = 100;

  useEffect(() => {
    if (!date) return;
    setLoading(true);
    getReconciliationBriRawFp({ date, page, limit }).then(res => { setRows(res.rows || []); setTotal(res.meta?.total || 0); }).finally(() => setLoading(false));
  }, [date, page]);

  if (loading) return <div className="wrr-empty-sub">Memuat...</div>;
  if (!rows.length) return <div className="wrr-empty-sub">Belum ada raw data FP.</div>;
  return (<>
    <div className="wrr-table-wrap">
      <table className="wrr-table">
        <thead><tr><th>Row #</th><th>ID Transaksi</th><th>Nominal</th><th>Produk</th><th>Time Response</th><th>Outlet</th><th>Biller</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.source_row_number ?? '-'}</td><td>{r.id_transaksi}</td><td>{fmtRp(r.nominal)}</td>
              <td>{r.id_produk || '-'}</td><td>{fmtDateTime(r.time_response)}</td><td>{r.id_outlet || '-'}</td><td>{r.id_biller || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <Pagination page={page} pageSize={limit} total={total} onPage={setPage} onPageSize={() => {}} pageSizeOptions={[limit]} />
  </>);
}

function RawBankSubTab({ date }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const limit = 100;

  useEffect(() => {
    if (!date) return;
    setLoading(true);
    getReconciliationBriRawBank({ date, page, limit }).then(res => { setRows(res.rows || []); setTotal(res.meta?.total || 0); }).finally(() => setLoading(false));
  }, [date, page]);

  if (loading) return <div className="wrr-empty-sub">Memuat...</div>;
  if (!rows.length) return <div className="wrr-empty-sub">Belum ada raw data BRI.</div>;
  return (<>
    <div className="wrr-table-wrap">
      <table className="wrr-table">
        <thead>
          <tr>
            <th>Row #</th><th>Norek</th><th>Waktu Transaksi</th><th>Waktu Efektif</th><th>SEQ</th>
            <th>DESK_TRAN</th><th>TRREMK</th><th>TLBDS1</th><th>TLBDS2</th>
            <th>Saldo Awal</th><th>Debit</th><th>Credit</th><th>Saldo Akhir</th>
            <th>Extracted ID</th><th>ID dari DESK_TRAN</th><th>ID dari TRREMK</th><th>ID dari TLBDS2</th>
            <th>Confidence</th><th>Conflict</th><th>Row Type</th><th>Coverage</th><th>Balance Check</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const raw = r.raw_data || {};
            return (
              <tr key={i}>
                <td>{r.source_row_number ?? '-'}</td><td>{r.account_no || '-'}</td>
                <td>{fmtDateTime(r.transaction_date_time)}</td><td>{fmtDate(r.effective_date_time)}</td><td>{r.sequence_no || '-'}</td>
                <td>{r.description || '-'}</td><td>{r.remarks || '-'}</td><td>{r.tlbds1 || '-'}</td><td>{r.tlbds2 || '-'}</td>
                <td>{r.opening_balance !== null ? fmtRp(r.opening_balance) : '-'}</td>
                <td>{r.debit !== null ? fmtRp(r.debit) : '-'}</td><td>{r.credit !== null ? fmtRp(r.credit) : '-'}</td>
                <td>{r.balance !== null ? fmtRp(r.balance) : '-'}</td>
                <td>{r.extracted_transaction_id || '-'}</td>
                <td>{raw.desk_id || '-'}</td><td>{raw.remark_id || '-'}</td><td>{raw.tlbds2_id || '-'}</td>
                <td><ConfidenceBadge confidence={r.extraction_confidence} /></td>
                <td>{r.id_conflict ? '⚠ Ya' : 'Tidak'}</td>
                <td>{r.bank_row_type || '-'}</td>
                <td><CoverageBadge status={r.coverage_status} /></td>
                <td>{r.balance_check_status || '-'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    <Pagination page={page} pageSize={limit} total={total} onPage={setPage} onPageSize={() => {}} pageSizeOptions={[limit]} />
  </>);
}

function SyncHistorySubTab({ analytics }) {
  const meta = analytics?.meta;
  const recentBatches = analytics?.recent_batches || [];
  return (<>
    <div className="wrr-panel">
      <div className="wrr-panel-title"><i className="ti ti-database" style={{ color: COLOR }} /> Info Sync Batch Ini</div>
      <div className="wrr-dq-note-grid">
        <div><span className="wrr-dq-note-label">Batch No</span><span className="wrr-dq-note-value">{meta?.batch_no || '-'}</span></div>
        <div><span className="wrr-dq-note-label">Norek</span><span className="wrr-dq-note-value">{meta?.account_no || '-'}</span></div>
        <div><span className="wrr-dq-note-label">Scope Mode</span><span className="wrr-dq-note-value">{meta?.scope_mode || '-'}</span></div>
        <div><span className="wrr-dq-note-label">Expected Fee</span><span className="wrr-dq-note-value">{fmtRpFull(meta?.expected_fee)}</span></div>
        <div><span className="wrr-dq-note-label">Grace Period</span><span className="wrr-dq-note-value">{meta?.grace_period_minutes ?? '-'} menit</span></div>
        <div><span className="wrr-dq-note-label">Coverage Tolerance</span><span className="wrr-dq-note-value">{meta?.coverage_tolerance_minutes ?? '-'} menit</span></div>
        <div><span className="wrr-dq-note-label">Reversal Lookup Days</span><span className="wrr-dq-note-value">{meta?.reversal_lookup_days ?? '-'} hari</span></div>
        <div><span className="wrr-dq-note-label">Jumlah Baris FP</span><span className="wrr-dq-note-value">{fmtN(meta?.fp_row_count)}</span></div>
        <div><span className="wrr-dq-note-label">Jumlah Baris BRI</span><span className="wrr-dq-note-value">{fmtN(meta?.bank_row_count)}</span></div>
        <div><span className="wrr-dq-note-label">Sync Terakhir</span><span className="wrr-dq-note-value">{fmtDateTime(meta?.last_sync)}</span></div>
      </div>
    </div>
    <div className="wrr-panel">
      <div className="wrr-panel-title"><i className="ti ti-history" style={{ color: COLOR }} /> Riwayat Sync (14 Batch Terakhir)</div>
      {recentBatches.length === 0 && <div className="wrr-empty-sub">Belum ada riwayat sync.</div>}
      {recentBatches.length > 0 && (
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>Batch</th><th>Tanggal</th><th>Norek</th><th>Scope</th><th>Baris FP</th><th>Baris BRI</th><th>Sync Terakhir</th><th>Status</th></tr></thead>
            <tbody>
              {recentBatches.map((b, i) => (
                <tr key={i}>
                  <td>{b.batch_no}</td><td>{fmtDate(b.business_date)}</td><td>{b.account_no || '-'}</td><td>{b.scope_mode || '-'}</td>
                  <td>{fmtN(b.fp_row_count)}</td><td>{fmtN(b.bank_row_count)}</td>
                  <td>{fmtDateTime(b.synced_at)}</td><td>{b.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  </>);
}

function ResolutionHistorySubTab({ date }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!date) return;
    setLoading(true);
    getReconciliationBriResolutionHistory({ date }).then(setLogs).finally(() => setLoading(false));
  }, [date]);

  if (loading) return <div className="wrr-empty-sub">Memuat...</div>;
  if (!logs.length) return <div className="wrr-empty-sub">Belum ada riwayat penyelesaian manual utk tanggal ini. Gunakan tombol "Riwayat" pada baris di Exception Queue utk melihat riwayat 1 transaksi spesifik.</div>;
  return (
    <div className="wrr-table-wrap">
      <table className="wrr-table">
        <thead><tr><th>Waktu</th><th>ID Transaksi</th><th>Aksi</th><th>Status Sebelum</th><th>Status Sesudah</th><th>Catatan</th><th>Oleh</th></tr></thead>
        <tbody>
          {logs.map((l, i) => (
            <tr key={i}>
              <td>{fmtDateTime(l.created_at)}</td><td>{l.id_transaksi || l.extracted_transaction_id || '-'}</td><td>{l.action}</td>
              <td><StatusBadge status={l.status_before} /></td><td><StatusBadge status={l.status_after} /></td>
              <td>{l.notes || '-'}</td><td>{l.created_by || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RawDataTab({ analytics, date, onExport, exporting }) {
  const [subTab, setSubTab] = useState('fp');
  const subTabs = [
    { key: 'fp', label: 'Raw DATA FP' },
    { key: 'bank', label: 'Raw DATA BRI' },
    { key: 'sync', label: 'Sync History' },
    { key: 'resolution', label: 'Resolution History' },
  ];
  return (
    <>
      <div className="wrr-panel">
        <div className="wrr-panel-title-row">
          <div className="wrr-panel-title"><i className="ti ti-database" style={{ color: COLOR }} /> Raw Data & Audit</div>
          <button className="wrr-btn wrr-btn-primary" onClick={onExport} disabled={exporting}>
            <i className="ti ti-download" /> {exporting ? 'Mengekspor...' : 'Export CSV'}
          </button>
        </div>
        <div className="wrrm-subtabs">
          {subTabs.map(t => (
            <button key={t.key} className={'wrrm-subtab-btn' + (subTab === t.key ? ' wrrbri-subtab-btn--active' : '')} onClick={() => setSubTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {subTab === 'fp' && <RawFpSubTab date={date} />}
      {subTab === 'bank' && <RawBankSubTab date={date} />}
      {subTab === 'sync' && <SyncHistorySubTab analytics={analytics} />}
      {subTab === 'resolution' && <ResolutionHistorySubTab date={date} />}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Main
   ═══════════════════════════════════════════════════════════════════════ */
export default function WarRoomReconciliationBri() {
  const [date, setDate] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('summary');
  const [auditId, setAuditId] = useState(null);
  const [jumpStatus, setJumpStatus] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [syncRequesting, setSyncRequesting] = useState(false);
  const [syncRequestMsg, setSyncRequestMsg] = useState(null);

  const handleSelectStatus = useCallback((status) => {
    const targetTab = (status === 'MATCHED' || status === 'MATCHED_NO_FEE') ? 'hasil' : 'exception';
    setJumpStatus(status);
    setActiveTab(targetTab);
  }, []);

  const loadAnalytics = useCallback((d) => {
    setLoading(true); setError(null);
    getReconciliationBriAnalytics(d ? { date: d } : {})
      .then(res => {
        setAnalytics(res);
        if (!d && res?.meta?.date) setDate(res.meta.date);
      })
      .catch(e => setError(e.message || 'Gagal memuat analytics'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadAnalytics(date); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDateChange = (d) => { setDate(d); loadAnalytics(d); };
  const handleRefresh = () => loadAnalytics(date);

  const handleExport = () => {
    setExporting(true);
    exportReconciliationBriCsv({ date: date || undefined })
      .then(blob => downloadBlob(blob, `reconciliation-bri-${date || 'export'}.csv`))
      .catch(e => setError(e.message || 'Gagal export CSV'))
      .finally(() => setExporting(false));
  };

  // Bukan sync instan — Apps Script Web App tidak bisa dipanggil langsung
  // dari browser (kebijakan Google Workspace). Ini hanya mencatat
  // permintaan; trigger checker Apps Script (jalan tiap 1 menit) yang
  // benar-benar sync dalam ~1-2 menit berikutnya.
  const handleSyncNow = () => {
    setSyncRequesting(true); setSyncRequestMsg(null);
    requestReconciliationSync('BRI')
      .then(res => setSyncRequestMsg(res.message || 'Permintaan sync terkirim.'))
      .catch(e => setSyncRequestMsg(e.response?.data?.error || e.message || 'Gagal mengirim permintaan sync.'))
      .finally(() => setSyncRequesting(false));
  };

  const isEmpty = !loading && !error && analytics?.empty === true;
  const recentBatches = analytics?.recent_batches || [];

  return (
    <Layout>
      <div className="wrr-page">
        <div className="wrr-header">
          <div className="wrr-header-left">
            <i className="ti ti-building-bank" style={{ color: COLOR, fontSize: 24 }} />
            <div>
              <div className="wrr-header-title">Rekonsiliasi BRI</div>
              <div className="wrr-header-sub">Rekonsiliasi transaksi FP terhadap mutasi Bank BRI — ekstraksi ID dari DESK_TRAN/TRREMK/TLBDS2, fee FASTPAY Rp150, coverage window, dan exception queue.</div>
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
            <button
              className="wrr-btn"
              onClick={handleSyncNow}
              disabled={syncRequesting}
              title='Bukan sync instan — Apps Script Web App tidak bisa dipanggil langsung dari browser (kebijakan Google Workspace). Ini hanya memicu sync lebih cepat (~1-2 menit), bukan seketika.'
            >
              <i className="ti ti-refresh-alert" /> {syncRequesting ? 'Mengirim...' : 'Sync Now'}
            </button>
            <button className="wrr-btn" onClick={handleRefresh}><i className="ti ti-refresh" /> Refresh</button>
            {analytics?.meta?.last_sync && (
              <span className="wrr-badge wrr-badge-sync" style={{ background: ACCENT, color: '#fff' }}><i className="ti ti-plug-connected" /> Sync: {fmtDateTime(analytics.meta.last_sync)}</span>
            )}
          </div>
        </div>
        {syncRequestMsg && <div className="wrr-empty-sub" style={{ marginBottom: 12 }}>{syncRequestMsg}</div>}

        {loading && <div className="wrr-loading"><i className="ti ti-loader-2 wrr-spin" /> Memuat data...</div>}
        {!loading && error && <div className="wrr-error"><i className="ti ti-alert-circle" /> {error}</div>}
        {!loading && !error && isEmpty && (
          <div className="wrr-empty">
            <i className="ti ti-building-bank" />
            <div>{analytics?.message || 'Data rekonsiliasi BRI belum tersedia. Jalankan sync Google Sheet terlebih dahulu.'}</div>
          </div>
        )}

        {!loading && !error && !isEmpty && analytics && (<>
          <div className="wrr-tabs">
            {TABS.map(t => (
              <button key={t.key} className={'wrr-tab-btn' + (activeTab === t.key ? ' wrr-tab-btn--active' : '')} onClick={() => { setJumpStatus(null); setActiveTab(t.key); }}>
                <i className={`ti ${t.icon}`} /> {t.label}
              </button>
            ))}
          </div>

          {activeTab === 'summary' && <SummaryTab analytics={analytics} onSelectStatus={handleSelectStatus} date={date} />}
          {activeTab === 'hasil' && <ReconTable date={date} scope="all" onOpenAudit={setAuditId} initialStatus={jumpStatus} />}
          {activeTab === 'exception' && <ReconTable date={date} scope="exception" onOpenAudit={setAuditId} initialStatus={jumpStatus} />}
          {activeTab === 'fee' && <FeeAnalysisTab analytics={analytics} />}
          {activeTab === 'time' && <TimeAnalysisTab analytics={analytics} />}
          {activeTab === 'raw' && <RawDataTab analytics={analytics} date={date} onExport={handleExport} exporting={exporting} />}
        </>)}

        {auditId && <AuditLogModal id={auditId} onClose={() => setAuditId(null)} />}
      </div>
    </Layout>
  );
}
