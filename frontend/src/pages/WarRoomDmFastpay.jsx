import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import { getDmFastpayAnalytics } from '../services/api';

const COLOR = '#0EA5E9';

/* ── Helpers ── */
const fmtRp = v => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e9) return `Rp ${(n/1e9).toFixed(2)}M`;
  if (Math.abs(n) >= 1e6) return `Rp ${(n/1e6).toFixed(1)}jt`;
  if (Math.abs(n) >= 1e3) return `Rp ${Math.round(n/1e3)}rb`;
  return `Rp ${Math.round(n).toLocaleString('id-ID')}`;
};
const fmtRpFull = v => `Rp ${(Number(v)||0).toLocaleString('id-ID')}`;
const fmtN = v => (Number(v)||0).toLocaleString('id-ID');
const safe = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
const fmtDate = iso => {
  if (!iso) return '-';
  return new Date(String(iso).substring(0,10)+'T12:00:00').toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'});
};

/* Percentage stored as 0–100 (Apps Script sudah multiply *100) */
const pctOf = v => safe(v);

/* ── ProgressBar ── */
function ProgressBar({ pct, color, height = 7 }) {
  const p = Math.min(100, Math.max(0, safe(pct)));
  const c = color || (p >= 80 ? '#059669' : p >= 50 ? COLOR : '#F59E0B');
  return (
    <div style={{ background:'#E5E7EB', borderRadius:4, height, margin:'6px 0 2px', overflow:'hidden' }}>
      <div style={{ width:`${p}%`, background:c, borderRadius:4, height, transition:'width .4s ease' }} />
    </div>
  );
}

/* ── Card ── */
function Card({ title, badge, badgeColor, children, style }) {
  return (
    <div style={{ background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:10, padding:'16px 18px', ...style }}>
      {title && (
        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:10 }}>
          <span style={{ fontSize:13, fontWeight:700, color:'var(--text-1)' }}>{title}</span>
          {badge && <span style={{ fontSize:10, background:badgeColor||COLOR, color:'#fff', padding:'1px 7px', borderRadius:10, fontWeight:700 }}>{badge}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

/* ── KPI progress card (Revenue, NMAT, Brand, NMAT Jawa) ── */
function ProgressCard({ title, actual, target, pct, fmtActual, fmtTarget, extraContent }) {
  const p = pctOf(pct);
  const color = p >= 80 ? '#059669' : p >= 50 ? COLOR : '#F59E0B';
  return (
    <Card title={title} badge={`${p.toFixed(1)}%`} badgeColor={color}>
      <div style={{ fontSize:24, fontWeight:800, color:COLOR, margin:'2px 0' }}>{fmtActual(actual)}</div>
      <div style={{ fontSize:12, color:'var(--text-3)', marginBottom:2 }}>Target {fmtTarget(target)}</div>
      <ProgressBar pct={p} color={color} />
      {extraContent}
    </Card>
  );
}

/* ── Ads table (App Ads / Retargeting) ── */
function AdsTable({ title, color, rows }) {
  const showVal = (v, fmt) => {
    const n = safe(v);
    if (n === 0) return <span style={{ color:'var(--text-4)' }}>–</span>;
    return fmt ? fmt(n) : fmtN(n);
  };
  return (
    <Card title={title}>
      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
          <thead>
            <tr>
              <th style={{ textAlign:'left',  padding:'5px 8px', borderBottom:'2px solid var(--border)', color:'var(--text-3)', fontWeight:600, width:'30%' }}>Metrik</th>
              {['Google','Tiktok','Total'].map(h => (
                <th key={h} style={{ textAlign:'right', padding:'5px 8px', borderBottom:'2px solid var(--border)', color:color, fontWeight:700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} style={{ borderBottom:'1px solid var(--border)' }}>
                <td style={{ padding:'7px 8px', fontWeight:500, color:'var(--text-2)' }}>{row.label}</td>
                <td style={{ padding:'7px 8px', textAlign:'right' }}>{showVal(row.google, row.fmt)}</td>
                <td style={{ padding:'7px 8px', textAlign:'right' }}>{showVal(row.tiktok, row.fmt)}</td>
                <td style={{ padding:'7px 8px', textAlign:'right', fontWeight:600 }}>{showVal(row.total,  row.fmt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ── Main Page ── */
export default function WarRoomDmFastpay() {
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [data,        setData]        = useState(null);
  const [tanggal,     setTanggal]     = useState(null);
  const [tanggalList, setTanggalList] = useState([]);

  const load = tgl => {
    setLoading(true);
    setError(null);
    getDmFastpayAnalytics(tgl)
      .then(r => {
        setData(r.data);
        setTanggal(r.tanggal);
        setTanggalList(r.tanggal_list || []);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const d = data || {};
  const dayNum = tanggal ? parseInt(String(tanggal).substring(8, 10)) : null;

  /* totals */
  const appTotalBudget     = safe(d.app_google_budget) + safe(d.app_tiktok_budget);
  const appTotalImpression = safe(d.app_google_impression) + safe(d.app_tiktok_impression);
  const appTotalInstall    = safe(d.app_google_install) + safe(d.app_tiktok_install);
  const retTotalBudget     = safe(d.ret_google_budget) + safe(d.ret_tiktok_budget);
  const retTotalImpression = safe(d.ret_google_impression) + safe(d.ret_tiktok_impression);
  const retTotalAction     = safe(d.ret_google_action) + safe(d.ret_tiktok_action);

  const roiVal      = pctOf(d.roi);
  const konversiVal = pctOf(d.konversi);
  const roiColor    = roiVal >= 100 ? '#059669' : roiVal >= 70 ? '#F59E0B' : '#DC2626';

  return (
    <Layout>
      <div style={{ padding:'20px 24px' }}>

        {/* ── Header ── */}
        <div style={{ display:'flex', alignItems:'flex-start', gap:12, marginBottom:20, flexWrap:'wrap' }}>
          <div style={{ flex:1 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
              <h1 style={{ fontSize:20, fontWeight:700, color:'var(--text-1)', margin:0 }}>WAR-ROOM DM Fastpay</h1>
              <span style={{ fontSize:11, background:COLOR, color:'#fff', padding:'2px 9px', borderRadius:12, fontWeight:700, letterSpacing:.5 }}>DM</span>
              <span style={{ fontSize:11, background:'#F3F4F6', color:'var(--text-3)', padding:'2px 9px', borderRadius:12, fontWeight:600 }}>Payment Agent</span>
            </div>
            {tanggal && (
              <div style={{ fontSize:12, color:'var(--text-3)', marginTop:4 }}>
                Data {fmtDate(tanggal)}{dayNum ? ` · Periode 1–${dayNum}` : ''}
              </div>
            )}
          </div>
          {tanggalList.length > 1 && (
            <select
              value={tanggal || ''}
              onChange={e => load(e.target.value || undefined)}
              style={{ fontSize:12, border:'1px solid var(--border)', borderRadius:6, padding:'6px 10px', background:'var(--bg-card)', color:'var(--text-1)', cursor:'pointer' }}
            >
              {tanggalList.map(t => (
                <option key={t} value={t}>{fmtDate(t)}</option>
              ))}
            </select>
          )}
        </div>

        {/* ── States ── */}
        {loading && (
          <div className="wrfp-loading">
            <i className="ti ti-loader-2 wrfp-spin" />
            <span>Memuat data DM Fastpay…</span>
          </div>
        )}
        {error && (
          <div className="wrfp-error">
            <i className="ti ti-alert-circle" />
            <span>{error === 'Network Error' ? 'Tidak dapat terhubung ke server' : `Error: ${error}`}</span>
          </div>
        )}
        {!loading && !error && !data && (
          <div className="wr-empty">
            <i className="ti ti-speakerphone" style={{ fontSize:40, color:'var(--text-4)' }} />
            <p style={{ fontWeight:600, marginTop:12 }}>Belum ada data DM Fastpay</p>
            <span style={{ fontSize:13, color:'var(--text-3)' }}>Jalankan Apps Script di Google Sheets untuk sync data ke dashboard.</span>
          </div>
        )}

        {!loading && !error && data && (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

            {/* ── Row 1: 4 top KPI ── */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr auto 1fr', gap:12 }}>

              {/* Revenue DM */}
              <ProgressCard
                title="Revenue Digital Marketing"
                actual={d.rev_actual} target={d.rev_target} pct={d.rev_progress}
                fmtActual={fmtRpFull} fmtTarget={fmtRpFull}
              />

              {/* NMAT DM */}
              <ProgressCard
                title="NMAT Digital Marketing"
                actual={d.nmat_actual} target={d.nmat_target} pct={d.nmat_progress}
                fmtActual={fmtN} fmtTarget={fmtN}
              />

              {/* ROI */}
              <Card title="ROI">
                <div style={{ fontSize:34, fontWeight:900, color:roiColor, margin:'4px 0 0', whiteSpace:'nowrap' }}>
                  {roiVal.toFixed(2)}%
                </div>
              </Card>

              {/* Rev Trx Direct */}
              <Card title="Rev Trx Direct Bulanan (Aktivasi 2026)">
                <div style={{ fontSize:22, fontWeight:800, color:'var(--text-1)', margin:'4px 0' }}>
                  {fmtRpFull(d.rev_trx_direct)}
                </div>
              </Card>

            </div>

            {/* ── Row 2: Ads tables ── */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>

              <AdsTable
                title="App Ads Spending"
                color={COLOR}
                rows={[
                  { label:'Budget',    fmt:fmtRp, google:d.app_google_budget,     tiktok:d.app_tiktok_budget,     total:appTotalBudget },
                  { label:'Impression',           google:d.app_google_impression,  tiktok:d.app_tiktok_impression,  total:appTotalImpression },
                  { label:'CPM',       fmt:fmtRp, google:d.app_google_cpm,         tiktok:d.app_tiktok_cpm,         total:null },
                  { label:'Install',              google:d.app_google_install,     tiktok:d.app_tiktok_install,     total:appTotalInstall },
                  { label:'CPI',       fmt:fmtRp, google:d.app_google_cpi,         tiktok:d.app_tiktok_cpi,         total:null },
                ]}
              />

              <AdsTable
                title="Ads Spending Retargeting"
                color="#7C3AED"
                rows={[
                  { label:'Budget',    fmt:fmtRp, google:d.ret_google_budget,     tiktok:d.ret_tiktok_budget,     total:retTotalBudget },
                  { label:'Impression',           google:d.ret_google_impression,  tiktok:d.ret_tiktok_impression,  total:retTotalImpression },
                  { label:'CPM',       fmt:fmtRp, google:d.ret_google_cpm,         tiktok:d.ret_tiktok_cpm,         total:null },
                  { label:'Action',               google:d.ret_google_action,      tiktok:d.ret_tiktok_action,      total:retTotalAction },
                  { label:'CPA',       fmt:fmtRp, google:d.ret_google_cpa,         tiktok:d.ret_tiktok_cpa,         total:null },
                ]}
              />

            </div>

            {/* ── Row 3: Brand Exposure + NMAT Jawa + Meta + Proporsi Konten ── */}
            <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1.5fr 1fr', gap:12 }}>

              {/* Brand Exposure */}
              <Card title="Brand Exposure" badge={`${pctOf(d.brand_progress).toFixed(1)}%`} badgeColor={pctOf(d.brand_progress) >= 75 ? '#059669' : '#F59E0B'}>
                <div style={{ fontSize:22, fontWeight:800, color:COLOR }}>{fmtN(d.brand_actual)}</div>
                <div style={{ fontSize:12, color:'var(--text-3)', marginBottom:2 }}>Target {fmtN(d.brand_target)}</div>
                <ProgressBar pct={pctOf(d.brand_progress)} />
                <div style={{ borderTop:'1px solid var(--border)', marginTop:12, paddingTop:12, display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div>
                    <div style={{ fontSize:11, color:'var(--text-3)' }}>Registrasi Direct</div>
                    <div style={{ fontSize:16, fontWeight:700 }}>{fmtN(d.reg_direct)}</div>
                    <div style={{ fontSize:11, color:'var(--text-3)' }}>CPA {fmtRpFull(d.reg_direct_cpa)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize:11, color:'var(--text-3)' }}>Aktivasi Direct</div>
                    <div style={{ fontSize:16, fontWeight:700 }}>{fmtN(d.akt_direct)}</div>
                    <div style={{ fontSize:11, color:'var(--text-3)' }}>CPA {fmtRpFull(d.akt_direct_cpa)}</div>
                  </div>
                  <div style={{ gridColumn:'span 2', marginTop:4 }}>
                    <div style={{ fontSize:11, color:'var(--text-3)' }}>Konversi (Reg → Aktif)</div>
                    <div style={{ fontSize:20, fontWeight:800, color: konversiVal >= 15 ? '#059669' : '#F59E0B' }}>
                      {konversiVal.toFixed(2)}%
                    </div>
                  </div>
                </div>
              </Card>

              {/* NMAT Jawa */}
              <Card title="NMAT Jawa" badge={`${pctOf(d.nmat_jawa_progress).toFixed(1)}%`} badgeColor={pctOf(d.nmat_jawa_progress) >= 50 ? '#059669' : '#F59E0B'}>
                <div style={{ fontSize:22, fontWeight:800, color:COLOR, marginTop:2 }}>{fmtN(d.nmat_jawa_actual)}</div>
                <div style={{ fontSize:12, color:'var(--text-3)', marginBottom:2 }}>Target {fmtN(d.nmat_jawa_target)}</div>
                <ProgressBar pct={pctOf(d.nmat_jawa_progress)} />
              </Card>

              {/* Meta Ads */}
              <Card title="Meta Ads">
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px 14px' }}>
                  {[
                    { label:'Budget',      val:fmtRp(d.meta_budget) },
                    { label:'Impression',  val:fmtN(d.meta_impression) },
                    { label:'CPM',         val:fmtRp(d.meta_cpm) },
                    { label:'Klik',        val:fmtN(d.meta_klik) },
                    { label:'Hasil',       val:fmtN(d.meta_hasil) },
                    { label:'Biaya/Hasil', val:fmtRp(d.meta_biaya_hasil) },
                  ].map(item => (
                    <div key={item.label}>
                      <div style={{ fontSize:11, color:'var(--text-3)', marginBottom:1 }}>{item.label}</div>
                      <div style={{ fontSize:14, fontWeight:700, color:'var(--text-1)' }}>{item.val}</div>
                    </div>
                  ))}
                </div>
              </Card>

              {/* Proporsi Konten */}
              <Card title="Proporsi Konten">
                {[
                  { label:'Official', val:safe(d.konten_official), color:'#059669' },
                  { label:'KOL',      val:safe(d.konten_kol),      color:'#7C3AED' },
                  { label:'Paid Ads', val:safe(d.konten_paid_ads), color:COLOR },
                ].map(item => (
                  <div key={item.label} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:'1px solid var(--border)' }}>
                    <span style={{ fontSize:13, color:'var(--text-2)' }}>{item.label}</span>
                    <span style={{ fontSize:16, fontWeight:800, color:item.color }}>{fmtN(item.val)}</span>
                  </div>
                ))}
                <div style={{ marginTop:8, fontSize:12, color:'var(--text-3)', textAlign:'right' }}>
                  Total: {fmtN(safe(d.konten_official)+safe(d.konten_kol)+safe(d.konten_paid_ads))}
                </div>
              </Card>

            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
