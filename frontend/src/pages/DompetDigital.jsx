import { useEffect, useRef, useState } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getDompetDigitalData } from '../services/api';

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
  if (!n && n !== 0) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + fmtRev(n);
}

function pillClass(status) {
  return {
    Aman: 'pill-aman', Waspada: 'pill-waspada',
    Awas: 'pill-awas', Kritis: 'pill-kritis'
  }[status] || 'pill-kritis';
}

function kpiColor(kpi) {
  if (kpi >= 100) return '#1D9E75';
  if (kpi >= 80)  return '#D97706';
  if (kpi >= 70)  return '#EF4444';
  return '#DC2626';
}

const WARNA = {
  grup:        '#D85A30',
  SpeedCash:   '#EF4444',
  'Travel B2C':'#1D9E75',
  Pulsagram:   '#378ADD'
};

const BULAN_OPTIONS = [
  'JAN_2026','FEB_2026','MAR_2026',
  'APR_2026','MEI_2026','JUN_2026','JUL_2026'
];
const MONTH_FULL_NAME = { JAN:'Januari',FEB:'Februari',MAR:'Maret',APR:'April',MEI:'Mei',JUN:'Juni',JUL:'Juli',AGU:'Agustus',SEP:'September',OKT:'Oktober',NOV:'November',DES:'Desember' };

/* ── Tren line chart ── */
function TrenLineChart({ tren }) {
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
            label: 'SpeedCash',
            data: tren.map(t => t.speedcash),
            borderColor: WARNA.SpeedCash,
            backgroundColor: WARNA.SpeedCash + '18',
            tension: 0.3, pointRadius: 3, borderWidth: 2, fill: true
          },
          {
            label: 'Travel B2C',
            data: tren.map(t => t.travel_b2c),
            borderColor: WARNA['Travel B2C'],
            backgroundColor: WARNA['Travel B2C'] + '18',
            tension: 0.3, pointRadius: 3, borderWidth: 2, fill: true
          },
          {
            label: 'Pulsagram',
            data: tren.map(t => t.pulsagram),
            borderColor: WARNA.Pulsagram,
            backgroundColor: WARNA.Pulsagram + '18',
            tension: 0.3, pointRadius: 3, borderWidth: 2, fill: true
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
          x: { ticks: { font: { size: 10 } }, grid: { display: false } }
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

/* ── Page body ── */
function PageBody({ data, bulan }) {
  const { grup, sub_units, summary, tren_harian, days_elapsed, days_left } = data;
  const bulanLabel = bulan.replace('_', ' ');
  const currMonthName = MONTH_FULL_NAME[bulan.split('_')[0]] || bulan.split('_')[0];

  /* head-to-head rows */
  const hthRows = [
    { label: 'Est % KPI',    key: 'est_kpi_juni', fmt: v => v.toFixed(1) + '%' },
    { label: 'Rev Aktual',   key: 'juni',          fmt: fmtRev },
    { label: 'Kontribusi %', key: 'kontribusi_pct', fmt: v => v.toFixed(1) + '%' },
    { label: 'Real KPI',     key: 'real_kpi',      fmt: v => v.toFixed(2) + '%' }
  ];

  return (
    <>
      {/* ── Alert banner ── */}
      {summary.ada_masalah ? (
        <div className="alert-banner alert-banner-danger" style={{ marginBottom: 14 }}>
          <i className="ti ti-alert-circle" />
          <span>
            <strong>{summary.unit_bermasalah.join(', ')}</strong> butuh perhatian —
            est KPI grup {grup.est_kpi_juni.toFixed(1)}% ({grup.status}).
            Sementara <strong>{summary.unit_aman.join(' dan ')}</strong> sudah on-track.
            Perlu akselerasi {summary.unit_bermasalah.join('/')} agar grup mencapai target.
          </span>
        </div>
      ) : (
        <div className="alert-banner alert-banner-success" style={{ marginBottom: 14 }}>
          <i className="ti ti-circle-check" />
          <span>Semua sub-unit on-track! Grup diproyeksikan mencapai target bulan ini.</span>
        </div>
      )}

      {/* ── 6 Summary cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(155px,1fr))', gap: 12, marginBottom: 16 }}>
        <div className="sum-card" style={{ borderLeft: `3px solid ${WARNA.grup}` }}>
          <div className="sum-label">Total Rev Grup</div>
          <div className="sum-main" style={{ fontSize: 15 }}>{fmtRev(grup.juni)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2 }}>Est {fmtRev(grup.est_rev_juni)}</div>
        </div>
        <div className="sum-card" style={{ borderLeft: `3px solid ${WARNA.grup}` }}>
          <div className="sum-label">Est % KPI Grup</div>
          <div className="sum-main" style={{ fontSize: 18, color: kpiColor(grup.est_kpi_juni) }}>
            {grup.est_kpi_juni.toFixed(1)}%
          </div>
          <div style={{ fontSize: 11, marginTop: 2 }}>
            <span className={pillClass(grup.status)}>{grup.status}</span>
          </div>
        </div>
        {sub_units.map(u => (
          <div key={u.nama} className="sum-card" style={{ borderLeft: `3px solid ${u.warna}` }}>
            <div className="sum-label">{u.nama}</div>
            <div className="sum-main" style={{ fontSize: 18, color: kpiColor(u.est_kpi_juni) }}>
              {u.est_kpi_juni.toFixed(1)}%
            </div>
            <div style={{ fontSize: 11, marginTop: 2 }}>
              <span className={pillClass(u.status)}>{u.status}</span>
            </div>
          </div>
        ))}
        <div className="sum-card" style={{ borderLeft: `3px solid ${summary.gap_surplus_grup >= 0 ? '#1D9E75' : '#EF4444'}` }}>
          <div className="sum-label">Gap/Surplus Grup</div>
          <div className="sum-main" style={{ fontSize: 15, color: summary.gap_surplus_grup >= 0 ? '#1D9E75' : '#EF4444' }}>
            {fmtRevSign(summary.gap_surplus_grup)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2 }}>
            {summary.gap_surplus_grup >= 0 ? 'Proyeksi surplus' : 'Proyeksi gap'}
          </div>
        </div>
      </div>

      {/* ── Grid 3 kolom sub-unit cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 10 }}>
        {sub_units.map(u => {
          const pct = Math.min((u.est_kpi_juni / 130) * 100, 100);
          return (
            <div key={u.nama} className="sub-card">
              <div className="sub-card-accent" style={{ background: u.warna }} />
              <div className="sub-header">
                <div className="sub-name">
                  <span className="sub-dot" style={{ background: u.warna }} />
                  {u.nama}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="sub-kpi" style={{ color: kpiColor(u.est_kpi_juni) }}>
                    {u.est_kpi_juni.toFixed(1)}%
                  </div>
                  <span className={pillClass(u.status)} style={{ fontSize: 10 }}>{u.status}</span>
                </div>
              </div>
              <div className="sub-meta">
                <div>
                  <div className="sub-meta-lbl">Rev {currMonthName}</div>
                  <div className="sub-meta-val">{fmtRev(u.juni)}</div>
                </div>
                <div>
                  <div className="sub-meta-lbl">Target RKAP</div>
                  <div className="sub-meta-val">{fmtRev(u.target_rkap)}</div>
                </div>
                <div>
                  <div className="sub-meta-lbl">Est Rev {currMonthName}</div>
                  <div className="sub-meta-val">{fmtRev(u.est_rev_juni)}</div>
                </div>
                <div>
                  <div className="sub-meta-lbl">Real % KPI</div>
                  <div className="sub-meta-val">{u.real_kpi.toFixed(2)}%</div>
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${pct}%`, background: u.warna }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-4)', marginTop: 3 }}>
                  <span>0%</span>
                  <span style={{ color: u.warna, fontWeight: 600 }}>{u.est_kpi_juni.toFixed(1)}%</span>
                  <span>130%</span>
                </div>
              </div>
              {u.is_bermasalah ? (
                <div className="sub-info-box sub-info-danger">
                  <i className="ti ti-alert-triangle" style={{ fontSize: 13 }} />
                  Gap {fmtRev(Math.abs(u.gap_surplus))} · butuh {fmtRev(u.rev_per_hari_dibutuhkan)}/hari sisa bulan
                </div>
              ) : (
                <div className={`sub-info-box ${u.warna === '#378ADD' ? 'sub-info-blue' : 'sub-info-success'}`}>
                  <i className="ti ti-circle-check" style={{ fontSize: 13 }} />
                  Surplus {fmtRev(u.gap_surplus)} di atas target
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Grid 2 kolom — head-to-head + health/tren ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>

        {/* Panel kiri — Head-to-head */}
        <div className="insight-card">
          <div className="insight-title">⚖️ Head-to-Head 3 Sub-unit</div>
          {hthRows.map(row => {
            const vals  = sub_units.map(u => u[row.key] || 0);
            const maxV  = Math.max(...vals, 0.01);
            return (
              <div key={row.label} className="cmp-row">
                <div className="cmp-label-col">{row.label}</div>
                <div style={{ flex: 1 }}>
                  {sub_units.map(u => (
                    <div key={u.nama} className="cmp-bar-row">
                      <span className="cmp-bar-name" style={{ color: u.warna, minWidth: 68 }}>{u.nama}</span>
                      <div className="cmp-bar-track">
                        <div className="cmp-bar-fill" style={{ width: `${((u[row.key] || 0) / maxV) * 100}%`, background: u.warna }} />
                      </div>
                      <span className="cmp-bar-val">{row.fmt(u[row.key] || 0)}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Panel kanan — Health check + Tren */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Health check */}
          <div className="insight-card">
            <div className="insight-title">🩺 Health Check Sub-unit</div>
            {sub_units.map(u => {
              let meta;
              if (u.is_bermasalah) {
                meta = `Gap ${fmtRev(Math.abs(u.gap_surplus))} · butuh ${fmtRev(u.rev_per_hari_dibutuhkan)}/hari`;
              } else if (u.gap_surplus < 10000000) {
                meta = `Surplus ${fmtRev(u.gap_surplus)} · margin tipis, pantau`;
              } else {
                meta = `Surplus ${fmtRev(u.gap_surplus)} · tinggal jaga momentum`;
              }
              return (
                <div key={u.nama} className="health-row">
                  <span className="health-dot" style={{ background: u.warna }} />
                  <div style={{ flex: 1 }}>
                    <div className="health-name">{u.nama}</div>
                    <div className="health-meta">{meta}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="health-kpi" style={{ color: kpiColor(u.est_kpi_juni) }}>
                      {u.est_kpi_juni.toFixed(1)}%
                    </div>
                    <span className={pillClass(u.status)} style={{ fontSize: 10 }}>{u.status}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Tren harian */}
          <div className="insight-card">
            <div className="insight-title">📈 Tren Harian Delta</div>
            {tren_harian?.length > 0 ? (
              <>
                <div style={{ position: 'relative', height: 130 }}>
                  <TrenLineChart tren={tren_harian} />
                </div>
                <div style={{ display: 'flex', gap: 14, marginTop: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  {sub_units.map(u => (
                    <span key={u.nama} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-3)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: u.warna, display: 'inline-block' }} />
                      {u.nama}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ color: 'var(--text-4)', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>
                Data tren belum tersedia — akan muncul setelah beberapa hari sync
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Rekomendasi + Ringkasan eksekutif ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>

        {/* Panel kiri — Rekomendasi dinamis */}
        <div className="insight-card">
          <div className="insight-title">💡 Rekomendasi Strategis</div>

          {/* Urgen dulu: unit bermasalah */}
          {sub_units.filter(u => u.is_bermasalah).map(u => (
            <div key={u.nama} className="rec-card" style={{ borderLeftColor: '#DC2626', background: '#FEF2F2' }}>
              <span className="rec-tag" style={{ background: '#FEE2E2', color: '#991B1B' }}>{u.nama} — Urgen</span>
              <div className="rec-title">{u.nama} menjadi bottleneck grup — akselerasi segera</div>
              <div className="rec-text">
                Dengan est KPI {u.est_kpi_juni.toFixed(1)}% dan gap {fmtRev(Math.abs(u.gap_surplus))},
                {u.nama} perlu push {fmtRev(u.rev_per_hari_dibutuhkan)}/hari di sisa {days_left} hari.
                Review hambatan operasional, tambah aktivitas akuisisi,
                dan pertimbangkan realokasi resource dari sub-unit yang sudah surplus.
              </div>
            </div>
          ))}

          {/* Best performer */}
          {sub_units.filter(u => u.nama === summary.best_performer).map(u => (
            <div key={u.nama} className="rec-card" style={{ borderLeftColor: '#1D9E75', background: '#F0FBF7' }}>
              <span className="rec-tag" style={{ background: '#D1FAE5', color: '#065F46' }}>{u.nama} — Pertahankan</span>
              <div className="rec-title">{u.nama} terbaik di grup — jadikan benchmark</div>
              <div className="rec-text">
                Est KPI {u.est_kpi_juni.toFixed(1)}% dengan surplus {fmtRev(u.gap_surplus)}.
                Identifikasi praktik terbaik tim {u.nama} dan replikasi
                ke sub-unit yang bermasalah. Dorong target stretch {Math.round(u.est_kpi_juni * 1.05)}%.
              </div>
            </div>
          ))}

          {/* Aman tapi bukan best performer */}
          {sub_units.filter(u => !u.is_bermasalah && u.nama !== summary.best_performer).map(u => (
            <div key={u.nama} className="rec-card" style={{ borderLeftColor: '#378ADD', background: '#E6F1FB' }}>
              <span className="rec-tag" style={{ background: '#DBEAFE', color: '#1E40AF' }}>{u.nama} — Pantau</span>
              <div className="rec-title">
                {u.nama} aman {u.gap_surplus < 10000000 ? 'tapi margin tipis' : 'dengan surplus solid'}
              </div>
              <div className="rec-text">
                Est KPI {u.est_kpi_juni.toFixed(1)}%, surplus {fmtRev(u.gap_surplus)}.
                {u.gap_surplus < 10000000
                  ? ` Surplus tipis — pantau pace harian agar tidak slip ke bawah target di sisa ${days_left} hari.`
                  : ` Momentum solid. Pertahankan pace dan identifikasi peluang untuk mendorong lebih tinggi.`}
              </div>
            </div>
          ))}

          {/* Strategi grup — selalu muncul */}
          <div className="rec-card" style={{ borderLeftColor: '#7F77DD', background: '#F5F3FF' }}>
            <span className="rec-tag" style={{ background: '#EDE9FE', color: '#5B21B6' }}>Grup — Strategi</span>
            <div className="rec-title">Optimasi alokasi resource antar sub-unit</div>
            <div className="rec-text">
              {summary.unit_aman.join(' dan ')} sudah surplus. Pertimbangkan
              redistribusi fokus tim dan anggaran promosi ke {summary.unit_bermasalah.length > 0 ? summary.unit_bermasalah.join('/') : 'semua unit'} untuk memaksimalkan kinerja grup.
              Target: bawa {summary.worst_performer} ke 95%+ agar grup bisa capai 100%.
            </div>
          </div>
        </div>

        {/* Panel kanan — Ringkasan eksekutif */}
        <div className="insight-card">
          <div className="insight-title">📋 Ringkasan Eksekutif</div>
          {[
            {
              dot: WARNA.grup,
              text: `Grup DOMPET DIGITAL SPEEDCASH est KPI ${grup.est_kpi_juni.toFixed(1)}% — ${grup.est_kpi_juni >= 100 ? 'melampaui' : 'di bawah'} target dengan proyeksi ${fmtRev(grup.est_rev_juni)} di akhir ${bulanLabel}.`
            },
            summary.ada_masalah
              ? {
                  dot: '#EF4444',
                  text: `${summary.unit_bermasalah.join(', ')} bermasalah — ` +
                    sub_units.filter(u => u.is_bermasalah).map(u =>
                      `${u.nama} est KPI ${u.est_kpi_juni.toFixed(1)}%, gap ${fmtRev(Math.abs(u.gap_surplus))}`
                    ).join('; ') + '. Butuh akselerasi segera.'
                }
              : {
                  dot: '#1D9E75',
                  text: `Semua sub-unit on-track. Tidak ada unit bermasalah — grup dalam kondisi sehat menuju akhir bulan.`
                },
            {
              dot: '#1D9E75',
              text: (() => {
                const best = sub_units.find(u => u.nama === summary.best_performer);
                return best
                  ? `${best.nama} sebagai best performer dengan est KPI ${best.est_kpi_juni.toFixed(1)}%, kontribusi ${best.kontribusi_pct.toFixed(1)}% dari total grup, surplus ${fmtRev(best.gap_surplus)}.`
                  : '';
              })()
            },
            {
              dot: '#378ADD',
              text: (() => {
                const others = sub_units.filter(u => u.nama !== summary.best_performer && !u.is_bermasalah);
                if (!others.length) return 'Semua sub-unit lain dalam kondisi bermasalah — fokus akselerasi menyeluruh.';
                return others.map(u =>
                  `${u.nama} est KPI ${u.est_kpi_juni.toFixed(1)}% (${u.gap_surplus >= 0 ? 'surplus ' + fmtRev(u.gap_surplus) : 'gap ' + fmtRev(Math.abs(u.gap_surplus))})`
                ).join('; ') + '.';
              })()
            },
            {
              dot: '#7F77DD',
              text: `Strategi kunci: ${summary.unit_bermasalah.length > 0 ? `akselerasi ${summary.unit_bermasalah.join('/')} dengan target ${fmtRev(sub_units.filter(u => u.is_bermasalah).reduce((s, u) => s + u.rev_per_hari_dibutuhkan, 0))}/hari, dan` : 'pertahankan momentum,'} manfaatkan surplus ${summary.unit_aman.join('/')} sebagai buffer kinerja grup.`
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
export default function DompetDigital() {
  const [data,    setData]    = useState(null);
  const [bulan,   setBulan]   = useState('JUL_2026');
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const loadData = async (b) => {
    setLoading(true);
    setError(null);
    try {
      const d = await getDompetDigitalData(b);
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
            <i className="ti ti-wallet" style={{ color: WARNA.grup, fontSize: 20 }} />
            Dompet Digital Speedcash
            <span className="pill" style={{ background: WARNA.grup, color: '#fff', fontSize: 11, padding: '2px 8px' }}>
              3 Sub-unit
            </span>
            {data && (
              data.summary.ada_masalah ? (
                <span className="pill" style={{ background: '#FAEEDA', color: '#633806', fontSize: 11, padding: '2px 8px' }}>
                  {data.summary.unit_bermasalah.length} Awas · {data.summary.unit_aman.length} Aman
                </span>
              ) : (
                <span className="pill" style={{ background: '#E1F5EE', color: '#085041', fontSize: 11, padding: '2px 8px' }}>
                  Semua Unit Aman
                </span>
              )
            )}
          </div>
          <div className="page-sub">
            Grup dengan {data ? (data.summary.ada_masalah ? 'mixed performance' : 'performa solid') : '…'} · Data 1–{data?.days_elapsed ?? '…'} {bulanLabel} · {data?.days_left ?? '…'} hari tersisa
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

      {loading ? <SkeletonCards /> : data && <PageBody data={data} bulan={bulan} />}

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
