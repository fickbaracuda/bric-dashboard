import { useState, useEffect, useRef, useMemo } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import {
  getDmControlTowerMonths,
  getDmControlTowerAnalytics,
  getDmControlTowerDataQuality,
  getDmControlTowerOutlets,
} from '../services/api';

const COLOR = '#7F77DD';

/* ─── Format helpers ─── */
const BULAN_LABEL = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
function formatBulan(bulan) {
  if (!bulan) return '-';
  const [y, m] = String(bulan).split('-');
  return `${BULAN_LABEL[Number(m)] || m} ${y}`;
}

const BULAN_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
function fmtDate(v) {
  if (!v) return '-';
  const iso = String(v).slice(0, 10);
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return '-';
  return `${d} ${BULAN_SHORT[Number(m) - 1] || m} ${y}`;
}

function fmtN(v) { return (Number(v) || 0).toLocaleString('id-ID'); }
function fmtRp(v) {
  const n = Number(v) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}Rp ${(abs / 1e9).toFixed(1)}M`;
  if (abs >= 1e6) return `${sign}Rp ${(abs / 1e6).toFixed(1)}jt`;
  if (abs >= 1e3) return `${sign}Rp ${(abs / 1e3).toFixed(0)}rb`;
  return `${sign}Rp ${Math.round(abs)}`;
}
function fmtPct(v) { return `${(Number(v) || 0).toFixed(1)}%`; }

/* ─── Definisi segmen final (lihat docs/DM_CONTROL_TOWER.md) ─── */
const SEGMENT_META = {
  registered_only:      { label: 'Baru Registrasi',           color: '#9CA3AF', priority: 'P2', desc: 'Sudah daftar, belum aktivasi & belum transaksi.', rekomendasi: 'Tunggu sampai window H0-H3 selesai, pantau perkembangan aktivasi.' },
  activated_no_tx:      { label: 'Aktivasi, Belum Transaksi',  color: '#F59E0B', priority: 'P1', desc: 'Sudah aktivasi tapi belum pernah transaksi.', rekomendasi: 'Hubungi outlet, edukasi cara transaksi pertama sebelum lewat H3.' },
  tx1_h0_h3:            { label: 'Transaksi Cepat (H0-H3)',    color: '#3B82F6', priority: 'P3', desc: 'Transaksi pertama terjadi 0-3 hari sejak registrasi.', rekomendasi: 'Dorong repeat transaksi kedua sebelum outlet pasif kembali.' },
  repeat_h0_h3:         { label: 'Repeat Awal (H0-H3)',        color: '#059669', priority: 'P3', desc: 'Minimal 2x transaksi dalam 0-3 hari sejak registrasi.', rekomendasi: 'Pertahankan — jadikan contoh outlet sehat, beri apresiasi/testimoni.' },
  late_tx:              { label: 'Transaksi Telat',            color: '#D97706', priority: 'P2', desc: 'Transaksi pertama terjadi setelah hari ke-3.', rekomendasi: 'Kasus langka — cek data, pastikan bukan salah input tanggal.' },
  handoff_farming:      { label: 'Handoff Farming',            color: '#DC2626', priority: 'P1', desc: 'Sudah lewat H3 tapi belum pernah berhasil transaksi — perlu di-follow-up tim farming.', rekomendasi: 'Lempar ke tim farming untuk follow-up & edukasi ulang segera.' },
  active_after_handoff: { label: 'Sudah Sehat (Telat)',        color: '#7C3AED', priority: 'P3', desc: 'Sempat gagal di H0-H3, tapi akhirnya transaksi juga.', rekomendasi: 'Sudah convert setelah follow-up — pantau agar tetap aktif.' },
  anomaly:              { label: 'Anomali Data',               color: '#B91C1C', priority: 'P0', desc: 'Data bermasalah — transaksi sebelum registrasi/aktivasi atau tanggal tidak konsisten.', rekomendasi: 'Cek data di sheet Register/Aktivasi/Transaksi — kemungkinan salah input.' },
};
function segMeta(seg) {
  return SEGMENT_META[seg] || { label: seg || '-', color: '#9CA3AF', priority: 'P2', desc: '', rekomendasi: '' };
}

const PRIORITY_META = {
  P0: { label: 'Anomali Data',           color: '#B91C1C' },
  P1: { label: 'Butuh Follow-up Segera', color: '#DC2626' },
  P2: { label: 'Perlu Dipantau',         color: '#F59E0B' },
  P3: { label: 'Sudah Sehat',            color: '#059669' },
};

/* ─── Severity & rekomendasi Data Quality — heuristik tampilan frontend saja
   (backend belum mengirim severity/rekomendasi, lihat docs/DM_CONTROL_TOWER.md) ─── */
const DQ_META = {
  trx_before_register: { severity: 'high', label: 'Transaksi Sebelum Registrasi', rekomendasi: 'Cek ulang tanggal input di sheet Register/Transaksi — kemungkinan salah input tanggal.' },
  trx_before_aktivasi: { severity: 'high', label: 'Transaksi Sebelum Aktivasi', rekomendasi: 'Cek ulang tanggal aktivasi outlet — transaksi tidak wajar terjadi sebelum aktivasi.' },
  duplicate_register: { severity: 'medium', label: 'Duplikat Data Registrasi', rekomendasi: 'Cek baris duplikat di sheet Register untuk outlet yang sama.' },
  duplicate_aktivasi: { severity: 'medium', label: 'Duplikat Data Aktivasi', rekomendasi: 'Cek baris duplikat di sheet Aktivasi untuk outlet yang sama.' },
  duplicate_outlet_date_trx: { severity: 'low', label: 'Transaksi Ganda di Tanggal Sama', rekomendasi: 'Wajar kalau outlet memang transaksi lebih dari 1x/hari — cek kalau jumlahnya tidak wajar.' },
  trx_outlet_tidak_ada_di_register: { severity: 'medium', label: 'Transaksi Tanpa Data Registrasi', rekomendasi: 'Outlet ini bertransaksi tapi tidak ada di sheet Register bulan ini — cek kelengkapan data.' },
  trx_outlet_tidak_ada_di_aktivasi: { severity: 'medium', label: 'Transaksi Tanpa Data Aktivasi', rekomendasi: 'Outlet ini bertransaksi tapi tidak ada di sheet Aktivasi bulan ini — cek kelengkapan data.' },
  aktivasi_tanpa_register: { severity: 'medium', label: 'Aktivasi Tanpa Registrasi', rekomendasi: 'Outlet aktivasi tapi tidak ditemukan di sheet Register — cek data Register.' },
  register_tanpa_aktivasi: { severity: 'low', label: 'Registrasi Belum Aktivasi', rekomendasi: 'Wajar untuk outlet baru — follow-up tim aktivasi kalau sudah lama menunggu.' },
  aktivasi_tanpa_transaksi: { severity: 'low', label: 'Aktivasi Belum Transaksi', rekomendasi: 'Lihat tab Segmentasi/Action Queue — kemungkinan termasuk Handoff Farming.' },
  id_outlet_kosong: { severity: 'info', label: 'Baris Tanpa ID Outlet', rekomendasi: 'Baris ini otomatis dilewati saat sync — cek sheet asal kalau jumlahnya banyak.' },
  tanggal_invalid: { severity: 'info', label: 'Tanggal Tidak Terbaca', rekomendasi: 'Format tanggal di sheet mungkin tidak standar — cek kolom tanggal terkait.' },
};
const SEVERITY_META = {
  high:   { label: 'Tinggi', color: '#DC2626' },
  medium: { label: 'Sedang', color: '#F59E0B' },
  low:    { label: 'Rendah', color: '#3B82F6' },
  info:   { label: 'Info',   color: '#9CA3AF' },
};
function dqMeta(type) { return DQ_META[type] || { severity: 'info', label: type, rekomendasi: '' }; }

function waLink(noHp) {
  if (!noHp) return null;
  const digits = String(noHp).replace(/\D/g, '');
  if (!digits) return null;
  const withCountry = digits.startsWith('0') ? '62' + digits.slice(1) : digits;
  return `https://wa.me/${withCountry}`;
}

/* ─── Charts ─── */
function CalendarLineChart({ id, data }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !data?.length) return;
    const labels = data.map(r => fmtDate(r.tanggal));
    const chart = new Chart(ref.current, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Registrasi', data: data.map(r => Number(r.registrasi) || 0), borderColor: '#9CA3AF', backgroundColor: '#9CA3AF33', tension: 0.3 },
          { label: 'Aktivasi', data: data.map(r => Number(r.aktivasi) || 0), borderColor: '#F59E0B', backgroundColor: '#F59E0B33', tension: 0.3 },
          { label: 'Outlet Transaksi', data: data.map(r => Number(r.outlet_transaksi) || 0), borderColor: COLOR, backgroundColor: COLOR + '33', tension: 0.3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 10 } } },
        scales: {
          x: { ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 45 } },
          y: { beginAtZero: true, grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 } } },
        },
      },
    });
    return () => chart.destroy();
  }, [id, data]);
  return <canvas key={id} ref={ref} />;
}

function SegmentBarChart({ id, counts }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !counts?.length) return;
    const sorted = [...counts].sort((a, b) => Number(b.count) - Number(a.count));
    const labels = sorted.map(c => segMeta(c.segment).label);
    const colors = sorted.map(c => segMeta(c.segment).color);
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [{ data: sorted.map(c => Number(c.count) || 0), backgroundColor: colors, borderRadius: 4 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { font: { size: 11 } } },
          y: { ticks: { font: { size: 11 } } },
        },
      },
    });
    return () => chart.destroy();
  }, [id, counts]);
  return <canvas key={id} ref={ref} />;
}

/* ─── UI atoms ─── */
function KPICard({ label, value, sub, alert }) {
  return (
    <div className={'dmct-kpi-card' + (alert ? ' dmct-kpi-card--alert' : '')}>
      <div className="dmct-kpi-label">{label}</div>
      <div className="dmct-kpi-value">{value}</div>
      {sub && <div className="dmct-kpi-sub">{sub}</div>}
    </div>
  );
}
function PriorityBadge({ priority }) {
  const m = PRIORITY_META[priority] || { label: priority, color: '#9CA3AF' };
  return <span className="dmct-priority-badge" style={{ background: m.color }}>{priority} · {m.label}</span>;
}
function SeverityBadge({ severity }) {
  const m = SEVERITY_META[severity] || SEVERITY_META.info;
  return <span className="dmct-severity-badge" style={{ background: m.color }}>{m.label}</span>;
}
function SegmentBadge({ segment }) {
  const m = segMeta(segment);
  return <span className="dmct-priority-badge" style={{ background: m.color }}>{m.label}</span>;
}

const TABS = [
  { key: 'overview', label: 'Overview', icon: 'ti-chart-dots' },
  { key: 'cohort', label: 'Cohort H0-H3', icon: 'ti-calendar-stats' },
  { key: 'segmen', label: 'Segmentasi', icon: 'ti-chart-pie' },
  { key: 'dq', label: 'Data Quality', icon: 'ti-alert-triangle' },
  { key: 'action', label: 'Action Queue', icon: 'ti-clipboard-list' },
  { key: 'outlet', label: 'Outlet Detail', icon: 'ti-building-store' },
];

/* ─── Main ─── */
export default function WarRoomDmControlTower() {
  const [months, setMonths] = useState([]);
  const [bulan, setBulan] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('overview');

  // Data Quality tab (lazy load, punya contoh id_outlet — beda dari
  // analytics.data_quality yang cuma ringkasan count tanpa contoh baris)
  const [dq, setDq] = useState(null);
  const [dqLoading, setDqLoading] = useState(false);
  const [dqError, setDqError] = useState(null);

  // Outlet Detail tab (server-side pagination)
  const [outletState, setOutletState] = useState({ rows: [], total: 0, page: 1, limit: 100 });
  const [outletLoading, setOutletLoading] = useState(false);
  const [outletError, setOutletError] = useState(null);
  const [outletSearch, setOutletSearch] = useState('');
  const [outletSegment, setOutletSegment] = useState('');

  // Action Queue tab (filter di data yang sudah dimuat, tidak perlu request baru)
  const [actionPriorityFilter, setActionPriorityFilter] = useState('');

  /* ── Load daftar bulan sekali di awal ── */
  useEffect(() => {
    getDmControlTowerMonths()
      .then(res => {
        const list = res?.months || [];
        setMonths(list);
        if (list.length) setBulan(list[0].bulan);
        else setLoading(false);
      })
      .catch(e => { setError(e.message || 'Gagal memuat daftar bulan'); setLoading(false); });
  }, []);

  /* ── Load analytics tiap kali bulan berubah ── */
  useEffect(() => {
    if (!bulan) return;
    setLoading(true); setError(null);
    getDmControlTowerAnalytics(bulan)
      .then(setAnalytics)
      .catch(e => setError(e.message || 'Gagal memuat analytics'))
      .finally(() => setLoading(false));
  }, [bulan]);

  /* ── Load data quality (dengan contoh baris) saat tab dq dibuka / bulan berubah ── */
  useEffect(() => {
    if (tab !== 'dq' || !bulan) return;
    setDqLoading(true); setDqError(null);
    getDmControlTowerDataQuality(bulan)
      .then(res => setDq(res))
      .catch(e => setDqError(e.message || 'Gagal memuat data quality'))
      .finally(() => setDqLoading(false));
  }, [tab, bulan]);

  /* ── Load outlet detail (server-side pagination) ── */
  useEffect(() => {
    if (tab !== 'outlet' || !bulan) return;
    setOutletLoading(true); setOutletError(null);
    getDmControlTowerOutlets({ bulan, page: outletState.page, limit: outletState.limit, search: outletSearch, segment: outletSegment })
      .then(res => setOutletState(s => ({ ...s, rows: res.outlets || [], total: res.total || 0 })))
      .catch(e => setOutletError(e.message || 'Gagal memuat outlet'))
      .finally(() => setOutletLoading(false));
  }, [tab, bulan, outletState.page, outletState.limit, outletSearch, outletSegment]);

  const summary = analytics?.summary;
  const meta = analytics?.meta;
  const funnel = analytics?.funnel;
  const dqIssueCount = summary?.data_quality_issues || 0;

  const configBadge = useMemo(() => {
    if (!meta) return null;
    if (meta.config_source === 'config') return { text: 'Berdasarkan data sinkronisasi', cls: 'dmct-badge-config' };
    if (meta.config_source === 'partial') return { text: 'Sebagian dari data sinkronisasi', cls: 'dmct-badge-config' };
    return { text: 'Estimasi (belum ada data config)', cls: 'dmct-badge-fallback' };
  }, [meta]);

  const totalPages = Math.max(1, Math.ceil(outletState.total / outletState.limit));

  function changeOutletSearch(v) { setOutletSearch(v); setOutletState(s => ({ ...s, page: 1 })); }
  function changeOutletSegment(v) { setOutletSegment(v); setOutletState(s => ({ ...s, page: 1 })); }

  function handleExportOutletCsv() {
    const rows = outletState.rows;
    if (!rows.length) return;
    const header = ['id_outlet', 'segment', 'priority', 'tanggal_register', 'tanggal_aktivasi', 'first_tx_date', 'total_trx', 'total_margin'];
    const lines = [header.join(',')];
    rows.forEach(r => {
      lines.push([
        r.id_outlet, segMeta(r.segment).label, r.priority,
        fmtDate(r.tanggal_register), fmtDate(r.tanggal_aktivasi), fmtDate(r.first_tx_date),
        r.total_trx, r.total_margin,
      ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dm-control-tower-outlet-${bulan}-hal${outletState.page}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filteredActionQueue = (analytics?.action_queue || [])
    .filter(r => !actionPriorityFilter || r.priority === actionPriorityFilter);

  return (
    <Layout>
      <div className="dmct-page">

        {/* Header / Hero */}
        <div className="dmct-header">
          <div className="dmct-header-left">
            <i className="ti ti-radar-2" style={{ color: COLOR, fontSize: 24 }} />
            <div>
              <div className="dmct-header-title">DM Control Tower</div>
              <div className="dmct-header-sub">Monitoring funnel registrasi, aktivasi, transaksi H0-H3, dan handoff farming per bulan</div>
            </div>
          </div>
          <div className="dmct-header-right">
            {months.length > 0 && (
              <select className="dmct-select" value={bulan || ''} onChange={e => setBulan(e.target.value)}>
                {months.map(m => <option key={m.bulan} value={m.bulan}>{formatBulan(m.bulan)}</option>)}
              </select>
            )}
            {meta?.last_sync && (
              <span className="dmct-badge dmct-badge-sync">
                <i className="ti ti-refresh" /> Sync terakhir: {new Date(meta.last_sync).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            {analytics && (
              <span className={'dmct-badge ' + (dqIssueCount > 0 ? 'dmct-badge-dq-bad' : 'dmct-badge-dq-ok')}>
                <i className={dqIssueCount > 0 ? 'ti ti-alert-triangle' : 'ti ti-circle-check'} />
                {dqIssueCount > 0 ? `${fmtN(dqIssueCount)} isu data quality` : 'Data quality bersih'}
              </span>
            )}
          </div>
        </div>

        {/* States */}
        {loading && (
          <div className="dmct-loading"><i className="ti ti-loader-2 dmct-spin" /> Memuat data...</div>
        )}
        {!loading && error && (
          <div className="dmct-error"><i className="ti ti-alert-circle" /> {error}</div>
        )}
        {!loading && !error && months.length === 0 && (
          <div className="dmct-empty">
            <i className="ti ti-radar-2" />
            <div>Belum ada data DM Control Tower. Jalankan sync dari Google Sheet terlebih dahulu.</div>
          </div>
        )}

        {!loading && !error && months.length > 0 && analytics && (<>

          {meta && (
            <div className="dmct-mature-note">
              <i className="ti ti-info-circle" />
              <div>
                Cohort mature dihitung sampai tanggal yang sudah punya window H0-H3 lengkap: <strong>{fmtDate(meta.mature_cohort_end)}</strong>.
                {configBadge && <span className={'dmct-badge ' + configBadge.cls} style={{ marginLeft: 8 }}>{configBadge.text}</span>}
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="dmct-tabs">
            {TABS.map(t => (
              <button key={t.key} className={'dmct-tab' + (tab === t.key ? ' dmct-tab--active' : '')} onClick={() => setTab(t.key)}>
                <i className={'ti ' + t.icon} />
                {t.label}
                {t.key === 'dq' && dqIssueCount > 0 && <span className="dmct-tab-badge dmct-tab-badge--alert">{fmtN(dqIssueCount)}</span>}
              </button>
            ))}
          </div>

          {/* ── TAB: Overview ── */}
          {tab === 'overview' && (
            <>
              <div className="dmct-kpi-grid">
                <KPICard label="Registrasi" value={fmtN(summary.total_registrasi)} sub={`Aktivasi: ${fmtN(summary.total_aktivasi)}`} />
                <KPICard label="Activation Rate" value={fmtPct(summary.activation_rate)} sub="Aktivasi / Registrasi" />
                <KPICard label="Tx1 H0-H3" value={fmtN(summary.reg_to_tx1_h0_h3)} sub={`${fmtPct(summary.reg_to_tx1_h0_h3_rate)} dari cohort matang`} />
                <KPICard label="Early Repeat Rate" value={fmtPct(summary.early_repeat_rate)} sub={`${fmtN(summary.early_repeat_count)} outlet repeat H0-H3`} />
                <KPICard
                  label="Handoff Farming"
                  value={fmtN(summary.handoff_farming)}
                  sub={`${fmtPct(summary.handoff_rate)} dari cohort matang`}
                  alert={summary.handoff_farming > 0}
                />
                <KPICard label="Margin H0-H3" value={fmtRp((analytics.cohort_daily || []).reduce((s, c) => s + Number(c.margin_h3 || 0), 0))} sub="Total margin transaksi H0-H3" />
                <KPICard label="Total Margin Bulan Ini" value={fmtRp(summary.total_margin)} sub={`${fmtN(summary.total_transaksi)} transaksi`} />
                <KPICard label="Data Quality Issue" value={fmtN(dqIssueCount)} sub="Lihat tab Data Quality" alert={dqIssueCount > 0} />
              </div>

              {/* Funnel */}
              <div className="dmct-funnel">
                <div className="dmct-funnel-step">
                  <div className="dmct-funnel-step-label">Registrasi</div>
                  <div className="dmct-funnel-step-value">{fmtN(funnel.registrasi)}</div>
                </div>
                <div className="dmct-funnel-arrow"><i className="ti ti-arrow-narrow-right" /></div>
                <div className="dmct-funnel-step">
                  <div className="dmct-funnel-step-label">Aktivasi</div>
                  <div className="dmct-funnel-step-value">{fmtN(funnel.aktivasi)}</div>
                  <div className="dmct-funnel-step-pct">{fmtPct(summary.activation_rate)} dari registrasi</div>
                </div>
                <div className="dmct-funnel-arrow"><i className="ti ti-arrow-narrow-right" /></div>
                <div className="dmct-funnel-step">
                  <div className="dmct-funnel-step-label">Tx1 H0-H3</div>
                  <div className="dmct-funnel-step-value">{fmtN(funnel.tx1_h0_h3)}</div>
                  <div className="dmct-funnel-step-pct">{fmtPct(summary.reg_to_tx1_h0_h3_rate)} dari cohort matang</div>
                </div>
                <div className="dmct-funnel-arrow"><i className="ti ti-arrow-narrow-right" /></div>
                <div className="dmct-funnel-step">
                  <div className="dmct-funnel-step-label">Repeat H0-H3</div>
                  <div className="dmct-funnel-step-value">{fmtN(funnel.repeat_h0_h3)}</div>
                </div>
                <div className="dmct-funnel-arrow"><i className="ti ti-arrow-narrow-right" /></div>
                <div className="dmct-funnel-step dmct-funnel-step--danger">
                  <div className="dmct-funnel-step-label">Handoff Farming</div>
                  <div className="dmct-funnel-step-value">{fmtN(summary.handoff_farming)}</div>
                  <div className="dmct-funnel-step-pct">Perlu follow-up tim farming</div>
                </div>
              </div>

              {/* Calendar daily chart */}
              <div className="dmct-chart-card">
                <div className="dmct-chart-title"><i className="ti ti-chart-line" style={{ color: COLOR }} /> Aktivitas Harian</div>
                <div className="dmct-chart-box">
                  {(analytics.calendar_daily || []).length
                    ? <CalendarLineChart id={`cal-${bulan}`} data={analytics.calendar_daily} />
                    : <div className="dmct-table-empty">Belum ada data harian untuk bulan ini</div>}
                </div>
              </div>
            </>
          )}

          {/* ── TAB: Cohort H0-H3 ── */}
          {tab === 'cohort' && (
            <div className="dmct-chart-card">
              <div className="dmct-chart-title"><i className="ti ti-calendar-stats" style={{ color: COLOR }} /> Cohort Registrasi Harian (H0-H3)</div>
              <div className="dmct-table-wrap">
                <table className="dmct-table">
                  <thead>
                    <tr>
                      <th>Tgl Registrasi</th><th>Registrasi</th><th>Aktivasi ≤H3</th>
                      <th>Tx1 ≤H3</th><th>Repeat ≤H3</th><th>Margin H0-H3</th><th>Conversion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(analytics.cohort_daily || []).length === 0 && (
                      <tr><td colSpan={7} className="dmct-table-empty">Belum ada data cohort untuk bulan ini</td></tr>
                    )}
                    {[...(analytics.cohort_daily || [])].reverse().map(row => {
                      const conv = row.total_registrasi ? (Number(row.tx1_h3) / Number(row.total_registrasi) * 100) : 0;
                      return (
                        <tr key={String(row.cohort_date)}>
                          <td>{fmtDate(row.cohort_date)}</td>
                          <td>{fmtN(row.total_registrasi)}</td>
                          <td>{fmtN(row.aktivasi_h3)}</td>
                          <td>{fmtN(row.tx1_h3)}</td>
                          <td>{fmtN(row.repeat_h3)}</td>
                          <td>{fmtRp(row.margin_h3)}</td>
                          <td style={{ fontWeight: 700, color: conv >= 30 ? '#059669' : conv >= 10 ? '#F59E0B' : '#DC2626' }}>{conv.toFixed(1)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── TAB: Segmentasi ── */}
          {tab === 'segmen' && (
            <>
              <div className="dmct-segment-grid">
                {(analytics.segment_counts || []).map(s => {
                  const m = segMeta(s.segment);
                  return (
                    <div key={s.segment} className="dmct-segment-card" style={{ '--seg-color': m.color }}>
                      <div className="dmct-segment-card-count">{fmtN(s.count)}</div>
                      <div className="dmct-segment-card-label">{m.label}</div>
                      <div className="dmct-segment-card-desc">{m.desc}</div>
                    </div>
                  );
                })}
              </div>
              <div className="dmct-chart-card">
                <div className="dmct-chart-title"><i className="ti ti-chart-bar" style={{ color: COLOR }} /> Jumlah Outlet per Segmen</div>
                <div className="dmct-chart-box" style={{ height: Math.max(240, (analytics.segment_counts || []).length * 36) }}>
                  {(analytics.segment_counts || []).length
                    ? <SegmentBarChart id={`seg-${bulan}`} counts={analytics.segment_counts} />
                    : <div className="dmct-table-empty">Belum ada data segmentasi</div>}
                </div>
              </div>
            </>
          )}

          {/* ── TAB: Data Quality ── */}
          {tab === 'dq' && (
            <>
              {dqLoading && <div className="dmct-loading"><i className="ti ti-loader-2 dmct-spin" /> Memuat data quality...</div>}
              {!dqLoading && dqError && <div className="dmct-error"><i className="ti ti-alert-circle" /> {dqError}</div>}
              {!dqLoading && !dqError && dq && (
                <div className="dmct-dq-list">
                  {dq.checks.filter(c => c.count > 0).length === 0 && (
                    <div className="dmct-table-empty">Tidak ada isu data quality untuk bulan ini</div>
                  )}
                  {dq.checks.filter(c => c.count > 0).map(c => {
                    const m = dqMeta(c.check_type);
                    const sevColor = (SEVERITY_META[m.severity] || SEVERITY_META.info).color;
                    return (
                      <div key={c.check_type} className="dmct-dq-item" style={{ '--dq-color': sevColor }}>
                        <div className="dmct-dq-top">
                          <div className="dmct-dq-title">{m.label}</div>
                          <SeverityBadge severity={m.severity} />
                          <div className="dmct-dq-count">{fmtN(c.count)}</div>
                        </div>
                        <div className="dmct-dq-desc">{c.description}</div>
                        {m.rekomendasi && <div className="dmct-dq-rekomendasi"><i className="ti ti-bulb" /> {m.rekomendasi}</div>}
                        {(c.examples || []).length > 0 && (
                          <div className="dmct-dq-examples">
                            Contoh outlet:{' '}
                            {c.examples.slice(0, 15).map((ex, i) => (
                              <span key={i} className="dmct-dq-example-chip">{ex.id_outlet || '-'}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* ── TAB: Action Queue ── */}
          {tab === 'action' && (
            <>
              <div className="dmct-filter-bar">
                <select className="dmct-select" value={actionPriorityFilter} onChange={e => setActionPriorityFilter(e.target.value)}>
                  <option value="">Semua Prioritas</option>
                  {Object.keys(PRIORITY_META).map(p => <option key={p} value={p}>{p} — {PRIORITY_META[p].label}</option>)}
                </select>
                <span className="dmct-filter-count">
                  Menampilkan top {fmtN((analytics.action_queue || []).length)} outlet prioritas (maks 300), {fmtN(filteredActionQueue.length)} sesuai filter
                </span>
              </div>
              <div className="dmct-table-wrap">
                <table className="dmct-table">
                  <thead>
                    <tr>
                      <th>Priority</th><th>ID Outlet</th><th>Segmen</th><th>Alasan</th><th>Rekomendasi</th>
                      <th>Tgl Register</th><th>Total Trx</th><th>Total Margin</th><th>WhatsApp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredActionQueue.length === 0 && (
                      <tr><td colSpan={9} className="dmct-table-empty">Tidak ada outlet di prioritas ini</td></tr>
                    )}
                    {filteredActionQueue.map(row => {
                      const m = segMeta(row.segment);
                      const wa = waLink(row.no_hp);
                      return (
                        <tr key={row.id_outlet} className={row.priority === 'P0' ? 'dmct-row--p0' : row.priority === 'P1' ? 'dmct-row--p1' : undefined}>
                          <td><PriorityBadge priority={row.priority} /></td>
                          <td style={{ fontFamily: 'SF Mono, monospace' }}>{row.id_outlet}</td>
                          <td><SegmentBadge segment={row.segment} /></td>
                          <td style={{ whiteSpace: 'normal', minWidth: 200 }}>{m.desc}</td>
                          <td style={{ whiteSpace: 'normal', minWidth: 200 }}>{m.rekomendasi}</td>
                          <td>{fmtDate(row.tanggal_register)}</td>
                          <td>{fmtN(row.total_trx)}</td>
                          <td>{fmtRp(row.total_margin)}</td>
                          <td>
                            {wa
                              ? <a className="dmct-wa-link" href={wa} target="_blank" rel="noreferrer"><i className="ti ti-brand-whatsapp" /> Chat</a>
                              : <span className="dmct-na">no. HP belum tersedia</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* ── TAB: Outlet Detail ── */}
          {tab === 'outlet' && (
            <>
              <div className="dmct-filter-bar">
                <div className="dmct-search-wrap">
                  <i className="ti ti-search" />
                  <input
                    className="dmct-search" placeholder="Cari ID Outlet..."
                    value={outletSearch} onChange={e => changeOutletSearch(e.target.value)}
                  />
                </div>
                <select className="dmct-select" value={outletSegment} onChange={e => changeOutletSegment(e.target.value)}>
                  <option value="">Semua Segmen</option>
                  {Object.entries(SEGMENT_META).map(([key, m]) => <option key={key} value={key}>{m.label}</option>)}
                </select>
                <button className="dmct-export-btn" onClick={handleExportOutletCsv} disabled={!outletState.rows.length}>
                  <i className="ti ti-download" /> Export Halaman Ini (CSV)
                </button>
                <span className="dmct-filter-count">Total: {fmtN(outletState.total)} outlet</span>
              </div>

              {outletLoading && <div className="dmct-loading"><i className="ti ti-loader-2 dmct-spin" /> Memuat outlet...</div>}
              {!outletLoading && outletError && <div className="dmct-error"><i className="ti ti-alert-circle" /> {outletError}</div>}

              {!outletLoading && !outletError && (
                <>
                  <div className="dmct-table-wrap">
                    <table className="dmct-table">
                      <thead>
                        <tr>
                          <th>ID Outlet</th><th>Segmen</th><th>Priority</th>
                          <th>Tgl Register</th><th>Tgl Aktivasi</th><th>Tgl Transaksi Pertama</th>
                          <th>Total Trx</th><th>Total Margin</th>
                        </tr>
                      </thead>
                      <tbody>
                        {outletState.rows.length === 0 && (
                          <tr><td colSpan={8} className="dmct-table-empty">Tidak ada outlet yang cocok dengan filter</td></tr>
                        )}
                        {outletState.rows.map(row => (
                          <tr key={row.id_outlet}>
                            <td style={{ fontFamily: 'SF Mono, monospace' }}>{row.id_outlet}</td>
                            <td><SegmentBadge segment={row.segment} /></td>
                            <td><PriorityBadge priority={row.priority} /></td>
                            <td>{fmtDate(row.tanggal_register)}</td>
                            <td>{fmtDate(row.tanggal_aktivasi)}</td>
                            <td>{fmtDate(row.first_tx_date)}</td>
                            <td>{fmtN(row.total_trx)}</td>
                            <td>{fmtRp(row.total_margin)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="dmct-pagination">
                    <button className="dmct-page-btn" disabled={outletState.page <= 1}
                      onClick={() => setOutletState(s => ({ ...s, page: 1 }))}>«</button>
                    <button className="dmct-page-btn" disabled={outletState.page <= 1}
                      onClick={() => setOutletState(s => ({ ...s, page: s.page - 1 }))}>‹ Prev</button>
                    <span className="dmct-page-info">Halaman {outletState.page} dari {totalPages}</span>
                    <button className="dmct-page-btn" disabled={outletState.page >= totalPages}
                      onClick={() => setOutletState(s => ({ ...s, page: s.page + 1 }))}>Next ›</button>
                    <button className="dmct-page-btn" disabled={outletState.page >= totalPages}
                      onClick={() => setOutletState(s => ({ ...s, page: totalPages }))}>»</button>
                  </div>
                </>
              )}
            </>
          )}

        </>)}
      </div>
    </Layout>
  );
}
