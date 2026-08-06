import { useState, useEffect, useRef, useMemo, useCallback, Component } from 'react';
import Layout from '../components/Layout';
import Chart from 'chart.js/auto';
import {
  getMgmAnalytics, getMgmOutlets, searchMgmOutlet,
  getMgmActions, upsertMgmAction, updateMgmAction,
} from '../services/api';

// Defensive defaults — dipakai di titik-titik yang menerima data langsung
// dari response API, supaya bentuk response yang tak terduga (field hilang,
// null, tipe salah) tidak membuat seluruh halaman blank. Response backend
// SEHARUSNYA selalu punya bentuk ini, tapi halaman tidak boleh 100%
// bergantung pada asumsi itu.
function safeArr(v) { return Array.isArray(v) ? v : []; }
function safeObj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }

// Error boundary — kalau ADA bug yang lolos dari semua guard di atas (mis.
// error di dalam Chart.js saat commit useEffect), tampilkan pesan error yang
// jelas & bisa di-retry, JANGAN biarkan seluruh React root jadi blank tanpa
// penjelasan apa pun ke user.
class MgmErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[WarRoomMgmPa] Uncaught render error:', error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="wrfp-error" style={{ flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-alert-triangle" style={{ color: '#DC2626', fontSize: 20 }} />
            <strong>Halaman MGM PA mengalami error saat menampilkan data.</strong>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <button className="wr-btn-update" onClick={() => this.setState({ error: null })}>
            Coba Tampilkan Ulang
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const COLOR_PRIMARY = '#10B981';
const COLOR_ACCENT  = '#059669';

const STATUS_COLORS = {
  'Growth Engine':       '#059669',
  'Closer':              '#3B82F6',
  'Hunter Only':         '#F59E0B',
  'Productivity Builder':'#8B5CF6',
  'Costly PB':           '#DC2626',
  'Low Activity':        '#9CA3AF',
};

const nf = new Intl.NumberFormat('id-ID');
const nfPct = (n, digits = 1) => n == null ? 'N/A' : `${Number(n).toLocaleString('id-ID', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
function fmt(n) { return n == null ? '-' : nf.format(Math.round(Number(n))); }
function fmtRp(n) { return n == null ? '-' : 'Rp ' + nf.format(Math.round(Number(n))); }
function fmtDeltaPct(n) { if (n == null) return 'N/A'; const s = n >= 0 ? '+' : ''; return `${s}${n.toFixed(1)}%`; }
function fmtDeltaPt(n) { if (n == null) return 'N/A'; const s = n >= 0 ? '+' : ''; return `${s}${n.toFixed(1)} pt`; }
function deltaColor(n) { if (n == null) return 'var(--text-4)'; return n >= 0 ? '#059669' : '#DC2626'; }
function fmtBulan(periode) {
  if (!periode) return '-';
  const [y, m] = periode.split('-');
  const names = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  return `${names[parseInt(m)] || m} ${y}`;
}
function fmtDate(d) { return d ? String(d).substring(0, 10) : '-'; }

function toCsv(rows, columns) {
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(c => esc(c.label)).join(',');
  const body = rows.map(r => columns.map(c => esc(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(',')).join('\n');
  return `${header}\n${body}`;
}
function downloadCsv(filename, csv) {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const SPIN = { animation: 'aic-rotate 0.8s linear infinite' };

// ─── Shared small components ───────────────────────────────────
function KPICard({ label, value, deltaVal, deltaKind, sub, color }) {
  return (
    <div className="wrd-kpi-card" style={{ borderTop: `3px solid ${color}` }}>
      <div className="wrd-kpi-label">{label}</div>
      <div className="wrd-kpi-value" style={{ color }}>{value}</div>
      {sub && <div className="wrd-kpi-sub">{sub}</div>}
      {deltaVal !== undefined && (
        <div className="mgm-kpi-delta" style={{ color: deltaColor(deltaVal) }}>
          {deltaKind === 'pt' ? fmtDeltaPt(deltaVal) : fmtDeltaPct(deltaVal)} vs periode lalu
        </div>
      )}
    </div>
  );
}
function ChartCard({ title, right, children }) {
  return (
    <div className="wrd-chart-card">
      <div className="wrd-chart-head">
        <span className="wrd-chart-title">{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}
function StatusPill({ status }) {
  const c = STATUS_COLORS[status] || '#9CA3AF';
  return <span className="mgm-status-pill" style={{ background: c + '20', color: c }}>{status || '-'}</span>;
}

function BarChart({ labels, datasets, height = 220, horizontal = false }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: datasets.length > 1, position: 'top' } },
        scales: { x: { beginAtZero: true }, y: { beginAtZero: true } },
      },
    });
    return () => chart.destroy();
  }, [labels, datasets, horizontal]);
  return <div style={{ height }}><canvas ref={ref} /></div>;
}

function DonutChart({ labels, values, colors, height = 200 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current.getContext('2d'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 11 } } } },
      },
    });
    return () => chart.destroy();
  }, [labels, values, colors]);
  return <div style={{ height }}><canvas ref={ref} /></div>;
}

function BubbleMatrix({ rows, thresholds }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !rows?.length) return;
    const maxRev = Math.max(...rows.map(r => r.bubble_revenue || 0), 1);
    const chart = new Chart(ref.current.getContext('2d'), {
      type: 'bubble',
      data: {
        datasets: [{
          label: 'PB',
          data: rows.map(r => ({
            x: r.x_registrations || 0, y: r.y_conversion_pct || 0,
            r: 6 + ((r.bubble_revenue || 0) / maxRev) * 24,
            pb: r.pb, status: r.status,
          })),
          backgroundColor: rows.map(r => (STATUS_COLORS[r.status] || '#9CA3AF') + 'AA'),
          borderColor: rows.map(r => STATUS_COLORS[r.status] || '#9CA3AF'),
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.raw.pb}: ${nf.format(ctx.raw.x)} reg, ${ctx.raw.y.toFixed(1)}% konversi (${ctx.raw.status})`,
            },
          },
        },
        scales: {
          x: { title: { display: true, text: 'Registrations' } },
          y: { title: { display: true, text: 'REG → Paid Conversion (%)' } },
        },
      },
      plugins: [{
        id: 'thresholdLines',
        afterDraw(c) {
          if (!thresholds) return;
          const { ctx, chartArea, scales } = c;
          ctx.save();
          ctx.strokeStyle = '#9CA3AF80';
          ctx.setLineDash([4, 4]);
          if (thresholds.registrations_p50 != null) {
            const x = scales.x.getPixelForValue(thresholds.registrations_p50);
            ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
          }
          if (thresholds.conversion_p50 != null) {
            const y = scales.y.getPixelForValue(thresholds.conversion_p50);
            ctx.beginPath(); ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y); ctx.stroke();
          }
          ctx.restore();
        },
      }],
    });
    return () => chart.destroy();
  }, [rows, thresholds]);
  return <div style={{ height: 340 }}><canvas ref={ref} /></div>;
}

// ─── Data table helper ──────────────────────────────────────────
function DataTable({ columns, rows, emptyLabel = 'Belum ada data' }) {
  return (
    <div className="wr-table-wrap">
      <table className="wr-table">
        <thead><tr>{columns.map(c => <th key={c.key} style={c.right ? { textAlign: 'right' } : undefined}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id_outlet || r.pb || r.id_aktifasi || i}>
              {columns.map(c => (
                <td key={c.key} style={c.right ? { textAlign: 'right' } : undefined}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={columns.length} style={{ textAlign: 'center', color: 'var(--text-4)', padding: 20 }}>{emptyLabel}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 1 — Command Center
// ═══════════════════════════════════════════════════════════════
function buildExecutiveInsight(data) {
  if (!data?.summary) return [];
  const current = safeObj(data.summary.current);
  const previous = safeObj(data.summary.previous);
  const deltas = safeObj(data.summary.deltas);
  const insights = [];

  if (deltas.registrations != null && deltas.reg_to_paid_conversion_pct != null) {
    if (deltas.registrations > 0 && deltas.reg_to_paid_conversion_pct < 0) {
      insights.push({ icon: '⚠️', text: `Registrasi naik ${fmtDeltaPct(deltas.registrations)} tapi konversi REG→Paid turun ${fmtDeltaPt(deltas.reg_to_paid_conversion_pct)} — kualitas registrasi perlu dicek, bukan cuma kuantitas.` });
    } else if (deltas.registrations > 0 && deltas.reg_to_paid_conversion_pct > 0) {
      insights.push({ icon: '✅', text: `Registrasi naik ${fmtDeltaPct(deltas.registrations)} DAN konversi ikut naik ${fmtDeltaPt(deltas.reg_to_paid_conversion_pct)} — pertumbuhan sehat.` });
    }
  }
  if (deltas.transacting_outlets != null && deltas.activated_outlets != null) {
    if (deltas.transacting_outlets > deltas.activated_outlets) {
      insights.push({ icon: '📈', text: `Outlet bertransaksi tumbuh lebih cepat (${fmtDeltaPct(deltas.transacting_outlets)}) dibanding outlet aktif (${fmtDeltaPct(deltas.activated_outlets)}) — aktivasi lama makin produktif.` });
    } else if (deltas.transacting_outlets < 0 && deltas.activated_outlets > 0) {
      insights.push({ icon: '⚠️', text: `Outlet aktif bertambah tapi outlet bertransaksi justru turun ${fmtDeltaPct(deltas.transacting_outlets)} — indikasi outlet baru belum produktif.` });
    }
  }
  if (current.revenue_per_transaction != null && previous.revenue_per_transaction != null) {
    const d = current.revenue_per_transaction - previous.revenue_per_transaction;
    if (Math.abs(d) > 1) insights.push({ icon: d > 0 ? '💰' : '📉', text: `Revenue per transaksi ${d > 0 ? 'naik' : 'turun'} dari ${fmtRp(previous.revenue_per_transaction)} ke ${fmtRp(current.revenue_per_transaction)}.` });
  }
  if (data.concentration?.revenue?.top1?.pct != null && data.concentration.revenue.top1.pct >= 30) {
    insights.push({ icon: '🎯', text: `Top-1 PB (${data.concentration.revenue.top1.pb}) menyumbang ${data.concentration.revenue.top1.pct.toFixed(1)}% dari total revenue — risiko konsentrasi tinggi pada satu PB.` });
  }
  if (deltas.negative_activation_count != null) {
    if (deltas.negative_activation_count < 0) insights.push({ icon: '✅', text: `Aktivasi berkomisi negatif membaik: turun ${fmtDeltaPct(Math.abs(deltas.negative_activation_count))} dari periode lalu.` });
    else if (deltas.negative_activation_count > 0) insights.push({ icon: '⚠️', text: `Aktivasi berkomisi negatif memburuk: naik ${fmtDeltaPct(deltas.negative_activation_count)} dari periode lalu.` });
  }
  if (data.meta?.quality?.upline_mismatch_reg_vs_activation > 0 || data.meta?.quality?.upline_mismatch_reg_vs_detail > 0) {
    insights.push({ icon: '🔍', text: `Ditemukan ketidakcocokan upline antar sumber data (REG vs AKTIVASI/DETAIL) — cek tab Action Center & Data Audit.` });
  }
  return insights;
}

function CommandCenterTab({ data }) {
  const s = safeObj(data.summary);
  const cohortFunnel = safeObj(data.cohort_funnel);
  const operationalVolume = safeObj(data.operational_volume);
  const insights = useMemo(() => buildExecutiveInsight(data), [data]);
  const topPb = useMemo(() => [...safeArr(data.pb_scorecard)].sort((a, b) => b.registrations - a.registrations).slice(0, 8), [data.pb_scorecard]);

  return (
    <div className="wrd-tab-content">
      <div className="wrd-charts-row">
        <ChartCard title="Cohort Funnel — Registrasi → Converted → Transacting">
          <div className="mgm-funnel">
            {[
              { label: 'Registrasi', val: cohortFunnel.registrations, color: '#3B82F6' },
              { label: 'Converted Registration', val: cohortFunnel.converted_registrations, color: COLOR_ACCENT, sub: nfPct(cohortFunnel.reg_to_paid_conversion_pct) },
              { label: 'Converted & Transacting', val: cohortFunnel.converted_and_transacting, color: '#7C3AED', sub: nfPct(cohortFunnel.converted_to_transaction_pct) },
            ].map((f, i) => (
              <div key={i} className="mgm-funnel-step">
                <div className="mgm-funnel-bar" style={{ background: f.color + '15', borderLeft: `4px solid ${f.color}` }}>
                  <span>{f.label}</span>
                  <strong style={{ color: f.color }}>{fmt(f.val)}</strong>
                </div>
                {f.sub && <div className="mgm-funnel-sub">{f.sub}</div>}
              </div>
            ))}
          </div>
        </ChartCard>
        <ChartCard title="Operational Volume">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { label: 'Paid Activation Events', val: operationalVolume.paid_activation_events },
              { label: 'Activated Outlets', val: operationalVolume.activated_outlets },
              { label: 'Transacting Outlets', val: operationalVolume.transacting_outlets, sub: nfPct(operationalVolume.activation_to_transaction_pct) },
            ].map((f, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--bg-page)', borderRadius: 8 }}>
                <span style={{ fontSize: 13 }}>{f.label}</span>
                <span style={{ fontWeight: 700 }}>{fmt(f.val)} {f.sub && <span style={{ fontSize: 11, color: 'var(--text-4)', fontWeight: 400 }}>({f.sub})</span>}</span>
              </div>
            ))}
          </div>
        </ChartCard>
      </div>

      <div className="wrd-charts-row">
        <ChartCard title="Executive Insight">
          {insights.length === 0
            ? <div style={{ color: 'var(--text-4)', fontSize: 13 }}>Belum ada insight signifikan periode ini.</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {insights.map((ins, i) => (
                  <div key={i} style={{ fontSize: 13, padding: '8px 10px', background: 'var(--bg-page)', borderRadius: 8 }}>
                    {ins.icon} {ins.text}
                  </div>
                ))}
              </div>}
        </ChartCard>
        <ChartCard title="Concentration Risk (kontribusi Top PB)">
          <DataTable
            columns={[
              { key: 'metric', label: 'Metrik' },
              { key: 'top1', label: 'Top 1', right: true, render: r => `${nfPct(r.top1?.pct)} (${r.top1?.pb || '-'})` },
              { key: 'top5', label: 'Top 5', right: true, render: r => nfPct(r.top5?.pct) },
              { key: 'top10', label: 'Top 10', right: true, render: r => nfPct(r.top10?.pct) },
            ]}
            rows={[
              { metric: 'Registrasi', ...safeObj(safeObj(data.concentration).registrations) },
              { metric: 'Paid Activation', ...safeObj(safeObj(data.concentration).paid_activation_events) },
              { metric: 'Revenue', ...safeObj(safeObj(data.concentration).revenue) },
            ]}
          />
        </ChartCard>
      </div>

      <ChartCard title="Daily Acquisition — Registrasi & Aktivasi (bukan revenue/trx harian)">
        <BarChart
          labels={safeArr(data.daily_acquisition).map(d => String(d.date || '').slice(5))}
          datasets={[
            { label: 'Registrasi', data: safeArr(data.daily_acquisition).map(d => d.registrations || 0), backgroundColor: '#3B82F6CC' },
            { label: 'Activated Outlets', data: safeArr(data.daily_acquisition).map(d => d.activated_outlets || 0), backgroundColor: COLOR_PRIMARY + 'CC' },
          ]}
        />
      </ChartCard>

      <ChartCard title="Top PB (ringkas)">
        <DataTable
          columns={[
            { key: 'pb', label: 'PB' },
            { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
            { key: 'registrations', label: 'Reg', right: true },
            { key: 'reg_to_paid_conversion_pct', label: 'Konversi', right: true, render: r => nfPct(r.reg_to_paid_conversion_pct) },
            { key: 'total_revenue', label: 'Revenue', right: true, render: r => fmtRp(r.total_revenue) },
          ]}
          rows={topPb}
        />
      </ChartCard>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 2 — PB Scorecard
// ═══════════════════════════════════════════════════════════════
function PbScorecardTab({ data, onSelectPb }) {
  const [q, setQ] = useState('');
  const [sortF, setSortF] = useState('registrations');
  const [sortD, setSortD] = useState('desc');
  const pbMatrix = safeObj(data.pb_matrix);
  pbMatrix.rows = safeArr(pbMatrix.rows);
  pbMatrix.thresholds = safeObj(pbMatrix.thresholds);

  const rows = useMemo(() => {
    let d = data.pb_scorecard || [];
    if (q) d = d.filter(r => r.pb.toLowerCase().includes(q.toLowerCase()));
    return [...d].sort((a, b) => {
      const va = a[sortF] ?? -Infinity, vb = b[sortF] ?? -Infinity;
      return sortD === 'asc' ? va - vb : vb - va;
    });
  }, [data.pb_scorecard, q, sortF, sortD]);

  const onSort = f => { if (sortF === f) setSortD(d => d === 'asc' ? 'desc' : 'asc'); else { setSortF(f); setSortD('desc'); } };
  const Th = ({ label, field, right }) => (
    <th style={{ cursor: 'pointer', textAlign: right ? 'right' : undefined }} onClick={() => onSort(field)}>
      {label} {sortF === field ? (sortD === 'asc' ? '↑' : '↓') : ''}
    </th>
  );

  function exportCsv() {
    const csv = toCsv(rows, [
      { label: 'PB', value: 'pb' }, { label: 'Status', value: 'status' },
      { label: 'Registrasi', value: 'registrations' }, { label: 'Converted', value: 'converted_registrations' },
      { label: 'Paid Activation Events', value: 'paid_activation_events' }, { label: 'Activated Outlets', value: 'activated_outlets' },
      { label: 'Transacting Outlets', value: 'transacting_outlets' }, { label: 'Konversi (%)', value: r => r.reg_to_paid_conversion_pct },
      { label: 'Activation->Transaction (%)', value: r => r.activation_to_transaction_pct },
      { label: 'Total TRX', value: 'total_trx' }, { label: 'Total Revenue', value: 'total_revenue' },
      { label: 'Fee Upline', value: 'fee_upline' }, { label: 'Komisi Aktivasi', value: 'activation_commission' },
      { label: 'Negative Activation', value: 'negative_activation_count' },
    ]);
    downloadCsv(`mgm-pb-scorecard-${data.meta.selected_period}.csv`, csv);
  }

  return (
    <div className="wrd-tab-content">
      <div className="wrd-charts-row">
        <ChartCard title="PB Matrix — Registrasi vs Konversi (bubble = revenue)">
          <BubbleMatrix rows={pbMatrix.rows} thresholds={pbMatrix.thresholds} />
          <div className="mgm-matrix-legend">
            {Object.entries(STATUS_COLORS).map(([label, color]) => (
              <span key={label} className="mgm-matrix-legend-item"><i style={{ background: color }} />{label}</span>
            ))}
          </div>
        </ChartCard>
        <ChartCard title="Threshold Segmentasi (P25/P50/P75 aktual, bukan target)">
          <DataTable
            columns={[{ key: 'k', label: 'Metrik' }, { key: 'v', label: 'Nilai', right: true }]}
            rows={Object.entries(pbMatrix.thresholds).map(([k, v]) => ({ k, v: typeof v === 'number' ? v.toFixed(1) : v }))}
          />
        </ChartCard>
      </div>

      <ChartCard title="PB Scorecard" right={
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="Cari PB..." value={q} onChange={e => setQ(e.target.value)} className="wr-select" style={{ fontSize: 12 }} />
          <button className="wr-btn-update" onClick={exportCsv}><i className="ti ti-download" /></button>
        </div>
      }>
        <div className="wr-table-wrap">
          <table className="wr-table">
            <thead><tr>
              <th>PB</th><th>Status</th>
              <Th label="Reg" field="registrations" right /><Th label="Converted" field="converted_registrations" right />
              <Th label="Paid Events" field="paid_activation_events" right /><Th label="Aktif" field="activated_outlets" right />
              <Th label="Transacting" field="transacting_outlets" right />
              <Th label="Konversi" field="reg_to_paid_conversion_pct" right /><Th label="Akt→Trx" field="activation_to_transaction_pct" right />
              <Th label="Revenue" field="total_revenue" right /><Th label="Komisi" field="activation_commission" right />
              <Th label="Neg. Akt" field="negative_activation_count" right />
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.pb} onClick={() => onSelectPb(r.pb)} style={{ cursor: 'pointer' }}>
                  <td><code>{r.pb}</code></td>
                  <td><StatusPill status={r.status} /></td>
                  <td style={{ textAlign: 'right' }}>{fmt(r.registrations)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(r.converted_registrations)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(r.paid_activation_events)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(r.activated_outlets)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(r.transacting_outlets)}</td>
                  <td style={{ textAlign: 'right' }}>{nfPct(r.reg_to_paid_conversion_pct)}</td>
                  <td style={{ textAlign: 'right' }}>{nfPct(r.activation_to_transaction_pct)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtRp(r.total_revenue)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtRp(r.activation_commission)}</td>
                  <td style={{ textAlign: 'right', color: r.negative_activation_count > 0 ? '#DC2626' : undefined }}>{fmt(r.negative_activation_count)}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={12} style={{ textAlign: 'center', padding: 20, color: 'var(--text-4)' }}>Belum ada data</td></tr>}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 3 — Funnel & Aging
// ═══════════════════════════════════════════════════════════════
function agingBucketOf(days) {
  if (days === null || days === undefined) return 'unknown';
  if (days <= 1) return '0-1 hari';
  if (days <= 3) return '2-3 hari';
  if (days <= 7) return '4-7 hari';
  if (days <= 14) return '8-14 hari';
  return '>14 hari';
}
const AGING_BUCKETS = ['0-1 hari', '2-3 hari', '4-7 hari', '8-14 hari', '>14 hari', 'unknown'];

const STAGE_LABELS = {
  registered_not_paid: 'Registered, Not Paid',
  paid_not_active: 'Paid, Not Active',
  active_no_trx: 'Active, No Trx',
  transacting: 'Transacting',
  data_review: 'Data Review (orphan)',
};

// Browser outlet server-side (stage/pagination) — endpoint GET /mgm/outlets,
// SELALU fresh (tidak lewat cache analytics 5 menit).
function OutletExplorer({ periode }) {
  const [stage, setStage] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getMgmOutlets({ periode, stage: stage || undefined, page, limit: 50 })
      .then(res => { if (!cancelled) setResult(res); })
      .catch(() => { if (!cancelled) setResult(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [periode, stage, page]);

  const outlets = result?.outlets || [];
  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.limit)) : 1;

  return (
    <ChartCard title={`Outlet Explorer${result ? ` (${result.total} outlet)` : ''}`} right={
      <select className="wr-select" value={stage} onChange={e => { setStage(e.target.value); setPage(1); }} style={{ fontSize: 12 }}>
        <option value="">Semua Stage</option>
        {Object.entries(STAGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        <option value="negative_economics">Negative Economics</option>
      </select>
    }>
      {loading && !result ? <div style={{ padding: 16, color: 'var(--text-4)' }}>Memuat…</div> : (
        <>
          <DataTable
            columns={[
              { key: 'id_outlet', label: 'ID Outlet' }, { key: 'upline', label: 'PB' }, { key: 'nama_pemilik', label: 'Nama' },
              { key: 'nama_kota', label: 'Kota' }, { key: 'tipe_outlet', label: 'Tipe' },
              { key: 'stage', label: 'Stage', render: r => STAGE_LABELS[r.stage] || r.stage },
              { key: 'trx', label: 'TRX', right: true }, { key: 'rev', label: 'Revenue', right: true, render: r => fmtRp(r.rev) },
              { key: 'has_negative_economics', label: '', render: r => r.has_negative_economics ? <span style={{ color: '#DC2626' }}>⚠️ neg.</span> : null },
            ]}
            rows={outlets}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10, alignItems: 'center', fontSize: 12 }}>
            <button className="mgm-mini-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
            <span>Hal {page}/{totalPages}</span>
            <button className="mgm-mini-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next ›</button>
          </div>
        </>
      )}
    </ChartCard>
  );
}

function FunnelAgingTab({ data, periode }) {
  const p1Queue = safeArr(safeObj(data.derived_queues).p1);
  const regNotPaid = p1Queue.filter(q => q.type === 'registered_not_paid');
  const activeNoTrx = p1Queue.filter(q => q.type === 'active_no_transaction');
  const cohortFunnel = safeObj(data.cohort_funnel);
  const operationalVolume = safeObj(data.operational_volume);

  const bucketCounts = (arr) => AGING_BUCKETS.map(b => arr.filter(q => agingBucketOf(q.aging_days) === b).length);

  return (
    <div className="wrd-tab-content">
      <div className="wrd-charts-row">
        <ChartCard title="Lifecycle Funnel">
          <DataTable
            columns={[{ key: 'label', label: 'Tahap' }, { key: 'val', label: 'Jumlah', right: true }]}
            rows={[
              { label: 'Registrations', val: fmt(cohortFunnel.registrations) },
              { label: 'Converted Registration', val: fmt(cohortFunnel.converted_registrations) },
              { label: 'Converted & Transacting', val: fmt(cohortFunnel.converted_and_transacting) },
              { label: 'Paid Activation Events', val: fmt(operationalVolume.paid_activation_events) },
              { label: 'Activated Outlets', val: fmt(operationalVolume.activated_outlets) },
              { label: 'Transacting Outlets', val: fmt(operationalVolume.transacting_outlets) },
            ]}
          />
        </ChartCard>
        <ChartCard title="Aging Bucket — Registered Not Paid vs Active No Trx (deskriptif, bukan SLA resmi)">
          <BarChart
            labels={AGING_BUCKETS}
            datasets={[
              { label: 'Registered Not Paid', data: bucketCounts(regNotPaid), backgroundColor: '#F59E0BCC' },
              { label: 'Active No Trx', data: bucketCounts(activeNoTrx), backgroundColor: '#DC2626CC' },
            ]}
          />
        </ChartCard>
      </div>

      <ChartCard title={`Queue — Registered Not Paid (${regNotPaid.length})`}>
        <DataTable
          columns={[
            { key: 'id_outlet', label: 'ID Outlet' }, { key: 'upline', label: 'PB' },
            { key: 'aging_days', label: 'Aging (hari)', right: true },
            { key: 'aging_critical', label: 'Kritis', render: r => r.aging_critical ? <span style={{ color: '#DC2626', fontWeight: 700 }}>Ya</span> : 'Tidak' },
          ]}
          rows={regNotPaid.slice(0, 100)}
        />
      </ChartCard>

      <ChartCard title={`Queue — Active, Belum Bertransaksi (${activeNoTrx.length})`}>
        <DataTable
          columns={[
            { key: 'id_outlet', label: 'ID Outlet' }, { key: 'upline', label: 'PB' },
            { key: 'aging_days', label: 'Aging (hari)', right: true },
            { key: 'aging_critical', label: 'Kritis', render: r => r.aging_critical ? <span style={{ color: '#DC2626', fontWeight: 700 }}>Ya</span> : 'Tidak' },
          ]}
          rows={activeNoTrx.slice(0, 100)}
        />
      </ChartCard>

      <OutletExplorer periode={periode} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 4 — Transaction & Revenue
// ═══════════════════════════════════════════════════════════════
function TransactionRevenueTab({ data }) {
  const trend = safeArr(data.monthly_trend);
  const pbScorecard = safeArr(data.pb_scorecard);
  const topRevPb = [...pbScorecard].sort((a, b) => b.total_revenue - a.total_revenue).slice(0, 10);
  const bottomRevPb = [...pbScorecard].filter(r => r.activated_outlets > 0).sort((a, b) => a.total_revenue - b.total_revenue).slice(0, 10);
  const activeNoTrxOutlets = safeArr(safeObj(data.derived_queues).p1).filter(q => q.type === 'active_no_transaction');
  const current = safeObj(safeObj(data.summary).current);

  return (
    <div className="wrd-tab-content">
      <ChartCard title={`Trend Bulanan (cutoff hari berbeda per bulan — lihat label)`}>
        <BarChart
          labels={trend.map(t => `${fmtBulan(t.periode).slice(0, 3)} (d${t.cutoff_day ?? '?'})`)}
          datasets={[
            { label: 'Total TRX', data: trend.map(t => Number(t.total_trx)), backgroundColor: '#3B82F6CC' },
            { label: 'Total Revenue (rb)', data: trend.map(t => Number(t.total_revenue) / 1000), backgroundColor: COLOR_PRIMARY + 'CC' },
          ]}
        />
      </ChartCard>

      <div className="wrd-kpi-grid wrd-kpi-grid-3">
        <KPICard label="TOTAL TRX" value={fmt(current.total_trx)} color="#3B82F6" />
        <KPICard label="REVENUE PER TRANSAKSI" value={fmtRp(current.revenue_per_transaction)} color={COLOR_PRIMARY} />
        <KPICard label="REVENUE PER ACTIVATED OUTLET" value={fmtRp(current.revenue_per_activated_outlet)} color="#8B5CF6" />
      </div>

      <div className="wrd-charts-row">
        <ChartCard title="Top 10 PB by Revenue">
          <BarChart horizontal labels={topRevPb.map(r => r.pb)} datasets={[{ data: topRevPb.map(r => r.total_revenue), backgroundColor: COLOR_PRIMARY + 'CC' }]} height={280} />
        </ChartCard>
        <ChartCard title="Bottom 10 PB by Revenue (yang sudah punya outlet aktif)">
          <BarChart horizontal labels={bottomRevPb.map(r => r.pb)} datasets={[{ data: bottomRevPb.map(r => r.total_revenue), backgroundColor: '#DC2626CC' }]} height={280} />
        </ChartCard>
      </div>

      <ChartCard title={`Outlet Aktif Belum Bertransaksi (${activeNoTrxOutlets.length})`}>
        <DataTable
          columns={[{ key: 'id_outlet', label: 'ID Outlet' }, { key: 'upline', label: 'PB' }, { key: 'aging_days', label: 'Aging (hari)', right: true }]}
          rows={activeNoTrxOutlets.slice(0, 100)}
        />
      </ChartCard>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 5 — Activation Economics
// ═══════════════════════════════════════════════════════════════
function EconomicsTab({ data }) {
  const e = safeObj(data.economics);
  e.by_tipe_outlet = safeArr(e.by_tipe_outlet);
  e.by_pembayaran_via = safeArr(e.by_pembayaran_via);
  e.by_nama_group = safeArr(e.by_nama_group);
  e.negative_activations = safeArr(e.negative_activations);
  e.formula_mismatch = safeArr(e.formula_mismatch);

  function exportNegCsv() {
    const csv = toCsv(e.negative_activations, [
      { label: 'ID Aktifasi', value: 'id_aktifasi' }, { label: 'ID Outlet', value: 'id_outlet' }, { label: 'PB', value: 'upline' },
      { label: 'Komisi Aktifasi', value: 'komisi_aktifasi' }, { label: 'Fee Upline', value: 'fee_upline' },
    ]);
    downloadCsv(`mgm-negative-activations-${data.meta.selected_period}.csv`, csv);
  }

  return (
    <div className="wrd-tab-content">
      <div className="wrd-kpi-grid wrd-kpi-grid-4">
        <KPICard label="FEE UPLINE" value={fmtRp(e.fee_upline)} color="#3B82F6" />
        <KPICard label="KOMISI AKTIVASI" value={fmtRp(e.activation_commission)} color={COLOR_PRIMARY} />
        <KPICard label="AVG KOMISI/EVENT" value={fmtRp(e.avg_commission_per_activation)} color="#8B5CF6" />
        <KPICard label="NEGATIVE ACTIVATION" value={`${fmt(e.negative_activation_count)} (${nfPct(e.negative_activation_rate)})`} color="#DC2626" />
      </div>

      <div className="wrd-charts-row">
        <ChartCard title="Breakdown per Tipe Outlet">
          <DataTable columns={[
            { key: 'key', label: 'Tipe' }, { key: 'count', label: 'Jumlah', right: true },
            { key: 'fee_upline', label: 'Fee Upline', right: true, render: r => fmtRp(r.fee_upline) },
            { key: 'komisi_aktifasi', label: 'Komisi', right: true, render: r => fmtRp(r.komisi_aktifasi) },
          ]} rows={e.by_tipe_outlet} />
        </ChartCard>
        <ChartCard title="Breakdown per Pembayaran">
          <DataTable columns={[
            { key: 'key', label: 'Metode' }, { key: 'count', label: 'Jumlah', right: true },
            { key: 'fee_upline', label: 'Fee Upline', right: true, render: r => fmtRp(r.fee_upline) },
            { key: 'komisi_aktifasi', label: 'Komisi', right: true, render: r => fmtRp(r.komisi_aktifasi) },
          ]} rows={e.by_pembayaran_via} />
        </ChartCard>
      </div>

      <ChartCard title="Breakdown per Nama Group">
        <DataTable columns={[
          { key: 'key', label: 'Group' }, { key: 'count', label: 'Jumlah', right: true },
          { key: 'fee_upline', label: 'Fee Upline', right: true, render: r => fmtRp(r.fee_upline) },
          { key: 'komisi_aktifasi', label: 'Komisi', right: true, render: r => fmtRp(r.komisi_aktifasi) },
        ]} rows={e.by_nama_group} />
      </ChartCard>

      <ChartCard title={`Aktivasi Komisi Negatif (${e.negative_activations.length})`} right={
        <button className="wr-btn-update" onClick={exportNegCsv}><i className="ti ti-download" /></button>
      }>
        <DataTable columns={[
          { key: 'id_aktifasi', label: 'ID Aktifasi' }, { key: 'id_outlet', label: 'ID Outlet' }, { key: 'upline', label: 'PB' },
          { key: 'komisi_aktifasi', label: 'Komisi', right: true, render: r => <span style={{ color: '#DC2626', fontWeight: 700 }}>{fmtRp(r.komisi_aktifasi)}</span> },
          { key: 'biaya_aktifasi_2', label: 'Biaya Aktivasi', right: true, render: r => fmtRp(r.biaya_aktifasi_2) },
          { key: 'hpp', label: 'HPP', right: true, render: r => fmtRp(r.hpp) },
          { key: 'ongkos_kirim', label: 'Ongkir', right: true, render: r => fmtRp(r.ongkos_kirim) },
          { key: 'fee_upline', label: 'Fee Upline', right: true, render: r => fmtRp(r.fee_upline) },
        ]} rows={e.negative_activations.slice(0, 100)} />
      </ChartCard>

      {e.formula_mismatch.length > 0 && (
        <ChartCard title={`⚠️ Formula Audit Mismatch (${e.formula_mismatch.length}) — komisi resmi TETAP nilai sumber sheet`}>
          <DataTable columns={[
            { key: 'id_aktifasi', label: 'ID Aktifasi' }, { key: 'id_outlet', label: 'ID Outlet' },
            { key: 'expected', label: 'Formula (audit)', right: true, render: r => fmtRp(r.expected) },
            { key: 'actual', label: 'Sumber Sheet (resmi)', right: true, render: r => fmtRp(r.actual) },
            { key: 'diff', label: 'Selisih', right: true, render: r => fmtRp(r.diff) },
          ]} rows={e.formula_mismatch.slice(0, 100)} />
        </ChartCard>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 6 — Territory & Mix
// ═══════════════════════════════════════════════════════════════
function TerritoryMixTab({ data }) {
  const territories = safeArr(data.territories);
  const types = safeArr(data.outlet_types);
  const payments = safeArr(data.payment_mix);
  const thresholds = safeObj(safeObj(data.pb_matrix).thresholds);
  const flagged = safeArr(data.pb_scorecard).filter(r =>
    r.registrations >= (thresholds.registrations_p50 || 0) &&
    (r.reg_to_paid_conversion_pct == null || r.reg_to_paid_conversion_pct < (thresholds.conversion_p50 || 0))
  );

  return (
    <div className="wrd-tab-content">
      <ChartCard title="Top Provinsi by Revenue">
        <BarChart horizontal labels={territories.slice(0, 10).map(t => t.provinsi)} datasets={[{ data: territories.slice(0, 10).map(t => t.total_revenue), backgroundColor: COLOR_PRIMARY + 'CC' }]} height={280} />
      </ChartCard>

      <ChartCard title="Detail per Provinsi">
        <DataTable columns={[
          { key: 'provinsi', label: 'Provinsi' },
          { key: 'registrations', label: 'Reg', right: true }, { key: 'activated_outlets', label: 'Aktif', right: true },
          { key: 'transacting_outlets', label: 'Transacting', right: true },
          { key: 'total_trx', label: 'TRX', right: true }, { key: 'total_revenue', label: 'Revenue', right: true, render: r => fmtRp(r.total_revenue) },
        ]} rows={territories} />
      </ChartCard>

      <div className="wrd-charts-row">
        <ChartCard title="Outlet Type Mix">
          <DonutChart labels={types.map(t => t.tipe_outlet)} values={types.map(t => t.activated_outlets)} colors={['#7C3AED', '#059669', '#F97316', '#6B7280', '#3B82F6', '#EC4899', '#9CA3AF']} />
        </ChartCard>
        <ChartCard title="Payment Method Mix">
          <DonutChart labels={payments.map(p => p.pembayaran_via)} values={payments.map(p => p.count)} colors={['#3B82F6', '#059669', '#F59E0B', '#DC2626', '#8B5CF6']} />
        </ChartCard>
      </div>

      <ChartCard title={`Registrasi Tinggi tapi Konversi Rendah (${flagged.length} PB)`}>
        <DataTable columns={[
          { key: 'pb', label: 'PB' }, { key: 'registrations', label: 'Registrasi', right: true },
          { key: 'reg_to_paid_conversion_pct', label: 'Konversi', right: true, render: r => nfPct(r.reg_to_paid_conversion_pct) },
        ]} rows={flagged} />
      </ChartCard>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB 7 — Action Center & Data Audit
// ═══════════════════════════════════════════════════════════════
function ActionModal({ outlet, periode, onClose, onSaved }) {
  const [priority, setPriority] = useState('P2');
  const [actionType, setActionType] = useState('follow_up');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(status) {
    setSaving(true);
    try {
      await upsertMgmAction({ periode, id_outlet: outlet.id_outlet, upline: outlet.upline, action_type: actionType, priority, status, notes });
      onSaved();
      onClose();
    } catch (e) {
      alert('Gagal menyimpan action: ' + (e.response?.data?.error || e.message));
    } finally { setSaving(false); }
  }

  return (
    <div className="mgm-modal-backdrop" onClick={onClose}>
      <div className="mgm-modal" onClick={e => e.stopPropagation()}>
        <h3>Action — {outlet.id_outlet}</h3>
        <div className="mgm-modal-field">
          <label>Tipe Action</label>
          <select value={actionType} onChange={e => setActionType(e.target.value)}>
            <option value="follow_up">Follow Up</option>
            <option value="negative_commission">Negative Commission</option>
            <option value="paid_not_active">Paid Not Active</option>
            <option value="scale_reward">Scale / Reward</option>
          </select>
        </div>
        <div className="mgm-modal-field">
          <label>Prioritas</label>
          <select value={priority} onChange={e => setPriority(e.target.value)}>
            {['P0', 'P1', 'P2', 'P3'].map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="mgm-modal-field">
          <label>Catatan</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} />
        </div>
        <div className="mgm-modal-actions">
          <button disabled={saving} onClick={() => save('in_progress')}>Assign / Follow Up</button>
          <button disabled={saving} onClick={() => save('resolved')} className="mgm-btn-primary">Resolve</button>
          <button disabled={saving} onClick={() => save('dismissed')}>Dismiss</button>
          <button disabled={saving} onClick={onClose}>Batal</button>
        </div>
      </div>
    </div>
  );
}

function ActionCenterTab({ data, periode }) {
  const [actions, setActions] = useState([]);
  const [modalOutlet, setModalOutlet] = useState(null);
  const [queueTab, setQueueTab] = useState('p0');

  const loadActions = useCallback(async () => {
    try { const res = await getMgmActions({ periode }); setActions(res.actions || []); } catch { /* non-fatal */ }
  }, [periode]);
  useEffect(() => { loadActions(); }, [loadActions]);

  const q = safeObj(data.derived_queues);
  const queues = { p0: safeArr(q.p0), p1: safeArr(q.p1), p2: safeArr(q.p2), p3: safeArr(q.p3) };
  const activeQueue = queues[queueTab] || [];

  function exportQualityCsv() {
    const csv = toCsv(Object.entries(safeObj(safeObj(data.meta).quality)).map(([k, v]) => ({ k, v: JSON.stringify(v) })), [
      { label: 'Metrik', value: 'k' }, { label: 'Nilai', value: 'v' },
    ]);
    downloadCsv(`mgm-data-quality-${periode}.csv`, csv);
  }

  async function quickUpdate(action, status) {
    try { await updateMgmAction(action.id, { status }); loadActions(); }
    catch (e) { alert('Gagal update action: ' + (e.response?.data?.error || e.message)); }
  }

  return (
    <div className="wrd-tab-content">
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {['p0', 'p1', 'p2', 'p3'].map(p => (
          <button key={p} onClick={() => setQueueTab(p)} className={`mgm-queue-tab${queueTab === p ? ' active' : ''}`}>
            {p.toUpperCase()} ({queues[p].length})
          </button>
        ))}
      </div>

      <ChartCard title={`Queue ${queueTab.toUpperCase()}`}>
        <DataTable
          columns={[
            { key: 'type', label: 'Tipe' }, { key: 'id_outlet', label: 'ID Outlet' }, { key: 'pb', label: 'PB', render: r => r.upline || r.pb || '-' },
            { key: 'aging_days', label: 'Aging', right: true, render: r => r.aging_days ?? '-' },
            { key: 'action', label: 'Aksi', render: r => r.id_outlet ? (
              <button className="mgm-mini-btn" onClick={() => setModalOutlet(r)}>Assign/Follow Up</button>
            ) : null },
          ]}
          rows={activeQueue.slice(0, 150)}
        />
      </ChartCard>

      <ChartCard title={`Action Tersimpan (${actions.length})`}>
        <DataTable
          columns={[
            { key: 'id_outlet', label: 'ID Outlet' }, { key: 'upline', label: 'PB' }, { key: 'action_type', label: 'Tipe' },
            { key: 'priority', label: 'Prioritas' }, { key: 'status', label: 'Status' },
            { key: 'notes', label: 'Catatan' },
            { key: 'updated_at', label: 'Update', render: r => fmtDate(r.updated_at) },
            { key: 'quick', label: 'Aksi Cepat', render: r => r.status === 'resolved' || r.status === 'dismissed' ? null : (
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="mgm-mini-btn" onClick={() => quickUpdate(r, 'resolved')}>Resolve</button>
                <button className="mgm-mini-btn" onClick={() => quickUpdate(r, 'dismissed')}>Dismiss</button>
              </div>
            ) },
          ]}
          rows={actions}
        />
      </ChartCard>

      <ChartCard title="Data Quality" right={<button className="wr-btn-update" onClick={exportQualityCsv}><i className="ti ti-download" /></button>}>
        <DataTable
          columns={[{ key: 'k', label: 'Metrik' }, { key: 'v', label: 'Nilai', right: true }]}
          rows={Object.entries(safeObj(safeObj(data.meta).quality)).map(([k, v]) => ({ k, v: typeof v === 'object' ? JSON.stringify(v) : v }))}
        />
      </ChartCard>

      {modalOutlet && (
        <ActionModal outlet={modalOutlet} periode={periode} onClose={() => setModalOutlet(null)} onSaved={loadActions} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════
const TABS = [
  { id: 'command',   label: 'Command Center',           icon: 'ti-layout-dashboard' },
  { id: 'scorecard', label: 'PB Scorecard',              icon: 'ti-trophy' },
  { id: 'funnel',    label: 'Funnel & Aging',            icon: 'ti-filter' },
  { id: 'revenue',   label: 'Transaction & Revenue',     icon: 'ti-cash' },
  { id: 'economics', label: 'Activation Economics',      icon: 'ti-report-money' },
  { id: 'territory', label: 'Territory & Mix',           icon: 'ti-map-pin' },
  { id: 'action',    label: 'Action Center & Data Audit',icon: 'ti-clipboard-check' },
];

export default function WarRoomMgmPa() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [periode, setPeriode] = useState(null);
  const [tab, setTab] = useState('command');

  const [filterPb, setFilterPb] = useState('');
  const [filterProvinsi, setFilterProvinsi] = useState('');
  const [filterTipe, setFilterTipe] = useState('');
  const [filterPembayaran, setFilterPembayaran] = useState('');

  const [searchQ, setSearchQ] = useState('');
  const [searchRes, setSearchRes] = useState(null);
  const searchTimer = useRef(null);

  const fetchData = useCallback(async (p, force = false) => {
    setLoading(true); setError(null);
    try {
      const params = { periode: p || undefined, pb: filterPb || undefined, provinsi: filterProvinsi || undefined, tipe_outlet: filterTipe || undefined, pembayaran_via: filterPembayaran || undefined, force };
      const json = await getMgmAnalytics(params);
      setData(json);
      if (!p && json.meta?.selected_period) setPeriode(json.meta.selected_period);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setLoading(false); }
  }, [filterPb, filterProvinsi, filterTipe, filterPembayaran]);

  useEffect(() => { fetchData(periode); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [periode, filterPb, filterProvinsi, filterTipe, filterPembayaran]);

  function onSearchChange(val) {
    setSearchQ(val);
    clearTimeout(searchTimer.current);
    if (val.trim().length < 2) { setSearchRes(null); return; }
    searchTimer.current = setTimeout(async () => {
      try { setSearchRes(await searchMgmOutlet(val.trim(), periode)); } catch { setSearchRes(null); }
    }, 500);
  }

  const GSHEET = {
    gsheetUrl: 'https://docs.google.com/spreadsheets/d/1_OwT_j1qIcq2GP4ir-f5grJFI58E6Q5J5BuFsyuT_-s/edit',
    gsheetLabel: 'MGM PA',
  };

  if (loading && !data) return (
    <Layout {...GSHEET}><div className="wrfp-loading"><i className="ti ti-loader-2" style={SPIN} /><span>Memuat data MGM PA…</span></div></Layout>
  );
  if (error) return (
    <Layout {...GSHEET}>
      <div className="wrfp-error">
        <i className="ti ti-alert-circle" /><span>Gagal memuat: {error}</span>
        <button className="wr-btn-update" onClick={() => fetchData(periode, true)} style={{ marginLeft: 12 }}>Coba Lagi</button>
      </div>
    </Layout>
  );
  if (!data?.summary) return (
    <Layout {...GSHEET}>
      <div className="wrfp-empty">
        <i className="ti ti-database-off" />
        <p>Belum ada data MGM PA untuk periode ini.</p>
        <span>Jalankan pushMgmSemuaBulan() dari Apps Script terlebih dahulu.</span>
      </div>
    </Layout>
  );

  const s = safeObj(data.summary);
  s.current = safeObj(s.current);
  s.deltas = safeObj(s.deltas);
  const uplineOptions = [...new Set(safeArr(data.pb_scorecard).map(r => r.pb))].sort();
  const provinsiOptions = [...new Set(safeArr(data.territories).map(r => r.provinsi))].sort();
  const tipeOptions = [...new Set(safeArr(data.outlet_types).map(r => r.tipe_outlet))].sort();
  const paymentOptions = [...new Set(safeArr(data.payment_mix).map(r => r.pembayaran_via))].sort();

  function selectPb(pb) { setFilterPb(pb); setTab('scorecard'); }

  return (
    <Layout {...GSHEET}>
      <MgmErrorBoundary>
      <div className="wr-page">
        <div className="wr-header">
          <div>
            <div className="wr-title-row">
              <i className="ti ti-users-group" style={{ fontSize: 22, color: COLOR_PRIMARY }} />
              <h1 className="wr-title" style={{ color: COLOR_PRIMARY }}>WAR ROOM MGM PA</h1>
            </div>
            <p className="wr-sub">PB Lifecycle &amp; Productivity Control Tower · {fmtBulan(periode)}</p>
          </div>
          <div className="wr-header-right" style={{ flexWrap: 'wrap', gap: 8 }}>
            {data.meta.available_periods?.length > 0 && (
              <select className="wr-select" value={periode || ''} onChange={e => setPeriode(e.target.value)}>
                {data.meta.available_periods.map(p => <option key={p} value={p}>{fmtBulan(p)}</option>)}
              </select>
            )}
            <span className="mgm-chip">vs {fmtBulan(data.meta.compare_period)} (same-day)</span>
            {data.meta.cutoff_date && <span className="mgm-chip">Cutoff: {fmtDate(data.meta.cutoff_date)}</span>}
            <button className="wr-btn-update" onClick={() => fetchData(periode, true)} disabled={loading}>
              <i className="ti ti-refresh" style={loading ? SPIN : undefined} />
            </button>
          </div>
        </div>

        <div className="mgm-filter-bar">
          <select className="wr-select" value={filterPb} onChange={e => setFilterPb(e.target.value)}>
            <option value="">Semua PB</option>{uplineOptions.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          <select className="wr-select" value={filterProvinsi} onChange={e => setFilterProvinsi(e.target.value)}>
            <option value="">Semua Provinsi</option>{provinsiOptions.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select className="wr-select" value={filterTipe} onChange={e => setFilterTipe(e.target.value)}>
            <option value="">Semua Tipe Outlet</option>{tipeOptions.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className="wr-select" value={filterPembayaran} onChange={e => setFilterPembayaran(e.target.value)}>
            <option value="">Semua Pembayaran</option>{paymentOptions.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          {(filterPb || filterProvinsi || filterTipe || filterPembayaran) && (
            <button className="mgm-mini-btn" onClick={() => { setFilterPb(''); setFilterProvinsi(''); setFilterTipe(''); setFilterPembayaran(''); }}>× Reset Filter</button>
          )}
          <div style={{ flex: 1 }} />
          <input placeholder="Cari ID outlet / PB..." value={searchQ} onChange={e => onSearchChange(e.target.value)} className="wr-select" style={{ minWidth: 200 }} />
        </div>

        {searchRes && (
          <div className="wrd-chart-card" style={{ marginBottom: 14 }}>
            <div className="wrd-chart-title">Hasil Pencarian "{searchRes.q}" — {searchRes.total_registrasi} registrasi, {searchRes.total_aktivasi} aktivasi</div>
            <DataTable
              columns={[
                { key: 'periode', label: 'Periode' }, { key: 'id_outlet', label: 'ID Outlet' }, { key: 'upline', label: 'PB' },
                { key: 'nama_pemilik', label: 'Nama' }, { key: 'nama_kota', label: 'Kota' },
              ]}
              rows={[...safeArr(searchRes.registrasi), ...safeArr(searchRes.aktivasi)].slice(0, 50)}
            />
          </div>
        )}

        {!data.meta.target_available && (
          <div className="mgm-quality-banner">
            <i className="ti ti-info-circle" /> Target PB belum tersedia — evaluasi memakai perbandingan periode sebelumnya (same-day), bukan pencapaian target.
          </div>
        )}

        <div className="wrd-kpi-grid wrd-kpi-grid-4">
          <KPICard label="REGISTRASI" value={fmt(s.current.registrations)} deltaVal={s.deltas.registrations} deltaKind="pct" color="#3B82F6" />
          <KPICard label="CONVERTED REGISTRATIONS" value={fmt(s.current.converted_registrations)} deltaVal={s.deltas.converted_registrations} deltaKind="pct" color={COLOR_ACCENT} />
          <KPICard label="PAID ACTIVATION EVENTS" value={fmt(s.current.paid_activation_events)} deltaVal={s.deltas.paid_activation_events} deltaKind="pct" color="#8B5CF6" />
          <KPICard label="ACTIVATED OUTLETS" value={fmt(s.current.activated_outlets)} deltaVal={s.deltas.activated_outlets} deltaKind="pct" color={COLOR_PRIMARY} />
          <KPICard label="TRANSACTING OUTLETS" value={fmt(s.current.transacting_outlets)} deltaVal={s.deltas.transacting_outlets} deltaKind="pct" color="#059669" />
          <KPICard label="REG → PAID CONVERSION" value={nfPct(s.current.reg_to_paid_conversion_pct)} deltaVal={s.deltas.reg_to_paid_conversion_pct} deltaKind="pt" color="#F59E0B" />
          <KPICard label="ACTIVATION → TRANSACTION" value={nfPct(s.current.activation_to_transaction_pct)} deltaVal={s.deltas.activation_to_transaction_pct} deltaKind="pt" color="#F97316" />
          <KPICard label="TOTAL TRX" value={fmt(s.current.total_trx)} deltaVal={s.deltas.total_trx} deltaKind="pct" color="#3B82F6" />
          <KPICard label="REVENUE" value={fmtRp(s.current.total_revenue)} deltaVal={s.deltas.total_revenue} deltaKind="pct" color="#EC4899" />
          <KPICard label="FEE UPLINE" value={fmtRp(s.current.fee_upline)} deltaVal={s.deltas.fee_upline} deltaKind="pct" color="#7C3AED" />
          <KPICard label="ACTIVATION COMMISSION" value={fmtRp(s.current.activation_commission)} deltaVal={s.deltas.activation_commission} deltaKind="pct" color="#8B5CF6" />
          <KPICard label="NEGATIVE ACTIVATIONS" value={fmt(s.current.negative_activation_count)} deltaVal={s.deltas.negative_activation_count} deltaKind="pct" color="#DC2626" />
        </div>

        <div className="wrd-tabs">
          {TABS.map(t => (
            <button key={t.id} className={`wrd-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}
              style={tab === t.id ? { color: COLOR_PRIMARY, borderBottomColor: COLOR_PRIMARY } : {}}>
              <i className={`ti ${t.icon}`} style={{ marginRight: 5 }} />{t.label}
            </button>
          ))}
        </div>

        {tab === 'command'   && <CommandCenterTab data={data} />}
        {tab === 'scorecard' && <PbScorecardTab data={data} onSelectPb={selectPb} />}
        {tab === 'funnel'    && <FunnelAgingTab data={data} periode={periode} />}
        {tab === 'revenue'   && <TransactionRevenueTab data={data} />}
        {tab === 'economics' && <EconomicsTab data={data} />}
        {tab === 'territory' && <TerritoryMixTab data={data} />}
        {tab === 'action'    && <ActionCenterTab data={data} periode={periode} />}
      </div>
      </MgmErrorBoundary>
    </Layout>
  );
}
