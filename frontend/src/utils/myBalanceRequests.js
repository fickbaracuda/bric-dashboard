// Tracking ringan (localStorage) utk permintaan tambahan saldo yang DIBUAT
// oleh browser/user ini sendiri — dipakai OperationBalanceRequestToast.jsx
// utk polling status (PENDING -> ACKNOWLEDGED -> TRANSFERRED) dan
// menampilkan 2 tahap notifikasi di sisi Tim Operation: "sedang diproses"
// begitu Finance menekan SAYA TERIMA, lalu "dana sudah ditransfer" begitu
// Finance menandai transfer selesai. BalanceRequestButton.jsx menulis
// entri ini setelah berhasil submit; file ini SENGAJA dipisah (bukan
// didefinisikan ulang di 2 tempat) supaya key & bentuk data tidak pernah
// divergen antara penulis dan pembaca.
//
// Entry shape: { id, bank_code, requester_name, ackNotified? }
// `ackNotified` ditandai true setelah toast tahap-1 (ACKNOWLEDGED) tampil,
// supaya tidak muncul berulang di setiap polling — entry TETAP dilacak
// sampai TRANSFERRED terdeteksi (baru dihapus, itu status akhir).

const STORAGE_KEY = 'bric_my_pending_balance_requests';
const MAX_TRACKED = 10;

export function getTrackedBalanceRequests() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function addTrackedBalanceRequest(entry) {
  const list = getTrackedBalanceRequests().filter(x => x.id !== entry.id);
  const next = [entry, ...list].slice(0, MAX_TRACKED);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* localStorage penuh/disabled -- abaikan, bukan fitur kritikal */ }
}

export function removeTrackedBalanceRequest(id) {
  const list = getTrackedBalanceRequests().filter(x => x.id !== id);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* noop */ }
}

export function updateTrackedBalanceRequest(id, patch) {
  const list = getTrackedBalanceRequests().map(x => (x.id === id ? { ...x, ...patch } : x));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* noop */ }
}
