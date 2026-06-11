import { useState, useEffect, useRef, useCallback } from 'react';
import Layout from '../components/Layout';
import { getMgmAnalytics, searchMgmOutlet } from '../services/api';
import Chart from 'chart.js/auto';

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

const SPIN = { animation: 'aic-rotate 0.8s linear infinite' };

function fmt(n) {
  if (n == null) return '-';
  const num = Number(n);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'Jt';
  if (num >= 1_000)     return (num / 1_000).toFixed(1) + 'Rb';
  return num.toLocaleString('id-ID');
}
function fmtRp(n) { return n == null ? '-' : 'Rp ' + fmt(n); }
function fmtBulan(b) {
  if (!b) return '-';
  const [y, m] = b.split('-');
  const nm = ['','Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  return `${nm[parseInt(m)]} ${y}`;
}

// ─── KPI Card — pola sama persis dengan WarRoomSpeedcash ────────
function KPICard({ label, value, sub, color }) {
  return (
    <div className="wrd-kpi-card" style={{ borderTop: `3px solid ${color}` }}>
      <div className="wrd-kpi-label">{label}</div>
      <div className="wrd-kpi-value" style={{ color }}>{value}</div>
      {sub && <div className="wrd-kpi-sub">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="wrd-chart-card">
      <div className="wrd-chart-head">
        <span className="wrd-chart-title">{title}</span>
      </div>
      {children}
    </div>
  );
}

// ─── Top Upline horizontal bar chart ────────────────────────────
function TopUplineChart({ data, color }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !data?.length) return;
    const ctx = ref.current.getContext('2d');
    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(r => r.upline),
        datasets: [{
          data: data.map(r => parseInt(r.jumlah_rekrut || 0)),
          backgroundColor: color + 'CC',
          borderRadius: 4,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, ticks: { font: { size: 11 } } },
                  y: { ticks: { font: { size: 11 } } } }
      }
    });
    return () => chart.destroy();
  }, [data, color]);
  return <div style={{ height: 280 }}><canvas ref={ref} /></div>;
}

// ─── Donut distribusi tipe ───────────────────────────────────────
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
        plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } }
      }
    });
    return () => chart.destroy();
  }, [data]);
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-3)' }}>{title}</div>
      <div style={{ height: 180 }}><canvas ref={ref} /></div>
    </div>
  );
}

// ─── Trend bar chart ────────────────────────────────────────────
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
          { label: 'Aktivasi',   data: data.map(r => parseInt(r.aktivasi   || 0)),
            backgroundColor: COLOR_AKTIV + 'CC', borderRadius: 4 },
          { label: 'Registrasi', data: data.map(r => parseInt(r.registrasi || 0)),
            backgroundColor: COLOR_REG   + 'CC', borderRadius: 4 }
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
  return <div style={{ height: 220 }}><canvas ref={ref} /></div>;
}

// ─── Main Page ───────────────────────────────────────────────────
export default function WarRoomMgmPa() {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [bulan, setBulan]       = useState(null);
  const [tab, setTab]           = useState('overview');
  const [tableTab, setTableTab] = useState('aktivasi');

  // Search state
  const [searchQ, setSearchQ]         = useState('');
  const [searchRes, setSearchRes]     = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchErr, setSearchErr]     = useState(null);
  const searchTimer                   = useRef(null);

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

  const doSearch = useCallback(async (q, b) => {
    if (!q || q.trim().length < 2) { setSearchRes(null); return; }
    setSearchLoading(true); setSearchErr(null);
    try {
      const res = await searchMgmOutlet(q.trim(), b);
      setSearchRes(res);
    } catch (e) {
      setSearchErr(e.response?.data?.error || e.message);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  function onSearchChange(val) {
    setSearchQ(val);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => doSearch(val, null), 500);
  }

  const GSHEET = {
    gsheetUrl: 'https://docs.google.com/spreadsheets/d/1_OwT_j1qIcq2GP4ir-f5grJFI58E6Q5J5BuFsyuT_-s',
    gsheetLabel: 'MGM PA'
  };

  if (loading && !data) return (
    <Layout {...GSHEET}>
      <div className="wrfp-loading">
        <i className="ti ti-loader-2" style={SPIN} />
        <span>Memuat data MGM PA…</span>
      </div>
    </Layout>
  );

  if (error) return (
    <Layout {...GSHEET}>
      <div className="wrfp-error">
        <i className="ti ti-alert-circle" />
        <span>Gagal memuat: {error}</span>
      </div>
    </Layout>
  );

  if (!data?.summary) return (
    <Layout {...GSHEET}>
      <div className="wrfp-empty">
        <i className="ti ti-database-off" />
        <p>Belum ada data MGM PA.</p>
        <span>Jalankan pushMgmToVPS() dari Apps Script terlebih dahulu.</span>
      </div>
    </Layout>
  );

  const s = data.summary;
  const konversiRate = Math.round(
    (parseInt(s.reg_sudah_aktif) / Math.max(parseInt(s.total_registrasi), 1)) * 100
  );

  const TABS = [
    { id: 'overview', label: 'Overview',        icon: 'ti-layout-dashboard' },
    { id: 'upline',   label: 'Top Upline',      icon: 'ti-trophy' },
    { id: 'wilayah',  label: 'Sebaran Wilayah', icon: 'ti-map-pin' },
    { id: 'tabel',    label: 'Data Tabel',      icon: 'ti-table' },
    { id: 'cari',     label: 'Cari Outlet',     icon: 'ti-search' },
  ];

  return (
    <Layout {...GSHEET}>
      <div className="wr-page">

        {/* ── Header ── */}
        <div className="wr-header">
          <div>
            <div className="wr-title-row">
              <i className="ti ti-users-group" style={{ fontSize: 22, color: COLOR_AKTIV }} />
              <h1 className="wr-title" style={{ color: COLOR_AKTIV }}>WAR ROOM MGM PA</h1>
            </div>
            <p className="wr-sub">Member Get Member · Payment Agent Fastpay · {fmtBulan(bulan)}</p>
          </div>
          <div className="wr-header-right">
            {data.availableBulan?.length > 0 && (
              <select className="wr-select" value={bulan || ''} onChange={e => setBulan(e.target.value)}>
                {data.availableBulan.map(b => (
                  <option key={b} value={b}>{fmtBulan(b)}</option>
                ))}
              </select>
            )}
            <button className="wr-btn-update" onClick={() => fetchData(bulan)} disabled={loading}
              style={{ minWidth: 36, padding: '6px 10px' }}>
              <i className="ti ti-refresh" style={loading ? SPIN : undefined} />
            </button>
          </div>
        </div>

        {/* ── KPI Cards ── */}
        <div className="wrd-kpi-grid wrd-kpi-grid-4">
          <KPICard label="TOTAL AKTIVASI"
            value={fmt(s.total_aktivasi)}
            sub={`${fmt(s.aktiv_aktif)} aktif bertransaksi`}
            color={COLOR_AKTIV} />
          <KPICard label="TOTAL REGISTRASI"
            value={fmt(s.total_registrasi)}
            sub={`${fmt(s.reg_belum_aktif)} belum aktif`}
            color={COLOR_REG} />
          <KPICard label="KONVERSI REG → AKTIF"
            value={`${konversiRate}%`}
            sub={`${fmt(s.reg_sudah_aktif)} dari ${fmt(s.total_registrasi)}`}
            color={COLOR_KONVERSI} />
          <KPICard label="TOTAL TRX"
            value={fmt(s.total_trx)}
            sub={`Rev: ${fmtRp(s.total_rev)}`}
            color="#8B5CF6" />
        </div>

        {/* ── Tab Navigation ── */}
        <div className="wrd-tabs">
          {TABS.map(t => (
            <button key={t.id}
              className={`wrd-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
              style={tab === t.id ? { color: COLOR_AKTIV, borderBottomColor: COLOR_AKTIV } : {}}>
              <i className={`ti ${t.icon}`} style={{ marginRight: 5 }} />
              {t.label}
            </button>
          ))}
        </div>

        {/* ══ TAB: OVERVIEW ══ */}
        {tab === 'overview' && (
          <div className="wrd-tab-content">
            <div className="wrd-charts-row">
              <ChartCard title="Trend Bulanan — Aktivasi vs Registrasi">
                <TrendChart data={data.trend} />
              </ChartCard>

              <ChartCard title="Distribusi Tipe Outlet">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <TipeDonut data={data.tipe_aktivasi}   title="Aktivasi" />
                  <TipeDonut data={data.tipe_registrasi} title="Registrasi" />
                </div>
              </ChartCard>
            </div>

            <div className="wrd-charts-row">
              <ChartCard title="Konversi per Upline (min. 3 registrasi)">
                <div className="wr-table-wrap" style={{ maxHeight: 280 }}>
                  <table className="wr-table">
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
                          <td><code style={{ fontSize: 12 }}>{r.upline}</code></td>
                          <td style={{ textAlign: 'right' }}>{r.total_reg}</td>
                          <td style={{ textAlign: 'right' }}>{r.sudah_aktif}</td>
                          <td style={{ textAlign: 'right' }}>
                            <span className="wrd-badge" style={{
                              background: parseFloat(r.pct_konversi) >= 50
                                ? COLOR_AKTIV + '20' : COLOR_KONVERSI + '20',
                              color: parseFloat(r.pct_konversi) >= 50
                                ? COLOR_AKTIV : COLOR_KONVERSI
                            }}>{r.pct_konversi}%</span>
                          </td>
                        </tr>
                      ))}
                      {!data.konversi.length && (
                        <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-4)', padding: 20 }}>Belum ada data</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </ChartCard>

              <ChartCard title={`Ringkasan — ${fmtBulan(bulan)}`}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
                  {[
                    { label: 'Total Aktivasi',     val: fmt(s.total_aktivasi),   color: COLOR_AKTIV },
                    { label: 'Aktif Bertransaksi',  val: fmt(s.aktiv_aktif),      color: '#059669' },
                    { label: 'Total Registrasi',    val: fmt(s.total_registrasi), color: COLOR_REG },
                    { label: 'Reg Sudah Aktif',     val: fmt(s.reg_sudah_aktif),  color: COLOR_AKTIV },
                    { label: 'Reg Belum Aktif',     val: fmt(s.reg_belum_aktif),  color: COLOR_KONVERSI },
                    { label: 'Total TRX',           val: fmt(s.total_trx),        color: '#8B5CF6' },
                    { label: 'Total Revenue',       val: fmtRp(s.total_rev),      color: '#EC4899' },
                  ].map((item, i) => (
                    <div key={i} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '7px 12px', background: 'var(--bg-page)', borderRadius: 8
                    }}>
                      <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{item.label}</span>
                      <span style={{ fontWeight: 700, color: item.color }}>{item.val}</span>
                    </div>
                  ))}
                </div>
              </ChartCard>
            </div>
          </div>
        )}

        {/* ══ TAB: TOP UPLINE ══ */}
        {tab === 'upline' && (
          <div className="wrd-tab-content">
            <div className="wrd-charts-row">
              <ChartCard title="Top 15 Upline — Terbanyak Aktivasi">
                {data.top_upline_aktiv?.length
                  ? <TopUplineChart data={data.top_upline_aktiv} color={COLOR_AKTIV} />
                  : <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-4)' }}>Belum ada data</div>}
              </ChartCard>
              <ChartCard title="Top 15 Upline — Terbanyak Registrasi">
                {data.top_upline_reg?.length
                  ? <TopUplineChart data={data.top_upline_reg} color={COLOR_REG} />
                  : <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-4)' }}>Belum ada data</div>}
              </ChartCard>
            </div>

            <div className="wrd-charts-row">
              <ChartCard title="Detail Top Upline — Aktivasi">
                <div className="wr-table-wrap" style={{ maxHeight: 320 }}>
                  <table className="wr-table">
                    <thead>
                      <tr><th>#</th><th>Upline</th>
                        <th style={{ textAlign: 'right' }}>Rekrutan</th>
                        <th style={{ textAlign: 'right' }}>TRX</th>
                        <th style={{ textAlign: 'right' }}>Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.top_upline_aktiv.map((r, i) => (
                        <tr key={i}>
                          <td style={{ color: 'var(--text-4)', width: 28 }}>{i + 1}</td>
                          <td><code style={{ fontSize: 11 }}>{r.upline}</code></td>
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
                <div className="wr-table-wrap" style={{ maxHeight: 320 }}>
                  <table className="wr-table">
                    <thead>
                      <tr><th>#</th><th>Upline</th>
                        <th style={{ textAlign: 'right' }}>Total Reg</th>
                        <th style={{ textAlign: 'right' }}>Sudah Aktif</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.top_upline_reg.map((r, i) => (
                        <tr key={i}>
                          <td style={{ color: 'var(--text-4)', width: 28 }}>{i + 1}</td>
                          <td><code style={{ fontSize: 11 }}>{r.upline}</code></td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: COLOR_REG }}>{r.jumlah_rekrut}</td>
                          <td style={{ textAlign: 'right', color: COLOR_AKTIV }}>{r.sudah_aktif}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </ChartCard>
            </div>
          </div>
        )}

        {/* ══ TAB: SEBARAN WILAYAH ══ */}
        {tab === 'wilayah' && (
          <div className="wrd-tab-content">
            <div className="wrd-charts-row">
              <ChartCard title="Top 10 Provinsi — Aktivasi">
                <div className="wr-table-wrap">
                  <table className="wr-table">
                    <thead>
                      <tr><th>#</th><th>Provinsi</th><th style={{ textAlign: 'right' }}>Aktivasi</th></tr>
                    </thead>
                    <tbody>
                      {data.provinsi.map((r, i) => {
                        const pct = Math.round(parseInt(r.jumlah) / parseInt(data.provinsi[0]?.jumlah || 1) * 100);
                        return (
                          <tr key={i}>
                            <td style={{ color: 'var(--text-4)', width: 28 }}>{i + 1}</td>
                            <td>
                              <div style={{ marginBottom: 3 }}>{r.nama_propinsi}</div>
                              <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: pct + '%', background: COLOR_AKTIV }} />
                              </div>
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: 600, color: COLOR_AKTIV }}>{r.jumlah}</td>
                          </tr>
                        );
                      })}
                      {!data.provinsi.length && (
                        <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-4)', padding: 20 }}>Belum ada data</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </ChartCard>

              <ChartCard title="Sebaran Tipe Outlet — Aktivasi">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
                  {data.tipe_aktivasi.map((r, i) => {
                    const pct = Math.round(parseInt(r.jumlah) / parseInt(data.tipe_aktivasi[0]?.jumlah || 1) * 100);
                    const col = TIPE_COLORS[r.tipe_outlet] || '#94A3B8';
                    return (
                      <div key={i}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13 }}>
                          <span style={{ color: 'var(--text-2)' }}>{r.tipe_outlet}</span>
                          <span style={{ fontWeight: 600, color: col }}>{r.jumlah}</span>
                        </div>
                        <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: pct + '%', background: col }} />
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
          </div>
        )}

        {/* ══ TAB: DATA TABEL ══ */}
        {tab === 'tabel' && (
          <div className="wrd-tab-content">
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              {[
                { id: 'aktivasi',   label: `Aktivasi (${fmt(s.total_aktivasi)})`,     color: COLOR_AKTIV },
                { id: 'registrasi', label: `Registrasi (${fmt(s.total_registrasi)})`, color: COLOR_REG }
              ].map(t => (
                <button key={t.id} onClick={() => setTableTab(t.id)} style={{
                  padding: '6px 16px', borderRadius: 8,
                  border: `2px solid ${tableTab === t.id ? t.color : 'var(--border)'}`,
                  background: tableTab === t.id ? t.color + '15' : 'transparent',
                  color: tableTab === t.id ? t.color : 'var(--text-2)',
                  fontWeight: 600, fontSize: 13, cursor: 'pointer', transition: 'all .15s'
                }}>{t.label}</button>
              ))}
            </div>

            {tableTab === 'aktivasi' && (
              <div className="wrd-chart-card">
                <div className="wr-table-wrap" style={{ maxHeight: 520 }}>
                  <table className="wr-table">
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
                          <td><code style={{ fontSize: 11 }}>{r.id_outlet}</code></td>
                          <td style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nama_pemilik}</td>
                          <td>
                            <span className="wrd-badge" style={{
                              background: (TIPE_COLORS[r.tipe_outlet] || '#9CA3AF') + '20',
                              color: TIPE_COLORS[r.tipe_outlet] || '#9CA3AF', fontSize: 10
                            }}>{r.tipe_outlet || '-'}</span>
                          </td>
                          <td><code style={{ fontSize: 11 }}>{r.upline || '-'}</code></td>
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
                <div className="wr-table-wrap" style={{ maxHeight: 520 }}>
                  <table className="wr-table">
                    <thead>
                      <tr>
                        <th>ID Outlet</th><th>Nama</th><th>Tipe</th><th>Upline</th>
                        <th>Kota</th><th>Tgl Reg</th><th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent_registrasi.map((r, i) => (
                        <tr key={i}>
                          <td><code style={{ fontSize: 11 }}>{r.id_outlet}</code></td>
                          <td style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nama_pemilik}</td>
                          <td>
                            <span className="wrd-badge" style={{
                              background: (TIPE_COLORS[r.tipe_outlet] || '#9CA3AF') + '20',
                              color: TIPE_COLORS[r.tipe_outlet] || '#9CA3AF', fontSize: 10
                            }}>{r.tipe_outlet || '-'}</span>
                          </td>
                          <td><code style={{ fontSize: 11 }}>{r.upline || '-'}</code></td>
                          <td style={{ fontSize: 12 }}>{r.nama_kota || '-'}</td>
                          <td style={{ fontSize: 12 }}>{r.tanggal_registrasi ? String(r.tanggal_registrasi).substring(0, 10) : '-'}</td>
                          <td>
                            <span className="wrd-badge" style={{
                              background: r.tanggal_aktifasi ? COLOR_AKTIV + '20' : COLOR_KONVERSI + '20',
                              color: r.tanggal_aktifasi ? COLOR_AKTIV : COLOR_KONVERSI, fontSize: 10
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

        {/* ══ TAB: CARI OUTLET ══ */}
        {tab === 'cari' && (
          <div className="wrd-tab-content">
            {/* Search Box */}
            <div className="wrd-chart-card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
              <i className="ti ti-search" style={{ color: 'var(--text-4)', fontSize: 18, flexShrink: 0 }} />
              <input
                type="text"
                value={searchQ}
                onChange={e => onSearchChange(e.target.value)}
                placeholder="Ketik ID Outlet atau ID Upline (min. 2 karakter)…"
                autoFocus
                style={{
                  flex: 1, border: 'none', outline: 'none', fontSize: 14,
                  background: 'transparent', color: 'var(--text-1)'
                }}
              />
              {searchQ && (
                <button onClick={() => { setSearchQ(''); setSearchRes(null); setSearchErr(null); }}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-4)', fontSize: 20, lineHeight: 1, padding: 0 }}>
                  ×
                </button>
              )}
              {searchLoading && <i className="ti ti-loader-2" style={{ ...SPIN, color: COLOR_AKTIV, flexShrink: 0 }} />}
            </div>

            {searchErr && (
              <div style={{ color: '#DC2626', fontSize: 13, padding: '8px 4px', marginTop: 8 }}>
                <i className="ti ti-alert-circle" style={{ marginRight: 6 }} />{searchErr}
              </div>
            )}

            {searchRes && !searchLoading && (
              <>
                <div style={{ fontSize: 12, color: 'var(--text-4)', margin: '8px 4px 12px' }}>
                  Hasil untuk{' '}
                  <strong style={{ color: 'var(--text-2)' }}>"{searchRes.q}"</strong>
                  {searchRes.bulan && <> · {fmtBulan(searchRes.bulan)}</>}
                  {' '}— {searchRes.aktivasi.length} aktivasi, {searchRes.registrasi.length} registrasi
                </div>

                {searchRes.aktivasi.length === 0 && searchRes.registrasi.length === 0 && (
                  <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-4)' }}>
                    <i className="ti ti-mood-empty" style={{ fontSize: 32, display: 'block', marginBottom: 10 }} />
                    Tidak ada outlet ditemukan untuk &ldquo;{searchRes.q}&rdquo;
                  </div>
                )}

                {/* ── Tabel AKTIVASI ── */}
                {searchRes.aktivasi.length > 0 && (
                  <ChartCard title={`Aktivasi — ${searchRes.aktivasi.length} outlet`}>
                    <div className="wr-table-wrap">
                      <table className="wr-table">
                        <thead>
                          <tr>
                            <th>Bulan</th><th>ID Outlet</th><th>Nama</th><th>Tipe</th>
                            <th>Upline</th><th>Kota</th><th>Provinsi</th>
                            <th>Tgl Aktif</th>
                            <th style={{ textAlign: 'right' }}>TRX</th>
                            <th style={{ textAlign: 'right' }}>Revenue</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {searchRes.aktivasi.map((r, i) => (
                            <tr key={i}>
                              <td>
                                <span className="wrd-badge" style={{ background: COLOR_AKTIV + '18', color: COLOR_AKTIV, fontWeight: 700 }}>
                                  {fmtBulan(r.bulan)}
                                </span>
                              </td>
                              <td><code style={{ fontSize: 11, color: COLOR_AKTIV, fontWeight: 700 }}>{r.id_outlet}</code></td>
                              <td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nama_pemilik || '-'}</td>
                              <td>
                                <span className="wrd-badge" style={{
                                  background: (TIPE_COLORS[r.tipe_outlet] || '#9CA3AF') + '20',
                                  color: TIPE_COLORS[r.tipe_outlet] || '#9CA3AF', fontSize: 10
                                }}>{r.tipe_outlet || '-'}</span>
                              </td>
                              <td><code style={{ fontSize: 11 }}>{r.upline || '-'}</code></td>
                              <td style={{ fontSize: 12 }}>{r.nama_kota || '-'}</td>
                              <td style={{ fontSize: 12 }}>{r.nama_propinsi || '-'}</td>
                              <td style={{ fontSize: 12 }}>{r.tanggal_aktifasi ? String(r.tanggal_aktifasi).substring(0, 10) : '-'}</td>
                              <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(r.trx)}</td>
                              <td style={{ textAlign: 'right' }}>{fmtRp(r.rev)}</td>
                              <td>
                                <span className="wrd-badge" style={{
                                  background: r.is_active ? COLOR_AKTIV + '20' : '#9CA3AF20',
                                  color: r.is_active ? COLOR_AKTIV : '#9CA3AF', fontSize: 10
                                }}>{r.is_active ? 'Aktif' : 'Tidak'}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </ChartCard>
                )}

                {/* ── Tabel REGISTRASI ── */}
                {searchRes.registrasi.length > 0 && (
                  <ChartCard title={`Registrasi — ${searchRes.registrasi.length} outlet`}>
                    <div className="wr-table-wrap">
                      <table className="wr-table">
                        <thead>
                          <tr>
                            <th>Bulan</th><th>ID Outlet</th><th>Nama</th><th>Tipe</th>
                            <th>Upline</th><th>Kota</th><th>Provinsi</th>
                            <th>Tgl Reg</th><th>Tgl Aktif</th><th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {searchRes.registrasi.map((r, i) => (
                            <tr key={i}>
                              <td>
                                <span className="wrd-badge" style={{ background: COLOR_REG + '18', color: COLOR_REG, fontWeight: 700 }}>
                                  {fmtBulan(r.bulan)}
                                </span>
                              </td>
                              <td><code style={{ fontSize: 11, color: COLOR_REG, fontWeight: 700 }}>{r.id_outlet}</code></td>
                              <td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nama_pemilik || '-'}</td>
                              <td>
                                <span className="wrd-badge" style={{
                                  background: (TIPE_COLORS[r.tipe_outlet] || '#9CA3AF') + '20',
                                  color: TIPE_COLORS[r.tipe_outlet] || '#9CA3AF', fontSize: 10
                                }}>{r.tipe_outlet || '-'}</span>
                              </td>
                              <td><code style={{ fontSize: 11 }}>{r.upline || '-'}</code></td>
                              <td style={{ fontSize: 12 }}>{r.nama_kota || '-'}</td>
                              <td style={{ fontSize: 12 }}>{r.nama_propinsi || '-'}</td>
                              <td style={{ fontSize: 12 }}>{r.tanggal_registrasi ? String(r.tanggal_registrasi).substring(0, 10) : '-'}</td>
                              <td style={{ fontSize: 12 }}>{r.tanggal_aktifasi  ? String(r.tanggal_aktifasi).substring(0, 10)  : '-'}</td>
                              <td>
                                <span className="wrd-badge" style={{
                                  background: r.tanggal_aktifasi ? COLOR_AKTIV + '20' : COLOR_KONVERSI + '20',
                                  color: r.tanggal_aktifasi ? COLOR_AKTIV : COLOR_KONVERSI, fontSize: 10
                                }}>{r.tanggal_aktifasi ? 'Sudah Aktif' : 'Belum Aktif'}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </ChartCard>
                )}
              </>
            )}

            {!searchRes && !searchLoading && !searchErr && (
              <div style={{ textAlign: 'center', padding: 56, color: 'var(--text-4)' }}>
                <i className="ti ti-search" style={{ fontSize: 38, display: 'block', marginBottom: 14, opacity: 0.35 }} />
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Cari ID Outlet</div>
                <div style={{ fontSize: 12 }}>Ketik ID outlet atau ID upline untuk mencari rekrutannya</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>Hasil mencakup data dari semua bulan yang tersedia</div>
              </div>
            )}
          </div>
        )}

      </div>
    </Layout>
  );
}
