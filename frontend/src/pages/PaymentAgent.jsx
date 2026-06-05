import { useEffect, useRef, useState } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getPaymentAgentData } from '../services/api';

/* ── Helpers ── */
function fmtRev(n) {
  if (!n && n !== 0) return '—';
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return sign + 'Rp ' + (abs / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return sign + 'Rp ' + (abs / 1e9).toFixed(2) + 'M';
  if (abs >= 1e6)  return sign + 'Rp ' + (abs / 1e6).toFixed(1) + 'jt';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}

function fmtRevSign(n) {
  const sign = n >= 0 ? '+' : '';
  return sign + fmtRev(n);
}

function barColor(status) {
  return {
    Aman: '#1D9E75', Waspada: '#F59E0B',
    Awas: '#EF4444', Kritis: '#DC2626'
  }[status] || '#9CA3AF';
}

function pillClass(status) {
  return {
    Aman: 'pill-aman', Waspada: 'pill-waspada',
    Awas: 'pill-awas', Kritis: 'pill-kritis'
  }[status] || 'pill-kritis';
}

const WARNA_PA   = '#639922';
const WARNA_PACE = '#EF9F27';

const BULAN_OPTIONS = [
  'JAN_2026', 'FEB_2026', 'MAR_2026', 'APR_2026',
  'MEI_2026', 'JUN_2026'
];

/* ── Bar chart tren harian ── */
function TrenBarChart({ tren }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !tren?.length) return;
    if (chartRef.current) chartRef.current.destroy();

    const labels = tren.map(t => {
      const d = new Date(t.tanggal);
      return `${d.getDate()}/${d.getMonth() + 1}`;
    });

    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            label: 'Revenue Harian',
            data: tren.map(t => t.rev),
            backgroundColor: tren.map(t =>
              t.rev >= t.pace_ideal ? WARNA_PA : WARNA_PACE + '99'
            ),
            borderRadius: 3,
            order: 2
          },
          {
            type: 'line',
            label: 'Pace Ideal',
            data: tren.map(t => t.pace_ideal),
            borderColor: WARNA_PACE,
            borderDash: [4, 3],
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${fmtRev(ctx.parsed.y)}`
            }
          }
        },
        scales: {
          y: {
            ticks: {
              font: { size: 10 },
              callback: v => {
                const abs = Math.abs(v);
                if (abs >= 1e9) return 'Rp ' + (v / 1e9).toFixed(1) + 'M';
                if (abs >= 1e6) return 'Rp ' + (v / 1e6).toFixed(0) + 'jt';
                return 'Rp ' + v;
              }
            },
            grid: { color: '#F3F4F6' }
          },
          x: {
            ticks: { font: { size: 10 } },
            grid: { display: false }
          }
        }
      }
    });

    return () => { if (chartRef.current) chartRef.current.destroy(); };
  }, [tren]);

  return <canvas ref={canvasRef} />;
}

/* ── Skeleton ── */
function SkeletonCards() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 12, marginBottom: 24 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="skeleton-card" style={{ height: 80 }} />
      ))}
    </div>
  );
}

/* ── Page body (dipisah agar bisa destructure data) ── */
function PageBody({ data, bulan }) {
  const { unit, pace, kontribusi, tren_harian, days_elapsed, days_left, total_days } = data;
  const targetPacePct = total_days > 0 ? (days_elapsed / total_days) * 100 : 0;
  const aktualPct     = targetPacePct > 0 ? Math.min((unit.real_kpi / targetPacePct) * 100, 100) : 0;

  return (
    <>
      {/* ── Hero panel ── */}
      <div className="hero-panel-pa">
        <div className="hero-grid-3">

          {/* Kolom 1 — Pencapaian */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              Pencapaian bulan ini
            </div>
            <div className="hero-val-lg" style={{ color: WARNA_PA }}>{unit.real_kpi.toFixed(2)}%</div>
            <div className="hero-sub-sm">dari target {fmtRev(unit.target_rkap)}</div>
            <div className="double-bar">
              <div className="double-bar-label">
                <span>Aktual</span>
                <span>Target pace ({targetPacePct.toFixed(1)}%)</span>
              </div>
              <div className="bar-track-sm">
                <div className="bar-fill-sm" style={{ width: `${aktualPct}%`, background: WARNA_PA }} />
              </div>
              <div className="bar-track-sm" style={{ background: '#FEF3C7' }}>
                <div className="bar-fill-sm" style={{ width: '100%', background: WARNA_PACE }} />
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 5, fontSize: 10, color: 'var(--text-4)' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 10, height: 4, borderRadius: 2, background: WARNA_PA, display: 'inline-block' }} />
                  Aktual
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 10, height: 4, borderRadius: 2, background: WARNA_PACE, display: 'inline-block' }} />
                  Target pace
                </span>
              </div>
            </div>
          </div>

          {/* Kolom 2 — Proyeksi */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              Proyeksi akhir bulan
            </div>
            <div className="hero-val-lg" style={{ color: '#0F6E56' }}>{fmtRev(unit.est_rev_juni)}</div>
            <div className="hero-sub-sm">Est surplus {fmtRevSign(pace.surplus_rkap)} vs RKAP</div>
            <div className="info-box-green">
              <div className="info-box-label">Dasar proyeksi</div>
              Avg rev/hari {fmtRev(unit.avg_rev_day)} × {total_days} hari
            </div>
          </div>

          {/* Kolom 3 — Pace */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              Pace vs target harian
            </div>
            <div className="hero-val-lg" style={{ color: pace.gap_pace >= 0 ? WARNA_PA : WARNA_PACE }}>
              {fmtRevSign(pace.gap_pace)}
            </div>
            <div className="hero-sub-sm">
              {pace.gap_pace >= 0 ? 'di atas' : 'di bawah'} pace ideal per hari
            </div>
            <div className={pace.gap_pace >= 0 ? 'info-box-green' : 'info-box-amber'}>
              <div className="info-box-label">Target pace ideal</div>
              {fmtRev(pace.pace_ideal_per_hari)}/hari untuk capai RKAP tepat waktu
            </div>
          </div>
        </div>
      </div>

      {/* ── Grid 3 kolom ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr 1fr', gap: 10, marginBottom: 10 }}>

        {/* Panel kiri — Indikator pace */}
        <div className="insight-card">
          <div className="insight-title">⚡ Indikator Pace Harian</div>

          {/* Indikator 1 — Proyeksi */}
          <div className={`pace-indicator ${unit.est_kpi_juni >= 100 ? 'pi-green' : 'pi-red'}`}>
            <i
              className={`ti ${unit.est_kpi_juni >= 100 ? 'ti-circle-check' : 'ti-alert-circle'}`}
              style={{ color: unit.est_kpi_juni >= 100 ? '#1D9E75' : '#DC2626' }}
            />
            <div>
              <div className="pace-title">
                {unit.est_kpi_juni >= 100 ? 'Proyeksi akhir bulan aman' : 'Proyeksi di bawah target'}
              </div>
              <div className="pace-desc">
                {unit.est_kpi_juni >= 100
                  ? `Est ${unit.est_kpi_juni.toFixed(2)}% — akan melampaui RKAP jika pace terjaga`
                  : 'Perlu akselerasi segera'}
              </div>
            </div>
          </div>

          {/* Indikator 2 — Gap pace */}
          <div className={`pace-indicator ${pace.gap_pace >= 0 ? 'pi-green' : pace.gap_pace > -50000000 ? 'pi-amber' : 'pi-red'}`}>
            <i
              className={`ti ${pace.gap_pace >= 0 ? 'ti-trending-up' : pace.gap_pace > -50000000 ? 'ti-alert-triangle' : 'ti-alert-circle'}`}
              style={{ color: pace.gap_pace >= 0 ? '#1D9E75' : pace.gap_pace > -50000000 ? '#F59E0B' : '#DC2626' }}
            />
            <div>
              <div className="pace-title">
                {pace.gap_pace >= 0
                  ? 'Pace di atas ideal'
                  : pace.gap_pace > -50000000
                    ? 'Pace sedikit di bawah ideal'
                    : 'Pace jauh di bawah ideal'}
              </div>
              <div className="pace-desc">
                {pace.gap_pace >= 0
                  ? `${fmtRev(pace.gap_pace)}/hari di atas target`
                  : pace.gap_pace > -50000000
                    ? `Gap ${fmtRev(Math.abs(pace.gap_pace))}/hari`
                    : 'Perlu akselerasi segera'}
              </div>
            </div>
          </div>

          {/* Indikator 3 — Tren vs bulan lalu */}
          <div className={`pace-indicator ${unit.delta_vs_mei > 0 ? 'pi-green' : 'pi-red'}`}>
            <i
              className={`ti ${unit.delta_vs_mei > 0 ? 'ti-trending-up' : 'ti-trending-down'}`}
              style={{ color: unit.delta_vs_mei > 0 ? '#1D9E75' : '#DC2626' }}
            />
            <div>
              <div className="pace-title">
                {unit.delta_vs_mei > 0 ? 'Revenue naik vs bulan lalu' : 'Revenue turun vs bulan lalu'}
              </div>
              <div className="pace-desc">
                {unit.delta_vs_mei > 0
                  ? `+${fmtRev(unit.delta_vs_mei)} vs Mei`
                  : `${fmtRev(unit.delta_vs_mei)} vs Mei`}
              </div>
            </div>
          </div>
        </div>

        {/* Panel tengah — Tren bar chart */}
        <div className="insight-card">
          <div className="insight-title">📈 Tren Revenue Harian</div>
          {tren_harian?.length > 0 ? (
            <>
              <div style={{ position: 'relative', height: 160 }}>
                <TrenBarChart tren={tren_harian} />
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-3)' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: WARNA_PA, display: 'inline-block' }} />
                  Rev ≥ pace ideal
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-3)' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: WARNA_PACE + '99', display: 'inline-block' }} />
                  Rev &lt; pace ideal
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-3)' }}>
                  <span style={{ display: 'inline-block', width: 18, height: 0, borderTop: `2px dashed ${WARNA_PACE}` }} />
                  Pace ideal
                </span>
              </div>
            </>
          ) : (
            <div className="info-box-green" style={{ textAlign: 'center', padding: '20px 12px' }}>
              Data tren belum tersedia — akan muncul setelah beberapa hari sync
            </div>
          )}
        </div>

        {/* Panel kanan — Statistik detail */}
        <div className="insight-card">
          <div className="insight-title">📊 Statistik Detail</div>
          {[
            { label: 'Revenue Juni aktual', val: fmtRev(unit.juni),                    color: null },
            { label: 'Revenue Mei',         val: fmtRev(unit.mei),                     color: null },
            { label: 'Delta Juni vs Mei',   val: fmtRevSign(unit.delta_vs_mei),        color: unit.delta_vs_mei >= 0 ? '#1D9E75' : '#EF4444' },
            { label: 'Est Rev Juni',        val: fmtRev(unit.est_rev_juni),            color: null },
            { label: 'Est Surplus vs RKAP', val: fmtRevSign(pace.surplus_rkap),        color: pace.surplus_rkap >= 0 ? '#1D9E75' : '#EF4444' },
            { label: 'Kontribusi vs BMS',   val: kontribusi.rev_pct.toFixed(1) + '%',  color: null },
            { label: 'Hari tersisa',        val: days_left + ' hari',                  color: null },
            { label: 'Rev dibutuhkan/hari', val: fmtRev(pace.rev_dibutuhkan_per_hari), color: WARNA_PACE },
          ].map((row, i) => (
            <div key={i} className="stat-row-pa">
              <span className="stat-lbl">{row.label}</span>
              <span className="stat-val" style={row.color ? { color: row.color } : {}}>{row.val}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Kontribusi panel ── */}
      <div className="insight-card" style={{ marginBottom: 10 }}>
        <div className="insight-title">🏦 Kontribusi Payment Agent terhadap BMS</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            {[
              { label: 'Revenue vs BMS',    pct: kontribusi.rev_pct,     color: WARNA_PA },
              { label: 'Target RKAP vs BMS', pct: kontribusi.rkap_pct,   color: WARNA_PACE },
              { label: 'Est Rev vs BMS',    pct: kontribusi.est_rev_pct,  color: '#378ADD' },
            ].map((bar, i) => (
              <div key={i} className="contrib-bar-row">
                <div className="contrib-bar-label">
                  <span>{bar.label}</span>
                  <span style={{ fontWeight: 600, color: bar.color }}>{bar.pct.toFixed(1)}%</span>
                </div>
                <div className="contrib-track">
                  <div className="contrib-fill" style={{ width: `${Math.min(bar.pct, 100)}%`, background: bar.color }} />
                </div>
              </div>
            ))}
          </div>
          <div className="analysis-box">
            Payment Agent menyumbang <strong>{kontribusi.rev_pct.toFixed(1)}%</strong> dari seluruh revenue BMS.
            Artinya performa BMS sangat bergantung pada unit ini.
            Jika pace Payment Agent melambat bahkan 10%, dampak ke keseluruhan bisnis sangat signifikan.
            Perlu manajemen risiko dan monitoring harian yang ketat.
          </div>
        </div>
      </div>

      {/* ── Rekomendasi + Ringkasan eksekutif ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>

        {/* Panel kiri — Rekomendasi */}
        <div className="insight-card">
          <div className="insight-title">💡 Rekomendasi Strategis</div>

          {/* Kartu 1 — Pertahankan */}
          <div className="rec-card" style={{ borderLeftColor: '#1D9E75', background: '#F0FBF7' }}>
            <span className="rec-tag" style={{ background: '#D1FAE5', color: '#065F46' }}>Pertahankan — Prioritas Utama</span>
            <div className="rec-title">Jaga pace harian minimum {fmtRev(pace.pace_aktual_per_hari)}</div>
            <div className="rec-text">
              Dengan {days_left} hari tersisa, butuh rata-rata {fmtRev(pace.pace_ideal_per_hari)}/hari untuk capai RKAP tepat.
              Saat ini pace {fmtRev(pace.pace_aktual_per_hari)} — {pace.gap_pace >= 0 ? 'di atas target' : 'di bawah target'}. Tetapkan daily target internal
              tim {fmtRev(Math.round(pace.pace_ideal_per_hari * 1.03))} sebagai buffer keamanan.
            </div>
          </div>

          {/* Kartu 2 — Risiko konsentrasi */}
          <div className="rec-card" style={{ borderLeftColor: '#F59E0B', background: '#FFFBEB' }}>
            <span className="rec-tag" style={{ background: '#FEF3C7', color: '#92400E' }}>Risiko — Waspadai</span>
            <div className="rec-title">Ketergantungan BMS sangat tinggi pada unit ini</div>
            <div className="rec-text">
              {kontribusi.rev_pct.toFixed(1)}% revenue BMS bergantung pada Payment Agent. Satu gangguan
              operasional atau perlambatan bisa berdampak besar ke overall BMS. Pastikan
              backup operasional, SLA agent, dan eskalasi masalah berjalan dengan baik.
            </div>
          </div>

          {/* Kartu 3 — Kondisional */}
          {unit.est_kpi_juni >= 105 ? (
            <div className="rec-card" style={{ borderLeftColor: WARNA_PA, background: '#F0FBF7' }}>
              <span className="rec-tag" style={{ background: '#D1FAE5', color: '#065F46' }}>Peluang — Target Stretch</span>
              <div className="rec-title">Naikkan target stretch ke {Math.round(unit.est_kpi_juni * 1.05)}% untuk bulan ini</div>
              <div className="rec-text">
                Dengan momentum yang kuat (+{fmtRev(unit.delta_vs_mei)} vs Mei), ada peluang menutup
                bulan lebih tinggi. Dorong tim di minggu terakhir. Jika tercapai, jadikan
                baseline target RKAP bulan depan yang lebih ambisius.
              </div>
            </div>
          ) : (
            <div className="rec-card" style={{ borderLeftColor: '#DC2626', background: '#FEF2F2' }}>
              <span className="rec-tag" style={{ background: '#FEE2E2', color: '#991B1B' }}>Urgen — Akselerasi</span>
              <div className="rec-title">Butuh akselerasi segera untuk capai target</div>
              <div className="rec-text">
                Gap vs target: {fmtRev(Math.max(unit.target_rkap - unit.juni, 0))} dalam {days_left} hari.
                Butuh {fmtRev(pace.rev_dibutuhkan_per_hari)}/hari — {fmtRev(Math.abs(pace.gap_pace))} lebih tinggi dari pace saat ini.
                Prioritaskan akselerasi aktivasi agent dan monitoring intensif.
              </div>
            </div>
          )}
        </div>

        {/* Panel kanan — Ringkasan eksekutif */}
        <div className="insight-card">
          <div className="insight-title">📋 Ringkasan Eksekutif</div>
          {[
            {
              dot: WARNA_PA,
              text: `Payment Agent menyumbang ${kontribusi.rev_pct.toFixed(1)}% revenue dan ${kontribusi.rkap_pct.toFixed(1)}% target RKAP BMS — unit dengan kontribusi terbesar di seluruh bisnis.`
            },
            {
              dot: '#1D9E75',
              text: `Proyeksi akhir bulan: est KPI ${unit.est_kpi_juni.toFixed(2)}% (${fmtRev(unit.est_rev_juni)}), ${pace.surplus_rkap >= 0 ? 'surplus ' + fmtRev(pace.surplus_rkap) : 'gap ' + fmtRev(Math.abs(pace.surplus_rkap))} vs RKAP ${unit.est_kpi_juni >= 100 ? '— on track.' : '— perlu akselerasi.'}`
            },
            {
              dot: WARNA_PACE,
              text: `Pace harian: aktual ${fmtRev(pace.pace_aktual_per_hari)}/hari vs ideal ${fmtRev(pace.pace_ideal_per_hari)}/hari — gap ${fmtRevSign(pace.gap_pace)}. ${pace.gap_pace >= 0 ? 'Pace terjaga, on track menuju RKAP.' : 'Perlu akselerasi untuk menutup gap.'}`
            },
            {
              dot: '#DC2626',
              text: `Risiko konsentrasi tinggi: ${kontribusi.rev_pct.toFixed(1)}% revenue BMS bergantung pada satu unit. Gangguan operasional akan berdampak signifikan ke seluruh bisnis — butuh mitigasi aktif.`
            },
            {
              dot: '#7F77DD',
              text: `Target bulan depan: pertahankan pace minimum ${fmtRev(pace.pace_ideal_per_hari)}/hari. Tren ${unit.delta_vs_mei >= 0 ? 'naik ' + fmtRev(unit.delta_vs_mei) : 'turun ' + fmtRev(Math.abs(unit.delta_vs_mei))} vs Mei — ${unit.delta_vs_mei >= 0 ? 'momentum baik untuk target lebih ambisius.' : 'perlu evaluasi faktor penurunan.'}`
            }
          ].map((item, i) => (
            <div key={i} className="exec-bullet">
              <span className="exec-dot" style={{ background: item.dot }} />
              <span>{item.text}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ── Main page ── */
export default function PaymentAgent() {
  const [data,    setData]    = useState(null);
  const [bulan,   setBulan]   = useState('JUN_2026');
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const loadData = async (b) => {
    setLoading(true);
    setError(null);
    try {
      const d = await getPaymentAgentData(b);
      setData(d);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Gagal memuat data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(bulan); }, [bulan]);

  const bulanLabel = bulan.replace('_', ' ');

  return (
    <Layout syncedAt={data?.synced_at} bulan={bulan}>
      {/* ── Page header ── */}
      <div className="page-header">
        <div>
          <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <i className="ti ti-building-bank" style={{ color: WARNA_PA, fontSize: 20 }} />
            Payment Agent
            <span className="pill" style={{ background: WARNA_PA, color: '#fff', fontSize: 11, padding: '2px 8px' }}>Unit Tunggal</span>
            <span className="pill" style={{ background: WARNA_PACE, color: '#fff', fontSize: 11, padding: '2px 8px' }}>#1 Revenue BMS</span>
          </div>
          <div className="page-sub">
            Unit revenue &amp; target RKAP terbesar · Data 1–{data?.days_elapsed ?? '…'} {bulanLabel} · {data?.days_left ?? '…'} hari tersisa
          </div>
        </div>
        <div className="header-controls">
          <select
            className="select-input"
            value={bulan}
            onChange={e => setBulan(e.target.value)}
          >
            {BULAN_OPTIONS.map(b => (
              <option key={b} value={b}>{b.replace('_', ' ')}</option>
            ))}
          </select>
          <button
            className="sync-btn"
            onClick={() => loadData(bulan)}
            disabled={loading}
          >
            <span className={loading ? 'spin' : ''}>↻</span> Refresh
          </button>
        </div>
      </div>

      {error && <div className="alert-error">{error}</div>}

      {/* ── 6 Summary cards ── */}
      {loading ? <SkeletonCards /> : data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 12, marginBottom: 16 }}>
          <div className="sum-card" style={{ borderLeft: `3px solid ${WARNA_PA}` }}>
            <div className="sum-label">Revenue Juni</div>
            <div className="sum-main" style={{ fontSize: 15 }}>{fmtRev(data.unit.juni)}</div>
            <div style={{ fontSize: 11, color: data.unit.delta_vs_mei >= 0 ? '#1D9E75' : '#EF4444', marginTop: 2 }}>
              {fmtRevSign(data.unit.delta_vs_mei)} vs Mei
            </div>
          </div>
          <div className="sum-card" style={{ borderLeft: `3px solid ${WARNA_PA}` }}>
            <div className="sum-label">Target RKAP</div>
            <div className="sum-main" style={{ fontSize: 15 }}>{fmtRev(data.unit.target_rkap)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2 }}>Target bulanan penuh</div>
          </div>
          <div className="sum-card" style={{ borderLeft: `3px solid ${WARNA_PA}` }}>
            <div className="sum-label">Est Rev Juni</div>
            <div className="sum-main" style={{ fontSize: 15 }}>{fmtRev(data.unit.est_rev_juni)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2 }}>Proyeksi akhir bulan</div>
          </div>
          <div className="sum-card" style={{ borderLeft: `3px solid ${WARNA_PA}` }}>
            <div className="sum-label">Est % KPI</div>
            <div className="sum-main" style={{ fontSize: 18, color: data.unit.est_kpi_juni >= 100 ? '#1D9E75' : '#EF4444' }}>
              {data.unit.est_kpi_juni.toFixed(2)}%
            </div>
            <div style={{ fontSize: 11, color: data.unit.est_kpi_juni >= 100 ? '#1D9E75' : '#EF4444', marginTop: 2 }}>
              {data.unit.est_kpi_juni >= 100 ? '↑ Di atas target' : '↓ Di bawah target'}
            </div>
          </div>
          <div className="sum-card" style={{ borderLeft: `3px solid ${WARNA_PA}` }}>
            <div className="sum-label">Real % KPI</div>
            <div className="sum-main" style={{ fontSize: 18 }}>{data.unit.real_kpi.toFixed(2)}%</div>
            <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2 }}>Dari target bulanan</div>
          </div>
          <div className="sum-card" style={{ borderLeft: `3px solid ${WARNA_PA}` }}>
            <div className="sum-label">Avg Rev / Hari</div>
            <div className="sum-main" style={{ fontSize: 15 }}>{fmtRev(data.unit.avg_rev_day)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2 }}>{data.days_elapsed} hari berjalan</div>
          </div>
        </div>
      )}

      {/* ── Body ── */}
      {!loading && data && <PageBody data={data} bulan={bulan} />}

      {/* ── Loading skeleton body ── */}
      {loading && (
        <div className="skeleton-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton-card" style={{ height: 200 }} />
          ))}
        </div>
      )}
    </Layout>
  );
}
