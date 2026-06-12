import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Layout from '../components/Layout';
import { getSpeedcashAnalytics, getSpeedcashTanggalList } from '../services/api';
import Chart from 'chart.js/auto';

/* ═══════════════════════════════════════
   FORMAT HELPERS
═══════════════════════════════════════ */
function fmtRp(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}Rp ${(abs / 1_000_000_000).toFixed(1)}M`;
  if (abs >= 1_000_000)     return `${sign}Rp ${(abs / 1_000_000).toFixed(1)}jt`;
  if (abs >= 1_000)         return `${sign}Rp ${(abs / 1_000).toFixed(1)}k`;
  return `${sign}Rp ${abs.toFixed(0)}`;
}
function fmtNum(n) { return Number(n || 0).toLocaleString('id-ID'); }
function fmtDate(d) { return d ? String(d).slice(0, 10) : '–'; }
function fmtPct(num, den) {
  if (!den || den === 0) return num > 0 ? 'New Growth' : '0%';
  return `${((num / den) * 100).toFixed(1)}%`;
}
function fmtSign(n) { const v = Number(n) || 0; return v >= 0 ? `+${fmtNum(v)}` : fmtNum(v); }
function fmtSignRp(n) { const v = Number(n) || 0; return v >= 0 ? `+${fmtRp(v)}` : fmtRp(v); }

function NoHpLink({ no_hp }) {
  if (!no_hp) return <span style={{ color: 'var(--text-4)' }}>–</span>;
  const clean = String(no_hp).replace(/\D/g, '');
  return (
    <a href={`https://wa.me/${clean}`} target="_blank" rel="noreferrer"
      style={{ color: '#25D366', fontSize: 12, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
      <i className="ti ti-brand-whatsapp" style={{ fontSize: 13 }} />{no_hp}
    </a>
  );
}

/* ═══════════════════════════════════════
   BUSINESS LOGIC
═══════════════════════════════════════ */
const SEGMENT_COLORS = {
  superstar         : '#7C3AED',
  rising_star       : '#059669',
  at_risk           : '#DC2626',
  high_trx_low_margin: '#D97706',
  low_trx_high_margin: '#2563EB',
  low_value         : '#9CA3AF',
  inactive          : '#D1D5DB',
};
const SEGMENT_LABELS = {
  superstar          : 'Superstar',
  rising_star        : 'Rising Star',
  at_risk            : 'At Risk',
  high_trx_low_margin: 'High TRX Low Margin',
  low_trx_high_margin: 'Low TRX High Margin',
  low_value          : 'Low Value',
  inactive           : 'Inactive',
};
const SEGMENT_ACTIONS = {
  superstar          : 'Retain & upsell',
  rising_star        : 'Follow up, testimoni, scale',
  at_risk            : 'Hubungi merchant segera',
  high_trx_low_margin: 'Review pricing / MDR',
  low_trx_high_margin: 'Push aktivasi TRX',
  low_value          : 'Low priority',
  inactive           : 'Reaktivasi',
};
const STATUS_COLORS = {
  growing   : '#059669',
  declining : '#DC2626',
  stable    : '#6B7280',
  new_active: '#2563EB',
  churned   : '#9F1239',
  inactive  : '#D1D5DB',
};
const STATUS_LABELS = {
  growing   : 'Growing',
  declining : 'Declining',
  stable    : 'Stable',
  new_active: 'New/Reactivated',
  churned   : 'Churn',
  inactive  : 'Inactive',
};
const MARGIN_STATUS_LABELS = {
  margin_hero       : 'Margin Hero',
  margin_drop       : 'Margin Drop',
  volume_no_margin  : 'Volume No Margin',
  new_margin_source : 'New Margin Source',
  normal            : 'Normal',
};
const MARGIN_STATUS_COLORS = {
  margin_hero      : '#059669',
  margin_drop      : '#DC2626',
  volume_no_margin : '#D97706',
  new_margin_source: '#2563EB',
  normal           : '#9CA3AF',
};
const PRIORITY_LABELS = {
  drop     : '🚨 Wajib Diselamatkan',
  growth   : '📈 Wajib Dihubungi',
  optimize : '⚡ Wajib Dioptimasi',
  testimony: '⭐ Wajib Testimoni',
};
const PRIORITY_COLORS = { drop: '#DC2626', growth: '#059669', optimize: '#D97706', testimony: '#7C3AED' };

function getSuggestedAction(segment, devTrx, devMargin) {
  if (Number(devTrx) < 0 && Math.abs(Number(devTrx)) > 10)
    return 'Call merchant, cek kendala operasional / kompetitor';
  if (Number(devTrx) > 0 && Number(devMargin) > 0)
    return 'Follow up, upsell, minta testimoni';
  return SEGMENT_ACTIONS[segment] || 'Monitor';
}

function exportCSV(rows, filename) {
  if (!rows?.length) return;
  const keys = Object.keys(rows[0]);
  const bom = '﻿';
  const csv = [
    keys.join(','),
    ...rows.map(r => keys.map(k => {
      const v = r[k] == null ? '' : String(r[k]);
      return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(','))
  ].join('\n');
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function buildInsights(data) {
  if (!data?.summary) return [];
  const s = data.summary;
  const insights = [];
  const topG = data.top20_dm_pos?.[0];
  if (topG) insights.push({ type: 'pos', text: `Growth terbesar: ${topG.id_outlet} dengan DEV Margin ${fmtRp(topG.dev_margin)}` });
  const topD = data.top20_dm_neg?.[0];
  if (topD) insights.push({ type: 'neg', text: `Penurunan terbesar: ${topD.id_outlet} — DEV Margin ${fmtRp(topD.dev_margin)}` });
  const topM = data.top10_margin?.[0];
  if (topM) {
    const pct = ((Number(topM.margin_jun) / Math.max(s.total_margin_jun, 1)) * 100).toFixed(1);
    insights.push({ type: 'info', text: `${topM.id_outlet} menyumbang ${pct}% total margin bulan ini` });
  }
  if (s.outlet_churn > 100) insights.push({ type: 'warn', text: `⚠ ${fmtNum(s.outlet_churn)} outlet churn — butuh investigasi segera` });
  if (s.outlet_new_active > 0) insights.push({ type: 'pos', text: `${fmtNum(s.outlet_new_active)} outlet baru/reaktivasi berkontribusi aktif di bulan ini` });
  return insights;
}

/* ═══════════════════════════════════════
   CHART COMPONENTS
═══════════════════════════════════════ */
function HBarChart({ id, labels, values, colors, height = 220, formatter }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);
  useEffect(() => {
    if (!canvasRef.current || !labels?.length) return;
    chartRef.current?.destroy();
    const ctx = canvasRef.current.getContext('2d');
    const bgColors = Array.isArray(colors) ? colors : Array(labels.length).fill(colors || '#F97316');
    chartRef.current = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: bgColors, borderRadius: 4, borderSkipped: false }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => formatter ? formatter(ctx.raw) : fmtNum(ctx.raw) } } },
        scales: {
          x: { grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { font: { size: 9 }, callback: v => formatter ? formatter(v) : fmtNum(v) } },
          y: { grid: { display: false }, ticks: { font: { size: 9 }, maxRotation: 0 } },
        },
      },
    });
    return () => chartRef.current?.destroy();
  }, [id]);
  if (!labels?.length) return <div className="wr-no-data-sm">Belum ada data</div>;
  return <div style={{ height }}><canvas ref={canvasRef} /></div>;
}

function VGroupedBar({ id, labels, datasets, height = 200, yFormatter }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);
  useEffect(() => {
    if (!canvasRef.current || !labels?.length) return;
    chartRef.current?.destroy();
    const ctx = canvasRef.current.getContext('2d');
    chartRef.current = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 } } } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 9 }, maxRotation: 45 } },
          y: { grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { font: { size: 9 }, callback: v => yFormatter ? yFormatter(v) : fmtNum(v) } },
        },
      },
    });
    return () => chartRef.current?.destroy();
  }, [id]);
  if (!labels?.length) return <div className="wr-no-data-sm">Belum ada data</div>;
  return <div style={{ height }}><canvas ref={canvasRef} /></div>;
}

function DonutChart({ id, labels, values, colors, height = 220 }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);
  useEffect(() => {
    if (!canvasRef.current || !labels?.length) return;
    chartRef.current?.destroy();
    const ctx = canvasRef.current.getContext('2d');
    chartRef.current = new Chart(ctx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#fff', hoverOffset: 6 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        cutout: '65%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 10, font: { size: 10 }, padding: 8 } },
          tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmtNum(ctx.raw)}` } },
        },
      },
    });
    return () => chartRef.current?.destroy();
  }, [id]);
  if (!labels?.length) return <div className="wr-no-data-sm">Belum ada data</div>;
  return <div style={{ height }}><canvas ref={canvasRef} /></div>;
}

function ScatterPlot({ id, datasets, height = 280 }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);
  useEffect(() => {
    if (!canvasRef.current || !datasets?.length) return;
    chartRef.current?.destroy();
    const ctx = canvasRef.current.getContext('2d');
    chartRef.current = new Chart(ctx, {
      type: 'scatter',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 8, font: { size: 9 }, padding: 6 } },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.raw.id || ''} · TRX: ${fmtNum(ctx.raw.x)} · Margin: ${fmtRp(ctx.raw.y)}`,
            },
          },
        },
        scales: {
          x: { title: { display: true, text: 'TRX Juni', font: { size: 10 } }, ticks: { font: { size: 9 }, callback: v => fmtNum(v) }, grid: { color: 'rgba(0,0,0,0.04)' } },
          y: { title: { display: true, text: 'Margin Juni', font: { size: 10 } }, ticks: { font: { size: 9 }, callback: v => fmtRp(v) }, grid: { color: 'rgba(0,0,0,0.04)' } },
        },
      },
    });
    return () => chartRef.current?.destroy();
  }, [id]);
  if (!datasets?.length) return <div className="wr-no-data-sm">Belum ada data</div>;
  return <div style={{ height }}><canvas ref={canvasRef} /></div>;
}

/* ═══════════════════════════════════════
   SHARED UI COMPONENTS
═══════════════════════════════════════ */
function KPICard({ label, value, sub, color = '#F97316', borderColor, icon }) {
  return (
    <div className="wrd-kpi-card" style={{ borderTop: `3px solid ${borderColor || color}` }}>
      {icon && <div className="wrd-kpi-icon" style={{ color }}>{icon}</div>}
      <div className="wrd-kpi-label">{label}</div>
      <div className="wrd-kpi-value" style={{ color }}>{value}</div>
      {sub && <div className="wrd-kpi-sub">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, sub, children, action }) {
  return (
    <div className="wrd-chart-card">
      <div className="wrd-chart-head">
        <div>
          <div className="wrd-chart-title">{title}</div>
          {sub && <div className="wrd-chart-sub">{sub}</div>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function InsightBox({ insights }) {
  if (!insights?.length) return null;
  const bg = { pos: '#F0FDF4', neg: '#FFF1F2', warn: '#FFFBEB', info: '#EFF6FF' };
  const border = { pos: '#BBF7D0', neg: '#FECDD3', warn: '#FDE68A', info: '#BFDBFE' };
  const textColor = { pos: '#065F46', neg: '#881337', warn: '#78350F', info: '#1E3A8A' };
  return (
    <div className="wrd-insight-grid">
      {insights.map((ins, i) => (
        <div key={i} className="wrd-insight-item" style={{ background: bg[ins.type] || bg.info, borderLeft: `3px solid ${border[ins.type] || border.info}` }}>
          <span style={{ color: textColor[ins.type] || textColor.info, fontSize: 12 }}>{ins.text}</span>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }) {
  const labels = { ...STATUS_LABELS, ...MARGIN_STATUS_LABELS };
  const colors = { ...STATUS_COLORS, ...MARGIN_STATUS_COLORS };
  return (
    <span className="wrd-badge" style={{ background: (colors[status] || '#9CA3AF') + '22', color: colors[status] || '#9CA3AF', border: `1px solid ${(colors[status] || '#9CA3AF')}44` }}>
      {labels[status] || status}
    </span>
  );
}

function SegmentBadge({ segment }) {
  const c = SEGMENT_COLORS[segment] || '#9CA3AF';
  return (
    <span className="wrd-badge" style={{ background: c + '22', color: c, border: `1px solid ${c}44` }}>
      {SEGMENT_LABELS[segment] || segment}
    </span>
  );
}

function DevCell({ value, isRp = false }) {
  const v = Number(value) || 0;
  const c = v > 0 ? '#059669' : v < 0 ? '#DC2626' : '#9CA3AF';
  return <span style={{ color: c, fontWeight: 600 }}>{v > 0 ? '+' : ''}{isRp ? fmtRp(v) : fmtNum(v)}</span>;
}

function SectionTitle({ title, sub }) {
  return (
    <div className="wrd-section-head">
      <div className="wrd-section-title">{title}</div>
      {sub && <div className="wrd-section-sub">{sub}</div>}
    </div>
  );
}

/* ═══════════════════════════════════════
   TAB 1: EXECUTIVE SUMMARY
═══════════════════════════════════════ */
function ExecutiveSummaryTab({ data, tanggal }) {
  const s = data.summary || {};
  const insights = useMemo(() => buildInsights(data), [data]);
  const devTrxPct  = fmtPct(s.dev_trx, s.total_trx_mei);
  const devMrgPct  = fmtPct(s.dev_margin, s.total_margin_mei);
  const devTrxSign = Number(s.dev_trx) >= 0 ? 'pos' : 'neg';
  const devMrgSign = Number(s.dev_margin) >= 0 ? 'pos' : 'neg';

  const top10TrxLabels   = (data.top10_trx    || []).map(r => r.id_outlet);
  const top10TrxVals     = (data.top10_trx    || []).map(r => Number(r.trx_jun));
  const top10MrgLabels   = (data.top10_margin || []).map(r => r.id_outlet);
  const top10MrgVals     = (data.top10_margin || []).map(r => Number(r.margin_jun));

  const cmpLabels  = ['Mei', 'Juni'];
  const cmpTrxData = [{ label: 'TRX', data: [Number(s.total_trx_mei), Number(s.total_trx_jun)], backgroundColor: ['#93C5FD', '#3B82F6'], borderRadius: 4 }];
  const cmpMrgData = [{ label: 'Margin', data: [Number(s.total_margin_mei), Number(s.total_margin_jun)], backgroundColor: ['#6EE7B7', '#059669'], borderRadius: 4 }];

  return (
    <div className="wrd-tab-content">
      <SectionTitle title="Executive Summary" sub={`Performa utama Speedcash · Data ${tanggal}`} />

      {/* KPI Grid */}
      <div className="wrd-kpi-grid wrd-kpi-grid-4">
        <KPICard label="Total Outlet Aktif Juni"  value={fmtNum(s.total_aktif_jun)} color="#F97316" />
        <KPICard label="Total TRX Juni"            value={fmtNum(s.total_trx_jun)}   color="#F97316"
          sub={<span style={{ color: devTrxSign === 'pos' ? '#059669' : '#DC2626', fontSize: 11 }}>
            {fmtSign(s.dev_trx)} vs Mei ({devTrxPct})
          </span>} />
        <KPICard label="Total Margin Juni"         value={fmtRp(s.total_margin_jun)} color="#059669"
          sub={<span style={{ color: devMrgSign === 'pos' ? '#059669' : '#DC2626', fontSize: 11 }}>
            {fmtSignRp(s.dev_margin)} vs Mei ({devMrgPct})
          </span>} />
        <KPICard label="New Active Outlet"         value={fmtNum(s.outlet_new_active)} color="#2563EB" />
        <KPICard label="Outlet Baru (< 1 bln)"     value={fmtNum(s.outlet_baru)}       color="#7C3AED" />
        <KPICard label="Outlet Drop / Churn"       value={fmtNum(s.outlet_churn)}      color="#DC2626" />
        <KPICard label="Outlet Growing"            value={fmtNum(s.outlet_growing)}    color="#059669" />
        <KPICard label="Outlet Declining"          value={fmtNum(s.outlet_declining)}  color="#D97706" />
      </div>

      {/* Insights */}
      <InsightBox insights={insights} />

      {/* Charts row 1: TRX Mei vs Juni + Margin Mei vs Juni */}
      <div className="wrd-charts-row">
        <ChartCard title="TRX Mei vs Juni" sub="Total transaksi perbandingan">
          <VGroupedBar id={`cmp-trx-${tanggal}`} labels={cmpLabels} datasets={cmpTrxData} height={180}
            yFormatter={v => fmtNum(v)} />
        </ChartCard>
        <ChartCard title="Margin Mei vs Juni" sub="Total margin perbandingan">
          <VGroupedBar id={`cmp-mrg-${tanggal}`} labels={cmpLabels} datasets={cmpMrgData} height={180}
            yFormatter={v => fmtRp(v)} />
        </ChartCard>
      </div>

      {/* Charts row 2: Top 10 by TRX + Top 10 by Margin */}
      <div className="wrd-charts-row">
        <ChartCard title="Top 10 Outlet by TRX Juni">
          <HBarChart id={`top-trx-${tanggal}`} labels={top10TrxLabels} values={top10TrxVals}
            colors="#F97316" height={230} formatter={fmtNum} />
        </ChartCard>
        <ChartCard title="Top 10 Outlet by Margin Juni">
          <HBarChart id={`top-mrg-${tanggal}`} labels={top10MrgLabels} values={top10MrgVals}
            colors="#059669" height={230} formatter={fmtRp} />
        </ChartCard>
      </div>

      {/* Detail table: top 10 */}
      <ChartCard title="Detail Top 10 Outlet by Margin Juni">
        <div className="wr-table-wrap">
          <table className="wr-table">
            <thead>
              <tr>
                <th>#</th><th>ID Outlet</th><th>Nama</th><th>No HP</th><th>Tgl Reg</th>
                <th style={{ textAlign: 'right' }}>TRX Mei</th>
                <th style={{ textAlign: 'right' }}>TRX Jun</th>
                <th style={{ textAlign: 'right' }}>Margin Jun</th>
                <th style={{ textAlign: 'right' }}>DEV TRX</th>
                <th style={{ textAlign: 'right' }}>DEV Margin</th>
              </tr>
            </thead>
            <tbody>
              {(data.top10_margin || []).map((r, i) => (
                <tr key={r.id_outlet}>
                  <td style={{ color: 'var(--text-4)' }}>{i + 1}</td>
                  <td><b>{r.id_outlet}</b></td>
                  <td style={{ fontSize: 12, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nama || '–'}</td>
                  <td><NoHpLink no_hp={r.no_hp} /></td>
                  <td style={{ color: 'var(--text-3)' }}>{fmtDate(r.tgl_reg)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNum(r.trx_mei)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNum(r.trx_jun)}</td>
                  <td style={{ textAlign: 'right', color: '#059669', fontWeight: 700 }}>{fmtRp(r.margin_jun)}</td>
                  <td style={{ textAlign: 'right' }}><DevCell value={r.dev_trx} /></td>
                  <td style={{ textAlign: 'right' }}><DevCell value={r.dev_margin} isRp /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  );
}

/* ═══════════════════════════════════════
   TAB 2: GROWTH & CHURN
═══════════════════════════════════════ */
function GrowthChurnTab({ data, tanggal }) {
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const s = data.summary || {};
  const gc = data.growth_counts || {};

  const donutLabels = ['Growing', 'Declining', 'New Active', 'Churn', 'Stable'];
  const donutValues = [gc.growing || 0, gc.declining || 0, gc.new_active || 0, gc.churned || 0, gc.stable || 0];
  const donutColors = ['#059669', '#DC2626', '#2563EB', '#9F1239', '#9CA3AF'];

  const dtPosLabels = (data.top20_dt_pos || []).map(r => r.id_outlet);
  const dtPosVals   = (data.top20_dt_pos || []).map(r => Number(r.dev_trx));
  const dtNegLabels = (data.top20_dt_neg || []).map(r => r.id_outlet);
  const dtNegVals   = (data.top20_dt_neg || []).map(r => Math.abs(Number(r.dev_trx)));
  const dmPosLabels = (data.top20_dm_pos || []).map(r => r.id_outlet);
  const dmPosVals   = (data.top20_dm_pos || []).map(r => Number(r.dev_margin));
  const dmNegLabels = (data.top20_dm_neg || []).map(r => r.id_outlet);
  const dmNegVals   = (data.top20_dm_neg || []).map(r => Math.abs(Number(r.dev_margin)));

  const filteredRows = useMemo(() => {
    let rows = data.growth_table || [];
    if (statusFilter !== 'all') rows = rows.filter(r => r.growth_status === statusFilter);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r => r.id_outlet?.toLowerCase().includes(q) || r.nama?.toLowerCase().includes(q));
    }
    return rows;
  }, [data.growth_table, statusFilter, search]);

  return (
    <div className="wrd-tab-content">
      <SectionTitle title="Growth & Churn Analysis" sub="Segmentasi outlet berdasarkan performa TRX bulan ini" />

      <div className="wrd-kpi-grid wrd-kpi-grid-3">
        <KPICard label="Growing Outlet"      value={fmtNum(s.outlet_growing)}   color="#059669" />
        <KPICard label="Declining Outlet"    value={fmtNum(s.outlet_declining)} color="#DC2626" />
        <KPICard label="New / Reactivated"   value={fmtNum(s.outlet_new_active)} color="#2563EB" />
        <KPICard label="Churn / Drop"        value={fmtNum(s.outlet_churn)}     color="#9F1239" />
        <KPICard label="Net Growth TRX"      value={fmtSign(s.dev_trx)}
          color={Number(s.dev_trx) >= 0 ? '#059669' : '#DC2626'} />
        <KPICard label="Net Growth Margin"   value={fmtSignRp(s.dev_margin)}
          color={Number(s.dev_margin) >= 0 ? '#059669' : '#DC2626'} />
      </div>

      {/* Donut */}
      <div className="wrd-charts-row">
        <ChartCard title="Distribusi Status Outlet" sub="Semua outlet bulan ini">
          <DonutChart id={`donut-gc-${tanggal}`} labels={donutLabels} values={donutValues} colors={donutColors} height={220} />
        </ChartCard>
        <ChartCard title="Top 20 DEV TRX Positif" sub="Outlet pertumbuhan TRX terbesar">
          <HBarChart id={`dt-pos-${tanggal}`} labels={dtPosLabels} values={dtPosVals} colors="#059669" height={230} formatter={fmtNum} />
        </ChartCard>
      </div>

      <div className="wrd-charts-row">
        <ChartCard title="Top 20 DEV TRX Negatif" sub="Outlet penurunan TRX terbesar">
          <HBarChart id={`dt-neg-${tanggal}`} labels={dtNegLabels} values={dtNegVals} colors="#DC2626" height={230} formatter={fmtNum} />
        </ChartCard>
        <ChartCard title="Top 20 DEV Margin Positif">
          <HBarChart id={`dm-pos-${tanggal}`} labels={dmPosLabels} values={dmPosVals} colors="#059669" height={230} formatter={fmtRp} />
        </ChartCard>
      </div>

      <ChartCard title="Top 20 DEV Margin Negatif">
        <HBarChart id={`dm-neg-${tanggal}`} labels={dmNegLabels} values={dmNegVals} colors="#DC2626" height={230} formatter={fmtRp} />
      </ChartCard>

      {/* Table */}
      <ChartCard title="Tabel Detail Growth & Churn"
        action={
          <button className="wrd-export-btn" onClick={() => exportCSV(filteredRows, `growth-churn-${tanggal}.csv`)}>
            <i className="ti ti-download" /> CSV
          </button>
        }>
        <div className="wrd-filter-row">
          <input className="wrd-search" placeholder="Cari ID Outlet / Nama…" value={search} onChange={e => setSearch(e.target.value)} />
          <div className="wr-filter-tabs">
            {['all', 'growing', 'declining', 'new_active', 'churned', 'stable'].map(f => (
              <button key={f} className={`wr-filter-tab${statusFilter === f ? ' active' : ''}`}
                onClick={() => setStatusFilter(f)} style={{ '--active-bg': STATUS_COLORS[f] || '#F97316' }}>
                {f === 'all' ? 'Semua' : STATUS_LABELS[f] || f}
              </button>
            ))}
          </div>
          <span className="wr-count">{filteredRows.length} outlet</span>
        </div>
        <div className="wr-table-wrap">
          <table className="wr-table">
            <thead>
              <tr>
                <th>#</th><th>ID Outlet</th><th>Nama</th><th>No HP</th><th>Tgl Reg</th>
                <th style={{ textAlign: 'right' }}>TRX Mei</th>
                <th style={{ textAlign: 'right' }}>TRX Juni</th>
                <th style={{ textAlign: 'right' }}>DEV TRX</th>
                <th style={{ textAlign: 'right' }}>Margin Mei</th>
                <th style={{ textAlign: 'right' }}>Margin Juni</th>
                <th style={{ textAlign: 'right' }}>DEV Margin</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.slice(0, 300).map((r, i) => (
                <tr key={r.id_outlet + i} className="wr-tr-clickable">
                  <td style={{ color: 'var(--text-4)' }}>{i + 1}</td>
                  <td><b>{r.id_outlet}</b></td>
                  <td style={{ fontSize: 12, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nama || '–'}</td>
                  <td><NoHpLink no_hp={r.no_hp} /></td>
                  <td style={{ color: 'var(--text-3)' }}>{fmtDate(r.tgl_reg)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNum(r.trx_mei)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNum(r.trx_jun)}</td>
                  <td style={{ textAlign: 'right' }}><DevCell value={r.dev_trx} /></td>
                  <td style={{ textAlign: 'right' }}>{fmtRp(r.margin_mei)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtRp(r.margin_jun)}</td>
                  <td style={{ textAlign: 'right' }}><DevCell value={r.dev_margin} isRp /></td>
                  <td><StatusBadge status={r.growth_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  );
}

/* ═══════════════════════════════════════
   TAB 3: MERCHANT SEGMENTATION
═══════════════════════════════════════ */
function MerchantSegmentTab({ data, tanggal }) {
  const [segFilter, setSegFilter] = useState('all');
  const [search, setSearch] = useState('');
  const sc = data.segment_counts || {};

  const scatterDatasets = useMemo(() => {
    const segs = ['superstar', 'rising_star', 'at_risk', 'high_trx_low_margin', 'low_trx_high_margin', 'low_value'];
    return segs.map(seg => ({
      label: SEGMENT_LABELS[seg],
      data : (data.scatter_data || []).filter(r => r.segment === seg).map(r => ({
        x: Number(r.trx_jun), y: Number(r.margin_jun), id: r.id_outlet,
      })),
      backgroundColor: SEGMENT_COLORS[seg] + 'CC',
      borderColor    : SEGMENT_COLORS[seg],
      borderWidth    : 1,
      pointRadius    : 3,
      pointHoverRadius: 5,
    })).filter(d => d.data.length > 0);
  }, [data.scatter_data]);

  const filteredRows = useMemo(() => {
    let rows = data.scatter_data || [];
    if (segFilter !== 'all') rows = rows.filter(r => r.segment === segFilter);
    if (search) rows = rows.filter(r => r.id_outlet?.toLowerCase().includes(search.toLowerCase()));
    return rows;
  }, [data.scatter_data, segFilter, search]);

  return (
    <div className="wrd-tab-content">
      <SectionTitle title="Merchant Segmentation" sub="Klasifikasi otomatis berdasarkan TRX & Margin Juni" />

      <div className="wrd-kpi-grid wrd-kpi-grid-3">
        <KPICard label="Superstar"           value={fmtNum(sc.superstar)}           color="#7C3AED" />
        <KPICard label="Rising Star"         value={fmtNum(sc.rising_star)}         color="#059669" />
        <KPICard label="At Risk"             value={fmtNum(sc.at_risk)}             color="#DC2626" />
        <KPICard label="High TRX Low Margin" value={fmtNum(sc.high_trx_low_margin)} color="#D97706" />
        <KPICard label="Low TRX High Margin" value={fmtNum(sc.low_trx_high_margin)} color="#2563EB" />
        <KPICard label="Low Value"           value={fmtNum(sc.low_value)}           color="#9CA3AF" />
      </div>

      <ChartCard title="Scatter Plot: TRX Juni vs Margin Juni"
        sub={`${(data.scatter_data || []).length} outlet aktif · warna = segmen`}>
        <ScatterPlot id={`scatter-seg-${tanggal}`} datasets={scatterDatasets} height={300} />
      </ChartCard>

      {/* Donut segment */}
      <div className="wrd-charts-row">
        <ChartCard title="Distribusi Segmen">
          <DonutChart
            id={`donut-seg-${tanggal}`}
            labels={Object.keys(sc).map(k => SEGMENT_LABELS[k] || k)}
            values={Object.values(sc)}
            colors={Object.keys(sc).map(k => SEGMENT_COLORS[k] || '#9CA3AF')}
            height={220}
          />
        </ChartCard>
        <ChartCard title="Panduan Segmentasi">
          <div className="wrd-seg-guide">
            {Object.entries(SEGMENT_LABELS).filter(([k]) => k !== 'inactive').map(([k, label]) => (
              <div key={k} className="wrd-seg-guide-row">
                <span className="wrd-seg-dot" style={{ background: SEGMENT_COLORS[k] }} />
                <div style={{ flex: 1 }}>
                  <b style={{ color: SEGMENT_COLORS[k] }}>{label}</b>
                  <span style={{ marginLeft: 8, color: 'var(--text-3)', fontSize: 11 }}>{SEGMENT_ACTIONS[k]}</span>
                </div>
                <span className="wrd-seg-count">{fmtNum(sc[k] || 0)}</span>
              </div>
            ))}
          </div>
        </ChartCard>
      </div>

      {/* Table */}
      <ChartCard title="Detail Segmentasi Outlet"
        action={
          <button className="wrd-export-btn" onClick={() => exportCSV(filteredRows.map(r => ({ ...r, suggested_action: SEGMENT_ACTIONS[r.segment] || '' })), `segmentasi-${tanggal}.csv`)}>
            <i className="ti ti-download" /> CSV
          </button>
        }>
        <div className="wrd-filter-row">
          <input className="wrd-search" placeholder="Cari ID Outlet…" value={search} onChange={e => setSearch(e.target.value)} />
          <div className="wr-filter-tabs">
            <button className={`wr-filter-tab${segFilter === 'all' ? ' active' : ''}`} onClick={() => setSegFilter('all')}>Semua</button>
            {['superstar','rising_star','at_risk','high_trx_low_margin','low_trx_high_margin','low_value'].map(seg => (
              <button key={seg} className={`wr-filter-tab${segFilter === seg ? ' active' : ''}`} onClick={() => setSegFilter(seg)}
                style={{ '--active-bg': SEGMENT_COLORS[seg] }}>
                {SEGMENT_LABELS[seg]}
              </button>
            ))}
          </div>
          <span className="wr-count">{filteredRows.length} outlet</span>
        </div>
        <div className="wr-table-wrap">
          <table className="wr-table">
            <thead>
              <tr>
                <th>#</th><th>ID Outlet</th>
                <th style={{ textAlign: 'right' }}>TRX Juni</th>
                <th style={{ textAlign: 'right' }}>Margin Juni</th>
                <th style={{ textAlign: 'right' }}>DEV TRX</th>
                <th style={{ textAlign: 'right' }}>DEV Margin</th>
                <th>Segmen</th>
                <th>Suggested Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.slice(0, 300).map((r, i) => (
                <tr key={r.id_outlet + i} className="wr-tr-clickable">
                  <td style={{ color: 'var(--text-4)' }}>{i + 1}</td>
                  <td><b>{r.id_outlet}</b></td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNum(r.trx_jun)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#059669' }}>{fmtRp(r.margin_jun)}</td>
                  <td style={{ textAlign: 'right' }}><DevCell value={r.dev_trx} /></td>
                  <td style={{ textAlign: 'right' }}><DevCell value={r.dev_margin} isRp /></td>
                  <td><SegmentBadge segment={r.segment} /></td>
                  <td style={{ fontSize: 11, color: 'var(--text-3)' }}>{SEGMENT_ACTIONS[r.segment] || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  );
}

/* ═══════════════════════════════════════
   TAB 4: MARGIN ANALYSIS
═══════════════════════════════════════ */
function MarginAnalysisTab({ data, tanggal }) {
  const [search, setSearch] = useState('');
  const s = data.summary || {};
  const avgMrgMei = s.total_trx_mei > 0 ? s.total_margin_mei / s.total_trx_mei : 0;
  const avgMrgJun = s.total_trx_jun > 0 ? s.total_margin_jun / s.total_trx_jun : 0;
  const mrgGrowthPct = fmtPct(s.dev_margin, s.total_margin_mei);

  const top20MrgLabels = (data.top20_margin_jun || []).map(r => r.id_outlet);
  const top20MrgVals   = (data.top20_margin_jun || []).map(r => Number(r.margin_jun));
  const dmPosLabels    = (data.top20_dev_margin || []).map(r => r.id_outlet);
  const dmPosVals      = (data.top20_dev_margin || []).map(r => Number(r.dev_margin));
  const dmNegLabels    = (data.bot20_dev_margin || []).map(r => r.id_outlet);
  const dmNegVals      = (data.bot20_dev_margin || []).map(r => Math.abs(Number(r.dev_margin)));

  const scatterRows = useMemo(() => {
    const rows = [...(data.top20_margin_jun || []), ...(data.top20_dev_margin || [])];
    const seen = new Set();
    return rows.filter(r => { if (seen.has(r.id_outlet)) return false; seen.add(r.id_outlet); return true; });
  }, [data.top20_margin_jun, data.top20_dev_margin]);

  const trxVsAvgDatasets = useMemo(() => [{
    label: 'Outlet',
    data: scatterRows.map(r => ({ x: Number(r.trx_jun), y: Number(r.avg_margin_per_trx), id: r.id_outlet })),
    backgroundColor: '#F97316CC', borderColor: '#F97316', borderWidth: 1, pointRadius: 4,
  }], [scatterRows]);

  const filteredRows = useMemo(() => {
    let rows = [...(data.top20_margin_jun || []), ...(data.top20_dev_margin || []), ...(data.bot20_dev_margin || [])];
    const seen = new Set();
    rows = rows.filter(r => { if (seen.has(r.id_outlet)) return false; seen.add(r.id_outlet); return true; });
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r => r.id_outlet?.toLowerCase().includes(q) || r.nama?.toLowerCase().includes(q));
    }
    return rows;
  }, [data, search]);

  return (
    <div className="wrd-tab-content">
      <SectionTitle title="Margin Analysis" sub="Fokus pada revenue & margin per outlet" />

      <div className="wrd-kpi-grid wrd-kpi-grid-3">
        <KPICard label="Total Margin Mei"      value={fmtRp(s.total_margin_mei)}  color="#6B7280" />
        <KPICard label="Total Margin Juni"     value={fmtRp(s.total_margin_jun)}  color="#059669" />
        <KPICard label="DEV Margin"            value={fmtSignRp(s.dev_margin)}
          color={Number(s.dev_margin) >= 0 ? '#059669' : '#DC2626'} />
        <KPICard label="Margin Growth %"       value={mrgGrowthPct}
          color={String(mrgGrowthPct).startsWith('-') ? '#DC2626' : '#059669'} />
        <KPICard label="Avg Margin/TRX Mei"   value={fmtRp(avgMrgMei)}           color="#6B7280" />
        <KPICard label="Avg Margin/TRX Juni"  value={fmtRp(avgMrgJun)}           color="#059669" />
      </div>

      <div className="wrd-charts-row">
        <ChartCard title="Top 20 Outlet by Margin Juni">
          <HBarChart id={`mrg-top-${tanggal}`} labels={top20MrgLabels} values={top20MrgVals} colors="#059669" height={260} formatter={fmtRp} />
        </ChartCard>
        <ChartCard title="Top 20 DEV Margin Positif">
          <HBarChart id={`dm-p-${tanggal}`} labels={dmPosLabels} values={dmPosVals} colors="#059669" height={260} formatter={fmtRp} />
        </ChartCard>
      </div>

      <div className="wrd-charts-row">
        <ChartCard title="Bottom 20 DEV Margin Negatif">
          <HBarChart id={`dm-n-${tanggal}`} labels={dmNegLabels} values={dmNegVals} colors="#DC2626" height={260} formatter={fmtRp} />
        </ChartCard>
        <ChartCard title="Scatter: TRX Juni vs Avg Margin/TRX" sub="Top outlet by margin">
          <ScatterPlot id={`scatter-mrg-${tanggal}`} datasets={trxVsAvgDatasets} height={260} />
        </ChartCard>
      </div>

      <ChartCard title="Detail Margin Analysis"
        action={
          <button className="wrd-export-btn" onClick={() => exportCSV(filteredRows, `margin-analysis-${tanggal}.csv`)}>
            <i className="ti ti-download" /> CSV
          </button>
        }>
        <div className="wrd-filter-row">
          <input className="wrd-search" placeholder="Cari ID Outlet / Nama…" value={search} onChange={e => setSearch(e.target.value)} />
          <span className="wr-count">{filteredRows.length} outlet</span>
        </div>
        <div className="wr-table-wrap">
          <table className="wr-table">
            <thead>
              <tr>
                <th>#</th><th>ID Outlet</th><th>Nama</th><th>No HP</th>
                <th style={{ textAlign: 'right' }}>TRX Juni</th>
                <th style={{ textAlign: 'right' }}>Margin Juni</th>
                <th style={{ textAlign: 'right' }}>Avg Margin/TRX</th>
                <th style={{ textAlign: 'right' }}>DEV Margin</th>
                <th>Margin Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.slice(0, 200).map((r, i) => (
                <tr key={r.id_outlet + i} className="wr-tr-clickable">
                  <td style={{ color: 'var(--text-4)' }}>{i + 1}</td>
                  <td><b>{r.id_outlet}</b></td>
                  <td style={{ fontSize: 12, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nama || '–'}</td>
                  <td><NoHpLink no_hp={r.no_hp} /></td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNum(r.trx_jun)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#059669' }}>{fmtRp(r.margin_jun)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtRp(r.avg_margin_per_trx)}</td>
                  <td style={{ textAlign: 'right' }}><DevCell value={r.dev_margin} isRp /></td>
                  <td><StatusBadge status={r.margin_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  );
}

/* ═══════════════════════════════════════
   TAB 5: COHORT ANALYSIS
═══════════════════════════════════════ */
function CohortAnalysisTab({ data, tanggal }) {
  const cohortYear  = data.cohort_year  || [];
  const cohortMonth = data.cohort_month || [];

  const yearLabels  = cohortYear.map(r => String(r.tahun_reg));
  const yearTrxData = [{
    label: 'TRX Jun', data: cohortYear.map(r => Number(r.total_trx_jun)),
    backgroundColor: '#3B82F6', borderRadius: 4,
  }, {
    label: 'TRX Mei', data: cohortYear.map(r => Number(r.total_trx_mei)),
    backgroundColor: '#93C5FD', borderRadius: 4,
  }];
  const yearMrgData = [{
    label: 'Margin Jun', data: cohortYear.map(r => Number(r.total_margin_jun)),
    backgroundColor: '#059669', borderRadius: 4,
  }, {
    label: 'Margin Mei', data: cohortYear.map(r => Number(r.total_margin_mei)),
    backgroundColor: '#6EE7B7', borderRadius: 4,
  }];

  const maxTrx    = Math.max(...cohortMonth.map(r => Number(r.total_trx_jun)), 1);
  const maxMargin = Math.max(...cohortMonth.map(r => Number(r.total_margin_jun)), 1);

  function heatColor(value, max, hue = 147) {
    const pct = Math.min(value / max, 1);
    return pct === 0 ? '#F3F4F6' : `hsl(${hue},${Math.round(50 + pct * 40)}%,${Math.round(90 - pct * 45)}%)`;
  }

  return (
    <div className="wrd-tab-content">
      <SectionTitle title="Cohort Analysis" sub="Kontribusi outlet berdasarkan tahun/bulan registrasi" />

      {/* Year table */}
      <ChartCard title="Ringkasan per Tahun Registrasi" sub="Outlet yang masih aktif di bulan ini">
        <div className="wr-table-wrap">
          <table className="wr-table">
            <thead>
              <tr>
                <th>Tahun Reg</th>
                <th style={{ textAlign: 'right' }}>Jml Outlet</th>
                <th style={{ textAlign: 'right' }}>Total TRX Jun</th>
                <th style={{ textAlign: 'right' }}>Total Margin Jun</th>
                <th style={{ textAlign: 'right' }}>Avg TRX/Outlet</th>
                <th style={{ textAlign: 'right' }}>Avg Margin/Outlet</th>
                <th style={{ textAlign: 'right' }}>Growth TRX</th>
                <th style={{ textAlign: 'right' }}>Growth Margin</th>
              </tr>
            </thead>
            <tbody>
              {cohortYear.map(r => {
                const devTrx = Number(r.total_trx_jun) - Number(r.total_trx_mei);
                const devMrg = Number(r.total_margin_jun) - Number(r.total_margin_mei);
                return (
                  <tr key={r.tahun_reg}>
                    <td><b>{r.tahun_reg || 'Tidak diketahui'}</b></td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(r.total_outlet)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNum(r.total_trx_jun)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#059669' }}>{fmtRp(r.total_margin_jun)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(r.avg_trx_jun)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtRp(r.avg_margin_jun)}</td>
                    <td style={{ textAlign: 'right' }}><DevCell value={devTrx} /></td>
                    <td style={{ textAlign: 'right' }}><DevCell value={devMrg} isRp /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <div className="wrd-charts-row">
        <ChartCard title="Total TRX Juni per Tahun Registrasi">
          <VGroupedBar id={`cohort-trx-${tanggal}`} labels={yearLabels} datasets={yearTrxData} height={220} yFormatter={fmtNum} />
        </ChartCard>
        <ChartCard title="Total Margin Juni per Tahun Registrasi">
          <VGroupedBar id={`cohort-mrg-${tanggal}`} labels={yearLabels} datasets={yearMrgData} height={220} yFormatter={fmtRp} />
        </ChartCard>
      </div>

      {/* Heatmap by month */}
      {cohortMonth.length > 0 && (
        <ChartCard title="Heatmap TRX per Bulan Registrasi" sub="Intensitas warna = TRX Juni (gelap = tinggi)">
          <div className="wr-table-wrap">
            <table className="wrd-cohort-table">
              <thead>
                <tr>
                  <th>Bulan Reg</th>
                  <th style={{ textAlign: 'right' }}>Outlet</th>
                  <th style={{ textAlign: 'right' }}>TRX Jun</th>
                  <th style={{ textAlign: 'right' }}>TRX Mei</th>
                  <th style={{ textAlign: 'right' }}>Margin Jun</th>
                  <th style={{ textAlign: 'right' }}>Margin Mei</th>
                  <th style={{ textAlign: 'right' }}>DEV TRX</th>
                  <th style={{ textAlign: 'right' }}>DEV Margin</th>
                </tr>
              </thead>
              <tbody>
                {cohortMonth.map(r => {
                  const devT = Number(r.total_trx_jun) - Number(r.total_trx_mei);
                  const devM = Number(r.total_margin_jun) - Number(r.total_margin_mei);
                  return (
                    <tr key={`${r.tahun_reg}-${r.bulan_reg}`}>
                      <td><b>{r.label}</b></td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(r.total_outlet)}</td>
                      <td style={{ textAlign: 'right', background: heatColor(Number(r.total_trx_jun), maxTrx, 217), fontWeight: 700 }}>
                        {fmtNum(r.total_trx_jun)}
                      </td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(r.total_trx_mei)}</td>
                      <td style={{ textAlign: 'right', background: heatColor(Number(r.total_margin_jun), maxMargin, 147), fontWeight: 700 }}>
                        {fmtRp(r.total_margin_jun)}
                      </td>
                      <td style={{ textAlign: 'right' }}>{fmtRp(r.total_margin_mei)}</td>
                      <td style={{ textAlign: 'right' }}><DevCell value={devT} /></td>
                      <td style={{ textAlign: 'right' }}><DevCell value={devM} isRp /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ChartCard>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════
   TAB 6: ACTION CENTER
═══════════════════════════════════════ */
function ActionCenterTab({ data, tanggal }) {
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [segFilter, setSegFilter] = useState('all');
  const [sort, setSort] = useState('dev_margin');
  const [search, setSearch] = useState('');

  const allActions = useMemo(() => {
    const drop     = (data.action_drop      || []).map(r => ({ ...r, priority: 'drop'     }));
    const growth   = (data.action_growth    || []).map(r => ({ ...r, priority: 'growth'   }));
    const highTrx  = (data.action_high_trx  || []).map(r => ({ ...r, priority: 'optimize' }));
    const rising   = (data.action_rising    || []).map(r => ({ ...r, priority: 'testimony'}));
    const seen = new Set();
    return [...drop, ...growth, ...highTrx, ...rising].filter(r => {
      if (seen.has(r.id_outlet)) return false;
      seen.add(r.id_outlet);
      return true;
    });
  }, [data]);

  const filtered = useMemo(() => {
    let rows = allActions;
    if (priorityFilter !== 'all') rows = rows.filter(r => r.priority === priorityFilter);
    if (segFilter !== 'all') rows = rows.filter(r => r.segment === segFilter);
    if (search) rows = rows.filter(r => r.id_outlet?.toLowerCase().includes(search.toLowerCase()));
    return [...rows].sort((a, b) => {
      if (sort === 'dev_trx') return Number(a.dev_trx) - Number(b.dev_trx);
      return Number(a.dev_margin) - Number(b.dev_margin);
    });
  }, [allActions, priorityFilter, segFilter, sort, search]);

  const counts = useMemo(() => ({
    drop     : allActions.filter(r => r.priority === 'drop').length,
    growth   : allActions.filter(r => r.priority === 'growth').length,
    optimize : allActions.filter(r => r.priority === 'optimize').length,
    testimony: allActions.filter(r => r.priority === 'testimony').length,
  }), [allActions]);

  function getActionText(r) {
    if (r.priority === 'drop') return 'Call merchant, cek kendala operasional / kompetitor';
    if (r.priority === 'growth') return 'Follow up, upsell, minta testimoni';
    if (r.priority === 'optimize') return 'Review pricing / skema MDR';
    if (r.priority === 'testimony') return r.is_outlet_baru ? 'Jaga momentum aktivasi, minta testimoni' : 'Scale aktivitas, jadikan referral';
    return SEGMENT_ACTIONS[r.segment] || '–';
  }

  function getProblemText(r) {
    if (r.priority === 'drop') return `TRX turun ${fmtSign(r.dev_trx)}, Margin ${fmtSignRp(r.dev_margin)}`;
    if (r.priority === 'growth') return `TRX naik ${fmtSign(r.dev_trx)}, Growth margin ${fmtSignRp(r.dev_margin)}`;
    if (r.priority === 'optimize') return `TRX tinggi tapi margin rendah`;
    if (r.priority === 'testimony') return `Outlet baru/reaktivasi dengan growth besar`;
    return '–';
  }

  return (
    <div className="wrd-tab-content">
      <SectionTitle title="Action Center" sub="Daftar prioritas outlet yang perlu ditindaklanjuti hari ini" />

      {/* Priority summary cards */}
      <div className="wrd-kpi-grid wrd-kpi-grid-4">
        {Object.entries(PRIORITY_LABELS).map(([p, label]) => (
          <div key={p} className="wrd-action-priority-card"
            style={{ borderLeft: `4px solid ${PRIORITY_COLORS[p]}`, cursor: 'pointer', background: priorityFilter === p ? PRIORITY_COLORS[p] + '11' : undefined }}
            onClick={() => setPriorityFilter(p === priorityFilter ? 'all' : p)}>
            <div className="wrd-kpi-label" style={{ color: PRIORITY_COLORS[p] }}>{label}</div>
            <div className="wrd-kpi-value" style={{ color: PRIORITY_COLORS[p] }}>{fmtNum(counts[p])}</div>
            <div className="wrd-kpi-sub" style={{ fontSize: 11, color: 'var(--text-4)' }}>outlet</div>
          </div>
        ))}
      </div>

      {/* Action table */}
      <ChartCard title="Action Table"
        action={
          <button className="wrd-export-btn" onClick={() => exportCSV(
            filtered.map(r => ({ priority: PRIORITY_LABELS[r.priority], id_outlet: r.id_outlet, segment: SEGMENT_LABELS[r.segment] || r.segment,
              problem: getProblemText(r), action: getActionText(r), trx_mei: r.trx_mei, trx_jun: r.trx_jun,
              dev_trx: r.dev_trx, margin_mei: r.margin_mei, margin_jun: r.margin_jun, dev_margin: r.dev_margin })),
            `action-center-${tanggal}.csv`)}>
            <i className="ti ti-download" /> CSV
          </button>
        }>
        <div className="wrd-filter-row">
          <input className="wrd-search" placeholder="Cari ID Outlet…" value={search} onChange={e => setSearch(e.target.value)} />
          <div className="wr-filter-tabs">
            <button className={`wr-filter-tab${priorityFilter === 'all' ? ' active' : ''}`} onClick={() => setPriorityFilter('all')}>Semua</button>
            {Object.entries(PRIORITY_LABELS).map(([p, label]) => (
              <button key={p} className={`wr-filter-tab${priorityFilter === p ? ' active' : ''}`}
                onClick={() => setPriorityFilter(p)} style={{ '--active-bg': PRIORITY_COLORS[p] }}>
                {label.split(' ').slice(1).join(' ')}
              </button>
            ))}
          </div>
          <select className="wr-select" value={sort} onChange={e => setSort(e.target.value)}>
            <option value="dev_margin">Sort: DEV Margin ↑ (terburuk)</option>
            <option value="dev_trx">Sort: DEV TRX ↑ (terburuk)</option>
          </select>
          <span className="wr-count">{filtered.length} outlet</span>
        </div>
        <div className="wr-table-wrap">
          <table className="wr-table">
            <thead>
              <tr>
                <th>Prioritas</th>
                <th>ID Outlet</th>
                <th>Nama</th>
                <th>No HP</th>
                <th>Segmen</th>
                <th>Problem / Opportunity</th>
                <th>Suggested Action</th>
                <th style={{ textAlign: 'right' }}>TRX Mei</th>
                <th style={{ textAlign: 'right' }}>TRX Juni</th>
                <th style={{ textAlign: 'right' }}>DEV TRX</th>
                <th style={{ textAlign: 'right' }}>Margin Mei</th>
                <th style={{ textAlign: 'right' }}>Margin Juni</th>
                <th style={{ textAlign: 'right' }}>DEV Margin</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.id_outlet + i} className="wr-tr-clickable">
                  <td>
                    <span className="wrd-badge" style={{ background: PRIORITY_COLORS[r.priority] + '22', color: PRIORITY_COLORS[r.priority], border: `1px solid ${PRIORITY_COLORS[r.priority]}44`, whiteSpace: 'nowrap' }}>
                      {PRIORITY_LABELS[r.priority]}
                    </span>
                  </td>
                  <td><b>{r.id_outlet}</b>{r.is_outlet_baru && <span className="pill-baru" style={{ marginLeft: 4 }}>BARU</span>}</td>
                  <td style={{ fontSize: 12, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nama || '–'}</td>
                  <td><NoHpLink no_hp={r.no_hp} /></td>
                  <td><SegmentBadge segment={r.segment} /></td>
                  <td style={{ fontSize: 11, color: 'var(--text-2)', maxWidth: 180 }}>{getProblemText(r)}</td>
                  <td style={{ fontSize: 11, color: 'var(--text-2)', maxWidth: 220 }}>{getActionText(r)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNum(r.trx_mei)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNum(r.trx_jun)}</td>
                  <td style={{ textAlign: 'right' }}><DevCell value={r.dev_trx} /></td>
                  <td style={{ textAlign: 'right' }}>{fmtRp(r.margin_mei)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#059669' }}>{fmtRp(r.margin_jun)}</td>
                  <td style={{ textAlign: 'right' }}><DevCell value={r.dev_margin} isRp /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  );
}

/* ═══════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════ */
const TABS = [
  { key: 'executive', label: 'Executive Summary',      icon: 'ti-chart-bar' },
  { key: 'growth',    label: 'Growth & Churn',          icon: 'ti-trending-up' },
  { key: 'segment',   label: 'Merchant Segmentation',   icon: 'ti-layout-grid' },
  { key: 'margin',    label: 'Margin Analysis',         icon: 'ti-currency-dollar' },
  { key: 'cohort',    label: 'Cohort Analysis',         icon: 'ti-calendar-stats' },
  { key: 'action',    label: 'Action Center',           icon: 'ti-target' },
];

export default function WarRoomSpeedcash() {
  const [data,        setData]        = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [activeTab,   setActiveTab]   = useState('executive');
  const [tanggal,     setTanggal]     = useState('');
  const [tglList,     setTglList]     = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = tanggal ? { tanggal } : {};
      const [analyticsRes, tglRes] = await Promise.all([
        getSpeedcashAnalytics(params),
        tglList.length ? Promise.resolve({ list: tglList }) : getSpeedcashTanggalList(),
      ]);
      setData(analyticsRes);
      if (tglRes.list) setTglList(tglRes.list);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [tanggal]);

  useEffect(() => { fetchData(); }, [tanggal]);

  const displayTanggal = data?.tanggal ? String(data.tanggal).slice(0, 10) : '–';

  const Header = () => (
    <div className="wr-header">
      <div>
        <div className="wr-title-row">
          <span style={{ fontSize: 22, color: '#F97316' }}>⚡</span>
          <h1 className="wr-title" style={{ color: '#F97316' }}>WAR-ROOM SPEEDCASH</h1>
          <span className="war-badge-sc">LIVE</span>
        </div>
        <p className="wr-sub">
          Action Dashboard · Monitoring outlet Speedcash · Data s/d {displayTanggal}
          {lastUpdated && (
            <span style={{ marginLeft: 8, color: 'var(--text-4)' }}>
              · Refresh {lastUpdated.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </p>
      </div>
      <div className="wr-header-right">
        <select className="wr-select" value={tanggal} onChange={e => setTanggal(e.target.value)}>
          <option value="">Terkini</option>
          {tglList.map(t => <option key={t} value={String(t)}>{String(t).slice(0, 10)}</option>)}
        </select>
        <button className="wr-btn-update"
          style={{ background: loading ? '#f0a070' : '#F97316' }}
          onClick={fetchData} disabled={loading}>
          {loading
            ? <><i className="ti ti-loader-2" style={{ animation: 'aic-rotate 0.8s linear infinite' }} /> Memuat...</>
            : <><i className="ti ti-refresh" /> Refresh</>}
        </button>
      </div>
    </div>
  );

  if (loading && !data) {
    return (
      <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1MIpXkyU_COR_ptTvweKQKFYT0pxWIo_5zfCC90Gqlck" gsheetLabel="Speedcash">
        <div className="wr-page">
          <Header />
          <div className="wr-summary-grid">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="wr-summary-card wr-skeleton" style={{ height: 80 }} />
            ))}
          </div>
        </div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1MIpXkyU_COR_ptTvweKQKFYT0pxWIo_5zfCC90Gqlck" gsheetLabel="Speedcash">
        <div className="wr-page">
          <Header />
          <div className="wr-error">
            ⚠ {error}
            <button className="wr-btn-retry" onClick={fetchData}>Coba Lagi</button>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1MIpXkyU_COR_ptTvweKQKFYT0pxWIo_5zfCC90Gqlck" gsheetLabel="Speedcash">
      <div className="wr-page">
        <Header />

        {/* Tab Navigation */}
        <div className="wrd-tabs">
          {TABS.map(tab => (
            <button key={tab.key}
              className={`wrd-tab${activeTab === tab.key ? ' active' : ''}`}
              onClick={() => setActiveTab(tab.key)}>
              <i className={`ti ${tab.icon}`} style={{ marginRight: 5 }} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {loading && <div style={{ fontSize: 12, color: 'var(--text-4)', padding: '8px 0' }}>
          <i className="ti ti-loader-2" style={{ animation: 'aic-rotate 0.8s linear infinite', marginRight: 4 }} />
          Memuat data terbaru…
        </div>}

        {data && (
          <>
            {activeTab === 'executive' && <ExecutiveSummaryTab  data={data} tanggal={displayTanggal} />}
            {activeTab === 'growth'    && <GrowthChurnTab        data={data} tanggal={displayTanggal} />}
            {activeTab === 'segment'   && <MerchantSegmentTab    data={data} tanggal={displayTanggal} />}
            {activeTab === 'margin'    && <MarginAnalysisTab     data={data} tanggal={displayTanggal} />}
            {activeTab === 'cohort'    && <CohortAnalysisTab     data={data} tanggal={displayTanggal} />}
            {activeTab === 'action'    && <ActionCenterTab       data={data} tanggal={displayTanggal} />}
          </>
        )}
      </div>
    </Layout>
  );
}
