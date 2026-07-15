import { useState } from 'react';
import { createFinanceBalanceRequest } from '../../services/api';

// Tombol "Minta Tambahan Saldo" — shared component dipakai di semua halaman
// Rekonsiliasi (OCBC/Mandiri/BRI, dan bank lain di masa depan) lewat prop
// bankCode. Bank (dari prop, TIDAK BISA diedit user) + Nama Requester
// (wajib diisi manual, TIDAK diambil otomatis dari akun BRIC yang login —
// requested_by_user_id/username tetap disimpan di backend utk audit, tapi
// bukan sbg "Nama Requester") + Sisa Saldo (nominal saldo saat ini, wajib
// diisi manual).

export default function BalanceRequestButton({ bankCode }) {
  const [open, setOpen] = useState(false);
  const [requesterName, setRequesterName] = useState('');
  const [remainingBalance, setRemainingBalance] = useState(''); // digit string mentah, mis. "1500000"
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

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
      .then(() => {
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

  return (
    <>
      <button className="fbr-trigger-btn" onClick={openModal} title="Kirim permintaan tambahan saldo ke Finance">
        <i className="ti ti-cash-banknote" /> Minta Tambahan Saldo
      </button>

      {open && (
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
                  <input
                    id="fbr-requester-name"
                    className="fbr-input"
                    type="text"
                    value={requesterName}
                    onChange={e => setRequesterName(e.target.value)}
                    placeholder="Isi nama Anda secara manual"
                    maxLength={100}
                    autoFocus
                    disabled={submitting}
                  />
                </div>

                <div className="fbr-field">
                  <label className="fbr-field-label" htmlFor="fbr-remaining-balance">Sisa Saldo</label>
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
    </>
  );
}
