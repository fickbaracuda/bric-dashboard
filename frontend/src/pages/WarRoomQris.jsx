import { useState, useEffect, useRef, useCallback } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getDataRawQrisAnalytics } from '../services/api';

/* ─ Constants ─ */
const ACCENT   = '#EC4899';
const GREEN    = '#10B981';
const AMBER    = '#F59E0B';
const BLUE     = '#3B82F6';
const RED      = '#EF4444';
const GRAY     = '#9CA3AF';

const STATUS_COLOR = {
  'Terbit':         GREEN,
  'Belum Terbit':   BLUE,
  'Perbaikan Data': AMBER,
  'Rejected':       RED,
};
const STATUS_ICON = {
  'Terbit':         '✅',
  'Belum Terbit':   '⏳',
  'Perbaikan Data': '🔧',
  'Rejected':       '❌',
};

/* ─ Helpers ─ */
const n = (v) => Number(v) || 0;
const fmtNum = (v) => n(v).toLocaleString('id-ID');
const fmtPct = (v) => n(v).toFixed(1) + '%';

function bulanLabel(b) {
  if (!b) return '';
  const [y, m] = b.split('-');
  const BL = ['','Jan','Feb','Mar','Apr','Mei','Jun','Jul','Ags','Sep','Okt','Nov','Des'];
  return (BL[parseInt(m)] || m) + ' ' + y;
}

/* ─ Shared UI ─ */
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

function KPICard({ label, value, sub, color = ACCENT, badge, badgeColor }) {
  return (
    <div className="wr-summary-card" style={{ borderTop: `3px solid ${color}` }}>
      <div className="wr-card-label">{label}</div>
      <div className="wr-card-value" style={{ color }}>
        {value}
        {badge && <span style={{ marginLeft: 6, fontSize: 13, color: badgeColor }}>{badge}</span>}
      </div>
      {sub && <div className="wr-card-sub">{sub}</div>}
    </div>
  );
}

/* ─ Chart components ─ */
function StatusDonut({ id, data }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !data?.length) return;
    const chart = new Chart(ref.current, {
      type: 'doughnut',
      data: {
        labels: data.map(d => d.status),
        datasets: [{
          data: data.map(d => d.count),
          backgroundColor: data.map(d => d.color),
          borderWidth: 2,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: {
          legend: { position: 'right', labels: { font: { size: 11 }, padding: 10, boxWidth: 14 } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmtNum(ctx.parsed)} (${fmtPct(ctx.dataset.data[ctx.dataIndex] / ctx.dataset.data.reduce((s,v) => s+v,0) * 100)})` } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function DailyStackedBar({ id, daily }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !daily?.length) return;
    const labels   = daily.map(d => d.tanggal.slice(5));
    const statuses = ['terbit', 'perbaikan', 'belum', 'rejected'];
    const colors   = [GREEN, AMBER, BLUE, RED];
    const slabels  = ['Terbit', 'Perbaikan Data', 'Belum Terbit', 'Rejected'];
    const datasets = statuses.map((s, i) => ({
      label: slabels[i],
      data: daily.map(d => d[s] || 0),
      backgroundColor: colors[i] + 'CC',
      borderRadius: 2,
    })).filter((_, i) => daily.some(d => d[statuses[i]] > 0));
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 10, boxWidth: 12 } },
          tooltip: { mode: 'index', intersect: false },
        },
        scales: {
          x: { stacked: true, ticks: { font: { size: 10 }, maxRotation: 45 } },
          y: { stacked: true, grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 } } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function DailyTerbitLine({ id, daily }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !daily?.length) return;
    const labels = daily.filter(d => d.terbit > 0).map(d => d.tanggal.slice(5));
    const values = daily.filter(d => d.terbit > 0).map(d => d.terbit);
    const avg    = values.length > 0 ? Math.round(values.reduce((s,v) => s+v,0) / values.length) : 0;
    const chart = new Chart(ref.current, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'QRIS Terbit/Hari',
            data: values,
            borderColor: GREEN,
            backgroundColor: GREEN + '18',
            fill: true,
            tension: 0.3,
            pointRadius: labels.length > 25 ? 2 : 4,
          },
          {
            label: `Rata-rata (${avg}/hari)`,
            data: Array(labels.length).fill(avg),
            borderColor: AMBER,
            borderDash: [6, 3],
            pointRadius: 0,
            borderWidth: 1.5,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 10, boxWidth: 12 } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmtNum(ctx.parsed.y)}` } },
        },
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

function HBarStacked({ id, rows, keyField, maxRows = 15 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !rows?.length) return;
    const top = rows.slice(0, maxRows);
    const labels = top.map(r => {
      const name = r[keyField] || '?';
      return name.length > 22 ? name.slice(0, 22) + '…' : name;
    });
    const datasets = [
      { label: 'Terbit',         data: top.map(r => r.terbit    || 0), backgroundColor: GREEN + 'CC', borderRadius: 2 },
      { label: 'Perbaikan Data', data: top.map(r => r.perbaikan || 0), backgroundColor: AMBER + 'CC', borderRadius: 2 },
      { label: 'Belum Terbit',   data: top.map(r => r.belum     || 0), backgroundColor: BLUE  + 'CC', borderRadius: 2 },
      { label: 'Rejected',       data: top.map(r => r.rejected  || 0), backgroundColor: RED   + 'CC', borderRadius: 2 },
    ].filter(d => d.data.some(v => v > 0));
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 10, boxWidth: 12 } },
          tooltip: { mode: 'index', intersect: false },
        },
        scales: {
          x: { stacked: true, grid: { color: '#f0f0f0' }, ticks: { font: { size: 10 } } },
          y: { stacked: true, ticks: { font: { size: 10 } } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function HBarRate({ id, rows, keyField, maxRows = 15 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !rows?.length) return;
    const top = rows.slice(0, maxRows);
    const labels = top.map(r => {
      const name = r[keyField] || '?';
      return name.length > 22 ? name.slice(0, 22) + '…' : name;
    });
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Terbit Rate (%)',
          data: top.map(r => r.terbit_rate || 0),
          backgroundColor: top.map(r => {
            const rate = r.terbit_rate || 0;
            if (rate >= 80) return GREEN + 'CC';
            if (rate >= 50) return AMBER + 'CC';
            return RED + 'CC';
          }),
          borderRadius: 3,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.x.toFixed(1)}%` } } },
        scales: {
          x: { max: 100, grid: { color: '#f0f0f0' }, ticks: { font: { size: 10 }, callback: v => v + '%' } },
          y: { ticks: { font: { size: 10 } } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

/* ─ Funnel Component ─ */
function FunnelPipeline({ data }) {
  if (!data) return null;
  const { total, terbit, perbaikan, belum, rejected } = data;
  const steps = [
    { label: 'Total Pengajuan QRIS', count: total,     color: ACCENT, icon: '📋', pct: 100 },
    { label: 'Terbit ✅',             count: terbit,    color: GREEN,  icon: '✅', pct: total > 0 ? (terbit/total*100) : 0 },
    { label: 'Perbaikan Data 🔧',     count: perbaikan, color: AMBER,  icon: '🔧', pct: total > 0 ? (perbaikan/total*100) : 0 },
    { label: 'Belum Terbit ⏳',       count: belum,     color: BLUE,   icon: '⏳', pct: total > 0 ? (belum/total*100) : 0 },
    { label: 'Rejected ❌',           count: rejected,  color: RED,    icon: '❌', pct: total > 0 ? (rejected/total*100) : 0 },
  ].filter(s => s.count > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {steps.map((s, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 130, textAlign: 'right', fontSize: 12, color: 'var(--text-3)', flexShrink: 0 }}>
            {s.label}
          </div>
          <div style={{ flex: 1, height: 28, background: '#F1F5F9', borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
            <div style={{ width: `${Math.max(s.pct, 0.5)}%`, height: '100%', background: s.color, borderRadius: 4, transition: 'width 0.6s ease' }} />
            <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, fontWeight: 600, color: '#374151' }}>
              {fmtNum(s.count)} ({s.pct.toFixed(1)}%)
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─ Status Badge ─ */
function StatusBadge({ status }) {
  const c = STATUS_COLOR[status] || GRAY;
  return (
    <span style={{ background: c + '20', color: c, border: `1px solid ${c}40`, borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {STATUS_ICON[status] || ''} {status}
    </span>
  );
}

/* ─── TAB 0: Ringkasan ─── */
function RingkasanTab({ data, loading, bulan }) {
  if (loading) return <SkeletonCards />;
  if (!data)   return null;
  const { summary, by_status, daily } = data;
  const lb = bulanLabel(bulan);

  const isPerbaikanDominant = n(summary?.perbaikan_rate) > 50;

  return (
    <div>
      {/* Alert banner jika Perbaikan Data mendominasi */}
      {isPerbaikanDominant && (
        <div style={{ background: AMBER + '15', border: `1px solid ${AMBER}`, borderRadius: 8, padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 20 }}>⚠️</span>
          <div>
            <div style={{ fontWeight: 700, color: '#92400E', fontSize: 14 }}>
              {fmtPct(summary?.perbaikan_rate)} pengajuan dalam status Perbaikan Data
            </div>
            <div style={{ fontSize: 12, color: '#B45309' }}>
              {fmtNum(summary?.perbaikan)} QRIS terblokir karena data perlu koreksi — tindakan prioritas diperlukan untuk akselerasi penerbitan
            </div>
          </div>
        </div>
      )}

      {/* KPI Grid */}
      <div className="wr-summary-grid">
        <KPICard label={`Total Pengajuan ${lb}`} value={fmtNum(summary?.total)} color={ACCENT}
          sub={`${fmtNum(n(summary?.terbit_outlets) + n(summary?.perbaikan_outlets) + n(summary?.belum_outlets))} outlet unik`} />
        <KPICard label="Terbit ✅" value={fmtNum(summary?.terbit)} color={GREEN}
          sub={<span style={{ color: GREEN, fontSize: 11, fontWeight: 600 }}>{fmtPct(summary?.terbit_rate)} dari total</span>} />
        <KPICard label="Perbaikan Data 🔧" value={fmtNum(summary?.perbaikan)} color={AMBER}
          sub={<span style={{ color: AMBER, fontSize: 11, fontWeight: 600 }}>{fmtPct(summary?.perbaikan_rate)} dari total</span>} />
        <KPICard label="Belum Terbit ⏳" value={fmtNum(summary?.belum)} color={BLUE}
          sub={<span style={{ color: BLUE, fontSize: 11 }}>{fmtPct(summary?.belum_rate)} dari total</span>} />
        <KPICard label="Aktivasi (Terbit→TRX)" value={fmtPct(summary?.activation_rate)} color={summary?.activation_rate >= 70 ? GREEN : summary?.activation_rate >= 50 ? AMBER : RED}
          sub={`${fmtNum(summary?.terbit_with_trx)} dari ${fmtNum(summary?.terbit_outlets)} outlet bertransaksi`} />
        <KPICard label="Kecepatan Penerbitan" value={`${fmtNum(summary?.avg_daily_terbit)}/hari`} color={ACCENT}
          sub={`Puncak: ${fmtNum(summary?.peak_daily_terbit)} QRIS (${summary?.peak_date?.slice(5) || '-'})`} />
      </div>

      <div className="wri-2col" style={{ marginTop: 16 }}>
        {/* Pipeline funnel */}
        <div className="wri-chart-card">
          <div className="wri-chart-title">Pipeline Status Penerbitan</div>
          <FunnelPipeline data={summary} />
        </div>

        {/* Donut */}
        <div className="wri-chart-card">
          <div className="wri-chart-title">Distribusi Status QRIS {lb}</div>
          <div style={{ position: 'relative', height: 200 }}>
            <StatusDonut id={`q-donut-${bulan}`} data={by_status} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, justifyContent: 'center' }}>
            {by_status?.map(s => (
              <span key={s.status} style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: 'inline-block' }} />
                {s.status}: <strong>{fmtNum(s.count)}</strong> ({fmtPct(s.rate)})
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Daily mini chart - hanya terbit */}
      {daily?.some(d => d.terbit > 0) && (
        <div className="wri-chart-card" style={{ marginTop: 16 }}>
          <div className="wri-chart-title">Tren Harian — QRIS Terbit {lb}</div>
          <div style={{ position: 'relative', height: 200 }}>
            <DailyTerbitLine id={`q-dline-${bulan}`} daily={daily} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── TAB 1: Penerbitan Harian ─── */
function PenerbitanHarianTab({ data, loading, bulan }) {
  if (loading) return <SkeletonCards />;
  if (!data?.daily?.length) return <div className="wri-state">Belum ada data harian</div>;

  const { daily, summary } = data;
  const terbitOnly = daily.filter(d => d.terbit > 0);
  const totalTerbit = terbitOnly.reduce((s,d) => s+d.terbit, 0);
  const lb = bulanLabel(bulan);

  return (
    <div>
      <div className="wri-kpi-grid">
        <div className="wri-kpi-card">
          <div className="wri-kpi-label">Total QRIS Terbit {lb}</div>
          <div className="wri-kpi-value" style={{ color: GREEN }}>{fmtNum(totalTerbit)}</div>
          <div className="wri-kpi-sub">selama {terbitOnly.length} hari data</div>
        </div>
        <div className="wri-kpi-card">
          <div className="wri-kpi-label">Rata-rata per Hari</div>
          <div className="wri-kpi-value" style={{ color: ACCENT }}>{fmtNum(summary?.avg_daily_terbit)}</div>
          <div className="wri-kpi-sub">QRIS Terbit</div>
        </div>
        <div className="wri-kpi-card">
          <div className="wri-kpi-label">Puncak Penerbitan</div>
          <div className="wri-kpi-value" style={{ color: GREEN }}>{fmtNum(summary?.peak_daily_terbit)}</div>
          <div className="wri-kpi-sub">{summary?.peak_date || '-'}</div>
        </div>
        <div className="wri-kpi-card">
          <div className="wri-kpi-label">Proyeksi 30 Hari</div>
          <div className="wri-kpi-value" style={{ color: ACCENT }}>
            {fmtNum(Math.round(n(summary?.avg_daily_terbit) * 30))}
          </div>
          <div className="wri-kpi-sub">berdasarkan rata-rata saat ini</div>
        </div>
      </div>

      {/* Line chart terbit */}
      <div className="wri-chart-card" style={{ marginTop: 16 }}>
        <div className="wri-chart-title">Penerbitan QRIS Harian (Terbit) — {lb}</div>
        <div style={{ position: 'relative', height: 280 }}>
          <DailyTerbitLine id={`q-tline-${bulan}-big`} daily={daily} />
        </div>
      </div>

      {/* Stacked bar semua status */}
      <div className="wri-chart-card" style={{ marginTop: 16 }}>
        <div className="wri-chart-title">Distribusi Status per Hari — {lb}</div>
        <div style={{ position: 'relative', height: 280 }}>
          <DailyStackedBar id={`q-sbar-${bulan}`} daily={daily} />
        </div>
      </div>

      {/* Tabel harian detail */}
      <div className="wr-table-wrap" style={{ marginTop: 16 }}>
        <table className="wr-table">
          <thead>
            <tr>
              <th>Tanggal</th>
              <th style={{ color: GREEN }}>Terbit ✅</th>
              <th style={{ color: AMBER }}>Perbaikan Data 🔧</th>
              <th style={{ color: BLUE }}>Belum Terbit ⏳</th>
              <th style={{ color: RED }}>Rejected ❌</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {[...daily].sort((a,b) => b.tanggal.localeCompare(a.tanggal)).map(d => {
              const tot = d.terbit + d.perbaikan + d.belum + d.rejected;
              return (
                <tr key={d.tanggal}>
                  <td style={{ fontWeight: 600 }}>{d.tanggal}</td>
                  <td style={{ color: GREEN, fontWeight: 600 }}>{d.terbit > 0 ? fmtNum(d.terbit) : '—'}</td>
                  <td style={{ color: AMBER }}>{d.perbaikan > 0 ? fmtNum(d.perbaikan) : '—'}</td>
                  <td style={{ color: BLUE }}>{d.belum > 0 ? fmtNum(d.belum) : '—'}</td>
                  <td style={{ color: RED }}>{d.rejected > 0 ? fmtNum(d.rejected) : '—'}</td>
                  <td>{fmtNum(tot)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── TAB 2: Segmentasi Kategori ─── */
function SegmentasiKategoriTab({ data, loading, bulan }) {
  const [sort, setSort] = useState('total');
  const [view, setView] = useState('stacked');

  if (loading) return <SkeletonCards />;
  if (!data?.by_kategori?.length) return <div className="wri-state">Belum ada data segmentasi</div>;

  const lb = bulanLabel(bulan);
  const rows = [...data.by_kategori].sort((a, b) => {
    if (sort === 'total')     return b.total - a.total;
    if (sort === 'terbit')    return b.terbit - a.terbit;
    if (sort === 'perbaikan') return b.perbaikan - a.perbaikan;
    if (sort === 'rate')      return b.terbit_rate - a.terbit_rate;
    if (sort === 'activation')return b.activation_rate - a.activation_rate;
    return b.total - a.total;
  });

  const chartKey = `q-kat-${sort}-${view}-${bulan}`;

  return (
    <div>
      <div className="wr-table-controls" style={{ marginBottom: 12 }}>
        <div className="wr-table-left">
          <select className="wr-select" value={sort} onChange={e => setSort(e.target.value)}>
            <option value="total">Total ↓</option>
            <option value="terbit">Terbit ↓</option>
            <option value="perbaikan">Perbaikan Data ↓</option>
            <option value="rate">Terbit Rate ↓</option>
            <option value="activation">Activation Rate ↓</option>
          </select>
          <span className="wr-count">{rows.length} kategori</span>
        </div>
        <div className="wr-filter-tabs">
          {[['stacked','Volume'],['rate','Rate %']].map(([k,l]) => (
            <button key={k} className={`wr-filter-tab${view===k?' active':''}`} onClick={() => setView(k)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="wri-chart-card">
        <div className="wri-chart-title">{view === 'stacked' ? `Volume QRIS per Kategori — ${lb}` : `Terbit Rate per Kategori — ${lb}`}</div>
        <div style={{ position: 'relative', height: Math.max(280, Math.min(rows.length * 24, 480)) + 'px' }}>
          {view === 'stacked'
            ? <HBarStacked id={chartKey} rows={rows} keyField="kategori" maxRows={15} />
            : <HBarRate    id={chartKey} rows={rows} keyField="kategori" maxRows={15} />
          }
        </div>
      </div>

      <div className="wr-table-wrap" style={{ marginTop: 16 }}>
        <table className="wr-table">
          <thead>
            <tr>
              <th>#</th><th>Kategori</th><th>Total</th>
              <th style={{ color: GREEN }}>Terbit</th>
              <th style={{ color: AMBER }}>Perbaikan</th>
              <th style={{ color: BLUE }}>Belum</th>
              <th>Terbit Rate</th>
              <th>Aktivasi</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.kategori}>
                <td>{i + 1}</td>
                <td style={{ maxWidth: 200 }}>{r.kategori}</td>
                <td><strong>{fmtNum(r.total)}</strong></td>
                <td style={{ color: GREEN, fontWeight: 600 }}>{fmtNum(r.terbit)}</td>
                <td style={{ color: AMBER }}>{r.perbaikan > 0 ? fmtNum(r.perbaikan) : '—'}</td>
                <td style={{ color: BLUE }}>{r.belum > 0 ? fmtNum(r.belum) : '—'}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ flex: 1, height: 8, background: '#F1F5F9', borderRadius: 4, minWidth: 40, overflow: 'hidden' }}>
                      <div style={{ width: `${r.terbit_rate}%`, height: '100%', background: r.terbit_rate >= 80 ? GREEN : r.terbit_rate >= 50 ? AMBER : RED, borderRadius: 4 }} />
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, color: r.terbit_rate >= 80 ? GREEN : r.terbit_rate >= 50 ? AMBER : RED }}>
                      {fmtPct(r.terbit_rate)}
                    </span>
                  </div>
                </td>
                <td>
                  {r.terbit > 0 ? (
                    <span style={{ fontSize: 11, fontWeight: 600, color: r.activation_rate >= 70 ? GREEN : r.activation_rate >= 40 ? AMBER : RED }}>
                      {fmtPct(r.activation_rate)}
                    </span>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── TAB 3: Segmentasi Provinsi ─── */
function SegmentasiProvinsiTab({ data, loading, bulan }) {
  const [sort, setSort] = useState('total');
  const [view, setView] = useState('stacked');

  if (loading) return <SkeletonCards />;
  if (!data?.by_provinsi?.length) return <div className="wri-state">Belum ada data provinsi</div>;

  const lb = bulanLabel(bulan);
  const rows = [...data.by_provinsi].sort((a, b) => {
    if (sort === 'terbit')    return b.terbit - a.terbit;
    if (sort === 'perbaikan') return b.perbaikan - a.perbaikan;
    if (sort === 'rate')      return b.terbit_rate - a.terbit_rate;
    return b.total - a.total;
  });

  const chartKey = `q-prov-${sort}-${view}-${bulan}`;

  return (
    <div>
      <div className="wr-table-controls" style={{ marginBottom: 12 }}>
        <div className="wr-table-left">
          <select className="wr-select" value={sort} onChange={e => setSort(e.target.value)}>
            <option value="total">Total ↓</option>
            <option value="terbit">Terbit ↓</option>
            <option value="perbaikan">Perbaikan Data ↓</option>
            <option value="rate">Terbit Rate ↓</option>
          </select>
          <span className="wr-count">{rows.length} provinsi</span>
        </div>
        <div className="wr-filter-tabs">
          {[['stacked','Volume'],['rate','Rate %']].map(([k,l]) => (
            <button key={k} className={`wr-filter-tab${view===k?' active':''}`} onClick={() => setView(k)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="wri-chart-card">
        <div className="wri-chart-title">{view === 'stacked' ? `Volume QRIS per Provinsi — ${lb}` : `Terbit Rate per Provinsi — ${lb}`}</div>
        <div style={{ position: 'relative', height: Math.max(280, Math.min(rows.length * 24, 480)) + 'px' }}>
          {view === 'stacked'
            ? <HBarStacked id={chartKey} rows={rows} keyField="provinsi" maxRows={15} />
            : <HBarRate    id={chartKey} rows={rows} keyField="provinsi" maxRows={15} />
          }
        </div>
      </div>

      <div className="wr-table-wrap" style={{ marginTop: 16 }}>
        <table className="wr-table">
          <thead>
            <tr>
              <th>#</th><th>Provinsi</th><th>Total</th>
              <th style={{ color: GREEN }}>Terbit</th>
              <th style={{ color: AMBER }}>Perbaikan</th>
              <th style={{ color: BLUE }}>Belum</th>
              <th>Terbit Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.provinsi}>
                <td>{i + 1}</td>
                <td style={{ fontWeight: 500 }}>{r.provinsi}</td>
                <td><strong>{fmtNum(r.total)}</strong></td>
                <td style={{ color: GREEN, fontWeight: 600 }}>{fmtNum(r.terbit)}</td>
                <td style={{ color: AMBER }}>{r.perbaikan > 0 ? fmtNum(r.perbaikan) : '—'}</td>
                <td style={{ color: BLUE }}>{r.belum > 0 ? fmtNum(r.belum) : '—'}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ flex: 1, height: 8, background: '#F1F5F9', borderRadius: 4, minWidth: 40, overflow: 'hidden' }}>
                      <div style={{ width: `${r.terbit_rate}%`, height: '100%', background: r.terbit_rate >= 80 ? GREEN : r.terbit_rate >= 50 ? AMBER : RED, borderRadius: 4 }} />
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, color: r.terbit_rate >= 80 ? GREEN : r.terbit_rate >= 50 ? AMBER : RED }}>
                      {fmtPct(r.terbit_rate)}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── TAB 4: Action Center ─── */
function ActionCenterTab({ data, loading }) {
  if (loading) return <SkeletonCards />;
  if (!data) return null;

  const { summary, top_perbaikan, top_terbit, top_activation, bot_activation } = data;

  const actions = [
    { icon: '🔧', label: 'Perbaikan Data',  count: n(summary?.perbaikan),          color: AMBER, desc: 'perlu koreksi data' },
    { icon: '⏳', label: 'Belum Terbit',    count: n(summary?.belum),              color: BLUE,  desc: 'antrian penerbitan' },
    { icon: '📊', label: 'Terbit tanpa TRX', count: n(summary?.terbit_outlets) - n(summary?.terbit_with_trx), color: RED, desc: 'belum bertransaksi' },
    { icon: '✅', label: 'Aktif (Terbit+TRX)', count: n(summary?.terbit_with_trx), color: GREEN, desc: 'sudah bertransaksi' },
  ].filter(a => a.count > 0);

  return (
    <div>
      {/* Risk overview */}
      <div className="wri-risk-row">
        {actions.map(a => (
          <div key={a.label} className="wri-risk-card" style={{ borderTop: `3px solid ${a.color}` }}>
            <span style={{ fontSize: 24 }}>{a.icon}</span>
            <span className="wri-risk-count" style={{ color: a.color }}>{fmtNum(a.count)}</span>
            <span className="wri-risk-label">{a.label}</span>
            <span style={{ fontSize: 10, color: 'var(--text-4)' }}>{a.desc}</span>
          </div>
        ))}
      </div>

      {/* Perbaikan Data — kategori dengan volume terbesar */}
      {top_perbaikan?.length > 0 && (
        <div className="wri-action-block" style={{ borderLeft: `4px solid ${AMBER}` }}>
          <div className="wri-action-block-head" style={{ color: '#D97706' }}>
            🔧 Prioritas 1 — Kategori dengan Perbaikan Data Terbanyak
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8, padding: '0 16px' }}>
            Fokus bantu merchant di kategori ini untuk koreksi data agar QRIS bisa segera diterbitkan
          </div>
          {top_perbaikan.map((r, i) => (
            <div key={r.kategori} className="wri-action-item">
              <div className="wri-action-item-hd">
                <span className="wri-action-num" style={{ background: AMBER }}>{i + 1}</span>
                <span className="wri-action-name">{r.kategori}</span>
                <span className="wri-action-badge wri-badge-warn">{fmtNum(r.perbaikan)} perbaikan</span>
              </div>
              <div className="wri-action-stat">
                Total: {fmtNum(r.total)} · Terbit: {fmtNum(r.terbit)} ({fmtPct(r.terbit_rate)}) · Perbaikan: {fmtNum(r.perbaikan)} ({fmtPct(r.perbaikan_rate)})
              </div>
              <div className="wri-action-steps">
                <span>① Hubungi merchant yang dalam status Perbaikan Data</span>
                <span>② Bantu koreksi: nama merchant, kategori usaha, nomor HP, atau dokumen</span>
                <span>③ Target: pindahkan ke Terbit dalam 3–5 hari kerja</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Aktivasi rendah — QRIS terbit tapi belum TRX */}
      {bot_activation?.length > 0 && (
        <div className="wri-action-block" style={{ borderLeft: `4px solid ${RED}` }}>
          <div className="wri-action-block-head" style={{ color: RED }}>
            📊 Prioritas 2 — Kategori Aktivasi QRIS Rendah (Terbit tapi Belum Transaksi)
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8, padding: '0 16px' }}>
            Merchant sudah dapat QRIS tapi belum menggunakannya — perlu pendampingan aktivasi
          </div>
          <div className="wri-action-2col">
            {bot_activation.map((r, i) => (
              <div key={r.kategori} className="wri-action-item">
                <div className="wri-action-item-hd">
                  <span className="wri-action-num" style={{ background: RED }}>{i + 1}</span>
                  <span className="wri-action-name">{r.kategori}</span>
                  <span className="wri-action-badge wri-badge-danger">Aktivasi {fmtPct(r.activation_rate)}</span>
                </div>
                <div className="wri-action-stat">
                  {fmtNum(r.terbit)} Terbit · {fmtNum(r.with_trx)} bertransaksi · {fmtNum(r.terbit - r.with_trx)} belum aktif
                </div>
                <div className="wri-action-steps">
                  <span>① Hubungi outlet yang sudah dapat QRIS tapi belum ada TRX</span>
                  <span>② Demo cara penggunaan QRIS InstaQris kepada merchant</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Best performers — replikasi */}
      {top_activation?.length > 0 && (
        <div className="wri-action-block" style={{ borderLeft: `4px solid ${GREEN}` }}>
          <div className="wri-action-block-head" style={{ color: GREEN }}>
            📈 Benchmark — Kategori Aktivasi Terbaik (Replikasi Strategi)
          </div>
          <div className="wri-action-2col">
            {top_activation.map((r, i) => (
              <div key={r.kategori} className="wri-action-item">
                <div className="wri-action-item-hd">
                  <span className="wri-action-num" style={{ background: GREEN }}>{i + 1}</span>
                  <span className="wri-action-name">{r.kategori}</span>
                  <span className="wri-action-badge wri-badge-success">Aktivasi {fmtPct(r.activation_rate)}</span>
                </div>
                <div className="wri-action-stat">
                  {fmtNum(r.terbit)} Terbit · {fmtNum(r.with_trx)} aktif · {fmtNum(r.terbit - r.with_trx)} belum
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Kategori dengan Terbit Rate terbaik */}
      {top_terbit?.length > 0 && (
        <div className="wri-action-block" style={{ borderLeft: `4px solid ${ACCENT}` }}>
          <div className="wri-action-block-head" style={{ color: ACCENT }}>
            🏆 Kategori Terbit Rate Tertinggi (min. 50 pengajuan)
          </div>
          <div className="wri-action-2col">
            {top_terbit.map((r, i) => (
              <div key={r.kategori} className="wri-action-item">
                <div className="wri-action-item-hd">
                  <span className="wri-action-num" style={{ background: ACCENT }}>{i + 1}</span>
                  <span className="wri-action-name">{r.kategori}</span>
                  <span className="wri-action-badge" style={{ background: ACCENT + '20', color: ACCENT, border: `1px solid ${ACCENT}40`, borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>
                    {fmtPct(r.terbit_rate)} terbit
                  </span>
                </div>
                <div className="wri-action-stat">
                  {fmtNum(r.total)} total · {fmtNum(r.terbit)} terbit · {fmtNum(r.perbaikan)} perbaikan
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Main Page ─── */
export default function WarRoomQris() {
  const [tab,         setTab]     = useState(0);
  const [data,        setData]    = useState(null);
  const [loading,     setLoading] = useState(true);
  const [error,       setError]   = useState(null);
  const [bulan,       setBulan]   = useState('');
  const [bulanList,   setBulanList] = useState([]);
  const [lastUpdated, setLastUpd]   = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await getDataRawQrisAnalytics({ bulan: bulan || undefined });
      setData(res);
      if (res.bulan_list?.length) setBulanList(res.bulan_list);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Gagal memuat data');
    } finally { setLoading(false); setLastUpd(new Date()); }
  }, [bulan]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const TABS = ['Ringkasan', 'Penerbitan Harian', 'Per Kategori', 'Per Provinsi', 'Action Center'];
  const activeBulan = data?.bulan || bulan || '';

  return (
    <Layout>
      <div className="wr-page">

        <div className="wr-header">
          <div>
            <div className="wr-title-row">
              <span className="wr-icon" style={{ color: ACCENT }}>
                <i className="ti ti-qrcode" style={{ fontSize: 24 }} />
              </span>
              <h1 className="wr-title">WAR-ROOM Penerbitan QRIS</h1>
              <span className="war-badge" style={{ background: ACCENT }}>QRIS</span>
            </div>
            <p className="wr-sub">
              Pipeline penerbitan QRIS InstaQris · Terbit · Perbaikan Data · Aktivasi →  TRX
              · Bulan: {bulanLabel(activeBulan) || '–'}
              {lastUpdated && (
                <span style={{ marginLeft: 8, color: 'var(--text-4)' }}>
                  · Dimuat {lastUpdated.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              )}
            </p>
          </div>
          <div className="wr-header-right">
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
          {tab === 0 && <RingkasanTab   data={data} loading={loading} bulan={activeBulan} />}
          {tab === 1 && <PenerbitanHarianTab data={data} loading={loading} bulan={activeBulan} />}
          {tab === 2 && <SegmentasiKategoriTab data={data} loading={loading} bulan={activeBulan} />}
          {tab === 3 && <SegmentasiProvinsiTab data={data} loading={loading} bulan={activeBulan} />}
          {tab === 4 && <ActionCenterTab data={data} loading={loading} />}
        </div>

      </div>
    </Layout>
  );
}
