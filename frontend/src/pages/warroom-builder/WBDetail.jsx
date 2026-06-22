import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Chart from 'chart.js/auto';
import Layout from '../../components/Layout';
import { wbGetDashboard, wbGenerate, wbResolveAlert, wbUpdateAction } from '../../services/wbApi';
import {
  SCORE_STATUS_COLORS, BU_COLORS, ACTION_TYPE_LABELS,
  ACTION_STATUS_LABELS, ALERT_LEVEL_COLORS,
} from '../../services/wbRegistry';

const TABS = [
  { id: 'summary',  label: 'Executive Summary',  icon: 'ti-chart-bar' },
  { id: 'growth',   label: 'Growth & Churn',      icon: 'ti-trending-up' },
  { id: 'entity',   label: 'Entity Detail',        icon: 'ti-list-details' },
  { id: 'revenue',  label: 'Revenue Analysis',     icon: 'ti-coin' },
  { id: 'trx',      label: 'TRX Distribution',     icon: 'ti-chart-scatter' },
  { id: 'actions',  label: 'Action Center',         icon: 'ti-checklist' },
];

function fmt(n, type = 'number') {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  if (type === 'pct') return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString('id-ID');
}

function DeltaBadge({ val }) {
  if (val === null || val === undefined) return <span className="wb-muted">—</span>;
  const pos = val >= 0;
  return (
    <span className="wb-delta" style={{ color: pos ? '#1D9E75' : '#EF4444' }}>
      <i className={`ti ti-trending-${pos ? 'up' : 'down'}`} />
      {fmt(val, 'pct')}
    </span>
  );
}

function KpiCard({ label, val, delta, icon, color }) {
  return (
    <div className="wb-kpi-card">
      <div className="wb-kpi-icon" style={{ background: (color || '#1D9E75') + '20' }}>
        <i className={`ti ${icon}`} style={{ color: color || '#1D9E75' }} />
      </div>
      <div style={{ flex: 1 }}>
        <div className="wb-kpi-val">{val}</div>
        <div className="wb-kpi-label">{label}</div>
        {delta !== undefined && <DeltaBadge val={delta} />}
      </div>
    </div>
  );
}

function useBarChart(ref, labels, datasets, opts = {}) {
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: datasets.length > 1 } },
        scales: { y: { beginAtZero: true } },
        ...opts,
      },
    });
    return () => chart.destroy();
  }, [labels, datasets]);
}

function useDoughnutChart(ref, labels, data, colors) {
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { boxWidth: 12 } } },
      },
    });
    return () => chart.destroy();
  }, [labels, data]);
}

/* ── Tab: Executive Summary ── */
function TabSummary({ summary, insights, warroom, snapshot }) {
  const top10TrxRef = useRef(null);
  const top10RevRef = useRef(null);

  useBarChart(
    top10TrxRef,
    (summary?.top10_trx || []).map(r => r.name?.slice(0, 15) || '?'),
    [{
      label: 'TRX',
      data: (summary?.top10_trx || []).map(r => r.current_trx || 0),
      backgroundColor: warroom?.color || '#1D9E75',
    }]
  );

  useBarChart(
    top10RevRef,
    (summary?.top10_revenue || []).map(r => r.name?.slice(0, 15) || '?'),
    [{
      label: 'Revenue',
      data: (summary?.top10_revenue || []).map(r => r.current_revenue || 0),
      backgroundColor: '#3B82F6',
    }]
  );

  return (
    <div>
      {/* KPI Cards */}
      <div className="wb-kpi-row">
        <KpiCard label="Total Entity"    val={fmt(summary?.total_entity)}   icon="ti-users"      color="#1D9E75" />
        <KpiCard label="Entity Aktif"    val={fmt(summary?.active_entity)}  icon="ti-activity"   color="#3B82F6" />
        <KpiCard label="Total TRX"       val={fmt(summary?.total_trx_curr)} icon="ti-arrows-right-left" color="#7F77DD"
          delta={summary?.dev_trx_pct} />
        <KpiCard label="Total Revenue"   val={fmt(summary?.total_rev_curr)} icon="ti-coin"       color="#F59E0B"
          delta={summary?.dev_revenue_pct} />
        <KpiCard label="Total Margin"    val={fmt(summary?.total_mar_curr)} icon="ti-trending-up" color="#10B981"
          delta={summary?.dev_margin !== undefined ? ((summary?.total_mar_prev > 0)
            ? ((summary?.dev_margin / summary?.total_mar_prev) * 100) : null) : undefined} />
        <KpiCard label="Entity Baru"     val={fmt(summary?.new_entity)}     icon="ti-sparkles"   color="#8B5CF6" />
        <KpiCard label="Entity Churn"    val={fmt(summary?.churn_count)}    icon="ti-user-off"   color="#EF4444" />
      </div>

      {/* Period Info */}
      {snapshot && (
        <div className="wb-period-info">
          <span className="wb-period-badge">
            <i className="ti ti-calendar" /> {snapshot.period_label || 'Current Period'}
          </span>
          {snapshot.day_counter && (
            <span className="wb-period-badge">
              <i className="ti ti-clock" /> Day {snapshot.day_counter} of {snapshot.month_total_days}
            </span>
          )}
          {snapshot.cutoff_date && (
            <span className="wb-period-badge">
              <i className="ti ti-database" /> Data s.d. {snapshot.cutoff_date}
            </span>
          )}
        </div>
      )}

      {/* Insight Box */}
      {insights && (
        <div className="wb-insight-box">
          <div className="wb-insight-header">
            <i className="ti ti-sparkles" style={{ color: '#F59E0B' }} />
            <span>AI Insight</span>
          </div>
          <div className="wb-insight-body">
            <div className="wb-insight-item">
              <div className="wb-insight-label">Executive Summary</div>
              <div className="wb-insight-text">{insights.executive_summary || '—'}</div>
            </div>
            {insights.top_growth_driver && (
              <div className="wb-insight-item wb-insight-item--green">
                <div className="wb-insight-label">📈 Top Growth Driver</div>
                <div className="wb-insight-text">
                  <b>{insights.top_growth_driver.name}</b>
                  {insights.top_growth_driver.dev_revenue !== undefined &&
                    ` — Revenue ${fmt(insights.top_growth_driver.dev_revenue)}`}
                </div>
              </div>
            )}
            {insights.top_decliner && (
              <div className="wb-insight-item wb-insight-item--red">
                <div className="wb-insight-label">📉 Top Decliner</div>
                <div className="wb-insight-text">
                  <b>{insights.top_decliner.name}</b>
                  {insights.top_decliner.dev_revenue !== undefined &&
                    ` — Revenue ${fmt(insights.top_decliner.dev_revenue)}`}
                </div>
              </div>
            )}
            {insights.recommended_actions?.length > 0 && (
              <div className="wb-insight-item">
                <div className="wb-insight-label">💡 Recommended Actions</div>
                <ul className="wb-insight-list">
                  {insights.recommended_actions.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Charts */}
      <div className="wb-chart-row">
        <div className="wb-chart-card">
          <div className="wb-chart-title">Top 10 TRX</div>
          <div className="wb-chart-wrap">
            <canvas ref={top10TrxRef} />
          </div>
        </div>
        <div className="wb-chart-card">
          <div className="wb-chart-title">Top 10 Revenue</div>
          <div className="wb-chart-wrap">
            <canvas ref={top10RevRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Tab: Growth & Churn ── */
function TabGrowth({ summary, parsedData }) {
  const doughnutRef = useRef(null);
  const dist = summary?.status_dist || {};
  const labels = ['Growing','Declining','Stable','New','Churned'];
  const data   = [dist.growing||0, dist.declining||0, dist.stable||0, dist.new||0, dist.churned||0];
  const colors = ['#1D9E75','#EF4444','#9CA3AF','#8B5CF6','#F97316'];
  useDoughnutChart(doughnutRef, labels, data, colors);

  const growing  = (parsedData||[]).filter(r => r.growth_status==='growing').sort((a,b)=>(b.dev_trx||0)-(a.dev_trx||0)).slice(0,10);
  const declining= (parsedData||[]).filter(r => r.growth_status==='declining').sort((a,b)=>(a.dev_trx||0)-(b.dev_trx||0)).slice(0,10);

  return (
    <div>
      <div className="wb-chart-row">
        <div className="wb-chart-card">
          <div className="wb-chart-title">Status Distribution</div>
          <div className="wb-chart-wrap">
            <canvas ref={doughnutRef} />
          </div>
        </div>
        <div className="wb-kpi-card-col">
          {labels.map((l, i) => (
            <div key={l} className="wb-status-kpi">
              <div className="wb-status-dot" style={{ background: colors[i] }} />
              <div style={{ flex: 1 }}>{l}</div>
              <div className="wb-status-count" style={{ color: colors[i] }}>{data[i]}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="wb-two-col" style={{ marginTop: 20 }}>
        <div className="wb-card">
          <div className="wb-section-title" style={{ color: '#1D9E75' }}>📈 Top Growing</div>
          <table className="wb-table wb-table-sm" style={{ marginTop: 8 }}>
            <thead><tr><th>Entity</th><th>Dev TRX</th><th>Dev Rev</th></tr></thead>
            <tbody>
              {growing.map((r, i) => (
                <tr key={i}>
                  <td>{r.entity_name || r.entity_id || '—'}</td>
                  <td style={{ color: '#1D9E75' }}>{r.dev_trx >= 0 ? '+' : ''}{fmt(r.dev_trx)}</td>
                  <td style={{ color: '#1D9E75' }}>{r.dev_revenue !== undefined ? (r.dev_revenue >= 0 ? '+' : '') + fmt(r.dev_revenue) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="wb-card">
          <div className="wb-section-title" style={{ color: '#EF4444' }}>📉 Top Declining</div>
          <table className="wb-table wb-table-sm" style={{ marginTop: 8 }}>
            <thead><tr><th>Entity</th><th>Dev TRX</th><th>Dev Rev</th></tr></thead>
            <tbody>
              {declining.map((r, i) => (
                <tr key={i}>
                  <td>{r.entity_name || r.entity_id || '—'}</td>
                  <td style={{ color: '#EF4444' }}>{fmt(r.dev_trx)}</td>
                  <td style={{ color: '#EF4444' }}>{r.dev_revenue !== undefined ? fmt(r.dev_revenue) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ── Tab: Entity Detail ── */
function TabEntity({ parsedData, warroom }) {
  const entityLabel = warroom?.entity_label || 'Entity';
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('current_trx');
  const [sortDir, setSortDir] = useState('desc');
  const [statusFilter, setStatusFilter] = useState('');

  const handleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const filtered = (parsedData || [])
    .filter(r => {
      const name = (r.entity_name || r.entity_id || '').toLowerCase();
      const matchSearch = !search || name.includes(search.toLowerCase());
      const matchStatus = !statusFilter || r.growth_status === statusFilter;
      return matchSearch && matchStatus;
    })
    .sort((a, b) => {
      const va = a[sortBy] ?? 0, vb = b[sortBy] ?? 0;
      return sortDir === 'asc' ? va - vb : vb - va;
    });

  const SortTh = ({ col, label }) => (
    <th className="wb-th-sort" onClick={() => handleSort(col)}>
      {label}
      {sortBy === col && <i className={`ti ti-sort-${sortDir === 'asc' ? 'ascending' : 'descending'}`} style={{ marginLeft: 4 }} />}
    </th>
  );

  const STATUS_COLORS = {
    growing: '#1D9E75', declining: '#EF4444', stable: '#9CA3AF',
    new: '#8B5CF6', churned: '#F97316',
  };

  return (
    <div>
      <div className="wb-filter-bar">
        <div className="wb-search-wrap">
          <i className="ti ti-search" />
          <input
            className="wb-search"
            placeholder={`Cari ${entityLabel}...`}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select className="wb-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">Semua Status</option>
          <option value="growing">Growing</option>
          <option value="declining">Declining</option>
          <option value="stable">Stable</option>
          <option value="new">New</option>
          <option value="churned">Churned</option>
        </select>
        <span className="wb-count-label">{filtered.length} {entityLabel}</span>
      </div>
      <div className="wb-table-wrap">
        <table className="wb-table wb-table-sm">
          <thead>
            <tr>
              <th>{entityLabel} ID</th>
              <th>Nama</th>
              <th>Kategori</th>
              <SortTh col="previous_trx"  label="TRX Prev" />
              <SortTh col="current_trx"   label="TRX Curr" />
              <SortTh col="dev_trx"       label="Dev TRX" />
              <SortTh col="current_revenue" label="Revenue" />
              <SortTh col="dev_revenue"   label="Dev Rev" />
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 200).map((r, i) => {
              const sc = STATUS_COLORS[r.growth_status] || '#9CA3AF';
              return (
                <tr key={i}>
                  <td className="wb-muted">{r.entity_id || '—'}</td>
                  <td>{r.entity_name || '—'}</td>
                  <td className="wb-muted">{r.category || '—'}</td>
                  <td>{fmt(r.previous_trx)}</td>
                  <td><b>{fmt(r.current_trx)}</b></td>
                  <td style={{ color: (r.dev_trx||0) >= 0 ? '#1D9E75' : '#EF4444' }}>
                    {r.dev_trx !== undefined ? (r.dev_trx >= 0 ? '+' : '') + fmt(r.dev_trx) : '—'}
                  </td>
                  <td>{fmt(r.current_revenue)}</td>
                  <td style={{ color: (r.dev_revenue||0) >= 0 ? '#1D9E75' : '#EF4444' }}>
                    {r.dev_revenue !== undefined ? (r.dev_revenue >= 0 ? '+' : '') + fmt(r.dev_revenue) : '—'}
                  </td>
                  <td>
                    <span className="wb-status-badge" style={{ background: sc + '20', color: sc }}>
                      {r.growth_status || '—'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length > 200 && (
          <div className="wb-table-note">Menampilkan 200 dari {filtered.length} data. Gunakan filter untuk mempersempit.</div>
        )}
      </div>
    </div>
  );
}

/* ── Tab: Revenue Analysis ── */
function TabRevenue({ summary, parsedData }) {
  const chartRef = useRef(null);
  const top10    = (parsedData||[]).filter(r => r.current_revenue > 0)
    .sort((a,b) => (b.current_revenue||0)-(a.current_revenue||0)).slice(0,10);

  useBarChart(
    chartRef,
    top10.map(r => (r.entity_name || r.entity_id || '?').slice(0,15)),
    [
      { label: 'Revenue Prev', data: top10.map(r => r.previous_revenue||0), backgroundColor: '#93C5FD' },
      { label: 'Revenue Curr', data: top10.map(r => r.current_revenue||0),  backgroundColor: '#3B82F6' },
    ]
  );

  const monProb = (parsedData||[]).filter(r => (r.dev_trx||0) > 0 && (r.dev_revenue !== undefined) && (r.dev_revenue||0) < 0)
    .sort((a,b) => (a.dev_revenue||0)-(b.dev_revenue||0)).slice(0,10);

  return (
    <div>
      <div className="wb-kpi-row">
        <KpiCard label="Revenue Prev"  val={fmt(summary?.total_rev_prev)}  icon="ti-coin"       color="#93C5FD" />
        <KpiCard label="Revenue Curr"  val={fmt(summary?.total_rev_curr)}  icon="ti-coin"       color="#3B82F6"
          delta={summary?.dev_revenue_pct} />
        <KpiCard label="Dev Revenue"   val={fmt(summary?.dev_revenue)}     icon="ti-trending-up" color={summary?.dev_revenue >= 0 ? '#1D9E75' : '#EF4444'} />
        <KpiCard label="Margin Curr"   val={fmt(summary?.total_mar_curr)}  icon="ti-trending-up" color="#10B981" />
      </div>
      <div className="wb-chart-row">
        <div className="wb-chart-card" style={{ flex: 2 }}>
          <div className="wb-chart-title">Top 10 Revenue — Prev vs Curr</div>
          <div className="wb-chart-wrap" style={{ height: 220 }}>
            <canvas ref={chartRef} />
          </div>
        </div>
      </div>
      {monProb.length > 0 && (
        <div className="wb-card" style={{ marginTop: 16 }}>
          <div className="wb-section-title" style={{ color: '#F59E0B' }}>
            ⚡ Monetization Problem ({monProb.length} entity)
          </div>
          <p style={{ color: '#6B7280', fontSize: 13, margin: '8px 0' }}>
            TRX naik tetapi Revenue turun — indikasi masalah harga/margin/monetisasi.
          </p>
          <table className="wb-table wb-table-sm">
            <thead><tr><th>Entity</th><th>Dev TRX</th><th>Dev Revenue</th></tr></thead>
            <tbody>
              {monProb.map((r, i) => (
                <tr key={i}>
                  <td>{r.entity_name || r.entity_id}</td>
                  <td style={{ color: '#1D9E75' }}>+{fmt(r.dev_trx)}</td>
                  <td style={{ color: '#EF4444' }}>{fmt(r.dev_revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Tab: TRX Distribution ── */
function TabTRX({ parsedData }) {
  const histRef  = useRef(null);
  const data = (parsedData||[]).filter(r => (r.current_trx||0) > 0);

  useEffect(() => {
    if (!histRef.current || !data.length) return;
    const trxValues = data.map(r => r.current_trx || 0);
    const max = Math.max(...trxValues);
    const BINS = 10;
    const binSize = Math.ceil(max / BINS);
    const bins = Array(BINS).fill(0);
    trxValues.forEach(v => {
      const idx = Math.min(Math.floor(v / binSize), BINS - 1);
      bins[idx]++;
    });
    const labels = bins.map((_, i) => `${fmt(i * binSize)}–${fmt((i+1)*binSize)}`);
    const chart = new Chart(histRef.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Jumlah Entity', data: bins, backgroundColor: '#1D9E75' }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } },
      },
    });
    return () => chart.destroy();
  }, [data.length]);

  // Pareto: top 20% entity → berapa persen TRX
  const sorted = [...data].sort((a,b) => (b.current_trx||0)-(a.current_trx||0));
  const total  = sorted.reduce((s, r) => s + (r.current_trx||0), 0);
  const top20pct = Math.ceil(sorted.length * 0.2);
  const top20sum = sorted.slice(0, top20pct).reduce((s, r) => s + (r.current_trx||0), 0);
  const paretoRatio = total > 0 ? (top20sum / total * 100).toFixed(1) : 0;

  return (
    <div>
      <div className="wb-kpi-row">
        <KpiCard label="Entity Aktif" val={fmt(data.length)} icon="ti-users" color="#1D9E75" />
        <KpiCard label="Total TRX"    val={fmt(total)}        icon="ti-arrows-right-left" color="#7F77DD" />
        <KpiCard label="Avg TRX/Entity" val={fmt(data.length ? Math.round(total/data.length) : 0)} icon="ti-math-avg" color="#F59E0B" />
        <div className="wb-kpi-card">
          <div className="wb-kpi-icon" style={{ background: '#8B5CF620' }}>
            <i className="ti ti-chart-pie" style={{ color: '#8B5CF6' }} />
          </div>
          <div>
            <div className="wb-kpi-val">{paretoRatio}%</div>
            <div className="wb-kpi-label">TRX dari Top 20% Entity (Pareto)</div>
          </div>
        </div>
      </div>
      <div className="wb-chart-card">
        <div className="wb-chart-title">Distribusi TRX (Histogram)</div>
        <div className="wb-chart-wrap" style={{ height: 220 }}>
          <canvas ref={histRef} />
        </div>
      </div>
      <div className="wb-card" style={{ marginTop: 16 }}>
        <div className="wb-section-title">Top 20 TRX</div>
        <table className="wb-table wb-table-sm" style={{ marginTop: 8 }}>
          <thead><tr><th>#</th><th>Entity</th><th>TRX Curr</th><th>TRX Prev</th><th>Dev TRX</th></tr></thead>
          <tbody>
            {sorted.slice(0,20).map((r, i) => (
              <tr key={i}>
                <td className="wb-muted">{i+1}</td>
                <td>{r.entity_name || r.entity_id || '—'}</td>
                <td><b>{fmt(r.current_trx)}</b></td>
                <td className="wb-muted">{fmt(r.previous_trx)}</td>
                <td style={{ color: (r.dev_trx||0) >= 0 ? '#1D9E75' : '#EF4444' }}>
                  {r.dev_trx !== undefined ? (r.dev_trx >= 0 ? '+' : '') + fmt(r.dev_trx) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Tab: Action Center ── */
function TabActions({ actions: initialActions, warroom }) {
  const [actions, setActions] = useState(initialActions || []);
  const [updating, setUpdating] = useState(null);

  const handleStatus = async (ac, status) => {
    setUpdating(ac.id);
    try {
      const updated = await wbUpdateAction(warroom.id, ac.id, { status });
      setActions(prev => prev.map(a => a.id === ac.id ? { ...a, ...updated } : a));
    } catch (e) {
      console.error(e);
    } finally {
      setUpdating(null);
    }
  };

  const grouped = {};
  for (const ac of actions) {
    const t = ac.action_type || 'monitor';
    if (!grouped[t]) grouped[t] = [];
    grouped[t].push(ac);
  }

  const TYPE_ORDER = ['scale','rescue','fix_monetization','activate','reactivate','hidden_gem','monitor'];

  return (
    <div>
      {actions.length === 0 ? (
        <div className="wb-empty">
          <i className="ti ti-checklist" />
          <p>Tidak ada action item. Jalankan "Sync Now" untuk generate action otomatis.</p>
        </div>
      ) : (
        TYPE_ORDER.map(type => {
          const items = (grouped[type] || []);
          if (!items.length) return null;
          return (
            <div key={type} className="wb-action-group">
              <div className="wb-action-group-title">{ACTION_TYPE_LABELS[type] || type}</div>
              <div className="wb-action-cards">
                {items.map(ac => (
                  <div key={ac.id} className="wb-action-card">
                    <div className="wb-action-card-top">
                      <div>
                        <div className="wb-action-entity-name">{ac.entity_name || ac.entity_id || '—'}</div>
                        <div className="wb-action-issue">{ac.issue}</div>
                      </div>
                      <select
                        className="wb-select wb-select-sm"
                        value={ac.status || 'open'}
                        disabled={updating === ac.id}
                        onChange={e => handleStatus(ac, e.target.value)}
                      >
                        {Object.entries(ACTION_STATUS_LABELS).map(([v, l]) =>
                          <option key={v} value={v}>{l}</option>
                        )}
                      </select>
                    </div>
                    <div className="wb-action-recommendation">{ac.recommendation}</div>
                    {ac.pic && <div className="wb-action-meta"><i className="ti ti-user" /> {ac.pic}</div>}
                    {ac.due_date && <div className="wb-action-meta"><i className="ti ti-calendar" /> {ac.due_date}</div>}
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

/* ── Main Component ── */
export default function WBDetail() {
  const { id }       = useParams();
  const navigate     = useNavigate();
  const [tab,        setTab]        = useState('summary');
  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [syncing,    setSyncing]    = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  const load = () => {
    setLoading(true);
    wbGetDashboard(id)
      .then(setData)
      .catch(e => console.error('[WB Detail]', e))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [id]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await wbGenerate(id);
      setSyncResult(result);
      load();
    } catch (e) {
      alert('Sync gagal: ' + (e.response?.data?.error || e.message));
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return (
    <Layout>
      <div className="wb-loading"><i className="ti ti-loader wb-spin" /> Memuat dashboard...</div>
    </Layout>
  );

  if (!data) return (
    <Layout>
      <div className="wb-empty">
        <i className="ti ti-alert-circle" />
        <p>Warroom tidak ditemukan.</p>
        <button className="wb-btn-primary" onClick={() => navigate('/warroom-builder')}>Kembali</button>
      </div>
    </Layout>
  );

  const { warroom, snapshot, alerts, actions } = data;
  const summary    = snapshot?.summary || {};
  const insights   = snapshot?.insights || null;
  const parsedData = snapshot?.parsed_data || [];
  const color      = warroom.color || BU_COLORS[warroom.business_unit] || '#1D9E75';
  const scoreCol   = SCORE_STATUS_COLORS[warroom.score_status] || '#9CA3AF';
  const critAlerts = alerts.filter(a => a.level === 'critical');
  const dynamicTabLabel = TABS.map(t =>
    t.id === 'entity' ? { ...t, label: `${warroom.entity_label || 'Entity'} Detail` } : t
  );

  return (
    <Layout>
      <div className="wb-page">
        {/* Header */}
        <div className="wb-detail-header">
          <button className="wb-btn-ghost wb-back-btn" onClick={() => navigate('/warroom-builder/library')}>
            <i className="ti ti-arrow-left" /> Library
          </button>
          <div className="wb-detail-title-wrap">
            <div className="wb-warroom-card-dot" style={{ background: color, width: 14, height: 14, borderRadius: '50%' }} />
            <h1 className="wb-detail-title">{warroom.name}</h1>
            <span className="wb-bu-badge" style={{ background: color + '20', color }}>{warroom.business_unit}</span>
            <span className="wb-entity-badge">{warroom.entity_type}</span>
            {warroom.score != null && (
              <span className="wb-score-badge" style={{ background: scoreCol + '20', color: scoreCol }}>
                Score {warroom.score} · {warroom.score_status}
              </span>
            )}
          </div>
          <div className="wb-detail-actions">
            {critAlerts.length > 0 && (
              <span className="wb-crit-badge">
                <i className="ti ti-alert-triangle" /> {critAlerts.length} kritis
              </span>
            )}
            <button
              className="wb-btn-primary"
              onClick={handleSync}
              disabled={syncing}
            >
              {syncing
                ? <><i className="ti ti-loader wb-spin" /> Syncing...</>
                : <><i className="ti ti-refresh" /> Sync Now</>}
            </button>
          </div>
        </div>

        {/* Sync result flash */}
        {syncResult && (
          <div className="wb-sync-result">
            <i className="ti ti-circle-check" style={{ color: '#1D9E75' }} />
            Sync selesai: {syncResult.rows_processed?.toLocaleString()} entity · Score {syncResult.score} ·
            {syncResult.alert_count} alert · {syncResult.action_count} action
          </div>
        )}

        {/* Alert banners */}
        {critAlerts.length > 0 && (
          <div className="wb-alert-banners">
            {critAlerts.slice(0, 3).map(al => (
              <div key={al.id} className="wb-alert-banner-row wb-alert-banner-row--critical">
                <i className="ti ti-alert-triangle" />
                <div className="wb-alert-banner-body">
                  <b>{al.title}</b> — {al.message}
                </div>
                <button className="wb-resolve-btn" onClick={() => wbResolveAlert(warroom.id, al.id).then(load)}>
                  Resolve
                </button>
              </div>
            ))}
          </div>
        )}

        {/* No snapshot */}
        {!snapshot ? (
          <div className="wb-empty">
            <i className="ti ti-database-off" />
            <p>Belum ada data. Klik "Sync Now" untuk mengambil data dari Google Sheet.</p>
            <button className="wb-btn-primary" onClick={handleSync} disabled={syncing}>
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
        ) : (
          <>
            {/* Period info */}
            {snapshot.period_label && (
              <div className="wb-period-bar">
                <span className="wb-period-badge"><i className="ti ti-calendar" /> {snapshot.period_label}</span>
                {snapshot.day_counter && (
                  <span className="wb-period-badge">
                    Day {snapshot.day_counter}/{snapshot.month_total_days}
                  </span>
                )}
                <span className="wb-period-badge"><i className="ti ti-database" /> {snapshot.row_count?.toLocaleString()} rows</span>
              </div>
            )}

            {/* Tabs */}
            <div className="wb-tab-nav">
              {dynamicTabLabel.map(t => (
                <button
                  key={t.id}
                  className={`wb-tab-btn ${tab === t.id ? 'wb-tab-btn--active' : ''}`}
                  style={tab === t.id ? { borderBottomColor: color } : {}}
                  onClick={() => setTab(t.id)}
                >
                  <i className={`ti ${t.icon}`} />
                  {t.label}
                </button>
              ))}
            </div>

            <div className="wb-tab-content">
              {tab === 'summary' && <TabSummary summary={summary} insights={insights} warroom={warroom} snapshot={snapshot} />}
              {tab === 'growth'  && <TabGrowth summary={summary} parsedData={parsedData} />}
              {tab === 'entity'  && <TabEntity parsedData={parsedData} warroom={warroom} />}
              {tab === 'revenue' && <TabRevenue summary={summary} parsedData={parsedData} />}
              {tab === 'trx'     && <TabTRX parsedData={parsedData} />}
              {tab === 'actions' && <TabActions actions={actions} warroom={warroom} />}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
