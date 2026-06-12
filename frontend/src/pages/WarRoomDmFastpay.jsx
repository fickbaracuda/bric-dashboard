import { useState, useEffect, useRef } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getDmFastpayAnalytics } from '../services/api';

const COLOR = '#0EA5E9';
const MONTHS = ['April', 'Mei', 'Juni'];

/* ─── Format helpers ─── */
function fmtRp(v) {
  const n = Math.abs(Number(v) || 0);
  if (n >= 1e9) return `Rp ${(n / 1e9).toFixed(1)}M`;
  if (n >= 1e6) return `Rp ${(n / 1e6).toFixed(0)}jt`;
  if (n >= 1e3) return `Rp ${(n / 1e3).toFixed(0)}rb`;
  return `Rp ${Math.round(n)}`;
}
const fmtN   = v => (Number(v) || 0).toLocaleString('id');
const fmtPct = v => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`;
const pctDev = (cur, prev) => (prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : 0);

/* ─── buildInsights ─── */
function buildInsights(d) {
  if (!d) return { paragraph: '', recs: [] };

  const convJun    = d.reg_jun > 0 ? (d.akt_jun / d.reg_jun * 100) : 0;
  const convMei    = d.reg_mei > 0 ? (d.akt_mei / d.reg_mei * 100) : 0;
  const revTotalJun = (Number(d.rev_akt_jun) || 0) + (Number(d.rev_trx_jun) || 0);
  const revTotalMei = (Number(d.rev_akt_mei) || 0) + (Number(d.rev_trx_mei) || 0);
  const roiJun     = d.budget_ads_jun > 0 ? (revTotalJun / d.budget_ads_jun * 100) : 0;
  const roiMei     = d.budget_ads_mei > 0 ? (revTotalMei / d.budget_ads_mei * 100) : 0;
  const pctAkt     = pctDev(d.akt_jun, d.akt_mei);
  const pctNmat    = pctDev(d.nmat_jun, d.nmat_mei);
  const pctBudget  = pctDev(d.budget_ads_jun, d.budget_ads_mei);
  const nmatJawaPct = d.nmat_jun > 0 ? (d.nmat_jawa_jun / d.nmat_jun * 100) : 0;

  const paragraph =
    `Juni: Aktivasi ${fmtN(d.akt_jun)} (${pctAkt >= 0 ? 'naik' : 'turun'} ${Math.abs(pctAkt).toFixed(1)}% vs Mei). ` +
    `NMAT ${fmtN(d.nmat_jun)} (${pctNmat >= 0 ? 'naik' : 'turun'} ${Math.abs(pctNmat).toFixed(1)}% vs Mei). ` +
    `Conversion rate registrasi→aktivasi: ${convJun.toFixed(1)}% (Mei: ${convMei.toFixed(1)}%). ` +
    `Budget Ads Juni ${fmtRp(d.budget_ads_jun)} (${pctBudget >= 0 ? 'naik' : 'turun'} ${Math.abs(pctBudget).toFixed(1)}% vs Mei), ROI ${roiJun.toFixed(0)}% (Mei: ${roiMei.toFixed(0)}%). ` +
    `NMAT Jawa ${fmtN(d.nmat_jawa_jun)} = ${nmatJawaPct.toFixed(0)}% dari total NMAT.`;

  const recs = [];
  if (pctBudget < -15 && pctNmat < -10) {
    recs.push({ level: 'high', title: 'Budget & NMAT Sama-sama Turun', text: 'Evaluasi ulang efektivitas kanal ads. Apakah penurunan NMAT sebanding dengan efisiensi budget yang diharapkan?' });
  }
  if (pctNmat < pctBudget - 5 && pctBudget > 0) {
    recs.push({ level: 'high', title: 'Efisiensi Ads Menurun', text: `NMAT turun ${Math.abs(pctNmat).toFixed(0)}% meskipun budget naik ${pctBudget.toFixed(0)}%. Cost per NMAT meningkat — perlu review targeting.` });
  }
  if (roiJun < roiMei * 0.8 && roiMei > 0) {
    recs.push({ level: 'high', title: 'ROI Juni Melemah', text: `ROI turun dari ${roiMei.toFixed(0)}% ke ${roiJun.toFixed(0)}%. Identifikasi kanal dengan cost tinggi tapi konversi rendah.` });
  }
  if (convJun < convMei - 1) {
    recs.push({ level: 'medium', title: 'Conversion Rate Menurun', text: `Aktivasi/Registrasi: ${convJun.toFixed(1)}% vs ${convMei.toFixed(1)}% di Mei. Kualitas lead atau proses follow-up perlu dievaluasi.` });
  }
  if (nmatJawaPct < 30) {
    recs.push({ level: 'medium', title: 'Kontribusi NMAT Jawa Rendah', text: `NMAT Jawa ${fmtN(d.nmat_jawa_jun)} = ${nmatJawaPct.toFixed(0)}% dari total NMAT. Pertimbangkan meningkatkan alokasi budget untuk wilayah Jawa.` });
  }
  const pctBrand = pctDev(d.brand_exp_jun, d.brand_exp_mei);
  if (pctBrand < -20) {
    recs.push({ level: 'low', title: 'Brand Exposure Turun Signifikan', text: `Brand exposure turun ${Math.abs(pctBrand).toFixed(0)}% vs Mei. Cek alokasi retargeting ads dan kanal brand awareness.` });
  }
  return { paragraph, recs: recs.slice(0, 5) };
}

/* ─── Chart components ─── */
function BarGroupChart({ id, labels, datasets, formatFn }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: datasets.map(d => ({ ...d, borderRadius: 4 })) },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 10 } },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${formatFn ? formatFn(ctx.parsed.y) : fmtN(ctx.parsed.y)}` } },
        },
        scales: {
          x: { ticks: { font: { size: 11 } } },
          y: { grid: { color: '#f0f0f0' }, ticks: { callback: v => formatFn ? formatFn(v) : fmtN(v), font: { size: 11 } } },
        },
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
        <div className="wrfp-exec-header">
          <i className="ti ti-report-analytics" style={{ color: COLOR }} />
          Ringkasan Eksekutif
        </div>
        <p className="wrfp-exec-text">{insights.paragraph}</p>
      </div>
      {insights.recs?.length > 0 && (
        <div className="wrfp-exec-card">
          <div className="wrfp-exec-header">
            <i className="ti ti-bulb" style={{ color: COLOR }} />
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

/* ─── Comparison Table ─── */
const TABLE_ROWS = [
  { key: 'reg',         label: 'Registrasi',     rp: false },
  { key: 'akt',         label: 'Aktivasi',        rp: false },
  { key: 'nmat',        label: 'NMAT',            rp: false },
  { key: 'rev_akt',     label: 'Rev Aktivasi',    rp: true  },
  { key: 'trx',         label: 'Transaksi',       rp: false },
  { key: 'rev_trx',     label: 'Rev Transaksi',   rp: true  },
  { key: 'budget_ads',  label: 'Budget Ads All',  rp: true  },
  { key: 'nmat_jawa',   label: 'NMAT JAWA',       rp: false },
  { key: 'retargeting', label: 'Retargeting Ads', rp: true  },
  { key: 'brand_exp',   label: 'Brand Exposure',  rp: false },
];

function fmtVal(v, isRp) {
  const num = Number(v) || 0;
  if (isRp) return 'Rp' + Math.round(Math.abs(num)).toLocaleString('id-ID');
  return Math.round(Math.abs(num)).toLocaleString('id-ID');
}
function DevCell({ v, isRp }) {
  const num = Number(v) || 0;
  const color = num > 0 ? '#10B981' : num < 0 ? '#EF4444' : 'var(--text-3)';
  const sign  = num > 0 ? '+' : '';
  const text  = isRp
    ? (num < 0 ? '-Rp' : sign + 'Rp') + Math.abs(Math.round(num)).toLocaleString('id-ID')
    : sign + Math.round(num).toLocaleString('id-ID');
  return <span style={{ color, fontWeight: 600 }}>{text}</span>;
}
function PctCell({ jun, base }) {
  const j = Number(jun) || 0, b = Number(base) || 0;
  if (b === 0) return <span style={{ color: 'var(--text-3)' }}>–</span>;
  const p = ((j - b) / Math.abs(b)) * 100;
  const color = p > 0 ? '#10B981' : p < 0 ? '#EF4444' : 'var(--text-3)';
  return <span style={{ color, fontWeight: 600 }}>{p > 0 ? '+' : ''}{p.toFixed(2)}%</span>;
}

function ComparisonTable({ d }) {
  return (
    <div className="wrfp-chart-card" style={{ marginTop: 0 }}>
      <div className="wrfp-chart-title">
        <i className="ti ti-table" style={{ color: COLOR }} />
        Detail Perbandingan Bulanan
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="wrdm-table">
          <thead>
            <tr>
              <th className="wrdm-th-label">DIRECT</th>
              <th className="wrdm-th">April</th>
              <th className="wrdm-th">Mei</th>
              <th className="wrdm-th" style={{ background: 'rgba(14,165,233,0.08)', color: COLOR }}>Juni</th>
              <th className="wrdm-th wrdm-dev-th">△ vs Apr</th>
              <th className="wrdm-th wrdm-pct-th">%</th>
              <th className="wrdm-th wrdm-dev-th">△ vs Mei</th>
              <th className="wrdm-th wrdm-pct-th">%</th>
            </tr>
          </thead>
          <tbody>
            {TABLE_ROWS.map(({ key, label, rp }) => {
              const apr = d[`${key}_apr`];
              const mei = d[`${key}_mei`];
              const jun = d[`${key}_jun`];
              return (
                <tr key={key} className="wrdm-row">
                  <td className="wrdm-td-label">{label}</td>
                  <td className="wrdm-td">{fmtVal(apr, rp)}</td>
                  <td className="wrdm-td">{fmtVal(mei, rp)}</td>
                  <td className="wrdm-td" style={{ background: 'rgba(14,165,233,0.06)', fontWeight: 600 }}>{fmtVal(jun, rp)}</td>
                  <td className="wrdm-td"><DevCell v={(Number(jun)||0)-(Number(apr)||0)} isRp={rp} /></td>
                  <td className="wrdm-td"><PctCell jun={jun} base={apr} /></td>
                  <td className="wrdm-td"><DevCell v={(Number(jun)||0)-(Number(mei)||0)} isRp={rp} /></td>
                  <td className="wrdm-td"><PctCell jun={jun} base={mei} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Main ─── */
export default function WarRoomDmFastpay() {
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [result, setResult]           = useState(null);
  const [selectedTgl, setSelectedTgl] = useState(null);

  useEffect(() => { load(selectedTgl); }, [selectedTgl]);

  async function load(tgl) {
    try {
      setLoading(true); setError(null);
      const res = await getDmFastpayAnalytics(tgl);
      setResult(res);
    } catch (e) {
      setError(e.message || 'Gagal memuat data');
    } finally {
      setLoading(false);
    }
  }

  const d    = result?.data;
  const list = result?.tanggal_list || [];

  const isoDate     = result?.tanggal ? String(result.tanggal).substring(0, 10) : null;
  const tanggalLabel = isoDate
    ? new Date(isoDate + 'T12:00:00').toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
    : '-';

  const convJun     = d?.reg_jun > 0 ? (d.akt_jun / d.reg_jun * 100) : 0;
  const convMei     = d?.reg_mei > 0 ? (d.akt_mei / d.reg_mei * 100) : 0;
  const revTotalJun = d ? (Number(d.rev_akt_jun) || 0) + (Number(d.rev_trx_jun) || 0) : 0;
  const revTotalMei = d ? (Number(d.rev_akt_mei) || 0) + (Number(d.rev_trx_mei) || 0) : 0;
  const roiJun      = d?.budget_ads_jun > 0 ? (revTotalJun / d.budget_ads_jun * 100) : 0;
  const roiMei      = d?.budget_ads_mei > 0 ? (revTotalMei / d.budget_ads_mei * 100) : 0;
  const pctAkt      = d ? pctDev(d.akt_jun, d.akt_mei) : 0;
  const pctNmat     = d ? pctDev(d.nmat_jun, d.nmat_mei) : 0;
  const pctRevAkt   = d ? pctDev(d.rev_akt_jun, d.rev_akt_mei) : 0;
  const pctBudget   = d ? pctDev(d.budget_ads_jun, d.budget_ads_mei) : 0;

  const insights = buildInsights(d);
  const chartId  = d?.id || 0;

  return (
    <Layout>
      <div className="wrfp-page">

        {/* Header */}
        <div className="wrfp-header">
          <div className="wrfp-header-left">
            <i className="ti ti-speakerphone" style={{ color: COLOR, fontSize: 22 }} />
            <div>
              <div className="wrfp-header-title">WAR-ROOM DM FASTPAY</div>
              <div className="wrfp-header-meta">Perbandingan DIRECT: April · Mei · Juni</div>
            </div>
          </div>
          <div className="wrfp-header-badges">
            <span className="wrfp-badge" style={{ background: COLOR }}>DM</span>
            {isoDate && (
              <span className="wrfp-badge" style={{ background: '#F1F5F9', color: '#64748B' }}>
                <i className="ti ti-calendar" /> {tanggalLabel}
              </span>
            )}
            {list.length > 1 && (
              <select
                className="wrfp-select"
                value={selectedTgl || (list[0] ? (typeof list[0] === 'string' ? list[0] : new Date(list[0]).toISOString().slice(0, 10)) : '')}
                onChange={e => setSelectedTgl(e.target.value || null)}
              >
                {list.map(t => {
                  const s = typeof t === 'string' ? t : new Date(t).toISOString().slice(0, 10);
                  return <option key={s} value={s}>{s}</option>;
                })}
              </select>
            )}
          </div>
        </div>

        {/* States */}
        {loading && <div className="wrfp-loading"><i className="ti ti-loader-2 wrfp-spin" /> Memuat data...</div>}
        {error   && <div className="wrfp-error"><i className="ti ti-alert-circle" /> {error}</div>}
        {!loading && !error && !d && (
          <div className="wrfp-empty">
            <i className="ti ti-speakerphone" style={{ color: COLOR }} />
            <div>Belum ada data</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Sync dari Apps Script belum berjalan</div>
          </div>
        )}

        {!loading && !error && d && (<>

          {/* ── KPI Cards ── */}
          <div className="wrfp-kpi-grid">
            <KPICard
              label="Aktivasi Juni"
              value={fmtN(d.akt_jun)}
              sub={fmtPct(pctAkt) + ' vs Mei'}
              badge={pctAkt >= 0 ? '▲' : '▼'}
              badgeColor={pctAkt >= 0 ? '#059669' : '#DC2626'}
            />
            <KPICard
              label="NMAT Juni"
              value={fmtN(d.nmat_jun)}
              sub={fmtPct(pctNmat) + ' vs Mei'}
              badge={pctNmat >= 0 ? '▲' : '▼'}
              badgeColor={pctNmat >= 0 ? '#059669' : '#DC2626'}
            />
            <KPICard
              label="Conv. Rate Juni"
              value={convJun.toFixed(1) + '%'}
              sub={'Mei: ' + convMei.toFixed(1) + '%  |  Akt / Reg'}
              badge={convJun >= convMei ? '▲' : '▼'}
              badgeColor={convJun >= convMei ? '#059669' : '#DC2626'}
            />
            <KPICard
              label="Rev Aktivasi Juni"
              value={fmtRp(d.rev_akt_jun)}
              sub={fmtPct(pctRevAkt) + ' vs Mei'}
              badge={pctRevAkt >= 0 ? '▲' : '▼'}
              badgeColor={pctRevAkt >= 0 ? '#059669' : '#DC2626'}
            />
            <KPICard
              label="Budget Ads Juni"
              value={fmtRp(d.budget_ads_jun)}
              sub={fmtPct(pctBudget) + ' vs Mei'}
              badge={pctBudget >= 0 ? '▲' : '▼'}
              badgeColor={pctBudget >= 0 ? '#2563EB' : '#6B7280'}
            />
            <KPICard
              label="ROI Ads Juni"
              value={roiJun.toFixed(0) + '%'}
              sub={'Mei: ' + roiMei.toFixed(0) + '%  |  Rev / Budget'}
              badge={roiJun >= 100 ? '✓' : roiJun >= roiMei ? '▲' : '▼'}
              badgeColor={roiJun >= 100 ? '#059669' : roiJun >= roiMei ? '#2563EB' : '#DC2626'}
            />
          </div>

          {/* ── Charts baris 1 ── */}
          <div className="wrfp-charts-2col">
            <ChartCard title="📊 Registrasi & Aktivasi" height={220}>
              <BarGroupChart
                id={`reg-akt-${chartId}`}
                labels={MONTHS}
                datasets={[
                  { label: 'Registrasi', data: [d.reg_apr, d.reg_mei, d.reg_jun], backgroundColor: '#94A3B8' },
                  { label: 'Aktivasi',   data: [d.akt_apr, d.akt_mei, d.akt_jun], backgroundColor: COLOR },
                ]}
              />
            </ChartCard>
            <ChartCard title="🎯 NMAT Total vs NMAT Jawa" height={220}>
              <BarGroupChart
                id={`nmat-${chartId}`}
                labels={MONTHS}
                datasets={[
                  { label: 'NMAT Total', data: [d.nmat_apr,      d.nmat_mei,      d.nmat_jun],      backgroundColor: '#7DD3FC' },
                  { label: 'NMAT Jawa',  data: [d.nmat_jawa_apr, d.nmat_jawa_mei, d.nmat_jawa_jun], backgroundColor: COLOR     },
                ]}
              />
            </ChartCard>
          </div>

          {/* ── Charts baris 2 ── */}
          <div className="wrfp-charts-2col">
            <ChartCard title="💰 Revenue: Aktivasi & Transaksi" height={220}>
              <BarGroupChart
                id={`rev-${chartId}`}
                labels={MONTHS}
                datasets={[
                  { label: 'Rev Aktivasi',  data: [d.rev_akt_apr, d.rev_akt_mei, d.rev_akt_jun], backgroundColor: '#34D399' },
                  { label: 'Rev Transaksi', data: [d.rev_trx_apr, d.rev_trx_mei, d.rev_trx_jun], backgroundColor: '#6EE7B7' },
                ]}
                formatFn={fmtRp}
              />
            </ChartCard>
            <ChartCard title="📣 Budget Ads All & Retargeting" height={220}>
              <BarGroupChart
                id={`budget-${chartId}`}
                labels={MONTHS}
                datasets={[
                  { label: 'Budget Ads All',  data: [d.budget_ads_apr,  d.budget_ads_mei,  d.budget_ads_jun],  backgroundColor: '#FCA5A5' },
                  { label: 'Retargeting Ads', data: [d.retargeting_apr, d.retargeting_mei, d.retargeting_jun], backgroundColor: '#F87171' },
                ]}
                formatFn={fmtRp}
              />
            </ChartCard>
          </div>

          {/* ── Insight Block ── */}
          <InsightCard insights={insights} />

          {/* ── Detail Table ── */}
          <ComparisonTable d={d} />

        </>)}
      </div>
    </Layout>
  );
}
