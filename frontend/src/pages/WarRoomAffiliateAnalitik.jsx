import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getAffiliateAnalytics, getAffiliateDownlines } from '../services/api';

const COLOR  = '#0891B2';
const GREEN  = '#10B981';
const AMBER  = '#F59E0B';
const RED    = '#EF4444';
const BLUE   = '#3B82F6';
const PURPLE = '#8B5CF6';
const ORANGE = '#F97316';

const QRIS_COLOR = {
  'Terbit':          GREEN,
  'Belum Terbit':    AMBER,
  'Perbaikan Data':  ORANGE,
  'Rejected':        RED,
  '-':               '#6B7280',
};

function fmtNum(n) { return Math.round(+(n ?? 0)).toLocaleString('id-ID'); }
function fmtRp(n)  { return 'Rp ' + Math.round(+(n ?? 0)).toLocaleString('id-ID'); }
function fmtPct(n) { return `${+(n ?? 0)}%`; }

function KPICard({ label, value, color, sub }) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || 'var(--text-1)', lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }) {
  const c = QRIS_COLOR[status] || '#6B7280';
  return (
    <span style={{ background: c + '22', color: c, borderRadius: 5, padding: '2px 8px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {status}
    </span>
  );
}

export default function WarRoomAffiliateAnalitik() {
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [bulan, setBulan]         = useState('');
  const [activeTab, setActiveTab] = useState('ringkasan');

  const [sortKey, setSortKey] = useState('total_downline');
  const [sortDir, setSortDir] = useState('desc');

  const [selectedUpline,   setSelectedUpline]   = useState('');
  const [downlineSearch,   setDownlineSearch]   = useState('');
  const [downlineData,     setDownlineData]     = useState(null);
  const [downlineLoading,  setDownlineLoading]  = useState(false);

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
    try {
      const d = await getAffiliateDownlines(upline, bl);
      setDownlineData(d);
    } catch (e) { console.error(e); setDownlineData(null); }
    finally { setDownlineLoading(false); }
  }, []);

  const handleBulanChange = (b) => { setBulan(b); fetchData(b); };

  const handleUplineSelect = (id) => {
    setSelectedUpline(id);
    fetchDownlines(id, bulan);
  };

  const s       = data?.summary;
  const uplines = useMemo(() => data?.uplines || [], [data]);

  const sortedUplines = useMemo(() => {
    return [...uplines].sort((a, b) => {
      const va = a[sortKey] ?? 0, vb = b[sortKey] ?? 0;
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === 'asc' ? va - vb : vb - va;
    });
  }, [uplines, sortKey, sortDir]);

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const top10Downline = useMemo(() => [...uplines].sort((a, b) => b.total_downline - a.total_downline).slice(0, 10), [uplines]);
  const qrisSorted    = useMemo(() => [...uplines].filter(u => u.sudah_aktivasi > 0).sort((a, b) => b.qris_belum_terbit - a.qris_belum_terbit), [uplines]);
  const trxSorted     = useMemo(() => [...uplines].sort((a, b) => b.total_trx - a.total_trx), [uplines]);

  const filteredUplines = useMemo(() => {
    const q = downlineSearch.toLowerCase().trim();
    if (!q) return uplines;
    return uplines.filter(u =>
      u.id_upline?.toLowerCase().includes(q) ||
      (u.nama_pemilik && u.id_upline !== u.nama_pemilik && u.nama_pemilik.toLowerCase().includes(q))
    );
  }, [uplines, downlineSearch]);

  const TABS = [
    { key: 'ringkasan', label: 'Ringkasan' },
    { key: 'tabel',     label: 'Tabel Upline' },
    { key: 'qris',      label: 'Pipeline QRIS' },
    { key: 'trx',       label: 'Kontribusi TRX' },
    { key: 'cari',      label: 'Cari Downline' },
  ];

  const SortChev = ({ k }) => {
    if (sortKey !== k) return <i className="ti ti-arrows-sort" style={{ opacity: .3, marginLeft: 3, fontSize: 10 }} />;
    return <i className={`ti ti-sort-${sortDir === 'asc' ? 'ascending' : 'descending'}`} style={{ marginLeft: 3, fontSize: 10, color: COLOR }} />;
  };

  const thStyle = (k) => ({
    padding: '8px 10px', textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap',
    color: 'var(--text-3)', fontWeight: 600, userSelect: 'none', fontSize: 11,
    background: 'var(--bg-page)', borderBottom: '1px solid var(--border)',
  });
  const tdR = { padding: '6px 10px', textAlign: 'right' };
  const tdL = { padding: '6px 10px' };

  const rowStyle = { borderBottom: '1px solid var(--border)', cursor: 'default' };

  return (
    <div className="main-content">
      {/* Header */}
      <div className="wr-header" style={{ borderLeft: `4px solid ${COLOR}` }}>
        <div className="wr-header-left">
          <span className="wr-badge" style={{ background: COLOR + '22', color: COLOR }}>AFFILIATE</span>
          <h1 className="wr-title">Affiliate Analitik — InstaQris</h1>
        </div>
        {data?.bulan_list?.length > 0 && (
          <select value={bulan} onChange={e => handleBulanChange(e.target.value)}
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-1)', borderRadius: 7, padding: '6px 12px', fontSize: 13 }}>
            {data.bulan_list.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        )}
      </div>

      {loading && <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-3)' }}>Memuat data affiliate...</div>}
      {error   && <div style={{ padding: 20, color: RED, fontWeight: 600 }}>Error: {error}</div>}

      {!loading && data && !data.empty && (
        <>
          {/* Tab Nav */}
          <div className="wrd-tab-nav" style={{ margin: '16px 0 0' }}>
            {TABS.map(t => (
              <button key={t.key}
                className={`wrd-tab-btn${activeTab === t.key ? ' active' : ''}`}
                onClick={() => setActiveTab(t.key)}
                style={{ '--tab-color': COLOR }}>
                {t.label}
              </button>
            ))}
          </div>

          {/* ── RINGKASAN ─────────────────────────────────────────────── */}
          {activeTab === 'ringkasan' && (
            <div style={{ marginTop: 16 }}>
              {/* KPI */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 20 }}>
                <KPICard label="Upline Aktif"      value={fmtNum(s?.total_upline)}    color={COLOR}  sub="yang punya downline" />
                <KPICard label="Total Downline"    value={fmtNum(s?.total_downline)}  color="var(--text-1)" sub="seluruh outlet terdaftar" />
                <KPICard label="Hanya Registrasi"  value={fmtNum(s?.registrasi_only)} color={BLUE}
                  sub={<span style={{ color: BLUE }}>{fmtPct(s?.total_downline > 0 ? +((s.registrasi_only/s.total_downline)*100).toFixed(1) : 0)} belum aktivasi</span>} />
                <KPICard label="Sudah Aktivasi"    value={fmtNum(s?.sudah_aktivasi)}  color={GREEN}
                  sub={<span style={{ color: GREEN }}>{fmtPct(s?.aktivasi_rate)} dari total</span>} />
                <KPICard label="Sudah Transaksi"   value={fmtNum(s?.dengan_trx)}      color={PURPLE}
                  sub={<span style={{ color: PURPLE }}>{fmtPct(s?.trx_rate)} dari aktivasi</span>} />
                <KPICard label="QRIS Terbit ✅"    value={fmtNum(s?.qris_terbit)}     color={GREEN} />
                <KPICard label="QRIS Pending ⏳"   value={fmtNum((s?.qris_belum_terbit||0)+(s?.qris_perbaikan||0))} color={AMBER}
                  sub={`${fmtNum(s?.qris_belum_terbit)} belum + ${fmtNum(s?.qris_perbaikan)} perbaikan`} />
                <KPICard label="Total TRX"         value={fmtNum(s?.total_trx)}       color="var(--text-1)"
                  sub={`margin ${fmtRp(s?.total_margin)}`} />
              </div>

              {/* Funnel */}
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 20, marginBottom: 20 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>Funnel Konversi Downline</div>
                {[
                  { label: 'Total Downline',   val: s?.total_downline, color: 'var(--text-3)', pct: 100 },
                  { label: 'Sudah Aktivasi',   val: s?.sudah_aktivasi,  color: GREEN,  pct: s?.aktivasi_rate },
                  { label: 'Sudah Transaksi',  val: s?.dengan_trx,      color: PURPLE, pct: s?.total_downline > 0 ? +((s.dengan_trx/s.total_downline)*100).toFixed(1) : 0 },
                  { label: 'QRIS Terbit',      val: s?.qris_terbit,     color: COLOR,  pct: s?.total_downline > 0 ? +((s.qris_terbit/s.total_downline)*100).toFixed(1) : 0 },
                ].map(f => (
                  <div key={f.label} style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-2)', marginBottom: 4 }}>
                      <span style={{ fontWeight: 600 }}>{f.label}</span>
                      <span>{fmtNum(f.val)} <span style={{ color: f.color, fontWeight: 700 }}>({fmtPct(f.pct)})</span></span>
                    </div>
                    <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${Math.min(+(f.pct||0), 100)}%`, height: '100%', background: f.color, borderRadius: 4, transition: 'width .4s' }} />
                    </div>
                  </div>
                ))}
              </div>

              {/* Top 10 Upline */}
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 14 }}>
                  Top 10 Upline — Terbanyak Downline
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>
                        {['#','ID Upline','Nama','Downline','Aktivasi','% Akt','TRX','QRIS Terbit','QRIS Belum'].map(h => (
                          <th key={h} style={{ ...thStyle(), textAlign: h==='#'?'center':'left', cursor:'default' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {top10Downline.map((u, i) => (
                        <tr key={u.id_upline} style={rowStyle}>
                          <td style={{ ...tdL, textAlign: 'center', color: 'var(--text-3)', fontWeight: 600 }}>{i+1}</td>
                          <td style={{ ...tdL, fontFamily: 'monospace', color: COLOR, fontWeight: 600 }}>{u.id_upline}</td>
                          <td style={{ ...tdL, color: 'var(--text-2)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {u.id_upline !== u.nama_pemilik ? u.nama_pemilik : '—'}
                          </td>
                          <td style={{ ...tdR, fontWeight: 700 }}>{fmtNum(u.total_downline)}</td>
                          <td style={{ ...tdR, color: GREEN, fontWeight: 600 }}>{fmtNum(u.sudah_aktivasi)}</td>
                          <td style={tdR}>
                            <span style={{ color: u.aktivasi_rate>=70?GREEN:u.aktivasi_rate>=40?AMBER:RED, fontWeight:600 }}>{u.aktivasi_rate}%</span>
                          </td>
                          <td style={{ ...tdR, color: PURPLE, fontWeight: 600 }}>{fmtNum(u.dengan_trx)}</td>
                          <td style={{ ...tdR, color: GREEN }}>{fmtNum(u.qris_terbit)}</td>
                          <td style={{ ...tdR, color: AMBER, fontWeight: u.qris_belum_terbit>0?700:400 }}>{fmtNum(u.qris_belum_terbit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── TABEL UPLINE ─────────────────────────────────────────── */}
          {activeTab === 'tabel' && (
            <div style={{ marginTop: 16, overflowX: 'auto' }}>
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      {[
                        { k:'id_upline',          l:'ID Upline' },
                        { k:'nama_pemilik',        l:'Nama' },
                        { k:'total_downline',      l:'Downline' },
                        { k:'registrasi_only',     l:'Reg Only' },
                        { k:'sudah_aktivasi',      l:'Aktivasi' },
                        { k:'aktivasi_rate',       l:'% Akt' },
                        { k:'dengan_trx',          l:'Dg TRX' },
                        { k:'trx_rate',            l:'% TRX' },
                        { k:'qris_terbit',         l:'Q Terbit' },
                        { k:'qris_belum_terbit',   l:'Q Belum' },
                        { k:'qris_perbaikan',      l:'Q Perbaikan' },
                        { k:'total_trx',           l:'Total TRX' },
                        { k:'total_margin',        l:'Margin' },
                        { k:'komisi',              l:'Komisi' },
                      ].map(col => (
                        <th key={col.k} onClick={() => handleSort(col.k)} style={thStyle(col.k)}>
                          {col.l}<SortChev k={col.k} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedUplines.map(u => (
                      <tr key={u.id_upline} style={rowStyle}>
                        <td style={{ ...tdL, fontFamily:'monospace', color:COLOR, fontWeight:600, whiteSpace:'nowrap' }}>{u.id_upline}</td>
                        <td style={{ ...tdL, color:'var(--text-2)', maxWidth:140, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {u.id_upline !== u.nama_pemilik ? u.nama_pemilik : '—'}
                        </td>
                        <td style={{ ...tdR, fontWeight:700 }}>{fmtNum(u.total_downline)}</td>
                        <td style={{ ...tdR, color:BLUE }}>{fmtNum(u.registrasi_only)}</td>
                        <td style={{ ...tdR, color:GREEN, fontWeight:600 }}>{fmtNum(u.sudah_aktivasi)}</td>
                        <td style={tdR}><span style={{ color:u.aktivasi_rate>=70?GREEN:u.aktivasi_rate>=40?AMBER:RED, fontWeight:600 }}>{u.aktivasi_rate}%</span></td>
                        <td style={{ ...tdR, color:PURPLE, fontWeight:600 }}>{fmtNum(u.dengan_trx)}</td>
                        <td style={tdR}><span style={{ color:u.trx_rate>=60?GREEN:u.trx_rate>=30?AMBER:RED, fontWeight:600 }}>{u.trx_rate}%</span></td>
                        <td style={{ ...tdR, color:GREEN }}>{fmtNum(u.qris_terbit)}</td>
                        <td style={{ ...tdR, color:AMBER, fontWeight:u.qris_belum_terbit>0?700:400 }}>{fmtNum(u.qris_belum_terbit)}</td>
                        <td style={{ ...tdR, color:ORANGE }}>{fmtNum(u.qris_perbaikan)}</td>
                        <td style={{ ...tdR, fontWeight:u.total_trx>0?600:400, color:u.total_trx>0?'var(--text-1)':'var(--text-4)' }}>{fmtNum(u.total_trx)}</td>
                        <td style={{ ...tdR, color:GREEN, whiteSpace:'nowrap' }}>{u.total_margin>0?fmtRp(u.total_margin):'—'}</td>
                        <td style={{ ...tdR, whiteSpace:'nowrap', color:'var(--text-3)' }}>{u.komisi>0?fmtRp(u.komisi):'—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── PIPELINE QRIS ─────────────────────────────────────────── */}
          {activeTab === 'qris' && (
            <div style={{ marginTop: 16 }}>
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 14 }}>
                  Upline diurutkan berdasarkan QRIS Belum Terbit terbanyak
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>
                        {['#','ID Upline','Nama','Belum Terbit','Perbaikan','Terbit','Rejected','Total QRIS','% Terbit'].map(h => (
                          <th key={h} style={{ ...thStyle(), cursor:'default', textAlign:h==='#'?'center':'left' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {qrisSorted.map((u, i) => {
                        const total = u.qris_terbit + u.qris_belum_terbit + u.qris_perbaikan + u.qris_rejected;
                        const pctTerbit = total > 0 ? +((u.qris_terbit / total) * 100).toFixed(1) : 0;
                        return (
                          <tr key={u.id_upline} style={rowStyle}>
                            <td style={{ ...tdL, textAlign:'center', color:'var(--text-3)', fontWeight:600 }}>{i+1}</td>
                            <td style={{ ...tdL, fontFamily:'monospace', color:COLOR, fontWeight:600 }}>{u.id_upline}</td>
                            <td style={{ ...tdL, color:'var(--text-2)', maxWidth:130, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {u.id_upline !== u.nama_pemilik ? u.nama_pemilik : '—'}
                            </td>
                            <td style={{ ...tdR, color:AMBER, fontWeight:u.qris_belum_terbit>0?700:400 }}>{fmtNum(u.qris_belum_terbit)}</td>
                            <td style={{ ...tdR, color:ORANGE }}>{fmtNum(u.qris_perbaikan)}</td>
                            <td style={{ ...tdR, color:GREEN, fontWeight:600 }}>{fmtNum(u.qris_terbit)}</td>
                            <td style={{ ...tdR, color:RED }}>{fmtNum(u.qris_rejected)}</td>
                            <td style={{ ...tdR, fontWeight:600 }}>{fmtNum(total)}</td>
                            <td style={tdR}>
                              <span style={{ color:pctTerbit>=80?GREEN:pctTerbit>=50?AMBER:RED, fontWeight:600 }}>{pctTerbit}%</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── KONTRIBUSI TRX ────────────────────────────────────────── */}
          {activeTab === 'trx' && (
            <div style={{ marginTop: 16 }}>
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 14 }}>
                  Kontribusi Transaksi &amp; Margin per Upline — bulan {bulan}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>
                        {['#','ID Upline','Nama','Total TRX','Margin','Omzet','Dg TRX','Total Downline','Avg TRX/Outlet'].map(h => (
                          <th key={h} style={{ ...thStyle(), cursor:'default', textAlign:h==='#'?'center':'left' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {trxSorted.map((u, i) => {
                        const avgTrx = u.dengan_trx > 0 ? Math.round(u.total_trx / u.dengan_trx) : 0;
                        return (
                          <tr key={u.id_upline} style={rowStyle}>
                            <td style={{ ...tdL, textAlign:'center', color:'var(--text-3)' }}>{i+1}</td>
                            <td style={{ ...tdL, fontFamily:'monospace', color:COLOR, fontWeight:600 }}>{u.id_upline}</td>
                            <td style={{ ...tdL, color:'var(--text-2)', maxWidth:130, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {u.id_upline !== u.nama_pemilik ? u.nama_pemilik : '—'}
                            </td>
                            <td style={{ ...tdR, fontWeight:700, color:u.total_trx>0?'var(--text-1)':'var(--text-4)' }}>{fmtNum(u.total_trx)}</td>
                            <td style={{ ...tdR, color:GREEN, fontWeight:600, whiteSpace:'nowrap' }}>{u.total_margin>0?fmtRp(u.total_margin):'—'}</td>
                            <td style={{ ...tdR, color:'var(--text-3)', whiteSpace:'nowrap' }}>{u.total_omzet>0?fmtRp(u.total_omzet):'—'}</td>
                            <td style={{ ...tdR, color:PURPLE, fontWeight:600 }}>{fmtNum(u.dengan_trx)}</td>
                            <td style={tdR}>{fmtNum(u.total_downline)}</td>
                            <td style={{ ...tdR, color:'var(--text-3)' }}>{u.total_trx>0?fmtNum(avgTrx):'—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── CARI DOWNLINE ─────────────────────────────────────────── */}
          {activeTab === 'cari' && (
            <div style={{ marginTop: 16 }}>
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 20, marginBottom: 16 }}>
                <div style={{ fontWeight: 700, marginBottom: 12, fontSize: 14 }}>Pilih Upline untuk Melihat Downline</div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    placeholder="Cari ID / Nama upline..."
                    value={downlineSearch}
                    onChange={e => setDownlineSearch(e.target.value)}
                    style={{ background: 'var(--bg-page)', border: '1px solid var(--border)', color: 'var(--text-1)', borderRadius: 7, padding: '7px 12px', fontSize: 13, width: 240 }}
                  />
                  <select
                    value={selectedUpline}
                    onChange={e => handleUplineSelect(e.target.value)}
                    style={{ background: 'var(--bg-page)', border: '1px solid var(--border)', color: 'var(--text-1)', borderRadius: 7, padding: '7px 12px', fontSize: 13, minWidth: 300 }}>
                    <option value="">— Pilih Upline —</option>
                    {filteredUplines.map(u => (
                      <option key={u.id_upline} value={u.id_upline}>
                        {u.id_upline}{u.id_upline !== u.nama_pemilik ? ` — ${u.nama_pemilik}` : ''} ({fmtNum(u.total_downline)} downline)
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {!selectedUpline && (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
                  <i className="ti ti-search" style={{ fontSize: 32, display: 'block', marginBottom: 8 }} />
                  Pilih upline untuk melihat daftar downline-nya.
                </div>
              )}

              {downlineLoading && (
                <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)' }}>Memuat downline...</div>
              )}

              {!downlineLoading && downlineData && selectedUpline && (() => {
                const u = uplines.find(x => x.id_upline === selectedUpline);
                return (
                  <>
                    {u && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10, marginBottom: 16 }}>
                        <KPICard label="Total Downline"  value={fmtNum(u.total_downline)} color={COLOR} />
                        <KPICard label="Aktivasi"        value={fmtNum(u.sudah_aktivasi)} color={GREEN} sub={`${u.aktivasi_rate}% dari total`} />
                        <KPICard label="Dg Transaksi"    value={fmtNum(u.dengan_trx)}     color={PURPLE} sub={`${u.trx_rate}% dari aktivasi`} />
                        <KPICard label="QRIS Terbit ✅"  value={fmtNum(u.qris_terbit)}    color={GREEN} />
                        <KPICard label="QRIS Belum ⏳"   value={fmtNum(u.qris_belum_terbit)} color={AMBER} />
                        <KPICard label="Total TRX"       value={fmtNum(u.total_trx)}      color="var(--text-1)" sub={fmtRp(u.total_margin)} />
                        {u.komisi > 0 && <KPICard label="Komisi" value={fmtRp(u.komisi)} color={GREEN} />}
                      </div>
                    )}

                    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 13 }}>
                        {fmtNum(downlineData.downlines?.length)} Downline dari Upline {selectedUpline}
                      </div>
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead>
                            <tr>
                              {['ID Outlet','Nama Merchant','Kota','Paket','Tgl Reg','Tgl Aktivasi','Status QRIS','Total TRX','Margin'].map(h => (
                                <th key={h} style={{ ...thStyle(), cursor:'default' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {(downlineData.downlines || []).map(d => (
                              <tr key={d.id_outlet} style={rowStyle}>
                                <td style={{ ...tdL, fontFamily:'monospace', color:COLOR, fontWeight:600, whiteSpace:'nowrap' }}>{d.id_outlet}</td>
                                <td style={{ ...tdL, color:'var(--text-2)', maxWidth:150, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{d.nama_merchant || '—'}</td>
                                <td style={{ ...tdL, color:'var(--text-3)', whiteSpace:'nowrap' }}>{d.kota || '—'}</td>
                                <td style={{ ...tdL, color:'var(--text-3)', whiteSpace:'nowrap' }}>{d.nama_paket || '—'}</td>
                                <td style={{ ...tdL, color:'var(--text-3)', whiteSpace:'nowrap' }}>{d.tgl_reg || '—'}</td>
                                <td style={{ ...tdL, color:d.tgl_akt?GREEN:'var(--text-4)', whiteSpace:'nowrap' }}>{d.tgl_akt || '—'}</td>
                                <td style={tdL}><StatusBadge status={d.qris_status} /></td>
                                <td style={{ ...tdR, fontWeight:d.total_trx>0?700:400, color:d.total_trx>0?'var(--text-1)':'var(--text-4)' }}>{fmtNum(d.total_trx)}</td>
                                <td style={{ ...tdR, color:d.total_margin>0?GREEN:'var(--text-4)', whiteSpace:'nowrap' }}>{d.total_margin>0?fmtRp(d.total_margin):'—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          )}
        </>
      )}

      {!loading && data?.empty && (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-3)' }}>
          Belum ada data affiliate. Lakukan sync dari Google Sheets terlebih dahulu.
        </div>
      )}
    </div>
  );
}
