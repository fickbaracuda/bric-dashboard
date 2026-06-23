import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import { getToken } from '../utils/auth';

const API = import.meta.env.VITE_API_URL || '';

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtM(b) {
  if (!b) return '-';
  const [y, m] = b.split('-');
  return ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'][+m-1] + ' ' + y;
}
function fmtRp(n) {
  n = n || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + 'Rp' + (abs/1e9).toFixed(1) + 'M';
  if (abs >= 1e6) return sign + 'Rp' + (abs/1e6).toFixed(1) + 'jt';
  return sign + 'Rp' + Math.round(abs).toLocaleString('id-ID');
}
function fmtN(n)   { return (n||0).toLocaleString('id-ID'); }
function fmtP(n)   { return ((n||0)*100).toFixed(1) + '%'; }
function fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' });
}

const STAGE_LABEL = {
  registered_not_activated: 'Belum Aktivasi',
  activated_no_trx:         'Aktivasi, 0 Trx',
  first_trx:                'First Trx',
  low_frequency:            'Low Frequency',
  high_potential:           'High Potential',
  revenue_hero:             'Revenue Hero',
  activation_loss:          'Loss Aktivasi',
};
const STAGE_COLOR = {
  registered_not_activated: '#DC2626',
  activated_no_trx:         '#D97706',
  first_trx:                '#059669',
  low_frequency:            '#2563EB',
  high_potential:           '#7C3AED',
  revenue_hero:             '#F97316',
  activation_loss:          '#991B1B',
};
const STATUS_LABEL = {
  super_hunter:       'Super PB',
  activation_hunter:  'Activation PB',
  acquisition_hunter: 'Acquisition PB',
  revenue_hunter:     'Revenue PB',
  dormant_hunter:     'Dormant PB',
  costly_hunter:      'Costly PB',
};
const STATUS_COLOR = {
  super_hunter:       '#7C3AED',
  activation_hunter:  '#059669',
  acquisition_hunter: '#D97706',
  revenue_hunter:     '#2563EB',
  dormant_hunter:     '#9CA3AF',
  costly_hunter:      '#DC2626',
};

function StageBadge({ stage }) {
  const c = STAGE_COLOR[stage] || '#9CA3AF';
  return (
    <span style={{ display:'inline-block', padding:'2px 8px', borderRadius:4, fontSize:11,
      background: c+'22', color: c, fontWeight:600, whiteSpace:'nowrap' }}>
      {STAGE_LABEL[stage] || stage}
    </span>
  );
}
function StatusBadge({ status }) {
  const c = STATUS_COLOR[status] || '#9CA3AF';
  return (
    <span style={{ display:'inline-block', padding:'2px 8px', borderRadius:4, fontSize:11,
      background: c+'22', color: c, fontWeight:600, whiteSpace:'nowrap' }}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}
function WaLink({ no }) {
  if (!no) return <span style={{ color:'var(--text-4)' }}>—</span>;
  const digits = String(no).replace(/\D/g, '');
  const wa = digits.startsWith('0') ? '62' + digits.slice(1) : digits;
  return (
    <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer"
       style={{ color:'#25D366', display:'flex', alignItems:'center', gap:3 }}>
      <i className="ti ti-brand-whatsapp" style={{ fontSize:13 }} />
      {no}
    </a>
  );
}

// ── Apps Script ───────────────────────────────────────────────────────────
function buildScript() {
  return `// ============================================================
// BRIC Dashboard — Sync Hunter (D.1, D.2, D.3)
// D.1 = data Mei (referensi registrasi, tidak berubah)
// D.2 = data transaksi bulan berjalan (Juni, dst)
// D.3 = data aktivasi bulan berjalan (Juni, dst)
//
// Cara pakai:
// 1. Extensions → Apps Script → paste kode ini → Save
// 2. Run: syncHunterData()
// ============================================================
var VPS_URL    = 'https://bmsretail.my.id/api/warroom/hunter/sync';
var SYNC_TOKEN = 'bric2026bimasaktisecret';

function getCurrentBulan() {
  var now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

function syncHunterData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  var s1 = ss.getSheetByName('D.1');
  var s2 = ss.getSheetByName('D.2');
  var s3 = ss.getSheetByName('D.3');

  if (!s1) { ui.alert('❌ Sheet "D.1" tidak ditemukan!'); return; }
  if (!s2) { ui.alert('❌ Sheet "D.2" tidak ditemukan!'); return; }
  if (!s3) { ui.alert('❌ Sheet "D.3" tidak ditemukan!'); return; }

  ss.toast('Membaca data...', 'Hunter Sync', 5);

  var d1 = readSheet(s1);
  var d2 = readSheet(s2);
  var d3 = readSheet(s3);

  if (d1.length === 0) { ui.alert('❌ Sheet D.1 kosong.'); return; }

  // Bulan laporan = bulan D.2 & D.3 (default: bulan ini)
  var defaultBulan = getCurrentBulan();
  var resp = ui.prompt(
    '🎯 Hunter Sync — Bulan Laporan',
    'D.1 = data Mei (referensi tetap)\\n' +
    'D.2 & D.3 = data bulan laporan\\n\\n' +
    'Masukkan bulan laporan (YYYY-MM).\\n' +
    'Kosongkan untuk pakai bulan ini (' + defaultBulan + '):',
    ui.ButtonSet.OK_CANCEL
  );

  if (resp.getSelectedButton() !== ui.Button.OK) { ui.alert('Dibatalkan.'); return; }

  var inputBulan = resp.getResponseText().trim();
  var bulan      = inputBulan || defaultBulan;

  if (!/^\\d{4}-\\d{2}$/.test(bulan)) {
    ui.alert('❌ Format bulan tidak valid. Gunakan YYYY-MM (contoh: 2026-06).');
    return;
  }

  var confirm = ui.alert('Konfirmasi',
    '🎯 Sync Hunter\\n\\n' +
    'Bulan laporan : ' + bulan + '\\n' +
    'D.1 (ref Mei) : ' + d1.length + ' baris\\n' +
    'D.2 (trx)     : ' + d2.length + ' baris\\n' +
    'D.3 (akt)     : ' + d3.length + ' baris\\n\\n' +
    'Data lama bulan ' + bulan + ' akan DIGANTI. Lanjutkan?',
    ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) { ui.alert('Dibatalkan.'); return; }

  ss.toast('Mengirim data ke server...', 'Hunter Sync', 60);

  try {
    var response = UrlFetchApp.fetch(VPS_URL, {
      method:             'post',
      contentType:        'application/json',
      payload:            JSON.stringify({ token: SYNC_TOKEN, bulan: bulan, d1: d1, d2: d2, d3: d3 }),
      muteHttpExceptions: true,
      followRedirects:    true
    });
    var code = response.getResponseCode();
    var body = JSON.parse(response.getContentText());
    if (code !== 200) { ui.alert('❌ HTTP ' + code + '\\n\\n' + response.getContentText().slice(0, 400)); return; }
    if (body.ok) {
      ui.alert('✅ Sync Berhasil!\\n\\nBulan : ' + body.bulan +
        '\\nD.1   : ' + body.d1_rows + ' baris' +
        '\\nD.2   : ' + body.d2_rows + ' baris' +
        '\\nD.3   : ' + body.d3_rows + ' baris' +
        '\\nDurasi: ' + body.duration_ms + ' ms');
    } else {
      ui.alert('❌ Server error:\\n\\n' + JSON.stringify(body).slice(0, 400));
    }
  } catch (e) {
    ui.alert('❌ Exception:\\n\\n' + e.message);
  }
}

function readSheet(sheet) {
  var last = sheet.getLastRow();
  var lc   = sheet.getLastColumn();
  if (last < 2 || lc < 1) return [];
  var data    = sheet.getRange(1, 1, last, lc).getValues();
  var headers = data[0].map(function(h) { return String(h).trim(); });
  var rows    = [];
  for (var r = 1; r < data.length; r++) {
    var row    = data[r];
    var hasVal = headers.some(function(h, i) { return h && row[i] !== '' && row[i] != null; });
    if (!hasVal) continue;
    var obj = {};
    headers.forEach(function(h, i) {
      if (!h) return;
      var v = row[i];
      if (v instanceof Date) v = Utilities.formatDate(v, 'Asia/Jakarta', 'yyyy-MM-dd');
      else if (v === undefined || v === null) v = '';
      obj[h] = v;
    });
    rows.push(obj);
  }
  return rows;
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎯 Hunter Sync')
    .addItem('Sync ke Dashboard', 'syncHunterData')
    .addToUi();
}`;
}

// ── TABS ──────────────────────────────────────────────────────────────────
const TABS = [
  { key: 'command',     label: '🎯 Command Center',      icon: 'ti-dashboard' },
  { key: 'leaderboard', label: '🏆 Leaderboard PB',       icon: 'ti-trophy' },
  { key: 'action',      label: '⚡ Action Queue',         icon: 'ti-list-check' },
  { key: 'funnel',      label: '🔽 Funnel',               icon: 'ti-filter' },
  { key: 'revenue',     label: '💰 Revenue Intelligence', icon: 'ti-coin' },
  { key: 'area',        label: '📍 Area & Type',          icon: 'ti-map-pin' },
];

// ── Main Page ─────────────────────────────────────────────────────────────
export default function WarRoomHunter() {
  const [tab,     setTab]     = useState('command');
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [bulan,   setBulan]   = useState('');
  const [script,  setScript]  = useState(false);

  useEffect(() => {
    const params = bulan ? '?bulan=' + bulan : '';
    setLoading(true);
    setError('');
    fetch(API + '/api/warroom/hunter/analytics' + params, {
      headers: { Authorization: 'Bearer ' + getToken() },
    })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [bulan]);

  const cc = data?.command_center;

  return (
    <Layout>
      <div className="wh-page">
        {/* ── Header ── */}
        <div className="wh-header">
          <div className="wh-title">
            <span className="wh-badge-icon">🎯</span>
            <span>WAR-ROOM <strong>Hunter</strong></span>
            {data && !data.empty && (
              <span className="wh-bulan-chip">{fmtM(data.bulan)}</span>
            )}
          </div>
          <div className="wh-header-right">
            {data?.bulan_list?.length > 0 && (
              <select className="wh-select" value={bulan} onChange={e => setBulan(e.target.value)}>
                <option value="">Bulan Terbaru</option>
                {data.bulan_list.map(b => (
                  <option key={b} value={b}>{fmtM(b)}</option>
                ))}
              </select>
            )}
            <button className="wh-btn-script" onClick={() => setScript(true)}>
              <i className="ti ti-brand-google" />
              Apps Script
            </button>
          </div>
        </div>

        {/* ── Tabs ── */}
        <div className="wh-tabs">
          {TABS.map(t => (
            <button
              key={t.key}
              className={'wh-tab' + (tab === t.key ? ' wh-tab--active' : '')}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Content ── */}
        {loading && (
          <div className="wh-loading">
            <i className="ti ti-loader-2 dr-spinner" />
            Menganalisis data Hunter…
          </div>
        )}
        {error && <div className="wh-error"><i className="ti ti-alert-circle" /> {error}</div>}
        {data?.empty && (
          <div className="wh-empty">
            <i className="ti ti-crosshair" />
            <div>Belum ada data Hunter. Jalankan Apps Script dari Google Sheets untuk sync pertama.</div>
          </div>
        )}

        {!loading && !error && data && !data.empty && (
          <>
            {tab === 'command'     && <CommandCenter cc={data.command_center} />}
            {tab === 'leaderboard' && <Leaderboard list={data.hunter_leaderboard} />}
            {tab === 'action'      && <ActionQueue queue={data.action_queue} />}
            {tab === 'funnel'      && <FunnelTab cc={data.command_center} funnel={data.funnel_hunter} />}
            {tab === 'revenue'     && <RevenueTab rev={data.revenue} />}
            {tab === 'area'        && <AreaTypeTab area={data.area} types={data.type_loket} />}
          </>
        )}
      </div>

      {script && <ScriptModal onClose={() => setScript(false)} />}
    </Layout>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────
function KPI({ label, value, sub, color, icon }) {
  return (
    <div className="wh-kpi">
      {icon && <i className={'ti ' + icon} style={{ color: color || 'var(--primary)', fontSize: 18, marginBottom: 6, display:'block' }} />}
      <div className="wh-kpi-val" style={color ? { color } : {}}>{value}</div>
      <div className="wh-kpi-label">{label}</div>
      {sub && <div className="wh-kpi-sub">{sub}</div>}
    </div>
  );
}

// ── Tab 1: Command Center ─────────────────────────────────────────────────
function CommandCenter({ cc }) {
  const fn = cc.funnel;
  const steps = [
    { label: 'Register', val: fn.register, color: '#3B82F6' },
    { label: 'Aktivasi', val: fn.aktivasi, color: '#10B981' },
    { label: 'Trx', val: fn.trx, color: '#7C3AED' },
    { label: 'Repeat', val: fn.repeat, color: '#F97316' },
    { label: 'Rev+', val: fn.rev_positive, color: '#059669' },
  ];

  const convs = [];
  for (let i = 1; i < steps.length; i++) {
    const r = steps[i-1].val > 0 ? (steps[i].val / steps[i-1].val * 100).toFixed(1) : '0.0';
    convs.push(r + '%');
  }

  return (
    <div className="wh-section">
      {/* KPI Grid */}
      <div className="wh-kpi-grid">
        <KPI icon="ti-users" label="Total PB (Pembina Bisnis)" value={fmtN(cc.total_hunters)} color="#3B82F6" />
        <KPI icon="ti-user-plus" label="Total Register" value={fmtN(cc.total_register)} />
        <KPI icon="ti-check-circle" label="Sudah Aktivasi" value={fmtN(cc.total_aktivasi)}
             sub={fmtP(cc.activation_rate) + ' activation rate'} color="#10B981" />
        <KPI icon="ti-clock-off" label="Belum Aktivasi" value={fmtN(cc.belum_aktivasi)}
             color={cc.belum_aktivasi > cc.total_aktivasi ? '#DC2626' : '#D97706'} />
        <KPI icon="ti-cash-register" label="Outlet Trx" value={fmtN(cc.sudah_trx)}
             sub={fmtP(cc.first_trx_rate) + ' dari yg aktivasi'} color="#7C3AED" />
        <KPI icon="ti-ban" label="Aktivasi 0 Trx" value={fmtN(cc.outlet_0_trx)} color="#D97706" />
        <KPI icon="ti-refresh" label="Repeat Trx" value={fmtN(cc.repeat_trx)} color="#059669" />
        <KPI icon="ti-chart-bar" label="Total Trx" value={fmtN(cc.total_trx)} />
        <KPI icon="ti-coin" label="Margin Trx" value={fmtRp(cc.total_margin)} color="#059669" />
        <KPI icon="ti-percentage" label="Avg Margin / Trx" value={fmtRp(cc.avg_margin_per_trx)} />
        <KPI icon="ti-award" label="Rev Aktivasi Net" value={fmtRp(cc.rev_aktivasi_net)}
             color={cc.rev_aktivasi_net < 0 ? '#DC2626' : '#10B981'} />
        <KPI icon="ti-currency-dollar" label="Total Revenue" value={fmtRp(cc.total_revenue)}
             color={cc.total_revenue < 0 ? '#DC2626' : '#7C3AED'} />
        <KPI icon="ti-alert-triangle" label="Loss Aktivasi" value={fmtN(cc.neg_activation_count)}
             color={cc.neg_activation_count > 0 ? '#DC2626' : '#9CA3AF'} />
        <KPI icon="ti-trending-up" label="Rev Positif" value={fmtN(cc.rev_positive)}
             sub={fmtP(cc.total_register > 0 ? cc.rev_positive / cc.total_register : 0)} color="#F97316" />
      </div>

      {/* Funnel */}
      <div className="wh-card">
        <div className="wh-card-title">
          <i className="ti ti-filter" />
          Funnel Konversi
        </div>
        <div className="wh-funnel-wrap">
          {steps.map((s, i) => (
            <div key={s.label} className="wh-funnel-step">
              <div className="wh-funnel-bar-wrap">
                <div className="wh-funnel-bar" style={{
                  height: 80 - i * 12,
                  background: s.color,
                  width: '100%',
                  borderRadius: 6,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontWeight: 700, fontSize: 14,
                }}>
                  {fmtN(s.val)}
                </div>
              </div>
              <div className="wh-funnel-label">{s.label}</div>
              {i < steps.length - 1 && (
                <div className="wh-funnel-conv">{convs[i]}</div>
              )}
            </div>
          ))}
        </div>
        <div className="wh-funnel-hint">
          Angka di bawah panah = konversi dari tahap sebelumnya
        </div>
      </div>
    </div>
  );
}

// ── Tab 2: Hunter Leaderboard ─────────────────────────────────────────────
function Leaderboard({ list }) {
  const [sort, setSort] = useState('score');
  const [dir,  setDir]  = useState(-1);

  function toggle(col) {
    if (sort === col) setDir(d => -d);
    else { setSort(col); setDir(-1); }
  }

  const sorted = [...list].sort((a, b) => dir * ((a[sort]||0) < (b[sort]||0) ? -1 : 1));

  function Th({ col, children }) {
    return (
      <th onClick={() => toggle(col)} style={{ cursor:'pointer', userSelect:'none', whiteSpace:'nowrap' }}>
        {children}
        {sort === col && <span style={{ marginLeft:3 }}>{dir<0?'↓':'↑'}</span>}
      </th>
    );
  }

  return (
    <div className="wh-section">
      <div className="wh-card">
        <div className="wh-card-title">
          <i className="ti ti-trophy" />
          Leaderboard Pembina Bisnis — {list.length} PB
        </div>
        <div className="wh-table-wrap">
          <table className="wh-table">
            <thead>
              <tr>
                <th>#</th>
                <Th col="upline">Pembina Bisnis</Th>
                <Th col="reg">Register</Th>
                <Th col="akt">Aktivasi</Th>
                <Th col="act_rate">Act%</Th>
                <Th col="trx_out">Outlet Trx</Th>
                <Th col="trx_rate">Trx%</Th>
                <Th col="total_trx">Total Trx</Th>
                <Th col="margin">Margin</Th>
                <Th col="rev_akt">Rev Akt</Th>
                <Th col="total_rev">Total Rev</Th>
                <Th col="score">Score</Th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((h, i) => (
                <tr key={h.upline} style={i < 3 ? { background:'rgba(124,58,237,.04)' } : {}}>
                  <td style={{ textAlign:'center', fontWeight:700, color: i===0?'#F97316': i===1?'#9CA3AF': i===2?'#D97706':'var(--text-3)' }}>
                    {h.rank}
                  </td>
                  <td style={{ fontWeight:600 }}>{h.upline}</td>
                  <td style={{ textAlign:'right' }}>{fmtN(h.reg)}</td>
                  <td style={{ textAlign:'right' }}>{fmtN(h.akt)}</td>
                  <td>
                    <div style={{ display:'flex', alignItems:'center', gap:4, minWidth:70 }}>
                      <div style={{ flex:1, height:5, background:'var(--border)', borderRadius:3 }}>
                        <div style={{ width: fmtP(h.act_rate), height:'100%', background:'#10B981', borderRadius:3 }} />
                      </div>
                      <span style={{ fontSize:11, minWidth:34 }}>{fmtP(h.act_rate)}</span>
                    </div>
                  </td>
                  <td style={{ textAlign:'right' }}>{fmtN(h.trx_out)}</td>
                  <td style={{ fontSize:11 }}>{fmtP(h.trx_rate)}</td>
                  <td style={{ textAlign:'right' }}>{fmtN(h.total_trx)}</td>
                  <td style={{ textAlign:'right', color: h.margin>=0?'#059669':'#DC2626' }}>{fmtRp(h.margin)}</td>
                  <td style={{ textAlign:'right', color: h.rev_akt>=0?'#059669':'#DC2626' }}>{fmtRp(h.rev_akt)}</td>
                  <td style={{ textAlign:'right', fontWeight:600, color: h.total_rev>=0?'#7C3AED':'#DC2626' }}>{fmtRp(h.total_rev)}</td>
                  <td>
                    <div style={{ display:'flex', alignItems:'center', gap:4, minWidth:80 }}>
                      <div style={{ flex:1, height:5, background:'var(--border)', borderRadius:3 }}>
                        <div style={{ width: h.score+'%', height:'100%', background:'#7C3AED', borderRadius:3 }} />
                      </div>
                      <span style={{ fontSize:11, fontWeight:700, minWidth:24 }}>{h.score}</span>
                    </div>
                  </td>
                  <td><StatusBadge status={h.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Tab 3: Action Queue ───────────────────────────────────────────────────
function ActionQueue({ queue }) {
  const [filter, setFilter]   = useState('all');
  const [search, setSearch]   = useState('');

  const FILTERS = [
    { key: 'all',                      label: 'Semua' },
    { key: 'registered_not_activated', label: 'Belum Aktivasi' },
    { key: 'activated_no_trx',         label: '0 Trx' },
    { key: 'first_trx',                label: 'First Trx' },
    { key: 'activation_loss',          label: 'Loss Aktivasi' },
    { key: 'low_frequency',            label: 'Low Frequency' },
  ];

  const filtered = queue.filter(m => {
    if (filter !== 'all' && m.stage !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (m.nama||'').toLowerCase().includes(q) ||
             (m.id_loket||'').toLowerCase().includes(q) ||
             (m.upline||'').toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="wh-section">
      <div className="wh-card">
        <div className="wh-card-title">
          <i className="ti ti-list-check" />
          Action Queue — {filtered.length} outlet prioritas
        </div>

        <div className="wh-toolbar">
          <div className="wh-filter-chips">
            {FILTERS.map(f => (
              <button key={f.key}
                className={'wh-chip' + (filter===f.key ? ' wh-chip--active' : '')}
                onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
          <input className="wh-search"
            placeholder="Cari nama / ID / PB…"
            value={search}
            onChange={e => setSearch(e.target.value)} />
        </div>

        <div className="wh-table-wrap">
          <table className="wh-table">
            <thead>
              <tr>
                <th>Prioritas</th>
                <th>ID Loket</th>
                <th>Nama</th>
                <th>No Telp</th>
                <th>PB</th>
                <th>Type</th>
                <th>Kota</th>
                <th>Stage</th>
                <th>Tgl Reg</th>
                <th>Aging</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m, i) => (
                <tr key={m.id_loket + i}>
                  <td style={{ textAlign:'center' }}>
                    <span style={{
                      display:'inline-block', width:32, height:32, borderRadius:'50%', lineHeight:'32px',
                      textAlign:'center', fontWeight:700, fontSize:12,
                      background: m.priority>=80?'#DC262622': m.priority>=60?'#D9770622': '#2563EB22',
                      color:      m.priority>=80?'#DC2626':   m.priority>=60?'#D97706':   '#2563EB',
                    }}>{m.priority}</span>
                  </td>
                  <td style={{ fontFamily:'monospace', fontSize:11 }}>{m.id_loket}</td>
                  <td style={{ fontWeight:500, maxWidth:160, overflow:'hidden', textOverflow:'ellipsis' }}>{m.nama}</td>
                  <td><WaLink no={m.no_telp} /></td>
                  <td style={{ fontSize:11 }}>{m.upline}</td>
                  <td style={{ fontSize:11 }}>{m.type_loket}</td>
                  <td style={{ fontSize:11 }}>{m.kota || '-'}</td>
                  <td><StageBadge stage={m.stage} /></td>
                  <td style={{ fontSize:11 }}>{fmtDate(m.tgl_reg)}</td>
                  <td style={{ textAlign:'right', fontSize:11 }}>{m.aging}h</td>
                  <td style={{ fontSize:11, fontWeight:600, color:'#7C3AED', whiteSpace:'nowrap' }}>{m.action}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={11} style={{ textAlign:'center', padding:24, color:'var(--text-4)' }}>Tidak ada data</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Tab 4: Funnel ─────────────────────────────────────────────────────────
function FunnelTab({ cc, funnel }) {
  const fn   = cc.funnel;
  const pct  = (a, b) => b > 0 ? (a/b*100).toFixed(1)+'%' : '0%';

  return (
    <div className="wh-section">
      {/* Big Funnel */}
      <div className="wh-card">
        <div className="wh-card-title"><i className="ti ti-filter" /> Funnel Keseluruhan</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:12, padding:'8px 0' }}>
          {[
            { label:'Register',   val: fn.register,   pct: '100%',                           color:'#3B82F6' },
            { label:'Aktivasi',   val: fn.aktivasi,   pct: pct(fn.aktivasi, fn.register),    color:'#10B981' },
            { label:'Trx',        val: fn.trx,        pct: pct(fn.trx, fn.aktivasi),         color:'#7C3AED' },
            { label:'Repeat Trx', val: fn.repeat,     pct: pct(fn.repeat, fn.trx),           color:'#F97316' },
            { label:'Rev+',       val: fn.rev_positive, pct: pct(fn.rev_positive, fn.register), color:'#059669' },
          ].map((s, i) => (
            <div key={s.label} style={{ textAlign:'center' }}>
              <div style={{
                background: s.color, color:'#fff', borderRadius:8, padding:'18px 8px',
                fontSize: 22-i*2, fontWeight:700, marginBottom:8,
              }}>{fmtN(s.val)}</div>
              <div style={{ fontSize:12, fontWeight:600, color:'var(--text-2)' }}>{s.label}</div>
              <div style={{ fontSize:11, color: s.color, fontWeight:700, marginTop:2 }}>
                {i === 0 ? 'Base' : s.pct + ' dari sebelumnya'}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginTop:8 }}>
          {[
            { label:'Reg → Akt drop', val: fn.register - fn.aktivasi, color:'#DC2626' },
            { label:'Akt → Trx drop', val: fn.aktivasi - fn.trx,     color:'#D97706' },
            { label:'Trx → Repeat drop', val: fn.trx - fn.repeat,    color:'#F59E0B' },
            { label:'Tidak Rev+', val: fn.register - fn.rev_positive,  color:'#9CA3AF' },
          ].map(d => (
            <div key={d.label} style={{ background:'var(--bg-page)', borderRadius:8, padding:'10px 12px', textAlign:'center' }}>
              <div style={{ fontSize:18, fontWeight:700, color:d.color }}>{fmtN(d.val)}</div>
              <div style={{ fontSize:11, color:'var(--text-3)', marginTop:2 }}>{d.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Per-PB funnel */}
      <div className="wh-card">
        <div className="wh-card-title"><i className="ti ti-user-check" /> Funnel per Pembina Bisnis</div>
        <div className="wh-table-wrap">
          <table className="wh-table">
            <thead>
              <tr>
                <th>Pembina Bisnis</th>
                <th>Register</th>
                <th>Aktivasi</th>
                <th>Drop R→A</th>
                <th>Act%</th>
                <th>Outlet Trx</th>
                <th>Drop A→T</th>
                <th>Trx%</th>
                <th>Total Rev</th>
                <th>Bottleneck</th>
              </tr>
            </thead>
            <tbody>
              {funnel.map(h => (
                <tr key={h.upline}>
                  <td style={{ fontWeight:600 }}>{h.upline}</td>
                  <td style={{ textAlign:'right' }}>{fmtN(h.rr)}</td>
                  <td style={{ textAlign:'right' }}>{fmtN(h.aa)}</td>
                  <td style={{ textAlign:'right', color:'#DC2626' }}>{h.drop_ra > 0 ? '-'+fmtN(h.drop_ra) : '—'}</td>
                  <td style={{ fontSize:11 }}>{h.rr>0 ? (h.aa/h.rr*100).toFixed(1)+'%' : '—'}</td>
                  <td style={{ textAlign:'right' }}>{fmtN(h.tt)}</td>
                  <td style={{ textAlign:'right', color:'#D97706' }}>{h.drop_at > 0 ? '-'+fmtN(h.drop_at) : '—'}</td>
                  <td style={{ fontSize:11 }}>{h.aa>0 ? (h.tt/h.aa*100).toFixed(1)+'%' : '—'}</td>
                  <td style={{ textAlign:'right', fontWeight:600, color: h.rev>=0?'#7C3AED':'#DC2626' }}>{fmtRp(h.rev)}</td>
                  <td>
                    <span style={{
                      padding:'2px 7px', borderRadius:4, fontSize:11, fontWeight:600,
                      background: h.bot==='OK'?'#05996922':'#D9770622',
                      color: h.bot==='OK'?'#059669':'#D97706',
                    }}>{h.bot}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Tab 5: Revenue Intelligence ───────────────────────────────────────────
function RevenueTab({ rev }) {
  const cards = [
    { label:'Gross Biaya Aktivasi',   val: rev.gross_aktivasi,      color:'#3B82F6', icon:'ti-receipt' },
    { label:'HPP',                    val: -rev.hpp_total,           color:'#DC2626', icon:'ti-minus-circle' },
    { label:'Ongkos Kirim',           val: -rev.ongkos_kirim_total,  color:'#DC2626', icon:'ti-truck' },
    { label:'Fee Pembina Bisnis',      val: -rev.fee_upline_total,    color:'#DC2626', icon:'ti-arrow-up-circle' },
    { label:'Net Komisi Aktivasi',    val: rev.net_komisi,           color: rev.net_komisi>=0?'#059669':'#DC2626', icon:'ti-coin' },
    { label:'Margin Transaksi',       val: rev.margin_trx,           color:'#7C3AED', icon:'ti-chart-bar' },
    { label:'Total Net Revenue',      val: rev.total_net_revenue,    color: rev.total_net_revenue>=0?'#F97316':'#DC2626', icon:'ti-currency-dollar' },
  ];

  return (
    <div className="wh-section">
      <div className="wh-kpi-grid">
        {cards.map(c => (
          <div key={c.label} className="wh-kpi">
            <i className={'ti ' + c.icon} style={{ color:c.color, fontSize:18, marginBottom:6, display:'block' }} />
            <div className="wh-kpi-val" style={{ color:c.color, fontSize:18 }}>{fmtRp(c.val)}</div>
            <div className="wh-kpi-label">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Loss table */}
      {rev.loss_count > 0 && (
        <div className="wh-card">
          <div className="wh-card-title">
            <i className="ti ti-alert-triangle" style={{ color:'#DC2626' }} />
            Alert: Aktivasi Loss — {rev.loss_count} outlet (total {fmtRp(rev.loss_amount)})
          </div>
          <div className="wh-table-wrap">
            <table className="wh-table">
              <thead>
                <tr>
                  <th>ID Loket</th>
                  <th>Nama</th>
                  <th>PB</th>
                  <th>Type Loket</th>
                  <th>Biaya Aktifasi</th>
                  <th>HPP</th>
                  <th>Ongkir</th>
                  <th>Fee PB</th>
                  <th>Komisi (Rugi)</th>
                  <th>Trx</th>
                  <th>No Telp</th>
                </tr>
              </thead>
              <tbody>
                {rev.loss_table.map((m, i) => (
                  <tr key={i}>
                    <td style={{ fontFamily:'monospace', fontSize:11 }}>{m.id_loket}</td>
                    <td style={{ maxWidth:140, overflow:'hidden', textOverflow:'ellipsis' }}>{m.nama}</td>
                    <td style={{ fontSize:11 }}>{m.upline}</td>
                    <td style={{ fontSize:11 }}>{m.type_loket}</td>
                    <td style={{ textAlign:'right' }}>{fmtRp(m.biaya_aktifasi)}</td>
                    <td style={{ textAlign:'right', color:'#DC2626' }}>{fmtRp(m.hpp)}</td>
                    <td style={{ textAlign:'right', color:'#DC2626' }}>{fmtRp(m.ongkos_kirim)}</td>
                    <td style={{ textAlign:'right', color:'#DC2626' }}>{fmtRp(m.fee_upline)}</td>
                    <td style={{ textAlign:'right', fontWeight:700, color:'#DC2626' }}>{fmtRp(m.komisi)}</td>
                    <td style={{ textAlign:'right' }}>{fmtN(m.jml_trx)}</td>
                    <td><WaLink no={m.no_telp} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rev.loss_count === 0 && (
        <div className="wh-card" style={{ textAlign:'center', padding:24 }}>
          <i className="ti ti-check-circle" style={{ color:'#10B981', fontSize:32 }} />
          <div style={{ color:'var(--text-2)', marginTop:8 }}>Tidak ada aktivasi yang rugi. Struktur biaya sehat!</div>
        </div>
      )}
    </div>
  );
}

// ── Tab 6: Area & Type ────────────────────────────────────────────────────
function AreaTypeTab({ area, types }) {
  const [view, setView] = useState('area');
  return (
    <div className="wh-section">
      <div style={{ display:'flex', gap:8, marginBottom:12 }}>
        {[{ k:'area', l:'Provinsi' }, { k:'type', l:'Type Loket' }].map(v => (
          <button key={v.k}
            className={'wh-chip' + (view===v.k ? ' wh-chip--active' : '')}
            onClick={() => setView(v.k)}>{v.l}
          </button>
        ))}
      </div>

      {view === 'area' && (
        <div className="wh-card">
          <div className="wh-card-title"><i className="ti ti-map-pin" /> Distribusi Provinsi</div>
          <div className="wh-table-wrap">
            <table className="wh-table">
              <thead>
                <tr>
                  <th>Provinsi</th>
                  <th>Register</th>
                  <th>Aktivasi</th>
                  <th>Act%</th>
                  <th>Outlet Trx</th>
                  <th>Jml Trx</th>
                  <th>Margin</th>
                  <th>Rev Akt</th>
                  <th>Total Rev</th>
                </tr>
              </thead>
              <tbody>
                {area.map(a => (
                  <tr key={a.propinsi}>
                    <td style={{ fontWeight:600 }}>{a.propinsi}</td>
                    <td style={{ textAlign:'right' }}>{fmtN(a.reg)}</td>
                    <td style={{ textAlign:'right' }}>{fmtN(a.akt)}</td>
                    <td style={{ fontSize:11 }}>{fmtP(a.act_rate)}</td>
                    <td style={{ textAlign:'right' }}>{fmtN(a.trx)}</td>
                    <td style={{ textAlign:'right' }}>{fmtN(a.jml_trx)}</td>
                    <td style={{ textAlign:'right', color:'#059669' }}>{fmtRp(a.margin)}</td>
                    <td style={{ textAlign:'right', color: a.rev_akt>=0?'#059669':'#DC2626' }}>{fmtRp(a.rev_akt)}</td>
                    <td style={{ textAlign:'right', fontWeight:600, color: a.total_rev>=0?'#7C3AED':'#DC2626' }}>{fmtRp(a.total_rev)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view === 'type' && (
        <div className="wh-card">
          <div className="wh-card-title"><i className="ti ti-building-store" /> Distribusi Type Loket</div>
          <div className="wh-table-wrap">
            <table className="wh-table">
              <thead>
                <tr>
                  <th>Type Loket</th>
                  <th>Register</th>
                  <th>Aktivasi</th>
                  <th>Act%</th>
                  <th>Outlet Trx</th>
                  <th>Jml Trx</th>
                  <th>Margin</th>
                  <th>Gross Akt</th>
                  <th>Net Akt</th>
                  <th>Total Rev</th>
                  <th>Avg Rev / DL</th>
                </tr>
              </thead>
              <tbody>
                {types.map(t => (
                  <tr key={t.type_loket}>
                    <td style={{ fontWeight:600 }}>{t.type_loket}</td>
                    <td style={{ textAlign:'right' }}>{fmtN(t.reg)}</td>
                    <td style={{ textAlign:'right' }}>{fmtN(t.akt)}</td>
                    <td style={{ fontSize:11 }}>{t.reg>0 ? (t.akt/t.reg*100).toFixed(1)+'%' : '—'}</td>
                    <td style={{ textAlign:'right' }}>{fmtN(t.trx)}</td>
                    <td style={{ textAlign:'right' }}>{fmtN(t.jml_trx)}</td>
                    <td style={{ textAlign:'right', color:'#059669' }}>{fmtRp(t.margin)}</td>
                    <td style={{ textAlign:'right' }}>{fmtRp(t.gross_akt)}</td>
                    <td style={{ textAlign:'right', color: t.net_akt>=0?'#059669':'#DC2626' }}>{fmtRp(t.net_akt)}</td>
                    <td style={{ textAlign:'right', fontWeight:600, color: t.total_rev>=0?'#7C3AED':'#DC2626' }}>{fmtRp(t.total_rev)}</td>
                    <td style={{ textAlign:'right', fontSize:11 }}>{fmtRp(t.avg_rev)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Script Modal ──────────────────────────────────────────────────────────
function ScriptModal({ onClose }) {
  const [copied, setCopied] = useState(false);
  const code = buildScript();

  function copy() {
    navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(()=>setCopied(false), 2500); });
  }

  return (
    <div className="dr-modal-overlay" onClick={onClose}>
      <div className="dr-modal" onClick={e => e.stopPropagation()}>
        <div className="dr-modal-head">
          <div className="dr-modal-title">
            <i className="ti ti-brand-google" />
            Apps Script — Sync Hunter (D.1, D.2, D.3)
          </div>
          <button className="dr-modal-close" onClick={onClose}><i className="ti ti-x" /></button>
        </div>
        <div className="dr-modal-body">
          <div className="dr-script-info">
            <i className="ti ti-info-circle" />
            <div>
              Buka Google Sheets Hunter (<code>1WyYG0obpT0rGYlgsVlq6EO_6m4c5eTDethTEA09PNyU</code>)
              → <strong>Extensions → Apps Script</strong> → paste → Save → Run <code>syncHunterData()</code>.
              <br /><strong>D.1</strong> = data Mei (referensi registrasi, tidak berubah) · <strong>D.2 & D.3</strong> = data bulan berjalan (Juni, dst).
            </div>
          </div>
          <pre className="dr-script-code">{code}</pre>
        </div>
        <div className="dr-modal-foot">
          <button className="dr-btn-copy" onClick={copy}>
            <i className={'ti ' + (copied ? 'ti-check' : 'ti-copy')} />
            {copied ? 'Tersalin!' : 'Salin Kode'}
          </button>
          <button className="dr-btn-close2" onClick={onClose}>Tutup</button>
        </div>
      </div>
    </div>
  );
}
