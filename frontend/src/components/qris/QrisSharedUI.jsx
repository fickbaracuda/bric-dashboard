import { useRef, useEffect } from 'react';
import Chart from 'chart.js/auto';
import { ACCENT, GREEN, AMBER, YELLOW, RED } from './qrisConstants';
import { fmtNum } from './qrisHelpers';

// Potongan UI kecil yang dipakai lebih dari 1 tab (KPI card, funnel, insight
// banner, chart primitive, skeleton). Semua persis sama dengan yang ada di
// WarRoomQrisControlTower.jsx sebelum refactor — cuma dipindah supaya tidak
// duplikat di tiap file tab.

export function SkeletonCards({ count = 8 }) {
  return (
    <div className="wr-summary-grid">
      {[...Array(count)].map((_, i) => (
        <div key={i} className="wr-summary-card wr-skeleton">
          <div className="wr-sk-line wr-sk-short" /><div className="wr-sk-line wr-sk-long" />
        </div>
      ))}
    </div>
  );
}

export function KPICard({ label, value, color, sub, tooltip }) {
  return (
    <div className="wr-summary-card wrqris-card" style={{ borderTop: `3px solid ${color}` }}>
      <div className="wr-card-label" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {label}
        {tooltip && <i className="ti ti-info-circle" title={tooltip} style={{ fontSize: 12, color: 'var(--text-4)', cursor: 'help' }} />}
      </div>
      <div className="wr-card-value" style={{ color }}>{value}</div>
      {sub && <div className="wr-card-sub">{sub}</div>}
    </div>
  );
}

export function InsightBanner({ insights }) {
  if (!insights.length) return null;
  return (
    <div className="wr-reco-list">
      {insights.map((ins, i) => (
        <div key={i} className={`wr-reco-card wr-reco-${ins.color}`}>
          <div className="wr-reco-title">{ins.title}</div>
          <div className="wr-reco-body">{ins.message}</div>
        </div>
      ))}
    </div>
  );
}

export function FunnelSection({ funnel }) {
  const baseline = funnel[0]?.count || 1;
  return (
    <div className="wri-chart-card">
      <div className="wri-chart-title">Funnel Pipeline — Registrasi → Terbit</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {funnel.map((s, i) => (
          <div key={s.key}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 100, fontSize: 12, color: 'var(--text-3)', textAlign: 'right', flexShrink: 0 }}>{s.label}</div>
              <div style={{ flex: 1, height: 30, background: '#F1F5F9', borderRadius: 5, overflow: 'hidden', position: 'relative' }}>
                <div style={{ width: `${Math.max((s.count / baseline) * 100, 2)}%`, height: '100%', background: ACCENT, borderRadius: 5, transition: 'width .5s ease' }} />
                <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 12, fontWeight: 700, color: '#0F172A' }}>
                  {fmtNum(s.count)}
                </span>
              </div>
              <div style={{ width: 110, fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>
                {i > 0 && <>Konversi <strong style={{ color: s.conversionRate >= 70 ? GREEN : s.conversionRate >= 40 ? AMBER : RED }}>{s.conversionRate.toFixed(1)}%</strong></>}
              </div>
            </div>
            {i > 0 && s.dropOff > 0 && (
              <div style={{ marginLeft: 110, fontSize: 11, color: RED, marginTop: 2 }}>
                ↓ Drop-off {fmtNum(s.dropOff)} outlet dari step sebelumnya
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─ Chart primitives — deps [id, data] (BUKAN cuma [id]), lihat catatan QA
 * sebelumnya: id statis per chart di sini, jadi harus depend ke `data`
 * (referensi stabil dari useMemo) supaya chart ikut update saat data
 * di-refresh, bukan cuma dibuat sekali saat mount. ─ */
export function DonutChart({ id, data, colors }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !data?.length) return;
    const chart = new Chart(ref.current, {
      type: 'doughnut',
      data: { labels: data.map(d => d.label), datasets: [{ data: data.map(d => d.count), backgroundColor: colors, borderWidth: 2, hoverOffset: 6 }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: { legend: { position: 'right', labels: { font: { size: 11 }, padding: 8, boxWidth: 12 } } },
      },
    });
    return () => chart.destroy();
  }, [id, data]);
  return <canvas key={id} ref={ref} />;
}

export function HBarChart({ id, data, color }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !data?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels: data.map(d => d.label), datasets: [{ data: data.map(d => d.count), backgroundColor: color + 'CC', borderRadius: 3 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 10 } } },
          y: { ticks: { font: { size: 10 } } },
        },
      },
    });
    return () => chart.destroy();
  }, [id, data]);
  return <canvas key={id} ref={ref} />;
}

export function AgingBucketChart({ id, data }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !data?.length) return;
    const colors = [GREEN, GREEN, YELLOW, AMBER, RED];
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels: data.map(d => d.label), datasets: [{ data: data.map(d => d.count), backgroundColor: colors, borderRadius: 4 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { font: { size: 10 } } },
          y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 } } },
        },
      },
    });
    return () => chart.destroy();
  }, [id, data]);
  return <canvas key={id} ref={ref} />;
}

export function ChartOrEmpty({ entries, children, emptyText = 'Belum ada data' }) {
  return entries.length ? children : <div className="wri-state">{emptyText}</div>;
}
