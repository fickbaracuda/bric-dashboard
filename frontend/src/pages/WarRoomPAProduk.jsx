import { useState, useEffect, useRef, useMemo } from 'react';
import Layout from '../components/Layout';
import Chart from 'chart.js/auto';
import { getPAProdukAnalytics, getPAProdukTrendline, getPAArpuAnalytics } from '../services/api';

const THEME = '#639922';
const RED   = '#E24B4A';
const GRAY  = '#9CA3AF';

const LINE_COLORS = [
  '#639922','#E24B4A','#2563EB','#F59E0B','#8B5CF6',
  '#06B6D4','#EC4899','#14B8A6','#F97316','#84CC16',
  '#A855F7','#0EA5E9','#65A30D','#D946EF',
];

/* ─── Label bulan dinamis (bukan lagi hardcode "April"/"Mei"/"Juni") ─── */
const BULAN_ID = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
function bulanShort(bulan) {
  if (!bulan) return '-';
  const m = parseInt(bulan.slice(5, 7));
  return BULAN_ID[m] ? BULAN_ID[m].slice(0, 3) : bulan;
}
function currLabel(bulan) { return bulan ? (BULAN_ID[parseInt(bulan.slice(5, 7))] || bulan) : 'Bulan Ini'; }
function m1Label(bulan_m1) { return bulan_m1 ? (BULAN_ID[parseInt(bulan_m1.slice(5, 7))] || bulan_m1) : 'Bulan Lalu'; }
function m2Label(bulan_m2) { return bulan_m2 ? (BULAN_ID[parseInt(bulan_m2.slice(5, 7))] || bulan_m2) : '2 Bulan Lalu'; }
function bulanDisplay(bulan) {
  if (!bulan) return '-';
  const [y, m] = bulan.split('-');
  return `${BULAN_ID[parseInt(m)]} ${y}`;
}

/* ─── Helpers ─── */
const fmtRp = v => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e9) return `Rp ${(n/1e9).toFixed(1)}M`;
  if (Math.abs(n) >= 1e6) return `Rp ${(n/1e6).toFixed(1)}jt`;
  if (Math.abs(n) >= 1e3) return `Rp ${(n/1e3).toFixed(0)}rb`;
  return `Rp ${n}`;
};
const fmtN   = v => (Number(v)||0).toLocaleString('id');
const fmtPct = v => { const n = Number(v)||0; return `${n>=0?'+':''}${n.toFixed(1)}%`; };
const fmtDate = iso => {
  if (!iso) return '-';
  return new Date(String(iso).substring(0,10)+'T12:00:00').toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'});
};
const fmtDateShort = iso => {
  if (!iso) return '-';
  return new Date(String(iso).substring(0,10)+'T12:00:00').toLocaleDateString('id-ID',{day:'numeric',month:'short'});
};

const gcColor = pct => (Number(pct)||0)>0 ? THEME : (Number(pct)||0)<0 ? RED : GRAY;
const rowCls  = pct => { const n=Number(pct)||0; if(n>0) return 'wrpa-row--positive'; if(n<0) return 'wrpa-row--negative'; return ''; };

const calcArpt = (rev,trx) => Number(trx)>0 ? Math.round(Number(rev)/Number(trx)) : 0;
const calcAtpu = (trx,mat) => Number(mat)>0 ? (Number(trx)/Number(mat)).toFixed(1) : '0.0';
const calcArpu = (rev,mat) => Number(mat)>0 ? Math.round(Number(rev)/Number(mat)) : 0;

function produkBadge(row) {
  if (Number(row.rev_curr)<Number(row.rev_m1) && Number(row.rev_m1)<Number(row.rev_m2))
    return { label:'Kritis', cls:'wrpa-badge--kritis' };
  if (Number(row.pct_rev_growth)>10)
    return { label:'Bintang', cls:'wrpa-badge--bintang' };
  return { label:'Stabil', cls:'wrpa-badge--stabil' };
}

/* ─── Insights computation ─── */
// stats = server-side counts across all outlets (not just top-100 sample)
function computeInsights(data, total, stats, bulan) {
  if (!data?.length) return [];
  const curr = currLabel(bulan);
  const prev = m1Label(bulan?.bulan_m1);
  const valid = data.filter(r => Number(r.rev_curr)>0 || Number(r.rev_m1)>0);
  const list = [];

  const growing   = stats?.growing   ?? valid.filter(r=>(Number(r.pct_rev_growth)||0)>0).length;
  const declining = stats?.declining ?? valid.filter(r=>(Number(r.pct_rev_growth)||0)<0).length;
  const activeCurr = stats?.active_curr ?? valid.length;
  const pctGrow   = activeCurr > 0 ? ((growing/activeCurr)*100).toFixed(0) : 0;

  // 1 — Portfolio health
  list.push({
    type: growing>=declining ? 'positive' : 'negative',
    icon: growing>=declining ? '📊' : '⚠️',
    title: `Kesehatan Portofolio: ${pctGrow}% outlet tumbuh (${fmtN(growing)}/${fmtN(activeCurr)} aktif)`,
    desc: `${fmtN(growing)} outlet revenue naik, ${fmtN(declining)} outlet turun dibanding ${prev}`,
    action: declining>growing
      ? `Prioritaskan penanganan ${fmtN(declining)} outlet yang menurun — risiko > peluang saat ini`
      : `Pertahankan momentum — dokumentasikan best practice dari outlet tumbuh`,
  });

  // 2 — Star performer
  const star = [...valid].filter(r=>(Number(r.pct_rev_growth)||0)>0)
    .sort((a,b)=>(Number(b.pct_rev_growth)||0)-(Number(a.pct_rev_growth)||0))[0];
  if (star) {
    const delta = Number(star.rev_curr)-Number(star.rev_m1);
    list.push({
      type:'positive', icon:'🌟',
      title:`Bintang: ${star.produk} revenue +${Number(star.pct_rev_growth).toFixed(1)}% — tambahan ${fmtRp(delta)}`,
      desc:`${prev}: ${fmtRp(star.rev_m1)} → ${curr}: ${fmtRp(star.rev_curr)} · TRX: ${fmtN(star.trx_m1)} → ${fmtN(star.trx_curr)} (${star.pct_trx_growth!=null?fmtPct(star.pct_trx_growth):'-'})`,
      action:`Identifikasi faktor sukses ${star.produk} — seasonality, promo, atau improvement permanen? Jadikan template untuk produk lain`,
      impact:`+${fmtRp(delta)}`,
    });
  }

  // 3 — Critical 2-period decline
  const kritis = valid.filter(r=>Number(r.rev_curr)<Number(r.rev_m1) && Number(r.rev_m1)<Number(r.rev_m2))
    .sort((a,b)=>(Number(b.rev_m2)-Number(b.rev_curr))-(Number(a.rev_m2)-Number(a.rev_curr)));
  if (kritis.length>0) {
    const w = kritis[0];
    const drop = Number(w.rev_m2)-Number(w.rev_curr);
    const dropPct = Number(w.rev_m2)>0 ? ((drop/Number(w.rev_m2))*100).toFixed(1) : 0;
    const twoPrev = m2Label(bulan?.bulan_m2);
    list.push({
      type:'negative', icon:'🚨',
      title:`DARURAT: ${w.produk} turun 2 periode berturut-turut${kritis.length>1?` (+${kritis.length-1} produk lain)`:''}`,
      desc:`${w.produk}: ${twoPrev} ${fmtRp(w.rev_m2)} → ${prev} ${fmtRp(w.rev_m1)} → ${curr} ${fmtRp(w.rev_curr)} (−${dropPct}% total)`,
      action:`Investigasi hari ini: cek masalah sistem, perubahan fee/komisi, atau kompetitor baru. Hubungi sales manager segera`,
      impact:`−${fmtRp(drop)} sejak ${twoPrev}`,
    });
  }

  // 4 — Margin anomaly: TRX up, Rev down
  const anomaly = valid.filter(r=>(Number(r.pct_trx_growth)||0)>5 && (Number(r.pct_rev_growth)||0)<0)
    .sort((a,b)=>Math.abs(Number(b.pct_rev_growth)||0)-Math.abs(Number(a.pct_rev_growth)||0));
  if (anomaly.length>0) {
    const a = anomaly[0];
    list.push({
      type:'warning', icon:'⚡',
      title:`Anomali Margin: ${a.produk} — TRX ${fmtPct(a.pct_trx_growth)} tapi Revenue ${fmtPct(a.pct_rev_growth)}`,
      desc:`Volume naik tapi pendapatan turun — kemungkinan product mix bergeser ke transaksi nilai rendah atau ada diskon tidak terkontrol`,
      action:`Bandingkan ARPT ${prev} vs ${curr} pada ${a.produk}: breakdown komposisi transaksi. Cek apakah ada promo yang menekan margin`,
    });
  }

  // 5 — Revenue concentration risk
  if (valid.length>=4) {
    const totalRev = Number(total.rev_curr)||1;
    const top3 = [...valid].sort((a,b)=>Number(b.rev_curr)-Number(a.rev_curr)).slice(0,3);
    const top3Rev = top3.reduce((s,r)=>s+Number(r.rev_curr),0);
    const top3Pct = ((top3Rev/totalRev)*100).toFixed(0);
    list.push({
      type: Number(top3Pct)>75 ? 'warning' : 'info',
      icon: Number(top3Pct)>75 ? '📉' : '💼',
      title:`Konsentrasi: ${top3.map(r=>r.produk).join(', ')} = ${top3Pct}% dari total revenue`,
      desc:`3 produk teratas menyumbang ${top3Pct}% dari total revenue ${curr} ${fmtRp(totalRev)}`,
      action: Number(top3Pct)>75
        ? `Risiko konsentrasi tinggi — dorong pertumbuhan produk menengah agar portofolio lebih resilient`
        : `Distribusi revenue sehat — pertahankan keseimbangan portofolio`,
    });
  }

  // 6 — ARPT opportunity: above-avg MAT, below-avg ARPT
  const active = valid.filter(r=>Number(r.trx_curr)>0);
  if (active.length>=3) {
    const avgArpt = active.reduce((s,r)=>s+(Number(r.arpt_curr)||0),0)/active.length;
    const avgMat  = active.reduce((s,r)=>s+(Number(r.mat_curr)||0),0)/active.length;
    const opp = active.filter(r=>Number(r.mat_curr)>avgMat*0.8 && Number(r.arpt_curr)<avgArpt*0.65)
      .sort((a,b)=>Number(b.mat_curr)-Number(a.mat_curr));
    if (opp.length>0) {
      const o = opp[0];
      const potential = Math.round((avgArpt-Number(o.arpt_curr))*Number(o.trx_curr));
      list.push({
        type:'info', icon:'💡',
        title:`Peluang: ${o.produk} — MAT besar tapi ARPT ${fmtRp(o.arpt_curr)} (rata-rata portofolio ${fmtRp(avgArpt)})`,
        desc:`${fmtN(o.mat_curr)} merchant aktif namun nilai transaksi per-TRX jauh di bawah rata-rata`,
        action:`Optimalkan product mix ${o.produk}: dorong merchant ke nominal transaksi lebih besar. Estimasi potensi: ${fmtRp(potential)}/bulan`,
        impact:`Potensi +${fmtRp(potential)}`,
      });
    }
  }

  return list;
}

/* ─── Chart atoms ─── */
function HBarChart({ id, labels, values, color, formatFn }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type:'bar',
      data:{ labels, datasets:[{ data:values, backgroundColor:color||THEME, borderRadius:3 }] },
      options:{
        indexAxis:'y', responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label:ctx => formatFn?formatFn(ctx.parsed.x):fmtN(ctx.parsed.x) } } },
        scales:{ x:{ grid:{ color:'#f0f0f0' }, ticks:{ font:{ size:11 } } }, y:{ ticks:{ font:{ size:11 } } } },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function GroupedBar({ id, labels, datasets, yFmt }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels?.length) return;
    const chart = new Chart(ref.current, {
      type:'bar',
      data:{ labels, datasets },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{
          legend:{ position:'bottom', labels:{ font:{ size:11 }, padding:10 } },
          tooltip:{ callbacks:{ label: ctx => {
            const v = ctx.parsed.y;
            return ` ${ctx.dataset.label}: ${yFmt ? yFmt(v) : v.toLocaleString('id')}`;
          }}},
        },
        scales:{
          x:{ ticks:{ font:{ size:10 }, maxRotation:40 } },
          y:{ grid:{ color:'#f0f0f0' }, ticks:{ font:{ size:11 }, callback: v => yFmt ? yFmt(v) : v.toLocaleString('id') } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function ScatterPlot({ id, products }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !products?.length) return;
    const maxRev = Math.max(...products.map(p=>Number(p.rev_curr)||0),1);
    const chart = new Chart(ref.current, {
      type:'scatter',
      data:{
        datasets:[{
          data:products.map(p=>({ x:Number(p.pct_trx_growth)||0, y:Number(p.pct_rev_growth)||0 })),
          backgroundColor:products.map(p=>gcColor(p.pct_rev_growth)+'BB'),
          pointRadius:products.map(p=>Math.max(6,Math.min(20,((Number(p.rev_curr)||0)/maxRev)*20))),
          pointHoverRadius:12,
        }],
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{
          legend:{ display:false },
          tooltip:{ callbacks:{ label:ctx=>{ const p=products[ctx.dataIndex]; return `${p.produk}: TRX ${p.pct_trx_growth!=null?fmtPct(p.pct_trx_growth):'-'}, Rev ${p.pct_rev_growth!=null?fmtPct(p.pct_rev_growth):'-'}`; } } },
        },
        scales:{
          x:{ title:{ display:true, text:'% Growth TRX' }, grid:{ color:'#f0f0f0' }, ticks:{ callback:v=>v+'%' } },
          y:{ title:{ display:true, text:'% Growth Revenue' }, grid:{ color:'#f0f0f0' }, ticks:{ callback:v=>v+'%' } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function MiniBar({ id, labels, values, color }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = new Chart(ref.current, {
      type:'bar',
      data:{ labels, datasets:[{ data:values, backgroundColor:color||THEME, borderRadius:3 }] },
      options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } }, scales:{ x:{ ticks:{ font:{ size:10 } } }, y:{ grid:{ color:'#f0f0f0' }, ticks:{ font:{ size:10 } } } } },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

function MultiLineChart({ id, dates, byProduk, selectedProduks, metric }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !dates?.length || !selectedProduks?.length) return;
    const datasets = selectedProduks.map((produk, idx) => {
      const entries  = byProduk[produk] || [];
      const dataMap  = Object.fromEntries(entries.map(e=>[e.tanggal, e]));
      return {
        label: produk,
        data: dates.map(d => {
          const e = dataMap[d];
          if (!e) return null;
          return metric==='revenue' ? Number(e.rev_curr) : Number(e.trx_curr);
        }),
        borderColor: LINE_COLORS[idx % LINE_COLORS.length],
        backgroundColor: LINE_COLORS[idx % LINE_COLORS.length]+'22',
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 7,
        tension: 0.3,
        spanGaps: false,
      };
    });
    const chart = new Chart(ref.current, {
      type:'line',
      data:{ labels:dates.map(fmtDateShort), datasets },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{
          legend:{ position:'bottom', labels:{ font:{ size:11 }, padding:10, usePointStyle:true } },
          tooltip:{ callbacks:{ label:ctx=>{ const v=ctx.parsed.y; if(v==null) return null; return `${ctx.dataset.label}: ${metric==='revenue'?fmtRp(v):fmtN(v)}`; } } },
        },
        scales:{
          x:{ ticks:{ font:{ size:10 }, maxRotation:45 }, grid:{ color:'#f0f0f0' } },
          y:{ grid:{ color:'#f0f0f0' }, ticks:{ font:{ size:11 }, callback:v=>metric==='revenue'?fmtRp(v):fmtN(v) } },
        },
      },
    });
    return () => chart.destroy();
  }, [id]);
  return <canvas key={id} ref={ref} />;
}

/* ─── UI atoms ─── */
function KPICard({ label, value, sub, badge, badgeColor }) {
  return (
    <div className="wrpa-kpi-card">
      <div className="wrpa-kpi-label">{label}</div>
      <div className="wrpa-kpi-value">{value}{badge&&<span className="wrpa-kpi-badge" style={{background:badgeColor||THEME}}>{badge}</span>}</div>
      {sub&&<div className="wrpa-kpi-sub">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, children, height }) {
  return (
    <div className="wrpa-chart-card">
      {title&&<div className="wrpa-chart-title">{title}</div>}
      <div className="wrpa-chart-box" style={height?{height}:undefined}>{children}</div>
    </div>
  );
}

/* ─── InsightBox ─── */
function InsightBox({ data, total, stats, bulan }) {
  const insights = useMemo(() => computeInsights(data, total, stats, bulan), [data, total, stats, bulan]);
  if (!insights.length) return null;
  return (
    <div className="wrpa-insight-box">
      <div className="wrpa-insight-header">
        <i className="ti ti-brain" /> Rekomendasi &amp; Insight Strategis
        <span className="wrpa-insight-count">{insights.length} temuan</span>
      </div>
      {insights.map((ins, i) => (
        <div key={i} className={`wrpa-insight-item wrpa-insight--${ins.type}`}>
          <div className="wrpa-insight-icon">{ins.icon}</div>
          <div className="wrpa-insight-body">
            <div className="wrpa-insight-title">{ins.title}</div>
            <div className="wrpa-insight-desc">{ins.desc}</div>
            <div className="wrpa-insight-action"><i className="ti ti-arrow-right" style={{marginRight:4}} />{ins.action}</div>
          </div>
          {ins.impact&&(
            <div className={`wrpa-insight-impact wrpa-insight-impact--${ins.type==='positive'?'pos':'neg'}`}>{ins.impact}</div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─── Modal Detail Produk ─── */
function ProdukModal({ row, onClose, bulan }) {
  if (!row) return null;
  const badge   = produkBadge(row);
  const curr = currLabel(bulan?.bulan);
  const prev = m1Label(bulan?.bulan_m1);
  const twoPrev = m2Label(bulan?.bulan_m2);
  const months  = [twoPrev, prev, curr];
  const trxVals = [Number(row.trx_m2),Number(row.trx_m1),Number(row.trx_curr)];
  const revVals = [Number(row.rev_m2),Number(row.rev_m1),Number(row.rev_curr)];
  const arptCurr = calcArpt(row.rev_curr,row.trx_curr);
  const arptM1   = calcArpt(row.rev_m1,row.trx_m1);
  const arptDelta = arptCurr-arptM1;
  const pctTrx   = Number(row.pct_trx_growth)||0;
  const pctRev   = Number(row.pct_rev_growth)||0;
  let insight = `TRX ${pctTrx>=0?'naik':'turun'} ${Math.abs(pctTrx).toFixed(1)}% dari ${prev} ke ${curr}`;
  insight += pctRev>=0 ? `, revenue naik ${pctRev.toFixed(1)}%` : `, namun revenue turun ${Math.abs(pctRev).toFixed(1)}%`;
  if (arptDelta!==0) insight += `. ARPT ${arptDelta>0?'naik':'turun'} ${fmtRp(Math.abs(arptDelta))} (${arptDelta>0?'margin meningkat':'perlu review pricing'})`;
  insight += '.';
  const tblRows = [
    { bulan:twoPrev, mat:row.mat_m2, trx:row.trx_m2, rev:row.rev_m2, arpt:calcArpt(row.rev_m2,row.trx_m2), atpu:calcAtpu(row.trx_m2,row.mat_m2), arpu:calcArpu(row.rev_m2,row.mat_m2) },
    { bulan:prev,    mat:row.mat_m1, trx:row.trx_m1, rev:row.rev_m1, arpt:arptM1, atpu:calcAtpu(row.trx_m1,row.mat_m1), arpu:calcArpu(row.rev_m1,row.mat_m1) },
    { bulan:curr,    mat:row.mat_curr, trx:row.trx_curr, rev:row.rev_curr, arpt:arptCurr, atpu:calcAtpu(row.trx_curr,row.mat_curr), arpu:calcArpu(row.rev_curr,row.mat_curr) },
  ];
  return (
    <div className="wrpa-modal-overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="wrpa-modal">
        <div className="wrpa-modal-header">
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <div className="wrpa-modal-title">{row.produk}</div>
            <span className={`wrpa-badge ${badge.cls}`}>{badge.label}</span>
          </div>
          <button className="wrpa-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="wrpa-modal-body">
          <div className="wrpa-modal-insight"><i className="ti ti-sparkles" /> {insight}</div>
          <div className="wrpa-table-wrap" style={{marginBottom:16}}>
            <table className="wrpa-table">
              <thead><tr><th>Bulan</th><th>MAT</th><th>TRX</th><th>Revenue</th><th>ARPT</th><th>ATPU</th><th>ARPU</th></tr></thead>
              <tbody>{tblRows.map((r,i)=>(
                <tr key={i}>
                  <td style={{fontWeight:600,color:i===2?THEME:'inherit'}}>{r.bulan}</td>
                  <td>{fmtN(r.mat)}</td>
                  <td style={{fontWeight:i===2?600:400}}>{fmtN(r.trx)}</td>
                  <td style={{fontWeight:i===2?600:400}}>{fmtRp(r.rev)}</td>
                  <td>{fmtRp(r.arpt)}</td>
                  <td>{r.atpu}x</td>
                  <td>{fmtRp(r.arpu)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>
            <ChartCard title="Tren TRX" height="130px"><MiniBar id={`modal-trx-${row.produk}`} labels={months} values={trxVals} color="#94A3B8" /></ChartCard>
            <ChartCard title="Tren Revenue" height="130px"><MiniBar id={`modal-rev-${row.produk}`} labels={months} values={revVals} color={THEME} /></ChartCard>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── ARPU Layer Table ─── */
const LAYER_COLOR = {
  'Low ARPU':  '#9CA3AF',
  'Mid ARPU':  '#60A5FA',
  'High ARPU': '#34D399',
  'Top ARPU':  THEME,
};

function ArpuLayerTable() {
  const [state, setState] = useState({ loading: true, layers: [], error: null });

  useEffect(() => {
    getPAArpuAnalytics()
      .then(d => setState({ loading: false, layers: d.layers || [], error: null }))
      .catch(e => setState({ loading: false, layers: [], error: e.message }));
  }, []);

  if (state.loading) return <div className="wrpa-empty">Memuat...</div>;
  if (state.error)   return <div className="wrpa-empty" style={{color:'#E24B4A'}}>Gagal memuat data ARPU</div>;
  if (!state.layers.length) return <div className="wrpa-empty">Belum ada data ARPU — jalankan sync dari Apps Script</div>;

  return (
    <table className="wrpa-arpu-table">
      <thead>
        <tr>
          <th>Layer</th>
          <th style={{textAlign:'right'}}>Jumlah Agen</th>
          <th style={{textAlign:'right'}}>% Distribusi</th>
          <th>% Kontribusi Rev</th>
        </tr>
      </thead>
      <tbody>
        {state.layers.map(layer => {
          const color = LAYER_COLOR[layer.layer] || '#9CA3AF';
          return (
            <tr key={layer.layer}>
              <td>
                <span className="wrpa-arpu-dot" style={{background:color}} />
                {layer.layer}
              </td>
              <td style={{textAlign:'right', fontVariantNumeric:'tabular-nums'}}>{fmtN(layer.jumlah_agen)}</td>
              <td style={{textAlign:'right', fontVariantNumeric:'tabular-nums'}}>{layer.pct_distribusi}%</td>
              <td>
                <div className="wrpa-arpu-bar-row">
                  <div className="wrpa-arpu-bar-bg">
                    <div className="wrpa-arpu-bar-fill" style={{width:`${layer.pct_kontribusi_rev}%`, background:color}} />
                  </div>
                  <span className="wrpa-arpu-bar-pct">{layer.pct_kontribusi_rev}%</span>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ─── Sortable + filterable product table ─── */
function ProductTable({ data, onProdukClick, curr }) {
  const [sortCol, setSortCol] = useState('rev_curr');
  const [sortDir, setSortDir] = useState('desc');
  const [filterStatus, setFilterStatus] = useState('all');
  const [search, setSearch] = useState('');

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  const counts = useMemo(() => {
    const c = { Bintang: 0, Stabil: 0, Kritis: 0 };
    data.forEach(r => { const b = produkBadge(r); c[b.label] = (c[b.label] || 0) + 1; });
    return c;
  }, [data]);

  const processed = useMemo(() => {
    let rows = data.map(r => ({ ...r, _badge: produkBadge(r) }));
    if (filterStatus !== 'all') rows = rows.filter(r => r._badge.label === filterStatus);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(r => r.produk.toLowerCase().includes(q));
    }
    rows.sort((a, b) => {
      if (sortCol === 'produk') {
        return sortDir === 'asc' ? a.produk.localeCompare(b.produk) : b.produk.localeCompare(a.produk);
      }
      const av = Number(a[sortCol]) || 0;
      const bv = Number(b[sortCol]) || 0;
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return rows;
  }, [data, sortCol, sortDir, filterStatus, search]);

  const Th = ({ col, children }) => {
    const active = sortCol === col;
    return (
      <th onClick={() => handleSort(col)}
        style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
        {children}
        <span style={{ marginLeft: 3, fontSize: 9, opacity: active ? 1 : 0.25 }}>
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </th>
    );
  };

  return (
    <ChartCard title="Ringkasan Semua Produk — klik baris untuk detail">
      <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap', alignItems:'center' }}>
        <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
          {[
            ['all',    `Semua (${data.length})`],
            ['Bintang',`Bintang (${counts.Bintang})`],
            ['Stabil', `Stabil (${counts.Stabil})`],
            ['Kritis', `Kritis (${counts.Kritis})`],
          ].map(([val, label]) => (
            <button key={val} onClick={() => setFilterStatus(val)}
              className={`wrpa-filter-btn${filterStatus===val?' wrpa-filter-btn--active':''}`}
              style={{ fontSize:11 }}>
              {label}
            </button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Cari produk…"
          style={{
            padding:'4px 10px', border:'1px solid var(--border)', borderRadius:6,
            fontSize:12, background:'var(--bg-card)', color:'var(--text-1)',
            outline:'none', minWidth:140,
          }} />
        <span style={{ fontSize:11, color:'#9CA3AF', marginLeft:'auto' }}>
          {processed.length} produk
          {(filterStatus !== 'all' || search) && (
            <button onClick={() => { setFilterStatus('all'); setSearch(''); }}
              style={{ marginLeft:6, fontSize:10, color:'#6B7280', background:'none',
                border:'1px solid var(--border)', borderRadius:4, padding:'1px 6px', cursor:'pointer' }}>
              Reset
            </button>
          )}
        </span>
      </div>
      <div className="wrpa-table-wrap">
        <table className="wrpa-table">
          <thead><tr>
            <Th col="produk">Produk</Th>
            <Th col="mat_curr">MAT {curr}</Th>
            <Th col="trx_curr">TRX {curr}</Th>
            <Th col="rev_curr">Revenue {curr}</Th>
            <Th col="arpt_curr">ARPT {curr}</Th>
            <Th col="pct_trx_growth">Growth TRX</Th>
            <Th col="pct_rev_growth">Growth Rev</Th>
            <th>Status</th>
          </tr></thead>
          <tbody>
            {processed.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign:'center', color:'#9CA3AF', padding:20 }}>
                Tidak ada produk yang cocok
              </td></tr>
            ) : processed.map((row, i) => (
              <tr key={i} className={rowCls(row.pct_rev_growth)}
                style={{ cursor:'pointer' }} onClick={() => onProdukClick(row)}>
                <td style={{ fontWeight:600 }}>{row.produk}</td>
                <td>{fmtN(row.mat_curr)}</td>
                <td>{fmtN(row.trx_curr)}</td>
                <td>{fmtRp(row.rev_curr)}</td>
                <td>{fmtRp(row.arpt_curr)}</td>
                <td style={{ color:gcColor(row.pct_trx_growth), fontWeight:600 }}>
                  {row.pct_trx_growth != null ? fmtPct(row.pct_trx_growth) : '-'}
                </td>
                <td style={{ color:gcColor(row.pct_rev_growth), fontWeight:600 }}>
                  {row.pct_rev_growth != null ? fmtPct(row.pct_rev_growth) : '-'}
                </td>
                <td><span className={`wrpa-badge ${row._badge.cls}`}>{row._badge.label}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

/* ─── Tab 0: Executive Summary ─── */
function ExecutiveSummaryTab({ data, total, meta, stats, onProdukClick, bulan }) {
  const tid    = bulan?.bulan;
  const curr   = currLabel(bulan?.bulan);
  const prev   = m1Label(bulan?.bulan_m1);
  const top10  = data.slice(0,10);
  const devTrx = (total.trx_curr||0)-(total.trx_m1||0);
  const devRev = (total.rev_curr||0)-(total.rev_m1||0);
  const pctTrx = total.trx_m1>0 ? ((devTrx/total.trx_m1)*100).toFixed(1) : 0;
  const pctRev = total.rev_m1>0 ? ((devRev/total.rev_m1)*100).toFixed(1) : 0;
  const arptT  = calcArpt(total.rev_curr,total.trx_curr);
  const arptM  = calcArpt(total.rev_m1,total.trx_m1);
  const kpis = [
    { label:`Total MAT (${curr})`,      value:fmtN(total.mat_curr), sub:`${total.mat_curr-total.mat_m1>=0?'+':''}${fmtN(total.mat_curr-total.mat_m1)} vs ${prev}`, badge:total.mat_curr>=total.mat_m1?'▲':'▼', badgeColor:total.mat_curr>=total.mat_m1?THEME:RED },
    { label:`Total TRX (${curr})`,      value:fmtN(total.trx_curr), sub:`${fmtPct(pctTrx)} vs ${prev}`, badge:Number(pctTrx)>=0?'▲':'▼', badgeColor:Number(pctTrx)>=0?THEME:RED },
    { label:`Total Revenue (${curr})`,  value:fmtRp(total.rev_curr), sub:`${fmtPct(pctRev)} vs ${prev}`, badge:Number(pctRev)>=0?'▲':'▼', badgeColor:Number(pctRev)>=0?THEME:RED },
    { label:'Rata-rata ARPT',       value:fmtRp(arptT), sub:`${arptT-arptM>=0?'+':''}${fmtRp(arptT-arptM)} vs ${prev}` },
  ];
  return (
    <div>
      <div className="wrpa-kpi-grid">{kpis.map((k,i)=><KPICard key={i} {...k} />)}</div>
      <div className="wrpa-charts-2col">
        <ChartCard title={`Top 10 Produk — Revenue ${curr}`} height="260px">
          <HBarChart id={`pa-rev-${tid}`} labels={top10.map(r=>r.produk)} values={top10.map(r=>Number(r.rev_curr))} formatFn={fmtRp} />
        </ChartCard>
        <ChartCard title={`Distribusi ARPU per Layer — ${curr}`} height="260px">
          <ArpuLayerTable />
        </ChartCard>
      </div>
      <ProductTable data={data} onProdukClick={onProdukClick} curr={curr} />
      <InsightBox data={data} total={total} stats={stats} bulan={bulan} />
    </div>
  );
}

/* ─── Tab 1: Trendline Harian ─── */
function TrendlineTab({ analytics, bulan }) {
  const [trendData, setTrendData] = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [metric,    setMetric]    = useState('revenue');
  const [selected,  setSelected]  = useState(null);
  const [days,      setDays]      = useState(30);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getPAProdukTrendline(days, bulan?.bulan)
      .then(d => {
        setTrendData(d);
        if (!selected) {
          const top5 = (analytics?.data||[])
            .sort((a,b)=>Number(b.rev_curr)-Number(a.rev_curr))
            .slice(0,5).map(r=>r.produk).filter(p=>d.byProduk[p]);
          setSelected(top5);
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [days, bulan?.bulan]);

  if (loading) return <div className="wrpa-loading"><i className="ti ti-loader-2 wrpa-spin" /><span>Memuat trendline…</span></div>;
  if (error)   return <div className="wrpa-error"><i className="ti ti-alert-circle" /><span>Error: {error}</span></div>;
  if (!trendData || trendData.dates.length < 2) return (
    <div className="wrpa-empty">
      <i className="ti ti-chart-line" style={{fontSize:36,color:'#9CA3AF'}} />
      <p style={{fontWeight:600}}>Data trendline belum tersedia</p>
      <span style={{fontSize:13,color:'#9CA3AF'}}>Dibutuhkan minimal 2 hari sync di bulan ini untuk menampilkan grafik tren harian.</span>
    </div>
  );

  const { dates, byProduk, products } = trendData;
  const selProduks = selected || [];
  const chartId = `tl-${metric}-${days}-${selProduks.slice(0,5).join(',')}`;

  const toggle = p => setSelected(prev => prev?.includes(p) ? prev.filter(x=>x!==p) : [...(prev||[]),p]);

  // Summary table: first vs last date per product
  const summaryRows = products.map(p => {
    const entries = (byProduk[p]||[]).sort((a,b)=>String(a.tanggal).localeCompare(String(b.tanggal)));
    if (entries.length < 2) return null;
    const first = entries[0], last = entries[entries.length-1];
    const devRev = Number(last.rev_curr)-Number(first.rev_curr);
    const pctRev = Number(first.rev_curr)>0 ? ((devRev/Number(first.rev_curr))*100).toFixed(1) : null;
    const devTrx = Number(last.trx_curr)-Number(first.trx_curr);
    return { produk:p, first, last, devRev, pctRev, devTrx, n:entries.length };
  }).filter(Boolean).sort((a,b)=>(Number(b.pctRev)||0)-(Number(a.pctRev)||0));

  return (
    <div>
      {/* Controls */}
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14,flexWrap:'wrap'}}>
        <div style={{display:'flex',gap:6,alignItems:'center'}}>
          <span style={{fontSize:12,color:'#6B7280',fontWeight:500}}>Periode:</span>
          {[7,14,30,60].map(d=>(
            <button key={d} className={`wrpa-filter-btn${days===d?' wrpa-filter-btn--active':''}`} onClick={()=>setDays(d)}>{d} hari</button>
          ))}
        </div>
        <div style={{display:'flex',gap:6,alignItems:'center'}}>
          <span style={{fontSize:12,color:'#6B7280',fontWeight:500}}>Metrik:</span>
          <button className={`wrpa-filter-btn${metric==='revenue'?' wrpa-filter-btn--active':''}`} onClick={()=>setMetric('revenue')}>Revenue</button>
          <button className={`wrpa-filter-btn${metric==='trx'?' wrpa-filter-btn--active':''}`} onClick={()=>setMetric('trx')}>TRX</button>
        </div>
        <div style={{marginLeft:'auto',display:'flex',gap:6,alignItems:'center'}}>
          <span style={{fontSize:11,color:'#9CA3AF'}}>{selProduks.length}/{products.length} dipilih</span>
          <button className="wrpa-filter-btn" onClick={()=>setSelected((analytics?.data||[]).sort((a,b)=>Number(b.rev_curr)-Number(a.rev_curr)).slice(0,5).map(r=>r.produk).filter(p=>byProduk[p]))}>Top 5</button>
          <button className="wrpa-filter-btn" onClick={()=>setSelected([])}>Kosongkan</button>
          <button className="wrpa-filter-btn" onClick={()=>setSelected([...products])}>Semua</button>
        </div>
      </div>

      {/* Product chips */}
      <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:16}}>
        {products.map((p,i)=>(
          <button key={p} onClick={()=>toggle(p)} style={{
            padding:'4px 10px',borderRadius:20,border:'2px solid',fontSize:11,cursor:'pointer',fontFamily:'inherit',
            borderColor:selProduks.includes(p)?LINE_COLORS[i%LINE_COLORS.length]:'#E5E7EB',
            background:selProduks.includes(p)?LINE_COLORS[i%LINE_COLORS.length]+'22':'var(--bg-card)',
            color:selProduks.includes(p)?LINE_COLORS[i%LINE_COLORS.length]:'#6B7280',
            fontWeight:selProduks.includes(p)?600:400,
          }}>{p}</button>
        ))}
      </div>

      {/* Line chart */}
      <ChartCard title={`Trendline ${metric==='revenue'?'Revenue':'TRX'} Harian — ${dates.length} snapshot`} height="340px">
        {selProduks.length===0
          ? <div className="wrpa-empty" style={{minHeight:200}}><span>Pilih produk di atas untuk menampilkan trendline</span></div>
          : <MultiLineChart id={chartId} dates={dates} byProduk={byProduk} selectedProduks={selProduks} metric={metric} />
        }
      </ChartCard>

      {/* Per-product summary */}
      {summaryRows.length>0 && (
        <div className="wrpa-chart-card">
          <div className="wrpa-chart-title">
            <i className="ti ti-arrows-diff" /> Perubahan: {fmtDateShort(dates[0])} → {fmtDateShort(dates[dates.length-1])}
          </div>
          <div className="wrpa-table-wrap">
            <table className="wrpa-table">
              <thead><tr>
                <th>Produk</th><th>Rev Awal</th><th>Rev Terkini</th>
                <th>Δ Revenue</th><th>Δ TRX</th><th>Hari</th>
              </tr></thead>
              <tbody>{summaryRows.map((r,i)=>(
                <tr key={i}>
                  <td style={{fontWeight:600}}>{r.produk}</td>
                  <td>{fmtRp(r.first.rev_curr)}</td>
                  <td style={{fontWeight:600}}>{fmtRp(r.last.rev_curr)}</td>
                  <td style={{color:gcColor(r.pctRev),fontWeight:600}}>
                    {r.pctRev!=null?fmtPct(r.pctRev):'-'} ({r.devRev>=0?'+':''}{fmtRp(r.devRev)})
                  </td>
                  <td style={{color:gcColor(r.devTrx),fontWeight:600}}>
                    {r.devTrx>=0?'+':''}{fmtN(r.devTrx)}
                  </td>
                  <td style={{color:'#9CA3AF'}}>{r.n}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Tab 2: Trend & Growth ─── */
function TrendGrowthTab({ data, top15_growth_trx, bot15_decline_trx, bulan }) {
  const tid  = bulan?.bulan;
  const curr = currLabel(bulan?.bulan);
  const prev = m1Label(bulan?.bulan_m1);
  const twoPrev = m2Label(bulan?.bulan_m2);
  // Use server-precomputed lists (all outlets, not just top-100 sample)
  const top5 = (top15_growth_trx || []).slice(0, 5);
  const bot5 = (bot15_decline_trx || []).slice(0, 5);
  return (
    <div>
      {/* Top 5 / Bottom 5 FIRST */}
      <div className="wrpa-charts-2col">
        <div className="wrpa-chart-card">
          <div className="wrpa-chart-title" style={{color:THEME}}><i className="ti ti-trending-up" /> Top 5 Growth TRX ({prev}→{curr})</div>
          <div className="wrpa-table-wrap">
            <table className="wrpa-table">
              <thead><tr><th>Produk</th><th>TRX {prev}</th><th>TRX {curr}</th><th>Growth</th></tr></thead>
              <tbody>{top5.map((r,i)=>(
                <tr key={i}>
                  <td style={{fontWeight:600}}>{r.produk}</td>
                  <td>{fmtN(r.trx_m1)}</td>
                  <td style={{color:THEME,fontWeight:600}}>{fmtN(r.trx_curr)}</td>
                  <td style={{color:gcColor(r.pct_trx_growth),fontWeight:600}}>{r.pct_trx_growth!=null?fmtPct(r.pct_trx_growth):'-'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
        <div className="wrpa-chart-card">
          <div className="wrpa-chart-title" style={{color:RED}}><i className="ti ti-trending-down" /> Bottom 5 Decline TRX ({prev}→{curr})</div>
          <div className="wrpa-table-wrap">
            <table className="wrpa-table">
              <thead><tr><th>Produk</th><th>TRX {prev}</th><th>TRX {curr}</th><th>Growth</th></tr></thead>
              <tbody>{bot5.map((r,i)=>(
                <tr key={i}>
                  <td style={{fontWeight:600}}>{r.produk}</td>
                  <td>{fmtN(r.trx_m1)}</td>
                  <td style={{color:RED,fontWeight:600}}>{fmtN(r.trx_curr)}</td>
                  <td style={{color:gcColor(r.pct_trx_growth),fontWeight:600}}>{r.pct_trx_growth!=null?fmtPct(r.pct_trx_growth):'-'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Revenue bar AFTER */}
      <ChartCard title={`Semua Produk — Revenue ${twoPrev} / ${prev} / ${curr}`} height="280px">
        <GroupedBar id={`pa-revall-${tid}`} labels={data.map(r=>r.produk)} datasets={[
          { label:twoPrev, data:data.map(r=>Number(r.rev_m2)), backgroundColor:'#94A3B8', borderRadius:2 },
          { label:prev,    data:data.map(r=>Number(r.rev_m1)), backgroundColor:'#CBD5E1', borderRadius:2 },
          { label:curr,    data:data.map(r=>Number(r.rev_curr)), backgroundColor:THEME,     borderRadius:2 },
        ]} />
      </ChartCard>

      <div className="wrpa-chart-card">
        <div className="wrpa-chart-title">Scatter Growth: % TRX vs % Revenue ({prev}→{curr})</div>
        <div style={{fontSize:11,color:'#9CA3AF',marginBottom:6}}>
          Ukuran titik = besaran Revenue {curr}. Hover untuk detail.
          &nbsp;Kanan-atas = Bintang &nbsp;|&nbsp; Kiri-atas = Anomali Margin &nbsp;|&nbsp; Kiri-bawah = Perhatian
        </div>
        <div className="wrpa-chart-box" style={{height:260}}>
          <ScatterPlot id={`pa-scatter-${tid}`} products={data} />
        </div>
      </div>
    </div>
  );
}

/* ─── Tab 3: Unit Ekonomi ─── */
function UnitEkonomiTab({ data, bulan }) {
  const tid    = bulan?.bulan;
  const curr = currLabel(bulan?.bulan);
  const prev = m1Label(bulan?.bulan_m1);
  const twoPrev = m2Label(bulan?.bulan_m2);
  const sorted = [...data].sort((a,b)=>calcArpu(b.rev_curr,b.mat_curr)-calcArpu(a.rev_curr,a.mat_curr));
  return (
    <div>
      <div className="wrpa-chart-card">
        <div className="wrpa-chart-title">ARPT / ATPU / ARPU per Produk — 3 Bulan</div>
        <div className="wrpa-table-wrap">
          <table className="wrpa-table">
            <thead><tr>
              <th>Produk</th>
              <th>ARPT {twoPrev}</th><th>ARPT {prev}</th><th>ARPT {curr}</th>
              <th>ATPU {prev}</th><th>ATPU {curr}</th>
              <th>ARPU {prev}</th><th>ARPU {curr}</th>
              <th>Signal</th>
            </tr></thead>
            <tbody>{data.map((r,i)=>{
              const arptCurr = calcArpt(r.rev_curr,r.trx_curr);
              const arptM1 = calcArpt(r.rev_m1,r.trx_m1);
              const arptDown = arptCurr<arptM1 && Number(r.trx_curr)>0;
              const anomali  = arptDown && (Number(r.dev_trx_m1_curr)||0)<0;
              return (
                <tr key={i} className={anomali ? 'wrpa-trend-anomali' : undefined} style={{background:anomali?'#FFF1F0':undefined}}>
                  <td style={{fontWeight:600}}>{r.produk}</td>
                  <td>{fmtRp(calcArpt(r.rev_m2,r.trx_m2))}</td>
                  <td>{fmtRp(arptM1)}</td>
                  <td style={{color:arptDown?RED:THEME,fontWeight:600}}>{fmtRp(arptCurr)}</td>
                  <td>{calcAtpu(r.trx_m1,r.mat_m1)}x</td>
                  <td style={{fontWeight:600}}>{calcAtpu(r.trx_curr,r.mat_curr)}x</td>
                  <td>{fmtRp(calcArpu(r.rev_m1,r.mat_m1))}</td>
                  <td style={{fontWeight:600}}>{fmtRp(calcArpu(r.rev_curr,r.mat_curr))}</td>
                  <td>{anomali?<span className="wrpa-badge wrpa-badge--kritis" title="ARPT & TRX turun">⚠ Anomali</span>:null}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </div>
      <div className="wrpa-charts-2col">
        <ChartCard title={`ARPU per Produk (${curr})`} height="260px">
          <HBarChart id={`pa-arpu-${tid}`} labels={sorted.map(r=>r.produk)} values={sorted.map(r=>calcArpu(r.rev_curr,r.mat_curr))} color="#7C3AED" formatFn={fmtRp} />
        </ChartCard>
        <ChartCard title={`ATPU per Produk (${curr}) — Frekuensi TRX per MAT`} height="260px">
          <HBarChart id={`pa-atpu-${tid}`} labels={data.map(r=>r.produk)} values={data.map(r=>parseFloat(calcAtpu(r.trx_curr,r.mat_curr))||0)} color="#0EA5E9" />
        </ChartCard>
      </div>
    </div>
  );
}

/* ─── Tab 4: Action Center (strategic) ─── */
function ActionCenterTab({ data, bulan }) {
  const curr = currLabel(bulan?.bulan);
  const prev = m1Label(bulan?.bulan_m1);
  const twoPrev = m2Label(bulan?.bulan_m2);

  const kritis = data
    .filter(r=>Number(r.rev_curr)<Number(r.rev_m1) && Number(r.rev_m1)<Number(r.rev_m2))
    .map(r=>({
      ...r,
      totalDrop: Number(r.rev_m2)-Number(r.rev_curr),
      dropPct: Number(r.rev_m2)>0 ? ((Number(r.rev_m2)-Number(r.rev_curr))/Number(r.rev_m2)*100).toFixed(1) : 0,
      recovery: Number(r.rev_m1)-Number(r.rev_curr),
      arptCurr: calcArpt(r.rev_curr,r.trx_curr),
      arptM1: calcArpt(r.rev_m1,r.trx_m1),
    }))
    .sort((a,b)=>b.totalDrop-a.totalDrop);

  const optimasi = data
    .filter(r=>{ const ac=calcArpt(r.rev_curr,r.trx_curr),am=calcArpt(r.rev_m1,r.trx_m1); return am>0&&ac<am&&Number(r.trx_curr)>0; })
    .map(r=>({
      ...r,
      arptCurr: calcArpt(r.rev_curr,r.trx_curr),
      arptM1: calcArpt(r.rev_m1,r.trx_m1),
      arptDelta: calcArpt(r.rev_m1,r.trx_m1)-calcArpt(r.rev_curr,r.trx_curr),
      potential: (calcArpt(r.rev_m1,r.trx_m1)-calcArpt(r.rev_curr,r.trx_curr))*Number(r.trx_curr),
    }))
    .sort((a,b)=>b.potential-a.potential);

  const bintang = data.filter(r=>(Number(r.pct_rev_growth)||0)>10)
    .sort((a,b)=>(Number(b.pct_rev_growth)||0)-(Number(a.pct_rev_growth)||0));

  const rising = data
    .filter(r=>(Number(r.trx_m1)===0&&Number(r.trx_curr)>0)||(Number(r.pct_trx_growth)||0)>50)
    .sort((a,b)=>(Number(b.pct_trx_growth)||999)-(Number(a.pct_trx_growth)||999));

  const totalRecovery = kritis.reduce((s,r)=>s+r.recovery,0);
  const totalOptimasi = optimasi.reduce((s,r)=>s+r.potential,0);

  return (
    <div>
      {/* Risk dashboard */}
      <div className="wrpa-action-risk-bar">
        <div className="wrpa-action-risk-item wrpa-action-risk--red">
          <div className="wrpa-action-risk-val">{kritis.length}</div>
          <div className="wrpa-action-risk-lbl">Kritis</div>
        </div>
        <div className="wrpa-action-risk-item wrpa-action-risk--amber">
          <div className="wrpa-action-risk-val">{optimasi.length}</div>
          <div className="wrpa-action-risk-lbl">Optimasi</div>
        </div>
        <div className="wrpa-action-risk-item wrpa-action-risk--green">
          <div className="wrpa-action-risk-val">{bintang.length}</div>
          <div className="wrpa-action-risk-lbl">Bintang</div>
        </div>
        <div className="wrpa-action-risk-item wrpa-action-risk--blue">
          <div className="wrpa-action-risk-val">{rising.length}</div>
          <div className="wrpa-action-risk-lbl">Rising</div>
        </div>
        <div className="wrpa-action-risk-summary">
          {totalRecovery>0 && <div>Potensi recovery dari {kritis.length} produk kritis: <strong style={{color:RED}}>{fmtRp(totalRecovery)}</strong></div>}
          {totalOptimasi>0 && <div>Potensi tambahan dari optimasi margin: <strong style={{color:'#F59E0B'}}>{fmtRp(totalOptimasi)}</strong></div>}
          {totalRecovery===0 && totalOptimasi===0 && <div style={{color:THEME}}>✓ Tidak ada risiko aktif saat ini — portofolio dalam kondisi baik</div>}
        </div>
      </div>

      {/* === KRITIS === */}
      {kritis.length>0&&(
        <div className="wrpa-action-card" style={{borderTop:'3px solid #E24B4A',marginBottom:16}}>
          <div className="wrpa-action-card-header" style={{color:'#E24B4A'}}>
            🚨 <span>DARURAT — Tren Turun 2 Periode Berturut</span>
            <span className="wrpa-urgency-badge wrpa-urgency--red">SEGERA</span>
            <span style={{marginLeft:'auto',fontSize:11,fontWeight:400,color:'#9CA3AF'}}>{kritis.length} produk · recovery potensial {fmtRp(totalRecovery)}</span>
          </div>
          {kritis.map((r,i)=>(
            <div key={i} className="wrpa-action-block wrpa-action-block--red">
              <div className="wrpa-action-block-header">
                <span style={{fontWeight:700,fontSize:13}}>{r.produk}</span>
                <span style={{color:'#E24B4A',fontWeight:600,fontSize:12}}>−{r.dropPct}% (−{fmtRp(r.totalDrop)} sejak {twoPrev})</span>
              </div>
              <div style={{fontSize:11,color:'#6B7280',marginBottom:6}}>
                {twoPrev} {fmtRp(r.rev_m2)} → {prev} {fmtRp(r.rev_m1)} → {curr} {fmtRp(r.rev_curr)}
                &nbsp;·&nbsp;TRX: {fmtN(r.trx_m2)} → {fmtN(r.trx_m1)} → {fmtN(r.trx_curr)}
                {r.arptCurr!==r.arptM1&&<span>&nbsp;·&nbsp;ARPT: {fmtRp(r.arptM1)} → {fmtRp(r.arptCurr)} {r.arptCurr<r.arptM1?'(margin turun)':'(margin naik)'}</span>}
              </div>
              <div className="wrpa-action-steps">
                <div className="wrpa-action-step"><span>1</span>Cek apakah ada error sistem atau gagal transaksi massal di log — periksa hari ini</div>
                <div className="wrpa-action-step"><span>2</span>Review struktur fee/komisi {r.produk}: apakah ada perubahan yang mendorong agen beralih produk?</div>
                <div className="wrpa-action-step"><span>3</span>Identifikasi 10 agen top produk ini — hubungi langsung untuk memahami situasi di lapangan</div>
                <div className="wrpa-action-step"><span>4</span>Rancang flash promo atau insentif khusus minggu ini dengan target recovery minimal {fmtRp(r.recovery)}</div>
              </div>
              <div className="wrpa-action-outcome">
                ✓ Target: kembali ke level {prev} → estimasi recovery <strong>{fmtRp(r.recovery)}</strong>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* === OPTIMASI MARGIN === */}
      {optimasi.length>0&&(
        <div className="wrpa-action-card" style={{borderTop:'3px solid #F59E0B',marginBottom:16}}>
          <div className="wrpa-action-card-header" style={{color:'#F59E0B'}}>
            ⚡ <span>OPTIMASI MARGIN — ARPT {curr} &lt; {prev}</span>
            <span className="wrpa-urgency-badge wrpa-urgency--amber">PRIORITAS TINGGI</span>
            <span style={{marginLeft:'auto',fontSize:11,fontWeight:400,color:'#9CA3AF'}}>{optimasi.length} produk · potensi {fmtRp(totalOptimasi)}</span>
          </div>
          {optimasi.map((r,i)=>(
            <div key={i} className="wrpa-action-block wrpa-action-block--amber">
              <div className="wrpa-action-block-header">
                <span style={{fontWeight:700,fontSize:13}}>{r.produk}</span>
                <span style={{color:'#F59E0B',fontWeight:600,fontSize:12}}>
                  ARPT: {fmtRp(r.arptM1)} → {fmtRp(r.arptCurr)} (−{fmtRp(r.arptDelta)}/trx)
                </span>
              </div>
              <div style={{fontSize:11,color:'#6B7280',marginBottom:6}}>
                TRX {curr}: {fmtN(r.trx_curr)} · Rev {curr}: {fmtRp(r.rev_curr)} · Potensi jika ARPT kembali: <strong style={{color:'#F59E0B'}}>{fmtRp(r.potential)}</strong>
              </div>
              <div className="wrpa-action-steps">
                <div className="wrpa-action-step"><span>1</span>Analisis komposisi transaksi: hitung breakdown berdasarkan nominal — apakah ada pergeseran ke transaksi kecil?</div>
                <div className="wrpa-action-step"><span>2</span>Cek apakah ada promo aktif yang secara tidak sengaja mendorong transaksi nominal rendah lebih banyak</div>
                <div className="wrpa-action-step"><span>3</span>Dorong agen melakukan upsell: rancang program loyalty untuk transaksi di atas threshold tertentu</div>
              </div>
              <div className="wrpa-action-outcome">
                ✓ Jika ARPT kembali ke level {prev} → potensi tambahan <strong>{fmtRp(r.potential)}</strong>/bulan
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="wrpa-action-grid">
        {/* === BINTANG === */}
        {bintang.length>0&&(
          <div className="wrpa-action-card" style={{borderTop:`3px solid ${THEME}`}}>
            <div className="wrpa-action-card-header" style={{color:THEME}}>
              📈 <span>PERTAHANKAN — Revenue Growth &gt; 10%</span>
              <span style={{marginLeft:'auto',fontSize:11,fontWeight:400,color:'#9CA3AF'}}>{bintang.length} produk</span>
            </div>
            {bintang.map((r,i)=>(
              <div key={i} className="wrpa-action-block wrpa-action-block--green">
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                  <span style={{fontWeight:600,fontSize:12}}>{r.produk}</span>
                  <span style={{color:THEME,fontWeight:700,fontSize:12}}>{r.pct_rev_growth!=null?fmtPct(r.pct_rev_growth):'-'} rev</span>
                </div>
                <div style={{fontSize:11,color:'#6B7280',marginBottom:4}}>
                  Rev: {prev} {fmtRp(r.rev_m1)} → {curr} {fmtRp(r.rev_curr)} · TRX: {fmtN(r.trx_m1)} → {fmtN(r.trx_curr)}
                </div>
                <div style={{fontSize:11,color:THEME}}>✓ Dokumentasi faktor sukses. Naikkan target jika growth ini permanen, bukan seasonal.</div>
              </div>
            ))}
            <div style={{marginTop:10,padding:'8px 10px',background:'#F0FDF4',borderRadius:6,fontSize:11,color:'#166534'}}>
              💡 <strong>Strategi:</strong> Analisis apakah growth karena promo (akan berhenti) atau perilaku baru agen (permanen). Jika permanen → revisi target bulanan ke atas.
            </div>
          </div>
        )}

        {/* === RISING STARS === */}
        {rising.length>0&&(
          <div className="wrpa-action-card" style={{borderTop:'3px solid #2563EB'}}>
            <div className="wrpa-action-card-header" style={{color:'#2563EB'}}>
              ⭐ <span>AKSELERASI — Produk Baru / Lonjakan &gt; 50%</span>
              <span style={{marginLeft:'auto',fontSize:11,fontWeight:400,color:'#9CA3AF'}}>{rising.length} produk</span>
            </div>
            {rising.map((r,i)=>(
              <div key={i} className="wrpa-action-block wrpa-action-block--blue">
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                  <span style={{fontWeight:600,fontSize:12}}>{r.produk}</span>
                  <span style={{color:'#2563EB',fontWeight:700,fontSize:12}}>
                    {Number(r.trx_m1)===0?'🆕 Baru':`+${Number(r.pct_trx_growth||0).toFixed(0)}% TRX`}
                  </span>
                </div>
                <div style={{fontSize:11,color:'#6B7280',marginBottom:4}}>
                  TRX: {prev} {fmtN(r.trx_m1)} → {curr} {fmtN(r.trx_curr)} · Rev {curr}: {fmtRp(r.rev_curr)}
                </div>
                <div style={{fontSize:11,color:'#2563EB'}}>⭐ Investasi support penuh — pastikan infrastruktur tidak jadi bottleneck saat scaling</div>
              </div>
            ))}
            <div style={{marginTop:10,padding:'8px 10px',background:'#EFF6FF',borderRadius:6,fontSize:11,color:'#1E40AF'}}>
              💡 <strong>Strategi:</strong> Assign dedicated support untuk produk ini. Pantau daily — jangan biarkan momentum terhambat masalah teknis.
            </div>
          </div>
        )}
      </div>

      {kritis.length===0&&bintang.length===0&&optimasi.length===0&&rising.length===0&&(
        <div className="wrpa-empty">
          <i className="ti ti-check-circle" style={{fontSize:36,color:THEME}} />
          <p style={{fontWeight:600,marginTop:8}}>Tidak ada tindakan mendesak</p>
          <span style={{fontSize:13,color:'#9CA3AF'}}>Semua produk dalam kondisi normal</span>
        </div>
      )}
    </div>
  );
}

/* ─── Main ─── */
const TABS = [
  { label:'Executive Summary',  icon:'ti-layout-dashboard' },
  { label:'Trendline Harian',   icon:'ti-chart-line'       },
  { label:'Trend & Growth',     icon:'ti-trending-up'      },
  { label:'Unit Ekonomi',       icon:'ti-calculator'       },
  { label:'Action Center',      icon:'ti-target'           },
];

export default function WarRoomPAProduk() {
  const [tab,        setTab]        = useState(0);
  const [resp,       setResp]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [modalRow,   setModalRow]   = useState(null);
  const [bulanSel,   setBulanSel]   = useState(null);

  async function fetchData(isRefresh=false, bulanOverride) {
    isRefresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const d = await getPAProdukAnalytics(bulanOverride ? { bulan: bulanOverride } : (bulanSel ? { bulan: bulanSel } : {}));
      setResp(d);
      if (d?.bulan) setBulanSel(d.bulan);
    }
    catch(e) { setError(e?.response?.data?.error||e.message); }
    finally { setLoading(false); setRefreshing(false); }
  }

  useEffect(() => { fetchData(); }, []);

  function handleBulanChange(newBulan) {
    setBulanSel(newBulan);
    fetchData(false, newBulan);
  }

  if (loading) return <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw" gsheetLabel="PA Produk & ARPU"><div className="wrpa-loading"><i className="ti ti-loader-2 wrpa-spin"/><span>Memuat data PA Produk…</span></div></Layout>;
  if (error)   return <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw" gsheetLabel="PA Produk & ARPU"><div className="wrpa-error"><i className="ti ti-alert-circle"/><span>Gagal memuat: {error}</span></div></Layout>;
  if (!resp?.meta) return (
    <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw" gsheetLabel="PA Produk & ARPU">
      <div className="wrpa-empty">
        <i className="ti ti-database-off" style={{fontSize:36,color:'#9CA3AF'}}/>
        <p style={{fontWeight:600}}>Belum ada data PA Produk</p>
        <span style={{fontSize:13,color:'#9CA3AF'}}>Jalankan sync dari Google Sheets terlebih dahulu.</span>
      </div>
    </Layout>
  );

  const { meta, total, data, stats, top15_growth_trx, bot15_decline_trx, bulan, bulan_list, bulan_m1, bulan_m2 } = resp;
  const bulanInfo = { bulan, bulan_m1, bulan_m2 };
  const bulanListArr = bulan_list || [];

  return (
    <Layout gsheetUrl="https://docs.google.com/spreadsheets/d/1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw" gsheetLabel="PA Produk & ARPU">
      <div className="wrpa-page">
        <div className="wrpa-header">
          <div className="wrpa-header-left">
            <i className="ti ti-chart-bar" style={{color:THEME,fontSize:22}}/>
            <div>
              <div className="wrpa-header-title">WAR-ROOM PA PRODUK</div>
              <div className="wrpa-header-meta">{fmtN(stats?.total_outlets || data.length)} outlet · Payment Agent</div>
            </div>
          </div>
          <div className="wrpa-header-badges">
            {bulanListArr.length > 1 && (
              <select className="wrpa-filter-btn" value={bulan} onChange={e => handleBulanChange(e.target.value)} style={{ cursor:'pointer' }}>
                {bulanListArr.map(b => <option key={b} value={b}>{bulanDisplay(b)}</option>)}
              </select>
            )}
            <span className="wrpa-period-badge"><i className="ti ti-calendar-stats"/> {fmtDate(meta.periode_start)} – {fmtDate(meta.periode_end)}</span>
            <span className="wrpa-date-badge"><i className="ti ti-refresh"/> Update {fmtDate(meta.last_sync)}</span>
            <button className="wrpa-refresh-btn" onClick={()=>fetchData(true)} title="Refresh">
              <i className={`ti ti-refresh${refreshing?' wrpa-spin':''}`}/>
            </button>
          </div>
        </div>

        <div className="wrpa-tabs">
          {TABS.map((t,i)=>(
            <button key={i} className={`wrpa-tab${tab===i?' wrpa-tab--active':''}`} onClick={()=>setTab(i)}>
              <i className={`ti ${t.icon}`}/>{t.label}
            </button>
          ))}
        </div>

        {tab===0&&<ExecutiveSummaryTab data={data} total={total} meta={meta} stats={stats} onProdukClick={setModalRow} bulan={bulanInfo}/>}
        {tab===1&&<TrendlineTab analytics={resp} bulan={bulanInfo}/>}
        {tab===2&&<TrendGrowthTab data={data} top15_growth_trx={top15_growth_trx} bot15_decline_trx={bot15_decline_trx} bulan={bulanInfo}/>}
        {tab===3&&<UnitEkonomiTab data={data} bulan={bulanInfo}/>}
        {tab===4&&<ActionCenterTab data={data} bulan={bulanInfo}/>}
      </div>

      {modalRow&&<ProdukModal row={modalRow} onClose={()=>setModalRow(null)} bulan={bulanInfo}/>}
    </Layout>
  );
}
