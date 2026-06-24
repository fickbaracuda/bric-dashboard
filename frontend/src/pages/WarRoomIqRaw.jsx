import { useState, useEffect, useRef, useCallback } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getDataRawAnalytics, getDataRawTrendline } from '../services/api';

/* ─ Constants ─ */
const ACCENT = '#0EA5E9';
const GREEN  = '#1D9E75';
const RED    = '#EF4444';
const BLUE   = '#378ADD';
const LINE_COLORS = [
  ACCENT, '#7C3AED', GREEN, '#F59E0B', RED,
  '#06B6D4', '#EC4899', '#14B8A6', '#F97316', '#84CC16',
  '#A855F7', BLUE, '#65A30D', '#D946EF',
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
function fmtDevNum(v) {
  const num = n(v);
  return (num >= 0 ? '+' : '') + num.toLocaleString('id-ID');
}
const fmtNum   = (v) => n(v).toLocaleString('id-ID');
const calcArpt = (rev, trx) => n(trx) > 0 ? Math.round(n(rev) / n(trx)) : 0;
const calcRpm  = (rev, m)   => n(m)   > 0 ? Math.round(n(rev) / n(m))   : 0;

function bulanLabel(b) {
  if (!b) return '';
  const [y, m] = b.split('-');
  const BULAN = ['','Jan','Feb','Mar','Apr','Mei','Jun','Jul','Ags','Sep','Okt','Nov','Des'];
  return (BULAN[parseInt(m)] || m) + ' ' + y;
}

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
function GroupedBarKat({ id, labels, datasets }) {
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

function HBarKat({ id, labels, values, formatFn = fmtRp, color = ACCENT }) {
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

function ScatterKat({ id, rows }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !rows?.length) return;
    const maxTrx = Math.max(...rows.map(r => n(r.jun_trx)), 1);
    const chart = new Chart(ref.current, {
      type: 'scatter',
      data: {
        datasets: [{
          data: rows.map(r => ({
            x: n(r.dev_mei_jun_trx),
            y: n(r.dev_mei_jun_margin) / 1e6,
          })),
          backgroundColor: rows.map(r => {
            const dT = n(r.dev_mei_jun_trx);
            const dM = n(r.dev_mei_jun_margin);
            if (r.is_anomali)   return '#F59E0BAA';   // TRX naik, margin turun
            if (dT > 0 && dM > 0) return GREEN + 'AA';
            if (dT < 0 || dM < 0) return RED   + 'AA';
            return '#9CA3AFAA';
          }),
          pointRadius: rows.map(r => Math.max(6, Math.min(20, (n(r.jun_trx) / maxTrx) * 20))),
          pointHoverRadius: 12,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => {
            const r = rows[ctx.dataIndex];
            return [
              `${r.kategori}`,
              `DEV TRX: ${fmtDevNum(r.dev_mei_jun_trx)}`,
              `DEV Margin: ${fmtDev(r.dev_mei_jun_margin)}`,
              `TRX: ${fmtNum(r.jun_trx)} · Margin: ${fmtRp(r.jun_margin)}`,
            ];
          }}},
        },
        scales: {
          x: { title: { display: true, text: 'DEV TRX (Bulan Lalu→Sekarang)' }, grid: { color: '#f0f0f0' }, ticks: { callback: v => v > 0 ? '+' + fmtNum(v) : fmtNum(v) } },
          y: { title: { display: true, text: 'DEV Margin (jt)' },               grid: { color: '#f0f0f0' }, ticks: { callback: v => 'Rp ' + v + 'jt' } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function DonutKat({ id, labels, values, colors }) {
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

function MultiLineKat({ id, dates, byKategori, visibleKat, metric, segments }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !dates?.length) return;
    const getVal = (rows, d) => {
      const r = rows.find(x => x.tanggal === d);
      if (!r) return null;
      if (metric === 'merchant') return n(r.jun_merchant);
      if (metric === 'trx')     return n(r.jun_trx);
      if (metric === 'margin')  return n(r.jun_margin) / 1e6;
      return n(r.jun_rev) / 1e6;
    };
    const datasets = segments
      .filter(s => visibleKat.has(s.kategori))
      .map((s, i) => ({
        label: s.kategori,
        data: dates.map(d => getVal(byKategori[s.kategori] || [], d)),
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
              callback: v => (metric === 'rev' || metric === 'margin') ? 'Rp ' + v + 'jt' : fmtNum(v),
            },
          },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

/* ─ Shared UI pieces ─ */
function StatusPill({ row }) {
  const devTrx    = n(row.dev_mei_jun_trx);
  const devMargin = n(row.dev_mei_jun_margin);
  if (row.is_anomali) return <span className="pill-anomali" style={{ fontSize: 11 }}>⚠ Anomali</span>;
  if (devTrx > 0 && devMargin > 0) return <span className="pill-naik">Naik</span>;
  if (devTrx < 0 || devMargin < 0) return <span className="pill-turun">Turun</span>;
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

function SummaryCards({ s, bulanLabel: bl }) {
  if (!s) return <SkeletonCards />;
  const devTrx    = n(s.dev_trx_mei_jun);
  const devMargin = n(s.dev_margin_mei_jun);
  const cards = [
    { label: 'Total Transaksi', value: fmtNum(s.total_trx), color: ACCENT,
      sub: <span style={{ color: devTrx >= 0 ? GREEN : RED, fontSize: 11, fontWeight: 600 }}>{fmtDevNum(devTrx)} TRX vs bulan lalu</span> },
    { label: 'Total Margin', value: fmtRp(s.total_margin), color: GREEN,
      sub: <span style={{ color: devMargin >= 0 ? GREEN : RED, fontSize: 11, fontWeight: 600 }}>{fmtDev(devMargin)} vs bulan lalu</span> },
    { label: `Total Omzet ${bl}`, value: fmtRp(s.total_rev), color: BLUE },
    { label: `Merchant ${bl}`,    value: fmtNum(s.total_merchant), color: BLUE },
    { label: 'Kategori Tumbuh', value: fmtNum(s.segmen_tumbuh), color: GREEN,
      sub: <span style={{ color: GREEN, fontSize: 11 }}>↑ TRX naik vs bulan lalu</span> },
    { label: 'Kategori Turun',  value: fmtNum(s.segmen_turun),  color: RED,
      sub: <span style={{ color: RED,   fontSize: 11 }}>↓ TRX turun vs bulan lalu</span> },
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

function RankRow({ item, idx, maxVal, color, metric = 'trx' }) {
  // metric: 'trx' | 'margin' | 'dev_trx' | 'dev_margin'
  const val = metric === 'trx'        ? n(item.jun_trx)
            : metric === 'margin'     ? n(item.jun_margin)
            : metric === 'dev_trx'    ? n(item.dev_mei_jun_trx)
            : metric === 'dev_margin' ? n(item.dev_mei_jun_margin)
            : n(item.jun_trx);
  const barPct = maxVal > 0 ? (Math.abs(val) / maxVal) * 100 : 0;
  const isDev  = metric.startsWith('dev_');
  const fmt    = metric === 'trx' || metric === 'dev_trx' ? fmtNum : fmtRp;
  const devFmt = metric === 'dev_trx' ? fmtDevNum : fmtDev;
  return (
    <div className="rank-row">
      <span className="rnum">{idx + 1}</span>
      <span className="rname" title={item.kategori}>
        {item.kategori}
        {item.is_anomali && <span className="pill-anomali" style={{ marginLeft: 4, fontSize: 9 }}>⚠</span>}
      </span>
      <div className="rbar-w"><div className="rbar" style={{ width: barPct + '%', background: color }} /></div>
      <span className="rval" style={{ color }}>{isDev ? devFmt(val) : fmt(val)}</span>
    </div>
  );
}

function Top2BulanChart({ data, tid, b1, b2, b3, mtd }) {
  const top2 = data?.top_trx?.slice(0, 3) || [];
  if (!top2.length) return null;
  const sfx    = mtd?.is_mtd ? ` MTD-${mtd.max_day}` : '';
  const labels = [bulanLabel(b3) + sfx, bulanLabel(b2) + sfx, bulanLabel(b1)];
  const COLS   = [ACCENT, BLUE, GREEN];
  const datasets = top2.map((r, i) => ({
    label: r.kategori.length > 22 ? r.kategori.slice(0, 22) + '…' : r.kategori,
    data: [n(r.apr_trx), n(r.mei_trx), n(r.jun_trx)],
    backgroundColor: COLS[i % COLS.length] + 'CC',
    borderRadius: 4,
  }));
  return (
    <ChartCard height="200px">
      <GroupedBarKat id={`iq-top2-3m-${tid}`} labels={labels} datasets={datasets} />
    </ChartCard>
  );
}

function Recommendations({ data }) {
  if (!data) return null;
  const { top_trx = [], top_margin = [], segmen_masalah = [], anomali = [], summary } = data;
  const totTrx    = n(summary?.total_trx);
  const top2Trx   = n(top_trx[0]?.jun_trx) + n(top_trx[1]?.jun_trx);
  const pctTrx    = totTrx > 0 ? ((top2Trx / totTrx) * 100).toFixed(1) : '—';
  return (
    <div className="wr-reco-list">
      {top_trx[0] && (
        <div className="wr-reco-card wr-reco-hijau">
          <div className="wr-reco-title">💡 Fokus TRX — {top_trx[0].kategori}</div>
          <div className="wr-reco-body">
            <strong>{top_trx[0]?.kategori}</strong>{top_trx[1] ? <> dan <strong>{top_trx[1]?.kategori}</strong></> : ''}
            {' '}mendominasi <strong>{pctTrx}%</strong> total transaksi.
            Akselerasi akuisisi merchant baru di segmen ini untuk volume lebih tinggi.
          </div>
        </div>
      )}
      {anomali.length > 0 && (
        <div className="wr-reco-card wr-reco-kuning">
          <div className="wr-reco-title">⚠ TRX Naik, Margin Turun — {anomali.length} kategori</div>
          <div className="wr-reco-body">
            {anomali.map(a => a.kategori).join(', ')} — TRX meningkat namun margin justru menurun.
            Indikasi transaksi bernilai rendah mendominasi atau ada pergeseran mix produk.
          </div>
        </div>
      )}
      {segmen_masalah[0] && (
        <div className="wr-reco-card wr-reco-merah">
          <div className="wr-reco-title">🚨 TRX Turun — {segmen_masalah[0].kategori}</div>
          <div className="wr-reco-body">
            Penurunan transaksi signifikan terdeteksi.
            Gap vs bulan lalu: <strong>{fmtDevNum(segmen_masalah[0].dev_mei_jun_trx)} TRX</strong>,
            margin: {fmtDev(segmen_masalah[0].dev_mei_jun_margin)}.
          </div>
        </div>
      )}
    </div>
  );
}

function KatModal({ row, onClose, b1, b2, b3, mtd_info }) {
  if (!row) return null;
  const mtd     = mtd_info;
  const isMtd   = mtd?.is_mtd;
  const mdSufx  = isMtd ? ` (MTD 1-${mtd.max_day})` : '';
  const lb1m    = bulanLabel(b1);
  const lb2m    = bulanLabel(b2) + mdSufx;
  const lb3m    = bulanLabel(b3) + mdSufx;
  return (
    <div className="wr-modal-overlay" onClick={onClose}>
      <div className="wr-modal" onClick={e => e.stopPropagation()}>
        <div className="wr-modal-header">
          <div>
            <div className="wr-modal-title">{row.kategori}</div>
            <div className="wr-modal-sub">Kategori outlet InstaQris{isMtd ? ` · Perbandingan MTD hari 1–${mtd.max_day}` : ''}</div>
          </div>
          <button className="wr-modal-close" onClick={onClose}>✕</button>
        </div>
        {row.is_anomali && <div className="wr-anomali-banner">⚠ TRX naik namun margin turun — indikasi pergeseran mix transaksi bernilai rendah</div>}
        <table className="wr-modal-table">
          <thead><tr><th></th><th>{lb3m}</th><th>{lb2m}</th><th>{lb1m}</th></tr></thead>
          <tbody>
            <tr>
              <td>TRX</td>
              <td>{fmtNum(row.apr_trx)}</td><td>{fmtNum(row.mei_trx)}</td>
              <td><strong style={{ color: ACCENT }}>{fmtNum(row.jun_trx)}</strong></td>
            </tr>
            <tr>
              <td>Margin</td>
              <td>{fmtRp(row.apr_margin)}</td><td>{fmtRp(row.mei_margin)}</td>
              <td><strong style={{ color: GREEN }}>{fmtRp(row.jun_margin)}</strong></td>
            </tr>
            <tr style={{ opacity: 0.7, fontSize: '0.92em' }}>
              <td>Omzet</td>
              <td>{fmtRp(row.apr_rev)}</td><td>{fmtRp(row.mei_rev)}</td>
              <td>{fmtRp(row.jun_rev)}</td>
            </tr>
            <tr style={{ opacity: 0.7, fontSize: '0.92em' }}>
              <td>Merchant</td>
              <td>{fmtNum(row.apr_merchant)}</td><td>{fmtNum(row.mei_merchant)}</td>
              <td>{fmtNum(row.jun_merchant)}</td>
            </tr>
          </tbody>
        </table>
        <div className="wr-dev-boxes">
          {[
            { label: `DEV ${lb3m}→${lb1m}`, trx: row.dev_apr_jun_trx, margin: row.dev_apr_jun_margin, m: row.dev_apr_jun_merchant },
            { label: `DEV ${lb2m}→${lb1m}`, trx: row.dev_mei_jun_trx, margin: row.dev_mei_jun_margin, m: row.dev_mei_jun_merchant },
          ].map(d => (
            <div key={d.label} className={`wr-dev-box ${n(d.trx) >= 0 && n(d.margin) >= 0 ? 'wr-dev-pos' : 'wr-dev-neg'}`}>
              <div className="wr-dev-label">{d.label}</div>
              <div className="wr-dev-rev" style={{ fontSize: 13 }}>
                TRX: <span style={{ color: n(d.trx) >= 0 ? GREEN : RED }}>{fmtDevNum(d.trx)}</span>
                {' · '}Margin: <span style={{ color: n(d.margin) >= 0 ? GREEN : RED }}>{fmtDev(d.margin)}</span>
              </div>
              <div className="wr-dev-detail">{fmtDevNum(d.m)} merchant</div>
            </div>
          ))}
        </div>
        <div className="wr-modal-chart">
          <div className="wr-no-data-sm" style={{ color: 'var(--text-4)', fontSize: 12 }}>
            <i className="ti ti-chart-line" style={{ marginRight: 4 }} />
            Untuk analisis tren harian, gunakan tab Trendline Harian
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── TAB 0: Executive Summary ─── */
function ExecutiveSummaryTab({ data, loading, onClickRow, b1, b2, b3 }) {
  const [filter, setFilter] = useState('semua');
  const [sort, setSort]     = useState('trx');
  const [search, setSearch] = useState('');

  const displayRows = (() => {
    if (!data?.tabel) return [];
    let rows = [...data.tabel];
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(r => r.kategori.toLowerCase().includes(q));
    }
    if (filter === 'tumbuh')  rows = rows.filter(r => n(r.dev_mei_jun_trx) > 0);
    if (filter === 'turun')   rows = rows.filter(r => n(r.dev_mei_jun_trx) < 0);
    if (filter === 'anomali') rows = rows.filter(r => r.is_anomali);
    if (filter === 'pos_all') rows = rows.filter(r => n(r.dev_mei_jun_trx) > 0 && n(r.dev_mei_jun_margin) > 0);
    if (filter === 'top10')   rows = rows.slice(0, 10);
    if (sort === 'efficiency') {
      return [...rows].sort((a, b) => {
        const ea = n(a.jun_trx) > 0 ? n(a.jun_margin) / n(a.jun_trx) : 0;
        const eb = n(b.jun_trx) > 0 ? n(b.jun_margin) / n(b.jun_trx) : 0;
        return eb - ea;
      });
    }
    const sk = {
      trx:        'jun_trx',
      margin:     'jun_margin',
      rev:        'jun_rev',
      dev_trx:    'dev_mei_jun_trx',
      dev_margin: 'dev_mei_jun_margin',
      merchant:   'jun_merchant',
    }[sort] || 'jun_trx';
    return [...rows].sort((a, b) => n(b[sk]) - n(a[sk]));
  })();

  const maxTopTrx  = n(data?.top_trx?.[0]?.jun_trx);
  const maxMargin  = n(data?.top_margin?.[0]?.jun_margin);
  const maxGrowth  = n(data?.top_growth?.[0]?.dev_mei_jun_trx);
  const maxMasalah = Math.abs(n(data?.segmen_masalah?.[0]?.dev_mei_jun_trx));
  const tid        = b1 || 'x';
  const lb1        = bulanLabel(b1);
  const mtd        = data?.mtd_info;
  const isMtd      = mtd?.is_mtd;
  const mdSufx     = isMtd ? ` MTD-${mtd.max_day}` : '';
  const lb2        = bulanLabel(b2) + mdSufx;
  const lb3        = bulanLabel(b3) + mdSufx;

  return (
    <div>
      {!loading && isMtd && (
        <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8, padding: '8px 14px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#1D4ED8' }}>
          <i className="ti ti-calendar-stats" />
          <span>
            <strong>Perbandingan MTD (Month-to-Date)</strong> — {bulanLabel(b2)} & {bulanLabel(b3)} hanya dihitung s/d hari ke-{mtd.max_day}
            agar head-to-head dengan {lb1} yang baru tersedia sampai <strong>{mtd.max_tgl}</strong>
          </span>
        </div>
      )}
      {loading ? <SkeletonCards /> : <SummaryCards s={data?.summary} bulanLabel={lb1} />}
      {!loading && data && (
        <>
          <div className="wr-panels">
            <div className="wr-panel">
              <div className="wr-panel-title" style={{ color: ACCENT }}>Top TRX {lb1}</div>
              {(data.top_trx || []).map((row, i) => <RankRow key={row.kategori} item={row} idx={i} maxVal={maxTopTrx} color={ACCENT} metric="trx" />)}
            </div>
            <div className="wr-panel">
              <div className="wr-panel-title" style={{ color: GREEN }}>Top Margin {lb1}</div>
              {(data.top_margin || []).map((row, i) => <RankRow key={row.kategori} item={row} idx={i} maxVal={maxMargin} color={GREEN} metric="margin" />)}
            </div>
            <div className="wr-panel">
              <div className="wr-panel-title" style={{ color: RED }}>TRX Turun Terbanyak</div>
              {(data.segmen_masalah || []).slice(0, 10).map((row, i) => <RankRow key={row.kategori} item={row} idx={i} maxVal={maxMasalah} color={RED} metric="dev_trx" />)}
              {!data.segmen_masalah?.length && <div className="wr-empty-panel">Semua kategori TRX positif ✓</div>}
            </div>
          </div>

          <div className="wr-table-section">
            <div className="wr-table-controls" style={{ flexWrap: 'wrap', gap: 8 }}>
              <div className="wr-table-left" style={{ flexWrap: 'wrap', gap: 6 }}>
                <input
                  type="text" className="wri-tbl-search"
                  placeholder="🔍 Cari kategori..."
                  value={search} onChange={e => setSearch(e.target.value)}
                />
                <select className="wr-select" value={sort} onChange={e => setSort(e.target.value)}>
                  <option value="trx">Sort: TRX ↓</option>
                  <option value="margin">Sort: Margin ↓</option>
                  <option value="dev_trx">Sort: DEV TRX ↓</option>
                  <option value="dev_margin">Sort: DEV Margin ↓</option>
                  <option value="efficiency">Sort: Margin/TRX ↓</option>
                  <option value="rev">Sort: Omzet ↓</option>
                  <option value="merchant">Sort: Merchant ↓</option>
                </select>
                <span className="wr-count">{displayRows.length} kategori{search ? ` (filter "${search}")` : ''}</span>
              </div>
              <div className="wr-filter-tabs">
                {[
                  ['semua','Semua'],
                  ['tumbuh','TRX Naik'],
                  ['turun','TRX Turun'],
                  ['pos_all','TRX+Margin Naik'],
                  ['anomali','⚠ Anomali'],
                  ['top10','Top 10'],
                ].map(([k,l]) => (
                  <button key={k} className={`wr-filter-tab${filter===k?' active':''}`} onClick={() => setFilter(k)}>{l}</button>
                ))}
              </div>
            </div>
            <div className="wr-table-wrap">
              <table className="wr-table">
                <thead>
                  <tr>
                    <th>#</th><th>Kategori</th>
                    <th>TRX {lb1}</th>
                    <th>Margin {lb1}</th>
                    <th style={{ color: 'var(--text-3)', fontWeight: 500 }}>Omzet {lb1}</th>
                    <th>DEV TRX<br/><span style={{ fontWeight: 400, fontSize: 10, color: 'var(--text-3)' }}>{lb2}→{lb1}</span></th>
                    <th>DEV Margin<br/><span style={{ fontWeight: 400, fontSize: 10, color: 'var(--text-3)' }}>{lb2}→{lb1}</span></th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row, i) => {
                    const devMei = n(row.dev_mei_jun_rev), devApr = n(row.dev_apr_jun_rev);
                    return (
                      <tr key={row.kategori} className="wr-tr-clickable" onClick={() => onClickRow(row)}>
                        <td>{i + 1}</td>
                        <td><span className="wr-segmen-name">{row.kategori}</span></td>
                        <td style={{ fontWeight: 700, color: ACCENT }}>{fmtNum(row.jun_trx)}</td>
                        <td style={{ fontWeight: 700, color: GREEN }}>{fmtRp(row.jun_margin)}</td>
                        <td style={{ color: 'var(--text-3)', fontSize: '0.9em' }}>{fmtRp(row.jun_rev)}</td>
                        <td style={{ fontWeight: 600, color: n(row.dev_mei_jun_trx) >= 0 ? GREEN : RED }}>{fmtDevNum(row.dev_mei_jun_trx)}</td>
                        <td style={{ fontWeight: 600, color: n(row.dev_mei_jun_margin) >= 0 ? GREEN : RED }}>{fmtDev(row.dev_mei_jun_margin)}</td>
                        <td><StatusPill row={row} /></td>
                      </tr>
                    );
                  })}
                  {!displayRows.length && (
                    <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--text-4)' }}>
                      {data?.tabel?.length ? 'Tidak ada data untuk filter ini' : 'Belum ada data — jalankan sync dari Apps Script'}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="wr-analysis-grid">
            <div className="wr-analysis-panel">
              <div className="wr-panel-title">Top 3 Kategori TRX — 3 Bulan</div>
              <Top2BulanChart data={data} tid={tid} b1={b1} b2={b2} b3={b3} mtd={mtd} />
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
function TrendlineTab({ activeBulan }) {
  const [days, setDays]          = useState(30);
  const [metric, setMetric]      = useState('trx');
  const [trendData, setTrend]    = useState(null);
  const [loading, setLoading]    = useState(true);
  const [error, setError]        = useState(null);
  const [visibleKat, setVisible] = useState(new Set());
  const [search, setSearch]      = useState('');
  const [expanded, setExpanded]  = useState(false);

  useEffect(() => {
    setLoading(true);
    getDataRawTrendline(days, activeBulan)
      .then(d => {
        setTrend(d);
        setVisible(new Set(d.segments.slice(0, 8).map(s => s.kategori)));
        setError(null);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [days, activeBulan]);

  const toggleKat = (kat) => setVisible(prev => {
    const next = new Set(prev);
    if (next.has(kat)) next.delete(kat); else next.add(kat);
    return next;
  });

  if (loading) return <div className="wri-state">Memuat trendline...</div>;
  if (error)   return <div className="wri-state wri-state--error">{error}</div>;
  if (!trendData?.dates?.length) return <div className="wri-state">Belum ada data — pastikan iq_raw_trx sudah disync</div>;

  const chartId = `iq-raw-tl-${days}-${metric}-${visibleKat.size}-${[...visibleKat][0]?.slice(0,8) || ''}`;

  const filtered   = trendData.segments.filter(s =>
    !search || s.kategori.toLowerCase().includes(search.toLowerCase())
  );
  const MAX_VISIBLE = 10;
  const showExpand  = !search && filtered.length > MAX_VISIBLE;
  const displaySegs = search ? filtered : (expanded ? filtered : filtered.slice(0, MAX_VISIBLE));

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
          {[['trx','TRX'],['margin','Margin'],['rev','Omzet'],['merchant','Merchant']].map(([k,l]) => (
            <button key={k} className={`wri-filter-btn${metric===k?' wri-filter-btn--active':''}`} onClick={() => setMetric(k)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="wri-seg-selector">
        <div className="wri-seg-header">
          <span className="wri-seg-title">
            Kategori <span className="wri-seg-count">{visibleKat.size} aktif</span>
          </span>
          <input
            className="wri-seg-search"
            placeholder="Cari kategori..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button className="wri-seg-clear" onClick={() => setVisible(new Set())}>Hapus semua</button>
        </div>
        <div className="wri-chip-row">
          {displaySegs.map(s => {
            const i  = trendData.segments.indexOf(s);
            const on = visibleKat.has(s.kategori);
            return (
              <button
                key={s.kategori}
                className={`wri-chip${on ? ' wri-chip--on' : ''}`}
                style={on ? { borderColor: LINE_COLORS[i % LINE_COLORS.length], background: LINE_COLORS[i % LINE_COLORS.length] + '22', color: LINE_COLORS[i % LINE_COLORS.length] } : {}}
                onClick={() => toggleKat(s.kategori)}
              >
                {s.kategori}
              </button>
            );
          })}
          {showExpand && (
            <button className="wri-chip wri-chip--expand" onClick={() => setExpanded(e => !e)}>
              {expanded ? '‹ Sembunyikan' : `+${filtered.length - MAX_VISIBLE} lainnya`}
            </button>
          )}
        </div>
      </div>

      <ChartCard title="" height="340px">
        <MultiLineKat
          id={chartId}
          dates={trendData.dates}
          byKategori={trendData.byKategori}
          visibleKat={visibleKat}
          metric={metric}
          segments={trendData.segments}
        />
      </ChartCard>
    </div>
  );
}

/* ─── TAB 2: Trend & Growth ─── */
function TrendGrowthTab({ data, tid, b1, b2, b3 }) {
  if (!data?.tabel?.length) return <div className="wri-state">Belum ada data</div>;

  const all  = data.tabel;
  const top5 = [...all].filter(r => n(r.dev_mei_jun_rev) > 0).sort((a,b) => n(b.dev_mei_jun_rev) - n(a.dev_mei_jun_rev)).slice(0, 5);
  const bot5 = [...all].filter(r => n(r.dev_mei_jun_rev) < 0).sort((a,b) => n(a.dev_mei_jun_rev) - n(b.dev_mei_jun_rev)).slice(0, 5);
  const top10 = [...all].sort((a,b) => n(b.jun_rev) - n(a.jun_rev)).slice(0, 10);
  const lb1 = bulanLabel(b1), lb2 = bulanLabel(b2), lb3 = bulanLabel(b3);

  return (
    <div>
      <div className="wri-2col">
        <div className="wri-panel-box">
          <div className="wri-panel-head" style={{ color: GREEN }}>Top 5 — Pertumbuhan Omzet ({lb2}→{lb1})</div>
          <table className="wri-mini-table">
            <thead><tr><th>#</th><th>Kategori</th><th>DEV Omzet</th><th>DEV Merchant</th></tr></thead>
            <tbody>
              {top5.map((r, i) => (
                <tr key={r.kategori}>
                  <td style={{ color: GREEN, fontWeight: 700 }}>{i + 1}</td>
                  <td>{r.kategori}</td>
                  <td style={{ color: GREEN, fontWeight: 600 }}>{fmtDev(r.dev_mei_jun_rev)}</td>
                  <td style={{ color: n(r.dev_mei_jun_merchant) >= 0 ? GREEN : RED }}>{fmtDev(r.dev_mei_jun_merchant)}</td>
                </tr>
              ))}
              {!top5.length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-4)', padding: 12 }}>Tidak ada kategori tumbuh</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="wri-panel-box">
          <div className="wri-panel-head" style={{ color: RED }}>Bottom 5 — Penurunan Omzet ({lb2}→{lb1})</div>
          <table className="wri-mini-table">
            <thead><tr><th>#</th><th>Kategori</th><th>DEV Omzet</th><th>DEV Merchant</th></tr></thead>
            <tbody>
              {bot5.map((r, i) => (
                <tr key={r.kategori}>
                  <td style={{ color: RED, fontWeight: 700 }}>{i + 1}</td>
                  <td>{r.kategori}{r.is_anomali && <span className="pill-anomali" style={{ marginLeft: 4, fontSize: 9 }}>⚠</span>}</td>
                  <td style={{ color: RED, fontWeight: 600 }}>{fmtDev(r.dev_mei_jun_rev)}</td>
                  <td style={{ color: n(r.dev_mei_jun_merchant) >= 0 ? GREEN : RED }}>{fmtDev(r.dev_mei_jun_merchant)}</td>
                </tr>
              ))}
              {!bot5.length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-4)', padding: 12 }}>Tidak ada kategori turun</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <ChartCard title={`Top 10 Kategori — Omzet ${lb3} / ${lb2} / ${lb1}`} height="300px" style={{ marginTop: 16 }}>
        <GroupedBarKat
          id={`iq-rev3-${tid}`}
          labels={top10.map(r => r.kategori.length > 18 ? r.kategori.slice(0, 18) + '…' : r.kategori)}
          datasets={[
            { label: lb3, data: top10.map(r => n(r.apr_rev)), backgroundColor: '#94A3B8', borderRadius: 2 },
            { label: lb2, data: top10.map(r => n(r.mei_rev)), backgroundColor: '#CBD5E1', borderRadius: 2 },
            { label: lb1, data: top10.map(r => n(r.jun_rev)), backgroundColor: ACCENT,    borderRadius: 2 },
          ]}
        />
      </ChartCard>

      <ChartCard title="Quadrant — DEV Merchant vs DEV Omzet (Prev→Cur)" height="300px" style={{ marginTop: 16 }}>
        <ScatterKat id={`iq-scatter-${tid}`} rows={all} />
      </ChartCard>
    </div>
  );
}

/* ─── TAB 3: Unit Ekonomi ─── */
function UnitEkonomiTab({ data, tid, b1, b2 }) {
  if (!data?.tabel?.length) return <div className="wri-state">Belum ada data</div>;

  const rows   = data.tabel.filter(r => n(r.jun_trx) > 0 || n(r.jun_rev) > 0);
  const sorted = [...rows].sort((a,b) => n(b.jun_rev) - n(a.jun_rev));
  const lb1 = bulanLabel(b1), lb2 = bulanLabel(b2);

  const totRev  = rows.reduce((s,r) => s + n(r.jun_rev), 0);
  const totRevM = rows.reduce((s,r) => s + n(r.mei_rev), 0);
  const totTrx  = rows.reduce((s,r) => s + n(r.jun_trx), 0);
  const totMerc = rows.reduce((s,r) => s + n(r.jun_merchant), 0);
  const arptT   = calcArpt(totRev, totTrx);
  const rpmT    = calcRpm(totRev, totMerc);

  const top5Rev     = sorted.slice(0, 5);
  const othersRev   = totRev - top5Rev.reduce((s,r) => s + n(r.jun_rev), 0);
  const donutLabels = [...top5Rev.map(r => r.kategori.length > 20 ? r.kategori.slice(0, 20) + '…' : r.kategori), 'Lainnya'];
  const donutValues = [...top5Rev.map(r => n(r.jun_rev)), othersRev];

  const arptRanked = [...rows]
    .map(r => ({ ...r, arpt_jun: calcArpt(r.jun_rev, r.jun_trx) }))
    .filter(r => r.arpt_jun > 0)
    .sort((a,b) => b.arpt_jun - a.arpt_jun)
    .slice(0, 10);

  return (
    <div>
      <div className="wri-kpi-grid">
        <KPICard label={`Total Omzet (${lb1})`} value={fmtRp(totRev)} sub={`${fmtDev(totRev - totRevM)} vs ${lb2}`} badge={totRev >= totRevM ? '▲' : '▼'} badgeColor={totRev >= totRevM ? GREEN : RED} />
        <KPICard label="ARPT (Omzet/TRX)" value={fmtRp(arptT)} sub="Rata-rata semua kategori aktif" />
        <KPICard label="Omzet per Merchant" value={fmtRp(rpmT)} sub="Avg omzet per merchant aktif" />
        <KPICard label="Kategori Aktif" value={fmtNum(rows.length)} sub={`${rows.filter(r => n(r.jun_trx) > 0).length} bertransaksi`} />
      </div>

      <div className="wri-2col" style={{ marginTop: 16 }}>
        <ChartCard title={`Top 10 Kategori — ARPT (Omzet/TRX) ${lb1}`} height="270px">
          <HBarKat
            id={`iq-arpt-${tid}`}
            labels={arptRanked.map(r => r.kategori.length > 20 ? r.kategori.slice(0, 20) + '…' : r.kategori)}
            values={arptRanked.map(r => r.arpt_jun)}
            formatFn={fmtRp}
            color={ACCENT}
          />
        </ChartCard>
        <ChartCard title={`Konsentrasi Omzet ${lb1}`} height="270px">
          <DonutKat
            id={`iq-donut-${tid}`}
            labels={donutLabels}
            values={donutValues}
            colors={[ACCENT, BLUE, GREEN, '#F59E0B', '#8B5CF6', '#9CA3AF']}
          />
        </ChartCard>
      </div>

      <div className="wr-table-wrap" style={{ marginTop: 16 }}>
        <table className="wr-table">
          <thead>
            <tr>
              <th>#</th><th>Kategori</th>
              <th>Merchant {lb1}</th><th>TRX {lb1}</th>
              <th>Omzet {lb1}</th><th>ARPT {lb1}</th><th>ARPT {lb2}</th><th>DEV ARPT</th>
              <th>Omzet/Merchant</th><th>% Omzet</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => {
              const arptJ  = calcArpt(r.jun_rev, r.jun_trx);
              const arptM  = calcArpt(r.mei_rev, r.mei_trx);
              const rpm    = calcRpm(r.jun_rev, r.jun_merchant);
              const pct    = totRev > 0 ? ((n(r.jun_rev) / totRev) * 100).toFixed(1) : '0.0';
              const devArpt = arptJ - arptM;
              return (
                <tr key={r.kategori}>
                  <td>{i + 1}</td>
                  <td>{r.kategori}</td>
                  <td>{fmtNum(r.jun_merchant)}</td>
                  <td>{fmtNum(r.jun_trx)}</td>
                  <td style={{ color: GREEN, fontWeight: 600 }}>{fmtRp(r.jun_rev)}</td>
                  <td style={{ fontWeight: 600 }}>{fmtRp(arptJ)}</td>
                  <td style={{ color: 'var(--text-3)' }}>{fmtRp(arptM)}</td>
                  <td style={{ color: devArpt >= 0 ? GREEN : RED, fontWeight: 600 }}>{fmtDev(devArpt)}</td>
                  <td>{fmtRp(rpm)}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ flex: 1, height: 8, background: '#F1F5F9', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: ACCENT + 'CC', borderRadius: 4 }} />
                      </div>
                      <span style={{ fontSize: 11, minWidth: 36, textAlign: 'right' }}>{pct}%</span>
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
  // Anomali: TRX naik tapi margin turun
  const anomali = all.filter(r => r.is_anomali);
  // Kritis: TRX turun dan bukan anomali
  const kritis  = all.filter(r => n(r.dev_mei_jun_trx) < 0 && !r.is_anomali)
                     .sort((a,b) => n(a.dev_mei_jun_trx) - n(b.dev_mei_jun_trx)).slice(0, 5);
  // Tumbuh: TRX naik dan margin naik
  const growth  = all.filter(r => n(r.dev_mei_jun_trx) > 0 && n(r.dev_mei_jun_margin) > 0)
                     .sort((a,b) => n(b.dev_mei_jun_margin) - n(a.dev_mei_jun_margin)).slice(0, 5);
  // Peluang: TRX naik tapi kontribusi margin masih kecil
  const totMargin = n(data.summary?.total_margin);
  const peluang = all.filter(r => n(r.dev_mei_jun_trx) > 0 && n(r.jun_margin) < totMargin * 0.05 && n(r.jun_margin) > 0)
                     .sort((a,b) => n(b.dev_mei_jun_trx) - n(a.dev_mei_jun_trx)).slice(0, 5);

  const riskCards = [
    { icon: '🚨', label: 'TRX Turun', count: kritis.length,  color: RED },
    { icon: '⚠️',  label: 'Anomali',   count: anomali.length, color: '#F59E0B' },
    { icon: '📈',  label: 'TRX+Margin Naik', count: growth.length, color: GREEN },
    { icon: '💡',  label: 'Peluang',   count: peluang.length, color: ACCENT },
  ];

  return (
    <div>
      <div className="wri-risk-row">
        {riskCards.map(r => (
          <div key={r.label} className="wri-risk-card" style={{ borderTop: `3px solid ${r.color}` }}>
            <span style={{ fontSize: 24 }}>{r.icon}</span>
            <span className="wri-risk-count" style={{ color: r.color }}>{r.count}</span>
            <span className="wri-risk-label">{r.label}</span>
          </div>
        ))}
      </div>

      {kritis.length > 0 && (
        <div className="wri-action-block" style={{ borderLeft: `4px solid ${RED}` }}>
          <div className="wri-action-block-head" style={{ color: RED }}>🚨 Wajib Diselamatkan — TRX Turun ({kritis.length} kategori)</div>
          {kritis.map((r, i) => (
            <div key={r.kategori} className="wri-action-item">
              <div className="wri-action-item-hd">
                <span className="wri-action-num" style={{ background: RED }}>{i + 1}</span>
                <span className="wri-action-name">{r.kategori}</span>
                <span className="wri-action-badge wri-badge-danger">TRX {fmtDevNum(r.dev_mei_jun_trx)}</span>
              </div>
              <div className="wri-action-steps">
                <span>① Identifikasi merchant aktif yang berhenti bertransaksi</span>
                <span>② Hubungi top merchant di kategori ini dalam 24 jam</span>
                <span>③ Analisis penyebab: kompetitor, masalah teknis, atau seasonal</span>
                <span>④ Target recovery: TRX {fmtNum(r.mei_trx)} (level bulan lalu)</span>
              </div>
              <div className="wri-action-stat">
                TRX: {fmtNum(r.mei_trx)} → {fmtNum(r.jun_trx)} &nbsp;·&nbsp;
                Margin: {fmtRp(r.mei_margin)} → {fmtRp(r.jun_margin)}
              </div>
            </div>
          ))}
        </div>
      )}

      {anomali.length > 0 && (
        <div className="wri-action-block" style={{ borderLeft: `4px solid #F59E0B` }}>
          <div className="wri-action-block-head" style={{ color: '#D97706' }}>⚠️ Wajib Diinvestigasi — TRX Naik tapi Margin Turun ({anomali.length} kategori)</div>
          {anomali.map((r, i) => (
            <div key={r.kategori} className="wri-action-item">
              <div className="wri-action-item-hd">
                <span className="wri-action-num" style={{ background: '#F59E0B' }}>{i + 1}</span>
                <span className="wri-action-name">{r.kategori}</span>
                <span className="wri-action-badge wri-badge-warn">
                  TRX {fmtDevNum(r.dev_mei_jun_trx)} · Margin {fmtDev(r.dev_mei_jun_margin)}
                </span>
              </div>
              <div className="wri-action-steps">
                <span>① Volume naik tapi margin per TRX turun — cek mix jenis transaksi</span>
                <span>② Kemungkinan: dominasi transaksi nominal kecil atau produk margin rendah</span>
                <span>③ Dorong merchant ke transaksi bernilai lebih tinggi atau kategori produk premium</span>
              </div>
              <div className="wri-action-stat">
                TRX: {fmtNum(r.mei_trx)} → {fmtNum(r.jun_trx)} ({fmtDevNum(r.dev_mei_jun_trx)}) &nbsp;·&nbsp;
                Margin: {fmtRp(r.mei_margin)} → {fmtRp(r.jun_margin)} ({fmtDev(r.dev_mei_jun_margin)})
              </div>
            </div>
          ))}
        </div>
      )}

      {growth.length > 0 && (
        <div className="wri-action-block" style={{ borderLeft: `4px solid ${GREEN}` }}>
          <div className="wri-action-block-head" style={{ color: GREEN }}>📈 Wajib Dihubungi — TRX dan Margin Tumbuh ({growth.length} kategori)</div>
          <div className="wri-action-2col">
            {growth.map((r, i) => (
              <div key={r.kategori} className="wri-action-item">
                <div className="wri-action-item-hd">
                  <span className="wri-action-num" style={{ background: GREEN }}>{i + 1}</span>
                  <span className="wri-action-name">{r.kategori}</span>
                  <span className="wri-action-badge wri-badge-success">Margin {fmtDev(r.dev_mei_jun_margin)}</span>
                </div>
                <div className="wri-action-steps">
                  <span>① Dokumentasikan best practice — apa yang berjalan baik</span>
                  <span>② Replikasi strategi ke kategori lain dengan profil serupa</span>
                </div>
                <div className="wri-action-stat">
                  TRX: {fmtNum(r.jun_trx)} ({fmtDevNum(r.dev_mei_jun_trx)}) &nbsp;·&nbsp; Margin: {fmtRp(r.jun_margin)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {peluang.length > 0 && (
        <div className="wri-action-block" style={{ borderLeft: `4px solid ${ACCENT}` }}>
          <div className="wri-action-block-head" style={{ color: ACCENT }}>💡 Kategori Peluang — TRX Tumbuh tapi Kontribusi Margin Masih Kecil</div>
          <div className="wri-action-2col">
            {peluang.map((r, i) => (
              <div key={r.kategori} className="wri-action-item">
                <div className="wri-action-item-hd">
                  <span className="wri-action-num" style={{ background: ACCENT }}>{i + 1}</span>
                  <span className="wri-action-name">{r.kategori}</span>
                  <span className="wri-action-badge wri-badge-info">TRX {fmtDevNum(r.dev_mei_jun_trx)}</span>
                </div>
                <div className="wri-action-stat">
                  TRX: {fmtNum(r.jun_trx)} &nbsp;·&nbsp; Margin: {fmtRp(r.jun_margin)} &nbsp;·&nbsp; Potensi ekspansi merchant
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Persistent Summary Cards (always above tabs) ─── */
function TopSummaryCards({ summary, loading }) {
  if (loading && !summary) return (
    <div className="wri-top-cards">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="wri-tc wr-skeleton"><div className="wr-sk-line wr-sk-short" /><div className="wr-sk-line wr-sk-long" /></div>
      ))}
    </div>
  );
  if (!summary) return null;
  const s = summary;
  const devTrx    = n(s.dev_trx_mei_jun);
  const devMargin = n(s.dev_margin_mei_jun);
  const cards = [
    { label: 'Total TRX', val: fmtNum(s.total_trx), color: ACCENT,
      dev: <span style={{ color: devTrx >= 0 ? GREEN : RED }}>{fmtDevNum(devTrx)} TRX vs bln lalu</span> },
    { label: 'Total Margin', val: fmtRp(s.total_margin), color: GREEN,
      dev: <span style={{ color: devMargin >= 0 ? GREEN : RED }}>{fmtDev(devMargin)} vs bln lalu</span> },
    { label: 'Total Omzet', val: fmtRp(s.total_rev), color: BLUE },
    { label: 'Merchant Aktif', val: fmtNum(s.total_merchant), color: 'var(--text-1)',
      dev: <span style={{ color: 'var(--text-3)' }}>{s.segmen_aktif} kategori aktif</span> },
    { label: 'TRX Tumbuh', val: fmtNum(s.segmen_tumbuh), color: GREEN,
      dev: <span style={{ color: 'var(--text-3)' }}>kategori vs bln lalu</span> },
    { label: 'TRX Turun', val: fmtNum(s.segmen_turun), color: RED,
      dev: <span style={{ color: 'var(--text-3)' }}>kategori vs bln lalu</span> },
  ];
  return (
    <div className="wri-top-cards">
      {cards.map((c, i) => (
        <div key={i} className="wri-tc" style={{ borderTopColor: c.color }}>
          <div className="wri-tc-label">{c.label}</div>
          <div className="wri-tc-val" style={{ color: c.color }}>{c.val}</div>
          {c.dev && <div className="wri-tc-dev">{c.dev}</div>}
        </div>
      ))}
    </div>
  );
}

/* ─── Main Page ─── */
export default function WarRoomIqRaw() {
  const [tab,         setTab]     = useState(0);
  const [data,        setData]    = useState(null);
  const [loading,     setLoading] = useState(true);
  const [error,       setError]   = useState(null);
  const [bulan,       setBulan]   = useState('');
  const [bulanList,   setBulanList] = useState([]);
  const [modalRow,    setModalRow]  = useState(null);
  const [lastUpdated, setLastUpd]   = useState(null);
  const [tglDari,     setTglDari]   = useState('');
  const [tglSampai,   setTglSampai] = useState('');
  // Refs untuk dipakai di fetchData tanpa jadi dep (hindari re-fetch saat input berubah)
  const tglDariRef   = useRef('');
  const tglSampaiRef = useRef('');

  const handleSetTglDari = (v) => { tglDariRef.current = v; setTglDari(v); };
  const handleSetTglSampai = (v) => { tglSampaiRef.current = v; setTglSampai(v); };
  const resetDateRange = () => { handleSetTglDari(''); handleSetTglSampai(''); };

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = { bulan: bulan || undefined };
      const d = tglDariRef.current, s = tglSampaiRef.current;
      if (d && s && d <= s) { params.tgl_dari = d; params.tgl_sampai = s; }
      const res = await getDataRawAnalytics(params);
      setData(res);
      if (res.bulan_list?.length) setBulanList(res.bulan_list);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Gagal memuat data');
    } finally { setLoading(false); setLastUpd(new Date()); }
  }, [bulan]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const isDateRange = !!(tglDari && tglSampai && tglDari <= tglSampai);
  const TABS = ['Executive Summary', 'Trendline Harian', 'Trend & Growth', 'Unit Ekonomi', 'Action Center'];
  const activeBulan = data?.b1 || bulan || '';
  const b1 = data?.b1 || '', b2 = data?.b2 || '', b3 = data?.b3 || '';
  const tid = activeBulan;

  return (
    <Layout>
      <div className="wr-page">

        <div className="wr-header">
          <div>
            <div className="wr-title-row">
              <span className="wr-icon" style={{ color: ACCENT }}>📊</span>
              <h1 className="wr-title">WAR-ROOM Analitik</h1>
              <span className="war-badge" style={{ background: ACCENT }}>IQ RAW</span>
              {isDateRange && <span className="wri-range-badge">📅 Range Aktif</span>}
            </div>
            <p className="wr-sub">
              {isDateRange
                ? <>Filter: <strong>{tglDari}</strong> s/d <strong>{tglSampai}</strong> · Bandingkan dengan periode sama bulan sebelumnya</>
                : <>Segmentasi kategori outlet InstaQris · Bulan: {bulanLabel(activeBulan) || '–'}</>}
              {lastUpdated && <span style={{ marginLeft: 8, color: 'var(--text-4)' }}>· {lastUpdated.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
            </p>
          </div>
          <div className="wr-header-right">
            <div className="wri-date-range">
              <span className="wri-dr-label">Dari</span>
              <input type="date" className="wr-select wri-date-input" value={tglDari}
                onChange={e => handleSetTglDari(e.target.value)} />
              <span className="wri-dr-label">–</span>
              <input type="date" className="wr-select wri-date-input" value={tglSampai}
                onChange={e => handleSetTglSampai(e.target.value)} />
              {(tglDari || tglSampai) && (
                <button className="wri-dr-reset" onClick={resetDateRange} title="Reset filter tanggal">✕</button>
              )}
            </div>
            <select className="wr-select" value={bulan} onChange={e => setBulan(e.target.value)}>
              <option value="">Terkini</option>
              {bulanList.map(b => <option key={b} value={b}>{bulanLabel(b)}</option>)}
            </select>
            <button className="wr-btn-update" onClick={fetchData} disabled={loading}>
              {loading
                ? <><i className="ti ti-loader-2" style={{ animation: 'aic-rotate 0.8s linear infinite' }} /> Memuat...</>
                : <><i className="ti ti-refresh" /> Update Data</>
              }
            </button>
          </div>
        </div>

        <TopSummaryCards summary={data?.summary} loading={loading} />

        <div className="war-tabs">
          {TABS.map((t, i) => (
            <button key={i} className={`war-tab${tab === i ? ' active' : ''}`} onClick={() => setTab(i)}>{t}</button>
          ))}
        </div>

        {error && !loading && (
          <div className="wr-error">
            <i className="ti ti-alert-circle" /> {error}
            <button className="wr-btn-retry" onClick={fetchData}>Coba Lagi</button>
          </div>
        )}

        <div className="wri-tab-content">
          {tab === 0 && <ExecutiveSummaryTab data={data} loading={loading} onClickRow={setModalRow} b1={b1} b2={b2} b3={b3} />}
          {tab === 1 && <TrendlineTab activeBulan={activeBulan} />}
          {tab === 2 && (loading ? <SkeletonCards /> : data && <TrendGrowthTab data={data} tid={tid} b1={b1} b2={b2} b3={b3} />)}
          {tab === 3 && (loading ? <SkeletonCards /> : data && <UnitEkonomiTab data={data} tid={tid} b1={b1} b2={b2} />)}
          {tab === 4 && (loading ? <SkeletonCards /> : data && <ActionCenterTab data={data} />)}
        </div>

      </div>
      <KatModal row={modalRow} onClose={() => setModalRow(null)} b1={b1} b2={b2} b3={b3} mtd_info={data?.mtd_info} />
    </Layout>
  );
}
