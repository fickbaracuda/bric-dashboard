import { useState, useEffect, useRef, useMemo } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getToken } from '../utils/auth';

const authHdr = () => ({ Authorization: `Bearer ${getToken()}` });
const API     = '/api/data-raw/outlet-analytics';
const COLOR   = '#2563EB';
const THEME2  = '#059669';

const SEG_COLOR = {
  superstar:  '#7C3AED', tumbuh:     '#059669', stabil:     '#3B82F6',
  turun:      '#F59E0B', at_risk:    '#EF4444', churn:      '#DC2626',
  baru_aktif: '#10B981', reaktivasi: '#F97316',
};
const SEG_LABEL = {
  superstar: 'Superstar', tumbuh: 'Tumbuh', stabil: 'Stabil', turun: 'Turun',
  at_risk: 'At Risk', churn: 'Churn', baru_aktif: 'Baru Aktif', reaktivasi: 'Reaktivasi',
};
const SEG_ORDER = ['superstar','tumbuh','stabil','turun','at_risk','churn','baru_aktif','reaktivasi'];
const SEG_DESC = {
  superstar:  'TRX & Margin di atas P75 — revenue driver utama',
  tumbuh:     'Growth TRX ≥ 20% bulan ini vs bulan lalu',
  stabil:     'Aktif dengan pertumbuhan -10% s/d +20% — konsisten',
  turun:      'Penurunan TRX 10–25% — perlu perhatian',
  at_risk:    'Penurunan TRX > 25% — hampir churn',
  churn:      'Aktif bulan lalu, 0 TRX bulan ini — sudah churn',
  baru_aktif: 'Pertama kali TRX bulan ini — outlet baru',
  reaktivasi: 'Tidak aktif 2 bulan, kini aktif kembali',
};
const SEG_ACTION = {
  superstar:  'Reward loyalitas, jadikan brand ambassador, ambil testimonial.',
  tumbuh:     'Push lebih keras! Hubungi untuk akselerasi. Berikan target lebih tinggi.',
  stabil:     'Pertahankan. Edukasi produk tambahan untuk tingkatkan margin.',
  turun:      'Engagement! Cek hambatan, kampanye buyer di area outlet.',
  at_risk:    'Reactivation call. Kunjungi langsung, tawarkan promo khusus.',
  churn:      'Recovery campaign. Visit fisik, identifikasi masalah, ajukan solusi.',
  baru_aktif: 'Dampingi onboarding. Pastikan transaksi kedua terjadi dalam 7 hari.',
  reaktivasi: 'Sambut kembali! Berikan insentif reaktivasi, jadikan prioritas bulan ini.',
};
const TERR_COLOR = {
  'Jawa': '#7C3AED', 'Sumatera': '#0EA5E9', 'Kalimantan': '#F59E0B',
  'Sulawesi': '#10B981', 'Bali & Nusa Tenggara': '#EF4444',
  'Maluku': '#EC4899', 'Papua': '#059669', 'Lainnya': '#94A3B8',
};
const TABS = [
  { id: 0, icon: 'ti-dashboard',        label: 'Executive'  },
  { id: 1, icon: 'ti-table',            label: 'Outlet'     },
  { id: 2, icon: 'ti-layers-intersect', label: 'Segmentasi' },
  { id: 3, icon: 'ti-calendar-stats',   label: 'Trend'      },
  { id: 4, icon: 'ti-tag',              label: 'Kategori'   },
  { id: 5, icon: 'ti-map-pin',          label: 'Territory'  },
  { id: 6, icon: 'ti-trending-up',      label: 'Growth'     },
  { id: 7, icon: 'ti-target',           label: 'Action'     },
  { id: 8, icon: 'ti-download',         label: 'Export'     },
];

/* ─── helpers ─── */
const fmtN   = v => (Number(v) || 0).toLocaleString('id');
const fmtRp  = v => 'Rp ' + (Number(v) || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });
const fmtPct = v => (v == null ? '–' : (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%');
const devColor = v => v > 0 ? '#059669' : v < 0 ? '#DC2626' : '#9CA3AF';
const scoreClass = v => Number(v) >= 70 ? 'writ-score-high' : Number(v) >= 40 ? 'writ-score-mid' : 'writ-score-low';

function computePerfScore(o, thr, maxDay) {
  if (!o.jun_trx) return 0;
  const trxScore  = Math.min(30, (o.jun_trx / (thr.trx_p90 || 1)) * 30);
  const growScore = o.growth_pct !== null
    ? Math.max(0, Math.min(25, ((o.growth_pct + 50) / 150) * 25))
    : 12.5;
  const conScore  = maxDay > 0 ? Math.min(25, (o.days_active / maxDay) * 25) : 0;
  const mptScore  = thr.avg_mpt > 0 ? Math.min(20, (o.mpt / (thr.avg_mpt * 2)) * 20) : 0;
  return Math.round(trxScore + growScore + conScore + mptScore);
}

function buildSummary(outlets) {
  const aktif   = outlets.filter(o => o.jun_trx > 0);
  const totTrx  = aktif.reduce((s, o) => s + o.jun_trx,    0);
  const totMgn  = aktif.reduce((s, o) => s + o.jun_margin, 0);
  const churn   = outlets.filter(o => o.segment === 'churn').length;
  const supers  = outlets.filter(o => o.segment === 'superstar').length;
  const tumbuh  = outlets.filter(o => o.segment === 'tumbuh').length;
  const baru    = outlets.filter(o => o.segment === 'baru_aktif').length;
  const atRisk  = outlets.filter(o => o.segment === 'at_risk').length;
  return { aktif: aktif.length, totTrx, totMgn, churn, supers, tumbuh, baru, atRisk };
}

function buildInsights(outlets, s, mtd) {
  if (!outlets.length) return { paragraph: '', recs: [] };
  const paragraph = `Total ${fmtN(outlets.length)} outlet tercatat, ${fmtN(s.aktif)} aktif ${mtd?.b1_label || ''}. Churn: ${fmtN(s.churn)} outlet | Baru Aktif: ${fmtN(s.baru)} | Superstar: ${fmtN(s.supers)} | At Risk: ${fmtN(s.atRisk)}.`;
  const recs = [];
  if (s.churn > 0)   recs.push({ lv: 'high',   title: `Recovery ${fmtN(s.churn)} Churn`,         text: 'Outlet aktif bulan lalu kini 0 TRX. Hubungi langsung — jangan biarkan >7 hari tanpa follow-up.' });
  if (s.atRisk > 0)  recs.push({ lv: 'high',   title: `${fmtN(s.atRisk)} Outlet At Risk`,        text: 'TRX turun >25%. Engagement segera — promo, edukasi, atau kunjungan langsung.' });
  if (s.supers > 0)  recs.push({ lv: 'medium', title: `Reward ${fmtN(s.supers)} Superstar`,      text: 'Berikan reward loyalitas, ambil testimonial, jadikan brand ambassador.' });
  if (s.baru > 0)    recs.push({ lv: 'medium', title: `Dampingi ${fmtN(s.baru)} Outlet Baru`,    text: 'Pastikan onboarding lancar dan transaksi kedua terjadi dalam 7 hari.' });
  if (s.tumbuh > 0)  recs.push({ lv: 'medium', title: `Akselerasi ${fmtN(s.tumbuh)} Tumbuh`,     text: 'Berikan target lebih tinggi dan insentif pertumbuhan.' });
  return { paragraph, recs: recs.slice(0, 5) };
}

/* ─── Chart components ─── */
function DonutChart({ id, labels, values, colors }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const c = new Chart(ref.current, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { font: { size: 10 }, padding: 8, boxWidth: 10 } } } },
    });
    return () => c.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function HBarChart({ id, labels, values, color, fmt }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const c = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: color || COLOR, borderRadius: 3 }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => fmt ? fmt(ctx.parsed.x) : fmtN(ctx.parsed.x) } } },
        scales: { x: { ticks: { font: { size: 10 } } }, y: { ticks: { font: { size: 11 } } } },
      },
    });
    return () => c.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function GroupedBarChart({ id, labels, datasets }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const c = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: datasets.map(d => ({ ...d, borderRadius: 4 })) },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, padding: 8 } },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtN(ctx.parsed.y)}` } } },
        scales: { x: { ticks: { font: { size: 10 } } }, y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 10 } } } },
      },
    });
    return () => c.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function LineChart({ id, labels, datasets }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const c = new Chart(ref.current, {
      type: 'line',
      data: { labels, datasets },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 10 } },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtN(ctx.parsed.y)}` } } },
        scales: {
          x: { ticks: { font: { size: 10 }, maxRotation: 0 } },
          y: { ticks: { font: { size: 10 }, callback: v => fmtN(v) }, grid: { color: '#f0f0f0' } },
        },
      },
    });
    return () => c.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

/* ─── Shared UI ─── */
function KPICard({ label, value, sub, badge, badgeColor }) {
  return (
    <div className="wrfp-kpi-card">
      <div className="wrfp-kpi-label">{label}</div>
      <div className="wrfp-kpi-value">
        {value}
        {badge && <span className="wrfp-kpi-badge" style={{ background: badgeColor || COLOR }}>{badge}</span>}
      </div>
      {sub && <div className="wrfp-kpi-sub">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, children, height = 220 }) {
  return (
    <div className="wrfp-chart-card">
      {title && <div className="wrfp-chart-title">{title}</div>}
      <div className="wrfp-chart-box" style={{ height }}>{children}</div>
    </div>
  );
}

function SegBadge({ seg }) {
  return (
    <span style={{ display:'inline-flex', alignItems:'center', padding:'2px 8px', borderRadius:12, fontSize:10, fontWeight:600, color:'#fff', background: SEG_COLOR[seg] || '#94A3B8' }}>
      {SEG_LABEL[seg] || seg}
    </span>
  );
}

function SortTh({ field, label, sortF, sortD, onSort, style }) {
  const active = sortF === field;
  return (
    <th className={`writ-th${active ? ' writ-th--active' : ''}`} onClick={() => onSort(field)} style={style}>
      {label} {active && (sortD === 'asc' ? '↑' : '↓')}
    </th>
  );
}

function Paginator({ total, page, pageSize, setPage }) {
  const pages = Math.ceil(total / pageSize) || 1;
  return (
    <div className="writ-pagination">
      <button className="writ-pag-btn" onClick={() => setPage(1)} disabled={page <= 1}>«</button>
      <button className="writ-pag-btn" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>‹</button>
      <span className="writ-pag-info">Hal {page}/{pages} · {fmtN(total)} data</span>
      <button className="writ-pag-btn" onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page >= pages}>›</button>
      <button className="writ-pag-btn" onClick={() => setPage(pages)} disabled={page >= pages}>»</button>
    </div>
  );
}

function InsightBlock({ outlets, s, mtd }) {
  const ins = buildInsights(outlets, s, mtd);
  if (!ins.paragraph) return null;
  const LVL = {
    high:   { label: 'Prioritas Tinggi', bg: '#FEE2E2', border: '#DC2626', color: '#DC2626' },
    medium: { label: 'Prioritas Sedang', bg: '#F0FDF4', border: '#10B981', color: '#059669' },
  };
  return (
    <div className="wrfp-insight-block">
      <div className="wrfp-exec-card">
        <div className="wrfp-exec-header"><i className="ti ti-report-analytics" style={{ color: COLOR }} /> Ringkasan Eksekutif</div>
        <p className="wrfp-exec-text">{ins.paragraph}</p>
      </div>
      {ins.recs.length > 0 && (
        <div className="wrfp-exec-card">
          <div className="wrfp-exec-header"><i className="ti ti-bulb" style={{ color: COLOR }} /> Rekomendasi Tindakan</div>
          <div className="wrfp-recs-list">
            {ins.recs.map((r, i) => {
              const lv = LVL[r.lv] || LVL.medium;
              return (
                <div key={i} className="wrfp-rec-item" style={{ borderLeft: `3px solid ${lv.border}`, background: lv.bg }}>
                  <div className="wrfp-rec-top">
                    <span className="wrfp-rec-title">{r.title}</span>
                    <span className="wrfp-rec-level" style={{ color: lv.color }}>{lv.label}</span>
                  </div>
                  <p className="wrfp-rec-text">{r.text}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 0 — Executive Summary
════════════════════════════════════════════ */
function ExecutiveTab({ outlets, summary, mtd, thr }) {
  const chartId = outlets.length;
  const s = summary;

  const segData = useMemo(() => {
    const m = {};
    outlets.forEach(o => { m[o.segment] = (m[o.segment] || 0) + 1; });
    return SEG_ORDER.filter(k => m[k] > 0).map(k => ({ key: k, count: m[k] }));
  }, [outlets]);

  const provData = useMemo(() => {
    const m = {};
    outlets.filter(o => o.jun_trx > 0).forEach(o => {
      const p = o.provinsi || 'N/A';
      if (!m[p]) m[p] = { count: 0, trx: 0 };
      m[p].count++; m[p].trx += o.jun_trx;
    });
    return Object.entries(m).sort((a, b) => b[1].count - a[1].count).slice(0, 10)
      .map(([p, v]) => ({ provinsi: p, ...v }));
  }, [outlets]);

  const cohortData = useMemo(() => {
    const m = {};
    outlets.forEach(o => {
      const yr = o.tgl_aktivasi ? o.tgl_aktivasi.slice(0, 4) : 'N/A';
      if (!m[yr]) m[yr] = { yr, total: 0, aktif: 0, churn: 0, superstar: 0, trx: 0 };
      m[yr].total++;
      if (o.jun_trx > 0) m[yr].aktif++;
      if (o.segment === 'churn')     m[yr].churn++;
      if (o.segment === 'superstar') m[yr].superstar++;
      m[yr].trx += o.jun_trx;
    });
    return Object.values(m).sort((a, b) => a.yr.localeCompare(b.yr));
  }, [outlets]);

  return (
    <>
      <div className="wrfp-kpi-grid">
        <KPICard label="Outlet Aktif" value={fmtN(s.aktif)}
          sub={`dari ${fmtN(outlets.length)} total outlet`} />
        <KPICard label="Total TRX" value={fmtN(s.totTrx)}
          sub={`avg ${fmtN(Math.round(s.totTrx / (s.aktif || 1)))} per outlet`} />
        <KPICard label="Total Margin" value={fmtRp(s.totMgn)}
          sub={`avg MPT Rp ${fmtN(Math.round(s.totMgn / (s.totTrx || 1)))}`} />
        <KPICard label="Superstar" value={fmtN(s.supers)}
          sub="TRX & Margin ≥ P75" badge="★" badgeColor="#7C3AED" />
        <KPICard label="Churn" value={fmtN(s.churn)}
          sub="Aktif lalu, 0 TRX kini"
          badge={s.churn > 0 ? '!' : '✓'} badgeColor={s.churn > 0 ? '#DC2626' : '#059669'} />
        <KPICard label="Tumbuh ≥20%" value={fmtN(s.tumbuh)}
          sub="Growth positif bulan ini" badge="▲" badgeColor="#059669" />
      </div>

      <div className="wrfp-charts-2col">
        <ChartCard title="🎯 Distribusi Segmentasi Outlet">
          <DonutChart id={`seg-${chartId}`}
            labels={segData.map(d => SEG_LABEL[d.key])}
            values={segData.map(d => d.count)}
            colors={segData.map(d => SEG_COLOR[d.key])} />
        </ChartCard>
        <ChartCard title="🗺️ Top 10 Provinsi (Outlet Aktif)">
          <HBarChart id={`prov-${chartId}`}
            labels={provData.map(p => p.provinsi)}
            values={provData.map(p => p.count)}
            color={COLOR} />
        </ChartCard>
      </div>

      {cohortData.length > 1 && (
        <ChartCard title="📊 Cohort Outlet per Tahun Aktivasi" height={240}>
          <GroupedBarChart id={`cohort-${chartId}`}
            labels={cohortData.map(c => c.yr)}
            datasets={[
              { label: 'Total Outlet', data: cohortData.map(c => c.total), backgroundColor: '#CBD5E1' },
              { label: 'Aktif',        data: cohortData.map(c => c.aktif), backgroundColor: '#10B981' },
              { label: 'Superstar',    data: cohortData.map(c => c.superstar), backgroundColor: '#7C3AED' },
              { label: 'Churn',        data: cohortData.map(c => c.churn),  backgroundColor: '#DC2626' },
            ]} />
        </ChartCard>
      )}

      <InsightBlock outlets={outlets} s={s} mtd={mtd} />
    </>
  );
}

/* ════════════════════════════════════════════
   TAB 1 — Outlet Master
════════════════════════════════════════════ */
function OutletTab({ outlets, thr, maxDay }) {
  const [q, setQ]         = useState('');
  const [fSeg, setFSeg]   = useState('');
  const [fTerr, setFTerr] = useState('');
  const [fKat, setFKat]   = useState('');
  const [sortF, setSortF] = useState('jun_trx');
  const [sortD, setSortD] = useState('desc');
  const [page, setPage]   = useState(1);
  const PS = 50;

  const territories = useMemo(() => [...new Set(outlets.map(o => o.territory_cluster).filter(Boolean))].sort(), [outlets]);
  const kategories  = useMemo(() => [...new Set(outlets.map(o => o.kategori).filter(Boolean))].sort(), [outlets]);

  const enriched = useMemo(() => outlets.map(o => ({
    ...o, perf_score: computePerfScore(o, thr, maxDay),
  })), [outlets, thr, maxDay]);

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return enriched.filter(o =>
      (!ql || o.id_outlet.toLowerCase().includes(ql) || (o.nama_merchant || '').toLowerCase().includes(ql) || (o.kota || '').toLowerCase().includes(ql)) &&
      (!fSeg  || o.segment === fSeg) &&
      (!fTerr || o.territory_cluster === fTerr) &&
      (!fKat  || o.kategori === fKat)
    ).sort((a, b) => {
      const va = a[sortF], vb = b[sortF], d = sortD === 'asc' ? 1 : -1;
      if (va == null) return 1; if (vb == null) return -1;
      return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
    });
  }, [enriched, q, fSeg, fTerr, fKat, sortF, sortD]);

  const paged = filtered.slice((page - 1) * PS, page * PS);
  const sort = f => { if (sortF === f) setSortD(d => d === 'asc' ? 'desc' : 'asc'); else { setSortF(f); setSortD('desc'); } setPage(1); };
  const reset = () => { setQ(''); setFSeg(''); setFTerr(''); setFKat(''); setPage(1); };

  return (
    <div>
      <div className="writ-filter-bar">
        <input className="writ-filter-input" placeholder="🔍 Cari ID Outlet, Nama, atau Kota..." value={q}
          onChange={e => { setQ(e.target.value); setPage(1); }} />
        <select className="writ-filter-select" value={fSeg} onChange={e => { setFSeg(e.target.value); setPage(1); }}>
          <option value="">Semua Segmen</option>
          {SEG_ORDER.map(k => <option key={k} value={k}>{SEG_LABEL[k]}</option>)}
        </select>
        <select className="writ-filter-select" value={fTerr} onChange={e => { setFTerr(e.target.value); setPage(1); }}>
          <option value="">Semua Territory</option>
          {territories.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="writ-filter-select" value={fKat} onChange={e => { setFKat(e.target.value); setPage(1); }}>
          <option value="">Semua Kategori</option>
          {kategories.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <span className="writ-filter-badge">{fmtN(filtered.length)} outlet</span>
        {(q || fSeg || fTerr || fKat) && <button className="writ-filter-clear" onClick={reset}>Reset</button>}
      </div>
      <div className="writ-table-wrap">
        <table className="writ-table">
          <thead>
            <tr>
              <th className="writ-th" style={{ width: 32 }}>#</th>
              {[
                ['id_outlet',       'ID Outlet'],
                ['nama_merchant',   'Nama'],
                ['kategori',        'Kategori'],
                ['kota',            'Kota'],
                ['provinsi',        'Provinsi'],
                ['jun_trx',         'TRX Juni'],
                ['mei_trx',         'TRX Mei'],
                ['growth_pct',      'Growth%'],
                ['jun_margin',      'Margin Juni'],
                ['mpt',             'MPT'],
                ['consistency_pct', 'Konsistensi'],
                ['perf_score',      'Score'],
              ].map(([f, l]) => <SortTh key={f} field={f} label={l} sortF={sortF} sortD={sortD} onSort={sort} />)}
              <th className="writ-th">Segmen</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((o, i) => (
              <tr key={o.id_outlet} className="writ-tr">
                <td className="writ-td" style={{ color: 'var(--text-3)' }}>{(page - 1) * PS + i + 1}</td>
                <td className="writ-td" style={{ fontFamily: 'monospace', fontSize: 11 }}>{o.id_outlet}</td>
                <td className="writ-td writ-td-name" style={{ fontWeight: 500, color: 'var(--text-1)' }} title={o.nama_merchant}>{o.nama_merchant}</td>
                <td className="writ-td" style={{ color: 'var(--text-3)', fontSize: 11 }}>{o.kategori}</td>
                <td className="writ-td">{o.kota}</td>
                <td className="writ-td">{o.provinsi}</td>
                <td className="writ-td" style={{ fontWeight: 700, color: COLOR }}>{fmtN(o.jun_trx)}</td>
                <td className="writ-td" style={{ color: 'var(--text-3)' }}>{fmtN(o.mei_trx)}</td>
                <td className="writ-td" style={{ fontWeight: 600, color: devColor(o.growth_pct ?? 0) }}>{fmtPct(o.growth_pct)}</td>
                <td className="writ-td" style={{ color: 'var(--text-2)' }}>{fmtRp(o.jun_margin)}</td>
                <td className="writ-td" style={{ color: 'var(--text-3)', fontSize: 11 }}>Rp {fmtN(Math.round(o.mpt))}</td>
                <td className="writ-td">{o.consistency_pct != null ? o.consistency_pct + '%' : '–'}</td>
                <td className="writ-td"><span className={scoreClass(o.perf_score)}>{o.perf_score}</span></td>
                <td className="writ-td"><SegBadge seg={o.segment} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Paginator total={filtered.length} page={page} pageSize={PS} setPage={setPage} />
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 2 — Segmentasi
════════════════════════════════════════════ */
function SegmentasiTab({ outlets }) {
  const [activeSeg, setActiveSeg] = useState(null);
  const [q, setQ]     = useState('');
  const [sortF, setSortF] = useState('jun_trx');
  const [sortD, setSortD] = useState('desc');
  const [page, setPage]   = useState(1);
  const PS = 50;

  const segCounts = useMemo(() => {
    const m = {};
    outlets.forEach(o => { m[o.segment] = (m[o.segment] || 0) + 1; });
    return m;
  }, [outlets]);

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return outlets.filter(o =>
      (!activeSeg || o.segment === activeSeg) &&
      (!ql || o.id_outlet.toLowerCase().includes(ql) || (o.nama_merchant || '').toLowerCase().includes(ql))
    ).sort((a, b) => {
      const va = a[sortF], vb = b[sortF], d = sortD === 'asc' ? 1 : -1;
      if (va == null) return 1; if (vb == null) return -1;
      return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
    });
  }, [outlets, activeSeg, q, sortF, sortD]);

  const paged = filtered.slice((page - 1) * PS, page * PS);
  const sort = f => { if (sortF === f) setSortD(d => d === 'asc' ? 'desc' : 'asc'); else { setSortF(f); setSortD('desc'); } setPage(1); };

  return (
    <div>
      <div className="writ-seg-grid">
        {SEG_ORDER.map(key => {
          const count = segCounts[key] || 0;
          const pct   = outlets.length > 0 ? (count / outlets.length * 100).toFixed(1) : 0;
          const active = activeSeg === key;
          return (
            <div key={key} className={`writ-seg-card${active ? ' writ-seg-card--active' : ''}`}
              style={{ '--color': SEG_COLOR[key], borderColor: active ? SEG_COLOR[key] : 'var(--border)', background: SEG_COLOR[key] + '10' }}
              onClick={() => { setActiveSeg(activeSeg === key ? null : key); setPage(1); setQ(''); }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: SEG_COLOR[key], marginBottom: 4 }}>{SEG_LABEL[key]}</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-1)', lineHeight: 1 }}>{fmtN(count)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{pct}% dari total</div>
              {active && <div style={{ fontSize: 10, color: SEG_COLOR[key], marginTop: 6, fontWeight: 600 }}>▶ Filter aktif</div>}
            </div>
          );
        })}
      </div>

      {activeSeg && (
        <div className="wrfp-chart-card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ width: 4, borderRadius: 2, flexShrink: 0, alignSelf: 'stretch', background: SEG_COLOR[activeSeg] }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: SEG_COLOR[activeSeg], marginBottom: 4 }}>
                {SEG_LABEL[activeSeg]} — {SEG_DESC[activeSeg]}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                <strong>Action:</strong> {SEG_ACTION[activeSeg]}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="writ-filter-bar">
        <input className="writ-filter-input" placeholder="🔍 Cari ID atau Nama..." value={q}
          onChange={e => { setQ(e.target.value); setPage(1); }} />
        <span className="writ-filter-badge">{fmtN(filtered.length)} outlet {activeSeg ? `(${SEG_LABEL[activeSeg]})` : '(semua)'}</span>
        {activeSeg && <button className="writ-filter-clear" onClick={() => { setActiveSeg(null); setPage(1); }}>Hapus Filter</button>}
      </div>
      <div className="writ-table-wrap">
        <table className="writ-table">
          <thead>
            <tr>
              <th className="writ-th">#</th>
              {[['id_outlet','ID'],['nama_merchant','Nama'],['kota','Kota'],['provinsi','Provinsi'],
                ['jun_trx','TRX Juni'],['mei_trx','TRX Mei'],['growth_pct','Growth%'],['mpt','MPT']].map(([f,l]) =>
                <SortTh key={f} field={f} label={l} sortF={sortF} sortD={sortD} onSort={sort} />)}
              <th className="writ-th">Segmen</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((o, i) => (
              <tr key={o.id_outlet} className="writ-tr">
                <td className="writ-td" style={{ color: 'var(--text-3)' }}>{(page - 1) * PS + i + 1}</td>
                <td className="writ-td" style={{ fontFamily: 'monospace', fontSize: 11 }}>{o.id_outlet}</td>
                <td className="writ-td writ-td-name" title={o.nama_merchant}>{o.nama_merchant}</td>
                <td className="writ-td">{o.kota}</td>
                <td className="writ-td">{o.provinsi}</td>
                <td className="writ-td" style={{ fontWeight: 700, color: COLOR }}>{fmtN(o.jun_trx)}</td>
                <td className="writ-td" style={{ color: 'var(--text-3)' }}>{fmtN(o.mei_trx)}</td>
                <td className="writ-td" style={{ fontWeight: 600, color: devColor(o.growth_pct ?? 0) }}>{fmtPct(o.growth_pct)}</td>
                <td className="writ-td" style={{ color: 'var(--text-3)', fontSize: 11 }}>Rp {fmtN(Math.round(o.mpt))}</td>
                <td className="writ-td"><SegBadge seg={o.segment} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Paginator total={filtered.length} page={page} pageSize={PS} setPage={setPage} />
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 3 — Trend Harian
════════════════════════════════════════════ */
function TrendTab({ daily, mtd }) {
  const chartId = daily.length;
  if (!daily.length) return <div className="wrfp-empty">Belum ada data trend harian.</div>;

  const labels  = daily.map(d => d.day);
  const bestDay = [...daily].sort((a, b) => b.trx - a.trx)[0];
  const wrstDay = [...daily].filter(d => d.trx > 0).sort((a, b) => a.trx - b.trx)[0];
  const avgTrx  = Math.round(daily.reduce((s, d) => s + d.trx, 0)     / daily.length);
  const avgOut  = Math.round(daily.reduce((s, d) => s + d.outlets, 0) / daily.length);

  return (
    <div>
      <div className="wrfp-kpi-grid">
        <KPICard label="Hari Terbaik" value={fmtN(bestDay?.trx)}
          sub={`Tgl ${bestDay?.day} · ${fmtN(bestDay?.outlets)} outlet`}
          badge="★" badgeColor="#059669" />
        <KPICard label="Hari Terendah" value={fmtN(wrstDay?.trx)}
          sub={`Tgl ${wrstDay?.day} · ${fmtN(wrstDay?.outlets)} outlet`} />
        <KPICard label="Rata-rata TRX/Hari" value={fmtN(avgTrx)}
          sub={`dari ${daily.length} hari`} />
        <KPICard label="Rata-rata Outlet/Hari" value={fmtN(avgOut)}
          sub="outlet aktif per hari" />
      </div>

      <ChartCard title={`📈 Transaksi Harian — ${mtd?.b1_label || 'Juni'} vs ${mtd?.b2_label || 'Mei'}`} height={260}>
        <LineChart id={`trx-${chartId}`}
          labels={labels}
          datasets={[
            { label: mtd?.b1_label || 'Juni', data: daily.map(d => d.trx),
              borderColor: COLOR, backgroundColor: COLOR + '15', fill: true, tension: 0.3, pointRadius: 3 },
            { label: mtd?.b2_label || 'Mei', data: daily.map(d => d.mei_trx),
              borderColor: '#9CA3AF', backgroundColor: 'transparent', borderDash: [4,3], tension: 0.3, pointRadius: 2 },
          ]} />
      </ChartCard>

      <ChartCard title="🏪 Outlet Aktif per Hari" height={220}>
        <GroupedBarChart id={`out-${chartId}`}
          labels={labels}
          datasets={[
            { label: mtd?.b1_label || 'Juni', data: daily.map(d => d.outlets),     backgroundColor: COLOR + 'AA' },
            { label: mtd?.b2_label || 'Mei',  data: daily.map(d => d.mei_outlets), backgroundColor: '#9CA3AFAA' },
          ]} />
      </ChartCard>

      <div className="wrfp-chart-card">
        <div className="wrfp-chart-title">📊 Tabel Harian Detail</div>
        <div className="writ-table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table className="writ-table">
            <thead>
              <tr>
                <th className="writ-th">Tgl</th>
                <th className="writ-th">TRX Juni</th>
                <th className="writ-th">TRX Mei</th>
                <th className="writ-th">Dev</th>
                <th className="writ-th">Outlet Juni</th>
                <th className="writ-th">Outlet Mei</th>
                <th className="writ-th">Margin Juni</th>
              </tr>
            </thead>
            <tbody>
              {daily.map(d => {
                const dev = d.trx - d.mei_trx;
                return (
                  <tr key={d.day} className="writ-tr">
                    <td className="writ-td" style={{ fontWeight: 600 }}>{d.tanggal?.slice(0, 10) || d.day}</td>
                    <td className="writ-td" style={{ fontWeight: 700, color: COLOR }}>{fmtN(d.trx)}</td>
                    <td className="writ-td" style={{ color: 'var(--text-3)' }}>{fmtN(d.mei_trx)}</td>
                    <td className="writ-td" style={{ fontWeight: 600, color: devColor(dev) }}>{dev >= 0 ? '+' : ''}{fmtN(dev)}</td>
                    <td className="writ-td">{fmtN(d.outlets)}</td>
                    <td className="writ-td" style={{ color: 'var(--text-3)' }}>{fmtN(d.mei_outlets)}</td>
                    <td className="writ-td" style={{ color: '#059669' }}>{fmtRp(d.margin)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 4 — Kategori
════════════════════════════════════════════ */
function KategoriTab({ outlets }) {
  const [sortF, setSortF] = useState('outlet_count');
  const [sortD, setSortD] = useState('desc');
  const [selKat, setSelKat] = useState(null);
  const [q, setQ]       = useState('');
  const [page, setPage] = useState(1);
  const PS = 50;
  const chartId = outlets.length;

  const katData = useMemo(() => {
    const m = {};
    outlets.forEach(o => {
      const k = o.kategori || 'Lainnya';
      if (!m[k]) m[k] = { kategori: k, outlet_count: 0, aktif: 0, total_trx: 0, total_margin: 0, churn: 0, baru: 0 };
      m[k].outlet_count++;
      if (o.jun_trx > 0) m[k].aktif++;
      m[k].total_trx    += o.jun_trx;
      m[k].total_margin += o.jun_margin;
      if (o.segment === 'churn')     m[k].churn++;
      if (o.segment === 'baru_aktif') m[k].baru++;
    });
    return Object.values(m);
  }, [outlets]);

  const sorted = useMemo(() => [...katData].sort((a, b) => {
    const va = a[sortF], vb = b[sortF], d = sortD === 'asc' ? 1 : -1;
    return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
  }), [katData, sortF, sortD]);

  const drillMs = useMemo(() => {
    if (!selKat) return [];
    const ql = q.toLowerCase();
    return outlets.filter(o => o.kategori === selKat &&
      (!ql || o.id_outlet.toLowerCase().includes(ql) || (o.nama_merchant || '').toLowerCase().includes(ql))
    ).sort((a, b) => b.jun_trx - a.jun_trx);
  }, [outlets, selKat, q]);

  const pagedDrill = drillMs.slice((page - 1) * PS, page * PS);
  const sort = f => { if (sortF === f) setSortD(d => d === 'asc' ? 'desc' : 'asc'); else { setSortF(f); setSortD('desc'); } };
  const top10 = [...katData].sort((a, b) => b.outlet_count - a.outlet_count).slice(0, 10);

  return (
    <div>
      <div className="wrfp-charts-2col" style={{ marginBottom: 14 }}>
        <ChartCard title="📊 Top 10 Kategori — Outlet Count" height={220}>
          <HBarChart id={`kc-${chartId}`}
            labels={top10.map(k => k.kategori.length > 22 ? k.kategori.slice(0,22)+'…' : k.kategori)}
            values={top10.map(k => k.outlet_count)} color={COLOR} />
        </ChartCard>
        <ChartCard title="💳 Top 10 Kategori — Total TRX" height={220}>
          <HBarChart id={`kt-${chartId}`}
            labels={top10.map(k => k.kategori.length > 22 ? k.kategori.slice(0,22)+'…' : k.kategori)}
            values={top10.map(k => k.total_trx)} color={THEME2} />
        </ChartCard>
      </div>

      <div className="wrfp-chart-card" style={{ marginTop: 0 }}>
        <div className="wrfp-chart-title">🏷️ {selKat ? `Outlet: ${selKat}` : 'Semua Kategori'}</div>
        {!selKat ? (
          <div className="writ-table-wrap">
            <table className="writ-table">
              <thead>
                <tr>
                  <th className="writ-th">#</th>
                  {[['kategori','Kategori'],['outlet_count','Outlet'],['aktif','Aktif'],['total_trx','TRX'],
                    ['total_margin','Margin'],['churn','Churn'],['baru','Baru']].map(([f,l]) =>
                    <SortTh key={f} field={f} label={l} sortF={sortF} sortD={sortD} onSort={sort} />)}
                  <th className="writ-th">AR%</th>
                  <th className="writ-th"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((k, i) => {
                  const ar = k.outlet_count > 0 ? (k.aktif / k.outlet_count * 100).toFixed(1) : 0;
                  return (
                    <tr key={k.kategori} className="writ-tr">
                      <td className="writ-td" style={{ color: 'var(--text-3)' }}>{i + 1}</td>
                      <td className="writ-td" style={{ fontWeight: 600, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={k.kategori}>{k.kategori}</td>
                      <td className="writ-td" style={{ fontWeight: 700, color: COLOR }}>{fmtN(k.outlet_count)}</td>
                      <td className="writ-td" style={{ color: '#10B981' }}>{fmtN(k.aktif)}</td>
                      <td className="writ-td">{fmtN(k.total_trx)}</td>
                      <td className="writ-td" style={{ color: 'var(--text-2)' }}>{fmtRp(k.total_margin)}</td>
                      <td className="writ-td" style={{ color: k.churn > 0 ? '#DC2626' : 'var(--text-3)' }}>{k.churn}</td>
                      <td className="writ-td" style={{ color: 'var(--text-3)' }}>{k.baru}</td>
                      <td className="writ-td"><span style={{ fontWeight: 700, fontSize: 12, color: ar >= 80 ? '#059669' : ar >= 50 ? '#D97706' : '#DC2626' }}>{ar}%</span></td>
                      <td className="writ-td"><button className="writ-copy-btn" onClick={() => { setSelKat(k.kategori); setPage(1); }}>Lihat ›</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            <div className="writ-filter-bar">
              <input className="writ-filter-input" placeholder="🔍 Cari ID atau Nama..." value={q}
                onChange={e => { setQ(e.target.value); setPage(1); }} />
              <span className="writ-filter-badge">{fmtN(drillMs.length)} outlet</span>
              <button className="writ-filter-clear" onClick={() => { setSelKat(null); setQ(''); }}>← Kembali</button>
            </div>
            <div className="writ-table-wrap">
              <table className="writ-table">
                <thead>
                  <tr>
                    <th className="writ-th">#</th>
                    <th className="writ-th">ID Outlet</th>
                    <th className="writ-th">Nama</th>
                    <th className="writ-th">Kota</th>
                    <th className="writ-th">Provinsi</th>
                    <th className="writ-th">TRX Juni</th>
                    <th className="writ-th">TRX Mei</th>
                    <th className="writ-th">Growth%</th>
                    <th className="writ-th">Segmen</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedDrill.map((o, i) => (
                    <tr key={o.id_outlet} className="writ-tr">
                      <td className="writ-td" style={{ color: 'var(--text-3)' }}>{(page - 1) * PS + i + 1}</td>
                      <td className="writ-td" style={{ fontFamily: 'monospace', fontSize: 11 }}>{o.id_outlet}</td>
                      <td className="writ-td writ-td-name" title={o.nama_merchant}>{o.nama_merchant}</td>
                      <td className="writ-td">{o.kota}</td>
                      <td className="writ-td">{o.provinsi}</td>
                      <td className="writ-td" style={{ fontWeight: 700, color: COLOR }}>{fmtN(o.jun_trx)}</td>
                      <td className="writ-td" style={{ color: 'var(--text-3)' }}>{fmtN(o.mei_trx)}</td>
                      <td className="writ-td" style={{ fontWeight: 600, color: devColor(o.growth_pct ?? 0) }}>{fmtPct(o.growth_pct)}</td>
                      <td className="writ-td"><SegBadge seg={o.segment} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Paginator total={drillMs.length} page={page} pageSize={PS} setPage={setPage} />
          </>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 5 — Territory Intelligence
════════════════════════════════════════════ */
function TerritoryTab({ outlets }) {
  const [fTerr, setFTerr] = useState('');
  const [sortF, setSortF] = useState('outlet_count');
  const [sortD, setSortD] = useState('desc');
  const chartId = outlets.length;

  const terrData = useMemo(() => {
    const m = {};
    outlets.forEach(o => {
      const t = o.territory_cluster || 'Lainnya';
      if (!m[t]) m[t] = { terr: t, count: 0, aktif: 0, trx: 0, churn: 0 };
      m[t].count++;
      if (o.jun_trx > 0) m[t].aktif++;
      m[t].trx += o.jun_trx;
      if (o.segment === 'churn') m[t].churn++;
    });
    return Object.values(m).sort((a, b) => b.count - a.count);
  }, [outlets]);

  const provData = useMemo(() => {
    const m = {};
    outlets.filter(o => !fTerr || o.territory_cluster === fTerr).forEach(o => {
      const p = o.provinsi || 'N/A';
      if (!m[p]) m[p] = { provinsi: p, outlet_count: 0, aktif: 0, total_trx: 0, churn: 0, terr: o.territory_cluster };
      m[p].outlet_count++;
      if (o.jun_trx > 0) m[p].aktif++;
      m[p].total_trx += o.jun_trx;
      if (o.segment === 'churn') m[p].churn++;
    });
    return Object.values(m).sort((a, b) => {
      const va = a[sortF], vb = b[sortF], d = sortD === 'asc' ? 1 : -1;
      return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
    });
  }, [outlets, fTerr, sortF, sortD]);

  const sort = f => { if (sortF === f) setSortD(d => d === 'asc' ? 'desc' : 'asc'); else { setSortF(f); setSortD('desc'); } };

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        {terrData.map(t => {
          const ar = t.count > 0 ? (t.aktif / t.count * 100).toFixed(0) : 0;
          const active = fTerr === t.terr;
          return (
            <div key={t.terr} onClick={() => setFTerr(active ? '' : t.terr)}
              style={{ padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                border: `2px solid ${active ? (TERR_COLOR[t.terr] || COLOR) : 'var(--border)'}`,
                background: (TERR_COLOR[t.terr] || COLOR) + '10' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: TERR_COLOR[t.terr] || COLOR }}>{t.terr}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-1)' }}>{fmtN(t.count)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>AR: {ar}% · TRX: {fmtN(t.trx)}</div>
              {t.churn > 0 && <div style={{ fontSize: 10, color: '#DC2626', marginTop: 2 }}>{t.churn} churn</div>}
            </div>
          );
        })}
      </div>

      <div className="wrfp-charts-2col" style={{ marginBottom: 14 }}>
        <ChartCard title="📊 Outlet Count per Territory" height={200}>
          <HBarChart id={`tc-${chartId}-${fTerr}`} labels={terrData.map(t => t.terr)} values={terrData.map(t => t.count)} color={COLOR} />
        </ChartCard>
        <ChartCard title="💳 Total TRX per Territory" height={200}>
          <HBarChart id={`tt-${chartId}-${fTerr}`} labels={terrData.map(t => t.terr)} values={terrData.map(t => t.trx)} color={THEME2} />
        </ChartCard>
      </div>

      <div className="wrfp-chart-card" style={{ marginTop: 0 }}>
        <div className="wrfp-chart-title">
          🗺️ Ranking Provinsi {fTerr ? `— ${fTerr}` : '(Semua)'}
          {fTerr && <button className="writ-filter-clear" style={{ marginLeft: 10 }} onClick={() => setFTerr('')}>Hapus Filter</button>}
        </div>
        <div className="writ-table-wrap">
          <table className="writ-table">
            <thead>
              <tr>
                <th className="writ-th">#</th>
                {[['provinsi','Provinsi'],['outlet_count','Outlet'],['aktif','Aktif'],['total_trx','TRX'],['churn','Churn']].map(([f,l]) =>
                  <SortTh key={f} field={f} label={l} sortF={sortF} sortD={sortD} onSort={sort} />)}
                <th className="writ-th">AR%</th>
                <th className="writ-th">Territory</th>
              </tr>
            </thead>
            <tbody>
              {provData.map((p, i) => {
                const ar = p.outlet_count > 0 ? (p.aktif / p.outlet_count * 100).toFixed(1) : 0;
                return (
                  <tr key={p.provinsi} className="writ-tr">
                    <td className="writ-td" style={{ color: 'var(--text-3)' }}>{i + 1}</td>
                    <td className="writ-td" style={{ fontWeight: 600 }}>{p.provinsi}</td>
                    <td className="writ-td" style={{ fontWeight: 700, color: COLOR }}>{fmtN(p.outlet_count)}</td>
                    <td className="writ-td" style={{ color: '#10B981' }}>{fmtN(p.aktif)}</td>
                    <td className="writ-td">{fmtN(p.total_trx)}</td>
                    <td className="writ-td" style={{ color: p.churn > 0 ? '#DC2626' : 'var(--text-3)' }}>{p.churn}</td>
                    <td className="writ-td">
                      <span style={{ fontWeight: 700, fontSize: 12, color: ar >= 80 ? '#059669' : ar >= 50 ? '#D97706' : '#DC2626' }}>{ar}%</span>
                    </td>
                    <td className="writ-td">
                      <span style={{ padding: '2px 8px', borderRadius: 8, fontSize: 10, background: (TERR_COLOR[p.terr] || COLOR) + '20', color: TERR_COLOR[p.terr] || COLOR, fontWeight: 600 }}>{p.terr}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 6 — Growth & Churn
════════════════════════════════════════════ */
function GrowthTab({ outlets }) {
  const [view, setView]   = useState('growing');
  const [q, setQ]         = useState('');
  const [page, setPage]   = useState(1);
  const PS = 50;

  const groups = useMemo(() => ({
    growing:  outlets.filter(o => ['superstar','tumbuh'].includes(o.segment)).sort((a, b) => b.growth_pct - a.growth_pct),
    at_risk:  outlets.filter(o => ['at_risk','turun','churn'].includes(o.segment)).sort((a, b) => a.growth_pct - b.growth_pct),
    stable:   outlets.filter(o => o.segment === 'stabil').sort((a, b) => b.jun_trx - a.jun_trx),
    new_reakt:outlets.filter(o => ['baru_aktif','reaktivasi'].includes(o.segment)).sort((a, b) => b.jun_trx - a.jun_trx),
  }), [outlets]);

  const current = groups[view] || [];
  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return ql ? current.filter(o => o.id_outlet.includes(ql) || (o.nama_merchant || '').toLowerCase().includes(ql)) : current;
  }, [current, q]);

  const paged = filtered.slice((page - 1) * PS, page * PS);

  const VIEWS = [
    { key: 'growing',   label: '⬆️ Growing',       color: '#059669', desc: 'Superstar + Tumbuh' },
    { key: 'at_risk',   label: '⚠️ At Risk / Churn', color: '#DC2626', desc: 'At Risk + Turun + Churn' },
    { key: 'stable',    label: '✅ Stabil',          color: '#3B82F6', desc: 'Growth -10% s/d +20%' },
    { key: 'new_reakt', label: '🆕 Baru & Reaktivasi', color: '#F97316', desc: 'Baru Aktif + Reaktivasi' },
  ];

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        {VIEWS.map(v => (
          <div key={v.key} onClick={() => { setView(v.key); setPage(1); setQ(''); }}
            style={{ padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
              border: `2px solid ${view === v.key ? v.color : 'var(--border)'}`,
              background: view === v.key ? v.color + '15' : 'var(--bg-card)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: v.color, marginBottom: 4 }}>{v.label}</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--text-1)' }}>{fmtN((groups[v.key] || []).length)}</div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4 }}>{v.desc}</div>
          </div>
        ))}
      </div>
      <div className="writ-filter-bar">
        <input className="writ-filter-input" placeholder="🔍 Cari ID atau Nama..." value={q}
          onChange={e => { setQ(e.target.value); setPage(1); }} />
        <span className="writ-filter-badge">{fmtN(filtered.length)} outlet</span>
      </div>
      <div className="writ-table-wrap">
        <table className="writ-table">
          <thead>
            <tr>
              <th className="writ-th">#</th>
              <th className="writ-th">ID Outlet</th>
              <th className="writ-th">Nama</th>
              <th className="writ-th">Kota</th>
              <th className="writ-th">TRX Juni</th>
              <th className="writ-th">TRX Mei</th>
              <th className="writ-th">Growth%</th>
              <th className="writ-th">Margin Juni</th>
              <th className="writ-th">Segmen</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((o, i) => (
              <tr key={o.id_outlet} className="writ-tr">
                <td className="writ-td" style={{ color: 'var(--text-3)' }}>{(page - 1) * PS + i + 1}</td>
                <td className="writ-td" style={{ fontFamily: 'monospace', fontSize: 11 }}>{o.id_outlet}</td>
                <td className="writ-td writ-td-name" title={o.nama_merchant}>{o.nama_merchant}</td>
                <td className="writ-td">{o.kota}</td>
                <td className="writ-td" style={{ fontWeight: 700, color: COLOR }}>{fmtN(o.jun_trx)}</td>
                <td className="writ-td" style={{ color: 'var(--text-3)' }}>{fmtN(o.mei_trx)}</td>
                <td className="writ-td" style={{ fontWeight: 600, color: devColor(o.growth_pct ?? 0) }}>{fmtPct(o.growth_pct)}</td>
                <td className="writ-td" style={{ color: THEME2 }}>{fmtRp(o.jun_margin)}</td>
                <td className="writ-td"><SegBadge seg={o.segment} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Paginator total={filtered.length} page={page} pageSize={PS} setPage={setPage} />
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 7 — Action Center
════════════════════════════════════════════ */
function ActionPanel({ title, color, outlets: ms, helpText }) {
  const [q, setQ]     = useState('');
  const [page, setPage] = useState(1);
  const [copied, setCopied] = useState(false);
  const PS = 30;

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return ql ? ms.filter(o => o.id_outlet.toLowerCase().includes(ql) || (o.nama_merchant || '').toLowerCase().includes(ql)) : ms;
  }, [ms, q]);

  const paged = filtered.slice((page - 1) * PS, page * PS);

  const copyIds = () => {
    navigator.clipboard.writeText(filtered.map(o => o.id_outlet).join('\n'));
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="writ-action-panel">
      <div className="writ-action-title">
        {title}
        <span className="writ-action-count" style={{ background: color }}>{fmtN(ms.length)}</span>
      </div>
      {helpText && <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.6 }}>{helpText}</div>}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input className="writ-action-search" placeholder="Cari ID Outlet..." value={q}
          onChange={e => { setQ(e.target.value); setPage(1); }} style={{ flex: 1 }} />
        <button className="writ-copy-btn" onClick={copyIds}>{copied ? '✓ Copied' : 'Copy IDs'}</button>
      </div>
      <div style={{ overflowX: 'auto', maxHeight: 280, overflowY: 'auto' }}>
        <table className="writ-action-table">
          <thead>
            <tr><th>ID Outlet</th><th>Nama</th><th>Kota</th><th>TRX Juni</th><th>TRX Mei</th><th>Growth%</th><th>Segmen</th></tr>
          </thead>
          <tbody>
            {paged.map(o => (
              <tr key={o.id_outlet}>
                <td style={{ fontFamily: 'monospace', fontSize: 10 }}>{o.id_outlet}</td>
                <td style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o.nama_merchant}>{o.nama_merchant}</td>
                <td>{o.kota}</td>
                <td style={{ fontWeight: 700, color: COLOR }}>{fmtN(o.jun_trx)}</td>
                <td style={{ color: 'var(--text-3)' }}>{fmtN(o.mei_trx)}</td>
                <td style={{ fontWeight: 600, color: devColor(o.growth_pct ?? 0) }}>{fmtPct(o.growth_pct)}</td>
                <td><SegBadge seg={o.segment} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length > PS && <Paginator total={filtered.length} page={page} pageSize={PS} setPage={setPage} />}
    </div>
  );
}

function ActionTab({ outlets, thr }) {
  const panels = useMemo(() => {
    const byMeiTrx  = (a, b) => b.mei_trx   - a.mei_trx;
    const byGrow    = (a, b) => b.growth_pct - a.growth_pct;
    const byJunTrx  = (a, b) => b.jun_trx   - a.jun_trx;
    const byAprTrx  = (a, b) => b.apr_trx   - a.apr_trx;
    const byMpt     = (a, b) => a.mpt       - b.mpt;
    return {
      selamatkan: outlets.filter(o => o.segment === 'churn').sort(byMeiTrx),
      hubungi:    outlets.filter(o => o.jun_trx >= (thr.trx_p50 || 0) && o.growth_pct !== null && o.growth_pct >= 20).sort(byGrow),
      reward:     outlets.filter(o => o.segment === 'superstar').sort(byJunTrx),
      reaktivasi: outlets.filter(o => o.segment === 'reaktivasi').sort(byAprTrx),
      optimasi:   outlets.filter(o => o.jun_trx >= (thr.trx_p75 || 0) && o.mpt < (thr.avg_mpt || 0)).sort(byMpt),
    };
  }, [outlets, thr]);

  return (
    <div>
      <div className="wrfp-chart-card" style={{ marginBottom: 16, padding: '12px 16px' }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-2)' }}>
          <span>🚨 <strong>Selamatkan:</strong> {fmtN(panels.selamatkan.length)} churn</span>
          <span>📞 <strong>Hubungi:</strong> {fmtN(panels.hubungi.length)} tumbuh volume tinggi</span>
          <span>⭐ <strong>Reward:</strong> {fmtN(panels.reward.length)} superstar</span>
          <span>🔄 <strong>Reaktivasi:</strong> {fmtN(panels.reaktivasi.length)} outlet kembali aktif</span>
          <span>💡 <strong>Optimasi:</strong> {fmtN(panels.optimasi.length)} high TRX low margin</span>
        </div>
      </div>
      <div className="writ-action-grid">
        <ActionPanel title="🚨 Wajib Diselamatkan" color="#DC2626" outlets={panels.selamatkan}
          helpText="Churn — aktif bulan lalu, kini 0 TRX. Prioritaskan outlet dengan TRX tertinggi sebelum churn." />
        <ActionPanel title="📞 Wajib Dihubungi" color="#059669" outlets={panels.hubungi}
          helpText="Tumbuh ≥20% & volume signifikan. Push lebih keras — momentum sedang bagus." />
        <ActionPanel title="⭐ Reward & Testimonial" color="#7C3AED" outlets={panels.reward}
          helpText="Superstar: TRX & Margin ≥ P75. Berikan reward loyalitas, ambil testimonial, jadikan brand ambassador." />
        <ActionPanel title="🔄 Reaktivasi" color="#F97316" outlets={panels.reaktivasi}
          helpText="Tidak aktif 2 bulan, kini aktif kembali. Sambut, berikan insentif, jaga momentum." />
        <ActionPanel title="💡 Wajib Dioptimasi" color="#F59E0B" outlets={panels.optimasi}
          helpText="TRX tinggi tapi margin per transaksi di bawah rata-rata. Edukasi produk dengan margin lebih tinggi." />
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 8 — Export
════════════════════════════════════════════ */
function ExportTab({ outlets, bulan, thr, maxDay }) {
  const [status, setStatus] = useState('');

  function doExport(type) {
    let rows, headers, filename;
    if (type === 'semua') {
      headers = ['id_outlet','nama_merchant','kategori','kota','provinsi','id_upline','territory_cluster',
                 'tgl_aktivasi','jun_trx','jun_margin','mei_trx','mei_margin','apr_trx',
                 'dev_trx','dev_margin','growth_pct','avg_daily','mpt','consistency_pct','segment'];
      rows    = outlets;
      filename = `trx-outlet-semua_${bulan}`;
    } else if (type === 'aktif') {
      headers = ['id_outlet','nama_merchant','kategori','kota','provinsi','territory_cluster',
                 'jun_trx','jun_margin','growth_pct','mpt','consistency_pct','segment'];
      rows    = outlets.filter(o => o.jun_trx > 0);
      filename = `trx-outlet-aktif_${bulan}`;
    } else if (type === 'churn') {
      headers = ['id_outlet','nama_merchant','kategori','kota','provinsi','territory_cluster','mei_trx','mei_margin'];
      rows    = outlets.filter(o => o.segment === 'churn').sort((a,b) => b.mei_trx - a.mei_trx);
      filename = `trx-outlet-churn_${bulan}`;
    } else if (type === 'action') {
      headers = ['priority','id_outlet','nama_merchant','kategori','kota','provinsi','jun_trx','mei_trx','growth_pct','mpt','segment'];
      const p = (o, label) => ({ ...o, priority: label });
      rows = [
        ...outlets.filter(o => o.segment === 'churn').sort((a,b) => b.mei_trx - a.mei_trx).map(o => p(o, 'Selamatkan')),
        ...outlets.filter(o => o.jun_trx >= (thr.trx_p50 || 0) && (o.growth_pct || 0) >= 20).sort((a,b) => b.growth_pct - a.growth_pct).map(o => p(o, 'Hubungi')),
        ...outlets.filter(o => o.segment === 'superstar').sort((a,b) => b.jun_trx - a.jun_trx).map(o => p(o, 'Reward')),
      ];
      filename = `trx-outlet-action_${bulan}`;
    }

    setStatus(`Menyiapkan ${rows.length} baris...`);
    const BOM = '﻿';
    const lines = [
      headers.join(','),
      ...rows.map(r => headers.map(h => {
        const v = String(r[h] ?? '');
        return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(',')),
    ];
    const blob = new Blob([BOM + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${filename}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    setStatus(`✓ ${fmtN(rows.length)} baris berhasil diunduh`);
  }

  const EXPORTS = [
    { type: 'semua',  icon: 'ti-table',        label: 'Semua Outlet',    desc: `${fmtN(outlets.length)} outlet — 20 kolom lengkap termasuk semua bulan` },
    { type: 'aktif',  icon: 'ti-building-store',label: 'Outlet Aktif',   desc: `${fmtN(outlets.filter(o => o.jun_trx > 0).length)} outlet aktif bulan ini — 12 kolom` },
    { type: 'churn',  icon: 'ti-skull',         label: 'Daftar Churn',   desc: `${fmtN(outlets.filter(o => o.segment === 'churn').length)} outlet churn — untuk follow-up tim` },
    { type: 'action', icon: 'ti-target',         label: 'Action Center',  desc: 'Gabungan Selamatkan + Hubungi + Reward — dengan kolom Priority' },
  ];

  return (
    <div>
      <div className="wrfp-chart-card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.8 }}>
          Export menggunakan data bulan <strong style={{ color: COLOR }}>{bulan}</strong>. BOM UTF-8 disertakan agar nama outlet terbaca benar di Excel.
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {EXPORTS.map(e => (
          <div key={e.type} className="wrfp-chart-card" style={{ margin: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ width: 46, height: 46, borderRadius: 10, background: COLOR + '15', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <i className={`ti ${e.icon}`} style={{ color: COLOR, fontSize: 20 }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-1)', marginBottom: 3 }}>{e.label}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{e.desc}</div>
              </div>
              <button onClick={() => doExport(e.type)}
                style={{ padding: '10px 20px', border: `1.5px solid ${COLOR}`, borderRadius: 8,
                  background: COLOR, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8 }}>
                <i className="ti ti-download" /> Download CSV
              </button>
            </div>
          </div>
        ))}
      </div>
      {status && (
        <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--text-2)' }}>
          {status}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════
   MAIN COMPONENT
════════════════════════════════════════════ */
export default function WarRoomTrxOutlet() {
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [data,    setData]    = useState(null);
  const [bulan,   setBulan]   = useState('2026-06');
  const [tab,     setTab]     = useState(0);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true); setError(null);
        const url = bulan ? `${API}?bulan=${bulan}` : API;
        const r = await fetch(url, { headers: authHdr() });
        if (!r.ok) throw new Error(await r.text());
        const d = await r.json();
        setData(d);
        if (d.bulan && !bulan) setBulan(d.bulan);
      } catch (e) { setError(e.message || 'Gagal memuat data'); }
      finally { setLoading(false); }
    })();
  }, [bulan]);

  const outlets = data?.outlets || [];
  const daily   = data?.daily_trend || [];
  const mtd     = data?.mtd_info   || {};
  const thr     = data?.thresholds  || {};
  const maxDay  = mtd.max_day || 0;
  const summary = useMemo(() => buildSummary(outlets), [outlets]);

  const tabComponents = [
    <ExecutiveTab   key={0} outlets={outlets} summary={summary} mtd={mtd} thr={thr} />,
    <OutletTab      key={1} outlets={outlets} thr={thr} maxDay={maxDay} />,
    <SegmentasiTab  key={2} outlets={outlets} />,
    <TrendTab       key={3} daily={daily} mtd={mtd} />,
    <KategoriTab    key={4} outlets={outlets} />,
    <TerritoryTab   key={5} outlets={outlets} />,
    <GrowthTab      key={6} outlets={outlets} />,
    <ActionTab      key={7} outlets={outlets} thr={thr} />,
    <ExportTab      key={8} outlets={outlets} bulan={bulan} thr={thr} maxDay={maxDay} />,
  ];

  return (
    <Layout>
      <div className="wrfp-page">
        <div className="wrfp-header">
          <div className="wrfp-header-left">
            <i className="ti ti-building-store" style={{ color: COLOR, fontSize: 22 }} />
            <div>
              <div className="wrfp-header-title">WAR-ROOM TRX BY OUTLET</div>
              <div className="wrfp-header-meta">
                Outlet-level Analytics · InstaQris
                {mtd.is_mtd && <> · <span style={{ color: '#F59E0B', fontWeight: 700 }}>MTD {mtd.b1_label}</span></>}
                {outlets.length > 0 && <> · {fmtN(outlets.length)} outlet</>}
              </div>
            </div>
          </div>
          <div className="wrfp-header-badges">
            <span className="wrfp-badge" style={{ background: COLOR }}>OUT</span>
            <select className="wrfp-select" value={bulan} onChange={e => setBulan(e.target.value)}>
              {(data?.bulan_list || ['2026-06','2026-05','2026-04']).map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="wrfp-tabs">
          {TABS.map(t => (
            <button key={t.id} className={`wrfp-tab${tab === t.id ? ' wrfp-tab--active' : ''}`}
              onClick={() => setTab(t.id)}>
              <i className={`ti ${t.icon}`} /> {t.label}
            </button>
          ))}
        </div>

        {loading && (
          <div className="wrfp-loading">
            <i className="ti ti-loader-2 wrfp-spin" /> Memuat data outlet...
          </div>
        )}
        {error && <div className="wrfp-error"><i className="ti ti-alert-circle" /> {error}</div>}
        {!loading && !error && outlets.length === 0 && (
          <div className="wrfp-empty">
            <i className="ti ti-building-store" style={{ color: COLOR }} />
            <div>Belum ada data outlet</div>
          </div>
        )}
        {!loading && !error && outlets.length > 0 && tabComponents[tab]}
      </div>
    </Layout>
  );
}
