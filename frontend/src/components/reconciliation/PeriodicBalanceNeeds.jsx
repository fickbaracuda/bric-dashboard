import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Chart from 'chart.js/auto';

// Shared component tab "Kebutuhan Saldo" — dipakai SEMUA war-room
// Rekonsiliasi (OCBC/Mandiri/BRI/BRI BI-FAST/BNI). Referensi utama & sumber
// kebenaran = implementasi OCBC (dibangun pertama kali) — generalisasi di
// sini HANYA menambah props (bankCode/bankLabel/themeColor/fetchData/
// supportsFundingComparison/defaultRange) dan field/kolom BARU (Minimum
// Harian, Average Nilai Transaksi, Peak Hour Label, grafik per tanggal,
// panel funding comparison khusus BNI) — TIDAK ADA rumus/perhitungan yang
// diubah dari versi OCBC yang sudah berjalan.

/* ─── Format helpers (lokal, tidak ada shared format util di codebase ini) ─── */
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
function fmtDate(v) {
  if (!v) return '-';
  const iso = String(v).slice(0, 10);
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return '-';
  return `${d}/${m}/${y}`;
}
function hourLabel(h) {
  if (h === null || h === undefined || !Number.isFinite(Number(h))) return '-';
  return `${String(h).padStart(2, '0')}:00`;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(obj) {
  return Object.values(obj).map(csvEscape).join(',');
}

/* Data mentah (numerik, bukan string ter-format) supaya siap dihitung ulang
   di Excel — dipakai bareng oleh export CSV & XLS supaya isinya konsisten. */
function hourlyExportRows(hourly) {
  return (hourly || []).map(h => ({
    'Hour': h.hour,
    'Hour Label': h.label,
    'Total Transaction': h.total_transaction,
    'Average Transaction Per Day': h.average_transaction_per_day,
    'Total Principal': h.total_principal,
    'Total Expected Fee': h.total_expected_fee,
    'Total Balance Need': h.total_balance_need,
    'Average Balance Need Per Day': h.average_balance_need_per_day,
    'Maximum Daily Need': h.maximum_daily_need,
    'Minimum Daily Need': h.minimum_daily_need,
    'Peak Date': h.peak_date,
  }));
}
function dailyExportRows(daily, includeFunding, fundingByDate) {
  return (daily || []).map(d => {
    const row = {
      'Business Date': d.business_date,
      'Transaction Count': d.transaction_count,
      'Principal': d.principal,
      'Expected Fee': d.expected_fee,
      'Total Balance Need': d.total_balance_need,
      'Peak Hour': d.peak_hour,
      'Peak Hour Need': d.peak_hour_need,
      'Average Transaction Value': d.average_transaction_value,
    };
    if (includeFunding) {
      const f = fundingByDate?.get(d.business_date);
      row['Funding Credit'] = f?.funding_credit ?? 0;
      row['Fastpay Debit'] = f?.fastpay_debit ?? 0;
      row['Reversal Credit'] = f?.reversal_credit ?? 0;
      row['Net Cash Movement'] = f?.net_cash_movement ?? 0;
    }
    return row;
  });
}
function buildBalanceNeedsWorkbook(XLSX, data, meta) {
  const wb = XLSX.utils.book_new();
  const metaRows = [{ Bank: meta.bankLabel, 'Start Date': meta.startDate, 'End Date': meta.endDate, 'Included Days': data.coverage?.included_days, 'Missing Days': data.coverage?.missing_days }];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(metaRows), 'Info');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(hourlyExportRows(data.hourly)), 'Rekap Per Jam');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dailyExportRows(data.daily, meta.includeFunding, meta.fundingByDate)), 'Rekap Per Tanggal');
  return wb;
}

/* ─── Tanggal (Asia/Jakarta) ─── */
function todayJakartaIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDaysIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function startOfMonthIso(iso) {
  const [y, m] = iso.split('-');
  return `${y}-${m}-01`;
}
function diffDaysInclusive(startIso, endIso) {
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const [ey, em, ed] = endIso.split('-').map(Number);
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  return Math.round((end - start) / 86400000) + 1;
}

const PRESETS = [
  { key: 'today', label: 'Hari Ini' },
  { key: '7d', label: '7 Hari Terakhir' },
  { key: '14d', label: '14 Hari Terakhir' },
  { key: '30d', label: '30 Hari Terakhir' },
  { key: 'this_month', label: 'Bulan Ini' },
  { key: 'last_month', label: 'Bulan Lalu' },
  { key: 'custom', label: 'Custom Date Range' },
];

function computeRangeForPreset(preset, customStart, customEnd) {
  const today = todayJakartaIso();
  switch (preset) {
    case 'today': return { start: today, end: today };
    case '7d': return { start: addDaysIso(today, -6), end: today };
    case '14d': return { start: addDaysIso(today, -13), end: today };
    case '30d': return { start: addDaysIso(today, -29), end: today };
    case 'this_month': return { start: startOfMonthIso(today), end: today };
    case 'last_month': {
      const firstThisMonth = startOfMonthIso(today);
      const lastDayPrevMonth = addDaysIso(firstThisMonth, -1);
      return { start: startOfMonthIso(lastDayPrevMonth), end: lastDayPrevMonth };
    }
    case 'custom': return { start: customStart, end: customEnd };
    default: return { start: addDaysIso(today, -6), end: today };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   Chart per jam — Average/Total Kebutuhan Saldo + Maximum Kebutuhan Harian
   ═══════════════════════════════════════════════════════════════════════ */
function BalanceNeedsChart({ hourly, mode, color }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!ref.current || !hourly || hourly.length === 0) return;
    if (chartRef.current) chartRef.current.destroy();

    const labels = hourly.map(h => hourLabel(h.hour));
    const primarySeries = hourly.map(h => (mode === 'total' ? h.total_balance_need : (h.average_balance_need_per_day ?? 0)));
    const maxSeries = hourly.map(h => h.maximum_daily_need ?? 0);

    chartRef.current = new Chart(ref.current, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: mode === 'total' ? 'Total Kebutuhan Saldo (Periode)' : 'Average Kebutuhan Saldo per Hari',
            data: primarySeries,
            borderColor: color,
            backgroundColor: `${color}1F`,
            fill: true,
            tension: 0.25,
            pointRadius: 2,
          },
          {
            label: 'Maximum Kebutuhan Harian',
            data: maxSeries,
            borderColor: '#B45309',
            backgroundColor: 'rgba(180,83,9,.08)',
            borderDash: [5, 4],
            fill: false,
            tension: 0.25,
            pointRadius: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: { y: { ticks: { callback: (v) => fmtRp(v) } } },
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              title: (items) => `Jam ${items[0].label}`,
              afterBody: (items) => {
                const h = hourly[items[0].dataIndex];
                if (!h) return [];
                return [
                  `Total transaksi: ${fmtN(h.total_transaction)}`,
                  `Average transaksi/hari: ${fmtN(h.average_transaction_per_day)}`,
                  `Total principal: ${fmtRpFull(h.total_principal)}`,
                  `Total expected fee: ${fmtRpFull(h.total_expected_fee)}`,
                  `Total kebutuhan: ${fmtRpFull(h.total_balance_need)}`,
                  `Average kebutuhan/hari: ${fmtRpFull(h.average_balance_need_per_day)}`,
                  `Maximum harian: ${fmtRpFull(h.maximum_daily_need)}`,
                  `Peak date: ${fmtDate(h.peak_date)}`,
                ];
              },
              label: (item) => `${item.dataset.label}: ${fmtRpFull(item.raw)}`,
            },
          },
        },
      },
    });

    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
  }, [hourly, mode, color]);

  return (
    <div className="wrr-balance-periodic-chart-wrap">
      <canvas ref={ref} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Chart per tanggal — Total Kebutuhan Saldo (+ Funding Credit utk BNI)
   ═══════════════════════════════════════════════════════════════════════ */
function DailyBalanceChart({ daily, color, fundingByDate }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!ref.current || !daily || daily.length === 0) return;
    if (chartRef.current) chartRef.current.destroy();

    // Tabel sudah diurutkan tanggal terbaru dulu -- grafik lebih enak dibaca kronologis.
    const sorted = [...daily].sort((a, b) => a.business_date.localeCompare(b.business_date));
    const labels = sorted.map(d => fmtDate(d.business_date));
    const datasets = [{
      label: 'Total Kebutuhan Saldo',
      data: sorted.map(d => d.total_balance_need),
      borderColor: color,
      backgroundColor: `${color}1F`,
      fill: true,
      tension: 0.2,
      pointRadius: 2,
    }];
    if (fundingByDate && fundingByDate.size > 0) {
      datasets.push({
        label: 'Funding Credit',
        data: sorted.map(d => fundingByDate.get(d.business_date)?.funding_credit ?? 0),
        borderColor: '#059669',
        backgroundColor: 'rgba(5,150,105,.1)',
        fill: false,
        borderDash: [4, 3],
        tension: 0.2,
        pointRadius: 2,
      });
    }

    chartRef.current = new Chart(ref.current, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        scales: { y: { ticks: { callback: (v) => fmtRp(v) } } },
        plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${fmtRpFull(item.raw)}` } } },
      },
    });

    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
  }, [daily, color, fundingByDate]);

  return (
    <div className="wrr-balance-periodic-chart-wrap">
      <canvas ref={ref} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Panel Funding Comparison (khusus BNI, opsional)
   ═══════════════════════════════════════════════════════════════════════ */
function FundingComparisonPanel({ bankSpecific, color }) {
  if (!bankSpecific) return null;
  const diff = bankSpecific.funding_need_difference;
  return (
    <div className="wrr-panel">
      <div className="wrr-panel-title"><i className="ti ti-arrows-exchange" style={{ color }} /> Perbandingan Funding vs Kebutuhan Saldo (BNI)</div>
      <div className="wrr-kpi-grid">
        <KPICard label="Total Funding Masuk" value={fmtRp(bankSpecific.total_funding_credit)} />
        <KPICard label="Jumlah Top-up" value={fmtN(bankSpecific.funding_transaction_count)} />
        <KPICard label="Total Fastpay Debit" value={fmtRp(bankSpecific.total_fastpay_debit)} />
        <KPICard label="Total Reversal Credit" value={fmtRp(bankSpecific.total_reversal_credit)} />
        <KPICard label="Net Cash Movement" value={fmtRp(bankSpecific.net_cash_movement)} />
        <KPICard label="Selisih Funding vs Kebutuhan" value={fmtRp(diff)} />
      </div>
      <div className="wrr-empty-sub" style={{ marginTop: 8 }}>
        Perbandingan funding dan kebutuhan tidak menunjukkan saldo rekening aktual karena data mutasi tidak memuat opening balance.
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Main — shared component
   ═══════════════════════════════════════════════════════════════════════ */
export default function PeriodicBalanceNeeds({ bankCode, bankLabel, themeColor, fetchData, supportsFundingComparison = false, defaultRange = '7d' }) {
  const color = themeColor || '#DC2626';
  const [preset, setPreset] = useState(defaultRange);
  const todayIso = useMemo(() => todayJakartaIso(), []);
  const [customStart, setCustomStart] = useState(addDaysIso(todayIso, -6));
  const [customEnd, setCustomEnd] = useState(todayIso);
  const [chartMode, setChartMode] = useState('average');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [validationError, setValidationError] = useState(null);
  const requestIdRef = useRef(0);
  const abortRef = useRef(null);

  const range = useMemo(() => computeRangeForPreset(preset, customStart, customEnd), [preset, customStart, customEnd]);

  useEffect(() => {
    const { start, end } = range;
    if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      setValidationError('Tanggal mulai dan tanggal selesai wajib diisi.');
      setData(null); setLoading(false);
      return;
    }
    const days = diffDaysInclusive(start, end);
    if (days < 1) {
      setValidationError('Tanggal selesai harus sama atau setelah tanggal mulai.');
      setData(null); setLoading(false);
      return;
    }
    if (days > 90) {
      setValidationError('Rentang tanggal maksimal 90 hari — persempit periode agar query tetap ringan.');
      setData(null); setLoading(false);
      return;
    }
    setValidationError(null);

    // Batalkan/abaikan request sebelumnya + kosongkan data lama SEGERA saat
    // periode berganti, supaya tidak sempat menampilkan hasil periode lama
    // ATAU data bank lain (guard by requestId, bukan cuma AbortController,
    // supaya aman juga kalau bankCode berganti tanpa unmount).
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const myRequestId = ++requestIdRef.current;
    setLoading(true); setError(null); setData(null);
    fetchData({ start_date: start, end_date: end, signal: controller.signal })
      .then(res => { if (myRequestId === requestIdRef.current) setData(res); })
      .catch(e => {
        if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError' || e?.name === 'AbortError') return;
        if (myRequestId === requestIdRef.current) setError(e.response?.data?.error || e.message || 'Gagal memuat data');
      })
      .finally(() => { if (myRequestId === requestIdRef.current) setLoading(false); });
  }, [range.start, range.end, bankCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const fundingByDate = useMemo(() => {
    if (!supportsFundingComparison || !data?.bank_specific?.daily) return null;
    return new Map(data.bank_specific.daily.map(d => [d.business_date, d]));
  }, [data, supportsFundingComparison]);

  const handleExportCsv = useCallback(() => {
    if (!data || data.empty) return;
    const hourlyRows = hourlyExportRows(data.hourly);
    const dailyRows = dailyExportRows(data.daily, supportsFundingComparison && !!fundingByDate, fundingByDate);
    const lines = [];
    lines.push('INFO');
    lines.push(['Bank', 'Start Date', 'End Date', 'Included Days', 'Missing Days'].join(','));
    lines.push([bankLabel, range.start, range.end, data.coverage?.included_days, data.coverage?.missing_days].map(csvEscape).join(','));
    lines.push('');
    lines.push('REKAP PER JAM');
    if (hourlyRows.length) lines.push(Object.keys(hourlyRows[0]).join(','));
    for (const row of hourlyRows) lines.push(csvRow(row));
    lines.push('');
    lines.push('REKAP PER TANGGAL');
    if (dailyRows.length) lines.push(Object.keys(dailyRows[0]).join(','));
    for (const row of dailyRows) lines.push(csvRow(row));
    downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' }), `kebutuhan-saldo-${bankCode.toLowerCase()}-${range.start}_${range.end}.csv`);
  }, [data, range, bankCode, bankLabel, supportsFundingComparison, fundingByDate]);

  const [xlsxLoading, setXlsxLoading] = useState(false);
  // Lazy-load 'xlsx' (SheetJS, ~330kb) HANYA saat tombol Export XLS diklik --
  // supaya tidak membengkakkan bundle utama yang dimuat semua halaman.
  const handleExportXlsx = useCallback(async () => {
    if (!data || data.empty) return;
    setXlsxLoading(true);
    try {
      const XLSX = await import('xlsx');
      const wb = buildBalanceNeedsWorkbook(XLSX, data, {
        bankLabel, startDate: range.start, endDate: range.end,
        includeFunding: supportsFundingComparison && !!fundingByDate, fundingByDate,
      });
      XLSX.writeFile(wb, `kebutuhan-saldo-${bankCode.toLowerCase()}-${range.start}_${range.end}.xlsx`);
    } finally {
      setXlsxLoading(false);
    }
  }, [data, range, bankCode, bankLabel, supportsFundingComparison, fundingByDate]);

  const isEmpty = !loading && !error && !validationError && data?.empty === true;
  const hasData = !loading && !error && !validationError && data && data.empty === false;
  const hasMissingDays = hasData && (data.coverage?.missing_days || 0) > 0;

  return (
    <div className="wrr-balance-periodic">
      <div className="wrr-panel">
        <div className="wrr-panel-title-row">
          <div className="wrr-panel-title"><i className="ti ti-filter" style={{ color }} /> Filter Periode</div>
          <div className="wrr-balance-periodic-export-group">
            <button className="wrr-btn" onClick={handleExportCsv} disabled={!hasData}>
              <i className="ti ti-download" /> Export CSV
            </button>
            <button className="wrr-btn wrr-btn-primary" onClick={handleExportXlsx} disabled={!hasData || xlsxLoading} style={{ background: color, borderColor: color }}>
              <i className="ti ti-download" /> {xlsxLoading ? 'Menyiapkan...' : 'Export XLS'}
            </button>
          </div>
        </div>
        <div className="wrr-filter-row">
          <select className="wrr-select" value={preset} onChange={e => setPreset(e.target.value)}>
            {PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          {preset === 'custom' && (
            <div className="wrr-balance-periodic-custom-range">
              <label>Tanggal Mulai</label>
              <input type="date" className="wrr-select" value={customStart} max={customEnd} onChange={e => setCustomStart(e.target.value)} />
              <label>Tanggal Selesai</label>
              <input type="date" className="wrr-select" value={customEnd} min={customStart} max={todayIso} onChange={e => setCustomEnd(e.target.value)} />
            </div>
          )}
        </div>
        {range.start && range.end && !validationError && (
          <div className="wrr-empty-sub">
            Rentang: {fmtDate(range.start)} – {fmtDate(range.end)}
            {data && !data.empty && ` · Rata-rata dihitung dari ${fmtN(data.coverage?.included_days)} hari yang memiliki batch Rekonsiliasi ${bankLabel}.`}
          </div>
        )}
      </div>

      {validationError && <div className="wrr-error"><i className="ti ti-alert-circle" /> {validationError}</div>}
      {!validationError && loading && <div className="wrr-loading"><i className="ti ti-loader-2 wrr-spin" /> Memuat data...</div>}
      {!validationError && !loading && error && <div className="wrr-error"><i className="ti ti-alert-circle" /> {error}</div>}
      {!validationError && !loading && !error && isEmpty && (
        <div className="wrr-empty">
          <i className="ti ti-cash-off" />
          <div>{data?.message || `Belum ada batch Rekonsiliasi ${bankLabel} pada periode ini.`}</div>
        </div>
      )}

      {hasMissingDays && (
        <div className="wrr-warning-banner wrr-warning-banner-amber">
          <i className="ti ti-alert-triangle" />
          <div>Data tersedia untuk {fmtN(data.coverage.included_days)} dari {fmtN(data.coverage.selected_days)} hari pada periode yang dipilih.</div>
        </div>
      )}

      {hasData && (<>
        <div className="wrr-panel">
          <div className="wrr-panel-title"><i className="ti ti-history-toggle" style={{ color }} /> Cakupan Periode</div>
          <div className="wrr-dq-note-grid">
            <div><span className="wrr-dq-note-label">Rentang Tanggal</span><span className="wrr-dq-note-value">{fmtDate(range.start)} – {fmtDate(range.end)}</span></div>
            <div><span className="wrr-dq-note-label">Jumlah Hari Dipilih</span><span className="wrr-dq-note-value">{fmtN(data.coverage?.selected_days)}</span></div>
            <div><span className="wrr-dq-note-label">Jumlah Hari dengan Data</span><span className="wrr-dq-note-value">{fmtN(data.coverage?.included_days)}</span></div>
            <div><span className="wrr-dq-note-label">Jumlah Hari Tanpa Batch</span><span className="wrr-dq-note-value">{fmtN(data.coverage?.missing_days)}</span></div>
          </div>
          {(data.coverage?.missing_dates || []).length > 0 && (
            <div className="wrr-empty-sub" style={{ marginTop: 8 }}>
              Tanggal tanpa data: {data.coverage.missing_dates.map(fmtDate).join(', ')}
            </div>
          )}
        </div>

        <div className="wrr-kpi-grid">
          <KPICard label="Total Kebutuhan Saldo" value={fmtRp(data.summary?.total_balance_need)} />
          <KPICard label="Rata-rata Kebutuhan per Hari" value={fmtRp(data.summary?.average_balance_need_per_day)} />
          <KPICard label="Total Transaksi" value={fmtN(data.summary?.total_transaction)} />
          <KPICard label="Rata-rata Transaksi per Hari" value={fmtN(data.summary?.average_transaction_per_day)} />
          <KPICard label="Peak Hour" value={data.summary?.peak_hour_label || hourLabel(data.summary?.peak_hour)} />
          <KPICard label="Average Kebutuhan Peak Hour" value={fmtRp(data.summary?.peak_hour_average)} />
          <KPICard label="Kebutuhan Harian Tertinggi" value={fmtRp(data.summary?.maximum_daily_need)} />
          <KPICard label="Tanggal Kebutuhan Tertinggi" value={fmtDate(data.summary?.maximum_daily_need_date)} />
          <KPICard label="Hari Data Tersedia" value={fmtN(data.coverage?.included_days)} />
          <KPICard label="Hari Tanpa Data" value={fmtN(data.coverage?.missing_days)} />
        </div>

        {supportsFundingComparison && data.bank_specific && Object.keys(data.bank_specific).length > 0 && (
          <FundingComparisonPanel bankSpecific={data.bank_specific} color={color} />
        )}

        <div className="wrr-panel">
          <div className="wrr-panel-title-row">
            <div className="wrr-panel-title"><i className="ti ti-chart-line" style={{ color }} /> Pola Kebutuhan Saldo {bankLabel} per Jam</div>
            <div className="wrr-balance-periodic-toggle">
              <button className={'wrr-balance-periodic-toggle-btn' + (chartMode === 'average' ? ' wrr-balance-periodic-toggle-btn--active' : '')} onClick={() => setChartMode('average')}>Average</button>
              <button className={'wrr-balance-periodic-toggle-btn' + (chartMode === 'total' ? ' wrr-balance-periodic-toggle-btn--active' : '')} onClick={() => setChartMode('total')}>Total Periode</button>
            </div>
          </div>
          <BalanceNeedsChart hourly={data.hourly} mode={chartMode} color={color} />
        </div>

        <div className="wrr-panel">
          <div className="wrr-panel-title"><i className="ti ti-calendar-stats" style={{ color }} /> Kebutuhan Saldo per Tanggal</div>
          <DailyBalanceChart daily={data.daily} color={color} fundingByDate={supportsFundingComparison ? fundingByDate : null} />
        </div>

        <HourlyTable hourly={data.hourly} includedDays={data.coverage?.included_days} bankLabel={bankLabel} color={color} />
        <DailyTable daily={data.daily} color={color} />
      </>)}
    </div>
  );
}

function KPICard({ label, value }) {
  return (
    <div className="wrr-kpi-card">
      <div className="wrr-kpi-label">{label}</div>
      <div className="wrr-kpi-value">{value}</div>
    </div>
  );
}

function HourlyTable({ hourly, includedDays, bankLabel, color }) {
  const rows = hourly || [];
  const totals = rows.reduce((acc, h) => ({
    total_transaction: acc.total_transaction + (h.total_transaction || 0),
    total_principal: acc.total_principal + (h.total_principal || 0),
    total_expected_fee: acc.total_expected_fee + (h.total_expected_fee || 0),
    total_balance_need: acc.total_balance_need + (h.total_balance_need || 0),
    maximum_daily_need: Math.max(acc.maximum_daily_need, h.maximum_daily_need || 0),
  }), { total_transaction: 0, total_principal: 0, total_expected_fee: 0, total_balance_need: 0, maximum_daily_need: 0 });

  return (
    <div className="wrr-panel">
      <div className="wrr-panel-title"><i className="ti ti-clock-hour-4" style={{ color }} /> Rekap Kebutuhan Saldo per Jam</div>
      {rows.length === 0 ? (
        <div className="wrr-empty-sub">Belum ada batch Rekonsiliasi {bankLabel} pada periode ini.</div>
      ) : (
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead>
              <tr>
                <th>Jam</th><th>Total Trx</th><th>Average Trx/Hari</th><th>Total Principal</th><th>Total Fee</th>
                <th>Total Kebutuhan</th><th>Average Kebutuhan/Hari</th><th>Maximum Harian</th><th>Minimum Harian</th><th>Peak Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h, i) => (
                <tr key={i}>
                  <td>{h.label}</td>
                  <td>{fmtN(h.total_transaction)}</td>
                  <td>{fmtN(h.average_transaction_per_day)}</td>
                  <td>{fmtRp(h.total_principal)}</td>
                  <td>{fmtRp(h.total_expected_fee)}</td>
                  <td>{fmtRp(h.total_balance_need)}</td>
                  <td>{fmtRp(h.average_balance_need_per_day)}</td>
                  <td>{fmtRp(h.maximum_daily_need)}</td>
                  <td>{fmtRp(h.minimum_daily_need)}</td>
                  <td>{fmtDate(h.peak_date)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="wrr-balance-periodic-total-row">
                <td>TOTAL</td>
                <td>{fmtN(totals.total_transaction)}</td>
                <td>{fmtN(includedDays ? totals.total_transaction / includedDays : null)}</td>
                <td>{fmtRp(totals.total_principal)}</td>
                <td>{fmtRp(totals.total_expected_fee)}</td>
                <td>{fmtRp(totals.total_balance_need)}</td>
                <td>{fmtRp(includedDays ? totals.total_balance_need / includedDays : null)}</td>
                <td>{fmtRp(totals.maximum_daily_need)}</td>
                <td>-</td>
                <td>-</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function DailyTable({ daily, color }) {
  const rows = daily || [];
  return (
    <div className="wrr-panel">
      <div className="wrr-panel-title"><i className="ti ti-calendar-stats" style={{ color }} /> Detail Kebutuhan Saldo per Tanggal</div>
      {rows.length === 0 ? (
        <div className="wrr-empty-sub">Belum ada data.</div>
      ) : (
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead>
              <tr>
                <th>Tanggal</th><th>Jumlah Trx</th><th>Principal</th><th>Expected Fee</th>
                <th>Total Kebutuhan</th><th>Peak Hour</th><th>Kebutuhan pada Peak Hour</th><th>Average Nilai Transaksi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d, i) => (
                <tr key={i}>
                  <td>{fmtDate(d.business_date)}</td>
                  <td>{fmtN(d.transaction_count)}</td>
                  <td>{fmtRp(d.principal)}</td>
                  <td>{fmtRp(d.expected_fee)}</td>
                  <td>{fmtRp(d.total_balance_need)}</td>
                  <td>{d.peak_hour_label || hourLabel(d.peak_hour)}</td>
                  <td>{fmtRp(d.peak_hour_need)}</td>
                  <td>{fmtRp(d.average_transaction_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
