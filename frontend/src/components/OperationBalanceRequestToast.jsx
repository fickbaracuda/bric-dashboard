import { useState, useEffect, useRef } from 'react';
import { getFinanceBalanceRequestStatus } from '../services/api';
import { getTrackedBalanceRequests, removeTrackedBalanceRequest, updateTrackedBalanceRequest } from '../utils/myBalanceRequests';

// Notifikasi utk Tim Operation — 2 TAHAP mengikuti status permintaan yang
// MEREKA buat sendiri (dilacak via localStorage, lihat utils/myBalanceRequests.js):
//   1. ACKNOWLEDGED — Finance menekan "SAYA TERIMA" -> toast kecil "sedang diproses"
//   2. TRANSFERRED  — Finance menandai dana sudah ditransfer -> POP UP + SUARA
//      (lebih menonjol drpd tahap 1, krn ini kabar final yang wajib diketahui
//      Operation sebelum lanjut kerja) — TAPI tetap bisa ditutup manual
//      (BEDA dari FinanceBalanceAlert yang hard/tidak bisa ditutup — di sini
//      tidak menggerbang proses bisnis apa pun, murni pemberitahuan).
// Entry TETAP dilacak setelah tahap 1 (hanya ditandai `ackNotified` supaya
// toast tahap-1 tidak muncul berulang) — baru dihapus dari tracking setelah
// TRANSFERRED (status akhir). Dipasang SATU KALI secara global di Layout.jsx.
//
// Polling HANYA berjalan kalau ada permintaan yang sedang dilacak (list
// localStorage tidak kosong) — supaya user yang tidak pernah membuat
// permintaan sama sekali tidak melakukan network call sia-sia.

const POLL_INTERVAL_MS = 5000;
const AUTO_DISMISS_MS = 12000;
const AUDIO_PREF_KEY = 'bric_op_transfer_alert_audio_enabled';

/** Chime sukses sederhana (2 nada naik) via Web Audio API — TIDAK PERNAH audio dari URL eksternal. */
function playSuccessChime(ctx) {
  try {
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.value = 0.2;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const startAt = ctx.currentTime + i * 0.16;
      osc.start(startAt);
      osc.stop(startAt + 0.16);
    });
  } catch {
    /* AudioContext gagal -- popup tetap tampil, hanya suara yang tidak jalan */
  }
}

export default function OperationBalanceRequestToast() {
  const [toasts, setToasts] = useState([]);
  const [transferAlerts, setTransferAlerts] = useState([]); // queue popup TRANSFERRED
  const [audioReady, setAudioReady] = useState(false);
  const inFlightRef = useRef(false);
  const aliveRef = useRef(true);
  const audioContextRef = useRef(null);

  // Coba siapkan AudioContext dari preferensi tersimpan (best-effort — bisa
  // saja masih diblokir browser sampai ada gesture baru di tab ini).
  useEffect(() => {
    if (localStorage.getItem(AUDIO_PREF_KEY) !== 'true') return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioContextRef.current = new Ctx();
      audioContextRef.current.resume().then(() => {
        if (audioContextRef.current.state === 'running') setAudioReady(true);
      }).catch(() => {});
    } catch { /* noop */ }
  }, []);

  function enableAudio() {
    try {
      if (!audioContextRef.current) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        audioContextRef.current = new Ctx();
      }
      audioContextRef.current.resume().then(() => {
        setAudioReady(true);
        localStorage.setItem(AUDIO_PREF_KEY, 'true');
        playSuccessChime(audioContextRef.current);
      });
    } catch { /* noop */ }
  }

  useEffect(() => {
    aliveRef.current = true;

    function poll() {
      if (inFlightRef.current) return;
      const tracked = getTrackedBalanceRequests();
      if (!tracked.length) return;
      inFlightRef.current = true;

      Promise.all(tracked.map(t =>
        getFinanceBalanceRequestStatus(t.id)
          .then(res => ({ t, request: res.request }))
          .catch(() => ({ t, invalid: true }))
      ))
        .then(results => {
          if (!aliveRef.current) return;
          const newToasts = [];
          const newAlerts = [];
          for (const r of results) {
            if (r.invalid) {
              removeTrackedBalanceRequest(r.t.id);
              continue;
            }
            const status = r.request?.status;
            if (status === 'TRANSFERRED') {
              // Status akhir -- berhenti dilacak sepenuhnya. Notifikasi
              // PALING menonjol: pop up + suara (bukan sekadar toast).
              removeTrackedBalanceRequest(r.t.id);
              newAlerts.push({
                key: `${r.t.id}-transferred-${Date.now()}`,
                bankCode: r.t.bank_code,
                transferredBy: r.request.transferred_by_username || null,
              });
            } else if (status === 'ACKNOWLEDGED' && !r.t.ackNotified) {
              // Tahap 1 saja -- TETAP dilacak sampai TRANSFERRED terdeteksi.
              updateTrackedBalanceRequest(r.t.id, { ackNotified: true });
              const who = r.request.acknowledged_by_username ? ` (${r.request.acknowledged_by_username})` : '';
              newToasts.push({
                key: `${r.t.id}-acknowledged-${Date.now()}`,
                message: `Permintaan tambahan saldo Bank ${r.t.bank_code} telah diterima oleh Finance${who} — sedang diproses.`,
              });
            }
          }
          if (newToasts.length) setToasts(cur => [...cur, ...newToasts]);
          if (newAlerts.length) {
            setTransferAlerts(cur => [...cur, ...newAlerts]);
            if (audioContextRef.current && audioReady) playSuccessChime(audioContextRef.current);
          }
        })
        .finally(() => { inFlightRef.current = false; });
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => { aliveRef.current = false; clearInterval(id); };
  }, [audioReady]);

  function dismissToast(key) {
    setToasts(cur => cur.filter(t => t.key !== key));
  }
  function dismissAlert(key) {
    setTransferAlerts(cur => cur.filter(a => a.key !== key));
  }

  useEffect(() => {
    if (!toasts.length) return undefined;
    const timers = toasts.map(t => setTimeout(() => dismissToast(t.key), AUTO_DISMISS_MS));
    return () => timers.forEach(clearTimeout);
  }, [toasts]);

  const currentAlert = transferAlerts[0] || null;

  return (
    <>
      {toasts.length > 0 && (
        <div className="fbr-toast-stack">
          {toasts.map(t => (
            <div key={t.key} className="fbr-toast">
              <i className="ti ti-clock-hour-4" />
              <span>{t.message}</span>
              <button className="fbr-toast-close" onClick={() => dismissToast(t.key)} aria-label="Tutup notifikasi">
                <i className="ti ti-x" />
              </button>
            </div>
          ))}
        </div>
      )}

      {currentAlert && (
        <div className="fbr-transfer-popup-overlay" onClick={() => dismissAlert(currentAlert.key)}>
          <div className="fbr-transfer-popup" onClick={e => e.stopPropagation()}>
            <div className="fbr-transfer-popup-icon"><i className="ti ti-rosette-discount-check" /></div>
            <h2>DANA SUDAH DITRANSFER</h2>
            <div className="fbr-transfer-popup-bank">Bank: {currentAlert.bankCode}</div>
            <p>
              Finance{currentAlert.transferredBy ? ` (${currentAlert.transferredBy})` : ''} telah menyelesaikan transfer
              dana tambahan saldo yang Anda minta.
            </p>
            {!audioReady && (
              <button className="fbr-transfer-popup-audio-btn" onClick={enableAudio}>
                <i className="ti ti-volume" /> Aktifkan Suara Notifikasi
              </button>
            )}
            <button className="fbr-transfer-popup-ok-btn" onClick={() => dismissAlert(currentAlert.key)}>
              Mengerti
            </button>
            {transferAlerts.length > 1 && (
              <div className="fbr-transfer-popup-more">Terdapat {transferAlerts.length - 1} notifikasi lainnya.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
