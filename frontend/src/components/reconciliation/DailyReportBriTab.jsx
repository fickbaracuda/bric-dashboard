import { useState, useEffect, useRef } from 'react';
import { getReconciliationBriDailyReport } from '../../services/api';

// Tab "Laporan Harian" Rekonsiliasi BRI — pola SAMA dgn Laporan Harian
// OCBC/Mandiri (file terpisah, diizinkan spec), TAPI punya 2 panel
// tambahan yang tidak ada di keduanya: Coverage Window BRI dan Extraction
// & ID Quality (ekstraksi 3-sumber DESK_TRAN/TRREMK/TLBDS2 khas BRI).
// REUSE CSS generik `wrr-*`/`wrrm-*`/`wrrbri-*` yang sudah ada — TIDAK ada
// CSS baru yang perlu ditambahkan.

const COLOR = '#00529C';

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
function StatusBadge({ status }) {
  const m = statusMeta(status);
  return <span className="wrr-status-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}

const HEALTH_META = {
  GREEN:  { label: 'GREEN',  color: '#059669', bg: '#DCFCE7' },
  YELLOW: { label: 'YELLOW', color: '#B45309', bg: '#FEF3C7' },
  RED:    { label: 'RED',    color: '#DC2626', bg: '#FEE2E2' },
};

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

function KPICard({ label, value, alert }) {
  return (
    <div className={'wrr-kpi-card' + (alert ? ' wrr-kpi-card--alert' : '')}>
      <div className="wrr-kpi-label">{label}</div>
      <div className="wrr-kpi-value">{value}</div>
    </div>
  );
}

/* Teks ringkas siap-tempel WhatsApp/email — format PERSIS sesuai spec. */
function buildCopyText(report) {
  const lines = [
    'LAPORAN REKONSILIASI BRI',
    `Tanggal: ${fmtDate(report.meta?.date)}`,
    `Data sampai: ${fmtDateTime(report.active_batch?.synced_at)}`,
    `Status Laporan: ${report.report_status === 'RUNNING' ? 'Berjalan (Hari Ini)' : 'Selesai'}`,
    `Status Kesehatan: ${report.health_status}`,
    '',
    `Total FP: ${fmtN(report.total_fp)}`,
    `Total Nominal: ${fmtRp(report.total_nominal_fp)}`,
    `Berhasil Direkonsiliasi: ${fmtN(report.matched_transaksi)}`,
    `Valid Match Rate: ${fmtPct(report.valid_match_rate_transaction)}`,
    `Actionable Exception: ${fmtN(report.actionable_exception_count)}`,
    `Nominal Terdampak: ${fmtRp(report.actionable_exception_nominal)}`,
    `Reversal: ${fmtN(report.reversal?.count)} (${fmtRp(report.reversal?.nominal)})`,
    `Cross-Date Reversal: ${fmtN(report.cross_date_reversal_count)}`,
    `ID Conflict: ${fmtN(report.data_quality_warning?.id_conflict_count)}`,
    `Mutasi Di Luar Coverage: ${fmtN(report.coverage_summary?.bank_outside_coverage)}`,
    `Mutasi Out of Scope: ${fmtN(report.coverage_summary?.out_of_scope_rows)}`,
    `Rata-rata Waktu Posting: ${fmtMinutes(report.time_posting_summary?.average_minutes)}`,
    `Validasi Saldo: ${report.balance_validation?.status || 'TIDAK DAPAT DIPASTIKAN'}`,
    '',
    'Ringkasan:',
    report.ringkasan_direktur,
    '',
    'Tindak Lanjut:',
    ...(report.rekomendasi_tindak_lanjut || []).map((r, i) => `${i + 1}. ${r}`),
  ];
  return lines.join('\n');
}

export default function DailyReportBriTab({ date }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copyMsg, setCopyMsg] = useState(null);
  const requestIdRef = useRef(0);

  const loadReport = (d) => {
    if (!d) return;
    const myRequestId = ++requestIdRef.current;
    setLoading(true); setError(null);
    getReconciliationBriDailyReport({ date: d })
      .then(res => { if (myRequestId === requestIdRef.current) setReport(res); })
      .catch(e => { if (myRequestId === requestIdRef.current) setError(e.message || 'Gagal memuat laporan'); })
      .finally(() => { if (myRequestId === requestIdRef.current) setLoading(false); });
  };

  useEffect(() => { loadReport(date); }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePrint = () => window.print();
  const handleCopy = () => {
    if (!report || report.empty) return;
    const text = buildCopyText(report);
    (navigator.clipboard?.writeText(text) || Promise.reject())
      .then(() => setCopyMsg('Ringkasan disalin ke clipboard — siap ditempel ke WhatsApp/email.'))
      .catch(() => {
        // Fallback clipboard: textarea sementara + execCommand (spec: "Sediakan
        // fallback jika clipboard API gagal" — mis. browser lama/non-HTTPS).
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          setCopyMsg('Ringkasan disalin ke clipboard — siap ditempel ke WhatsApp/email.');
        } catch {
          setCopyMsg('Gagal menyalin otomatis — salin manual dari Ringkasan Otomatis di bawah.');
        }
      });
    setTimeout(() => setCopyMsg(null), 5000);
  };

  if (loading) return <div className="wrr-loading"><i className="ti ti-loader-2 wrr-spin" /> Memuat laporan...</div>;
  if (error) return <div className="wrr-error"><i className="ti ti-alert-circle" /> {error}</div>;
  if (!report || report.empty) {
    return (
      <div className="wrr-empty">
        <i className="ti ti-file-report" />
        <div>{report?.message || 'Belum ada data rekonsiliasi BRI untuk tanggal ini.'}</div>
      </div>
    );
  }

  const hm = HEALTH_META[report.health_status] || HEALTH_META.YELLOW;
  const bv = report.balance_validation;
  const tp = report.time_posting_summary;
  const cov = report.coverage_summary;
  const ext = report.extraction_summary;

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
          <div className="wrr-daily-report-title">Laporan Rekonsiliasi Harian — Bank BRI</div>
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
        <KPICard label="Data Bank Diterima" value={fmtN(report.total_bank_row_count)} />
        <KPICard label="Berhasil Direkonsiliasi" value={fmtN(report.matched_transaksi)} />
        <KPICard label="Valid Match Rate" value={fmtPct(report.valid_match_rate_transaction)} />
        <KPICard label="Actionable Exception" value={fmtN(report.actionable_exception_count)} alert={report.actionable_exception_count > 0} />
        <KPICard label="Nominal Terdampak" value={fmtRp(report.actionable_exception_nominal)} alert={report.actionable_exception_nominal > 0} />
        <KPICard label="Reversal" value={fmtN(report.reversal?.count)} alert={(report.reversal?.count || 0) > 0} />
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
        <div className="wrr-panel-title"><i className="ti ti-cash" style={{ color: COLOR }} /> Posisi Finansial</div>
        <div className="wrr-dq-note-grid">
          <div><span className="wrr-dq-note-label">Total Nominal FP</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.total_nominal_fp)}</span></div>
          <div><span className="wrr-dq-note-label">Matched Nominal</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.matched_nominal)}</span></div>
          <div><span className="wrr-dq-note-label">Total Gross Debit</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.total_gross_debit)}</span></div>
          <div><span className="wrr-dq-note-label">Actual Fee Total</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.actual_fee_total)}</span></div>
          <div><span className="wrr-dq-note-label">Expected Fee Total</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.expected_fee_total)}</span></div>
          <div><span className="wrr-dq-note-label">Fee Variance</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.fee_variance)}</span></div>
          <div><span className="wrr-dq-note-label">Nominal Terdampak Exception</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.actionable_exception_nominal)}</span></div>
          <div><span className="wrr-dq-note-label">Nominal Reversal</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.reversal_nominal)}</span></div>
          <div><span className="wrr-dq-note-label">Bank Only — Gross Debit</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.bank_only_gross_debit)}</span></div>
          <div><span className="wrr-dq-note-label">Bank Only — Est. Principal (ESTIMASI)</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.bank_only_estimated_principal)}</span></div>
          <div><span className="wrr-dq-note-label">Nominal Mismatch (Absolut)</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.nominal_mismatch_absolute)}</span></div>
        </div>
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-window" style={{ color: COLOR }} /> Coverage Window BRI</div>
        <div className="wrr-dq-note-grid">
          <div><span className="wrr-dq-note-label">Scope Mode</span><span className="wrr-dq-note-value">{cov?.scope_mode || '-'}</span></div>
          <div><span className="wrr-dq-note-label">Coverage Start</span><span className="wrr-dq-note-value">{fmtDateTime(cov?.coverage_start)}</span></div>
          <div><span className="wrr-dq-note-label">Coverage End</span><span className="wrr-dq-note-value">{fmtDateTime(cov?.coverage_end)}</span></div>
          <div><span className="wrr-dq-note-label">Coverage Tolerance</span><span className="wrr-dq-note-value">{cov?.coverage_tolerance_minutes ?? '-'} menit</span></div>
          <div><span className="wrr-dq-note-label">Bank Dalam Coverage</span><span className="wrr-dq-note-value">{fmtN(cov?.bank_in_coverage)}</span></div>
          <div><span className="wrr-dq-note-label">Bank Di Luar Coverage</span><span className="wrr-dq-note-value">{fmtN(cov?.bank_outside_coverage)}</span></div>
          <div><span className="wrr-dq-note-label">Mutasi Out of Scope</span><span className="wrr-dq-note-value">{fmtN(cov?.out_of_scope_rows)}</span></div>
          <div><span className="wrr-dq-note-label">Transaksi FASTPAY Dalam Scope</span><span className="wrr-dq-note-value">{fmtN(cov?.fastpay_rows_in_scope)}</span></div>
        </div>
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-fingerprint" style={{ color: COLOR }} /> Extraction &amp; ID Quality</div>
        <div className="wrr-dq-note-grid">
          <div><span className="wrr-dq-note-label">Confidence HIGH</span><span className="wrr-dq-note-value">{fmtN(ext?.high_confidence_count)}</span></div>
          <div><span className="wrr-dq-note-label">Confidence MEDIUM</span><span className="wrr-dq-note-value">{fmtN(ext?.medium_confidence_count)}</span></div>
          <div><span className="wrr-dq-note-label">Confidence CONFLICT</span><span className="wrr-dq-note-value">{fmtN(ext?.conflict_count)}</span></div>
          <div><span className="wrr-dq-note-label">Confidence NONE</span><span className="wrr-dq-note-value">{fmtN(ext?.none_confidence_count)}</span></div>
          <div><span className="wrr-dq-note-label">ID Conflict</span><span className="wrr-dq-note-value">{fmtN(ext?.id_conflict_count)}</span></div>
          <div><span className="wrr-dq-note-label">ID dari DESK_TRAN</span><span className="wrr-dq-note-value">{fmtN(ext?.id_from_desk_tran_count)}</span></div>
          <div><span className="wrr-dq-note-label">ID dari TRREMK</span><span className="wrr-dq-note-value">{fmtN(ext?.id_from_trremk_count)}</span></div>
          <div><span className="wrr-dq-note-label">ID dari TLBDS2</span><span className="wrr-dq-note-value">{fmtN(ext?.id_from_tlbds2_count)}</span></div>
          <div><span className="wrr-dq-note-label">Need Review (Konflik ID)</span><span className="wrr-dq-note-value">{fmtN(ext?.need_review_conflict_count)}</span></div>
          <div><span className="wrr-dq-note-label">Out of Scope</span><span className="wrr-dq-note-value">{fmtN(ext?.out_of_scope_count)}</span></div>
        </div>
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-clock" style={{ color: COLOR }} /> Time &amp; Posting Summary</div>
        <div className="wrr-dq-note-grid">
          <div><span className="wrr-dq-note-label">Rata-rata Selisih Waktu</span><span className="wrr-dq-note-value">{fmtMinutes(tp?.average_minutes)}</span></div>
          <div><span className="wrr-dq-note-label">Median</span><span className="wrr-dq-note-value">{fmtMinutes(tp?.median_minutes)}</span></div>
          <div><span className="wrr-dq-note-label">P95</span><span className="wrr-dq-note-value">{fmtMinutes(tp?.p95_minutes)}</span></div>
          <div><span className="wrr-dq-note-label">Maksimum</span><span className="wrr-dq-note-value">{fmtMinutes(tp?.maximum_minutes)}</span></div>
          <div><span className="wrr-dq-note-label">0–5 menit</span><span className="wrr-dq-note-value">{fmtN(tp?.bucket_0_5)}</span></div>
          <div><span className="wrr-dq-note-label">5–15 menit</span><span className="wrr-dq-note-value">{fmtN(tp?.bucket_5_15)}</span></div>
          <div><span className="wrr-dq-note-label">15–30 menit</span><span className="wrr-dq-note-value">{fmtN(tp?.bucket_15_30)}</span></div>
          <div><span className="wrr-dq-note-label">&gt; 30 menit</span><span className="wrr-dq-note-value">{fmtN(tp?.bucket_over_30)}</span></div>
        </div>
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-scale" style={{ color: COLOR }} /> Validasi Saldo BRI</div>
        {!bv ? (
          <div className="wrr-empty-sub">Validasi saldo belum tersedia untuk batch ini.</div>
        ) : (
          <div className="wrrm-balance-row">
            <span className={'wrrm-balance-badge wrrm-balance-badge--' + String(bv.status || '').toLowerCase()}>
              {bv.status === 'BALANCED' ? 'SELARAS' : bv.status === 'UNBALANCED' ? 'TIDAK SELARAS' : 'TIDAK DAPAT DIPASTIKAN'}
            </span>
            <span>Baris diperiksa: {fmtN(bv.total_rows_checked)} — balanced: {fmtN(bv.balanced_rows)} ({fmtPct(bv.pct_balanced)}) — unbalanced: {fmtN(bv.unbalanced_rows)} — undetermined: {fmtN(bv.undetermined_rows)}</span>
            <span>Total variance: {fmtRp(bv.total_variance)}</span>
          </div>
        )}
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-alert-triangle" style={{ color: COLOR }} /> Top 10 Exception</div>
        {(!report.top_10_exception || report.top_10_exception.length === 0) ? (
          <div className="wrr-empty-sub">Tidak ada exception pada tanggal ini.</div>
        ) : (
          <div className="wrr-table-wrap">
            <table className="wrr-table">
              <thead>
                <tr>
                  <th>ID Transaksi</th><th>Outlet</th><th>Produk</th><th>Biller</th><th>Norek</th>
                  <th>Status</th><th>Nominal FP</th><th>Gross Debit</th><th>Principal</th><th>Est. Principal</th>
                  <th>Fee</th><th>Selisih Principal</th><th>Selisih Fee</th><th>Selisih Waktu</th>
                  <th>Extraction</th><th>Confidence</th><th>Conflict</th><th>Coverage</th><th>Reversal Source</th><th>Catatan</th>
                </tr>
              </thead>
              <tbody>
                {report.top_10_exception.map((r, i) => (
                  <tr key={i}>
                    <td>{r.id_transaksi || r.canonical_transaction_key || '-'}</td>
                    <td>{r.id_outlet || '-'}</td>
                    <td>{r.id_produk || '-'}</td>
                    <td>{r.id_biller || '-'}</td>
                    <td>{r.account_no || '-'}</td>
                    <td><StatusBadge status={r.recon_status} /></td>
                    <td>{fmtRp(r.fp_nominal)}</td>
                    <td>{fmtRp(r.bank_gross_debit)}</td>
                    <td>{fmtRp(r.bank_principal)}</td>
                    <td>{r.estimated_bank_principal !== null ? fmtRp(r.estimated_bank_principal) + ' (est.)' : '-'}</td>
                    <td>{fmtRp(r.bank_fee)}</td>
                    <td>{r.variance_principal === null ? '-' : fmtRp(r.variance_principal)}</td>
                    <td>{r.variance_fee === null ? '-' : fmtRp(r.variance_fee)}</td>
                    <td>{r.time_difference_minutes === null || r.time_difference_minutes === undefined ? '-' : fmtMinutes(r.time_difference_minutes)}</td>
                    <td>{r.matching_method || '-'}</td>
                    <td>{r.extraction_confidence || '-'}</td>
                    <td>{r.id_conflict ? '⚠ Ya' : 'Tidak'}</td>
                    <td>{r.coverage_status || '-'}</td>
                    <td>{r.reversal_lookup_source || '-'}</td>
                    <td>{r.notes || '-'}</td>
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
          <div className="wrr-empty-sub">Tidak ditemukan masalah kualitas data (tidak ada invalid business date, duplikat canonical key, maupun consumed-juga-bank-only).</div>
        ) : (
          <div className="wrr-warning-banner wrr-warning-banner-amber">
            <i className="ti ti-alert-triangle" />
            <div><p style={{ margin: 0 }}>{report.data_quality_warning.message}</p></div>
          </div>
        )}
        <div className="wrr-dq-note-grid" style={{ marginTop: 12 }}>
          <div><span className="wrr-dq-note-label">ID Conflict</span><span className="wrr-dq-note-value">{fmtN(report.data_quality_warning?.id_conflict_count)}</span></div>
          <div><span className="wrr-dq-note-label">Saldo Unbalanced</span><span className="wrr-dq-note-value">{fmtN(report.data_quality_warning?.unbalanced_bank_row_count)}</span></div>
          <div><span className="wrr-dq-note-label">Cross-Date Reversal (valid, bukan masalah)</span><span className="wrr-dq-note-value">{fmtN(report.cross_date_reversal_count)}</span></div>
        </div>
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
