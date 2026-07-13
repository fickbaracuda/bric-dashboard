# Rekonsiliasi FP vs Bank OCBC — War Room Payment Agent > Rekonsiliasi OCBC

## Tujuan
Mencocokkan transaksi FP (Financial Platform) terhadap mutasi rekening Bank
OCBC secara otomatis — mendeteksi transaksi yang cocok, belum muncul di bank,
fee tidak sesuai, duplikat, reversal, dan mutasi bank yang tidak ada di FP.

## Sumber Data
Google Sheet: `1V8NwLKeVUo2zV4ez-K4V-Ymt3_PNk7DyNrsJktcb2tE`
- **DATA FP**: header baris 1, data baris 2+. Kolom A-F dipetakan (id_transaksi,
  nominal, id_produk, time_response, id_outlet, id_biller). Kolom G ("CEK DATA
  ke BANK") kolom bantuan manual — **tidak pernah dibaca**.
- **DATA BANK OCBC**: info rekening baris 1-8 (di-scan fleksibel per label),
  header baris 10, data baris 11+. Kolom A-H dipetakan. Kolom I & J bantuan
  manual — **tidak pernah dibaca**.

## Konsep Kunci
`DATA FP.id_transaksi = DATA BANK OCBC.Reference No.` (selalu diproses sebagai
STRING). Satu reference biasanya punya 2 baris debit: principal (= nominal FP)
dan fee BI-FAST (default Rp25, dapat dikonfigurasi via payload sync
`config.expected_fee` atau override per-transaksi tidak didukung — berlaku
per-batch). **Jangan membandingkan total debit langsung ke nominal FP** — fee
adalah biaya transfer yang valid, bukan selisih.

## Fallback Matching dari Description
Kalau Reference No. kosong/tidak match, backend coba parse Description bank
dengan pola `.../` diikuti `<id_outlet 2huruf+5digit><id_transaksi digit>`
(contoh: `/HH829153556344215` → outlet `HH82915`, id_transaksi `3556344215`).
Reference exact match **selalu diprioritaskan** di atas fallback ini. Baris
bank yang polanya tidak cocok sama sekali dianggap **di luar scope** rekon
(bukan otomatis BANK_ONLY) — mencegah exception queue dibanjiri mutasi bank
yang tidak terkait FP sama sekali.

## Status Rekonsiliasi
`MATCHED`, `MATCHED_NO_FEE`, `PENDING_BANK`, `FP_ONLY`, `BANK_ONLY`,
`NOMINAL_MISMATCH`, `FEE_MISMATCH`, `DUPLICATE_FP`, `DUPLICATE_BANK`,
`REVERSAL`, `NEED_REVIEW`. Detail cascade logic ada di
`reconcileTransactions()` (`backend/src/routes/warroom-reconciliation.js`).
Credit/reversal pada reference yang sama **selalu menimpa** status lain
(sinyal reversal dianggap paling kuat).

## Database
Migration: `backend/src/migrations/create_reconciliation_ocbc.sql`
Runner: `backend/scripts/run-reconciliation-ocbc-migration.js`

| Tabel | Key | Catatan |
|---|---|---|
| `recon_sync_batches` | UNIQUE(business_date, bank_code) | 1 batch per hari per bank; resync menimpa batch yang sama |
| `recon_fp_transactions` | — | Raw FP, dihapus+diisi ulang tiap chunk pertama sync |
| `recon_bank_transactions` | — (reference_no SENGAJA TIDAK unique) | Raw bank, sama seperti di atas |
| `recon_results` | UNIQUE expression index (batch_id, id_transaksi, reference_no) | Hasil engine, di-**upsert** (bukan delete+insert) supaya riwayat resolve/audit log tidak hilang saat resync |
| `recon_action_logs` | FK ke recon_results | Audit trail tiap aksi resolve |

**Idempotensi sync**: chunk pertama (`chunk_index=0`) menghapus data mentah
lama batch tsb; chunk terakhir menjalankan engine dan meng-upsert
`recon_results` by natural key, lalu menghapus baris hasil yang sudah tidak
relevan. Resync data yang sama tidak pernah menggandakan baris atau batch.

## Backend Endpoints (`backend/src/routes/warroom-reconciliation.js`)
| Endpoint | Auth | Keterangan |
|---|---|---|
| `POST /api/warroom/reconciliation/sync` | `APPS_SCRIPT_TOKEN` (token SHARED, bukan token baru) | Terima chunk FP/bank, jalankan engine di chunk terakhir |
| `GET /api/warroom/reconciliation/analytics?date=&bank_code=` | JWT | Summary, distribusi status, validasi rekening, fee analysis, recent batches |
| `GET /api/warroom/reconciliation/transactions?date=&status=&id_outlet=&id_produk=&search=&page=&limit=&sort=&order=` | JWT | List berpaginasi; `status` boleh comma-separated utk exception queue |
| `GET /api/warroom/reconciliation/export?...` | JWT | CSV (di-fetch sbg blob di frontend krn butuh header Authorization) |
| `POST /api/warroom/reconciliation/:id/resolve` | JWT | Body `{status, notes}`, tercatat di `recon_action_logs` |
| `GET /api/warroom/reconciliation/:id/logs` | JWT | Riwayat audit 1 baris hasil |

## Tidak ada tombol "Sync Sekarang" di dashboard (dicoba, dibatalkan)
Sempat dicoba: tombol di dashboard yang memanggil Apps Script lewat Web App
deployment (`doPost()` di `apps-script-reconciliation-ocbc.js` + endpoint
backend `trigger-sync`). **Tidak jalan** — deployment Web App di domain
Google Workspace `bm.co.id` mewajibkan login Google untuk request eksternal
(`Who has access: Anyone within <domain>`, bukan publik), dan ini kebijakan
admin Workspace yang tidak bisa/boleh di-bypass dari sisi kode. Alternatif
yang butuh Service Account + Google Sheets API langsung dari backend juga
dipertimbangkan tapi diputuskan terlalu ribet untuk kebutuhan saat ini
(butuh Google Cloud project baru, service account, kredensial baru, dan
duplikasi logic parsing sheet di Node.js).

Endpoint `trigger-sync`, fungsi `doPost()`, dan tombolnya di frontend
**sudah dihapus** dari kode (bukan cuma dinonaktifkan) supaya tidak ada
fitur yang diam-diam gagal tapi terlihat "berhasil" di UI. `doPost()` di
Apps Script memang masih ada sebagai fungsi (harmless, tidak dipanggil
otomatis) — boleh dihapus juga kalau mau beres-beres total, tapi tidak
wajib.

## Apps Script (`apps-script-reconciliation-ocbc.js`)
Fungsi: `testReconciliationOcbc()` (dry-run, tidak kirim), `pushReconciliationOcbc()`
(kirim, chunk 1500 baris, return `{success,message,...}`),
`setupReconciliationOcbcTrigger()`, `removeReconciliationOcbcTrigger()`.

### Auto-sync reaktif (bukan cuma interval tetap)
Karena tombol manual tidak bisa dipakai (lihat di atas), sync sepenuhnya
mengandalkan trigger 2 lapis di Apps Script supaya data tetap segar tanpa
tombol maupun campur tangan manual, otomatis segera setelah ada perubahan
di Sheet:

1. **`reconOnChangeTrigger_`** — installable trigger terpasang ke event
   `onChange` spreadsheet. HANYA menandai timestamp "ada perubahan" di
   Script Properties (`RECON_DIRTY_SINCE`) — sangat ringan, bukan sync
   langsung (kalau langsung sync di setiap onChange, edit/paste beruntun
   dari tim bisa memicu banyak sync yang tumpang tindih saling menghapus
   data batch yang sama, dan cepat menghabiskan kuota harian Apps Script).
2. **`checkAndSyncIfDirtyReconciliationOcbc`** — time-based trigger tiap
   1 menit. Baru menjalankan `pushReconciliationOcbc()` kalau: ada dirty
   flag, sudah lewat 30 detik (`RECON_DEBOUNCE_MS`) sejak edit terakhir
   (supaya tidak nyambar saat tim masih input), dan tidak ada sync lain
   yang sedang berjalan (lock `RECON_SYNC_IN_PROGRESS`).

Hasil: data ter-update otomatis ~30-90 detik setelah perubahan terakhir di
Sheet. Pasang sekali lewat `setupReconciliationOcbcTrigger()` (memasang
KEDUA trigger di atas), lepas dengan `removeReconciliationOcbcTrigger()`.

Script Properties:
- `RECONCILIATION_OCBC_SYNC_TOKEN` — **harus sama dengan `APPS_SCRIPT_TOKEN` di server** (token yang sama dipakai war-room lain)
- `RECONCILIATION_OCBC_SYNC_URL` — default `https://bmsretail.my.id/api/warroom/reconciliation/sync`

## Frontend
- Route: `/war-room/rekonsiliasi-ocbc`
- Page: `frontend/src/pages/WarRoomReconciliationOcbc.jsx`
- Menu: Payment Agent > War Room > **Rekonsiliasi OCBC** (badge `REK`, `#DC2626`)
- CSS prefix: `wrr-*`, dark/light via CSS variable BRIC standar
- 5 tab: Executive Summary, Hasil Rekonsiliasi, Exception Queue, Fee Analysis, Raw Data & Audit

## Testing
`node backend/scripts/test-reconciliation-ocbc.js` — 10 acceptance test resmi
+ beberapa test tambahan (MATCHED_NO_FEE, FEE_MISMATCH, fallback description,
BANK_ONLY scope). Jalankan di server (Node lokal Windows tidak tersedia).

## Troubleshooting
- **401 saat sync**: cek `APPS_SCRIPT_TOKEN` sudah sama di server & Script Properties Apps Script.
- **413 saat sync**: cek endpoint `reconciliation/sync` sudah masuk regex payload besar di Nginx.
- **Semua status NEED_REVIEW/BANK_ONLY membludak**: cek pola Description OCBC — kalau
  format outlet bukan 2 huruf+5 digit, sesuaikan regex `parseDescriptionFallback` di
  `warroom-reconciliation.js` DAN Apps Script tetap boleh kirim description apa adanya
  (parsing terjadi di backend, bukan Apps Script).
