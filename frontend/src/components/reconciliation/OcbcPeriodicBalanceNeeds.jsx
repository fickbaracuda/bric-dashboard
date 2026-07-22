import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Chart from 'chart.js/auto';
import { getOcbcPeriodicBalanceNeeds } from '../../services/api';

const COLOR = '#DC2626';

/* ─── Format helpers (lokal, sama pola dgn WarRoomReconciliationOcbc.jsx — tidak ada shared format util di codebase ini) ─── */
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

/* ─── Tanggal (Asia/Jakarta) — SAMA pola dgn todayJakarta() backend, murni util tanggal kalender jadi aman dihitung via Date.UTC (tidak perlu re-anchor timezone tiap operasi). ─── */
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
   Chart — Average/Total Kebutuhan Saldo per Jam + Maximum Kebutuhan Harian
   ═══════════════════════════════════════════════════════════════════════ */
function BalanceNeedsChart({ hourly, mode }) {
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
            label: mode === 'total' ? 'Total Kebutuhan Saldo (Periode)' : 'Average Kebutuhan Saldo',
            data: primarySeries,
            borderColor: COLOR,
            backgroundColor: 'rgba(220,38,38,.12)',
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
        scales: {
          y: { ticks: { callback: (v) => fmtRp(v) } },
        },
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              title: (items) => `Jam ${items[0].label}`,
              afterBody: (items) => {
                const h = hourly[items[0].dataIndex];
                if (!h) return [];
                return [
                  `Average transaksi/hari: ${fmtN(h.average_transaction_per_day)}`,
                  `Average principal: ${fmtRpFull(h.average_principal_per_day)}`,
                  `Average fee: ${fmtRpFull(h.average_fee_per_day)}`,
                  `Average kebutuhan saldo: ${fmtRpFull(h.average_balance_need_per_day)}`,
                  `Maximum kebutuhan: ${fmtRpFull(h.maximum_daily_need)}`,
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
  }, [hourly, mode]);

  return (
    <div className="wrr-balance-periodic-chart-wrap">
      <canvas ref={ref} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Main
   ═══════════════════════════════════════════════════════════════════════ */
export default function OcbcPeriodicBalanceNeeds() {
  const [preset, setPreset] = useState('7d');
  const todayIso = useMemo(() => todayJakartaIso(), []);
  const [customStart, setCustomStart] = useState(addDaysIso(todayIso, -6));
  const [customEnd, setCustomEnd] = useState(todayIso);
  const [chartMode, setChartMode] = useState('average');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [validationError, setValidationError] = useState(null);
  const requestIdRef = useRef(0);

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
    // periode berganti, supaya tidak sempat menampilkan hasil periode lama.
    const myRequestId = ++requestIdRef.current;
    setLoading(true); setError(null); setData(null);
    getOcbcPeriodicBalanceNeeds({ start_date: start, end_date: end })
      .then(res => { if (myRequestId === requestIdRef.current) setData(res); })
      .catch(e => { if (myRequestId === requestIdRef.current) setError(e.response?.data?.error || e.message || 'Gagal memuat data'); })
      .finally(() => { if (myRequestId === requestIdRef.current) setLoading(false); });
  }, [range.start, range.end]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleExport = useCallback(() => {
    if (!data || data.empty) return;
    const lines = [];
    lines.push('REKAP PER JAM');
    lines.push(['Hour', 'Total Transaction', 'Average Transaction Per Day', 'Total Principal', 'Total Expected Fee', 'Total Balance Need', 'Average Balance Need Per Day', 'Maximum Daily Need', 'Peak Date'].join(','));
    for (const h of data.hourly || []) {
      lines.push([hourLabel(h.hour), h.total_transaction, h.average_transaction_per_day, h.total_principal, h.total_expected_fee, h.total_balance_need, h.average_balance_need_per_day, h.maximum_daily_need, h.peak_date].map(csvEscape).join(','));
    }
    lines.push('');
    lines.push('REKAP PER TANGGAL');
    lines.push(['Tanggal', 'Jumlah Transaksi', 'Principal', 'Expected Fee', 'Total Kebutuhan', 'Peak Hour', 'Kebutuhan pada Peak Hour'].join(','));
    for (const d of data.daily || []) {
      lines.push([d.business_date, d.transaction_count, d.principal, d.expected_fee, d.total_balance_need, hourLabel(d.peak_hour), d.peak_hour_need].map(csvEscape).join(','));
    }
    downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' }), `kebutuhan-saldo-ocbc-${range.start}_${range.end}.csv`);
  }, [data, range]);

  const isEmpty = !loading && !error && !validationError && data?.empty === true;
  const hasData = !loading && !error && !validationError && data && data.empty === false;

  return (
    <div className="wrr-balance-periodic">
      <div className="wrr-panel">
        <div className="wrr-panel-title-row">
          <div className="wrr-panel-title"><i className="ti ti-filter" style={{ color: COLOR }} /> Filter Periode</div>
          <button className="wrr-btn wrr-btn-primary" onClick={handleExport} disabled={!hasData}>
            <i className="ti ti-download" /> Export Rekap Saldo
          </button>
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
            {data && !data.empty && ` · Average dihitung dari ${fmtN(data.coverage?.included_days)} hari yang memiliki batch OCBC.`}
          </div>
        )}
      </div>

      {validationError && <div className="wrr-error"><i className="ti ti-alert-circle" /> {validationError}</div>}
      {!validationError && loading && <div className="wrr-loading"><i className="ti ti-loader-2 wrr-spin" /> Memuat data...</div>}
      {!validationError && !loading && error && <div className="wrr-error"><i className="ti ti-alert-circle" /> {error}</div>}
      {!validationError && !loading && !error && isEmpty && (
        <div className="wrr-empty">
          <i className="ti ti-cash-off" />
          <div>{data?.message || 'Belum ada batch Rekonsiliasi OCBC pada periode ini.'}</div>
        </div>
      )}

      {hasData && (<>
        <div className="wrr-panel">
          <div className="wrr-panel-title"><i className="ti ti-history-toggle" style={{ color: COLOR }} /> Cakupan Periode</div>
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
          <KPICard label="Total Kebutuhan Saldo Periode" value={fmtRp(data.summary?.total_balance_need)} />
          <KPICard label="Rata-rata Kebutuhan Saldo / Hari" value={fmtRp(data.summary?.average_balance_need_per_day)} />
          <KPICard label="Rata-rata Jumlah Transaksi / Hari" value={fmtN(data.summary?.average_transaction_per_day)} />
          <KPICard label="Jam Average Kebutuhan Tertinggi" value={hourLabel(data.summary?.peak_hour)} />
          <KPICard label="Average Kebutuhan pada Peak Hour" value={fmtRp(data.summary?.peak_hour_average)} />
          <KPICard label="Kebutuhan Harian Tertinggi" value={fmtRp(data.summary?.maximum_daily_need)} />
          <KPICard label="Tanggal Kebutuhan Tertinggi" value={fmtDate(data.summary?.maximum_daily_need_date)} />
          <KPICard label="Hari Data Tersedia" value={fmtN(data.coverage?.included_days)} />
        </div>

        <div className="wrr-panel">
          <div className="wrr-panel-title-row">
            <div className="wrr-panel-title"><i className="ti ti-chart-line" style={{ color: COLOR }} /> Kebutuhan Saldo per Jam</div>
            <div className="wrr-balance-periodic-toggle">
              <button className={'wrr-balance-periodic-toggle-btn' + (chartMode === 'average' ? ' wrr-balance-periodic-toggle-btn--active' : '')} onClick={() => setChartMode('average')}>Average</button>
              <button className={'wrr-balance-periodic-toggle-btn' + (chartMode === 'total' ? ' wrr-balance-periodic-toggle-btn--active' : '')} onClick={() => setChartMode('total')}>Total Periode</button>
            </div>
          </div>
          <BalanceNeedsChart hourly={data.hourly} mode={chartMode} />
        </div>

        <HourlyTable hourly={data.hourly} includedDays={data.coverage?.included_days} />
        <DailyTable daily={data.daily} />
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

function HourlyTable({ hourly, includedDays }) {
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
      <div className="wrr-panel-title"><i className="ti ti-clock-hour-4" style={{ color: COLOR }} /> Rekap Kebutuhan Saldo per Jam</div>
      {rows.length === 0 ? (
        <div className="wrr-empty-sub">Belum ada batch Rekonsiliasi OCBC pada periode ini.</div>
      ) : (
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead>
              <tr>
                <th>Jam</th><th>Total Trx</th><th>Average Trx/Hari</th><th>Total Principal</th><th>Total Fee</th>
                <th>Total Kebutuhan</th><th>Average Kebutuhan/Hari</th><th>Maximum Harian</th><th>Peak Date</th>
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
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function DailyTable({ daily }) {
  const rows = daily || [];
  return (
    <div className="wrr-panel">
      <div className="wrr-panel-title"><i className="ti ti-calendar-stats" style={{ color: COLOR }} /> Detail Kebutuhan Saldo per Tanggal</div>
      {rows.length === 0 ? (
        <div className="wrr-empty-sub">Belum ada data.</div>
      ) : (
        <div className="wrr-table-wrap">
          <table className="wrr-table">
            <thead>
              <tr>
                <th>Tanggal</th><th>Jumlah Trx</th><th>Principal</th><th>Expected Fee</th>
                <th>Total Kebutuhan</th><th>Peak Hour</th><th>Kebutuhan pada Peak Hour</th>
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
                  <td>{hourLabel(d.peak_hour)}</td>
                  <td>{fmtRp(d.peak_hour_need)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
