import { useState, useEffect, useRef } from 'react';
import { getFinanceBalanceRequestStatus } from '../services/api';
import { getTrackedBalanceRequests, removeTrackedBalanceRequest } from '../utils/myBalanceRequests';

// Notifikasi non-blocking utk Tim Operation — begitu Finance menekan
// "SAYA TERIMA" pada permintaan yang MEREKA buat sendiri (dilacak via
// localStorage, lihat utils/myBalanceRequests.js), tampilkan toast kecil
// "sedang diproses". Dipasang SATU KALI secara global di Layout.jsx.
//
// BEDA dari FinanceBalanceAlert (hard, full-screen, khusus unit FA): ini
// dismissible, tidak ada suara, tidak memblokir apa pun — murni informasi.
// Polling HANYA berjalan kalau ada permintaan yang sedang dilacak (list
// localStorage tidak kosong) — supaya user yang tidak pernah membuat
// permintaan sama sekali tidak melakukan network call sia-sia.

const POLL_INTERVAL_MS = 5000;
const AUTO_DISMISS_MS = 12000;

export default function OperationBalanceRequestToast() {
  const [toasts, setToasts] = useState([]);
  const inFlightRef = useRef(false);
  const aliveRef = useRef(true);

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
          for (const r of results) {
            if (r.invalid) {
              removeTrackedBalanceRequest(r.t.id);
              continue;
            }
            if (r.request?.status === 'ACKNOWLEDGED') {
              removeTrackedBalanceRequest(r.t.id);
              const who = r.request.acknowledged_by_username ? ` (${r.request.acknowledged_by_username})` : '';
              newToasts.push({
                key: `${r.t.id}-${Date.now()}`,
                message: `Permintaan tambahan saldo Bank ${r.t.bank_code} telah diterima oleh Finance${who} — sedang diproses.`,
              });
            }
          }
          if (newToasts.length) setToasts(cur => [...cur, ...newToasts]);
        })
        .finally(() => { inFlightRef.current = false; });
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => { aliveRef.current = false; clearInterval(id); };
  }, []);

  function dismiss(key) {
    setToasts(cur => cur.filter(t => t.key !== key));
  }

  useEffect(() => {
    if (!toasts.length) return undefined;
    const timers = toasts.map(t => setTimeout(() => dismiss(t.key), AUTO_DISMISS_MS));
    return () => timers.forEach(clearTimeout);
  }, [toasts]);

  if (!toasts.length) return null;

  return (
    <div className="fbr-toast-stack">
      {toasts.map(t => (
        <div key={t.key} className="fbr-toast">
          <i className="ti ti-clock-hour-4" />
          <span>{t.message}</span>
          <button className="fbr-toast-close" onClick={() => dismiss(t.key)} aria-label="Tutup notifikasi">
            <i className="ti ti-x" />
          </button>
        </div>
      ))}
    </div>
  );
}
