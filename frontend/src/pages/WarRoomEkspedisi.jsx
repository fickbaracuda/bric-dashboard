import { useState, useEffect, useRef, useMemo } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getEkspedisiAnalytics } from '../services/api';

/* ── Constants ── */
const THEME       = '#8B5CF6';
const THEME_LIGHT = '#EDE9FE';
const STATUS_COLOR = {
  growing:  '#059669',
  declining:'#DC2626',
  new:      '#2563EB',
  churned:  '#9CA3AF',
  stable:   '#D97706',
};
const STATUS_LABEL = {
  growing:  'Growing',
  declining:'Declining',
  new:      'Baru',
  churned:  'Churned',
  stable:   'Stable',
};

/* ── Format helpers ── */
const fmtRp  = n => 'Rp ' + Math.round(n || 0).toLocaleString('id-ID');
const fmtNum = n => Math.round(n || 0).toLocaleString('id-ID');
const fmtPct = n => (n == null ? '-' : (Number(n) >= 0 ? '+' : '') + Number(n).toFixed(1) + '%');
const fmtSign = n => (Number(n || 0) >= 0 ? '+' : '') + fmtNum(n);

function exportCSV(filename, headers, rows) {
  const BOM = '﻿';
  const lines = [headers.join(','), ...rows.map(r => r.join(','))];
  const blob = new Blob([BOM + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = filename; a.click();
}

/* ── Chart components ── */
function HBarChart({ id, labels, values, color = THEME }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: color, borderRadius: 4, barThickness: 18 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { size: 10 } } },
                  y: { ticks: { font: { size: 10 } } } },
      },
    });
    return () => chartRef.current?.destroy();
  }, [id]);
  return <canvas ref={ref} />;
}

function BarGroupChart({ id, labels, datasets }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { font: { size: 11 }, boxWidth: 12 } } },
        scales: {
          y:  { type: 'linear', position: 'left',  title: { display: true, text: 'TRX', font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
          y2: { type: 'linear', position: 'right', title: { display: true, text: 'Revenue', font: { size: 11 } }, grid: { drawOnChartArea: false } },
        },
      },
    });
    return () => chartRef.current?.destroy();
  }, [id]);
  return <canvas ref={ref} />;
}

function DonutChart({ id, labels, values, colors }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !values?.length) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(ref.current, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12, padding: 10 } } },
        cutout: '65%',
      },
    });
    return () => chartRef.current?.destroy();
  }, [id]);
  return <canvas ref={ref} />;
}

function ScatterPlot({ id, data }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !data?.length) return;
    chartRef.current?.destroy();
    const groups = {};
    data.forEach(d => {
      const s = d.status || 'stable';
      if (!groups[s]) groups[s] = [];
      groups[s].push({ x: Number(d.trx_jun), y: Number(d.rev_jun) });
    });
    chartRef.current = new Chart(ref.current, {
      type: 'scatter',
      data: {
        datasets: Object.entries(groups).map(([s, pts]) => ({
          label: STATUS_LABEL[s] || s,
          data: pts,
          backgroundColor: (STATUS_COLOR[s] || '#888') + 'aa',
          pointRadius: 4,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { font: { size: 11 }, boxWidth: 10 } } },
        scales: {
          x: { title: { display: true, text: 'TRX Jun', font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
          y: { title: { display: true, text: 'Revenue Jun', font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
        },
      },
    });
    return () => chartRef.current?.destroy();
  }, [id]);
  return <canvas ref={ref} />;
}

function DistChart({ id, data }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !data?.length) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(ref.current, {
      type: 'bar',
      data: {
        labels: data.map(d => d.range),
        datasets: [{ label: 'Jumlah Outlet', data: data.map(d => d.count), backgroundColor: THEME, borderRadius: 6 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { grid: { color: 'rgba(0,0,0,0.05)' } } },
      },
    });
    return () => chartRef.current?.destroy();
  }, [id]);
  return <canvas ref={ref} />;
}

/* ── UI components ── */
function KPICard({ title, value, sub, icon, color }) {
  return (
    <div className="wre-kpi-card">
      <div className="wre-kpi-icon" style={{ background: (color || THEME) + '18', color: color || THEME }}>
        <i className={`ti ti-${icon}`} />
      </div>
      <div className="wre-kpi-body">
        <div className="wre-kpi-title">{title}</div>
        <div className="wre-kpi-value" style={{ color: color || THEME }}>{value}</div>
        {sub && <div className="wre-kpi-sub">{sub}</div>}
      </div>
    </div>
  );
}

function ChartCard({ title, children, height = 280, action }) {
  return (
    <div className="wre-chart-card">
      <div className="wre-chart-card-header">
        <span className="wre-chart-card-title">{title}</span>
        {action}
      </div>
      <div style={{ height }}>{children}</div>
    </div>
  );
}

function StatusBadge({ status }) {
  return (
    <span className="wre-status-badge" style={{ background: (STATUS_COLOR[status] || '#888') + '20', color: STATUS_COLOR[status] || '#888' }}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function DevCell({ val, suffix = '' }) {
  const n = Number(val || 0);
  const color = n > 0 ? '#059669' : n < 0 ? '#DC2626' : '#6B7280';
  return <span style={{ color, fontWeight: 600 }}>{(n >= 0 ? '+' : '') + fmtNum(n)}{suffix}</span>;
}

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="wre-copy-btn" onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
      {copied ? <i className="ti ti-check" /> : <i className="ti ti-copy" />}
    </button>
  );
}

/* ── Insight builder ── */
function buildInsights(data) {
  const { summary: s = {}, status_counts: sc = {}, anomali = [] } = data;
  const growing      = sc.growing   || 0;
  const declining    = sc.declining || 0;
  const churned      = sc.churned   || 0;
  const newOut       = sc.new       || 0;
  const stable       = sc.stable    || 0;
  const anomaliCount = anomali.length;
  const growthTrx    = Number(s.pct_growth_trx || 0);
  const growthRev    = Number(s.pct_growth_rev || 0);
  const total        = s.total_aktif_jun || 0;
  const hari         = s.hari_berjalan || '-';

  const kondisi  = growthTrx >= 5 ? 'baik' : growthTrx >= 0 ? 'stabil' : 'perlu perhatian';
  const tTrx     = growthTrx >= 0 ? `tumbuh ${growthTrx.toFixed(1)}%` : `turun ${Math.abs(growthTrx).toFixed(1)}%`;
  const tRev     = growthRev >= 0 ? `tumbuh ${growthRev.toFixed(1)}%` : `turun ${Math.abs(growthRev).toFixed(1)}%`;
  const dominant = growing > declining ? 'pertumbuhan outlet lebih banyak dari yang turun' : declining > growing ? 'lebih banyak outlet yang mengalami penurunan TRX' : 'TRX outlet terbilang seimbang';

  const ringkasan =
    `Pada hari ke-${hari} Juni, ${fmtNum(total)} outlet aktif dengan TRX ${tTrx} dan revenue ${tRev} dibanding Mei (bulan penuh). ` +
    `Kondisi keseluruhan ${kondisi} — ${dominant}. ` +
    `Dari total outlet: ${growing} growing, ${declining} declining, ${newOut} baru, ${churned} churned, ${stable} stable.` +
    (anomaliCount > 0 ? ` Terdapat ${anomaliCount} outlet anomali (TRX naik namun revenue turun) yang perlu diinvestigasi.` : '');

  const recs = [];

  if (churned > 0)
    recs.push({ level: 'high', icon: '🚨',
      title: 'Recovery Call Outlet Hilang',
      text: `${churned} outlet churned bulan ini. Hubungi segera sebelum akhir Juni agar bisa diaktifkan kembali dan tidak kehilangan revenue bulan depan.` });

  if (declining > growing)
    recs.push({ level: 'high', icon: '⚠️',
      title: 'Intervensi Outlet Declining',
      text: `Outlet declining (${declining}) melebihi growing (${growing}). Identifikasi pola penyebab (hari libur, kompetitor, kendala teknis) dan berikan pendampingan langsung kepada outlet dengan penurunan terbesar.` });

  if (anomaliCount > 0)
    recs.push({ level: 'medium', icon: '🔍',
      title: 'Investigasi Anomali Margin',
      text: `${anomaliCount} outlet menunjukkan TRX naik tapi revenue turun. Cek apakah ada pergeseran ke jenis transaksi bernilai rendah atau potongan fee yang meningkat.` });

  if (newOut > 0)
    recs.push({ level: 'medium', icon: '✨',
      title: 'Onboarding Outlet Baru',
      text: `${newOut} outlet baru aktif bulan ini. Lakukan onboarding terstruktur dan pendampingan rutin agar konsisten aktif di bulan-bulan berikutnya.` });

  if (growing > 0 && growing >= declining)
    recs.push({ level: 'low', icon: '📈',
      title: 'Pertahankan Momentum Growth',
      text: `${growing} outlet sedang tumbuh. Lakukan komunikasi rutin, berikan apresiasi, dan dorong peningkatan nilai transaksi agar pertumbuhan berlanjut.` });

  if (stable > 0)
    recs.push({ level: 'low', icon: '📌',
      title: 'Aktivasi Outlet Stable',
      text: `${stable} outlet stagnan (TRX tidak berubah). Dorong dengan program insentif atau edukasi produk baru agar masuk kategori growing.` });

  if (growthTrx >= 10)
    recs.push({ level: 'low', icon: '🎯',
      title: 'Proyeksi Akhir Bulan Positif',
      text: `TRX sudah tumbuh ${growthTrx.toFixed(1)}% di hari ke-${hari}. Jika tren berlanjut, proyeksi akhir bulan sangat optimistis — pertimbangkan target lebih tinggi untuk Juli.` });

  return { ringkasan, recs: recs.slice(0, 5) };
}

const REC_LEVEL = {
  high:   { label: 'Prioritas Tinggi', bg: '#FEF2F2', border: '#DC2626', color: '#DC2626' },
  medium: { label: 'Prioritas Sedang', bg: '#FFFBEB', border: '#D97706', color: '#D97706' },
  low:    { label: 'Prioritas Rendah', bg: '#F0FDF4', border: '#059669', color: '#059669' },
};

function ExecInsightCard({ data }) {
  const { ringkasan, recs } = buildInsights(data);
  return (
    <div className="wre-insight-block">
      {/* Ringkasan Eksekutif */}
      <div className="wre-exec-summary-card">
        <div className="wre-exec-summary-header">
          <i className="ti ti-report-analytics" style={{ color: THEME }} />
          <span>Ringkasan Eksekutif</span>
        </div>
        <p className="wre-exec-summary-text">{ringkasan}</p>
      </div>

      {/* Rekomendasi */}
      <div className="wre-exec-recs-card">
        <div className="wre-exec-summary-header">
          <i className="ti ti-bulb" style={{ color: '#D97706' }} />
          <span>Rekomendasi</span>
        </div>
        <div className="wre-recs-list">
          {recs.map((r, i) => {
            const lv = REC_LEVEL[r.level];
            return (
              <div key={i} className="wre-rec-item" style={{ borderLeftColor: lv.border, background: lv.bg }}>
                <div className="wre-rec-top">
                  <span className="wre-rec-icon">{r.icon}</span>
                  <span className="wre-rec-title">{r.title}</span>
                  <span className="wre-rec-level" style={{ color: lv.color, background: lv.color + '18' }}>{lv.label}</span>
                </div>
                <p className="wre-rec-text">{r.text}</p>
              </div>
            );
          })}
          {recs.length === 0 && (
            <div className="wre-empty" style={{ padding: '16px' }}>
              ✅ Tidak ada rekomendasi khusus — kondisi outlet dalam keadaan baik.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Tab 1: Executive Summary ── */
function ExecutiveSummaryTab({ data, tanggal }) {
  const { summary, status_counts, top10_trx_jun, monthly_trend } = data;
  const id = `exec-${tanggal}`;

  const sc = status_counts || {};
  const statusLabels  = Object.keys(STATUS_LABEL);
  const statusValues  = statusLabels.map(s => sc[s] || 0);
  const statusColors  = statusLabels.map(s => STATUS_COLOR[s]);

  const trendLabels = (monthly_trend || []).map(t => t.month);
  const trendDatasets = [
    { label: 'TRX', data: (monthly_trend || []).map(t => t.total_trx), backgroundColor: THEME + 'cc', yAxisID: 'y', borderRadius: 4 },
    { label: 'Revenue', data: (monthly_trend || []).map(t => t.total_rev), backgroundColor: '#E2D9FC', type: 'line', yAxisID: 'y2', borderColor: '#5B21B6', tension: 0.4, fill: false, pointRadius: 4 },
  ];

  return (
    <div>
      {/* KPI Grid */}
      <div className="wre-kpi-grid">
        <KPICard title="Outlet Aktif Jun" value={fmtNum(summary.total_aktif_jun)} icon="building-store" color={THEME} />
        <KPICard title="Total TRX Juni" value={fmtNum(summary.total_trx_jun)}
          sub={`vs Mei: ${fmtSign(summary.total_trx_jun - summary.total_trx_mei)} (${fmtPct(summary.pct_growth_trx)})`}
          icon="repeat" color={Number(summary.pct_growth_trx) >= 0 ? '#059669' : '#DC2626'} />
        <KPICard title="Total Revenue Juni" value={fmtRp(summary.total_rev_jun)}
          sub={`vs Mei: ${fmtSign(summary.total_rev_jun - summary.total_rev_mei)} (${fmtPct(summary.pct_growth_rev)})`}
          icon="coin" color={Number(summary.pct_growth_rev) >= 0 ? '#059669' : '#DC2626'} />
        <KPICard title="Avg Rev / TRX" value={fmtRp(summary.avg_rev_per_trx)} icon="chart-bar" color="#7C3AED" />
        <KPICard title="Outlet Baru Jun" value={fmtNum(summary.total_new)} icon="sparkles" color="#2563EB" />
      </div>

      <div className="wre-charts-row">
        {/* Trend Chart */}
        <ChartCard title="Trend Bulanan — TRX &amp; Revenue" height={260}>
          <BarGroupChart id={`trend-${id}`} labels={trendLabels} datasets={trendDatasets} />
        </ChartCard>

        {/* Status Donut */}
        <ChartCard title="Status Outlet" height={260}>
          <DonutChart id={`donut-${id}`}
            labels={statusLabels.map(s => `${STATUS_LABEL[s]} (${sc[s] || 0})`)}
            values={statusValues} colors={statusColors} />
        </ChartCard>
      </div>

      {/* Top 10 TRX */}
      <ChartCard title="Top 10 Outlet — TRX Juni" height={260}>
        <HBarChart id={`top10-${id}`}
          labels={(top10_trx_jun || []).map(r => r.id_outlet)}
          values={(top10_trx_jun || []).map(r => Number(r.trx_jun))} />
      </ChartCard>

      {/* Ringkasan Eksekutif & Rekomendasi — di paling bawah */}
      <ExecInsightCard data={data} />
    </div>
  );
}

/* ── Tab 2: Growth & Churn ── */
function GrowthChurnTab({ data, tanggal }) {
  const { summary, status_counts, top20_growth_trx, top20_decline_trx } = data;
  const sc = status_counts || {};

  const handleExport = (rows, type) => {
    exportCSV(
      `ekspedisi-${type}-${tanggal}.csv`,
      ['ID Outlet', 'TRX Mei', 'TRX Jun', 'Δ TRX', '% Growth', 'Rev Jun'],
      rows.map(r => [r.id_outlet, r.trx_mei, r.trx_jun, r.dev_trx_mei_jun, r.pct_trx_growth?.toFixed(1), r.rev_jun])
    );
  };

  return (
    <div>
      {/* Insight cards */}
      <div className="wre-insight-grid">
        <div className="wre-insight-card wre-insight-green">
          <span className="wre-insight-icon">🚀</span>
          <div><div className="wre-insight-val">{fmtNum(sc.growing)}</div><div className="wre-insight-lbl">Growing</div></div>
        </div>
        <div className="wre-insight-card wre-insight-red">
          <span className="wre-insight-icon">⚠️</span>
          <div><div className="wre-insight-val">{fmtNum(sc.declining)}</div><div className="wre-insight-lbl">Declining</div></div>
        </div>
        <div className="wre-insight-card wre-insight-blue">
          <span className="wre-insight-icon">✨</span>
          <div><div className="wre-insight-val">{fmtNum(sc.new)}</div><div className="wre-insight-lbl">Outlet Baru</div></div>
        </div>
        <div className="wre-insight-card wre-insight-gray">
          <span className="wre-insight-icon">💀</span>
          <div><div className="wre-insight-val">{fmtNum(sc.churned)}</div><div className="wre-insight-lbl">Churned</div></div>
        </div>
      </div>

      {/* Top 20 Growth */}
      <div className="wre-table-section">
        <div className="wre-table-header">
          <span>📈 Top 20 Growth TRX (Mei → Jun)</span>
          <button className="wre-export-btn" onClick={() => handleExport(top20_growth_trx || [], 'growth')}>
            <i className="ti ti-download" /> Export CSV
          </button>
        </div>
        <div className="wre-table-wrap">
          <table className="wre-table">
            <thead><tr><th>ID Outlet</th><th>TRX Mei</th><th>TRX Jun</th><th>Δ TRX</th><th>% Growth</th><th>Rev Jun</th></tr></thead>
            <tbody>
              {(top20_growth_trx || []).map(r => (
                <tr key={r.id_outlet}>
                  <td className="wre-outlet-id">{r.id_outlet}</td>
                  <td>{fmtNum(r.trx_mei)}</td>
                  <td>{fmtNum(r.trx_jun)}</td>
                  <td><DevCell val={r.dev_trx_mei_jun} /></td>
                  <td><DevCell val={r.pct_trx_growth} suffix="%" /></td>
                  <td>{fmtRp(r.rev_jun)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Top 20 Decline */}
      <div className="wre-table-section">
        <div className="wre-table-header">
          <span>📉 Top 20 Decline TRX (Mei → Jun)</span>
          <button className="wre-export-btn" onClick={() => handleExport(top20_decline_trx || [], 'decline')}>
            <i className="ti ti-download" /> Export CSV
          </button>
        </div>
        <div className="wre-table-wrap">
          <table className="wre-table">
            <thead><tr><th>ID Outlet</th><th>TRX Mei</th><th>TRX Jun</th><th>Δ TRX</th><th>% Change</th><th>Rev Jun</th></tr></thead>
            <tbody>
              {(top20_decline_trx || []).map(r => (
                <tr key={r.id_outlet}>
                  <td className="wre-outlet-id">{r.id_outlet}</td>
                  <td>{fmtNum(r.trx_mei)}</td>
                  <td>{fmtNum(r.trx_jun)}</td>
                  <td><DevCell val={r.dev_trx_mei_jun} /></td>
                  <td><DevCell val={r.pct_trx_growth} suffix="%" /></td>
                  <td>{fmtRp(r.rev_jun)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ── Tab 3: Outlet Detail ── */
function OutletDetailTab({ data, tanggal }) {
  const allOutlets = data.outlet_all || [];
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortCol, setSortCol] = useState('trx_jun');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const filtered = useMemo(() => {
    let rows = allOutlets;
    if (search) rows = rows.filter(r => r.id_outlet.toLowerCase().includes(search.toLowerCase()));
    if (statusFilter !== 'all') rows = rows.filter(r => r.status === statusFilter);
    rows = [...rows].sort((a, b) => {
      const av = Number(a[sortCol] || 0), bv = Number(b[sortCol] || 0);
      return sortDir === 'desc' ? bv - av : av - bv;
    });
    return rows;
  }, [allOutlets, search, statusFilter, sortCol, sortDir]);

  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  function toggleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortCol(col); setSortDir('desc'); }
    setPage(0);
  }

  function SortTh({ col, children }) {
    const active = sortCol === col;
    return (
      <th onClick={() => toggleSort(col)} style={{ cursor: 'pointer', userSelect: 'none' }}>
        {children} {active ? (sortDir === 'desc' ? '↓' : '↑') : ''}
      </th>
    );
  }

  const handleExport = () => {
    exportCSV(
      `ekspedisi-outlet-${tanggal}.csv`,
      ['ID Outlet', 'TRX Apr', 'TRX Mei', 'TRX Jun', 'Rev Jun', 'Δ TRX', 'Δ Rev', 'Status'],
      filtered.map(r => [r.id_outlet, r.trx_apr, r.trx_mei, r.trx_jun, r.rev_jun, r.dev_trx_mei_jun, r.dev_rev_mei_jun, r.status])
    );
  };

  return (
    <div>
      <div className="wre-filter-row">
        <input className="wre-search" placeholder="Cari ID Outlet..." value={search}
          onChange={e => { setSearch(e.target.value); setPage(0); }} />
        <select className="wre-select" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(0); }}>
          <option value="all">Semua Status</option>
          {Object.keys(STATUS_LABEL).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <button className="wre-export-btn" onClick={handleExport}><i className="ti ti-download" /> Export CSV</button>
        <span className="wre-count-badge">{fmtNum(filtered.length)} outlet</span>
      </div>

      <div className="wre-table-wrap">
        <table className="wre-table">
          <thead>
            <tr>
              <th>ID Outlet</th>
              <SortTh col="trx_apr">TRX Apr</SortTh>
              <SortTh col="trx_mei">TRX Mei</SortTh>
              <SortTh col="trx_jun">TRX Jun</SortTh>
              <SortTh col="rev_jun">Rev Jun</SortTh>
              <th>Status</th>
              <SortTh col="dev_trx_mei_jun">Δ TRX</SortTh>
              <SortTh col="dev_rev_mei_jun">Δ Rev</SortTh>
            </tr>
          </thead>
          <tbody>
            {paged.map(r => (
              <tr key={r.id_outlet}>
                <td className="wre-outlet-id">{r.id_outlet}</td>
                <td>{fmtNum(r.trx_apr)}</td>
                <td>{fmtNum(r.trx_mei)}</td>
                <td>{fmtNum(r.trx_jun)}</td>
                <td>{fmtRp(r.rev_jun)}</td>
                <td><StatusBadge status={r.status} /></td>
                <td><DevCell val={r.dev_trx_mei_jun} /></td>
                <td><DevCell val={r.dev_rev_mei_jun} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="wre-pagination">
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
          <span>{page + 1} / {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next ›</button>
        </div>
      )}
    </div>
  );
}

/* ── Tab 4: Revenue Analysis ── */
function RevenueAnalysisTab({ data, tanggal }) {
  const { top10_rev_jun, scatter_data, anomali } = data;
  const id = `rev-${tanggal}`;

  return (
    <div>
      <div className="wre-charts-row">
        <ChartCard title="Top 10 Revenue Juni" height={280}>
          <HBarChart id={`top10rev-${id}`}
            labels={(top10_rev_jun || []).map(r => r.id_outlet)}
            values={(top10_rev_jun || []).map(r => Number(r.rev_jun))}
            color="#7C3AED" />
        </ChartCard>
        <ChartCard title="Scatter TRX vs Revenue (max 2000 outlet)" height={280}>
          <ScatterPlot id={`scatter-${id}`} data={scatter_data || []} />
        </ChartCard>
      </div>

      {/* Anomali: TRX naik tapi rev turun */}
      <div className="wre-table-section">
        <div className="wre-table-header">
          <span>⚠️ Anomali — TRX Naik tapi Revenue Turun ({(anomali || []).length} outlet)</span>
        </div>
        {(anomali || []).length === 0
          ? <div className="wre-empty">Tidak ada anomali terdeteksi ✓</div>
          : (
            <div className="wre-table-wrap">
              <table className="wre-table">
                <thead><tr><th>ID Outlet</th><th>TRX Mei</th><th>TRX Jun</th><th>Δ TRX</th><th>Rev Mei</th><th>Rev Jun</th><th>Δ Rev</th></tr></thead>
                <tbody>
                  {(anomali || []).map(r => (
                    <tr key={r.id_outlet} className="wre-row-anomali">
                      <td className="wre-outlet-id">{r.id_outlet}</td>
                      <td>{fmtNum(r.trx_mei)}</td>
                      <td>{fmtNum(r.trx_jun)}</td>
                      <td><DevCell val={r.dev_trx_mei_jun} /></td>
                      <td>{fmtRp(r.rev_mei)}</td>
                      <td>{fmtRp(r.rev_jun)}</td>
                      <td><DevCell val={r.dev_rev_mei_jun} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

/* ── Tab 5: TRX Distribution ── */
function TRXDistributionTab({ data, tanggal }) {
  const { trx_distribution, monthly_trend } = data;
  const id = `dist-${tanggal}`;

  const mtLabels = (monthly_trend || []).map(t => t.month);
  const mtDatasets = [{
    label: 'Total TRX',
    data: (monthly_trend || []).map(t => t.total_trx),
    backgroundColor: [THEME + '99', THEME + 'cc', THEME],
    borderRadius: 6,
  }];

  return (
    <div>
      <div className="wre-charts-row">
        <ChartCard title="Distribusi Outlet per Range TRX Juni" height={280}>
          <DistChart id={`dist-${id}`} data={trx_distribution || []} />
        </ChartCard>
        <ChartCard title="Perbandingan Total TRX — Apr / Mei / Jun" height={280}>
          <BarGroupChart id={`monthly-${id}`} labels={mtLabels} datasets={mtDatasets.map(d => ({ ...d, yAxisID: undefined }))} />
        </ChartCard>
      </div>

      <div className="wre-table-section">
        <div className="wre-table-header"><span>Ringkasan Distribusi TRX</span></div>
        <div className="wre-table-wrap">
          <table className="wre-table">
            <thead><tr><th>Range TRX/Bulan</th><th>Jumlah Outlet</th><th>% dari Total Aktif</th></tr></thead>
            <tbody>
              {(trx_distribution || []).map(d => {
                const total = (trx_distribution || []).reduce((s, x) => s + Number(x.count), 0) || 1;
                return (
                  <tr key={d.range}>
                    <td><span className="wre-range-badge">{d.range}</span></td>
                    <td>{fmtNum(d.count)}</td>
                    <td>{((Number(d.count) / total) * 100).toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ── Tab 6: Action Center ── */
function ActionTable({ rows, cols, tanggal, label }) {
  const handleExport = () => {
    exportCSV(
      `ekspedisi-action-${label}-${tanggal}.csv`,
      cols.map(c => c.header),
      rows.map(r => cols.map(c => r[c.key]))
    );
  };
  return (
    <div className="wre-table-section">
      <div className="wre-table-header">
        <span>{rows.length} outlet</span>
        <button className="wre-export-btn" onClick={handleExport}><i className="ti ti-download" /> Export</button>
      </div>
      <div className="wre-table-wrap">
        <table className="wre-table">
          <thead><tr>{cols.map(c => <th key={c.key}>{c.header}</th>)}<th /></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id_outlet}>
                {cols.map(c => (
                  <td key={c.key}>
                    {c.fmt === 'rp'   ? fmtRp(r[c.key])
                    : c.fmt === 'dev' ? <DevCell val={r[c.key]} />
                    : c.fmt === 'pct' ? <DevCell val={r[c.key]} suffix="%" />
                    : c.key === 'id_outlet' ? <span className="wre-outlet-id">{r[c.key]}</span>
                    : fmtNum(r[c.key])}
                  </td>
                ))}
                <td><CopyBtn text={r.id_outlet} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActionCenterTab({ data, tanggal }) {
  const { action_drop, action_growth, action_new, action_churned } = data;

  const dropCols    = [{ key: 'id_outlet', header: 'ID Outlet' }, { key: 'trx_mei', header: 'TRX Mei' }, { key: 'trx_jun', header: 'TRX Jun' }, { key: 'dev_trx_mei_jun', header: 'Δ TRX', fmt: 'dev' }, { key: 'pct_trx_growth', header: '% Change', fmt: 'pct' }, { key: 'rev_jun', header: 'Rev Jun', fmt: 'rp' }];
  const growthCols  = [{ key: 'id_outlet', header: 'ID Outlet' }, { key: 'trx_mei', header: 'TRX Mei' }, { key: 'trx_jun', header: 'TRX Jun' }, { key: 'dev_trx_mei_jun', header: 'Δ TRX', fmt: 'dev' }, { key: 'pct_trx_growth', header: '% Growth', fmt: 'pct' }, { key: 'rev_jun', header: 'Rev Jun', fmt: 'rp' }];
  const newCols     = [{ key: 'id_outlet', header: 'ID Outlet' }, { key: 'trx_jun', header: 'TRX Jun' }, { key: 'rev_jun', header: 'Rev Jun', fmt: 'rp' }];
  const churnedCols = [{ key: 'id_outlet', header: 'ID Outlet' }, { key: 'trx_apr', header: 'TRX Apr' }, { key: 'trx_mei', header: 'TRX Mei' }, { key: 'rev_mei', header: 'Rev Mei Terakhir', fmt: 'rp' }];

  const sections = [
    { icon: '🚨', title: 'Wajib Diselamatkan', sub: 'Outlet declining terbesar — hubungi sekarang', rows: action_drop || [], cols: dropCols, color: '#DC2626', label: 'drop' },
    { icon: '📈', title: 'Wajib Dihubungi', sub: 'Outlet dengan growth TRX tertinggi — maintain momentum', rows: action_growth || [], cols: growthCols, color: '#059669', label: 'growth' },
    { icon: '✨', title: 'Outlet Baru', sub: 'Baru masuk bulan ini — perlu onboarding & pendampingan', rows: action_new || [], cols: newCols, color: '#2563EB', label: 'new' },
    { icon: '💀', title: 'Outlet Hilang', sub: 'Churned bulan ini — perlu recovery call', rows: action_churned || [], cols: churnedCols, color: '#9CA3AF', label: 'churned' },
  ];

  return (
    <div>
      {sections.map(s => (
        <div key={s.label} className="wre-action-section">
          <div className="wre-action-header" style={{ borderLeftColor: s.color }}>
            <span className="wre-action-icon">{s.icon}</span>
            <div>
              <div className="wre-action-title" style={{ color: s.color }}>{s.title}</div>
              <div className="wre-action-sub">{s.sub}</div>
            </div>
          </div>
          {s.rows.length === 0
            ? <div className="wre-empty">Tidak ada data</div>
            : <ActionTable rows={s.rows} cols={s.cols} tanggal={tanggal} label={s.label} />
          }
        </div>
      ))}
    </div>
  );
}

/* ── Tabs config ── */
const TABS = [
  { key: 'executive',    label: 'Executive Summary',      icon: 'chart-bar'    },
  { key: 'growth',       label: 'Growth & Churn',         icon: 'trending-up'  },
  { key: 'detail',       label: 'Outlet Detail',          icon: 'table'        },
  { key: 'revenue',      label: 'Revenue Analysis',       icon: 'coin'         },
  { key: 'distribution', label: 'TRX Distribution',       icon: 'chart-dots'   },
  { key: 'action',       label: 'Action Center',          icon: 'bolt'         },
];

/* ── Main Component ── */
export default function WarRoomEkspedisi() {
  const [activeTab, setActiveTab] = useState('executive');
  const [analytics, setAnalytics] = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);

  async function fetchData() {
    setLoading(true); setError(null);
    try {
      const res = await getEkspedisiAnalytics();
      setAnalytics(res);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); }, []);

  const tanggal = analytics?.tanggal
    ? new Date(analytics.tanggal).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
    : '-';
  const hari = analytics?.summary?.hari_berjalan;

  if (loading) {
    return (
      <Layout>
        <div className="wre-loading">
          <i className="ti ti-loader-2 wre-spin" style={{ color: THEME }} />
          <span>Memuat data ekspedisi…</span>
        </div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <div className="wre-error">
          <i className="ti ti-alert-triangle" style={{ color: '#DC2626', fontSize: 32 }} />
          <p>{error}</p>
          <button className="wre-retry-btn" onClick={fetchData}>Coba Lagi</button>
        </div>
      </Layout>
    );
  }

  if (!analytics?.tanggal) {
    return (
      <Layout>
        <div className="wre-empty-state">
          <i className="ti ti-database-off" style={{ fontSize: 40, color: '#9CA3AF' }} />
          <p>Belum ada data ekspedisi. Jalankan Apps Script untuk sync pertama.</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
    <div className="wre-page">
      {/* Header */}
      <div className="wre-header">
        <div className="wre-header-left">
          <i className="ti ti-truck-delivery wre-header-icon" style={{ color: THEME }} />
          <div>
            <div className="wre-header-title">WAR-ROOM EKSPEDISI</div>
            <div className="wre-header-sub">Monitoring Outlet Payment Agent — Okta</div>
          </div>
        </div>
        <div className="wre-header-badges">
          <span className="wre-badge wre-badge-owner">👤 Okta</span>
          <span className="wre-badge wre-badge-date">📅 {tanggal}</span>
          {hari && <span className="wre-badge wre-badge-hari">Juni — Hari ke-{hari}</span>}
          <button className="wre-refresh-btn" onClick={fetchData} title="Refresh data">
            <i className="ti ti-refresh" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="wre-tab-nav">
        {TABS.map(t => (
          <button key={t.key}
            className={'wre-tab-btn' + (activeTab === t.key ? ' wre-tab-btn--active' : '')}
            onClick={() => setActiveTab(t.key)}>
            <i className={`ti ti-${t.icon}`} /> {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="wre-tab-content">
        {activeTab === 'executive'    && <ExecutiveSummaryTab  data={analytics} tanggal={analytics.tanggal} />}
        {activeTab === 'growth'       && <GrowthChurnTab       data={analytics} tanggal={analytics.tanggal} />}
        {activeTab === 'detail'       && <OutletDetailTab      data={analytics} tanggal={analytics.tanggal} />}
        {activeTab === 'revenue'      && <RevenueAnalysisTab   data={analytics} tanggal={analytics.tanggal} />}
        {activeTab === 'distribution' && <TRXDistributionTab   data={analytics} tanggal={analytics.tanggal} />}
        {activeTab === 'action'       && <ActionCenterTab      data={analytics} tanggal={analytics.tanggal} />}
      </div>
    </div>
    </Layout>
  );
}
