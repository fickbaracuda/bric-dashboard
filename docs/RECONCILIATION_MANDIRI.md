# Rekonsiliasi FP vs Bank Mandiri — Rekonsiliasi > Rekonsiliasi Mandiri

## Tujuan
Mencocokkan transaksi FP terhadap mutasi rekening Bank Mandiri secara
otomatis. Berbeda dari OCBC: Mandiri **tidak** punya kolom Reference No. —
id_transaksi harus diekstrak dari teks `Remarks`/`AdditionalDesc`.

## Arsitektur — Reconciliation Core Engine + Adapter
Sama seperti Rekonsiliasi OCBC, fitur ini REUSE tabel generic `recon_*`
(`recon_sync_batches`, `recon_fp_transactions`, `recon_bank_transactions`,
`recon_results`, `recon_action_logs`) — dibedakan lewat `bank_code = 'MANDIRI'`.
TIDAK ada tabel `recon_mandiri_results` terpisah.

```
Reconciliation Core (tabel generic + pola sync/analytics/resolve/audit)
├── OCBC Adapter    — backend/src/routes/warroom-reconciliation.js
└── Mandiri Adapter — backend/src/reconciliation/mandiriAdapter.js
                       (dipakai oleh backend/src/routes/warroom-reconciliation-mandiri.js)
```

Helper dasar (`extractToken`, `nullIfEmpty`, `cleanNum`, `csvEscape`,
`isValidIdTransaksi`, `RECON_STATUSES`, dst) diimpor langsung dari
`warroom-reconciliation.js` — tidak diduplikasi.

## Sumber Data
Google Sheet: `1iGDzKsoDdcaL2Hfk2_q1y0N50KEMm2c6auaT9DhKPFc`
- **DATA FP**: header baris 1, data baris 2+. A-F: id_transaksi, nominal,
  id_produk, time_response, id_outlet, id_biller.
- **DATA Mandiri**: header baris 1, data baris 2+. A-H: AccountNo, Ccy,
  PostDate, Remarks, AdditionalDesc, Credit Amount, Debit Amount, Close Balance.

Semua ID (id_transaksi, AccountNo, id_outlet, id_biller) diproses sebagai
**STRING** di Apps Script maupun backend — tidak pernah lewat `Number()`.

## Ekstraksi ID Transaksi (`mandiriAdapter.js::extractMandiriRow`)
Satu transaksi FP biasanya menghasilkan 2 baris mutasi: **principal** (=
nominal FP) dan **fee transfer** (default Rp100). Aturan ekstraksi:

1. **RULE A (FEE)** — teks (setelah trim) **DIMULAI** dengan `"Transfer Fee"`
   → regex `^Transfer Fee\s+(\d{8,12})\b`. PENTING: baris principal juga
   sering mengandung kata "Transfer Fee" di EKOR deskripsi — dicek pakai
   prefix, bukan "contains", supaya tidak salah diklasifikasi (lihat test 12).
2. **RULE B (PRINCIPAL)** — kalau tidak dimulai "Transfer Fee": ambil digit
   setelah karakter `/` → regex `/(\d{8,12})\b`.
3. **RULE C (CREDIT_REVERSAL)** — `Credit Amount > 0` MENIMPA hasil A/B.
4. **RULE D (UNKNOWN)** — tidak ada pola cocok.

`Remarks` = sumber utama, `AdditionalDesc` = fallback HANYA kalau Remarks
kosong/gagal. Kalau keduanya berisi teks yang sama, tetap 1 hasil ekstraksi
(1 baris sheet = 1 baris tersimpan, tidak pernah dihitung 2x).

## Matching & Status
Grouping berdasarkan `extracted_transaction_id` (dalam 1 batch/account).
Status yang dipakai **sama persis** dengan OCBC: `MATCHED`,
`MATCHED_NO_FEE`, `PENDING_BANK`, `FP_ONLY`, `BANK_ONLY`,
`NOMINAL_MISMATCH`, `FEE_MISMATCH`, `DUPLICATE_FP`, `DUPLICATE_BANK`,
`REVERSAL`, `NEED_REVIEW`. Detail cascade logic ada di
`reconcileMandiriTransactions()`.

**Scope mode BANK_ONLY** (2 mode, default `FP_COVERAGE_WINDOW`):
- `FP_COVERAGE_WINDOW` — mutasi Mandiri dianggap kandidat BANK_ONLY hanya
  kalau PostDate-nya berada dalam rentang [min(time_response FP) − toleransi,
  max(time_response FP) + toleransi] (toleransi default 60 menit). Mutasi di
  luar rentang ini diabaikan (bukan flood exception queue).
- `FULL_BUSINESS_DATE` — seluruh mutasi batch dianggap dalam scope.

Fee-only/credit-only group (tanpa baris principal) **tidak pernah** dianggap
kandidat BANK_ONLY — itu bukan "transaksi berdiri sendiri".

## Validasi Waktu
`DATA FP.time_response` dibanding `DATA Mandiri.PostDate`, di-anchor ke
**Asia/Jakarta (+07:00)** secara eksplisit (bukan timezone server VPS yang
Asia/Shanghai/UTC+8) — lihat `parseFlexibleDateTime()` di
`warroom-reconciliation-mandiri.js`. Kategori: 0-5 menit=normal,
5-15=warning, 15-30=delayed, >30=exception. Selisih waktu adalah indikator
keterlambatan posting, **bukan** pembanding nominal.

## Validasi Saldo (`validateMandiriBalance`)
Level BATCH (bukan per-transaksi). Urutan statement (menaik/menurun) tidak
selalu sama, jadi dideteksi otomatis dengan mencoba kedua arah dan memilih
yang paling konsisten. Status: `BALANCED` / `UNBALANCED` /
`BALANCE_CHECK_UNDETERMINED`. Hasil ini murni informatif — TIDAK mengubah
status rekonsiliasi transaksi manapun.

## Database
Migration: `backend/src/migrations/add_reconciliation_mandiri_columns.sql`
(perluasan tabel `recon_*` yang sudah ada, semua kolom baru nullable —
tidak mengubah perilaku baris OCBC yang sudah ada).
Runner: `backend/scripts/run-reconciliation-mandiri-migration.js`

Kolom baru penting: `recon_bank_transactions.extracted_transaction_id` /
`bank_row_type` / `extraction_method` / `post_date_time` (TIMESTAMPTZ, bukan
DATE — supaya presisi jam-menit tidak hilang), `recon_sync_batches.scope_mode`
/ `expected_fee` / `grace_period_minutes` / `account_no`,
`recon_results.bank_code` / `time_difference_minutes`.

## Backend Endpoints (`backend/src/routes/warroom-reconciliation-mandiri.js`)
| Endpoint | Auth | Keterangan |
|---|---|---|
| `POST /api/warroom/reconciliation/mandiri/sync` | `APPS_SCRIPT_TOKEN` (token SHARED) | Chunk FP/Mandiri, jalankan adapter+engine di chunk terakhir |
| `GET /api/warroom/reconciliation/sync-request-status?bank_code=MANDIRI` | `APPS_SCRIPT_TOKEN` | Endpoint GENERIK (bukan di bawah `/mandiri`) — dipanggil Apps Script Mandiri tiap 1 menit, cek tombol "Sync Now" |
| `POST /api/warroom/reconciliation/request-sync` | JWT | Endpoint GENERIK (bukan di bawah `/mandiri`) — tombol "Sync Now", body `{bank_code: 'MANDIRI'}` |
| `GET /api/warroom/reconciliation/mandiri/analytics?date=` | JWT | Summary, status distribution, fee analysis, time analysis, balance validation |
| `GET /api/warroom/reconciliation/mandiri/transactions?...` | JWT | List berpaginasi (status boleh comma-separated) |
| `GET /api/warroom/reconciliation/mandiri/raw-bank?date=` | JWT | Raw baris mutasi Mandiri + hasil ekstraksi |
| `GET /api/warroom/reconciliation/mandiri/raw-fp?date=` | JWT | Raw baris DATA FP |
| `GET /api/warroom/reconciliation/mandiri/export?...` | JWT | CSV (fetch sbg blob, butuh header Authorization) |
| `POST /api/warroom/reconciliation/mandiri/:id/resolve` | JWT | Body `{status, notes}`, matching_method di-set `MANUAL_RESOLUTION` |
| `GET /api/warroom/reconciliation/mandiri/:id/logs` | JWT | Riwayat audit 1 baris hasil |
| `GET /api/warroom/reconciliation/mandiri/resolution-history?date=` | JWT | Rekap semua resolve manual pada batch tanggal ini |

## Frontend
- Route: `/war-room/rekonsiliasi/mandiri`
- Page: `frontend/src/pages/WarRoomReconciliationMandiri.jsx`
- Menu: Rekonsiliasi > **Rekonsiliasi Mandiri** (badge `MDR`, `#003D79`)
- CSS: reuse `wrr-*` (layout generik dari halaman OCBC — tabs/panel/kpi/table/
  modal/pagination, memang tidak spesifik OCBC) + `wrrm-*` (elemen BARU:
  validasi saldo, bucket waktu, sub-tab Raw Data & Audit)
- 6 tab: Executive Summary, Hasil Rekonsiliasi, Exception Queue, Fee Analysis,
  Time & Posting Analysis, Raw Data & Audit (4 sub-tab: Raw FP, Raw Mandiri,
  Sync History, Resolution History)

## Apps Script (`apps-script-reconciliation-mandiri.js`)
Fungsi: `testReconciliationMandiri()` (dry-run), `pushReconciliationMandiri()`
(kirim, chunk 1500 baris), `setupReconciliationMandiriTrigger()`,
`removeReconciliationMandiriTrigger()`, `getReconciliationMandiriStatus()`
(lihat ringkasan sync terakhir tanpa buka Execution Log).

Header sheet dibaca **by NAME** (bukan index hardcode) — kolom boleh
berpindah posisi asal nama header sesuai spek.

### Tombol "Sync Now" — kompromi, BUKAN sync instan
Sama seperti Rekonsiliasi OCBC (lihat `docs/RECONCILIATION_OCBC.md` bagian
"Tombol Sync Now" utk penjelasan lengkap kenapa Web App Apps Script tidak
bisa dipanggil langsung dari browser). Ringkasnya: tombol di dashboard
HANYA mencatat permintaan lewat `POST .../reconciliation/request-sync`
(endpoint generik, dipakai bareng dengan OCBC); trigger checker Apps Script
Mandiri yang sudah jalan tiap 1 menit ikut mengecek permintaan itu lewat
`reconMdrCheckForceSyncRequested_()` dan sync SEKARANG kalau ada. Realistis
~1-2 menit dari klik sampai data ter-update, bukan instan.

### Auto-sync REAKTIF (bukan interval tetap)
Sync mengandalkan trigger 2 lapis supaya data ter-update otomatis segera
setelah ada perubahan di Sheet ATAU setelah tombol "Sync Now" ditekan —
BUKAN menunggu interval tetap (mis. 5 menit):

1. **`reconMdrOnChangeTrigger_`** — installable trigger terpasang ke event
   `onChange` spreadsheet. HANYA menandai timestamp "ada perubahan" di
   Script Properties (`RECON_MDR_DIRTY_SINCE`) — sangat ringan, bukan sync
   langsung (kalau langsung sync di setiap onChange, edit/paste beruntun
   dari tim bisa memicu banyak sync yang tumpang tindih saling menghapus
   data batch yang sama, dan cepat menghabiskan kuota harian Apps Script).
2. **`checkAndSyncIfDirtyReconciliationMandiri`** — time-based trigger tiap
   1 menit. Menjalankan `pushReconciliationMandiri()` kalau: (ada dirty
   flag DAN sudah lewat 30 detik debounce sejak edit terakhir) ATAU ada
   permintaan "Sync Now" dari dashboard (skip debounce) — DAN tidak ada
   sync lain yang sedang berjalan (lock `RECON_MDR_SYNC_IN_PROGRESS`).

Hasil: data ter-update otomatis ~30-90 detik setelah perubahan terakhir di
Sheet. Pasang sekali lewat `setupReconciliationMandiriTrigger()` (memasang
KEDUA trigger di atas), lepas dengan `removeReconciliationMandiriTrigger()`.

### Setup
1. Buka spreadsheet `1iGDzKsoDdcaL2Hfk2_q1y0N50KEMm2c6auaT9DhKPFc` →
   Extensions > Apps Script.
2. Tempel isi `apps-script-reconciliation-mandiri.js` sebagai file baru.
3. Project Settings > Script Properties:
   - `BRIC_SYNC_TOKEN` = sama dengan `APPS_SCRIPT_TOKEN` di server (**jangan** ditulis di source code)
   - `BRIC_API_BASE_URL` = `https://bmsretail.my.id` (opsional, ini defaultnya)
4. Jalankan `testReconciliationMandiri()` dulu — cek Execution Log.
5. Jalankan `pushReconciliationMandiri()` untuk sync manual pertama kali.
6. Jalankan `setupReconciliationMandiriTrigger()` untuk sync otomatis reaktif
   (~30-90 detik setelah ada perubahan apa pun di Sheet).

## Troubleshooting
- **401 saat sync**: cek `BRIC_SYNC_TOKEN` di Script Properties sama dengan `APPS_SCRIPT_TOKEN` server.
- **413 saat sync**: cek endpoint `reconciliation/mandiri/sync` sudah masuk regex payload besar di Nginx.
- **Banyak NEED_REVIEW**: kemungkinan format Remarks Mandiri berubah — cek pola
  regex di `extractMandiriRow()` (`mandiriAdapter.js`) terhadap contoh Remarks terbaru.
- **BANK_ONLY membludak**: kemungkinan scope_mode perlu `FULL_BUSINESS_DATE`
  atau toleransi coverage window (`coverageToleranceMinutes`) perlu diperbesar.
- **PostDate hasil dry-run tidak masuk akal (mis. bulan jauh berbeda dari
  DATA FP, atau di masa depan)**: insiden nyata — kolom PostDate di sheet
  `DATA Mandiri` sudah ter-parse jadi Date object oleh Google Sheets dengan
  urutan hari/bulan yang TERTUKAR (tergantung locale spreadsheet vs format
  asli export bank, mis. `07/10/2026` dibaca Oktober alih-alih Juli). Begitu
  Sheets sudah mengonversi jadi Date, teks aslinya tidak bisa direkonstruksi
  lagi. `reconMdrFixPostDateSwap_()` di Apps Script otomatis mendeteksi &
  mengoreksi ini — SATU-SATUNYA syarat koreksi jalan: tanggal hasil parse
  Sheets ada di **masa depan** (mustahil utk mutasi yang sudah settle) DAN
  hari≤12 (supaya pertukaran hari/bulan menghasilkan tanggal valid). Kalau
  Execution Log masih menunjukkan `WARNING: PostDate ... tidak bisa
  dikoreksi (hari>12...)`, cek manual sheet DATA Mandiri baris tsb — berarti
  hari aslinya >12 sehingga tidak bisa ditukar otomatis, kemungkinan data
  sumbernya sendiri yang salah/perlu diperbaiki manual di sheet.
