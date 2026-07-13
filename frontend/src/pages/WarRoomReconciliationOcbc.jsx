import { useState, useEffect, useMemo, useCallback } from 'react';
import Layout from '../components/Layout';
import {
  getReconciliationAnalytics, getReconciliationTransactions, exportReconciliationCsv,
  resolveReconciliation, getReconciliationLogs,
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

/* ─── UI atoms ─── */
function KPICard({ label, value, sub, alert }) {
  return (
    <div className={'wrr-kpi-card' + (alert ? ' wrr-kpi-card--alert' : '')}>
      <div className="wrr-kpi-label">{label}</div>
      <div className="wrr-kpi-value">{value}</div>
      {sub && <div className="wrr-kpi-sub">{sub}</div>}
    </div>
  );
}
function StatusBadge({ status }) {
  const m = statusMeta(status);
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

/* ═══════════════════════════════════════════════════════════════════════
   TAB 1 — Executive Summary
   ═══════════════════════════════════════════════════════════════════════ */
function SummaryTab({ analytics }) {
  const s = analytics?.summary;
  const sv = analytics?.statement_validation;
  return (
    <>
      <div className="wrr-kpi-grid">
        <KPICard label="Total Transaksi FP" value={fmtN(s?.total_transaksi_fp)} />
        <KPICard label="Total Nominal FP" value={fmtRp(s?.total_nominal_fp)} />
        <KPICard label="Reference Bank Unik" value={fmtN(s?.reference_bank_unik)} />
        <KPICard label="Matched Transaksi" value={fmtN(s?.matched_transaksi)} />
        <KPICard label="Matched Nominal" value={fmtRp(s?.matched_nominal)} />
        <KPICard label="Pending Bank" value={fmtN(s?.pending_bank_count)} alert={(s?.pending_bank_count || 0) > 0} />
        <KPICard label="FP Only" value={fmtN(s?.fp_only_count)} alert={(s?.fp_only_count || 0) > 0} />
        <KPICard label="Bank Only" value={fmtN(s?.bank_only_count)} alert={(s?.bank_only_count || 0) > 0} />
        <KPICard label="Nominal Mismatch" value={fmtN(s?.nominal_mismatch_count)} alert={(s?.nominal_mismatch_count || 0) > 0} />
        <KPICard label="Total Fee Bank" value={fmtRp(s?.total_fee_bank)} />
        <KPICard label="Match Rate Transaksi" value={fmtPct(s?.match_rate_transaksi)} />
        <KPICard label="Match Rate Nominal" value={fmtPct(s?.match_rate_nominal)} />
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-building-bank" style={{ color: COLOR }} /> Validasi Rekening</div>
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
        <div className="wrr-panel-title"><i className="ti ti-chart-donut" style={{ color: COLOR }} /> Distribusi Status</div>
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead><tr><th>Status</th><th>Jumlah Transaksi</th><th>Nominal FP</th></tr></thead>
            <tbody>
              {(analytics?.status_distribution || []).filter(d => d.count > 0).map((d, i) => (
                <tr key={i}><td><StatusBadge status={d.status} /></td><td>{fmtN(d.count)}</td><td>{fmtRp(d.nominal)}</td></tr>
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
function ReconTable({ date, scope, onOpenAudit }) {
  const isException = scope === 'exception';
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

  useEffect(() => { setPage(1); }, [statusFilter, search, sort, pageSize, date]);

  useEffect(() => {
    if (!date) return;
    setLoading(true); setError(null);
    const statusParam = statusFilter !== 'semua' ? statusFilter : (isException ? EXCEPTION_STATUSES.join(',') : undefined);
    getReconciliationTransactions({
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
        <input className="wrr-search-input" placeholder="Cari ID Transaksi / Reference / Outlet..." value={search} onChange={e => setSearch(e.target.value)} />
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
        <KPICard label="Expected Fee" value={fmtRpFull(fa.expected_fee)} />
        <KPICard label="Actual Fee (Total)" value={fmtRp(fa.actual_fee_total)} />
        <KPICard label="Actual Fee (Rata-rata)" value={fmtRp(fa.actual_fee_avg)} />
        <KPICard label="Transaksi dengan Fee" value={fmtN(fa.transaction_with_fee_count)} />
        <KPICard label="Fee Variance" value={fmtN(fa.fee_variance_count)} alert={(fa.fee_variance_count || 0) > 0} />
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
  const [exporting, setExporting] = useState(false);

  const loadAnalytics = useCallback((d) => {
    setLoading(true); setError(null);
    getReconciliationAnalytics(d ? { date: d } : {})
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
    exportReconciliationCsv({ date: date || undefined })
      .then(blob => downloadBlob(blob, `reconciliation-ocbc-${date || 'export'}.csv`))
      .catch(e => setError(e.message || 'Gagal export CSV'))
      .finally(() => setExporting(false));
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
              <div className="wrr-header-title">Rekonsiliasi OCBC</div>
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
            <button className="wrr-btn" onClick={handleRefresh}><i className="ti ti-refresh" /> Refresh</button>
            {analytics?.meta?.last_sync && (
              <span className="wrr-badge wrr-badge-sync"><i className="ti ti-plug-connected" /> Sync: {fmtDateTime(analytics.meta.last_sync)}</span>
            )}
          </div>
        </div>

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

          {activeTab === 'summary' && <SummaryTab analytics={analytics} />}
          {activeTab === 'hasil' && <ReconTable date={date} scope="all" onOpenAudit={setAuditId} />}
          {activeTab === 'exception' && <ReconTable date={date} scope="exception" onOpenAudit={setAuditId} />}
          {activeTab === 'fee' && <FeeAnalysisTab analytics={analytics} />}
          {activeTab === 'raw' && <RawDataTab analytics={analytics} date={date} onExport={handleExport} exporting={exporting} />}
        </>)}

        {auditId && <AuditLogModal id={auditId} onClose={() => setAuditId(null)} />}
      </div>
    </Layout>
  );
}
