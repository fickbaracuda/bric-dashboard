# Rekonsiliasi FP vs Bank BNI — War Room Rekonsiliasi > BNI

## Tujuan
Mencocokkan transaksi Fastpay pada sheet "Data FP" dengan mutasi rekening
pada sheet "Data Bank BNI" secara otomatis. MODUL BARU, TERPISAH dari
Rekonsiliasi OCBC/Mandiri/BRI/BRI BI-FAST existing — tidak mengubah
route/adapter/matching engine bank lain sama sekali.

`bank_code = 'BNI'`. Route frontend `/war-room/rekonsiliasi/bni`. Base route
backend `/api/warroom/reconciliation/bni`. Tema warna `#F15A23`.

## Beda Mendasar dari Bank Lain
- **Matching key**: `DATA FP.id_transaksi` == transaction ID hasil
  **ekstraksi** dari Description mutasi bank (BUKAN Reference No./bill_info1
  langsung — BNI tidak punya kolom reference terpisah).
- **2 sumber ekstraksi independen** per baris Description: hash
  (`BMS_SNAP API #<10 digit>`) dan reference (10 digit terakhir dari token
  setelah `/`). Confidence HIGH (setuju) / MEDIUM (1 sumber) / CONFLICT (beda,
  TIDAK PERNAH diam-diam memilih salah satu) / NONE.
- **scope_mode default `FP_COVERAGE_WINDOW`** (bukan `FULL_BUSINESS_DATE`) —
  Data FP bisa berupa potongan waktu, jadi mutasi bank di luar rentang
  waktu FP (± toleransi, default 5 menit) TIDAK PERNAH otomatis dianggap
  `BANK_ONLY`.
- **Funding credit** (`PB KE BNI MULTIBILLER` / `BIMASAKTI MULTI SINERGI`)
  BUKAN transaksi rekonsiliasi — tidak pernah `MATCHED`/`BANK_ONLY`/
  `REVERSAL`, tidak masuk match rate, TIDAK PERNAH menghasilkan
  `recon_results` sama sekali. Dipakai murni untuk Saldo & Funding Analysis
  ("Net Cash Movement", BUKAN saldo rekening aktual — file mutasi tidak
  punya opening/closing balance).
- **Time order dalam DETIK** (bukan menit) — sample selisih waktu FP vs
  posting bank sering hanya 0-1 detik.

## Google Sheet
Spreadsheet: `1cW7SfkL8nCbWuGhOI9IVCmEzy3HN4z66FCcYDkiHtbw`. TIDAK
di-hardcode di kode — dikonfigurasi via Script Property `BNI_SPREADSHEET_ID`
(fallback `SpreadsheetApp.getActiveSpreadsheet()`). Nama sheet via
`BNI_FP_SHEET_NAME` (default "Data FP") dan `BNI_BANK_SHEET_NAME` (default
"Data Bank BNI").

### Data FP
Header (dibaca by nama): `id_transaksi, nominal, id_produk, time_response,
id_outlet, id_biller`. Kandidat BNI = `id_biller = '141'` — filter ini
dilakukan **BACKEND** (`isBniFpCandidate()`), bukan Apps Script (spec
eksplisit: id_produk TIDAK dipakai memfilter kandidat, hanya disimpan utk
filter/analisis). `id_transaksi`/`id_produk`/`id_outlet`/`id_biller` WAJIB
string murni (leading zero/presisi digit besar tidak boleh hilang).

### Data Bank BNI
Header: `Post Date, Value Date, Branch, Journal No., Description, Debit,
Credit`. Contoh baris debit:
```
Post Date: 22/07/26 08.39.01
Description: TRANSFER KE | BMS_SNAP API #3562421092 FASTPAY
             0246405258/353562421092 | KOPERASI KREDIT HANDAYANI BAJAWA
Debit: 300,000.00
```
`Branch`/`Journal No.`/`Description` WAJIB string murni. `Debit`/`Credit`
numeric (parser `cleanNum` — WAJIB cek `typeof v === 'number'` dulu sebelum
string replace, sama insiden Speedcash).

## Account Number
File mutasi BNI **tidak punya kolom nomor rekening**. `account_no` HANYA
dari konfigurasi eksplisit Script Property `BNI_ACCOUNT_NO` (dikirim Apps
Script sbg `body.account_no`). Kalau belum dikonfigurasi: `account_no`
disimpan `NULL`, frontend menampilkan "Tidak tersedia", rekonsiliasi
**TETAP JALAN NORMAL** (tidak digagalkan). Angka pada teks `TRF TO:...` di
Description TIDAK PERNAH dianggap nomor rekening resmi tanpa konfigurasi.

## Ekstraksi Transaction ID (`bniAdapter.js`)

### `extractBniIdentifiers(description)`
Dua sumber independen:
1. **Hash ID** — `/BMS_SNAP\s+API\s*#\s*(\d{10})\b/i`, fallback
   `/#\s*(\d{10})\b/`.
2. **Reference ID** — dianchor ke pola `FASTPAY <akun>/<referensi>`
   (`/FASTPAY\s+(\d{6,20})\/(\d{10,20})\b/i`) supaya beneficiary_account &
   reference ID digali dari konstruksi yang SAMA (bukan slash pertama yang
   kebetulan ditemukan di teks manapun) — fallback bare `/\/(\d{10,20})\b/`
   kalau pola FASTPAY tidak ketemu. Ambil **10 digit TERAKHIR** dari token,
   TIDAK PERNAH diubah ke `Number()` (contoh: `353562421092` → `3562421092`;
   `3563562425311` → `3562425311`).

`extractionConfidence`: `HIGH` (dua sumber sama), `MEDIUM` (1 sumber),
`CONFLICT` (dua sumber beda — `idConflict=true`, `extractedTransactionId`
TETAP `null`, TIDAK PERNAH diam-diam memilih salah satu), `NONE` (tidak ada).

`beneficiaryAccount` (group 1 pola FASTPAY, string, leading zero
dipertahankan) dan `recipientName` (teks setelah separator `|` TERAKHIR)
disimpan HANYA untuk audit — **BUKAN** matching key.

### `classifyBniBankRow(row, extraction, coverageStatus)`
Cascade: Description kosong → `UNKNOWN`. Credit>0 + pola funding →
`FUNDING_CREDIT`. Debit>0 + `BMS_SNAP API` + `FASTPAY` + ID valid →
`FASTPAY_DEBIT`. Credit>0 + pola sama + ID valid → `CREDIT_REVERSAL`. Pola
Fastpay tapi ID tidak valid/conflict → `NEED_REVIEW` kalau
`INSIDE_FP_COVERAGE`, else `OUT_OF_SCOPE` (tersimpan di Raw Data, TIDAK
PERNAH jadi actionable exception). Non-Fastpay → `OUT_OF_SCOPE`.

### `parseBniDateTime(value)`
Format bank: `DD/MM/YY HH.mm.ss` (titik sbg pemisah jam, BUKAN titik dua),
di-anchor Asia/Jakarta (+07:00) eksplisit. Tahun 2 digit 00-69 → 2000-2069,
70-99 → 1900-1999. **TIDAK PERNAH** fallback ke `Date.parse()` native (locale
bisa salah tafsir DD/MM jadi MM/DD) — format tak dikenali → `null`. Post
Date = posting time (`transaction_date_time`), Value Date = business date
(`business_date`, effective_date_time) — fallback ke tanggal Post Date kalau
Value Date kosong.

## Coverage Window
`computeBniCoverage(fpRows, toleranceBefore=5, toleranceAfter=5)`:
`coverageStart/End` = min/max `FP.time_response` ± toleransi menit. "Core"
(`fpMinTime..fpMaxTime`, TANPA toleransi) membedakan `INSIDE_FP_COVERAGE`
(di dalam rentang FP asli) dari `BOUNDARY_PARTIAL` (di zona toleransi tapi
di luar rentang FP asli). `OUTSIDE_FP_COVERAGE` = di luar toleransi sama
sekali. `UNDETERMINED` = waktu tidak valid/tidak ada data FP sama sekali.

Aturan: `FASTPAY_DEBIT` di luar coverage TETAP tersimpan di Raw Data, TIDAK
PERNAH jadi `BANK_ONLY`, TIDAK masuk Exception Queue, TIDAK menurunkan valid
match rate. `FUNDING_CREDIT` tetap masuk Funding Analysis meski di luar
coverage. Exact FP yang ditemukan TETAP boleh dicocokkan selama lolos
aturan waktu (matching TIDAK dibatasi coverage — hanya sintesis
`BANK_ONLY`/`NEED_REVIEW` standalone tanpa FP yang dibatasi).

## Grouping & Matching (`reconcileBniTransactions`)
Group key: `bank_code + business_date + extracted_transaction_id`, fallback
`bank_fingerprint` kalau ID tidak tersedia. >1 baris debit dgn ID sama pada
group yang sama → `DUPLICATE_BANK` (TIDAK dijumlahkan otomatis).

Matching one-to-one murni berdasarkan `extracted_transaction_id` — TIDAK
PERNAH fallback ke nominal/waktu/recipient name/beneficiary account/Journal
No. `matching_method`: `TIER1_EXACT` (HIGH), `HASH_ONLY`/`REFERENCE_ONLY`
(MEDIUM).

### Cascade Status
1. `DUPLICATE_FP` (id_transaksi FP muncul >1x).
2. Tidak ada bank group → `PENDING_BANK` (masih grace period, default 30
   menit) / `FP_ONLY` (lewat grace).
3. >1 debit ID sama → `DUPLICATE_BANK`.
4. `expected_fee=0`: debit==nominal FP → `MATCHED`. `expected_fee>0`:
   debit==nominal+fee → `MATCHED`; debit==nominal (fee 0 di bank) →
   `MATCHED_NO_FEE`; debit>nominal (selisih ≠ expected_fee) →
   `FEE_MISMATCH`; debit<nominal → `NOMINAL_MISMATCH`.
5. `time_order_status` `EXTREME`/`IMPOSSIBLE_ORDER` pada hasil
   MATCHED/MATCHED_NO_FEE/FEE_MISMATCH → **override** ke `NEED_REVIEW`
   (exact ID tidak otomatis valid kalau waktu sangat tidak wajar).
6. Credit reversal dgn ID exact sama → `REVERSAL` (**prioritas tertinggi**,
   menimpa status apa pun di atas).

`time_order_status`: `NORMAL` (≤60 detik), `WARNING` (≤5 menit), `DELAYED`
(≤15 menit), `EXTREME` (>15 menit), `IMPOSSIBLE_ORDER` (bank posting >5
menit SEBELUM FP).

### BANK_ONLY
HANYA dibuat untuk `FASTPAY_DEBIT` yang: extracted ID valid (bukan
conflict), `INSIDE_FP_COVERAGE`, belum consumed, tidak punya pasangan FP,
hanya 1 baris debit dalam group. Kalau ID tidak valid → `NEED_REVIEW` bukan
`BANK_ONLY`. Kalau di luar coverage → TIDAK ada hasil sintetis sama sekali
(raw data saja).

### Reversal Cross-Date Lookup
`applyBniReversalCrossDateLookup()` — TERISOLASI dari
`reconcileBniTransactions()` (pure function terpisah). Cari maksimal
`business_date + 3 hari` (`reversal_lookup_days`), HANYA exact
`extracted_transaction_id` (TIDAK PERNAH nominal/nama penerima).
`reversal_lookup_source`: `SAME_DATE` (same-batch) atau `CROSS_DATE_ID`.

## Konfigurasi Default (terpusat, `bniAdapter.js`)
```
bank_code = 'BNI'                          candidate_biller = '141'
expected_fee = 0                            grace_period_minutes = 30
scope_mode = 'FP_COVERAGE_WINDOW'           coverage_tolerance_before_minutes = 5
coverage_tolerance_after_minutes = 5        matching_time_tolerance_minutes = 15
bank_before_fp_tolerance_minutes = 5        reversal_lookup_days = 3
timezone = 'Asia/Jakarta'
```
Semua configurable per batch via `body.config.*` saat sync (fallback ke
default di atas via env var `RECON_BNI_*`) — TIDAK di-hardcode berulang di
Apps Script maupun handler.

## Fingerprint (idempotensi sync)
`buildBniBankFingerprint()` — SHA-256 dari `bank_code|Post Date|Value
Date|Branch|Journal No.|normalized Description|Debit|Credit`. SENGAJA TIDAK
memakai nomor baris sheet (posisi baris bisa berubah antar sync). Reuse
partial unique index global `uq_recon_bank_transactions_fingerprint`
(`row_fingerprint`) yang sudah ada dari migration BRI — aman lintas bank
krn `bank_code` sudah ikut di-hash.

## Database
Reuse tabel generic `recon_sync_batches`/`recon_fp_transactions`/
`recon_bank_transactions`/`recon_results`/`recon_action_logs`
(`bank_code='BNI'`) — **TIDAK ADA tabel baru**.

**REUSE besar-besaran** dari kolom generic yang sudah ada (dari migration
OCBC/Mandiri/BRI/BRI BI-FAST): `description`, `debit`, `credit`,
`business_date`, `transaction_date_time` (Post Date), `effective_date_time`
(Value Date), `beneficiary_account`, `extracted_transaction_id`,
`extraction_confidence`, `id_conflict`, `bank_row_type`, `coverage_status`,
`row_fingerprint`, `sequence_no` (reuse utk Journal No.) di
`recon_bank_transactions`; `bank_code`, `canonical_transaction_key`,
`coverage_status`, `coverage_reason`, `is_actionable`,
`eligible_for_match_rate`, `time_order_status`, `id_conflict`,
`extracted_transaction_id` (reuse utk "bank_transaction_id"),
`bank_beneficiary_account` (reuse utk beneficiary_account),
`bank_principal`, `bank_fee`, `bank_total_debit` (reuse utk gross debit),
`variance_principal`, `variance_fee`, `matching_method`, `reversal_date`,
`reversal_amount`, `reversal_lookup_source` di `recon_results`.

**Kolom BARU** (migration `add_reconciliation_bni_columns.sql`):
| Tabel | Kolom | Alasan |
|---|---|---|
| `recon_sync_batches` | `coverage_tolerance_before_minutes`, `coverage_tolerance_after_minutes` | coverage window asimetris (generic `coverage_tolerance_minutes` cuma 1 angka) |
| `recon_bank_transactions` | `transaction_id_from_hash`, `transaction_id_from_reference` | audit 2 sumber ekstraksi terpisah dari hasil akhir |
| `recon_bank_transactions` | `recipient_name` | audit only, bukan matching key |
| `recon_bank_transactions` | `branch` | tidak ada kolom generic yang cocok |
| `recon_results` | `recipient_name`, `bank_branch`, `bank_journal_no` | denormalisasi utk tampilan tabel Hasil Rekonsiliasi (pola sama dgn `bank_beneficiary_account` BRI BI-FAST) |
| `recon_results` | `transaction_id_from_hash`, `transaction_id_from_reference` | audit di tabel hasil, bukan cuma Raw Data |
| `recon_results` | `time_difference_seconds` | BNI pakai presisi detik (bukan menit) |
| `recon_results` | `extraction_confidence` | HIGH/MEDIUM/CONFLICT/NONE per hasil |

`finance_balance_requests.bank_code` CHECK constraint diperluas menerima
`'BNI'` (redefinisi idempotent, tidak menghapus data, tetap menerima OCBC/
MANDIRI/BRI/BRI_BIFAST).

Migration: `backend/src/migrations/add_reconciliation_bni_columns.sql`.
Runner: `node backend/scripts/run-reconciliation-bni-migration.js`.

Unique index upsert: `(batch_id, canonical_transaction_key)` (sudah ada,
generic). `canonical_transaction_key`: FP match → `normalize(id_transaksi)`;
`BANK_ONLY` → `'BNI_BANK::' + extracted_transaction_id`; `NEED_REVIEW` tanpa
ID → `'BNI_REVIEW::' + bank_fingerprint`. Upsert (bukan delete-all lalu
insert ulang) — manual resolution & audit log bertahan setelah resync.

## Backend Files
- `backend/src/reconciliation/bniAdapter.js` — SEMUA fungsi pure (extraction,
  classification, time parsing, coverage, grouping, matching engine,
  reversal cross-date lookup, fingerprint). Di-unit-test langsung.
- `backend/src/routes/warroom-reconciliation-bni.js` — sync handler (2-pass:
  insert raw dulu, klasifikasi+engine di chunk terakhir setelah coverage
  window bisa dihitung dari SELURUH FP batch), analytics, daily-report,
  transactions, raw-fp, raw-bank, export, resolve, resolution-history,
  action-logs.
- `backend/scripts/test-reconciliation-bni.js` — 30 test otomatis (2 test
  DB-dependent — idempotensi resync & manual resolve bertahan — didokumentasi
  sbg verifikasi live/server, pola sama dgn adapter bank lain).

## Backend Endpoints
| Endpoint | Auth | Keterangan |
|---|---|---|
| `POST /api/warroom/reconciliation/bni/sync` | `APPS_SCRIPT_TOKEN` (token SHARED) | Chunk 1500 baris. 2-pass: insert raw → (chunk terakhir) hitung coverage dari SELURUH FP batch → klasifikasi tiap baris bank → jalankan engine → upsert `recon_results`. |
| `GET /api/warroom/reconciliation/bni/analytics?date=` | JWT | Summary, coverage, extraction_summary, funding_summary, time_analysis, data_quality_warning. `empty:true` kalau batch tanggal tsb tidak ada — TIDAK fallback. |
| `GET /api/warroom/reconciliation/bni/daily-report?date=` | JWT | Laporan Harian — default hari ini WIB, TIDAK fallback tanggal lain. |
| `GET /api/warroom/reconciliation/bni/transactions?date=&status=&id_transaksi=&id_produk=&id_outlet=&id_biller=&beneficiary_account=&recipient_name=&journal_no=&coverage_status=&search=&page=&limit=&sort=&order=` | JWT | List berpaginasi. |
| `GET /api/warroom/reconciliation/bni/raw-fp?date=` / `raw-bank?date=` | JWT | Raw Data & Audit sub-tab. |
| `GET /api/warroom/reconciliation/bni/export?...` | JWT | CSV. |
| `POST /api/warroom/reconciliation/bni/:id/resolve` | JWT | `{status, notes}` (catatan wajib), tercatat `recon_action_logs`. |
| `GET /api/warroom/reconciliation/bni/:id/logs` | JWT | Audit log 1 baris hasil. |
| `GET /api/warroom/reconciliation/bni/resolution-history?date=` | JWT | Riwayat resolve 1 hari (200 terakhir). |
| `POST /api/warroom/reconciliation/request-sync` | JWT | Generic (bank_code="BNI" di body) — dipakai bersama semua bank rekonsiliasi. |

Route statis (`daily-report`, `resolution-history`, `raw-bank`, `raw-fp`,
`export`) didaftarkan SEBELUM route dinamis `:id` di `app.js` (pola generik
Express — hindari `:id` menelan path statis).

## Actionable Exception & Health Status
Actionable = 9 `EXCEPTION_STATUSES` (semua kecuali `MATCHED`/
`MATCHED_NO_FEE`). `FUNDING_CREDIT`/`OUT_OF_SCOPE`/`OUTSIDE_FP_COVERAGE`
TIDAK PERNAH masuk hitungan — otomatis terkecuali krn TIDAK PERNAH
menghasilkan `recon_results` sama sekali (bukan via flag `is_actionable`
yang di-suppress, tapi structural: baris itu memang tidak pernah dibuat).

Health: `GREEN` (match rate ≥99%, tidak ada actionable exception, tidak ada
integrity issue), `YELLOW` (95-99%, ada actionable exception, extraction
confidence MEDIUM material, atau posting delay), `RED` (<95%, sync gagal,
duplicate canonical, consumed-juga-bank-only, ID conflict material,
malformed ID material, impossible time order material). Funding credit &
mutasi luar coverage **TIDAK PERNAH** memengaruhi health.

## Frontend
- Route: `/war-room/rekonsiliasi/bni`. Page:
  `frontend/src/pages/WarRoomReconciliationBni.jsx`. Menu: Rekonsiliasi >
  **Rekonsiliasi BNI** (badge `BNI`, `#F15A23`).
- REUSE besar-besaran CSS generik `wrr-*`/`wrrbri-*` (panel/kpi/table/modal/
  pagination/badge) yang sudah dibangun utk OCBC/Mandiri/BRI/BRI BI-FAST —
  TIDAK ada CSS terpisah per bank. Badge baru ditambahkan ke set generik:
  `.wrrbri-badge--boundary_partial`, `.wrrbri-badge--undetermined`,
  `.wrrbri-badge--funding_credit`.
- **7 tab**: Executive Summary, Hasil Rekonsiliasi, Exception Queue, Saldo &
  Funding Analysis, Time & Posting Analysis (detik), Raw Data & Audit (4
  sub-tab: Raw FP/Raw Bank/Sync History/Resolution History), Laporan Harian.
- Endpoint TIDAK di-cache, request ID guard (`requestIdRef`) saat tanggal
  berganti — sama pola dgn semua halaman rekonsiliasi lain.
- `<BalanceRequestButton bankCode="BNI" />` — komponen shared, tidak diubah.

## Apps Script (`apps-script-reconciliation-bni.js`)
Fungsi: `testReconciliationBni()` (dry-run), `pushReconciliationBni()`
(kirim, chunk 1500 baris), `setupReconciliationBniTrigger()`,
`removeReconciliationBniTrigger()`, `checkReconciliationBniChanges()`
(dipanggil trigger 1 menit, pakai `LockService` cegah overlap),
`getReconciliationBniStatus()`.

Script Properties: `BRIC_SYNC_TOKEN`, `BRIC_API_BASE_URL`,
`BNI_SPREADSHEET_ID`, `BNI_FP_SHEET_NAME`, `BNI_BANK_SHEET_NAME`,
`BNI_ACCOUNT_NO`.

Apps Script HANYA membaca sheet & mengirim raw data (mempertahankan string,
membersihkan numeric) — TIDAK PERNAH mengekstrak transaction ID, menentukan
coverage, matching, status, klasifikasi funding, atau dedupe bisnis. Seluruh
business logic ada di backend (`bniAdapter.js`).

Reactive sync: `onChange` trigger hanya menandai dirty flag → checker tiap 1
menit (debounce 30 detik, `LockService` cegah overlap) → sync ~30-90 detik
setelah perubahan terakhir di Sheet, atau ~1-2 menit setelah tombol "Sync
Now" (endpoint generic `request-sync`, sama pola dgn bank lain).

## Testing
`node backend/scripts/test-reconciliation-bni.js` — 30 test (extraction
hash/reference/confidence/leading-zero, parseBniDateTime format BNI,
matching cascade MATCHED/NOMINAL_MISMATCH/DUPLICATE_FP/DUPLICATE_BANK/
PENDING_BANK/FP_ONLY/BANK_ONLY/coverage-gating/FUNDING_CREDIT-exclusion/
REVERSAL/NEED_REVIEW-malformed/consumed-not-bank-only, fingerprint stabil,
sample acceptance 37 transaksi MATCHED + Rp27.023.888 + funding
Rp200.000.000, `buildTransactionsQuery` no-fallback). 2 test (idempotensi
resync via `row_fingerprint`, manual resolve bertahan via
`canonical_transaction_key` upsert) DB-dependent — diverifikasi live/server
sungguhan (pola sama dgn seluruh adapter bank lain di project ini, lihat
`test-reconciliation-ocbc.js`).

## Nginx
Endpoint `POST /api/warroom/reconciliation/bni/sync` ditambahkan ke regex
payload besar (`nginx-bric.conf`) — `bni` masuk grup
`reconciliation(/mandiri|/bri|/bri-bifast|/bni)?`.

## Batasan (Tidak Boleh Dilakukan)
Mencocokkan berdasarkan nominal/nama penerima/beneficiary account saja;
mengubah `id_transaksi` jadi `Number()`; menganggap funding credit sbg
reversal; menganggap seluruh debit bank sbg `BANK_ONLY` tanpa cek coverage;
mengabaikan FP coverage window; mengklaim net cash movement sbg saldo
rekening aktual; memakai `Date.parse()` native utk format BNI; delete-all
`recon_results`; menghapus audit log; hardcode credential.
