import { useState } from 'react';
import { createFinanceBalanceRequest, getFinanceBalanceRequestHistory } from '../../services/api';
import { addTrackedBalanceRequest } from '../../utils/myBalanceRequests';
import { getUser } from '../../utils/auth';
import FaTransferPanel from './FaTransferPanel';

// Tombol "Minta Tambahan Saldo" — shared component dipakai di semua halaman
// Rekonsiliasi (OCBC/Mandiri/BRI, dan bank lain di masa depan) lewat prop
// bankCode. Bank (dari prop, TIDAK BISA diedit user) + Nama Requester
// (wajib diisi manual, TIDAK diambil otomatis dari akun BRIC yang login —
// requested_by_user_id/username tetap disimpan di backend utk audit, tapi
// bukan sbg "Nama Requester") + Sisa Saldo (nominal saldo saat ini, wajib
// diisi manual).
//
// User unit FA TIDAK melihat tombol ini sama sekali (FA adalah penerima
// permintaan, bukan pemohon) — sebagai gantinya melihat FaTransferPanel
// (daftar permintaan yang sudah diterima, menunggu ditandai transfer).
// Tombol "Riwayat" tetap tampil utk SEMUA role (audit, read-only).
//
// Setelah berhasil submit, id permintaan dicatat via addTrackedBalanceRequest
// (localStorage) — dibaca oleh OperationBalanceRequestToast.jsx (global,
// Layout.jsx) utk menampilkan notifikasi "sedang diproses"/"sudah ditransfer".

function fmtRp(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '-';
  return `Rp ${Math.round(n).toLocaleString('id-ID')}`;
}
function fmtDateTime(v) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const STATUS_LABEL = { PENDING: 'Menunggu', ACKNOWLEDGED: 'Diterima', TRANSFERRED: 'Ditransfer' };
const QUICK_AMOUNTS = [
  { label: '50 Juta', value: 50000000 },
  { label: '100 Juta', value: 100000000 },
  { label: '150 Juta', value: 150000000 },
];
const MAX_NAME_SUGGESTIONS = 8;

export default function BalanceRequestButton({ bankCode }) {
  const isFA = getUser()?.unit === 'FA';
  const [open, setOpen] = useState(false);
  const [requesterName, setRequesterName] = useState('');
  const [remainingBalance, setRemainingBalance] = useState(''); // digit string mentah, mis. "1500000"
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRows, setHistoryRows] = useState([]);
  const [historyError, setHistoryError] = useState(null);

  const [recentNames, setRecentNames] = useState([]);

  const trimmed = requesterName.trim();
  const isNameValid = trimmed.length >= 2 && trimmed.length <= 100;
  const isBalanceValid = remainingBalance !== '' && Number(remainingBalance) >= 0;
  const isValid = isNameValid && isBalanceValid;
  const remainingBalanceDisplay = remainingBalance ? Number(remainingBalance).toLocaleString('id-ID') : '';

  function handleBalanceChange(e) {
    const digits = e.target.value.replace(/[^0-9]/g, '');
    setRemainingBalance(digits);
  }

  function openModal() {
    setOpen(true);
    setRequesterName('');
    setRemainingBalance('');
    setError(null);
    setSuccessMsg(null);
    // Riwayat nama requester (dari endpoint yg sama dgn tab Riwayat) supaya
    // OP tinggal klik nama yg sudah pernah dipakai, bukan ketik ulang tiap kali.
    getFinanceBalanceRequestHistory({ bank_code: bankCode, limit: 30 })
      .then(res => {
        const seen = new Set();
        const names = [];
        for (const r of (res.requests || [])) {
          const name = (r.requester_name || '').trim();
          if (!name || seen.has(name)) continue;
          seen.add(name);
          names.push(name);
          if (names.length >= MAX_NAME_SUGGESTIONS) break;
        }
        setRecentNames(names);
      })
      .catch(() => setRecentNames([]));
  }
  function closeModal() {
    setOpen(false);
    setRequesterName('');
    setRemainingBalance('');
    setError(null);
    setSuccessMsg(null);
  }

  function handleSubmit() {
    if (!isValid || submitting) return;
    setSubmitting(true);
    setError(null);
    createFinanceBalanceRequest({ bank_code: bankCode, requester_name: trimmed, remaining_balance: Number(remainingBalance) })
      .then(res => {
        if (res?.request?.id) {
          addTrackedBalanceRequest({ id: res.request.id, bank_code: bankCode, requester_name: trimmed });
        }
        setSuccessMsg(`Permintaan tambahan saldo untuk Bank ${bankCode} telah dikirim kepada Finance.`);
        setRequesterName('');
        setRemainingBalance('');
        setTimeout(() => closeModal(), 2200);
      })
      .catch(e => {
        setError(e.response?.data?.message || e.response?.data?.error || 'Gagal mengirim permintaan. Coba lagi.');
      })
      .finally(() => setSubmitting(false));
  }

  function openHistory() {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError(null);
    getFinanceBalanceRequestHistory({ bank_code: bankCode, limit: 20 })
      .then(res => setHistoryRows(res.requests || []))
      .catch(e => setHistoryError(e.response?.data?.error || 'Gagal memuat riwayat.'))
      .finally(() => setHistoryLoading(false));
  }
  function closeHistory() {
    setHistoryOpen(false);
    setHistoryRows([]);
    setHistoryError(null);
  }

  return (
    <>
      {isFA ? (
        <FaTransferPanel bankCode={bankCode} />
      ) : (
        <button className="fbr-trigger-btn" onClick={openModal} title="Kirim permintaan tambahan saldo ke Finance">
          <i className="ti ti-cash-banknote" /> Minta Tambahan Saldo
        </button>
      )}
      <button className="fbr-history-btn" onClick={openHistory} title="Lihat riwayat permintaan tambahan saldo">
        <i className="ti ti-history" />
      </button>

      {!isFA && open && (
        <div className="fbr-modal-overlay" onClick={closeModal}>
          <div className="fbr-modal" onClick={e => e.stopPropagation()}>
            <div className="fbr-modal-title">PERMINTAAN TAMBAHAN SALDO</div>

            {!successMsg && (
              <>
                <div className="fbr-field">
                  <span className="fbr-field-label">Bank</span>
                  <div className="fbr-bank-value">{bankCode}</div>
                </div>

                <div className="fbr-field">
                  <label className="fbr-field-label" htmlFor="fbr-requester-name">Nama Requester</label>
                  {recentNames.length > 0 && (
                    <div className="fbr-chip-row">
                      {recentNames.map(name => (
                        <button
                          key={name}
                          type="button"
                          className={'fbr-chip' + (trimmed === name ? ' fbr-chip--active' : '')}
                          onClick={() => setRequesterName(name)}
                          disabled={submitting}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  )}
                  <input
                    id="fbr-requester-name"
                    className="fbr-input"
                    type="text"
                    value={requesterName}
                    onChange={e => setRequesterName(e.target.value)}
                    placeholder="Isi nama Anda secara manual, atau klik nama di atas"
                    maxLength={100}
                    autoFocus
                    disabled={submitting}
                  />
                </div>

                <div className="fbr-field">
                  <label className="fbr-field-label" htmlFor="fbr-remaining-balance">Sisa Saldo</label>
                  <div className="fbr-chip-row">
                    {QUICK_AMOUNTS.map(a => (
                      <button
                        key={a.value}
                        type="button"
                        className={'fbr-chip' + (remainingBalance === String(a.value) ? ' fbr-chip--active' : '')}
                        onClick={() => setRemainingBalance(String(a.value))}
                        disabled={submitting}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                  <div className="fbr-input-prefix-wrap">
                    <span className="fbr-input-prefix">Rp</span>
                    <input
                      id="fbr-remaining-balance"
                      className="fbr-input fbr-input-with-prefix"
                      type="text"
                      inputMode="numeric"
                      value={remainingBalanceDisplay}
                      onChange={handleBalanceChange}
                      placeholder="0"
                      disabled={submitting}
                    />
                  </div>
                </div>

                {error && <div className="fbr-error">{error}</div>}

                <div className="fbr-modal-actions">
                  <button className="fbr-btn fbr-btn-secondary" onClick={closeModal} disabled={submitting}>Batal</button>
                  <button className="fbr-btn fbr-btn-primary" onClick={handleSubmit} disabled={!isValid || submitting}>
                    {submitting ? 'Mengirim...' : 'Kirim Permintaan'}
                  </button>
                </div>
              </>
            )}

            {successMsg && (
              <div className="fbr-success">
                <i className="ti ti-circle-check" /> {successMsg}
              </div>
            )}
          </div>
        </div>
      )}

      {historyOpen && (
        <div className="fbr-modal-overlay" onClick={closeHistory}>
          <div className="fbr-modal fbr-modal--wide" onClick={e => e.stopPropagation()}>
            <div className="fbr-modal-title">RIWAYAT PERMINTAAN TAMBAHAN SALDO — {bankCode}</div>

            {historyLoading && <div className="fbr-history-empty">Memuat riwayat...</div>}
            {!historyLoading && historyError && <div className="fbr-error">{historyError}</div>}
            {!historyLoading && !historyError && historyRows.length === 0 && (
              <div className="fbr-history-empty">Belum ada permintaan tambahan saldo untuk Bank {bankCode}.</div>
            )}
            {!historyLoading && !historyError && historyRows.length > 0 && (
              <div className="fbr-history-table-wrap">
                <table className="fbr-history-table">
                  <thead>
                    <tr>
                      <th>Waktu Request</th>
                      <th>Requester</th>
                      <th>Diminta Oleh</th>
                      <th>Sisa Saldo</th>
                      <th>Status</th>
                      <th>Diterima Oleh</th>
                      <th>Waktu Diterima</th>
                      <th>Ditransfer Oleh</th>
                      <th>Waktu Transfer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyRows.map(r => (
                      <tr key={r.id}>
                        <td>{fmtDateTime(r.requested_at)}</td>
                        <td>{r.requester_name}</td>
                        <td>{r.requested_by_username || '-'}</td>
                        <td>{fmtRp(r.remaining_balance)}</td>
                        <td>
                          <span className={'fbr-status-badge fbr-status-badge--' + r.status.toLowerCase()}>
                            {STATUS_LABEL[r.status] || r.status}
                          </span>
                        </td>
                        <td>{r.acknowledged_by_username || '-'}</td>
                        <td>{fmtDateTime(r.acknowledged_at)}</td>
                        <td>{r.transferred_by_username || '-'}</td>
                        <td>{fmtDateTime(r.transferred_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="fbr-modal-actions">
              <button className="fbr-btn fbr-btn-secondary" onClick={closeHistory}>Tutup</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
