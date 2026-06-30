import { useState, useEffect, useCallback, useMemo } from 'react';
import Layout from '../components/Layout';
import { getAffiliateAnalytics, getAffiliateDownlines } from '../services/api';

const COLOR  = '#0891B2';
const COLOR2 = '#0E7490';
const GREEN  = '#10B981';
const AMBER  = '#F59E0B';
const RED    = '#EF4444';
const BLUE   = '#3B82F6';
const PURPLE = '#8B5CF6';
const ORANGE = '#F97316';
const GREY   = '#6B7280';

const QRIS_COLOR = {
  'Terbit':          GREEN,
  'Belum Terbit':    AMBER,
  'Perbaikan Data':  ORANGE,
  'Rejected':        RED,
  '-':               GREY,
};

function fmtN(n)   { return Math.round(+(n ?? 0)).toLocaleString('id-ID'); }
function fmtRp(n)  { return 'Rp ' + Math.round(+(n ?? 0)).toLocaleString('id-ID'); }
function fmtPct(n) { return `${+(n ?? 0)}%`; }

const TABS = [
  { id: 'ringkasan', label: 'Ringkasan',       icon: 'ti-chart-bar' },
  { id: 'tabel',     label: 'Tabel Upline',     icon: 'ti-table' },
  { id: 'qris',      label: 'Pipeline QRIS',    icon: 'ti-qrcode' },
  { id: 'trx',       label: 'Kontribusi TRX',   icon: 'ti-coin' },
  { id: 'cari',      label: 'Cari Downline',    icon: 'ti-search' },
];

function KPICard({ label, value, sub, icon = 'ti-chart-bar', accent = COLOR, small }) {
  return (
    <div className="wrfp-kpi-card" style={{ borderLeft: `3px solid ${accent}` }}>
      <div className="wrfp-kpi-label">
        <i className={`ti ${icon}`} style={{ color: accent }} /> {label}
      </div>
      <div className={`wrfp-kpi-value${small ? ' wra-kpi-sm' : ''}`}>{value}</div>
      {sub && <div className="wrfp-kpi-sub">{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }) {
  const c = QRIS_COLOR[status] || GREY;
  return (
    <span style={{ background: c + '22', color: c, borderRadius: 5, padding: '2px 8px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {status}
    </span>
  );
}

function FunnelBar({ label, val, total, color }) {
  const pct = total > 0 ? +((val / total) * 100).toFixed(1) : 0;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-2)', marginBottom: 4 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span>{fmtN(val)} <span style={{ color, fontWeight: 700 }}>({fmtPct(pct)})</span></span>
      </div>
      <div style={{ height: 7, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: color, borderRadius: 4, transition: 'width .4s' }} />
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

  // Tabel Upline sort
  const [sortKey, setSortKey] = useState('total_downline');
  const [sortDir, setSortDir] = useState('desc');

  // Cari Downline
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
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(''); }, [fetchData]);

  const fetchDownlines = useCallback(async (upline, bl) => {
    if (!upline) { setDownlineData(null); return; }
    setDownlineLoading(true);
    try {
      const d = await getAffiliateDownlines(upline, bl);
      setDownlineData(d);
    } catch (e) { console.error(e); }
    finally { setDownlineLoading(false); }
  }, []);

  const onBulanChange = (b) => { setBulan(b); fetchData(b); setDownlineData(null); setSelectedUpline(''); };

  const handleSelectUpline = (id) => { setSelectedUpline(id); fetchDownlines(id, bulan); };

  const s       = data?.summary || {};
  const uplines = useMemo(() => data?.uplines || [], [data]);

  const sortedUplines = useMemo(() => {
    return [...uplines].sort((a, b) => {
      const va = a[sortKey] ?? 0, vb = b[sortKey] ?? 0;
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === 'asc' ? va - vb : vb - va;
    });
  }, [uplines, sortKey, sortDir]);

  const onSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const top10    = useMemo(() => [...uplines].sort((a, b) => b.total_downline - a.total_downline).slice(0, 10), [uplines]);
  const qrisList = useMemo(() => [...uplines].filter(u => u.sudah_aktivasi > 0).sort((a, b) => b.qris_belum_terbit - a.qris_belum_terbit), [uplines]);
  const trxList  = useMemo(() => [...uplines].sort((a, b) => b.total_trx - a.total_trx), [uplines]);

  const filteredUplines = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return uplines;
    return uplines.filter(u =>
      u.id_upline?.toLowerCase().includes(q) ||
      (u.nama_pemilik && u.id_upline !== u.nama_pemilik && u.nama_pemilik.toLowerCase().includes(q))
    );
  }, [uplines, search]);

  // Table header helper
  const TH = ({ label, k, right }) => {
    const active = sortKey === k;
    const icon = active ? (sortDir === 'asc' ? 'ti-sort-ascending' : 'ti-sort-descending') : 'ti-arrows-sort';
    return (
      <th
        onClick={() => onSort(k)}
        style={{ padding: '8px 10px', textAlign: right ? 'right' : 'left', cursor: 'pointer', whiteSpace: 'nowrap',
          color: active ? COLOR : 'var(--text-3)', fontWeight: 600, userSelect: 'none', fontSize: 11,
          background: 'var(--bg-page)', borderBottom: '1px solid var(--border)' }}
      >
        {label} <i className={`ti ${icon}`} style={{ fontSize: 10, opacity: active ? 1 : .35 }} />
      </th>
    );
  };

  const THL = ({ label }) => (
    <th style={{ padding: '8px 10px', color: 'var(--text-3)', fontWeight: 600, fontSize: 11,
      background: 'var(--bg-page)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{label}</th>
  );

  const tdL = { padding: '6px 10px' };
  const tdR = { padding: '6px 10px', textAlign: 'right' };
  const rowS = { borderBottom: '1px solid var(--border)' };

  const rateColor = (r) => r >= 70 ? GREEN : r >= 40 ? AMBER : RED;

  return (
    <Layout>
      <div className="wrfp-page">

        {/* Header */}
        <div className="wrfp-header">
          <div className="wrfp-header-left">
            <i className="ti ti-users-group" style={{ color: COLOR, fontSize: 22 }} />
            <div>
              <div className="wrfp-header-title">WAR-ROOM Affiliate Analitik — InstaQris</div>
              <div className="wrfp-header-meta">
                Monitoring upline &amp; downline · {fmtN(s.total_upline)} upline aktif · {fmtN(s.total_downline)} downline
              </div>
            </div>
          </div>
          <div className="wrfp-header-badges">
            {data?.bulan_list?.length > 0 && (
              <select value={bulan} onChange={e => onBulanChange(e.target.value)}
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-1)', borderRadius: 6, padding: '4px 10px', fontSize: 13, cursor: 'pointer' }}>
                {data.bulan_list.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            )}
            <span className="wrfp-badge" style={{ background: COLOR, color: '#fff' }}>AFF</span>
            {bulan && <span className="wrfp-badge wrfp-badge-date">{bulan}</span>}
          </div>
        </div>

        {/* Tabs */}
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

        {/* Loading / Error / Empty */}
        {loading && (
          <div className="wrfp-loading">
            <i className="ti ti-loader-2 wrfp-spin" />
            <div>Memuat data affiliate...</div>
          </div>
        )}
        {!loading && error && (
          <div className="wrfp-error">
            <i className="ti ti-alert-circle" />
            <div>Error: {error}</div>
          </div>
        )}
        {!loading && !error && data?.empty && (
          <div className="wrfp-empty">
            <i className="ti ti-users-group" style={{ color: COLOR }} />
            <div>Belum ada data affiliate.</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Lakukan sync dari Google Sheets terlebih dahulu.</div>
          </div>
        )}

        {/* Content */}
        {!loading && !error && data && !data.empty && (

          <div className="wrfp-tab-content">

            {/* ── RINGKASAN ─────────────────────────────── */}
            {tab === 'ringkasan' && (
              <>
                <div className="wra-kpi-grid">
                  <KPICard icon="ti-users-group"  label="Upline Aktif"      value={fmtN(s.total_upline)}    accent={COLOR}   sub="yang punya downline" />
                  <KPICard icon="ti-user-plus"    label="Total Downline"    value={fmtN(s.total_downline)}  accent={GREY}    sub="seluruh outlet terdaftar" />
                  <KPICard icon="ti-user-check"   label="Sudah Aktivasi"    value={fmtN(s.sudah_aktivasi)}  accent={GREEN}   sub={<span style={{ color: GREEN }}>{fmtPct(s.aktivasi_rate)} dari total</span>} />
                  <KPICard icon="ti-cash"         label="Sudah Transaksi"   value={fmtN(s.dengan_trx)}      accent={PURPLE}  sub={<span style={{ color: PURPLE }}>{fmtPct(s.trx_rate)} dari aktivasi</span>} />
                  <KPICard icon="ti-qrcode"       label="QRIS Terbit ✅"    value={fmtN(s.qris_terbit)}     accent={GREEN}   sub="sudah terbit" />
                  <KPICard icon="ti-clock"        label="QRIS Pending ⏳"   value={fmtN((s.qris_belum_terbit||0)+(s.qris_perbaikan||0))}  accent={AMBER}
                    sub={`${fmtN(s.qris_belum_terbit)} belum + ${fmtN(s.qris_perbaikan)} perbaikan`} />
                  <KPICard icon="ti-user-x"       label="Hanya Registrasi"  value={fmtN(s.registrasi_only)} accent={BLUE}    sub={<span style={{ color: BLUE }}>{s.total_downline > 0 ? fmtPct(+((s.registrasi_only/s.total_downline)*100).toFixed(1)) : '0%'} belum aktivasi</span>} />
                  <KPICard icon="ti-bolt"         label="Total TRX"         value={fmtN(s.total_trx)}        accent="var(--text-3)" sub={`margin ${fmtRp(s.total_margin)}`} small />
                </div>

                {/* Funnel */}
                <div className="wrfp-chart-card">
                  <div className="wrfp-chart-title"><i className="ti ti-filter" style={{ color: COLOR }} /> Funnel Konversi Downline</div>
                  <FunnelBar label="Total Downline"  val={s.total_downline} total={s.total_downline} color={GREY} />
                  <FunnelBar label="Sudah Aktivasi"  val={s.sudah_aktivasi} total={s.total_downline} color={GREEN} />
                  <FunnelBar label="Sudah Transaksi" val={s.dengan_trx}     total={s.total_downline} color={PURPLE} />
                  <FunnelBar label="QRIS Terbit"     val={s.qris_terbit}    total={s.total_downline} color={COLOR} />
                </div>

                {/* Top 10 table */}
                <div className="wrfp-chart-card" style={{ marginBottom: 0 }}>
                  <div className="wrfp-chart-title"><i className="ti ti-trophy" style={{ color: AMBER }} /> Top 10 Upline — Terbanyak Downline</div>
                  <div className="wrfp-table-wrap">
                    <table className="wrfp-table">
                      <thead>
                        <tr>
                          <THL label="#" /><THL label="ID Upline" /><THL label="Nama" /><THL label="Downline" />
                          <THL label="Aktivasi" /><THL label="% Akt" /><THL label="TRX" /><THL label="QRIS Terbit" /><THL label="QRIS Belum" />
                        </tr>
                      </thead>
                      <tbody>
                        {top10.map((u, i) => (
                          <tr key={u.id_upline}>
                            <td style={{ ...tdL, color: 'var(--text-3)', fontWeight: 600, textAlign: 'center' }}>{i+1}</td>
                            <td style={{ ...tdL, fontFamily: 'monospace', color: COLOR, fontWeight: 600 }}>{u.id_upline}</td>
                            <td style={{ ...tdL, color: 'var(--text-2)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {u.id_upline !== u.nama_pemilik ? u.nama_pemilik : '—'}
                            </td>
                            <td style={{ ...tdR, fontWeight: 700 }}>{fmtN(u.total_downline)}</td>
                            <td style={{ ...tdR, color: GREEN, fontWeight: 600 }}>{fmtN(u.sudah_aktivasi)}</td>
                            <td style={tdR}><span style={{ color: rateColor(u.aktivasi_rate), fontWeight: 600 }}>{u.aktivasi_rate}%</span></td>
                            <td style={{ ...tdR, color: PURPLE, fontWeight: 600 }}>{fmtN(u.dengan_trx)}</td>
                            <td style={{ ...tdR, color: GREEN }}>{fmtN(u.qris_terbit)}</td>
                            <td style={{ ...tdR, color: AMBER, fontWeight: u.qris_belum_terbit > 0 ? 700 : 400 }}>{fmtN(u.qris_belum_terbit)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            {/* ── TABEL UPLINE ──────────────────────────── */}
            {tab === 'tabel' && (
              <div className="wrfp-table-wrap">
                <table className="wrfp-table">
                  <thead>
                    <tr>
                      <TH label="ID Upline"       k="id_upline" />
                      <TH label="Nama"             k="nama_pemilik" />
                      <TH label="Downline"         k="total_downline"    right />
                      <TH label="Reg Only"         k="registrasi_only"   right />
                      <TH label="Aktivasi"         k="sudah_aktivasi"    right />
                      <TH label="% Akt"            k="aktivasi_rate"     right />
                      <TH label="Dg TRX"           k="dengan_trx"        right />
                      <TH label="% TRX"            k="trx_rate"          right />
                      <TH label="Q Terbit"         k="qris_terbit"       right />
                      <TH label="Q Belum"          k="qris_belum_terbit" right />
                      <TH label="Q Perbaikan"      k="qris_perbaikan"    right />
                      <TH label="Total TRX"        k="total_trx"         right />
                      <TH label="Margin"           k="total_margin"      right />
                      <TH label="Komisi"           k="komisi"            right />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedUplines.map(u => (
                      <tr key={u.id_upline} style={rowS}>
                        <td style={{ ...tdL, fontFamily: 'monospace', color: COLOR, fontWeight: 600, whiteSpace: 'nowrap' }}>{u.id_upline}</td>
                        <td style={{ ...tdL, color: 'var(--text-2)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {u.id_upline !== u.nama_pemilik ? u.nama_pemilik : '—'}
                        </td>
                        <td style={{ ...tdR, fontWeight: 700 }}>{fmtN(u.total_downline)}</td>
                        <td style={{ ...tdR, color: BLUE }}>{fmtN(u.registrasi_only)}</td>
                        <td style={{ ...tdR, color: GREEN, fontWeight: 600 }}>{fmtN(u.sudah_aktivasi)}</td>
                        <td style={tdR}><span style={{ color: rateColor(u.aktivasi_rate), fontWeight: 600 }}>{u.aktivasi_rate}%</span></td>
                        <td style={{ ...tdR, color: PURPLE, fontWeight: 600 }}>{fmtN(u.dengan_trx)}</td>
                        <td style={tdR}><span style={{ color: rateColor(u.trx_rate), fontWeight: 600 }}>{u.trx_rate}%</span></td>
                        <td style={{ ...tdR, color: GREEN }}>{fmtN(u.qris_terbit)}</td>
                        <td style={{ ...tdR, color: AMBER, fontWeight: u.qris_belum_terbit > 0 ? 700 : 400 }}>{fmtN(u.qris_belum_terbit)}</td>
                        <td style={{ ...tdR, color: ORANGE }}>{fmtN(u.qris_perbaikan)}</td>
                        <td style={{ ...tdR, fontWeight: u.total_trx > 0 ? 600 : 400, color: u.total_trx > 0 ? 'var(--text-1)' : 'var(--text-4)' }}>{fmtN(u.total_trx)}</td>
                        <td style={{ ...tdR, color: GREEN, whiteSpace: 'nowrap' }}>{u.total_margin > 0 ? fmtRp(u.total_margin) : '—'}</td>
                        <td style={{ ...tdR, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{u.komisi > 0 ? fmtRp(u.komisi) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* ── PIPELINE QRIS ─────────────────────────── */}
            {tab === 'qris' && (
              <div className="wrfp-chart-card" style={{ marginBottom: 0 }}>
                <div className="wrfp-chart-title">
                  <i className="ti ti-qrcode" style={{ color: AMBER }} /> Upline diurutkan berdasarkan QRIS Belum Terbit terbanyak
                </div>
                <div className="wrfp-table-wrap">
                  <table className="wrfp-table">
                    <thead>
                      <tr>
                        <THL label="#" /><THL label="ID Upline" /><THL label="Nama" />
                        <THL label="Belum Terbit" /><THL label="Perbaikan" /><THL label="Terbit" />
                        <THL label="Rejected" /><THL label="Total QRIS" /><THL label="% Terbit" />
                      </tr>
                    </thead>
                    <tbody>
                      {qrisList.map((u, i) => {
                        const total    = u.qris_terbit + u.qris_belum_terbit + u.qris_perbaikan + u.qris_rejected;
                        const pctTerbit = total > 0 ? +((u.qris_terbit / total) * 100).toFixed(1) : 0;
                        return (
                          <tr key={u.id_upline} style={rowS}>
                            <td style={{ ...tdL, textAlign: 'center', color: 'var(--text-3)', fontWeight: 600 }}>{i+1}</td>
                            <td style={{ ...tdL, fontFamily: 'monospace', color: COLOR, fontWeight: 600 }}>{u.id_upline}</td>
                            <td style={{ ...tdL, color: 'var(--text-2)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {u.id_upline !== u.nama_pemilik ? u.nama_pemilik : '—'}
                            </td>
                            <td style={{ ...tdR, color: AMBER, fontWeight: u.qris_belum_terbit > 0 ? 700 : 400 }}>{fmtN(u.qris_belum_terbit)}</td>
                            <td style={{ ...tdR, color: ORANGE }}>{fmtN(u.qris_perbaikan)}</td>
                            <td style={{ ...tdR, color: GREEN, fontWeight: 600 }}>{fmtN(u.qris_terbit)}</td>
                            <td style={{ ...tdR, color: RED }}>{fmtN(u.qris_rejected)}</td>
                            <td style={{ ...tdR, fontWeight: 600 }}>{fmtN(total)}</td>
                            <td style={tdR}><span style={{ color: rateColor(pctTerbit), fontWeight: 600 }}>{pctTerbit}%</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── KONTRIBUSI TRX ────────────────────────── */}
            {tab === 'trx' && (
              <div className="wrfp-chart-card" style={{ marginBottom: 0 }}>
                <div className="wrfp-chart-title">
                  <i className="ti ti-coin" style={{ color: GREEN }} /> Kontribusi Transaksi &amp; Margin per Upline — bulan {bulan}
                </div>
                <div className="wrfp-table-wrap">
                  <table className="wrfp-table">
                    <thead>
                      <tr>
                        <THL label="#" /><THL label="ID Upline" /><THL label="Nama" />
                        <THL label="Total TRX" /><THL label="Margin" /><THL label="Omzet" />
                        <THL label="Dg TRX" /><THL label="Total Downline" /><THL label="Avg TRX/Outlet" />
                      </tr>
                    </thead>
                    <tbody>
                      {trxList.map((u, i) => {
                        const avgTrx = u.dengan_trx > 0 ? Math.round(u.total_trx / u.dengan_trx) : 0;
                        return (
                          <tr key={u.id_upline} style={rowS}>
                            <td style={{ ...tdL, textAlign: 'center', color: 'var(--text-3)' }}>{i+1}</td>
                            <td style={{ ...tdL, fontFamily: 'monospace', color: COLOR, fontWeight: 600 }}>{u.id_upline}</td>
                            <td style={{ ...tdL, color: 'var(--text-2)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {u.id_upline !== u.nama_pemilik ? u.nama_pemilik : '—'}
                            </td>
                            <td style={{ ...tdR, fontWeight: u.total_trx > 0 ? 700 : 400, color: u.total_trx > 0 ? 'var(--text-1)' : 'var(--text-4)' }}>{fmtN(u.total_trx)}</td>
                            <td style={{ ...tdR, color: GREEN, fontWeight: 600, whiteSpace: 'nowrap' }}>{u.total_margin > 0 ? fmtRp(u.total_margin) : '—'}</td>
                            <td style={{ ...tdR, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{u.total_omzet > 0 ? fmtRp(u.total_omzet) : '—'}</td>
                            <td style={{ ...tdR, color: PURPLE, fontWeight: 600 }}>{fmtN(u.dengan_trx)}</td>
                            <td style={tdR}>{fmtN(u.total_downline)}</td>
                            <td style={{ ...tdR, color: 'var(--text-3)' }}>{u.total_trx > 0 ? fmtN(avgTrx) : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── CARI DOWNLINE ─────────────────────────── */}
            {tab === 'cari' && (
              <>
                {/* Search box */}
                <div className="wrfp-chart-card">
                  <div className="wrfp-chart-title"><i className="ti ti-search" style={{ color: COLOR }} /> Pilih Upline untuk Melihat Downline</div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      placeholder="Cari ID / Nama upline..."
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      style={{ background: 'var(--bg-page)', border: '1px solid var(--border)', color: 'var(--text-1)', borderRadius: 7, padding: '7px 12px', fontSize: 13, width: 240 }}
                    />
                    <select
                      value={selectedUpline}
                      onChange={e => handleSelectUpline(e.target.value)}
                      style={{ background: 'var(--bg-page)', border: '1px solid var(--border)', color: 'var(--text-1)', borderRadius: 7, padding: '7px 12px', fontSize: 13, minWidth: 300 }}>
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

                {downlineLoading && (
                  <div className="wrfp-loading">
                    <i className="ti ti-loader-2 wrfp-spin" />
                    <div>Memuat downline...</div>
                  </div>
                )}

                {!downlineLoading && downlineData && selectedUpline && (() => {
                  const u = uplines.find(x => x.id_upline === selectedUpline);
                  return (
                    <>
                      {u && (
                        <div className="wra-kpi-grid" style={{ marginBottom: 14 }}>
                          <KPICard icon="ti-users"       label="Total Downline"  value={fmtN(u.total_downline)}   accent={COLOR} />
                          <KPICard icon="ti-user-check"  label="Aktivasi"        value={fmtN(u.sudah_aktivasi)}   accent={GREEN}  sub={`${u.aktivasi_rate}% dari total`} />
                          <KPICard icon="ti-cash"        label="Dg Transaksi"    value={fmtN(u.dengan_trx)}       accent={PURPLE} sub={`${u.trx_rate}% dari aktivasi`} />
                          <KPICard icon="ti-qrcode"      label="QRIS Terbit ✅"  value={fmtN(u.qris_terbit)}      accent={GREEN} />
                          <KPICard icon="ti-clock"       label="QRIS Belum ⏳"   value={fmtN(u.qris_belum_terbit)} accent={AMBER} />
                          {u.komisi > 0
                            ? <KPICard icon="ti-coin" label="Komisi"   value={fmtRp(u.komisi)} accent={GREEN} />
                            : <KPICard icon="ti-bolt" label="Total TRX" value={fmtN(u.total_trx)} accent="var(--text-3)" sub={fmtRp(u.total_margin)} small />
                          }
                        </div>
                      )}

                      <div className="wrfp-chart-card" style={{ marginBottom: 0 }}>
                        <div className="wrfp-chart-title">
                          {fmtN(downlineData.downlines?.length)} Downline dari Upline {selectedUpline}
                        </div>
                        <div className="wrfp-table-wrap">
                          <table className="wrfp-table">
                            <thead>
                              <tr>
                                <THL label="ID Outlet" /><THL label="Nama Merchant" /><THL label="Kota" />
                                <THL label="Paket" /><THL label="Tgl Reg" /><THL label="Tgl Aktivasi" />
                                <THL label="Status QRIS" /><THL label="Total TRX" /><THL label="Margin" />
                              </tr>
                            </thead>
                            <tbody>
                              {(downlineData.downlines || []).map(d => (
                                <tr key={d.id_outlet}>
                                  <td style={{ ...tdL, fontFamily: 'monospace', color: COLOR, fontWeight: 600, whiteSpace: 'nowrap' }}>{d.id_outlet}</td>
                                  <td style={{ ...tdL, color: 'var(--text-2)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.nama_merchant || '—'}</td>
                                  <td style={{ ...tdL, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{d.kota || '—'}</td>
                                  <td style={{ ...tdL, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{d.nama_paket || '—'}</td>
                                  <td style={{ ...tdL, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{d.tgl_reg || '—'}</td>
                                  <td style={{ ...tdL, color: d.tgl_akt ? GREEN : 'var(--text-4)', whiteSpace: 'nowrap' }}>{d.tgl_akt || '—'}</td>
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
