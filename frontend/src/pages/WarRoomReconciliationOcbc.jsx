import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Layout from '../components/Layout';
import {
  getReconciliationAnalytics, getReconciliationTransactions, exportReconciliationCsv,
  resolveReconciliation, getReconciliationLogs, requestReconciliationSync,
} from '../services/api';

const COLOR = '#DC2626';
const TABS = [
  { key: 'summary', label: 'Executive Summary', icon: 'ti-report-money' },
  { key: 'hasil', label: 'Hasil Rekonsiliasi', icon: 'ti-list-details' },
  { key: 'exception', label: 'Exception Queue', icon: 'ti-alert-triangle' },
  { key: 'fee', label: 'Fee Analysis', icon: 'ti-receipt-2' },
  { key: 'raw', label: 'Raw Data & Audit', icon: 'ti-database' },
];
const EXCEPTION_STATUSES = [
  'PENDING_BANK', 'FP_ONLY', 'BANK_ONLY', 'NOMINAL_MISMATCH', 'FEE_MISMATCH',
  'DUPLICATE_FP', 'DUPLICATE_BANK', 'REVERSAL', 'NEED_REVIEW',
];
const ALL_STATUSES = ['MATCHED', 'MATCHED_NO_FEE', ...EXCEPTION_STATUSES];

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
const MONTHS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
function fmtDateLong(v) {
  if (!v) return null;
  const iso = String(v).slice(0, 10);
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return null;
  return `${Number(d)} ${MONTHS_ID[Number(m) - 1] || m} ${y}`;
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

// coverage_status TIDAK PERNAH merah -- OUTSIDE_BANK_COVERAGE & BOUNDARY_PARTIAL
// BUKAN kegagalan transaksi, cuma keterbatasan data bank (5.000 baris terbaru).
const COVERAGE_META = {
  IN_BANK_COVERAGE:     { label: 'Dalam Cakupan', color: '#0369A1', bg: '#E0F2FE' },
  OUTSIDE_BANK_COVERAGE: { label: 'Di Luar Cakupan Data OCBC', color: '#6B7280', bg: '#F3F4F6' },
  BOUNDARY_PARTIAL:     { label: 'Batas Data OCBC Terpotong', color: '#B45309', bg: '#FEF3C7' },
};
function coverageMeta(s) { return COVERAGE_META[s] || null; }

/* ─── UI atoms ─── */
function InfoIcon({ text }) {
  if (!text) return null;
  return (
    <span className="wrr-info-icon" tabIndex={0} role="img" aria-label="Info" title={text}>i</span>
  );
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
  if (!status) return <span className="wrr-status-badge" style={{ background: '#F3F4F6', color: '#9CA3AF' }}>-</span>;
  const m = statusMeta(status);
  return <span className="wrr-status-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}
function CoverageBadge({ status }) {
  const m = coverageMeta(status);
  if (!m) return <span>-</span>;
  return <span className="wrr-status-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
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
   masing-masing tabel ringkas (ID Trx + Nominal saja) supaya cepat dibaca
   sekilas tanpa perlu buka tab Exception Queue. Tinggi seragam, scroll
   vertikal sendiri-sendiri kalau datanya banyak (lihat wrr-mini-table-wrap
   di index.css). Reference ditampilkan sbg fallback ID Trx utk baris
   BANK_ONLY/REVERSAL-tanpa-FP (id_transaksi NULL), nominal fallback ke
   Total Debit bank kalau nominal FP tidak ada. */
function StatusMiniTable({ title, status, date, info }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!date) return;
    const myRequestId = ++requestIdRef.current;
    setLoading(true);
    getReconciliationTransactions({
      date, status, is_actionable: 'true',
      limit: 200, sort: 'updated_at', order: 'desc',
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
                  <td>{r.id_transaksi || r.reference_no || '-'}</td>
                  <td>{fmtRp(r.fp_nominal !== null ? r.fp_nominal : r.bank_total_debit)}</td>
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
  const sv = analytics?.statement_validation;
  const cov = analytics?.coverage;
  const isTruncated = !!cov?.is_source_truncated;
  return (
    <>
      {isTruncated && (
        <div className="wrr-warning-banner wrr-warning-banner-amber">
          <i className="ti ti-alert-triangle" />
          <div>
            <div className="wrr-warning-banner-title">Data OCBC Terbatas</div>
            <p style={{ margin: 0 }}>
              OCBC hanya menyediakan 5.000 baris mutasi terbaru. Hasil rekonsiliasi dihitung berdasarkan transaksi FP
              yang berada dalam cakupan data bank yang tersedia. Transaksi FP di luar cakupan tidak dianggap gagal dan
              tidak masuk Exception Queue.
            </p>
          </div>
        </div>
      )}

      {cov && (
        <div className="wrr-panel">
          <div className="wrr-panel-title">
            <i className="ti ti-history-toggle" style={{ color: COLOR }} /> Cakupan Data Bank OCBC
            <InfoIcon text="Rolling Bank Archive menyimpan setiap baris mutasi bank yang pernah diterima secara kumulatif, supaya transaksi FP lama tetap bisa dicocokkan walau sudah tergeser keluar 5.000 baris terbaru di Google Sheet." />
          </div>
          <div className="wrr-dq-note-grid">
            <div><span className="wrr-dq-note-label">Bank Coverage Start</span><span className="wrr-dq-note-value">{fmtDateTime(cov.snapshot_oldest_time)}</span></div>
            <div><span className="wrr-dq-note-label">Bank Coverage End</span><span className="wrr-dq-note-value">{fmtDateTime(cov.snapshot_newest_time)}</span></div>
            <div><span className="wrr-dq-note-label">Trusted Coverage Start</span><span className="wrr-dq-note-value">{fmtDateTime(cov.trusted_coverage_start)}</span></div>
            <div><span className="wrr-dq-note-label">Bank Rows Received</span><span className="wrr-dq-note-value">{fmtN(cov.bank_row_count)} / {fmtN(cov.source_limit)}</span></div>
            <div><span className="wrr-dq-note-label">Archive Rows</span><span className="wrr-dq-note-value">{fmtN(cov.archive_row_count)}</span></div>
            <div><span className="wrr-dq-note-label">FP Dalam Cakupan</span><span className="wrr-dq-note-value">{fmtN(cov.fp_in_coverage)}</span></div>
            <div><span className="wrr-dq-note-label">FP Di Luar Cakupan</span><span className="wrr-dq-note-value">{fmtN(cov.fp_outside_coverage)}</span></div>
            <div><span className="wrr-dq-note-label">Boundary Partial</span><span className="wrr-dq-note-value">{fmtN(cov.fp_boundary_partial)}</span></div>
          </div>
        </div>
      )}

      <div className="wrr-kpi-grid">
        <KPICard label="Total Transaksi FP" value={fmtN(s?.total_transaksi_fp)}
          info="Jumlah total transaksi dari sheet DATA FP untuk tanggal yang dipilih." />
        <KPICard label="Total Nominal FP" value={fmtRp(s?.total_nominal_fp)}
          info="Total nilai (Rupiah) seluruh transaksi FP untuk tanggal ini." />
        <KPICard label="Reference Bank Unik" value={fmtN(s?.reference_bank_unik)}
          info="Jumlah Reference No. unik di mutasi Bank OCBC. Satu reference biasanya punya 2 baris (principal + fee), jadi angka ini bisa lebih kecil dari jumlah baris mentah di sheet bank." />
        <KPICard label="Matched Transaksi" value={fmtN(s?.matched_transaksi)}
          info="Jumlah transaksi FP yang principal-nya cocok dengan debit di bank (status MATCHED atau MATCHED_NO_FEE)." />
        <KPICard label="Matched Nominal" value={fmtRp(s?.matched_nominal)}
          info="Total nominal FP dari transaksi yang berhasil dicocokkan ke bank." />
        <KPICard label="Pending Bank" value={fmtN(s?.pending_bank_count)} alert={(s?.pending_bank_count || 0) > 0}
          info="Transaksi FP yang belum ditemukan di bank, TAPI masih dalam masa tunggu (grace period, default 30 menit) — belum tentu bermasalah, mungkin bank belum posting." />
        <KPICard label="FP Only" value={fmtN(s?.fp_only_count)} alert={(s?.fp_only_count || 0) > 0}
          info="Transaksi FP yang TIDAK ditemukan di bank SETELAH masa tunggu selesai, DAN berada dalam cakupan data bank — perlu dicek, kemungkinan gagal transfer atau salah catat." />
        <KPICard label="Bank Only" value={fmtN(s?.bank_only_count)} alert={(s?.bank_only_count || 0) > 0}
          info="Mutasi di bank yang punya pola reference/outlet FP tapi tidak ditemukan padanannya di DATA FP — kemungkinan transaksi tidak tercatat di sistem FP." />
        <KPICard label="Nominal Mismatch" value={fmtN(s?.nominal_mismatch_count)} alert={(s?.nominal_mismatch_count || 0) > 0}
          info="Reference cocok, tapi tidak ada debit bank yang nilainya sama dengan nominal FP — kemungkinan salah input nominal di salah satu sisi." />
        <KPICard label="Match Rate Transaksi (Valid)" value={fmtPct(s?.valid_match_rate_transaction)}
          info="Persentase JUMLAH transaksi FP yang cocok, dihitung HANYA dari transaksi yang berada dalam cakupan data bank (coverage_status=IN_BANK_COVERAGE) — transaksi di luar cakupan TIDAK ikut menurunkan angka ini." />
        <KPICard label="Match Rate Nominal (Valid)" value={fmtPct(s?.valid_match_rate_nominal)}
          info="Persentase NILAI (Rupiah) transaksi yang cocok, dihitung HANYA dari transaksi dalam cakupan data bank." />
        <KPICard label="Actionable Exception" value={fmtN(s?.actionable_exception_count)} alert={(s?.actionable_exception_count || 0) > 0}
          info="Jumlah exception yang BENAR-BENAR perlu ditindaklanjuti tim — sudah dikecualikan transaksi di luar cakupan/boundary data bank yang bukan kegagalan sungguhan." />
      </div>

      <div className="wrr-mini-panel-row">
        <StatusMiniTable title="FP Only" status="FP_ONLY" date={date}
          info="Transaksi FP yang TIDAK ditemukan di bank setelah masa tunggu selesai, dalam cakupan data bank." />
        <StatusMiniTable title="Bank Only" status="BANK_ONLY" date={date}
          info="Mutasi di bank yang punya pola reference/outlet FP tapi tidak ditemukan padanannya di DATA FP." />
        <StatusMiniTable title="Reversal" status="REVERSAL" date={date}
          info="Transaksi yang punya baris credit/pembatalan (reversal) di bank." />
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title">
          <i className="ti ti-building-bank" style={{ color: COLOR }} /> Validasi Rekening
          <InfoIcon text="Mengecek konsistensi saldo yang DILAPORKAN BANK SENDIRI (dari summary di sheet DATA BANK OCBC): Saldo Awal + Total Credit − Total Debit harus sama dengan Saldo Akhir. Ini BUKAN verifikasi terhadap baris-baris transaksi yang sudah kita import satu per satu, murni cek angka ringkasan resmi dari bank." />
        </div>
        {!sv || (sv.opening_balance === null && sv.closing_balance === null) ? (
          <div className="wrr-empty-sub">Summary rekening belum tersedia dari Apps Script (opsional).</div>
        ) : (<>
          <div className="wrr-statement-formula">
            <span>{fmtRpFull(sv.opening_balance)}</span> <span className="wrr-statement-op">+</span>
            <span>{fmtRpFull(sv.total_credit_amount)}</span> <span className="wrr-statement-op">−</span>
            <span>{fmtRpFull(sv.total_debit_amount)}</span> <span className="wrr-statement-op">=</span>
            <span className="wrr-statement-expected">{fmtRpFull(sv.expected_closing_balance)}</span>
          </div>
          <div className="wrr-statement-actual">
            Closing Balance aktual: <strong>{fmtRpFull(sv.closing_balance)}</strong>
            {sv.is_valid !== null && (
              <span className={'wrr-statement-flag ' + (sv.is_valid ? 'wrr-statement-flag--ok' : 'wrr-statement-flag--bad')}>
                {sv.is_valid ? 'VALID' : `SELISIH ${fmtRpFull(sv.variance)}`}
              </span>
            )}
          </div>
          <div className="wrr-dq-note-grid" style={{ marginTop: 12 }}>
            <div><span className="wrr-dq-note-label">Periode</span><span className="wrr-dq-note-value">{sv.period || '-'}</span></div>
            <div><span className="wrr-dq-note-label">No. Rekening</span><span className="wrr-dq-note-value">{sv.account_number || '-'}</span></div>
            <div><span className="wrr-dq-note-label">Nama Rekening</span><span className="wrr-dq-note-value">{sv.account_name || '-'}</span></div>
            <div><span className="wrr-dq-note-label">Ledger Balance</span><span className="wrr-dq-note-value">{fmtRp(sv.ledger_balance)}</span></div>
            <div><span className="wrr-dq-note-label">Available Balance</span><span className="wrr-dq-note-value">{fmtRp(sv.available_balance)}</span></div>
            <div><span className="wrr-dq-note-label">Release Date</span><span className="wrr-dq-note-value">{sv.release_date || '-'}</span></div>
          </div>
        </>)}
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title">
          <i className="ti ti-chart-donut" style={{ color: COLOR }} /> Distribusi Status
          <InfoIcon text="Rincian jumlah & nominal transaksi FP per status hasil rekonsiliasi. Lihat tab Exception Queue untuk daftar detail status yang butuh perhatian (semua kecuali MATCHED/MATCHED_NO_FEE)." />
        </div>
        <div className="wrr-empty-sub" style={{ marginBottom: 8 }}>Klik baris untuk lihat daftar transaksinya.</div>
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
   Tabel bersama — dipakai Tab 2 (Hasil Rekonsiliasi) & Tab 3 (Exception Queue)
   ═══════════════════════════════════════════════════════════════════════ */
const COVERAGE_STATUSES = ['IN_BANK_COVERAGE', 'OUTSIDE_BANK_COVERAGE', 'BOUNDARY_PARTIAL'];

function ReconTable({ date, scope, onOpenAudit, initialStatus }) {
  const isException = scope === 'exception';
  const [statusFilter, setStatusFilter] = useState(initialStatus || 'semua');
  // Filter coverage HANYA relevan/bisa diubah di tab Hasil Rekonsiliasi --
  // Exception Queue WAJIB coverage_status=IN_BANK_COVERAGE (bukan pilihan
  // user, supaya transaksi di luar cakupan/boundary tidak pernah muncul di
  // sana sama sekali, sesuai definisi Exception Queue).
  const [coverageFilter, setCoverageFilter] = useState('semua');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'updated_at', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [resolveTarget, setResolveTarget] = useState(null);
  // Guard race condition: kalau user ganti tanggal cepat, respons request
  // LAMA bisa datang SETELAH respons request BARU dan menimpanya dgn data
  // tanggal yg salah. requestIdRef menandai request TERBARU -- respons dari
  // request yg sudah "basi" (bukan yg terbaru saat resolve) diabaikan.
  const requestIdRef = useRef(0);

  useEffect(() => { setPage(1); }, [statusFilter, coverageFilter, search, sort, pageSize, date]);
  // Hapus data lama dari state segera saat tanggal berganti -- jangan
  // menunggu respons baru datang dulu (supaya tidak sempat menampilkan
  // baris tanggal SEBELUMNYA walau sesaat).
  useEffect(() => { setRows([]); setTotal(0); }, [date]);

  useEffect(() => {
    if (!date) return;
    const myRequestId = ++requestIdRef.current;
    setLoading(true); setError(null);
    const statusParam = statusFilter !== 'semua' ? statusFilter : (isException ? EXCEPTION_STATUSES.join(',') : undefined);
    const coverageParam = isException ? 'IN_BANK_COVERAGE' : (coverageFilter !== 'semua' ? coverageFilter : undefined);
    const isActionableParam = isException ? 'true' : undefined;
    getReconciliationTransactions({
      date, status: statusParam, coverage_status: coverageParam, is_actionable: isActionableParam,
      search: search || undefined, page, limit: pageSize, sort: sort.key, order: sort.dir,
    })
      .then(res => {
        if (myRequestId !== requestIdRef.current) return; // respons basi, sudah ada request lebih baru
        setRows(res.rows || []); setTotal(res.meta?.total || 0);
      })
      .catch(e => { if (myRequestId === requestIdRef.current) setError(e.message || 'Gagal memuat data'); })
      .finally(() => { if (myRequestId === requestIdRef.current) setLoading(false); });
  }, [date, statusFilter, coverageFilter, search, sort, page, pageSize, isException]);

  const handleSort = useCallback((key) => {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' });
  }, []);

  const statusOptions = isException ? EXCEPTION_STATUSES : ALL_STATUSES;

  return (
    <div className="wrr-panel">
      <div className="wrr-filter-row">
        <input className="wrr-search-input" placeholder="Cari ID Transaksi / Reference / Outlet..." value={search} onChange={e => setSearch(e.target.value)} />
        <select className="wrr-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="semua">{isException ? 'Semua Exception' : 'Semua Status'}</option>
          {statusOptions.map(s => <option key={s} value={s}>{statusMeta(s).label}</option>)}
        </select>
        {!isException && (
          <select className="wrr-select" value={coverageFilter} onChange={e => setCoverageFilter(e.target.value)}>
            <option value="semua">Semua Cakupan</option>
            {COVERAGE_STATUSES.map(c => <option key={c} value={c}>{coverageMeta(c)?.label || c}</option>)}
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
                <SortableTh label="ID Transaksi" sortKey="id_transaksi" sort={sort} onSort={handleSort} />
                <SortableTh label="Nominal FP" sortKey="fp_nominal" sort={sort} onSort={handleSort} />
                <th>Reference Bank</th>
                <SortableTh label="Principal" sortKey="bank_principal" sort={sort} onSort={handleSort} />
                <SortableTh label="Fee" sortKey="bank_fee" sort={sort} onSort={handleSort} />
                <SortableTh label="Total Debit" sortKey="bank_total_debit" sort={sort} onSort={handleSort} />
                <th>Credit/Reversal</th>
                <SortableTh label="Selisih Fee" sortKey="variance_fee" sort={sort} onSort={handleSort} />
                <th>Waktu FP</th><th>Waktu Bank</th><th>Outlet</th><th>Produk</th>
                <th>Matching Method</th>
                <SortableTh label="Status" sortKey="recon_status" sort={sort} onSort={handleSort} />
                <th>Cakupan</th>
                {isException && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.id_transaksi || '-'}</td>
                  <td>{fmtRp(r.fp_nominal)}</td>
                  <td>{r.reference_no || '-'}</td>
                  <td>{fmtRp(r.bank_principal)}</td>
                  <td>{fmtRp(r.bank_fee)}</td>
                  <td>{fmtRp(r.bank_total_debit)}</td>
                  <td>{r.bank_credit ? fmtRp(r.bank_credit) : '-'}</td>
                  <td style={{ color: r.variance_fee ? (r.variance_fee === 0 ? undefined : '#DC2626') : undefined }}>
                    {r.variance_fee === null ? '-' : fmtRp(r.variance_fee)}
                  </td>
                  <td>{fmtDateTime(r.fp_time_response)}</td>
                  <td>{fmtDate(r.bank_transaction_date)}</td>
                  <td>{r.id_outlet || '-'}</td>
                  <td>{r.id_produk || '-'}</td>
                  <td>{r.matching_method || '-'}</td>
                  <td><StatusBadge status={r.recon_status} /></td>
                  <td><CoverageBadge status={r.coverage_status} /></td>
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
    resolveReconciliation(target.id, { status, notes: notes || undefined })
      .then(() => onResolved())
      .catch(e => setError(e.response?.data?.error || e.message || 'Gagal menyimpan'))
      .finally(() => setSaving(false));
  };

  return (
    <Modal title={`Resolve — ${target.id_transaksi || target.reference_no || target.id}`} onClose={onClose}>
      <div className="wrr-detail-grid" style={{ marginBottom: 16 }}>
        <div><span className="wrr-detail-label">ID Transaksi</span><span className="wrr-detail-value">{target.id_transaksi || '-'}</span></div>
        <div><span className="wrr-detail-label">Reference Bank</span><span className="wrr-detail-value">{target.reference_no || '-'}</span></div>
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
    getReconciliationLogs(id).then(setLogs).catch(e => setError(e.message)).finally(() => setLoading(false));
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
   TAB 4 — Fee Analysis
   ═══════════════════════════════════════════════════════════════════════ */
function FeeAnalysisTab({ analytics }) {
  const fa = analytics?.fee_analysis;
  if (!fa) return <div className="wrr-empty-sub">Belum ada data fee untuk tanggal ini.</div>;

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
        <KPICard label="Expected Fee" value={fmtRpFull(fa.expected_fee)}
          info="Nominal fee BI-FAST yang seharusnya dikenakan bank per transaksi (default Rp25, bisa dikonfigurasi)." />
        <KPICard label="Actual Fee (Total)" value={fmtRp(fa.actual_fee_total)}
          info="Total fee yang benar-benar terpotong di bank dari seluruh transaksi matched." />
        <KPICard label="Actual Fee (Rata-rata)" value={fmtRp(fa.actual_fee_avg)}
          info="Rata-rata fee per transaksi yang benar-benar terpotong di bank." />
        <KPICard label="Transaksi dengan Fee" value={fmtN(fa.transaction_with_fee_count)}
          info="Jumlah transaksi yang datanya lengkap (principal + fee ditemukan di bank), sehingga fee-nya bisa dihitung." />
        <KPICard label="Fee Variance" value={fmtN(fa.fee_variance_count)} alert={(fa.fee_variance_count || 0) > 0}
          info="Jumlah transaksi dengan fee yang TIDAK sama dengan Expected Fee (status FEE_MISMATCH) — perlu dicek, kemungkinan bank kenakan biaya beda dari biasanya." />
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
   TAB 5 — Raw Data & Audit
   ═══════════════════════════════════════════════════════════════════════ */
function RawDataTab({ analytics, date, onExport, exporting }) {
  const meta = analytics?.meta;
  const recentBatches = analytics?.recent_batches || [];
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
          <div><span className="wrr-dq-note-label">Spreadsheet ID</span><span className="wrr-dq-note-value">{meta?.source_spreadsheet_id || '-'}</span></div>
        </div>
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-history" style={{ color: COLOR }} /> Riwayat Sync (14 Batch Terakhir)</div>
        {recentBatches.length === 0 && <div className="wrr-empty-sub">Belum ada riwayat sync.</div>}
        {recentBatches.length > 0 && (
          <div className="wrr-table-wrap">
            <table className="wrr-table">
              <thead><tr><th>Batch</th><th>Tanggal</th><th>Bank</th><th>Baris FP</th><th>Baris Bank</th><th>Sync Terakhir</th><th>Status</th></tr></thead>
              <tbody>
                {recentBatches.map((b, i) => (
                  <tr key={i}>
                    <td>{b.batch_no}</td><td>{fmtDate(b.business_date)}</td><td>{b.bank_code}</td>
                    <td>{fmtN(b.fp_row_count)}</td><td>{fmtN(b.bank_row_count)}</td>
                    <td>{fmtDateTime(b.synced_at)}</td><td>{b.status}</td>
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
   Main
   ═══════════════════════════════════════════════════════════════════════ */
export default function WarRoomReconciliationOcbc() {
  const [date, setDate] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('summary');
  const [auditId, setAuditId] = useState(null);
  const [jumpStatus, setJumpStatus] = useState(null);

  // Klik baris di Distribusi Status (tab Executive Summary) -> lompat ke tab
  // yang relevan, sudah ter-filter ke status itu. MATCHED/MATCHED_NO_FEE ada
  // di tab Hasil Rekonsiliasi (Exception Queue sengaja tidak menampilkan
  // status "aman" ini), status lainnya semua ada di Exception Queue.
  const handleSelectStatus = useCallback((status) => {
    const targetTab = (status === 'MATCHED' || status === 'MATCHED_NO_FEE') ? 'hasil' : 'exception';
    setJumpStatus(status);
    setActiveTab(targetTab);
  }, []);
  const [exporting, setExporting] = useState(false);
  const [syncRequesting, setSyncRequesting] = useState(false);
  const [syncRequestMsg, setSyncRequestMsg] = useState(null);
  // Guard race condition analytics (sama alasan dgn ReconTable di atas).
  const analyticsRequestIdRef = useRef(0);

  const loadAnalytics = useCallback((d) => {
    const myRequestId = ++analyticsRequestIdRef.current;
    setLoading(true); setError(null);
    getReconciliationAnalytics(d ? { date: d } : {})
      .then(res => {
        if (myRequestId !== analyticsRequestIdRef.current) return; // respons basi, sudah ada request lebih baru
        // Guard integritas data: kalau tanggal SUDAH eksplisit diminta (d),
        // tapi server mengembalikan batch dgn business_date BERBEDA, JANGAN
        // render hasil campuran -- tampilkan error data integrity yg jelas.
        if (d && res && res.empty === false && res.active_batch && res.active_batch.business_date !== d) {
          setError(`Data integrity error: diminta tanggal ${d}, server mengembalikan batch tanggal ${res.active_batch.business_date}. Hasil tidak ditampilkan untuk menghindari data tercampur.`);
          setAnalytics(null);
          return;
        }
        setAnalytics(res);
        if (!d && res?.meta?.date) setDate(res.meta.date);
      })
      .catch(e => { if (myRequestId === analyticsRequestIdRef.current) setError(e.message || 'Gagal memuat analytics'); })
      .finally(() => { if (myRequestId === analyticsRequestIdRef.current) setLoading(false); });
  }, []);

  useEffect(() => { loadAnalytics(date); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Hapus data lama dari state SEGERA saat tanggal berganti -- jangan
  // menunggu respons baru dulu, supaya tidak sempat menampilkan analytics
  // tanggal SEBELUMNYA walau sesaat.
  const handleDateChange = (d) => { setDate(d); setAnalytics(null); loadAnalytics(d); };
  const handleRefresh = () => loadAnalytics(date);

  const handleExport = () => {
    setExporting(true);
    exportReconciliationCsv({ date: date || undefined })
      .then(blob => downloadBlob(blob, `reconciliation-ocbc-${date || 'export'}.csv`))
      .catch(e => setError(e.message || 'Gagal export CSV'))
      .finally(() => setExporting(false));
  };

  // Bukan sync instan — Apps Script Web App tidak bisa dipanggil langsung
  // dari browser (kebijakan Google Workspace). Ini hanya mencatat
  // permintaan; trigger checker Apps Script (jalan tiap 1 menit) yang
  // benar-benar sync dalam ~1-2 menit berikutnya.
  const handleSyncNow = () => {
    setSyncRequesting(true); setSyncRequestMsg(null);
    requestReconciliationSync('OCBC')
      .then(res => setSyncRequestMsg(res.message || 'Permintaan sync terkirim.'))
      .catch(e => setSyncRequestMsg(e.response?.data?.error || e.message || 'Gagal mengirim permintaan sync.'))
      .finally(() => setSyncRequesting(false));
  };

  const isEmpty = !loading && !error && analytics?.empty === true;
  const recentBatches = analytics?.recent_batches || [];
  // Tanggal batch AKTIF (sumber kebenaran dari server, active_batch.business_date)
  // -- fallback ke filter tanggal frontend kalau analytics belum ada.
  const activeBatchDate = analytics?.active_batch?.business_date || date;
  const activeBatchDateLong = fmtDateLong(activeBatchDate);

  return (
    <Layout>
      <div className="wrr-page">
        <div className="wrr-header">
          <div className="wrr-header-left">
            <i className="ti ti-building-bank" style={{ color: COLOR, fontSize: 24 }} />
            <div>
              <div className="wrr-header-title">Rekonsiliasi OCBC{activeBatchDateLong ? ` — ${activeBatchDateLong}` : ''}</div>
              <div className="wrr-header-sub">Rekonsiliasi transaksi FP terhadap mutasi Bank OCBC — matching reference, fee BI-FAST, dan exception queue.</div>
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
              <span className="wrr-badge wrr-badge-sync"><i className="ti ti-plug-connected" /> Sync: {fmtDateTime(analytics.meta.last_sync)}</span>
            )}
          </div>
        </div>
        {syncRequestMsg && <div className="wrr-empty-sub" style={{ marginBottom: 12 }}>{syncRequestMsg}</div>}

        {!loading && !error && analytics?.data_quality_warning && (
          <div className="wrr-warning-banner wrr-warning-banner-amber">
            <i className="ti ti-alert-triangle" />
            <div>
              <div className="wrr-warning-banner-title">Data Quality Warning — Hasil Cross-Date Ditemukan</div>
              <p style={{ margin: 0 }}>{analytics.data_quality_warning.message}</p>
            </div>
          </div>
        )}

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
              <button key={t.key} className={'wrr-tab-btn' + (activeTab === t.key ? ' wrr-tab-btn--active' : '')} onClick={() => { setJumpStatus(null); setActiveTab(t.key); }}>
                <i className={`ti ${t.icon}`} /> {t.label}
              </button>
            ))}
          </div>

          {activeTab === 'summary' && <SummaryTab analytics={analytics} onSelectStatus={handleSelectStatus} date={date} />}
          {activeTab === 'hasil' && <ReconTable date={date} scope="all" onOpenAudit={setAuditId} initialStatus={jumpStatus} />}
          {activeTab === 'exception' && <ReconTable date={date} scope="exception" onOpenAudit={setAuditId} initialStatus={jumpStatus} />}
          {activeTab === 'fee' && <FeeAnalysisTab analytics={analytics} />}
          {activeTab === 'raw' && <RawDataTab analytics={analytics} date={date} onExport={handleExport} exporting={exporting} />}
        </>)}

        {auditId && <AuditLogModal id={auditId} onClose={() => setAuditId(null)} />}
      </div>
    </Layout>
  );
}
