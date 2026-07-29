import { useState, useEffect, useCallback } from 'react';
import Layout from '../components/Layout';
import { getUser } from '../utils/auth';
import {
  getBctSummary, getBctBankDetail, createBctSnapshot, getBctPolicy, updateBctPolicy,
  createBctTopup, getBctTopups, requestBctTopup, approveBctTopup, rejectBctTopup,
  transferBctTopup, confirmBctTopupBalance, completeBctTopup, cancelBctTopup,
  getBctAlerts, acknowledgeBctAlert, snoozeBctAlert, resolveBctAlert, createBctBank,
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
function DetailTab({ banks, selectedBankId, onSelectBank, detail, loading, isOps, isAdmin, onInputSnapshot, onEditPolicy, onCreateTopup }) {
  return (
    <>
      <div className="header-controls" style={{ marginBottom: 16 }}>
        <select className="select-input" value={selectedBankId || ''} onChange={e => onSelectBank(Number(e.target.value))}>
          {banks.map(b => <option key={b.id} value={b.id}>{b.bank_name} — {b.account_number}</option>)}
        </select>
        {isOps && <button className="fbr-btn" onClick={onInputSnapshot}><i className="ti ti-cash-register" /> Input Saldo</button>}
        {isAdmin && <button className="fbr-btn" onClick={onEditPolicy}><i className="ti ti-settings" /> Atur Policy</button>}
        {isOps && <button className="fbr-btn fbr-btn-primary" onClick={onCreateTopup}><i className="ti ti-transfer-in" /> Ajukan Top Up</button>}
      </div>

      {loading ? (
        <div className="loading-wrap"><div className="loading-spinner" /><div className="loading-text">Memuat detail…</div></div>
      ) : !detail ? (
        <div className="empty-state"><div className="empty-icon">🏦</div><div className="empty-title">Pilih bank</div></div>
      ) : (
        <>
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
                <thead><tr><th>Waktu</th><th>Tersedia</th><th>Tertahan</th><th>Pending</th><th>Cadangan</th><th>Efektif</th><th>Sumber</th><th>Sync</th></tr></thead>
                <tbody>
                  {(detail.riwayat_snapshot || []).slice(0, 30).map(s => (
                    <tr key={s.id}>
                      <td>{fmtDateTime(s.captured_at)}</td>
                      <td>{fmtRp(s.available_balance)}</td>
                      <td>{fmtRp(s.held_balance)}</td>
                      <td>{fmtRp(s.pending_amount)}</td>
                      <td>{fmtRp(s.reserve_balance)}</td>
                      <td><b>{fmtRp(s.effective_balance)}</b></td>
                      <td>{s.source}</td>
                      <td>{s.sync_status}</td>
                    </tr>
                  ))}
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
function validatePolicyForm(form) {
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const nonNegFields = [
    ['absolute_minimum_balance', 'Batas Minimum Absolut'], ['critical_threshold', 'Critical Threshold'],
    ['emergency_threshold', 'Emergency Threshold'], ['watch_threshold', 'Watch Threshold'],
    ['excess_balance_threshold', 'Excess Balance Threshold'], ['reserve_balance', 'Reserve Balance'],
    ['topup_rounding_amount', 'Pembulatan Top Up'], ['sudden_drop_amount_threshold', 'Sudden Drop Nominal'],
  ];
  for (const [key, label] of nonNegFields) {
    const v = num(form[key]);
    if (v !== null && (Number.isNaN(v) || v < 0)) return `${label} tidak boleh negatif.`;
  }
  for (const [key, label] of [['safety_buffer_percentage', 'Safety Buffer'], ['sudden_drop_percentage_threshold', 'Sudden Drop Percentage']]) {
    const v = num(form[key]);
    if (v !== null && (Number.isNaN(v) || v < 0 || v > 100)) return `${label} harus di antara 0 dan 100.`;
  }
  for (const [key, label] of [['stale_after_minutes', 'Stale After'], ['sudden_drop_window_minutes', 'Sudden Drop Window']]) {
    const v = num(form[key]);
    if (v !== null && (Number.isNaN(v) || v <= 0)) return `${label} harus lebih besar dari 0 menit.`;
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
      });
    } else {
      setForm(f => ({ ...f, is_active: true }));
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
    title = `Input Saldo — ${bankName(modal.bankId)}`;
    body = (
      <>
        <Field label="Saldo Tersedia (available_balance)"><input className="fbr-input" type="number" value={form.available_balance || ''} onChange={e => set('available_balance', e.target.value)} /></Field>
        <Field label="Saldo Tertahan (held_balance)"><input className="fbr-input" type="number" value={form.held_balance || ''} onChange={e => set('held_balance', e.target.value)} /></Field>
        <Field label="Transaksi Pending (pending_amount)"><input className="fbr-input" type="number" value={form.pending_amount || ''} onChange={e => set('pending_amount', e.target.value)} /></Field>
        <Field label="Saldo Cadangan (reserve_balance) — kosongkan untuk pakai default dari policy">
          <input className="fbr-input" type="number" value={form.reserve_balance ?? ''} onChange={e => set('reserve_balance', e.target.value)} />
        </Field>
      </>
    );
    onConfirm = () => run(() => createBctSnapshot(modal.bankId, form));
  }

  if (modal.type === 'policy') {
    title = `Atur Policy — ${bankName(modal.bankId)}`;
    body = (
      <>
        <Field label="Batas Minimum Absolut (legacy)"><input className="fbr-input" type="number" value={form.absolute_minimum_balance || ''} onChange={e => set('absolute_minimum_balance', e.target.value)} /></Field>
        <Field label="Emergency Threshold"><input className="fbr-input" type="number" value={form.emergency_threshold || ''} onChange={e => set('emergency_threshold', e.target.value)} /></Field>
        <Field label="Critical Threshold"><input className="fbr-input" type="number" value={form.critical_threshold || ''} onChange={e => set('critical_threshold', e.target.value)} /></Field>
        <Field label="Watch Threshold"><input className="fbr-input" type="number" value={form.watch_threshold || ''} onChange={e => set('watch_threshold', e.target.value)} /></Field>
        <Field label="Excess Balance Threshold"><input className="fbr-input" type="number" value={form.excess_balance_threshold || ''} onChange={e => set('excess_balance_threshold', e.target.value)} /></Field>
        <Field label="Reserve Balance (default saat snapshot tidak isi reserve)"><input className="fbr-input" type="number" value={form.reserve_balance || ''} onChange={e => set('reserve_balance', e.target.value)} /></Field>
        <Field label="Stale After (menit)"><input className="fbr-input" type="number" value={form.stale_after_minutes || ''} onChange={e => set('stale_after_minutes', e.target.value)} /></Field>
        <Field label="Sudden Drop Window (menit)"><input className="fbr-input" type="number" value={form.sudden_drop_window_minutes || ''} onChange={e => set('sudden_drop_window_minutes', e.target.value)} /></Field>
        <Field label="Sudden Drop Nominal"><input className="fbr-input" type="number" value={form.sudden_drop_amount_threshold || ''} onChange={e => set('sudden_drop_amount_threshold', e.target.value)} /></Field>
        <Field label="Sudden Drop Percentage (%)"><input className="fbr-input" type="number" value={form.sudden_drop_percentage_threshold || ''} onChange={e => set('sudden_drop_percentage_threshold', e.target.value)} /></Field>
        <Field label="Safety Buffer (%)"><input className="fbr-input" type="number" value={form.safety_buffer_percentage || ''} onChange={e => set('safety_buffer_percentage', e.target.value)} /></Field>
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

function Field({ label, children }) {
  return (
    <div className="fbr-field">
      <div className="fbr-field-label">{label}</div>
      {children}
    </div>
  );
}
