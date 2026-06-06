import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chart, registerables } from 'chart.js';
import Layout from '../components/Layout';
import LeaderManagement from '../components/LeaderManagement';
import { getWinmeData } from '../services/api';

Chart.register(...registerables);

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

function barColor(status) {
  return { Aman: '#1D9E75', Waspada: '#F59E0B', Awas: '#EF4444', Kritis: '#DC2626' }[status] || '#9CA3AF';
}

function pillClass(status) {
  return { Aman: 'pill-aman', Waspada: 'pill-waspada', Awas: 'pill-awas', Kritis: 'pill-kritis' }[status] || 'pill-kritis';
}

const BULAN_OPTIONS = ['JAN_2026','FEB_2026','MAR_2026','APR_2026','MEI_2026','JUN_2026'];

/* ── Chart component ── */
function TrenChart({ tren }) {
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
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Winme',
            data: tren.map(t => t.winme),
            borderColor: '#378ADD',
            backgroundColor: 'rgba(55,138,221,0.08)',
            tension: 0.4,
            pointRadius: 3,
            borderWidth: 2,
            fill: true
          },
          {
            label: 'InstaQris',
            data: tren.map(t => t.instaqris),
            borderColor: '#1D9E75',
            backgroundColor: 'rgba(29,158,117,0.08)',
            tension: 0.4,
            pointRadius: 3,
            borderWidth: 2,
            fill: true
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

/* ── Main page ── */
export default function WinmeInstaqris() {
  const navigate  = useNavigate();
  const [tab,     setTab]     = useState('analitik');
  const [data,    setData]    = useState(null);
  const [bulan,   setBulan]   = useState('JUN_2026');
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [syncing, setSyncing] = useState(false);

  const loadData = async (b) => {
    setLoading(true);
    setError(null);
    try {
      const d = await getWinmeData(b);
      setData(d);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Gagal memuat data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(bulan); }, [bulan]);

  const handleSync = async () => {
    setSyncing(true);
    await loadData(bulan);
    setSyncing(false);
  };

  const bulanLabel = bulan.replace('_', ' ');

  return (
    <Layout syncedAt={data?.synced_at} bulan={bulan}>
      {/* ── Page header ── */}
      <div className="page-header">
        <div>
          <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>⚡</span>
            Winme &amp; InstaQris
            <span className="pill pill-aman" style={{ fontSize: 11 }}>WINME&amp;INSTAQRIS Group</span>
          </div>
          <div className="page-sub">
            Analitik mendalam 2 produk · Data 1–{data?.days_elapsed ?? '…'} {bulanLabel} · {data?.days_left ?? '…'} hari tersisa
          </div>
        </div>
        {tab === 'analitik' && (
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
            <button className="sync-btn" onClick={handleSync} disabled={syncing || loading}>
              <span className={syncing ? 'spin' : ''}>↻</span> Refresh
            </button>
          </div>
        )}
      </div>

      {/* ── Tab switcher ── */}
      <div className="winme-tabs">
        <button
          className={'winme-tab' + (tab === 'analitik' ? ' winme-tab--active' : '')}
          onClick={() => setTab('analitik')}
        >
          <i className="ti ti-chart-bar" /> Pencapaian Unit
        </button>
        <button
          className={'winme-tab' + (tab === 'tim' ? ' winme-tab--active' : '')}
          onClick={() => setTab('tim')}
        >
          <i className="ti ti-users" /> Leader &amp; Tim
        </button>
      </div>

      {/* ── Tim Management Tab ── */}
      {tab === 'tim' && <LeaderManagement navigate={navigate} />}

      {tab === 'analitik' && error && <div className="alert-error">{error}</div>}

      {tab === 'analitik' && (
      <>
      {/* ── 6 Summary cards ── */}
      {loading ? <SkeletonCards /> : data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 12, marginBottom: 24 }}>
          <div className="sum-card" style={{ borderLeft: '3px solid #7F77DD' }}>
            <div className="sum-label">Total Rev Grup</div>
            <div className="sum-main" style={{ fontSize: 16 }}>{fmtRev(data.summary.total_rev_grup)}</div>
          </div>
          <div className="sum-card" style={{ borderLeft: '3px solid #7F77DD' }}>
            <div className="sum-label">Est % KPI Grup</div>
            <div className="sum-main" style={{ color: data.summary.est_kpi_grup >= 100 ? '#1D9E75' : '#EF4444', fontSize: 18 }}>
              {data.summary.est_kpi_grup?.toFixed(1)}%
            </div>
          </div>
          <div className="sum-card" style={{ borderLeft: '3px solid #378ADD' }}>
            <div className="sum-label">Winme — Est KPI</div>
            <div className="sum-main" style={{ color: '#378ADD', fontSize: 18 }}>
              {data.produk[0]?.est_kpi_juni?.toFixed(1)}%
            </div>
          </div>
          <div className="sum-card" style={{ borderLeft: '3px solid #1D9E75' }}>
            <div className="sum-label">InstaQris — Est KPI</div>
            <div className="sum-main" style={{ color: '#1D9E75', fontSize: 18 }}>
              {data.produk[1]?.est_kpi_juni?.toFixed(1)}%
            </div>
          </div>
          <div className="sum-card" style={{ borderLeft: '3px solid #7F77DD' }}>
            <div className="sum-label">Kontribusi vs BMS</div>
            <div className="sum-main" style={{ fontSize: 18 }}>
              {data.summary.kontribusi_vs_bms_pct?.toFixed(2)}%
            </div>
          </div>
          <div className="sum-card" style={{ borderLeft: data.summary.surplus_target ? '3px solid #1D9E75' : '3px solid #EF4444' }}>
            <div className="sum-label">Sisa Target Grup</div>
            <div className="sum-main" style={{ color: data.summary.surplus_target ? '#1D9E75' : '#EF4444', fontSize: 16 }}>
              {data.summary.surplus_target ? 'Surplus ✓' : fmtRev(data.summary.gap_target_grup)}
            </div>
          </div>
        </div>
      )}

      {/* ── Body (hanya tampil jika tidak loading dan ada data) ── */}
      {!loading && data && (
        <>
          {/* Grid 2 kolom atas */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>

            {/* Kolom kiri — Pencapaian per produk */}
            <div className="insight-card">
              <div className="insight-title">📊 Pencapaian per Produk</div>
              {data.produk.map(p => {
                const pct = Math.min((p.est_kpi_juni / 200) * 100, 100);
                return (
                  <div key={p.nama} className="prod-card">
                    <div className="prod-header">
                      <div className="prod-name">
                        <span className="prod-dot" style={{ background: p.warna }} />
                        {p.nama}
                      </div>
                      <div>
                        <div className="prod-kpi" style={{ color: barColor(p.status) }}>
                          {p.est_kpi_juni?.toFixed(1)}%
                        </div>
                        <div style={{ textAlign: 'right', marginTop: 2 }}>
                          <span className={`pill ${pillClass(p.status)}`}>{p.status}</span>
                        </div>
                      </div>
                    </div>
                    <div className="prod-meta">
                      <div>
                        <div className="meta-item">Rev Juni aktual</div>
                        <div className="meta-val">{fmtRev(p.juni)}</div>
                      </div>
                      <div>
                        <div className="meta-item">Target RKAP</div>
                        <div className="meta-val">{fmtRev(p.target_rkap)}</div>
                      </div>
                      <div>
                        <div className="meta-item">Est Rev Juni</div>
                        <div className="meta-val">{fmtRev(p.est_rev_juni)}</div>
                      </div>
                      <div>
                        <div className="meta-item">Real % KPI</div>
                        <div className="meta-val">{p.real_kpi?.toFixed(2)}%</div>
                      </div>
                    </div>
                    <div style={{ marginTop: 10 }}>
                      <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${pct}%`, background: p.warna }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-4)', marginTop: 3 }}>
                        <span>0%</span>
                        <span style={{ color: p.warna, fontWeight: 600 }}>
                          {p.est_kpi_juni?.toFixed(1)}% dari target
                        </span>
                        <span>200%</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Kolom kanan — head-to-head + tren */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Head-to-head */}
              <div className="insight-card">
                <div className="insight-title">⚖️ Head-to-Head Perbandingan</div>
                {[
                  { label: 'Est % KPI',  w: data.produk[0]?.est_kpi_juni,  i: data.produk[1]?.est_kpi_juni,  fmt: v => v?.toFixed(1) + '%' },
                  { label: 'Real KPI',   w: data.produk[0]?.real_kpi,       i: data.produk[1]?.real_kpi,       fmt: v => v?.toFixed(2) + '%' },
                  { label: 'Rev Aktual', w: data.produk[0]?.juni,           i: data.produk[1]?.juni,           fmt: fmtRev },
                  { label: 'Kontribusi', w: data.produk[0]?.kontribusi_pct, i: data.produk[1]?.kontribusi_pct, fmt: v => v?.toFixed(1) + '%' }
                ].map(row => {
                  const maxVal = Math.max(row.w || 0, row.i || 0);
                  const wPct   = maxVal > 0 ? (row.w / maxVal) * 100 : 0;
                  const iPct   = maxVal > 0 ? (row.i / maxVal) * 100 : 0;
                  return (
                    <div key={row.label} className="cmp-row">
                      <div className="cmp-label-col">{row.label}</div>
                      <div className="cmp-bars-col">
                        <div className="cmp-bar-row">
                          <span className="cmp-bar-name" style={{ color: '#378ADD' }}>Winme</span>
                          <div className="cmp-bar-track">
                            <div className="cmp-bar-fill" style={{ width: `${wPct}%`, background: '#378ADD' }} />
                          </div>
                          <span className="cmp-bar-val">{row.fmt(row.w)}</span>
                        </div>
                        <div className="cmp-bar-row">
                          <span className="cmp-bar-name" style={{ color: '#1D9E75' }}>InstaQris</span>
                          <div className="cmp-bar-track">
                            <div className="cmp-bar-fill" style={{ width: `${iPct}%`, background: '#1D9E75' }} />
                          </div>
                          <span className="cmp-bar-val">{row.fmt(row.i)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Tren harian */}
              <div className="insight-card">
                <div className="insight-title">📈 Tren Harian (Delta Rev)</div>
                {data.tren_harian?.length > 0 ? (
                  <>
                    <div style={{ position: 'relative', height: 130 }}>
                      <TrenChart tren={data.tren_harian} />
                    </div>
                    <div style={{ display: 'flex', gap: 16, marginTop: 8, justifyContent: 'center' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-3)' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#378ADD', display: 'inline-block' }} />
                        Winme
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-3)' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#1D9E75', display: 'inline-block' }} />
                        InstaQris
                      </span>
                    </div>
                  </>
                ) : (
                  <div style={{ color: 'var(--text-4)', fontSize: 12, textAlign: 'center', padding: '20px 0' }}>
                    Data tren belum tersedia — akan muncul setelah beberapa hari sync
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Grid 2 kolom bawah */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>

            {/* Rekomendasi strategis */}
            <div className="insight-card">
              <div className="insight-title">💡 Rekomendasi Strategis</div>
              <div className="rec-card" style={{ borderLeftColor: '#1D9E75', background: '#F0FBF7' }}>
                <span className="rec-tag" style={{ background: '#D1FAE5', color: '#065F46' }}>InstaQris — Pertahankan</span>
                <div className="rec-title">Momentum InstaQris sangat kuat — jaga konsistensi</div>
                <div className="rec-text">
                  Est KPI {data.produk[1]?.est_kpi_juni?.toFixed(1)}% jauh melampaui target. Fokus pada retensi merchant aktif dan pastikan layanan tidak terganggu. Identifikasi faktor pendorong utama untuk direplikasi bulan depan. Target stretch: 200% di akhir {bulanLabel}.
                </div>
              </div>
              <div className="rec-card" style={{ borderLeftColor: '#F59E0B', background: '#FFFBEB' }}>
                <span className="rec-tag" style={{ background: '#FEF3C7', color: '#92400E' }}>Winme — Akselerasi</span>
                <div className="rec-title">Winme on track tapi gap kontribusi perlu diperhatikan</div>
                <div className="rec-text">
                  Est KPI {data.produk[0]?.est_kpi_juni?.toFixed(1)}% — aman, tapi kontribusi Winme hanya {data.produk[0]?.kontribusi_pct?.toFixed(1)}% dari total grup. Dorong cross-selling ke basis pengguna InstaQris. Evaluasi apakah target RKAP Winme sudah optimal atau perlu direvisi naik.
                </div>
              </div>
              <div className="rec-card" style={{ borderLeftColor: '#7F77DD', background: '#F5F3FF' }}>
                <span className="rec-tag" style={{ background: '#EDE9FE', color: '#5B21B6' }}>Grup — Peluang Sinergi</span>
                <div className="rec-title">Sinergi antar produk belum dioptimalkan</div>
                <div className="rec-text">
                  Winme dan InstaQris menyasar merchant yang sama. Bundling paket kombinasi bisa meningkatkan ARPU. Dorong tim sales untuk pitching paket Winme+InstaQris — estimasi uplift 15–20% dari basis merchant yang ada.
                </div>
              </div>
            </div>

            {/* Ringkasan eksekutif */}
            <div className="insight-card">
              <div className="insight-title">📋 Ringkasan Eksekutif</div>
              {[
                {
                  dot: '#1D9E75',
                  text: `Grup WINME&INSTAQRIS est KPI ${data.grup.est_kpi_juni?.toFixed(1)}% — ${data.grup.est_kpi_juni >= 100 ? 'melampaui' : 'di bawah'} target RKAP dengan total rev ${fmtRev(data.summary.total_rev_grup)} per hari ke-${data.days_elapsed}.`
                },
                {
                  dot: '#1D9E75',
                  text: `InstaQris menjadi kontributor dominan dengan ${data.produk[1]?.kontribusi_pct?.toFixed(1)}% dari total grup (${fmtRev(data.produk[1]?.juni)}) dan est KPI ${data.produk[1]?.est_kpi_juni?.toFixed(1)}% — performa luar biasa.`
                },
                {
                  dot: '#F59E0B',
                  text: `Winme berkontribusi ${data.produk[0]?.kontribusi_pct?.toFixed(1)}% dari grup (${fmtRev(data.produk[0]?.juni)}) dengan est KPI ${data.produk[0]?.est_kpi_juni?.toFixed(1)}% — ${data.produk[0]?.est_kpi_juni >= 100 ? 'aman' : 'perlu akselerasi'}. Risiko ketergantungan tinggi pada InstaQris.`
                },
                {
                  dot: '#7F77DD',
                  text: `Proyeksi akhir bulan: InstaQris ${fmtRev(data.produk[1]?.est_rev_juni)}, Winme ${fmtRev(data.produk[0]?.est_rev_juni)}, total grup ${fmtRev((data.produk[0]?.est_rev_juni || 0) + (data.produk[1]?.est_rev_juni || 0))}.`
                },
                {
                  dot: '#1D9E75',
                  text: `Rekomendasi bulan depan: pertahankan momentum InstaQris, akselerasi Winme lewat bundling, dan targetkan kontribusi grup ≥10% dari total BMS.`
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
      )}

      {/* Loading skeleton body */}
      {loading && (
        <div className="skeleton-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton-card" style={{ height: 200 }} />
          ))}
        </div>
      )}
      </>
      )}
    </Layout>
  );
}
