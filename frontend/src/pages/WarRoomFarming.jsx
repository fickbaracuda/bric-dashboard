import { useState, useEffect, useRef, useMemo } from 'react';
import Layout from '../components/Layout';
import Chart from 'chart.js/auto';
import { getFarmingAnalytics, getFarmingOutlets } from '../services/api';

/* ─── Constants ─── */
const THEME = '#10B981';

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
  medium: { label:'Prioritas Sedang', bg:'#F0FDF4', border:'#10B981', color:'#059669' },
  low:    { label:'Opsional',         bg:'#ECFDF5', border:'#34D399', color:'#059669' },
};

/* ─── Format helpers ─── */
const fmtRp  = v => { const n = Number(v)||0; if(n>=1e9) return `Rp ${(n/1e9).toFixed(1)}M`; if(n>=1e6) return `Rp ${(n/1e6).toFixed(0)}jt`; if(n>=1e3) return `Rp ${(n/1e3).toFixed(0)}rb`; return `Rp ${n}`; };
const fmtN   = v => (Number(v)||0).toLocaleString('id');
const fmtPct = v => `${Number(v)>=0?'+':''}${Number(v).toFixed(1)}%`;

/* ─── buildInsights ─── */
function buildInsights(data) {
  if (!data?.summary) return { paragraph: '', recs: [] };
  const { summary: s, status_counts: sc, meta } = data;
  const total = meta.total_outlets || 0;
  const growing = (sc.rocket||0) + (sc.growing||0);
  const pctGrowing = s.active_jun > 0 ? ((growing/s.active_jun)*100).toFixed(0) : 0;
  const isoD = meta.sync_date ? String(meta.sync_date).substring(0, 10) : null;
  const hariD = isoD ? parseInt(isoD.split('-')[2]) : 9;
  const periodeD = `1–${hariD}`;
  const paragraph =
    `Total ${fmtN(total)} outlet farming dipantau. Periode ${periodeD} Juni vs ${periodeD} Mei: ` +
    `TRX ${s.pct_dev_trx >= 0 ? 'naik' : 'turun'} ${Math.abs(s.pct_dev_trx).toFixed(1)}%, ` +
    `revenue ${s.pct_dev_rev >= 0 ? 'naik' : 'turun'} ${Math.abs(s.pct_dev_rev).toFixed(1)}%. ` +
    `${pctGrowing}% outlet aktif tumbuh positif. ` +
    `${fmtN(sc.churned||0)} outlet churn, ${fmtN(sc.new||0)} outlet baru.`;

  const recs = [];
  if ((sc.churned||0) >= 3) recs.push({ level:'high', title:`Tangani ${fmtN(sc.churned)} Outlet Churn`, text:'Follow-up segera ke outlet yang tidak bertransaksi di periode ini.' });
  if ((sc.declining||0) >= 5) recs.push({ level:'high', title:`Recovery ${fmtN(sc.declining)} Outlet Declining`, text:'Prioritaskan outlet dengan penurunan TRX terbesar untuk program insentif.' });
  if (s.pct_dev_trx > 0 && s.pct_dev_rev < 0) recs.push({ level:'high', title:'Anomali: TRX Naik tapi Revenue Turun', text:'Audit jenis transaksi — kemungkinan shifting ke produk bernilai rendah.' });
  if ((sc.rocket||0) > 0) recs.push({ level:'medium', title:`Pertahankan ${fmtN(sc.rocket)} Outlet Rocket`, text:'Ambil testimonial, jadikan benchmark, dan berikan reward.' });
  if ((sc.new||0) >= 3) recs.push({ level:'medium', title:`Onboarding ${fmtN(sc.new)} Outlet Baru`, text:'Pastikan target TRX awal terpenuhi dengan pendampingan intensif.' });
  if (data.anomali_free_trx?.length > 0) recs.push({ level:'low', title:`${data.anomali_free_trx.length} Outlet Free TRX Perlu Diverifikasi`, text:'TRX ada tapi revenue = 0. Cek apakah transaksi gratis atau error data.' });

  return { paragraph, recs: recs.slice(0, 5) };
}

/* ─── Chart components (reuse wrfp-* CSS) ─── */
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

function DonutChart({ id, labels, values, colors }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { font: { size: 11 }, padding: 10 } } } },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function BarGroupChart({ id, labels, data1, data2, label1, label2 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [
        { label: label1, data: data1, backgroundColor: '#94A3B8', borderRadius: 2 },
        { label: label2, data: data2, backgroundColor: THEME,     borderRadius: 2 },
      ]},
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } }, scales: { x: { ticks: { font: { size: 10 }, maxRotation: 45 } }, y: { grid: { color: '#f0f0f0' } } } },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function DistBarChart({ id, labels, values }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Jumlah Outlet', data: values, backgroundColor: THEME, borderRadius: 3 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { font: { size: 11 } } }, y: { grid: { color: '#f0f0f0' } } } },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function ScatterChart({ id, groups }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !groups?.length) return;
    const chart = new Chart(ref.current, {
      type: 'scatter',
      data: { datasets: groups.map(g => ({ label: STATUS_LABEL[g.status]||g.status, data: g.points, backgroundColor:(STATUS_COLOR[g.status]||'#999')+'AA', pointRadius: 4 })) },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position:'bottom', labels: { font:{size:11}, padding:8 } } }, scales: { x: { title:{display:true, text:'TRX 1-N Jun'}, grid:{color:'#f0f0f0'} }, y: { title:{display:true, text:'Avg Rev/TRX (Rp)'}, ticks:{callback:v=>fmtRp(v)} } } },
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
      <div className="wrfp-kpi-value">{value}{badge && <span className="wrfp-kpi-badge" style={{ background: badgeColor||THEME }}>{badge}</span>}</div>
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
  return <span className="wrfp-badge" style={{ background:STATUS_COLOR[status]||'#999', color:'#fff' }}>{STATUS_LABEL[status]||status}</span>;
}
function DevCell({ value }) {
  const n = Number(value)||0;
  return <span style={{ color: n>0?'#059669':n<0?'#DC2626':'#6B7280', fontWeight:600 }}>{n>0?'+':''}{fmtN(n)}</span>;
}
function PctCell({ value }) {
  const n = Number(value)||0;
  return <span style={{ color: n>0?'#059669':n<0?'#DC2626':'#6B7280', fontWeight:600 }}>{fmtPct(n)}</span>;
}
function CopyBtn({ ids }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="wrfp-copy-btn" onClick={() => { navigator.clipboard.writeText(ids.join('\n')).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2000); }); }}>
      <i className={`ti ti-${copied?'check':'copy'}`} />{copied?'Tersalin!':`Copy ${ids.length} ID`}
    </button>
  );
}

function ExecInsightCard({ insights }) {
  if (!insights?.paragraph) return null;
  return (
    <div className="wrfp-insight-block">
      <div className="wrfp-exec-card">
        <div className="wrfp-exec-header"><i className="ti ti-report-analytics" style={{ color:THEME }} />Ringkasan Eksekutif</div>
        <p className="wrfp-exec-text">{insights.paragraph}</p>
      </div>
      {insights.recs?.length > 0 && (
        <div className="wrfp-exec-card">
          <div className="wrfp-exec-header"><i className="ti ti-bulb" style={{ color:THEME }} />Rekomendasi Tindakan</div>
          <div className="wrfp-recs-list">
            {insights.recs.map((r,i) => {
              const lvl = REC_LEVEL[r.level]||REC_LEVEL.low;
              return (
                <div key={i} className="wrfp-rec-item" style={{ borderLeft:`3px solid ${lvl.border}`, background:lvl.bg }}>
                  <div className="wrfp-rec-top"><span className="wrfp-rec-title">{r.title}</span><span className="wrfp-rec-level" style={{ color:lvl.color }}>{lvl.label}</span></div>
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
  const hari = meta.sync_date ? parseInt(String(meta.sync_date).substring(8,10)) : null;
  const periodeLabel = hari ? `1–${hari}` : '1–9';

  const kpis = [
    { label: 'Total Outlet',            value: fmtN(meta.total_outlets) },
    { label: `Aktif Juni ${periodeLabel}`, value: fmtN(s.active_jun), sub: `${meta.total_outlets>0?((s.active_jun/meta.total_outlets)*100).toFixed(0):0}% dari total` },
    { label: `TRX ${periodeLabel} Juni`, value: fmtN(s.total_trx_jun_period), sub: fmtPct(s.pct_dev_trx)+' vs periode Mei', badge: s.pct_dev_trx>=0?'▲':'▼', badgeColor: s.pct_dev_trx>=0?'#059669':'#DC2626' },
    { label: `Rev ${periodeLabel} Juni`, value: fmtRp(s.total_rev_jun_period), sub: fmtPct(s.pct_dev_rev)+' vs periode Mei', badge: s.pct_dev_rev>=0?'▲':'▼', badgeColor: s.pct_dev_rev>=0?'#059669':'#DC2626' },
    { label: 'Outlet Baru',  value: fmtN(sc.new||0),     badge: '✨', badgeColor: '#2563EB' },
    { label: 'Churn',        value: fmtN(sc.churned||0), badge: '💀', badgeColor: '#9CA3AF' },
  ];

  const statusOrder = ['rocket','growing','stable','declining','new','churned'];
  const insights = buildInsights(data);

  return (
    <div>
      <div className="wrfp-kpi-grid">{kpis.map((k,i)=><KPICard key={i} {...k} />)}</div>

      {/* Context bar: Mei Full baseline */}
      <div className="wrfm-context-bar">
        <i className="ti ti-info-circle" style={{ color: THEME }} />
        <span>Baseline Mei Full: TRX <strong>{fmtN(s.total_trx_mei_full)}</strong> · Revenue <strong>{fmtRp(s.total_rev_mei_full)}</strong></span>
        <span className="wrfm-context-note">Data update harian: hari ini −1</span>
      </div>

      <div className="wrfp-charts-2col">
        <ChartCard title="Distribusi Status Outlet" height="260px">
          <DonutChart id={`fm-donut-${meta.sync_date}`} labels={statusOrder.map(s=>STATUS_LABEL[s])} values={statusOrder.map(s=>sc[s]||0)} colors={statusOrder.map(s=>STATUS_COLOR[s])} />
        </ChartCard>
        <ChartCard title={`Top 15 — TRX ${periodeLabel} Juni vs Mei`} height="260px">
          <BarGroupChart
            id={`fm-group-${meta.sync_date}`}
            labels={top15_trx_jun.map(o=>o.id_outlet)}
            data1={top15_trx_jun.map(o=>Number(o.trx_mei_period))}
            data2={top15_trx_jun.map(o=>Number(o.trx_jun_period))}
            label1={`Mei ${periodeLabel}`} label2={`Jun ${periodeLabel}`}
          />
        </ChartCard>
      </div>

      <ChartCard title={`Top 15 Outlet — Revenue ${periodeLabel} Juni`} height="260px">
        <HBarChart id={`fm-top15rev-${meta.sync_date}`} labels={top15_rev_jun.map(o=>o.id_outlet)} values={top15_rev_jun.map(o=>Number(o.rev_jun_period))} color="#059669" formatFn={fmtRp} />
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
      <div className="wrfp-status-pills">
        {statusOrder.map(s => (
          <div key={s} className="wrfp-status-pill" style={{ borderColor: STATUS_COLOR[s], color: STATUS_COLOR[s] }}>
            <span className="wrfp-pill-label">{STATUS_LABEL[s]}</span>
            <span className="wrfp-pill-count">{fmtN(sc[s]||0)}</span>
          </div>
        ))}
      </div>

      {rocket_outlets?.length > 0 && (
        <div className="wrfp-chart-card">
          <div className="wrfp-chart-title"><i className="ti ti-rocket" style={{ color:'#7C3AED' }} /> Outlet Rocket</div>
          <div className="wrfp-table-wrap">
            <table className="wrfp-table">
              <thead><tr><th>ID Outlet</th><th>TRX Mei P</th><th>TRX Jun P</th><th>Dev TRX</th><th>Growth %</th><th>Rev Jun P</th></tr></thead>
              <tbody>{rocket_outlets.map((o,i)=>(
                <tr key={i}>
                  <td style={{fontWeight:600}}>{o.id_outlet}</td>
                  <td>{fmtN(o.trx_mei_period)}</td>
                  <td style={{color:'#7C3AED',fontWeight:600}}>{fmtN(o.trx_jun_period)}</td>
                  <td><DevCell value={o.dev_trx} /></td>
                  <td><PctCell value={o.pct_trx_growth} /></td>
                  <td>{fmtRp(o.rev_jun_period)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      <div className="wrfp-charts-2col">
        <div className="wrfp-chart-card">
          <div className="wrfp-chart-title" style={{ color:'#059669' }}><i className="ti ti-trending-up" /> Top 15 Growth TRX</div>
          {top15_growth_trx?.length > 0 ? (
            <div className="wrfp-table-wrap">
              <table className="wrfp-table">
                <thead><tr><th>ID Outlet</th><th>TRX Mei P</th><th>TRX Jun P</th><th>Growth %</th></tr></thead>
                <tbody>{top15_growth_trx.map((o,i)=>(
                  <tr key={i}>
                    <td style={{fontWeight:600}}>{o.id_outlet}</td>
                    <td>{fmtN(o.trx_mei_period)}</td>
                    <td style={{color:'#059669',fontWeight:600}}>{fmtN(o.trx_jun_period)}</td>
                    <td><PctCell value={o.pct_trx_growth} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <div className="wrfp-empty-msg">Tidak ada data</div>}
        </div>

        <div className="wrfp-chart-card">
          <div className="wrfp-chart-title" style={{ color:'#DC2626' }}><i className="ti ti-trending-down" /> Top 15 Penurunan TRX</div>
          {top15_decline_trx?.length > 0 ? (
            <div className="wrfp-table-wrap">
              <table className="wrfp-table">
                <thead><tr><th>ID Outlet</th><th>TRX Mei P</th><th>TRX Jun P</th><th>Dev TRX</th></tr></thead>
                <tbody>{top15_decline_trx.map((o,i)=>(
                  <tr key={i}>
                    <td style={{fontWeight:600}}>{o.id_outlet}</td>
                    <td>{fmtN(o.trx_mei_period)}</td>
                    <td style={{color:'#DC2626',fontWeight:600}}>{fmtN(o.trx_jun_period)}</td>
                    <td><DevCell value={o.dev_trx} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <div className="wrfp-empty-msg">Tidak ada data</div>}
        </div>
      </div>
    </div>
  );
}

/* ─── TAB 2: Outlet Detail (server-side paginated) ─── */
function OutletDetailTab({ periodeLabel }) {
  const p = periodeLabel || '1–9';
  const [rows, setRows]               = useState([]);
  const [total, setTotal]             = useState(0);
  const [page, setPage]               = useState(1);
  const [loading, setLoading]         = useState(true);
  const [search, setSearch]           = useState('');
  const [dSearch, setDSearch]         = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [sortBy, setSortBy]           = useState('trx_jun_period');
  const [sortDir, setSortDir]         = useState('desc');
  const PER_PAGE = 50;

  useEffect(() => {
    const t = setTimeout(() => { setDSearch(search); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setLoading(true);
    getFarmingOutlets({ page, limit: PER_PAGE, search: dSearch, status: filterStatus, sortBy, sortDir })
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
              <th>TRX Mei Full</th>
              <th className="wrfp-th-sort" onClick={() => handleSort('trx_mei_period')}>TRX Mei {p} <SortIcon col="trx_mei_period"/></th>
              <th className="wrfp-th-sort" onClick={() => handleSort('trx_jun_period')}>TRX Jun {p} <SortIcon col="trx_jun_period"/></th>
              <th className="wrfp-th-sort" onClick={() => handleSort('dev_trx')}>Dev TRX <SortIcon col="dev_trx"/></th>
              <th className="wrfp-th-sort" onClick={() => handleSort('pct_trx_growth')}>Growth % <SortIcon col="pct_trx_growth"/></th>
              <th className="wrfp-th-sort" onClick={() => handleSort('rev_jun_period')}>Rev Jun {p} <SortIcon col="rev_jun_period"/></th>
              <th>Status</th>
            </tr></thead>
            <tbody>
              {rows.map((o, i) => (
                <tr key={i}>
                  <td style={{ fontWeight:600, fontFamily:'monospace', fontSize:12 }}>{o.id_outlet}</td>
                  <td style={{ color:'#9CA3AF' }}>{fmtN(o.trx_mei_full)}</td>
                  <td>{fmtN(o.trx_mei_period)}</td>
                  <td style={{ fontWeight:600 }}>{fmtN(o.trx_jun_period)}</td>
                  <td><DevCell value={o.dev_trx}/></td>
                  <td><PctCell value={o.pct_trx_growth}/></td>
                  <td>{fmtRp(o.rev_jun_period)}</td>
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
        <button className="wrfp-page-btn" onClick={() => setPage(pg => Math.max(1,pg-1))} disabled={page===1}>‹</button>
        <span className="wrfp-page-info">Hal {page} / {totalPages}</span>
        <button className="wrfp-page-btn" onClick={() => setPage(pg => Math.min(totalPages,pg+1))} disabled={page===totalPages}>›</button>
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
    for (const o of (scatter_data||[])) {
      if (!grouped[o.status]) grouped[o.status] = [];
      grouped[o.status].push({ x: Number(o.trx_jun_period), y: Number(o.avg_rev_per_trx_jun) });
    }
    return statusOrder.filter(s=>grouped[s]?.length).map(s=>({ status:s, points:grouped[s].slice(0,500) }));
  }, [scatter_data]);

  const bucketOrder = ['0 (Inactive)','1-5','6-20','21-50','51-100','101-500','501+'];
  const distMap = {};
  for (const r of (trx_distribution||[])) distMap[r.bucket] = parseInt(r.cnt);
  const distLabels = bucketOrder.filter(b=>distMap[b]!==undefined);
  const distValues = distLabels.map(b=>distMap[b]||0);

  const isoDate3 = data.meta.sync_date ? String(data.meta.sync_date).substring(0, 10) : null;
  const hari3 = isoDate3 ? parseInt(isoDate3.split('-')[2]) : null;
  const p = hari3 ? `1–${hari3}` : '1–9';

  return (
    <div>
      <div className="wrfp-charts-2col">
        <ChartCard title={`Scatter: TRX vs Avg Rev/TRX (Juni ${p})`} height="280px">
          <ScatterChart id={`fm-scatter-${data.meta.sync_date}`} groups={scatterGroups} />
        </ChartCard>
        <ChartCard title={`Distribusi TRX Juni ${p}`} height="280px">
          <DistBarChart id={`fm-dist-${data.meta.sync_date}`} labels={distLabels} values={distValues} />
        </ChartCard>
      </div>

      {prefix_breakdown?.length > 0 && (
        <ChartCard title="Top 20 Prefix Outlet — TRX Juni" height="260px">
          <HBarChart id={`fm-prefix-${data.meta.sync_date}`} labels={prefix_breakdown.map(p=>p.prefix||'???')} values={prefix_breakdown.map(p=>Number(p.total_trx_jun))} color="#8B5CF6" />
        </ChartCard>
      )}

      {anomali_free_trx?.length > 0 && (
        <div className="wrfp-chart-card">
          <div className="wrfp-chart-title" style={{ color:'#D97706' }}>
            <i className="ti ti-alert-triangle" /> Anomali Free TRX — {anomali_free_trx.length} outlet
          </div>
          <div className="wrfp-table-wrap">
            <table className="wrfp-table">
              <thead><tr><th>ID Outlet</th><th>TRX Mei P</th><th>Rev Mei P</th><th>TRX Jun P</th><th>Rev Jun P</th><th>Status</th></tr></thead>
              <tbody>{anomali_free_trx.map((o,i)=>(
                <tr key={i} style={{background:'#FFFBEB'}}>
                  <td style={{fontWeight:600,fontFamily:'monospace',fontSize:12}}>{o.id_outlet}</td>
                  <td>{fmtN(o.trx_mei_period)}</td><td>{fmtRp(o.rev_mei_period)}</td>
                  <td style={{color:'#D97706',fontWeight:600}}>{fmtN(o.trx_jun_period)}</td>
                  <td style={{color:'#DC2626'}}>Rp 0</td>
                  <td><StatusBadge status={o.status}/></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {prefix_breakdown?.length > 0 && (
        <div className="wrfp-chart-card">
          <div className="wrfp-chart-title">Detail Prefix Outlet</div>
          <div className="wrfp-table-wrap">
            <table className="wrfp-table">
              <thead><tr><th>Prefix</th><th>Total Outlet</th><th>Aktif Juni</th><th>TRX Juni P</th><th>Revenue Juni P</th></tr></thead>
              <tbody>{prefix_breakdown.map((p,i)=>(
                <tr key={i}>
                  <td style={{fontWeight:700,fontFamily:'monospace',color:THEME}}>{p.prefix||'???'}</td>
                  <td>{fmtN(p.total_outlets)}</td><td>{fmtN(p.active_jun)}</td>
                  <td style={{fontWeight:600}}>{fmtN(p.total_trx_jun)}</td><td>{fmtRp(p.total_rev_jun)}</td>
                </tr>
              ))}</tbody>
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
  return (
    <div className="wrfp-action-section" style={{ borderLeft:`4px solid ${color}` }}>
      <div className="wrfp-action-header">
        <div className="wrfp-action-title" style={{ color }}>{icon} {title} <span className="wrfp-action-count">{items.length}</span></div>
        <CopyBtn ids={items.map(o=>o.id_outlet)} />
      </div>
      <div className="wrfp-table-wrap">
        <table className="wrfp-table">
          <thead><tr>{columns.map((c,i)=><th key={i}>{c}</th>)}</tr></thead>
          <tbody>{items.map((o,i)=><tr key={i}>{renderRow(o)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function ActionCenterTab({ data }) {
  const { rocket_outlets, top15_decline_trx, new_outlets, churned_outlets } = data;
  return (
    <div>
      <ActionSection icon="🚀" title="Pertahankan Outlet Rocket" color="#7C3AED"
        items={rocket_outlets}
        columns={['ID Outlet','TRX Mei P','TRX Jun P','Growth %','Rev Jun P']}
        renderRow={o=><><td style={{fontWeight:600,fontFamily:'monospace',fontSize:12}}>{o.id_outlet}</td><td>{fmtN(o.trx_mei_period)}</td><td style={{color:'#7C3AED',fontWeight:700}}>{fmtN(o.trx_jun_period)}</td><td><PctCell value={o.pct_trx_growth}/></td><td>{fmtRp(o.rev_jun_period)}</td></>}
      />
      <ActionSection icon="🚨" title="Selamatkan Outlet Declining" color="#DC2626"
        items={top15_decline_trx}
        columns={['ID Outlet','TRX Mei P','TRX Jun P','Dev TRX','Rev Mei P (potensi hilang)']}
        renderRow={o=><><td style={{fontWeight:600,fontFamily:'monospace',fontSize:12}}>{o.id_outlet}</td><td style={{fontWeight:600}}>{fmtN(o.trx_mei_period)}</td><td style={{color:'#DC2626'}}>{fmtN(o.trx_jun_period)}</td><td><DevCell value={o.dev_trx}/></td><td>{fmtRp(o.rev_mei_period)}</td></>}
      />
      <ActionSection icon="✨" title="Onboarding Outlet Baru" color="#2563EB"
        items={new_outlets}
        columns={['ID Outlet','TRX Jun P','Rev Jun P']}
        renderRow={o=><><td style={{fontWeight:600,fontFamily:'monospace',fontSize:12}}>{o.id_outlet}</td><td style={{color:'#2563EB',fontWeight:600}}>{fmtN(o.trx_jun_period)}</td><td>{fmtRp(o.rev_jun_period)}</td></>}
      />
      <ActionSection icon="💀" title="Recover Outlet Churn" color="#9CA3AF"
        items={churned_outlets}
        columns={['ID Outlet','TRX Mei P (terakhir)','Rev Mei P','TRX Mei Full','Rev Mei Full']}
        renderRow={o=><><td style={{fontWeight:600,fontFamily:'monospace',fontSize:12}}>{o.id_outlet}</td><td>{fmtN(o.trx_mei_period)}</td><td>{fmtRp(o.rev_mei_period)}</td><td style={{color:'#9CA3AF'}}>{fmtN(o.trx_mei_full)}</td><td style={{color:'#9CA3AF'}}>{fmtRp(o.rev_mei_full)}</td></>}
      />
      {!rocket_outlets?.length && !top15_decline_trx?.length && !new_outlets?.length && !churned_outlets?.length && (
        <div className="wrfp-empty-msg" style={{padding:'40px',textAlign:'center',color:'#9CA3AF'}}>Belum ada data</div>
      )}
    </div>
  );
}

/* ─── Main Component ─── */
const TABS = [
  { label:'Executive Summary', icon:'ti-layout-dashboard' },
  { label:'Growth & Decline',  icon:'ti-trending-up'      },
  { label:'Outlet Detail',     icon:'ti-list-details'     },
  { label:'Analisis Revenue',  icon:'ti-chart-bar'        },
  { label:'Action Center',     icon:'ti-target'           },
];

export default function WarRoomFarming() {
  const [tab, setTab]               = useState(0);
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState(null);

  async function fetchData(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const d = await getFarmingAnalytics();
      setData(d);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { fetchData(); }, []);

  if (loading) return <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw" gsheetLabel="Farming"><div className="wrfp-loading"><i className="ti ti-loader-2 wrfp-spin" /><span>Memuat data Farming…</span></div></Layout>;
  if (error)   return <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw" gsheetLabel="Farming"><div className="wrfp-error"><i className="ti ti-alert-circle" /><span>Gagal memuat: {error}</span></div></Layout>;
  if (!data || data.error) return <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw" gsheetLabel="Farming"><div className="wrfp-empty"><i className="ti ti-database-off" /><p>{data?.error||'Belum ada data Farming.'}</p><span>Jalankan sync dari Google Sheets terlebih dahulu.</span></div></Layout>;

  const isoDate     = data.meta.sync_date ? String(data.meta.sync_date).substring(0, 10) : null;
  const tanggal     = isoDate ? new Date(isoDate + 'T12:00:00').toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' }) : '-';
  const hari        = isoDate ? parseInt(isoDate.split('-')[2]) : null;
  const periodeLabel = hari ? `1–${hari}` : '1–9';

  return (
    <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw" gsheetLabel="Farming">
      <div className="wrfp-page wrfm-page">
        {/* Header */}
        <div className="wrfp-header">
          <div className="wrfp-header-left">
            <i className="ti ti-plant" style={{ color:THEME, fontSize:22 }} />
            <div>
              <div className="wrfp-header-title">WAR-ROOM FARMING</div>
              <div className="wrfp-header-meta">{fmtN(data.meta.total_outlets)} outlet terdaftar</div>
            </div>
          </div>
          <div className="wrfp-header-badges">
            <span className="wrfp-badge wrfp-badge-owner"><i className="ti ti-user" /> Nizar</span>
            <span className="wrfp-badge wrfp-badge-date"><i className="ti ti-calendar" /> {tanggal}</span>
            {hari && <span className="wrfp-badge wrfp-badge-hari">Juni — Hari ke-{hari}</span>}
            <button className="wrfp-refresh-btn" onClick={()=>fetchData(true)} title="Refresh data">
              <i className={`ti ti-refresh${refreshing?' wrfp-spin':''}`} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="wrfp-tabs">
          {TABS.map((t,i)=>(
            <button key={i} className={`wrfp-tab${tab===i?' wrfp-tab--active':''}`} onClick={()=>setTab(i)}>
              <i className={`ti ${t.icon}`} />{t.label}
            </button>
          ))}
        </div>

        <div className="wrfp-tab-content">
          {tab===0 && <ExecutiveSummaryTab data={data} />}
          {tab===1 && <GrowthDeclineTab   data={data} />}
          {tab===2 && <OutletDetailTab    periodeLabel={periodeLabel} />}
          {tab===3 && <RevenueAnalysisTab data={data} />}
          {tab===4 && <ActionCenterTab    data={data} />}
        </div>
      </div>
    </Layout>
  );
}
