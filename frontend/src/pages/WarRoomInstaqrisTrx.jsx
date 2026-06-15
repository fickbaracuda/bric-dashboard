import { useState, useEffect, useRef, useMemo } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getInstaqrisTrxMerchants, getInstaqrisTrxExport } from '../services/api';

const COLOR  = '#7F77DD';
const THEME2 = '#E24B4A';

const SEG_COLOR = {
  high_density: '#7C3AED', daily_active: '#0EA5E9', repeat_scan: '#059669',
  activated: '#10B981',    declining: '#F59E0B',    dormant: '#EF4444',
  churn: '#DC2626',        new_merchant: '#94A3B8',
};
const SEG_LABEL = {
  high_density: 'High Density', daily_active: 'Daily Active', repeat_scan: 'Repeat Scan',
  activated: 'Activated',       declining: 'Declining',       dormant: 'Dormant',
  churn: 'Churn',               new_merchant: 'New Merchant',
};
const SEG_ORDER = ['high_density','daily_active','repeat_scan','activated','declining','dormant','churn','new_merchant'];
const SEG_DESC = {
  high_density: 'Avg ≥1 trx/hari, aktif 7 hari terakhir — revenue driver utama',
  daily_active: 'Avg ≥0.3 trx/hari, aktif 7 hari — loyalitas tinggi',
  repeat_scan:  '≥3 transaksi, aktif 14 hari — potensi berkembang',
  activated:    'Sudah pernah transaksi, masih aktif',
  declining:    'Tidak ada trx 14–30 hari — mulai jarang',
  dormant:      'Tidak ada trx 31–45 hari — hampir churn',
  churn:        'Tidak ada trx >45 hari — sudah churn',
  new_merchant: 'Terdaftar tapi belum pernah transaksi',
};
const SEG_ACTION = {
  high_density: 'Reward loyalitas, jadikan brand ambassador, ambil testimonial.',
  daily_active: 'Tingkatkan ke High Density. Kampanye buyer lokal di sekitar merchant.',
  repeat_scan:  'Push ke Daily Active. Edukasi manfaat QR, insentif buyer.',
  activated:    'Dorong repeat scan. Edukasi manfaat QR, berikan insentif pembeli.',
  declining:    'Engagement segera! Cek hambatan, promo khusus, sticker refresh.',
  dormant:      'Reactivation call. Cek kondisi merchant, tawarkan program reaktivasi.',
  churn:        'Recovery campaign. Visit fisik, identifikasi masalah, ajukan solusi.',
  new_merchant: 'Push first scan dalam 7 hari. Kunjungi, edukasi, insentif pertama.',
};
const BULAN_LABEL = { '2026-04': 'April 2026', '2026-05': 'Mei 2026', '2026-06': 'Juni 2026' };
const TERR_COLOR = {
  'Jawa': '#7C3AED', 'Sumatera': '#0EA5E9', 'Kalimantan': '#F59E0B',
  'Sulawesi': '#10B981', 'Bali & Nusa Tenggara': '#EF4444',
  'Maluku': '#EC4899', 'Papua': '#059669', 'Lainnya': '#94A3B8',
};
const TABS = [
  { id: 0, icon: 'ti-dashboard',          label: 'Executive' },
  { id: 1, icon: 'ti-table',              label: 'Merchant' },
  { id: 2, icon: 'ti-layers-intersect',   label: 'Segmentasi' },
  { id: 3, icon: 'ti-calendar-stats',     label: 'Cohort' },
  { id: 4, icon: 'ti-star',               label: 'Score' },
  { id: 5, icon: 'ti-map-pin',            label: 'Territory' },
  { id: 6, icon: 'ti-trending-up',        label: 'Growth' },
  { id: 7, icon: 'ti-tag',               label: 'Kategori' },
  { id: 8, icon: 'ti-target',             label: 'Action' },
  { id: 9, icon: 'ti-download',           label: 'Export' },
];

/* ─── helpers ─── */
const fmtN   = v => (Number(v) || 0).toLocaleString('id');
const fmtPct = (a, b) => b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '–';
const scoreClass = v => Number(v) >= 70 ? 'writ-score-high' : Number(v) >= 40 ? 'writ-score-mid' : 'writ-score-low';

function buildSummary(ms) {
  if (!ms.length) return {};
  const total = ms.length;
  const activated  = ms.filter(m => m.total_transaction > 0).length;
  const active7d   = ms.filter(m => m.days_since_last_trx <= 7 && m.total_transaction > 0).length;
  const totalTrx   = ms.reduce((s, m) => s + (parseInt(m.total_transaction) || 0), 0);
  const churned    = ms.filter(m => m.segment === 'churn').length;
  const highDensity= ms.filter(m => m.segment === 'high_density').length;
  const newM       = ms.filter(m => m.segment === 'new_merchant').length;
  const dormant    = ms.filter(m => m.segment === 'dormant').length;
  const declining  = ms.filter(m => m.segment === 'declining').length;
  const avgTrx     = activated > 0 ? (totalTrx / activated).toFixed(1) : '0';
  return { total, activated, active7d, totalTrx, churned, highDensity, newM, dormant, declining, avgTrx };
}

function buildInsights(s) {
  if (!s.total) return { paragraph: '', recs: [] };
  const ar = (s.activated / s.total * 100).toFixed(1);
  const paragraph = `Total ${fmtN(s.total)} merchant. Activation rate: ${ar}% (${fmtN(s.activated)} aktif). Active 7 hari: ${fmtN(s.active7d)}. High Density: ${fmtN(s.highDensity)} | Churn: ${fmtN(s.churned)} | Dormant: ${fmtN(s.dormant)} | Belum aktif: ${fmtN(s.newM)}.`;
  const recs = [];
  if (s.newM > 5)     recs.push({ lv: 'high',   title: `${fmtN(s.newM)} Merchant Belum Aktif`,      text: 'Push first scan dalam 7 hari. Kunjungi, edukasi cara scan, berikan insentif.' });
  if (s.churned > 0)  recs.push({ lv: 'high',   title: `Recovery ${fmtN(s.churned)} Churn`,          text: 'Follow-up langsung. Identifikasi hambatan — QR rusak, merchant tutup, atau sepi.' });
  if (s.declining > 0)recs.push({ lv: 'high',   title: `${fmtN(s.declining)} Merchant Declining`,   text: 'Engagement segera. Promo, sticker refresh, kampanye buyer di area merchant.' });
  if (s.dormant > 0)  recs.push({ lv: 'medium', title: `Reaktivasi ${fmtN(s.dormant)} Dormant`,      text: 'Reactivation call. Cek kondisi merchant, tawarkan program reaktivasi.' });
  if (s.highDensity > 0) recs.push({ lv: 'medium', title: `${fmtN(s.highDensity)} High Density`,   text: 'Testimonial & brand ambassador. Berikan reward loyalitas, dokumentasi success story.' });
  if (Number(ar) < 80) recs.push({ lv: 'medium', title: 'Activation Rate < 80%', text: `Hanya ${ar}% merchant bertransaksi. Review proses onboarding dan first scan.` });
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

function SegBadge({ segment }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: 12, fontSize: 10, fontWeight: 600, color: '#fff', background: SEG_COLOR[segment] || '#94A3B8' }}>
      {SEG_LABEL[segment] || segment}
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

function InsightBlock({ s, merchants }) {
  const ins = buildInsights(s);
  if (!ins.paragraph) return null;
  const LVL = {
    high:   { label: 'Prioritas Tinggi', bg: '#FEE2E2', border: '#DC2626', color: '#DC2626' },
    medium: { label: 'Prioritas Sedang', bg: '#F0FDF4', border: '#10B981', color: '#059669' },
  };
  return (
    <div className="wrfp-insight-block">
      <div className="wrfp-exec-card">
        <div className="wrfp-exec-header"><i className="ti ti-report-analytics" style={{ color: COLOR }} />Ringkasan Eksekutif</div>
        <p className="wrfp-exec-text">{ins.paragraph}</p>
      </div>
      {ins.recs.length > 0 && (
        <div className="wrfp-exec-card">
          <div className="wrfp-exec-header"><i className="ti ti-bulb" style={{ color: COLOR }} />Rekomendasi Tindakan</div>
          <div className="wrfp-recs-list">
            {ins.recs.map((r, i) => {
              const lv = LVL[r.lv] || LVL.medium;
              return (
                <div key={i} className="wrfp-rec-item" style={{ borderLeft: `3px solid ${lv.border}`, background: lv.bg }}>
                  <div className="wrfp-rec-top"><span className="wrfp-rec-title">{r.title}</span><span className="wrfp-rec-level" style={{ color: lv.color }}>{lv.label}</span></div>
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
function ExecutiveTab({ ms }) {
  const s = buildSummary(ms);
  const chartId = ms.length;

  const segData = useMemo(() => {
    const m = {};
    ms.forEach(m2 => { m[m2.segment] = (m[m2.segment] || 0) + 1; });
    return SEG_ORDER.filter(k => m[k] > 0).map(k => ({ key: k, count: m[k] }));
  }, [ms]);

  const provData = useMemo(() => {
    const m = {};
    ms.forEach(m2 => {
      const p = m2.province || 'N/A';
      if (!m[p]) m[p] = { count: 0, trx: 0 };
      m[p].count++; m[p].trx += parseInt(m2.total_transaction) || 0;
    });
    return Object.entries(m).sort((a, b) => b[1].count - a[1].count).slice(0, 10).map(([p, v]) => ({ province: p, ...v }));
  }, [ms]);

  const cohortData = useMemo(() => {
    const m = {};
    ms.forEach(m2 => {
      const b = m2.bulan;
      if (!m[b]) m[b] = { total: 0, activated: 0, repeat: 0, trx: 0 };
      m[b].total++;
      if (m2.total_transaction > 0) m[b].activated++;
      if (m2.total_transaction >= 3) m[b].repeat++;
      m[b].trx += parseInt(m2.total_transaction) || 0;
    });
    return Object.entries(m).sort().map(([b, v]) => ({ bulan: b, ...v }));
  }, [ms]);

  return (
    <>
      <div className="wrfp-kpi-grid">
        <KPICard label="Total Merchant" value={fmtN(s.total)} sub={`${Object.keys(BULAN_LABEL).filter(b => ms.some(m => m.bulan === b)).length} cohort bulan`} />
        <KPICard label="Activation Rate" value={fmtPct(s.activated, s.total)}
          sub={`${fmtN(s.activated)} merchant aktif`}
          badge={s.activated / s.total >= 0.8 ? '✓' : '↓'}
          badgeColor={s.activated / s.total >= 0.8 ? '#059669' : '#DC2626'} />
        <KPICard label="Active 7 Hari" value={fmtN(s.active7d)} sub={fmtPct(s.active7d, s.activated) + ' dari yang aktif'} badge={s.active7d > 0 ? '▲' : '–'} badgeColor={s.active7d > 0 ? '#059669' : '#9CA3AF'} />
        <KPICard label="Total Transaksi" value={fmtN(s.totalTrx)} sub={`Avg ${s.avgTrx} trx/merchant aktif`} />
        <KPICard label="High Density" value={fmtN(s.highDensity)} sub="avg ≥1 trx/hari, 7 hari aktif" badge="★" badgeColor="#7C3AED" />
        <KPICard label="Churn Merchant" value={fmtN(s.churned)} sub={fmtPct(s.churned, s.total) + ' dari total'}
          badge={s.churned > 0 ? '!' : '✓'} badgeColor={s.churned > 0 ? '#DC2626' : '#059669'} />
      </div>

      <div className="wrfp-charts-2col">
        <ChartCard title="🎯 Distribusi Segmentasi Merchant">
          <DonutChart id={`exec-seg-${chartId}`}
            labels={segData.map(d => SEG_LABEL[d.key])}
            values={segData.map(d => d.count)}
            colors={segData.map(d => SEG_COLOR[d.key])} />
        </ChartCard>
        <ChartCard title="🗺️ Top 10 Provinsi (Merchant Count)">
          <HBarChart id={`exec-prov-${chartId}`}
            labels={provData.map(p => p.province)}
            values={provData.map(p => p.count)}
            color={COLOR} />
        </ChartCard>
      </div>

      {cohortData.length > 1 && (
        <div className="wrfp-chart-card">
          <div className="wrfp-chart-title">📊 Perbandingan Cohort Bulanan</div>
          <div className="wrfp-chart-box" style={{ height: 220 }}>
            <GroupedBarChart id={`exec-cohort-${chartId}`}
              labels={cohortData.map(c => BULAN_LABEL[c.bulan] || c.bulan)}
              datasets={[
                { label: 'Total', data: cohortData.map(c => c.total), backgroundColor: '#94A3B8' },
                { label: 'Activated', data: cohortData.map(c => c.activated), backgroundColor: '#10B981' },
                { label: 'Repeat ≥3', data: cohortData.map(c => c.repeat), backgroundColor: COLOR },
              ]} />
          </div>
        </div>
      )}

      <InsightBlock s={s} merchants={ms} />
    </>
  );
}

/* ════════════════════════════════════════════
   TAB 1 — Merchant Master
════════════════════════════════════════════ */
function MerchantTab({ ms }) {
  const [q, setQ]           = useState('');
  const [fProv, setFProv]   = useState('');
  const [fSeg, setFSeg]     = useState('');
  const [fCat, setFCat]     = useState('');
  const [sortF, setSortF]   = useState('total_transaction');
  const [sortD, setSortD]   = useState('desc');
  const [page, setPage]     = useState(1);
  const PS = 50;

  const provinces  = useMemo(() => [...new Set(ms.map(m => m.province).filter(Boolean))].sort(), [ms]);
  const categories = useMemo(() => [...new Set(ms.map(m => m.category).filter(Boolean))].sort(), [ms]);

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return ms.filter(m =>
      (!ql || m.merchant_id.toLowerCase().includes(ql) || (m.merchant_name || '').toLowerCase().includes(ql)) &&
      (!fProv || m.province === fProv) &&
      (!fSeg  || m.segment === fSeg)  &&
      (!fCat  || m.category === fCat)
    ).sort((a, b) => {
      const va = a[sortF], vb = b[sortF], d = sortD === 'asc' ? 1 : -1;
      if (va == null) return 1; if (vb == null) return -1;
      return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
    });
  }, [ms, q, fProv, fSeg, fCat, sortF, sortD]);

  const paged = filtered.slice((page - 1) * PS, page * PS);

  const sort = f => {
    if (sortF === f) setSortD(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortF(f); setSortD('desc'); }
    setPage(1);
  };
  const reset = () => { setQ(''); setFProv(''); setFSeg(''); setFCat(''); setPage(1); };

  return (
    <div>
      <div className="writ-filter-bar">
        <input className="writ-filter-input" placeholder="🔍 Cari ID Outlet atau Nama Merchant..." value={q} onChange={e => { setQ(e.target.value); setPage(1); }} />
        <select className="writ-filter-select" value={fSeg} onChange={e => { setFSeg(e.target.value); setPage(1); }}>
          <option value="">Semua Segmen</option>
          {SEG_ORDER.map(k => <option key={k} value={k}>{SEG_LABEL[k]}</option>)}
        </select>
        <select className="writ-filter-select" value={fProv} onChange={e => { setFProv(e.target.value); setPage(1); }}>
          <option value="">Semua Provinsi</option>
          {provinces.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="writ-filter-select" value={fCat} onChange={e => { setFCat(e.target.value); setPage(1); }}>
          <option value="">Semua Kategori</option>
          {categories.map(c => <option key={c} value={c}>MCC {c}</option>)}
        </select>
        <span className="writ-filter-badge">{fmtN(filtered.length)} hasil</span>
        {(q || fProv || fSeg || fCat) && <button className="writ-filter-clear" onClick={reset}>Reset Filter</button>}
      </div>
      <div className="writ-table-wrap">
        <table className="writ-table">
          <thead>
            <tr>
              <th className="writ-th" style={{ width: 32 }}>#</th>
              {[
                ['merchant_id',       'ID Outlet'],
                ['merchant_name',     'Nama Merchant'],
                ['category',          'MCC'],
                ['city',              'Kota'],
                ['province',          'Provinsi'],
                ['bulan',             'Bulan'],
                ['total_transaction', 'TRX'],
                ['days_since_last_trx','Hari Lalu'],
                ['final_priority_score','Score'],
              ].map(([f, l]) => <SortTh key={f} field={f} label={l} sortF={sortF} sortD={sortD} onSort={sort} />)}
              <th className="writ-th">Segmen</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((m, i) => (
              <tr key={m.merchant_id + m.bulan} className="writ-tr">
                <td className="writ-td" style={{ color: 'var(--text-3)' }}>{(page - 1) * PS + i + 1}</td>
                <td className="writ-td" style={{ fontFamily: 'monospace', fontSize: 11 }}>{m.merchant_id}</td>
                <td className="writ-td writ-td-name" style={{ fontWeight: 500, color: 'var(--text-1)' }} title={m.merchant_name}>{m.merchant_name || '—'}</td>
                <td className="writ-td" style={{ color: 'var(--text-3)' }}>{m.category || '—'}</td>
                <td className="writ-td">{m.city || '—'}</td>
                <td className="writ-td">{m.province || '—'}</td>
                <td className="writ-td" style={{ color: 'var(--text-3)' }}>{BULAN_LABEL[m.bulan] || m.bulan}</td>
                <td className="writ-td" style={{ fontWeight: 700, color: COLOR }}>{fmtN(m.total_transaction)}</td>
                <td className="writ-td" style={{ color: m.days_since_last_trx > 30 ? '#DC2626' : 'var(--text-2)' }}>
                  {m.total_transaction > 0 ? m.days_since_last_trx + 'h' : '–'}
                </td>
                <td className="writ-td"><span className={scoreClass(m.final_priority_score)}>{m.final_priority_score}</span></td>
                <td className="writ-td"><SegBadge segment={m.segment} /></td>
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
function SegmentasiTab({ ms }) {
  const [activeSeg, setActiveSeg] = useState(null);
  const [q, setQ]   = useState('');
  const [sortF, setSortF] = useState('total_transaction');
  const [sortD, setSortD] = useState('desc');
  const [page, setPage]   = useState(1);
  const PS = 50;

  const segCounts = useMemo(() => {
    const m = {};
    ms.forEach(m2 => { m[m2.segment] = (m[m2.segment] || 0) + 1; });
    return m;
  }, [ms]);

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return ms.filter(m =>
      (!activeSeg || m.segment === activeSeg) &&
      (!ql || m.merchant_id.toLowerCase().includes(ql) || (m.merchant_name || '').toLowerCase().includes(ql))
    ).sort((a, b) => {
      const va = a[sortF], vb = b[sortF], d = sortD === 'asc' ? 1 : -1;
      if (va == null) return 1; if (vb == null) return -1;
      return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
    });
  }, [ms, activeSeg, q, sortF, sortD]);

  const paged = filtered.slice((page - 1) * PS, page * PS);
  const sort = f => { if (sortF === f) setSortD(d => d === 'asc' ? 'desc' : 'asc'); else { setSortF(f); setSortD('desc'); } setPage(1); };

  return (
    <div>
      <div className="writ-seg-grid">
        {SEG_ORDER.map(key => {
          const count = segCounts[key] || 0;
          const pct = ms.length > 0 ? (count / ms.length * 100).toFixed(1) : 0;
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
            <div style={{ width: 4, height: '100%', background: SEG_COLOR[activeSeg], borderRadius: 2, flexShrink: 0 }} />
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
        <span className="writ-filter-badge">{fmtN(filtered.length)} merchant {activeSeg ? `(${SEG_LABEL[activeSeg]})` : '(semua segmen)'}</span>
        {activeSeg && <button className="writ-filter-clear" onClick={() => { setActiveSeg(null); setPage(1); }}>Hapus Filter Segmen</button>}
      </div>
      <div className="writ-table-wrap">
        <table className="writ-table">
          <thead>
            <tr>
              <th className="writ-th">#</th>
              {[['merchant_id','ID'],['merchant_name','Nama'],['city','Kota'],['province','Provinsi'],
                ['bulan','Bulan'],['total_transaction','TRX'],['days_since_last_trx','Hari Lalu']].map(([f,l]) =>
                <SortTh key={f} field={f} label={l} sortF={sortF} sortD={sortD} onSort={sort} />)}
              <th className="writ-th">Segmen</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((m, i) => (
              <tr key={m.merchant_id + m.bulan} className="writ-tr">
                <td className="writ-td" style={{ color: 'var(--text-3)' }}>{(page - 1) * PS + i + 1}</td>
                <td className="writ-td" style={{ fontFamily: 'monospace', fontSize: 11 }}>{m.merchant_id}</td>
                <td className="writ-td writ-td-name" title={m.merchant_name}>{m.merchant_name || '—'}</td>
                <td className="writ-td">{m.city || '—'}</td>
                <td className="writ-td">{m.province || '—'}</td>
                <td className="writ-td" style={{ color: 'var(--text-3)' }}>{BULAN_LABEL[m.bulan] || m.bulan}</td>
                <td className="writ-td" style={{ fontWeight: 700, color: COLOR }}>{fmtN(m.total_transaction)}</td>
                <td className="writ-td" style={{ color: m.days_since_last_trx > 30 ? '#DC2626' : 'var(--text-2)' }}>
                  {m.total_transaction > 0 ? m.days_since_last_trx + 'h' : '–'}
                </td>
                <td className="writ-td"><SegBadge segment={m.segment} /></td>
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
   TAB 3 — Cohort Analysis
════════════════════════════════════════════ */
function CohortTab({ ms }) {
  const cohorts = useMemo(() => {
    const m = {};
    ms.forEach(m2 => {
      const b = m2.bulan;
      if (!m[b]) m[b] = { bulan: b, total: 0, activated: 0, repeat: 0, highDensity: 0, churn: 0, trx: 0 };
      m[b].total++;
      if (m2.total_transaction > 0) m[b].activated++;
      if (m2.total_transaction >= 3) m[b].repeat++;
      if (m2.segment === 'high_density') m[b].highDensity++;
      if (m2.segment === 'churn') m[b].churn++;
      m[b].trx += parseInt(m2.total_transaction) || 0;
    });
    return Object.values(m).sort((a, b) => a.bulan.localeCompare(b.bulan));
  }, [ms]);

  const segPerCohort = useMemo(() => {
    const m = {};
    ms.forEach(m2 => {
      const key = m2.bulan + '|' + m2.segment;
      m[key] = (m[key] || 0) + 1;
    });
    return m;
  }, [ms]);

  const chartId = ms.length;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cohorts.length || 1}, 1fr)`, gap: 12, marginBottom: 18 }}>
        {cohorts.map(c => {
          const ar = c.total > 0 ? (c.activated / c.total * 100).toFixed(1) : 0;
          const rr = c.activated > 0 ? (c.repeat / c.activated * 100).toFixed(1) : 0;
          return (
            <div key={c.bulan} className="wrfp-chart-card" style={{ margin: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: COLOR, marginBottom: 12 }}>{BULAN_LABEL[c.bulan] || c.bulan}</div>
              {[
                ['Total Merchant', fmtN(c.total), 'var(--text-3)'],
                ['Activated', fmtN(c.activated), '#10B981'],
                ['Activation Rate', ar + '%', ar >= 80 ? '#059669' : '#DC2626'],
                ['Repeat (≥3 TRX)', fmtN(c.repeat), '#059669'],
                ['Repeat Rate', rr + '%', '#059669'],
                ['High Density', fmtN(c.highDensity), '#7C3AED'],
                ['Churn', fmtN(c.churn), c.churn > 0 ? '#DC2626' : 'var(--text-3)'],
                ['Total TRX', fmtN(c.trx), COLOR],
              ].map(([l, v, col]) => (
                <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-3)' }}>{l}</span>
                  <span style={{ color: col, fontWeight: 600 }}>{v}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {cohorts.length > 1 && (
        <div className="wrfp-charts-2col">
          <ChartCard title="📊 Perbandingan Aktivasi per Cohort" height={240}>
            <GroupedBarChart id={`cohort-bar-${chartId}`}
              labels={cohorts.map(c => BULAN_LABEL[c.bulan] || c.bulan)}
              datasets={[
                { label: 'Total',       data: cohorts.map(c => c.total),      backgroundColor: '#CBD5E1' },
                { label: 'Activated',   data: cohorts.map(c => c.activated),  backgroundColor: '#10B981' },
                { label: 'Repeat ≥3',  data: cohorts.map(c => c.repeat),     backgroundColor: COLOR },
                { label: 'High Density',data: cohorts.map(c => c.highDensity),backgroundColor: '#7C3AED' },
              ]} />
          </ChartCard>
          <ChartCard title="🔴 Distribusi Churn & Health per Cohort" height={240}>
            <GroupedBarChart id={`cohort-health-${chartId}`}
              labels={cohorts.map(c => BULAN_LABEL[c.bulan] || c.bulan)}
              datasets={[
                { label: 'High Density', data: cohorts.map(c => c.highDensity), backgroundColor: '#7C3AED' },
                { label: 'Churn',        data: cohorts.map(c => c.churn),       backgroundColor: '#DC2626' },
                { label: 'Dormant',      data: cohorts.map(c => segPerCohort[c.bulan + '|dormant'] || 0), backgroundColor: '#EF4444' },
                { label: 'Declining',    data: cohorts.map(c => segPerCohort[c.bulan + '|declining'] || 0), backgroundColor: '#F59E0B' },
              ]} />
          </ChartCard>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 4 — Behavior Score
════════════════════════════════════════════ */
function ScoreTab({ ms }) {
  const [q, setQ]         = useState('');
  const [minScore, setMin]= useState(0);
  const [sortF, setSortF] = useState('final_priority_score');
  const [sortD, setSortD] = useState('desc');
  const [page, setPage]   = useState(1);
  const PS = 50;

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return ms.filter(m =>
      Number(m.final_priority_score) >= Number(minScore) &&
      (!ql || m.merchant_id.toLowerCase().includes(ql) || (m.merchant_name || '').toLowerCase().includes(ql))
    ).sort((a, b) => {
      const va = a[sortF], vb = b[sortF], d = sortD === 'asc' ? 1 : -1;
      if (va == null) return 1; if (vb == null) return -1;
      return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
    });
  }, [ms, q, minScore, sortF, sortD]);

  const paged = filtered.slice((page - 1) * PS, page * PS);
  const sort = f => { if (sortF === f) setSortD(d => d === 'asc' ? 'desc' : 'asc'); else { setSortF(f); setSortD('desc'); } setPage(1); };

  return (
    <div>
      <div className="wrfp-chart-card" style={{ marginBottom: 14, padding: '12px 16px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.8 }}>
          <strong>Behavior Score Formula:</strong> Repeat Scan (25%) + Merchant Activation (15%) + Transaction Density (25%) + Retention (20%) + Ecosystem Dependency (15%). Skor 0–100. Merchant dengan skor tinggi = prioritas pertahankan; skor rendah + segmen at-risk = prioritas recovery.
        </div>
      </div>
      <div className="writ-filter-bar">
        <input className="writ-filter-input" placeholder="🔍 Cari ID atau Nama..." value={q} onChange={e => { setQ(e.target.value); setPage(1); }} />
        <select className="writ-filter-select" value={minScore} onChange={e => { setMin(e.target.value); setPage(1); }}>
          <option value={0}>Semua Score</option>
          <option value={70}>Score ≥ 70 (Tinggi)</option>
          <option value={40}>Score ≥ 40 (Sedang)</option>
          <option value={1}>Score > 0 (Aktif)</option>
        </select>
        <span className="writ-filter-badge">{fmtN(filtered.length)} merchant</span>
      </div>
      <div className="writ-table-wrap">
        <table className="writ-table">
          <thead>
            <tr>
              <th className="writ-th" style={{ width: 32 }}>#</th>
              {[['merchant_id','ID'],['merchant_name','Nama'],['final_priority_score','Score Total'],
                ['repeat_scan_score','Repeat'],['transaction_density_score','Density'],
                ['retention_score','Retention'],['ecosystem_dependency_score','Ecosystem']].map(([f,l]) =>
                <SortTh key={f} field={f} label={l} sortF={sortF} sortD={sortD} onSort={sort} />)}
              <th className="writ-th">Segmen</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((m, i) => (
              <tr key={m.merchant_id + m.bulan} className="writ-tr">
                <td className="writ-td" style={{ color: 'var(--text-3)' }}>{(page - 1) * PS + i + 1}</td>
                <td className="writ-td" style={{ fontFamily: 'monospace', fontSize: 11 }}>{m.merchant_id}</td>
                <td className="writ-td writ-td-name" title={m.merchant_name}>{m.merchant_name || '—'}</td>
                {['final_priority_score','repeat_scan_score','transaction_density_score','retention_score','ecosystem_dependency_score'].map(k => (
                  <td key={k} className="writ-td"><span className={scoreClass(m[k])}>{m[k]}</span></td>
                ))}
                <td className="writ-td"><SegBadge segment={m.segment} /></td>
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
   TAB 5 — Territory Intelligence
════════════════════════════════════════════ */
function TerritoryTab({ ms }) {
  const [fTerr, setFTerr] = useState('');
  const [sortF, setSortF] = useState('merchant_count');
  const [sortD, setSortD] = useState('desc');
  const chartId = ms.length;

  const terrData = useMemo(() => {
    const m = {};
    ms.forEach(m2 => {
      const t = m2.territory_cluster || 'Lainnya';
      if (!m[t]) m[t] = { terr: t, count: 0, activated: 0, trx: 0, churn: 0 };
      m[t].count++;
      if (m2.total_transaction > 0) m[t].activated++;
      m[t].trx += parseInt(m2.total_transaction) || 0;
      if (m2.segment === 'churn') m[t].churn++;
    });
    return Object.values(m).sort((a, b) => b.count - a.count);
  }, [ms]);

  const provData = useMemo(() => {
    const m = {};
    ms.filter(m2 => !fTerr || m2.territory_cluster === fTerr).forEach(m2 => {
      const p = m2.province || 'N/A';
      if (!m[p]) m[p] = { province: p, merchant_count: 0, activated: 0, total_trx: 0, churn: 0, terr: m2.territory_cluster };
      m[p].merchant_count++;
      if (m2.total_transaction > 0) m[p].activated++;
      m[p].total_trx += parseInt(m2.total_transaction) || 0;
      if (m2.segment === 'churn') m[p].churn++;
    });
    const arr = Object.values(m).sort((a, b) => {
      const va = a[sortF], vb = b[sortF], d = sortD === 'asc' ? 1 : -1;
      return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
    });
    return arr;
  }, [ms, fTerr, sortF, sortD]);

  const sort = f => { if (sortF === f) setSortD(d => d === 'asc' ? 'desc' : 'asc'); else { setSortF(f); setSortD('desc'); } };

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        {terrData.map(t => {
          const ar = t.count > 0 ? (t.activated / t.count * 100).toFixed(0) : 0;
          const active = fTerr === t.terr;
          return (
            <div key={t.terr} onClick={() => setFTerr(active ? '' : t.terr)}
              style={{ padding: '12px 14px', borderRadius: 10, border: `2px solid ${active ? (TERR_COLOR[t.terr] || COLOR) : 'var(--border)'}`,
                background: (TERR_COLOR[t.terr] || COLOR) + '10', cursor: 'pointer' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: TERR_COLOR[t.terr] || COLOR }}>{t.terr}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-1)' }}>{fmtN(t.count)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>AR: {ar}% | TRX: {fmtN(t.trx)}</div>
              {t.churn > 0 && <div style={{ fontSize: 10, color: '#DC2626', marginTop: 2 }}>{t.churn} churn</div>}
            </div>
          );
        })}
      </div>
      <div className="wrfp-charts-2col" style={{ marginBottom: 14 }}>
        <ChartCard title="📊 Merchant Count per Territory" height={200}>
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
                {[['province','Provinsi'],['merchant_count','Merchant'],['activated','Activated'],['total_trx','Total TRX'],['churn','Churn']].map(([f,l]) =>
                  <SortTh key={f} field={f} label={l} sortF={sortF} sortD={sortD} onSort={sort} />)}
                <th className="writ-th">AR%</th>
                <th className="writ-th">Territory</th>
              </tr>
            </thead>
            <tbody>
              {provData.map((p, i) => {
                const ar = p.merchant_count > 0 ? (p.activated / p.merchant_count * 100).toFixed(1) : 0;
                return (
                  <tr key={p.province} className="writ-tr">
                    <td className="writ-td" style={{ color: 'var(--text-3)' }}>{i + 1}</td>
                    <td className="writ-td" style={{ fontWeight: 600 }}>{p.province}</td>
                    <td className="writ-td" style={{ fontWeight: 700, color: COLOR }}>{fmtN(p.merchant_count)}</td>
                    <td className="writ-td" style={{ color: '#10B981' }}>{fmtN(p.activated)}</td>
                    <td className="writ-td">{fmtN(p.total_trx)}</td>
                    <td className="writ-td" style={{ color: p.churn > 0 ? '#DC2626' : 'var(--text-3)' }}>{p.churn}</td>
                    <td className="writ-td"><span style={{ fontWeight: 700, fontSize: 12, color: ar >= 80 ? '#059669' : ar >= 50 ? '#D97706' : '#DC2626' }}>{ar}%</span></td>
                    <td className="writ-td"><span style={{ padding: '2px 8px', borderRadius: 8, fontSize: 10, background: (TERR_COLOR[p.terr] || COLOR) + '20', color: TERR_COLOR[p.terr] || COLOR, fontWeight: 600 }}>{p.terr}</span></td>
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
function GrowthTab({ ms }) {
  const [view, setView] = useState('growing');
  const [q, setQ]       = useState('');
  const [page6, setPage6] = useState(1);
  const PS = 50;

  const groups = useMemo(() => ({
    growing:  ms.filter(m => ['high_density','daily_active','repeat_scan'].includes(m.segment)).sort((a, b) => b.final_priority_score - a.final_priority_score),
    at_risk:  ms.filter(m => ['declining','dormant','churn'].includes(m.segment)).sort((a, b) => b.total_transaction - a.total_transaction),
    inactive: ms.filter(m => m.segment === 'new_merchant'),
    stable:   ms.filter(m => m.segment === 'activated').sort((a, b) => b.total_transaction - a.total_transaction),
  }), [ms]);

  const current = groups[view] || [];
  const filtered6 = useMemo(() => {
    const ql = q.toLowerCase();
    return ql ? current.filter(m => m.merchant_id.includes(ql) || (m.merchant_name || '').toLowerCase().includes(ql)) : current;
  }, [current, q]);
  const paged6 = filtered6.slice((page6 - 1) * PS, page6 * PS);

  const VIEWS = [
    { key: 'growing', label: '⬆️ Growing', color: '#059669', desc: 'High Density + Daily Active + Repeat Scan' },
    { key: 'at_risk', label: '⚠️ At Risk',  color: '#DC2626', desc: 'Declining + Dormant + Churn' },
    { key: 'inactive',label: '⭕ Belum Aktif', color: '#94A3B8', desc: 'New Merchant — belum transaksi' },
    { key: 'stable',  label: '✅ Stable',    color: '#0EA5E9', desc: 'Activated — aktif stabil' },
  ];

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        {VIEWS.map(v => (
          <div key={v.key} onClick={() => { setView(v.key); setPage6(1); setQ(''); }}
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
        <input className="writ-filter-input" placeholder="🔍 Cari ID atau Nama..." value={q} onChange={e => { setQ(e.target.value); setPage6(1); }} />
        <span className="writ-filter-badge">{fmtN(filtered6.length)} merchant</span>
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
              <th className="writ-th">TRX</th>
              <th className="writ-th">Hari Lalu</th>
              <th className="writ-th">Score</th>
              <th className="writ-th">Segmen</th>
            </tr>
          </thead>
          <tbody>
            {paged6.map((m, i) => (
              <tr key={m.merchant_id + m.bulan} className="writ-tr">
                <td className="writ-td" style={{ color: 'var(--text-3)' }}>{(page6 - 1) * PS + i + 1}</td>
                <td className="writ-td" style={{ fontFamily: 'monospace', fontSize: 11 }}>{m.merchant_id}</td>
                <td className="writ-td writ-td-name" title={m.merchant_name}>{m.merchant_name || '—'}</td>
                <td className="writ-td">{m.city || '—'}</td>
                <td className="writ-td">{m.province || '—'}</td>
                <td className="writ-td" style={{ fontWeight: 700, color: COLOR }}>{fmtN(m.total_transaction)}</td>
                <td className="writ-td" style={{ color: m.days_since_last_trx > 30 ? '#DC2626' : 'var(--text-2)' }}>
                  {m.total_transaction > 0 ? m.days_since_last_trx + 'h' : '–'}
                </td>
                <td className="writ-td"><span className={scoreClass(m.final_priority_score)}>{m.final_priority_score}</span></td>
                <td className="writ-td"><SegBadge segment={m.segment} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Paginator total={filtered6.length} page={page6} pageSize={PS} setPage={setPage6} />
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 7 — Kategori (MCC)
════════════════════════════════════════════ */
function KategoriTab({ ms }) {
  const [sortF7, setSortF7] = useState('merchant_count');
  const [sortD7, setSortD7] = useState('desc');
  const [selCat, setSelCat] = useState(null);
  const [q7, setQ7]         = useState('');
  const [page7, setPage7]   = useState(1);
  const PS = 50;
  const chartId7 = ms.length;

  const catData = useMemo(() => {
    const m = {};
    ms.forEach(m2 => {
      const c = m2.category || 'N/A';
      if (!m[c]) m[c] = { category: c, merchant_count: 0, activated: 0, total_trx: 0, churn: 0, new_m: 0 };
      m[c].merchant_count++;
      if (m2.total_transaction > 0) m[c].activated++;
      m[c].total_trx += parseInt(m2.total_transaction) || 0;
      if (m2.segment === 'churn') m[c].churn++;
      if (m2.segment === 'new_merchant') m[c].new_m++;
    });
    return Object.values(m);
  }, [ms]);

  const sorted7 = useMemo(() => [...catData].sort((a, b) => {
    const va = a[sortF7], vb = b[sortF7], d = sortD7 === 'asc' ? 1 : -1;
    return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
  }), [catData, sortF7, sortD7]);

  const drillMs = useMemo(() => {
    if (!selCat) return [];
    const ql = q7.toLowerCase();
    return ms.filter(m => m.category === selCat &&
      (!ql || m.merchant_id.includes(ql) || (m.merchant_name || '').toLowerCase().includes(ql))
    ).sort((a, b) => b.total_transaction - a.total_transaction);
  }, [ms, selCat, q7]);

  const pagedDrill = drillMs.slice((page7 - 1) * PS, page7 * PS);
  const sort7 = f => { if (sortF7 === f) setSortD7(d => d === 'asc' ? 'desc' : 'asc'); else { setSortF7(f); setSortD7('desc'); } };
  const top10cat = [...catData].sort((a, b) => b.merchant_count - a.merchant_count).slice(0, 10);

  return (
    <div>
      <div className="wrfp-charts-2col" style={{ marginBottom: 14 }}>
        <ChartCard title="📊 Top 10 MCC — Merchant Count" height={220}>
          <HBarChart id={`cc-${chartId7}`} labels={top10cat.map(c => `MCC ${c.category}`)} values={top10cat.map(c => c.merchant_count)} color={COLOR} />
        </ChartCard>
        <ChartCard title="💳 Top 10 MCC — Total TRX" height={220}>
          <HBarChart id={`ct-${chartId7}`} labels={top10cat.map(c => `MCC ${c.category}`)} values={top10cat.map(c => c.total_trx)} color={THEME2} />
        </ChartCard>
      </div>
      <div className="wrfp-chart-card" style={{ marginTop: 0 }}>
        <div className="wrfp-chart-title">🏷️ {selCat ? `Merchant MCC ${selCat}` : 'Semua Kategori MCC'}</div>
        {!selCat ? (
          <div className="writ-table-wrap">
            <table className="writ-table">
              <thead>
                <tr>
                  <th className="writ-th">#</th>
                  {[['category','MCC'],['merchant_count','Merchant'],['activated','Activated'],['total_trx','TRX'],['churn','Churn'],['new_m','Belum Aktif']].map(([f,l]) =>
                    <SortTh key={f} field={f} label={l} sortF={sortF7} sortD={sortD7} onSort={sort7} />)}
                  <th className="writ-th">AR%</th>
                  <th className="writ-th"></th>
                </tr>
              </thead>
              <tbody>
                {sorted7.map((c, i) => {
                  const ar7 = c.merchant_count > 0 ? (c.activated / c.merchant_count * 100).toFixed(1) : 0;
                  return (
                    <tr key={c.category} className="writ-tr">
                      <td className="writ-td" style={{ color: 'var(--text-3)' }}>{i + 1}</td>
                      <td className="writ-td" style={{ fontWeight: 700, fontFamily: 'monospace' }}>MCC {c.category}</td>
                      <td className="writ-td" style={{ fontWeight: 700, color: COLOR }}>{fmtN(c.merchant_count)}</td>
                      <td className="writ-td" style={{ color: '#10B981' }}>{fmtN(c.activated)}</td>
                      <td className="writ-td">{fmtN(c.total_trx)}</td>
                      <td className="writ-td" style={{ color: c.churn > 0 ? '#DC2626' : 'var(--text-3)' }}>{c.churn}</td>
                      <td className="writ-td" style={{ color: 'var(--text-3)' }}>{c.new_m}</td>
                      <td className="writ-td"><span style={{ fontWeight: 700, fontSize: 12, color: ar7 >= 80 ? '#059669' : ar7 >= 50 ? '#D97706' : '#DC2626' }}>{ar7}%</span></td>
                      <td className="writ-td"><button className="writ-copy-btn" onClick={() => { setSelCat(c.category); setPage7(1); }}>Lihat ›</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            <div className="writ-filter-bar">
              <input className="writ-filter-input" placeholder="🔍 Cari ID atau Nama..." value={q7} onChange={e => { setQ7(e.target.value); setPage7(1); }} />
              <span className="writ-filter-badge">{fmtN(drillMs.length)} merchant MCC {selCat}</span>
              <button className="writ-filter-clear" onClick={() => { setSelCat(null); setQ7(''); }}>← Kembali</button>
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
                    <th className="writ-th">TRX</th>
                    <th className="writ-th">Hari Lalu</th>
                    <th className="writ-th">Segmen</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedDrill.map((m, i) => (
                    <tr key={m.merchant_id + m.bulan} className="writ-tr">
                      <td className="writ-td" style={{ color: 'var(--text-3)' }}>{(page7 - 1) * PS + i + 1}</td>
                      <td className="writ-td" style={{ fontFamily: 'monospace', fontSize: 11 }}>{m.merchant_id}</td>
                      <td className="writ-td writ-td-name" title={m.merchant_name}>{m.merchant_name || '—'}</td>
                      <td className="writ-td">{m.city || '—'}</td>
                      <td className="writ-td">{m.province || '—'}</td>
                      <td className="writ-td" style={{ fontWeight: 700, color: COLOR }}>{fmtN(m.total_transaction)}</td>
                      <td className="writ-td" style={{ color: m.days_since_last_trx > 30 ? '#DC2626' : 'var(--text-2)' }}>
                        {m.total_transaction > 0 ? m.days_since_last_trx + 'h' : '–'}
                      </td>
                      <td className="writ-td"><SegBadge segment={m.segment} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Paginator total={drillMs.length} page={page7} pageSize={PS} setPage={setPage7} />
          </>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 8 — Action Center
════════════════════════════════════════════ */
function ActionPanel({ title, color, merchants, helpText }) {
  const [qA, setQA]       = useState('');
  const [pageA, setPageA] = useState(1);
  const [copied, setCopied] = useState(false);
  const PS = 30;

  const filteredA = useMemo(() => {
    const ql = qA.toLowerCase();
    return ql ? merchants.filter(m => m.merchant_id.includes(ql) || (m.merchant_name || '').toLowerCase().includes(ql)) : merchants;
  }, [merchants, qA]);

  const pagedA = filteredA.slice((pageA - 1) * PS, pageA * PS);

  const copyIds = () => {
    navigator.clipboard.writeText(filteredA.map(m => m.merchant_id).join('\n'));
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="writ-action-panel">
      <div className="writ-action-title">
        {title}
        <span className="writ-action-count" style={{ background: color }}>{fmtN(merchants.length)}</span>
      </div>
      {helpText && <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.6 }}>{helpText}</div>}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input className="writ-action-search" placeholder="Cari ID Outlet..." value={qA} onChange={e => { setQA(e.target.value); setPageA(1); }} style={{ flex: 1 }} />
        <button className="writ-copy-btn" onClick={copyIds}>{copied ? '✓ Copied' : 'Copy IDs'}</button>
      </div>
      <div style={{ overflowX: 'auto', maxHeight: 280, overflowY: 'auto' }}>
        <table className="writ-action-table">
          <thead><tr><th>ID Outlet</th><th>Nama</th><th>Kota</th><th>TRX</th><th>Hari Lalu</th><th>Segmen</th></tr></thead>
          <tbody>
            {pagedA.map(m => (
              <tr key={m.merchant_id + m.bulan}>
                <td style={{ fontFamily: 'monospace', fontSize: 10 }}>{m.merchant_id}</td>
                <td style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.merchant_name}>{m.merchant_name || '—'}</td>
                <td>{m.city || '—'}</td>
                <td style={{ fontWeight: 700, color: COLOR }}>{fmtN(m.total_transaction)}</td>
                <td style={{ color: m.days_since_last_trx > 30 ? '#DC2626' : 'inherit' }}>
                  {m.total_transaction > 0 ? m.days_since_last_trx + 'h' : '–'}
                </td>
                <td><SegBadge segment={m.segment} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filteredA.length > PS && <Paginator total={filteredA.length} page={pageA} pageSize={PS} setPage={setPageA} />}
    </div>
  );
}

function ActionTab({ ms }) {
  const panels = useMemo(() => ({
    save:     ms.filter(m => m.segment === 'churn').sort((a, b) => b.total_transaction - a.total_transaction),
    activate: ms.filter(m => m.segment === 'new_merchant').sort((a, b) => b.days_since_register - a.days_since_register),
    recover:  ms.filter(m => ['dormant','declining'].includes(m.segment)).sort((a, b) => b.total_transaction - a.total_transaction),
    retain:   ms.filter(m => ['high_density','daily_active'].includes(m.segment)).sort((a, b) => b.final_priority_score - a.final_priority_score),
  }), [ms]);

  return (
    <div>
      <div className="wrfp-chart-card" style={{ marginBottom: 16, padding: '12px 16px' }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-2)' }}>
          <span>🚨 <strong>Selamatkan:</strong> {fmtN(panels.save.length)} churn</span>
          <span>📞 <strong>Aktifkan:</strong> {fmtN(panels.activate.length)} belum aktif</span>
          <span>🔄 <strong>Recovery:</strong> {fmtN(panels.recover.length)} dormant+declining</span>
          <span>⭐ <strong>Pertahankan:</strong> {fmtN(panels.retain.length)} top performers</span>
        </div>
      </div>
      <div className="writ-action-grid">
        <ActionPanel title="🚨 Wajib Diselamatkan" color="#DC2626" merchants={panels.save}
          helpText="Churn >45 hari. Prioritaskan merchant dengan TRX terbesar sebelum churn." />
        <ActionPanel title="📞 Wajib Diaktifkan" color="#94A3B8" merchants={panels.activate}
          helpText="Belum pernah transaksi. Push first scan — semakin lama daftar semakin rendah kemungkinan aktif." />
        <ActionPanel title="🔄 Prioritas Recovery" color="#F59E0B" merchants={panels.recover}
          helpText="Dormant (31–45h) + Declining (14–30h). Masih bisa diselamatkan — hubungi sekarang." />
        <ActionPanel title="⭐ Pertahankan & Kembangkan" color="#7C3AED" merchants={panels.retain}
          helpText="High Density + Daily Active. Merchant terbaik — reward loyalitas, jadikan brand ambassador." />
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   TAB 9 — Export Center
════════════════════════════════════════════ */
function ExportTab({ bulanFilter }) {
  const [exporting, setExporting] = useState(null);
  const [status, setStatus]       = useState('');

  const EXPORTS = [
    { type: 'transaksi',      icon: 'ti-table',            label: 'Data Transaksi',  desc: '16 kolom: ID, nama, kategori, kota, provinsi, tanggal, TRX, skor, segmen, territory, dll.' },
    { type: 'segmentasi',     icon: 'ti-layers-intersect', label: 'Data Segmentasi', desc: '10 kolom: segment, ID, nama, kategori, kota, provinsi, bulan, TRX, last_trx, hari_lalu.' },
    { type: 'behavior_score', icon: 'ti-chart-radar',      label: 'Behavior Score',  desc: '8 kolom: merchant_id + 6 dimensi skor + final_priority_score.' },
  ];

  async function doExport(type) {
    try {
      setExporting(type); setStatus('Menyiapkan data...');
      const res = await getInstaqrisTrxExport({ type, ...(bulanFilter ? { bulan: bulanFilter } : {}) });
      setStatus(`${res.rows.length} baris — membuat file...`);
      const BOM = '﻿';
      const lines = [
        res.headers.join(','),
        ...res.rows.map(r => res.headers.map(h => {
          const v = String(r[h] ?? '');
          return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(',')),
      ];
      const blob = new Blob([BOM + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${res.filename}_${bulanFilter || 'all'}_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      setStatus(`✓ ${fmtN(res.rows.length)} baris berhasil diunduh`);
    } catch (e) {
      setStatus('❌ Gagal: ' + (e.message || e));
    } finally {
      setExporting(null);
    }
  }

  return (
    <div>
      <div className="wrfp-chart-card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.8 }}>
          Export menggunakan filter bulan aktif di header.
          {bulanFilter ? <strong style={{ color: COLOR }}> Filter: {BULAN_LABEL[bulanFilter] || bulanFilter}.</strong>
            : <span style={{ color: 'var(--text-3)' }}> Saat ini: Semua Bulan.</span>}
          {' '}BOM UTF-8 disertakan agar nama merchant terbaca benar di Excel.
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
              <button onClick={() => doExport(e.type)} disabled={!!exporting}
                style={{ padding: '10px 20px', border: `1.5px solid ${COLOR}`, borderRadius: 8,
                  background: exporting === e.type ? COLOR + '20' : COLOR,
                  color: exporting === e.type ? COLOR : '#fff', fontSize: 13, fontWeight: 600,
                  cursor: exporting ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8, opacity: (exporting && exporting !== e.type) ? 0.5 : 1 }}>
                {exporting === e.type
                  ? <><i className="ti ti-loader-2 wrfp-spin" />Menyiapkan...</>
                  : <><i className="ti ti-download" />Download CSV</>}
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
export default function WarRoomInstaqrisTrx() {
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [allMs, setAllMs]     = useState([]);
  const [bulan, setBulan]     = useState('2026-06');
  const [tab, setTab]         = useState(0);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true); setError(null);
        const { merchants } = await getInstaqrisTrxMerchants(bulan ? { bulan } : {});
        setAllMs(merchants || []);
      } catch (e) {
        setError(e.message || 'Gagal memuat data');
      } finally {
        setLoading(false);
      }
    })();
  }, [bulan]);

  const ms = allMs;

  const tabComponents = [
    <ExecutiveTab  key={0} ms={ms} />,
    <MerchantTab   key={1} ms={ms} />,
    <SegmentasiTab key={2} ms={ms} />,
    <CohortTab     key={3} ms={ms} />,
    <ScoreTab      key={4} ms={ms} />,
    <TerritoryTab  key={5} ms={ms} />,
    <GrowthTab     key={6} ms={ms} />,
    <KategoriTab   key={7} ms={ms} />,
    <ActionTab     key={8} ms={ms} />,
    <ExportTab     key={9} bulanFilter={bulan} />,
  ];

  return (
    <Layout>
      <div className="wrfp-page">
        <div className="wrfp-header">
          <div className="wrfp-header-left">
            <i className="ti ti-qrcode" style={{ color: COLOR, fontSize: 22 }} />
            <div>
              <div className="wrfp-header-title">WAR-ROOM INSTAQRIS TRX</div>
              <div className="wrfp-header-meta">Merchant Behavior · Transaction Analytics · {fmtN(ms.length)} merchant</div>
            </div>
          </div>
          <div className="wrfp-header-badges">
            <span className="wrfp-badge" style={{ background: COLOR }}>IQ-TRX</span>
            <select className="wrfp-select" value={bulan} onChange={e => setBulan(e.target.value)}>
              <option value="">Semua Bulan</option>
              <option value="2026-04">April 2026</option>
              <option value="2026-05">Mei 2026</option>
              <option value="2026-06">Juni 2026</option>
            </select>
          </div>
        </div>

        <div className="wrfp-tabs">
          {TABS.map(t => (
            <button key={t.id} className={`wrfp-tab${tab === t.id ? ' wrfp-tab--active' : ''}`} onClick={() => setTab(t.id)}>
              <i className={`ti ${t.icon}`} /> {t.label}
            </button>
          ))}
        </div>

        {loading && <div className="wrfp-loading"><i className="ti ti-loader-2 wrfp-spin" /> Memuat data merchant...</div>}
        {error   && <div className="wrfp-error"><i className="ti ti-alert-circle" /> {error}</div>}
        {!loading && !error && allMs.length === 0 && (
          <div className="wrfp-empty">
            <i className="ti ti-qrcode" style={{ color: COLOR }} />
            <div>Belum ada data merchant</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Sync dari Apps Script belum berjalan</div>
          </div>
        )}
        {!loading && !error && allMs.length > 0 && tabComponents[tab]}
      </div>
    </Layout>
  );
}

