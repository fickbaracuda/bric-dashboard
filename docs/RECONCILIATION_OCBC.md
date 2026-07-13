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

## Database
Migration: `backend/src/migrations/create_reconciliation_ocbc.sql` (tabel dasar)
+ `backend/src/migrations/add_reconciliation_ocbc_coverage.sql` (coverage + archive)
Runner: `backend/scripts/run-reconciliation-ocbc-migration.js` +
`backend/scripts/run-reconciliation-ocbc-coverage-migration.js`

| Tabel | Key | Catatan |
|---|---|---|
| `recon_sync_batches` | UNIQUE(business_date, bank_code) | 1 batch per hari per bank; resync menimpa batch yang sama |
| `recon_fp_transactions` | — | Raw FP, dihapus+diisi ulang tiap chunk pertama sync |
| `recon_bank_transactions` | — (reference_no SENGAJA TIDAK unique) | Raw bank (snapshot AKTIF saja), dihapus+diisi ulang tiap sync. + `transaction_date_time` (TIMESTAMPTZ, presisi menit) |
| `recon_results` | UNIQUE expression index (batch_id, id_transaksi, reference_no) | Hasil engine, di-**upsert** (bukan delete+insert). `recon_status` sekarang **NULLABLE**. + `coverage_status`/`coverage_reason`/`is_actionable`/`eligible_for_match_rate`/`bank_snapshot_id`/`archive_match` |
| `recon_action_logs` | FK ke recon_results | Audit trail tiap aksi resolve |
| `recon_bank_snapshots` | FK ke recon_sync_batches | **BARU** — 1 baris ringkasan cakupan per sync (row_count, is_truncated, snapshot_oldest/newest_time, trusted_coverage_start) |
| `recon_bank_archive` | UNIQUE(row_fingerprint) | **BARU** — kumulatif, TIDAK PERNAH dihapus. Identitas via SHA-256 fingerprint (bukan source_row_number) |

**Idempotensi sync**: chunk pertama (`chunk_index=0`) menghapus data mentah
lama batch tsb (raw snapshot saja — archive TIDAK disentuh); chunk
terakhir membuat 1 baris `recon_bank_snapshots`, meng-upsert setiap baris
bank ke `recon_bank_archive`, lalu menjalankan engine dan meng-upsert
`recon_results` by natural key. Resync data yang sama tidak pernah
menggandakan baris atau batch — diverifikasi lewat sync 2× berturut-turut
menghasilkan `result_count`/jumlah archive row identik.

## Backend Endpoints (`backend/src/routes/warroom-reconciliation.js`)
| Endpoint | Auth | Keterangan |
|---|---|---|
| `POST /api/warroom/reconciliation/sync` | `APPS_SCRIPT_TOKEN` (token SHARED, bukan token baru) | Terima chunk FP/bank, jalankan engine di chunk terakhir |
| `GET /api/warroom/reconciliation/sync-request-status?bank_code=` | `APPS_SCRIPT_TOKEN` | Dipanggil Apps Script tiap 1 menit — cek apakah tombol "Sync Now" ditekan sejak sync terakhir |
| `GET /api/warroom/reconciliation/analytics?date=&bank_code=` | JWT | Summary (+ `valid_match_rate_*`, `actionable_exception_count`), distribusi status, validasi rekening, fee analysis, blok `coverage` baru, recent batches |
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
- 5 tab: Executive Summary, Hasil Rekonsiliasi, Exception Queue, Fee Analysis, Raw Data & Audit
- **Executive Summary**: banner "Data OCBC Terbatas" muncul kalau
  `coverage.is_source_truncated=true`; panel "Cakupan Data Bank OCBC"
  (Bank Coverage Start/End, Trusted Coverage Start, Bank Rows Received,
  Archive Rows, FP Dalam/Luar Cakupan, Boundary Partial); KPI utama pakai
  `valid_match_rate_transaction`/`valid_match_rate_nominal` (bukan
  `match_rate_transaksi`/`match_rate_nominal` lama) + KPI
  `actionable_exception_count`.
- **Hasil Rekonsiliasi & Exception Queue**: kolom baru "Cakupan" (badge
  `coverage_status` — `IN_BANK_COVERAGE` biru, `OUTSIDE_BANK_COVERAGE`
  "Di Luar Cakupan Data OCBC" abu-abu, `BOUNDARY_PARTIAL` "Batas Data OCBC
  Terpotong" kuning — **tidak pernah merah**, keduanya bukan kegagalan
  transaksi). Filter coverage TERSEDIA (opsional) di Hasil Rekonsiliasi;
  Exception Queue **WAJIB** `coverage_status=IN_BANK_COVERAGE&is_actionable=true`
  (hardcoded, bukan pilihan user) supaya transaksi di luar cakupan/boundary
  tidak pernah nyasar ke sana.

## Testing
`node backend/scripts/test-reconciliation-ocbc.js` — 10 acceptance test
resmi awal + beberapa test tambahan (MATCHED_NO_FEE, FEE_MISMATCH, fallback
description, BANK_ONLY scope) + **TEST 1-11 coverage-aware** (OUTSIDE/
BOUNDARY_PARTIAL classification, exact match menang di boundary, valid
match rate, fingerprint archive stabil & deterministik, timezone WIB dini
hari, regresi `reconcileTransactionsWithCoverage` identik dgn
`reconcileTransactions` lama utk data tidak truncated) — 44 test total.
Jalankan di server (Node lokal Windows tidak tersedia).

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
