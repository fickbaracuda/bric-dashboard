import { useState, useEffect, useCallback, useRef } from 'react';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getUser } from '../utils/auth';
import {
  getBfOverview, getBfBank, getBfPlan, getBfSchedules, createBfSchedule, updateBfSchedule,
  updateBfPlan, updateBfHourlyPlan, getBfRecommendations, acknowledgeBfRecommendation,
} from '../services/api';

/**
 * Balance & Funding — STANDALONE dari Balance Control Tower lama. Halaman
 * ini TIDAK mengimpor komponen/CSS class dari WarRoomBalanceControlTower.jsx
 * (spec section 47) — semua class CSS di sini prefix `wbf-*`, baru.
 * ADVISORY ONLY: tidak ada aksi transfer/cancel bank sungguhan di sini.
 */

const THEME = '#0EA5E9';
const BANK_LIST = [
  { code: 'OCBC', label: 'OCBC', color: '#DC2626' },
  { code: 'MANDIRI', label: 'Mandiri', color: '#003D79' },
  { code: 'BRI', label: 'BRI', color: '#00529C' },
  { code: 'BRI_BIFAST', label: 'BRI BI-FAST', color: '#00529C' },
  { code: 'BNI', label: 'BNI', color: '#F15A23' },
  { code: 'BCA', label: 'BCA', color: '#0033A0' },
];
function bankMeta(code) { return BANK_LIST.find(b => b.code === code) || { code, label: code, color: '#6B7280' }; }

const RECOMMENDATION_META = {
  CANCEL: { label: 'Batalkan Scheduler', color: '#DC2626', bg: '#FEE2E2', icon: 'ti-player-stop' },
  REDUCE: { label: 'Kurangi Scheduler', color: '#D97706', bg: '#FFEDD5', icon: 'ti-arrow-down' },
  KEEP: { label: 'Pertahankan Scheduler', color: '#059669', bg: '#DCFCE7', icon: 'ti-check' },
  ADD: { label: 'Tambahkan Scheduler', color: '#2563EB', bg: '#DBEAFE', icon: 'ti-arrow-up' },
  NO_UPCOMING_SCHEDULER: { label: 'Tidak Ada Scheduler', color: '#6B7280', bg: '#F3F4F6', icon: 'ti-calendar-off' },
  INSUFFICIENT_DATA: { label: 'Rencana Belum Tersedia', color: '#7C3AED', bg: '#EDE9FE', icon: 'ti-alert-triangle' },
  BALANCE_UNAVAILABLE: { label: 'Saldo Belum Terverifikasi', color: '#991B1B', bg: '#FEE2E2', icon: 'ti-plug-connected-x' },
  BALANCE_STALE: { label: 'Data Saldo Kedaluwarsa', color: '#7C3AED', bg: '#EDE9FE', icon: 'ti-clock-exclamation' },
};
function recoMeta(r) { return RECOMMENDATION_META[r] || { label: r || '-', color: '#6B7280', bg: '#F3F4F6', icon: 'ti-help' }; }

const PLAN_STATUS_META = {
  ABOVE_PLAN: { label: 'Saldo di atas rencana', color: '#2563EB', bg: '#DBEAFE' },
  BELOW_PLAN: { label: 'Saldo di bawah rencana', color: '#DC2626', bg: '#FEE2E2' },
  ON_PLAN: { label: 'Saldo sesuai rencana', color: '#059669', bg: '#DCFCE7' },
  INSUFFICIENT_DATA: { label: 'Data belum lengkap', color: '#6B7280', bg: '#F3F4F6' },
};
function planStatusMeta(s) { return PLAN_STATUS_META[s] || { label: s || '-', color: '#6B7280', bg: '#F3F4F6' }; }

const URGENCY_META = {
  NORMAL: { label: 'Normal', color: '#059669', bg: '#DCFCE7' },
  WATCH: { label: 'Watch', color: '#2563EB', bg: '#DBEAFE' },
  WARNING: { label: 'Warning', color: '#D97706', bg: '#FFEDD5' },
  URGENT: { label: 'Urgent', color: '#DC2626', bg: '#FEE2E2' },
  OVERDUE: { label: 'Overdue', color: '#991B1B', bg: '#FEE2E2' },
};
function urgencyMeta(u) { return URGENCY_META[u] || { label: '-', color: '#6B7280', bg: '#F3F4F6' }; }
const ACTIONABLE_RECO = new Set(['ADD', 'REDUCE', 'CANCEL']);

const CONFIDENCE_META = {
  HIGH: { label: 'HIGH', color: '#059669', bg: '#DCFCE7' },
  MEDIUM: { label: 'MEDIUM', color: '#D97706', bg: '#FFEDD5' },
  LOW: { label: 'LOW', color: '#DC2626', bg: '#FEE2E2' },
  UNAVAILABLE: { label: 'UNAVAILABLE', color: '#6B7280', bg: '#F3F4F6' },
};
function confidenceMeta(c) { return CONFIDENCE_META[c] || { label: c || '-', color: '#6B7280', bg: '#F3F4F6' }; }

function fmtRp(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '-';
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(v));
}
function fmtRpSigned(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '-';
  const n = Number(v);
  return (n > 0 ? '+' : '') + fmtRp(n);
}
function fmtRpShort(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}Rp${(abs / 1e9).toFixed(2)}M`;
  if (abs >= 1e6) return `${sign}Rp${(abs / 1e6).toFixed(1)}jt`;
  return fmtRp(n);
}
function fmtDateTime(v) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta' }) + ' WIB';
}

/**
 * Balance Position Time: pecah balance_info jadi bagian siap-tampil sesuai
 * presisi sumbernya. TIDAK PERNAH mengarang jam kalau precision='DATE'
 * (OCBC/BCA -- source cuma punya tanggal, lihat backend bankBalanceAdapters.js)
 * -- spec section 1/2/11: jangan samakan posisi saldo dgn waktu sync, dan
 * jangan fallback ke NOW() kalau tidak bisa dibuktikan.
 */
function positionTimeParts(balanceInfo) {
  const bp = balanceInfo?.balance_position_time;
  const precision = balanceInfo?.balance_position_precision;
  const ageMin = balanceInfo?.balance_age_minutes;
  if (!bp) return { available: false };
  const d = new Date(bp);
  if (Number.isNaN(d.getTime())) return { available: false };
  if (precision === 'MINUTE') {
    const clock = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta', hour12: false }) + ' WIB';
    const age = ageMin === null || ageMin === undefined ? null : (ageMin < 1 ? 'baru saja' : `${ageMin} menit lalu`);
    return { available: true, precision, clockOrDate: clock, ageLabel: age };
  }
  // DATE precision (OCBC/BCA) -- tampilkan sbg tanggal, BUKAN klaim jam:menit yang tidak bisa dibuktikan.
  const dateStr = d.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jakarta' });
  const days = ageMin === null || ageMin === undefined ? null : Math.floor(ageMin / 1440);
  const age = days === null ? null : (days <= 0 ? 'data hari ini' : `${days} hari lalu`);
  return { available: true, precision, clockOrDate: dateStr, ageLabel: age };
}

/** Teks persis spec section 9 ("Saldo terakhir posisi HH:mm WIB — X menit lalu. Tunggu data terbaru..."). */
function staleMessage(balanceInfo) {
  const pos = positionTimeParts(balanceInfo);
  if (!pos.available) return 'Waktu posisi saldo tidak tersedia. Tunggu data terbaru sebelum mengambil keputusan funding.';
  return `Saldo terakhir posisi ${pos.clockOrDate}${pos.ageLabel ? ' — ' + pos.ageLabel : ''}. Tunggu data terbaru sebelum mengambil keputusan funding.`;
}

/** Re-render berkala TANPA hit API (spec section 3) -- cuma dorong ulang komponen supaya countdown lokal ikut bergerak. */
function useTick(intervalMs) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

/** Countdown lokal dari next_scheduler_time absolute (spec section 3) -- akurat walau data terakhir fetch beberapa menit lalu. */
function localMinutesToScheduler(nextSchedule) {
  if (!nextSchedule?.next_scheduler_time) return nextSchedule?.minutes_to_next_scheduler ?? null;
  const ms = new Date(nextSchedule.next_scheduler_time).getTime() - Date.now();
  if (Number.isNaN(ms)) return nextSchedule?.minutes_to_next_scheduler ?? null;
  return Math.round(ms / 60000);
}
/** Urgency lokal dari countdown yang sama (mirror murni dari ambang batas backend, spec section 5) -- dipakai supaya badge tetap benar walau user diam di halaman lewat ambang batas tanpa refresh. */
function localUrgency(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return null;
  if (minutes < 0) return 'OVERDUE';
  if (minutes <= 15) return 'URGENT';
  if (minutes <= 30) return 'WARNING';
  if (minutes <= 60) return 'WATCH';
  return 'NORMAL';
}
function countdownLabel(minutes) {
  if (minutes === null || minutes === undefined) return '-';
  if (minutes < 0) return `TERLAMBAT ${Math.abs(minutes)} MENIT`;
  if (minutes === 0) return 'Sekarang';
  return `${minutes} menit lagi`;
}

function Kpi({ label, value, sub, alert }) {
  return (
    <div className={'wbf-kpi-card' + (alert ? ' wbf-kpi-card--alert' : '')}>
      <div className="wbf-kpi-label">{label}</div>
      <div className="wbf-kpi-value">{value}</div>
      {sub && <div className="wbf-kpi-sub">{sub}</div>}
    </div>
  );
}

/**
 * Finance Action Alert (spec section 6) — HANYA muncul kalau
 * next_schedule.finance_action_alert true (backend: recommendation
 * actionable ADD/REDUCE/CANCEL DAN scheduler <=15 menit lagi/overdue).
 * KEEP TIDAK PERNAH memicu ini, walau scheduler dekat.
 */
function FinanceActionAlert({ result, balanceInfo }) {
  const ns = result?.next_schedule;
  if (!ns?.finance_action_alert) return null;
  const reco = result.recommendation;
  const minutes = localMinutesToScheduler(ns);
  const pos = positionTimeParts(balanceInfo);

  if (reco === 'ADD') {
    return (
      <div className="wbf-finance-alert">
        <div className="wbf-finance-alert-title">🔴 FUNDING PERLU DITAMBAH</div>
        <div className="wbf-finance-alert-grid">
          <div><span>Posisi saldo</span><b>{pos.available ? pos.clockOrDate : '-'}</b></div>
          <div><span>Next Scheduler</span><b>{ns.funding_source_code} {ns.scheduled_time}</b></div>
          <div><span>Waktu tersisa</span><b>{countdownLabel(minutes)}</b></div>
          <div><span>Saran</span><b>Tambahkan {fmtRp(ns.adjustment_amount)}</b></div>
        </div>
        <div className="wbf-finance-alert-cta">Segera konfirmasi ke tim Finance sebelum scheduler diproses.</div>
      </div>
    );
  }
  if (reco === 'CANCEL') {
    return (
      <div className="wbf-finance-alert">
        <div className="wbf-finance-alert-title">🔴 SCHEDULER PERLU DIBATALKAN</div>
        <div className="wbf-finance-alert-grid">
          <div><span>Scheduler</span><b>{ns.funding_source_code} {ns.scheduled_time} — {fmtRp(ns.scheduled_amount)}</b></div>
          <div><span>Waktu tersisa</span><b>{countdownLabel(minutes)}</b></div>
        </div>
        <div className="wbf-finance-alert-text">Saldo diproyeksikan sudah mencukupi.</div>
        <div className="wbf-finance-alert-cta">Segera konfirmasi ke tim Finance agar scheduler tidak terlanjur diproses.</div>
      </div>
    );
  }
  // REDUCE
  return (
    <div className="wbf-finance-alert">
      <div className="wbf-finance-alert-title">🔴 FUNDING PERLU DIKURANGI</div>
      <div className="wbf-finance-alert-grid">
        <div><span>Scheduler</span><b>{ns.funding_source_code} {ns.scheduled_time}</b></div>
        <div><span>Waktu tersisa</span><b>{countdownLabel(minutes)}</b></div>
        <div><span>Saran</span><b>Kurangi {fmtRp(Math.abs(ns.adjustment_amount))}</b></div>
      </div>
      <div className="wbf-finance-alert-cta">Segera konfirmasi ke tim Finance sebelum scheduler diproses.</div>
    </div>
  );
}

export default function BalanceFunding() {
  const user = getUser();
  const isAdmin = user?.role === 'admin';
  const isFinanceOrOps = user?.unit === 'FA' || user?.unit === 'OP' || isAdmin;

  const [view, setView] = useState('overview'); // 'overview' | bank_code
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadOverview = useCallback(() => {
    setLoading(true); setError(null);
    getBfOverview()
      .then(setOverview)
      .catch(e => setError(e.response?.data?.error || 'Gagal memuat Balance & Funding.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  return (
    <Layout>
      <div className="page-header">
        <div>
          <div className="page-title">Balance &amp; Funding</div>
          <div className="page-sub">Reminder &amp; decision support saldo operasional 6 bank — advisory only, tidak ada transfer/cancel scheduler otomatis</div>
        </div>
        <button className="fbr-btn" onClick={loadOverview} disabled={loading}>
          <i className="ti ti-refresh" /> {loading ? 'Memuat…' : 'Refresh'}
        </button>
      </div>

      <div className="wbf-bank-selector">
        <button className={'wbf-bank-tab' + (view === 'overview' ? ' wbf-bank-tab--active' : '')} onClick={() => setView('overview')}>
          <i className="ti ti-layout-grid" /> All Banks
        </button>
        {BANK_LIST.map(b => (
          <button key={b.code} className={'wbf-bank-tab' + (view === b.code ? ' wbf-bank-tab--active' : '')} onClick={() => setView(b.code)}>
            <span className="wbf-bank-dot" style={{ background: b.color }} /> {b.label}
          </button>
        ))}
      </div>

      {error && <div className="fbr-error" style={{ marginBottom: 12 }}>{error}</div>}

      {loading && !overview ? (
        <div className="loading-wrap"><div className="loading-spinner" /><div className="loading-text">Memuat data…</div></div>
      ) : view === 'overview' ? (
        <OverviewTab banks={overview?.banks || []} onSelectBank={setView} />
      ) : (
        <BankDetailTab bankCode={view} isAdmin={isAdmin} isFinanceOrOps={isFinanceOrOps} onAcknowledged={loadOverview} />
      )}
    </Layout>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function OverviewTab({ banks, onSelectBank }) {
  useTick(30000); // countdown lokal ikut bergerak tanpa hit API (spec section 3)
  return (
    <div className="wbf-overview-grid">
      {banks.map(b => {
        const meta = bankMeta(b.bank_code);
        const result = b.result || {};
        const cp = result.current_plan;
        const ns = result.next_schedule;
        const reco = recoMeta(result.recommendation);
        const conf = confidenceMeta(b.balance_info?.confidence);
        const pos = positionTimeParts(b.balance_info);
        const minutes = ns ? localMinutesToScheduler(ns) : null;
        const urgency = ns ? localUrgency(minutes) : null;
        // Urgency HANYA ditonjolkan (badge merah dsb) kalau recommendation actionable -- KEEP tidak pernah dibuat merah (spec section 5).
        const showUrgencyBadge = urgency && ACTIONABLE_RECO.has(result.recommendation);
        const um = urgencyMeta(urgency);
        return (
          <div key={b.bank_code} className="wbf-overview-card" onClick={() => onSelectBank(b.bank_code)} style={{ borderTopColor: meta.color }}>
            <div className="wbf-overview-card-header">
              <div className="wbf-overview-bank-name"><span className="wbf-bank-dot" style={{ background: meta.color }} /> {meta.label}</div>
              <span className="wbf-badge" style={{ color: conf.color, background: conf.bg }}>{conf.label}</span>
            </div>

            <div className="wbf-overview-block">
              <div className="wbf-overview-label">Actual Balance</div>
              <div className="wbf-overview-value">{fmtRp(b.balance_info?.balance)}</div>
              <div className="wbf-overview-position">
                {pos.available ? `Posisi ${pos.clockOrDate}${pos.ageLabel ? ' • ' + pos.ageLabel : ''}` : 'Waktu posisi saldo tidak tersedia'}
              </div>
            </div>

            <div className="wbf-overview-row"><span>Plan</span><b>{cp ? fmtRp(cp.planned_balance) : '-'}</b></div>
            <div className="wbf-overview-row"><span>Variance</span><b style={{ color: cp ? planStatusMeta(cp.status).color : undefined }}>{cp ? fmtRpSigned(cp.variance) : '-'}</b></div>

            <div className="wbf-overview-row wbf-overview-row--next">
              <span>Next</span>
              <b>{ns ? `${ns.funding_source_code} • ${ns.scheduled_time}` : '-'}</b>
            </div>
            {ns && (
              <div className="wbf-overview-countdown" style={showUrgencyBadge ? { color: um.color } : undefined}>
                {countdownLabel(minutes)}
              </div>
            )}

            <div className="wbf-overview-reco" style={{ color: reco.color, background: reco.bg }}>
              <i className={'ti ' + reco.icon} /> {reco.label}
              {showUrgencyBadge && <span className="wbf-badge" style={{ color: um.color, background: um.bg, marginLeft: 'auto' }}>{um.label}</span>}
            </div>
          </div>
        );
      })}
      {!banks.length && <div className="wbf-empty">Belum ada data bank.</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function BankDetailTab({ bankCode, isAdmin, isFinanceOrOps, onAcknowledged }) {
  useTick(1000); // countdown & "sekarang" di operational strip ikut bergerak tanpa hit API (spec section 3)
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const meta = bankMeta(bankCode);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    getBfBank(bankCode)
      .then(setData)
      .catch(e => setError(e.response?.data?.error || `Gagal memuat data ${bankCode}.`))
      .finally(() => setLoading(false));
  }, [bankCode]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!data || !chartRef.current || !data.plan_24h?.length) return;
    const ctx = chartRef.current.getContext('2d');
    if (chartInstance.current) chartInstance.current.destroy();
    const labels = data.plan_24h.map(p => `${String(p.hour).padStart(2, '0')}:00`);
    const plannedSeries = data.plan_24h.map(p => p.planned_balance);
    const currentHour = data.result?.current_hour;
    const actualSeries = data.plan_24h.map(p => (p.hour === currentHour ? data.balance_info?.balance : null));
    chartInstance.current = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Planned Balance', data: plannedSeries, borderColor: meta.color, backgroundColor: `${meta.color}18`, tension: 0.3, pointRadius: 2, fill: true },
          { label: `Actual Balance (jam berjalan)${data.balance_info?.confidence && data.balance_info.confidence !== 'HIGH' ? ' — ' + data.balance_info.confidence : ''}`, data: actualSeries, borderColor: '#DC2626', backgroundColor: '#DC2626', pointRadius: 7, showLine: false },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: { y: { ticks: { callback: (v) => fmtRpShort(v) } } },
      },
    });
    return () => { if (chartInstance.current) chartInstance.current.destroy(); };
  }, [data, meta.color]);

  if (loading && !data) return <div className="loading-wrap"><div className="loading-spinner" /></div>;
  if (error && !loading) return <div className="fbr-error">{error}</div>;
  if (!data) return null;

  const result = data.result || {};
  const cp = result.current_plan;
  const ns = result.next_schedule;
  const reco = recoMeta(result.recommendation);
  const planMeta = cp ? planStatusMeta(cp.status) : planStatusMeta(null);
  const conf = confidenceMeta(data.balance_info?.confidence);
  const canAcknowledge = isFinanceOrOps && !['INSUFFICIENT_DATA', 'BALANCE_UNAVAILABLE'].includes(result.recommendation);
  const pos = positionTimeParts(data.balance_info);
  const minutesToNext = ns ? localMinutesToScheduler(ns) : null;
  const urgency = ns ? localUrgency(minutesToNext) : null;
  const showUrgencyBadge = urgency && ACTIONABLE_RECO.has(result.recommendation);
  const um = urgencyMeta(urgency);
  const nowWib = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta', hour12: false }) + ' WIB';

  return (
    <div className="wbf-detail">
      <div className="wbf-detail-header" style={{ borderLeftColor: meta.color }}>
        <div className="wbf-detail-title"><span className="wbf-bank-dot" style={{ background: meta.color }} /> {meta.label} Balance &amp; Funding</div>
        <div className="wbf-detail-sub">
          Actual source: <b>{data.balance_info?.source || '-'}</b> · Sync terakhir: <b>{fmtDateTime(data.balance_info?.last_sync_at)}</b> ·
          Confidence: <span className="wbf-badge" style={{ color: conf.color, background: conf.bg, marginLeft: 4 }}>{conf.label}</span>
        </div>
        {data.balance_info?.warnings?.length > 0 && (
          <div className="wbf-detail-warnings">{data.balance_info.warnings.map((w, i) => <div key={i}><i className="ti ti-alert-triangle" /> {w}</div>)}</div>
        )}
      </div>

      {/* Operational strip (spec section 10) -- SEKARANG/POSISI SALDO/NEXT SCHEDULER/STATUS, harus terlihat tanpa scroll panjang. */}
      <div className="wbf-opstrip">
        <div className="wbf-opstrip-item">
          <div className="wbf-opstrip-label">Sekarang</div>
          <div className="wbf-opstrip-value">{nowWib}</div>
        </div>
        <div className="wbf-opstrip-item">
          <div className="wbf-opstrip-label">Posisi Saldo</div>
          <div className="wbf-opstrip-value">{pos.available ? pos.clockOrDate : 'Tidak tersedia'}</div>
          {pos.available && pos.ageLabel && <div className="wbf-opstrip-sub">{pos.ageLabel}</div>}
        </div>
        <div className="wbf-opstrip-item">
          <div className="wbf-opstrip-label">Next Scheduler</div>
          <div className="wbf-opstrip-value">{ns ? `${ns.funding_source_code} • ${ns.scheduled_time}` : '-'}</div>
          {ns && <div className="wbf-opstrip-sub">{countdownLabel(minutesToNext)}</div>}
        </div>
        <div className="wbf-opstrip-item">
          <div className="wbf-opstrip-label">Status</div>
          <div className="wbf-opstrip-value" style={showUrgencyBadge ? { color: um.color } : undefined}>
            {showUrgencyBadge ? um.label.toUpperCase() : (result.recommendation === 'BALANCE_STALE' ? 'DATA STALE' : '-')}
          </div>
        </div>
      </div>

      <FinanceActionAlert result={result} balanceInfo={data.balance_info} />

      {cp && (cp.status === 'ABOVE_PLAN' || cp.status === 'BELOW_PLAN') && (
        <div className="wbf-alert" style={{ borderLeftColor: planMeta.color, background: planMeta.bg }}>
          <i className={'ti ' + (cp.status === 'ABOVE_PLAN' ? 'ti-trending-up' : 'ti-trending-down')} style={{ color: planMeta.color }} />
          <div>
            <b style={{ color: planMeta.color }}>{planMeta.label}</b>
            <div className="wbf-alert-text">Saldo {fmtRpSigned(cp.variance)} dibanding rencana jam {String(cp.hour).padStart(2, '0')}:00 (Rp{Number(cp.planned_balance).toLocaleString('id-ID')}).</div>
          </div>
        </div>
      )}
      {result.recommendation === 'BALANCE_STALE' && (
        <div className="wbf-alert" style={{ borderLeftColor: reco.color, background: reco.bg }}>
          <i className={'ti ' + reco.icon} style={{ color: reco.color }} />
          <div><b style={{ color: reco.color }}>{reco.label}</b><div className="wbf-alert-text">{staleMessage(data.balance_info)}</div></div>
        </div>
      )}
      {(result.recommendation === 'BALANCE_UNAVAILABLE' || result.recommendation === 'INSUFFICIENT_DATA') && (
        <div className="wbf-alert" style={{ borderLeftColor: reco.color, background: reco.bg }}>
          <i className={'ti ' + reco.icon} style={{ color: reco.color }} />
          <div><b style={{ color: reco.color }}>{reco.label}</b><div className="wbf-alert-text">{result.reason}</div></div>
        </div>
      )}

      <div className="wbf-kpi-grid">
        <Kpi label="Actual Balance" value={fmtRp(data.balance_info?.balance)} sub={pos.available ? `Posisi ${pos.clockOrDate}${pos.ageLabel ? ' • ' + pos.ageLabel : ''}` : 'Waktu posisi saldo tidak tersedia'} />
        <Kpi label="Planned Balance" value={cp ? fmtRp(cp.planned_balance) : '-'} sub={cp ? `Jam ${String(cp.hour).padStart(2, '0')}:00` : '-'} />
        <Kpi label="Variance" value={cp ? fmtRpSigned(cp.variance) : '-'} sub={planMeta.label} alert={cp?.status === 'BELOW_PLAN'} />
        <Kpi label="Next Scheduler" value={ns ? `${ns.funding_source_code} ${ns.scheduled_time}` : '-'} sub={ns ? countdownLabel(minutesToNext) : '-'} alert={showUrgencyBadge && (urgency === 'URGENT' || urgency === 'OVERDUE')} />
        <Kpi label="Required Funding" value={ns && ns.required_funding !== null ? fmtRp(ns.required_funding) : '-'} sub={ns ? `s.d. ${ns.scheduled_time}` : '-'} />
      </div>

      <div className="wbf-reco-card" style={{ borderColor: reco.color, background: reco.bg }}>
        <div className="wbf-reco-icon" style={{ color: reco.color }}><i className={'ti ' + reco.icon} /></div>
        <div className="wbf-reco-body">
          <div className="wbf-reco-label" style={{ color: reco.color }}>{reco.label}</div>
          {ns && ns.adjustment_amount !== null && ns.adjustment_amount !== undefined && result.recommendation !== 'KEEP' && (
            <div className="wbf-reco-amount" style={{ color: reco.color }}>{fmtRp(Math.abs(ns.adjustment_amount))}</div>
          )}
          <div className="wbf-reco-reason">{result.reason}</div>
        </div>
        {canAcknowledge && (
          <AcknowledgeBox bankCode={bankCode} onDone={() => { load(); onAcknowledged?.(); }} />
        )}
      </div>

      <div className="wr-table-section">
        <div className="wr-table-controls"><div className="wr-table-left"><b>Planned vs Actual Balance — 24 Jam</b></div></div>
        <div style={{ height: 280, padding: '8px 16px 16px' }}><canvas ref={chartRef} /></div>
      </div>

      <div className="wr-table-section">
        <div className="wr-table-controls"><div className="wr-table-left"><b>Funding Timeline</b></div></div>
        <div className="wr-table-wrap">
          <table className="wr-table">
            <thead><tr><th>Waktu</th><th>Sumber</th><th>Scheduled</th><th>Actual</th><th>Status</th><th>Rekomendasi</th></tr></thead>
            <tbody>
              {(data.schedule_timeline || []).map(s => (
                <tr key={s.id} style={s.is_next ? { background: 'var(--bg-elevated)', fontWeight: 600 } : undefined}>
                  <td>{s.scheduled_time}</td>
                  <td>{s.funding_source_code}</td>
                  <td>{fmtRp(s.scheduled_amount)}</td>
                  <td>{s.actual_amount !== null ? fmtRp(s.actual_amount) : '—'}</td>
                  <td>
                    {s.display_status === 'SCHEDULER_OVERDUE' ? (
                      <span className="wbf-badge" style={{ color: '#991B1B', background: '#FEE2E2' }}>
                        TERLAMBAT {s.overdue_minutes ?? '?'} MENIT
                      </span>
                    ) : (
                      <span className="wbf-badge" style={{ color: '#374151', background: '#F3F4F6' }}>{s.display_status}</span>
                    )}
                  </td>
                  <td>{s.recommendation ? <span className="wbf-badge" style={{ color: recoMeta(s.recommendation).color, background: recoMeta(s.recommendation).bg }}>{recoMeta(s.recommendation).label}</span> : '—'}</td>
                </tr>
              ))}
              {(!data.schedule_timeline || !data.schedule_timeline.length) && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>Tidak ada scheduler berikutnya.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="wr-table-section">
        <div className="wr-table-controls"><div className="wr-table-left"><b>Data Quality / Balance Source</b></div></div>
        <div className="wbf-dq-grid">
          <div><span>Actual Source</span><b>{data.balance_info?.source || '-'}</b></div>
          <div><span>Verification</span><b>{data.balance_info?.verification_status || '-'}</b></div>
          <div><span>Business Date</span><b>{data.balance_info?.business_date || '-'}</b></div>
          <div><span>Account</span><b>{data.balance_info?.account_no || '-'}</b></div>
          <div>
            <span>Posisi Saldo</span>
            <b>{pos.available ? `${pos.clockOrDate} (${pos.precision === 'MINUTE' ? 'jam:menit' : 'harian'})` : 'Tidak tersedia'}</b>
          </div>
          <div><span>Sync Terakhir</span><b>{fmtDateTime(data.balance_info?.last_sync_at)}</b></div>
          <div><span>Confidence</span><b style={{ color: conf.color }}>{conf.label}</b></div>
        </div>
      </div>

      {isAdmin && (
        <div className="wr-table-section">
          <div className="wr-table-controls" style={{ cursor: 'pointer' }} onClick={() => setShowAdmin(s => !s)}>
            <div className="wr-table-left"><b>Manage Plan (Admin)</b></div>
            <i className={'ti ' + (showAdmin ? 'ti-chevron-up' : 'ti-chevron-down')} />
          </div>
          {showAdmin && <AdminPlanPanel bankCode={bankCode} plan={data.plan} onSaved={load} />}
        </div>
      )}
    </div>
  );
}

function AcknowledgeBox({ bankCode, onDone }) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  async function submit() {
    setSaving(true); setMsg(null);
    try {
      // Ambil rekomendasi terbaru bank ini lalu acknowledge (backend menyimpan
      // 1 baris riwayat per perubahan material -- ambil via endpoint recommendations).
      const hist = await getBfRecommendations(bankCode, { limit: 1 });
      const latest = hist.recommendations?.[0];
      if (!latest) { setMsg({ type: 'error', text: 'Belum ada riwayat rekomendasi untuk di-acknowledge.' }); setSaving(false); return; }
      await acknowledgeBfRecommendation(latest.id, note.trim() || null);
      setNote('');
      setMsg({ type: 'ok', text: 'Rekomendasi ditandai sudah ditindaklanjuti.' });
      onDone?.();
    } catch (e) {
      setMsg({ type: 'error', text: e.response?.data?.error || 'Gagal menyimpan.' });
    } finally { setSaving(false); }
  }

  return (
    <div className="wbf-ack-box">
      <textarea className="fbr-input" rows={2} placeholder="Catatan tindak lanjut (opsional)…" value={note} onChange={e => setNote(e.target.value)} />
      <button className="fbr-btn fbr-btn-primary" onClick={submit} disabled={saving}>
        <i className="ti ti-check" /> {saving ? 'Menyimpan…' : 'Sudah Ditindaklanjuti'}
      </button>
      {msg && <div className={msg.type === 'ok' ? 'wbf-ack-ok' : 'fbr-error'} style={{ marginTop: 6 }}>{msg.text}</div>}
    </div>
  );
}

/** Admin-only: edit opening balance/tolerance, hourly plan, & scheduler langsung dari tabel. */
function AdminPlanPanel({ bankCode, plan, onSaved }) {
  const [hourlyPlan, setHourlyPlan] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null);
  const [msg, setMsg] = useState(null);
  const [newSchedule, setNewSchedule] = useState({ scheduled_time: '', funding_source_code: '', scheduled_amount: '' });
  const [planForm, setPlanForm] = useState({
    opening_balance: plan?.opening_balance ?? '', variance_tolerance: '', scheduler_tolerance: '', stale_after_minutes: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [planRes, schedRes] = await Promise.all([getBfPlan(bankCode), getBfSchedules(bankCode)]);
      setHourlyPlan(planRes.hourly_plan || []);
      setSchedules(schedRes.schedules || []);
      if (planRes.plan) {
        setPlanForm({
          opening_balance: planRes.plan.opening_balance ?? '',
          variance_tolerance: planRes.plan.variance_tolerance ?? '',
          scheduler_tolerance: planRes.plan.scheduler_tolerance ?? '',
          stale_after_minutes: planRes.plan.stale_after_minutes ?? '',
        });
      }
    } catch (e) { setMsg({ type: 'error', text: 'Gagal memuat konfigurasi plan.' }); }
    finally { setLoading(false); }
  }, [bankCode]);

  useEffect(() => { load(); }, [load]);

  async function savePlanConfig() {
    setSavingKey('plan'); setMsg(null);
    try {
      await updateBfPlan(bankCode, {
        opening_balance: planForm.opening_balance === '' ? null : Number(planForm.opening_balance),
        variance_tolerance: planForm.variance_tolerance === '' ? null : Number(planForm.variance_tolerance),
        scheduler_tolerance: planForm.scheduler_tolerance === '' ? null : Number(planForm.scheduler_tolerance),
        stale_after_minutes: planForm.stale_after_minutes === '' ? null : Number(planForm.stale_after_minutes),
      });
      setMsg({ type: 'ok', text: 'Konfigurasi plan tersimpan.' });
      load(); onSaved?.();
    } catch (e) { setMsg({ type: 'error', text: e.response?.data?.error || 'Gagal menyimpan plan.' }); }
    finally { setSavingKey(null); }
  }

  async function saveHour(hour, patch) {
    setSavingKey(`h${hour}`); setMsg(null);
    try {
      await updateBfHourlyPlan(bankCode, hour, patch);
      setMsg({ type: 'ok', text: `Baseline jam ${String(hour).padStart(2, '0')}:00 tersimpan.` });
      load(); onSaved?.();
    } catch (e) { setMsg({ type: 'error', text: e.response?.data?.error || 'Gagal menyimpan.' }); }
    finally { setSavingKey(null); }
  }

  async function saveSchedule(id, patch) {
    setSavingKey(`s${id}`); setMsg(null);
    try {
      await updateBfSchedule(bankCode, id, patch);
      setMsg({ type: 'ok', text: 'Scheduler tersimpan.' });
      load(); onSaved?.();
    } catch (e) { setMsg({ type: 'error', text: e.response?.data?.error || 'Gagal menyimpan.' }); }
    finally { setSavingKey(null); }
  }

  async function addSchedule() {
    if (!newSchedule.scheduled_time || !newSchedule.funding_source_code || newSchedule.scheduled_amount === '') {
      setMsg({ type: 'error', text: 'Waktu, sumber, dan nominal wajib diisi.' }); return;
    }
    setSavingKey('new'); setMsg(null);
    try {
      await createBfSchedule(bankCode, newSchedule);
      setNewSchedule({ scheduled_time: '', funding_source_code: '', scheduled_amount: '' });
      setMsg({ type: 'ok', text: 'Scheduler baru ditambahkan.' });
      load(); onSaved?.();
    } catch (e) { setMsg({ type: 'error', text: e.response?.data?.error || 'Gagal menambah scheduler.' }); }
    finally { setSavingKey(null); }
  }

  if (loading) return <div className="loading-wrap" style={{ padding: 20 }}><div className="loading-spinner" /></div>;

  return (
    <div style={{ padding: '4px 16px 16px' }}>
      {msg && <div className={msg.type === 'ok' ? 'wbf-ack-ok' : 'fbr-error'} style={{ margin: '8px 0' }}>{msg.text}</div>}

      <div style={{ fontWeight: 700, fontSize: 13, margin: '12px 0 6px' }}>Plan Config</div>
      <div className="wbf-plan-form">
        <label>Opening Balance<input className="fbr-input" type="number" value={planForm.opening_balance} onChange={e => setPlanForm(f => ({ ...f, opening_balance: e.target.value }))} /></label>
        <label>Toleransi Variance (Rp)<input className="fbr-input" type="number" value={planForm.variance_tolerance} onChange={e => setPlanForm(f => ({ ...f, variance_tolerance: e.target.value }))} placeholder="default 10.000.000" /></label>
        <label>Toleransi Scheduler (Rp)<input className="fbr-input" type="number" value={planForm.scheduler_tolerance} onChange={e => setPlanForm(f => ({ ...f, scheduler_tolerance: e.target.value }))} placeholder="default 10.000.000" /></label>
        <label>Stale After (menit)<input className="fbr-input" type="number" value={planForm.stale_after_minutes} onChange={e => setPlanForm(f => ({ ...f, stale_after_minutes: e.target.value }))} placeholder="default 120" /></label>
        <button className="fbr-btn fbr-btn-primary" onClick={savePlanConfig} disabled={savingKey === 'plan'}>{savingKey === 'plan' ? 'Menyimpan…' : 'Simpan Plan'}</button>
      </div>

      <div style={{ fontWeight: 700, fontSize: 13, margin: '18px 0 6px' }}>Hourly Plan</div>
      <div className="wr-table-wrap">
        <table className="wr-table">
          <thead><tr><th>Jam</th><th>Nominal Average</th><th>Planned Balance</th><th></th></tr></thead>
          <tbody>
            {hourlyPlan.map(row => <AdminHourRow key={row.hour_of_day} row={row} saving={savingKey === `h${row.hour_of_day}`} onSave={(patch) => saveHour(row.hour_of_day, patch)} />)}
            {!hourlyPlan.length && Array.from({ length: 24 }, (_, h) => h).map(h => (
              <AdminHourRow key={h} row={{ hour_of_day: h }} saving={savingKey === `h${h}`} onSave={(patch) => saveHour(h, patch)} />
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontWeight: 700, fontSize: 13, margin: '18px 0 6px' }}>Funding Schedules</div>
      <div className="wr-table-wrap">
        <table className="wr-table">
          <thead><tr><th>Waktu</th><th>Funding Source</th><th>Nominal</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {schedules.map(row => <AdminScheduleRow key={row.id} row={row} saving={savingKey === `s${row.id}`} onSave={(patch) => saveSchedule(row.id, patch)} />)}
            <tr>
              <td><input className="fbr-input" style={{ width: 80 }} placeholder="HH:mm" value={newSchedule.scheduled_time} onChange={e => setNewSchedule(f => ({ ...f, scheduled_time: e.target.value }))} /></td>
              <td>
                <select className="select-input" value={newSchedule.funding_source_code} onChange={e => setNewSchedule(f => ({ ...f, funding_source_code: e.target.value }))}>
                  <option value="">Pilih…</option>
                  {BANK_LIST.map(b => <option key={b.code} value={b.code}>{b.label}</option>)}
                </select>
              </td>
              <td><input className="fbr-input" style={{ width: 130 }} type="number" placeholder="Nominal" value={newSchedule.scheduled_amount} onChange={e => setNewSchedule(f => ({ ...f, scheduled_amount: e.target.value }))} /></td>
              <td colSpan={2}><button className="fbr-btn fbr-btn-primary" onClick={addSchedule} disabled={savingKey === 'new'}><i className="ti ti-plus" /> Tambah</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AdminHourRow({ row, saving, onSave }) {
  const [avg, setAvg] = useState(row.nominal_average ?? '');
  const [planned, setPlanned] = useState(row.planned_balance ?? '');
  return (
    <tr>
      <td>{String(row.hour_of_day).padStart(2, '0')}:00</td>
      <td><input className="fbr-input" type="number" style={{ width: 150 }} value={avg} onChange={e => setAvg(e.target.value)} /></td>
      <td><input className="fbr-input" type="number" style={{ width: 160 }} value={planned} onChange={e => setPlanned(e.target.value)} /></td>
      <td><button className="fbr-btn" disabled={saving} onClick={() => onSave({ nominal_average: avg === '' ? null : Number(avg), planned_balance: planned === '' ? null : Number(planned) })}>{saving ? '…' : 'Simpan'}</button></td>
    </tr>
  );
}

function AdminScheduleRow({ row, saving, onSave }) {
  const [amount, setAmount] = useState(row.scheduled_amount ?? '');
  const [status, setStatus] = useState(row.status || 'SCHEDULED');
  return (
    <tr>
      <td>{String(row.scheduled_time).slice(0, 5)}</td>
      <td>{row.funding_source_code}</td>
      <td><input className="fbr-input" type="number" style={{ width: 150 }} value={amount} onChange={e => setAmount(e.target.value)} /></td>
      <td>
        <select className="select-input" value={status} onChange={e => setStatus(e.target.value)}>
          {['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'ADJUSTED', 'MISSED'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </td>
      <td><button className="fbr-btn" disabled={saving} onClick={() => onSave({ scheduled_amount: Number(amount), status, funding_source_code: row.funding_source_code, scheduled_time: row.scheduled_time })}>{saving ? '…' : 'Simpan'}</button></td>
    </tr>
  );
}
