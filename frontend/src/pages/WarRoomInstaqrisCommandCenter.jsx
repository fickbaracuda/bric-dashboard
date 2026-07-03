import { useState, useEffect, useRef } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import {
  getInstaqrisCommandCenterMonths,
  getInstaqrisCommandCenterAnalytics,
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
function fmtDateTime(v) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return `${String(d.getDate()).padStart(2, '0')} ${BULAN_SHORT[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtN(v) {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) return '-';
  return n.toLocaleString('id-ID');
}
function fmtRp(v) {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}Rp ${(abs / 1e9).toFixed(1)}M`;
  if (abs >= 1e6) return `${sign}Rp ${(abs / 1e6).toFixed(1)}jt`;
  if (abs >= 1e3) return `${sign}Rp ${(abs / 1e3).toFixed(0)}rb`;
  return `${sign}Rp ${Math.round(abs)}`;
}
function fmtPct(v, digits = 1) {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) return '-';
  return `${n.toFixed(digits)}%`;
}

/* ─── Metadata presentasi (frontend-only — backend hanya mengirim angka/kode) ─── */
const HEALTH_META = {
  healthy:  { label: 'Sehat',            color: '#059669', bg: '#DCFCE7' },
  warning:  { label: 'Perlu Perhatian',  color: '#92400E', bg: '#FEF3C7' },
  critical: { label: 'Kritis',           color: '#991B1B', bg: '#FEE2E2' },
};
function healthMeta(status) { return HEALTH_META[status] || { label: status || '-', color: '#374151', bg: '#F3F4F6' }; }

const INSIGHT_SEVERITY_META = {
  high:   { label: 'Tinggi', color: '#DC2626', bg: '#FEE2E2' },
  medium: { label: 'Sedang', color: '#B45309', bg: '#FEF3C7' },
  low:    { label: 'Rendah', color: '#1D4ED8', bg: '#DBEAFE' },
};
function insightSeverityMeta(sev) { return INSIGHT_SEVERITY_META[sev] || INSIGHT_SEVERITY_META.low; }

/* area -> judul bisnis + rekomendasi generik (backend hanya kirim area/title/detail) */
const INSIGHT_AREA_META = {
  penerbitan_qris:     { icon: 'ti-file-certificate',      title: 'Bottleneck Penerbitan QRIS',              recommendation: 'Percepat verifikasi & submit PTEN — cek outlet yang menumpuk di status Belum Terbit/Perbaikan Data.' },
  aktivasi_transaksi:  { icon: 'ti-bolt',                   title: 'Bottleneck Aktivasi Transaksi Pertama',    recommendation: 'Follow up outlet yang QRIS-nya sudah terbit tapi belum pernah transaksi — edukasi cara pakai QRIS.' },
  retensi:             { icon: 'ti-user-x',                 title: 'Risiko Retention',                        recommendation: 'Hubungi outlet yang transaksinya turun/berhenti dibanding bulan lalu untuk reaktivasi.' },
  kualitas_data:       { icon: 'ti-database-exclamation',   title: 'Kualitas Data Perlu Dicek',                recommendation: 'Lihat panel Kualitas Data di bawah untuk detail masalah per kategori.' },
  kualitas_transaksi:  { icon: 'ti-report-money',           title: 'Margin Quality Perlu Dicek',               recommendation: 'Transaksi naik tapi revenue turun — cek apakah nilai per transaksi mengecil.' },
};
function insightMeta(area) { return INSIGHT_AREA_META[area] || { icon: 'ti-alert-triangle', title: area || 'Insight', recommendation: '' }; }

const ACTION_PRIORITY_META = {
  P0: { label: 'Cek Data Quality',         color: '#B91C1C' },
  P1: { label: 'Dorong Aktivasi / Tx1',     color: '#DC2626' },
  P2: { label: 'Bereskan Penerbitan QRIS',  color: '#F59E0B' },
  P3: { label: 'Retention',                 color: '#3B82F6' },
  P4: { label: 'Growth / Reward',           color: '#059669' },
};
function actionPriorityMeta(p) { return ACTION_PRIORITY_META[p] || { label: p || '-', color: '#9CA3AF' }; }

const ACTION_TYPE_LABEL = {
  outlet_tanpa_id: 'Outlet Tanpa ID',
  trx_tanpa_id: 'Transaksi Tanpa ID',
  trx_tidak_match_outlet: 'Transaksi Tidak Match Katalog Outlet',
  qris_tanpa_id: 'Status QRIS Tanpa ID',
  qris_status_unknown: 'Status QRIS Tidak Diketahui',
  qris_terbit_tanpa_transaksi: 'QRIS Terbit, Belum Transaksi',
  qris_belum_terbit: 'QRIS Belum Terbit',
  qris_perbaikan_data: 'QRIS Perlu Perbaikan Data',
  qris_rejected: 'QRIS Ditolak',
  churn_dari_bulan_lalu: 'Churn dari Bulan Lalu',
  top_performer_p90_revenue: 'Top Performer (P90 Revenue)',
};
function actionTypeLabel(t) { return ACTION_TYPE_LABEL[t] || (t ? t.replace(/_/g, ' ') : '-'); }

/* check -> label + catatan (khusus trx_tidak_match_outlet: jangan tampil sebagai error fatal) */
const DQ_META = {
  outlet_tanpa_id:         { label: 'Outlet Tanpa ID',                    note: 'Baris outlet tanpa ID yang bisa dikenali — cek header kolom ID Outlet di sheet sumber.' },
  trx_tanpa_id:            { label: 'Transaksi Tanpa ID',                 note: 'Transaksi tanpa ID outlet tidak bisa dihubungkan ke merchant manapun.' },
  qris_tanpa_id:           { label: 'Status QRIS Tanpa ID',               note: 'Baris status QRIS tanpa ID outlet — cek sheet KYCKYM/PTEN.' },
  trx_tidak_match_outlet:  {
    label: 'Transaksi Tidak Match dengan Katalog Outlet Bulan Ini',
    note: 'Ini bisa terjadi karena cakupan tabel transaksi lebih luas daripada katalog outlet pada bulan tersebut. Perlu dicek sumber data, bukan berarti transaksi salah.',
  },
  qris_status_unknown:     { label: 'Status QRIS Kosong / Tidak Terbaca', note: 'Kolom status QRIS kosong pada baris ini — cek sheet sumber.' },
  duplicate_outlet_id:     { label: 'ID Outlet Duplikat',                 note: 'ID outlet yang sama muncul lebih dari 1x di katalog outlet bulan ini.' },
  month_data_missing:      { label: 'Data Bulan Tidak Lengkap',           note: 'Salah satu sumber (outlet/QRIS/transaksi) tidak punya data sama sekali untuk bulan ini.' },
};
function dqMeta(check) { return DQ_META[check] || { label: check ? check.replace(/_/g, ' ') : '-', note: '' }; }

const DQ_SEVERITY_META = {
  critical: { label: 'Tinggi', color: '#DC2626' },
  warning:  { label: 'Sedang', color: '#B45309' },
  ok:       { label: 'Aman',   color: '#059669' },
};
function dqSeverityMeta(sev) { return DQ_SEVERITY_META[sev] || DQ_SEVERITY_META.ok; }

const FUNNEL_STEP_LABEL = {
  outlet_registered: 'Merchant Terdaftar',
  qris_terbit: 'QRIS Terbit',
  active_trx: 'Outlet Transaksi',
};

const QRIS_STATUS_COLOR = {
  terbit: '#059669',
  belum_terbit: '#F59E0B',
  perbaikan_data: '#D97706',
  rejected: '#991B1B',
  lainnya: '#9CA3AF',
};

/* ─── UI atoms ─── */
function KPICard({ label, value, sub, alert, growth }) {
  return (
    <div className={'iqcc-kpi-card' + (alert ? ' iqcc-kpi-card--alert' : '')}>
      <div className="iqcc-kpi-label">{label}</div>
      <div className="iqcc-kpi-value">{value}</div>
      {(sub || growth !== undefined) && (
        <div className="iqcc-kpi-sub-row">
          {sub && <span className="iqcc-kpi-sub">{sub}</span>}
          {growth !== undefined && <GrowthTag value={growth} compact />}
        </div>
      )}
    </div>
  );
}

function GrowthTag({ value, compact }) {
  const n = Number(value);
  if (value === null || value === undefined || Number.isNaN(n)) {
    return compact
      ? <span className="iqcc-growth iqcc-growth--neutral">belum ada pembanding</span>
      : <span className="iqcc-growth iqcc-growth--neutral">Belum ada pembanding bulan sebelumnya</span>;
  }
  const up = n > 0;
  const flat = n === 0;
  return (
    <span className={'iqcc-growth ' + (flat ? 'iqcc-growth--flat' : up ? 'iqcc-growth--up' : 'iqcc-growth--down')}>
      <i className={'ti ' + (flat ? 'ti-minus' : up ? 'ti-trending-up' : 'ti-trending-down')} />
      {Math.abs(n).toFixed(1)}%
    </span>
  );
}

function TopListCard({ title, icon, items }) {
  const list = Array.isArray(items) ? items.slice(0, 10) : [];
  const max = list.length ? Math.max(...list.map(i => Number(i.count) || 0)) : 0;
  return (
    <div className="iqcc-panel">
      <div className="iqcc-panel-title"><i className={'ti ' + icon} style={{ color: COLOR }} /> {title}</div>
      {list.length === 0 && <div className="iqcc-empty-sub">Belum ada data</div>}
      <div className="iqcc-toplist">
        {list.map((item, i) => (
          <div key={item.label + i} className="iqcc-toplist-row">
            <div className="iqcc-toplist-label" title={item.label}>{item.label}</div>
            <div className="iqcc-toplist-bar-wrap">
              <div className="iqcc-toplist-bar" style={{ width: max ? `${(Number(item.count) / max) * 100}%` : '0%' }} />
            </div>
            <div className="iqcc-toplist-count">{fmtN(item.count)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function QrisStatusDonut({ id, buckets }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = new Chart(ref.current, {
      type: 'doughnut',
      data: {
        labels: ['Terbit', 'Belum Terbit', 'Perbaikan Data', 'Rejected', 'Unknown / Lainnya'],
        datasets: [{
          data: buckets,
          backgroundColor: [
            QRIS_STATUS_COLOR.terbit, QRIS_STATUS_COLOR.belum_terbit,
            QRIS_STATUS_COLOR.perbaikan_data, QRIS_STATUS_COLOR.rejected, QRIS_STATUS_COLOR.lainnya,
          ],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: { legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12, padding: 10 } } },
      },
    });
    return () => chart.destroy();
  }, [id, JSON.stringify(buckets)]);
  return <canvas key={id} ref={ref} />;
}

/* ─── Main ─── */
export default function WarRoomInstaqrisCommandCenter() {
  const [months, setMonths] = useState([]);
  const [bulan, setBulan] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [monthsLoaded, setMonthsLoaded] = useState(false);

  useEffect(() => {
    getInstaqrisCommandCenterMonths()
      .then(res => {
        const list = Array.isArray(res?.months) ? res.months : [];
        setMonths(list);
        setMonthsLoaded(true);
        if (list.length) setBulan(list[0]);
        else setLoading(false);
      })
      .catch(e => { setError(e.message || 'Gagal memuat daftar bulan'); setMonthsLoaded(true); setLoading(false); });
  }, []);

  useEffect(() => {
    if (!bulan) return;
    setLoading(true); setError(null);
    getInstaqrisCommandCenterAnalytics(bulan)
      .then(setAnalytics)
      .catch(e => setError(e.message || 'Gagal memuat analytics'))
      .finally(() => setLoading(false));
  }, [bulan]);

  const isEmpty = monthsLoaded && !error && (months.length === 0 || analytics?.empty === true);

  const meta = analytics?.meta;
  const health = analytics?.health;
  const kpi = analytics?.kpi;
  const outlet = kpi?.outlet;
  const qris = kpi?.qris_status;
  const trx = kpi?.transaksi;
  const growth = kpi?.growth;
  const funnel = analytics?.funnel;
  const insights = Array.isArray(analytics?.insights) ? analytics.insights.slice(0, 5) : [];
  const actionSummary = Array.isArray(analytics?.action_summary) ? analytics.action_summary : [];
  const dqChecks = Array.isArray(analytics?.data_quality?.checks) ? analytics.data_quality.checks : [];

  const lastSyncTimes = meta?.data_sources
    ? Object.values(meta.data_sources).map(s => s?.last_synced).filter(Boolean).sort().reverse()
    : [];
  const lastSync = lastSyncTimes[0] || null;

  const qrisBuckets = qris
    ? [
        Number(qris.qris_terbit) || 0,
        Number(qris.qris_belum_terbit) || 0,
        Number(qris.qris_perbaikan_data) || 0,
        Number(qris.qris_rejected) || 0,
        (Number(qris.qris_status_lain) || 0) + (Number(qris.qris_unknown) || 0),
      ]
    : [0, 0, 0, 0, 0];
  const hasQrisData = qrisBuckets.some(v => v > 0);

  const hMeta = healthMeta(health?.status);

  return (
    <Layout>
      <div className="iqcc-page">

        {/* Header / Hero */}
        <div className="iqcc-header">
          <div className="iqcc-header-left">
            <i className="ti ti-radar-2" style={{ color: COLOR, fontSize: 24 }} />
            <div>
              <div className="iqcc-header-title">InstaQRIS Command Center</div>
              <div className="iqcc-header-sub">Pusat monitoring kesehatan merchant, penerbitan QRIS, transaksi, revenue, bottleneck, dan prioritas aksi InstaQRIS.</div>
            </div>
          </div>
          <div className="iqcc-header-right">
            {months.length > 0 && (
              <select className="iqcc-select" value={bulan || ''} onChange={e => setBulan(e.target.value)}>
                {months.map(m => <option key={m} value={m}>{formatBulan(m)}</option>)}
              </select>
            )}
            {lastSync && (
              <span className="iqcc-badge iqcc-badge-sync">
                <i className="ti ti-refresh" /> Sync terakhir: {fmtDateTime(lastSync)}
              </span>
            )}
            {health?.status && (
              <span className="iqcc-health-badge" style={{ color: hMeta.color, background: hMeta.bg }}>
                <i className="ti ti-heartbeat" /> {hMeta.label}
              </span>
            )}
          </div>
        </div>

        {/* States */}
        {loading && (
          <div className="iqcc-loading"><i className="ti ti-loader-2 iqcc-spin" /> Memuat data...</div>
        )}
        {!loading && error && (
          <div className="iqcc-error"><i className="ti ti-alert-circle" /> {error}</div>
        )}
        {!loading && !error && isEmpty && (
          <div className="iqcc-empty">
            <i className="ti ti-radar-2" />
            <div>Belum ada data InstaQRIS Command Center. Jalankan sync Data Raw InstaQRIS terlebih dahulu.</div>
          </div>
        )}
        {!loading && !error && !isEmpty && months.length > 0 && bulan && !months.includes(bulan) && (
          <div className="iqcc-empty"><i className="ti ti-calendar-off" /><div>Bulan belum tersedia di Data Raw.</div></div>
        )}

        {!loading && !error && !isEmpty && analytics && (<>

          {/* Health reasons */}
          {Array.isArray(health?.reasons) && health.reasons.length > 0 && (
            <div className="iqcc-health-note" style={{ '--hn-color': hMeta.color }}>
              <i className="ti ti-info-circle" />
              <div>{health.reasons.join(' ')}</div>
            </div>
          )}

          {/* KPI Cards */}
          <div className="iqcc-kpi-grid">
            <KPICard label="Merchant Terdaftar" value={fmtN(outlet?.total_outlet)} sub={outlet?.outlet_tanpa_id > 0 ? `${fmtN(outlet.outlet_tanpa_id)} tanpa ID` : undefined} />
            <KPICard label="QRIS Terbit" value={fmtN(qris?.qris_terbit)} sub={`dari ${fmtN(outlet?.total_outlet)} merchant`} />
            <KPICard label="QRIS Terbit Rate" value={fmtPct(qris?.qris_terbit_rate)} growth={qris?.qris_terbit_growth} />
            <KPICard label="Outlet Transaksi" value={fmtN(trx?.active_outlet_trx)} sub={trx?.outlet_tanpa_trx > 0 ? `${fmtN(trx.outlet_tanpa_trx)} belum transaksi` : undefined} />
            <KPICard label="Active Rate" value={fmtPct(trx?.active_rate)} sub="Outlet transaksi / merchant terdaftar" />
            <KPICard label="Total Transaksi" value={fmtN(trx?.total_trx)} sub={`Rata-rata ${fmtN(trx?.avg_trx_per_active_outlet)} / outlet aktif`} />
            <KPICard label="Revenue / MDR" value={fmtRp(trx?.total_revenue)} sub={`Margin: ${fmtRp(trx?.total_margin)}`} />
            <KPICard label="Avg Revenue / Trx" value={fmtRp(trx?.avg_revenue_per_trx)} />
            <KPICard
              label="Kualitas Data"
              value={fmtN(analytics?.data_quality?.total_issue_count)}
              sub={`${fmtPct(analytics?.data_quality?.issue_rate_pct)} dari total record`}
              alert={(analytics?.data_quality?.total_issue_count || 0) > 0}
            />
          </div>

          {/* Growth Summary */}
          <div className="iqcc-panel">
            <div className="iqcc-panel-title"><i className="ti ti-chart-line" style={{ color: COLOR }} /> Growth vs Bulan Sebelumnya {growth?.bulan_pembanding ? `(${formatBulan(growth.bulan_pembanding)})` : ''}</div>
            {!growth && <div className="iqcc-empty-sub">Belum ada pembanding bulan sebelumnya</div>}
            {growth && (
              <div className="iqcc-growth-grid">
                <div className="iqcc-growth-item"><div className="iqcc-growth-item-label">Transaksi</div><GrowthTag value={growth.trx_growth_pct} /></div>
                <div className="iqcc-growth-item"><div className="iqcc-growth-item-label">Revenue</div><GrowthTag value={growth.revenue_growth_pct} /></div>
                <div className="iqcc-growth-item"><div className="iqcc-growth-item-label">Outlet Aktif</div><GrowthTag value={growth.active_outlet_growth_pct} /></div>
                <div className="iqcc-growth-item"><div className="iqcc-growth-item-label">QRIS Terbit</div><GrowthTag value={qris?.qris_terbit_growth} /></div>
              </div>
            )}
          </div>

          {/* Funnel Ringkas */}
          <div className="iqcc-panel">
            <div className="iqcc-panel-title"><i className="ti ti-filter" style={{ color: COLOR }} /> Funnel Ringkas</div>
            <div className="iqcc-funnel">
              {(funnel?.steps || []).map((s, i) => (
                <div key={s.step || i} style={{ display: 'contents' }}>
                  {i > 0 && <div className="iqcc-funnel-arrow"><i className="ti ti-arrow-narrow-right" /></div>}
                  <div className="iqcc-funnel-step">
                    <div className="iqcc-funnel-step-label">{FUNNEL_STEP_LABEL[s.step] || s.step}</div>
                    <div className="iqcc-funnel-step-value">{fmtN(s.count)}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="iqcc-funnel-rates">
              <div><i className="ti ti-corner-down-right" /> Dari merchant terdaftar ke QRIS terbit: <strong>{fmtPct(funnel?.rates?.registered_to_terbit_pct)}</strong></div>
              <div><i className="ti ti-corner-down-right" /> Dari QRIS terbit ke outlet transaksi: <strong>{fmtPct(funnel?.rates?.terbit_to_active_pct)}</strong></div>
            </div>
          </div>

          {/* QRIS Status Breakdown */}
          <div className="iqcc-panel">
            <div className="iqcc-panel-title"><i className="ti ti-chart-donut" style={{ color: COLOR }} /> Status Penerbitan QRIS</div>
            <div className="iqcc-qris-layout">
              <div className="iqcc-qris-chart">
                {hasQrisData ? <QrisStatusDonut id={`qris-${bulan}`} buckets={qrisBuckets} /> : <div className="iqcc-empty-sub">Belum ada data status QRIS</div>}
              </div>
              <div className="iqcc-qris-cards">
                <div className="iqcc-qris-card" style={{ '--qc-color': QRIS_STATUS_COLOR.terbit }}><div className="iqcc-qris-card-count">{fmtN(qris?.qris_terbit)}</div><div className="iqcc-qris-card-label">Terbit</div></div>
                <div className="iqcc-qris-card" style={{ '--qc-color': QRIS_STATUS_COLOR.belum_terbit }}><div className="iqcc-qris-card-count">{fmtN(qris?.qris_belum_terbit)}</div><div className="iqcc-qris-card-label">Belum Terbit</div></div>
                <div className="iqcc-qris-card" style={{ '--qc-color': QRIS_STATUS_COLOR.perbaikan_data }}><div className="iqcc-qris-card-count">{fmtN(qris?.qris_perbaikan_data)}</div><div className="iqcc-qris-card-label">Perbaikan Data</div></div>
                <div className="iqcc-qris-card" style={{ '--qc-color': QRIS_STATUS_COLOR.rejected }}><div className="iqcc-qris-card-count">{fmtN(qris?.qris_rejected)}</div><div className="iqcc-qris-card-label">Rejected</div></div>
                <div className="iqcc-qris-card" style={{ '--qc-color': QRIS_STATUS_COLOR.lainnya }}><div className="iqcc-qris-card-count">{fmtN((qris?.qris_status_lain || 0) + (qris?.qris_unknown || 0))}</div><div className="iqcc-qris-card-label">Unknown / Lainnya</div></div>
              </div>
            </div>
          </div>

          {/* Top Wilayah & Top Kategori */}
          <div className="iqcc-2col">
            <TopListCard title="Top 10 Provinsi" icon="ti-map-pin" items={outlet?.top_provinsi} />
            <TopListCard title="Top 10 Kategori" icon="ti-category" items={outlet?.top_kategori} />
          </div>

          {/* Insight / Bottleneck */}
          <div className="iqcc-panel">
            <div className="iqcc-panel-title"><i className="ti ti-bulb" style={{ color: COLOR }} /> Bottleneck & Insight</div>
            {insights.length === 0 && <div className="iqcc-empty-sub">Tidak ada bottleneck terdeteksi bulan ini — kondisi normal.</div>}
            <div className="iqcc-insight-grid">
              {insights.map((ins, i) => {
                const m = insightMeta(ins.area);
                const sm = insightSeverityMeta(ins.severity);
                return (
                  <div key={i} className="iqcc-insight-card" style={{ '--ins-color': sm.color }}>
                    <div className="iqcc-insight-top">
                      <i className={'ti ' + m.icon} style={{ color: sm.color }} />
                      <div className="iqcc-insight-title">{ins.title || m.title}</div>
                      <span className="iqcc-severity-badge" style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>
                    </div>
                    <div className="iqcc-insight-desc">{ins.detail}</div>
                    {m.recommendation && <div className="iqcc-insight-reko"><i className="ti ti-arrow-right" /> {m.recommendation}</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Action Summary */}
          <div className="iqcc-panel">
            <div className="iqcc-panel-title"><i className="ti ti-list-check" style={{ color: COLOR }} /> Prioritas Aksi</div>
            {actionSummary.length === 0 && <div className="iqcc-empty-sub">Tidak ada aksi prioritas — semua indikator bersih.</div>}
            <div className="iqcc-action-grid">
              {actionSummary.map((a, i) => {
                const pm = actionPriorityMeta(a.priority);
                return (
                  <div key={i} className="iqcc-action-card" style={{ '--ac-color': pm.color }}>
                    <div className="iqcc-action-top">
                      <span className="iqcc-priority-badge" style={{ background: pm.color }}>{a.priority} · {pm.label}</span>
                      <span className="iqcc-action-count">{fmtN(a.count)}</span>
                    </div>
                    <div className="iqcc-action-title">{actionTypeLabel(a.action_type)}</div>
                    {a.recommendation && <div className="iqcc-action-reko">{a.recommendation}</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Data Quality Panel */}
          <div className="iqcc-panel">
            <div className="iqcc-panel-title"><i className="ti ti-database-cog" style={{ color: COLOR }} /> Kualitas Data</div>
            {dqChecks.filter(c => c.count > 0).length === 0 && (
              <div className="iqcc-empty-sub">Tidak ada isu kualitas data untuk bulan ini.</div>
            )}
            <div className="iqcc-dq-list">
              {dqChecks.filter(c => c.count > 0).map((c, i) => {
                const m = dqMeta(c.check);
                const sm = dqSeverityMeta(c.severity);
                return (
                  <div key={i} className="iqcc-dq-item" style={{ '--dq-color': sm.color }}>
                    <div className="iqcc-dq-top">
                      <div className="iqcc-dq-title">{m.label}</div>
                      <span className="iqcc-severity-badge" style={{ background: sm.color + '22', color: sm.color }}>{sm.label}</span>
                      <div className="iqcc-dq-count">{fmtN(c.count)}</div>
                    </div>
                    {m.note && <div className="iqcc-dq-note">{m.note}</div>}
                  </div>
                );
              })}
            </div>
          </div>

        </>)}
      </div>
    </Layout>
  );
}
