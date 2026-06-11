import { useState, useEffect, useRef, useCallback } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getSegmenData, getSegmenHistory, getSegmenTanggalList, getSegmenTrendline } from '../services/api';

/* ─ Constants ─ */
const RED   = '#E24B4A';
const GREEN = '#1D9E75';
const BLUE  = '#378ADD';
const LINE_COLORS = [
  RED, BLUE, GREEN, '#F59E0B', '#8B5CF6',
  '#06B6D4', '#EC4899', '#14B8A6', '#F97316', '#84CC16',
  '#A855F7', '#0EA5E9', '#65A30D', '#D946EF',
];

/* ─ Helpers ─ */
const n = (v) => Number(v) || 0;

function fmtRp(v) {
  const num = n(v), abs = Math.abs(num), sign = num < 0 ? '-' : '';
  if (abs >= 1e9) return sign + 'Rp ' + (abs / 1e9).toFixed(2) + 'M';
  if (abs >= 1e6) return sign + 'Rp ' + (abs / 1e6).toFixed(1) + 'jt';
  if (abs >= 1e3) return sign + 'Rp ' + (abs / 1e3).toFixed(0) + 'k';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}
function fmtDev(v) {
  const num = n(v), abs = Math.abs(num), sign = num >= 0 ? '+' : '-';
  if (abs >= 1e6) return sign + 'Rp ' + (abs / 1e6).toFixed(1) + 'jt';
  if (abs >= 1e3) return sign + 'Rp ' + (abs / 1e3).toFixed(0) + 'k';
  return (num >= 0 ? '+' : '') + 'Rp ' + Math.round(num).toLocaleString('id-ID');
}
const fmtNum  = (v) => n(v).toLocaleString('id-ID');
const calcArpt = (rev, trx) => n(trx) > 0 ? Math.round(n(rev) / n(trx)) : 0;
const calcRpm  = (rev, m)   => n(m)   > 0 ? Math.round(n(rev) / n(m))   : 0;

/* ─ Shared UI ─ */
function ChartCard({ title, children, height = '220px', style }) {
  return (
    <div className="wri-chart-card" style={style}>
      {title && <div className="wri-chart-title">{title}</div>}
      <div style={{ position: 'relative', height }}>{children}</div>
    </div>
  );
}
function KPICard({ label, value, sub, badge, badgeColor }) {
  return (
    <div className="wri-kpi-card">
      <div className="wri-kpi-label">{label}</div>
      <div className="wri-kpi-value">
        {value}
        {badge && <span className="wri-kpi-badge" style={{ color: badgeColor }}>{badge}</span>}
      </div>
      {sub && <div className="wri-kpi-sub">{sub}</div>}
    </div>
  );
}

/* ─ Chart components ─ */
function GroupedBarSegmen({ id, labels, datasets }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 10 } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmtRp(ctx.parsed.y)}` } },
        },
        scales: {
          x: { ticks: { font: { size: 10 }, maxRotation: 40 } },
          y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 }, callback: v => fmtRp(v) } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function HBarSegmen({ id, labels, values, formatFn = fmtRp, color = RED }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: color + 'CC', borderRadius: 3 }] },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ` ${formatFn(ctx.parsed.x)}` } },
        },
        scales: {
          x: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 10 }, callback: v => formatFn(v) } },
          y: { ticks: { font: { size: 10 } } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function ScatterSegmen({ id, rows }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !rows?.length) return;
    const maxRev = Math.max(...rows.map(r => n(r.jun_rev)), 1);
    const chart = new Chart(ref.current, {
      type: 'scatter',
      data: {
        datasets: [{
          data: rows.map(r => ({
            x: n(r.jun_merchant) - n(r.mei_merchant),
            y: n(r.jun_rev)      - n(r.mei_rev),
          })),
          backgroundColor: rows.map(r => {
            const dM = n(r.jun_merchant) - n(r.mei_merchant);
            const dR = n(r.jun_rev) - n(r.mei_rev);
            if (dM > 0 && dR < 0) return '#F59E0BAA';
            if (dR > 0) return GREEN + 'AA';
            if (dR < 0) return RED   + 'AA';
            return '#9CA3AFAA';
          }),
          pointRadius: rows.map(r => Math.max(6, Math.min(20, (n(r.jun_rev) / maxRev) * 20))),
          pointHoverRadius: 12,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => {
            const r = rows[ctx.dataIndex];
            const dM = n(r.jun_merchant) - n(r.mei_merchant);
            const dR = n(r.jun_rev) - n(r.mei_rev);
            return [`${r.kategori}`, `Merchant: ${fmtDev(dM)}  Rev: ${fmtDev(dR)}`];
          }}},
        },
        scales: {
          x: { title: { display: true, text: 'DEV Merchant (Mei→Jun)' }, grid: { color: '#f0f0f0' }, ticks: { callback: v => v > 0 ? '+' + v : v } },
          y: { title: { display: true, text: 'DEV Revenue (Mei→Jun)' },  grid: { color: '#f0f0f0' }, ticks: { callback: v => fmtRp(v) } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function DonutSegmen({ id, labels, values, colors }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors || LINE_COLORS, borderWidth: 2, hoverOffset: 6 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { font: { size: 11 }, padding: 10, boxWidth: 14 } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmtRp(ctx.parsed)}` } },
        },
        cutout: '62%',
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function MultiLineSegmen({ id, dates, byMcc, visibleMcc, metric, segments }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !dates?.length) return;
    const getVal = (rows, d) => {
      const r = rows.find(x => x.tanggal === d);
      if (!r) return null;
      if (metric === 'merchant') return n(r.jun_merchant);
      if (metric === 'trx') return n(r.jun_trx);
      return n(r.jun_rev) / 1e6;
    };
    const datasets = segments
      .filter(s => visibleMcc.has(s.mcc))
      .map((s, i) => ({
        label: s.kategori,
        data: dates.map(d => getVal(byMcc[s.mcc] || [], d)),
        borderColor: LINE_COLORS[segments.indexOf(s) % LINE_COLORS.length],
        backgroundColor: LINE_COLORS[segments.indexOf(s) % LINE_COLORS.length] + '18',
        tension: 0.3,
        pointRadius: dates.length > 20 ? 2 : 3,
        fill: false,
        spanGaps: true,
      }));
    const chart = new Chart(ref.current, {
      type: 'line',
      data: { labels: dates, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 10, boxWidth: 14 } } },
        scales: {
          x: { ticks: { font: { size: 10 }, maxRotation: 45 } },
          y: {
            grid: { color: '#f0f0f0' },
            ticks: {
              font: { size: 11 },
              callback: v => metric === 'rev' ? 'Rp ' + v + 'jt' : fmtNum(v),
            },
          },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

/* ─ Existing shared components ─ */
function StatusPill({ row }) {
  const dev = n(row.dev_mei_jun_rev);
  if (dev > 0) return <span className="pill-naik">Naik</span>;
  if (dev < 0) return <span className="pill-turun">Turun</span>;
  return <span className="pill-stabil">Stabil</span>;
}

function SkeletonCards() {
  return (
    <div className="wr-summary-grid">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="wr-summary-card wr-skeleton">
          <div className="wr-sk-line wr-sk-short" /><div className="wr-sk-line wr-sk-long" />
        </div>
      ))}
    </div>
  );
}

function SummaryCards({ s }) {
  if (!s) return <SkeletonCards />;
  const devRev = n(s.dev_rev_mei_jun);
  const cards = [
    { label: 'Total Merchant Juni', value: fmtNum(s.total_merchant), color: RED },
    { label: 'Total Transaksi',     value: fmtNum(s.total_trx),      color: RED },
    { label: 'Total Revenue', value: fmtRp(s.total_rev), color: GREEN, sub: <span style={{ color: devRev >= 0 ? GREEN : RED, fontSize: 11 }}>{fmtDev(devRev)} vs Mei</span> },
    { label: 'Segmen Aktif',   value: fmtNum(s.segmen_aktif),  color: BLUE },
    { label: 'Segmen Tumbuh',  value: fmtNum(s.segmen_tumbuh), color: GREEN, sub: <span style={{ color: GREEN, fontSize: 11 }}>↑ segmen positif</span> },
    { label: 'Segmen Turun',   value: fmtNum(s.segmen_turun),  color: RED,   sub: <span style={{ color: RED,   fontSize: 11 }}>↓ butuh perhatian</span> },
  ];
  return (
    <div className="wr-summary-grid">
      {cards.map((c, i) => (
        <div key={i} className="wr-summary-card" style={{ borderTop: `3px solid ${c.color}` }}>
          <div className="wr-card-label">{c.label}</div>
          <div className="wr-card-value" style={{ color: c.color }}>{c.value}</div>
          {c.sub && <div className="wr-card-sub">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function RankRow({ item, idx, maxVal, color, showDev }) {
  const val    = n(item.jun_rev);
  const dev    = n(item.dev_mei_jun_rev);
  const barPct = maxVal > 0 ? (Math.abs(showDev ? dev : val) / maxVal) * 100 : 0;
  return (
    <div className="rank-row">
      <span className="rnum">{idx + 1}</span>
      <span className="rname" title={item.kategori}>
        {item.kategori}
        {item.is_anomali && <span className="pill-anomali" style={{ marginLeft: 4, fontSize: 9 }}>⚠</span>}
      </span>
      <div className="rbar-w"><div className="rbar" style={{ width: barPct + '%', background: color }} /></div>
      <span className="rval" style={{ color }}>{showDev ? fmtDev(dev) : fmtRp(val)}</span>
    </div>
  );
}

function TrendChart({ mcc1, mcc2, historyData, topRev }) {
  const ref = useRef(null); const chartRef = useRef(null);
  const rows1 = historyData[mcc1] || [], rows2 = mcc2 ? (historyData[mcc2] || []) : [];
  const hasData = rows1.length >= 2 || rows2.length >= 2;
  useEffect(() => {
    if (!ref.current || !hasData) return;
    chartRef.current?.destroy();
    const allDates = [...new Set([...rows1, ...rows2].map(r => String(r.tanggal).slice(0, 10)))].sort();
    const getVal   = (rows, d) => { const r = rows.find(x => String(x.tanggal).startsWith(d)); return r ? n(r.jun_rev) / 1e6 : null; };
    chartRef.current = new Chart(ref.current, {
      type: 'line',
      data: { labels: allDates, datasets: [
        { label: topRev?.[0]?.kategori || mcc1, data: allDates.map(d => getVal(rows1, d)), borderColor: '#10B981', backgroundColor: '#10B98118', fill: true, tension: 0.3, pointRadius: 3 },
        ...(rows2.length >= 2 ? [{ label: topRev?.[1]?.kategori || mcc2, data: allDates.map(d => getVal(rows2, d)), borderColor: '#3B82F6', backgroundColor: '#3B82F618', fill: true, tension: 0.3, pointRadius: 3 }] : []),
      ]},
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } }, scales: { y: { ticks: { callback: v => 'Rp ' + v + 'jt', font: { size: 10 } } }, x: { ticks: { font: { size: 10 }, maxRotation: 45 } } } },
    });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [rows1, rows2, hasData, mcc1, mcc2]);
  if (!hasData) return <div className="wr-no-data"><i className="ti ti-chart-line" style={{ fontSize: 28, opacity: 0.3 }} /><p>Data tren belum tersedia (minimal 2 hari snapshot)</p></div>;
  return <div style={{ position: 'relative', height: 200 }}><canvas ref={ref} /></div>;
}

function Recommendations({ data }) {
  if (!data) return null;
  const { top_rev = [], segmen_masalah = [], anomali = [], summary } = data;
  const totalRev = n(summary?.total_rev);
  const top2Rev  = n(top_rev[0]?.jun_rev) + n(top_rev[1]?.jun_rev);
  const pct2     = totalRev > 0 ? ((top2Rev / totalRev) * 100).toFixed(1) : '—';
  return (
    <div className="wr-reco-list">
      {top_rev[0] && (
        <div className="wr-reco-card wr-reco-hijau">
          <div className="wr-reco-title">💡 Perkuat — {top_rev[0].kategori}</div>
          <div className="wr-reco-body"><strong>{top_rev[0]?.kategori}</strong>{top_rev[1] ? <> dan <strong>{top_rev[1]?.kategori}</strong></> : ''} mendominasi <strong>{pct2}%</strong> total revenue. Akselerasi akuisisi merchant baru di segmen ini.</div>
        </div>
      )}
      {segmen_masalah[0] && (
        <div className="wr-reco-card wr-reco-merah">
          <div className="wr-reco-title">🚨 Investigasi — {segmen_masalah[0].kategori}</div>
          <div className="wr-reco-body">{segmen_masalah[0].is_anomali ? 'Merchant bertambah namun revenue menurun — indikasi potensi churn atau penurunan nilai transaksi per merchant.' : `Penurunan merchant aktif terdeteksi — risiko kehilangan basis pengguna. Gap MEI→JUN: ${fmtDev(segmen_masalah[0].dev_mei_jun_rev)}.`}</div>
        </div>
      )}
      {anomali.length > 0 && (
        <div className="wr-reco-card wr-reco-kuning">
          <div className="wr-reco-title">⚠ Anomali — {anomali.length} segmen perlu investigasi</div>
          <div className="wr-reco-body">{anomali.map(a => a.kategori).join(', ')}</div>
        </div>
      )}
    </div>
  );
}

function SegmenModal({ row, onClose, historyData, onFetchHistory }) {
  const canvasRef = useRef(null), chartRef = useRef(null);
  useEffect(() => { if (row?.mcc && !historyData[row.mcc]) onFetchHistory(row.mcc); }, [row?.mcc]);
  useEffect(() => {
    if (!canvasRef.current || !row) { chartRef.current?.destroy(); chartRef.current = null; return; }
    const rows = historyData[row.mcc] || [];
    if (rows.length < 2) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: { labels: rows.map(r => String(r.tanggal).slice(5)), datasets: [{ label: 'Rev (jt)', data: rows.map(r => n(r.jun_rev) / 1e6), backgroundColor: rows.map((r, i) => i === 0 || n(r.jun_rev) >= n(rows[i - 1]?.jun_rev) ? '#10B981' : '#EF4444') }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => v + 'jt', font: { size: 10 } } }, x: { ticks: { font: { size: 10 } } } } },
    });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [row?.mcc, historyData]);
  if (!row) return null;
  const histRows = historyData[row.mcc] || [];
  return (
    <div className="wr-modal-overlay" onClick={onClose}>
      <div className="wr-modal" onClick={e => e.stopPropagation()}>
        <div className="wr-modal-header">
          <div><div className="wr-modal-title">{row.kategori}</div><div className="wr-modal-sub">MCC: {row.mcc}</div></div>
          <button className="wr-modal-close" onClick={onClose}>✕</button>
        </div>
        {row.is_anomali && <div className="wr-anomali-banner">⚠ Merchant bertambah namun revenue turun — perlu investigasi</div>}
        <table className="wr-modal-table">
          <thead><tr><th></th><th>April</th><th>Mei</th><th>Juni</th></tr></thead>
          <tbody>
            <tr><td>Merchant</td><td>{fmtNum(row.apr_merchant)}</td><td>{fmtNum(row.mei_merchant)}</td><td><strong>{fmtNum(row.jun_merchant)}</strong></td></tr>
            <tr><td>TRX</td><td>{fmtNum(row.apr_trx)}</td><td>{fmtNum(row.mei_trx)}</td><td><strong>{fmtNum(row.jun_trx)}</strong></td></tr>
            <tr><td>Revenue</td><td>{fmtRp(row.apr_rev)}</td><td>{fmtRp(row.mei_rev)}</td><td><strong style={{ color: GREEN }}>{fmtRp(row.jun_rev)}</strong></td></tr>
          </tbody>
        </table>
        <div className="wr-dev-boxes">
          {[{ label:'DEV Apr→Jun', rev:row.dev_apr_jun_rev, m:row.dev_apr_jun_merchant, t:row.dev_apr_jun_trx }, { label:'DEV Mei→Jun', rev:row.dev_mei_jun_rev, m:row.dev_mei_jun_merchant, t:row.dev_mei_jun_trx }].map(d => (
            <div key={d.label} className={`wr-dev-box ${n(d.rev) >= 0 ? 'wr-dev-pos' : 'wr-dev-neg'}`}>
              <div className="wr-dev-label">{d.label}</div><div className="wr-dev-rev">{fmtDev(d.rev)}</div>
              <div className="wr-dev-detail">{fmtDev(d.m)} merchant · {fmtDev(d.t)} TRX</div>
            </div>
          ))}
        </div>
        <div className="wr-modal-chart">
          {histRows.length >= 2
            ? <div style={{ position: 'relative', height: 160 }}><canvas ref={canvasRef} /></div>
            : <div className="wr-no-data-sm">Data tren belum tersedia (minimal 2 hari snapshot)</div>
          }
        </div>
      </div>
    </div>
  );
}

/* ─── TAB 0: Executive Summary ─── */
function ExecutiveSummaryTab({ data, loading, historyData, onClickRow }) {
  const [filter, setFilter] = useState('semua');
  const [sort, setSort]     = useState('rev');

  const displayRows = (() => {
    if (!data?.tabel) return [];
    let rows = [...data.tabel];
    if (filter === 'tumbuh') rows = rows.filter(r => n(r.dev_mei_jun_rev) > 0);
    if (filter === 'turun')  rows = rows.filter(r => n(r.dev_mei_jun_rev) < 0);
    if (filter === 'top10')  rows = rows.slice(0, 10);
    const sk = { rev:'jun_rev', dev_mei:'dev_mei_jun_rev', merchant:'jun_merchant', dev_apr:'dev_apr_jun_rev' }[sort] || 'jun_rev';
    return rows.sort((a, b) => n(b[sk]) - n(a[sk]));
  })();

  const maxTopRev  = n(data?.top_rev?.[0]?.jun_rev);
  const maxGrowth  = n(data?.top_growth?.[0]?.dev_mei_jun_rev);
  const maxMasalah = Math.abs(n(data?.segmen_masalah?.[0]?.dev_mei_jun_rev));

  return (
    <div>
      {loading ? <SkeletonCards /> : <SummaryCards s={data?.summary} />}
      {!loading && data && (
        <>
          <div className="wr-panels">
            <div className="wr-panel">
              <div className="wr-panel-title" style={{ color: GREEN }}>Top Revenue Juni</div>
              {(data.top_rev || []).map((row, i) => <RankRow key={row.mcc} item={row} idx={i} maxVal={maxTopRev} color={GREEN} />)}
            </div>
            <div className="wr-panel">
              <div className="wr-panel-title" style={{ color: BLUE }}>Pertumbuhan Tercepat</div>
              {(data.top_growth || []).map((row, i) => <RankRow key={row.mcc} item={row} idx={i} maxVal={maxGrowth} color={BLUE} showDev />)}
              {!data.top_growth?.length && <div className="wr-empty-panel">Belum ada segmen tumbuh</div>}
            </div>
            <div className="wr-panel">
              <div className="wr-panel-title" style={{ color: RED }}>Segmen Bermasalah</div>
              {(data.segmen_masalah || []).slice(0, 10).map((row, i) => <RankRow key={row.mcc} item={row} idx={i} maxVal={maxMasalah} color={RED} showDev />)}
              {!data.segmen_masalah?.length && <div className="wr-empty-panel">Semua segmen positif ✓</div>}
            </div>
          </div>

          <div className="wr-table-section">
            <div className="wr-table-controls">
              <div className="wr-table-left">
                <select className="wr-select" value={sort} onChange={e => setSort(e.target.value)}>
                  <option value="rev">Revenue ↓</option>
                  <option value="dev_mei">DEV Mei→Jun ↓</option>
                  <option value="merchant">Merchant ↓</option>
                  <option value="dev_apr">DEV Apr→Jun ↓</option>
                </select>
                <span className="wr-count">{displayRows.length} segmen</span>
              </div>
              <div className="wr-filter-tabs">
                {[['semua','Semua'],['tumbuh','Tumbuh'],['turun','Turun'],['top10','Top 10']].map(([k,l]) => (
                  <button key={k} className={`wr-filter-tab${filter===k?' active':''}`} onClick={() => setFilter(k)}>{l}</button>
                ))}
              </div>
            </div>
            <div className="wr-table-wrap">
              <table className="wr-table">
                <thead>
                  <tr><th>#</th><th>Segmen</th><th>Merchant Jun</th><th>TRX Jun</th><th>Rev Juni</th><th>Rev Mei</th><th>DEV Mei→Jun</th><th>DEV Apr→Jun</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {displayRows.map((row, i) => {
                    const devMei = n(row.dev_mei_jun_rev), devApr = n(row.dev_apr_jun_rev);
                    return (
                      <tr key={row.mcc} className="wr-tr-clickable" onClick={() => onClickRow(row)}>
                        <td>{i+1}</td>
                        <td><span className="wr-segmen-name">{row.kategori}</span>{row.is_anomali && <span className="pill-anomali" style={{ marginLeft:6,fontSize:10 }}>⚠ Anomali</span>}</td>
                        <td>{fmtNum(row.jun_merchant)}</td><td>{fmtNum(row.jun_trx)}</td>
                        <td style={{ fontWeight:600, color:GREEN }}>{fmtRp(row.jun_rev)}</td>
                        <td>{fmtRp(row.mei_rev)}</td>
                        <td style={{ fontWeight:600, color:devMei>=0?GREEN:RED }}>{fmtDev(devMei)}</td>
                        <td style={{ color:devApr>=0?GREEN:RED }}>{fmtDev(devApr)}</td>
                        <td><StatusPill row={row} /></td>
                      </tr>
                    );
                  })}
                  {!displayRows.length && <tr><td colSpan={9} style={{ textAlign:'center', padding:24, color:'var(--text-4)' }}>{data?.tabel?.length ? 'Tidak ada data untuk filter ini' : 'Belum ada data — jalankan sync dari Apps Script'}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="wr-analysis-grid">
            <div className="wr-analysis-panel">
              <div className="wr-panel-title">Tren Revenue Segmen Teratas</div>
              <TrendChart mcc1={data?.top_rev?.[0]?.mcc} mcc2={data?.top_rev?.[1]?.mcc} historyData={historyData} topRev={data.top_rev} />
            </div>
            <div className="wr-analysis-panel">
              <div className="wr-panel-title">Rekomendasi Strategis</div>
              <Recommendations data={data} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ─── TAB 1: Trendline Harian ─── */
function TrendlineTab() {
  const [days, setDays]          = useState(30);
  const [metric, setMetric]      = useState('rev');
  const [trendData, setTrend]    = useState(null);
  const [loading, setLoading]    = useState(true);
  const [error, setError]        = useState(null);
  const [visibleMcc, setVisible] = useState(new Set());

  useEffect(() => {
    setLoading(true);
    getSegmenTrendline(days)
      .then(d => {
        setTrend(d);
        setVisible(new Set(d.segments.slice(0, 8).map(s => s.mcc)));
        setError(null);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [days]);

  const toggleMcc = (mcc) => setVisible(prev => {
    const next = new Set(prev);
    if (next.has(mcc)) next.delete(mcc); else next.add(mcc);
    return next;
  });

  if (loading) return <div className="wri-state">Memuat trendline...</div>;
  if (error)   return <div className="wri-state wri-state--error">{error}</div>;
  if (!trendData?.dates?.length) return <div className="wri-state">Belum ada data historis — butuh minimal 2 hari snapshot</div>;

  const chartId = `seg-tl-${days}-${metric}-${[...visibleMcc].sort().join('')}`;

  return (
    <div>
      <div className="wri-controls">
        <div className="wri-ctrl-group">
          <span className="wri-ctrl-label">Periode:</span>
          {[7, 14, 30, 60].map(d => (
            <button key={d} className={`wri-filter-btn${days===d?' wri-filter-btn--active':''}`} onClick={() => setDays(d)}>{d} hari</button>
          ))}
        </div>
        <div className="wri-ctrl-group">
          <span className="wri-ctrl-label">Metrik:</span>
          {[['rev','Revenue'],['merchant','Merchant'],['trx','TRX']].map(([k,l]) => (
            <button key={k} className={`wri-filter-btn${metric===k?' wri-filter-btn--active':''}`} onClick={() => setMetric(k)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="wri-chip-row">
        {trendData.segments.map((s, i) => (
          <button
            key={s.mcc}
            className={`wri-chip${visibleMcc.has(s.mcc) ? ' wri-chip--on' : ''}`}
            style={visibleMcc.has(s.mcc) ? { borderColor: LINE_COLORS[i%LINE_COLORS.length], background: LINE_COLORS[i%LINE_COLORS.length]+'22', color: LINE_COLORS[i%LINE_COLORS.length] } : {}}
            onClick={() => toggleMcc(s.mcc)}
          >
            {s.kategori}
          </button>
        ))}
      </div>

      <ChartCard title="" height="340px">
        <MultiLineSegmen
          id={chartId}
          dates={trendData.dates}
          byMcc={trendData.byMcc}
          visibleMcc={visibleMcc}
          metric={metric}
          segments={trendData.segments}
        />
      </ChartCard>
    </div>
  );
}

/* ─── TAB 2: Trend & Growth ─── */
function TrendGrowthTab({ data, tid }) {
  if (!data?.tabel?.length) return <div className="wri-state">Belum ada data</div>;

  const all  = data.tabel;
  const top5 = [...all].filter(r => n(r.dev_mei_jun_rev) > 0).sort((a,b) => n(b.dev_mei_jun_rev) - n(a.dev_mei_jun_rev)).slice(0, 5);
  const bot5 = [...all].filter(r => n(r.dev_mei_jun_rev) < 0).sort((a,b) => n(a.dev_mei_jun_rev) - n(b.dev_mei_jun_rev)).slice(0, 5);
  const top10 = [...all].sort((a,b) => n(b.jun_rev) - n(a.jun_rev)).slice(0, 10);

  return (
    <div>
      <div className="wri-2col">
        <div className="wri-panel-box">
          <div className="wri-panel-head" style={{ color: GREEN }}>Top 5 — Pertumbuhan Revenue Mei→Jun</div>
          <table className="wri-mini-table">
            <thead><tr><th>#</th><th>Segmen</th><th>DEV Revenue</th><th>DEV Merchant</th></tr></thead>
            <tbody>
              {top5.map((r, i) => (
                <tr key={r.mcc}>
                  <td style={{ color:GREEN, fontWeight:700 }}>{i+1}</td>
                  <td>{r.kategori}</td>
                  <td style={{ color:GREEN, fontWeight:600 }}>{fmtDev(r.dev_mei_jun_rev)}</td>
                  <td style={{ color:n(r.dev_mei_jun_merchant)>=0?GREEN:RED }}>{fmtDev(r.dev_mei_jun_merchant)}</td>
                </tr>
              ))}
              {!top5.length && <tr><td colSpan={4} style={{ textAlign:'center', color:'var(--text-4)', padding:12 }}>Tidak ada segmen tumbuh</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="wri-panel-box">
          <div className="wri-panel-head" style={{ color: RED }}>Bottom 5 — Penurunan Revenue Mei→Jun</div>
          <table className="wri-mini-table">
            <thead><tr><th>#</th><th>Segmen</th><th>DEV Revenue</th><th>DEV Merchant</th></tr></thead>
            <tbody>
              {bot5.map((r, i) => (
                <tr key={r.mcc}>
                  <td style={{ color:RED, fontWeight:700 }}>{i+1}</td>
                  <td>{r.kategori}{r.is_anomali && <span className="pill-anomali" style={{ marginLeft:4,fontSize:9 }}>⚠</span>}</td>
                  <td style={{ color:RED, fontWeight:600 }}>{fmtDev(r.dev_mei_jun_rev)}</td>
                  <td style={{ color:n(r.dev_mei_jun_merchant)>=0?GREEN:RED }}>{fmtDev(r.dev_mei_jun_merchant)}</td>
                </tr>
              ))}
              {!bot5.length && <tr><td colSpan={4} style={{ textAlign:'center', color:'var(--text-4)', padding:12 }}>Tidak ada segmen turun</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <ChartCard title="Top 10 Segmen — Revenue Apr / Mei / Jun" height="300px" style={{ marginTop:16 }}>
        <GroupedBarSegmen
          id={`seg-rev3-${tid}`}
          labels={top10.map(r => r.kategori)}
          datasets={[
            { label:'April', data:top10.map(r=>n(r.apr_rev)), backgroundColor:'#94A3B8', borderRadius:2 },
            { label:'Mei',   data:top10.map(r=>n(r.mei_rev)), backgroundColor:'#CBD5E1', borderRadius:2 },
            { label:'Juni',  data:top10.map(r=>n(r.jun_rev)), backgroundColor:RED,       borderRadius:2 },
          ]}
        />
      </ChartCard>

      <ChartCard title="Quadrant — DEV Merchant vs DEV Revenue (Mei→Jun)" height="300px" style={{ marginTop:16 }}>
        <ScatterSegmen id={`seg-scatter-${tid}`} rows={all} />
      </ChartCard>
    </div>
  );
}

/* ─── TAB 3: Unit Ekonomi ─── */
function UnitEkonomiTab({ data, tid }) {
  if (!data?.tabel?.length) return <div className="wri-state">Belum ada data</div>;

  const rows   = data.tabel.filter(r => n(r.jun_trx) > 0 || n(r.jun_rev) > 0);
  const sorted = [...rows].sort((a,b) => n(b.jun_rev) - n(a.jun_rev));

  const totRev  = rows.reduce((s,r) => s+n(r.jun_rev), 0);
  const totRevM = rows.reduce((s,r) => s+n(r.mei_rev), 0);
  const totTrx  = rows.reduce((s,r) => s+n(r.jun_trx), 0);
  const totMerc = rows.reduce((s,r) => s+n(r.jun_merchant), 0);
  const arptT   = calcArpt(totRev, totTrx);
  const rpmT    = calcRpm(totRev, totMerc);

  const top5Rev     = sorted.slice(0, 5);
  const othersRev   = totRev - top5Rev.reduce((s,r) => s+n(r.jun_rev), 0);
  const donutLabels = [...top5Rev.map(r => r.kategori), 'Lainnya'];
  const donutValues = [...top5Rev.map(r => n(r.jun_rev)), othersRev];

  const arptRanked = [...rows]
    .map(r => ({ ...r, arpt_jun: calcArpt(r.jun_rev, r.jun_trx) }))
    .filter(r => r.arpt_jun > 0)
    .sort((a,b) => b.arpt_jun - a.arpt_jun)
    .slice(0, 10);

  return (
    <div>
      <div className="wri-kpi-grid">
        <KPICard label="Total Revenue (Jun)"    value={fmtRp(totRev)}  sub={`${fmtDev(totRev-totRevM)} vs Mei`}            badge={totRev>=totRevM?'▲':'▼'} badgeColor={totRev>=totRevM?GREEN:RED} />
        <KPICard label="ARPT (Rata-rata Rev/TRX)" value={fmtRp(arptT)} sub="Rata-rata semua segmen aktif" />
        <KPICard label="Rev per Merchant (Jun)" value={fmtRp(rpmT)}    sub="Avg revenue per merchant aktif" />
        <KPICard label="Segmen Aktif"           value={fmtNum(rows.length)} sub={`${rows.filter(r=>n(r.jun_trx)>0).length} bertransaksi`} />
      </div>

      <div className="wri-2col" style={{ marginTop:16 }}>
        <ChartCard title="Top 10 Segmen — ARPT (Rev/TRX) Juni" height="270px">
          <HBarSegmen
            id={`seg-arpt-${tid}`}
            labels={arptRanked.map(r => r.kategori)}
            values={arptRanked.map(r => r.arpt_jun)}
            formatFn={fmtRp}
            color={RED}
          />
        </ChartCard>
        <ChartCard title="Konsentrasi Revenue Juni" height="270px">
          <DonutSegmen
            id={`seg-donut-${tid}`}
            labels={donutLabels}
            values={donutValues}
            colors={[RED, BLUE, GREEN, '#F59E0B', '#8B5CF6', '#9CA3AF']}
          />
        </ChartCard>
      </div>

      <div className="wr-table-wrap" style={{ marginTop:16 }}>
        <table className="wr-table">
          <thead>
            <tr><th>#</th><th>Segmen</th><th>Merchant Jun</th><th>TRX Jun</th><th>Rev Jun</th><th>ARPT Jun</th><th>ARPT Mei</th><th>DEV ARPT</th><th>Rev/Merchant</th><th>% Revenue</th></tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => {
              const arptJ  = calcArpt(r.jun_rev, r.jun_trx);
              const arptM  = calcArpt(r.mei_rev, r.mei_trx);
              const rpm    = calcRpm(r.jun_rev, r.jun_merchant);
              const pct    = totRev > 0 ? ((n(r.jun_rev)/totRev)*100).toFixed(1) : '0.0';
              const devArpt = arptJ - arptM;
              return (
                <tr key={r.mcc}>
                  <td>{i+1}</td>
                  <td>{r.kategori}</td>
                  <td>{fmtNum(r.jun_merchant)}</td>
                  <td>{fmtNum(r.jun_trx)}</td>
                  <td style={{ color:GREEN, fontWeight:600 }}>{fmtRp(r.jun_rev)}</td>
                  <td style={{ fontWeight:600 }}>{fmtRp(arptJ)}</td>
                  <td style={{ color:'var(--text-3)' }}>{fmtRp(arptM)}</td>
                  <td style={{ color:devArpt>=0?GREEN:RED, fontWeight:600 }}>{fmtDev(devArpt)}</td>
                  <td>{fmtRp(rpm)}</td>
                  <td>
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <div style={{ flex:1, height:8, background:'#F1F5F9', borderRadius:4, overflow:'hidden' }}>
                        <div style={{ width:`${pct}%`, height:'100%', background:RED+'CC', borderRadius:4 }} />
                      </div>
                      <span style={{ fontSize:11, minWidth:36, textAlign:'right' }}>{pct}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── TAB 4: Action Center ─── */
function ActionCenterTab({ data }) {
  if (!data?.tabel?.length) return <div className="wri-state">Belum ada data</div>;

  const all     = data.tabel;
  const anomali = all.filter(r => n(r.dev_mei_jun_merchant) > 0 && n(r.dev_mei_jun_rev) < 0);
  const kritis  = all.filter(r => n(r.dev_mei_jun_rev) < 0 && !anomali.some(a => a.mcc === r.mcc))
                     .sort((a,b) => n(a.dev_mei_jun_rev) - n(b.dev_mei_jun_rev)).slice(0, 5);
  const growth  = all.filter(r => n(r.dev_mei_jun_rev) > 0)
                     .sort((a,b) => n(b.dev_mei_jun_rev) - n(a.dev_mei_jun_rev)).slice(0, 5);
  const peluang = all.filter(r => n(r.dev_mei_jun_merchant) > 0 && n(r.dev_mei_jun_rev) > 0 && n(r.jun_rev) < n(data.summary?.total_rev) * 0.05)
                     .sort((a,b) => n(b.dev_mei_jun_merchant) - n(a.dev_mei_jun_merchant)).slice(0, 5);

  const riskCards = [
    { icon:'🚨', label:'Kritis',  count:kritis.length,  color:RED },
    { icon:'⚠️',  label:'Anomali', count:anomali.length, color:'#F59E0B' },
    { icon:'📈', label:'Tumbuh',  count:growth.length,  color:GREEN },
    { icon:'💡', label:'Peluang', count:peluang.length, color:BLUE },
  ];

  return (
    <div>
      <div className="wri-risk-row">
        {riskCards.map(r => (
          <div key={r.label} className="wri-risk-card" style={{ borderTop:`3px solid ${r.color}` }}>
            <span style={{ fontSize:24 }}>{r.icon}</span>
            <span className="wri-risk-count" style={{ color:r.color }}>{r.count}</span>
            <span className="wri-risk-label">{r.label}</span>
          </div>
        ))}
      </div>

      {kritis.length > 0 && (
        <div className="wri-action-block" style={{ borderLeft:`4px solid ${RED}` }}>
          <div className="wri-action-block-head" style={{ color:RED }}>🚨 Wajib Diselamatkan — Revenue Turun ({kritis.length} segmen)</div>
          {kritis.map((r, i) => (
            <div key={r.mcc} className="wri-action-item">
              <div className="wri-action-item-hd">
                <span className="wri-action-num" style={{ background:RED }}>{i+1}</span>
                <span className="wri-action-name">{r.kategori}</span>
                <span className="wri-action-badge wri-badge-danger">{fmtDev(r.dev_mei_jun_rev)}</span>
              </div>
              <div className="wri-action-steps">
                <span>① Identifikasi merchant aktif yang berhenti bertransaksi</span>
                <span>② Hubungi top 10 merchant di segmen ini dalam 24 jam</span>
                <span>③ Analisis penyebab: kompetitor, masalah teknis, atau seasonal</span>
                <span>④ Target recovery: kembalikan ke level Mei ({fmtRp(r.mei_rev)})</span>
              </div>
              <div className="wri-action-stat">
                Merchant: {fmtNum(r.mei_merchant)} → {fmtNum(r.jun_merchant)} ({fmtDev(r.dev_mei_jun_merchant)})
                &nbsp;·&nbsp; Revenue: {fmtRp(r.mei_rev)} → {fmtRp(r.jun_rev)}
              </div>
            </div>
          ))}
        </div>
      )}

      {anomali.length > 0 && (
        <div className="wri-action-block" style={{ borderLeft:`4px solid #F59E0B` }}>
          <div className="wri-action-block-head" style={{ color:'#D97706' }}>⚠️ Wajib Diinvestigasi — Anomali: Merchant Naik, Revenue Turun ({anomali.length} segmen)</div>
          {anomali.map((r, i) => (
            <div key={r.mcc} className="wri-action-item">
              <div className="wri-action-item-hd">
                <span className="wri-action-num" style={{ background:'#F59E0B' }}>{i+1}</span>
                <span className="wri-action-name">{r.kategori}</span>
                <span className="wri-action-badge wri-badge-warn">Merchant {fmtDev(r.dev_mei_jun_merchant)} · Rev {fmtDev(r.dev_mei_jun_rev)}</span>
              </div>
              <div className="wri-action-steps">
                <span>① Merchant bertambah tapi revenue turun — cek kualitas merchant baru</span>
                <span>② Audit frekuensi & nilai TRX merchant lama vs merchant baru</span>
                <span>③ Kemungkinan: merchant dormant, nilai transaksi kecil, atau aktivasi belum optimal</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {growth.length > 0 && (
        <div className="wri-action-block" style={{ borderLeft:`4px solid ${GREEN}` }}>
          <div className="wri-action-block-head" style={{ color:GREEN }}>📈 Wajib Dihubungi — Segmen Tumbuh ({growth.length} segmen)</div>
          <div className="wri-action-2col">
            {growth.map((r, i) => (
              <div key={r.mcc} className="wri-action-item">
                <div className="wri-action-item-hd">
                  <span className="wri-action-num" style={{ background:GREEN }}>{i+1}</span>
                  <span className="wri-action-name">{r.kategori}</span>
                  <span className="wri-action-badge wri-badge-success">{fmtDev(r.dev_mei_jun_rev)}</span>
                </div>
                <div className="wri-action-steps">
                  <span>① Dokumentasikan best practice — apa yang berjalan baik</span>
                  <span>② Replikasi ke segmen lain dengan profil merchant serupa</span>
                </div>
                <div className="wri-action-stat">Merchant: {fmtNum(r.jun_merchant)} · Rev Jun: {fmtRp(r.jun_rev)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {peluang.length > 0 && (
        <div className="wri-action-block" style={{ borderLeft:`4px solid ${BLUE}` }}>
          <div className="wri-action-block-head" style={{ color:BLUE }}>💡 Segmen Peluang — Tumbuh tapi Kontribusi Masih Kecil ({peluang.length} segmen)</div>
          <div className="wri-action-2col">
            {peluang.map((r, i) => (
              <div key={r.mcc} className="wri-action-item">
                <div className="wri-action-item-hd">
                  <span className="wri-action-num" style={{ background:BLUE }}>{i+1}</span>
                  <span className="wri-action-name">{r.kategori}</span>
                  <span className="wri-action-badge wri-badge-info">{fmtDev(r.dev_mei_jun_merchant)} merchant</span>
                </div>
                <div className="wri-action-stat">Rev Jun: {fmtRp(r.jun_rev)} · Growth: {fmtDev(r.dev_mei_jun_rev)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Main Page ─── */
export default function WarRoom() {
  const [tab,         setTab]     = useState(0);
  const [data,        setData]    = useState(null);
  const [loading,     setLoading] = useState(true);
  const [error,       setError]   = useState(null);
  const [tanggal,     setTanggal] = useState('');
  const [tglList,     setTglList] = useState([]);
  const [modalRow,    setModalRow]= useState(null);
  const [historyData, setHistory] = useState({});
  const [lastUpdated, setLastUpd] = useState(null);

  const fetchHistory = useCallback(async (mcc) => {
    if (!mcc || historyData[mcc]) return;
    try {
      const res = await getSegmenHistory(mcc);
      setHistory(h => ({ ...h, [mcc]: res.rows || [] }));
    } catch { /* silent */ }
  }, [historyData]);

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await getSegmenData({ tanggal: tanggal || undefined });
      setData(res);
      if (res.top_rev?.[0]?.mcc) fetchHistory(res.top_rev[0].mcc);
      if (res.top_rev?.[1]?.mcc) fetchHistory(res.top_rev[1].mcc);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Gagal memuat data');
    } finally { setLoading(false); setLastUpd(new Date()); }
  }, [tanggal]);

  useEffect(() => { getSegmenTanggalList().then(r => setTglList(r.list || [])).catch(() => {}); }, []);
  useEffect(() => { fetchData(); }, [fetchData]);

  const TABS = ['Executive Summary', 'Trendline Harian', 'Trend & Growth', 'Unit Ekonomi', 'Action Center'];
  const tid  = data?.tanggal ? String(data.tanggal).slice(0, 10) : 'x';

  return (
    <Layout>
      <div className="wr-page">

        <div className="wr-header">
          <div>
            <div className="wr-title-row">
              <span className="wr-icon">⚔</span>
              <h1 className="wr-title">WAR-ROOM</h1>
              <span className="war-badge">LIVE</span>
            </div>
            <p className="wr-sub">
              Monitoring intensif real-time · InstaQris · Snapshot data: {data?.tanggal ? String(data.tanggal).slice(0,10) : '–'}
              {lastUpdated && <span style={{ marginLeft:8, color:'var(--text-4)' }}>· Terakhir dimuat {lastUpdated.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>}
            </p>
          </div>
          <div className="wr-header-right">
            <select className="wr-select" value={tanggal} onChange={e => setTanggal(e.target.value)}>
              <option value="">Terkini</option>
              {tglList.map(t => <option key={t} value={String(t)}>{String(t).slice(0,10)}</option>)}
            </select>
            <button className="wr-btn-update" onClick={fetchData} disabled={loading}>
              {loading
                ? <><i className="ti ti-loader-2" style={{ animation:'aic-rotate 0.8s linear infinite' }}/> Memuat...</>
                : <><i className="ti ti-refresh"/> Update Data</>
              }
            </button>
          </div>
        </div>

        <div className="war-tabs">
          {TABS.map((t, i) => (
            <button key={i} className={`war-tab${tab===i?' active':''}`} onClick={() => setTab(i)}>{t}</button>
          ))}
        </div>

        {error && !loading && (
          <div className="wr-error">
            <i className="ti ti-alert-circle"/> {error}
            <button className="wr-btn-retry" onClick={fetchData}>Coba Lagi</button>
          </div>
        )}

        <div className="wri-tab-content">
          {tab === 0 && <ExecutiveSummaryTab data={data} loading={loading} historyData={historyData} onClickRow={setModalRow} />}
          {tab === 1 && <TrendlineTab />}
          {tab === 2 && (loading ? <SkeletonCards /> : data && <TrendGrowthTab data={data} tid={tid} />)}
          {tab === 3 && (loading ? <SkeletonCards /> : data && <UnitEkonomiTab data={data} tid={tid} />)}
          {tab === 4 && (loading ? <SkeletonCards /> : data && <ActionCenterTab data={data} />)}
        </div>

      </div>
      <SegmenModal row={modalRow} onClose={() => setModalRow(null)} historyData={historyData} onFetchHistory={fetchHistory} />
    </Layout>
  );
}
