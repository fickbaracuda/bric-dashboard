import { useState, useEffect, useRef, useMemo } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getBumdesAnalytics, getBumdesOutlets } from '../services/api';

const COLOR  = '#0D9488';
const COLOR2 = '#0F766E';

const TABS = [
  { id: 0, icon: 'ti-dashboard',   label: 'Executive' },
  { id: 1, icon: 'ti-table',       label: 'Outlet' },
  { id: 2, icon: 'ti-users',       label: 'Upline' },
  { id: 3, icon: 'ti-map-pin',     label: 'Kota' },
  { id: 4, icon: 'ti-tag',         label: 'Tipe Outlet' },
  { id: 5, icon: 'ti-trending-up', label: 'Growth' },
];

const fmtN  = v => (Number(v) || 0).toLocaleString('id');
const fmtRp = v => 'Rp ' + fmtN(v);
const fmtDev = v => {
  const n = Number(v) || 0;
  return { val: (n >= 0 ? '+' : '') + fmtN(n), cls: n >= 0 ? 'wra-pos' : 'wra-neg' };
};

const TIPE_COLORS = ['#7C3AED','#0D9488','#059669','#F59E0B','#EF4444','#EC4899','#8B5CF6','#14B8A6'];

/* ─── Chart components ─── */
function HBarChart({ labels, values, color = COLOR, title }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const c = new Chart(ref.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ data: values, backgroundColor: color + 'CC', borderColor: color, borderWidth: 1.5, borderRadius: 4 }],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: '#ffffff10' }, ticks: { color: '#9CA3AF', font: { size: 11 } } },
          y: { grid: { display: false }, ticks: { color: '#D1D5DB', font: { size: 11 } } },
        },
      },
    });
    return () => c.destroy();
  }, [labels, values, color]);
  return (
    <div className="wrfp-chart-card">
      {title && <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-1)', marginBottom: 10 }}>{title}</div>}
      <div style={{ height: Math.max((labels?.length || 1) * 30, 120) }}><canvas ref={ref} /></div>
    </div>
  );
}

function DonutChart({ labels, values, colors, title }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const c = new Chart(ref.current, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#1f2937' }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { color: '#9CA3AF', font: { size: 11 }, padding: 8 } } },
      },
    });
    return () => c.destroy();
  }, [labels, values, colors]);
  return (
    <div className="wrfp-chart-card">
      {title && <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-1)', marginBottom: 10 }}>{title}</div>}
      <div style={{ height: 200 }}><canvas ref={ref} /></div>
    </div>
  );
}

/* ─── Shared UI ─── */
function KPICard({ icon, label, value, sub, subCls, accent = COLOR, small }) {
  return (
    <div className="wrfp-kpi-card" style={{ borderLeft: `3px solid ${accent}` }}>
      <div className="wrfp-kpi-title"><i className={`ti ${icon}`} style={{ color: accent }} /> {label}</div>
      <div className={`wrfp-kpi-value${small ? ' wra-kpi-sm' : ''}`}>{value}</div>
      {sub && <div className={`wrfp-kpi-sub ${subCls || ''}`}>{sub}</div>}
    </div>
  );
}

function SortTh({ label, field, sortF, sortD, onSort, right }) {
  const active = sortF === field;
  return (
    <th className={`writ-th${active ? ' writ-th--active' : ''}`}
        style={{ cursor: 'pointer', userSelect: 'none', textAlign: right ? 'right' : undefined }}
        onClick={() => onSort(field)}>
      {label} {active ? (sortD === 'asc' ? '↑' : '↓') : ''}
    </th>
  );
}

function Paginator({ page, total, pageSize, onPage }) {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  return (
    <div className="writ-pagination">
      <button className="writ-pag-btn" onClick={() => onPage(page - 1)} disabled={page === 1}>‹</button>
      <span className="writ-pag-info">Hal {page}/{pages} · {total} data</span>
      <button className="writ-pag-btn" onClick={() => onPage(page + 1)} disabled={page >= pages}>›</button>
    </div>
  );
}

function WaLink({ notelp }) {
  if (!notelp) return null;
  const num = String(notelp).replace(/^0/, '').replace(/\D/g, '');
  return (
    <a href={`https://wa.me/62${num}`} target="_blank" rel="noreferrer" style={{ color: '#25D366', fontSize: 15 }}>
      <i className="ti ti-brand-whatsapp" />
    </a>
  );
}

/* ════════════════════════════════════════════
   TAB 0 — Executive Summary
════════════════════════════════════════════ */
function buildInsight(s) {
  const growing    = Number(s.growing)    || 0;
  const declining  = Number(s.declining)  || 0;
  const stable     = Number(s.stable)     || 0;
  const churned    = Number(s.churned)    || 0;
  const belumAktif = Number(s.belum_aktif)|| 0;
  const anomali    = Number(s.anomali)    || 0;
  const nmat       = Number(s.nmat)       || 0;
  const trxMei     = Number(s.total_trx_mei) || 0;
  const revMei     = Number(s.total_rev_mei) || 0;
  const devTrxPct  = trxMei > 0 ? ((Number(s.dev_trx_total) / trxMei) * 100).toFixed(1) : null;
  const devRevPct  = revMei > 0 ? ((Number(s.dev_rev_total) / revMei) * 100).toFixed(1) : null;
  const matPct     = s.total_outlet > 0 ? ((Number(s.mat)||0) / Number(s.total_outlet) * 100).toFixed(1) : '0';

  const arahTrx = devTrxPct !== null ? (Number(devTrxPct) >= 0 ? 'naik' : 'turun') : null;
  const arahRev = devRevPct !== null ? (Number(devRevPct) >= 0 ? 'tumbuh' : 'turun') : null;

  const paragraph = [
    `Total ${fmtN(s.total_outlet)} outlet BUMDes terdaftar, ${fmtN(s.mat)} aktif bertransaksi di Juni (activation rate ${matPct}%).`,
    arahTrx && arahRev
      ? `TRX ${arahTrx} ${Math.abs(devTrxPct)}% dan revenue ${arahRev} ${Math.abs(devRevPct)}% dibanding Mei (bulan penuh).`
      : '',
    `Dari total outlet: ${fmtN(growing)} growing, ${fmtN(declining)} declining, ${fmtN(nmat)} baru aktif, ${fmtN(churned)} churned, ${fmtN(stable)} stable${belumAktif > 0 ? `, ${fmtN(belumAktif)} belum pernah aktif` : ''}.`,
    anomali > 0 ? `Terdapat ${fmtN(anomali)} outlet anomali (TRX naik namun revenue turun) yang perlu diinvestigasi.` : '',
  ].filter(Boolean).join(' ');

  const recs = [];
  if (churned > 0)   recs.push({ icon: '🚨', title: 'Recovery Call Outlet Hilang',         priority: 'Prioritas Tinggi',  color: '#DC2626',
    text: `${fmtN(churned)} outlet BUMDes aktif di Mei tapi tidak ada transaksi di Juni. Hubungi segera agar bisa diaktifkan kembali sebelum akhir bulan.` });
  if (declining > 0) recs.push({ icon: '📉', title: 'Retensi Outlet Declining',             priority: 'Prioritas Tinggi',  color: '#EF4444',
    text: `${fmtN(declining)} outlet mengalami penurunan TRX vs Mei. Follow-up langsung, cek hambatan operasional pengurus BUMDes, dan berikan dukungan teknis.` });
  if (anomali > 0)   recs.push({ icon: '🔍', title: 'Investigasi Anomali Revenue',          priority: 'Prioritas Sedang',  color: '#F59E0B',
    text: `${fmtN(anomali)} outlet menunjukkan TRX naik tapi revenue turun. Cek apakah ada pergeseran ke jenis transaksi bernilai lebih rendah atau ada potongan fee.` });
  if (nmat > 0)      recs.push({ icon: '🌟', title: 'Onboarding Outlet Baru',               priority: 'Prioritas Sedang',  color: '#F59E0B',
    text: `${fmtN(nmat)} outlet BUMDes baru aktif bulan ini. Lakukan pendampingan terstruktur dan kunjungan rutin agar konsisten aktif di bulan berikutnya.` });
  if (belumAktif > 0) recs.push({ icon: '⚠️', title: 'Aktivasi Outlet Belum Bertransaksi', priority: 'Prioritas Sedang',  color: '#F59E0B',
    text: `${fmtN(belumAktif)} outlet BUMDes terdaftar tapi belum pernah bertransaksi. Kunjungi pengurus, edukasi cara bertransaksi, dan fasilitasi transaksi pertama.` });
  if (growing > 0)   recs.push({ icon: '📈', title: 'Pertahankan Momentum Growth',          priority: 'Prioritas Rendah',  color: '#10B981',
    text: `${fmtN(growing)} outlet sedang tumbuh. Berikan apresiasi kepada pengurus BUMDes, lakukan komunikasi rutin, dan dorong peningkatan volume transaksi.` });
  if (stable > 0)    recs.push({ icon: '📌', title: 'Dorong Outlet Stable ke Growing',      priority: 'Prioritas Rendah',  color: '#10B981',
    text: `${fmtN(stable)} outlet stagnan (TRX tidak berubah). Berikan program insentif atau bantu BUMDes diversifikasi layanan transaksi agar volume meningkat.` });

  return { paragraph, recs: recs.slice(0, 6) };
}

function ExecutiveTab({ summary: s, lastSync, outlets }) {
  const devTrx = fmtDev(s.dev_trx_total);
  const devRev = fmtDev(s.dev_rev_total);
  const matPct     = s.total_outlet > 0 ? ((Number(s.mat)||0) / Number(s.total_outlet) * 100).toFixed(1) : '0';
  const nmatContrib= s.mat > 0 ? ((Number(s.nmat)||0) / Number(s.mat) * 100).toFixed(1) : '0';

  const trunc = (str, n = 28) => str && str.length > n ? str.slice(0, n) + '…' : (str || '-');

  const topGrowing   = useMemo(() =>
    (outlets||[]).filter(o => Number(o.dev_trx)>0 && Number(o.trx_mei)>0)
      .sort((a,b) => Number(b.dev_trx)-Number(a.dev_trx)).slice(0,10), [outlets]);
  const topDeclining = useMemo(() =>
    (outlets||[]).filter(o => Number(o.dev_trx)<0)
      .sort((a,b) => Number(a.dev_trx)-Number(b.dev_trx)).slice(0,6), [outlets]);
  const topNewActive = useMemo(() =>
    (outlets||[]).filter(o => Number(o.trx_mei)===0 && Number(o.trx_juni)>0)
      .sort((a,b) => Number(b.trx_juni)-Number(a.trx_juni)).slice(0,6), [outlets]);

  const { paragraph, recs } = buildInsight(s);

  const MiniRow = ({ label, value, cls, color }) => (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
      padding:'4px 0', borderBottom:'1px solid var(--border)', fontSize:12 }}>
      <span style={{ color:'var(--text-2)', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{label}</span>
      <span className={cls} style={{ fontWeight:700, marginLeft:10, whiteSpace:'nowrap', color:color }}>{value}</span>
    </div>
  );

  return (
    <div>
      {/* 10 KPI Cards — 5 kolom × 2 baris */}
      <div className="wra-kpi-grid">
        <KPICard icon="ti-bolt"           label="Transaksi"          value={fmtN(s.total_trx_juni)}  sub="Total TRX Juni" />
        <KPICard icon="ti-cash"           label="Revenue TRX"        value={fmtRp(s.total_rev_juni)} sub="Total Rev Juni" small />
        <KPICard icon="ti-circle-check"   label="MAT"                value={fmtN(s.mat)}             sub={`${matPct}% activation rate`} />
        <KPICard icon="ti-star"           label="NMAT"               value={fmtN(s.nmat)}            sub={`${nmatContrib}% dari MAT`} accent="#059669" />
        <KPICard icon="ti-flame"          label="NMAT Min 100 TRX"   value={fmtN(s.nmat_min100)}     sub="New outlet berperforma tinggi" accent="#F59E0B" />
        <KPICard icon="ti-bolt-circle"    label="MAT Min 300 TRX"    value={fmtN(s.mat_min300)}      sub="Volume sangat tinggi" accent="#7C3AED" />
        <KPICard icon="ti-trending-up"    label="Trx New MAT"        value={fmtN(s.trx_new_mat)}     sub="TRX dari outlet baru" accent={COLOR} />
        <KPICard icon="ti-receipt-2"      label="Rev New MAT"        value={fmtRp(s.rev_new_mat)}    sub="Revenue outlet baru" small accent={COLOR} />
        <KPICard icon="ti-arrows-diff"    label="Dev TRX Juni-Mei"
          value={devTrx.val} subCls={devTrx.cls} sub="Selisih TRX Juni vs Mei"
          accent={Number(s.dev_trx_total) >= 0 ? '#059669' : '#DC2626'} />
        <KPICard icon="ti-arrows-diff"    label="Dev Rev Juni-Mei"
          value={devRev.val} subCls={devRev.cls} sub="Selisih Rev Juni vs Mei" small
          accent={Number(s.dev_rev_total) >= 0 ? '#059669' : '#DC2626'} />
      </div>

      {/* Charts: Top Growing | Top Declining + Top New Active */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        {/* Kiri: Top Growing */}
        <HBarChart
          labels={topGrowing.map(o => trunc(o.nama_pemilik))}
          values={topGrowing.map(o => Number(o.dev_trx))}
          color="#059669"
          title="📈 Top Growing Outlet (Dev TRX)"
        />

        {/* Kanan: Top Declining + Top New Active */}
        <div className="wrfp-chart-card" style={{ margin: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#DC2626', marginBottom: 8 }}>
            📉 Top Declining Outlet
          </div>
          {topDeclining.length === 0
            ? <div style={{ fontSize:12, color:'var(--text-4)', padding:'6px 0' }}>Tidak ada outlet declining</div>
            : topDeclining.map(o => {
                const d = fmtDev(o.dev_trx);
                return <MiniRow key={o.id_outlet} label={trunc(o.nama_pemilik)} value={d.val} cls={d.cls} />;
              })
          }

          <div style={{ fontWeight: 700, fontSize: 13, color: COLOR, marginTop: 16, marginBottom: 8 }}>
            🌟 Top New Active Outlet
          </div>
          {topNewActive.length === 0
            ? <div style={{ fontSize:12, color:'var(--text-4)', padding:'6px 0' }}>Tidak ada outlet baru aktif</div>
            : topNewActive.map(o => (
                <MiniRow key={o.id_outlet} label={trunc(o.nama_pemilik)}
                  value={fmtN(o.trx_juni) + ' TRX'} color={COLOR} />
              ))
          }
        </div>
      </div>

      {/* Ringkasan Eksekutif + Rekomendasi — 2 kolom, di bawah */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div className="wrfp-chart-card" style={{ margin: 0 }}>
          <div style={{ fontWeight: 700, marginBottom: 10, color: 'var(--text-1)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 7 }}>
            <i className="ti ti-report-analytics" style={{ color: COLOR }} /> Ringkasan Eksekutif
          </div>
          <p style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.8, margin: 0 }}>
            {paragraph}
          </p>
        </div>
        <div className="wrfp-chart-card" style={{ margin: 0 }}>
          <div style={{ fontWeight: 700, marginBottom: 10, color: 'var(--text-1)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 7 }}>
            <i className="ti ti-bulb" style={{ color: '#F59E0B' }} /> Rekomendasi
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recs.map(r => (
              <div key={r.title} style={{
                borderLeft: `3px solid ${r.color}`, padding: '8px 12px',
                background: r.color + '12', borderRadius: '0 6px 6px 0',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-1)', fontSize: 13 }}>{r.icon} {r.title}</div>
                  <span style={{
                    fontSize: 11, padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap', marginLeft: 8,
                    background: r.color + '25', color: r.color, fontWeight: 600,
                  }}>{r.priority}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6 }}>{r.text}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {lastSync && (
        <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-4)', marginTop: 8 }}>
          Data terakhir sync: {new Date(lastSync).toLocaleString('id-ID')}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 1 — Daftar Outlet
════════════════════════════════════════════ */
function OutletTab({ outlets }) {
  const [q, setQ]         = useState('');
  const [fKota, setFKota] = useState('');
  const [fTipe, setFTipe] = useState('');
  const [fUp,   setFUp]   = useState('');
  const [sortF, setSortF] = useState('trx_juni');
  const [sortD, setSortD] = useState('desc');
  const [page,  setPage]  = useState(1);
  const PAGE = 50;

  const kotas   = useMemo(() => [...new Set((outlets||[]).map(o => o.nama_kota).filter(Boolean))].sort(), [outlets]);
  const tipes   = useMemo(() => [...new Set((outlets||[]).map(o => o.tipe_outlet).filter(Boolean))].sort(), [outlets]);
  const uplines = useMemo(() => [...new Set((outlets||[]).map(o => o.upline).filter(Boolean))].sort(), [outlets]);

  const filtered = useMemo(() => {
    let d = outlets || [];
    if (q) {
      const lq = q.toLowerCase();
      d = d.filter(o =>
        (o.id_outlet||'').toLowerCase().includes(lq) ||
        (o.nama_pemilik||'').toLowerCase().includes(lq) ||
        (o.upline||'').toLowerCase().includes(lq)
      );
    }
    if (fKota) d = d.filter(o => o.nama_kota === fKota);
    if (fTipe) d = d.filter(o => o.tipe_outlet === fTipe);
    if (fUp)   d = d.filter(o => o.upline === fUp);
    return [...d].sort((a, b) => {
      const va = Number(a[sortF])||0, vb = Number(b[sortF])||0;
      if (va !== vb) return sortD === 'asc' ? va - vb : vb - va;
      return String(a.id_outlet).localeCompare(String(b.id_outlet));
    });
  }, [outlets, q, fKota, fTipe, fUp, sortF, sortD]);

  const paged  = filtered.slice((page-1)*PAGE, page*PAGE);
  const onSort = f => { if (sortF===f) setSortD(d => d==='asc'?'desc':'asc'); else { setSortF(f); setSortD('desc'); } setPage(1); };
  const clear  = () => { setQ(''); setFKota(''); setFTipe(''); setFUp(''); setPage(1); };

  return (
    <div>
      <div className="writ-filter-bar">
        <input className="writ-filter-input" placeholder="Cari ID / Nama / Upline..." value={q}
          onChange={e => { setQ(e.target.value); setPage(1); }} />
        <select className="writ-filter-select" value={fKota} onChange={e => { setFKota(e.target.value); setPage(1); }}>
          <option value="">Semua Kota</option>
          {kotas.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <select className="writ-filter-select" value={fTipe} onChange={e => { setFTipe(e.target.value); setPage(1); }}>
          <option value="">Semua Tipe</option>
          {tipes.map(t => <option key={t} value={t}>{t.replace('(FastPay + FastKAI)','').trim()}</option>)}
        </select>
        <select className="writ-filter-select" value={fUp} onChange={e => { setFUp(e.target.value); setPage(1); }}>
          <option value="">Semua Upline</option>
          {uplines.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <span className="writ-filter-badge">{filtered.length} outlet</span>
        {(q||fKota||fTipe||fUp) && <button className="writ-filter-clear" onClick={clear}>× Reset</button>}
      </div>
      <div className="writ-table-wrap">
        <table className="writ-table">
          <thead><tr>
            <SortTh label="ID Outlet"   field="id_outlet"  sortF={sortF} sortD={sortD} onSort={onSort} />
            <th className="writ-th">Nama Pemilik</th>
            <th className="writ-th">Upline</th>
            <th className="writ-th">Kota</th>
            <th className="writ-th">Tipe</th>
            <th className="writ-th">Tgl Reg</th>
            <SortTh label="TRX Mei"  field="trx_mei"  sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="TRX Juni" field="trx_juni" sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="Rev Juni" field="rev_juni" sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="Dev TRX"  field="dev_trx"  sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="Dev Rev"  field="dev_rev"  sortF={sortF} sortD={sortD} onSort={onSort} right />
            <th className="writ-th">WA</th>
          </tr></thead>
          <tbody>
            {paged.map(o => {
              const dT = fmtDev(o.dev_trx), dR = fmtDev(o.dev_rev);
              return (
                <tr key={o.id_outlet} className="writ-tr">
                  <td className="writ-td" style={{ fontFamily: 'monospace', color: COLOR, fontSize: 12 }}>{o.id_outlet}</td>
                  <td className="writ-td writ-td-name">{o.nama_pemilik}</td>
                  <td className="writ-td" style={{ color: 'var(--text-3)', fontSize: 12 }}>{o.upline}</td>
                  <td className="writ-td" style={{ fontSize: 12 }}>{o.nama_kota}</td>
                  <td className="writ-td" style={{ fontSize: 11 }}>{(o.tipe_outlet||'').replace('(FastPay + FastKAI)','').trim()}</td>
                  <td className="writ-td" style={{ fontSize: 11, color: 'var(--text-3)' }}>{o.tanggal_registrasi}</td>
                  <td className="writ-td" style={{ textAlign: 'right' }}>{fmtN(o.trx_mei)}</td>
                  <td className="writ-td" style={{ textAlign: 'right', fontWeight: 700 }}>{fmtN(o.trx_juni)}</td>
                  <td className="writ-td" style={{ textAlign: 'right', fontSize: 12 }}>{fmtRp(o.rev_juni)}</td>
                  <td className={`writ-td ${dT.cls}`} style={{ textAlign: 'right', fontWeight: 600 }}>{dT.val}</td>
                  <td className={`writ-td ${dR.cls}`} style={{ textAlign: 'right', fontSize: 12 }}>{dR.val}</td>
                  <td className="writ-td"><WaLink notelp={o.notelp_pemilik} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Paginator page={page} total={filtered.length} pageSize={PAGE} onPage={setPage} />
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 2 — Analisis Upline
════════════════════════════════════════════ */
function UplineTab({ uplines }) {
  const [q, setQ]         = useState('');
  const [sortF, setSortF] = useState('trx_juni');
  const [sortD, setSortD] = useState('desc');

  const filtered = useMemo(() => {
    let d = (uplines||[]).filter(u => !q || (u.upline||'').toLowerCase().includes(q.toLowerCase()));
    return [...d].sort((a, b) => {
      const va = Number(a[sortF])||0, vb = Number(b[sortF])||0;
      return sortD === 'asc' ? va-vb : vb-va;
    });
  }, [uplines, q, sortF, sortD]);

  const onSort = f => { if (sortF===f) setSortD(d => d==='asc'?'desc':'asc'); else { setSortF(f); setSortD('desc'); } };
  const top10  = (uplines||[]).slice(0, 10);

  return (
    <div>
      <HBarChart labels={top10.map(u=>u.upline)} values={top10.map(u=>Number(u.trx_juni)||0)}
        title="Top Upline by TRX Juni" />
      <div className="writ-filter-bar" style={{ marginTop: 14 }}>
        <input className="writ-filter-input" placeholder="Cari ID Upline..." value={q} onChange={e => setQ(e.target.value)} />
        <span className="writ-filter-badge">{filtered.length} upline</span>
      </div>
      <div className="writ-table-wrap">
        <table className="writ-table">
          <thead><tr>
            <th className="writ-th">ID Upline</th>
            <SortTh label="Outlet"   field="outlet_count" sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="MAT"      field="mat"          sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="TRX Mei"  field="trx_mei"      sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="TRX Juni" field="trx_juni"     sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="Rev Juni" field="rev_juni"     sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="Dev TRX"  field="dev_trx"      sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="Dev Rev"  field="dev_rev"      sortF={sortF} sortD={sortD} onSort={onSort} right />
            <th className="writ-th" style={{textAlign:'right'}}>Act. Rate</th>
          </tr></thead>
          <tbody>
            {filtered.map(u => {
              const dT = fmtDev(u.dev_trx), dR = fmtDev(u.dev_rev);
              const actRate = u.outlet_count > 0 ? (Number(u.mat)/Number(u.outlet_count)*100).toFixed(1)+'%' : '-';
              return (
                <tr key={u.upline} className="writ-tr">
                  <td className="writ-td" style={{ fontFamily: 'monospace', color: COLOR }}>{u.upline}</td>
                  <td className="writ-td" style={{ textAlign: 'right' }}>{fmtN(u.outlet_count)}</td>
                  <td className="writ-td" style={{ textAlign: 'right' }}>{fmtN(u.mat)}</td>
                  <td className="writ-td" style={{ textAlign: 'right' }}>{fmtN(u.trx_mei)}</td>
                  <td className="writ-td" style={{ textAlign: 'right', fontWeight: 700 }}>{fmtN(u.trx_juni)}</td>
                  <td className="writ-td" style={{ textAlign: 'right', fontSize: 12 }}>{fmtRp(u.rev_juni)}</td>
                  <td className={`writ-td ${dT.cls}`} style={{ textAlign: 'right', fontWeight: 600 }}>{dT.val}</td>
                  <td className={`writ-td ${dR.cls}`} style={{ textAlign: 'right', fontSize: 12 }}>{dR.val}</td>
                  <td className="writ-td" style={{ textAlign: 'right', color: 'var(--text-2)' }}>{actRate}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 3 — Kota & Wilayah
════════════════════════════════════════════ */
function KotaTab({ kotas }) {
  const [sortF, setSortF] = useState('trx_juni');
  const [sortD, setSortD] = useState('desc');
  const data   = useMemo(() => [...(kotas||[])].sort((a,b) => {
    const va=Number(a[sortF])||0, vb=Number(b[sortF])||0;
    return sortD==='asc'?va-vb:vb-va;
  }), [kotas, sortF, sortD]);
  const onSort = f => { if(sortF===f) setSortD(d=>d==='asc'?'desc':'asc'); else {setSortF(f);setSortD('desc');} };

  return (
    <div>
      <HBarChart labels={(kotas||[]).slice(0,10).map(k=>k.nama_kota)} values={(kotas||[]).slice(0,10).map(k=>Number(k.trx_juni)||0)}
        title="Top 10 Kota by TRX Juni" />
      <div className="writ-table-wrap" style={{ marginTop: 14 }}>
        <table className="writ-table">
          <thead><tr>
            <th className="writ-th">Kota</th>
            <SortTh label="Outlet"   field="outlet_count" sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="MAT"      field="mat"          sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="TRX Juni" field="trx_juni"     sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="Rev Juni" field="rev_juni"     sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="Dev TRX"  field="dev_trx"      sortF={sortF} sortD={sortD} onSort={onSort} right />
            <th className="writ-th" style={{textAlign:'right'}}>Act. Rate</th>
          </tr></thead>
          <tbody>
            {data.map(k => {
              const dT = fmtDev(k.dev_trx);
              const actRate = k.outlet_count > 0 ? (Number(k.mat)/Number(k.outlet_count)*100).toFixed(1)+'%' : '-';
              return (
                <tr key={k.nama_kota} className="writ-tr">
                  <td className="writ-td">{k.nama_kota}</td>
                  <td className="writ-td" style={{textAlign:'right'}}>{fmtN(k.outlet_count)}</td>
                  <td className="writ-td" style={{textAlign:'right'}}>{fmtN(k.mat)}</td>
                  <td className="writ-td" style={{textAlign:'right',fontWeight:700}}>{fmtN(k.trx_juni)}</td>
                  <td className="writ-td" style={{textAlign:'right',fontSize:12}}>{fmtRp(k.rev_juni)}</td>
                  <td className={`writ-td ${dT.cls}`} style={{textAlign:'right',fontWeight:600}}>{dT.val}</td>
                  <td className="writ-td" style={{textAlign:'right',color:'var(--text-2)'}}>{actRate}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 4 — Tipe Outlet
════════════════════════════════════════════ */
function TipeTab({ tipes }) {
  const [sortF, setSortF] = useState('outlet_count');
  const [sortD, setSortD] = useState('desc');
  const data   = useMemo(() => [...(tipes||[])].sort((a,b) => {
    const va=Number(a[sortF])||0, vb=Number(b[sortF])||0;
    return sortD==='asc'?va-vb:vb-va;
  }), [tipes, sortF, sortD]);
  const onSort = f => { if(sortF===f) setSortD(d=>d==='asc'?'desc':'asc'); else {setSortF(f);setSortD('desc');} };

  const labels = (tipes||[]).map(t => (t.tipe_outlet||'-').replace('(FastPay + FastKAI)','').trim());

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <DonutChart labels={labels} values={(tipes||[]).map(t=>Number(t.outlet_count)||0)}
          colors={TIPE_COLORS} title="Jumlah Outlet per Tipe" />
        <DonutChart labels={labels} values={(tipes||[]).map(t=>Number(t.trx_juni)||0)}
          colors={TIPE_COLORS} title="Distribusi TRX per Tipe" />
      </div>
      <div className="writ-table-wrap" style={{ marginTop: 14 }}>
        <table className="writ-table">
          <thead><tr>
            <th className="writ-th">Tipe Outlet</th>
            <SortTh label="Outlet"   field="outlet_count" sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="MAT"      field="mat"          sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="TRX Juni" field="trx_juni"     sortF={sortF} sortD={sortD} onSort={onSort} right />
            <SortTh label="Rev Juni" field="rev_juni"     sortF={sortF} sortD={sortD} onSort={onSort} right />
            <th className="writ-th" style={{textAlign:'right'}}>Act. Rate</th>
          </tr></thead>
          <tbody>
            {data.map((t, i) => {
              const actRate = t.outlet_count > 0 ? (Number(t.mat)/Number(t.outlet_count)*100).toFixed(1)+'%' : '-';
              return (
                <tr key={t.tipe_outlet} className="writ-tr">
                  <td className="writ-td" style={{color:TIPE_COLORS[i%TIPE_COLORS.length]}}>{t.tipe_outlet}</td>
                  <td className="writ-td" style={{textAlign:'right'}}>{fmtN(t.outlet_count)}</td>
                  <td className="writ-td" style={{textAlign:'right'}}>{fmtN(t.mat)}</td>
                  <td className="writ-td" style={{textAlign:'right',fontWeight:700}}>{fmtN(t.trx_juni)}</td>
                  <td className="writ-td" style={{textAlign:'right',fontSize:12}}>{fmtRp(t.rev_juni)}</td>
                  <td className="writ-td" style={{textAlign:'right',color:'var(--text-2)'}}>{actRate}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 5 — Growth & Decline
════════════════════════════════════════════ */
function GrowthTab({ outlets }) {
  const [view, setView] = useState('growing');

  const growing  = useMemo(() => (outlets||[]).filter(o => Number(o.dev_trx)>0 && Number(o.trx_mei)>0).sort((a,b)=>Number(b.dev_trx)-Number(a.dev_trx)), [outlets]);
  const declining= useMemo(() => (outlets||[]).filter(o => Number(o.dev_trx)<0).sort((a,b)=>Number(a.dev_trx)-Number(b.dev_trx)), [outlets]);
  const newActive= useMemo(() => (outlets||[]).filter(o => Number(o.trx_mei)===0 && Number(o.trx_juni)>0).sort((a,b)=>Number(b.trx_juni)-Number(a.trx_juni)), [outlets]);
  const inactive = useMemo(() => (outlets||[]).filter(o => Number(o.trx_juni)===0), [outlets]);

  const CATS = [
    { key:'growing',  label:'📈 Growing',    count:growing.length,   data:growing,   color:'#059669', desc:'Aktif Mei & naik di Juni' },
    { key:'declining',label:'📉 Declining',  count:declining.length, data:declining, color:'#DC2626', desc:'Turun dari bulan lalu' },
    { key:'new',      label:'🌟 New Active', count:newActive.length, data:newActive, color:COLOR,     desc:'Pertama kali aktif di Juni' },
    { key:'inactive', label:'⚪ Belum Aktif',count:inactive.length,  data:inactive,  color:'#6B7280', desc:'TRX Juni = 0' },
  ];
  const cur = CATS.find(c=>c.key===view);

  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:14 }}>
        {CATS.map(c => (
          <div key={c.key} onClick={() => setView(c.key)}
            style={{ padding:'14px 16px', borderRadius:10, cursor:'pointer',
              border:`2px solid ${view===c.key ? c.color : 'var(--border)'}`,
              background: view===c.key ? c.color+'15' : 'var(--bg-card)' }}>
            <div style={{ fontSize:22, fontWeight:700, color:c.color }}>{fmtN(c.count)}</div>
            <div style={{ fontSize:13, fontWeight:600, color:'var(--text-1)', marginTop:2 }}>{c.label}</div>
            <div style={{ fontSize:11, color:'var(--text-3)', marginTop:3 }}>{c.desc}</div>
          </div>
        ))}
      </div>
      {cur && (
        <div className="writ-table-wrap">
          <table className="writ-table">
            <thead><tr>
              <th className="writ-th">ID Outlet</th>
              <th className="writ-th">Nama Pemilik</th>
              <th className="writ-th">Upline</th>
              <th className="writ-th">Kota</th>
              <th className="writ-th" style={{textAlign:'right'}}>TRX Mei</th>
              <th className="writ-th" style={{textAlign:'right'}}>TRX Juni</th>
              <th className="writ-th" style={{textAlign:'right'}}>Dev TRX</th>
              <th className="writ-th" style={{textAlign:'right'}}>Dev Rev</th>
              <th className="writ-th">WA</th>
            </tr></thead>
            <tbody>
              {cur.data.map(o => {
                const dT=fmtDev(o.dev_trx), dR=fmtDev(o.dev_rev);
                return (
                  <tr key={o.id_outlet} className="writ-tr">
                    <td className="writ-td" style={{fontFamily:'monospace',color:cur.color,fontSize:12}}>{o.id_outlet}</td>
                    <td className="writ-td writ-td-name">{o.nama_pemilik}</td>
                    <td className="writ-td" style={{color:'var(--text-3)',fontSize:12}}>{o.upline}</td>
                    <td className="writ-td" style={{fontSize:12}}>{o.nama_kota}</td>
                    <td className="writ-td" style={{textAlign:'right'}}>{fmtN(o.trx_mei)}</td>
                    <td className="writ-td" style={{textAlign:'right',fontWeight:700}}>{fmtN(o.trx_juni)}</td>
                    <td className={`writ-td ${dT.cls}`} style={{textAlign:'right',fontWeight:600}}>{dT.val}</td>
                    <td className={`writ-td ${dR.cls}`} style={{textAlign:'right',fontSize:12}}>{dR.val}</td>
                    <td className="writ-td"><WaLink notelp={o.notelp_pemilik} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════
   MAIN COMPONENT
════════════════════════════════════════════ */
export default function WarRoomBumdes() {
  const [analytics, setAnalytics] = useState(null);
  const [outlets,   setOutlets]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [tab,       setTab]       = useState(0);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true); setError(null);
        const [a, o] = await Promise.all([getBumdesAnalytics(), getBumdesOutlets()]);
        setAnalytics(a);
        setOutlets(o.outlets || []);
      } catch (e) {
        setError(e.message || 'Gagal memuat data');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const s = analytics?.summary || {};

  const tabContent = [
    <ExecutiveTab key={0} summary={s} lastSync={analytics?.last_sync} outlets={outlets} />,
    <OutletTab    key={1} outlets={outlets} />,
    <UplineTab    key={2} uplines={analytics?.uplines||[]} />,
    <KotaTab      key={3} kotas={analytics?.kotas||[]} />,
    <TipeTab      key={4} tipes={analytics?.tipes||[]} />,
    <GrowthTab    key={5} outlets={outlets} />,
  ];

  return (
    <Layout>
      <div className="wrfp-page">
        <div className="wrfp-header">
          <div className="wrfp-header-left">
            <i className="ti ti-building-community" style={{ color: COLOR, fontSize: 22 }} />
            <div>
              <div className="wrfp-header-title">WAR-ROOM TERRITORY BUMDES</div>
              <div className="wrfp-header-meta">
                Monitoring Outlet Badan Usaha Milik Desa · {fmtN(outlets.length)} outlet
              </div>
            </div>
          </div>
          <div className="wrfp-header-badges">
            <span className="wrfp-badge" style={{ background: COLOR }}>BUMDes</span>
            <span className="wrfp-badge" style={{ background: COLOR2 }}>JUNI 2026</span>
          </div>
        </div>

        <div className="wrfp-tabs">
          {TABS.map(t => (
            <button key={t.id} className={`wrfp-tab${tab===t.id ? ' wrfp-tab--active' : ''}`} onClick={() => setTab(t.id)}>
              <i className={`ti ${t.icon}`} /> {t.label}
            </button>
          ))}
        </div>

        {loading && <div className="wrfp-loading"><i className="ti ti-loader-2 wrfp-spin" /> Memuat data BUMDes...</div>}
        {error   && <div className="wrfp-error"><i className="ti ti-alert-circle" /> {error}</div>}
        {!loading && !error && outlets.length === 0 && (
          <div className="wrfp-empty">
            <i className="ti ti-building-community" style={{ color: COLOR }} />
            <div>Belum ada data outlet BUMDes</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Jalankan sync dari Apps Script terlebih dahulu</div>
          </div>
        )}
        {!loading && !error && (outlets.length > 0 || analytics) && tabContent[tab]}
      </div>
    </Layout>
  );
}
