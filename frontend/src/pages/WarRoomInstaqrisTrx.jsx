import { useState, useEffect, useRef } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getInstaqrisTrxAnalytics, getInstaqrisTrxExport } from '../services/api';

const COLOR  = '#7F77DD';
const THEME2 = '#E24B4A';

const SEG_COLOR = {
  high_density: '#7C3AED',
  daily_active: '#0EA5E9',
  repeat_scan:  '#059669',
  activated:    '#10B981',
  declining:    '#F59E0B',
  dormant:      '#EF4444',
  churn:        '#DC2626',
  new_merchant: '#94A3B8',
};
const SEG_LABEL = {
  high_density: 'High Density',
  daily_active: 'Daily Active',
  repeat_scan:  'Repeat Scan',
  activated:    'Activated',
  declining:    'Declining',
  dormant:      'Dormant',
  churn:        'Churn',
  new_merchant: 'New Merchant',
};

const BULAN_LABEL = { '2026-04': 'April 2026', '2026-05': 'Mei 2026', '2026-06': 'Juni 2026' };

/* ─── Format helpers ─── */
const fmtN   = v => (Number(v) || 0).toLocaleString('id');
const fmtPct = (a, b) => b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '–';

/* ─── buildInsights ─── */
function buildInsights(data) {
  if (!data?.summary) return { paragraph: '', recs: [] };
  const s = data.summary;
  const segMap = {};
  (data.segments || []).forEach(sg => { segMap[sg.segment] = parseInt(sg.count); });

  const total      = parseInt(s.total) || 0;
  const activated  = parseInt(s.activated) || 0;
  const active7d   = parseInt(s.active_7d) || 0;
  const churned    = parseInt(s.churned) || 0;
  const newM       = segMap.new_merchant || 0;
  const highDensity = segMap.high_density || 0;
  const dormant    = segMap.dormant || 0;
  const declining  = segMap.declining || 0;
  const activationRate = total > 0 ? (activated / total * 100).toFixed(1) : 0;
  const activeRate7d   = activated > 0 ? (active7d / activated * 100).toFixed(1) : 0;

  const paragraph =
    `Total ${fmtN(total)} merchant terdaftar across ${data.cohorts?.length || 0} cohort bulan. ` +
    `Activation rate: ${activationRate}% (${fmtN(activated)} merchant pernah bertransaksi). ` +
    `Active 7 hari terakhir: ${fmtN(active7d)} merchant (${activeRate7d}% dari yang pernah aktif). ` +
    `High Density: ${fmtN(highDensity)} | Churned: ${fmtN(churned)} | Dormant: ${fmtN(dormant)} | Belum aktif: ${fmtN(newM)}.`;

  const recs = [];
  if (newM > 10) recs.push({ level: 'high', title: `${fmtN(newM)} Merchant Belum Aktif`, text: 'Prioritas utama: push first scan. Kunjungi merchant, edukasi cara scan, berikan insentif pertama transaksi.' });
  if (churned > 0) recs.push({ level: 'high', title: `Recovery ${fmtN(churned)} Merchant Churn`, text: 'Follow-up langsung. Identifikasi hambatan — apakah QR rusak, merchant tutup, atau tidak ada pembeli yang scan.' });
  if (declining > 0) recs.push({ level: 'high', title: `${fmtN(declining)} Merchant Declining`, text: 'Transaksi mulai jarang. Lakukan engagement: promo, sticker refresh, atau kampanye buyer di area merchant.' });
  if (dormant > 0) recs.push({ level: 'medium', title: `Reaktivasi ${fmtN(dormant)} Merchant Dormant`, text: 'Tidak ada transaksi 31-45 hari. Cek apakah merchant masih buka. Tawarkan program reactivation reward.' });
  if (highDensity > 0) recs.push({ level: 'medium', title: `${fmtN(highDensity)} High Density Merchant`, text: 'Merchant terbaik — ambil testimonial, jadikan brand ambassador di wilayah, berikan reward loyalitas.' });
  if (Number(activationRate) < 80) recs.push({ level: 'medium', title: 'Activation Rate < 80%', text: `Hanya ${activationRate}% merchant yang pernah bertransaksi. Review proses onboarding dan edukasi first scan.` });
  return { paragraph, recs: recs.slice(0, 5) };
}

/* ─── Chart: Donut ─── */
function DonutChart({ id, labels, values, colors }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { font: { size: 11 }, padding: 8, boxWidth: 12 } } },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

/* ─── Chart: Horizontal Bar ─── */
function HBarChart({ id, labels, values, color }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: color || COLOR, borderRadius: 3 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => fmtN(ctx.parsed.x) } } },
        scales: { x: { ticks: { font: { size: 10 } } }, y: { ticks: { font: { size: 11 } } } },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

/* ─── Chart: Grouped Bar ─── */
function GroupedBarChart({ id, labels, datasets }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: datasets.map(d => ({ ...d, borderRadius: 4 })) },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 10 } }, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtN(ctx.parsed.y)}` } } },
        scales: { x: { ticks: { font: { size: 11 } } }, y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 } } } },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

/* ─── UI Components ─── */
function KPICard({ label, value, sub, badge, badgeColor }) {
  return (
    <div className="wrfp-kpi-card">
      <div className="wrfp-kpi-label">{label}</div>
      <div className="wrfp-kpi-value">
        {value}
        {badge && <span className="wrfp-kpi-badge" style={{ background: badgeColor || COLOR }}>{badge}</span>}
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

function InsightCard({ insights }) {
  if (!insights?.paragraph) return null;
  const REC_LEVEL = {
    high:   { label: 'Prioritas Tinggi', bg: '#FEE2E2', border: '#DC2626', color: '#DC2626' },
    medium: { label: 'Prioritas Sedang', bg: '#F0FDF4', border: '#10B981', color: '#059669' },
    low:    { label: 'Opsional',         bg: '#EFF6FF', border: '#3B82F6', color: '#2563EB' },
  };
  return (
    <div className="wrfp-insight-block">
      <div className="wrfp-exec-card">
        <div className="wrfp-exec-header"><i className="ti ti-report-analytics" style={{ color: COLOR }} />Ringkasan Eksekutif</div>
        <p className="wrfp-exec-text">{insights.paragraph}</p>
      </div>
      {insights.recs?.length > 0 && (
        <div className="wrfp-exec-card">
          <div className="wrfp-exec-header"><i className="ti ti-bulb" style={{ color: COLOR }} />Rekomendasi Tindakan</div>
          <div className="wrfp-recs-list">
            {insights.recs.map((r, i) => {
              const lvl = REC_LEVEL[r.level] || REC_LEVEL.low;
              return (
                <div key={i} className="wrfp-rec-item" style={{ borderLeft: `3px solid ${lvl.border}`, background: lvl.bg }}>
                  <div className="wrfp-rec-top"><span className="wrfp-rec-title">{r.title}</span><span className="wrfp-rec-level" style={{ color: lvl.color }}>{lvl.label}</span></div>
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

/* ─── Segment Badge ─── */
function SegBadge({ segment }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: 12,
      fontSize: 11, fontWeight: 600, color: '#fff',
      background: SEG_COLOR[segment] || '#94A3B8',
    }}>
      {SEG_LABEL[segment] || segment}
    </span>
  );
}

/* ─── Export ─── */
function ExportSection({ selectedBulan }) {
  const [exporting, setExporting] = useState(null);

  async function handleExport(type) {
    try {
      setExporting(type);
      const res = await getInstaqrisTrxExport({ type, bulan: selectedBulan });
      const BOM = '﻿';
      const lines = [
        res.headers.join(','),
        ...res.rows.map(r => res.headers.map(h => {
          const v = r[h] ?? '';
          return String(v).includes(',') || String(v).includes('"') ? `"${String(v).replace(/"/g, '""')}"` : String(v);
        }).join(',')),
      ];
      const blob = new Blob([BOM + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${res.filename}_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
    } catch (e) {
      alert('Export gagal: ' + (e.message || e));
    } finally {
      setExporting(null);
    }
  }

  const EXPORTS = [
    { type: 'transaksi',      icon: 'ti-table',            label: 'Data Transaksi',   desc: '16 kolom merchant master' },
    { type: 'segmentasi',     icon: 'ti-layers-intersect', label: 'Data Segmentasi',  desc: '8 segment + detail' },
    { type: 'behavior_score', icon: 'ti-chart-radar',      label: 'Behavior Score',   desc: '7 skor per merchant' },
  ];

  return (
    <div className="wrfp-chart-card" style={{ marginTop: 0 }}>
      <div className="wrfp-chart-title"><i className="ti ti-download" style={{ color: COLOR }} />Export Data</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {EXPORTS.map(e => (
          <button
            key={e.type}
            onClick={() => handleExport(e.type)}
            disabled={!!exporting}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px',
              border: `1.5px solid ${COLOR}`, borderRadius: 8, background: exporting === e.type ? '#EDE9FE' : '#F5F3FF',
              color: COLOR, fontSize: 13, fontWeight: 600, cursor: exporting ? 'not-allowed' : 'pointer',
              opacity: exporting && exporting !== e.type ? 0.5 : 1,
            }}
          >
            <i className={`ti ${e.icon}`} />
            <div style={{ textAlign: 'left' }}>
              <div>{e.label}</div>
              <div style={{ fontSize: 11, fontWeight: 400, color: '#9CA3AF' }}>{e.desc}</div>
            </div>
            {exporting === e.type && <i className="ti ti-loader-2 wrfp-spin" style={{ fontSize: 14 }} />}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── Main ─── */
export default function WarRoomInstaqrisTrx() {
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [data, setData]         = useState(null);
  const [bulan, setBulan]       = useState('');

  useEffect(() => { load(bulan || undefined); }, [bulan]);

  async function load(b) {
    try {
      setLoading(true); setError(null);
      const res = await getInstaqrisTrxAnalytics(b ? { bulan: b } : {});
      setData(res);
    } catch (e) {
      setError(e.message || 'Gagal memuat data');
    } finally {
      setLoading(false);
    }
  }

  const s        = data?.summary;
  const insights = buildInsights(data);
  const chartId  = bulan || 'all';

  const total     = parseInt(s?.total)     || 0;
  const activated = parseInt(s?.activated) || 0;
  const active7d  = parseInt(s?.active_7d) || 0;
  const totalTrx  = parseInt(s?.total_trx) || 0;
  const churned   = parseInt(s?.churned)   || 0;
  const segMap    = {};
  (data?.segments || []).forEach(sg => { segMap[sg.segment] = parseInt(sg.count); });

  return (
    <Layout>
      <div className="wrfp-page">

        {/* ── Header ── */}
        <div className="wrfp-header">
          <div className="wrfp-header-left">
            <i className="ti ti-qrcode" style={{ color: COLOR, fontSize: 22 }} />
            <div>
              <div className="wrfp-header-title">WAR-ROOM INSTAQRIS TRX</div>
              <div className="wrfp-header-meta">Merchant Behavior & Transaction Analytics</div>
            </div>
          </div>
          <div className="wrfp-header-badges">
            <span className="wrfp-badge" style={{ background: COLOR }}>IQ</span>
            <select
              className="wrfp-select"
              value={bulan}
              onChange={e => setBulan(e.target.value)}
            >
              <option value="">Semua Bulan</option>
              <option value="2026-04">April 2026</option>
              <option value="2026-05">Mei 2026</option>
              <option value="2026-06">Juni 2026</option>
            </select>
          </div>
        </div>

        {/* ── States ── */}
        {loading && <div className="wrfp-loading"><i className="ti ti-loader-2 wrfp-spin" /> Memuat data...</div>}
        {error   && <div className="wrfp-error"><i className="ti ti-alert-circle" /> {error}</div>}
        {!loading && !error && !data && (
          <div className="wrfp-empty">
            <i className="ti ti-qrcode" style={{ color: COLOR }} />
            <div>Belum ada data</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Sync dari Apps Script belum berjalan</div>
          </div>
        )}

        {!loading && !error && data && (<>

          {/* ── KPI Cards ── */}
          <div className="wrfp-kpi-grid">
            <KPICard
              label="Total Merchant"
              value={fmtN(total)}
              sub={bulan ? BULAN_LABEL[bulan] : `${data.cohorts?.length || 0} cohort bulan`}
            />
            <KPICard
              label="Activation Rate"
              value={fmtPct(activated, total)}
              sub={`${fmtN(activated)} merchant aktif`}
              badge={activated / total >= 0.8 ? '✓' : '↓'}
              badgeColor={activated / total >= 0.8 ? '#059669' : '#DC2626'}
            />
            <KPICard
              label="Active 7 Hari"
              value={fmtN(active7d)}
              sub={fmtPct(active7d, activated) + ' dari yang pernah aktif'}
              badge={active7d > 0 ? '▲' : '–'}
              badgeColor={active7d > 0 ? '#059669' : '#9CA3AF'}
            />
            <KPICard
              label="Total Transaksi"
              value={fmtN(totalTrx)}
              sub={`Avg ${Number(s?.avg_trx || 0).toFixed(1)} trx/merchant`}
            />
            <KPICard
              label="High Density"
              value={fmtN(segMap.high_density || 0)}
              sub="avg ≥ 1 trx/hari, aktif 7 hari"
              badge="★"
              badgeColor="#7C3AED"
            />
            <KPICard
              label="Churn Merchant"
              value={fmtN(churned)}
              sub={fmtPct(churned, total) + ' dari total'}
              badge={churned > 0 ? '!' : '✓'}
              badgeColor={churned > 0 ? '#DC2626' : '#059669'}
            />
          </div>

          {/* ── Charts baris 1: Segmentasi + Provinsi ── */}
          <div className="wrfp-charts-2col">
            <ChartCard title="🎯 Distribusi Segmentasi Merchant" height={240}>
              <DonutChart
                id={`seg-${chartId}`}
                labels={(data.segments || []).map(sg => SEG_LABEL[sg.segment] || sg.segment)}
                values={(data.segments || []).map(sg => parseInt(sg.count))}
                colors={(data.segments || []).map(sg => SEG_COLOR[sg.segment] || '#94A3B8')}
              />
            </ChartCard>
            <ChartCard title="🗺️ Top 10 Provinsi (by Merchant)" height={240}>
              <HBarChart
                id={`prov-${chartId}`}
                labels={(data.provinces || []).slice(0, 10).map(p => p.province || 'N/A')}
                values={(data.provinces || []).slice(0, 10).map(p => parseInt(p.merchant_count))}
                color={COLOR}
              />
            </ChartCard>
          </div>

          {/* ── Charts baris 2: Cohort + Provinsi TRX ── */}
          <div className="wrfp-charts-2col">
            <ChartCard title="📊 Perbandingan Cohort Bulanan" height={220}>
              <GroupedBarChart
                id={`cohort-${chartId}`}
                labels={(data.cohorts || []).map(c => BULAN_LABEL[c.bulan] || c.bulan)}
                datasets={[
                  { label: 'Total Merchant', data: (data.cohorts || []).map(c => parseInt(c.total)), backgroundColor: '#94A3B8' },
                  { label: 'Activated',      data: (data.cohorts || []).map(c => parseInt(c.activated)), backgroundColor: '#10B981' },
                  { label: 'Repeat (≥3 TRX)',data: (data.cohorts || []).map(c => parseInt(c.repeat_or_more)), backgroundColor: COLOR },
                ]}
              />
            </ChartCard>
            <ChartCard title="💳 Top 10 Provinsi (by Transaksi)" height={220}>
              <HBarChart
                id={`prov-trx-${chartId}`}
                labels={(data.provinces || []).slice(0, 10).map(p => p.province || 'N/A')}
                values={(data.provinces || []).slice(0, 10).map(p => parseInt(p.total_trx))}
                color={THEME2}
              />
            </ChartCard>
          </div>

          {/* ── Insight Block ── */}
          <InsightCard insights={insights} />

          {/* ── Top 20 Merchant Table ── */}
          <div className="wrfp-chart-card" style={{ marginTop: 0 }}>
            <div className="wrfp-chart-title"><i className="ti ti-trophy" style={{ color: COLOR }} />Top 20 Merchant by Transaksi</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    {['#', 'Merchant', 'Kategori', 'Kota', 'Provinsi', 'Bulan', 'TRX', 'Last Trx', 'Segment'].map(h => (
                      <th key={h} style={{ padding: '9px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, background: 'var(--bg-card)', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(data.top_merchants || []).map((m, i) => (
                    <tr key={m.merchant_id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 12px', color: 'var(--text-3)', fontWeight: 700 }}>{i + 1}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-1)', fontWeight: 500, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.merchant_name}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-3)' }}>{m.category}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-2)' }}>{m.city}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-2)' }}>{m.province}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-3)' }}>{BULAN_LABEL[m.bulan] || m.bulan}</td>
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: COLOR }}>{fmtN(m.total_transaction)}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{m.last_trx}</td>
                      <td style={{ padding: '8px 12px' }}><SegBadge segment={m.segment} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Segmentation Detail ── */}
          <div className="wrfp-chart-card" style={{ marginTop: 0 }}>
            <div className="wrfp-chart-title"><i className="ti ti-layers-intersect" style={{ color: COLOR }} />Ringkasan Segmentasi</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              {Object.entries(SEG_LABEL).map(([key, label]) => {
                const count = segMap[key] || 0;
                const pct = total > 0 ? (count / total * 100).toFixed(1) : 0;
                return (
                  <div key={key} style={{
                    padding: '12px 14px', borderRadius: 10, border: `1px solid ${SEG_COLOR[key]}33`,
                    background: SEG_COLOR[key] + '10',
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: SEG_COLOR[key], marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-1)' }}>{fmtN(count)}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{pct}% dari total</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Export Section ── */}
          <ExportSection selectedBulan={bulan || undefined} />

        </>)}
      </div>
    </Layout>
  );
}
