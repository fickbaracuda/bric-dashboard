import { useState, useEffect, useCallback } from 'react';
import Layout from '../components/Layout';
import { getUser } from '../utils/auth';
import {
  getBctSummary, getBctBankDetail, createBctSnapshot, getBctPolicy, updateBctPolicy,
  createBctTopup, getBctTopups, requestBctTopup, approveBctTopup, rejectBctTopup,
  transferBctTopup, confirmBctTopupBalance, completeBctTopup, cancelBctTopup,
  getBctAlerts, acknowledgeBctAlert, snoozeBctAlert, resolveBctAlert, createBctBank,
  refreshBctForecast,
} from '../services/api';

const COLOR = '#0D9488';

const TABS = [
  { key: 'dashboard', label: 'Dashboard', icon: 'ti-building-bank' },
  { key: 'detail', label: 'Monitoring Saldo', icon: 'ti-activity' },
  { key: 'topup', label: 'Top Up', icon: 'ti-transfer-in' },
  { key: 'alerts', label: 'Alert', icon: 'ti-bell-ringing' },
];

const STATUS_META = {
  SAFE:                    { label: 'Aman',              color: '#059669', bg: '#DCFCE7' },
  WATCH:                   { label: 'Waspada',           color: '#B45309', bg: '#FEF3C7' },
  TOP_UP_RECOMMENDED:      { label: 'Perlu Top Up',       color: '#D97706', bg: '#FFEDD5' },
  CRITICAL:                { label: 'Kritis',             color: '#DC2626', bg: '#FEE2E2' },
  EMERGENCY:               { label: 'Darurat',            color: '#FFFFFF', bg: '#991B1B' },
  SUDDEN_DROP:             { label: 'Penurunan Mendadak', color: '#FFFFFF', bg: '#B91C1C' },
  EXCESS_BALANCE:          { label: 'Saldo Berlebih',     color: '#2563EB', bg: '#DBEAFE' },
  DATA_STALE:              { label: 'Data Kedaluwarsa',   color: '#7C3AED', bg: '#EDE9FE' },
  SYNC_ERROR:              { label: 'Gagal Sync',         color: '#991B1B', bg: '#FEE2E2' },
  CONFIGURATION_REQUIRED:  { label: 'Perlu Konfigurasi',  color: '#6B7280', bg: '#F3F4F6' },
};
function statusMeta(s) { return STATUS_META[s] || { label: s || '-', color: '#6B7280', bg: '#F3F4F6' }; }

const TOPUP_STATUS_META = {
  DRAFT:              { label: 'Draft',               color: '#6B7280', bg: '#F3F4F6' },
  REQUESTED:          { label: 'Diajukan',             color: '#B45309', bg: '#FEF3C7' },
  APPROVED:           { label: 'Disetujui',            color: '#2563EB', bg: '#DBEAFE' },
  TRANSFERRED:        { label: 'Sudah Transfer',       color: '#7C3AED', bg: '#EDE9FE' },
  BALANCE_CONFIRMED:  { label: 'Saldo Terkonfirmasi',  color: '#0891B2', bg: '#CFFAFE' },
  COMPLETED:          { label: 'Selesai',              color: '#059669', bg: '#DCFCE7' },
  REJECTED:           { label: 'Ditolak',              color: '#DC2626', bg: '#FEE2E2' },
  CANCELLED:          { label: 'Dibatalkan',           color: '#6B7280', bg: '#F3F4F6' },
};
function topupMeta(s) { return TOPUP_STATUS_META[s] || { label: s || '-', color: '#6B7280', bg: '#F3F4F6' }; }

const MOVEMENT_CLASSIFICATION_LABEL = {
  NO_PREVIOUS: { label: 'Tidak ada pembanding', color: 'var(--text-4)' },
  NO_CHANGE: { label: 'Tidak ada perubahan', color: 'var(--text-3)' },
  RECONCILIATION_DATA_UNAVAILABLE: { label: 'Data rekonsiliasi tidak tersedia', color: '#B45309' },
  CONSISTENT_WITH_VERIFIED_TRANSACTIONS: { label: 'Konsisten dgn transaksi terverifikasi', color: '#059669' },
  LIKELY_INCOMING_FUNDS_UNVERIFIED: { label: 'Kemungkinan dana masuk (belum terverifikasi penuh)', color: '#2563EB' },
  LIKELY_OPERATIONAL_OUTFLOW_UNVERIFIED: { label: 'Kemungkinan transaksi operasional (belum terverifikasi penuh)', color: '#DC2626' },
};
function movementClassificationMeta(c) {
  return MOVEMENT_CLASSIFICATION_LABEL[c] || { label: c || '-', color: 'var(--text-4)' };
}

const ALERT_TYPE_LABEL = {
  LOW_BALANCE: 'Saldo Rendah', CRITICAL_BALANCE: 'Saldo Kritis', EXCESS_BALANCE: 'Saldo Berlebih',
  DATA_STALE: 'Data Kedaluwarsa', SYNC_ERROR: 'Gagal Sync',
};
const ALERT_STATUS_META = {
  OPEN: { label: 'Terbuka', color: '#DC2626', bg: '#FEE2E2' },
  ACKNOWLEDGED: { label: 'Diketahui', color: '#B45309', bg: '#FEF3C7' },
  RESOLVED: { label: 'Selesai', color: '#059669', bg: '#DCFCE7' },
};

function fmtRp(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '-';
  return `Rp ${Math.round(n).toLocaleString('id-ID')}`;
}
function fmtDateTime(v) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' WIB';
}

function StatusBadge({ status }) {
  const m = statusMeta(status);
  return <span className="bct-badge" style={{ color: m.color, background: m.bg }}>{m.label}</span>;
}
function TopupBadge({ status }) {
  const m = topupMeta(status);
  return <span className="bct-badge" style={{ color: m.color, background: m.bg }}>{m.label}</span>;
}
function AlertStatusBadge({ status }) {
  const m = ALERT_STATUS_META[status] || { label: status, color: '#6B7280', bg: '#F3F4F6' };
  return <span className="bct-badge" style={{ color: m.color, background: m.bg }}>{m.label}</span>;
}

function Kpi({ label, value, sub, alert }) {
  return (
    <div className={'bct-kpi-card' + (alert ? ' bct-kpi-card--alert' : '')}>
      <div className="bct-kpi-label">{label}</div>
      <div className="bct-kpi-value">{value}</div>
      {sub && <div className="bct-kpi-sub">{sub}</div>}
    </div>
  );
}

export default function WarRoomBalanceControlTower() {
  const user = getUser();
  const isAdmin = user?.role === 'admin';
  const isFinance = user?.unit === 'FA' || isAdmin;
  const isOps = user?.unit === 'OP' || user?.unit === 'FA' || isAdmin;

  const [tab, setTab] = useState('dashboard');
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [selectedBankId, setSelectedBankId] = useState(null);
  const [bankDetail, setBankDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [topups, setTopups] = useState([]);
  const [alerts, setAlerts] = useState([]);

  const [modal, setModal] = useState(null); // { type, ... }
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState(null);

  const loadSummary = useCallback(() => {
    setLoading(true);
    setError(null);
    getBctSummary()
      .then(d => {
        setSummary(d);
        if (!selectedBankId && d.banks?.length) setSelectedBankId(d.banks[0].id);
      })
      .catch(e => setError(e.response?.data?.error || 'Gagal memuat data Balance Control Tower.'))
      .finally(() => setLoading(false));
  }, [selectedBankId]);

  const loadDetail = useCallback((bankId) => {
    if (!bankId) return;
    setDetailLoading(true);
    getBctBankDetail(bankId)
      .then(setBankDetail)
      .catch(() => setBankDetail(null))
      .finally(() => setDetailLoading(false));
  }, []);

  const loadTopups = useCallback(() => {
    getBctTopups().then(d => setTopups(d.topups || [])).catch(() => setTopups([]));
  }, []);

  const loadAlerts = useCallback(() => {
    getBctAlerts().then(d => setAlerts(d.alerts || [])).catch(() => setAlerts([]));
  }, []);

  useEffect(() => { loadSummary(); }, []);
  useEffect(() => { if (tab === 'detail' && selectedBankId) loadDetail(selectedBankId); }, [tab, selectedBankId]);
  useEffect(() => { if (tab === 'topup') loadTopups(); }, [tab]);
  useEffect(() => { if (tab === 'alerts') loadAlerts(); }, [tab]);

  function refreshAll() {
    loadSummary();
    if (selectedBankId) loadDetail(selectedBankId);
    loadTopups();
    loadAlerts();
  }

  function closeModal() { setModal(null); setActionError(null); }

  async function runAction(fn, successMsg) {
    setActionLoading(true);
    setActionError(null);
    try {
      await fn();
      closeModal();
      refreshAll();
    } catch (e) {
      setActionError(e.response?.data?.error || e.response?.data?.message || 'Aksi gagal, coba lagi.');
    } finally {
      setActionLoading(false);
    }
  }

  const banks = summary?.banks || [];
  const selectedBank = banks.find(b => b.id === selectedBankId) || null;

  return (
    <Layout>
      <div className="page-header">
        <div>
          <div className="page-title">Balance Control Tower</div>
          <div className="page-sub">Monitoring saldo bank lintas rekening &amp; workflow top up — Rekonsiliasi</div>
        </div>
        <button className="fbr-btn" onClick={refreshAll} disabled={loading}>
          <i className="ti ti-refresh" /> {loading ? 'Memuat…' : 'Refresh'}
        </button>
      </div>

      <div className="wrr-tabs">
        {TABS.map(t => (
          <button key={t.key} className={'wrr-tab-btn' + (tab === t.key ? ' wrr-tab-btn--active' : '')} onClick={() => setTab(t.key)}>
            <i className={'ti ' + t.icon} /> {t.label}
          </button>
        ))}
      </div>

      {error && <div className="fbr-error" style={{ marginBottom: 12 }}>{error}</div>}

      {loading && !summary ? (
        <div className="loading-wrap"><div className="loading-spinner" /><div className="loading-text">Memuat data…</div></div>
      ) : (
        <>
          {tab === 'dashboard' && (
            <DashboardTab
              summary={summary}
              onSelectBank={(id) => { setSelectedBankId(id); setTab('detail'); }}
              isAdmin={isAdmin}
              onAddBank={() => setModal({ type: 'add-bank' })}
            />
          )}

          {tab === 'detail' && (
            <DetailTab
              banks={banks}
              selectedBankId={selectedBankId}
              onSelectBank={setSelectedBankId}
              detail={bankDetail}
              loading={detailLoading}
              isOps={isOps}
              isAdmin={isAdmin}
              onInputSnapshot={() => setModal({ type: 'snapshot', bankId: selectedBankId })}
              onEditPolicy={() => setModal({ type: 'policy', bankId: selectedBankId })}
              onCreateTopup={() => setModal({ type: 'create-topup', bankId: selectedBankId })}
              onForecastRefreshed={() => loadDetail(selectedBankId)}
            />
          )}

          {tab === 'topup' && (
            <TopupTab
              topups={topups}
              banks={banks}
              user={user}
              isFinance={isFinance}
              isOps={isOps}
              onCreate={() => setModal({ type: 'create-topup', bankId: selectedBankId || banks[0]?.id })}
              onAction={(type, topup) => setModal({ type, topup })}
            />
          )}

          {tab === 'alerts' && (
            <AlertsTab
              alerts={alerts}
              isOps={isOps}
              onAcknowledge={(id) => runAction(() => acknowledgeBctAlert(id))}
              onSnooze={(id, until) => runAction(() => snoozeBctAlert(id, until))}
              onResolve={(id, reason) => runAction(() => resolveBctAlert(id, reason))}
            />
          )}
        </>
      )}

      {modal && (
        <Modal
          modal={modal}
          banks={banks}
          bankDetail={bankDetail}
          onClose={closeModal}
          loading={actionLoading}
          error={actionError}
          run={runAction}
        />
      )}
    </Layout>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function DashboardTab({ summary, onSelectBank, isAdmin, onAddBank }) {
  if (!summary) return null;
  const banks = summary.banks || [];
  return (
    <>
      <div className="bct-kpi-grid">
        <Kpi label="Total Saldo Bank" value={fmtRp(summary.total_saldo_bank)} />
        <Kpi label="Total Saldo Efektif" value={fmtRp(summary.total_saldo_efektif)} />
        <Kpi label="Total Top Up Hari Ini" value={fmtRp(summary.total_topup_hari_ini)} />
        <Kpi label="Bank Perlu Perhatian" value={summary.bank_perlu_perhatian} alert={summary.bank_perlu_perhatian > 0} />
        <Kpi label="Alert Aktif" value={summary.alert_aktif} alert={summary.alert_aktif > 0} />
      </div>

      <div className="wr-table-section">
        <div className="wr-table-controls">
          <div className="wr-table-left"><b>Posisi Saldo Bank</b> ({banks.length})</div>
          {isAdmin && (
            <button className="fbr-btn fbr-btn-primary" onClick={onAddBank}>
              <i className="ti ti-plus" /> Tambah Bank
            </button>
          )}
        </div>
        <div className="wr-table-wrap">
          <table className="wr-table">
            <thead>
              <tr>
                <th>Bank</th><th>Rekening</th><th>Saldo Tersedia</th><th>Saldo Tertahan</th>
                <th>Transaksi Pending</th><th>Saldo Cadangan</th><th>Saldo Efektif</th>
                <th>Top Up Hari Ini</th><th>Status</th><th>Update Terakhir</th>
              </tr>
            </thead>
            <tbody>
              {banks.length === 0 ? (
                <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>Belum ada bank terdaftar.</td></tr>
              ) : banks.map(b => (
                <tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => onSelectBank(b.id)}>
                  <td>{b.bank_name} <span style={{ color: 'var(--text-4)' }}>({b.bank_code})</span></td>
                  <td>{b.account_number}</td>
                  <td>{fmtRp(b.available_balance)}</td>
                  <td>{fmtRp(b.held_balance)}</td>
                  <td>{fmtRp(b.pending_amount)}</td>
                  <td>{fmtRp(b.reserve_balance)}</td>
                  <td><b>{fmtRp(b.effective_balance)}</b></td>
                  <td>{fmtRp(b.top_up_hari_ini)}</td>
                  <td><StatusBadge status={b.status} /></td>
                  <td>{fmtDateTime(b.last_captured_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function DetailTab({ banks, selectedBankId, onSelectBank, detail, loading, isOps, isAdmin, onInputSnapshot, onEditPolicy, onCreateTopup, onForecastRefreshed }) {
  return (
    <>
      <div className="header-controls" style={{ marginBottom: 16 }}>
        <select className="select-input" value={selectedBankId || ''} onChange={e => onSelectBank(Number(e.target.value))}>
          {banks.map(b => <option key={b.id} value={b.id}>{b.bank_name} — {b.account_number}</option>)}
        </select>
        {isOps && (
          <button className="fbr-btn" onClick={onInputSnapshot}>
            <i className="ti ti-cash-register" /> {detail?.operational ? 'Input Saldo Manual (Darurat)' : 'Input Saldo'}
          </button>
        )}
        {isAdmin && <button className="fbr-btn" onClick={onEditPolicy}><i className="ti ti-settings" /> Atur Policy</button>}
        {isOps && <button className="fbr-btn fbr-btn-primary" onClick={onCreateTopup}><i className="ti ti-transfer-in" /> Ajukan Top Up</button>}
      </div>

      {loading ? (
        <div className="loading-wrap"><div className="loading-spinner" /><div className="loading-text">Memuat detail…</div></div>
      ) : !detail ? (
        <div className="empty-state"><div className="empty-icon">🏦</div><div className="empty-title">Pilih bank</div></div>
      ) : (
        <>
          <FaActionSummary detail={detail} isOps={isOps} onCreateTopup={onCreateTopup} onEditPolicy={onEditPolicy} onForecastRefreshed={onForecastRefreshed} isAdmin={isAdmin} />

          <div className="bct-kpi-grid">
            <Kpi label="Saldo Tersedia" value={fmtRp(detail.posisi_saldo_terbaru?.available_balance)} sub={fmtDateTime(detail.posisi_saldo_terbaru?.captured_at)} />
            <Kpi label="Saldo Efektif" value={fmtRp(detail.posisi_saldo_terbaru?.effective_balance)} />
            <Kpi label="Penggunaan Saldo Hari Ini" value={detail.penggunaan_saldo_hari_ini === null ? '-' : fmtRp(detail.penggunaan_saldo_hari_ini)} />
            <Kpi label="Total Top Up Hari Ini" value={fmtRp(detail.total_topup_hari_ini)} />
            <Kpi label="Status" value={<StatusBadge status={detail.status} />} />
          </div>

          {!detail.policy?.is_active && (
            <div className="fbr-error" style={{ marginBottom: 16 }}>
              Bank ini belum punya policy aktif — status akan selalu <b>CONFIGURATION_REQUIRED</b> sampai admin mengatur threshold.
            </div>
          )}

          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '4px 0 8px' }}>
            Historical &amp; Planning Analytics <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— burn rata-rata 14 hari, bukan pemicu keputusan top-up saat ini</span>
          </div>
          <ForecastPanel bankId={selectedBankId} detail={detail} isOps={isOps} onRefreshed={onForecastRefreshed} />

          <div className="wr-table-section" style={{ marginBottom: 16 }}>
            <div className="wr-table-controls"><div className="wr-table-left"><b>Top Up Terakhir</b></div></div>
            <div style={{ padding: 16 }}>
              {detail.top_up_terakhir ? (
                <div>
                  {fmtRp(detail.top_up_terakhir.actual_amount || detail.top_up_terakhir.approved_amount || detail.top_up_terakhir.requested_amount)}
                  {' '}<TopupBadge status={detail.top_up_terakhir.status} />
                  {' '}— {fmtDateTime(detail.top_up_terakhir.transferred_at)}
                </div>
              ) : <span style={{ color: 'var(--text-3)' }}>Belum ada riwayat top up.</span>}
            </div>
          </div>

          <div className="wr-table-section" style={{ marginBottom: 16 }}>
            <div className="wr-table-controls"><div className="wr-table-left"><b>Alert Aktif</b> ({detail.alert_aktif?.length || 0})</div></div>
            <div className="wr-table-wrap">
              <table className="wr-table">
                <thead><tr><th>Tipe</th><th>Status</th><th>Dibuat</th><th>Owner</th></tr></thead>
                <tbody>
                  {(detail.alert_aktif || []).length === 0
                    ? <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 16 }}>Tidak ada alert aktif.</td></tr>
                    : detail.alert_aktif.map(a => (
                      <tr key={a.id}>
                        <td>{ALERT_TYPE_LABEL[a.alert_type] || a.alert_type}</td>
                        <td><AlertStatusBadge status={a.status} /></td>
                        <td>{fmtDateTime(a.created_at)}</td>
                        <td>{a.owner || '-'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="wr-table-section" style={{ marginBottom: 16 }}>
            <div className="wr-table-controls"><div className="wr-table-left"><b>Riwayat Snapshot</b> ({detail.riwayat_snapshot?.length || 0})</div></div>
            <div className="wr-table-wrap">
              <table className="wr-table">
                <thead>
                  <tr>
                    <th>Waktu</th><th>Tersedia</th><th>Δ</th><th>Δ%</th><th>Tertahan</th><th>Pending</th><th>Cadangan</th><th>Efektif</th>
                    <th>FP Matched</th><th>Fee</th><th>Funding Credit</th><th>Unmatched/Unknown</th><th>Klasifikasi Pergerakan</th>
                    <th>Sumber</th><th>Sync</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.riwayat_snapshot || []).slice(0, 30).map(s => {
                    const m = s.movement;
                    const cls = movementClassificationMeta(s.movement_classification);
                    return (
                      <tr key={s.id}>
                        <td>{fmtDateTime(s.captured_at)}</td>
                        <td>{fmtRp(s.available_balance)}</td>
                        <td style={{ color: m?.delta_amount > 0 ? '#059669' : (m?.delta_amount < 0 ? '#DC2626' : 'var(--text-3)') }}>
                          {m?.delta_amount !== null && m?.delta_amount !== undefined ? `${m.delta_amount > 0 ? '+' : ''}${fmtRp(m.delta_amount)}` : '-'}
                        </td>
                        <td>{m?.delta_percentage !== null && m?.delta_percentage !== undefined ? `${m.delta_percentage.toFixed(1)}%` : '-'}</td>
                        <td>{fmtRp(s.held_balance)}</td>
                        <td>{fmtRp(s.pending_amount)}</td>
                        <td>{fmtRp(s.reserve_balance)}</td>
                        <td><b>{fmtRp(s.effective_balance)}</b></td>
                        <td>{s.matched_principal_outflow_interval !== null && s.matched_principal_outflow_interval !== undefined ? fmtRp(s.matched_principal_outflow_interval) : '-'}</td>
                        <td>{s.verified_fee_outflow_interval !== null && s.verified_fee_outflow_interval !== undefined ? fmtRp(s.verified_fee_outflow_interval) : '-'}</td>
                        <td>{s.funding_credit_interval !== null && s.funding_credit_interval !== undefined ? fmtRp(s.funding_credit_interval) : '-'}</td>
                        <td>{s.unmatched_or_unknown_movement_interval !== null && s.unmatched_or_unknown_movement_interval !== undefined ? fmtRp(s.unmatched_or_unknown_movement_interval) : '-'}</td>
                        <td><span style={{ color: cls.color, fontWeight: 600, fontSize: 12 }}>{cls.label}</span></td>
                        <td>{s.source}</td>
                        <td>{s.sync_status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="wr-table-section">
            <div className="wr-table-controls"><div className="wr-table-left"><b>Riwayat Top Up</b> ({detail.riwayat_topup?.length || 0})</div></div>
            <div className="wr-table-wrap">
              <table className="wr-table">
                <thead><tr><th>Diajukan</th><th>Requester</th><th>Jumlah</th><th>Status</th><th>Approver</th></tr></thead>
                <tbody>
                  {(detail.riwayat_topup || []).length === 0
                    ? <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 16 }}>Belum ada riwayat top up.</td></tr>
                    : detail.riwayat_topup.map(t => (
                      <tr key={t.id}>
                        <td>{fmtDateTime(t.created_at)}</td>
                        <td>{t.requester_username || '-'}</td>
                        <td>{fmtRp(t.actual_amount || t.approved_amount || t.requested_amount)}</td>
                        <td><TopupBadge status={t.status} /></td>
                        <td>{t.approver_username || '-'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// FA Action Layer — lapisan keputusan operasional utama utk staf Finance
// Administration/Treasury, ditempatkan di ATAS Control Tower Analytics yang
// sudah ada (tidak menghapus/menggantikan apa pun di bawahnya). SELURUH
// angka di sini murni render dari backend (detail.operational, hasil
// backend/src/balanceControlTower/calculationEngine.js) -- TIDAK ADA
// kalkulasi status/rekomendasi di frontend.
// ─────────────────────────────────────────────────────────────────────────
const ACTION_LABEL = {
  SAFE: { label: 'Top-up Belum Diperlukan', icon: 'ti-circle-check', tone: 'safe' },
  WATCH: { label: 'Siapkan Top-up', icon: 'ti-alert-triangle', tone: 'watch' },
  CRITICAL: { label: 'Proses Top-up Sekarang', icon: 'ti-alert-octagon', tone: 'critical' },
  EMERGENCY: { label: 'Pendanaan Darurat Diperlukan', icon: 'ti-flame', tone: 'critical' },
  DATA_STALE: { label: 'Refresh Rekonsiliasi', icon: 'ti-refresh', tone: 'stale' },
  CONFIGURATION_REQUIRED: { label: 'Lengkapi Konfigurasi', icon: 'ti-settings', tone: 'stale' },
};
function actionMeta(status) {
  return ACTION_LABEL[status] || { label: '-', icon: 'ti-help', tone: 'stale' };
}
function maskAccountNumber(acc) {
  if (!acc) return '-';
  const digits = String(acc).replace(/\D/g, '');
  if (digits.length < 4) return acc;
  return acc.replace(digits.slice(0, -4), m => '•'.repeat(m.length));
}
function trendLabel(trend) {
  if (trend === 'ACCELERATING') return { label: 'Percepatan', color: '#DC2626' };
  if (trend === 'DECELERATING') return { label: 'Perlambatan', color: '#059669' };
  if (trend === 'STABLE') return { label: 'Stabil', color: 'var(--text-2)' };
  return { label: '-', color: 'var(--text-3)' };
}

/** value kalau ada, kalau tidak tampilkan alasan spesifik (BUKAN cuma "-") -- inti perbaikan kalkulasi parsial. */
function KpiVal({ value, formatter, reason, fallback = 'Belum dapat dihitung' }) {
  if (value !== null && value !== undefined) return formatter(value);
  return <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-4)' }}>{reason || fallback}</span>;
}

function DeltaSaldoCard({ movement }) {
  if (!movement) return null;
  if (movement.delta_amount === null) {
    return <Kpi label="Δ Saldo" value={<span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-4)' }}>{movement.reason || 'Belum ada pembanding'}</span>} />;
  }
  const isUp = movement.direction === 'UP';
  const isDown = movement.direction === 'DOWN';
  const color = isDown ? '#DC2626' : (isUp ? '#059669' : 'var(--text-2)');
  const sign = movement.delta_amount > 0 ? '+' : '';
  return (
    <Kpi
      label="Δ Saldo"
      value={<span style={{ color, fontWeight: 800 }}>{sign}{fmtRp(movement.delta_amount)}</span>}
      sub={`sejak ${fmtDateTime(movement.previous_captured_at)}${movement.delta_percentage !== null ? ` (${sign}${movement.delta_percentage.toFixed(1)}%)` : ''}`}
      alert={isDown && Math.abs(movement.delta_percentage || 0) > 0}
    />
  );
}

function FaActionSummary({ detail, isOps, onCreateTopup, onEditPolicy, onForecastRefreshed, isAdmin }) {
  const op = detail.operational;
  const status = detail.status;
  const action = actionMeta(status);
  const rp = (v) => fmtRp(v);
  const mins = (v) => fmtMinutes(v);

  return (
    <div className="wr-table-section" style={{ marginBottom: 16, borderWidth: 2 }}>
      <div className="wr-table-controls">
        <div className="wr-table-left">
          <b>FA Action Summary</b> <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>— {maskAccountNumber(detail.bank?.account_number)} · {detail.bank?.account_name}</span>
        </div>
        <StatusBadge status={status} />
      </div>

      <div style={{ padding: 16 }}>
        {/* Δ Saldo -- independen dari mesin operasional, tampil selama ada ≥2 snapshot valid utk bank apa pun (item 6). */}
        <div className="bct-kpi-grid" style={{ marginBottom: 14 }}>
          <DeltaSaldoCard movement={detail.balance_movement} />
        </div>

        {!op ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>
            Mesin kalkulasi operasional belum tersedia utk bank ini (belum didukung integrasi rekonsiliasi). Status memakai policy manual saja.
          </div>
        ) : (
          <>
            <div className="bct-kpi-grid" style={{ marginBottom: 14 }}>
              <Kpi label="Saldo Tersedia (Actual)" value={rp(op.available_balance)} sub={fmtDateTime(op.balance_source_timestamp)} />
              <Kpi label="Batas Minimum Terlindungi" value={<KpiVal value={op.absolute_minimum_balance} formatter={rp} reason={op.absolute_minimum_balance_unavailable_reason} />} />
              <Kpi label="Saldo Bisa Dipakai" value={<KpiVal value={op.usable_balance} formatter={rp} reason={op.usable_balance_unavailable_reason} />} alert={Number(op.usable_balance) <= 0} />
              <Kpi label="Tren Transaksi" value={<span style={{ color: trendLabel(op.burn_trend).color, fontWeight: 700 }}>{trendLabel(op.burn_trend).label}</span>}
                sub={op.acceleration_detected ? 'akselerasi terdeteksi' : null} />
            </div>

            {/* 4 window outflow mentah -- SELALU tampil kalau ada data, independen dari burn_window_minutes policy (item 1/7 spec). */}
            <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-4)', textTransform: 'uppercase', letterSpacing: '.03em', margin: '2px 0 6px' }}>Outflow Intraday (mentah, 4 window)</div>
            <div className="bct-kpi-grid" style={{ marginBottom: 14 }}>
              <Kpi label="Outflow 5 Menit" value={rp(op.burn_rate_per_5_minutes !== null ? op.burn_rate_per_5_minutes * 5 : null)} sub={op.burn_rate_per_5_minutes !== null ? `${rp(op.burn_rate_per_5_minutes)}/menit` : 'tidak ada transaksi matched'} />
              <Kpi label="Outflow 15 Menit" value={rp(op.burn_rate_per_15_minutes !== null ? op.burn_rate_per_15_minutes * 15 : null)} sub={op.burn_rate_per_15_minutes !== null ? `${rp(op.burn_rate_per_15_minutes)}/menit` : 'tidak ada transaksi matched'} />
              <Kpi label="Outflow 30 Menit" value={rp(op.burn_rate_per_30_minutes !== null ? op.burn_rate_per_30_minutes * 30 : null)} sub={op.burn_rate_per_30_minutes !== null ? `${rp(op.burn_rate_per_30_minutes)}/menit` : 'tidak ada transaksi matched'} />
              <Kpi label="Outflow 60 Menit" value={rp(op.burn_rate_per_60_minutes !== null ? op.burn_rate_per_60_minutes * 60 : null)} sub={op.burn_rate_per_60_minutes !== null ? `${rp(op.burn_rate_per_60_minutes)}/menit` : 'tidak ada transaksi matched'} />
              <Kpi label="Burn Rate Operasional Terpilih" value={<KpiVal value={op.burn_rate_per_minute} formatter={(v) => `${rp(v)}/menit`} reason={op.burn_rate_unavailable_reason} />}
                sub={op.selected_burn_window_minutes ? `window ${op.selected_burn_window_minutes} menit` : null} />
            </div>

            {/* Penggunaan Saldo Hari Ini -- independen dari burn_window_minutes (item 4 spec), reconciliation-sourced. */}
            <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-4)', textTransform: 'uppercase', letterSpacing: '.03em', margin: '2px 0 6px' }}>Penggunaan Saldo Hari Ini</div>
            <div className="bct-kpi-grid" style={{ marginBottom: 14 }}>
              {op.today_usage ? (
                <>
                  <Kpi label="FP Matched — Principal" value={rp(op.today_usage.matched_principal_outflow_today)} sub={`${op.today_usage.matched_transaction_count_today} transaksi matched`} />
                  <Kpi label="Fee Terverifikasi" value={rp(op.today_usage.verified_fee_outflow_today)} />
                  <Kpi label="Outflow Operasional Lain" value={rp(op.today_usage.other_verified_operational_outflow_today)} />
                  <Kpi label="Unmatched / Anomali" value={op.today_usage.unmatched_or_anomaly_debit_today === null ? <KpiVal value={null} reason="Total bank debit belum tersedia" /> : rp(op.today_usage.unmatched_or_anomaly_debit_today)}
                    alert={Number(op.today_usage.unmatched_or_anomaly_debit_today) > 0} />
                  <Kpi label="Total Bank Debit Hari Ini" value={<KpiVal value={op.today_usage.total_bank_debit_today} formatter={rp} reason="Belum tersedia dari statement bank" />} sub={op.today_usage.business_date} />
                </>
              ) : (
                <Kpi label="Total Bank Debit Hari Ini" value={<KpiVal value={null} reason="Data posisi saldo belum tersedia" />} />
              )}
            </div>

            <div className="bct-kpi-grid" style={{ marginBottom: 14 }}>
              <Kpi label="Runway ke Batas Minimum" value={<KpiVal value={op.usable_runway_minutes} formatter={mins} reason={op.runway_unavailable_reason || (op.usable_runway_minutes === null ? 'Tidak ada outflow aktif' : null)} />}
                sub={op.minimum_balance_breach_time ? `≈ ${fmtDateTime(op.minimum_balance_breach_time)}` : null} />
              <Kpi label="Runway ke Saldo Nol" value={<KpiVal value={op.zero_balance_runway_minutes} formatter={mins} reason={op.burn_rate_unavailable_reason} />} />
              <Kpi label="Rekomendasi Top-up" value={<KpiVal value={op.recommended_topup} formatter={rp} reason={op.recommended_topup_unavailable_reason} />} alert={Number(op.recommended_topup) > 0}
                sub={op.topup_deadline ? `Top-up sebelum ${fmtDateTime(op.topup_deadline)}` : null} />
              <Kpi label="Lead Time Top-up" value={<KpiVal value={op.topup_lead_time_minutes} formatter={mins} reason={op.topup_lead_time_unavailable_reason} />} />
              <Kpi label="Safety Buffer" value={<KpiVal value={op.safety_buffer_amount} formatter={rp} reason={op.recommended_topup_unavailable_reason} />} sub={op.safety_buffer_type ? `mode ${op.safety_buffer_type}` : null} />
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              {isOps && (status === 'CRITICAL' || status === 'EMERGENCY' || status === 'WATCH') && (
                <button className="fbr-btn fbr-btn-primary" onClick={onCreateTopup}>
                  <i className={'ti ' + action.icon} /> {action.label}
                </button>
              )}
              {status === 'DATA_STALE' && isOps && (
                <button className="fbr-btn fbr-btn-primary" onClick={onForecastRefreshed}>
                  <i className="ti ti-refresh" /> {action.label}
                </button>
              )}
              {status === 'CONFIGURATION_REQUIRED' && isAdmin && (
                <button className="fbr-btn fbr-btn-primary" onClick={onEditPolicy}>
                  <i className="ti ti-settings" /> Lengkapi Kebijakan Operasional
                </button>
              )}
              {status === 'SAFE' && <span className="bct-badge" style={{ color: '#059669', background: '#DCFCE7' }}><i className="ti ti-circle-check" /> {action.label}</span>}
            </div>

            {op.status_reason && (
              <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>{op.status_reason}</div>
            )}
            {!!(op.missing_configuration && op.missing_configuration.length) && (
              <div className="fbr-error" style={{ marginTop: 10, background: '#F3F4F6', color: 'var(--text-2)', borderRadius: 8, padding: '10px 12px' }}>
                <b>Konfigurasi yang masih kurang:</b> {op.missing_configuration.join(', ')}.
              </div>
            )}
            {op.movement_variance && (
              <div className="fbr-error" style={{ marginTop: 10 }}>
                Available Balance tetap dipakai sbg saldo aktual. Terdeteksi selisih movement-summary: {fmtRp(op.movement_variance.variance_amount)} ({op.movement_variance.variance_percentage}%) — butuh review rekonsiliasi.
              </div>
            )}

            {/* Footer -- refresh-on-read disclosure (spec item wajib: JANGAN terkesan real-time monitoring proaktif). */}
            <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 11, color: 'var(--text-4)' }}>
              <span>calculation_version {op.calculation_version}</span>
              <span>dihitung {fmtDateTime(op.calculation_timestamp)}</span>
              <span>sumber saldo {fmtDateTime(op.balance_source_timestamp)}</span>
              <span>freshness: {op.data_freshness_status || '-'}</span>
              <span style={{ fontStyle: 'italic' }}>Perhitungan diperbarui saat halaman dimuat atau tombol Refresh digunakan — belum ada pemantauan proaktif otomatis.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Forecast — OCBC Rekonsiliasi sbg source (burn rate/kebutuhan dana/runway),
// Balance Control Tower sbg control room (status/rekomendasi/audit).
// Label wajib beda: Finance Policy (manual, selalu ada) / System Forecast
// (dihitung dari data) / Manual Override (Finance menimpa nilai dinamis) /
// Actual Balance (angka riil dari snapshot).
// ─────────────────────────────────────────────────────────────────────────
const THRESHOLD_SOURCE_LABEL = {
  MANUAL_OVERRIDE: { label: 'Manual Override', color: '#7C3AED', bg: '#EDE9FE' },
  SYSTEM_FORECAST: { label: 'System Forecast', color: '#0891B2', bg: '#CFFAFE' },
};
function SourceTag({ source }) {
  if (!source) return <span style={{ color: 'var(--text-4)' }}>—</span>;
  const m = THRESHOLD_SOURCE_LABEL[source] || { label: source, color: '#6B7280', bg: '#F3F4F6' };
  return <span className="bct-badge" style={{ color: m.color, background: m.bg }}>{m.label}</span>;
}
function fmtMinutes(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '-';
  const n = Number(v);
  if (n < 60) return `${Math.round(n)} menit`;
  if (n < 1440) return `${(n / 60).toFixed(1)} jam`;
  return `${(n / 1440).toFixed(1)} hari`;
}
/**
 * Label deadline utk panel historis SAJA -- TIDAK PERNAH pakai kata "sebelum"
 * (itu khusus rekomendasi operasional FA Action Summary/op.topup_deadline).
 * Kalau waktu simulasi sudah lewat, dinyatakan eksplisit expired -- TIDAK
 * ditampilkan seolah masih jadi instruksi aktif (spec item 10).
 */
function forecastDeadlineLabel(deadline) {
  if (!deadline) return null;
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() < Date.now()) return `Waktu simulasi telah lewat (${fmtDateTime(deadline)})`;
  return `Waktu simulasi model historis: ${fmtDateTime(deadline)}`;
}

function ForecastPanel({ bankId, detail, isOps, onRefreshed }) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const [showDetail, setShowDetail] = useState(false);

  const forecast = detail?.forecast;
  const statusReason = detail?.status_reason;

  function handleRefresh() {
    setRefreshing(true);
    setRefreshError(null);
    refreshBctForecast(bankId)
      .then(() => onRefreshed && onRefreshed())
      .catch(e => setRefreshError(e.response?.data?.error || 'Gagal refresh forecast.'))
      .finally(() => setRefreshing(false));
  }

  return (
    <div className="wr-table-section" style={{ marginBottom: 16 }}>
      <div className="wr-table-controls">
        <div className="wr-table-left">
          <b>Simulasi &amp; Threshold Historis</b> <span className="bct-badge" style={{ color: '#0891B2', background: '#CFFAFE' }}>Sumber: OCBC Rekonsiliasi</span>
        </div>
        {isOps && (
          <button className="fbr-btn" onClick={handleRefresh} disabled={refreshing}>
            <i className="ti ti-refresh" /> {refreshing ? 'Memproses…' : 'Refresh Forecast'}
          </button>
        )}
      </div>

      <div style={{ padding: 16 }}>
        <div style={{ marginBottom: 14, fontSize: 12.5, color: '#0369A1', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8, padding: '10px 12px', lineHeight: 1.5 }}>
          Analitik berikut menggunakan pola historis (rata-rata burn 14 hari) untuk perencanaan, dan <b>tidak menentukan status atau rekomendasi top-up FA saat ini</b> — lihat FA Action Summary di atas untuk keputusan operasional.
        </div>

        {refreshError && <div className="fbr-error" style={{ marginBottom: 12 }}>{refreshError}</div>}

        {statusReason && (
          <div style={{ marginBottom: 14, fontSize: 13, color: 'var(--text-2)' }}>
            <b>Alasan status:</b> {statusReason}
          </div>
        )}

        {!forecast || !forecast.forecast_available ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>
            Analitik historis belum tersedia — {forecast?.forecast_unavailable_reason || 'belum ada data rekonsiliasi OCBC pada window terakhir.'}
            {' '}Threshold status memakai Finance Policy manual saja (kalau sudah diisi).
          </div>
        ) : (
          <>
            <div className="bct-kpi-grid">
              <Kpi label="Saldo Saat Ini (Actual Balance)" value={fmtRp(forecast.available_balance)} />
              <Kpi label="Saldo Efektif" value={fmtRp(forecast.effective_balance)} />
              <Kpi label="Proyeksi Historis 24 Jam" value={fmtRp(forecast.projected_balance_at_next_funding)} sub="berdasarkan burn rata-rata 14 hari, bukan burn real-time" />
              <Kpi label="Runway Teoretis (Rata-rata 14 Hari)" value={fmtMinutes(forecast.estimated_runway_minutes)} sub={forecast.estimated_runway_minutes === null ? 'burn rate 0 / tidak ada data' : 'model historis, bukan burn real-time'} />
              <Kpi label="Burn Rate Rata-rata" value={fmtRp(forecast.average_burn_rate) + '/hari'} />
              <Kpi label="Burn Rate Puncak" value={fmtRp(forecast.peak_burn_rate) + '/hari'} />
              <Kpi label="Kebutuhan Historis (Funding Window)" value={fmtRp(forecast.forecast_required_balance)} sub={`window ${forecast.funding_window_hours} jam${forecast.funding_window_is_default ? ' (default)' : ''}`} />
              <Kpi label="Reserve Dinamis (Historis, Analytics-Only)" value={fmtRp(forecast.dynamic_reserve_balance)} sub="tidak masuk formula recommended_topup operasional" />
              <Kpi label="Simulasi Kebutuhan Pendanaan Historis 24 Jam" value={fmtRp(forecast.recommended_topup_amount)}
                sub={forecastDeadlineLabel(forecast.recommended_topup_deadline)} />
            </div>
            <div style={{ marginTop: -8, marginBottom: 14, fontSize: 11.5, color: 'var(--text-4)', fontStyle: 'italic' }}>
              Bukan rekomendasi top-up operasional. Angka di atas adalah simulasi perencanaan dari model burn historis, terpisah dari FA Action Summary.
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12.5, color: 'var(--text-3)', marginBottom: 14 }}>
              <span>Dibuat: {fmtDateTime(forecast.forecast_generated_at)}</span>
              <span>Confidence: <b style={{ color: 'var(--text-1)' }}>{forecast.forecast_confidence}%</b></span>
              <span>Sudden Drop: {forecast.sudden_drop_amount !== null ? `${fmtRp(forecast.sudden_drop_amount)} (${forecast.sudden_drop_percentage?.toFixed(1)}%)` : 'tidak terdeteksi'}</span>
            </div>

            <div className="wr-table-wrap" style={{ marginBottom: 6 }}>
              <table className="wr-table">
                <thead><tr><th>Planning Threshold</th><th>Nilai Dipakai</th><th>Sumber</th></tr></thead>
                <tbody>
                  <tr><td>Planning Watch Threshold</td><td>{fmtRp(forecast.dynamic_watch_threshold)}</td><td><SourceTag source={forecast.thresholds_source?.watch} /></td></tr>
                  <tr><td>Planning Critical Threshold</td><td>{fmtRp(forecast.dynamic_critical_threshold)}</td><td><SourceTag source={forecast.thresholds_source?.critical} /></td></tr>
                  <tr><td>Planning Emergency Threshold</td><td>{fmtRp(forecast.dynamic_emergency_threshold)}</td><td><SourceTag source={forecast.thresholds_source?.emergency} /></td></tr>
                  <tr><td>Reserve Historis</td><td>{fmtRp(forecast.dynamic_reserve_balance)}</td><td><SourceTag source={forecast.thresholds_source?.reserve} /></td></tr>
                  <tr>
                    <td>Excess Balance / Stale After / Safety Buffer / Top-up Rounding</td>
                    <td colSpan={2}><span className="bct-badge" style={{ color: '#B45309', background: '#FEF3C7' }}>Finance Policy (manual)</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ marginBottom: 14, fontSize: 11.5, color: 'var(--text-4)', lineHeight: 1.6 }}>
              Planning Watch/Critical/Emergency Threshold = ambang perencanaan dari model historis (BUKAN status operasional saat ini — lihat status di FA Action Summary).
              Reserve Historis = cadangan hasil model volatilitas 14 hari, khusus perencanaan, tidak pernah dihitung dua kali dengan Safety Buffer operasional di FA Action Summary.
            </div>

            <details open={showDetail} onToggle={e => setShowDetail(e.target.open)}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13, color: 'var(--text-2)' }}>Detail Perhitungan (expand)</summary>
              <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.7 }}>
                <div>Window burn-rate: {forecast.calculation?.window_days} hari (coverage {forecast.calculation?.coverage?.included_days}/{forecast.calculation?.coverage?.selected_days} hari ada data)</div>
                <div>average_burn_rate = {forecast.calculation?.average_burn_rate_formula}</div>
                <div>forecast_required_balance = {forecast.calculation?.forecast_required_balance_formula}</div>
                <div>dynamic_reserve_balance = {forecast.calculation?.dynamic_reserve_balance_formula}</div>
                <div>dynamic_critical_threshold = {forecast.calculation?.dynamic_critical_threshold_formula}</div>
                <div>dynamic_emergency_threshold = {forecast.calculation?.dynamic_emergency_threshold_formula}</div>
                <div>dynamic_watch_threshold = {forecast.calculation?.dynamic_watch_threshold_formula}</div>
                <div>recommended_topup_amount = {forecast.calculation?.recommended_topup_formula}</div>
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
const NEXT_ACTIONS = {
  DRAFT: [{ type: 'request-topup', label: 'Ajukan', primary: true }, { type: 'cancel-topup', label: 'Batalkan' }],
  REQUESTED: [{ type: 'approve-topup', label: 'Setujui', primary: true, financeOnly: true }, { type: 'reject-topup', label: 'Tolak', financeOnly: true }, { type: 'cancel-topup', label: 'Batalkan' }],
  APPROVED: [{ type: 'transfer-topup', label: 'Tandai Transfer', primary: true, financeOnly: true }, { type: 'cancel-topup', label: 'Batalkan' }],
  TRANSFERRED: [{ type: 'confirm-topup', label: 'Konfirmasi Saldo Masuk', primary: true, financeOnly: true }],
  BALANCE_CONFIRMED: [{ type: 'complete-topup', label: 'Selesaikan', primary: true, financeOnly: true }],
};

function TopupTab({ topups, banks, user, isFinance, isOps, onCreate, onAction }) {
  const bankName = (id) => banks.find(b => b.id === id)?.bank_name || `Bank #${id}`;
  return (
    <div className="wr-table-section">
      <div className="wr-table-controls">
        <div className="wr-table-left"><b>Permintaan Top Up</b> ({topups.length})</div>
        {isOps && <button className="fbr-btn fbr-btn-primary" onClick={onCreate}><i className="ti ti-plus" /> Ajukan Top Up</button>}
      </div>
      <div className="wr-table-wrap">
        <table className="wr-table">
          <thead>
            <tr><th>Bank</th><th>Jumlah</th><th>Status</th><th>Requester</th><th>Approver</th><th>Dibuat</th><th>Aksi</th></tr>
          </thead>
          <tbody>
            {topups.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>Belum ada permintaan top up.</td></tr>
            ) : topups.map(t => {
              const isRequester = String(t.requester_user_id) === String(user?.id);
              const actions = (NEXT_ACTIONS[t.status] || []).filter(a => {
                if (a.financeOnly) return isFinance;
                if (a.type === 'request-topup' || a.type === 'cancel-topup') return isRequester || user?.role === 'admin';
                return true;
              });
              return (
                <tr key={t.id}>
                  <td>{bankName(t.bank_account_id)}</td>
                  <td>{fmtRp(t.actual_amount || t.approved_amount || t.requested_amount)}</td>
                  <td><TopupBadge status={t.status} /></td>
                  <td>{t.requester_username || '-'}</td>
                  <td>{t.approver_username || '-'}</td>
                  <td>{fmtDateTime(t.created_at)}</td>
                  <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {actions.map(a => (
                      <button key={a.type} className={'fbr-btn' + (a.primary ? ' fbr-btn-primary' : '')} style={{ padding: '4px 10px', fontSize: 12 }}
                        onClick={() => onAction(a.type, t)}>
                        {a.label}
                      </button>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function AlertsTab({ alerts, isOps, onAcknowledge, onSnooze, onResolve }) {
  const [reasonFor, setReasonFor] = useState(null);
  const [reasonText, setReasonText] = useState('');

  return (
    <div className="wr-table-section">
      <div className="wr-table-controls"><div className="wr-table-left"><b>Alert</b> ({alerts.length})</div></div>
      <div className="wr-table-wrap">
        <table className="wr-table">
          <thead><tr><th>Bank</th><th>Tipe</th><th>Status</th><th>Dibuat</th><th>Owner</th><th>Aksi</th></tr></thead>
          <tbody>
            {alerts.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>Tidak ada alert.</td></tr>
            ) : alerts.map(a => (
              <tr key={a.id}>
                <td>{a.bank_name} ({a.bank_code})</td>
                <td>{ALERT_TYPE_LABEL[a.alert_type] || a.alert_type}</td>
                <td><AlertStatusBadge status={a.status} /></td>
                <td>{fmtDateTime(a.created_at)}</td>
                <td>{a.owner || '-'}</td>
                <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {isOps && a.status === 'OPEN' && (
                    <button className="fbr-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => onAcknowledge(a.id)}>Ketahui</button>
                  )}
                  {isOps && (a.status === 'OPEN' || a.status === 'ACKNOWLEDGED') && (
                    reasonFor === a.id ? (
                      <>
                        <input className="fbr-input" style={{ width: 160, padding: '4px 8px', fontSize: 12 }} placeholder="Alasan selesai"
                          value={reasonText} onChange={e => setReasonText(e.target.value)} />
                        <button className="fbr-btn fbr-btn-primary" style={{ padding: '4px 10px', fontSize: 12 }}
                          onClick={() => { onResolve(a.id, reasonText); setReasonFor(null); setReasonText(''); }}>Kirim</button>
                        <button className="fbr-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setReasonFor(null)}>Batal</button>
                      </>
                    ) : (
                      <button className="fbr-btn fbr-btn-primary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setReasonFor(a.id)}>Selesai</button>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Modal generik utk semua aksi finansial — SELALU minta konfirmasi eksplisit.
// ─────────────────────────────────────────────────────────────────────────
/**
 * Validasi policy sebelum submit — pesan mudah dipahami, mencegah kombinasi
 * threshold yang tidak logis TERKIRIM (bukan hanya diblokir server, supaya
 * user langsung tahu field mana yang salah). Backend tetap validasi ulang
 * (sumber kebenaran, mode di sini cuma UX).
 */
const VALID_BURN_WINDOWS = [5, 15, 30, 60];
// Saran default teknis (spec) -- HANYA prefill form, TIDAK PERNAH disimpan
// otomatis. Admin harus eksplisit submit utk menyimpan, boleh diubah/dihapus
// dulu. topup_lead_time_minutes SENGAJA tidak punya saran -- harus berasal
// dari workflow FA nyata, bukan angka teknis yang dikarang.
const SUGGESTED_POLICY_DEFAULTS = { burn_window_minutes: 15, critical_margin_minutes: 10, watch_buffer_minutes: 30 };

function validatePolicyForm(form) {
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const nonNegFields = [
    ['absolute_minimum_balance', 'Batas Minimum Absolut'], ['critical_threshold', 'Critical Threshold'],
    ['emergency_threshold', 'Emergency Threshold'], ['watch_threshold', 'Watch Threshold'],
    ['excess_balance_threshold', 'Excess Balance Threshold'], ['reserve_balance', 'Reserve Balance'],
    ['topup_rounding_amount', 'Pembulatan Top Up'], ['sudden_drop_amount_threshold', 'Sudden Drop Nominal'],
    ['critical_margin_minutes', 'Critical Margin'], ['watch_buffer_minutes', 'Watch Buffer'],
    ['safety_buffer_fixed_amount', 'Safety Buffer (Nominal Tetap)'],
  ];
  for (const [key, label] of nonNegFields) {
    const v = num(form[key]);
    if (v !== null && (Number.isNaN(v) || v < 0)) return `${label} tidak boleh negatif.`;
  }
  for (const [key, label] of [['safety_buffer_percentage', 'Safety Buffer'], ['sudden_drop_percentage_threshold', 'Sudden Drop Percentage']]) {
    const v = num(form[key]);
    if (v !== null && (Number.isNaN(v) || v < 0 || v > 100)) return `${label} harus di antara 0 dan 100.`;
  }
  for (const [key, label] of [['stale_after_minutes', 'Stale After'], ['sudden_drop_window_minutes', 'Sudden Drop Window'], ['topup_lead_time_minutes', 'Top-up Lead Time']]) {
    const v = num(form[key]);
    if (v !== null && (Number.isNaN(v) || v <= 0)) return `${label} harus lebih besar dari 0 menit.`;
  }
  const burnWindow = num(form.burn_window_minutes);
  if (burnWindow !== null && !VALID_BURN_WINDOWS.includes(burnWindow)) {
    return `Burn Window harus salah satu: ${VALID_BURN_WINDOWS.join(', ')} menit.`;
  }
  const emergency = num(form.emergency_threshold);
  const critical = num(form.critical_threshold);
  const watch = num(form.watch_threshold);
  if (emergency !== null && critical !== null && emergency > critical) {
    return 'Emergency Threshold harus lebih kecil atau sama dengan Critical Threshold.';
  }
  if (critical !== null && watch !== null && critical > watch) {
    return 'Critical Threshold harus lebih kecil atau sama dengan Watch Threshold.';
  }
  return null;
}

function Modal({ modal, banks, bankDetail, onClose, loading, error, run }) {
  const [form, setForm] = useState({});
  const [localError, setLocalError] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Prefill form policy dari data existing — hook TIDAK boleh dipanggil
  // kondisional (aturan React), jadi selalu jalan di sini, cek modal.type di dalam.
  useEffect(() => {
    if (modal.type !== 'policy') return;
    if (bankDetail?.policy) {
      setForm({
        absolute_minimum_balance: bankDetail.policy.absolute_minimum_balance ?? '',
        critical_threshold: bankDetail.policy.critical_threshold ?? '',
        emergency_threshold: bankDetail.policy.emergency_threshold ?? '',
        watch_threshold: bankDetail.policy.watch_threshold ?? '',
        excess_balance_threshold: bankDetail.policy.excess_balance_threshold ?? '',
        reserve_balance: bankDetail.policy.reserve_balance ?? '',
        stale_after_minutes: bankDetail.policy.stale_after_minutes ?? '',
        sudden_drop_window_minutes: bankDetail.policy.sudden_drop_window_minutes ?? '',
        sudden_drop_amount_threshold: bankDetail.policy.sudden_drop_amount_threshold ?? '',
        sudden_drop_percentage_threshold: bankDetail.policy.sudden_drop_percentage_threshold ?? '',
        safety_buffer_percentage: bankDetail.policy.safety_buffer_percentage ?? '',
        topup_rounding_amount: bankDetail.policy.topup_rounding_amount ?? '',
        is_active: bankDetail.policy.is_active ?? true,
        // Field mesin operasional -- kalau sudah ada nilai tersimpan, pakai
        // itu apa adanya. Kalau BELUM ADA (null), prefill saran default
        // teknis (SUGGESTED_POLICY_DEFAULTS) sbg draft yang HARUS di-review
        // & disubmit eksplisit oleh admin -- tidak pernah otomatis tersimpan.
        burn_window_minutes: bankDetail.policy.burn_window_minutes ?? SUGGESTED_POLICY_DEFAULTS.burn_window_minutes,
        topup_lead_time_minutes: bankDetail.policy.topup_lead_time_minutes ?? '',
        critical_margin_minutes: bankDetail.policy.critical_margin_minutes ?? SUGGESTED_POLICY_DEFAULTS.critical_margin_minutes,
        watch_buffer_minutes: bankDetail.policy.watch_buffer_minutes ?? SUGGESTED_POLICY_DEFAULTS.watch_buffer_minutes,
        safety_buffer_type: bankDetail.policy.safety_buffer_type ?? '',
        safety_buffer_fixed_amount: bankDetail.policy.safety_buffer_fixed_amount ?? '',
      });
    } else {
      setForm(f => ({ ...f, is_active: true, ...SUGGESTED_POLICY_DEFAULTS }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal.type]);

  const bankName = (id) => banks.find(b => b.id === id)?.bank_name || bankDetail?.bank?.bank_name || `Bank #${id}`;

  let title = '';
  let body = null;
  let confirmLabel = 'Konfirmasi';
  let onConfirm = () => {};

  if (modal.type === 'add-bank') {
    title = 'Tambah Bank/Rekening';
    body = (
      <>
        <Field label="Kode Bank"><input className="fbr-input" value={form.bank_code || ''} onChange={e => set('bank_code', e.target.value)} placeholder="mis. BCA" /></Field>
        <Field label="Nama Bank"><input className="fbr-input" value={form.bank_name || ''} onChange={e => set('bank_name', e.target.value)} /></Field>
        <Field label="Nomor Rekening"><input className="fbr-input" value={form.account_number || ''} onChange={e => set('account_number', e.target.value)} /></Field>
        <Field label="Nama Rekening (opsional)"><input className="fbr-input" value={form.account_name || ''} onChange={e => set('account_name', e.target.value)} /></Field>
      </>
    );
    onConfirm = () => run(() => createBctBank(form));
  }

  if (modal.type === 'snapshot') {
    // Bank sudah punya mesin rekonsiliasi (detail.operational truthy) -> ini
    // FALLBACK DARURAT, bukan alur input normal (spec item 5). Wajib alasan,
    // masuk audit log, dan TIDAK PERNAH menimpa balance rekonsiliasi yang
    // lebih segar (dijamin backend via pickCurrentAndPrevious).
    const isReconciliationBacked = modal.bankId === bankDetail?.bank?.id && !!bankDetail?.operational;
    title = isReconciliationBacked ? `Input Saldo Manual (Darurat) — ${bankName(modal.bankId)}` : `Input Saldo — ${bankName(modal.bankId)}`;
    body = (
      <>
        {isReconciliationBacked && (
          <div className="fbr-error" style={{ background: '#FEF3C7', color: '#92400E', borderRadius: 8, padding: '10px 12px', marginBottom: 4 }}>
            Saldo bank ini otomatis dari rekonsiliasi OCBC. Input manual di sini HANYA fallback darurat —
            tidak akan menggantikan saldo rekonsiliasi yang lebih baru, dan wajib disertai alasan (masuk audit log).
          </div>
        )}
        <Field label="Saldo Tersedia (available_balance)"><input className="fbr-input" type="number" value={form.available_balance || ''} onChange={e => set('available_balance', e.target.value)} /></Field>
        <Field label="Saldo Tertahan (held_balance)"><input className="fbr-input" type="number" value={form.held_balance || ''} onChange={e => set('held_balance', e.target.value)} /></Field>
        <Field label="Transaksi Pending (pending_amount)"><input className="fbr-input" type="number" value={form.pending_amount || ''} onChange={e => set('pending_amount', e.target.value)} /></Field>
        <Field label="Saldo Cadangan (reserve_balance) — kosongkan untuk pakai default dari policy">
          <input className="fbr-input" type="number" value={form.reserve_balance ?? ''} onChange={e => set('reserve_balance', e.target.value)} />
        </Field>
        {isReconciliationBacked && (
          <Field label="Alasan Input Manual Darurat (wajib)">
            <textarea className="fbr-input" rows={3} value={form.reason || ''} onChange={e => set('reason', e.target.value)}
              placeholder="mis. rekonsiliasi OCBC gagal sync, dikonfirmasi manual oleh Finance" />
          </Field>
        )}
      </>
    );
    onConfirm = () => {
      if (isReconciliationBacked && !String(form.reason || '').trim()) {
        setLocalError('Alasan wajib diisi untuk Input Saldo Manual (Darurat) pada bank yang sudah didukung rekonsiliasi otomatis.');
        return;
      }
      setLocalError(null);
      run(() => createBctSnapshot(modal.bankId, form));
    };
  }

  if (modal.type === 'policy') {
    title = `Atur Policy — ${bankName(modal.bankId)}`;
    const p = bankDetail?.policy || {};
    body = (
      <>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '2px 0 8px' }}>
          Mesin Kalkulasi Operasional (FA Action Layer)
        </div>
        <Field label="Burn Window (menit)" hint="Jendela waktu utk menghitung outflow operasional saat ini. Tanpa ini, selected burn rate & runway tidak bisa dihitung.">
          <select className="select-input" style={{ width: '100%' }} value={form.burn_window_minutes ?? ''} onChange={e => set('burn_window_minutes', e.target.value ? Number(e.target.value) : '')}>
            <option value="">— belum dipilih —</option>
            {VALID_BURN_WINDOWS.map(m => <option key={m} value={m}>{m} menit</option>)}
          </select>
          {(p.burn_window_minutes === null || p.burn_window_minutes === undefined) && <div className="fbr-hint-suggested">Saran default: {SUGGESTED_POLICY_DEFAULTS.burn_window_minutes} menit — review & submit utk menyimpan.</div>}
        </Field>
        <Field label="Top-up Lead Time (menit)" hint="Waktu dari FA mengajukan top-up sampai dana masuk ke OCBC. WAJIB berasal dari workflow FA nyata, tidak ada saran teknis. Tanpa ini, rekomendasi top-up & deadline tidak bisa dihitung.">
          <input className="fbr-input" type="number" value={form.topup_lead_time_minutes ?? ''} onChange={e => set('topup_lead_time_minutes', e.target.value)} placeholder="Isi sesuai SLA transfer riil" />
        </Field>
        <Field label="Critical Margin (menit)" hint="Margin tambahan di atas lead time sebelum status naik ke Kritis.">
          <input className="fbr-input" type="number" value={form.critical_margin_minutes ?? ''} onChange={e => set('critical_margin_minutes', e.target.value)} />
          {(p.critical_margin_minutes === null || p.critical_margin_minutes === undefined) && <div className="fbr-hint-suggested">Saran default: {SUGGESTED_POLICY_DEFAULTS.critical_margin_minutes} menit — review & submit utk menyimpan.</div>}
        </Field>
        <Field label="Watch Buffer (menit)" hint="Buffer tambahan setelah critical margin sebelum status naik ke Waspada.">
          <input className="fbr-input" type="number" value={form.watch_buffer_minutes ?? ''} onChange={e => set('watch_buffer_minutes', e.target.value)} />
          {(p.watch_buffer_minutes === null || p.watch_buffer_minutes === undefined) && <div className="fbr-hint-suggested">Saran default: {SUGGESTED_POLICY_DEFAULTS.watch_buffer_minutes} menit — review & submit utk menyimpan.</div>}
        </Field>
        <Field label="Safety Buffer — Mode" hint="FIXED = nominal tetap. PERCENTAGE = persentase dari lead_time_need. Hanya SATU mode aktif.">
          <select className="select-input" style={{ width: '100%' }} value={form.safety_buffer_type ?? ''} onChange={e => set('safety_buffer_type', e.target.value)}>
            <option value="">— tidak dipakai —</option>
            <option value="FIXED">FIXED (nominal tetap)</option>
            <option value="PERCENTAGE">PERCENTAGE (dari lead_time_need)</option>
          </select>
        </Field>
        {form.safety_buffer_type === 'FIXED' && (
          <Field label="Safety Buffer — Nominal Tetap"><input className="fbr-input" type="number" value={form.safety_buffer_fixed_amount ?? ''} onChange={e => set('safety_buffer_fixed_amount', e.target.value)} /></Field>
        )}
        {form.safety_buffer_type === 'PERCENTAGE' && (
          <Field label="Safety Buffer (%) — dari lead_time_need"><input className="fbr-input" type="number" value={form.safety_buffer_percentage ?? ''} onChange={e => set('safety_buffer_percentage', e.target.value)} /></Field>
        )}

        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '16px 0 8px' }}>
          Threshold Legacy / Planning
        </div>
        <Field label="Batas Minimum Absolut"><input className="fbr-input" type="number" value={form.absolute_minimum_balance || ''} onChange={e => set('absolute_minimum_balance', e.target.value)} /></Field>
        <Field label="Emergency Threshold"><input className="fbr-input" type="number" value={form.emergency_threshold || ''} onChange={e => set('emergency_threshold', e.target.value)} /></Field>
        <Field label="Critical Threshold"><input className="fbr-input" type="number" value={form.critical_threshold || ''} onChange={e => set('critical_threshold', e.target.value)} /></Field>
        <Field label="Watch Threshold"><input className="fbr-input" type="number" value={form.watch_threshold || ''} onChange={e => set('watch_threshold', e.target.value)} /></Field>
        <Field label="Excess Balance Threshold"><input className="fbr-input" type="number" value={form.excess_balance_threshold || ''} onChange={e => set('excess_balance_threshold', e.target.value)} /></Field>
        <Field label="Reserve Balance (default saat snapshot tidak isi reserve)"><input className="fbr-input" type="number" value={form.reserve_balance || ''} onChange={e => set('reserve_balance', e.target.value)} /></Field>
        <Field label="Stale After (menit)"><input className="fbr-input" type="number" value={form.stale_after_minutes || ''} onChange={e => set('stale_after_minutes', e.target.value)} /></Field>
        <Field label="Sudden Drop Window (menit)"><input className="fbr-input" type="number" value={form.sudden_drop_window_minutes || ''} onChange={e => set('sudden_drop_window_minutes', e.target.value)} /></Field>
        <Field label="Sudden Drop Nominal"><input className="fbr-input" type="number" value={form.sudden_drop_amount_threshold || ''} onChange={e => set('sudden_drop_amount_threshold', e.target.value)} /></Field>
        <Field label="Sudden Drop Percentage (%)"><input className="fbr-input" type="number" value={form.sudden_drop_percentage_threshold || ''} onChange={e => set('sudden_drop_percentage_threshold', e.target.value)} /></Field>
        <Field label="Pembulatan Top Up"><input className="fbr-input" type="number" value={form.topup_rounding_amount || ''} onChange={e => set('topup_rounding_amount', e.target.value)} /></Field>
        <Field label="Aktifkan Policy">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.is_active !== false} onChange={e => set('is_active', e.target.checked)} /> Policy aktif
          </label>
        </Field>
      </>
    );
    onConfirm = () => {
      const msg = validatePolicyForm(form);
      if (msg) { setLocalError(msg); return; }
      setLocalError(null);
      run(() => updateBctPolicy(modal.bankId, form));
    };
  }

  if (modal.type === 'create-topup') {
    title = 'Ajukan Top Up';
    body = (
      <>
        <Field label="Bank">
          <select className="select-input" style={{ width: '100%' }} value={form.bank_account_id ?? modal.bankId ?? ''} onChange={e => set('bank_account_id', Number(e.target.value))}>
            <option value="">Pilih bank…</option>
            {banks.map(b => <option key={b.id} value={b.id}>{b.bank_name} — {b.account_number}</option>)}
          </select>
        </Field>
        <Field label="Jumlah Diajukan"><input className="fbr-input" type="number" value={form.requested_amount || ''} onChange={e => set('requested_amount', e.target.value)} /></Field>
        <Field label="Alasan"><input className="fbr-input" value={form.reason || ''} onChange={e => set('reason', e.target.value)} placeholder="mis. saldo mendekati watch threshold" /></Field>
      </>
    );
    onConfirm = () => run(async () => {
      const created = await createBctTopup({ ...form, bank_account_id: form.bank_account_id || modal.bankId });
      await requestBctTopup(created.topup.id);
    });
  }

  if (modal.type === 'request-topup') {
    title = 'Ajukan Permintaan Top Up';
    body = <p>Ajukan permintaan top up sebesar <b>{fmtRp(modal.topup.requested_amount)}</b> untuk approval Finance?</p>;
    onConfirm = () => run(() => requestBctTopup(modal.topup.id));
  }

  if (modal.type === 'approve-topup') {
    title = 'Setujui Top Up';
    body = (
      <>
        <p>Menyetujui permintaan top up dari <b>{modal.topup.requester_username}</b> sebesar {fmtRp(modal.topup.requested_amount)}.</p>
        <Field label="Jumlah Disetujui"><input className="fbr-input" type="number" defaultValue={modal.topup.requested_amount} onChange={e => set('approved_amount', e.target.value)} /></Field>
      </>
    );
    onConfirm = () => run(() => approveBctTopup(modal.topup.id, { approved_amount: form.approved_amount }));
  }

  if (modal.type === 'reject-topup') {
    title = 'Tolak Top Up';
    body = <Field label="Alasan Penolakan"><input className="fbr-input" value={form.reason || ''} onChange={e => set('reason', e.target.value)} /></Field>;
    onConfirm = () => run(() => rejectBctTopup(modal.topup.id, form.reason));
  }

  if (modal.type === 'transfer-topup') {
    title = 'Tandai Sudah Transfer';
    body = (
      <>
        <Field label="Jumlah Aktual Ditransfer"><input className="fbr-input" type="number" defaultValue={modal.topup.approved_amount || modal.topup.requested_amount} onChange={e => set('actual_amount', e.target.value)} /></Field>
        <Field label="Referensi Bukti Transfer (link/no. referensi)"><input className="fbr-input" value={form.transfer_proof_path || ''} onChange={e => set('transfer_proof_path', e.target.value)} placeholder="mis. link Google Drive / no. referensi bank" /></Field>
      </>
    );
    onConfirm = () => run(() => transferBctTopup(modal.topup.id, { actual_amount: form.actual_amount || modal.topup.approved_amount || modal.topup.requested_amount, transfer_proof_path: form.transfer_proof_path }));
  }

  if (modal.type === 'confirm-topup') {
    title = 'Konfirmasi Saldo Sudah Masuk';
    body = <Field label="Saldo Efektif Terbaru"><input className="fbr-input" type="number" value={form.balance_after || ''} onChange={e => set('balance_after', e.target.value)} /></Field>;
    onConfirm = () => run(() => confirmBctTopupBalance(modal.topup.id, form.balance_after));
  }

  if (modal.type === 'complete-topup') {
    title = 'Selesaikan Permintaan Top Up';
    body = <Field label="Catatan (opsional)"><input className="fbr-input" value={form.notes || ''} onChange={e => set('notes', e.target.value)} /></Field>;
    onConfirm = () => run(() => completeBctTopup(modal.topup.id, form.notes));
  }

  if (modal.type === 'cancel-topup') {
    title = 'Batalkan Permintaan Top Up';
    body = <p>Yakin membatalkan permintaan top up sebesar <b>{fmtRp(modal.topup.requested_amount)}</b>?</p>;
    confirmLabel = 'Batalkan';
    onConfirm = () => run(() => cancelBctTopup(modal.topup.id));
  }

  return (
    <div className="fbr-modal-overlay" onClick={onClose}>
      <div className="fbr-modal" onClick={e => e.stopPropagation()}>
        <div className="fbr-modal-title">{title}</div>
        {(localError || error) && <div className="fbr-error">{localError || error}</div>}
        {body}
        <div className="fbr-modal-actions">
          <button className="fbr-btn fbr-btn-secondary" onClick={onClose} disabled={loading}>Batal</button>
          <button className="fbr-btn fbr-btn-primary" onClick={onConfirm} disabled={loading}>
            {loading ? 'Memproses…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="fbr-field">
      <div className="fbr-field-label">{label}</div>
      {hint && <div className="fbr-field-hint">{hint}</div>}
      {children}
    </div>
  );
}
