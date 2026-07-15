import { useState } from 'react';
import { createFinanceBalanceRequest } from '../../services/api';

// Tombol "Minta Tambahan Saldo" — shared component dipakai di semua halaman
// Rekonsiliasi (OCBC/Mandiri/BRI, dan bank lain di masa depan) lewat prop
// bankCode. Sengaja SEDERHANA: hanya bank_code (dari prop, TIDAK BISA
// diedit user) + Nama Requester (wajib diisi manual, TIDAK diambil
// otomatis dari akun BRIC yang login — requested_by_user_id/username tetap
// disimpan di backend utk audit, tapi bukan sbg "Nama Requester").

export default function BalanceRequestButton({ bankCode }) {
  const [open, setOpen] = useState(false);
  const [requesterName, setRequesterName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const trimmed = requesterName.trim();
  const isValid = trimmed.length >= 2 && trimmed.length <= 100;

  function openModal() {
    setOpen(true);
    setRequesterName('');
    setError(null);
    setSuccessMsg(null);
  }
  function closeModal() {
    setOpen(false);
    setRequesterName('');
    setError(null);
    setSuccessMsg(null);
  }

  function handleSubmit() {
    if (!isValid || submitting) return;
    setSubmitting(true);
    setError(null);
    createFinanceBalanceRequest({ bank_code: bankCode, requester_name: trimmed })
      .then(() => {
        setSuccessMsg(`Permintaan tambahan saldo untuk Bank ${bankCode} telah dikirim kepada Finance.`);
        setRequesterName('');
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
