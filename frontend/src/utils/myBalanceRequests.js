// Tracking ringan (localStorage) utk permintaan tambahan saldo yang DIBUAT
// oleh browser/user ini sendiri — dipakai OperationBalanceRequestToast.jsx
// utk polling status (PENDING -> ACKNOWLEDGED) dan menampilkan notifikasi
// "sedang diproses" di sisi Tim Operation begitu Finance menekan
// "SAYA TERIMA". BalanceRequestButton.jsx menulis entri ini setelah
// berhasil submit; file ini SENGAJA dipisah (bukan didefinisikan ulang di
// 2 tempat) supaya key & bentuk data tidak pernah divergen antara penulis
// dan pembaca.

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
