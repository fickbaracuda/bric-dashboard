import { useState, useEffect, useCallback, useRef } from 'react';
import Layout from '../components/Layout';
import { getSpeedcashData, getSpeedcashHistory, getSpeedcashTanggalList } from '../services/api';
import Chart from 'chart.js/auto';

/* ── Format helpers ── */
function fmtRp(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}Rp ${(abs / 1_000_000).toFixed(1)}jt`;
  if (abs >= 1_000)     return `${sign}Rp ${(abs / 1_000).toFixed(1)}k`;
  return `${sign}Rp ${abs.toFixed(0)}`;
}
function fmtNum(n) { return Number(n || 0).toLocaleString('id-ID'); }
function fmtDate(d) { return d ? String(d).slice(0, 10) : '–'; }

/* ── Skeleton ── */
function SkeletonCards() {
  return (
    <div className="wr-summary-grid">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="wr-summary-card wr-skeleton" style={{ height: 82 }} />
      ))}
    </div>
  );
}

/* ── Mini bar ── */
function MiniBar({ value, max, color = '#F97316' }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 2;
  return (
    <div style={{ flex: 1, background: 'var(--border)', borderRadius: 99, height: 4 }}>
      <div style={{ width: `${pct}%`, height: 4, borderRadius: 99, background: color }} />
    </div>
  );
}

/* ── Trend Line Chart ── */
function TrendChart({ outlet1, outlet2, hist1, hist2 }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !hist1?.length || hist1.length < 2) return;
    if (chartRef.current) chartRef.current.destroy();

    const labels = hist1.map(r => String(r.tanggal).slice(5));
    const datasets = [
      {
        label: outlet1 || '–',
        data: hist1.map(r => Number(r.margin_jun) / 1_000_000),
        borderColor: '#F97316', backgroundColor: 'rgba(249,115,22,0.1)',
        tension: 0.3, fill: true, pointRadius: 3,
      },
    ];
    if (hist2?.length >= 2) {
      datasets.push({
        label: outlet2 || '–',
        data: hist2.map(r => Number(r.margin_jun) / 1_000_000),
        borderColor: '#3B82F6', backgroundColor: 'rgba(59,130,246,0.08)',
        tension: 0.3, fill: true, pointRadius: 3,
      });
    }

    chartRef.current = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 11 } } } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 } } },
          y: { ticks: { callback: v => `${v.toFixed(1)}jt`, font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.06)' } }
        }
      }
    });
    return () => { if (chartRef.current) chartRef.current.destroy(); };
  }, [hist1, hist2, outlet1, outlet2]);

  if (!hist1 || hist1.length < 2) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 180, color: 'var(--text-4)', fontSize: 13 }}>
        Data tren belum tersedia (minimal 2 hari snapshot)
      </div>
    );
  }
  return <div style={{ height: 200 }}><canvas ref={canvasRef} /></div>;
}

/* ── Bar chart modal ── */
function ModalBarChart({ data }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !data?.length || data.length < 2) return;
    if (chartRef.current) chartRef.current.destroy();

    const labels = data.map(r => String(r.tanggal).slice(5));
    const vals   = data.map(r => Number(r.margin_jun));
    const colors = vals.map((v, i) => i === 0 ? '#F97316' : v >= vals[i - 1] ? '#F97316' : '#EF4444');

    chartRef.current = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Margin Jun', data: vals, backgroundColor: colors, borderRadius: 4 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 } } },
          y: { ticks: { callback: v => fmtRp(v), font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.06)' } }
        }
      }
    });
    return () => { if (chartRef.current) chartRef.current.destroy(); };
  }, [data]);

  if (!data || data.length < 2) {
    return (
      <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-4)', fontSize: 12 }}>
        Data tren belum tersedia (minimal 2 hari snapshot)
      </div>
    );
  }
  return <div style={{ height: 160 }}><canvas ref={canvasRef} /></div>;
}

/* ── Outlet Modal ── */
function OutletModal({ row, historyData, onClose }) {
  const hist      = historyData[row.id_outlet] || [];
  const devTrx    = Number(row.dev_trx    || 0);
  const devMargin = Number(row.dev_margin || 0);

  return (
    <div className="wr-modal-overlay" onClick={onClose}>
      <div className="wr-modal" onClick={e => e.stopPropagation()}>
        <div className="wr-modal-head">
          <div>
            <span style={{ fontWeight: 700, fontSize: 15 }}>ID Outlet: {row.id_outlet}</span>
            <span style={{ marginLeft: 10, color: 'var(--text-3)', fontSize: 12 }}>
              Tgl Reg: {fmtDate(row.tgl_reg)}
            </span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-3)', lineHeight: 1 }}>✕</button>
        </div>

        {row.is_anomali && (
          <div style={{ background: '#FFFBEB', border: '1px solid #FCD34D', borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 12, color: '#92400E' }}>
            ⚠ TRX bertambah namun margin turun — perlu investigasi
          </div>
        )}
        {row.is_outlet_baru && (
          <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 12, color: '#1E40AF' }}>
            🆕 Outlet baru (registrasi &lt; 1 bulan)
          </div>
        )}

        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 14, fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-3)', fontSize: 11 }}>
              <th style={{ textAlign: 'left', padding: '6px 0' }} />
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Mei</th>
              <th style={{ textAlign: 'right', padding: '6px 0'  }}>Juni</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '7px 0', color: 'var(--text-2)' }}>TRX</td>
              <td style={{ textAlign: 'right', padding: '7px 8px' }}>{fmtNum(row.trx_mei)}</td>
              <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNum(row.trx_jun)}</td>
            </tr>
            <tr>
              <td style={{ padding: '7px 0', color: 'var(--text-2)' }}>Margin</td>
              <td style={{ textAlign: 'right', padding: '7px 8px' }}>{fmtRp(row.margin_mei)}</td>
              <td style={{ textAlign: 'right', fontWeight: 700, color: '#1D9E75' }}>{fmtRp(row.margin_jun)}</td>
            </tr>
          </tbody>
        </table>

        <div className="wr-dev-boxes">
          <div className="wr-dev-box" style={{ background: devTrx >= 0 ? '#F0FDF4' : '#FFF1F2', border: `1px solid ${devTrx >= 0 ? '#BBF7D0' : '#FECDD3'}` }}>
            <div className="wr-dev-label">DEV TRX</div>
            <div className="wr-dev-rev" style={{ color: devTrx >= 0 ? '#1D9E75' : '#EF4444' }}>
              {devTrx >= 0 ? '+' : ''}{fmtNum(devTrx)}
            </div>
          </div>
          <div className="wr-dev-box" style={{ background: devMargin >= 0 ? '#F0FDF4' : '#FFF1F2', border: `1px solid ${devMargin >= 0 ? '#BBF7D0' : '#FECDD3'}` }}>
            <div className="wr-dev-label">DEV Margin</div>
            <div className="wr-dev-rev" style={{ color: devMargin >= 0 ? '#1D9E75' : '#EF4444' }}>
              {devMargin >= 0 ? '+' : ''}{fmtRp(devMargin)}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--text-3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Tren Margin Harian
          </div>
          <ModalBarChart data={hist} />
        </div>
      </div>
    </div>
  );
}

/* ── Halaman Utama ── */
export default function WarRoomSpeedcash() {
  const [data,        setData]        = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [activeTab,   setActiveTab]   = useState('review');
  const [filter,      setFilter]      = useState('semua');
  const [sort,        setSort]        = useState('margin');
  const [tanggal,     setTanggal]     = useState('');
  const [tglList,     setTglList]     = useState([]);
  const [modalRow,    setModalRow]    = useState(null);
  const [historyData, setHistoryData] = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchHistory = useCallback(async (id_outlet) => {
    if (historyData[id_outlet]) return;
    try {
      const res = await getSpeedcashHistory(id_outlet, 30);
      setHistoryData(prev => ({ ...prev, [id_outlet]: res.rows }));
    } catch {}
  }, [historyData]);

  const fetchData = useCallback(async (f = filter, s = sort) => {
    setLoading(true);
    setError(null);
    try {
      const params = { filter: f, sort: s };
      if (tanggal) params.tanggal = tanggal;
      const [dataRes, tglRes] = await Promise.all([
        getSpeedcashData(params),
        tglList.length ? Promise.resolve({ list: tglList }) : getSpeedcashTanggalList(),
      ]);
      setData(dataRes);
      if (tglRes.list) setTglList(tglRes.list);
      // Prefetch history top 2 — TIDAK blocking loading
      const top2 = (dataRes.top_margin || []).slice(0, 2);
      top2.forEach(r => fetchHistory(r.id_outlet));
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
      setLastUpdated(new Date());
    }
  }, [tanggal, tglList]);

  useEffect(() => { fetchData(filter, sort); }, [tanggal]);

  const handleFilter = (f) => { setFilter(f); fetchData(f, sort); };
  const handleSort   = (s) => { setSort(s);   fetchData(filter, s); };

  const openModal = (row) => {
    setModalRow(row);
    fetchHistory(row.id_outlet);
  };

  /* ── Header shared ── */
  const Header = () => (
    <div className="wr-header">
      <div>
        <div className="wr-title-row">
          <span style={{ fontSize: 22, color: '#F97316' }}>⚡</span>
          <h1 className="wr-title" style={{ color: '#F97316' }}>WAR-ROOM SPEEDCASH</h1>
          <span className="war-badge-sc">LIVE</span>
        </div>
        <p className="wr-sub">
          Monitoring intensif real-time · Speedcash · Data s/d {data?.tanggal ? String(data.tanggal).slice(0, 10) : '–'}
          {lastUpdated && (
            <span style={{ marginLeft: 8, color: 'var(--text-4)' }}>
              · Terakhir dimuat {lastUpdated.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </p>
      </div>
      <div className="wr-header-right">
        <select className="wr-select" value={tanggal} onChange={e => setTanggal(e.target.value)}>
          <option value="">Terkini</option>
          {tglList.map(t => <option key={t} value={String(t)}>{String(t).slice(0, 10)}</option>)}
        </select>
        <button
          className="wr-btn-update"
          style={{ background: loading ? '#f0a070' : '#F97316' }}
          onClick={fetchData}
          disabled={loading}
        >
          {loading
            ? <><i className="ti ti-loader-2" style={{ animation: 'aic-rotate 0.8s linear infinite' }} /> Memuat...</>
            : <><i className="ti ti-refresh" /> Update Data</>
          }
        </button>
      </div>
    </div>
  );

  if (loading && !data) {
    return (
      <Layout>
        <div className="wr-page">
          <Header />
          <SkeletonCards />
        </div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <div className="wr-page">
          <Header />
          <div className="wr-error">
            ⚠ {error}
            <button className="wr-btn-retry" onClick={fetchData}>Coba Lagi</button>
          </div>
        </div>
      </Layout>
    );
  }

  const s = data?.summary || {};

  // Tabel sudah difilter + diurutkan dari server
  const displayRows = data?.tabel || [];
  const tabelTotal  = data?.tabel_total || 0;

  const top2  = (data?.top_margin || []).slice(0, 2);
  const hist1 = historyData[top2[0]?.id_outlet] || [];
  const hist2 = historyData[top2[1]?.id_outlet] || [];

  const devMarginTotal = Number(s.dev_margin     || 0);
  const devTrxTotal    = Number(s.total_trx_jun  || 0) - Number(s.total_trx_mei || 0);

  return (
    <Layout>
      <div className="wr-page">
        <Header />

        {/* Tabs */}
        <div className="war-tabs-sc">
          <button
            className={`war-tab-sc${activeTab === 'review' ? ' active' : ''}`}
            onClick={() => setActiveTab('review')}
          >
            Review Speedcash
          </button>
          <button className="war-tab-sc disabled" disabled>
            + Tambah Sub-menu
          </button>
        </div>

        {/* Summary Cards */}
        <div className="wr-summary-grid">
          <div className="wr-summary-card" style={{ borderTop: '3px solid #F97316' }}>
            <div className="wr-card-label">Total Outlet Aktif</div>
            <div className="wr-card-val" style={{ color: '#F97316' }}>{fmtNum(s.total_outlet)}</div>
          </div>
          <div className="wr-summary-card" style={{ borderTop: '3px solid #F97316' }}>
            <div className="wr-card-label">Total TRX Juni</div>
            <div className="wr-card-val" style={{ color: '#F97316' }}>{fmtNum(s.total_trx_jun)}</div>
            <div className="wr-card-sub" style={{ fontSize: 12, marginTop: 4, color: devTrxTotal >= 0 ? '#1D9E75' : '#EF4444' }}>
              {devTrxTotal >= 0 ? '+' : ''}{fmtNum(devTrxTotal)} vs Mei
            </div>
          </div>
          <div className="wr-summary-card" style={{ borderTop: '3px solid #1D9E75' }}>
            <div className="wr-card-label">Total Margin Juni</div>
            <div className="wr-card-val" style={{ color: '#1D9E75' }}>{fmtRp(s.total_margin_jun)}</div>
            <div className="wr-card-sub" style={{ fontSize: 12, marginTop: 4, color: devMarginTotal >= 0 ? '#1D9E75' : '#EF4444' }}>
              DEV {devMarginTotal >= 0 ? '+' : ''}{fmtRp(devMarginTotal)} vs Mei
            </div>
          </div>
          <div className="wr-summary-card" style={{ borderTop: '3px solid #1D9E75' }}>
            <div className="wr-card-label">Outlet Tumbuh</div>
            <div className="wr-card-val" style={{ color: '#1D9E75' }}>{fmtNum(s.outlet_tumbuh)}</div>
          </div>
          <div className="wr-summary-card" style={{ borderTop: '3px solid #EF4444' }}>
            <div className="wr-card-label">Outlet Turun</div>
            <div className="wr-card-val" style={{ color: '#EF4444' }}>{fmtNum(s.outlet_turun)}</div>
          </div>
          <div className="wr-summary-card" style={{ borderTop: '3px solid #3B82F6' }}>
            <div className="wr-card-label">Outlet Baru</div>
            <div className="wr-card-val" style={{ color: '#3B82F6' }}>{fmtNum(s.outlet_baru)}</div>
            <div className="wr-card-sub" style={{ fontSize: 12, marginTop: 4, color: 'var(--text-4)' }}>&lt; 1 bulan</div>
          </div>
        </div>

        {/* 3 Panel Ranking */}
        <div className="wr-panels">
          {/* Top Margin */}
          <div className="wr-panel">
            <div className="wr-panel-title">Top Margin Juni</div>
            {(data?.top_margin || []).map((r, i) => {
              const maxVal = Number(data.top_margin[0]?.margin_jun || 1);
              return (
                <div key={r.id_outlet} className="rank-row-sc">
                  <span className="rnum">{i + 1}</span>
                  <span className="rname" style={{ flex: 1, minWidth: 0, fontSize: 12 }}>{r.id_outlet}</span>
                  <MiniBar value={Number(r.margin_jun)} max={maxVal} color="#F97316" />
                  <span className="rval" style={{ color: '#F97316', fontSize: 12 }}>{fmtRp(r.margin_jun)}</span>
                </div>
              );
            })}
          </div>

          {/* Pertumbuhan Tercepat */}
          <div className="wr-panel">
            <div className="wr-panel-title">Pertumbuhan Tercepat</div>
            {(data?.top_growth || []).map((r, i) => (
              <div key={r.id_outlet} className="rank-row-sc">
                <span className="rnum">{i + 1}</span>
                <span className="rname" style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
                  {r.id_outlet}
                  {r.is_outlet_baru && <span className="pill-baru" style={{ marginLeft: 4 }}>BARU</span>}
                </span>
                <span className="rval" style={{ color: '#1D9E75', fontSize: 12 }}>+{fmtRp(r.dev_margin)}</span>
              </div>
            ))}
            {!(data?.top_growth?.length) && (
              <div style={{ fontSize: 12, color: 'var(--text-4)', padding: '8px 0' }}>Belum ada data</div>
            )}
          </div>

          {/* Outlet Bermasalah */}
          <div className="wr-panel">
            <div className="wr-panel-title">Outlet Bermasalah</div>
            {(data?.outlet_masalah || []).slice(0, 10).map((r, i) => (
              <div key={r.id_outlet} className="rank-row-sc">
                <span className="rnum">{i + 1}</span>
                <span className="rname" style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
                  {r.id_outlet}
                  {r.is_anomali && <span className="pill-anomali" style={{ marginLeft: 4, fontSize: 10 }}>⚠</span>}
                </span>
                <span className="rval" style={{ color: '#EF4444', fontSize: 12 }}>{fmtRp(r.dev_margin)}</span>
              </div>
            ))}
            {!(data?.outlet_masalah?.length) && (
              <div style={{ fontSize: 12, color: 'var(--text-4)', padding: '8px 0' }}>Tidak ada outlet bermasalah</div>
            )}
          </div>
        </div>

        {/* Tabel Detail */}
        <div className="wr-table-section">
          <div className="wr-table-controls">
            <select className="wr-select" value={sort} onChange={e => handleSort(e.target.value)} disabled={loading}>
              <option value="margin">Margin ↓</option>
              <option value="dev_margin">DEV Margin ↓</option>
              <option value="trx">TRX Jun ↓</option>
              <option value="dev_trx">DEV TRX ↓</option>
            </select>
            <div className="war-tabs" style={{ border: 'none', marginBottom: 0 }}>
              {['semua','tumbuh','turun','top10','baru','anomali'].map(f => (
                <button
                  key={f}
                  className={`war-tab${filter === f ? ' war-tab--active' : ''}`}
                  onClick={() => handleFilter(f)}
                  disabled={loading}
                >
                  {{ semua:'Semua', tumbuh:'Tumbuh', turun:'Turun', top10:'Top 10', baru:'Baru', anomali:'Anomali' }[f]}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-3)', marginLeft: 'auto' }}>
              {loading ? '...' : `${displayRows.length} dari ${fmtNum(tabelTotal)} outlet`}
            </span>
          </div>

          <div className="wr-table-wrap">
            <table className="wr-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>ID Outlet</th>
                  <th>Tgl Reg</th>
                  <th style={{ textAlign: 'right' }}>TRX Mei</th>
                  <th style={{ textAlign: 'right' }}>TRX Jun</th>
                  <th style={{ textAlign: 'right' }}>Margin Mei</th>
                  <th style={{ textAlign: 'right' }}>Margin Jun</th>
                  <th style={{ textAlign: 'right' }}>DEV TRX</th>
                  <th style={{ textAlign: 'right' }}>DEV Margin</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r, i) => {
                  const devT = Number(r.dev_trx    || 0);
                  const devM = Number(r.dev_margin || 0);
                  return (
                    <tr key={r.id_outlet + i} onClick={() => openModal(r)} style={{ cursor: 'pointer' }}>
                      <td style={{ color: 'var(--text-4)' }}>{i + 1}</td>
                      <td>
                        <span style={{ fontWeight: 600 }}>{r.id_outlet}</span>
                        {r.is_outlet_baru && <span className="pill-baru" style={{ marginLeft: 4 }}>BARU</span>}
                        {r.is_anomali     && <span className="pill-anomali" style={{ marginLeft: 4, fontSize: 10 }}>⚠</span>}
                      </td>
                      <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{fmtDate(r.tgl_reg)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(r.trx_mei)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNum(r.trx_jun)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtRp(r.margin_mei)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: '#1D9E75' }}>{fmtRp(r.margin_jun)}</td>
                      <td style={{ textAlign: 'right', color: devT >= 0 ? '#1D9E75' : '#EF4444' }}>
                        {devT >= 0 ? '+' : ''}{fmtNum(devT)}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: devM >= 0 ? '#1D9E75' : '#EF4444' }}>
                        {devM >= 0 ? '+' : ''}{fmtRp(devM)}
                      </td>
                      <td>
                        {devM > 0
                          ? <span className="pill-naik">Naik</span>
                          : devM < 0
                            ? <span className="pill-turun">Turun</span>
                            : <span className="pill-stabil">Stabil</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Analisis Bawah */}
        <div className="wr-analysis-grid">
          {/* Tren */}
          <div className="wr-reco-card" style={{ padding: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>
              Tren Margin — {top2[0]?.id_outlet || '–'}{top2[1] ? ` vs ${top2[1].id_outlet}` : ''}
            </div>
            <TrendChart
              outlet1={top2[0]?.id_outlet}
              outlet2={top2[1]?.id_outlet}
              hist1={hist1}
              hist2={hist2}
            />
          </div>

          {/* Rekomendasi */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {top2.length > 0 && (() => {
              const totalMJ = Number(s.total_margin_jun || 1);
              const dom = ((Number(top2[0]?.margin_jun || 0) + Number(top2[1]?.margin_jun || 0)) / totalMJ * 100).toFixed(0);
              return (
                <div className="wr-reco-card" style={{ background: '#FFF7ED', borderColor: '#FED7AA' }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: '#9A3412', marginBottom: 4 }}>
                    Perkuat — {top2[0]?.id_outlet}
                  </div>
                  <div style={{ fontSize: 12, color: '#7C2D12' }}>
                    {top2[0]?.id_outlet}{top2[1] ? ` dan ${top2[1].id_outlet}` : ''} mendominasi {dom}% total margin. Pertahankan aktivitas dan prioritaskan retention.
                  </div>
                </div>
              );
            })()}

            {(data?.outlet_masalah || []).length > 0 && (() => {
              const prob = data.outlet_masalah[0];
              return (
                <div className="wr-reco-card" style={{ background: '#FFF1F2', borderColor: '#FECDD3' }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: '#9F1239', marginBottom: 4 }}>
                    Investigasi — {prob.id_outlet}
                  </div>
                  <div style={{ fontSize: 12, color: '#881337' }}>
                    {prob.is_anomali
                      ? 'TRX bertambah namun margin menurun — indikasi potensi penurunan nilai per transaksi atau pergeseran produk.'
                      : 'Penurunan TRX dan margin — risiko outlet tidak aktif.'}
                  </div>
                </div>
              );
            })()}

            {(data?.anomali || []).length > 0 && (
              <div className="wr-reco-card" style={{ background: '#FFFBEB', borderColor: '#FDE68A' }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: '#92400E', marginBottom: 4 }}>
                  Anomali — {data.anomali.length} outlet perlu investigasi
                </div>
                <div style={{ fontSize: 12, color: '#78350F' }}>
                  {data.anomali.map(a => a.id_outlet).join(', ')}
                </div>
              </div>
            )}

            {Number(s.outlet_baru) > 0 && (
              <div className="wr-reco-card" style={{ background: '#EFF6FF', borderColor: '#BFDBFE' }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: '#1E3A8A', marginBottom: 4 }}>
                  Outlet Baru — {s.outlet_baru} outlet
                </div>
                <div style={{ fontSize: 12, color: '#1E40AF' }}>
                  Terdapat {s.outlet_baru} outlet baru (registrasi &lt; 1 bulan). Pastikan onboarding berjalan optimal.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Modal */}
        {modalRow && (
          <OutletModal
            row={modalRow}
            historyData={historyData}
            onClose={() => setModalRow(null)}
          />
        )}
      </div>
    </Layout>
  );
}
