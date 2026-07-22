# Rekonsiliasi FP vs BRI BI-FAST — Rekonsiliasi > Rekonsiliasi BRI BI-FAST

## Tujuan

Mencocokkan transaksi pada sheet **"Data FP"** dengan mutasi pada sheet
**"Data Bank BRI BI Fast"** untuk pipeline BI-FAST (Bank Indonesia Fast
Payment) via BRI.

Modul ini **BARU dan TERPISAH** dari Rekonsiliasi BRI existing
(`warroom-reconciliation-bri.js` + `briAdapter.js` + `WarRoomReconciliationBri.jsx`).
Tidak satu pun file BRI existing diubah oleh paket ini.

- `bank_code` internal: `BRI_BIFAST`
- Label tampilan: **BRI BI-FAST**
- Route frontend: `/war-room/rekonsiliasi/bri-bifast`
- Route backend: `/api/warroom/reconciliation/bri-bifast`
- Badge sidebar: **BRI BF**, warna utama navy BRI `#00529C`

## Arsitektur — Reconciliation Core Engine + Adapter Baru

```
backend/src/routes/warroom-reconciliation.js         (Core generik: extractToken,
                                                        nullIfEmpty, cleanNum, csvEscape,
                                                        safeDiv, RECON_STATUSES,
                                                        EXCEPTION_STATUSES,
                                                        normalizeCanonicalKey, todayJakarta,
                                                        requestSyncHandler generik,
                                                        syncRequestStatusHandler generik)
backend/src/reconciliation/briBifastAdapter.js        (Adapter BARU — ekstraksi,
                                                        klasifikasi, grouping,
                                                        matching, reversal, balance,
                                                        fingerprint — SEMUA pure function,
                                                        TIDAK mengimpor briAdapter.js)
backend/src/routes/warroom-reconciliation-bri-bifast.js (Route handler BARU — sync,
                                                        analytics, daily-report,
                                                        transactions, raw-fp/raw-bank,
                                                        export, resolve, logs,
                                                        resolution-history)
```

**Kenapa adapter terpisah, bukan reuse `briAdapter.js`?** Struktur transaksi
BRI BI-FAST fundamental berbeda dari BRI existing:

| | BRI existing | BRI BI-FAST |
|---|---|---|
| 1 transaksi bank | 1 baris debit gross (principal+fee digabung) | 2 baris debit terpisah (principal + fee Rp77) |
| Matching key | `id_transaksi` (diekstrak dari DESK_TRAN/TRREMK/TLBDS2) | `bill_info1` (FP) `==` `beneficiary_account` (hasil ekstraksi pola `BFST<digits>`) |
| Grouping bank | per `extracted_transaction_id` | per `bank_trace_id` (dari TLBDS2, fallback composite key) |
| Coverage window | Ada (`FP_COVERAGE_WINDOW` default) | Tidak ada — `scope_mode` selalu `FULL_BUSINESS_DATE` |

Mencampur logic keduanya berisiko menerapkan aturan gross-debit BRI ke BI-FAST
atau sebaliknya — karena itu adapter & route handler BENAR-BENAR berdiri
sendiri, hanya reuse helper generik dari `warroom-reconciliation.js` (yang
maknanya identik lintas bank: parsing angka, csvEscape, dst).

## Sumber Data — Format Google Sheet

Spreadsheet ID **TIDAK di-hardcode** — diambil dari Script Property
`BRI_BIFAST_SPREADSHEET_ID`, fallback `SpreadsheetApp.getActiveSpreadsheet()`.

### Sheet "Data FP"
Header baris 1 (dibaca BY NAME, fallback index A:G kalau nama tidak ditemukan),
data mulai baris 2:

```
A: id_transaksi   B: bill_info1   C: nominal   D: id_produk
E: time_response  F: id_outlet    G: id_biller
```

- **Kandidat BI-FAST**: `id_biller = '11096'` — filter ini dilakukan di
  **backend** (`isBriBifastFpCandidate()`), BUKAN di Apps Script maupun di
  dalam pure engine matching. `id_produk` TIDAK PERNAH dipakai sbg filter
  utama — hanya utk pencarian/filter UI/fee analysis/breakdown/laporan.
- `id_transaksi`, `bill_info1`, `id_produk`, `id_outlet`, `id_biller` WAJIB
  diproses sbg **STRING** (leading zero `bill_info1` WAJIB dipertahankan,
  mis. `'0019773396'` tidak boleh jadi `'19773396'`) — Apps Script maupun
  backend TIDAK PERNAH memakai `Number()`/`parseFloat()` pada field-field ini.

### Sheet "Data Bank BRI BI Fast"
Header baris 1 (BY NAME, fallback index A:R), data mulai baris 2:

```
ID, NOREK, TGL_TRAN, TGL_EFEKTIF, JAM_TRAN, SEQ, DESK_TRAN,
SALDO_AWAL_MUTASI, MUTASI_DEBET, MUTASI_KREDIT, SALDO_AKHIR_MUTASI,
GLSIGN, TRUSER, KODE_TRAN, KODE_TRAN_TELLER, TRREMK, TLBDS1, TLBDS2
```

Field STRING wajib: `ID, NOREK, JAM_TRAN, SEQ, TRUSER, KODE_TRAN,
KODE_TRAN_TELLER, DESK_TRAN, TRREMK, TLBDS1, TLBDS2`. Field nominal:
`SALDO_AWAL_MUTASI, MUTASI_DEBET, MUTASI_KREDIT, SALDO_AKHIR_MUTASI`.

**Apps Script hanya membaca & mengirim data mentah** — TIDAK PERNAH
mengekstrak `bill_info1`/beneficiary account, menentukan principal/fee,
melakukan matching, menentukan status, atau validasi saldo. Seluruh business
logic ada di backend (satu sumber kebenaran).

## Konfigurasi Default (per batch, configurable via `config` payload sync)

| Key | Default | Catatan |
|---|---|---|
| `bank_code` | `BRI_BIFAST` | tetap |
| `account_no` | `36001999999306` | dari body `account_no`, fallback ini |
| `expected_fee` | `77` | **satu konfigurasi terpusat** (`DEFAULT_FEE_BRI_BIFAST`), TIDAK di-hardcode berulang di banyak fungsi |
| `grace_period_minutes` | `30` | |
| `scope_mode` | `FULL_BUSINESS_DATE` | tidak ada konsep coverage-window |
| `bank_posting_before_fp_tolerance_minutes` | `5` | eligibility TIER 1/2 + `time_order_status` |
| `bank_posting_after_fp_tolerance_minutes` | `1440` | |
| `mismatch_time_tolerance_minutes` | `60` | eligibility TIER 2 |
| `reversal_lookup_days` | `3` | cross-date reversal |

Env var override: `RECON_BRI_BIFAST_FEE_DEFAULT`,
`RECON_BRI_BIFAST_GRACE_MINUTES`, `RECON_BRI_BIFAST_BEFORE_TOLERANCE_MINUTES`,
`RECON_BRI_BIFAST_AFTER_TOLERANCE_MINUTES`,
`RECON_BRI_BIFAST_MISMATCH_TOLERANCE_MINUTES`,
`RECON_BRI_BIFAST_REVERSAL_LOOKUP_DAYS`.

## Ekstraksi Beneficiary Account (`briBifastAdapter.js::extractBriBifastIdentifiers`)

Independen dari **2 sumber** (DESK_TRAN, TRREMK — **TLBDS2 tidak dipakai
di sini**, murni sumber `bank_trace_id`):

```
Regex: /\bBFST([0-9]{6,20})\b/i
Contoh: "BFST0019773396" -> beneficiary_account = "0019773396"
```

**Confidence**:
- `HIGH` — DESK_TRAN & TRREMK menghasilkan account yang SAMA.
- `MEDIUM` — hanya satu sumber menghasilkan account.
- `CONFLICT` — DESK_TRAN & TRREMK menghasilkan account BERBEDA — bank row
  jadi `NEED_REVIEW`, TIDAK PERNAH otomatis MATCHED/BANK_ONLY, dan tidak
  pernah diam-diam memilih salah satu.
- `NONE` — tidak ada account yang berhasil diekstrak.

Juga diekstrak (best-effort, tidak dipakai sbg matching key):
- `bank_trace_id` — prioritas TLBDS2 > DESK_TRAN > null. Regex:
  `/\b20\d{6}BRINIDJA[0-9A-Z]+\b/i`. Contoh: `20260710BRINIDJA010O9903057543`.
- `counterparty_bic` — dari `APFT:<BIC>`. Regex: `/\bAPFT:([A-Z0-9]{8,11})\b/i`.
  **TIDAK PERNAH dipakai sbg matching key.**
- `esb_reference` — dari `ESB:<ref>` (opsional, informatif).

## Klasifikasi Baris (`classifyBriBifastRow`) — `bank_row_type`

Urutan keputusan:
1. DESK_TRAN & TRREMK kosong → `UNKNOWN`.
2. Tidak ada pola `BFST` maupun `APFT:` di kedua sumber → `OUT_OF_SCOPE`
   (mutasi rekening jelas tidak terkait BI-FAST — tersimpan mentah di Raw
   Data, TIDAK PERNAH masuk matching/BANK_ONLY/Exception Queue/match rate).
3. Account conflict → `NEED_REVIEW`.
4. Pola valid tapi beneficiary account tidak ditemukan → `NEED_REVIEW`.
5. `MUTASI_KREDIT > 0` → `CREDIT_REVERSAL`.
6. `MUTASI_DEBET > 0` → `DEBIT_COMPONENT`.
7. Selain itu → `NEED_REVIEW`.

## Grouping Transfer (`buildBriBifastBankGroups`)

Group key SATU transfer BI-FAST (principal + fee, kadang + credit reversal),
prioritas:
1. `bank_code + account_no + business_date + bank_trace_id` (kalau trace ada).
2. Fallback (trace tidak ada): `account_no + business_date + JAM_TRAN + SEQ +
   beneficiary_account + normalized DESK_TRAN` — **BUKAN** cuma beneficiary
   account (1 akun bisa terima banyak transfer sehari) atau cuma SEQ.

Per grup (tanpa konteks FP — dipakai utk BANK_ONLY):
- `feeCandidates` = baris debit dengan `MUTASI_DEBET == expected_fee`.
- `nonFeeDebitRows` = baris debit dengan `MUTASI_DEBET != expected_fee`.
- `principal_row_count = nonFeeDebitRows.length`.

Saat FP tersedia (matching), **principal sebenarnya** ditentukan dari exact
match nominal FP (pola sama dgn OCBC/Mandiri — bukan sekadar heuristik
fee-based), sehingga "principal terbesar" tidak pernah diasumsikan tanpa
validasi.

## Matching Satu ke Satu (`reconcileBriBifastTransactions`)

**TIER 1 — EXACT MATCH**: `bill_info1 == beneficiary_account` DAN
`nominal FP == principal bank` (exact) DAN grup belum consumed DAN tidak ada
account conflict DAN grup punya tepat 1 principal valid DAN eligible waktu
(lihat di bawah). Kalau >1 kandidat exact: tie-break selisih waktu absolut
terkecil → posting time ASC → `bank_trace_id` ASC (deterministic).

**TIER 2 — NOMINAL MISMATCH**: HANYA kalau beneficiary account sama, tidak
ada kandidat exact, **hanya ada satu FP** & **hanya ada satu bank group**
utk account tsb (dihitung statis dari seluruh input batch, bukan
runtime-berubah), dan selisih waktu ≤ `mismatch_time_tolerance_minutes`
(default 60). Kalau syarat tidak terpenuhi: **TIDAK dipaksa** — FP tetap
`PENDING_BANK`/`FP_ONLY`, bank group tetap kandidat `BANK_ONLY`.

**Eligibility waktu** (TIER 1 & 2): bank posting SEBELUM FP melebihi
`bank_posting_before_fp_tolerance_minutes` (default 5 menit) TIDAK PERNAH
eligible (`IMPOSSIBLE_ORDER` — tidak boleh otomatis MATCHED); posting
SETELAH FP melebihi `bank_posting_after_fp_tolerance_minutes` (default 1440
menit) juga tidak eligible.

### Cascade Status (11 status generic, sama lintas semua bank)
```
DUPLICATE_FP (id_transaksi dobel di Data FP)
→ tidak ada bank group: PENDING_BANK (masih grace) / FP_ONLY (lewat grace)
→ >1 principal dalam grup exact match: DUPLICATE_BANK
→ 1 principal, fee tidak ada: MATCHED_NO_FEE
→ 1 principal, fee == 77: MATCHED
→ 1 principal, fee != 77: FEE_MISMATCH
→ TIER 2 (nominal beda, pairing unik): NOMINAL_MISMATCH
→ Credit dalam grup (SATU BATCH atau CROSS_DATE_TRACE): REVERSAL (menimpa status apa pun, prioritas tertinggi)
```

### BANK_ONLY
Hanya dari grup yang: belum consumed, `bank_row_type` valid (bukan
OUT_OF_SCOPE), beneficiary account berhasil diekstrak, `account_conflict =
false`, **tepat satu** principal (>1 → `NEED_REVIEW`, bukan BANK_ONLY),
bukan fee-only (fee-only tanpa principal & tanpa credit → `NEED_REVIEW`),
bukan credit-only tanpa debit. Principal BANK_ONLY memakai nilai **nyata**
(bukan estimasi) — beda dari BRI existing yang principal-nya harus
diestimasi (gross debit − fee), karena di BI-FAST principal & fee memang
sudah baris terpisah dan bisa dikenali langsung.

## Reversal Cross-Date Lookup (`applyBriBifastReversalCrossDateLookup`)

Terisolasi dari matching utama (spec eksplisit). Mencari credit sampai
`business_date + reversal_lookup_days` (default 3 hari), **HANYA** exact
`bank_trace_id + account_no` (TIDAK PERNAH beneficiary account saja, karena
1 rekening tujuan bisa menerima banyak transaksi). Kalau ditemukan: hasil
batch asli DI-UPDATE jadi REVERSAL (bukan bikin BANK_ONLY baru di tanggal
credit), `reversal_lookup_source = 'CROSS_DATE_TRACE'`.

## Validasi Saldo (`validateBriBifastBalance`) — PER BARIS

`SALDO_AWAL_MUTASI - MUTASI_DEBET + MUTASI_KREDIT = SALDO_AKHIR_MUTASI`
(toleransi ±Rp1). Informatif — **TIDAK PERNAH** langsung mengubah
`recon_status` transaksi manapun, tapi jumlah UNBALANCED memengaruhi Health
Status (material ≥5 baris).

## Waktu — JAM_TRAN, TGL_TRAN, TGL_EFEKTIF

Sama pola dgn BRI existing: `JAM_TRAN` dinormalisasi
`String(JAM_TRAN).padStart(6,'0')` → `HH:MM:SS` (mis. `3950` → `00:39:50`).
`transaction_date_time = TGL_TRAN + jam presisi JAM_TRAN`. `business_date`
= tanggal `TGL_EFEKTIF` di Asia/Jakarta (**bukan**
`toISOString().slice(0,10)`). `time_order_status` (vocabulary BEDA dari BRI
existing): `NORMAL` (≤5 menit) / `WARNING` (≤15) / `DELAYED` (≤30) /
`EXTREME` (>30) / `IMPOSSIBLE_ORDER` (posting sebelum FP melebihi toleransi).

## Canonical Transaction Key & Fingerprint

- Ada FP: `canonical_transaction_key = normalize(id_transaksi)`.
- BANK_ONLY/REVERSAL/NEED_REVIEW tanpa FP:
  `'BRI_BIFAST_BANK::' + bank_trace_id` (fallback
  `'BRI_BIFAST_BANK::' + stable_group_fingerprint` kalau trace tidak ada).
- `UNIQUE(batch_id, canonical_transaction_key)` — **upsert**, TIDAK PERNAH
  delete-all lalu insert ulang. Manual resolution & audit log bertahan
  setelah resync.
- Row fingerprint (idempotensi sync) — SHA-256 dari `bank_code, account_no,
  TGL_TRAN, TGL_EFEKTIF, JAM_TRAN, SEQ, normalized DESK_TRAN, MUTASI_DEBET,
  MUTASI_KREDIT, SALDO_AKHIR_MUTASI, TLBDS2` (BUKAN nomor baris sheet).

## Database

Reuse tabel generic `recon_sync_batches` / `recon_fp_transactions` /
`recon_bank_transactions` / `recon_results` / `recon_action_logs`, dibedakan
`bank_code = 'BRI_BIFAST'`. **TIDAK ADA tabel baru.** Migration:
`backend/src/migrations/add_reconciliation_bri_bifast_columns.sql` (idempotent,
`ADD COLUMN IF NOT EXISTS`), runner: `backend/scripts/run-reconciliation-bri-bifast-migration.js`.

Kolom baru: `recon_fp_transactions.bill_info1`;
`recon_bank_transactions.{beneficiary_account, account_from_desk_tran,
account_from_trremk, account_conflict, bank_trace_id, trace_from_desk_tran,
trace_from_tlbds2, counterparty_bic, esb_reference, transfer_group_key}`;
`recon_results.{fp_bill_info1, bank_beneficiary_account, bank_trace_id,
counterparty_bic, account_conflict, time_order_status}`;
`recon_sync_batches.{bank_posting_before_fp_tolerance_minutes,
bank_posting_after_fp_tolerance_minutes, mismatch_time_tolerance_minutes}`.
`reversal_date/reversal_amount/reversal_lookup_source` di `recon_results`
**sudah ada** dari migration BRI existing, dipakai bersama apa adanya.

`finance_balance_requests` CHECK constraint `bank_code` diperluas jadi
`('OCBC','MANDIRI','BRI','BRI_BIFAST')` — idempotent (DROP lalu ADD ulang),
tidak merusak bank_code existing.

## Backend Endpoints

```
POST /api/warroom/reconciliation/bri-bifast/sync                (token APPS_SCRIPT_TOKEN, no JWT)
GET  /api/warroom/reconciliation/bri-bifast/analytics?date=
GET  /api/warroom/reconciliation/bri-bifast/balance-needs-periodic?start_date=&end_date=  (Kebutuhan Saldo, SHARED service)
GET  /api/warroom/reconciliation/bri-bifast/daily-report?date=
GET  /api/warroom/reconciliation/bri-bifast/transactions         (date, status, id_outlet,
                                                                   id_produk, id_biller,
                                                                   bill_info1, beneficiary_account,
                                                                   bank_trace_id, search, page,
                                                                   limit, sort, order)
GET  /api/warroom/reconciliation/bri-bifast/raw-fp?date=
GET  /api/warroom/reconciliation/bri-bifast/raw-bank?date=
GET  /api/warroom/reconciliation/bri-bifast/export
POST /api/warroom/reconciliation/bri-bifast/:id/resolve          (catatan WAJIB diisi)
GET  /api/warroom/reconciliation/bri-bifast/:id/logs
GET  /api/warroom/reconciliation/bri-bifast/resolution-history?date=
```

"Sync Now" & status-nya pakai endpoint GENERIC yang sudah ada (bukan endpoint
baru): `POST /api/warroom/reconciliation/request-sync` `{bank_code:
"BRI_BIFAST"}` dan `GET /api/warroom/reconciliation/sync-request-status?bank_code=BRI_BIFAST`.

### `active_batch` — TIDAK PERNAH fallback tanggal
Kalau `date` dikirim, analytics/daily-report HANYA ambil batch tanggal exact
itu — tidak ada batch untuk tanggal tsb → `empty:true`. Frontend
memvalidasi `active_batch.business_date === selectedDate`; kalau beda,
tampilkan integrity error, TIDAK render data (pertahanan berlapis di luar
guard backend).

### `data_quality_warning`
```
invalid_business_date_count, duplicate_canonical_result_count,
consumed_also_bank_only_count, account_conflict_count,
duplicate_bank_trace_count, orphan_fee_group_count,
impossible_time_order_count, unbalanced_bank_row_count, has_issue, message
```
Target ideal semua `0`. `duplicate_bank_trace_count` & `orphan_fee_group_count`
dihitung dari `recon_bank_transactions` mentah (bukan dari `recon_results`) —
lihat `computeBriBifastRawDiagnostics()`.

### Health Status (`BRI_BIFAST_HEALTH_THRESHOLDS`)
RED dievaluasi dulu, lalu YELLOW, fallback GREEN:
- **RED**: match rate <95%, sync gagal, invalid business date >0, duplicate
  canonical >0, consumed-juga-bank-only >0, account conflict/duplicate bank
  trace/impossible time order material (≥5), saldo unbalanced material (≥5).
- **YELLOW**: match rate 95–<99%, actionable exception >0, posting delay
  material, account conflict/duplicate trace/impossible order/unbalanced
  ada (>0 tapi belum material), extraction confidence MEDIUM material
  (>10% dari total baris terklasifikasi).
- **GREEN**: match rate ≥99%, tidak ada actionable exception/data-quality
  issue, sync sukses.

## Frontend

`frontend/src/pages/WarRoomReconciliationBriBifast.jsx` — 8 tab (Laporan
Harian WAJIB paling akhir): Executive Summary, Hasil Rekonsiliasi, Exception
Queue, Fee Analysis, Time & Posting Analysis, Raw Data & Audit, **Kebutuhan
Saldo**, Laporan Harian (`DailyReportBriBifastTab.jsx`, komponen terpisah).

### Kebutuhan Saldo (Tab 7) — SHARED service, bukan implementasi terpisah
Dipasang via komponen shared
`frontend/src/components/reconciliation/PeriodicBalanceNeeds.jsx`
(`bankCode="BRI_BIFAST"`, `bankLabel="BRI BI-FAST"`, tanpa
`supportsFundingComparison`), fetch via
`getBriBifastPeriodicBalanceNeeds()` di `services/api.js`. Route handler
`balanceNeedsPeriodicHandler` di `warroom-reconciliation-bri-bifast.js`
HANYA mengunci `bankCode: 'BRI_BIFAST'` lalu memanggil
`periodicBalanceNeeds.buildBalanceNeedsResponse()`. Prinsipal + fee 1
transaksi BI-FAST SUDAH dikonsolidasi jadi SATU baris `recon_results` oleh
`buildBriBifastBankGroups()`/`reconcileBriBifastTransactions()` (lihat
bagian "Grouping Transfer" & "Matching Satu ke Satu" di atas) — service
Kebutuhan Saldo TIDAK menghitungnya dua kali sbg 2 transaksi terpisah,
cukup mengonsumsi `recon_results` apa adanya. Expected fee per tanggal dari
`recon_sync_batches.expected_fee`, fallback default Rp77
(`DEFAULT_FEE_BY_BANK.BRI_BIFAST`) hanya kalau batch genuinely tidak
punya nilai. Mekanisme lengkap (included days, dedup transaksi, 24 bucket
jam, KPI, export, testing) — lihat `docs/RECONCILIATION_BNI.md` bagian
"Kebutuhan Saldo".

Executive Summary: 12 KPI (Total Transaksi FP, Total Nominal FP, Bank
Transfer Group, Matched Transaksi, Matched Nominal, Pending Bank, FP Only,
Bank Only, Nominal Mismatch, Valid Match Rate Transaksi, Valid Match Rate
Nominal, Actionable Exception) + mini-table FP Only/Bank Only/Reversal +
panel Principal & Fee Summary, Extraction Quality, Validasi Saldo, Data
Quality Warning, Distribusi Status. **Tidak ada panel Coverage Window**
(tidak relevan — `scope_mode` selalu `FULL_BUSINESS_DATE`).

Hasil Rekonsiliasi: 23 kolom sesuai spec (ID Transaksi, Bill Info 1,
Beneficiary Account, Produk, Outlet, Biller, Nominal FP, Principal Bank, Fee
Bank, Total Debit, Credit, Selisih Principal, Selisih Fee, Waktu FP, Waktu
Bank, Selisih Waktu, Time Order, Norek, Bank Trace ID, Counterparty BIC,
Extraction Confidence, Account Conflict, Matching Method, Status) + search,
filter, sort, pagination 25/50/100/500, export CSV.

Exception Queue: hanya 9 EXCEPTION_STATUSES (bukan MATCHED/MATCHED_NO_FEE/
OUT_OF_SCOPE), default sort nominal terdampak terbesar, Resolve **wajib
catatan**, Riwayat, audit log.

Semua endpoint analytics/list **TIDAK di-cache** (data operasional).

## Apps Script (`apps-script-reconciliation-bri-bifast.js`)

Auto-sync **REAKTIF** (pola sama dgn Rekonsiliasi Mandiri, BUKAN interval
tetap): `onChange` trigger hanya menandai dirty flag; checker tiap 1 menit
sync kalau sudah lewat debounce 30 detik sejak edit terakhir (atau ada
permintaan "Sync Now" dari dashboard via endpoint generic
request-sync/sync-request-status), dilindungi lock anti-overlap. Realistis
~30-90 detik setelah perubahan sheet, ~1-2 menit setelah tombol Sync Now.
Chunk 1500 baris. Script Properties: `BRIC_SYNC_TOKEN`, `BRIC_API_BASE_URL`
(default `https://bmsretail.my.id`), `BRI_BIFAST_SPREADSHEET_ID`.

`cleanNum()` (di sini `reconBfCleanNum_`) WAJIB cek `typeof value ===
'number'` dulu sebelum string processing (insiden Speedcash — direplikasi
persis).

Fungsi: `testReconciliationBriBifast()`, `pushReconciliationBriBifast()`,
`setupReconciliationBriBifastTrigger()`,
`removeReconciliationBriBifastTrigger()`,
`checkReconciliationBriBifastChanges()`, `getReconciliationBriBifastStatus()`.

## Testing

`backend/scripts/test-reconciliation-bri-bifast.js` — pure-function test
(Node `assert`, pola sama dgn OCBC/Mandiri/BRI existing). Run:
```
node backend/scripts/test-reconciliation-bri-bifast.js
```
Mencakup ekstraksi beneficiary/trace/BIC, confidence HIGH/MEDIUM/CONFLICT/
NONE, klasifikasi bank row, normalisasi JAM_TRAN, grouping, cascade status
(MATCHED/MATCHED_NO_FEE/FEE_MISMATCH/NOMINAL_MISMATCH/DUPLICATE_BANK/
NEED_REVIEW/PENDING_BANK/FP_ONLY/BANK_ONLY/REVERSAL/cross-date), eligibility
waktu, canonical key/fingerprint, balance validation, actionable exception,
quality checks, raw diagnostics, health status GREEN/YELLOW/RED. Idempotensi
sync, manual resolve bertahan setelah resync, dan regresi bank lain
(BRI existing/Mandiri/OCBC) adalah perilaku level DB/endpoint — diverifikasi
langsung di server (lihat laporan implementasi), bukan di level pure-function.

## Batasan Implementasi (jangan dilanggar)

- Jangan mengubah Rekonsiliasi BRI existing.
- Jangan memakai `id_transaksi` sbg bank matching key.
- Jangan memakai gross debit logic BRI existing.
- Jangan menggabungkan principal & fee jadi satu row.
- Jangan menghapus leading zero pada `bill_info1`.
- Jangan mencocokkan berdasarkan beneficiary account saja (tanpa nominal/
  eligibility waktu).
- Jangan memaksa nominal mismatch kalau kandidat ambigu (>1 FP atau >1 grup
  utk 1 account).
- Jangan menganggap fee-only sbg transaksi normal (→ NEED_REVIEW).
- Jangan membuat BANK_ONLY dari OUT_OF_SCOPE.
- Jangan delete-all `recon_results` (upsert + delete-selisih-key saja).
- Jangan menghapus audit log.
