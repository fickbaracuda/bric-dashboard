import { useState, useEffect, useRef, useCallback } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getSegmenData, getSegmenHistory, getSegmenTanggalList } from '../services/api';

/* ─ Helpers ─ */
const n = (v) => Number(v) || 0;

function fmtRp(v) {
  const num = n(v), abs = Math.abs(num), sign = num < 0 ? '-' : '';
  if (abs >= 1e9) return sign + 'Rp ' + (abs / 1e9).toFixed(2) + 'M';
  if (abs >= 1e6) return sign + 'Rp ' + (abs / 1e6).toFixed(1) + 'jt';
  if (abs >= 1e3) return sign + 'Rp ' + (abs / 1e3).toFixed(0) + 'k';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}

function fmtDev(v) {
  const num = n(v), abs = Math.abs(num), sign = num >= 0 ? '+' : '-';
  if (abs >= 1e6) return sign + 'Rp ' + (abs / 1e6).toFixed(1) + 'jt';
  if (abs >= 1e3) return sign + 'Rp ' + (abs / 1e3).toFixed(0) + 'k';
  return (num >= 0 ? '+' : '') + 'Rp ' + Math.round(num).toLocaleString('id-ID');
}

const fmtNum = (v) => n(v).toLocaleString('id-ID');

/* ─ Status pill ─ */
function StatusPill({ row }) {
  const dev = n(row.dev_mei_jun_rev);
  if (dev > 0) return <span className="pill-naik">Naik</span>;
  if (dev < 0) return <span className="pill-turun">Turun</span>;
  return <span className="pill-stabil">Stabil</span>;
}

/* ─ Skeleton ─ */
function SkeletonCards() {
  return (
    <div className="wr-summary-grid">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="wr-summary-card wr-skeleton">
          <div className="wr-sk-line wr-sk-short" />
          <div className="wr-sk-line wr-sk-long" />
        </div>
      ))}
    </div>
  );
}

/* ─ Summary cards ─ */
function SummaryCards({ s }) {
  if (!s) return <SkeletonCards />;
  const devRev = n(s.dev_rev_mei_jun);
  const cards = [
    { label: 'Total Merchant Juni', value: fmtNum(s.total_merchant), color: '#E24B4A' },
    { label: 'Total Transaksi', value: fmtNum(s.total_trx), color: '#E24B4A' },
    {
      label: 'Total Revenue', value: fmtRp(s.total_rev), color: '#1D9E75',
      sub: <span style={{ color: devRev >= 0 ? '#1D9E75' : '#E24B4A', fontSize: 11 }}>{fmtDev(devRev)} vs Mei</span>,
    },
    { label: 'Segmen Aktif', value: fmtNum(s.segmen_aktif), color: '#378ADD' },
    {
      label: 'Segmen Tumbuh', value: fmtNum(s.segmen_tumbuh), color: '#1D9E75',
      sub: <span style={{ color: '#1D9E75', fontSize: 11 }}>↑ segmen positif</span>,
    },
    {
      label: 'Segmen Turun', value: fmtNum(s.segmen_turun), color: '#E24B4A',
      sub: <span style={{ color: '#E24B4A', fontSize: 11 }}>↓ butuh perhatian</span>,
    },
  ];
  return (
    <div className="wr-summary-grid">
      {cards.map((c, i) => (
        <div key={i} className="wr-summary-card" style={{ borderTop: `3px solid ${c.color}` }}>
          <div className="wr-card-label">{c.label}</div>
          <div className="wr-card-value" style={{ color: c.color }}>{c.value}</div>
          {c.sub && <div className="wr-card-sub">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/* ─ Rank row ─ */
function RankRow({ item, idx, maxVal, color, showDev }) {
  const val    = n(item.jun_rev);
  const dev    = n(item.dev_mei_jun_rev);
  const barPct = maxVal > 0 ? (Math.abs(showDev ? dev : val) / maxVal) * 100 : 0;
  return (
    <div className="rank-row">
      <span className="rnum">{idx + 1}</span>
      <span className="rname" title={item.kategori}>
        {item.kategori}
        {item.is_anomali && <span className="pill-anomali" style={{ marginLeft: 4, fontSize: 9 }}>⚠</span>}
      </span>
      <div className="rbar-w"><div className="rbar" style={{ width: barPct + '%', background: color }} /></div>
      <span className="rval" style={{ color }}>{showDev ? fmtDev(dev) : fmtRp(val)}</span>
    </div>
  );
}

/* ─ Trend chart (line) ─ */
function TrendChart({ mcc1, mcc2, historyData, topRev }) {
  const ref      = useRef(null);
  const chartRef = useRef(null);
  const rows1    = historyData[mcc1] || [];
  const rows2    = mcc2 ? (historyData[mcc2] || []) : [];
  const hasData  = rows1.length >= 2 || rows2.length >= 2;

  useEffect(() => {
    if (!ref.current || !hasData) return;
    chartRef.current?.destroy();
    const allDates = [...new Set([...rows1, ...rows2].map(r => String(r.tanggal).slice(0, 10)))].sort();
    const getVal   = (rows, d) => { const r = rows.find(x => String(x.tanggal).startsWith(d)); return r ? n(r.jun_rev) / 1e6 : null; };

    chartRef.current = new Chart(ref.current, {
      type: 'line',
      data: {
        labels: allDates,
        datasets: [
          { label: topRev?.[0]?.kategori || mcc1, data: allDates.map(d => getVal(rows1, d)), borderColor: '#10B981', backgroundColor: '#10B98118', fill: true, tension: 0.3, pointRadius: 3 },
          ...(rows2.length >= 2 ? [{ label: topRev?.[1]?.kategori || mcc2, data: allDates.map(d => getVal(rows2, d)), borderColor: '#3B82F6', backgroundColor: '#3B82F618', fill: true, tension: 0.3, pointRadius: 3 }] : []),
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } },
        scales: {
          y: { ticks: { callback: v => 'Rp ' + v + 'jt', font: { size: 10 } } },
          x: { ticks: { font: { size: 10 }, maxRotation: 45 } },
        },
      },
    });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [rows1, rows2, hasData, mcc1, mcc2]);

  if (!hasData) return (
    <div className="wr-no-data">
      <i className="ti ti-chart-line" style={{ fontSize: 28, opacity: 0.3 }} />
      <p>Data tren belum tersedia (minimal 2 hari snapshot)</p>
    </div>
  );
  return <div style={{ position: 'relative', height: 200 }}><canvas ref={ref} /></div>;
}

/* ─ Recommendations ─ */
function Recommendations({ data }) {
  if (!data) return null;
  const { top_rev = [], segmen_masalah = [], anomali = [], summary } = data;
  const totalRev = n(summary?.total_rev);
  const top2Rev  = n(top_rev[0]?.jun_rev) + n(top_rev[1]?.jun_rev);
  const pct2     = totalRev > 0 ? ((top2Rev / totalRev) * 100).toFixed(1) : '—';

  return (
    <div className="wr-reco-list">
      {top_rev[0] && (
        <div className="wr-reco-card wr-reco-hijau">
          <div className="wr-reco-title">💡 Perkuat — {top_rev[0].kategori}</div>
          <div className="wr-reco-body">
            <strong>{top_rev[0]?.kategori}</strong>{top_rev[1] ? <> dan <strong>{top_rev[1]?.kategori}</strong></> : ''}{' '}
            mendominasi <strong>{pct2}%</strong> total revenue. Akselerasi akuisisi merchant baru di segmen ini.
          </div>
        </div>
      )}
      {segmen_masalah[0] && (
        <div className="wr-reco-card wr-reco-merah">
          <div className="wr-reco-title">🚨 Investigasi — {segmen_masalah[0].kategori}</div>
          <div className="wr-reco-body">
            {segmen_masalah[0].is_anomali
              ? 'Merchant bertambah namun revenue menurun — indikasi potensi churn atau penurunan nilai transaksi per merchant.'
              : `Penurunan merchant aktif terdeteksi — risiko kehilangan basis pengguna. Gap MEI→JUN: ${fmtDev(segmen_masalah[0].dev_mei_jun_rev)}.`
            }
          </div>
        </div>
      )}
      {anomali.length > 0 && (
        <div className="wr-reco-card wr-reco-kuning">
          <div className="wr-reco-title">⚠ Anomali — {anomali.length} segmen perlu investigasi</div>
          <div className="wr-reco-body">{anomali.map(a => a.kategori).join(', ')}</div>
        </div>
      )}
    </div>
  );
}

/* ─ Modal detail ─ */
function SegmenModal({ row, onClose, historyData, onFetchHistory }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);

  useEffect(() => {
    if (row?.mcc && !historyData[row.mcc]) onFetchHistory(row.mcc);
  }, [row?.mcc]);

  useEffect(() => {
    if (!canvasRef.current || !row) { chartRef.current?.destroy(); chartRef.current = null; return; }
    const rows = historyData[row.mcc] || [];
    if (rows.length < 2) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels: rows.map(r => String(r.tanggal).slice(5)),
        datasets: [{
          label: 'Rev (jt)',
          data: rows.map(r => n(r.jun_rev) / 1e6),
          backgroundColor: rows.map((r, i) =>
            i === 0 || n(r.jun_rev) >= n(rows[i - 1]?.jun_rev) ? '#10B981' : '#EF4444'
          ),
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { ticks: { callback: v => v + 'jt', font: { size: 10 } } }, x: { ticks: { font: { size: 10 } } } },
      },
    });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [row?.mcc, historyData]);

  if (!row) return null;
  const histRows = historyData[row.mcc] || [];

  return (
    <div className="wr-modal-overlay" onClick={onClose}>
      <div className="wr-modal" onClick={e => e.stopPropagation()}>
        <div className="wr-modal-header">
          <div>
            <div className="wr-modal-title">{row.kategori}</div>
            <div className="wr-modal-sub">MCC: {row.mcc}</div>
          </div>
          <button className="wr-modal-close" onClick={onClose}>✕</button>
        </div>

        {row.is_anomali && (
          <div className="wr-anomali-banner">
            ⚠ Merchant bertambah namun revenue turun — perlu investigasi
          </div>
        )}

        <table className="wr-modal-table">
          <thead><tr><th></th><th>April</th><th>Mei</th><th>Juni</th></tr></thead>
          <tbody>
            <tr><td>Merchant</td><td>{fmtNum(row.apr_merchant)}</td><td>{fmtNum(row.mei_merchant)}</td><td><strong>{fmtNum(row.jun_merchant)}</strong></td></tr>
            <tr><td>TRX</td><td>{fmtNum(row.apr_trx)}</td><td>{fmtNum(row.mei_trx)}</td><td><strong>{fmtNum(row.jun_trx)}</strong></td></tr>
            <tr><td>Revenue</td><td>{fmtRp(row.apr_rev)}</td><td>{fmtRp(row.mei_rev)}</td><td><strong style={{ color: '#1D9E75' }}>{fmtRp(row.jun_rev)}</strong></td></tr>
          </tbody>
        </table>

        <div className="wr-dev-boxes">
          {[
            { label: 'DEV Apr→Jun', rev: row.dev_apr_jun_rev, m: row.dev_apr_jun_merchant, t: row.dev_apr_jun_trx },
            { label: 'DEV Mei→Jun', rev: row.dev_mei_jun_rev, m: row.dev_mei_jun_merchant, t: row.dev_mei_jun_trx },
          ].map(d => (
            <div key={d.label} className={`wr-dev-box ${n(d.rev) >= 0 ? 'wr-dev-pos' : 'wr-dev-neg'}`}>
              <div className="wr-dev-label">{d.label}</div>
              <div className="wr-dev-rev">{fmtDev(d.rev)}</div>
              <div className="wr-dev-detail">{fmtDev(d.m)} merchant · {fmtDev(d.t)} TRX</div>
            </div>
          ))}
        </div>

        <div className="wr-modal-chart">
          {histRows.length >= 2
            ? <div style={{ position: 'relative', height: 160 }}><canvas ref={canvasRef} /></div>
            : <div className="wr-no-data-sm">Data tren belum tersedia (minimal 2 hari snapshot)</div>
          }
        </div>
      </div>
    </div>
  );
}

/* ─ Main page ─ */
export default function WarRoom() {
  const [data,        setData]        = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [filter,      setFilter]      = useState('semua');
  const [sort,        setSort]        = useState('rev');
  const [tanggal,     setTanggal]     = useState('');
  const [tglList,     setTglList]     = useState([]);
  const [modalRow,    setModalRow]    = useState(null);
  const [historyData, setHistoryData] = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchHistory = useCallback(async (mcc) => {
    if (!mcc || historyData[mcc]) return;
    try {
      const res = await getSegmenHistory(mcc);
      setHistoryData(h => ({ ...h, [mcc]: res.rows || [] }));
    } catch { /* silent */ }
  }, [historyData]);

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await getSegmenData({ tanggal: tanggal || undefined });
      setData(res);
      if (res.top_rev?.[0]?.mcc) fetchHistory(res.top_rev[0].mcc);
      if (res.top_rev?.[1]?.mcc) fetchHistory(res.top_rev[1].mcc);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Gagal memuat data');
    } finally { setLoading(false); setLastUpdated(new Date()); }
  }, [tanggal]);

  useEffect(() => {
    getSegmenTanggalList().then(r => setTglList(r.list || [])).catch(() => {});
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  /* Client-side filter + sort */
  const displayRows = (() => {
    if (!data?.tabel) return [];
    let rows = [...data.tabel];
    if (filter === 'tumbuh') rows = rows.filter(r => n(r.dev_mei_jun_rev) > 0);
    if (filter === 'turun')  rows = rows.filter(r => n(r.dev_mei_jun_rev) < 0);
    if (filter === 'top10')  rows = rows.slice(0, 10);
    const sk = { rev: 'jun_rev', dev_mei: 'dev_mei_jun_rev', merchant: 'jun_merchant', dev_apr: 'dev_apr_jun_rev' }[sort] || 'jun_rev';
    return rows.sort((a, b) => n(b[sk]) - n(a[sk]));
  })();

  const mcc1       = data?.top_rev?.[0]?.mcc;
  const mcc2       = data?.top_rev?.[1]?.mcc;
  const maxTopRev  = n(data?.top_rev?.[0]?.jun_rev);
  const maxGrowth  = n(data?.top_growth?.[0]?.dev_mei_jun_rev);
  const maxMasalah = Math.abs(n(data?.segmen_masalah?.[0]?.dev_mei_jun_rev));

  return (
    <Layout>
      <div className="wr-page">

        {/* Header */}
        <div className="wr-header">
          <div>
            <div className="wr-title-row">
              <span className="wr-icon">⚔</span>
              <h1 className="wr-title">WAR-ROOM</h1>
              <span className="war-badge">LIVE</span>
            </div>
            <p className="wr-sub">
              Monitoring intensif real-time · InstaQris · Snapshot data: {data?.tanggal ? String(data.tanggal).slice(0, 10) : '–'}
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
            <button className="wr-btn-update" onClick={fetchData} disabled={loading}>
              {loading
                ? <><i className="ti ti-loader-2" style={{ animation: 'aic-rotate 0.8s linear infinite' }} /> Memuat...</>
                : <><i className="ti ti-refresh" /> Update Data</>
              }
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="war-tabs">
          <button className="war-tab active">Segmen InstaQris</button>
          <button className="war-tab" disabled style={{ opacity: 0.4, cursor: 'not-allowed' }}>+ Tambah Sub-menu</button>
        </div>

        {/* Error */}
        {error && !loading && (
          <div className="wr-error">
            <i className="ti ti-alert-circle" /> {error}
            <button className="wr-btn-retry" onClick={fetchData}>Coba Lagi</button>
          </div>
        )}

        {/* Summary */}
        {loading ? <SkeletonCards /> : <SummaryCards s={data?.summary} />}

        {/* 3-col panels */}
        {!loading && data && (
          <div className="wr-panels">
            <div className="wr-panel">
              <div className="wr-panel-title" style={{ color: '#1D9E75' }}>Top Revenue Juni</div>
              {(data.top_rev || []).map((row, i) => (
                <RankRow key={row.mcc} item={row} idx={i} maxVal={maxTopRev} color="#1D9E75" />
              ))}
            </div>
            <div className="wr-panel">
              <div className="wr-panel-title" style={{ color: '#378ADD' }}>Pertumbuhan Tercepat</div>
              {(data.top_growth || []).map((row, i) => (
                <RankRow key={row.mcc} item={row} idx={i} maxVal={maxGrowth} color="#378ADD" showDev />
              ))}
              {!data.top_growth?.length && <div className="wr-empty-panel">Belum ada segmen tumbuh</div>}
            </div>
            <div className="wr-panel">
              <div className="wr-panel-title" style={{ color: '#E24B4A' }}>Segmen Bermasalah</div>
              {(data.segmen_masalah || []).slice(0, 10).map((row, i) => (
                <RankRow key={row.mcc} item={row} idx={i} maxVal={maxMasalah} color="#E24B4A" showDev />
              ))}
              {!data.segmen_masalah?.length && <div className="wr-empty-panel">Semua segmen positif ✓</div>}
            </div>
          </div>
        )}

        {/* Table */}
        {!loading && data && (
          <div className="wr-table-section">
            <div className="wr-table-controls">
              <div className="wr-table-left">
                <select className="wr-select" value={sort} onChange={e => setSort(e.target.value)}>
                  <option value="rev">Revenue ↓</option>
                  <option value="dev_mei">DEV Mei→Jun ↓</option>
                  <option value="merchant">Merchant ↓</option>
                  <option value="dev_apr">DEV Apr→Jun ↓</option>
                </select>
                <span className="wr-count">{displayRows.length} segmen</span>
              </div>
              <div className="wr-filter-tabs">
                {[['semua','Semua'],['tumbuh','Tumbuh'],['turun','Turun'],['top10','Top 10']].map(([k, l]) => (
                  <button key={k} className={`wr-filter-tab${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>{l}</button>
                ))}
              </div>
            </div>
            <div className="wr-table-wrap">
              <table className="wr-table">
                <thead>
                  <tr>
                    <th>#</th><th>Segmen</th>
                    <th>Merchant Jun</th><th>TRX Jun</th>
                    <th>Rev Juni</th><th>Rev Mei</th>
                    <th>DEV Mei→Jun</th><th>DEV Apr→Jun</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row, i) => {
                    const devMei = n(row.dev_mei_jun_rev);
                    const devApr = n(row.dev_apr_jun_rev);
                    return (
                      <tr key={row.mcc} className="wr-tr-clickable" onClick={() => setModalRow(row)}>
                        <td>{i + 1}</td>
                        <td>
                          <span className="wr-segmen-name">{row.kategori}</span>
                          {row.is_anomali && <span className="pill-anomali" style={{ marginLeft: 6, fontSize: 10 }}>⚠ Anomali</span>}
                        </td>
                        <td>{fmtNum(row.jun_merchant)}</td>
                        <td>{fmtNum(row.jun_trx)}</td>
                        <td style={{ fontWeight: 600, color: '#1D9E75' }}>{fmtRp(row.jun_rev)}</td>
                        <td>{fmtRp(row.mei_rev)}</td>
                        <td style={{ fontWeight: 600, color: devMei >= 0 ? '#1D9E75' : '#E24B4A' }}>{fmtDev(devMei)}</td>
                        <td style={{ color: devApr >= 0 ? '#1D9E75' : '#E24B4A' }}>{fmtDev(devApr)}</td>
                        <td><StatusPill row={row} /></td>
                      </tr>
                    );
                  })}
                  {!displayRows.length && (
                    <tr><td colSpan={9} style={{ textAlign: 'center', padding: 24, color: 'var(--text-4)' }}>
                      {data?.tabel?.length ? 'Tidak ada data untuk filter ini' : 'Belum ada data — jalankan sync dari Apps Script'}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Analysis grid */}
        {!loading && data && (
          <div className="wr-analysis-grid">
            <div className="wr-analysis-panel">
              <div className="wr-panel-title">Tren Revenue Segmen Teratas</div>
              <TrendChart mcc1={mcc1} mcc2={mcc2} historyData={historyData} topRev={data.top_rev} />
            </div>
            <div className="wr-analysis-panel">
              <div className="wr-panel-title">Rekomendasi Strategis</div>
              <Recommendations data={data} />
            </div>
          </div>
        )}

      </div>

      <SegmenModal row={modalRow} onClose={() => setModalRow(null)} historyData={historyData} onFetchHistory={fetchHistory} />
    </Layout>
  );
}
