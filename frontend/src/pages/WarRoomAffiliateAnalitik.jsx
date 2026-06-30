import { useState, useEffect, useCallback, useMemo } from 'react';
import Layout from '../components/Layout';
import { getAffiliateAnalytics, getAffiliateDownlines } from '../services/api';

const COLOR  = '#0891B2';
const COLOR2 = '#0E7490';
const GREEN  = '#059669';
const AMBER  = '#D97706';
const RED    = '#DC2626';
const BLUE   = '#2563EB';
const PURPLE = '#7C3AED';
const ORANGE = '#EA580C';
const TEAL   = '#0D9488';
const KOMISI_PER_QRIS = 20000;

const QRIS_COLOR = {
  'Terbit':         GREEN,
  'Belum Terbit':   AMBER,
  'Perbaikan Data': ORANGE,
  'Rejected':       RED,
  '-':              '#9CA3AF',
};

function fmtN(n)   { return Math.round(+(n ?? 0)).toLocaleString('id-ID'); }
function fmtRp(n)  { return 'Rp ' + Math.round(+(n ?? 0)).toLocaleString('id-ID'); }
function fmtPct(n) { return `${+(n ?? 0)}%`; }

function rateColor(r) { return r >= 70 ? GREEN : r >= 40 ? AMBER : RED; }

const TABS = [
  { id: 'ringkasan', label: 'Ringkasan',       icon: 'ti-chart-bar' },
  { id: 'tabel',     label: 'Tabel Upline',     icon: 'ti-table' },
  { id: 'qris',      label: 'Pipeline QRIS',    icon: 'ti-qrcode' },
  { id: 'trx',       label: 'Kontribusi TRX',   icon: 'ti-coin' },
  { id: 'komisi',    label: 'Estimasi Komisi',  icon: 'ti-receipt' },
  { id: 'cari',      label: 'Cari Downline',    icon: 'ti-search' },
];

/* KPI Card dengan background tinted */
function KPICard({ label, value, sub, icon = 'ti-chart-bar', accent = COLOR, small }) {
  return (
    <div className="wrfp-kpi-card" style={{
      borderLeft: `3px solid ${accent}`,
      background: `${accent}12`,
    }}>
      <div className="wrfp-kpi-label" style={{ color: accent }}>
        <i className={`ti ${icon}`} /> {label}
      </div>
      <div className={`wrfp-kpi-value${small ? ' wra-kpi-sm' : ''}`} style={{ color: accent }}>{value}</div>
      {sub && <div className="wrfp-kpi-sub">{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }) {
  const c = QRIS_COLOR[status] || '#9CA3AF';
  return (
    <span style={{ background: c + '1A', color: c, borderRadius: 5, padding: '2px 8px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', border: `1px solid ${c}40` }}>
      {status}
    </span>
  );
}

function FunnelBar({ label, val, pct, color }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
        <span style={{ fontWeight: 600, color: 'var(--text-2)' }}>{label}</span>
        <span style={{ fontWeight: 700, color }}>{fmtN(val)} <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>({fmtPct(pct)})</span></span>
      </div>
      <div style={{ height: 8, background: 'var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(+(pct||0), 100)}%`, height: '100%', background: color, borderRadius: 6, transition: 'width .5s ease' }} />
      </div>
    </div>
  );
}

export default function WarRoomAffiliateAnalitik() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [bulan,   setBulan]   = useState('');
  const [tab,     setTab]     = useState('ringkasan');

  const [sortKey, setSortKey] = useState('total_downline');
  const [sortDir, setSortDir] = useState('desc');
  const [komisiSort, setKomisiSort] = useState('komisi_estimasi');
  const [komisiDir,  setKomisiDir]  = useState('desc');

  const [search,          setSearch]          = useState('');
  const [selectedUpline,  setSelectedUpline]  = useState('');
  const [downlineData,    setDownlineData]    = useState(null);
  const [downlineLoading, setDownlineLoading] = useState(false);

  const fetchData = useCallback(async (b) => {
    setLoading(true); setError(null);
    try {
      const d = await getAffiliateAnalytics(b || undefined);
      setData(d);
      setBulan(d.bulan || '');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(''); }, [fetchData]);

  const fetchDownlines = useCallback(async (upline, bl) => {
    if (!upline) { setDownlineData(null); return; }
    setDownlineLoading(true);
    try { const d = await getAffiliateDownlines(upline, bl); setDownlineData(d); }
    catch (e) { console.error(e); }
    finally { setDownlineLoading(false); }
  }, []);

  const onBulanChange = (b) => { setBulan(b); fetchData(b); setDownlineData(null); setSelectedUpline(''); };

  const handleSelectUpline = (id) => { setSelectedUpline(id); fetchDownlines(id, bulan); };

  const s = data?.summary || {};

  /* Enrich uplines with estimasi komisi */
  const uplines = useMemo(() =>
    (data?.uplines || []).map(u => ({
      ...u,
      komisi_estimasi: u.qris_terbit * KOMISI_PER_QRIS,
    })),
  [data]);

  const sortedUplines = useMemo(() => {
    return [...uplines].sort((a, b) => {
      const va = a[sortKey] ?? 0, vb = b[sortKey] ?? 0;
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === 'asc' ? va - vb : vb - va;
    });
  }, [uplines, sortKey, sortDir]);

  const komisiSorted = useMemo(() =>
    [...uplines].sort((a, b) => {
      const va = a[komisiSort] ?? 0, vb = b[komisiSort] ?? 0;
      return komisiDir === 'asc' ? va - vb : vb - va;
    }),
  [uplines, komisiSort, komisiDir]);

  const onSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };
  const onKomisiSort = (key) => {
    if (komisiSort === key) setKomisiDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setKomisiSort(key); setKomisiDir('desc'); }
  };

  const top10     = useMemo(() => [...uplines].sort((a, b) => b.total_downline - a.total_downline).slice(0, 10), [uplines]);
  const qrisList  = useMemo(() => [...uplines].filter(u => u.sudah_aktivasi > 0).sort((a, b) => b.qris_belum_terbit - a.qris_belum_terbit), [uplines]);
  const trxList   = useMemo(() => [...uplines].sort((a, b) => b.total_trx - a.total_trx), [uplines]);

  const totalKomisiEstimasi = useMemo(() => uplines.reduce((s, u) => s + u.komisi_estimasi, 0), [uplines]);

  const filteredUplines = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return uplines;
    return uplines.filter(u =>
      u.id_upline?.toLowerCase().includes(q) ||
      (u.nama_pemilik && u.id_upline !== u.nama_pemilik && u.nama_pemilik.toLowerCase().includes(q))
    );
  }, [uplines, search]);

  /* Table helpers */
  const theadStyle = { background: `${COLOR}18`, borderBottom: `2px solid ${COLOR}40` };

  const makeTH = (onSortFn, activeSortKey, activeSortDir) => ({ label, k, right }) => {
    const active = k && activeSortKey === k;
    const ic = active ? (activeSortDir === 'asc' ? 'ti-sort-ascending' : 'ti-sort-descending') : 'ti-arrows-sort';
    return (
      <th onClick={k ? () => onSortFn(k) : undefined}
        style={{ padding: '9px 10px', textAlign: right ? 'right' : 'left', cursor: k ? 'pointer' : 'default',
          whiteSpace: 'nowrap', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.4px',
          color: active ? COLOR : 'var(--text-3)', userSelect: 'none' }}>
        {label}
        {k && <i className={`ti ${ic}`} style={{ fontSize: 10, marginLeft: 3, opacity: active ? 1 : .3 }} />}
      </th>
    );
  };

  const TH  = makeTH(onSort, sortKey, sortDir);
  const THK = makeTH(onKomisiSort, komisiSort, komisiDir);

  const tdL = { padding: '7px 10px' };
  const tdR = { padding: '7px 10px', textAlign: 'right' };
  const tdC = { padding: '7px 10px', textAlign: 'center' };
  const rowS = { borderBottom: '1px solid var(--border)' };

  return (
    <Layout>
      <div className="wrfp-page">

        {/* ── HEADER ────────────────────────────────────── */}
        <div style={{
          background: `linear-gradient(135deg, ${COLOR}18 0%, ${COLOR2}0A 100%)`,
          border: `1px solid ${COLOR}30`,
          borderRadius: 14, padding: '18px 22px', marginBottom: 20,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 46, height: 46, borderRadius: 12, background: `${COLOR}25`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="ti ti-users-group" style={{ color: COLOR, fontSize: 24 }} />
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-1)', letterSpacing: '-.3px' }}>
                WAR-ROOM <span style={{ color: COLOR }}>Affiliate Analitik</span> — InstaQris
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                {fmtN(s.total_upline)} upline aktif &nbsp;·&nbsp; {fmtN(s.total_downline)} total downline &nbsp;·&nbsp; estimasi komisi {fmtRp(totalKomisiEstimasi)}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {data?.bulan_list?.length > 0 && (
              <select value={bulan} onChange={e => onBulanChange(e.target.value)}
                style={{ background: 'var(--bg-card)', border: `1px solid ${COLOR}50`, color: 'var(--text-1)', borderRadius: 7, padding: '5px 12px', fontSize: 13, cursor: 'pointer' }}>
                {data.bulan_list.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            )}
            <span style={{ background: COLOR, color: '#fff', borderRadius: 20, padding: '5px 12px', fontSize: 12, fontWeight: 700 }}>AFFILIATE</span>
            {bulan && <span style={{ background: `${COLOR}20`, color: COLOR2, borderRadius: 20, padding: '5px 12px', fontSize: 12, fontWeight: 600, border: `1px solid ${COLOR}30` }}>{bulan}</span>}
          </div>
        </div>

        {/* ── TABS ──────────────────────────────────────── */}
        <div className="wrfp-tabs">
          {TABS.map(t => (
            <button key={t.id}
              className={`wrfp-tab${tab === t.id ? ' wrfp-tab--active' : ''}`}
              onClick={() => setTab(t.id)}
              style={tab === t.id ? { color: COLOR, borderBottomColor: COLOR } : {}}>
              <i className={`ti ${t.icon}`} /> {t.label}
            </button>
          ))}
        </div>

        {loading && <div className="wrfp-loading"><i className="ti ti-loader-2 wrfp-spin" /><div>Memuat data affiliate...</div></div>}
        {!loading && error && <div className="wrfp-error"><i className="ti ti-alert-circle" /><div>Error: {error}</div></div>}
        {!loading && !error && data?.empty && (
          <div className="wrfp-empty">
            <i className="ti ti-users-group" style={{ color: COLOR }} />
            <div>Belum ada data affiliate.</div>
          </div>
        )}

        {!loading && !error && data && !data.empty && (
          <div className="wrfp-tab-content">

            {/* ── RINGKASAN ───────────────────────────── */}
            {tab === 'ringkasan' && (
              <>
                {/* KPI Row 1 */}
                <div className="wra-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))' }}>
                  <KPICard icon="ti-users-group"  accent={COLOR}   label="Upline Aktif"     value={fmtN(s.total_upline)}    sub="yang punya downline" />
                  <KPICard icon="ti-user-plus"    accent="#6B7280" label="Total Downline"   value={fmtN(s.total_downline)}  sub="outlet terdaftar" />
                  <KPICard icon="ti-user-check"   accent={GREEN}   label="Sudah Aktivasi"  value={fmtN(s.sudah_aktivasi)}
                    sub={<span style={{ color: GREEN, fontWeight: 700 }}>{fmtPct(s.aktivasi_rate)} dari total</span>} />
                  <KPICard icon="ti-cash"         accent={PURPLE}  label="Sudah Transaksi" value={fmtN(s.dengan_trx)}
                    sub={<span style={{ color: PURPLE, fontWeight: 700 }}>{fmtPct(s.trx_rate)} dari aktivasi</span>} />
                  <KPICard icon="ti-qrcode"       accent={GREEN}   label="QRIS Terbit ✅"  value={fmtN(s.qris_terbit)}     sub="sudah terbit" />
                  <KPICard icon="ti-clock"        accent={AMBER}   label="QRIS Pending ⏳" value={fmtN((s.qris_belum_terbit||0)+(s.qris_perbaikan||0))}
                    sub={`${fmtN(s.qris_belum_terbit)} belum + ${fmtN(s.qris_perbaikan)} perbaikan`} />
                  <KPICard icon="ti-user-x"       accent={BLUE}    label="Reg Only"        value={fmtN(s.registrasi_only)}
                    sub={<span style={{ color: BLUE, fontWeight: 700 }}>{s.total_downline>0?fmtPct(+((s.registrasi_only/s.total_downline)*100).toFixed(1)):'0%'} belum aktivasi</span>} />
                  <KPICard icon="ti-receipt"      accent={TEAL}    label="Est. Komisi Total" value={fmtRp(totalKomisiEstimasi)} small
                    sub={`@Rp 20.000 × ${fmtN(s.qris_terbit)} QRIS terbit`} />
                </div>

                {/* Funnel */}
                <div className="wrfp-chart-card" style={{ border: `1px solid ${COLOR}30`, background: 'var(--bg-card)' }}>
                  <div className="wrfp-chart-title" style={{ color: COLOR }}>
                    <i className="ti ti-filter" /> Funnel Konversi Downline
                  </div>
                  <FunnelBar label="Total Downline"  val={s.total_downline} pct={100} color="#9CA3AF" />
                  <FunnelBar label="Sudah Aktivasi"  val={s.sudah_aktivasi} pct={s.aktivasi_rate} color={GREEN} />
                  <FunnelBar label="Sudah Transaksi" val={s.dengan_trx}     pct={s.total_downline>0?+((s.dengan_trx/s.total_downline)*100).toFixed(1):0} color={PURPLE} />
                  <FunnelBar label="QRIS Terbit"     val={s.qris_terbit}    pct={s.total_downline>0?+((s.qris_terbit/s.total_downline)*100).toFixed(1):0} color={COLOR} />
                </div>

                {/* Top 10 table */}
                <div className="wrfp-chart-card" style={{ marginBottom: 0, border: `1px solid ${COLOR}30` }}>
                  <div className="wrfp-chart-title" style={{ color: AMBER }}>
                    <i className="ti ti-trophy" /> Top 10 Upline — Terbanyak Downline
                  </div>
                  <div className="wrfp-table-wrap">
                    <table className="wrfp-table">
                      <thead style={theadStyle}>
                        <tr>
                          <TH label="#" />
                          <TH label="ID Upline" />
                          <TH label="Nama Upline" />
                          <TH label="Downline"    right />
                          <TH label="Aktivasi"    right />
                          <TH label="% Akt"       right />
                          <TH label="TRX"         right />
                          <TH label="QRIS Terbit" right />
                          <TH label="Est. Komisi" right />
                        </tr>
                      </thead>
                      <tbody>
                        {top10.map((u, i) => (
                          <tr key={u.id_upline} style={rowS}>
                            <td style={{ ...tdC, color: 'var(--text-4)', fontWeight: 700 }}>{i+1}</td>
                            <td style={{ ...tdL, fontFamily: 'monospace', color: COLOR, fontWeight: 700 }}>{u.id_upline}</td>
                            <td style={{ ...tdL, color: 'var(--text-2)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {u.id_upline !== u.nama_pemilik ? u.nama_pemilik : '—'}
                            </td>
                            <td style={{ ...tdR, fontWeight: 700 }}>{fmtN(u.total_downline)}</td>
                            <td style={{ ...tdR, color: GREEN, fontWeight: 700 }}>{fmtN(u.sudah_aktivasi)}</td>
                            <td style={tdR}><span style={{ color: rateColor(u.aktivasi_rate), fontWeight: 700 }}>{u.aktivasi_rate}%</span></td>
                            <td style={{ ...tdR, color: PURPLE, fontWeight: 600 }}>{fmtN(u.dengan_trx)}</td>
                            <td style={{ ...tdR, color: GREEN, fontWeight: 700 }}>{fmtN(u.qris_terbit)}</td>
                            <td style={{ ...tdR, color: TEAL, fontWeight: 700, whiteSpace: 'nowrap' }}>{fmtRp(u.komisi_estimasi)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            {/* ── TABEL UPLINE ──────────────────────── */}
            {tab === 'tabel' && (
              <div className="wrfp-chart-card" style={{ marginBottom: 0, padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px', borderBottom: `2px solid ${COLOR}30`, background: `${COLOR}0A`, fontWeight: 700, fontSize: 13, color: COLOR }}>
                  <i className="ti ti-table" /> Semua Upline ({fmtN(uplines.length)})
                </div>
                <div className="wrfp-table-wrap">
                  <table className="wrfp-table">
                    <thead style={theadStyle}>
                      <tr>
                        <TH label="ID Upline" k="id_upline" />
                        <TH label="Nama"      k="nama_pemilik" />
                        <TH label="Downline"      k="total_downline"    right />
                        <TH label="Reg Only"      k="registrasi_only"   right />
                        <TH label="Aktivasi"      k="sudah_aktivasi"    right />
                        <TH label="% Akt"         k="aktivasi_rate"     right />
                        <TH label="Dg TRX"        k="dengan_trx"        right />
                        <TH label="% TRX"         k="trx_rate"          right />
                        <TH label="Q Terbit"      k="qris_terbit"       right />
                        <TH label="Q Belum"       k="qris_belum_terbit" right />
                        <TH label="Q Perbaikan"   k="qris_perbaikan"    right />
                        <TH label="Total TRX"     k="total_trx"         right />
                        <TH label="Margin"        k="total_margin"      right />
                        <TH label="Est. Komisi"   k="komisi_estimasi"   right />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedUplines.map(u => (
                        <tr key={u.id_upline} style={rowS}>
                          <td style={{ ...tdL, fontFamily: 'monospace', color: COLOR, fontWeight: 700, whiteSpace: 'nowrap' }}>{u.id_upline}</td>
                          <td style={{ ...tdL, color: 'var(--text-2)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {u.id_upline !== u.nama_pemilik ? u.nama_pemilik : '—'}
                          </td>
                          <td style={{ ...tdR, fontWeight: 700 }}>{fmtN(u.total_downline)}</td>
                          <td style={{ ...tdR, color: BLUE }}>{fmtN(u.registrasi_only)}</td>
                          <td style={{ ...tdR, color: GREEN, fontWeight: 700 }}>{fmtN(u.sudah_aktivasi)}</td>
                          <td style={tdR}><span style={{ color: rateColor(u.aktivasi_rate), fontWeight: 700 }}>{u.aktivasi_rate}%</span></td>
                          <td style={{ ...tdR, color: PURPLE, fontWeight: 600 }}>{fmtN(u.dengan_trx)}</td>
                          <td style={tdR}><span style={{ color: rateColor(u.trx_rate), fontWeight: 600 }}>{u.trx_rate}%</span></td>
                          <td style={{ ...tdR, color: GREEN, fontWeight: 700 }}>{fmtN(u.qris_terbit)}</td>
                          <td style={{ ...tdR, color: AMBER, fontWeight: u.qris_belum_terbit > 0 ? 700 : 400 }}>{fmtN(u.qris_belum_terbit)}</td>
                          <td style={{ ...tdR, color: ORANGE }}>{fmtN(u.qris_perbaikan)}</td>
                          <td style={{ ...tdR, fontWeight: u.total_trx > 0 ? 700 : 400, color: u.total_trx > 0 ? 'var(--text-1)' : 'var(--text-4)' }}>{fmtN(u.total_trx)}</td>
                          <td style={{ ...tdR, color: GREEN, whiteSpace: 'nowrap' }}>{u.total_margin > 0 ? fmtRp(u.total_margin) : '—'}</td>
                          <td style={{ ...tdR, color: TEAL, fontWeight: 700, whiteSpace: 'nowrap' }}>{u.komisi_estimasi > 0 ? fmtRp(u.komisi_estimasi) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── PIPELINE QRIS ─────────────────────── */}
            {tab === 'qris' && (
              <div className="wrfp-chart-card" style={{ marginBottom: 0, padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px', borderBottom: `2px solid ${AMBER}40`, background: `${AMBER}0A`, fontWeight: 700, fontSize: 13, color: AMBER }}>
                  <i className="ti ti-qrcode" /> Pipeline QRIS — diurutkan berdasarkan Belum Terbit terbanyak
                </div>
                <div className="wrfp-table-wrap">
                  <table className="wrfp-table">
                    <thead style={{ background: `${AMBER}12`, borderBottom: `2px solid ${AMBER}30` }}>
                      <tr>
                        <TH label="#" />
                        <TH label="ID Upline" />
                        <TH label="Nama" />
                        <TH label="Belum Terbit" right />
                        <TH label="Perbaikan"    right />
                        <TH label="Terbit"       right />
                        <TH label="Rejected"     right />
                        <TH label="Total QRIS"   right />
                        <TH label="% Terbit"     right />
                        <TH label="Est. Komisi"  right />
                      </tr>
                    </thead>
                    <tbody>
                      {qrisList.map((u, i) => {
                        const total    = u.qris_terbit + u.qris_belum_terbit + u.qris_perbaikan + u.qris_rejected;
                        const pct      = total > 0 ? +((u.qris_terbit / total) * 100).toFixed(1) : 0;
                        return (
                          <tr key={u.id_upline} style={rowS}>
                            <td style={{ ...tdC, color: 'var(--text-4)', fontWeight: 700 }}>{i+1}</td>
                            <td style={{ ...tdL, fontFamily: 'monospace', color: COLOR, fontWeight: 700 }}>{u.id_upline}</td>
                            <td style={{ ...tdL, color: 'var(--text-2)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {u.id_upline !== u.nama_pemilik ? u.nama_pemilik : '—'}
                            </td>
                            <td style={{ ...tdR, color: u.qris_belum_terbit > 0 ? AMBER : 'var(--text-4)', fontWeight: u.qris_belum_terbit > 0 ? 800 : 400 }}>{fmtN(u.qris_belum_terbit)}</td>
                            <td style={{ ...tdR, color: ORANGE }}>{fmtN(u.qris_perbaikan)}</td>
                            <td style={{ ...tdR, color: GREEN, fontWeight: 700 }}>{fmtN(u.qris_terbit)}</td>
                            <td style={{ ...tdR, color: RED }}>{fmtN(u.qris_rejected)}</td>
                            <td style={{ ...tdR, fontWeight: 700 }}>{fmtN(total)}</td>
                            <td style={tdR}><span style={{ color: rateColor(pct), fontWeight: 700 }}>{pct}%</span></td>
                            <td style={{ ...tdR, color: TEAL, fontWeight: 700, whiteSpace: 'nowrap' }}>{u.komisi_estimasi > 0 ? fmtRp(u.komisi_estimasi) : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── KONTRIBUSI TRX ────────────────────── */}
            {tab === 'trx' && (
              <div className="wrfp-chart-card" style={{ marginBottom: 0, padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px', borderBottom: `2px solid ${PURPLE}40`, background: `${PURPLE}0A`, fontWeight: 700, fontSize: 13, color: PURPLE }}>
                  <i className="ti ti-coin" /> Kontribusi Transaksi &amp; Margin — bulan {bulan}
                </div>
                <div className="wrfp-table-wrap">
                  <table className="wrfp-table">
                    <thead style={{ background: `${PURPLE}10`, borderBottom: `2px solid ${PURPLE}25` }}>
                      <tr>
                        <TH label="#" />
                        <TH label="ID Upline" />
                        <TH label="Nama" />
                        <TH label="Total TRX"     k="total_trx"    right />
                        <TH label="Margin"         k="total_margin" right />
                        <TH label="Omzet"          k="total_omzet"  right />
                        <TH label="Dg TRX"         k="dengan_trx"   right />
                        <TH label="Downline"       k="total_downline" right />
                        <TH label="Avg TRX/Outlet" right />
                      </tr>
                    </thead>
                    <tbody>
                      {trxList.map((u, i) => {
                        const avg = u.dengan_trx > 0 ? Math.round(u.total_trx / u.dengan_trx) : 0;
                        return (
                          <tr key={u.id_upline} style={rowS}>
                            <td style={{ ...tdC, color: 'var(--text-4)', fontWeight: 700 }}>{i+1}</td>
                            <td style={{ ...tdL, fontFamily: 'monospace', color: COLOR, fontWeight: 700 }}>{u.id_upline}</td>
                            <td style={{ ...tdL, color: 'var(--text-2)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {u.id_upline !== u.nama_pemilik ? u.nama_pemilik : '—'}
                            </td>
                            <td style={{ ...tdR, fontWeight: u.total_trx > 0 ? 800 : 400, color: u.total_trx > 0 ? 'var(--text-1)' : 'var(--text-4)' }}>{fmtN(u.total_trx)}</td>
                            <td style={{ ...tdR, color: GREEN, fontWeight: 700, whiteSpace: 'nowrap' }}>{u.total_margin > 0 ? fmtRp(u.total_margin) : '—'}</td>
                            <td style={{ ...tdR, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{u.total_omzet > 0 ? fmtRp(u.total_omzet) : '—'}</td>
                            <td style={{ ...tdR, color: PURPLE, fontWeight: 600 }}>{fmtN(u.dengan_trx)}</td>
                            <td style={tdR}>{fmtN(u.total_downline)}</td>
                            <td style={{ ...tdR, color: 'var(--text-3)' }}>{u.total_trx > 0 ? fmtN(avg) : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── ESTIMASI KOMISI ───────────────────── */}
            {tab === 'komisi' && (
              <>
                {/* Komisi summary */}
                <div style={{ background: `linear-gradient(135deg, ${TEAL}20, ${GREEN}0E)`, border: `1px solid ${TEAL}40`, borderRadius: 12, padding: '16px 20px', marginBottom: 16 }}>
                  <div style={{ fontWeight: 800, fontSize: 13, color: TEAL, marginBottom: 12 }}>
                    <i className="ti ti-receipt" /> Formula: Rp 20.000 × jumlah downline yang QRIS-nya sudah Terbit
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12 }}>
                    <KPICard icon="ti-users-group"  accent={COLOR}   label="Total Upline"    value={fmtN(s.total_upline)} sub="punya komisi" />
                    <KPICard icon="ti-qrcode"       accent={GREEN}   label="Total QRIS Terbit" value={fmtN(s.qris_terbit)} sub="semua downline" />
                    <KPICard icon="ti-receipt"      accent={TEAL}    label="Total Est. Komisi" value={fmtRp(totalKomisiEstimasi)} small sub={`${fmtN(s.qris_terbit)} × Rp 20.000`} />
                    <KPICard icon="ti-coin"         accent={AMBER}   label="Rata-rata / Upline" value={fmtRp(s.total_upline > 0 ? Math.round(totalKomisiEstimasi / s.total_upline) : 0)} small sub="estimasi per upline" />
                  </div>
                </div>

                <div className="wrfp-chart-card" style={{ marginBottom: 0, padding: 0, overflow: 'hidden' }}>
                  <div style={{ padding: '14px 16px', borderBottom: `2px solid ${TEAL}40`, background: `${TEAL}0A`, fontWeight: 700, fontSize: 13, color: TEAL }}>
                    <i className="ti ti-receipt" /> Estimasi Komisi per Upline (sort: klik header)
                  </div>
                  <div className="wrfp-table-wrap">
                    <table className="wrfp-table">
                      <thead style={{ background: `${TEAL}12`, borderBottom: `2px solid ${TEAL}30` }}>
                        <tr>
                          <THK label="#" />
                          <THK label="ID Upline"       k="id_upline" />
                          <THK label="Nama Upline"     k="nama_pemilik" />
                          <THK label="QRIS Terbit"     k="qris_terbit"       right />
                          <THK label="Est. Komisi"     k="komisi_estimasi"   right />
                          <THK label="Total Downline"  k="total_downline"    right />
                          <THK label="% Terbit"        k="aktivasi_rate"     right />
                        </tr>
                      </thead>
                      <tbody>
                        {komisiSorted.map((u, i) => (
                          <tr key={u.id_upline} style={rowS}>
                            <td style={{ ...tdC, color: 'var(--text-4)', fontWeight: 700 }}>{i+1}</td>
                            <td style={{ ...tdL, fontFamily: 'monospace', color: COLOR, fontWeight: 700 }}>{u.id_upline}</td>
                            <td style={{ ...tdL, color: 'var(--text-2)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {u.id_upline !== u.nama_pemilik ? u.nama_pemilik : '—'}
                            </td>
                            <td style={{ ...tdR, color: GREEN, fontWeight: 700 }}>{fmtN(u.qris_terbit)}</td>
                            <td style={{ ...tdR, color: TEAL, fontWeight: 800, fontSize: 13, whiteSpace: 'nowrap' }}>
                              {u.komisi_estimasi > 0 ? fmtRp(u.komisi_estimasi) : '—'}
                            </td>
                            <td style={tdR}>{fmtN(u.total_downline)}</td>
                            <td style={tdR}>
                              {(() => {
                                const total = u.qris_terbit + u.qris_belum_terbit + u.qris_perbaikan + u.qris_rejected;
                                const pct = total > 0 ? +((u.qris_terbit / total) * 100).toFixed(1) : 0;
                                return <span style={{ color: rateColor(pct), fontWeight: 700 }}>{pct}%</span>;
                              })()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            {/* ── CARI DOWNLINE ─────────────────────── */}
            {tab === 'cari' && (
              <>
                <div className="wrfp-chart-card" style={{ border: `1px solid ${COLOR}30` }}>
                  <div className="wrfp-chart-title" style={{ color: COLOR }}>
                    <i className="ti ti-search" /> Pilih Upline untuk Melihat Downline
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input type="text" placeholder="Cari ID / Nama upline..." value={search}
                      onChange={e => setSearch(e.target.value)}
                      style={{ background: 'var(--bg-page)', border: `1px solid ${COLOR}40`, color: 'var(--text-1)', borderRadius: 7, padding: '7px 12px', fontSize: 13, width: 240 }} />
                    <select value={selectedUpline} onChange={e => handleSelectUpline(e.target.value)}
                      style={{ background: 'var(--bg-page)', border: `1px solid ${COLOR}40`, color: 'var(--text-1)', borderRadius: 7, padding: '7px 12px', fontSize: 13, minWidth: 300 }}>
                      <option value="">— Pilih Upline —</option>
                      {filteredUplines.map(u => (
                        <option key={u.id_upline} value={u.id_upline}>
                          {u.id_upline}{u.id_upline !== u.nama_pemilik ? ` — ${u.nama_pemilik}` : ''} ({fmtN(u.total_downline)} downline)
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {!selectedUpline && (
                  <div className="wrfp-empty">
                    <i className="ti ti-search" style={{ color: 'var(--text-4)' }} />
                    <div>Pilih upline untuk melihat daftar downline-nya.</div>
                  </div>
                )}

                {downlineLoading && <div className="wrfp-loading"><i className="ti ti-loader-2 wrfp-spin" /><div>Memuat downline...</div></div>}

                {!downlineLoading && downlineData && selectedUpline && (() => {
                  const u = uplines.find(x => x.id_upline === selectedUpline);
                  return (
                    <>
                      {u && (
                        <div className="wra-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', marginBottom: 14 }}>
                          <KPICard icon="ti-users"      accent={COLOR}   label="Total Downline"  value={fmtN(u.total_downline)} />
                          <KPICard icon="ti-user-check" accent={GREEN}   label="Aktivasi"        value={fmtN(u.sudah_aktivasi)}  sub={`${u.aktivasi_rate}% dari total`} />
                          <KPICard icon="ti-cash"       accent={PURPLE}  label="Dg Transaksi"    value={fmtN(u.dengan_trx)}      sub={`${u.trx_rate}% dari aktivasi`} />
                          <KPICard icon="ti-qrcode"     accent={GREEN}   label="QRIS Terbit ✅"  value={fmtN(u.qris_terbit)} />
                          <KPICard icon="ti-clock"      accent={AMBER}   label="QRIS Belum ⏳"   value={fmtN(u.qris_belum_terbit)} />
                          <KPICard icon="ti-receipt"    accent={TEAL}    label="Est. Komisi"     value={fmtRp(u.komisi_estimasi)} small sub={`${fmtN(u.qris_terbit)} × Rp 20.000`} />
                        </div>
                      )}

                      <div className="wrfp-chart-card" style={{ marginBottom: 0, padding: 0, overflow: 'hidden' }}>
                        <div style={{ padding: '12px 16px', borderBottom: `2px solid ${COLOR}30`, background: `${COLOR}0A`, fontWeight: 700, fontSize: 13, color: COLOR }}>
                          {fmtN(downlineData.downlines?.length)} Downline dari Upline {selectedUpline}
                          {u && u.komisi_estimasi > 0 && (
                            <span style={{ marginLeft: 12, color: TEAL, fontSize: 12 }}>· Est. Komisi: {fmtRp(u.komisi_estimasi)}</span>
                          )}
                        </div>
                        <div className="wrfp-table-wrap">
                          <table className="wrfp-table">
                            <thead style={theadStyle}>
                              <tr>
                                <TH label="ID Outlet" />
                                <TH label="Nama Merchant" />
                                <TH label="Kota" />
                                <TH label="Paket" />
                                <TH label="Tgl Reg" />
                                <TH label="Tgl Aktivasi" />
                                <TH label="Status QRIS" />
                                <TH label="Total TRX"  right />
                                <TH label="Margin"     right />
                              </tr>
                            </thead>
                            <tbody>
                              {(downlineData.downlines || []).map(d => (
                                <tr key={d.id_outlet} style={rowS}>
                                  <td style={{ ...tdL, fontFamily: 'monospace', color: COLOR, fontWeight: 700, whiteSpace: 'nowrap' }}>{d.id_outlet}</td>
                                  <td style={{ ...tdL, color: 'var(--text-2)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.nama_merchant || '—'}</td>
                                  <td style={{ ...tdL, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{d.kota || '—'}</td>
                                  <td style={{ ...tdL, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{d.nama_paket || '—'}</td>
                                  <td style={{ ...tdL, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{d.tgl_reg || '—'}</td>
                                  <td style={{ ...tdL, color: d.tgl_akt ? GREEN : 'var(--text-4)', fontWeight: d.tgl_akt ? 600 : 400, whiteSpace: 'nowrap' }}>{d.tgl_akt || '—'}</td>
                                  <td style={tdL}><StatusBadge status={d.qris_status} /></td>
                                  <td style={{ ...tdR, fontWeight: d.total_trx > 0 ? 700 : 400, color: d.total_trx > 0 ? 'var(--text-1)' : 'var(--text-4)' }}>{fmtN(d.total_trx)}</td>
                                  <td style={{ ...tdR, color: d.total_margin > 0 ? GREEN : 'var(--text-4)', whiteSpace: 'nowrap' }}>{d.total_margin > 0 ? fmtRp(d.total_margin) : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </>
            )}

          </div>
        )}
      </div>
    </Layout>
  );
}
