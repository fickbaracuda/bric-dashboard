import { useState, useEffect, useRef, useMemo } from 'react';
import Layout from '../components/Layout';
import Chart from 'chart.js/auto';
import { getFastpayAnalytics, getFastpayOutlets } from '../services/api';

/* ─── Constants ─── */
const THEME = '#F59E0B';

const STATUS_COLOR = {
  rocket:   '#7C3AED',
  growing:  '#059669',
  stable:   '#6B7280',
  declining:'#DC2626',
  new:      '#2563EB',
  churned:  '#9CA3AF',
};
const STATUS_LABEL = {
  rocket:   '🚀 Rocket',
  growing:  '📈 Growing',
  stable:   '😐 Stable',
  declining:'📉 Declining',
  new:      '✨ Baru',
  churned:  '💀 Churn',
};
const REC_LEVEL = {
  high:   { label:'Prioritas Tinggi', bg:'#FEE2E2', border:'#DC2626', color:'#DC2626' },
  medium: { label:'Prioritas Sedang', bg:'#FEF3C7', border:'#D97706', color:'#D97706' },
  low:    { label:'Opsional',         bg:'#F0FDF4', border:'#16A34A', color:'#16A34A' },
};

/* ─── Format helpers ─── */
const fmtRp = v => {
  const n = Number(v) || 0;
  if (n >= 1e9)  return `Rp ${(n/1e9).toFixed(1)}M`;
  if (n >= 1e6)  return `Rp ${(n/1e6).toFixed(0)}jt`;
  if (n >= 1e3)  return `Rp ${(n/1e3).toFixed(0)}rb`;
  return `Rp ${n}`;
};
const fmtN   = v => (Number(v) || 0).toLocaleString('id');
const fmtPct = v => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`;
const fmtDate = d => {
  if (!d) return '-';
  const dt = new Date(d);
  return dt.toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' });
};

/* ─── buildInsights ─── */
function buildInsights(data) {
  if (!data?.summary) return { paragraph: '', recs: [] };
  const { summary, status_counts: sc, meta } = data;
  const total = meta.total_outlets || 0;
  const activeJun = summary.active_jun || 0;
  const pctActive = total > 0 ? ((activeJun / total) * 100).toFixed(0) : 0;
  const growing = (sc.rocket || 0) + (sc.growing || 0);
  const pctGrowing = activeJun > 0 ? ((growing / activeJun) * 100).toFixed(0) : 0;

  const trendTrx = summary.pct_dev_trx >= 0 ? 'naik' : 'turun';
  const trendRev = summary.pct_dev_rev >= 0 ? 'naik' : 'turun';

  const paragraph =
    `Total ${fmtN(total)} outlet terdaftar dengan ${fmtN(activeJun)} outlet aktif di Juni (${pctActive}% dari total). ` +
    `TRX ${trendTrx} ${Math.abs(summary.pct_dev_trx).toFixed(1)}% dan revenue ${trendRev} ${Math.abs(summary.pct_dev_rev).toFixed(1)}% dibandingkan Mei. ` +
    `${pctGrowing}% outlet aktif mengalami pertumbuhan positif. ` +
    `${fmtN(sc.churned || 0)} outlet churn dan ${fmtN(sc.new || 0)} outlet baru bergabung bulan ini.`;

  const recs = [];

  if ((sc.churned || 0) >= 5) {
    recs.push({
      level: 'high',
      title: `Tangani ${fmtN(sc.churned)} Outlet Churn`,
      text: 'Lakukan follow-up segera. Identifikasi alasan churn dan buat program retensi untuk mencegah kehilangan lebih banyak outlet.',
    });
  }
  if ((sc.declining || 0) >= 10) {
    recs.push({
      level: 'high',
      title: `Recovery ${fmtN(sc.declining)} Outlet Declining`,
      text: 'Buat program insentif untuk outlet yang mengalami penurunan TRX. Prioritaskan yang memiliki revenue besar di Mei.',
    });
  }
  if (summary.pct_dev_trx > 0 && summary.pct_dev_rev < 0) {
    recs.push({
      level: 'high',
      title: 'Anomali: TRX Naik tapi Revenue Turun',
      text: 'Perlu audit jenis transaksi — ada kemungkinan transaksi bernilai rendah meningkat sementara transaksi bernilai tinggi berkurang.',
    });
  }
  if ((sc.rocket || 0) > 0) {
    recs.push({
      level: 'medium',
      title: `Optimalkan ${fmtN(sc.rocket)} Outlet Rocket`,
      text: 'Outlet rocket adalah aset terbaik. Jadikan mereka referensi, ambil testimoni, dan berikan reward untuk mempertahankan momentum.',
    });
  }
  if ((sc.new || 0) >= 5) {
    recs.push({
      level: 'medium',
      title: `Onboarding ${fmtN(sc.new)} Outlet Baru`,
      text: 'Pastikan outlet baru mendapat training produk, target TRX awal, dan pendampingan intensif di bulan pertama.',
    });
  }
  if (data.anomali_free_trx?.length > 0) {
    recs.push({
      level: 'low',
      title: `${data.anomali_free_trx.length} Outlet "Free TRX" Perlu Diverifikasi`,
      text: 'Outlet dengan TRX > 0 tapi Revenue = 0 di Juni perlu dicek — kemungkinan data anomali atau transaksi gratis.',
    });
  }

  return { paragraph, recs: recs.slice(0, 5) };
}

/* ─── Chart components ─── */
function HBarChart({ id, labels, values, color, formatFn }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ data: values, backgroundColor: color || THEME, borderRadius: 3 }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => formatFn ? formatFn(ctx.parsed.x) : fmtN(ctx.parsed.x) } },
        },
        scales: {
          x: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 } } },
          y: { ticks: { font: { size: 11 } } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function BarGroupChart({ id, labels, data1, data2, label1, label2, color1, color2 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: label1, data: data1, backgroundColor: color1 || '#94A3B8', borderRadius: 2 },
          { label: label2, data: data2, backgroundColor: color2 || THEME,     borderRadius: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } },
        scales: {
          x: { ticks: { font: { size: 10 }, maxRotation: 45 } },
          y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 } } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function DonutChart({ id, labels, values, colors }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { font: { size: 11 }, padding: 10 } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function ScatterChart({ id, groups }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !groups?.length) return;
    const datasets = groups.map(g => ({
      label: STATUS_LABEL[g.status] || g.status,
      data: g.points,
      backgroundColor: (STATUS_COLOR[g.status] || '#999') + 'AA',
      pointRadius: 4,
    }));
    const chart = new Chart(ref.current, {
      type: 'scatter',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 8 } } },
        scales: {
          x: { title: { display: true, text: 'TRX Juni', font: { size: 11 } }, grid: { color: '#f0f0f0' } },
          y: { title: { display: true, text: 'Avg Rev/TRX (Rp)', font: { size: 11 } }, grid: { color: '#f0f0f0' }, ticks: { callback: v => fmtRp(v) } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function DistBarChart({ id, labels, values, color }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Jumlah Outlet', data: values, backgroundColor: color || THEME, borderRadius: 3 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { font: { size: 11 } } },
          y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 } } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

/* ─── UI components ─── */
function KPICard({ label, value, sub, badge, badgeColor }) {
  return (
    <div className="wrfp-kpi-card">
      <div className="wrfp-kpi-label">{label}</div>
      <div className="wrfp-kpi-value">
        {value}
        {badge && <span className="wrfp-kpi-badge" style={{ background: badgeColor || THEME }}>{badge}</span>}
      </div>
      {sub && <div className="wrfp-kpi-sub">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, children, height }) {
  return (
    <div className="wrfp-chart-card">
      {title && <div className="wrfp-chart-title">{title}</div>}
      <div className="wrfp-chart-box" style={height ? { height } : undefined}>{children}</div>
    </div>
  );
}

function StatusBadge({ status }) {
  return (
    <span className="wrfp-badge" style={{ background: STATUS_COLOR[status] || '#999', color: '#fff' }}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function DevCell({ value }) {
  const n = Number(value) || 0;
  const color = n > 0 ? '#059669' : n < 0 ? '#DC2626' : '#6B7280';
  return <span style={{ color, fontWeight: 600 }}>{n > 0 ? '+' : ''}{fmtN(n)}</span>;
}

function PctCell({ value }) {
  const n = Number(value) || 0;
  const color = n > 0 ? '#059669' : n < 0 ? '#DC2626' : '#6B7280';
  return <span style={{ color, fontWeight: 600 }}>{fmtPct(n)}</span>;
}

function CopyBtn({ ids, label }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(ids.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button className="wrfp-copy-btn" onClick={handleCopy}>
      <i className={`ti ti-${copied ? 'check' : 'copy'}`} />
      {copied ? 'Tersalin!' : (label || `Copy ${ids.length} ID`)}
    </button>
  );
}

function ExecInsightCard({ insights }) {
  if (!insights?.paragraph) return null;
  return (
    <div className="wrfp-insight-block">
      <div className="wrfp-exec-card">
        <div className="wrfp-exec-header">
          <i className="ti ti-report-analytics" style={{ color: THEME }} />
          Ringkasan Eksekutif
        </div>
        <p className="wrfp-exec-text">{insights.paragraph}</p>
      </div>
      {insights.recs?.length > 0 && (
        <div className="wrfp-exec-card">
          <div className="wrfp-exec-header">
            <i className="ti ti-bulb" style={{ color: THEME }} />
            Rekomendasi Tindakan
          </div>
          <div className="wrfp-recs-list">
            {insights.recs.map((r, i) => {
              const lvl = REC_LEVEL[r.level] || REC_LEVEL.low;
              return (
                <div key={i} className="wrfp-rec-item" style={{ borderLeft: `3px solid ${lvl.border}`, background: lvl.bg }}>
                  <div className="wrfp-rec-top">
                    <span className="wrfp-rec-title">{r.title}</span>
                    <span className="wrfp-rec-level" style={{ color: lvl.color }}>{lvl.label}</span>
                  </div>
                  <p className="wrfp-rec-text">{r.text}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── TAB 0: Executive Summary ─── */
function ExecutiveSummaryTab({ data }) {
  const { summary: s, status_counts: sc, top15_trx_jun, top15_rev_jun, meta } = data;

  const kpis = [
    { label: 'Total Outlet',  value: fmtN(meta.total_outlets) },
    { label: 'Aktif Juni',    value: fmtN(s.active_jun), sub: `${meta.total_outlets > 0 ? ((s.active_jun / meta.total_outlets)*100).toFixed(0) : 0}% dari total` },
    { label: 'TRX Juni',      value: fmtN(s.total_trx_jun), sub: fmtPct(s.pct_dev_trx) + ' vs Mei', badge: s.pct_dev_trx >= 0 ? '▲' : '▼', badgeColor: s.pct_dev_trx >= 0 ? '#059669' : '#DC2626' },
    { label: 'Revenue Juni',  value: fmtRp(s.total_rev_jun), sub: fmtPct(s.pct_dev_rev) + ' vs Mei', badge: s.pct_dev_rev >= 0 ? '▲' : '▼', badgeColor: s.pct_dev_rev >= 0 ? '#059669' : '#DC2626' },
    { label: 'Outlet Baru',   value: fmtN(sc.new || 0),     badge: '✨', badgeColor: '#2563EB' },
    { label: 'Churn',         value: fmtN(sc.churned || 0), badge: '💀', badgeColor: '#9CA3AF' },
  ];

  const statusOrder = ['rocket','growing','stable','declining','new','churned'];
  const donutLabels = statusOrder.map(s => STATUS_LABEL[s]);
  const donutValues = statusOrder.map(s => sc[s] || 0);
  const donutColors = statusOrder.map(s => STATUS_COLOR[s]);

  const insights = buildInsights(data);

  return (
    <div>
      <div className="wrfp-kpi-grid">
        {kpis.map((k, i) => <KPICard key={i} {...k} />)}
      </div>

      <div className="wrfp-charts-2col">
        <ChartCard title="Distribusi Status Outlet" height="260px">
          <DonutChart
            id={`fp-donut-${meta.sync_date}`}
            labels={donutLabels} values={donutValues} colors={donutColors}
          />
        </ChartCard>
        <ChartCard title="Top 15 Outlet — TRX Juni" height="260px">
          <HBarChart
            id={`fp-top15trx-${meta.sync_date}`}
            labels={top15_trx_jun.map(o => o.id_outlet)}
            values={top15_trx_jun.map(o => Number(o.trx_jun))}
            color={THEME}
          />
        </ChartCard>
      </div>

      <ChartCard title="Top 15 Outlet — Revenue Juni" height="260px">
        <HBarChart
          id={`fp-top15rev-${meta.sync_date}`}
          labels={top15_rev_jun.map(o => o.id_outlet)}
          values={top15_rev_jun.map(o => Number(o.rev_jun))}
          color="#059669"
          formatFn={fmtRp}
        />
      </ChartCard>

      <ExecInsightCard insights={insights} />
    </div>
  );
}

/* ─── TAB 1: Growth & Decline ─── */
function GrowthDeclineTab({ data }) {
  const { status_counts: sc, top15_growth_trx, top15_decline_trx, rocket_outlets } = data;
  const statusOrder = ['rocket','growing','stable','declining','new','churned'];

  return (
    <div>
      {/* Status pills */}
      <div className="wrfp-status-pills">
        {statusOrder.map(s => (
          <div key={s} className="wrfp-status-pill" style={{ borderColor: STATUS_COLOR[s], color: STATUS_COLOR[s] }}>
            <span className="wrfp-pill-label">{STATUS_LABEL[s]}</span>
            <span className="wrfp-pill-count">{fmtN(sc[s] || 0)}</span>
          </div>
        ))}
      </div>

      {/* Rocket section */}
      {rocket_outlets?.length > 0 && (
        <div className="wrfp-chart-card">
          <div className="wrfp-chart-title">
            <i className="ti ti-rocket" style={{ color: '#7C3AED' }} /> Outlet Rocket — Growth Luar Biasa
          </div>
          <div className="wrfp-table-wrap">
            <table className="wrfp-table">
              <thead><tr>
                <th>ID Outlet</th><th>TRX Mei</th><th>TRX Jun</th><th>Dev TRX</th><th>Growth %</th><th>Rev Juni</th>
              </tr></thead>
              <tbody>
                {rocket_outlets.map((o, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{o.id_outlet}</td>
                    <td>{fmtN(o.trx_mei)}</td>
                    <td style={{ color: '#7C3AED', fontWeight: 600 }}>{fmtN(o.trx_jun)}</td>
                    <td><DevCell value={o.dev_trx} /></td>
                    <td><PctCell value={o.pct_trx_growth} /></td>
                    <td>{fmtRp(o.rev_jun)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Growth & Decline side by side */}
      <div className="wrfp-charts-2col">
        <div className="wrfp-chart-card">
          <div className="wrfp-chart-title" style={{ color: '#059669' }}>
            <i className="ti ti-trending-up" /> Top 15 Growth TRX
          </div>
          {top15_growth_trx?.length > 0 ? (
            <div className="wrfp-table-wrap">
              <table className="wrfp-table">
                <thead><tr><th>ID Outlet</th><th>TRX Mei</th><th>TRX Jun</th><th>Growth %</th></tr></thead>
                <tbody>
                  {top15_growth_trx.map((o, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{o.id_outlet}</td>
                      <td>{fmtN(o.trx_mei)}</td>
                      <td style={{ color: '#059669', fontWeight: 600 }}>{fmtN(o.trx_jun)}</td>
                      <td><PctCell value={o.pct_trx_growth} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="wrfp-empty-msg">Tidak ada data</div>}
        </div>

        <div className="wrfp-chart-card">
          <div className="wrfp-chart-title" style={{ color: '#DC2626' }}>
            <i className="ti ti-trending-down" /> Top 15 Penurunan TRX
          </div>
          {top15_decline_trx?.length > 0 ? (
            <div className="wrfp-table-wrap">
              <table className="wrfp-table">
                <thead><tr><th>ID Outlet</th><th>TRX Mei</th><th>TRX Jun</th><th>Dev TRX</th></tr></thead>
                <tbody>
                  {top15_decline_trx.map((o, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{o.id_outlet}</td>
                      <td>{fmtN(o.trx_mei)}</td>
                      <td style={{ color: '#DC2626', fontWeight: 600 }}>{fmtN(o.trx_jun)}</td>
                      <td><DevCell value={o.dev_trx} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="wrfp-empty-msg">Tidak ada data</div>}
        </div>
      </div>
    </div>
  );
}

/* ─── TAB 2: Outlet Detail (server-side paginated) ─── */
function OutletDetailTab() {
  const [rows, setRows]               = useState([]);
  const [total, setTotal]             = useState(0);
  const [page, setPage]               = useState(1);
  const [loading, setLoading]         = useState(true);
  const [search, setSearch]           = useState('');
  const [dSearch, setDSearch]         = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [sortBy, setSortBy]           = useState('trx_jun');
  const [sortDir, setSortDir]         = useState('desc');
  const PER_PAGE = 50;

  useEffect(() => {
    const t = setTimeout(() => { setDSearch(search); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setLoading(true);
    getFastpayOutlets({ page, limit: PER_PAGE, search: dSearch, status: filterStatus, sortBy, sortDir })
      .then(d => { setRows(d.rows || []); setTotal(d.total || 0); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, dSearch, filterStatus, sortBy, sortDir]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const handleSort = col => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
    setPage(1);
  };
  const SortIcon = ({ col }) => sortBy !== col
    ? <i className="ti ti-arrows-sort" style={{ opacity:0.3, fontSize:11 }} />
    : <i className={`ti ti-sort-${sortDir==='asc'?'ascending':'descending'}`} style={{ fontSize:11, color:THEME }} />;

  return (
    <div className="wrfp-chart-card">
      <div className="wrfp-filter-bar">
        <div className="wrfp-search-wrap">
          <i className="ti ti-search" />
          <input className="wrfp-search" placeholder="Cari ID Outlet…" value={search}
            onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="wrfp-select" value={filterStatus}
          onChange={e => { setFilterStatus(e.target.value); setPage(1); }}>
          <option value="all">Semua Status</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="wrfp-filter-count">{fmtN(total)} outlet</span>
      </div>

      {loading ? (
        <div style={{ padding:'20px', textAlign:'center', color:'#9CA3AF' }}>
          <i className="ti ti-loader-2 wrfp-spin" /> Memuat…
        </div>
      ) : (
        <div className="wrfp-table-wrap">
          <table className="wrfp-table">
            <thead><tr>
              <th>ID Outlet</th>
              <th className="wrfp-th-sort" onClick={() => handleSort('trx_mei')}>TRX Mei <SortIcon col="trx_mei"/></th>
              <th className="wrfp-th-sort" onClick={() => handleSort('trx_jun')}>TRX Jun <SortIcon col="trx_jun"/></th>
              <th className="wrfp-th-sort" onClick={() => handleSort('dev_trx')}>Dev TRX <SortIcon col="dev_trx"/></th>
              <th className="wrfp-th-sort" onClick={() => handleSort('pct_trx_growth')}>Growth % <SortIcon col="pct_trx_growth"/></th>
              <th className="wrfp-th-sort" onClick={() => handleSort('rev_jun')}>Rev Juni <SortIcon col="rev_jun"/></th>
              <th className="wrfp-th-sort" onClick={() => handleSort('avg_rev_per_trx_jun')}>Avg Rev/TRX <SortIcon col="avg_rev_per_trx_jun"/></th>
              <th>Status</th>
            </tr></thead>
            <tbody>
              {rows.map((o, i) => (
                <tr key={i}>
                  <td style={{ fontWeight:600, fontFamily:'monospace', fontSize:12 }}>{o.id_outlet}</td>
                  <td>{fmtN(o.trx_mei)}</td>
                  <td style={{ fontWeight:600 }}>{fmtN(o.trx_jun)}</td>
                  <td><DevCell value={o.dev_trx}/></td>
                  <td><PctCell value={o.pct_trx_growth}/></td>
                  <td>{fmtRp(o.rev_jun)}</td>
                  <td>{o.trx_jun > 0 ? fmtRp(o.avg_rev_per_trx_jun) : '-'}</td>
                  <td><StatusBadge status={o.status}/></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={8} style={{ textAlign:'center', padding:'20px', color:'#9CA3AF' }}>Tidak ada data</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      <div className="wrfp-pagination">
        <button className="wrfp-page-btn" onClick={() => setPage(1)} disabled={page===1}>«</button>
        <button className="wrfp-page-btn" onClick={() => setPage(p => Math.max(1,p-1))} disabled={page===1}>‹</button>
        <span className="wrfp-page-info">Hal {page} / {totalPages}</span>
        <button className="wrfp-page-btn" onClick={() => setPage(p => Math.min(totalPages,p+1))} disabled={page===totalPages}>›</button>
        <button className="wrfp-page-btn" onClick={() => setPage(totalPages)} disabled={page===totalPages}>»</button>
      </div>
    </div>
  );
}

/* ─── TAB 3: Revenue Analysis ─── */
function RevenueAnalysisTab({ data }) {
  const { scatter_data, prefix_breakdown, trx_distribution, anomali_free_trx } = data;

  const scatterGroups = useMemo(() => {
    const statusOrder = ['rocket','growing','stable','declining','new','churned'];
    const grouped = {};
    for (const o of (scatter_data || [])) {
      if (!grouped[o.status]) grouped[o.status] = [];
      grouped[o.status].push({ x: Number(o.trx_jun), y: Number(o.avg_rev_per_trx_jun) });
    }
    return statusOrder
      .filter(s => grouped[s]?.length > 0)
      .map(s => ({ status: s, points: grouped[s].slice(0, 500) }));
  }, [scatter_data]);

  const distId = `fp-dist-${data.meta.sync_date}`;
  const scatterId = `fp-scatter-${data.meta.sync_date}`;
  const prefixId = `fp-prefix-${data.meta.sync_date}`;

  const bucketOrder = ['0 (Inactive)','1-5','6-20','21-50','51-100','101-500','501+'];
  const distMap = {};
  for (const r of (trx_distribution || [])) distMap[r.bucket] = parseInt(r.cnt);
  const distLabels = bucketOrder.filter(b => distMap[b] !== undefined);
  const distValues = distLabels.map(b => distMap[b] || 0);

  return (
    <div>
      <div className="wrfp-charts-2col">
        <ChartCard title="Scatter: TRX vs Avg Revenue/TRX" height="280px">
          <ScatterChart id={scatterId} groups={scatterGroups} />
        </ChartCard>
        <ChartCard title="Distribusi TRX Juni (Bucket)" height="280px">
          <DistBarChart id={distId} labels={distLabels} values={distValues} color={THEME} />
        </ChartCard>
      </div>

      {prefix_breakdown?.length > 0 && (
        <ChartCard title="Top 20 Prefix Outlet — Total TRX Juni" height="260px">
          <HBarChart
            id={prefixId}
            labels={prefix_breakdown.map(p => p.prefix || '???')}
            values={prefix_breakdown.map(p => Number(p.total_trx_jun))}
            color="#8B5CF6"
          />
        </ChartCard>
      )}

      {/* Anomali Free TRX */}
      {anomali_free_trx?.length > 0 && (
        <div className="wrfp-chart-card">
          <div className="wrfp-chart-title" style={{ color: '#D97706' }}>
            <i className="ti ti-alert-triangle" /> Anomali Free TRX — TRX Ada tapi Revenue = 0 ({anomali_free_trx.length} outlet)
          </div>
          <div className="wrfp-table-wrap">
            <table className="wrfp-table">
              <thead><tr><th>ID Outlet</th><th>TRX Mei</th><th>Rev Mei</th><th>TRX Jun</th><th>Rev Jun</th><th>Status</th></tr></thead>
              <tbody>
                {anomali_free_trx.map((o, i) => (
                  <tr key={i} style={{ background: '#FFFBEB' }}>
                    <td style={{ fontWeight:600, fontFamily:'monospace', fontSize:12 }}>{o.id_outlet}</td>
                    <td>{fmtN(o.trx_mei)}</td>
                    <td>{fmtRp(o.rev_mei)}</td>
                    <td style={{ color:'#D97706', fontWeight:600 }}>{fmtN(o.trx_jun)}</td>
                    <td style={{ color:'#DC2626' }}>Rp 0</td>
                    <td><StatusBadge status={o.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Prefix breakdown detail */}
      {prefix_breakdown?.length > 0 && (
        <div className="wrfp-chart-card">
          <div className="wrfp-chart-title">Detail Prefix Outlet</div>
          <div className="wrfp-table-wrap">
            <table className="wrfp-table">
              <thead><tr><th>Prefix</th><th>Total Outlet</th><th>Aktif Juni</th><th>TRX Juni</th><th>Revenue Juni</th></tr></thead>
              <tbody>
                {prefix_breakdown.map((p, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight:700, fontFamily:'monospace', color: THEME }}>{p.prefix || '???'}</td>
                    <td>{fmtN(p.total_outlets)}</td>
                    <td>{fmtN(p.active_jun)}</td>
                    <td style={{ fontWeight:600 }}>{fmtN(p.total_trx_jun)}</td>
                    <td>{fmtRp(p.total_rev_jun)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── TAB 4: Action Center ─── */
function ActionSection({ icon, title, color, items, columns, renderRow }) {
  if (!items?.length) return null;
  const ids = items.map(o => o.id_outlet);
  return (
    <div className="wrfp-action-section" style={{ borderLeft: `4px solid ${color}` }}>
      <div className="wrfp-action-header">
        <div className="wrfp-action-title" style={{ color }}>
          {icon} {title} <span className="wrfp-action-count">{items.length}</span>
        </div>
        <CopyBtn ids={ids} label={`Copy ${items.length} ID`} />
      </div>
      <div className="wrfp-table-wrap">
        <table className="wrfp-table">
          <thead><tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
          <tbody>{items.map((o, i) => <tr key={i}>{renderRow(o)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function ActionCenterTab({ data }) {
  const { rocket_outlets, top15_decline_trx, new_outlets, churned_outlets } = data;

  return (
    <div>
      <ActionSection
        icon="🚀" title="Pertahankan Outlet Rocket" color="#7C3AED"
        items={rocket_outlets}
        columns={['ID Outlet','TRX Mei','TRX Jun','Growth %','Rev Juni']}
        renderRow={o => <>
          <td style={{ fontWeight:600, fontFamily:'monospace', fontSize:12 }}>{o.id_outlet}</td>
          <td>{fmtN(o.trx_mei)}</td>
          <td style={{ color:'#7C3AED', fontWeight:700 }}>{fmtN(o.trx_jun)}</td>
          <td><PctCell value={o.pct_trx_growth} /></td>
          <td>{fmtRp(o.rev_jun)}</td>
        </>}
      />

      <ActionSection
        icon="🚨" title="Selamatkan Outlet Declining" color="#DC2626"
        items={top15_decline_trx}
        columns={['ID Outlet','TRX Mei','TRX Jun','Dev TRX','Rev Mei (potensi hilang)']}
        renderRow={o => <>
          <td style={{ fontWeight:600, fontFamily:'monospace', fontSize:12 }}>{o.id_outlet}</td>
          <td style={{ fontWeight:600 }}>{fmtN(o.trx_mei)}</td>
          <td style={{ color:'#DC2626' }}>{fmtN(o.trx_jun)}</td>
          <td><DevCell value={o.dev_trx} /></td>
          <td>{fmtRp(o.rev_mei)}</td>
        </>}
      />

      <ActionSection
        icon="✨" title="Onboarding Outlet Baru" color="#2563EB"
        items={new_outlets}
        columns={['ID Outlet','TRX Jun','Rev Juni']}
        renderRow={o => <>
          <td style={{ fontWeight:600, fontFamily:'monospace', fontSize:12 }}>{o.id_outlet}</td>
          <td style={{ color:'#2563EB', fontWeight:600 }}>{fmtN(o.trx_jun)}</td>
          <td>{fmtRp(o.rev_jun)}</td>
        </>}
      />

      <ActionSection
        icon="💀" title="Recover Outlet Churn" color="#9CA3AF"
        items={churned_outlets}
        columns={['ID Outlet','TRX Mei (terakhir)','Rev Mei (terakhir)']}
        renderRow={o => <>
          <td style={{ fontWeight:600, fontFamily:'monospace', fontSize:12 }}>{o.id_outlet}</td>
          <td>{fmtN(o.trx_mei)}</td>
          <td>{fmtRp(o.rev_mei)}</td>
        </>}
      />

      {!rocket_outlets?.length && !top15_decline_trx?.length && !new_outlets?.length && !churned_outlets?.length && (
        <div className="wrfp-empty-msg" style={{ padding:'40px', textAlign:'center', color:'#9CA3AF' }}>
          Belum ada data untuk ditampilkan
        </div>
      )}
    </div>
  );
}

/* ─── Main Component ─── */
const TABS = [
  { label: 'Executive Summary', icon: 'ti-layout-dashboard' },
  { label: 'Growth & Decline',  icon: 'ti-trending-up' },
  { label: 'Outlet Detail',     icon: 'ti-list-details' },
  { label: 'Analisis Revenue',  icon: 'ti-chart-bar' },
  { label: 'Action Center',     icon: 'ti-target' },
];

export default function WarRoomFastpay() {
  const [tab, setTab]           = useState(0);
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]       = useState(null);

  async function fetchData(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const d = await getFastpayAnalytics();
      setData(d);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { fetchData(); }, []);

  if (loading) {
    return (
      <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw" gsheetLabel="Fastpay Global">
        <div className="wrfp-loading">
          <i className="ti ti-loader-2 wrfp-spin" />
          <span>Memuat data Fastpay Global…</span>
        </div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw" gsheetLabel="Fastpay Global">
        <div className="wrfp-error">
          <i className="ti ti-alert-circle" />
          <span>Gagal memuat data: {error}</span>
        </div>
      </Layout>
    );
  }

  if (!data || data.error) {
    return (
      <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw" gsheetLabel="Fastpay Global">
        <div className="wrfp-empty">
          <i className="ti ti-database-off" />
          <p>{data?.error || 'Belum ada data Fastpay Global.'}</p>
          <span>Jalankan sync dari Google Sheets terlebih dahulu.</span>
        </div>
      </Layout>
    );
  }

  // Ambil YYYY-MM-DD dari apapun format yang dikirim Postgres
  const isoDate  = data.meta.sync_date ? String(data.meta.sync_date).substring(0, 10) : null;
  const tanggal  = isoDate
    ? new Date(isoDate + 'T12:00:00').toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
    : '-';
  const hari = isoDate ? parseInt(isoDate.split('-')[2]) : null;

  return (
    <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw" gsheetLabel="Fastpay Global">
      <div className="wrfp-page">
        {/* Header */}
        <div className="wrfp-header">
          <div className="wrfp-header-left">
            <i className="ti ti-world" style={{ color: THEME, fontSize: 22 }} />
            <div>
              <div className="wrfp-header-title">WAR-ROOM FASTPAY GLOBAL</div>
              <div className="wrfp-header-meta">{fmtN(data.meta.total_outlets)} outlet terdaftar</div>
            </div>
          </div>
          <div className="wrfp-header-badges">
            <span className="wrfp-badge wrfp-badge-owner">
              <i className="ti ti-user" /> Ainul
            </span>
            <span className="wrfp-badge wrfp-badge-date">
              <i className="ti ti-calendar" /> {tanggal}
            </span>
            {hari && (
              <span className="wrfp-badge wrfp-badge-hari">Juni — Hari ke-{hari}</span>
            )}
            <button
              className="wrfp-refresh-btn"
              onClick={() => fetchData(true)}
              title="Refresh data"
            >
              <i className={`ti ti-refresh${refreshing ? ' wrfp-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="wrfp-tabs">
          {TABS.map((t, i) => (
            <button
              key={i}
              className={`wrfp-tab${tab === i ? ' wrfp-tab--active' : ''}`}
              onClick={() => setTab(i)}
            >
              <i className={`ti ${t.icon}`} />
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="wrfp-tab-content">
          {tab === 0 && <ExecutiveSummaryTab data={data} />}
          {tab === 1 && <GrowthDeclineTab    data={data} />}
          {tab === 2 && <OutletDetailTab />}
          {tab === 3 && <RevenueAnalysisTab  data={data} />}
          {tab === 4 && <ActionCenterTab     data={data} />}
        </div>
      </div>
    </Layout>
  );
}
