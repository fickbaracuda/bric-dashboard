import { useState, useEffect, useRef } from 'react';
import Layout from '../components/Layout';
import { getMgmAnalytics } from '../services/api';
import Chart from 'chart.js/auto';

const COLOR_PRIMARY  = '#10B981';
const COLOR_AKTIV    = '#10B981';
const COLOR_REG      = '#3B82F6';
const COLOR_KONVERSI = '#F59E0B';

const TIPE_COLORS = {
  'JUARA':           '#7C3AED',
  'LIMITED EDITION': '#059669',
  'EDC SAKU MGM':    '#F97316',
  'REGULER DIRECT':  '#6B7280',
  'REGULER':         '#9CA3AF',
};

function fmt(n) {
  if (n == null) return '-';
  const num = Number(n);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'Jt';
  if (num >= 1_000)     return (num / 1_000).toFixed(1) + 'Rb';
  return num.toLocaleString('id-ID');
}

function fmtRp(n) {
  if (n == null) return '-';
  return 'Rp ' + fmt(n);
}

function fmtBulan(b) {
  if (!b) return '-';
  const [y, m] = b.split('-');
  const names = ['','Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  return `${names[parseInt(m)]} ${y}`;
}

// ─── KPI Card (reuse wrd- CSS dari Speedcash) ───────────────────
function KPICard({ icon, label, value, sub, color }) {
  return (
    <div className="wrd-kpi-card">
      <div className="wrd-kpi-icon" style={{ background: color + '20', color }}>
        <i className={`ti ti-${icon}`} />
      </div>
      <div className="wrd-kpi-body">
        <div className="wrd-kpi-value">{value}</div>
        <div className="wrd-kpi-label">{label}</div>
        {sub && <div className="wrd-kpi-sub">{sub}</div>}
      </div>
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="wrd-chart-card">
      <div className="wrd-chart-header">
        <span className="wrd-chart-title">{title}</span>
      </div>
      {children}
    </div>
  );
}

// ─── Top Upline Bar Chart (horizontal) ───────────────────────────
function TopUplineChart({ data, colorKey }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !data?.length) return;
    const ctx = ref.current.getContext('2d');
    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(r => r.upline),
        datasets: [{
          label: 'Rekrutan',
          data: data.map(r => parseInt(r.jumlah_rekrut || 0)),
          backgroundColor: (colorKey === 'aktiv' ? COLOR_AKTIV : COLOR_REG) + 'CC',
          borderRadius: 4,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true } }
      }
    });
    return () => chart.destroy();
  }, [data, colorKey]);
  return <canvas ref={ref} style={{ height: '280px' }} />;
}

// ─── Donut Chart — distribusi tipe outlet ────────────────────────
function TipeDonut({ data, title }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !data?.length) return;
    const ctx = ref.current.getContext('2d');
    const chart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: data.map(r => r.tipe_outlet),
        datasets: [{
          data: data.map(r => parseInt(r.jumlah)),
          backgroundColor: data.map(r => TIPE_COLORS[r.tipe_outlet] || '#94A3B8'),
          borderWidth: 2,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } }
        }
      }
    });
    return () => chart.destroy();
  }, [data]);
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--text-2)' }}>{title}</div>
      <canvas ref={ref} style={{ height: '180px' }} />
    </div>
  );
}

// ─── Trend Bulanan Bar Chart ──────────────────────────────────────
function TrendChart({ data }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !data?.length) return;
    const ctx = ref.current.getContext('2d');
    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(r => fmtBulan(r.bulan)),
        datasets: [
          { label: 'Aktivasi',   data: data.map(r => parseInt(r.aktivasi || 0)),
            backgroundColor: COLOR_AKTIV + 'CC', borderRadius: 4 },
          { label: 'Registrasi', data: data.map(r => parseInt(r.registrasi || 0)),
            backgroundColor: COLOR_REG + 'CC', borderRadius: 4 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top' } },
        scales: { y: { beginAtZero: true } }
      }
    });
    return () => chart.destroy();
  }, [data]);
  return <canvas ref={ref} style={{ height: '220px' }} />;
}

// ─── Main Page ───────────────────────────────────────────────────
export default function WarRoomMgmPa() {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [bulan, setBulan]       = useState(null);
  const [tab, setTab]           = useState('overview');
  const [tableTab, setTableTab] = useState('aktivasi');

  useEffect(() => { fetchData(bulan); }, [bulan]);

  async function fetchData(b) {
    setLoading(true); setError(null);
    try {
      const json = await getMgmAnalytics(b);
      setData(json);
      if (!b && json.bulan) setBulan(json.bulan);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading && !data) {
    return (
      <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1_OwT_j1qIcq2GP4ir-f5grJFI58E6Q5J5BuFsyuT_-s" gsheetLabel="MGM PA">
        <div className="wrfp-loading">
          <i className="ti ti-loader-2 wrfp-spin" />
          <span>Memuat data MGM PA…</span>
        </div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1_OwT_j1qIcq2GP4ir-f5grJFI58E6Q5J5BuFsyuT_-s" gsheetLabel="MGM PA">
        <div className="wrfp-error">
          <i className="ti ti-alert-circle" />
          <span>Gagal memuat: {error}</span>
        </div>
      </Layout>
    );
  }

  if (!data?.summary) {
    return (
      <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1_OwT_j1qIcq2GP4ir-f5grJFI58E6Q5J5BuFsyuT_-s" gsheetLabel="MGM PA">
        <div className="wrfp-empty">
          <i className="ti ti-database-off" />
          <p>Belum ada data MGM PA.</p>
          <span>Jalankan pushMgmToVPS() dari Apps Script terlebih dahulu.</span>
        </div>
      </Layout>
    );
  }

  const s = data.summary;
  const konversiRate = Math.round(
    (parseInt(s.reg_sudah_aktif) / Math.max(parseInt(s.total_registrasi), 1)) * 100
  );

  const TABS = [
    { id: 'overview', label: 'Overview',       icon: 'layout-dashboard' },
    { id: 'upline',   label: 'Top Upline',     icon: 'trophy' },
    { id: 'wilayah',  label: 'Sebaran Wilayah',icon: 'map-pin' },
    { id: 'tabel',    label: 'Data Tabel',     icon: 'table' },
  ];

  return (
    <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1_OwT_j1qIcq2GP4ir-f5grJFI58E6Q5J5BuFsyuT_-s" gsheetLabel="MGM PA">
      <div className="wrd-page">

        {/* ── Header ── */}
        <div className="wrd-header">
          <div className="wrd-header-left">
            <div className="wrd-header-badge" style={{ background: COLOR_PRIMARY + '20', color: COLOR_PRIMARY }}>
              <i className="ti ti-seeding" /> MGM
            </div>
            <div>
              <h1 className="wrd-header-title">
                <i className="ti ti-users-group" style={{ color: COLOR_PRIMARY }} /> WAR ROOM MGM PA
              </h1>
              <p className="wrd-header-sub">Member Get Member — Payment Agent Fastpay</p>
            </div>
          </div>
          <div className="wrd-header-right">
            {data.availableBulan?.length > 0 && (
              <select
                className="wrd-bulan-select"
                value={bulan || ''}
                onChange={e => setBulan(e.target.value)}
              >
                {data.availableBulan.map(b => (
                  <option key={b} value={b}>{fmtBulan(b)}</option>
                ))}
              </select>
            )}
            <button className="wrd-refresh-btn" onClick={() => fetchData(bulan)} disabled={loading}>
              <i className={`ti ti-refresh${loading ? ' wrd-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* ── KPI Cards ── */}
        <div className="wrd-kpi-grid">
          <KPICard icon="user-check" label="Total Aktivasi"
            value={fmt(s.total_aktivasi)}
            sub={`${fmt(s.aktiv_aktif)} aktif bertransaksi`}
            color={COLOR_AKTIV} />
          <KPICard icon="user-plus" label="Total Registrasi"
            value={fmt(s.total_registrasi)}
            sub={`${fmt(s.reg_belum_aktif)} belum aktif`}
            color={COLOR_REG} />
          <KPICard icon="repeat" label="Konversi Reg → Aktif"
            value={`${konversiRate}%`}
            sub={`${fmt(s.reg_sudah_aktif)} dari ${fmt(s.total_registrasi)}`}
            color={COLOR_KONVERSI} />
          <KPICard icon="arrows-right-left" label="Total TRX"
            value={fmt(s.total_trx)}
            sub={`Rev: ${fmtRp(s.total_rev)}`}
            color="#8B5CF6" />
        </div>

        {/* ── Tab Nav ── */}
        <div className="wrd-tab-nav">
          {TABS.map(t => (
            <button key={t.id}
              className={`wrd-tab-btn${tab === t.id ? ' wrd-tab-btn--active' : ''}`}
              onClick={() => setTab(t.id)}
              style={tab === t.id ? { borderColor: COLOR_PRIMARY, color: COLOR_PRIMARY } : {}}>
              <i className={`ti ti-${t.icon}`} /> {t.label}
            </button>
          ))}
        </div>

        {/* ══ TAB: OVERVIEW ══ */}
        {tab === 'overview' && (
          <div className="wrd-grid-2">
            <ChartCard title="Trend Bulanan — Aktivasi vs Registrasi">
              <TrendChart data={data.trend} />
            </ChartCard>

            <ChartCard title="Distribusi Tipe Outlet">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <TipeDonut data={data.tipe_aktivasi}  title="Aktivasi" />
                <TipeDonut data={data.tipe_registrasi} title="Registrasi" />
              </div>
            </ChartCard>

            <ChartCard title="Konversi per Upline (min. 3 registrasi)">
              <div className="wrd-table-wrap" style={{ maxHeight: 280 }}>
                <table className="wrd-table">
                  <thead>
                    <tr>
                      <th>Upline</th>
                      <th style={{ textAlign: 'right' }}>Total Reg</th>
                      <th style={{ textAlign: 'right' }}>Sudah Aktif</th>
                      <th style={{ textAlign: 'right' }}>Konversi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.konversi.map((r, i) => (
                      <tr key={i}>
                        <td><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.upline}</span></td>
                        <td style={{ textAlign: 'right' }}>{r.total_reg}</td>
                        <td style={{ textAlign: 'right' }}>{r.sudah_aktif}</td>
                        <td style={{ textAlign: 'right' }}>
                          <span className="wrd-badge" style={{
                            background: parseFloat(r.pct_konversi) >= 50 ? COLOR_AKTIV + '20' : COLOR_KONVERSI + '20',
                            color: parseFloat(r.pct_konversi) >= 50 ? COLOR_AKTIV : COLOR_KONVERSI
                          }}>
                            {r.pct_konversi}%
                          </span>
                        </td>
                      </tr>
                    ))}
                    {!data.konversi.length && (
                      <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-4)' }}>Belum ada data</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </ChartCard>

            <ChartCard title={`Ringkasan — ${fmtBulan(bulan)}`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
                {[
                  { label: 'Total Aktivasi',     val: fmt(s.total_aktivasi),   icon: 'user-check',   color: COLOR_AKTIV },
                  { label: 'Aktif Bertransaksi',  val: fmt(s.aktiv_aktif),      icon: 'bolt',         color: '#059669' },
                  { label: 'Total Registrasi',    val: fmt(s.total_registrasi), icon: 'user-plus',    color: COLOR_REG },
                  { label: 'Reg Sudah Aktif',     val: fmt(s.reg_sudah_aktif),  icon: 'circle-check', color: COLOR_AKTIV },
                  { label: 'Reg Belum Aktif',     val: fmt(s.reg_belum_aktif),  icon: 'clock',        color: COLOR_KONVERSI },
                  { label: 'Total TRX',           val: fmt(s.total_trx),        icon: 'repeat',       color: '#8B5CF6' },
                  { label: 'Total Revenue',       val: fmtRp(s.total_rev),      icon: 'coin',         color: '#EC4899' },
                ].map((item, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '8px 12px', background: 'var(--bg-page)', borderRadius: 8
                  }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-2)', fontSize: 13 }}>
                      <i className={`ti ti-${item.icon}`} style={{ color: item.color }} />
                      {item.label}
                    </span>
                    <span style={{ fontWeight: 700, color: item.color }}>{item.val}</span>
                  </div>
                ))}
              </div>
            </ChartCard>
          </div>
        )}

        {/* ══ TAB: TOP UPLINE ══ */}
        {tab === 'upline' && (
          <div className="wrd-grid-2">
            <ChartCard title="Top 15 Upline — Terbanyak Aktivasi">
              {data.top_upline_aktiv?.length
                ? <TopUplineChart data={data.top_upline_aktiv} colorKey="aktiv" />
                : <div className="wr-empty" style={{ padding: 40 }}>Belum ada data</div>}
            </ChartCard>

            <ChartCard title="Top 15 Upline — Terbanyak Registrasi">
              {data.top_upline_reg?.length
                ? <TopUplineChart data={data.top_upline_reg} colorKey="reg" />
                : <div className="wr-empty" style={{ padding: 40 }}>Belum ada data</div>}
            </ChartCard>

            <ChartCard title="Detail Top Upline — Aktivasi">
              <div className="wrd-table-wrap" style={{ maxHeight: 320 }}>
                <table className="wrd-table">
                  <thead>
                    <tr>
                      <th>#</th><th>Upline</th>
                      <th style={{ textAlign: 'right' }}>Rekrutan</th>
                      <th style={{ textAlign: 'right' }}>TRX</th>
                      <th style={{ textAlign: 'right' }}>Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_upline_aktiv.map((r, i) => (
                      <tr key={i}>
                        <td style={{ color: 'var(--text-4)', width: 32 }}>{i + 1}</td>
                        <td><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.upline}</span></td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: COLOR_AKTIV }}>{r.jumlah_rekrut}</td>
                        <td style={{ textAlign: 'right' }}>{fmt(r.total_trx)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtRp(r.total_rev)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ChartCard>

            <ChartCard title="Detail Top Upline — Registrasi">
              <div className="wrd-table-wrap" style={{ maxHeight: 320 }}>
                <table className="wrd-table">
                  <thead>
                    <tr>
                      <th>#</th><th>Upline</th>
                      <th style={{ textAlign: 'right' }}>Total Reg</th>
                      <th style={{ textAlign: 'right' }}>Sudah Aktif</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_upline_reg.map((r, i) => (
                      <tr key={i}>
                        <td style={{ color: 'var(--text-4)', width: 32 }}>{i + 1}</td>
                        <td><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.upline}</span></td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: COLOR_REG }}>{r.jumlah_rekrut}</td>
                        <td style={{ textAlign: 'right', color: COLOR_AKTIV }}>{r.sudah_aktif}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ChartCard>
          </div>
        )}

        {/* ══ TAB: SEBARAN WILAYAH ══ */}
        {tab === 'wilayah' && (
          <div className="wrd-grid-2">
            <ChartCard title="Top 10 Provinsi — Aktivasi">
              <div className="wrd-table-wrap">
                <table className="wrd-table">
                  <thead>
                    <tr><th>#</th><th>Provinsi</th><th style={{ textAlign: 'right' }}>Aktivasi</th></tr>
                  </thead>
                  <tbody>
                    {data.provinsi.map((r, i) => {
                      const max = parseInt(data.provinsi[0]?.jumlah || 1);
                      const pct = Math.round(parseInt(r.jumlah) / max * 100);
                      return (
                        <tr key={i}>
                          <td style={{ color: 'var(--text-4)', width: 32 }}>{i + 1}</td>
                          <td>
                            <div style={{ marginBottom: 3 }}>{r.nama_propinsi}</div>
                            <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: pct + '%', background: COLOR_PRIMARY, borderRadius: 2 }} />
                            </div>
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: COLOR_PRIMARY }}>{r.jumlah}</td>
                        </tr>
                      );
                    })}
                    {!data.provinsi.length && (
                      <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-4)' }}>Belum ada data</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </ChartCard>

            <ChartCard title="Sebaran Tipe Outlet — Aktivasi">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
                {data.tipe_aktivasi.map((r, i) => {
                  const max = parseInt(data.tipe_aktivasi[0]?.jumlah || 1);
                  const pct = Math.round(parseInt(r.jumlah) / max * 100);
                  const col = TIPE_COLORS[r.tipe_outlet] || '#94A3B8';
                  return (
                    <div key={i}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13 }}>
                        <span style={{ color: 'var(--text-2)' }}>{r.tipe_outlet}</span>
                        <span style={{ fontWeight: 600, color: col }}>{r.jumlah}</span>
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: pct + '%', background: col, borderRadius: 3 }} />
                      </div>
                    </div>
                  );
                })}
                {!data.tipe_aktivasi.length && (
                  <div style={{ color: 'var(--text-4)', textAlign: 'center', padding: 20 }}>Belum ada data</div>
                )}
              </div>
            </ChartCard>
          </div>
        )}

        {/* ══ TAB: DATA TABEL ══ */}
        {tab === 'tabel' && (
          <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              {[
                { id: 'aktivasi',   label: `Aktivasi (${fmt(s.total_aktivasi)})`,    color: COLOR_AKTIV },
                { id: 'registrasi', label: `Registrasi (${fmt(s.total_registrasi)})`, color: COLOR_REG }
              ].map(t => (
                <button key={t.id} onClick={() => setTableTab(t.id)} style={{
                  padding: '6px 16px', borderRadius: 8,
                  border: `2px solid ${tableTab === t.id ? t.color : 'var(--border)'}`,
                  background: tableTab === t.id ? t.color + '15' : 'transparent',
                  color: tableTab === t.id ? t.color : 'var(--text-2)',
                  fontWeight: 600, fontSize: 13, cursor: 'pointer'
                }}>
                  {t.label}
                </button>
              ))}
            </div>

            {tableTab === 'aktivasi' && (
              <div className="wrd-chart-card">
                <div className="wrd-table-wrap" style={{ maxHeight: 520 }}>
                  <table className="wrd-table">
                    <thead>
                      <tr>
                        <th>ID Outlet</th><th>Nama</th><th>Tipe</th><th>Upline</th>
                        <th>Kota</th><th>Tgl Aktif</th>
                        <th style={{ textAlign: 'right' }}>TRX</th>
                        <th style={{ textAlign: 'right' }}>Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent_aktivasi.map((r, i) => (
                        <tr key={i}>
                          <td><span style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.id_outlet}</span></td>
                          <td style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nama_pemilik}</td>
                          <td>
                            <span className="wrd-badge" style={{
                              background: (TIPE_COLORS[r.tipe_outlet] || '#9CA3AF') + '20',
                              color: TIPE_COLORS[r.tipe_outlet] || '#9CA3AF', fontSize: 10
                            }}>
                              {r.tipe_outlet || '-'}
                            </span>
                          </td>
                          <td><span style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.upline || '-'}</span></td>
                          <td style={{ fontSize: 12 }}>{r.nama_kota || '-'}</td>
                          <td style={{ fontSize: 12 }}>{r.tanggal_aktifasi ? String(r.tanggal_aktifasi).substring(0, 10) : '-'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(r.trx)}</td>
                          <td style={{ textAlign: 'right' }}>{fmtRp(r.rev)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-4)', marginTop: 8 }}>
                  Menampilkan 50 teratas
                </div>
              </div>
            )}

            {tableTab === 'registrasi' && (
              <div className="wrd-chart-card">
                <div className="wrd-table-wrap" style={{ maxHeight: 520 }}>
                  <table className="wrd-table">
                    <thead>
                      <tr>
                        <th>ID Outlet</th><th>Nama</th><th>Tipe</th><th>Upline</th>
                        <th>Kota</th><th>Tgl Reg</th><th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent_registrasi.map((r, i) => (
                        <tr key={i}>
                          <td><span style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.id_outlet}</span></td>
                          <td style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nama_pemilik}</td>
                          <td>
                            <span className="wrd-badge" style={{
                              background: (TIPE_COLORS[r.tipe_outlet] || '#9CA3AF') + '20',
                              color: TIPE_COLORS[r.tipe_outlet] || '#9CA3AF', fontSize: 10
                            }}>
                              {r.tipe_outlet || '-'}
                            </span>
                          </td>
                          <td><span style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.upline || '-'}</span></td>
                          <td style={{ fontSize: 12 }}>{r.nama_kota || '-'}</td>
                          <td style={{ fontSize: 12 }}>{r.tanggal_registrasi ? String(r.tanggal_registrasi).substring(0, 10) : '-'}</td>
                          <td>
                            <span className="wrd-badge" style={{
                              background: r.tanggal_aktifasi ? COLOR_AKTIV + '20' : COLOR_KONVERSI + '20',
                              color: r.tanggal_aktifasi ? COLOR_AKTIV : COLOR_KONVERSI,
                              fontSize: 10
                            }}>
                              {r.tanggal_aktifasi ? 'Sudah Aktif' : 'Belum Aktif'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-4)', marginTop: 8 }}>
                  Menampilkan 50 terbaru
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </Layout>
  );
}
