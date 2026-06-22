import { useState, useEffect, useRef, useCallback } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getToken } from '../utils/auth';

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const API = '/api/instaqris-insight';
const COLOR_IQI = '#7F77DD';

/* ── Formatting helpers ── */
const fmt  = n => Number(n || 0).toLocaleString('id-ID');
const fmtR = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const fmtC = n => {
  const v = Number(n || 0);
  if (v >= 1_000_000_000) return 'Rp ' + (v / 1_000_000_000).toFixed(1) + 'M';
  if (v >= 1_000_000)     return 'Rp ' + (v / 1_000_000).toFixed(1) + 'jt';
  if (v >= 1_000)         return 'Rp ' + (v / 1_000).toFixed(0) + 'rb';
  return fmtR(v);
};
const fmtPct = n => (n !== null && n !== undefined ? `${Number(n).toFixed(1)}%` : '–');
const pctColor = v => {
  const n = parseFloat(v);
  if (isNaN(n)) return 'var(--text-3)';
  return n >= 0 ? '#10B981' : '#EF4444';
};

async function apiFetch(path) {
  const r = await fetch(`${API}${path}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ── KPI Card ── */
function KPICard({ label, value, prev, pct, sub, icon, color = COLOR_IQI, format = 'number' }) {
  const display = format === 'currency' ? fmtC(value)
                : format === 'pct'     ? fmtPct(value)
                : fmt(value);
  const arrow = pct > 0 ? '↑' : pct < 0 ? '↓' : '';
  return (
    <div className="iqi-kpi-card">
      <div className="iqi-kpi-icon" style={{ background: color + '1A', color }}>
        <i className={`ti ti-${icon}`} />
      </div>
      <div className="iqi-kpi-body">
        <div className="iqi-kpi-label">{label}</div>
        <div className="iqi-kpi-value">{display}</div>
        {pct !== null && pct !== undefined && (
          <div className="iqi-kpi-mom" style={{ color: pctColor(pct) }}>
            {arrow} {Math.abs(pct)}% MoM
          </div>
        )}
        {sub && <div className="iqi-kpi-sub">{sub}</div>}
      </div>
    </div>
  );
}

/* ── Section Header ── */
function SectionHeader({ title, sub }) {
  return (
    <div className="iqi-section-header">
      <div className="iqi-section-title">{title}</div>
      {sub && <div className="iqi-section-sub">{sub}</div>}
    </div>
  );
}

/* ── Simple table ── */
function DataTable({ cols, rows, emptyMsg = 'Tidak ada data' }) {
  if (!rows?.length) return <div className="iqi-empty">{emptyMsg}</div>;
  return (
    <div className="iqi-table-wrap">
      <table className="iqi-table">
        <thead>
          <tr>{cols.map(c => <th key={c.key} style={c.style}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {cols.map(c => (
                <td key={c.key} style={c.style}>
                  {c.render ? c.render(row[c.key], row, i) : (row[c.key] ?? '–')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Bar (simple horizontal) ── */
function MiniBar({ value, max, color = COLOR_IQI }) {
  const w = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="iqi-mini-bar-bg">
      <div className="iqi-mini-bar-fill" style={{ width: `${w}%`, background: color }} />
    </div>
  );
}

/* ── Funnel visualization ── */
function FunnelChart({ data }) {
  if (!data) return null;
  const stages = [
    { label: 'Registrasi',    value: data.registrasi, color: '#7F77DD', icon: 'user-plus' },
    { label: 'QRIS Terbit',   value: data.terbit,     color: '#1D9E75', icon: 'qrcode' },
    { label: 'MAT (All-time)',value: data.mat,         color: '#3B82F6', icon: 'chart-bar' },
  ];
  const maxVal = Math.max(...stages.map(s => s.value || 0), 1);
  return (
    <div className="iqi-funnel">
      {stages.map((s, i) => {
        const w = 100 - i * 15;
        const rate = i > 0 ? stages[i].value / (stages[i-1].value || 1) * 100 : 100;
        return (
          <div key={s.label} className="iqi-funnel-row">
            {i > 0 && (
              <div className="iqi-funnel-rate">
                <i className="ti ti-arrow-down" /> {rate.toFixed(1)}% dari stage sebelumnya
              </div>
            )}
            <div className="iqi-funnel-bar-wrap" style={{ width: `${w}%` }}>
              <div className="iqi-funnel-bar" style={{ background: s.color }}>
                <i className={`ti ti-${s.icon}`} />
                <span className="iqi-funnel-bar-label">{s.label}</span>
                <span className="iqi-funnel-bar-val">{fmt(s.value)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Trend Chart component ── */
function TrendChart({ data, metric, label, color = COLOR_IQI }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!ref.current || !data?.length) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(ref.current, {
      type: 'bar',
      data: {
        labels: data.map(d => d.bulan),
        datasets: [{
          label,
          data: data.map(d => d[metric]),
          backgroundColor: color + 'BB',
          borderColor: color,
          borderWidth: 1,
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: '#F3F4F6' } }
        }
      }
    });
    return () => { if (chartRef.current) chartRef.current.destroy(); };
  }, [data, metric]);

  return <canvas ref={ref} style={{ height: 200, width: '100%' }} />;
}

/* ── Cohort heatmap ── */
function CohortTable({ data }) {
  if (!data?.length) return <div className="iqi-empty">Data cohort belum tersedia</div>;
  const maxMonths = 6;
  const cellColor = (val, size) => {
    if (!size || !val) return '#F3F4F6';
    const pct = val / size;
    if (pct >= 0.8) return '#059669';
    if (pct >= 0.6) return '#10B981';
    if (pct >= 0.4) return '#6EE7B7';
    if (pct >= 0.2) return '#FCD34D';
    return '#FCA5A5';
  };
  return (
    <div className="iqi-table-wrap">
      <table className="iqi-table iqi-cohort-table">
        <thead>
          <tr>
            <th>Cohort</th>
            <th>Size</th>
            {Array.from({ length: maxMonths + 1 }, (_, i) => <th key={i}>M+{i}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map(row => (
            <tr key={row.cohort}>
              <td>{row.cohort}</td>
              <td><strong>{fmt(row.cohort_size)}</strong></td>
              {Array.from({ length: maxMonths + 1 }, (_, i) => {
                const key = `m${i}`;
                const val = +row[key] || 0;
                const pct = row.cohort_size > 0 ? (val / row.cohort_size * 100).toFixed(0) : 0;
                const bg  = cellColor(val, row.cohort_size);
                return (
                  <td key={i} title={`${val} merchant (${pct}%)`}
                    style={{ background: bg, color: pct >= 60 ? '#fff' : '#111', textAlign: 'center', minWidth: 64 }}>
                    {val > 0 ? `${pct}%` : '–'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Upload Card ── */
function UploadCard({ title, icon, type, count, lastUpdate, onSuccess }) {
  const [file, setFile]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);
  const inputRef = useRef(null);

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    setResult(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch(`${API}/upload/${type}`, {
        method: 'POST',
        headers: authHeaders(),
        body: fd,
      });
      const data = await r.json();
      setResult(data);
      if (data.success) {
        setFile(null);
        if (inputRef.current) inputRef.current.value = '';
        onSuccess?.();
      }
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="iqi-upload-card">
      <div className="iqi-upload-header">
        <div className="iqi-upload-icon" style={{ background: COLOR_IQI + '1A', color: COLOR_IQI }}>
          <i className={`ti ti-${icon}`} />
        </div>
        <div>
          <div className="iqi-upload-title">{title}</div>
          <div className="iqi-upload-meta">
            {count > 0 ? `${fmt(count)} baris` : 'Belum ada data'}
            {lastUpdate && ` · ${new Date(lastUpdate).toLocaleDateString('id-ID')}`}
          </div>
        </div>
      </div>

      <div className="iqi-upload-body">
        <input
          ref={inputRef}
          type="file"
          accept=".xls,.xlsx"
          onChange={e => { setFile(e.target.files[0]); setResult(null); }}
          className="iqi-upload-input"
        />
        {file && (
          <div className="iqi-upload-filename">
            <i className="ti ti-file-spreadsheet" /> {file.name}
          </div>
        )}
        <button
          className="iqi-upload-btn"
          onClick={handleUpload}
          disabled={!file || loading}
        >
          {loading ? <><i className="ti ti-loader" /> Mengupload...</> : <><i className="ti ti-upload" /> Upload XLS</>}
        </button>
      </div>

      {result && (
        <div className={`iqi-upload-result ${result.success ? 'success' : 'error'}`}>
          {result.success
            ? <>
                <i className="ti ti-circle-check" /> {fmt(result.count)} dari {fmt(result.total)} baris berhasil diimpor
                {result.errors?.length > 0 && (
                  <div className="iqi-upload-errors">
                    {result.errors.slice(0, 5).map((e, i) => (
                      <div key={i}>Baris {e.row}: {e.error}</div>
                    ))}
                    {result.errors.length > 5 && <div>...dan {result.errors.length - 5} error lainnya</div>}
                  </div>
                )}
              </>
            : <><i className="ti ti-alert-circle" /> {result.error}</>
          }
        </div>
      )}

      <div className="iqi-upload-guide">
        <strong>Kolom wajib:</strong> {type === 'outlet' ? 'id_outlet'
          : type === 'qris' ? 'id_outlet, status'
          : type === 'trx'  ? 'tanggal, id_outlet, jumlah_trx, jumlah_omzet'
          : 'id_upline'}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   TAB COMPONENTS
═══════════════════════════════════════════ */

function TabDashboard({ bulan, onBulanChange, periods }) {
  const [kpi,    setKpi]    = useState(null);
  const [funnel, setFunnel] = useState(null);
  const [trend,  setTrend]  = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const q = bulan ? `?bulan=${bulan}` : '';
    Promise.all([
      apiFetch(`/kpi${q}`),
      apiFetch('/funnel'),
      apiFetch('/trend?months=6'),
    ]).then(([k, f, t]) => {
      setKpi(k); setFunnel(f); setTrend(t);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [bulan]);

  if (loading) return <div className="iqi-loading"><i className="ti ti-loader" /> Memuat data...</div>;
  if (!kpi) return <div className="iqi-empty">Tidak ada data KPI. Silakan upload data terlebih dahulu.</div>;

  return (
    <div className="iqi-tab-content">
      {/* Period selector */}
      <div className="iqi-period-row">
        <label className="iqi-period-label"><i className="ti ti-calendar" /> Periode</label>
        <select className="iqi-period-select" value={bulan || ''} onChange={e => onBulanChange(e.target.value || null)}>
          <option value="">Terbaru</option>
          {periods.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {/* 5 KPI Cards */}
      <SectionHeader title="5 KPI Utama InstaQRIS" sub={`Periode: ${kpi.bulan || 'Terbaru'}`} />
      <div className="iqi-kpi-grid">
        <KPICard label="MAT"  value={kpi.mat}  prev={kpi.mat_prev}  pct={kpi.mat_pct}
          sub="Merchant Aktif Transaksi" icon="users" color="#7F77DD" />
        <KPICard label="NMAT" value={kpi.nmat} pct={null}
          sub="New Merchant Aktif" icon="user-plus" color="#3B82F6" />
        <KPICard label="ATPU" value={kpi.atpu?.toFixed(1)} prev={kpi.atpu_prev} pct={kpi.atpu_pct}
          sub="Avg Transaksi/Merchant" icon="repeat" color="#F59E0B" />
        <KPICard label="ARPU" value={kpi.arpu} prev={kpi.arpu_prev} pct={kpi.arpu_pct}
          sub="Avg Revenue/Merchant" icon="trending-up" color="#1D9E75" format="currency" />
        <KPICard label="ARPT" value={kpi.arpt} prev={kpi.arpt_prev} pct={kpi.arpt_pct}
          sub="Avg Revenue/Transaksi" icon="receipt" color="#8B5CF6" format="currency" />
      </div>

      {/* Diagnostic ratios */}
      <div className="iqi-ratio-row">
        <div className="iqi-ratio-card">
          <div className="iqi-ratio-label">NMAT/MAT Ratio</div>
          <div className="iqi-ratio-value">{fmtPct(kpi.nmat_mat_ratio)}</div>
          <div className="iqi-ratio-hint">
            {kpi.nmat_mat_ratio > 30
              ? <><i className="ti ti-alert-triangle" style={{color:'#F59E0B'}} /> Rasio tinggi — periksa churn merchant lama</>
              : <><i className="ti ti-circle-check" style={{color:'#10B981'}} /> Normal — merchant lama stabil</>}
          </div>
        </div>
        <div className="iqi-ratio-card">
          <div className="iqi-ratio-label">Activation Rate</div>
          <div className="iqi-ratio-value">{fmtPct(kpi.activation_rate)}</div>
          <div className="iqi-ratio-hint">MAT ÷ Total QRIS Terbit ({fmt(kpi.total_terbit)} outlet)</div>
        </div>
        <div className="iqi-ratio-card">
          <div className="iqi-ratio-label">Total Omzet</div>
          <div className="iqi-ratio-value">{fmtC(kpi.total_omzet)}</div>
          <div className="iqi-ratio-hint">{fmt(kpi.total_trx)} transaksi</div>
        </div>
      </div>

      {/* Funnel */}
      <SectionHeader title="Funnel Merchant" sub="Registrasi → QRIS Terbit → Transaksi Aktif (all-time)" />
      <FunnelChart data={funnel} />
      {funnel && (
        <div className="iqi-funnel-stats">
          <span>Outlet registered: <strong>{fmt(funnel.registrasi)}</strong></span>
          <span>QRIS Terbit: <strong>{fmt(funnel.terbit)}</strong> ({fmtPct(funnel.rate_reg_to_terbit)})</span>
          <span>Pernah transaksi: <strong>{fmt(funnel.mat)}</strong> ({fmtPct(funnel.rate_terbit_to_mat)} dari terbit)</span>
          <span>Non-Terbit: <strong>{fmt(funnel.non_terbit)}</strong></span>
        </div>
      )}

      {/* Trend Chart */}
      {trend?.length > 0 && (
        <>
          <SectionHeader title="Tren MAT 6 Bulan Terakhir" />
          <div className="iqi-chart-card">
            <TrendChart data={trend} metric="mat" label="MAT" color={COLOR_IQI} />
          </div>
          <div className="iqi-trend-grid">
            <div className="iqi-chart-card">
              <div className="iqi-chart-title">Tren ARPU</div>
              <TrendChart data={trend} metric="arpu" label="ARPU" color="#1D9E75" />
            </div>
            <div className="iqi-chart-card">
              <div className="iqi-chart-title">Tren ATPU</div>
              <TrendChart data={trend} metric="atpu" label="ATPU" color="#F59E0B" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TabMerchant({ bulan }) {
  const [type,  setType]  = useState('top');
  const [data,  setData]  = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const q = [`type=${type}`, bulan ? `bulan=${bulan}` : '', 'limit=50'].filter(Boolean).join('&');
    apiFetch(`/merchants?${q}`)
      .then(setData).catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [type, bulan]);

  useEffect(() => { load(); }, [load]);

  const topCols = [
    { key: 'no',           label: '#',        style: { width: 36 }, render: (_, __, i) => i + 1 },
    { key: 'id_outlet',    label: 'ID Outlet', style: { width: 100 } },
    { key: 'nama_merchant',label: 'Merchant' },
    { key: 'kota',         label: 'Kota' },
    { key: 'paket',        label: 'Paket',    style: { width: 70 } },
    { key: 'qris_status',  label: 'QRIS',     style: { width: 80 },
      render: v => <span className={`iqi-badge ${v === 'Terbit' ? 'success' : 'warn'}`}>{v || '–'}</span> },
    { key: 'total_trx',   label: 'TRX',      style: { textAlign: 'right', width: 80 },
      render: v => fmt(v) },
    { key: 'total_omzet', label: 'GMV',      style: { textAlign: 'right', width: 110 },
      render: v => fmtC(v) },
  ];

  const dormantCols = [
    { key: 'id_outlet',    label: 'ID Outlet', style: { width: 100 } },
    { key: 'nama_merchant',label: 'Merchant' },
    { key: 'kota',         label: 'Kota' },
    { key: 'id_upline',    label: 'Upline',   style: { width: 100 } },
    { key: 'last_trx_date',label: 'Trx Terakhir', style: { width: 110 },
      render: v => v ? new Date(v).toLocaleDateString('id-ID') : 'Belum pernah' },
    { key: 'total_trx_alltime', label: 'Total TRX (all)', style: { textAlign:'right', width: 90 },
      render: v => fmt(v) },
  ];

  const churnCols = [
    { key: 'id_outlet',    label: 'ID Outlet', style: { width: 100 } },
    { key: 'nama_merchant',label: 'Merchant' },
    { key: 'kota',         label: 'Kota' },
    { key: 'last_date',    label: 'Trx Terakhir', style: { width: 110 },
      render: v => v ? new Date(v).toLocaleDateString('id-ID') : '–' },
    { key: 'total_trx',   label: 'Total TRX', style: { textAlign:'right', width: 80 }, render: v => fmt(v) },
    { key: 'days_inactive',label: 'Tidak Aktif', style: { textAlign:'right', width: 90 },
      render: v => <span style={{ color: v > 90 ? '#EF4444' : '#F59E0B' }}>{v} hari</span> },
  ];

  const cols = type === 'top' ? topCols : type === 'dormant' ? dormantCols : churnCols;

  return (
    <div className="iqi-tab-content">
      <div className="iqi-type-tabs">
        {[
          { k: 'top',     label: '🏆 Top GMV',            sub: 'Top 50 merchant berdasarkan omzet' },
          { k: 'dormant', label: '😴 Dormant',            sub: 'QRIS Terbit tapi tidak aktif periode ini' },
          { k: 'churn',   label: '🚨 Churn Risk',         sub: 'Tidak transaksi ≥30 hari' },
        ].map(t => (
          <button key={t.k}
            className={`iqi-type-tab ${type === t.k ? 'active' : ''}`}
            onClick={() => setType(t.k)}
            title={t.sub}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading
        ? <div className="iqi-loading"><i className="ti ti-loader" /> Memuat...</div>
        : <DataTable cols={cols} rows={data.map((r, i) => ({ ...r, no: i + 1 }))}
            emptyMsg="Tidak ada data merchant" />
      }
    </div>
  );
}

function TabGeografi({ bulan }) {
  const [level, setLevel] = useState('provinsi');
  const [data,  setData]  = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const q = [`level=${level}`, bulan ? `bulan=${bulan}` : ''].filter(Boolean).join('&');
    apiFetch(`/geography?${q}`)
      .then(setData).catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [level, bulan]);

  const maxOmzet = Math.max(...data.map(d => +d.total_omzet || 0), 1);

  const cols = [
    { key: 'wilayah',      label: level === 'provinsi' ? 'Provinsi' : 'Kota' },
    { key: 'total_merchant',label: 'Outlet',    style: { textAlign:'right', width: 70  }, render: v => fmt(v) },
    { key: 'qris_terbit',  label: 'Terbit',    style: { textAlign:'right', width: 70  }, render: v => fmt(v) },
    { key: 'mat',          label: 'MAT',       style: { textAlign:'right', width: 70  }, render: v => fmt(v) },
    { key: 'activation_rate', label: 'Akt.%', style: { textAlign:'right', width: 60  }, render: v => fmtPct(v) },
    { key: 'total_trx',   label: 'TRX',       style: { textAlign:'right', width: 80  }, render: v => fmt(v) },
    { key: 'total_omzet', label: 'GMV',       style: { textAlign:'right', width: 120 }, render: v => fmtC(v) },
    { key: 'total_omzet', label: '',           style: { width: 140 },
      render: v => <MiniBar value={+v} max={maxOmzet} /> },
  ];

  return (
    <div className="iqi-tab-content">
      <div className="iqi-type-tabs">
        <button className={`iqi-type-tab ${level === 'provinsi' ? 'active' : ''}`} onClick={() => setLevel('provinsi')}>
          Provinsi
        </button>
        <button className={`iqi-type-tab ${level === 'kota' ? 'active' : ''}`} onClick={() => setLevel('kota')}>
          Kota/Kabupaten
        </button>
      </div>
      {loading
        ? <div className="iqi-loading"><i className="ti ti-loader" /> Memuat...</div>
        : <DataTable cols={cols} rows={data} emptyMsg="Tidak ada data wilayah (perlu upload iq_outlet)" />
      }
    </div>
  );
}

function TabPaketMcc({ bulan }) {
  const [view, setView] = useState('paket');
  const [paket, setPaket] = useState([]);
  const [mcc,   setMcc]   = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const q = bulan ? `?bulan=${bulan}` : '';
    Promise.all([
      apiFetch(`/package${q}`),
      apiFetch(`/mcc${q}`),
    ]).then(([p, m]) => { setPaket(p); setMcc(m); })
      .catch(() => {}).finally(() => setLoading(false));
  }, [bulan]);

  const paketPriceMap = { '25k': 25000, '35k': 35000, '49k': 49000 };
  const getPaketPrice = paket => {
    if (!paket) return 0;
    const match = String(paket).match(/\d+/);
    if (!match) return 0;
    const num = parseInt(match[0]);
    if (num <= 25) return 25000;
    if (num <= 35) return 35000;
    if (num <= 49) return 49000;
    return num * (num > 1000 ? 1 : 1000);
  };

  const paketCols = [
    { key: 'paket',       label: 'Paket' },
    { key: 'total_merchant', label: 'Outlet', style: { textAlign:'right' }, render: v => fmt(v) },
    { key: 'qris_terbit', label: 'Terbit',   style: { textAlign:'right' }, render: v => fmt(v) },
    { key: 'mat',         label: 'MAT',      style: { textAlign:'right' }, render: v => fmt(v) },
    { key: 'avg_arpu',    label: 'Avg ARPU', style: { textAlign:'right' }, render: v => fmtC(v) },
    { key: 'avg_atpu',    label: 'Avg ATPU', style: { textAlign:'right' }, render: v => Number(v).toFixed(1) },
    { key: 'total_omzet', label: 'Total GMV',style: { textAlign:'right' }, render: v => fmtC(v) },
    { key: 'paket', label: 'Rev Aktivasi', style: { textAlign:'right' },
      render: (v, row) => fmtC((getPaketPrice(v)) * (+row.qris_terbit || 0)) },
  ];

  const mccCols = [
    { key: 'kategori',    label: 'Kategori Bisnis' },
    { key: 'mcc',         label: 'MCC',    style: { width: 70 } },
    { key: 'total_merchant', label: 'Outlet', style: { textAlign:'right', width: 70 }, render: v => fmt(v) },
    { key: 'mat',         label: 'MAT',    style: { textAlign:'right', width: 70 }, render: v => fmt(v) },
    { key: 'avg_arpu',    label: 'Avg ARPU', style: { textAlign:'right', width: 100 }, render: v => fmtC(v) },
    { key: 'avg_atpu',    label: 'Avg ATPU', style: { textAlign:'right', width: 80 },  render: v => Number(v).toFixed(1) },
    { key: 'total_omzet', label: 'Total GMV',style: { textAlign:'right', width: 120 }, render: v => fmtC(v) },
  ];

  if (loading) return <div className="iqi-loading"><i className="ti ti-loader" /> Memuat...</div>;

  return (
    <div className="iqi-tab-content">
      <div className="iqi-type-tabs">
        <button className={`iqi-type-tab ${view === 'paket' ? 'active' : ''}`} onClick={() => setView('paket')}>
          Paket Aktivasi
        </button>
        <button className={`iqi-type-tab ${view === 'mcc' ? 'active' : ''}`} onClick={() => setView('mcc')}>
          MCC / Kategori Bisnis
        </button>
      </div>

      {view === 'paket' ? (
        <>
          <SectionHeader title="Analisis per Paket Aktivasi"
            sub="Bandingkan ARPU dan ATPU antar paket — buktikan ROI paket lebih tinggi" />
          <DataTable cols={paketCols} rows={paket} emptyMsg="Tidak ada data paket (perlu upload iq_outlet)" />
        </>
      ) : (
        <>
          <SectionHeader title="Analisis per Kategori Bisnis (MCC)"
            sub="Identifikasi sektor bisnis terkuat untuk fokus akuisisi" />
          <DataTable cols={mccCols} rows={mcc} emptyMsg="Tidak ada data MCC (perlu upload iq_outlet)" />
        </>
      )}
    </div>
  );
}

function TabQrisQuality() {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const donutRef = useRef(null);
  const donutChart = useRef(null);

  useEffect(() => {
    apiFetch('/qris-quality')
      .then(setData).catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!donutRef.current || !data?.summary) return;
    if (donutChart.current) donutChart.current.destroy();
    const s = data.summary;
    donutChart.current = new Chart(donutRef.current, {
      type: 'doughnut',
      data: {
        labels: ['Terbit', 'Perbaikan Data', 'Rejected', 'Lainnya'],
        datasets: [{
          data: [+s.terbit, +s.perbaikan, +s.rejected, +s.lainnya],
          backgroundColor: ['#10B981', '#F59E0B', '#EF4444', '#9CA3AF'],
          borderWidth: 2,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: {
            label: ctx => `${ctx.label}: ${fmt(ctx.raw)} (${(ctx.raw / +s.total * 100).toFixed(1)}%)`
          }}
        }
      }
    });
    return () => { if (donutChart.current) donutChart.current.destroy(); };
  }, [data]);

  if (loading) return <div className="iqi-loading"><i className="ti ti-loader" /> Memuat...</div>;
  if (!data) return <div className="iqi-empty">Tidak ada data QRIS. Silakan upload data penerbitan QRIS.</div>;

  const { summary, by_area, trend } = data;

  const areaCols = [
    { key: 'provinsi',    label: 'Provinsi' },
    { key: 'total',       label: 'Total',     style: { textAlign:'right', width: 80 }, render: v => fmt(v) },
    { key: 'terbit',      label: 'Terbit',    style: { textAlign:'right', width: 80 }, render: v => fmt(v) },
    { key: 'non_terbit',  label: 'Non-Terbit',style: { textAlign:'right', width: 90 }, render: v => fmt(v) },
    { key: 'success_rate',label: 'Success%',  style: { textAlign:'right', width: 80 },
      render: v => <span style={{ color: v >= 80 ? '#10B981' : v >= 50 ? '#F59E0B' : '#EF4444' }}>{fmtPct(v)}</span> },
  ];

  return (
    <div className="iqi-tab-content">
      <div className="iqi-quality-layout">
        {/* Donut chart */}
        <div className="iqi-quality-donut">
          <SectionHeader title="Distribusi Status QRIS" />
          <div style={{ height: 280 }}>
            <canvas ref={donutRef} />
          </div>
          <div className="iqi-quality-rates">
            <div className="iqi-quality-rate-item success">
              <div>{fmtPct(summary.success_rate)}</div>
              <div>Success Rate</div>
            </div>
            <div className="iqi-quality-rate-item warn">
              <div>{fmtPct(summary.perbaikan_rate)}</div>
              <div>Perbaikan Data</div>
            </div>
            <div className="iqi-quality-rate-item danger">
              <div>{fmtPct(summary.rejected_rate)}</div>
              <div>Rejected</div>
            </div>
          </div>
        </div>

        {/* By area table */}
        <div className="iqi-quality-area">
          <SectionHeader title="Success Rate per Provinsi"
            sub="Area dengan rejection rate tinggi perlu intervensi operasional" />
          <DataTable cols={areaCols} rows={by_area} emptyMsg="Tidak ada data per wilayah" />
        </div>
      </div>

      {/* Monthly trend */}
      {trend?.length > 0 && (
        <>
          <SectionHeader title="Tren Penerbitan per Bulan" />
          <div className="iqi-table-wrap">
            <table className="iqi-table">
              <thead>
                <tr>
                  <th>Bulan</th>
                  <th style={{ textAlign:'right' }}>Total</th>
                  <th style={{ textAlign:'right' }}>Terbit</th>
                  <th style={{ textAlign:'right' }}>Perbaikan</th>
                  <th style={{ textAlign:'right' }}>Rejected</th>
                  <th style={{ textAlign:'right' }}>Success%</th>
                </tr>
              </thead>
              <tbody>
                {trend.map(t => (
                  <tr key={t.bulan}>
                    <td>{t.bulan}</td>
                    <td style={{ textAlign:'right' }}>{fmt(t.total)}</td>
                    <td style={{ textAlign:'right', color:'#10B981' }}>{fmt(t.terbit)}</td>
                    <td style={{ textAlign:'right', color:'#F59E0B' }}>{fmt(t.perbaikan)}</td>
                    <td style={{ textAlign:'right', color:'#EF4444' }}>{fmt(t.rejected)}</td>
                    <td style={{ textAlign:'right' }}>
                      {t.total > 0 ? fmtPct((t.terbit / t.total * 100).toFixed(1)) : '–'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function TabAffiliate({ bulan }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const q = bulan ? `?bulan=${bulan}` : '';
    apiFetch(`/affiliate${q}`)
      .then(setData).catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [bulan]);

  if (loading) return <div className="iqi-loading"><i className="ti ti-loader" /> Memuat...</div>;
  if (!data) return <div className="iqi-empty">Tidak ada data affiliate. Upload iq_outlet dengan field id_upline.</div>;

  const { leaderboard, summary } = data;

  const cols = [
    { key: '_rank',            label: '#',    style: { width: 36 }, render: (_, __, i) => i + 1 },
    { key: 'id_upline',        label: 'ID Affiliate' },
    { key: 'total_downlines',  label: 'Downlines',   style: { textAlign:'right', width: 90 }, render: v => fmt(v) },
    { key: 'terbit_count',     label: 'Terbit',      style: { textAlign:'right', width: 70 }, render: v => fmt(v) },
    { key: 'mat_count',        label: 'MAT',         style: { textAlign:'right', width: 70 }, render: v => fmt(v) },
    { key: 'komisi_valid',     label: 'Komisi Valid',style: { textAlign:'right', width: 110 },
      render: v => <strong style={{ color:'#10B981' }}>{fmtC(v)}</strong> },
    { key: 'komisi_pending',   label: 'Pending',     style: { textAlign:'right', width: 110 },
      render: v => <span style={{ color:'#F59E0B' }}>{fmtC(v)}</span> },
    { key: 'activation_quality', label: 'Akt.Q%',   style: { textAlign:'right', width: 70 },
      render: v => <span style={{ color: v >= 70 ? '#10B981' : v >= 40 ? '#F59E0B' : '#EF4444' }}>{fmtPct(v)}</span> },
    { key: 'transaction_quality', label: 'Trx.Q%',  style: { textAlign:'right', width: 70 },
      render: v => <span style={{ color: v >= 70 ? '#10B981' : v >= 40 ? '#F59E0B' : '#EF4444' }}>{fmtPct(v)}</span> },
    { key: 'gmv_jaringan',     label: 'GMV Jaringan',style: { textAlign:'right', width: 120 }, render: v => fmtC(v) },
  ];

  return (
    <div className="iqi-tab-content">
      {/* Summary */}
      <div className="iqi-kpi-grid">
        <KPICard label="Total Affiliate"  value={summary.total_affiliate}  pct={null} icon="users-group" color="#7F77DD"   sub="Unique upline" />
        <KPICard label="Total Downlines"  value={summary.total_downlines}  pct={null} icon="user-plus"   color="#3B82F6"   sub="Merchant direkrut" />
        <KPICard label="Komisi Valid"     value={summary.total_komisi_valid}   pct={null} icon="coin"    color="#10B981"   sub="Dapat dibayarkan" format="currency" />
        <KPICard label="Komisi Pending"   value={summary.total_komisi_pending} pct={null} icon="clock"  color="#F59E0B"   sub="Belum dapat cair" format="currency" />
      </div>

      <div className="iqi-affiliate-legend">
        <span><span className="iqi-dot" style={{background:'#10B981'}} /> Akt.Q ≥70% — Rekrutmen berkualitas</span>
        <span><span className="iqi-dot" style={{background:'#F59E0B'}} /> Akt.Q 40-69% — Perlu coaching</span>
        <span><span className="iqi-dot" style={{background:'#EF4444'}} /> Akt.Q &lt;40% — Underperform</span>
      </div>

      <SectionHeader title="Leaderboard Affiliate"
        sub="Diurutkan berdasarkan komisi valid. Akt.Q = Activation Quality, Trx.Q = Transaction Quality" />
      <DataTable cols={cols} rows={leaderboard.map((r, i) => ({ ...r, _rank: i + 1 }))}
        emptyMsg="Tidak ada data affiliate — pastikan iq_outlet memiliki field id_upline" />
    </div>
  );
}

function TabRetensi({ bulan }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiFetch('/cohort')
      .then(setData).catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="iqi-loading"><i className="ti ti-loader" /> Memuat...</div>;
  if (!data) return <div className="iqi-empty">Tidak ada data retensi. Upload data transaksi terlebih dahulu.</div>;

  const churnCols = [
    { key: 'id_outlet',    label: 'ID Outlet', style: { width: 100 } },
    { key: 'nama_merchant',label: 'Merchant' },
    { key: 'kota',         label: 'Kota' },
    { key: 'id_upline',    label: 'Upline',   style: { width: 100 } },
    { key: 'last_date',    label: 'Trx Terakhir', style: { width: 110 },
      render: v => v ? new Date(v).toLocaleDateString('id-ID') : '–' },
    { key: 'days_inactive',label: 'Tidak Aktif', style: { textAlign:'right', width: 90 },
      render: v => <span style={{ color: v > 90 ? '#EF4444' : '#F59E0B', fontWeight: 600 }}>{v} hari</span> },
  ];

  return (
    <div className="iqi-tab-content">
      <SectionHeader title="Cohort Retention Analysis"
        sub="% merchant dari cohort bulan X yang masih aktif transaksi di bulan berikutnya" />
      <div className="iqi-cohort-legend">
        <span style={{ background:'#059669', padding:'2px 8px', borderRadius:4, color:'#fff', fontSize:12 }}>≥80%</span>
        <span style={{ background:'#10B981', padding:'2px 8px', borderRadius:4, color:'#fff', fontSize:12 }}>60-80%</span>
        <span style={{ background:'#6EE7B7', padding:'2px 8px', borderRadius:4, fontSize:12 }}>40-60%</span>
        <span style={{ background:'#FCD34D', padding:'2px 8px', borderRadius:4, fontSize:12 }}>20-40%</span>
        <span style={{ background:'#FCA5A5', padding:'2px 8px', borderRadius:4, fontSize:12 }}>&lt;20%</span>
      </div>
      <CohortTable data={data.cohort} />

      {data.churn?.length > 0 && (
        <>
          <SectionHeader title={`Merchant Churn Risk (≥30 hari tidak aktif) · ${data.churn.length} merchant`}
            sub="Prioritas win-back campaign sebelum merchant pindah ke kompetitor" />
          <DataTable cols={churnCols} rows={data.churn}
            emptyMsg="Tidak ada merchant churn" />
        </>
      )}
    </div>
  );
}

function TabData({ overview, reload }) {
  return (
    <div className="iqi-tab-content">
      <SectionHeader title="Kelola Data — Upload XLS"
        sub="Upload file XLS/XLSX dari 4 sumber data. Sistem akan mapping kolom otomatis." />

      <div className="iqi-upload-grid">
        <UploadCard title="Data Outlet (Master Merchant)"
          icon="building-store"
          type="outlet"
          count={overview?.outlet?.count}
          lastUpdate={overview?.outlet?.last_update}
          onSuccess={reload} />
        <UploadCard title="Data Penerbitan QRIS"
          icon="qrcode"
          type="qris"
          count={overview?.qris?.count}
          lastUpdate={overview?.qris?.last_update}
          onSuccess={reload} />
        <UploadCard title="Data Transaksi Outlet"
          icon="receipt-2"
          type="trx"
          count={overview?.trx?.count}
          lastUpdate={overview?.trx?.last_update}
          onSuccess={reload} />
        <UploadCard title="Data Affiliate"
          icon="users-group"
          type="affiliate"
          count={overview?.affiliate?.count}
          lastUpdate={overview?.affiliate?.last_update}
          onSuccess={reload} />
      </div>

      <div className="iqi-data-guide">
        <SectionHeader title="Panduan Format Kolom XLS" />
        <div className="iqi-guide-grid">
          <div className="iqi-guide-card">
            <div className="iqi-guide-title"><i className="ti ti-building-store" /> Data Outlet</div>
            <ul>
              <li><code>id_outlet</code> — ID unik merchant <em>(wajib)</em></li>
              <li><code>nama_merchant</code> — Nama toko/merchant</li>
              <li><code>tgl_registrasi</code> — Tanggal daftar (DD/MM/YYYY)</li>
              <li><code>tgl_aktivasi</code> — Tanggal aktivasi</li>
              <li><code>paket</code> — Paket aktivasi (25k/35k/49k)</li>
              <li><code>kota</code>, <code>provinsi</code> — Lokasi</li>
              <li><code>mcc</code>, <code>nama_kategori</code> — Kategori bisnis</li>
              <li><code>id_upline</code> — ID affiliate/upline</li>
            </ul>
          </div>
          <div className="iqi-guide-card">
            <div className="iqi-guide-title"><i className="ti ti-qrcode" /> Data QRIS</div>
            <ul>
              <li><code>id_outlet</code> — ID merchant <em>(wajib)</em></li>
              <li><code>status</code> — Terbit / Perbaikan Data / Rejected <em>(wajib)</em></li>
              <li><code>tanggal</code> — Tanggal penerbitan (opsional)</li>
            </ul>
          </div>
          <div className="iqi-guide-card">
            <div className="iqi-guide-title"><i className="ti ti-receipt-2" /> Data Transaksi</div>
            <ul>
              <li><code>tanggal</code> — Tanggal transaksi <em>(wajib)</em></li>
              <li><code>id_outlet</code> — ID merchant <em>(wajib)</em></li>
              <li><code>jumlah_trx</code> — Jumlah transaksi</li>
              <li><code>jumlah_omzet</code> — Total omzet (Rp)</li>
            </ul>
          </div>
          <div className="iqi-guide-card">
            <div className="iqi-guide-title"><i className="ti ti-users-group" /> Data Affiliate</div>
            <ul>
              <li><code>id_upline</code> — ID affiliate <em>(wajib)</em></li>
              <li><code>id_outlet</code> — ID merchant downline</li>
              <li><code>tanggal</code> — Tanggal rekrutmen</li>
              <li><code>komisi</code> — Nominal komisi</li>
            </ul>
          </div>
        </div>
        <div className="iqi-guide-note">
          <i className="ti ti-info-circle" />
          Sistem mendukung berbagai variasi nama kolom dalam Bahasa Indonesia maupun Inggris.
          Nama kolom bersifat <em>case-insensitive</em> dan spasi/underscore diabaikan.
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   MAIN PAGE
═══════════════════════════════════════════ */

const TABS = [
  { id: 'dashboard', label: 'Dashboard',     icon: 'dashboard' },
  { id: 'merchant',  label: 'Merchant',      icon: 'building-store' },
  { id: 'geografi',  label: 'Geografi',      icon: 'map' },
  { id: 'paket',     label: 'Paket & MCC',   icon: 'package' },
  { id: 'qris',      label: 'QRIS Quality',  icon: 'qrcode' },
  { id: 'affiliate', label: 'Affiliate',     icon: 'users-group' },
  { id: 'retensi',   label: 'Retensi',       icon: 'chart-dots' },
  { id: 'data',      label: 'Kelola Data',   icon: 'database' },
];

export default function InstaQrisInsight() {
  const [tab,      setTab]      = useState('dashboard');
  const [bulan,    setBulan]    = useState(null);
  const [periods,  setPeriods]  = useState([]);
  const [overview, setOverview] = useState(null);

  const loadOverview = useCallback(() => {
    apiFetch('/overview').then(setOverview).catch(() => {});
    apiFetch('/periods').then(setPeriods).catch(() => {});
  }, []);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  const hasData = overview
    && (overview.outlet?.count > 0 || overview.trx?.count > 0);

  return (
    <Layout>
      <div className="iqi-page">
        {/* Page Header */}
        <div className="iqi-page-header">
          <div className="iqi-page-title-row">
            <div className="iqi-page-icon" style={{ background: COLOR_IQI + '20', color: COLOR_IQI }}>
              <i className="ti ti-chart-infographic" />
            </div>
            <div>
              <h1 className="iqi-page-title">InstaQRIS Insight</h1>
              <div className="iqi-page-sub">Analytics Platform — 27 Analisis dari 4 Sumber Data</div>
            </div>
          </div>
          {overview && (
            <div className="iqi-page-status">
              {[
                { label: 'Outlet',    icon: 'building-store', count: overview.outlet?.count },
                { label: 'QRIS',      icon: 'qrcode',         count: overview.qris?.count },
                { label: 'Transaksi', icon: 'receipt-2',      count: overview.trx?.count },
                { label: 'Affiliate', icon: 'users-group',    count: overview.affiliate?.count },
              ].map(s => (
                <div key={s.label} className={`iqi-status-chip ${s.count > 0 ? 'active' : 'empty'}`}>
                  <i className={`ti ti-${s.icon}`} />
                  {s.label}: <strong>{fmt(s.count)}</strong>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tab nav */}
        <div className="iqi-tab-nav">
          {TABS.map(t => (
            <button key={t.id}
              className={`iqi-tab-btn ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <i className={`ti ti-${t.icon}`} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="iqi-tab-panel">
          {!hasData && tab !== 'data' && (
            <div className="iqi-no-data-banner">
              <i className="ti ti-database-off" />
              <span>Data belum tersedia. <button className="iqi-link" onClick={() => setTab('data')}>Upload data</button> terlebih dahulu untuk melihat analitik.</span>
            </div>
          )}
          {tab === 'dashboard' && <TabDashboard bulan={bulan} onBulanChange={setBulan} periods={periods} />}
          {tab === 'merchant'  && <TabMerchant  bulan={bulan} />}
          {tab === 'geografi'  && <TabGeografi   bulan={bulan} />}
          {tab === 'paket'     && <TabPaketMcc   bulan={bulan} />}
          {tab === 'qris'      && <TabQrisQuality />}
          {tab === 'affiliate' && <TabAffiliate  bulan={bulan} />}
          {tab === 'retensi'   && <TabRetensi    bulan={bulan} />}
          {tab === 'data'      && <TabData overview={overview} reload={loadOverview} />}
        </div>
      </div>
    </Layout>
  );
}
