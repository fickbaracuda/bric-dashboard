import { useState, useEffect, useRef } from 'react';
import Layout from '../components/Layout';
import Chart from 'chart.js/auto';
import { getPAProdukAnalytics } from '../services/api';

const THEME = '#639922';
const RED   = '#E24B4A';
const GRAY  = '#9CA3AF';

const fmtRp = v => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e9) return `Rp ${(n / 1e9).toFixed(1)}M`;
  if (Math.abs(n) >= 1e6) return `Rp ${(n / 1e6).toFixed(1)}jt`;
  if (Math.abs(n) >= 1e3) return `Rp ${(n / 1e3).toFixed(0)}rb`;
  return `Rp ${n}`;
};
const fmtN   = v => (Number(v) || 0).toLocaleString('id');
const fmtPct = v => { const n = Number(v) || 0; return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`; };
const fmtDate = iso => {
  if (!iso) return '-';
  return new Date(String(iso).substring(0, 10) + 'T12:00:00').toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
};

const gcColor = pct => (Number(pct) || 0) > 0 ? THEME : (Number(pct) || 0) < 0 ? RED : GRAY;
const rowCls  = pct => { const n = Number(pct) || 0; if (n > 0) return 'wrpa-row--positive'; if (n < 0) return 'wrpa-row--negative'; return ''; };

const calcArpt = (rev, trx) => Number(trx) > 0 ? Math.round(Number(rev) / Number(trx)) : 0;
const calcAtpu = (trx, mat) => Number(mat) > 0 ? (Number(trx) / Number(mat)).toFixed(1) : '0.0';
const calcArpu = (rev, mat) => Number(mat) > 0 ? Math.round(Number(rev) / Number(mat)) : 0;

function produkBadge(row) {
  if (Number(row.rev_jun) < Number(row.rev_mei) && Number(row.rev_mei) < Number(row.rev_apr))
    return { label: 'Kritis', cls: 'wrpa-badge--kritis' };
  if (Number(row.pct_rev_growth) > 10)
    return { label: 'Bintang', cls: 'wrpa-badge--bintang' };
  return { label: 'Stabil', cls: 'wrpa-badge--stabil' };
}

/* ─── Chart atoms ─── */
function HBarChart({ id, labels, values, color, formatFn }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: color || THEME, borderRadius: 3 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => formatFn ? formatFn(ctx.parsed.x) : fmtN(ctx.parsed.x) } } },
        scales: { x: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 } } }, y: { ticks: { font: { size: 11 } } } },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function GroupedBar({ id, labels, datasets }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 10 } } },
        scales: { x: { ticks: { font: { size: 10 }, maxRotation: 40 } }, y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 } } } },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function ScatterPlot({ id, products }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !products?.length) return;
    const maxRev = Math.max(...products.map(p => Number(p.rev_jun) || 0), 1);
    const chart = new Chart(ref.current, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Produk',
          data: products.map(p => ({ x: Number(p.pct_trx_growth) || 0, y: Number(p.pct_rev_growth) || 0 })),
          backgroundColor: products.map(p => gcColor(p.pct_rev_growth) + 'BB'),
          pointRadius: products.map(p => Math.max(6, Math.min(20, ((Number(p.rev_jun) || 0) / maxRev) * 20))),
          pointHoverRadius: 12,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => { const p = products[ctx.dataIndex]; return `${p.produk}: TRX ${p.pct_trx_growth != null ? fmtPct(p.pct_trx_growth) : '-'}, Rev ${p.pct_rev_growth != null ? fmtPct(p.pct_rev_growth) : '-'}`; } } },
        },
        scales: {
          x: { title: { display: true, text: '% Growth TRX (Mei→Jun)' }, grid: { color: '#f0f0f0' }, ticks: { callback: v => v + '%' } },
          y: { title: { display: true, text: '% Growth Revenue (Mei→Jun)' }, grid: { color: '#f0f0f0' }, ticks: { callback: v => v + '%' } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function MiniBar({ id, labels, values, color }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: color || THEME, borderRadius: 3 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { font: { size: 10 } } }, y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 10 } } } },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

/* ─── UI atoms ─── */
function KPICard({ label, value, sub, badge, badgeColor }) {
  return (
    <div className="wrpa-kpi-card">
      <div className="wrpa-kpi-label">{label}</div>
      <div className="wrpa-kpi-value">
        {value}
        {badge && <span className="wrpa-kpi-badge" style={{ background: badgeColor || THEME }}>{badge}</span>}
      </div>
      {sub && <div className="wrpa-kpi-sub">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, children, height }) {
  return (
    <div className="wrpa-chart-card">
      {title && <div className="wrpa-chart-title">{title}</div>}
      <div className="wrpa-chart-box" style={height ? { height } : undefined}>{children}</div>
    </div>
  );
}

/* ─── Modal Detail Produk ─── */
function ProdukModal({ row, onClose }) {
  if (!row) return null;
  const badge = produkBadge(row);
  const months = ['April', 'Mei', 'Juni'];
  const trxVals = [Number(row.trx_apr), Number(row.trx_mei), Number(row.trx_jun)];
  const revVals = [Number(row.rev_apr), Number(row.rev_mei), Number(row.rev_jun)];

  const arptJun  = calcArpt(row.rev_jun, row.trx_jun);
  const arptMei  = calcArpt(row.rev_mei, row.trx_mei);
  const arptDelta = arptJun - arptMei;
  const pctTrx   = Number(row.pct_trx_growth) || 0;
  const pctRev   = Number(row.pct_rev_growth) || 0;

  let insight = `TRX ${pctTrx >= 0 ? 'naik' : 'turun'} ${Math.abs(pctTrx).toFixed(1)}% dari Mei ke Juni`;
  insight += pctRev >= 0 ? `, revenue naik ${pctRev.toFixed(1)}%` : `, namun revenue turun ${Math.abs(pctRev).toFixed(1)}%`;
  if (arptDelta !== 0)
    insight += `. ARPT ${arptDelta > 0 ? 'naik' : 'turun'} ${fmtRp(Math.abs(arptDelta))} (${arptDelta > 0 ? 'margin per transaksi meningkat' : 'perlu review pricing atau product mix'})`;
  insight += '.';

  const tblRows = [
    { bulan: 'April', ...{ mat: row.mat_apr, trx: row.trx_apr, rev: row.rev_apr, arpt: calcArpt(row.rev_apr, row.trx_apr), atpu: calcAtpu(row.trx_apr, row.mat_apr), arpu: calcArpu(row.rev_apr, row.mat_apr) } },
    { bulan: 'Mei',   ...{ mat: row.mat_mei, trx: row.trx_mei, rev: row.rev_mei, arpt: arptMei, atpu: calcAtpu(row.trx_mei, row.mat_mei), arpu: calcArpu(row.rev_mei, row.mat_mei) } },
    { bulan: 'Juni',  ...{ mat: row.mat_jun, trx: row.trx_jun, rev: row.rev_jun, arpt: arptJun, atpu: calcAtpu(row.trx_jun, row.mat_jun), arpu: calcArpu(row.rev_jun, row.mat_jun) } },
  ];

  return (
    <div className="wrpa-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="wrpa-modal">
        <div className="wrpa-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="wrpa-modal-title">{row.produk}</div>
            <span className={`wrpa-badge ${badge.cls}`}>{badge.label}</span>
          </div>
          <button className="wrpa-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="wrpa-modal-body">
          <div className="wrpa-modal-insight"><i className="ti ti-sparkles" /> {insight}</div>
          <div className="wrpa-table-wrap" style={{ marginBottom: 16 }}>
            <table className="wrpa-table">
              <thead><tr><th>Bulan</th><th>MAT</th><th>TRX</th><th>Revenue</th><th>ARPT</th><th>ATPU</th><th>ARPU</th></tr></thead>
              <tbody>
                {tblRows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600, color: i === 2 ? THEME : 'inherit' }}>{r.bulan}</td>
                    <td>{fmtN(r.mat)}</td>
                    <td style={{ fontWeight: i === 2 ? 600 : 400 }}>{fmtN(r.trx)}</td>
                    <td style={{ fontWeight: i === 2 ? 600 : 400 }}>{fmtRp(r.rev)}</td>
                    <td>{fmtRp(r.arpt)}</td>
                    <td>{r.atpu}x</td>
                    <td>{fmtRp(r.arpu)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <ChartCard title="Tren TRX" height="130px">
              <MiniBar id={`modal-trx-${row.produk}`} labels={months} values={trxVals} color="#94A3B8" />
            </ChartCard>
            <ChartCard title="Tren Revenue" height="130px">
              <MiniBar id={`modal-rev-${row.produk}`} labels={months} values={revVals} color={THEME} />
            </ChartCard>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Tab 0: Executive Summary ─── */
function ExecutiveSummaryTab({ data, total, meta, onProdukClick }) {
  const tid     = meta.tanggal;
  const top10   = data.slice(0, 10);
  const devTrx  = (total.trx_jun || 0) - (total.trx_mei || 0);
  const devRev  = (total.rev_jun || 0) - (total.rev_mei || 0);
  const pctTrx  = total.trx_mei > 0 ? ((devTrx / total.trx_mei) * 100).toFixed(1) : 0;
  const pctRev  = total.rev_mei > 0 ? ((devRev / total.rev_mei) * 100).toFixed(1) : 0;
  const arptTot = calcArpt(total.rev_jun, total.trx_jun);
  const arptMei = calcArpt(total.rev_mei, total.trx_mei);

  const kpis = [
    { label: 'Total MAT (Jun)', value: fmtN(total.mat_jun), sub: `${total.mat_jun - total.mat_mei >= 0 ? '+' : ''}${fmtN(total.mat_jun - total.mat_mei)} vs Mei`, badge: total.mat_jun >= total.mat_mei ? '▲' : '▼', badgeColor: total.mat_jun >= total.mat_mei ? THEME : RED },
    { label: 'Total TRX (Jun)', value: fmtN(total.trx_jun), sub: `${fmtPct(pctTrx)} vs Mei`, badge: Number(pctTrx) >= 0 ? '▲' : '▼', badgeColor: Number(pctTrx) >= 0 ? THEME : RED },
    { label: 'Total Revenue (Jun)', value: fmtRp(total.rev_jun), sub: `${fmtPct(pctRev)} vs Mei`, badge: Number(pctRev) >= 0 ? '▲' : '▼', badgeColor: Number(pctRev) >= 0 ? THEME : RED },
    { label: 'Rata-rata ARPT', value: fmtRp(arptTot), sub: `${arptTot - arptMei >= 0 ? '+' : ''}${fmtRp(arptTot - arptMei)} vs Mei` },
  ];

  return (
    <div>
      <div className="wrpa-kpi-grid">
        {kpis.map((k, i) => <KPICard key={i} {...k} />)}
      </div>

      <div className="wrpa-charts-2col">
        <ChartCard title="Top 10 Produk — Revenue Juni" height="260px">
          <HBarChart id={`pa-rev-${tid}`} labels={top10.map(r => r.produk)} values={top10.map(r => Number(r.rev_jun))} formatFn={fmtRp} />
        </ChartCard>
        <ChartCard title="Top 10 Produk — TRX Apr / Mei / Jun" height="260px">
          <GroupedBar
            id={`pa-trx3-${tid}`}
            labels={top10.map(r => r.produk)}
            datasets={[
              { label: 'April', data: top10.map(r => Number(r.trx_apr)), backgroundColor: '#94A3B8', borderRadius: 2 },
              { label: 'Mei',   data: top10.map(r => Number(r.trx_mei)), backgroundColor: '#CBD5E1', borderRadius: 2 },
              { label: 'Juni',  data: top10.map(r => Number(r.trx_jun)), backgroundColor: THEME,     borderRadius: 2 },
            ]}
          />
        </ChartCard>
      </div>

      <ChartCard title="Ringkasan Semua Produk — klik baris untuk detail">
        <div className="wrpa-table-wrap">
          <table className="wrpa-table">
            <thead><tr>
              <th>Produk</th><th>MAT Jun</th><th>TRX Jun</th><th>Revenue Jun</th>
              <th>ARPT Jun</th><th>Growth TRX</th><th>Growth Rev</th><th>Status</th>
            </tr></thead>
            <tbody>
              {data.map((row, i) => {
                const badge = produkBadge(row);
                return (
                  <tr key={i} className={rowCls(row.pct_rev_growth)} style={{ cursor: 'pointer' }} onClick={() => onProdukClick(row)}>
                    <td style={{ fontWeight: 600 }}>{row.produk}</td>
                    <td>{fmtN(row.mat_jun)}</td>
                    <td>{fmtN(row.trx_jun)}</td>
                    <td>{fmtRp(row.rev_jun)}</td>
                    <td>{fmtRp(row.arpt_jun)}</td>
                    <td style={{ color: gcColor(row.pct_trx_growth), fontWeight: 600 }}>{row.pct_trx_growth != null ? fmtPct(row.pct_trx_growth) : '-'}</td>
                    <td style={{ color: gcColor(row.pct_rev_growth), fontWeight: 600 }}>{row.pct_rev_growth != null ? fmtPct(row.pct_rev_growth) : '-'}</td>
                    <td><span className={`wrpa-badge ${badge.cls}`}>{badge.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  );
}

/* ─── Tab 1: Trend & Growth ─── */
function TrendGrowthTab({ data, meta }) {
  const tid = meta.tanggal;
  const top5  = [...data].sort((a, b) => (Number(b.pct_trx_growth) || 0) - (Number(a.pct_trx_growth) || 0)).slice(0, 5);
  const bot5  = [...data].sort((a, b) => (Number(a.pct_trx_growth) || 0) - (Number(b.pct_trx_growth) || 0)).slice(0, 5);

  return (
    <div>
      <ChartCard title="Semua Produk — Revenue Apr / Mei / Jun" height="280px">
        <GroupedBar
          id={`pa-revall-${tid}`}
          labels={data.map(r => r.produk)}
          datasets={[
            { label: 'April', data: data.map(r => Number(r.rev_apr)), backgroundColor: '#94A3B8', borderRadius: 2 },
            { label: 'Mei',   data: data.map(r => Number(r.rev_mei)), backgroundColor: '#CBD5E1', borderRadius: 2 },
            { label: 'Juni',  data: data.map(r => Number(r.rev_jun)), backgroundColor: THEME,     borderRadius: 2 },
          ]}
        />
      </ChartCard>

      <div className="wrpa-chart-card">
        <div className="wrpa-chart-title">Scatter Growth: % TRX vs % Revenue (Mei → Jun)</div>
        <div style={{ fontSize: 11, color: '#9CA3AF', marginBottom: 6 }}>
          Ukuran titik = besaran Revenue Juni. Hover untuk detail produk.
          &nbsp;Kanan-atas = Bintang &nbsp;|&nbsp; Kiri-bawah = Perhatian &nbsp;|&nbsp; Kanan-bawah = Volume Naik tapi Rev Turun
        </div>
        <div className="wrpa-chart-box" style={{ height: 260 }}>
          <ScatterPlot id={`pa-scatter-${tid}`} products={data} />
        </div>
      </div>

      <div className="wrpa-charts-2col">
        <div className="wrpa-chart-card">
          <div className="wrpa-chart-title" style={{ color: THEME }}><i className="ti ti-trending-up" /> Top 5 Growth TRX (Mei→Jun)</div>
          <div className="wrpa-table-wrap">
            <table className="wrpa-table">
              <thead><tr><th>Produk</th><th>TRX Mei</th><th>TRX Jun</th><th>Growth</th></tr></thead>
              <tbody>
                {top5.map((r, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{r.produk}</td>
                    <td>{fmtN(r.trx_mei)}</td>
                    <td style={{ color: THEME, fontWeight: 600 }}>{fmtN(r.trx_jun)}</td>
                    <td style={{ color: gcColor(r.pct_trx_growth), fontWeight: 600 }}>{r.pct_trx_growth != null ? fmtPct(r.pct_trx_growth) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="wrpa-chart-card">
          <div className="wrpa-chart-title" style={{ color: RED }}><i className="ti ti-trending-down" /> Bottom 5 Decline TRX (Mei→Jun)</div>
          <div className="wrpa-table-wrap">
            <table className="wrpa-table">
              <thead><tr><th>Produk</th><th>TRX Mei</th><th>TRX Jun</th><th>Growth</th></tr></thead>
              <tbody>
                {bot5.map((r, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{r.produk}</td>
                    <td>{fmtN(r.trx_mei)}</td>
                    <td style={{ color: RED, fontWeight: 600 }}>{fmtN(r.trx_jun)}</td>
                    <td style={{ color: gcColor(r.pct_trx_growth), fontWeight: 600 }}>{r.pct_trx_growth != null ? fmtPct(r.pct_trx_growth) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Tab 2: Unit Ekonomi ─── */
function UnitEkonomiTab({ data, meta }) {
  const tid    = meta.tanggal;
  const sorted = [...data].sort((a, b) => calcArpu(b.rev_jun, b.mat_jun) - calcArpu(a.rev_jun, a.mat_jun));

  return (
    <div>
      <div className="wrpa-chart-card">
        <div className="wrpa-chart-title">ARPT / ATPU / ARPU per Produk — 3 Bulan</div>
        <div className="wrpa-table-wrap">
          <table className="wrpa-table">
            <thead><tr>
              <th>Produk</th>
              <th>ARPT Apr</th><th>ARPT Mei</th><th>ARPT Jun</th>
              <th>ATPU Mei</th><th>ATPU Jun</th>
              <th>ARPU Mei</th><th>ARPU Jun</th>
              <th>Signal</th>
            </tr></thead>
            <tbody>
              {data.map((r, i) => {
                const arptJun = calcArpt(r.rev_jun, r.trx_jun);
                const arptMei = calcArpt(r.rev_mei, r.trx_mei);
                const arptApr = calcArpt(r.rev_apr, r.trx_apr);
                const arptDown  = arptJun < arptMei && Number(r.trx_jun) > 0;
                const anomali   = arptDown && (Number(r.dev_trx_mei_jun) || 0) < 0;
                return (
                  <tr key={i} style={{ background: anomali ? '#FFF1F0' : undefined }}>
                    <td style={{ fontWeight: 600 }}>{r.produk}</td>
                    <td>{fmtRp(arptApr)}</td>
                    <td>{fmtRp(arptMei)}</td>
                    <td style={{ color: arptDown ? RED : THEME, fontWeight: 600 }}>{fmtRp(arptJun)}</td>
                    <td>{calcAtpu(r.trx_mei, r.mat_mei)}x</td>
                    <td style={{ fontWeight: 600 }}>{calcAtpu(r.trx_jun, r.mat_jun)}x</td>
                    <td>{fmtRp(calcArpu(r.rev_mei, r.mat_mei))}</td>
                    <td style={{ fontWeight: 600 }}>{fmtRp(calcArpu(r.rev_jun, r.mat_jun))}</td>
                    <td>{anomali ? <span className="wrpa-badge wrpa-badge--kritis" title="ARPT & TRX turun">⚠ Anomali</span> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="wrpa-charts-2col">
        <ChartCard title="ARPU per Produk (Juni)" height="260px">
          <HBarChart id={`pa-arpu-${tid}`} labels={sorted.map(r => r.produk)} values={sorted.map(r => calcArpu(r.rev_jun, r.mat_jun))} color="#7C3AED" formatFn={fmtRp} />
        </ChartCard>
        <ChartCard title="ATPU per Produk (Juni) — Frekuensi TRX per MAT" height="260px">
          <HBarChart id={`pa-atpu-${tid}`} labels={data.map(r => r.produk)} values={data.map(r => parseFloat(calcAtpu(r.trx_jun, r.mat_jun)) || 0)} color="#0EA5E9" />
        </ChartCard>
      </div>
    </div>
  );
}

/* ─── Tab 3: Action Center ─── */
function ActionCenterTab({ data }) {
  const kritis = data.filter(r =>
    Number(r.rev_jun) < Number(r.rev_mei) && Number(r.rev_mei) < Number(r.rev_apr)
  );
  const bintang = data.filter(r => Number(r.pct_rev_growth) > 10);
  const optimasi = data.filter(r => {
    const arptJ = calcArpt(r.rev_jun, r.trx_jun);
    const arptM = calcArpt(r.rev_mei, r.trx_mei);
    return arptM > 0 && arptJ < arptM;
  });
  const rising = data.filter(r =>
    (Number(r.trx_mei) === 0 && Number(r.trx_jun) > 0) || Number(r.pct_trx_growth) > 50
  );

  function ActionCard({ icon, title, color, items, renderItem }) {
    return (
      <div className="wrpa-action-card" style={{ borderTop: `3px solid ${color}` }}>
        <div className="wrpa-action-card-header" style={{ color }}>
          <span>{icon}</span>
          <span>{title}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 400, color: '#9CA3AF' }}>{items.length} produk</span>
        </div>
        {items.length === 0
          ? <div style={{ color: '#9CA3AF', fontSize: 12, padding: '8px 0' }}>Tidak ada produk di kategori ini</div>
          : items.map((r, i) => renderItem(r, i))}
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 16 }}>
        <i className="ti ti-info-circle" /> Kategori dihitung otomatis dari data periode ini. Klik tab lain untuk detail per produk.
      </div>
      <div className="wrpa-action-grid">
        <ActionCard icon="🚨" title="Kritis — Tren Turun 2 Periode" color={RED} items={kritis}
          renderItem={(r, i) => (
            <div key={i} className="wrpa-action-item" style={{ background: '#FFF1F0', borderRadius: 6 }}>
              <div style={{ fontWeight: 600, fontSize: 12 }}>{r.produk}</div>
              <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>
                Rev: Apr {fmtRp(r.rev_apr)} → Mei {fmtRp(r.rev_mei)} → Jun {fmtRp(r.rev_jun)}
              </div>
              <div style={{ fontSize: 11, color: RED, marginTop: 1 }}>↓ Review strategi & program insentif segera</div>
            </div>
          )}
        />
        <ActionCard icon="📈" title="Bintang — Growth Revenue > 10%" color={THEME} items={bintang}
          renderItem={(r, i) => (
            <div key={i} className="wrpa-action-item" style={{ background: '#F0FDF4', borderRadius: 6 }}>
              <div style={{ fontWeight: 600, fontSize: 12 }}>{r.produk}</div>
              <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>
                Rev Jun: {fmtRp(r.rev_jun)} · Growth: <span style={{ color: THEME, fontWeight: 600 }}>{r.pct_rev_growth != null ? fmtPct(r.pct_rev_growth) : '-'}</span>
              </div>
              <div style={{ fontSize: 11, color: THEME, marginTop: 1 }}>✓ Pertahankan momentum, jadikan benchmark</div>
            </div>
          )}
        />
        <ActionCard icon="⚡" title="Optimasi Margin — ARPT Jun < Mei" color="#F59E0B" items={optimasi}
          renderItem={(r, i) => {
            const arptJ = calcArpt(r.rev_jun, r.trx_jun);
            const arptM = calcArpt(r.rev_mei, r.trx_mei);
            return (
              <div key={i} className="wrpa-action-item" style={{ background: '#FFFBEB', borderRadius: 6 }}>
                <div style={{ fontWeight: 600, fontSize: 12 }}>{r.produk}</div>
                <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>ARPT Mei: {fmtRp(arptM)} → Jun: {fmtRp(arptJ)}</div>
                <div style={{ fontSize: 11, color: '#F59E0B', marginTop: 1 }}>⚡ Review product mix & pricing</div>
              </div>
            );
          }}
        />
        <ActionCard icon="⭐" title="Rising Stars — Produk Baru / Lonjakan > 50%" color="#2563EB" items={rising}
          renderItem={(r, i) => (
            <div key={i} className="wrpa-action-item" style={{ background: '#EFF6FF', borderRadius: 6 }}>
              <div style={{ fontWeight: 600, fontSize: 12 }}>{r.produk}</div>
              <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>
                TRX: Mei {fmtN(r.trx_mei)} → Jun {fmtN(r.trx_jun)} · Growth: <span style={{ color: '#2563EB', fontWeight: 600 }}>{r.pct_trx_growth != null ? fmtPct(r.pct_trx_growth) : 'Baru'}</span>
              </div>
              <div style={{ fontSize: 11, color: '#2563EB', marginTop: 1 }}>⭐ Support penuh — potensi growth besar</div>
            </div>
          )}
        />
      </div>
    </div>
  );
}

/* ─── Main ─── */
const TABS = [
  { label: 'Executive Summary', icon: 'ti-layout-dashboard' },
  { label: 'Trend & Growth',    icon: 'ti-trending-up'      },
  { label: 'Unit Ekonomi',      icon: 'ti-calculator'       },
  { label: 'Action Center',     icon: 'ti-target'           },
];

export default function WarRoomPAProduk() {
  const [tab,        setTab]        = useState(0);
  const [resp,       setResp]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [modalRow,   setModalRow]   = useState(null);

  async function fetchData(isRefresh = false) {
    isRefresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const d = await getPAProdukAnalytics();
      setResp(d);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { fetchData(); }, []);

  if (loading) return (
    <Layout>
      <div className="wrpa-loading"><i className="ti ti-loader-2 wrpa-spin" /><span>Memuat data PA Produk…</span></div>
    </Layout>
  );
  if (error) return (
    <Layout>
      <div className="wrpa-error"><i className="ti ti-alert-circle" /><span>Gagal memuat: {error}</span></div>
    </Layout>
  );
  if (!resp?.meta) return (
    <Layout>
      <div className="wrpa-empty">
        <i className="ti ti-database-off" style={{ fontSize: 36, color: '#9CA3AF' }} />
        <p style={{ fontWeight: 600 }}>Belum ada data PA Produk</p>
        <span style={{ fontSize: 13, color: '#9CA3AF' }}>Jalankan sync dari Google Sheets terlebih dahulu.</span>
      </div>
    </Layout>
  );

  const { meta, total, data } = resp;
  const periodeStr = `${fmtDate(meta.periode_start)} – ${fmtDate(meta.periode_end)}`;

  return (
    <Layout>
      <div className="wrpa-page">
        <div className="wrpa-header">
          <div className="wrpa-header-left">
            <i className="ti ti-chart-bar" style={{ color: THEME, fontSize: 22 }} />
            <div>
              <div className="wrpa-header-title">WAR-ROOM PA PRODUK</div>
              <div className="wrpa-header-meta">{data.length} produk · Payment Agent</div>
            </div>
          </div>
          <div className="wrpa-header-badges">
            <span className="wrpa-period-badge"><i className="ti ti-calendar-stats" /> {periodeStr}</span>
            <span className="wrpa-date-badge"><i className="ti ti-refresh" /> Update {fmtDate(meta.tanggal)}</span>
            <button className="wrpa-refresh-btn" onClick={() => fetchData(true)} title="Refresh data">
              <i className={`ti ti-refresh${refreshing ? ' wrpa-spin' : ''}`} />
            </button>
          </div>
        </div>

        <div className="wrpa-tabs">
          {TABS.map((t, i) => (
            <button key={i} className={`wrpa-tab${tab === i ? ' wrpa-tab--active' : ''}`} onClick={() => setTab(i)}>
              <i className={`ti ${t.icon}`} />{t.label}
            </button>
          ))}
        </div>

        {tab === 0 && <ExecutiveSummaryTab data={data} total={total} meta={meta} onProdukClick={setModalRow} />}
        {tab === 1 && <TrendGrowthTab     data={data} meta={meta} />}
        {tab === 2 && <UnitEkonomiTab     data={data} meta={meta} />}
        {tab === 3 && <ActionCenterTab    data={data} />}
      </div>

      {modalRow && <ProdukModal row={modalRow} onClose={() => setModalRow(null)} />}
    </Layout>
  );
}
