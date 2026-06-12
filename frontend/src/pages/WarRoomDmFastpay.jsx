import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import { getDmFastpayAnalytics } from '../services/api';

const COLOR = '#0EA5E9';

function fmt(v, isRp = false) {
  const num = Number(v) || 0;
  if (isRp) return 'Rp' + Math.round(Math.abs(num)).toLocaleString('id-ID');
  if (Math.abs(num) >= 1) return num.toLocaleString('id-ID', { maximumFractionDigits: 2 });
  return num.toFixed(2);
}

function fmtDev(v, isRp = false) {
  const num = Number(v) || 0;
  const color = num > 0 ? '#10B981' : num < 0 ? '#EF4444' : 'var(--text-3)';
  const sign = num > 0 ? '+' : '';
  let text;
  if (isRp) {
    text = (num < 0 ? '-Rp' : sign + 'Rp') + Math.abs(Math.round(num)).toLocaleString('id-ID');
  } else {
    text = sign + num.toLocaleString('id-ID', { maximumFractionDigits: 2 });
  }
  return <span style={{ color, fontWeight: 600 }}>{text}</span>;
}

function fmtPct(jun, base) {
  const j = Number(jun) || 0;
  const b = Number(base) || 0;
  if (b === 0) return <span style={{ color: 'var(--text-3)' }}>–</span>;
  const pct = ((j - b) / Math.abs(b)) * 100;
  const color = pct > 0 ? '#10B981' : pct < 0 ? '#EF4444' : 'var(--text-3)';
  return <span style={{ color, fontWeight: 600 }}>{pct > 0 ? '+' : ''}{pct.toFixed(2)}%</span>;
}

const ROWS = [
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

export default function WarRoomDmFastpay() {
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [result, setResult]           = useState(null);
  const [selectedTgl, setSelectedTgl] = useState(null);

  useEffect(() => { load(selectedTgl); }, [selectedTgl]);

  async function load(tgl) {
    try {
      setLoading(true);
      setError(null);
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

  return (
    <Layout>
      <div className="wr-page">
        <div className="wr-header" style={{ borderColor: COLOR }}>
          <div className="wr-header-left">
            <div className="wr-badge" style={{ background: COLOR }}>DM</div>
            <div>
              <div className="wr-title">WAR ROOM — DM Fastpay</div>
              <div className="wr-subtitle">Perbandingan DIRECT: April · Mei · Juni</div>
            </div>
          </div>
          {list.length > 1 && (
            <select
              className="wr-date-select"
              value={selectedTgl || (list[0] ? (typeof list[0] === 'string' ? list[0] : new Date(list[0]).toISOString().slice(0,10)) : '')}
              onChange={e => setSelectedTgl(e.target.value || null)}
            >
              {list.map(t => {
                const s = typeof t === 'string' ? t : new Date(t).toISOString().slice(0, 10);
                return <option key={s} value={s}>{s}</option>;
              })}
            </select>
          )}
        </div>

        {loading && (
          <div className="wrfp-loading">
            <i className="ti ti-loader-2" /> Memuat data...
          </div>
        )}

        {error && (
          <div className="wrfp-error">
            <i className="ti ti-alert-circle" /> {error}
          </div>
        )}

        {!loading && !error && !d && (
          <div className="empty-state" style={{ marginTop: 60 }}>
            <i className="ti ti-speakerphone" style={{ fontSize: 48, color: COLOR, display: 'block', marginBottom: 12 }} />
            <div className="empty-title">Belum ada data</div>
            <div className="empty-sub">Sync dari Apps Script belum berjalan</div>
          </div>
        )}

        {!loading && !error && d && (
          <div style={{ overflowX: 'auto', marginTop: 16 }}>
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
                {ROWS.map(({ key, label, rp }) => {
                  const apr = d[`${key}_apr`];
                  const mei = d[`${key}_mei`];
                  const jun = d[`${key}_jun`];
                  const devApr = (Number(jun) || 0) - (Number(apr) || 0);
                  const devMei = (Number(jun) || 0) - (Number(mei) || 0);
                  return (
                    <tr key={key} className="wrdm-row">
                      <td className="wrdm-td-label">{label}</td>
                      <td className="wrdm-td">{fmt(apr, rp)}</td>
                      <td className="wrdm-td">{fmt(mei, rp)}</td>
                      <td className="wrdm-td" style={{ background: 'rgba(14,165,233,0.06)', fontWeight: 600 }}>{fmt(jun, rp)}</td>
                      <td className="wrdm-td">{fmtDev(devApr, rp)}</td>
                      <td className="wrdm-td">{fmtPct(jun, apr)}</td>
                      <td className="wrdm-td">{fmtDev(devMei, rp)}</td>
                      <td className="wrdm-td">{fmtPct(jun, mei)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
              Data diperbarui: {typeof result.tanggal === 'string'
                ? result.tanggal
                : new Date(result.tanggal).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
