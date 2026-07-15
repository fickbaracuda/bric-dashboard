import { useState, useEffect, useRef, useCallback } from 'react';
import { getAcknowledgedFinanceBalanceRequests, markFinanceBalanceRequestTransferred } from '../../services/api';

// Panel khusus unit FA di halaman Rekonsiliasi (menggantikan tombol "Minta
// Tambahan Saldo" yang tidak relevan utk FA — FA adalah penerima, bukan
// pemohon). Menampilkan daftar permintaan yang SUDAH diterima (ACKNOWLEDGED)
// tapi BELUM ditransfer, khusus utk bank yang sedang dibuka. Kalau tidak
// ada, tombol/panel TIDAK ditampilkan sama sekali — supaya tidak ada UI
// mati kalau tidak ada yang perlu ditindaklanjuti.
//
// Polling ringan (8 detik) tetap berjalan di background (walau list sedang
// kosong) supaya begitu ada permintaan baru diterima (dari hard notification
// di halaman lain), tombol ini otomatis muncul tanpa perlu refresh manual.

const POLL_INTERVAL_MS = 8000;

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

export default function FaTransferPanel({ bankCode }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const [markingId, setMarkingId] = useState(null);
  const [error, setError] = useState(null);
  const inFlightRef = useRef(false);
  const aliveRef = useRef(true);

  const load = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    getAcknowledgedFinanceBalanceRequests(bankCode)
      .then(res => { if (aliveRef.current) setRows(res.requests || []); })
      .catch(() => { /* silent -- jangan ganggu halaman Rekonsiliasi kalau polling gagal sesaat */ })
      .finally(() => { inFlightRef.current = false; });
  }, [bankCode]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => { aliveRef.current = false; clearInterval(id); };
  }, [load]);

  // Kalau list kosong (semua sudah ditransfer -- entah oleh FA ini sendiri
  // atau FA lain di sesi berbeda), tutup modal yang mungkin sedang terbuka.
  // TANPA ini, `open` bisa tetap `true` walau komponen sempat return null
  // (rows kosong), lalu tiba-tiba modal muncul lagi sendiri begitu ada
  // permintaan BARU diterima nanti — padahal user tidak pernah klik tombol.
  useEffect(() => {
    if (rows.length === 0) setOpen(false);
  }, [rows]);

  function handleMarkTransferred(id) {
    if (markingId) return;
    setMarkingId(id);
    setError(null);
    markFinanceBalanceRequestTransferred(id)
      .then(() => {
        setRows(cur => cur.filter(r => r.id !== id));
      })
      .catch(e => setError(e.response?.data?.message || e.response?.data?.error || 'Gagal menandai transfer.'))
      .finally(() => setMarkingId(null));
  }

  if (!rows.length) return null;

  return (
    <>
      <button className="fbr-fa-panel-btn" onClick={() => setOpen(true)}>
        <i className="ti ti-transfer" /> Permintaan Diproses ({rows.length})
      </button>

      {open && (
        <div className="fbr-modal-overlay" onClick={() => setOpen(false)}>
          <div className="fbr-modal fbr-modal--wide" onClick={e => e.stopPropagation()}>
            <div className="fbr-modal-title">PERMINTAAN SEDANG DIPROSES — {bankCode}</div>

            {error && <div className="fbr-error">{error}</div>}

            {/* rows tidak pernah kosong di sini -- komponen sudah return null
                di atas kalau rows.length === 0 (lihat baris awal function). */}
            <div className="fbr-fa-transfer-list">
              {rows.map(r => (
                <div key={r.id} className="fbr-fa-transfer-row">
                  <div className="fbr-fa-transfer-info">
                    <div className="fbr-fa-transfer-name">{r.requester_name}</div>
                    <div className="fbr-fa-transfer-meta">
                      Sisa saldo: {fmtRp(r.remaining_balance)} &middot; diterima {fmtDateTime(r.acknowledged_at)}
                    </div>
                  </div>
                  <button
                    className="fbr-btn fbr-btn-primary"
                    onClick={() => handleMarkTransferred(r.id)}
                    disabled={markingId === r.id}
                  >
                    {markingId === r.id ? 'Memproses...' : 'Dana Sudah Ditransfer'}
                  </button>
                </div>
              ))}
            </div>

            <div className="fbr-modal-actions">
              <button className="fbr-btn fbr-btn-secondary" onClick={() => setOpen(false)}>Tutup</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
