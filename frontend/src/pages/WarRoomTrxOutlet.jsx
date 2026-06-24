import { useState, useEffect, useRef, useCallback } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { authHeaders } from '../services/api';

const API = '/api/data-raw/outlet-analytics';
const ACCENT = '#2563EB';

const SEG_META = {
  superstar:  { label: 'Superstar',  color: '#7C3AED', icon: 'ti-star-filled'    },
  tumbuh:     { label: 'Tumbuh',     color: '#059669', icon: 'ti-trending-up'    },
  stabil:     { label: 'Stabil',     color: '#3B82F6', icon: 'ti-minus'          },
  turun:      { label: 'Turun',      color: '#F59E0B', icon: 'ti-trending-down'  },
  at_risk:    { label: 'At Risk',    color: '#EF4444', icon: 'ti-alert-triangle' },
  churn:      { label: 'Churn',      color: '#DC2626', icon: 'ti-skull'          },
  baru_aktif: { label: 'Baru Aktif', color: '#10B981', icon: 'ti-rocket'         },
  reaktivasi: { label: 'Reaktivasi', color: '#F97316', icon: 'ti-refresh'        },
};

const fmtN   = n => (n == null ? '-' : Number(n).toLocaleString('id-ID'));
const fmtRp  = n => (n == null ? '-' : 'Rp ' + Number(n).toLocaleString('id-ID', { maximumFractionDigits: 0 }));
const fmtPct = n => (n == null ? '-' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%');
const devColor = n => (n > 0 ? '#059669' : n < 0 ? '#DC2626' : '#9CA3AF');

function SegBadge({ seg, small }) {
  const m = SEG_META[seg] || { label: seg, color: '#9CA3AF', icon: 'ti-circle' };
  return (
    <span className={`wto-seg-badge${small ? ' wto-seg-badge--sm' : ''}`}
      style={{ background: m.color + '22', color: m.color, borderColor: m.color + '44' }}>
      <i className={`ti ${m.icon}`} /> {m.label}
    </span>
  );
}

function KpiCard({ label, value, sub, subColor, icon, accent }) {
  return (
    <div className="wto-kpi-card">
      <div className="wto-kpi-top">
        <i className={`ti ${icon}`} style={{ color: accent || ACCENT }} />
        <span className="wto-kpi-label">{label}</span>
      </div>
      <div className="wto-kpi-value">{value}</div>
      {sub && <div className="wto-kpi-sub" style={{ color: subColor || '#6B7280' }}>{sub}</div>}
    </div>
  );
}

function SegBar({ dist }) {
  const total = dist.reduce((s, d) => s + d.count, 0) || 1;
  return (
    <div className="wto-seg-bar-wrap">
      <div className="wto-seg-bar-track">
        {dist.filter(d => d.count > 0).map(d => (
          <div key={d.key} className="wto-seg-bar-seg"
            style={{ width: (d.count / total * 100).toFixed(1) + '%', background: d.color }}
            title={`${d.label}: ${fmtN(d.count)} (${(d.count/total*100).toFixed(1)}%)`} />
        ))}
      </div>
      <div className="wto-seg-bar-legend">
        {dist.filter(d => d.count > 0).map(d => (
          <div key={d.key} className="wto-seg-bar-item">
            <span className="wto-seg-bar-dot" style={{ background: d.color }} />
            <span>{d.label}</span>
            <strong>{fmtN(d.count)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function OutletRow({ o, rank, metric }) {
  const m   = SEG_META[o.segment] || SEG_META.stabil;
  const val = metric === 'margin' ? fmtRp(o.jun_margin)
            : metric === 'growth' ? fmtPct(o.growth_pct)
            : metric === 'drop'   ? fmtPct(o.growth_pct)
            : metric === 'mei'    ? fmtN(o.mei_trx)
            : fmtN(o.jun_trx);
  const valColor = (metric === 'growth' || metric === 'drop')
    ? devColor(metric === 'drop' ? -(o.growth_pct ?? 0) : (o.growth_pct ?? 0))
    : undefined;
  return (
    <tr className="wto-tr">
      {rank && <td className="wto-td wto-td-rank">{rank}</td>}
      <td className="wto-td wto-td-id">{o.id_outlet}</td>
      <td className="wto-td wto-td-nama">{o.nama_merchant}</td>
      <td className="wto-td wto-td-kat">{o.kategori}</td>
      <td className="wto-td wto-td-kota">{o.kota}</td>
      <td className="wto-td wto-td-val" style={{ color: valColor, fontWeight: 700 }}>{val}</td>
      <td className="wto-td">
        <span className="wto-seg-badge wto-seg-badge--sm"
          style={{ background: m.color + '22', color: m.color, borderColor: m.color + '44' }}>
          {m.label}
        </span>
      </td>
    </tr>
  );
}

function TopTable({ rows, title, metric, icon, color }) {
  if (!rows?.length) return null;
  return (
    <div className="wto-top-table">
      <div className="wto-top-table-head" style={{ borderColor: color }}>
        <i className={`ti ${icon}`} style={{ color }} />
        <span style={{ color }}>{title}</span>
      </div>
      <div className="wto-top-table-body">
        {rows.map((o, i) => <OutletRow key={o.id_outlet} o={o} rank={i + 1} metric={metric} />)}
      </div>
    </div>
  );
}

function DailyChart({ data, b1Label, b2Label }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !data?.length) return;
    if (chartRef.current) chartRef.current.destroy();
    const labels   = data.map(d => d.day);
    const junTrx   = data.map(d => d.trx);
    const meiTrx   = data.map(d => d.mei_trx);
    const junOut   = data.map(d => d.outlets);
    const meiOut   = data.map(d => d.mei_outlets);
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: b1Label || 'Juni', data: junTrx, borderColor: ACCENT,   backgroundColor: ACCENT + '18',  tension: 0.3, fill: true,  pointRadius: 3 },
          { label: b2Label || 'Mei',  data: meiTrx, borderColor: '#9CA3AF', backgroundColor: 'transparent', tension: 0.3, fill: false, pointRadius: 2, borderDash: [4,3] },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { color: '#9CA3AF', boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: '#9CA3AF' }, grid: { color: '#1f2937' } },
          y: { ticks: { color: '#9CA3AF', callback: v => fmtN(v) }, grid: { color: '#1f2937' } },
        },
      },
    });
    return () => chartRef.current?.destroy();
  }, [data, b1Label, b2Label]);

  const outCanvas = useRef(null);
  const outChart  = useRef(null);
  useEffect(() => {
    if (!outCanvas.current || !data?.length) return;
    if (outChart.current) outChart.current.destroy();
    const labels = data.map(d => d.day);
    outChart.current = new Chart(outCanvas.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: b1Label || 'Juni', data: data.map(d => d.outlets),     backgroundColor: ACCENT + 'AA' },
          { label: b2Label || 'Mei',  data: data.map(d => d.mei_outlets), backgroundColor: '#6B7280AA'   },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { color: '#9CA3AF', boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: '#9CA3AF' }, grid: { color: '#1f2937' } },
          y: { ticks: { color: '#9CA3AF', callback: v => fmtN(v) }, grid: { color: '#1f2937' } },
        },
      },
    });
    return () => outChart.current?.destroy();
  }, [data, b1Label, b2Label]);

  return (
    <div className="wto-daily-charts">
      <div className="wto-chart-card">
        <div className="wto-chart-title">Transaksi Harian</div>
        <div className="wto-chart-wrap"><canvas ref={canvasRef} /></div>
      </div>
      <div className="wto-chart-card">
        <div className="wto-chart-title">Outlet Aktif per Hari</div>
        <div className="wto-chart-wrap"><canvas ref={outCanvas} /></div>
      </div>
    </div>
  );
}

function ActionList({ rows, emptyMsg, metric, metricLabel }) {
  const [show, setShow] = useState(false);
  const visible = show ? rows : rows.slice(0, 10);
  if (!rows?.length) return <p className="wto-action-empty">{emptyMsg || 'Tidak ada data.'}</p>;
  return (
    <>
      <div className="wto-action-list">
        {visible.map((o, i) => {
          const val = metric === 'mei'      ? fmtN(o.mei_trx)
                    : metric === 'apr'      ? fmtN(o.apr_trx)
                    : metric === 'margin'   ? fmtRp(o.jun_margin)
                    : metric === 'growth'   ? fmtPct(o.growth_pct)
                    : metric === 'mpt'      ? fmtRp(o.mpt)
                    : fmtN(o.jun_trx);
          const valC = metric === 'growth' ? devColor(o.growth_pct ?? 0) : undefined;
          return (
            <div key={o.id_outlet} className="wto-action-row">
              <span className="wto-action-rank">{i + 1}</span>
              <div className="wto-action-info">
                <div className="wto-action-name">{o.nama_merchant !== '-' ? o.nama_merchant : o.id_outlet}</div>
                <div className="wto-action-meta">{o.id_outlet} · {o.kategori} · {o.kota}</div>
              </div>
              <div className="wto-action-val" style={{ color: valC }}>
                <div className="wto-action-metric">{val}</div>
                <div className="wto-action-mlabel">{metricLabel}</div>
              </div>
            </div>
          );
        })}
      </div>
      {rows.length > 10 && (
        <button className="wto-show-more" onClick={() => setShow(s => !s)}>
          {show ? 'Sembunyikan' : `Tampilkan semua ${rows.length} outlet`}
        </button>
      )}
    </>
  );
}

function ActionCard({ icon, title, badge, badgeColor, desc, rows, metric, metricLabel, emptyMsg }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="wto-action-card" style={{ borderColor: badgeColor + '44' }}>
      <div className="wto-action-card-head" onClick={() => setOpen(o => !o)}>
        <span className="wto-action-icon">{icon}</span>
        <div className="wto-action-title-wrap">
          <span className="wto-action-title">{title}</span>
          <span className="wto-action-badge" style={{ background: badgeColor + '22', color: badgeColor }}>
            {rows?.length || 0} outlet
          </span>
        </div>
        <span className="wto-action-desc">{desc}</span>
        <i className={`ti ti-chevron-${open ? 'up' : 'down'} wto-action-chev`} />
      </div>
      {open && (
        <div className="wto-action-body">
          <ActionList rows={rows || []} emptyMsg={emptyMsg} metric={metric} metricLabel={metricLabel} />
        </div>
      )}
    </div>
  );
}

function RankingTab({ data }) {
  const [filter, setFilter] = useState('top_trx');
  const [search, setSearch] = useState('');

  const filterBtns = [
    { key: 'top_trx',    label: '🏆 Top TRX',    metric: 'trx'    },
    { key: 'top_margin', label: '💰 Top Margin',  metric: 'margin' },
    { key: 'top_growth', label: '📈 Tumbuh',      metric: 'growth' },
    { key: 'top_drop',   label: '📉 Turun',       metric: 'drop'   },
    { key: 'churn',      label: '💀 Churn',       metric: 'mei'    },
    { key: 'baru',       label: '🆕 Baru Aktif',  metric: 'trx'    },
  ];

  const rows = {
    top_trx:    data?.top20_trx     || [],
    top_margin: data?.top20_margin  || [],
    top_growth: data?.top20_growth  || [],
    top_drop:   data?.top20_decline || [],
    churn:      data?.churn_list    || [],
    baru:       data?.new_active    || [],
  };

  const activeBtn = filterBtns.find(b => b.key === filter);
  const activeMetric = activeBtn?.metric || 'trx';

  const filtered = (rows[filter] || []).filter(o =>
    !search || o.id_outlet.includes(search) ||
    o.nama_merchant.toLowerCase().includes(search.toLowerCase()) ||
    o.kota.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="wto-ranking-tab">
      <div className="wto-rank-toolbar">
        <div className="wto-rank-filters">
          {filterBtns.map(b => (
            <button key={b.key}
              className={'wto-rank-btn' + (filter === b.key ? ' wto-rank-btn--active' : '')}
              onClick={() => setFilter(b.key)}
              style={filter === b.key ? { background: ACCENT, color: '#fff', borderColor: ACCENT } : {}}
            >{b.label}</button>
          ))}
        </div>
        <input
          className="wto-rank-search" placeholder="Cari ID / nama / kota..."
          value={search} onChange={e => setSearch(e.target.value)}
        />
      </div>
      <div className="wto-table-wrap">
        <table className="wto-table">
          <thead>
            <tr>
              <th className="wto-th">#</th>
              <th className="wto-th">ID Outlet</th>
              <th className="wto-th">Nama Merchant</th>
              <th className="wto-th">Kategori</th>
              <th className="wto-th">Kota</th>
              <th className="wto-th">
                {activeMetric === 'margin' ? 'Margin Juni' :
                 activeMetric === 'growth' ? 'Growth %' :
                 activeMetric === 'drop'   ? 'Drop %' :
                 activeMetric === 'mei'    ? 'TRX Mei' : 'TRX Juni'}
              </th>
              <th className="wto-th">Segmen</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0
              ? <tr><td colSpan={7} className="wto-empty-row">Tidak ada data</td></tr>
              : filtered.map((o, i) => <OutletRow key={o.id_outlet} o={o} rank={i + 1} metric={activeMetric} />)
            }
          </tbody>
        </table>
      </div>
      {filtered.length > 0 && (
        <div className="wto-rank-count">{filtered.length} outlet ditampilkan</div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function WarRoomTrxOutlet() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [bulan,   setBulan]   = useState('');
  const [tab,     setTab]     = useState(0);

  const fetchData = useCallback(async (b) => {
    setLoading(true); setError(null);
    try {
      const url = b ? `${API}?bulan=${b}` : API;
      const r = await fetch(url, { headers: authHeaders() });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      setData(d);
      if (d.bulan) setBulan(d.bulan);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(''); }, [fetchData]);

  const s   = data?.summary   || {};
  const mtd = data?.mtd_info  || {};
  const thr = data?.thresholds || {};
  const devTrxC    = devColor(s.dev_trx    || 0);
  const devMarginC = devColor(s.dev_margin || 0);

  const TABS = ['📊 Executive Summary', '📈 Trend Harian', '🏅 Ranking Outlet', '🎯 Action Center'];

  return (
    <Layout>
      <div className="wto-page">
        {/* Header */}
        <div className="wto-header">
          <div className="wto-header-left">
            <div className="wto-title-badge" style={{ background: ACCENT + '22', color: ACCENT }}>
              <i className="ti ti-chart-bar" /> WAR-ROOM
            </div>
            <h1 className="wto-title">Transaksi by Outlet</h1>
            <div className="wto-subtitle">
              Analitik performa outlet-level · InstaQris
              {mtd.is_mtd && <span className="wto-mtd-badge">MTD</span>}
            </div>
          </div>
          <div className="wto-header-right">
            {data?.bulan_list?.length > 0 && (
              <select className="wto-bulan-sel"
                value={bulan} onChange={e => { setBulan(e.target.value); fetchData(e.target.value); }}>
                {data.bulan_list.map(b => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            )}
            {loading && <span className="wto-loading-dot" />}
          </div>
        </div>

        {/* Period info */}
        {mtd.b1_label && (
          <div className="wto-period-bar">
            <span><strong>Periode:</strong> {mtd.b1_label}</span>
            <span><strong>Pembanding:</strong> {mtd.b2_label}</span>
            {thr.trx_p75 && <span><strong>P75 TRX:</strong> {fmtN(thr.trx_p75)} · <strong>P50:</strong> {fmtN(thr.trx_p50)}</span>}
          </div>
        )}

        {error && <div className="wto-error">{error}</div>}

        {/* Tabs */}
        <div className="wto-tabs">
          {TABS.map((t, i) => (
            <button key={i} className={'wto-tab' + (tab === i ? ' wto-tab--active' : '')}
              onClick={() => setTab(i)}
              style={tab === i ? { borderColor: ACCENT, color: ACCENT } : {}}>
              {t}
            </button>
          ))}
        </div>

        {/* ── Tab 0: Executive Summary ────────────────────────────────── */}
        {tab === 0 && (
          <div className="wto-tab-content">
            {loading ? <div className="wto-spinner">Memuat data...</div> : (
              <>
                {/* KPI row 1: outlet & growth */}
                <div className="wto-kpi-grid">
                  <KpiCard icon="ti-building-store" label="Outlet Aktif" accent={ACCENT}
                    value={fmtN(s.outlet_aktif_jun)}
                    sub={`${s.dev_outlet >= 0 ? '+' : ''}${fmtN(s.dev_outlet)} vs ${mtd.b2_label}`}
                    subColor={devColor(s.dev_outlet || 0)} />
                  <KpiCard icon="ti-arrows-exchange" label={`Total TRX ${mtd.b1_label || ''}`} accent={ACCENT}
                    value={fmtN(s.total_trx_jun)}
                    sub={`${s.dev_trx >= 0 ? '+' : ''}${fmtN(s.dev_trx)} vs bulan lalu`}
                    subColor={devTrxC} />
                  <KpiCard icon="ti-arrows-exchange" label={`Total TRX ${mtd.b2_label || ''}`} accent="#6B7280"
                    value={fmtN(s.total_trx_mei)}
                    sub={`Pembanding MTD`} subColor="#6B7280" />
                  <KpiCard icon="ti-coin" label="Total Margin" accent="#059669"
                    value={fmtRp(s.total_margin_jun)}
                    sub={`${s.dev_margin >= 0 ? '+' : ''}${fmtRp(s.dev_margin)} vs bulan lalu`}
                    subColor={devMarginC} />
                </div>
                {/* KPI row 2: segment counts */}
                <div className="wto-kpi-grid">
                  <KpiCard icon="ti-star-filled" label="Superstar" accent="#7C3AED"
                    value={fmtN(s.superstar_count)}
                    sub={`TRX ≥ P75 & Margin ≥ P75`} subColor="#7C3AED" />
                  <KpiCard icon="ti-trending-up" label="Tumbuh (≥20%)" accent="#059669"
                    value={fmtN(s.tumbuh_count)}
                    sub={`Outlet dengan growth ≥ 20%`} subColor="#059669" />
                  <KpiCard icon="ti-skull" label="Churn (0 TRX)" accent="#DC2626"
                    value={fmtN(s.churn_count)}
                    sub={`Aktif ${mtd.b2_label}, hilang ${mtd.b1_label}`} subColor="#DC2626" />
                  <KpiCard icon="ti-rocket" label="Baru Aktif" accent="#10B981"
                    value={fmtN(s.baru_count)}
                    sub={`Pertama TRX bulan ini`} subColor="#10B981" />
                </div>

                {/* Segment distribution */}
                <div className="wto-section">
                  <div className="wto-section-title">Distribusi Segmen Outlet</div>
                  {data?.segment_dist && <SegBar dist={data.segment_dist} />}
                </div>

                {/* Top tables */}
                <div className="wto-top-grid">
                  <TopTable rows={data?.top20_trx?.slice(0, 10)} title="Top 10 Outlet — TRX Tertinggi"
                    metric="trx" icon="ti-trophy" color="#2563EB" />
                  <TopTable rows={data?.top20_growth?.slice(0, 10)} title="Top 10 Outlet — Growth TRX"
                    metric="growth" icon="ti-trending-up" color="#059669" />
                  <TopTable rows={data?.top20_margin?.slice(0, 10)} title="Top 10 Outlet — Margin Tertinggi"
                    metric="margin" icon="ti-coin" color="#7C3AED" />
                  <TopTable rows={data?.top20_decline?.slice(0, 10)} title="Top 10 Outlet — Drop Terbesar"
                    metric="drop" icon="ti-trending-down" color="#EF4444" />
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Tab 1: Trend Harian ─────────────────────────────────────── */}
        {tab === 1 && (
          <div className="wto-tab-content">
            {loading ? <div className="wto-spinner">Memuat data...</div> : (
              <>
                {/* Daily stat summary */}
                {data?.daily_trend?.length > 0 && (() => {
                  const dt = data.daily_trend;
                  const bestDay  = [...dt].sort((a,b) => b.trx - a.trx)[0];
                  const worstDay = [...dt].filter(d => d.trx > 0).sort((a,b) => a.trx - b.trx)[0];
                  const avgTrx   = Math.round(dt.reduce((s,d) => s + d.trx, 0) / dt.length);
                  const avgOut   = Math.round(dt.reduce((s,d) => s + d.outlets, 0) / dt.length);
                  return (
                    <div className="wto-kpi-grid">
                      <KpiCard icon="ti-award" label="Hari Terbaik" accent="#059669"
                        value={fmtN(bestDay?.trx)} sub={`Tgl ${bestDay?.day} — ${fmtN(bestDay?.outlets)} outlet`} />
                      <KpiCard icon="ti-alert-circle" label="Hari Terendah" accent="#F59E0B"
                        value={fmtN(worstDay?.trx)} sub={`Tgl ${worstDay?.day} — ${fmtN(worstDay?.outlets)} outlet`} />
                      <KpiCard icon="ti-calculator" label="Rata-rata TRX/Hari" accent={ACCENT}
                        value={fmtN(avgTrx)} sub={`dari ${dt.length} hari`} />
                      <KpiCard icon="ti-users" label="Rata-rata Outlet/Hari" accent="#8B5CF6"
                        value={fmtN(avgOut)} sub={`outlet aktif per hari`} />
                    </div>
                  );
                })()}
                <DailyChart data={data?.daily_trend} b1Label={mtd.b1_label} b2Label={mtd.b2_label} />
              </>
            )}
          </div>
        )}

        {/* ── Tab 2: Ranking Outlet ───────────────────────────────────── */}
        {tab === 2 && (
          <div className="wto-tab-content">
            {loading ? <div className="wto-spinner">Memuat data...</div>
              : <RankingTab data={data} />}
          </div>
        )}

        {/* ── Tab 3: Action Center ────────────────────────────────────── */}
        {tab === 3 && (
          <div className="wto-tab-content">
            {loading ? <div className="wto-spinner">Memuat data...</div> : (
              <div className="wto-action-grid">
                <ActionCard
                  icon="🚨" title="Wajib Diselamatkan" badgeColor="#DC2626"
                  desc={`Outlet aktif ${mtd.b2_label}, kini 0 TRX. Hubungi segera sebelum hilang permanen.`}
                  rows={data?.action?.selamatkan} metric="mei" metricLabel="TRX bulan lalu"
                  emptyMsg="Tidak ada outlet churn." />
                <ActionCard
                  icon="📞" title="Wajib Dihubungi" badgeColor="#059669"
                  desc={`Outlet sedang tumbuh ≥20% & volume signifikan. Push lebih keras untuk akselerasi!`}
                  rows={data?.action?.hubungi} metric="growth" metricLabel="Growth %"
                  emptyMsg="Tidak ada outlet dalam kategori ini." />
                <ActionCard
                  icon="⭐" title="Wajib Diapresiasi" badgeColor="#7C3AED"
                  desc={`Superstar: TRX & Margin di atas P75. Berikan reward, jadikan testimoni!`}
                  rows={data?.action?.reward} metric="trx" metricLabel="TRX Juni"
                  emptyMsg="Belum ada superstar bulan ini." />
                <ActionCard
                  icon="🔄" title="Wajib Diaktivasi Ulang" badgeColor="#F97316"
                  desc={`Outlet aktif di April, tidak muncul 2 bulan terakhir. Kampanye win-back!`}
                  rows={data?.action?.reaktivasi} metric="apr" metricLabel="TRX April"
                  emptyMsg="Tidak ada kandidat reaktivasi." />
                <ActionCard
                  icon="💡" title="Wajib Dioptimasi" badgeColor="#F59E0B"
                  desc={`TRX tinggi (≥P75) tapi margin per TRX di bawah rata-rata. Edukasi produk margin lebih tinggi.`}
                  rows={data?.action?.optimasi} metric="mpt" metricLabel="Margin/TRX"
                  emptyMsg="Tidak ada outlet yang perlu dioptimasi." />
              </div>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
