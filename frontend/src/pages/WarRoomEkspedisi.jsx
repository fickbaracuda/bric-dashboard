import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import {
  getEkspedisiAnalytics,
  getEkspedisiOutletStatus, updateEkspedisiOutletStatus,
  getEkspedisiNotes, addEkspedisiNote,
} from '../services/api';

/* ── Constants ── */
const THEME = '#8B5CF6';

const SEGMENT_LABEL = {
  whale: 'Whale', growth_driver: 'Growth Driver', at_risk: 'At Risk', churn: 'Churn',
  new_active: 'New Active', one_timer: 'One Timer', low_yield: 'Low Yield',
  premium_yield: 'Premium Yield', stable: 'Stable', declining: 'Declining',
};
const SEGMENT_COLOR = {
  whale: '#7C3AED', growth_driver: '#059669', at_risk: '#D97706', churn: '#9CA3AF',
  new_active: '#2563EB', one_timer: '#0EA5E9', low_yield: '#DC2626',
  premium_yield: '#DB2777', stable: '#65A30D', declining: '#EA580C',
};
// Kelas CSS per segmen — nama disesuaikan dengan contoh yang diminta
// (wre-segment-whale/churn/growth/declining/new/low-yield), sisanya konsisten.
const SEGMENT_CLASS = {
  whale: 'wre-segment-whale', growth_driver: 'wre-segment-growth', at_risk: 'wre-segment-at-risk',
  churn: 'wre-segment-churn', new_active: 'wre-segment-new', one_timer: 'wre-segment-one-timer',
  low_yield: 'wre-segment-low-yield', premium_yield: 'wre-segment-premium-yield',
  stable: 'wre-segment-stable', declining: 'wre-segment-declining',
};
const PRIORITY_LABEL = { P0: 'P0 Critical', P1: 'P1 High Impact', P2: 'P2 Growth Opportunity', P3: 'P3 Maintain' };
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

const EMPTY_NO_DATA    = 'Tidak ada data ekspedisi pada periode ini.';
const EMPTY_NO_MATCH   = 'Tidak ada outlet yang cocok dengan filter ini.';
const EMPTY_P0         = 'Tidak ada outlet prioritas P0 saat ini.';
const EMPTY_NO_COMPARE = 'Belum ada data bulan pembanding.';

// Insight tertentu dari backend ditampilkan dengan copy yang lebih lengkap di UI
// (kondisi deteksi tetap di backend, teks tampilan di-override di sini).
const INSIGHT_COPY_OVERRIDE = {
  revenue_lag: 'Volume transaksi naik, tetapi revenue per transaksi turun. Fokus minggu ini: dorong outlet high-volume agar masuk produk/margin yang lebih sehat, dan reaktivasi outlet aktif bulan lalu yang belum transaksi bulan ini.',
};

// Template WA follow-up per segmen (placeholder — belum tersambung backend)
const WA_TEMPLATE = {
  churn: 'Halo Kak, kami lihat outlet Kakak belum ada transaksi ekspedisi lagi bulan ini. Apakah ada kendala saat transaksi atau ada yang bisa kami bantu agar outlet bisa aktif kembali?',
  declining: 'Halo Kak, transaksi ekspedisi outlet Kakak bulan ini terlihat menurun dibanding bulan sebelumnya. Apakah ada kendala operasional, saldo, sistem, atau kebutuhan promo yang bisa kami bantu?',
  new: 'Halo Kak, terima kasih sudah mulai transaksi ekspedisi. Biar outlet Kakak makin aktif, yuk lanjutkan transaksi berikutnya. Kalau ada kendala penggunaan, kami siap bantu.',
  whale: 'Halo Kak, outlet Kakak termasuk outlet aktif dengan transaksi tinggi. Kami ingin pastikan proses transaksi ekspedisi tetap lancar. Apakah ada kendala atau kebutuhan support tambahan?',
  low_yield: 'Halo Kak, kami ingin bantu optimalkan transaksi ekspedisi outlet Kakak agar hasilnya lebih maksimal. Apakah ada kendala pada jenis transaksi, harga, atau kebutuhan produk ekspedisi tertentu?',
};
const WA_TEMPLATE_BY_SEGMENT = {
  churn: 'churn', declining: 'declining', at_risk: 'declining',
  new_active: 'new', one_timer: 'new',
  whale: 'whale', growth_driver: 'whale', premium_yield: 'whale', stable: 'whale',
  low_yield: 'low_yield',
};
function getWaText(segment) {
  return WA_TEMPLATE[WA_TEMPLATE_BY_SEGMENT[segment] || 'whale'];
}

/* ── Format helpers ── */
const fmtRp  = n => 'Rp ' + Math.round(n || 0).toLocaleString('id-ID');
const fmtNum = n => Math.round(n || 0).toLocaleString('id-ID');
const fmtPct = n => (n == null ? '-' : (Number(n) >= 0 ? '+' : '') + Number(n).toFixed(1) + '%');

function exportCSV(filename, headers, rows) {
  const BOM = '﻿';
  const lines = [headers.join(','), ...rows.map(r => r.join(','))];
  const blob = new Blob([BOM + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = filename; a.click();
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function isTrulyNew(o)    { return o.previousTrx === 0 && o.currentTrx > 0 && o.activeMonthCount <= 1; }
function isReactivated(o) { return o.previousTrx === 0 && o.currentTrx > 0 && o.activeMonthCount > 1; }

function buildHealthSummary(businessMetrics, summary) {
  const trxG = Number(summary.pctTrxGrowth || 0);
  const revG = Number(summary.pctRevenueGrowth || 0);
  const churnRatePct = businessMetrics.churnRate != null ? businessMetrics.churnRate * 100 : null;

  let verdict = 'Stabil', color = '#D97706';
  if (trxG >= 5 && revG >= 0 && (churnRatePct == null || churnRatePct < 20)) { verdict = 'Baik'; color = '#059669'; }
  else if (trxG < 0 || (churnRatePct != null && churnRatePct >= 30))          { verdict = 'Perlu Perhatian'; color = '#DC2626'; }

  const text =
    `TRX ${trxG >= 0 ? 'tumbuh' : 'turun'} ${Math.abs(trxG).toFixed(1)}%, revenue ${revG >= 0 ? 'tumbuh' : 'turun'} ${Math.abs(revG).toFixed(1)}%` +
    (churnRatePct != null ? `, churn rate ${churnRatePct.toFixed(1)}%` : '') +
    (businessMetrics.dependencyRisk != null ? `, top 10 outlet menyumbang ${(businessMetrics.dependencyRisk * 100).toFixed(1)}% revenue` : '') + '.';

  return { verdict, color, text };
}

/* ── Toast (placeholder actions — belum tersambung backend) ── */
function useToast() {
  const [toast, setToast] = useState(null);
  const show = useCallback((text) => {
    setToast(text);
    setTimeout(() => setToast(null), 2200);
  }, []);
  return [toast, show];
}
function Toast({ text }) {
  if (!text) return null;
  return <div className="wre-toast">{text}</div>;
}

/* ── Chart components ── */
function LineChart({ id, labels, datasets, yTitle }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(ref.current, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { font: { size: 11 }, boxWidth: 12 } } },
        scales: { y: { title: { display: !!yTitle, text: yTitle, font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } } },
      },
    });
    return () => chartRef.current?.destroy();
  }, [id]);
  return <canvas ref={ref} />;
}

function VBarChart({ id, labels, values, color = THEME }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: color, borderRadius: 4 }] },
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

function HBarChart({ id, labels, values, color = THEME }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: color, borderRadius: 4, barThickness: 16 }] },
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

function BarGroupChart({ id, labels, datasets, yTitle = 'TRX', y2Title = 'Revenue', y2Max }) {
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
          y:  { type: 'linear', position: 'left',  title: { display: true, text: yTitle, font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
          y2: { type: 'linear', position: 'right', title: { display: true, text: y2Title, font: { size: 11 } }, grid: { drawOnChartArea: false }, ...(y2Max ? { max: y2Max, min: 0 } : {}) },
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
    data.forEach(o => {
      const s = o.segment || 'stable';
      if (!groups[s]) groups[s] = [];
      groups[s].push({ x: o.currentTrx, y: o.currentRevenue });
    });
    chartRef.current = new Chart(ref.current, {
      type: 'scatter',
      data: {
        datasets: Object.entries(groups).map(([s, pts]) => ({
          label: SEGMENT_LABEL[s] || s, data: pts,
          backgroundColor: (SEGMENT_COLOR[s] || '#888') + 'aa', pointRadius: 4,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { font: { size: 10 }, boxWidth: 10 } } },
        scales: {
          x: { title: { display: true, text: 'TRX', font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
          y: { title: { display: true, text: 'Revenue', font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
        },
      },
    });
    return () => chartRef.current?.destroy();
  }, [id]);
  return <canvas ref={ref} />;
}

/* ── UI atoms ── */
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

function ChartCard({ title, children, height = 280 }) {
  return (
    <div className="wre-chart-card">
      <div className="wre-chart-card-header"><span className="wre-chart-card-title">{title}</span></div>
      <div style={{ height }}>{children}</div>
    </div>
  );
}

function SegmentBadge({ segment }) {
  const cls = 'wre-segment-badge ' + (SEGMENT_CLASS[segment] || 'wre-segment-stable');
  return <span className={cls}>{SEGMENT_LABEL[segment] || segment}</span>;
}
function PriorityBadge({ priority }) {
  const cls = 'wre-priority-badge wre-priority-' + String(priority || 'p3').toLowerCase();
  return <span className={cls}>{PRIORITY_LABEL[priority] || priority}</span>;
}
function DevCell({ val, suffix = '' }) {
  const n = Number(val || 0);
  const color = n > 0 ? '#059669' : n < 0 ? '#DC2626' : '#6B7280';
  return <span style={{ color, fontWeight: 600 }}>{(n >= 0 ? '+' : '') + fmtNum(n)}{suffix}</span>;
}

/* ── Sort-by helper — dipakai semua tabel di halaman ini ──
   sortCol=null berarti "pakai urutan default bawaan tabel" (dipakai
   Execution Queue yang defaultnya priority-based, bukan kolom biasa). */
function useSortedRows(rows, initialCol = null, initialDir = 'desc') {
  const [sortCol, setSortCol] = useState(initialCol);
  const [sortDir, setSortDir] = useState(initialDir);

  const sorted = useMemo(() => {
    if (!sortCol) return rows;
    return [...rows].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (typeof av === 'string' || typeof bv === 'string') {
        const as = String(av ?? ''), bs = String(bv ?? '');
        return sortDir === 'desc' ? bs.localeCompare(as) : as.localeCompare(bs);
      }
      const an = Number(av || 0), bn = Number(bv || 0);
      return sortDir === 'desc' ? bn - an : an - bn;
    });
  }, [rows, sortCol, sortDir]);

  const toggleSort = useCallback((col) => {
    setSortCol(prevCol => {
      if (prevCol === col) { setSortDir(d => d === 'desc' ? 'asc' : 'desc'); return col; }
      setSortDir('desc');
      return col;
    });
  }, []);

  return { sorted, sortCol, sortDir, toggleSort };
}

function SortTh({ col, sortCol, sortDir, onSort, children }) {
  const active = sortCol === col;
  return (
    <th onClick={() => onSort(col)} style={{ cursor: 'pointer', userSelect: 'none' }}>
      {children} {active ? (sortDir === 'desc' ? '↓' : '↑') : ''}
    </th>
  );
}

/* ── Execution Queue — status badges (contacted/PIC/follow-up) ── */
function ExecutionStatusCell({ status }) {
  const has = status && (status.isContacted || status.pic || status.followupDate);
  if (!has) return <span className="wre-status-cell-empty">-</span>;
  return (
    <div className="wre-status-cell">
      {status.isContacted && <span className="wre-status-chip wre-status-chip-contacted"><i className="ti ti-check" /> Contacted</span>}
      {status.pic && <span className="wre-status-chip wre-status-chip-pic"><i className="ti ti-user" /> {status.pic}</span>}
      {status.followupDate && <span className="wre-status-chip wre-status-chip-date"><i className="ti ti-calendar" /> {String(status.followupDate).slice(0, 10)}</span>}
    </div>
  );
}

/* ── Execution Queue — action menu (Contacted/PIC/Follow-up/Notes persist ke backend) ── */
function QueueActionMenu({ outlet, status, onUpdateStatus, showToast }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null); // 'pic' | 'followup' | 'notes' | null
  const [picValue, setPicValue] = useState(status?.pic || '');
  const [followupValue, setFollowupValue] = useState(status?.followupDate ? String(status.followupDate).slice(0, 10) : '');
  const [noteValue, setNoteValue] = useState('');
  const [saving, setSaving] = useState(false);

  const isContacted = !!status?.isContacted;

  const copyWa = () => { navigator.clipboard.writeText(getWaText(outlet.segment)); showToast('Template WA disalin ke clipboard'); setOpen(false); };

  const toggleContacted = async () => {
    setSaving(true);
    try {
      await onUpdateStatus(outlet.idOutlet, { isContacted: !isContacted });
      showToast(isContacted ? `${outlet.idOutlet} ditandai belum dihubungi` : `${outlet.idOutlet} ditandai sudah dihubungi`);
    } catch { /* toast error sudah ditangani di handler pusat */ }
    finally { setSaving(false); }
  };

  const savePic = async () => {
    if (!picValue.trim()) return;
    setSaving(true);
    try {
      await onUpdateStatus(outlet.idOutlet, { pic: picValue.trim() });
      showToast(`PIC ${outlet.idOutlet} diset ke "${picValue.trim()}"`);
      setEditing(null);
    } catch { /* noop */ }
    finally { setSaving(false); }
  };

  const saveFollowup = async () => {
    if (!followupValue) return;
    setSaving(true);
    try {
      await onUpdateStatus(outlet.idOutlet, { followupDate: followupValue });
      showToast(`Follow-up ${outlet.idOutlet} diset ke ${followupValue}`);
      setEditing(null);
    } catch { /* noop */ }
    finally { setSaving(false); }
  };

  const saveNote = async () => {
    if (!noteValue.trim()) return;
    setSaving(true);
    try {
      await addEkspedisiNote({ idOutlet: outlet.idOutlet, note: noteValue.trim() });
      showToast(`Catatan ditambahkan untuk ${outlet.idOutlet}`);
      setNoteValue('');
      setEditing(null);
    } catch {
      showToast('Gagal menambah catatan');
    } finally { setSaving(false); }
  };

  return (
    <div className="wre-action-menu-wrap">
      <button className="wre-action-menu-btn" onClick={(e) => { e.stopPropagation(); setOpen(o => !o); setEditing(null); }}><i className="ti ti-dots" /></button>
      {open && (
        <div className="wre-action-menu" onClick={e => e.stopPropagation()} onMouseLeave={() => { setOpen(false); setEditing(null); }}>
          <button onClick={copyWa}><i className="ti ti-brand-whatsapp" /> Copy WA Follow-up</button>
          <button onClick={toggleContacted} disabled={saving}>
            <i className={'ti ti-' + (isContacted ? 'square-check' : 'square')} /> {isContacted ? 'Batalkan Contacted' : 'Mark Contacted'}
          </button>

          {editing === 'pic' ? (
            <div className="wre-action-menu-form">
              <input className="wre-action-menu-input" placeholder="Nama PIC..." value={picValue}
                onChange={e => setPicValue(e.target.value)} onKeyDown={e => e.key === 'Enter' && savePic()} autoFocus />
              <button className="wre-action-menu-save" onClick={savePic} disabled={saving}>Simpan</button>
            </div>
          ) : (
            <button onClick={() => setEditing('pic')}><i className="ti ti-user" /> Assign PIC{status?.pic ? ` (${status.pic})` : ''}</button>
          )}

          {editing === 'followup' ? (
            <div className="wre-action-menu-form">
              <input type="date" className="wre-action-menu-input" value={followupValue} onChange={e => setFollowupValue(e.target.value)} autoFocus />
              <button className="wre-action-menu-save" onClick={saveFollowup} disabled={saving}>Simpan</button>
            </div>
          ) : (
            <button onClick={() => setEditing('followup')}><i className="ti ti-calendar" /> Set Follow-up Date{status?.followupDate ? ` (${String(status.followupDate).slice(0, 10)})` : ''}</button>
          )}

          {editing === 'notes' ? (
            <div className="wre-action-menu-form">
              <textarea className="wre-action-menu-textarea" placeholder="Tulis catatan..." value={noteValue} onChange={e => setNoteValue(e.target.value)} autoFocus />
              <button className="wre-action-menu-save" onClick={saveNote} disabled={saving}>Simpan</button>
            </div>
          ) : (
            <button onClick={() => setEditing('notes')}><i className="ti ti-note" /> Add Notes</button>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Tab 1: Executive Overview ── */
function ExecutiveOverviewTab({ data, onSelectOutlet }) {
  const { summary = {}, businessMetrics = {}, monthlySummary = [], executiveInsights = [], outletPerformance = [], meta = {} } = data;

  const activeOutletPrev = outletPerformance.filter(o => o.previousTrx > 0).length;
  const momActiveOutletGrowth = activeOutletPrev > 0 ? ((summary.totalOutletActive - activeOutletPrev) / activeOutletPrev * 100) : null;
  const avgTrxPerOutlet = summary.totalOutletActive > 0 ? summary.totalTrxCurrent / summary.totalOutletActive : 0;
  const avgRevenuePerOutlet = summary.totalOutletActive > 0 ? summary.totalRevenueCurrent / summary.totalOutletActive : 0;
  const latestSummary = monthlySummary.find(m => m.bulan === meta.latestMonth) || monthlySummary[monthlySummary.length - 1] || {};
  const dailyRevenue = meta.dayCutoff > 0 ? latestSummary.totalRevenue / meta.dayCutoff : null;
  const lastDayDateFmt = meta.lastDayDate
    ? new Date(meta.lastDayDate).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })
    : '-';
  const health = buildHealthSummary(businessMetrics, summary);
  const trendLabels = monthlySummary.map(m => m.monthLabel);
  const p0Base = useMemo(() => [...outletPerformance].filter(o => o.priority === 'P0')
    .sort((a, b) => Math.abs(b.revenueDelta || 0) - Math.abs(a.revenueDelta || 0)).slice(0, 10), [outletPerformance]);
  const { sorted: p0Top10, sortCol: p0SortCol, sortDir: p0SortDir, toggleSort: p0ToggleSort } = useSortedRows(p0Base);

  return (
    <div>
      <div className="wre-kpi-grid">
        <KPICard title="Total TRX Current Month" value={fmtNum(summary.totalTrxCurrent)} icon="repeat" color={THEME} />
        <KPICard title="Total Revenue Current Month" value={fmtRp(summary.totalRevenueCurrent)} icon="coin" color={THEME} />
        <KPICard title="Active Outlet" value={fmtNum(summary.totalOutletActive)} icon="building-store" color="#2563EB" />
        <KPICard title="Avg TRX / Outlet" value={fmtNum(avgTrxPerOutlet)} icon="chart-bar" color="#7C3AED" />
        <KPICard title="Avg Revenue / Outlet" value={fmtRp(avgRevenuePerOutlet)} icon="wallet" color="#7C3AED" />
        <KPICard title="Avg Revenue / TRX" value={fmtRp(summary.avgRevPerTrx)} icon="receipt" color="#DB2777" />
        <KPICard title="MoM TRX Growth" value={fmtPct(summary.pctTrxGrowth)} icon="trending-up" color={summary.pctTrxGrowth >= 0 ? '#059669' : '#DC2626'} />
        <KPICard title="MoM Revenue Growth" value={fmtPct(summary.pctRevenueGrowth)} icon="trending-up" color={summary.pctRevenueGrowth >= 0 ? '#059669' : '#DC2626'} />
        <KPICard title="MoM Active Outlet Growth" value={momActiveOutletGrowth == null ? '-' : fmtPct(momActiveOutletGrowth)} icon="users"
          color={momActiveOutletGrowth == null ? '#6B7280' : (momActiveOutletGrowth >= 0 ? '#059669' : '#DC2626')} />
        <KPICard title="Projected EOM TRX" value={fmtNum(latestSummary.projectedEomTrx)} sub={`Bulan ${latestSummary.monthLabel || '-'} berjalan`} icon="calendar-stats" color="#0EA5E9" />
        <KPICard title="Projected EOM Revenue" value={fmtRp(latestSummary.projectedEomRevenue)} sub={`Bulan ${latestSummary.monthLabel || '-'} berjalan`} icon="calendar-stats" color="#0EA5E9" />
        <KPICard title="Daily Revenue" value={dailyRevenue == null ? '-' : fmtRp(dailyRevenue)} sub={`Rata-rata per hari · Day ${meta.dayCutoff ?? '-'}`} icon="calendar-dollar" color="#0EA5E9" />
        <KPICard title="Revenue Hari Terakhir" value={meta.lastDayRevenue == null ? '-' : fmtRp(meta.lastDayRevenue)}
          sub={meta.lastDayPrevDate ? `Tanggal ${lastDayDateFmt} · vs sync sebelumnya` : `Tanggal ${lastDayDateFmt} · sync pertama bulan ini`}
          icon="calendar-event" color="#F59E0B" />
      </div>

      <div className="wre-health-summary" style={{ borderLeftColor: health.color }}>
        <div className="wre-health-summary-title" style={{ color: health.color }}>
          <i className="ti ti-heart-rate-monitor" /> Business Health: {health.verdict}
        </div>
        <p className="wre-health-summary-text">{health.text}</p>
      </div>

      <ChartCard title="Trendline Singkat — TRX per Bulan" height={220}>
        <LineChart id="exec-trend" labels={trendLabels}
          datasets={[{ label: 'TRX', data: monthlySummary.map(m => m.totalTrx), borderColor: THEME, backgroundColor: THEME + '22', tension: 0.3, pointRadius: 3, fill: true }]} />
      </ChartCard>

      <div className="wre-exec-recs-card">
        <div className="wre-exec-summary-header"><i className="ti ti-bulb" style={{ color: '#D97706' }} /><span>Executive Insights</span></div>
        <div className="wre-recs-list">
          {executiveInsights.map(ins => (
            <div key={ins.id} className="wre-rec-item" style={{ borderLeftColor: THEME, background: THEME + '0d' }}>
              <p className="wre-rec-text">{INSIGHT_COPY_OVERRIDE[ins.id] || ins.text}</p>
            </div>
          ))}
          {executiveInsights.length === 0 && <div className="wre-empty" style={{ padding: 16 }}>Tidak ada insight khusus — kondisi normal.</div>}
        </div>
      </div>

      <div className="wre-table-section">
        <div className="wre-table-header"><span>🚨 Top 10 Urgent Outlet — P0 Critical</span></div>
        {p0Top10.length === 0 ? <div className="wre-empty">{EMPTY_P0}</div> : (
          <div className="wre-table-wrap">
            <table className="wre-table">
              <thead>
                <tr>
                  <SortTh col="idOutlet" sortCol={p0SortCol} sortDir={p0SortDir} onSort={p0ToggleSort}>ID Outlet</SortTh>
                  <SortTh col="segment" sortCol={p0SortCol} sortDir={p0SortDir} onSort={p0ToggleSort}>Segment</SortTh>
                  <SortTh col="previousTrx" sortCol={p0SortCol} sortDir={p0SortDir} onSort={p0ToggleSort}>TRX Prev</SortTh>
                  <SortTh col="currentTrx" sortCol={p0SortCol} sortDir={p0SortDir} onSort={p0ToggleSort}>TRX Current</SortTh>
                  <SortTh col="revenueDelta" sortCol={p0SortCol} sortDir={p0SortDir} onSort={p0ToggleSort}>Δ Revenue</SortTh>
                  <th>Recommended Action</th>
                </tr>
              </thead>
              <tbody>
                {p0Top10.map(o => (
                  <tr key={o.idOutlet} className="wre-row-clickable" onClick={() => onSelectOutlet(o)}>
                    <td className="wre-outlet-id">{o.idOutlet}</td>
                    <td><SegmentBadge segment={o.segment} /></td>
                    <td>{fmtNum(o.previousTrx)}</td><td>{fmtNum(o.currentTrx)}</td>
                    <td><DevCell val={o.revenueDelta} /></td>
                    <td className="wre-action-text">{o.recommendedAction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Tab 2: MoM Growth & Trendline ── */
function TrendlineTab({ monthlySummary, meta }) {
  const latestLabel = (monthlySummary.find(m => m.bulan === meta.latestMonth) || {}).monthLabel || '-';
  const labels = monthlySummary.map(m => m.monthLabel + (m.bulan === meta.latestMonth && meta.dayCutoff ? ` (d-${meta.dayCutoff})` : ''));
  const { sorted: sortedSummary, sortCol, sortDir, toggleSort } = useSortedRows(monthlySummary, 'monthOrder', 'asc');

  if (!monthlySummary.length) return <div className="wre-empty-state"><p>{EMPTY_NO_DATA}</p></div>;

  return (
    <div>
      <div className="wre-charts-row">
        <ChartCard title="Total TRX per Month" height={250}>
          <LineChart id="trend-trx" labels={labels}
            datasets={[{ label: 'TRX', data: monthlySummary.map(m => m.totalTrx), borderColor: THEME, backgroundColor: THEME + '33', tension: 0.3, fill: true, pointRadius: 4 }]} />
        </ChartCard>
        <ChartCard title="Total Revenue per Month" height={250}>
          <LineChart id="trend-rev" labels={labels}
            datasets={[{ label: 'Revenue', data: monthlySummary.map(m => m.totalRevenue), borderColor: '#059669', backgroundColor: '#05966933', tension: 0.3, fill: true, pointRadius: 4 }]} />
        </ChartCard>
      </div>
      <div className="wre-charts-row">
        <ChartCard title="Active Outlet per Month" height={250}>
          <VBarChart id="trend-active" labels={labels} values={monthlySummary.map(m => m.activeOutlets)} />
        </ChartCard>
        <ChartCard title="TRX Growth % vs Revenue Growth %" height={250}>
          <LineChart id="trend-growth" labels={labels} yTitle="%"
            datasets={[
              { label: 'TRX Growth %', data: monthlySummary.map(m => m.momTrxGrowth), borderColor: '#2563EB', backgroundColor: '#2563EB22', tension: 0.3, pointRadius: 4 },
              { label: 'Revenue Growth %', data: monthlySummary.map(m => m.momRevenueGrowth), borderColor: '#DC2626', backgroundColor: '#DC262622', tension: 0.3, pointRadius: 4 },
            ]} />
        </ChartCard>
      </div>

      <div className="wre-table-section">
        <div className="wre-table-header"><span>Monthly Summary</span></div>
        <div className="wre-table-wrap">
          <table className="wre-table">
            <thead>
              <tr>
                <SortTh col="monthOrder" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Month</SortTh>
                <SortTh col="totalTrx" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Total TRX</SortTh>
                <SortTh col="totalRevenue" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Total Revenue</SortTh>
                <SortTh col="activeOutlets" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Active Outlet</SortTh>
                <SortTh col="avgTrxPerOutlet" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Avg TRX/Outlet</SortTh>
                <SortTh col="avgRevenuePerOutlet" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Avg Revenue/Outlet</SortTh>
                <SortTh col="avgRevenuePerTrx" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Avg Revenue/TRX</SortTh>
                <SortTh col="momTrxGrowth" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>MoM TRX Growth</SortTh>
                <SortTh col="momRevenueGrowth" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>MoM Revenue Growth</SortTh>
                <SortTh col="projectedEomTrx" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Projected EOM TRX</SortTh>
                <SortTh col="projectedEomRevenue" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Projected EOM Revenue</SortTh>
              </tr>
            </thead>
            <tbody>
              {sortedSummary.map(m => (
                <tr key={m.bulan}>
                  <td>{m.monthLabel}{m.bulan === meta.latestMonth && meta.dayCutoff ? ` (d-${meta.dayCutoff})` : ''}</td>
                  <td>{fmtNum(m.totalTrx)}</td><td>{fmtRp(m.totalRevenue)}</td><td>{fmtNum(m.activeOutlets)}</td>
                  <td>{fmtNum(m.avgTrxPerOutlet)}</td><td>{fmtRp(m.avgRevenuePerOutlet)}</td><td>{fmtRp(m.avgRevenuePerTrx)}</td>
                  <td>{m.momTrxGrowth == null ? '-' : <DevCell val={m.momTrxGrowth} suffix="%" />}</td>
                  <td>{m.momRevenueGrowth == null ? '-' : <DevCell val={m.momRevenueGrowth} suffix="%" />}</td>
                  <td>{fmtNum(m.projectedEomTrx)}{m.bulan === meta.latestMonth ? ' *' : ''}</td>
                  <td>{fmtRp(m.projectedEomRevenue)}{m.bulan === meta.latestMonth ? ' *' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="wre-table-footnote">* Proyeksi end-of-month hanya dihitung untuk bulan yang sedang berjalan ({latestLabel}).</div>
      </div>
    </div>
  );
}

/* ── Tab 3: Outlet Movement ── */
function OutletMovementTab({ outletPerformance, meta }) {
  const [segmentFilter, setSegmentFilter] = useState('all');
  const [growthFilter, setGrowthFilter] = useState('all');
  const [search, setSearch] = useState('');

  if (!meta.previousMonth) return <div className="wre-empty-state"><p>{EMPTY_NO_COMPARE}</p></div>;

  const retained  = outletPerformance.filter(o => o.previousTrx > 0 && o.currentTrx > 0).length;
  const newCount  = outletPerformance.filter(isTrulyNew).length;
  const reactivatedCount = outletPerformance.filter(isReactivated).length;
  const churnCount = outletPerformance.filter(o => o.segment === 'churn').length;
  const growingCount = outletPerformance.filter(o => o.previousTrx > 0 && o.currentTrx > 0 && o.trxDelta > 0).length;
  const decliningCount = outletPerformance.filter(o => o.previousTrx > 0 && o.currentTrx > 0 && o.trxDelta < 0).length;
  const oneTimeCount = outletPerformance.filter(o => o.segment === 'one_timer').length;

  const segmentDist = {};
  outletPerformance.forEach(o => { segmentDist[o.segment] = (segmentDist[o.segment] || 0) + 1; });

  const filteredBase = useMemo(() => {
    let rows = outletPerformance;
    if (segmentFilter !== 'all') rows = rows.filter(o => o.segment === segmentFilter);
    if (growthFilter === 'growing')   rows = rows.filter(o => o.trxDelta > 0);
    else if (growthFilter === 'declining') rows = rows.filter(o => o.trxDelta < 0);
    else if (growthFilter === 'stable')    rows = rows.filter(o => o.trxDelta === 0);
    if (search) rows = rows.filter(o => o.idOutlet.toLowerCase().includes(search.toLowerCase()));
    return rows;
  }, [outletPerformance, segmentFilter, growthFilter, search]);
  const { sorted: filtered, sortCol, sortDir, toggleSort } = useSortedRows(filteredBase, 'currentTrx', 'desc');

  const handleExport = () => exportCSV('ekspedisi-outlet-movement.csv',
    ['ID Outlet', 'Previous TRX', 'Current TRX', 'TRX Growth', 'Previous Revenue', 'Current Revenue', 'Revenue Growth', 'Segment', 'Recommended Action'],
    filtered.map(o => [o.idOutlet, o.previousTrx, o.currentTrx, o.trxGrowthPercent?.toFixed(1) ?? '', o.previousRevenue, o.currentRevenue, o.revenueGrowthPercent?.toFixed(1) ?? '', o.segment, o.recommendedAction]));

  return (
    <div>
      <div className="wre-movement-kpi-grid">
        <KPICard title="Retained" value={fmtNum(retained)} icon="repeat" color="#059669" />
        <KPICard title="New Outlet" value={fmtNum(newCount)} icon="sparkles" color="#2563EB" />
        <KPICard title="Reactivated" value={fmtNum(reactivatedCount)} icon="refresh" color="#0EA5E9" />
        <KPICard title="Churn" value={fmtNum(churnCount)} icon="alert-triangle" color="#9CA3AF" />
        <KPICard title="Growing" value={fmtNum(growingCount)} icon="trending-up" color="#059669" />
        <KPICard title="Declining" value={fmtNum(decliningCount)} icon="trending-down" color="#DC2626" />
        <KPICard title="One-Time" value={fmtNum(oneTimeCount)} icon="click" color="#D97706" />
      </div>

      <ChartCard title="Distribusi Segmen Outlet" height={230}>
        <DonutChart id="movement-donut"
          labels={Object.keys(segmentDist).map(s => `${SEGMENT_LABEL[s] || s} (${segmentDist[s]})`)}
          values={Object.values(segmentDist)}
          colors={Object.keys(segmentDist).map(s => SEGMENT_COLOR[s] || '#888')} />
      </ChartCard>

      <div className="wre-table-section">
        <div className="wre-filter-row">
          <input className="wre-search" placeholder="Cari ID Outlet..." value={search} onChange={e => setSearch(e.target.value)} />
          <select className="wre-select" value={segmentFilter} onChange={e => setSegmentFilter(e.target.value)}>
            <option value="all">Semua Segmen</option>
            {Object.keys(SEGMENT_LABEL).map(s => <option key={s} value={s}>{SEGMENT_LABEL[s]}</option>)}
          </select>
          <select className="wre-select" value={growthFilter} onChange={e => setGrowthFilter(e.target.value)}>
            <option value="all">Semua Kondisi</option>
            <option value="growing">Growing</option>
            <option value="declining">Declining</option>
            <option value="stable">Stable (0)</option>
          </select>
          <button className="wre-export-btn" onClick={handleExport}><i className="ti ti-download" /> Export CSV</button>
          <span className="wre-count-badge">{fmtNum(filtered.length)} outlet</span>
        </div>
        <div className="wre-table-wrap">
          <table className="wre-table">
            <thead>
              <tr>
                <SortTh col="idOutlet" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>ID Outlet</SortTh>
                <SortTh col="previousTrx" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Previous TRX</SortTh>
                <SortTh col="currentTrx" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Current TRX</SortTh>
                <SortTh col="trxGrowthPercent" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>TRX Growth</SortTh>
                <SortTh col="previousRevenue" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Previous Revenue</SortTh>
                <SortTh col="currentRevenue" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Current Revenue</SortTh>
                <SortTh col="revenueGrowthPercent" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Revenue Growth</SortTh>
                <SortTh col="segment" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Segment</SortTh>
                <th>Recommended Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map(o => (
                <tr key={o.idOutlet}>
                  <td className="wre-outlet-id">{o.idOutlet}</td>
                  <td>{fmtNum(o.previousTrx)}</td><td>{fmtNum(o.currentTrx)}</td>
                  <td><DevCell val={o.trxGrowthPercent} suffix="%" /></td>
                  <td>{fmtRp(o.previousRevenue)}</td><td>{fmtRp(o.currentRevenue)}</td>
                  <td><DevCell val={o.revenueGrowthPercent} suffix="%" /></td>
                  <td><SegmentBadge segment={o.segment} /></td>
                  <td className="wre-action-text">{o.recommendedAction}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="wre-empty">{EMPTY_NO_MATCH}</div>}
        </div>
      </div>
    </div>
  );
}

/* ── Tab 4: Execution Queue ── */
function ExecutionQueueTab({ outletPerformance, statusByOutlet, onUpdateStatus, showToast, onSelectOutlet }) {
  const [priorityFilter, setPriorityFilter] = useState('all');

  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  outletPerformance.forEach(o => { if (counts[o.priority] != null) counts[o.priority]++; });

  const filteredBase = useMemo(() => {
    if (priorityFilter === 'all') return outletPerformance;
    return outletPerformance.filter(o => o.priority === priorityFilter);
  }, [outletPerformance, priorityFilter]);

  // sortCol=null -> default: Priority P0->P3, lalu |Δrevenue| terbesar.
  // Klik header manapun mengganti ke sort kolom biasa.
  const { sorted: columnSorted, sortCol, sortDir, toggleSort } = useSortedRows(filteredBase);
  const sorted = useMemo(() => {
    if (sortCol) return columnSorted;
    return [...filteredBase].sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 9, pb = PRIORITY_ORDER[b.priority] ?? 9;
      if (pa !== pb) return pa - pb;
      return Math.abs(b.revenueDelta || 0) - Math.abs(a.revenueDelta || 0);
    });
  }, [filteredBase, columnSorted, sortCol]);

  const p0Count = outletPerformance.filter(o => o.priority === 'P0').length;

  const handleExport = () => exportCSV('ekspedisi-execution-queue.csv',
    ['Priority', 'ID Outlet', 'Segment', 'Last Month TRX', 'Current TRX', 'Growth', 'Revenue', 'Avg Revenue/TRX', 'Recommended Action'],
    sorted.map(o => [o.priority, o.idOutlet, o.segment, o.previousTrx, o.currentTrx, o.trxGrowthPercent?.toFixed(1) ?? '', o.currentRevenue, o.avgRevenuePerTrx?.toFixed(0), o.recommendedAction]));

  return (
    <div>
      <div className="wre-priority-stat-grid">
        {['P0', 'P1', 'P2', 'P3'].map(p => (
          <button key={p}
            className={'wre-priority-stat-card wre-priority-' + p.toLowerCase() + (priorityFilter === p ? ' wre-priority-stat-card-active' : '')}
            onClick={() => setPriorityFilter(f => f === p ? 'all' : p)}>
            <div className="wre-priority-stat-val">{fmtNum(counts[p])}</div>
            <div className="wre-priority-stat-lbl">{PRIORITY_LABEL[p]}</div>
          </button>
        ))}
      </div>

      {p0Count === 0 && <div className="wre-empty">{EMPTY_P0}</div>}

      <div className="wre-table-section">
        <div className="wre-table-header">
          <span>{priorityFilter === 'all' ? 'Semua Prioritas' : PRIORITY_LABEL[priorityFilter]} — {fmtNum(sorted.length)} outlet{!sortCol ? ' (default: prioritas)' : ''}</span>
          <button className="wre-export-btn" onClick={handleExport}><i className="ti ti-download" /> Export CSV</button>
        </div>
        <div className="wre-table-wrap">
          <table className="wre-table">
            <thead>
              <tr>
                <SortTh col="priority" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Priority</SortTh>
                <SortTh col="idOutlet" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>ID Outlet</SortTh>
                <SortTh col="segment" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Segment</SortTh>
                <SortTh col="previousTrx" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Last Month TRX</SortTh>
                <SortTh col="currentTrx" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Current TRX</SortTh>
                <SortTh col="trxGrowthPercent" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Growth</SortTh>
                <SortTh col="currentRevenue" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Revenue</SortTh>
                <SortTh col="avgRevenuePerTrx" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Avg Revenue/TRX</SortTh>
                <th>Recommended Action</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 200).map(o => (
                <tr key={o.idOutlet}>
                  <td><PriorityBadge priority={o.priority} /></td>
                  <td className="wre-outlet-id wre-row-clickable" onClick={() => onSelectOutlet(o)}>{o.idOutlet}</td>
                  <td><SegmentBadge segment={o.segment} /></td>
                  <td>{fmtNum(o.previousTrx)}</td><td>{fmtNum(o.currentTrx)}</td>
                  <td><DevCell val={o.trxGrowthPercent} suffix="%" /></td>
                  <td>{fmtRp(o.currentRevenue)}</td>
                  <td>{fmtRp(o.avgRevenuePerTrx)}</td>
                  <td className="wre-action-text">{o.recommendedAction}</td>
                  <td><ExecutionStatusCell status={statusByOutlet[o.idOutlet]} /></td>
                  <td><QueueActionMenu outlet={o} status={statusByOutlet[o.idOutlet]} onUpdateStatus={onUpdateStatus} showToast={showToast} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.length === 0 && <div className="wre-empty">{EMPTY_NO_MATCH}</div>}
          {sorted.length > 200 && <div className="wre-table-footnote">Menampilkan 200 dari {fmtNum(sorted.length)} outlet — gunakan filter prioritas untuk mempersempit.</div>}
        </div>
      </div>
    </div>
  );
}

/* ── Sortable mini-table — dipakai 5 tabel kategori di tab Pareto ── */
function SortableMiniTable({ title, rows }) {
  const { sorted, sortCol, sortDir, toggleSort } = useSortedRows(rows);
  return (
    <div className="wre-table-section">
      <div className="wre-table-header"><span>{title} ({rows.length})</span></div>
      {rows.length === 0 ? <div className="wre-empty">{EMPTY_NO_MATCH}</div> : (
        <div className="wre-table-wrap">
          <table className="wre-table">
            <thead>
              <tr>
                <SortTh col="idOutlet" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>ID Outlet</SortTh>
                <SortTh col="currentTrx" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>TRX</SortTh>
                <SortTh col="currentRevenue" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Revenue</SortTh>
                <SortTh col="revenueDelta" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Δ Revenue</SortTh>
                <SortTh col="segment" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Segment</SortTh>
              </tr>
            </thead>
            <tbody>
              {sorted.map(o => (
                <tr key={o.idOutlet}>
                  <td className="wre-outlet-id">{o.idOutlet}</td>
                  <td>{fmtNum(o.currentTrx)}</td><td>{fmtRp(o.currentRevenue)}</td>
                  <td><DevCell val={o.revenueDelta} /></td>
                  <td><SegmentBadge segment={o.segment} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Tab 5: Revenue Quality & Pareto ── */
function ParetoTab({ outletPerformance, businessMetrics, monthlySummary, meta }) {
  const active = useMemo(() => outletPerformance.filter(o => o.currentTrx > 0), [outletPerformance]);
  const byRevDesc = useMemo(() => [...active].sort((a, b) => b.currentRevenue - a.currentRevenue), [active]);
  const byTrxDesc = useMemo(() => [...active].sort((a, b) => b.currentTrx - a.currentTrx), [active]);

  const totalRevenue = active.reduce((s, o) => s + o.currentRevenue, 0);
  const totalTrx = active.reduce((s, o) => s + o.currentTrx, 0);
  const top10RevPct = totalRevenue > 0 ? byRevDesc.slice(0, 10).reduce((s, o) => s + o.currentRevenue, 0) / totalRevenue * 100 : 0;
  const top10TrxPct = totalTrx > 0 ? byTrxDesc.slice(0, 10).reduce((s, o) => s + o.currentTrx, 0) / totalTrx * 100 : 0;

  let cum = 0;
  const withCum = byRevDesc.map(o => { cum += o.currentRevenue; return { ...o, cumPct: totalRevenue > 0 ? cum / totalRevenue * 100 : 0 }; });
  const idx80 = withCum.findIndex(o => o.cumPct >= 80);
  const outletsFor80 = idx80 === -1 ? withCum.length : idx80 + 1;
  const pareto80Pct = withCum.length > 0 ? outletsFor80 / withCum.length * 100 : 0;

  const lowYieldCount = outletPerformance.filter(o => o.segment === 'low_yield').length;
  const premiumYieldCount = outletPerformance.filter(o => o.segment === 'premium_yield').length;

  const medianTrx = median(active.map(o => o.currentTrx));
  const medianRev = median(active.map(o => o.currentRevenue));

  const highTrxHighRev = active.filter(o => o.currentTrx >= medianTrx && o.currentRevenue >= medianRev).sort((a, b) => b.currentRevenue - a.currentRevenue).slice(0, 15);
  const highTrxLowRev  = active.filter(o => o.currentTrx >= medianTrx && o.currentRevenue < medianRev).sort((a, b) => b.currentTrx - a.currentTrx).slice(0, 15);
  const lowTrxHighRev  = active.filter(o => o.currentTrx < medianTrx && o.currentRevenue >= medianRev).sort((a, b) => b.currentRevenue - a.currentRevenue).slice(0, 15);
  const revenueDropper = [...outletPerformance].filter(o => o.revenueDelta < 0).sort((a, b) => a.revenueDelta - b.revenueDelta).slice(0, 15);
  const revenueGainer  = [...outletPerformance].filter(o => o.revenueDelta > 0).sort((a, b) => b.revenueDelta - a.revenueDelta).slice(0, 15);

  const top30 = withCum.slice(0, 30);

  const curSum = monthlySummary.find(m => m.bulan === meta.currentMonth);
  const prevSum = monthlySummary.find(m => m.bulan === meta.previousMonth);
  const revPerTrxDown = curSum && prevSum && curSum.avgRevenuePerTrx < prevSum.avgRevenuePerTrx;

  return (
    <div>
      <div className="wre-kpi-grid">
        <KPICard title="Avg Revenue / TRX" value={fmtRp(businessMetrics.avgRevenuePerTrx)} icon="chart-bar" color={THEME} />
        <KPICard title="Top 10 Revenue Contribution" value={`${top10RevPct.toFixed(1)}%`} icon="coin" color={top10RevPct > 50 ? '#DC2626' : '#059669'} />
        <KPICard title="Top 10 TRX Contribution" value={`${top10TrxPct.toFixed(1)}%`} icon="repeat" color="#2563EB" />
        <KPICard title="Pareto 80/20" value={`${fmtNum(outletsFor80)} outlet`} sub={`${pareto80Pct.toFixed(1)}% dari outlet aktif`} icon="target" color="#7C3AED" />
        <KPICard title="Low Yield Outlet" value={fmtNum(lowYieldCount)} icon="trending-down" color="#DC2626" />
        <KPICard title="Premium Yield Outlet" value={fmtNum(premiumYieldCount)} icon="diamond" color="#DB2777" />
      </div>

      {top10RevPct > 50 && (
        <div className="wre-insight-banner wre-insight-banner-warn">
          <i className="ti ti-alert-triangle" /> Revenue terlalu bergantung pada sedikit outlet besar. Jaga outlet whale dan dorong pemerataan transaksi.
        </div>
      )}
      {revPerTrxDown && (
        <div className="wre-insight-banner wre-insight-banner-warn">
          <i className="ti ti-alert-triangle" /> Revenue per transaksi menurun. Cek outlet high volume dengan yield rendah.
        </div>
      )}

      <div className="wre-charts-row">
        <ChartCard title="Scatter TRX vs Revenue" height={270}>
          <ScatterPlot id="pareto-scatter" data={active} />
        </ChartCard>
        <ChartCard title="Pareto — Revenue per Outlet (Top 30) &amp; Kumulatif %" height={270}>
          <BarGroupChart id="pareto-chart"
            labels={top30.map(o => o.idOutlet)}
            datasets={[
              { label: 'Revenue', data: top30.map(o => o.currentRevenue), backgroundColor: THEME + 'cc', yAxisID: 'y', borderRadius: 4 },
              { label: 'Kumulatif %', data: top30.map(o => o.cumPct), type: 'line', yAxisID: 'y2', borderColor: '#DC2626', backgroundColor: '#FEE2E2', tension: 0.3, fill: false, pointRadius: 3 },
            ]}
            yTitle="Revenue" y2Title="Kumulatif %" y2Max={100} />
        </ChartCard>
      </div>

      <div className="wre-charts-row">
        <ChartCard title="Top 20 Revenue Outlet" height={270}>
          <HBarChart id="top20-rev" labels={byRevDesc.slice(0, 20).map(o => o.idOutlet)} values={byRevDesc.slice(0, 20).map(o => o.currentRevenue)} color="#7C3AED" />
        </ChartCard>
        <ChartCard title="Top 20 TRX Outlet" height={270}>
          <HBarChart id="top20-trx" labels={byTrxDesc.slice(0, 20).map(o => o.idOutlet)} values={byTrxDesc.slice(0, 20).map(o => o.currentTrx)} />
        </ChartCard>
      </div>

      <SortableMiniTable title="High TRX, High Revenue" rows={highTrxHighRev} />
      <SortableMiniTable title="High TRX, Low Revenue"  rows={highTrxLowRev} />
      <SortableMiniTable title="Low TRX, High Revenue"  rows={lowTrxHighRev} />
      <SortableMiniTable title="Revenue Dropper"        rows={revenueDropper} />
      <SortableMiniTable title="Revenue Gainer"         rows={revenueGainer} />
    </div>
  );
}

/* ── Tab 6: Raw Data & Outlet Detail ── */
function RawDataTab({ outletPerformance, onSelectOutlet }) {
  const [search, setSearch] = useState('');
  const [segmentFilter, setSegmentFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const filteredBase = useMemo(() => {
    let rows = outletPerformance;
    if (search) rows = rows.filter(o => o.idOutlet.toLowerCase().includes(search.toLowerCase()));
    if (segmentFilter !== 'all') rows = rows.filter(o => o.segment === segmentFilter);
    if (priorityFilter !== 'all') rows = rows.filter(o => o.priority === priorityFilter);
    return rows;
  }, [outletPerformance, search, segmentFilter, priorityFilter]);
  const { sorted: filtered, sortCol, sortDir, toggleSort: toggleSortRaw } = useSortedRows(filteredBase, 'currentTrx', 'desc');
  const toggleSort = (col) => { toggleSortRaw(col); setPage(0); };

  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const handleExport = () => exportCSV('ekspedisi-rawdata.csv',
    ['ID Outlet', 'Current TRX', 'Previous TRX', 'MoM TRX Growth', 'Current Revenue', 'Previous Revenue', 'MoM Revenue Growth', 'Avg Revenue/TRX', 'Segment', 'Priority', 'Recommended Action'],
    filtered.map(o => [o.idOutlet, o.currentTrx, o.previousTrx, o.trxGrowthPercent?.toFixed(1) ?? '', o.currentRevenue, o.previousRevenue, o.revenueGrowthPercent?.toFixed(1) ?? '', o.avgRevenuePerTrx?.toFixed(0), o.segment, o.priority, o.recommendedAction]));

  return (
    <div>
      <div className="wre-filter-row">
        <input className="wre-search" placeholder="Cari ID Outlet..." value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} />
        <select className="wre-select" value={segmentFilter} onChange={e => { setSegmentFilter(e.target.value); setPage(0); }}>
          <option value="all">Semua Segmen</option>
          {Object.keys(SEGMENT_LABEL).map(s => <option key={s} value={s}>{SEGMENT_LABEL[s]}</option>)}
        </select>
        <select className="wre-select" value={priorityFilter} onChange={e => { setPriorityFilter(e.target.value); setPage(0); }}>
          <option value="all">Semua Priority</option>
          {Object.keys(PRIORITY_LABEL).map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>
        <button className="wre-export-btn" onClick={handleExport}><i className="ti ti-download" /> Export CSV</button>
        <span className="wre-count-badge">{fmtNum(filtered.length)} outlet</span>
      </div>

      <div className="wre-table-wrap">
        <table className="wre-table">
          <thead>
            <tr>
              <SortTh col="idOutlet" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>ID Outlet</SortTh>
              <SortTh col="previousTrx" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Previous TRX</SortTh>
              <SortTh col="currentTrx" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Current TRX</SortTh>
              <SortTh col="trxGrowthPercent" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>MoM TRX Growth</SortTh>
              <SortTh col="previousRevenue" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Previous Revenue</SortTh>
              <SortTh col="currentRevenue" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Current Revenue</SortTh>
              <SortTh col="revenueGrowthPercent" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>MoM Revenue Growth</SortTh>
              <SortTh col="avgRevenuePerTrx" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Avg Revenue/TRX</SortTh>
              <SortTh col="segment" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Segment</SortTh>
              <SortTh col="priority" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort}>Priority</SortTh>
            </tr>
          </thead>
          <tbody>
            {paged.map(o => (
              <tr key={o.idOutlet} className="wre-row-clickable" onClick={() => onSelectOutlet(o)}>
                <td className="wre-outlet-id">{o.idOutlet}</td>
                <td>{fmtNum(o.previousTrx)}</td><td>{fmtNum(o.currentTrx)}</td>
                <td><DevCell val={o.trxGrowthPercent} suffix="%" /></td>
                <td>{fmtRp(o.previousRevenue)}</td><td>{fmtRp(o.currentRevenue)}</td>
                <td><DevCell val={o.revenueGrowthPercent} suffix="%" /></td>
                <td>{fmtRp(o.avgRevenuePerTrx)}</td>
                <td><SegmentBadge segment={o.segment} /></td>
                <td><PriorityBadge priority={o.priority} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="wre-empty">{EMPTY_NO_MATCH}</div>}
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

/* ── Detail Drawer ── */
function OutletDetailDrawer({ outlet, status, onUpdateStatus, showToast, onClose }) {
  const [notes, setNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteInput, setNoteInput] = useState('');
  const [picInput, setPicInput] = useState('');
  const [followupInput, setFollowupInput] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!outlet) return;
    setPicInput(status?.pic || '');
    setFollowupInput(status?.followupDate ? String(status.followupDate).slice(0, 10) : '');
    setNoteInput('');
    setNotesLoading(true);
    getEkspedisiNotes(outlet.idOutlet)
      .then(setNotes)
      .catch(() => setNotes([]))
      .finally(() => setNotesLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlet?.idOutlet]);

  if (!outlet) return null;
  const months = outlet.months || [];
  const totalTrx = months.reduce((s, m) => s + m.trx, 0);
  const totalRevenue = months.reduce((s, m) => s + m.revenue, 0);
  const trendLabels = months.map(m => m.monthLabel);

  const toggleContacted = async () => {
    setSaving(true);
    try { await onUpdateStatus(outlet.idOutlet, { isContacted: !status?.isContacted }); }
    finally { setSaving(false); }
  };
  const savePic = async () => {
    if (!picInput.trim()) return;
    setSaving(true);
    try { await onUpdateStatus(outlet.idOutlet, { pic: picInput.trim() }); showToast('PIC disimpan'); }
    finally { setSaving(false); }
  };
  const saveFollowup = async () => {
    if (!followupInput) return;
    setSaving(true);
    try { await onUpdateStatus(outlet.idOutlet, { followupDate: followupInput }); showToast('Follow-up date disimpan'); }
    finally { setSaving(false); }
  };
  const submitNote = async () => {
    if (!noteInput.trim()) return;
    setSaving(true);
    try {
      const created = await addEkspedisiNote({ idOutlet: outlet.idOutlet, note: noteInput.trim() });
      setNotes(prev => [created, ...prev]);
      setNoteInput('');
      showToast('Catatan ditambahkan');
    } catch {
      showToast('Gagal menambah catatan');
    } finally { setSaving(false); }
  };

  return (
    <div className="wre-drawer-overlay" onClick={onClose}>
      <div className="wre-drawer" onClick={e => e.stopPropagation()}>
        <div className="wre-drawer-header">
          <div>
            <div className="wre-drawer-title">{outlet.idOutlet}</div>
            <SegmentBadge segment={outlet.segment} /> <PriorityBadge priority={outlet.priority} />
          </div>
          <button className="wre-drawer-close" onClick={onClose}><i className="ti ti-x" /></button>
        </div>

        <div className="wre-drawer-body">
          <div className="wre-drawer-kpi-row">
            <div className="wre-drawer-kpi"><div className="wre-drawer-kpi-val">{fmtNum(totalTrx)}</div><div className="wre-drawer-kpi-lbl">Total TRX Semua Bulan</div></div>
            <div className="wre-drawer-kpi"><div className="wre-drawer-kpi-val">{fmtRp(totalRevenue)}</div><div className="wre-drawer-kpi-lbl">Total Revenue Semua Bulan</div></div>
            <div className="wre-drawer-kpi"><div className="wre-drawer-kpi-val">{outlet.activeMonthCount}</div><div className="wre-drawer-kpi-lbl">Bulan Aktif</div></div>
            <div className="wre-drawer-kpi"><div className="wre-drawer-kpi-val">{outlet.bestMonth || '-'}</div><div className="wre-drawer-kpi-lbl">Bulan Terbaik</div></div>
          </div>

          <div className="wre-drawer-section-title">Status Bulan Ini</div>
          <p className="wre-drawer-text">
            {outlet.currentTrx > 0 ? `Aktif — ${fmtNum(outlet.currentTrx)} TRX, ${fmtRp(outlet.currentRevenue)} revenue.` : 'Tidak ada transaksi bulan ini.'}
            {' '}Segment <strong>{SEGMENT_LABEL[outlet.segment] || outlet.segment}</strong>, priority <strong>{outlet.priority}</strong>.
          </p>
          <div className="wre-drawer-recommendation"><i className="ti ti-bulb" /> {outlet.recommendedAction}</div>

          <div className="wre-drawer-section-title">Trendline TRX</div>
          <div style={{ height: 150 }}>
            <LineChart id={`drawer-trx-${outlet.idOutlet}`} labels={trendLabels}
              datasets={[{ label: 'TRX', data: months.map(m => m.trx), borderColor: THEME, backgroundColor: THEME + '33', tension: 0.35, fill: true, pointRadius: 3 }]} />
          </div>

          <div className="wre-drawer-section-title">Trendline Revenue</div>
          <div style={{ height: 150 }}>
            <LineChart id={`drawer-rev-${outlet.idOutlet}`} labels={trendLabels}
              datasets={[{ label: 'Revenue', data: months.map(m => m.revenue), borderColor: '#059669', backgroundColor: '#05966933', tension: 0.35, fill: true, pointRadius: 3 }]} />
          </div>

          <div className="wre-drawer-section-title">Timeline Bulanan</div>
          <table className="wre-table wre-table-nested">
            <thead><tr><th>Bulan</th><th>TRX</th><th>Revenue</th></tr></thead>
            <tbody>
              {months.map(m => (
                <tr key={m.monthOrder}><td>{m.monthLabel}</td><td>{fmtNum(m.trx)}</td><td>{fmtRp(m.revenue)}</td></tr>
              ))}
            </tbody>
          </table>

          <div className="wre-drawer-section-title">Execution Status</div>
          <button className={'wre-status-toggle' + (status?.isContacted ? ' wre-status-toggle-active' : '')} onClick={toggleContacted} disabled={saving}>
            <i className={'ti ti-' + (status?.isContacted ? 'square-check' : 'square')} /> {status?.isContacted ? 'Sudah Dihubungi' : 'Belum Dihubungi'}
          </button>
          {status?.isContacted && status?.contactedAt && (
            <div className="wre-drawer-text" style={{ marginTop: 6 }}>Dihubungi oleh {status.contactedBy || '-'} pada {new Date(status.contactedAt).toLocaleString('id-ID')}</div>
          )}
          <div className="wre-drawer-form-row">
            <input className="wre-drawer-input" placeholder="Nama PIC..." value={picInput}
              onChange={e => setPicInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && savePic()} />
            <button className="wre-drawer-save-btn" onClick={savePic} disabled={saving}>Simpan PIC</button>
          </div>
          <div className="wre-drawer-form-row">
            <input type="date" className="wre-drawer-input" value={followupInput} onChange={e => setFollowupInput(e.target.value)} />
            <button className="wre-drawer-save-btn" onClick={saveFollowup} disabled={saving}>Simpan Tanggal</button>
          </div>

          <div className="wre-drawer-section-title">Notes</div>
          <div className="wre-drawer-form-row">
            <textarea className="wre-drawer-textarea" placeholder="Tulis catatan..." value={noteInput} onChange={e => setNoteInput(e.target.value)} />
            <button className="wre-drawer-save-btn" onClick={submitNote} disabled={saving}>Tambah</button>
          </div>
          {notesLoading ? <div className="wre-drawer-text">Memuat catatan…</div> : (
            notes.length === 0 ? <div className="wre-drawer-text">Belum ada catatan.</div> : (
              <div className="wre-notes-list">
                {notes.map(n => (
                  <div key={n.id} className="wre-note-item">
                    <div className="wre-note-text">{n.note}</div>
                    <div className="wre-note-meta">{n.createdBy || '-'} · {new Date(n.createdAt).toLocaleString('id-ID')}</div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Tabs config ── */
const TABS = [
  { key: 'overview',  label: 'Executive Overview',       icon: 'dashboard' },
  { key: 'trendline', label: 'MoM Growth & Trendline',   icon: 'chart-line' },
  { key: 'movement',  label: 'Outlet Movement',          icon: 'arrows-exchange' },
  { key: 'queue',     label: 'Execution Queue',          icon: 'list-check' },
  { key: 'pareto',    label: 'Revenue Quality & Pareto', icon: 'coin' },
  { key: 'raw',       label: 'Raw Data & Outlet Detail', icon: 'database' },
];

/* ── Main Component ── */
export default function WarRoomEkspedisi() {
  const [activeTab, setActiveTab] = useState('overview');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedTanggal, setSelectedTanggal] = useState('');
  const [selectedCurrentMonth, setSelectedCurrentMonth] = useState('');
  const [selectedPreviousMonth, setSelectedPreviousMonth] = useState('');
  const [globalSearch, setGlobalSearch] = useState('');
  const [selectedOutlet, setSelectedOutlet] = useState(null);
  const [outletStatusList, setOutletStatusList] = useState([]);
  const [toast, showToast] = useToast();

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = {};
      if (selectedTanggal) params.tanggal = selectedTanggal;
      if (selectedCurrentMonth) params.currentMonth = selectedCurrentMonth;
      if (selectedPreviousMonth) params.previousMonth = selectedPreviousMonth;
      const [res, statusRes] = await Promise.all([
        getEkspedisiAnalytics(params),
        getEkspedisiOutletStatus(),
      ]);
      setData(res);
      setOutletStatusList(statusRes);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [selectedTanggal, selectedCurrentMonth, selectedPreviousMonth]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const outletPerformance = data?.outletPerformance || [];
  const monthlySummary = data?.monthlySummary || [];
  const meta = data?.meta || {};

  const statusByOutlet = useMemo(() => {
    const m = {};
    outletStatusList.forEach(s => { m[s.idOutlet] = s; });
    return m;
  }, [outletStatusList]);

  // Update satu outlet-status secara optimistic dari respons API — tidak
  // perlu refetch semuanya tiap kali user Mark Contacted / Assign PIC / dst.
  const handleUpdateStatus = useCallback(async (idOutlet, patch) => {
    try {
      const updated = await updateEkspedisiOutletStatus({ idOutlet, ...patch });
      setOutletStatusList(prev => {
        const idx = prev.findIndex(s => s.idOutlet === idOutlet);
        if (idx === -1) return [...prev, updated];
        const next = [...prev];
        next[idx] = updated;
        return next;
      });
      return updated;
    } catch (e) {
      showToast('Gagal menyimpan perubahan');
      throw e;
    }
  }, [showToast]);

  const filteredOutletPerformance = useMemo(() => {
    if (!globalSearch.trim()) return outletPerformance;
    const q = globalSearch.trim().toLowerCase();
    return outletPerformance.filter(o => o.idOutlet.toLowerCase().includes(q));
  }, [outletPerformance, globalSearch]);

  const badges = useMemo(() => ({
    movement: outletPerformance.filter(o => o.segment === 'churn' || o.segment === 'declining').length,
    queue: outletPerformance.filter(o => o.priority === 'P0' || o.priority === 'P1').length,
    pareto: outletPerformance.filter(o => o.segment === 'low_yield').length,
    raw: outletPerformance.length,
  }), [outletPerformance]);

  const monthLabelOf = (b) => (monthlySummary.find(m => m.bulan === b) || {}).monthLabel || b;
  const currentSelectValue = selectedCurrentMonth || meta.currentMonth || '';
  const previousOptions = (meta.monthsDetected || []).filter(b => b < currentSelectValue);
  const latestMonthLabel = monthLabelOf(meta.latestMonth);
  const availableDates = meta.availableDates || [];
  const tanggalSelectValue = selectedTanggal || data?.tanggal || '';

  const fmtDateShort = (d) => d
    ? new Date(d).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
    : '-';
  const tanggalFmt = fmtDateShort(data?.tanggal);

  // Ganti tanggal -> bulan current/previous yang ter-pilih bisa jadi tidak
  // ada di sync tanggal itu, reset ke otomatis (backend yang pilihkan).
  const handleTanggalChange = (val) => {
    setSelectedTanggal(val);
    setSelectedCurrentMonth('');
    setSelectedPreviousMonth('');
  };

  if (loading && !data) {
    return (
      <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1yVNeyHe3b_PLnFf3SGvLx3wuD4Gm3e6XItjiDADd_Lo" gsheetLabel="Ekspedisi">
        <div className="wre-loading"><i className="ti ti-loader-2 wre-spin" style={{ color: THEME }} /><span>Memuat data ekspedisi…</span></div>
      </Layout>
    );
  }

  if (error && !loading) {
    return (
      <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1yVNeyHe3b_PLnFf3SGvLx3wuD4Gm3e6XItjiDADd_Lo" gsheetLabel="Ekspedisi">
        <div className="wre-error">
          <i className="ti ti-alert-triangle" style={{ color: '#DC2626', fontSize: 32 }} />
          <p>{error}</p>
          <button className="wre-retry-btn" onClick={fetchData}>Coba Lagi</button>
        </div>
      </Layout>
    );
  }

  if (!loading && (!data?.tanggal || !monthlySummary.length)) {
    return (
      <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1yVNeyHe3b_PLnFf3SGvLx3wuD4Gm3e6XItjiDADd_Lo" gsheetLabel="Ekspedisi">
        <div className="wre-empty-state">
          <i className="ti ti-database-off" style={{ fontSize: 40, color: '#9CA3AF' }} />
          <p>{EMPTY_NO_DATA}</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1yVNeyHe3b_PLnFf3SGvLx3wuD4Gm3e6XItjiDADd_Lo" gsheetLabel="Ekspedisi">
      <div className="wre-page">
        <div className="wre-header">
          <div className="wre-header-left">
            <i className="ti ti-truck-delivery wre-header-icon" style={{ color: THEME }} />
            <div>
              <div className="wre-header-title">War Room Ekspedisi</div>
              <div className="wre-header-sub">Growth, Retention &amp; Execution Control untuk memantau performa ekspedisi month-to-month.</div>
            </div>
          </div>
          <div className="wre-header-badges">
            <span className="wre-badge wre-badge-owner">👤 Okta</span>
            <span className="wre-badge wre-badge-date">📅 {tanggalFmt}</span>
            {meta.dayCutoff && <span className="wre-badge wre-badge-hari">{latestMonthLabel} — Hari ke-{meta.dayCutoff}</span>}
          </div>
        </div>

        <div className="wre-global-filter-row">
          <select className="wre-select" value={tanggalSelectValue} onChange={e => handleTanggalChange(e.target.value)} title="Tanggal sync">
            {availableDates.map(d => <option key={d} value={d}>{fmtDateShort(d)}</option>)}
          </select>
          <select className="wre-select" value={currentSelectValue} onChange={e => setSelectedCurrentMonth(e.target.value)} title="Current month">
            {(meta.monthsDetected || []).map(b => <option key={b} value={b}>{monthLabelOf(b)} (Current)</option>)}
          </select>
          <select className="wre-select" value={selectedPreviousMonth || meta.previousMonth || ''} onChange={e => setSelectedPreviousMonth(e.target.value)} title="Previous month">
            <option value="">Otomatis (bulan sebelumnya)</option>
            {previousOptions.map(b => <option key={b} value={b}>{monthLabelOf(b)} (Previous)</option>)}
          </select>
          <input className="wre-search" placeholder="🔍 Cari ID Outlet (semua tab)..." value={globalSearch} onChange={e => setGlobalSearch(e.target.value)} />
          <button className="wre-refresh-btn" onClick={fetchData} disabled={loading} title="Refresh data">
            <i className={'ti ti-refresh' + (loading ? ' wre-spin' : '')} /> Refresh
          </button>
        </div>

        <div className="wre-tabs">
          {TABS.map(t => (
            <button key={t.key} className={'wre-tab' + (activeTab === t.key ? ' wre-tab-active' : '')} onClick={() => setActiveTab(t.key)}>
              <i className={`ti ti-${t.icon}`} /> {t.label}
              {badges[t.key] > 0 && <span className="wre-tab-badge">{badges[t.key]}</span>}
            </button>
          ))}
        </div>

        <div className="wre-tab-content">
          {activeTab === 'overview'  && <ExecutiveOverviewTab data={{ ...data, outletPerformance: filteredOutletPerformance }} onSelectOutlet={setSelectedOutlet} />}
          {activeTab === 'trendline' && <TrendlineTab monthlySummary={monthlySummary} meta={meta} />}
          {activeTab === 'movement'  && <OutletMovementTab outletPerformance={filteredOutletPerformance} meta={meta} />}
          {activeTab === 'queue'     && <ExecutionQueueTab outletPerformance={filteredOutletPerformance} statusByOutlet={statusByOutlet} onUpdateStatus={handleUpdateStatus} showToast={showToast} onSelectOutlet={setSelectedOutlet} />}
          {activeTab === 'pareto'    && <ParetoTab outletPerformance={filteredOutletPerformance} businessMetrics={data?.businessMetrics || {}} monthlySummary={monthlySummary} meta={meta} />}
          {activeTab === 'raw'       && <RawDataTab outletPerformance={filteredOutletPerformance} onSelectOutlet={setSelectedOutlet} />}
        </div>
      </div>

      <OutletDetailDrawer
        outlet={selectedOutlet}
        status={selectedOutlet ? statusByOutlet[selectedOutlet.idOutlet] : null}
        onUpdateStatus={handleUpdateStatus}
        showToast={showToast}
        onClose={() => setSelectedOutlet(null)}
      />
      <Toast text={toast} />
    </Layout>
  );
}
