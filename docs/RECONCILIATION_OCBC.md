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

## Canonical Transaction Key — fix bug REVERSAL+BANK_ONLY double count
**Insiden nyata**: 1 transaksi yang SUDAH ditemukan pasangan FP-nya dan
punya credit/reversal (recon_status=`REVERSAL`) bisa ikut muncul LAGI
sebagai baris `BANK_ONLY` terpisah utk Reference No. yang SAMA — 1
transaksi logis dihitung 2 kali, membengkakkan jumlah BANK_ONLY & selisih.

**Root cause**: `bankByRef` (exact, dari SEMUA baris ber-reference) dan
`bankFallbackByIdTransaksi` (fallback, HANYA dari baris ber-reference
KOSONG) adalah **2 index terpisah** yang tidak saling sinkron. Kalau
representasi 1 baris bank sedikit berbeda dari baris lain milik transaksi
logis yang sama (leading zero, whitespace, dsb — jarang tapi mungkin), atau
kalau ada baris "orphan" BANK_ONLY tersimpan dari SEBELUM FP-nya tersedia,
unique index lama recon_results (`batch_id, id_transaksi, reference_no`)
menganggap baris FP-based (id_transaksi TERISI) dan baris BANK_ONLY
(id_transaksi NULL, reference_no sama) sbg **2 identitas berbeda** — upsert
tidak pernah menyatukan keduanya.

**Fix engine** (`reconcileTransactions()`/`reconcileTransactionsWithCoverage()`):
- `buildOcbcBankGroups()` — SATU struktur Map per **canonical transaction
  key** (Reference No. dinormalisasi via `normalizeCanonicalKey()` — String+trim
  SAJA, tidak pernah diubah ke number, leading zero dipertahankan — kalau
  kosong baru fallback ke id_transaksi hasil parse Description), MENGGANTIKAN
  2 index terpisah lama. Group menyimpan `principalRows`/`feeRows`/`creditRows`
  + `hasPrincipal` (heuristik: minimal 1 debit yang BUKAN seukuran expected
  fee — tanpa ini, grup fee-only Rp25 tanpa pasangan bisa salah jadi
  BANK_ONLY).
- `consumedBankKeys` (Set) — ditandai **SEGERA** begitu 1 bank group dipakai
  FP manapun, **sebelum** cascade status ditentukan (jadi tetap ditandai
  consumed walau hasil akhirnya MATCHED, NOMINAL_MISMATCH, DUPLICATE_BANK,
  REVERSAL, dst — bukan cuma kalau MATCHED).
- BANK_ONLY sekarang dibuat **per GROUP** (bukan per baris bank) — HANYA
  dari group yang: (a) belum ada di `consumedBankKeys`, (b) canonical
  key-nya tidak ada di `fpIdSet` (defense-in-depth kedua), (c) `hasPrincipal`
  true (fee-only & credit-only dikecualikan).

**Fix database**: kolom baru `canonical_transaction_key` = `COALESCE(id_transaksi,
reference_no)` (dinormalisasi), **menggantikan** unique index lama
`(batch_id, id_transaksi, reference_no)` dengan `(batch_id,
canonical_transaction_key)`. Upsert `runOcbcEngineAndPersist()` (OCBC) DAN
`warroom-reconciliation-mandiri.js` (Mandiri — tabel `recon_results` SAMA,
dipakai bersama; `reconcileMandiriTransactions()` sendiri **tidak disentuh**)
sekarang menargetkan `ON CONFLICT (batch_id, canonical_transaction_key)` —
begitu FP ditemukan utk 1 reference yang sebelumnya BANK_ONLY, upsert
meng-**UPDATE row yang sama** (bukan insert baru), sehingga `id` stabil dan
`recon_action_logs` (FK ke id itu) otomatis tidak pernah hilang.

**Diagnostic permanen** (bukan cuma migrasi sekali jalan) di
`GET .../analytics`, field `data_quality_warning`:
`duplicate_canonical_result_count` (jumlah baris yang berbagi
canonical_transaction_key sama dalam 1 batch — harus SELALU 0 setelah unique
index baru aktif) dan `reversal_also_bank_only_count` (subset spesifik pola
REVERSAL+BANK_ONLY).

**Perbaikan data yang sudah terlanjur salah**: lihat bagian Testing —
`backend/scripts/repair-reversal-bank-only-duplicates.js`.

## Status Rekonsiliasi
`MATCHED`, `MATCHED_NO_FEE`, `PENDING_BANK`, `FP_ONLY`, `BANK_ONLY`,
`NOMINAL_MISMATCH`, `FEE_MISMATCH`, `DUPLICATE_FP`, `DUPLICATE_BANK`,
`REVERSAL`, `NEED_REVIEW`. Detail cascade logic ada di
`reconcileTransactions()` (`backend/src/routes/warroom-reconciliation.js`).
Credit/reversal pada reference yang sama **selalu menimpa** status lain
(sinyal reversal dianggap paling kuat).

## Keterbatasan 5.000 Baris OCBC — Coverage-Aware Reconciliation
Google Sheet `DATA BANK OCBC` **hanya menyediakan 5.000 baris mutasi
TERBARU** (bukan seluruh histori). Karena 1 transaksi OCBC = 2 baris
(principal + fee), 5.000 baris cuma mewakili **~2.500 transaksi terbaru**.
Tanpa penanganan khusus, transaksi FP yang lebih tua dari titik potong itu
berpotensi salah diklasifikasi `FP_ONLY`/`PENDING_BANK`/`NEED_REVIEW` —
padahal belum tentu gagal, datanya memang sudah tergeser keluar window.

Solusi terdiri dari 2 mekanisme yang saling melengkapi:

### 1. `coverage_status` — dimensi TERPISAH dari `recon_status`
**Bukan status ke-12.** Setiap baris `recon_results` punya kolom
`coverage_status` sendiri (nullable), independen dari 11 status di atas:

| coverage_status | Arti | recon_status | is_actionable | eligible_for_match_rate |
|---|---|---|---|---|
| `IN_BANK_COVERAGE` | FP berada dalam rentang data bank yang dipercaya | cascade normal (11 status di atas) | mengikuti recon_status | `true` |
| `OUTSIDE_BANK_COVERAGE` | FP lebih tua dari `trusted_coverage_start` | **NULL** | `false` | `false` |
| `BOUNDARY_PARTIAL` | FP tepat di menit batas snapshot 5.000 baris, principal/fee berpotensi terpotong cutoff | **NULL** (kecuali match lengkap ditemukan → tetap `MATCHED`) | `false` | `false` |

`OUTSIDE_BANK_COVERAGE`/`BOUNDARY_PARTIAL` **bukan exception** — tidak masuk
Exception Queue, tidak dihitung `FP_ONLY`/`PENDING_BANK`, tidak menurunkan
match rate. Kalau exact Reference No. ditemukan dan principal+fee lengkap,
transaksi tetap `MATCHED` walau berada persis di boundary minute (lihat
`isCompleteOcbcGroup()`).

**Penentuan boundary** (`calculateOcbcCoverage()` di
`warroom-reconciliation.js`): kalau jumlah baris bank snapshot ≥
`source_limit` (default 5000), baris TERTUA menentukan "boundary minute"
(menit kalendernya, detik dibuang) — seluruh menit itu dianggap berpotensi
terpotong. `trusted_coverage_start` = awal menit BERIKUTNYA. FP sebelum
titik itu → `OUTSIDE_BANK_COVERAGE`; FP tepat di menit itu tanpa match
lengkap → `BOUNDARY_PARTIAL`; FP setelahnya → `IN_BANK_COVERAGE` (cascade
normal, termasuk `FP_ONLY` kalau memang tidak ditemukan setelah grace
period).

**Timezone**: seluruh perhitungan boundary di-anchor ke **Asia/Jakarta**
secara eksplisit (bukan timezone server, bukan `.toISOString().slice(0,10)`)
— lihat insiden serupa yang sudah terjadi & diperbaiki di Rekonsiliasi
Mandiri, dan `formatDateJakartaOcbc()` yang dipakai utk `business_date`
archive.

### 2. Rolling Bank Archive (`recon_bank_archive` + `recon_bank_snapshots`)
Snapshot `recon_bank_transactions` tetap di-**replace** tiap sync (mewakili
5.000 baris TERBARU dari Sheets apa adanya). Tapi setiap baris yang pernah
diterima JUGA di-upsert ke `recon_bank_archive` — tabel KUMULATIF yang
**tidak pernah dihapus** saat resync. Identitas 1 baris archive adalah
`row_fingerprint` (SHA-256 dari `bank_code|account_no|transaction_date_time|
value_date|reference_no|description|debit|credit|balance`, semua
dinormalisasi) — **BUKAN** `source_row_number`, karena posisi baris bisa
berubah begitu window 5.000 baris Sheets bergeser.

Engine rekonsiliasi (`runOcbcEngineAndPersist()`) mengambil bank row utk
MATCHING dari **archive** (kumulatif), bukan cuma snapshot aktif — transaksi
FP lama tetap bisa cocok walau bank row-nya sudah tergeser keluar 5.000
baris terbaru di Sheets. `archive_match=true` menandai hasil yang match-nya
berasal dari baris yang TIDAK ada lagi di snapshot terkini (murni historis).

Prioritas matching: (1) exact Reference No. dari archive, (2) exact
Reference No. dari snapshot aktif — keduanya sama krn archive selalu
mencakup snapshot terkini, (3) description fallback, (4) coverage
classification, (5) cascade recon_status normal.

**Penting**: `is_source_truncated`/`snapshot_oldest_time`/dst dihitung dari
SNAPSHOT AKTIF SAJA (row count vs `source_limit`), **bukan** dari archive
kumulatif — archive akan jauh melebihi `source_limit` setelah berjalan
lama, dan kalau ikut dihitung akan SELALU salah menganggap truncated.

### 3. Business Date Scoping — fix bug cross-date
**Insiden nyata**: `runOcbcEngineAndPersist()` mengambil bank row dari
`recon_bank_archive` HANYA difilter `bank_code` (+`account_no`), **TANPA
`business_date` sama sekali**. Begitu archive kumulatif mencakup lebih dari
1 hari (mis. tanggal 13 DAN 14), SETIAP batch (termasuk batch tanggal 14)
ikut menarik SELURUH baris archive lintas tanggal ke dalam engine — baris
bank tanggal 13 yang tidak ada pasangan FP-nya di batch tanggal 14 salah
dijadikan `BANK_ONLY` milik batch tanggal 14, menyebabkan selisih/exception
meledak walau data sheet sebenarnya sudah bersih (hanya tanggal 14).

**Fix**: query archive di `runOcbcEngineAndPersist()` sekarang WAJIB
`AND business_date = $businessDate` (equality pada kolom `business_date`
yang SUDAH WIB-anchored sejak insert via `formatDateJakartaOcbc()` — bukan
range `AT TIME ZONE` di SQL, supaya tidak bergantung sama sekali pada
timezone session database). Archive tetap kumulatif/historis (tanggal 13
TIDAK dihapus, tetap tersimpan), TAPI engine 1 batch hanya boleh melihat
baris archive dgn `business_date` PERSIS SAMA dengan `business_date` batch
itu sendiri.

Lapis pertahanan tambahan (defense-in-depth) di `GET .../transactions` &
`GET .../export`: filter `(bank_transaction_date IS NULL OR
bank_transaction_date = business_date)` — DATE=DATE murni di SQL (bukan
round-trip lewat JS), supaya recon_results cross-date yang BELUM sempat
di-repair tetap tidak tampil di dashboard walau masih ada di DB.

`GET .../analytics` juga mengecualikan baris cross-date dari SEMUA
summary/distribusi (bukan cuma tampilan tabel), dan melaporkan
`data_quality_warning.cross_date_result_count` kalau masih ada baris begitu
(seharusnya SELALU 0 setelah fix + repair script dijalankan). Response
`analytics` juga menyertakan `active_batch` (`batch_id`, `bank_code`,
`business_date`, `account_no`, `synced_at`) — sumber kebenaran batch yang
sedang ditampilkan, dipakai frontend utk validasi integritas (kalau
`active_batch.business_date` beda dari filter tanggal yang diminta user,
frontend menampilkan error alih-alih merender hasil campuran).

**Perbaikan data yang sudah terlanjur salah**: jalankan
`backend/scripts/repair-reconciliation-cross-date.js` (dry-run default,
`--apply` utk eksekusi — lihat bagian Testing).

### Backfill (memperkaya archive dgn data lama)
Payload sync mendukung `sync_mode: 'SNAPSHOT' | 'BACKFILL'` (default
`SNAPSHOT`). Untuk `BACKFILL`: hanya meng-upsert `body.bank` ke
`recon_bank_archive` (business_date per baris diambil dari
`transaction_date_time` baris itu sendiri, BUKAN business_date payload),
**tidak menghapus/mengubah** raw snapshot aktif maupun `source_limit`
snapshot yang sudah ada, lalu menjalankan ulang rekonsiliasi batch terkait
(pakai statistik snapshot TERAKHIR yang sudah ada, tidak membuat snapshot
baru). Tidak ada UI upload baru — kirim lewat endpoint sync yang sama
dengan `sync_mode: 'BACKFILL'` di body. Wajib sudah ada batch SNAPSHOT utk
business_date target (backfill menolak kalau batch belum pernah ada).

### Match Rate Valid
Match rate LAMA (`match_rate_transaksi`/`match_rate_nominal`) dipertahankan
demi backward compatibility, tapi dihitung dari SELURUH FP (termasuk yang
di luar cakupan). Frontend **wajib** pakai metrik baru:

```
valid_match_rate_transaction = matched_in_coverage / fp_in_bank_coverage × 100
valid_match_rate_nominal     = matched_nominal_in_coverage / fp_nominal_in_bank_coverage × 100
```

Denominator HANYA transaksi dengan `eligible_for_match_rate=true`
(coverage_status=IN_BANK_COVERAGE) — transaksi di luar cakupan tidak boleh
menurunkan angka ini hanya karena data pembandingnya memang terpotong.

## Validasi Tanggal Baris FP saat Sync — cegah FP_ONLY massal di hari baru
**Insiden nyata**: Apps Script menghitung `business_date` dari `new Date()`
(kalender hari itu) tiap kali sync jalan. Kalau sheet "DATA FP"/"DATA BANK
OCBC" **belum sempat direfresh operator** untuk hari baru pada saat
reactive trigger (tiap 1 menit) menembak — isinya masih data hari
KEMARIN — seluruh baris FP kemarin ikut tersimpan tapi diberi label
`business_date` HARI INI. Karena `recon_bank_archive` untuk business_date
baru itu genuinely masih kosong (bank row kemarin tersimpan di archive
dengan business_date-nya SENDIRI, bukan business_date batch — lihat
"Business Date Scoping" di atas), SELURUH FP yang salah tanggal ini jadi
`FP_ONLY` massal, walau datanya sudah match sempurna kemarin begitu
dihitung ulang di bawah business_date yang benar.

**Fix (server-side, `syncHandler` di `warroom-reconciliation.js`)**:
setiap baris FP yang `time_response`-nya (di-anchor Asia/Jakarta via
`formatDateJakartaOcbc()`) **beda** dari `business_date` payload
dilewati saat insert (tidak ikut ke `recon_fp_transactions`), dilaporkan
lewat counter `fpSkippedOutsideDate` (`console.warn`, dan field response
sync `fp_rows_skipped_outside_date`). ***Baris bank TIDAK difilter*** —
archive sudah mengatribusikan business_date per baris dari
`transaction_date_time`-nya sendiri, jadi baris bank "kemarin" yang ikut
terkirim aman, tidak pernah dipakai untuk matching batch hari ini.

Proteksi ini **sengaja diduplikasi** di dua tempat (defense-in-depth):
- **Apps Script** (`apps-script-reconciliation-ocbc.js::reconValidateDates_`)
  — memfilter SEBELUM payload dikirim (lebih hemat kuota, FP di luar
  business_date dikecualikan dari `chunks`, bank tetap dikirim apa adanya).
- **Backend** (`syncHandler`) — filter identik, aktif TERLEPAS dari versi
  Apps Script yang sedang live di-deploy user (kalau Apps Script yang
  terpasang belum di-update ke versi yang punya `reconValidateDates_`,
  backend tetap melindungi).

**Kalau ini terjadi dan sudah kadung tersimpan** (batch hari ini penuh FP
salah tanggal SEBELUM fix di atas di-deploy): hapus baris
`recon_fp_transactions` milik batch itu yang `time_response`-nya (Asia/
Jakarta) tidak sama dengan `business_date` batch, lalu jalankan ulang
`runOcbcEngineAndPersist()` untuk batch tsb (pola yang sama dengan
`repair-reconciliation-cross-date.js`, cukup query manual — tidak ada
script khusus terpisah karena kasus ini seharusnya sudah tidak terjadi
lagi setelah fix di atas aktif). Setelah dibersihkan, batch akan
menampilkan status kosong yang jujur (`total_fp: 0`, bukan `FP_ONLY`
massal) sampai sheet benar-benar direfresh dengan data hari itu dan sync
berikutnya mengisi dengan benar.

## Database
Migration: `backend/src/migrations/create_reconciliation_ocbc.sql` (tabel dasar)
+ `backend/src/migrations/add_reconciliation_ocbc_coverage.sql` (coverage + archive)
+ `backend/src/migrations/add_reconciliation_ocbc_archive_business_date_index.sql`
(index `(bank_code, account_no, business_date)` utk query archive yg kini scoped per business_date)
+ `backend/src/migrations/add_reconciliation_canonical_transaction_key.sql`
(kolom `canonical_transaction_key` + backfill — SELALU aman dijalankan)
+ `backend/src/migrations/add_reconciliation_canonical_transaction_key_unique.sql`
(unique index baru — **HANYA** jalankan setelah
`repair-reversal-bank-only-duplicates.js --apply` memastikan 0 duplikat)
Runner: `backend/scripts/run-reconciliation-ocbc-migration.js` +
`backend/scripts/run-reconciliation-ocbc-coverage-migration.js` +
`backend/scripts/run-reconciliation-ocbc-archive-index-migration.js` +
`backend/scripts/run-reconciliation-canonical-key-migration.js` +
`backend/scripts/run-reconciliation-canonical-key-unique-migration.js`

| Tabel | Key | Catatan |
|---|---|---|
| `recon_sync_batches` | UNIQUE(business_date, bank_code) | 1 batch per hari per bank; resync menimpa batch yang sama |
| `recon_fp_transactions` | — | Raw FP, dihapus+diisi ulang tiap chunk pertama sync |
| `recon_bank_transactions` | — (reference_no SENGAJA TIDAK unique) | Raw bank (snapshot AKTIF saja), dihapus+diisi ulang tiap sync. + `transaction_date_time` (TIMESTAMPTZ, presisi menit) |
| `recon_results` | UNIQUE **(batch_id, canonical_transaction_key)** | Hasil engine, di-**upsert** (bukan delete+insert). `recon_status` **NULLABLE**. + `coverage_status`/`coverage_reason`/`is_actionable`/`eligible_for_match_rate`/`bank_snapshot_id`/`archive_match`/**`canonical_transaction_key`** (BARU — menggantikan unique index lama `(batch_id, id_transaksi, reference_no)`, lihat bagian "Canonical Transaction Key" di atas) |
| `recon_action_logs` | FK ke recon_results | Audit trail tiap aksi resolve |
| `recon_bank_snapshots` | FK ke recon_sync_batches | **BARU** — 1 baris ringkasan cakupan per sync (row_count, is_truncated, snapshot_oldest/newest_time, trusted_coverage_start) |
| `recon_bank_archive` | UNIQUE(row_fingerprint) | **BARU** — kumulatif, TIDAK PERNAH dihapus. Identitas via SHA-256 fingerprint (bukan source_row_number) |

**Idempotensi sync**: chunk pertama (`chunk_index=0`) menghapus data mentah
lama batch tsb (raw snapshot saja — archive TIDAK disentuh); chunk
terakhir membuat 1 baris `recon_bank_snapshots`, meng-upsert setiap baris
bank ke `recon_bank_archive`, lalu menjalankan engine dan meng-upsert
`recon_results` by canonical_transaction_key. Resync data yang sama tidak
pernah menggandakan baris atau batch — diverifikasi lewat sync 2×
berturut-turut menghasilkan `result_count`/jumlah archive row identik.

## Backend Endpoints (`backend/src/routes/warroom-reconciliation.js`)
| Endpoint | Auth | Keterangan |
|---|---|---|
| `POST /api/warroom/reconciliation/sync` | `APPS_SCRIPT_TOKEN` (token SHARED, bukan token baru) | Terima chunk FP/bank, jalankan engine di chunk terakhir. Response menyertakan `fp_rows_skipped_outside_date` (lihat bagian "Validasi Tanggal Baris FP" di atas) |
| `GET /api/warroom/reconciliation/sync-request-status?bank_code=` | `APPS_SCRIPT_TOKEN` | Dipanggil Apps Script tiap 1 menit — cek apakah tombol "Sync Now" ditekan sejak sync terakhir |
| `GET /api/warroom/reconciliation/analytics?date=&bank_code=` | JWT | Summary (+ `valid_match_rate_*`, `actionable_exception_count`), distribusi status, validasi rekening, fee analysis, blok `coverage`, `active_batch` (batch_id/bank_code/business_date/account_no/synced_at), `data_quality_warning` (cross_date_result_count, seharusnya selalu null), recent batches. Kalau `date` diberikan tapi batch tidak ada, `empty:true` — TIDAK fallback ke batch tanggal lain |
| `GET /api/warroom/reconciliation/daily-report?date=&bank_code=` | JWT | **Laporan Harian** (tab 7) — lihat bagian tersendiri di bawah |
| `GET /api/warroom/reconciliation/ocbc/balance-needs-periodic?start_date=&end_date=` | JWT | **Kebutuhan Saldo** (tab 6) — kebutuhan saldo per jam/tanggal utk suatu periode (maks 90 hari), lihat bagian tersendiri di bawah |
| `GET /api/warroom/reconciliation/transactions?date=&status=&coverage_status=&is_actionable=&id_outlet=&id_produk=&search=&page=&limit=&sort=&order=` | JWT | List berpaginasi; `status` & `coverage_status` boleh comma-separated. Field baru per baris: `coverage_status`, `coverage_reason`, `is_actionable`, `eligible_for_match_rate`, `archive_match` |
| `GET /api/warroom/reconciliation/export?...` | JWT | CSV (di-fetch sbg blob di frontend krn butuh header Authorization) — + 5 kolom baru (Coverage Status/Reason/Actionable/Eligible for Match Rate/Archive Match) |
| `POST /api/warroom/reconciliation/request-sync` | JWT | Tombol "Sync Now" — body `{bank_code}`, generik utk OCBC & Mandiri, hanya mencatat permintaan di `recon_sync_requests` |
| `POST /api/warroom/reconciliation/:id/resolve` | JWT | Body `{status, notes}`, tercatat di `recon_action_logs` |
| `GET /api/warroom/reconciliation/:id/logs` | JWT | Riwayat audit 1 baris hasil |

## Tombol "Sync Now" — kompromi, BUKAN sync instan
Percobaan PERTAMA: tombol yang memanggil Apps Script langsung lewat Web App
deployment (`doPost()` + endpoint backend `trigger-sync`). **Tidak jalan**
— deployment Web App di domain Google Workspace `bm.co.id` mewajibkan login
Google untuk request eksternal (`Who has access: Anyone within <domain>`,
bukan publik), dan ini kebijakan admin Workspace yang tidak bisa/boleh
di-bypass dari sisi kode. Endpoint `trigger-sync`, fungsi `doPost()` versi
lama, dan tombolnya waktu itu **sudah dihapus** karena selalu melapor
"berhasil" padahal diam-diam gagal.

Solusi kedua yang JALAN (dipakai sekarang): manfaatkan arah komunikasi yang
TIDAK diblokir — panggilan KELUAR dari Apps Script ke backend kita (itu
persis cara sync biasa bekerja) selalu boleh, hanya panggilan MASUK ke Web
App Apps Script dari luar yang diblokir kebijakan Workspace. Jadi:

1. Tombol "Sync Now" di dashboard memanggil `POST .../reconciliation/request-sync`
   (JWT, endpoint biasa BRIC) — HANYA mencatat baris baru di tabel
   `recon_sync_requests` (`bank_code`, `requested_at`, `requested_by`).
   Tidak menyentuh Apps Script sama sekali.
2. Trigger checker Apps Script yang SUDAH jalan tiap 1 menit
   (`checkAndSyncIfDirtyReconciliationOcbc`) SEKARANG JUGA memanggil
   `GET .../reconciliation/sync-request-status?bank_code=OCBC` (token,
   fungsi `reconCheckForceSyncRequested_`) di setiap siklusnya. Kalau ada
   permintaan yang lebih baru dari sync sukses terakhir, ia sync SEKARANG
   juga (skip debounce 30 detik).

Realistis: **~1-2 menit** dari klik tombol sampai data ter-update (menunggu
siklus checker berikutnya + waktu sync itu sendiri) — BUKAN instan.
`pending` di `sync-request-status` otomatis balik `false` begitu sync
berikutnya selesai (`synced_at` jadi lebih baru dari `requested_at`), tanpa
perlu langkah "consume/clear" terpisah.

Alternatif Service Account + Google Sheets API langsung dari backend (yang
benar-benar bisa instan) masih belum dipakai — butuh Google Cloud project
baru, service account + kredensial baru, dan duplikasi logic parsing sheet
di Node.js. Dipertimbangkan tapi diputuskan terlalu besar scope-nya untuk
kebutuhan saat ini.

## Apps Script (`apps-script-reconciliation-ocbc.js`)
Fungsi: `testReconciliationOcbc()` (dry-run, tidak kirim), `pushReconciliationOcbc()`
(kirim, chunk 1500 baris, return `{success,message,...}`),
`setupReconciliationOcbcTrigger()`, `removeReconciliationOcbcTrigger()`.

### Auto-sync reaktif (bukan cuma interval tetap)
Sync mengandalkan trigger 2 lapis di Apps Script supaya data tetap segar
otomatis segera setelah ada perubahan di Sheet ATAU setelah tombol "Sync
Now" ditekan:

1. **`reconOnChangeTrigger_`** — installable trigger terpasang ke event
   `onChange` spreadsheet. HANYA menandai timestamp "ada perubahan" di
   Script Properties (`RECON_DIRTY_SINCE`) — sangat ringan, bukan sync
   langsung (kalau langsung sync di setiap onChange, edit/paste beruntun
   dari tim bisa memicu banyak sync yang tumpang tindih saling menghapus
   data batch yang sama, dan cepat menghabiskan kuota harian Apps Script).
2. **`checkAndSyncIfDirtyReconciliationOcbc`** — time-based trigger tiap
   1 menit. Menjalankan `pushReconciliationOcbc()` kalau: (ada dirty flag
   DAN sudah lewat 30 detik debounce sejak edit terakhir) ATAU ada
   permintaan "Sync Now" dari dashboard (`reconCheckForceSyncRequested_`,
   skip debounce) — DAN tidak ada sync lain yang sedang berjalan (lock
   `RECON_SYNC_IN_PROGRESS`).

Hasil: data ter-update otomatis ~30-90 detik setelah perubahan terakhir di
Sheet, atau ~1-2 menit setelah tombol "Sync Now" ditekan. Pasang sekali
lewat `setupReconciliationOcbcTrigger()` (memasang KEDUA trigger di atas),
lepas dengan `removeReconciliationOcbcTrigger()`.

Script Properties:
- `RECONCILIATION_OCBC_SYNC_TOKEN` — **harus sama dengan `APPS_SCRIPT_TOKEN` di server** (token yang sama dipakai war-room lain)
- `RECONCILIATION_OCBC_SYNC_URL` — default `https://bmsretail.my.id/api/warroom/reconciliation/sync`

### Metadata cakupan (transaction_date_time)
Setiap baris bank sekarang JUGA mengirim `transaction_date_time` (presisi
jam-menit-detik, `reconToIso_()` — Asia/Jakarta eksplisit) selain
`transaction_date` (date-only, dipertahankan demi backward compat). Payload
juga menyertakan `config.source_limit` dan `meta.{bank_transaction_row_count,
is_source_truncated, snapshot_oldest_time, snapshot_newest_time}` —
**HANYA utk visibilitas Execution Log** (`reconBuildCoverageMeta_()`).
Backend **tidak pernah mempercayai** angka self-report ini untuk keputusan
bisnis — semuanya dihitung ULANG dari baris yang benar-benar diterima
(`calculateOcbcCoverage()`), supaya logic tetap terpusat di satu tempat dan
tidak bisa dipalsukan dari sisi client. `testReconciliationOcbc()` sekarang
menampilkan ringkasan cakupan di Execution Log.

## Frontend
- Route: `/war-room/rekonsiliasi-ocbc`
- Page: `frontend/src/pages/WarRoomReconciliationOcbc.jsx`
- Menu: Payment Agent > War Room > **Rekonsiliasi OCBC** (badge `REK`, `#DC2626`)
- CSS prefix: `wrr-*`, dark/light via CSS variable BRIC standar
- 7 tab (urutan tetap): Executive Summary, Hasil Rekonsiliasi, Exception Queue, Fee Analysis, Raw Data & Audit, **Kebutuhan Saldo**, Laporan Harian
- **Executive Summary**: banner "Data OCBC Terbatas" muncul kalau
  `coverage.is_source_truncated=true`; panel "Cakupan Data Bank OCBC"
  (Bank Coverage Start/End, Trusted Coverage Start, Bank Rows Received,
  Archive Rows, FP Dalam/Luar Cakupan, Boundary Partial); KPI utama pakai
  `valid_match_rate_transaction`/`valid_match_rate_nominal` (bukan
  `match_rate_transaksi`/`match_rate_nominal` lama) + KPI
  `actionable_exception_count`.
- **Hasil Rekonsiliasi & Exception Queue** (`ReconTable`, komponen SAMA
  dipakai dua tab lewat prop `scope="all"|"exception"`): kolom ID
  Transaksi, Nominal FP, Reference Bank, Principal, Fee, Total Debit,
  Credit/Reversal, Selisih Fee (merah kalau ≠0), Waktu FP, Waktu Bank,
  Outlet, Produk, Matching Method, Status (badge), **Cakupan** (badge
  `coverage_status` — `IN_BANK_COVERAGE` biru, `OUTSIDE_BANK_COVERAGE`
  "Di Luar Cakupan Data OCBC" abu-abu, `BOUNDARY_PARTIAL` "Batas Data OCBC
  Terpotong" kuning — **tidak pernah merah**, keduanya bukan kegagalan
  transaksi). Search (ID Transaksi/Reference/Outlet), sort per-kolom
  (`SortableTh`, klik header), paginasi (25/50/100/500 per halaman).
  Filter status: "Semua Status" (Hasil Rekonsiliasi, 11 status) vs "Semua
  Exception" (Exception Queue, 9 status selain MATCHED/MATCHED_NO_FEE).
  Filter coverage TERSEDIA (opsional, dropdown) HANYA di Hasil
  Rekonsiliasi; Exception Queue **WAJIB**
  `coverage_status=IN_BANK_COVERAGE&is_actionable=true` (hardcoded di
  kode, bukan pilihan user) supaya transaksi di luar cakupan/boundary
  tidak pernah nyasar ke sana. Kolom aksi (HANYA Exception Queue): tombol
  **Resolve** (buka `ResolveModal` — pilih status baru dari 11 status +
  catatan, submit ke `POST .../resolve`, otomatis tercatat di
  `recon_action_logs` dgn `matching_method='MANUAL_RESOLUTION'`) dan
  **Riwayat** (buka `AuditLogModal` — tabel riwayat audit 1 baris hasil
  dari `GET .../:id/logs`, kolom Waktu/Aksi/Status Sebelum/Status
  Sesudah/Catatan/Oleh).
- **Fee Analysis** (`FeeAnalysisTab`): 5 KPI (Expected Fee — default Rp25
  BI-FAST, Actual Fee Total, Actual Fee Rata-rata, Transaksi dengan Fee,
  Fee Variance — alert kalau >0, sumber `FEE_MISMATCH`), tabel Distribusi
  Fee (kelompok: sesuai expected/Rp0/lainnya), 3 tabel breakdown (Fee per
  Produk, Fee per Outlet — Top 20, Fee per Biller), semua dari blok
  `fee_analysis` response analytics.
- **Raw Data & Audit** (`RawDataTab`): panel "Info Sync Batch Ini" (Batch
  No, Jumlah Baris FP, Jumlah Baris Bank, Sync Terakhir, Spreadsheet ID)
  + tombol **Export CSV** (fetch `GET .../export` sbg blob krn butuh
  header Authorization, lalu trigger download manual — bukan `<a href>`
  biasa), panel "Riwayat Sync (14 Batch Terakhir)" (tabel Batch/Tanggal/
  Bank/Baris FP/Baris Bank/Sync Terakhir/Status dari `recent_batches`).
  Catatan: tab ini TIDAK menampilkan raw baris FP/bank mentah satu per
  satu (beda dari pola Mandiri/BRI yang punya sub-tab Raw FP/Raw Bank
  terpisah) — OCBC cukup lewat Export CSV utk kebutuhan audit baris
  mentah.
- **Header**: menampilkan tanggal batch AKTIF (`active_batch.business_date`
  dari response analytics — sumber kebenaran server, bukan cuma filter
  tanggal frontend), mis. "Rekonsiliasi OCBC — 14 Juli 2026".
- **Endpoint TIDAK di-cache** (`getReconciliationAnalytics`/
  `getReconciliationTransactions`/`exportReconciliationCsv` di
  `services/api.js` — selalu fresh, tidak ada cache key sama sekali), jadi
  tidak ada risiko cache lintas-tanggal. Race condition tetap mungkin
  terjadi murni dari urutan resolve promise (bukan cache) kalau user ganti
  tanggal cepat — dijaga via `requestIdRef` (abaikan respons yang bukan lagi
  request terbaru) di `ReconTable` & `loadAnalytics`, plus reset
  `rows`/`analytics` ke kosong SEGERA saat tanggal berganti (jangan tunggu
  respons baru datang dulu). Kalau `active_batch.business_date` dari server
  ternyata beda dari tanggal yang diminta user, frontend menampilkan error
  data integrity dan TIDAK merender hasil.

## Kebutuhan Saldo (Tab 6) — kebutuhan saldo per periode (bukan 1 hari)

### Tujuan
Tab terpisah dari 5 tab lain (yang semuanya scoped ke 1 `date`/batch) — hanya
menampilkan kebutuhan saldo OCBC teragregasi per **jam** untuk suatu
**periode** (7/14/30 hari terakhir, Bulan Ini, Bulan Lalu, atau custom range
maks 90 hari), supaya Operation & Finance bisa melihat pola kebutuhan saldo
per jam (bukan cuma snapshot 1 hari). READ-ONLY murni — TIDAK menyentuh
matching engine, `recon_status`, sync, coverage, atau Exception Queue.

### Sumber data & definisi transaksi
Transaksi FP = `recon_results` dengan `id_transaksi IS NOT NULL` (persis
definisi `fpResultRows` di `dailyReportHandler`) — recon_results sudah
deduped 1 baris per `id_transaksi` oleh engine (`processedIds` Set), jadi
BANK_ONLY/REVERSAL-tanpa-FP sintetis (`id_transaksi` NULL) otomatis
terkecuali (**tidak masuk kebutuhan saldo**), sementara PENDING_BANK/FP_ONLY/
REVERSAL-dengan-FP/dst semuanya **masuk** (kebutuhan saldo timbul begitu FP
diproses, terlepas hasil rekonsiliasinya). Waktu bucket jam pakai
`fp_time_response` di-anchor Asia/Jakarta (`AT TIME ZONE 'Asia/Jakarta'` di
SQL).

### Expected fee — per batch, BUKAN hardcode Rp25
Tidak ada kolom baru/migration. Expected fee tiap tanggal diturunkan dari
data yang SUDAH ADA: `bank_fee - variance_fee` pada baris `recon_results`
matched batch tanggal itu (konstan per batch, krn 1 config `expected_fee`
berlaku utk seluruh sync hari itu — lihat `expectedFee` di
`reconcileTransactionsWithCoverage`). Fallback `DEFAULT_FEE_BIFAST` (default
Rp25, sama constant yang dipakai engine sendiri) HANYA kalau batch itu
genuinely tidak punya baris matched sama sekali (mis. semua FP_ONLY).

### Included days vs selected days
`included_days` = tanggal dalam rentang yang PUNYA batch `recon_sync_batches`
(`bank_code='OCBC'`) — average SELALU dibagi `included_days`, bukan
`selected_days`. Jam yang tidak punya transaksi pada suatu included day tetap
dihitung `0` (bukan di-skip dari average). Tidak ada fallback ke batch di
luar rentang yang diminta.

### Backend
`GET /api/warroom/reconciliation/ocbc/balance-needs-periodic?start_date=&end_date=`
(`balanceNeedsPeriodicHandler` di `warroom-reconciliation.js`) — JWT,
`Cache-Control: no-store`, rentang maksimal 90 hari. Response: `coverage`
(`selected_days`/`included_days`/`missing_days`/`included_dates`/
`missing_dates`), `summary` (8 KPI), `hourly[]` (24 bucket tetap, tiap
elemen: `total_transaction`, `average_transaction_per_day`,
`total_principal`, `average_principal_per_day`, `total_expected_fee`,
`average_fee_per_day`, `total_balance_need`, `average_balance_need_per_day`,
`maximum_daily_need`, `minimum_daily_need`, `peak_date`), `daily[]`
(1 baris per included day, sort tanggal terbaru dulu: `transaction_count`,
`principal`, `expected_fee`, `total_balance_need`, `peak_hour`,
`peak_hour_need`). `empty:true` kalau tidak ada batch OCBC sama sekali pada
rentang yang diminta (tidak pernah fallback ke rentang lain).

Query dedup transaksi per `(batch_id, canonical_transaction_key)` via
`DISTINCT ON` SEBELUM `GROUP BY (business_date, hour)` — SATU query agregasi
(bukan 24 query per jam), cross-date guard sama dgn endpoint OCBC lain
(`bank_transaction_date` harus cocok `business_date` batch kalau terisi).
Perhitungan bucket/average/peak murni di fungsi pure
`computeOcbcBalanceNeedsPeriodic()` (tidak menyentuh DB, diuji langsung —
lihat bagian Testing) dipanggil oleh handler dengan hasil query sbg input.

**Refactor shared (Mandiri/BRI/BRI BI-FAST/BNI)**: seluruh logic di atas
(allowlist bank, `dateRangeArray`, fungsi pure agregasi, resolusi query
active batch/expected fee/hourly rows, orkestrasi response) sekarang tinggal
di `backend/src/reconciliation/periodicBalanceNeeds.js` — SHARED dipakai
tab "Kebutuhan Saldo" di 5 bank rekonsiliasi. `warroom-reconciliation.js`
(OCBC) HANYA delegate ke sana lewat alias
(`computeOcbcBalanceNeedsPeriodic = periodicBalanceNeeds.computePeriodicBalanceNeeds`,
`dateRangeArray = periodicBalanceNeeds.dateRangeArray`) dan
`balanceNeedsPeriodicHandler` memanggil `periodicBalanceNeeds.buildBalanceNeedsResponse({ pool, bankCode: 'OCBC', ... })`
— **byte-for-byte identik** dgn implementasi lama (diverifikasi: 76 test
OCBC existing lolos 100% tanpa perubahan setelah refactor). Detail lengkap
mekanisme shared (per-bank rules, BNI funding comparison, dst) ada di
`docs/RECONCILIATION_BNI.md` bagian "Kebutuhan Saldo" (paling lengkap krn
BNI satu-satunya bank dgn enrichment tambahan) — jangan duplikasi
penjelasan mekanisme umum di 4 dokumen bank lain, cukup rujuk ke sana dan
sebutkan hal yang BEDA per bank saja.

### Frontend
- Komponen: `frontend/src/components/reconciliation/OcbcPeriodicBalanceNeeds.jsx`,
  dipasang sbg tab `kebutuhan-saldo` di `WarRoomReconciliationOcbc.jsx`
  (posisi sebelum Laporan Harian), independen dari filter tanggal 1-hari yang
  dipakai 5 tab lain.
- Filter periode sendiri: 7/14/30 Hari Terakhir, Bulan Ini, Bulan Lalu,
  Custom Date Range (maks 90 hari, divalidasi di frontend & backend).
  Default: 7 hari terakhir (Asia/Jakarta). Ganti periode -> data lama
  dikosongkan segera + request lama diabaikan via `requestIdRef` (sama pola
  race-condition guard dgn tab lain di halaman ini).
- Chart.js line chart (2 seri: Average/Total Kebutuhan Saldo per Jam +
  Maximum Kebutuhan Harian), toggle Average/Total Periode mengganti seri
  utama antara `average_balance_need_per_day` dan `total_balance_need` per
  jam (seri Maximum tetap `maximum_daily_need`). Tooltip menampilkan jam,
  average transaksi/principal/fee/kebutuhan per hari, maximum kebutuhan, dan
  peak date.
- Tabel per jam (+ baris TOTAL) dan tabel detail per tanggal, keduanya
  `wrr-table` dengan scroll horizontal mobile bawaan (`wrr-table-wrap`).
  Empty state: "Belum ada batch Rekonsiliasi OCBC pada periode ini."
- 2 tombol export, sama-sama berisi 2 bagian (Rekap Per Jam + Rekap Per
  Tanggal): **Export CSV** (1 file `.csv`, 2 section dgn baris judul
  `REKAP PER JAM`/`REKAP PER TANGGAL`) dan **Export XLS** (1 file `.xlsx`
  asli, 2 sheet terpisah — "Rekap Per Jam" & "Rekap Per Tanggal" — via
  library `xlsx` SheetJS, **diinstall dari CDN resmi SheetJS**
  (`https://cdn.sheetjs.com/xlsx-latest/xlsx-latest.tgz`), BUKAN dari npm
  registry — versi npm registry-nya sudah lama tidak di-update & punya
  vulnerability high-severity tanpa fix (prototype pollution + ReDoS),
  sedangkan build CDN resmi sudah dipatch. Lihat `frontend/package.json`
  (`"xlsx": "https://cdn.sheetjs.com/..."`) — kalau suatu saat perlu update
  versi, ganti URL tarball-nya, JANGAN `npm install xlsx` biasa.
- CSS prefix: `wrr-balance-periodic-*` (reuse `wrr-panel`/`wrr-kpi-*`/
  `wrr-table`/`wrr-btn`/`wrr-select` existing utk konsistensi visual).

## Laporan Harian (Tab 7) — laporan siap-cetak untuk Direktur

### Tujuan
Ringkasan rekonsiliasi harian OCBC yang bisa langsung ditunjukkan/dicetak
untuk Direktur — bukan dashboard operasional (itu tugas 5 tab lainnya).
Posisi tab **wajib paling akhir**, urutan 5 tab sebelumnya tidak berubah,
dan **tidak ada menu sidebar baru** — akses tetap lewat
`/war-room/rekonsiliasi-ocbc` yang sudah ada.

### Sumber data — TIDAK PERNAH fallback tanggal
Endpoint `GET /api/warroom/reconciliation/daily-report?date=YYYY-MM-DD&bank_code=OCBC`
(`dailyReportHandler` di `warroom-reconciliation.js`) berbeda mendasar dari
`analyticsHandler`: kalau `date` tidak dikirim, default-nya **hari ini di
Asia/Jakarta** (`todayJakarta()`) — **BUKAN** "batch terakhir yang ada"
seperti `analyticsHandler`. Kalau batch untuk tanggal itu belum ada, respons
`{ empty: true, message: "Belum ada data rekonsiliasi OCBC untuk tanggal
ini." }` — **tidak pernah** menampilkan angka 0 seolah valid, dan **tidak
pernah** diam-diam menampilkan data batch tanggal lain.

`active_batch.business_date` adalah **satu-satunya sumber kebenaran**
tanggal laporan (query `WHERE business_date = $1 AND bank_code = $2`, lalu
diverifikasi ulang lewat guard eksplisit — kalau pernah tidak sama,
handler melempar error keras alih-alih diam-diam mencampur data). Seluruh
agregasi (`recon_results`, `recon_fp_transactions`) di-filter
`batch_id` batch itu saja. Cross-date guard yang sama dengan
`analyticsHandler` tetap berlaku (baris `bank_transaction_date` yang bukan
`date` diminta dikecualikan dari SELURUH perhitungan, dilaporkan lewat
`data_quality_warning.cross_date_result_count`).

**Dedupe canonical key**: sebagai jaminan berlapis TAMBAHAN di luar unique
index `(batch_id, canonical_transaction_key)` yang sudah ada, hasil
di-dedupe eksplisit per `canonical_transaction_key` (ambil 1 baris per
key) SEBELUM dipakai untuk KPI apa pun — memastikan "satu
`canonical_transaction_key` hanya dihitung satu kali" walau suatu saat
index unique-nya somehow tidak aktif di sebuah lingkungan.

### Aturan KPI
- **Berhasil direkonsiliasi** = `MATCHED + MATCHED_NO_FEE` (`matched_transaksi`).
- **Match rate** WAJIB pakai `valid_match_rate_transaction` (coverage-aware,
  sama formula dgn `analyticsHandler`: `matched_in_coverage / fp_in_bank_coverage`).
- **Exception** (utk `actionable_exception_count`, `nominal_terdampak_exception`,
  `top_10_exception`) HANYA baris dengan `coverage_status = IN_BANK_COVERAGE`
  **DAN** `is_actionable = true` **DAN** `recon_status` bukan
  MATCHED/MATCHED_NO_FEE. `OUTSIDE_BANK_COVERAGE` dan `BOUNDARY_PARTIAL`
  bukan kegagalan — tidak pernah dihitung sbg exception di laporan ini
  (persis prinsip yang sama dgn seluruh modul OCBC, lihat bagian
  "Keterbatasan 5.000 Baris" di atas).

### Health Status (GREEN/YELLOW/RED)
Dihitung server-side (`dailyReportHandler`), field `health_status`:

| Kondisi | Status |
|---|---|
| `valid_match_rate_transaction ≥ 99%` DAN tidak ada actionable exception DAN tidak ada data quality issue | **GREEN** |
| `95% ≤ match rate < 99%` ATAU masih ada actionable exception (tapi tidak memenuhi kondisi RED) | **YELLOW** |
| `match rate < 95%` ATAU sync batch belum berstatus `success` ATAU ada data quality issue (cross-date/duplicate canonical) ATAU ditemukan kombinasi REVERSAL+BANK_ONLY utk canonical key yang sama | **RED** |

Urutan evaluasi: RED dicek lebih dulu (menang atas YELLOW), lalu YELLOW,
default GREEN.

### Response `daily-report` (field utama)
`empty`, `message`, `generated_at`, `report_status` (`RUNNING` kalau
`date` = hari ini WIB, `CLOSED` kalau tanggal sebelumnya), `health_status`,
`meta` (date/bank_code/batch_no/last_sync), `active_batch`, `total_fp`,
`total_nominal_fp`, `total_bank_row_count`, `matched_transaksi`,
`valid_match_rate_transaction`, `valid_match_rate_nominal`,
`actionable_exception_count`, `nominal_terdampak_exception`, `reversal`
(`{count, nominal}`), `status_distribution`, `financial_summary`
(`total_nominal_fp`/`matched_nominal`/`nominal_terdampak_exception`/
`total_fee_bank`/`reversal_nominal`), `coverage` (blok sama dgn
`analyticsHandler`), `data_quality_warning` (`{cross_date_result_count,
duplicate_canonical_result_count, reversal_also_bank_only_count,
has_issue, message}`), `top_10_exception` (array, diurutkan nominal
terbesar), `ringkasan_direktur` (string narasi otomatis Bahasa Indonesia),
`rekomendasi_tindak_lanjut` (array string).

### Frontend (`DailyReportTab` di `WarRoomReconciliationOcbc.jsx`)
Header laporan (judul + tanggal + waktu sync terakhir + waktu laporan
dibuat), badge status `BERJALAN (HARI INI)`/`SELESAI`, badge kesehatan
GREEN/YELLOW/RED berwarna, panel "Ringkasan Otomatis untuk Direktur", 8 KPI
utama (`wrr-kpi-grid`), panel Ringkasan Status, Posisi Finansial, Top 10
Exception, Coverage Data Bank OCBC, Pemeriksaan Kualitas Data, dan Tindak
Lanjut Utama.

Tiga tombol:
- **Perbarui Laporan** — refetch endpoint tanpa reload halaman.
- **Salin Ringkasan** — `navigator.clipboard.writeText()` teks plain siap
  tempel WhatsApp (`buildDailyReportCopyText()`), fallback pesan manual
  kalau clipboard API gagal/diblokir browser.
- **Cetak / Simpan PDF** — `window.print()` native (bukan library PDF
  eksternal).

### CSS Print (A4)
`@media print` di `index.css`: `@page { size: A4; margin: 15mm; }`,
`-webkit-print-color-adjust: exact` (badge warna tetap tercetak, tidak
di-strip default browser). Disembunyikan total saat print: `.sidebar`,
`.topbar`, `.gsheet-bar`, `.presence-footer`, `.aic-fab`/`.aic-panel` (AI
Chat), `.wrr-header` (date selector + tombol Sync Now/Refresh), `.wrr-tabs`
(tab navigation), seluruh `.wrr-btn` (termasuk toolbar Perbarui/Salin/Cetak
sendiri — tidak masuk akal ada tombol di kertas), dan elemen apa pun
berclass `.wrr-print-hide`. `.wrr-panel` diberi `break-inside: avoid`
supaya 1 panel tidak terpotong di tengah antar halaman. Aturan ini berlaku
GLOBAL (bukan cuma tab Laporan Harian) — cetak dari tab lain war-room
manapun otomatis ikut rapi tanpa sidebar/navbar juga.

### Empty state
Kalau batch tanggal yang dipilih belum ada: pesan **"Belum ada data
rekonsiliasi OCBC untuk tanggal ini."** ditampilkan (ikon + teks polos),
TIDAK ada KPI card/angka 0 yang dirender sama sekali (`report.empty === true`
mem-short-circuit seluruh render sebelum sampai ke KPI grid).

## Testing
`node backend/scripts/test-reconciliation-ocbc.js` — 10 acceptance test
resmi awal + beberapa test tambahan (MATCHED_NO_FEE, FEE_MISMATCH, fallback
description, BANK_ONLY scope) + TEST 1-11 coverage-aware (OUTSIDE/
BOUNDARY_PARTIAL classification, exact match menang di boundary, valid
match rate, fingerprint archive stabil & deterministik, timezone WIB dini
hari, regresi `reconcileTransactionsWithCoverage` identik dgn
`reconcileTransactions` lama utk data tidak truncated) + fallback jam
presisi raw_data.A + CROSS-DATE TEST 1-2 (`buildTransactionsQuery` pure) +
REVERSAL-DUP TEST 1-8 (REVERSAL dgn pasangan FP -> 1 result bukan 2,
MATCHED/NOMINAL_MISMATCH tetap consumed tidak jadi BANK_ONLY kedua,
BANK_ONLY valid, credit-only/fee-only bukan BANK_ONLY, fallback description
dgn credit, exact+fallback sama-sama match -> 1 group) +
`normalizeCanonicalKey` (preserve leading zero) + TEST 7f/7g (fingerprint
SAMA meski detik `transaction_date_time` berbeda dalam menit yang sama —
regresi insiden DUPLICATE_BANK produksi 2.049 baris, lihat Troubleshooting;
fingerprint TETAP beda kalau beda MENIT) + BALANCE-NEEDS TEST 1-7 (pure
`computeOcbcBalanceNeedsPeriodic()`/`dateRangeArray()` — 24 bucket tetap,
average dibagi `included_days` bukan `selected_days`, jam kosong pada
included day dihitung 0, expected fee ikut batch masing-masing tanggal
(bukan fee batch lain), rentang tanpa batch -> `empty:true`, contoh numerik
spec bagian 4) — **76 test total**. Test tambahan khusus generalisasi
multi-bank (allowlist, label, default fee per bank, resolusi expected fee
OCBC vs bank lain, BRI BI-FAST tidak double-count, BNI funding comparison,
rentang >90 hari) ada di
`node backend/scripts/test-periodic-balance-needs.js` (25 test, terpisah
krn scope-nya generalisasi bank bukan OCBC spesifik). Skenario DB/live (resync, idempotensi,
resolution manual existing, cross-date, regresi Mandiri, filter FP di luar
business_date, dedup `DISTINCT ON` di query balance-needs-periodic)
diverifikasi end-to-end lewat server sungguhan (pola yang sama dgn TEST
8/TEST 10 coverage-aware — lihat catatan di file test soal kenapa
`runOcbcEngineAndPersist` sendiri tidak bisa di-unit-test tanpa DB).

**Repair data cross-date yang terlanjur salah**:
`node backend/scripts/repair-reconciliation-cross-date.js` (default
DRY-RUN — hanya menampilkan batch & jumlah baris cross-date, TIDAK
mengubah apa pun) lalu `--apply` setelah dry-run diverifikasi aman —
untuk tiap batch terdampak, menjalankan ULANG `runOcbcEngineAndPersist()`
(kode yang sudah diperbaiki: archive kini scoped `business_date`) sehingga
baris cross-date lama otomatis tidak dihasilkan lagi & terhapus lewat
mekanisme cleanup-stale bawaan (bukan DELETE manual terpisah) — archive
kumulatif TIDAK disentuh, `recon_action_logs` hanya ikut hilang untuk baris
yang memang tidak valid (FK `ON DELETE CASCADE`), baris yang masih valid
(natural key sama) tetap di-UPDATE (id stabil, riwayat log tetap ada).
Jalankan di server (Node lokal Windows tidak tersedia).

**Repair duplikat REVERSAL+BANK_ONLY (atau kombinasi lain) per canonical
transaction key yang terlanjur salah**:
`node backend/scripts/repair-reversal-bank-only-duplicates.js` (default
DRY-RUN — menampilkan tiap canonical key yg punya >1 recon_results, statusnya
apa saja, id row-nya) lalu `--apply` setelah dry-run diverifikasi aman —
untuk tiap grup duplikat: pilih row yang dipertahankan berdasarkan
prioritas status (REVERSAL tertinggi, urutan lengkap ada di
`STATUS_PRIORITY_ORDER` dalam file script), lengkapi field NULL di row yang
dipertahankan dari row lain (TIDAK PERNAH menimpa nilai yang sudah terisi
dgn NULL), pindahkan `recon_action_logs` dari row yang dihapus ke row yang
dipertahankan (riwayat audit TIDAK hilang), baru hapus row duplikat.
**WAJIB dijalankan (dan dipastikan 0 duplikat tersisa) SEBELUM** migration
`add_reconciliation_canonical_transaction_key_unique.sql` — unique index
baru akan GAGAL dibuat kalau masih ada duplikat. Jalankan di server (Node
lokal Windows tidak tersedia).

## Troubleshooting
- **401 saat sync**: cek `APPS_SCRIPT_TOKEN` sudah sama di server & Script Properties Apps Script.
- **413 saat sync**: cek endpoint `reconciliation/sync` sudah masuk regex payload besar di Nginx.
- **Semua status NEED_REVIEW/BANK_ONLY membludak**: cek pola Description OCBC — kalau
  format outlet bukan 2 huruf+5 digit, sesuaikan regex `parseDescriptionFallback` di
  `warroom-reconciliation.js` DAN Apps Script tetap boleh kirim description apa adanya
  (parsing terjadi di backend, bukan Apps Script).
- **`coverage.is_source_truncated` selalu false padahal bank_row_count sudah 5.000**:
  cek apakah `recon_bank_snapshots` punya baris utk batch ini (kalau sync
  terakhir berjalan pakai kode SEBELUM fitur coverage-aware ada, belum ada
  snapshot — resync sekali lagi utk membuatnya).
- **`fp_outside_coverage`/`fp_boundary_partial` selalu 0 walau data sudah 5.000 baris**:
  ini WAJAR kalau Apps Script yang terpasang belum di-update (belum kirim
  `transaction_date_time`) — tanpa presisi jam, `calculateOcbcCoverage()`
  tidak bisa menghitung boundary minute dan default aman ke
  `IN_BANK_COVERAGE` utk semua baris. Update Apps Script (re-paste file
  terbaru) utk mengaktifkan klasifikasi penuh.
- **Query error `time zone "gmt+0800" not recognized` (atau timezone lain) saat sync**:
  kolom `DATE` (bukan `TIMESTAMPTZ`) yang dibaca TANPA cast `::text` akan
  di-parse node-pg jadi objek `Date`, lalu kalau diproses lewat
  `String(value)`/`nullIfEmpty()` akan memanggil `.toString()` JS yang
  menghasilkan string macam `"Thu Jan 02 2099 00:00:00 GMT+0800 (...)"` —
  Postgres menolak string itu sbg DATE. Insiden nyata pernah terjadi pada
  `value_date`; fix permanen: selalu cast `::text` di setiap `SELECT` yang
  membaca kolom DATE (pola yang sama seperti `transaction_date`/`business_date`).
- **Match rate kolaps mendadak, `recon_status` didominasi `DUPLICATE_BANK`,
  `recon_bank_archive` membengkak jauh melebihi `bank_row_count` (mis. 10.000
  padahal source_limit 5.000)**: insiden nyata — `computeBankRowFingerprint()`
  sempat ikut memakai kolom `balance`. Running balance OCBC utk 1 mutasi yang
  SAMA bisa berubah antar sync (transaksi lain yang clear belakangan menggeser
  saldo berjalan yang dilaporkan bank utk baris lama), sehingga baris bank yang
  identik (bank_code/account_no/reference_no/description/debit/credit sama
  persis) menghasilkan `row_fingerprint` BARU tiap kali di-sync ulang — archive
  tidak pernah ter-upsert ke baris yang sama, terus menumpuk duplikat, dan
  grouping by `reference_no` di engine menemukan >1 "principal" utk referensi
  yang sama -> `DUPLICATE_BANK` mendominasi, match rate anjlok. Fix permanen:
  `balance` DIKELUARKAN dari fingerprint (tetap disimpan di kolom archive,
  di-refresh via `ON CONFLICT ... SET balance = EXCLUDED.balance`, hanya tidak
  lagi jadi bagian identitas). Kalau archive sudah kadung membengkak sebelum
  fix ini di-deploy, dan seluruh baris arsip masih dalam window snapshot bank
  yang masih hidup (belum tergeser keluar 5.000 baris), aman untuk
  `TRUNCATE recon_bank_snapshots CASCADE;` (ikut mengosongkan
  `recon_bank_archive`) lalu memicu 1x sync baru (Sync Now/reactive trigger)
  supaya archive terbangun ulang bersih dari fingerprint yang sudah benar.
  Jangan truncate kalau ada kemungkinan baris arsip lama sudah tergeser keluar
  snapshot hidup — itu akan menghilangkan histori yang justru menjadi tujuan
  utama Rolling Bank Archive.
  Catatan tambahan: kalau 1 `reference_no` punya lebih dari 2 baris arsip
  (principal+fee), itu BUKAN otomatis bug — BI-FAST OCBC bisa memakai ulang
  `reference_no` yang sama utk transaksi asli + reversal-nya (debit pair +
  credit pair), dan itu memang tugas cascade `REVERSAL` di
  `reconcileTransactions()`/`reconcileTransactionsWithCoverage()` utk
  mengenalinya, bukan tanda archive rusak.
- **`coverage.trusted_coverage_start` tetap `null` terus walau sudah resync,
  `FP_ONLY` meledak ratusan padahal seharusnya ~0 (dan bank counterpart-nya
  memang ada, cuma sudah tergeser keluar window 5.000 baris)**: DUA insiden
  bertumpuk, keduanya nyata terjadi di produksi:
  1. Apps Script yang TERPASANG mengirim `transaction_date_time` lewat
     `reconToIso_()`, tapi fungsi itu HANYA memformat objek `Date` asli dari
     `getValues()` — kalau sel sheet berupa TEXT (kasus nyata kolom waktu
     OCBC), `reconToIso_()` lama cuma `return String(value).trim()`, alias
     mengembalikan `"DD/MM/YYYY HH:mm"` MENTAH, bukan ISO.
  2. Karena field itu tetap truthy, resolver lama backend
     (`row.transaction_date_time ? parseTimeResponse(...) : fallback`)
     langsung commit ke cabang pertama — `new Date("DD/MM/YYYY...")` utk
     tanggal>12 = Invalid Date = null — dan TIDAK PERNAH mencoba fallback
     `raw_data.A`, walau fallback itu sendiri sudah benar.
  Fix permanen: satu parser toleran `parseFlexibleOcbcDateTime()` (terima
  ISO ATAU `"DD/MM/YYYY[ HH:mm[:ss]]"` mentah, anchor Asia/Jakarta +07:00)
  dipakai baik utk `transaction_date_time` maupun fallback `raw_data.A`;
  `resolveOcbcTransactionDateTime()` mencoba SEMUA tier via OR chain (bukan
  if/return dini) supaya selalu jatuh ke tier berikutnya kalau satu tier
  gagal parse, bukan cuma kalau falsy. `reconToIso_()` di
  `apps-script-reconciliation-ocbc.js` juga diperbaiki supaya mem-parse
  DD/MM/YYYY jadi ISO +07:00 yang benar (butuh user paste ulang ke Apps
  Script Editor utk aktif di sisi Apps Script — TAPI backend sudah robust
  independen dari itu, tidak perlu menunggu).
  **Efek samping SEKALI JALAN yang harus diantisipasi**: begitu
  `transaction_date_time` berubah dari selalu-null jadi terisi, SEMUA baris
  arsip lama (fingerprint dihitung dgn `transactionDateTime: null`) jadi
  "berbeda" dari baris baru hasil sync berikutnya (fingerprint dgn
  `transactionDateTime` terisi) utk transaksi LOGIS YANG SAMA — archive
  membengkak 2x lagi (mis. 5.210 lama + 5.000 baru = 10.210) dan
  `DUPLICATE_BANK` sempat mendominasi lagi (match rate sempat jatuh ke
  ~4%). Sama seperti insiden `balance`: karena seluruh data arsip masih
  dalam window snapshot bank yang masih hidup, aman
  `TRUNCATE recon_bank_snapshots CASCADE;` + 1x sync baru SEKALI LAGI
  setelah fix ini di-deploy. Setelah transisi ini selesai, `transaction_date_time`
  jadi field yang STABIL (jam transaksi historis tidak berubah lagi seperti
  `balance`), jadi tidak akan terulang lagi ke depannya.
- **Transaksi tanggal SEBELUMNYA (mis. tanggal 13) masih muncul di dashboard
  batch tanggal BARU (mis. tanggal 14), jadi `BANK_ONLY`/exception yang
  seharusnya tidak ada**: insiden nyata — `runOcbcEngineAndPersist()` dulu
  mengambil `recon_bank_archive` HANYA difilter `bank_code`(+`account_no`),
  **TANPA `business_date` sama sekali**. Begitu archive kumulatif mencakup
  lebih dari 1 hari, SETIAP batch ikut menarik SELURUH baris archive lintas
  tanggal ke dalam engine — baris bank hari sebelumnya yang tidak ada
  pasangan FP-nya di batch hari ini salah jadi `BANK_ONLY` milik batch hari
  ini. Fix permanen: query archive sekarang WAJIB
  `AND business_date = $businessDate` (equality pada kolom yang sudah
  WIB-anchored sejak insert, BUKAN range `AT TIME ZONE` — lihat bagian
  "Business Date Scoping" di atas). Data yang SUDAH terlanjur tersimpan
  salah (sebelum fix ini di-deploy) dibersihkan dengan
  `node backend/scripts/repair-reconciliation-cross-date.js --apply`
  (dry-run dulu tanpa `--apply` utk lihat batch mana saja yang terdampak) —
  archive TIDAK ikut terhapus/terpengaruh, hanya `recon_results` milik batch
  yang salah yang dibersihkan (via re-run engine, bukan DELETE manual).
- **Transaksi yang sudah REVERSAL (credit ditemukan, pasangan FP ada) masih
  muncul LAGI sebagai `BANK_ONLY` terpisah utk Reference No. yang sama, KPI
  BANK_ONLY & selisih membengkak**: insiden nyata — `bankByRef` (exact) dan
  `bankFallbackByIdTransaksi` (fallback, HANYA dari baris ber-reference
  KOSONG) adalah 2 index terpisah yang tidak saling sinkron; ditambah unique
  index lama `(batch_id, id_transaksi, reference_no)` menganggap baris
  FP-based (id_transaksi terisi) dan baris BANK_ONLY (id_transaksi NULL,
  reference_no sama) sbg 2 identitas berbeda. Fix permanen: grouping bank
  SATU struktur per canonical transaction key (`buildOcbcBankGroups()`) +
  `consumedBankKeys` (ditandai segera saat group dipakai FP manapun, apa pun
  status akhirnya) + kolom `canonical_transaction_key` menggantikan unique
  index lama (lihat bagian "Canonical Transaction Key" di atas). Data yang
  SUDAH terlanjur tersimpan duplikat dibersihkan dengan
  `node backend/scripts/repair-reversal-bank-only-duplicates.js --apply`
  (dry-run dulu) — **WAJIB** dijalankan (sampai 0 duplikat) SEBELUM migration
  `add_reconciliation_canonical_transaction_key_unique.sql`, kalau tidak
  `CREATE UNIQUE INDEX` akan gagal. Cek juga field
  `data_quality_warning.duplicate_canonical_result_count`/
  `reversal_also_bank_only_count` di response analytics — harus SELALU 0.
- **`DUPLICATE_BANK` mendadak membludak (mis. 2.049 exception dari total
  ~2.200 FP) padahal Description/reference terlihat aman di sheet, tidak
  ada tanda pola baru yang rusak**: insiden nyata KETIGA dengan pola sama
  seperti `balance` & `description` sebelumnya — kali ini `transaction_date_time`.
  OCBC/Apps Script tidak melaporkan **detik** yang stabil untuk 1 mutasi
  bank yang identik antar sync (mis. `07:49:00` pada sync pertama, `07:49:20`
  beberapa jam kemudian untuk mutasi yang PERSIS sama — reference_no,
  description, debit sama semua). Karena `computeBankRowFingerprint()`
  memakai `transactionDateTime.toISOString()` (presisi detik+milidetik),
  mutasi yang sama menghasilkan `row_fingerprint` BARU tiap kali detiknya
  berbeda → baris arsip duplikat → grouping by reference menemukan >1
  "principal" → `DUPLICATE_BANK` mendominasi. Diagnosis: bandingkan baris
  `recon_bank_archive` untuk 1 `reference_no` yang muncul di `DUPLICATE_BANK`
  — kalau ada 4 baris (bukan 2) dengan pasangan nilai debit yang sama
  persis tapi `transaction_date_time` beda beberapa detik/menit, ini
  penyebabnya. Fix permanen: `normalizeDateForFingerprint()` men-**truncate
  detik & milidetik** (`setSeconds(0, 0)`) sebelum dipakai sbg bagian
  fingerprint — presisi menit sudah cukup unik digabung reference_no/
  description/debit/credit, dan ini KONSISTEN dgn `calculateOcbcCoverage()`
  yang juga membuang detik saat menghitung boundary minute. Regresi:
  TEST 7f/7g di `test-reconciliation-ocbc.js`. **Perbaikan data yang sudah
  terlanjur duplikat**: jalankan ulang
  `node backend/scripts/repair-bank-archive-fingerprint.js` (dry-run
  default, `--apply` setelah diverifikasi) — script yang SAMA dipakai utk
  insiden `description` sebelumnya, generik terhadap fungsi
  `computeBankRowFingerprint()` yang mana pun sedang aktif — lalu jalankan
  ulang `runOcbcEngineAndPersist()` untuk batch-batch yang terdampak supaya
  `recon_results` ikut terhitung ulang dari archive yang sudah bersih
  (tidak ada script khusus terpisah — cukup query batch terkait & panggil
  fungsi itu langsung, pola yang sama dgn `repair-reconciliation-cross-date.js`).
- **`FP_ONLY` meledak besar setiap kali business_date berganti (mis. hari
  baru mulai jam 00:00 WIB), padahal kemarin match rate sudah tinggi/100%,
  dan begitu dicek sheet "DATA FP"/"DATA BANK OCBC" ternyata isinya masih
  data kemarin**: insiden nyata — lihat bagian "Validasi Tanggal Baris FP
  saat Sync" di atas. Root cause: `business_date` dihitung Apps Script dari
  `new Date()` (kalender hari itu), TAPI sheet sumber belum sempat
  direfresh operator untuk hari baru saat reactive trigger sempat jalan —
  baris FP kemarin ikut tersimpan di bawah label business_date hari ini,
  dan archive bank untuk business_date baru itu genuinely kosong. Fix
  permanen: `syncHandler` sekarang melewati (skip insert) baris FP yang
  `time_response`-nya (Asia/Jakarta) beda dari `business_date` payload.
  **Data yang sudah kadung tersimpan salah** (batch hari ini penuh FP salah
  tanggal dari SEBELUM fix ini aktif): hapus baris `recon_fp_transactions`
  batch tsb yang tanggalnya tidak cocok, lalu jalankan ulang
  `runOcbcEngineAndPersist()` — batch akan kembali menampilkan status
  kosong yang jujur (bukan `FP_ONLY` massal) sampai sheet betul-betul
  direfresh dengan data hari itu.
