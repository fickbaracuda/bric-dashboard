import { useState, useEffect, useRef } from 'react';
import { getReconciliationMandiriDailyReport } from '../../services/api';

// Tab "Laporan Harian" Rekonsiliasi Mandiri — pola SAMA dgn Laporan Harian
// OCBC (frontend/src/pages/WarRoomReconciliationOcbc.jsx::DailyReportTab),
// TAPI ditaruh di file terpisah (diizinkan spec) krn Mandiri punya panel
// tambahan yang tidak ada di OCBC: Time & Posting Summary dan Validasi
// Saldo Mandiri. REUSE CSS generik `wrr-*`/`wrrm-*` yang sudah ada
// (termasuk `wrr-daily-report-*` yang dibangun utk OCBC — BUKAN spesifik
// OCBC, jadi tidak diduplikasi) — TIDAK ada CSS baru yang perlu ditambahkan.

const COLOR = '#003D79';

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
    'LAPORAN REKONSILIASI MANDIRI',
    `Tanggal: ${fmtDate(report.meta?.date)}`,
    `Data sampai: ${fmtDateTime(report.active_batch?.synced_at)}`,
    `Status: ${report.report_status === 'RUNNING' ? 'Berjalan' : 'Selesai'} (${report.health_status})`,
    '',
    `Total FP: ${fmtN(report.total_fp)}`,
    `Total Nominal: ${fmtRp(report.total_nominal_fp)}`,
    `Berhasil Direkonsiliasi: ${fmtN(report.matched_transaksi)}`,
    `Valid Match Rate: ${fmtPct(report.valid_match_rate_transaction)}`,
    `Exception: ${fmtN(report.actionable_exception_count)}`,
    `Nominal Terdampak: ${fmtRp(report.actionable_exception_nominal)}`,
    `Reversal: ${fmtN(report.reversal?.count)} (${fmtRp(report.reversal?.nominal)})`,
    `Rata-rata Waktu Posting: ${fmtMinutes(report.time_posting_summary?.avg_minutes)}`,
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

export default function DailyReportMandiriTab({ date }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copyMsg, setCopyMsg] = useState(null);
  const requestIdRef = useRef(0);

  const loadReport = (d) => {
    if (!d) return;
    const myRequestId = ++requestIdRef.current;
    setLoading(true); setError(null);
    getReconciliationMandiriDailyReport({ date: d })
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
      .catch(() => setCopyMsg('Gagal menyalin otomatis — salin manual dari Ringkasan Otomatis di bawah.'));
    setTimeout(() => setCopyMsg(null), 5000);
  };

  if (loading) return <div className="wrr-loading"><i className="ti ti-loader-2 wrr-spin" /> Memuat laporan...</div>;
  if (error) return <div className="wrr-error"><i className="ti ti-alert-circle" /> {error}</div>;
  if (!report || report.empty) {
    return (
      <div className="wrr-empty">
        <i className="ti ti-file-report" />
        <div>{report?.message || 'Belum ada data rekonsiliasi Mandiri untuk tanggal ini.'}</div>
      </div>
    );
  }

  const hm = HEALTH_META[report.health_status] || HEALTH_META.YELLOW;
  const bv = report.balance_validation;
  const tp = report.time_posting_summary;

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
          <div className="wrr-daily-report-title">Laporan Rekonsiliasi Harian — Bank Mandiri</div>
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
          <div><span className="wrr-dq-note-label">Nominal Terdampak Exception</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.actionable_exception_nominal)}</span></div>
          <div><span className="wrr-dq-note-label">Total Fee Aktual</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.total_actual_fee)}</span></div>
          <div><span className="wrr-dq-note-label">Nominal Reversal</span><span className="wrr-dq-note-value">{fmtRpFull(report.financial_summary?.reversal_nominal)}</span></div>
        </div>
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-clock" style={{ color: COLOR }} /> Time & Posting Summary</div>
        <div className="wrr-dq-note-grid">
          <div><span className="wrr-dq-note-label">Rata-rata Selisih Waktu</span><span className="wrr-dq-note-value">{fmtMinutes(tp?.avg_minutes)}</span></div>
          <div><span className="wrr-dq-note-label">Median</span><span className="wrr-dq-note-value">{fmtMinutes(tp?.median_minutes)}</span></div>
          <div><span className="wrr-dq-note-label">P95</span><span className="wrr-dq-note-value">{fmtMinutes(tp?.p95_minutes)}</span></div>
          <div><span className="wrr-dq-note-label">Maksimum</span><span className="wrr-dq-note-value">{fmtMinutes(tp?.max_minutes)}</span></div>
          <div><span className="wrr-dq-note-label">0–5 menit</span><span className="wrr-dq-note-value">{fmtN(tp?.bucket_0_5)}</span></div>
          <div><span className="wrr-dq-note-label">5–15 menit</span><span className="wrr-dq-note-value">{fmtN(tp?.bucket_5_15)}</span></div>
          <div><span className="wrr-dq-note-label">15–30 menit</span><span className="wrr-dq-note-value">{fmtN(tp?.bucket_15_30)}</span></div>
          <div><span className="wrr-dq-note-label">&gt; 30 menit</span><span className="wrr-dq-note-value">{fmtN(tp?.bucket_gt_30)}</span></div>
        </div>
      </div>

      <div className="wrr-panel">
        <div className="wrr-panel-title"><i className="ti ti-scale" style={{ color: COLOR }} /> Validasi Saldo Mandiri</div>
        {!bv ? (
          <div className="wrr-empty-sub">Validasi saldo belum tersedia untuk batch ini.</div>
        ) : (
          <div className="wrrm-balance-row">
            <span className={'wrrm-balance-badge wrrm-balance-badge--' + String(bv.status || '').toLowerCase()}>
              {bv.status === 'BALANCED' ? 'SELARAS' : bv.status === 'UNBALANCED' ? 'TIDAK SELARAS' : 'TIDAK DAPAT DIPASTIKAN'}
            </span>
            <span>Arah urutan statement: <strong>{bv.direction === 'ASC' ? 'Menaik' : bv.direction === 'DESC' ? 'Menurun' : '-'}</strong></span>
            <span>Baris dicek: {fmtN(bv.checked)} — cocok: {fmtN(bv.matched)} — selisih: {fmtN(bv.mismatch_count)}</span>
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
                  <th>ID Transaksi</th><th>Outlet</th><th>Produk</th><th>Biller</th><th>Account No.</th>
                  <th>Status</th><th>Nominal FP</th><th>Principal Mandiri</th><th>Selisih Principal</th>
                  <th>Selisih Fee</th><th>Selisih Waktu</th><th>Catatan</th>
                </tr>
              </thead>
              <tbody>
                {report.top_10_exception.map((r, i) => (
                  <tr key={i}>
                    <td>{r.id_transaksi || '-'}</td>
                    <td>{r.id_outlet || '-'}</td>
                    <td>{r.id_produk || '-'}</td>
                    <td>{r.id_biller || '-'}</td>
                    <td>{r.account_no || '-'}</td>
                    <td><StatusBadge status={r.recon_status} /></td>
                    <td>{fmtRp(r.fp_nominal)}</td>
                    <td>{fmtRp(r.bank_principal)}</td>
                    <td>{r.variance_principal === null ? '-' : fmtRp(r.variance_principal)}</td>
                    <td>{r.variance_fee === null ? '-' : fmtRp(r.variance_fee)}</td>
                    <td>{r.time_difference_minutes === null || r.time_difference_minutes === undefined ? '-' : fmtMinutes(r.time_difference_minutes)}</td>
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
          <div className="wrr-empty-sub">Tidak ditemukan masalah kualitas data (tidak ada data lintas tanggal maupun duplikat canonical key).</div>
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
