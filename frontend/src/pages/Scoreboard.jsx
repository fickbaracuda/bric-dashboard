import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import { getScoreboard } from '../services/api';

/* ── Format helpers ── */
function fmtRev(n) {
  if (!n && n !== 0) return '—';
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return sign + 'Rp ' + (abs / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return sign + 'Rp ' + (abs / 1e9).toFixed(2) + 'M';
  if (abs >= 1e6)  return sign + 'Rp ' + (abs / 1e6).toFixed(0) + 'jt';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}
function fmtRevShort(n) {
  if (!n && n !== 0) return '—';
  const abs = Math.abs(n), sign = n < 0 ? '-' : '+';
  if (abs >= 1e12) return sign + 'Rp ' + (abs / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return sign + 'Rp ' + (abs / 1e9).toFixed(0) + 'M';
  if (abs >= 1e6)  return sign + 'Rp ' + (abs / 1e6).toFixed(0) + 'jt';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}
function barColor(s) {
  return { Aman:'#1D9E75', Waspada:'#F59E0B', Awas:'#EF4444', Kritis:'#DC2626' }[s] || '#9CA3AF';
}
function pillClass(s) {
  return { Aman:'pill-aman', Waspada:'pill-waspada', Awas:'pill-awas', Kritis:'pill-kritis' }[s] || 'pill-kritis';
}

/* ── Auto-generate CEO recommendation per unit ── */
function getRekomendasi(unit, daysLeft) {
  const k      = unit.est_kpi_juni;
  const status = unit.status;

  // Gap antara estimasi akhir bulan vs target RKAP
  const estRevJuni  = unit.est_rev_juni || 0;
  const gapRevJuni  = Math.max(unit.target_rkap - estRevJuni, 0);
  const dailyExtra  = daysLeft > 0 ? gapRevJuni / daysLeft : 0;

  // Gap revenue harian yang perlu ditambah vs rata-rata harian saat ini
  const currentDaily = unit.avg_rev_day || 0;
  const targetDaily  = unit.target_rkap / 30; // asumsi 30 hari/bulan

  if (status === 'Kritis') {
    if (k < 30) return {
      level: 'urgen',
      text: `🚨 URGEN: Est. KPI ${k.toFixed(1)}% — sangat jauh dari target. Butuh eskalasi ke manajemen. Evaluasi ulang strategi dan tim secara menyeluruh.`
    };
    return {
      level: 'tinggi',
      text: `Kritis di ${k.toFixed(1)}%. Perlu gap ${fmtRev(gapRevJuni)} tertutup di ${daysLeft} hari tersisa, setara tambahan ${fmtRev(dailyExtra)}/hari di atas pace saat ini. Review pipeline dan akselerasi closing deal prioritas.`
    };
  }
  if (status === 'Awas') {
    return {
      level: 'sedang',
      text: `Awas di ${k.toFixed(1)}%. Gap ke target ${fmtRev(gapRevJuni)} — butuh tambahan ${fmtRev(dailyExtra)}/hari di ${daysLeft} hari tersisa. Dorong aktivitas sales dan review hambatan utama.`
    };
  }
  if (status === 'Waspada') {
    return {
      level: 'pantau',
      text: `Waspada di ${k.toFixed(1)}%. Masih ada gap ${fmtRev(gapRevJuni)} ke target — perlu tambahan ${fmtRev(dailyExtra)}/hari di sisa ${daysLeft} hari. Pantau ketat dan jaga momentum.`
    };
  }
  return null;
}

/* ── Segmentation tier ── */
function getTier(k) {
  if (k >= 150) return { label: 'Luar Biasa', emoji: '🔥', cls: 'tier-s', color: '#1D9E75' };
  if (k >= 100) return { label: 'Aman',       emoji: '✅', cls: 'tier-a', color: '#059669' };
  if (k >= 80)  return { label: 'Waspada',    emoji: '⚡', cls: 'tier-b', color: '#F59E0B' };
  if (k >= 70)  return { label: 'Awas',       emoji: '🔶', cls: 'tier-c', color: '#EF4444' };
  return           { label: 'Kritis',      emoji: '🚨', cls: 'tier-d', color: '#DC2626' };
}

/* ── Components ── */
function ProgressBar({ pct, color }) {
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: Math.min(pct||0,100)+'%', background: color }} />
    </div>
  );
}

function SumCard({ label, main, sub, subColor }) {
  return (
    <div className="sum-card">
      <div className="sum-label">{label}</div>
      <div className="sum-main">{main}</div>
      {sub && <div className="sum-sub" style={{ color: subColor||'var(--text-4)' }}>{sub}</div>}
    </div>
  );
}

/* ── Alert Card per unit ── */
function AlertCard({ unit, daysLeft }) {
  const rec = getRekomendasi(unit, daysLeft);
  const pct = unit.target_rkap > 0 ? (unit.juni / unit.target_rkap) * 100 : 0;
  const gap = unit.target_rkap - (unit.est_rev_juni || unit.juni);
  const levelColor = { urgen:'#DC2626', tinggi:'#EF4444', sedang:'#F59E0B', pantau:'#F59E0B' };

  return (
    <div className={`alert-card alert-card--${unit.status?.toLowerCase()}`}>
      <div className="alert-card-top">
        <div className="alert-card-left">
          <span className={`pill ${pillClass(unit.status)}`}>{unit.status}</span>
          <span className="alert-card-nama">{unit.nama}</span>
        </div>
        <div className="alert-card-kpi" style={{ color: barColor(unit.status) }}>
          {unit.est_kpi_juni?.toFixed(2)}%
        </div>
      </div>
      <ProgressBar pct={pct} color={barColor(unit.status)} />
      <div className="alert-card-meta">
        <span>Rev: {fmtRev(unit.juni)}</span>
        <span>Target: {fmtRev(unit.target_rkap)}</span>
        {gap > 0 && <span style={{ color:'#DC2626' }}>Gap: {fmtRev(gap)}</span>}
      </div>
      {rec && (
        <div className="alert-card-rec" style={{ borderLeftColor: levelColor[rec.level] }}>
          💡 {rec.text}
        </div>
      )}
    </div>
  );
}

const BULAN_OPTIONS = ['JAN_2026','FEB_2026','MAR_2026','APR_2026','MEI_2026','JUN_2026'];
const FILTERS = ['Semua','Aman','Waspada','Awas','Kritis'];
const DAYS_IN_MONTH = { JAN:31,FEB:28,MAR:31,APR:30,MEI:31,JUN:30,JUL:31,AGU:31,SEP:30,OKT:31,NOV:30,DES:31 };

// Unit ESA yang sementara disembunyikan
const HIDDEN_UNITS = [
  'PAYMENT SWITCHING&BIG ENTERPRISE',
  'PSE',
  'GigaPulsa',
  'RETAIL,RECC&NICHE',
  'GOVERNMENT&BUMN',
  'LOCAL GOVERNMENT',
  'PAYMENT AGREGATOR',
  'B. TOTAL ESA'
];

export default function Scoreboard() {
  const [data,    setData]    = useState(null);
  const [metric,  setMetric]  = useState('kpi');
  const [bulan,   setBulan]   = useState('JUN_2026');
  const [filter,  setFilter]  = useState('Semua');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error,   setError]   = useState(null);
  const [toast,   setToast]   = useState('');

  const fetchData = (b, m) => {
    setLoading(true); setError(null);
    getScoreboard(b, m)
      .then(d  => { setData(d);          setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  };

  useEffect(() => { fetchData(bulan, metric); }, [bulan, metric]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const d = await getScoreboard(bulan, metric);
      setData(d);
      setToast('Data berhasil diperbarui');
      setTimeout(() => setToast(''), 3000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const allRows  = (data?.all_rows  || []).filter(r => !HIDDEN_UNITS.includes(r.nama));
  const rankings = (data?.rankings  || []).filter(u => !u.is_parent && !HIDDEN_UNITS.includes(u.nama));
  const daysElapsed = data?.days_elapsed || 0;
  const bulanLabel  = bulan.replace('_', ' ');
  const monthKey    = bulan.split('_')[0];
  const totalDays   = DAYS_IN_MONTH[monthKey] || 30;
  const daysLeft    = Math.max(totalDays - daysElapsed, 1);

  // Hitung ulang summary dari data yang sudah difilter (Business Retail only)
  const filteredUnits  = allRows.filter(r => !r.is_subtotal && !r.is_parent);
  const retailTotalRow = allRows.find(r => r.nama === 'A. TOTAL BUSINESS RETAIL');
  const revJuni        = filteredUnits.reduce((sum, u) => sum + (u.juni || 0), 0);
  const revMei         = filteredUnits.reduce((sum, u) => sum + (u.mei  || 0), 0);

  const s = {
    revenue_juni:    revJuni,
    revenue_mei:     revMei,
    delta_vs_mei:    revJuni - revMei,
    avg_rev_hari:    retailTotalRow?.avg_rev_day || (daysElapsed > 0 ? revJuni / daysElapsed : 0),
    est_kpi_juni:    retailTotalRow?.est_kpi_juni ?? (data?.summary?.est_kpi_juni || 0),
    real_kpi:        retailTotalRow?.real_kpi     ?? (data?.summary?.real_kpi     || 0),
    unit_total:      filteredUnits.length,
    unit_aman:       filteredUnits.filter(u => u.status === 'Aman').length,
    unit_waspada:    filteredUnits.filter(u => u.status === 'Waspada').length,
    unit_awas:       filteredUnits.filter(u => u.status === 'Awas').length,
    unit_kritis:     filteredUnits.filter(u => u.status === 'Kritis').length,
    rata_rata_est_kpi: filteredUnits.length
      ? parseFloat((filteredUnits.reduce((sum,u) => sum+(u.est_kpi_juni||0),0) / filteredUnits.length).toFixed(2))
      : 0,
  };

  // Units yang butuh perhatian: Kritis dulu, lalu Awas, lalu Waspada (exclude parent)
  const statusOrder = { Kritis: 0, Awas: 1, Waspada: 2 };
  const attentionUnits = rankings
    .filter(u => (u.status === 'Kritis' || u.status === 'Awas' || u.status === 'Waspada') && !u.is_parent)
    .sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

  // Top performers
  const topPerformers = [...rankings]
    .filter(u => u.status === 'Aman')
    .sort((a, b) => b.est_kpi_juni - a.est_kpi_juni)
    .slice(0, 5);

  // Segmentation
  const tiers = [
    { key:'a', label:'Aman ✅',    desc:'Est KPI ≥ 100%', color:'#1D9E75', bg:'#E6FAF4', units: rankings.filter(u=>u.est_kpi_juni>=100) },
    { key:'b', label:'Waspada ⚡',     desc:'Est KPI 80–99%',  color:'#D97706', bg:'#FEF3C7', units: rankings.filter(u=>u.est_kpi_juni>=80&&u.est_kpi_juni<100) },
    { key:'c', label:'Awas 🔶',        desc:'Est KPI 70–79%',  color:'#DC2626', bg:'#FEE2E2', units: rankings.filter(u=>u.est_kpi_juni>=70&&u.est_kpi_juni<80) },
    { key:'d', label:'Kritis 🚨',      desc:'Est KPI < 70%',   color:'#991B1B', bg:'#FEE2E2', units: rankings.filter(u=>u.est_kpi_juni<70) },
  ].filter(t => t.units.length > 0);

  // Table rows — parent rows always shown, filter only non-parent non-subtotal
  const tableRows = allRows.filter(r => {
    if (filter === 'Semua') return true;
    // Saat filter aktif: sembunyikan subtotal & parent, tampilkan unit yang cocok saja
    if (r.is_subtotal || r.is_parent) return false;
    return r.status?.toLowerCase() === filter.toLowerCase();
  });

  return (
    <Layout syncedAt={data?.synced_at} bulan={bulan}>

      {/* Toast notification */}
      {toast && <div className="toast-success">✓ {toast}</div>}

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Pencapaian Bisnis — {bulanLabel}</h1>
          <p className="page-sub">
            Data per 1–{daysElapsed} {bulanLabel} · {s.unit_total||0} unit aktif · {daysLeft} hari tersisa
          </p>
        </div>
        <div className="header-controls">
          <select className="select-input" value={bulan} onChange={e => setBulan(e.target.value)}>
            {BULAN_OPTIONS.map(b => <option key={b} value={b}>{b.replace('_',' ')}</option>)}
          </select>
          <div className="metric-toggle">
            <button className={`metric-btn${metric==='kpi'?' metric-btn--active':''}`} onClick={()=>setMetric('kpi')}>Est % KPI</button>
            <button className={`metric-btn${metric==='rev'?' metric-btn--active':''}`} onClick={()=>setMetric('rev')}>Revenue</button>
          </div>
          <button className="sync-btn" onClick={handleSync} disabled={syncing}>
            <span className={syncing ? 'spin' : ''}>↻</span>
            {syncing ? 'Memuat...' : 'Sync Data'}
          </button>
        </div>
      </div>

      {error && <div className="alert-error">⚠ {error}</div>}

      {loading ? (
        <div className="skeleton-grid">{[...Array(6)].map((_,i)=><div key={i} className="skeleton-card"/>)}</div>
      ) : (
        <>
          {/* ── Summary ── */}
          <div className="sum-grid">
            <SumCard label="REVENUE JUNI" main={fmtRev(s.revenue_juni)}
              sub={s.delta_vs_mei ? fmtRevShort(s.delta_vs_mei)+' vs Mei' : null}
              subColor={s.delta_vs_mei>=0?'#1D9E75':'#EF4444'} />
            <SumCard label="AVG REV / HARI" main={fmtRev(s.avg_rev_hari)} sub={`${daysElapsed} hari berjalan`} />
            <SumCard label="EST % KPI JUNI"
              main={<span style={{color:s.est_kpi_juni>=100?'#1D9E75':'#EF4444'}}>{s.est_kpi_juni?.toFixed(2)}%</span>}
              sub={s.est_kpi_juni>=100?'↗ Di atas target':'↘ Di bawah target'}
              subColor={s.est_kpi_juni>=100?'#1D9E75':'#EF4444'} />
            <SumCard label="REAL % KPI" main={s.real_kpi?.toFixed(2)+'%'} sub="Akumulasi berjalan" />
            <SumCard label="UNIT AMAN"
              main={<span style={{color:'#1D9E75',fontSize:'28px',fontWeight:800}}>{s.unit_aman}</span>}
              sub={`dari ${s.unit_total} unit`} />
            <SumCard label="UNIT KRITIS"
              main={<span style={{color:'#DC2626',fontSize:'28px',fontWeight:800}}>{s.unit_kritis}</span>}
              sub="Perlu perhatian segera" subColor="#DC2626" />
          </div>

          {/* ══════════════════════════════════════
              SEGMENTASI PERFORMA
          ══════════════════════════════════════ */}
          <section className="section">
            <h2 className="section-title">📊 Segmentasi Performa Unit</h2>
            <div className="tier-grid">
              {tiers.map(t => (
                <div key={t.key} className="tier-card" style={{borderTopColor:t.color, background:t.bg+'33'}}>
                  <div className="tier-header">
                    <span className="tier-label" style={{color:t.color}}>{t.label}</span>
                    <span className="tier-count" style={{background:t.bg,color:t.color}}>{t.units.length} unit</span>
                  </div>
                  <div className="tier-desc">{t.desc}</div>
                  <div className="tier-units">
                    {t.units.map(u => (
                      <div key={u.nama} className="tier-unit-row">
                        <span className="tier-unit-nama">{u.nama}</span>
                        <span className="tier-unit-kpi" style={{color:t.color}}>{u.est_kpi_juni?.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ══════════════════════════════════════
              TOP PERFORMER
          ══════════════════════════════════════ */}
          {topPerformers.length > 0 && (
            <section className="section">
              <div className="insight-row">
                <div className="insight-card">
                  <div className="insight-title"><span>🏆</span> Top Performer — Est % KPI</div>
                  <div className="insight-list">
                    {topPerformers.map((u,i) => (
                      <div key={u.nama} className="insight-item">
                        <span className="insight-rank">{i===0?'🥇':i===1?'🥈':i===2?'🥉':i+1}</span>
                        <span className="insight-nama">{u.nama}</span>
                        <span className="insight-val insight-val--green">{u.est_kpi_juni?.toFixed(2)}%</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="insight-card">
                  <div className="insight-title"><span>📈</span> Ringkasan Eksekutif</div>
                  <div className="exec-summary">
                    <div className="exec-item">
                      <span className="exec-dot" style={{background:'#1D9E75'}} />
                      <span>{s.unit_aman} unit on-track, berkontribusi pada pertumbuhan bisnis</span>
                    </div>
                    <div className="exec-item">
                      <span className="exec-dot" style={{background:'#DC2626'}} />
                      <span>{s.unit_kritis} unit kritis — risiko gagal target bulan ini</span>
                    </div>
                    {s.est_kpi_juni < 100 && (
                      <div className="exec-item">
                        <span className="exec-dot" style={{background:'#F59E0B'}} />
                        <span>Overall est. KPI {s.est_kpi_juni?.toFixed(1)}% — di bawah target, perlu akselerasi</span>
                      </div>
                    )}
                    {s.est_kpi_juni >= 100 && (
                      <div className="exec-item">
                        <span className="exec-dot" style={{background:'#1D9E75'}} />
                        <span>Overall est. KPI {s.est_kpi_juni?.toFixed(1)}% — on track mencapai target bulan ini</span>
                      </div>
                    )}
                    <div className="exec-item">
                      <span className="exec-dot" style={{background:'#6366F1'}} />
                      <span>Avg Rev/hari {fmtRev(s.avg_rev_hari)} · sisa {daysLeft} hari untuk akselerasi</span>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* ══════════════════════════════════════
              TABEL DETAIL
          ══════════════════════════════════════ */}
          <section className="section">
            <div className="table-header-row">
              <h2 className="section-title" style={{marginBottom:0}}>Detail Pencapaian Per Poin</h2>
              <div className="filter-tabs">
                {FILTERS.map(f => (
                  <button key={f}
                    className={`filter-tab${filter===f?' filter-tab--active':''}`}
                    onClick={()=>setFilter(f)}>{f}</button>
                ))}
              </div>
            </div>
            <div className="table-wrap" style={{marginTop:14}}>
              <table className="ranking-table">
                <thead>
                  <tr>
                    <th>POIN / UNIT</th><th>REV JUNI</th><th>TARGET RKAP</th>
                    <th>EST REV JUNI</th><th>REAL KPI</th>
                    <th style={{minWidth:120}}>PROGRES</th><th>EST KPI</th><th>STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((row,i) => {
                    const pct = row.target_rkap>0?(row.juni/row.target_rkap)*100:0;
                    const isTotal  = row.nama==='REVENUE BISNIS BMS';
                    const isSub    = row.is_subtotal && !isTotal;
                    const isParent = row.is_parent;
                    return (
                      <tr key={i} className={`table-row${isTotal?' row-total':isSub?' row-subtotal':isParent?' row-parent':''}`}>
                        <td className={`td-nama${isTotal?' td-nama--total':isSub?' td-nama--sub':isParent?' td-nama--parent':''}`}>
                          {isParent && <span className="parent-badge">GROUP</span>}
                          {row.nama}
                        </td>
                        <td>{fmtRev(row.juni)}</td>
                        <td>{fmtRev(row.target_rkap)}</td>
                        <td>{fmtRev(row.est_rev_juni)}</td>
                        <td>{row.real_kpi?.toFixed(2)}%</td>
                        <td><ProgressBar pct={pct} color={barColor(row.status)} /></td>
                        <td><strong style={{color:row.est_kpi_juni>=100?'#1D9E75':row.est_kpi_juni>=80?'#F59E0B':'#EF4444'}}>{row.est_kpi_juni?.toFixed(2)}%</strong></td>
                        <td>
                          {!isSub&&!isTotal&&!isParent
                            ? <span className={`pill ${pillClass(row.status)}`}>{row.status}</span>
                            : <span style={{fontWeight:600,color:barColor(row.status)}}>{row.status}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* ══════════════════════════════════════
              PRIORITAS PERHATIAN (di bawah tabel)
          ══════════════════════════════════════ */}
          {attentionUnits.length > 0 && (
            <section className="section">
              <div className="section-header-row">
                <div>
                  <h2 className="section-title" style={{marginBottom:2}}>🚨 Prioritas Perhatian</h2>
                  <p className="section-desc">{attentionUnits.length} unit membutuhkan tindakan · {daysLeft} hari tersisa di bulan ini</p>
                </div>
                <div className="attention-legend">
                  {['Kritis','Awas','Waspada'].map(st => (
                    <span key={st} className={`pill ${pillClass(st)}`} style={{fontSize:11}}>
                      {st}: {rankings.filter(u=>u.status===st).length} unit
                    </span>
                  ))}
                </div>
              </div>
              <div className="alert-cards-grid">
                {attentionUnits.map(u => (
                  <AlertCard key={u.nama} unit={u} daysLeft={daysLeft} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </Layout>
  );
}
