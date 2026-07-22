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
`isValidIdTransaksi`, `RECON_STATUSES`, `normalizeCanonicalKey`, dst)
diimpor langsung dari `warroom-reconciliation.js` — tidak diduplikasi.

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

**Catatan**: berbeda dari OCBC, Mandiri **tidak** punya dimensi
`coverage_status` (`IN_BANK_COVERAGE`/`OUTSIDE_BANK_COVERAGE`/
`BOUNDARY_PARTIAL`) yang disurfacekan per baris hasil — `scope_mode` di
Mandiri HANYA memengaruhi apakah sebuah grup bank BOLEH jadi kandidat
`BANK_ONLY`, tidak ada badge "Cakupan" terpisah di tabel Hasil Rekonsiliasi/
Exception Queue Mandiri (beda dari OCBC yang punya kolom Cakupan). Mandiri
juga tidak punya masalah "keterbatasan 5.000 baris" seperti OCBC — sheet
`DATA Mandiri` tidak dibatasi jumlah baris terbaru, jadi tidak perlu Rolling
Bank Archive.

## Canonical Transaction Key — upsert idempotent (SAMA dgn OCBC)
`recon_results` adalah tabel SHARED lintas bank dengan
`UNIQUE(batch_id, canonical_transaction_key)` (bukan lagi
`(batch_id, id_transaksi, reference_no)` lama). Setiap hasil engine
di-upsert dgn `canonicalKey = normalizeCanonicalKey(idTransaksi) ||
normalizeCanonicalKey(referenceNo)` (Mandiri tidak punya `reference_no`
asli, jadi hampir selalu `canonicalKey = idTransaksi`). `ON CONFLICT
(batch_id, canonical_transaction_key) DO UPDATE` memastikan resync TIDAK
menggandakan baris — kalau status 1 transaksi berubah antar sync (mis.
`BANK_ONLY` → `REVERSAL`), row yang SAMA di-UPDATE (`id` stabil,
`recon_action_logs` FK ke id itu tidak pernah hilang). Setelah upsert,
`DELETE FROM recon_results WHERE batch_id=$1 AND bank_code='MANDIRI' AND
canonical_transaction_key <> ALL(currentKeys)` membersihkan hasil lama yang
sudah tidak dihasilkan lagi oleh sync ini (bukan DELETE-semua-lalu-insert-
ulang — riwayat resolve/audit log utk key yang MASIH ada tetap aman).
Lihat `docs/RECONCILIATION_OCBC.md` bagian "Canonical Transaction Key"
untuk latar belakang bug yang mendorong desain ini (fix bareng OCBC).

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
tidak mengubah perilaku baris OCBC yang sudah ada) +
`backend/src/migrations/add_reconciliation_canonical_transaction_key.sql` /
`add_reconciliation_canonical_transaction_key_unique.sql` (kolom +
unique index `canonical_transaction_key`, SHARED dgn OCBC — lihat bagian
"Canonical Transaction Key" di atas).
Runner: `backend/scripts/run-reconciliation-mandiri-migration.js`

Kolom penting yang dipakai Mandiri di tabel shared:
`recon_bank_transactions.extracted_transaction_id` / `bank_row_type` /
`extraction_method` / `post_date_time` (TIMESTAMPTZ, bukan DATE — supaya
presisi jam-menit tidak hilang) / `account_no` / `currency` /
`additional_desc` / `close_balance`; `recon_sync_batches.scope_mode` /
`expected_fee` / `grace_period_minutes` / `account_no`;
`recon_results.bank_code` / `time_difference_minutes` /
`canonical_transaction_key`.

## Backend Endpoints (`backend/src/routes/warroom-reconciliation-mandiri.js`)
| Endpoint | Auth | Keterangan |
|---|---|---|
| `POST /api/warroom/reconciliation/mandiri/sync` | `APPS_SCRIPT_TOKEN` (token SHARED) | Chunk FP/Mandiri, jalankan adapter+engine di chunk terakhir |
| `GET /api/warroom/reconciliation/sync-request-status?bank_code=MANDIRI` | `APPS_SCRIPT_TOKEN` | Endpoint GENERIK (bukan di bawah `/mandiri`) — dipanggil Apps Script Mandiri tiap 1 menit, cek tombol "Sync Now" |
| `POST /api/warroom/reconciliation/request-sync` | JWT | Endpoint GENERIK (bukan di bawah `/mandiri`) — tombol "Sync Now", body `{bank_code: 'MANDIRI'}` |
| `GET /api/warroom/reconciliation/mandiri/analytics?date=` | JWT | Kalau `date` TIDAK dikirim, fallback ke batch tanggal PALING BARU (`ORDER BY business_date DESC LIMIT 1`) — beda dari `daily-report` yang default ke hari ini, TIDAK PERNAH fallback. Response: `meta`, `active_batch`, `data_quality_warning`, `summary` (+ `actionable_exception_count`/`actionable_exception_nominal`), `status_distribution`, `fee_analysis`, `time_analysis`, `balance_validation`, `recent_batches` (14 batch terakhir) |
| `GET /api/warroom/reconciliation/mandiri/balance-needs-periodic?start_date=&end_date=` | JWT | **Kebutuhan Saldo** (tab 7) — SHARED service, lihat bagian tersendiri di bawah |
| `GET /api/warroom/reconciliation/mandiri/daily-report?date=` | JWT | **Laporan Harian** (tab 8) — lihat bagian tersendiri di bawah |
| `GET /api/warroom/reconciliation/mandiri/transactions?date=&status=&id_outlet=&id_produk=&id_biller=&account_no=&search=&page=&limit=&sort=&order=` | JWT | List berpaginasi, `status` boleh comma-separated. TIDAK ada param `coverage_status` (Mandiri tidak punya konsep itu) |
| `GET /api/warroom/reconciliation/mandiri/raw-bank?date=` | JWT | Raw baris mutasi Mandiri + hasil ekstraksi (account_no, currency, post_date_time, remarks, additional_desc, debit, credit, close_balance, extracted_transaction_id, bank_row_type, extraction_method) |
| `GET /api/warroom/reconciliation/mandiri/raw-fp?date=` | JWT | Raw baris DATA FP |
| `GET /api/warroom/reconciliation/mandiri/export?...` | JWT | CSV (fetch sbg blob, butuh header Authorization) |
| `POST /api/warroom/reconciliation/mandiri/:id/resolve` | JWT | Body `{status, notes}`, `matching_method` di-set `MANUAL_RESOLUTION`, tercatat di `recon_action_logs` |
| `GET /api/warroom/reconciliation/mandiri/:id/logs` | JWT | Riwayat audit 1 baris hasil |
| `GET /api/warroom/reconciliation/mandiri/resolution-history?date=` | JWT | Rekap semua resolve manual pada batch tanggal ini (beda dari `:id/logs` yang per-baris) |

### `active_batch` & `data_quality_warning` (analytics & daily-report)
Sama konsep dgn OCBC: `active_batch` (`batch_id`, `bank_code`, `business_date`,
`account_no`, `synced_at`, `sync_status`) adalah sumber kebenaran batch yang
sedang ditampilkan — kalau `business_date`-nya beda dari tanggal yang
diminta, handler melempar error keras (integrity guard) alih-alih diam-diam
mencampur data. `data_quality_warning`
(`cross_date_result_count`/`duplicate_canonical_result_count`/
`reversal_also_bank_only_count`/`has_issue`/`message`) dihitung oleh
`computeMandiriDataQualityWarning()` dari baris `recon_results` SEBELUM
dedupe — target normal SELURUHNYA 0. Dedupe (`dedupeMandiriResultsByCanonicalKey()`)
diterapkan SETELAH diagnostic dihitung, sbg jaminan tambahan di luar unique
index DB, supaya "satu canonical_transaction_key hanya dihitung satu kali"
di SEMUA KPI (summary/fee_analysis/time_analysis/actionable exception).

### Actionable Exception (backend, bukan lagi frontend)
`actionable_exception_count`/`actionable_exception_nominal` sekarang
dihitung di `analyticsHandler`/`dailyReportHandler`
(`computeMandiriActionableException()`) — BUKAN lagi di frontend seperti
sebelumnya. Definisi: baris hasil (sudah bersih dari cross-date & dedupe)
dengan `recon_status` termasuk 9 `EXCEPTION_STATUSES`. `nominal` = SUM
`fp_nominal` (fallback `bank_total_debit` utk `BANK_ONLY` yang tidak
punya `fp_nominal`). TIDAK memakai `coverage_status` OCBC — Mandiri tidak
punya dimensi itu; fee-only/credit-only tanpa principal SUDAH dijamin
tidak pernah masuk `recon_results` sbg `BANK_ONLY` oleh
`reconcileMandiriTransactions()` sendiri (lihat bagian "Matching & Status"),
jadi tidak perlu filter tambahan di sisi backend Laporan Harian.

## Frontend
- Route: `/war-room/rekonsiliasi/mandiri`
- Page: `frontend/src/pages/WarRoomReconciliationMandiri.jsx`
- Komponen Laporan Harian: `frontend/src/components/reconciliation/DailyReportMandiriTab.jsx`
  (file TERPISAH dari page utama, beda dari OCBC yang inline — Mandiri
  punya 2 panel tambahan yang tidak ada di OCBC: Time & Posting Summary
  dan Validasi Saldo Mandiri)
- Menu: Rekonsiliasi > **Rekonsiliasi Mandiri** (badge `MDR`, `#003D79`)
- CSS: reuse `wrr-*` (layout generik dari halaman OCBC — tabs/panel/kpi/table/
  modal/pagination/mini-panel-row/**daily-report** termasuk `wrr-daily-report-*`
  yang dibangun utk Laporan Harian OCBC, TIDAK diduplikasi) + `wrrm-*`
  (elemen BARU khusus Mandiri: validasi saldo, bucket waktu, sub-tab Raw
  Data & Audit)
- **8 tab (urutan tetap, Laporan Harian WAJIB paling akhir)**: Executive
  Summary, Hasil Rekonsiliasi, Exception Queue, Fee Analysis, **Time &
  Posting Analysis**, Raw Data & Audit, **Kebutuhan Saldo**, **Laporan
  Harian**.

## Kebutuhan Saldo (Tab 7) — SHARED service, bukan implementasi terpisah
Dipasang via komponen shared
`frontend/src/components/reconciliation/PeriodicBalanceNeeds.jsx`
(`bankCode="MANDIRI"`, `bankLabel="Mandiri"`, tanpa
`supportsFundingComparison` — panel Funding Comparison hanya utk BNI),
fetch via `getMandiriPeriodicBalanceNeeds()` di `services/api.js`. Route
handler `balanceNeedsPeriodicHandler` di
`warroom-reconciliation-mandiri.js` HANYA mengunci
`bankCode: 'MANDIRI'` lalu memanggil
`periodicBalanceNeeds.buildBalanceNeedsResponse()` — tidak menduplikasi
rumus apa pun. Expected fee per tanggal diambil langsung dari
`recon_sync_batches.expected_fee` (diisi `mandiriAdapter.js` saat sync),
fallback default Rp100 (`DEFAULT_FEE_BY_BANK.MANDIRI`) hanya kalau batch
genuinely tidak punya nilai. Mekanisme lengkap (included days, dedup
transaksi, 24 bucket jam, KPI, export, testing) — lihat
`docs/RECONCILIATION_BNI.md` bagian "Kebutuhan Saldo", dijelaskan sekali
di sana krn identik di semua bank kecuali panel Funding Comparison (BNI
saja).

### Tab 1 — Executive Summary
KPI grid 12-card, susunannya SAMA dgn OCBC (disamakan menyusul permintaan
user): Total Transaksi FP, Total Nominal FP, Unique ID Transaksi Bank,
Matched Transaksi, Matched Nominal, Pending Bank, FP Only, Bank Only,
Nominal Mismatch, Match Rate Transaksi (Valid), Match Rate Nominal (Valid),
Actionable Exception. **"Actionable Exception" sekarang dihitung di
BACKEND** (`summary.actionable_exception_count`, lihat
`computeMandiriActionableException()` di
`warroom-reconciliation-mandiri.js`) — SAMA prinsip dgn OCBC, walau tanpa
konsep `is_actionable`/`coverage_status` OCBC (definisinya cukup
keanggotaan `EXCEPTION_STATUSES`, lihat bagian "Actionable Exception" di
atas).

Tiga mini-tabel sejajar (`StatusMiniTable`, pola sama dgn OCBC) — **FP
Only**, **Bank Only**, **Reversal** — masing-masing tabel ringkas ID Trx +
Nominal, tinggi seragam & scroll vertikal sendiri kalau data banyak.

Panel "Validasi Saldo Mandiri" (badge SELARAS/TIDAK SELARAS/TIDAK DAPAT
DIPASTIKAN, arah urutan statement, jumlah baris dicek/cocok/selisih) dan
panel "Distribusi Status" (klik baris → lompat ke tab Hasil
Rekonsiliasi/Exception Queue dgn filter status itu).

### Tab 2 & 3 — Hasil Rekonsiliasi / Exception Queue (`ReconTable`)
Komponen SAMA dipakai 2 tab lewat prop `scope="all"|"exception"`. Kolom:
ID Transaksi, Nominal FP, Principal Mandiri, Fee Mandiri, Total Debit,
Credit/Reversal, Selisih Principal, Selisih Fee (merah kalau ≠0), Waktu
FP, Post Date Mandiri, Selisih Waktu, Account No., Outlet, Produk,
Biller, Matching Method, Status — **TIDAK ADA kolom Cakupan** (beda dari
OCBC, lihat catatan di bagian "Matching & Status" di atas). Search (ID
Transaksi/Outlet/Produk), sort per-kolom, paginasi (25/50/100/500).
Filter status: "Semua Status" (11) vs "Semua Exception" (9, khusus
Exception Queue). Kolom aksi (HANYA Exception Queue): **Resolve**
(`ResolveModal`, pilih 1 dari 11 status + catatan) dan **Riwayat**
(`AuditLogModal`, riwayat audit 1 baris dari `GET .../:id/logs`).

### Tab 4 — Fee Analysis
7 KPI: Expected Fee/Transaksi (default Rp100), Transaksi dengan Fee,
Actual Fee Total, Expected Fee Total, Fee Variance (alert jika ≠0),
Transaksi Tanpa Fee (`MATCHED_NO_FEE`), Fee Tidak Sesuai
(`FEE_MISMATCH`). Tabel Distribusi Fee (sesuai expected/Rp0/lainnya).
**4** tabel breakdown (Fee per Produk, Fee per Outlet — Top 20, Fee per
Biller, **Fee per Account Number** — Mandiri punya 1 tabel breakdown
lebih banyak drpd OCBC krn ada dimensi `account_no`).

### Tab 5 — Time & Posting Analysis (Mandiri-only, tidak ada di OCBC)
4 KPI: Rata-rata/Median/P95/Maksimum selisih waktu (menit, antara
`time_response` FP dan `PostDate` Mandiri). Grid 4 bucket keterlambatan
(0-5 normal, 5-15 warning, 15-30 delayed, >30 exception) + tabel
"Transaksi Posting Terlambat" (Top 50, urut selisih waktu terbesar).
Murni indikator kecepatan posting bank, **bukan** pembanding nominal —
selisih waktu besar TIDAK membuat status jadi mismatch.

### Tab 6 — Raw Data & Audit (4 sub-tab, LEBIH detail drpd OCBC)
Berbeda dari OCBC (yang cuma 1 panel: Info Sync Batch + Riwayat Sync +
Export CSV, tanpa browsing baris mentah), Mandiri punya 4 sub-tab:
- **Raw DATA FP** — tabel baris mentah `recon_fp_transactions` (Row #, ID
  Transaksi, Nominal, Produk, Time Response, Outlet, Biller), paginasi
  100/halaman.
- **Raw DATA Mandiri** — tabel baris mentah `recon_bank_transactions`
  (Row #, Account No., Post Date, Remarks, Additional Desc, Debit,
  Credit, Close Balance, Extracted ID, Row Type, Extraction Method).
- **Sync History** — panel Info Sync Batch Ini (Batch No, Account No.,
  Scope Mode, Expected Fee, Grace Period, Jumlah Baris FP/Mandiri, Sync
  Terakhir, Spreadsheet ID) + tabel Riwayat Sync (14 batch terakhir).
- **Resolution History** — rekap SEMUA resolve manual pada tanggal ini
  (`GET .../resolution-history`), beda dari tombol "Riwayat" per-baris di
  Exception Queue.

Tombol **Export CSV** ada di panel atas (di luar sub-tab), berlaku utk
filter yang aktif di URL query saat itu.

### Tab 7 — Laporan Harian (`DailyReportMandiriTab`, WAJIB paling akhir)
Laporan siap-cetak/PDF untuk Direktur — sumber data
`GET .../mandiri/daily-report`, TIDAK PERNAH fallback tanggal (default hari
ini Asia/Jakarta, sama persis prinsip dgn Laporan Harian OCBC). Isi:
header laporan (tanggal, sync terakhir, waktu laporan dibuat), badge status
`BERJALAN (HARI INI)`/`SELESAI`, badge kesehatan GREEN/YELLOW/RED, panel
Ringkasan Otomatis Direktur, 8 KPI utama, panel Ringkasan Status, Posisi
Finansial, **Time & Posting Summary** (rata-rata/median/P95/maks + 4
bucket keterlambatan — TIDAK ada di Laporan Harian OCBC), **Validasi
Saldo Mandiri** (badge SELARAS/TIDAK SELARAS/TIDAK DAPAT DIPASTIKAN, arah
statement, baris dicek/cocok/selisih — TIDAK ada di Laporan Harian OCBC),
Top 10 Exception (kolom LEBIH lengkap drpd OCBC: ID Transaksi, Outlet,
Produk, Biller, **Account No.**, Status, Nominal FP, **Principal
Mandiri**, Selisih Principal, Selisih Fee, **Selisih Waktu**, Catatan),
Pemeriksaan Kualitas Data, Tindak Lanjut Utama. Tiga tombol: **Perbarui
Laporan**, **Salin Ringkasan** (format WhatsApp/email SESUAI spec, lihat
`buildCopyText()`), **Cetak / Simpan PDF** (`window.print()`, REUSE CSS
print global `@media print` di `index.css` — TIDAK ada CSS baru yang perlu
ditambahkan krn aturan sembunyikan sidebar/navbar/tab/tombol sudah berlaku
GLOBAL sejak dibangun utk OCBC).

**Health Status** (`computeMandiriHealthStatus()`, threshold terpusat di
`MANDIRI_HEALTH_THRESHOLDS`):

| Kondisi | Status |
|---|---|
| `valid_match_rate_transaction ≥ 99%` DAN tidak ada actionable exception DAN tidak ada data quality issue DAN balance BUKAN `UNBALANCED` DAN sync sukses | **GREEN** |
| `95% ≤ match rate < 99%` ATAU masih ada actionable exception (tapi tidak memenuhi kondisi RED) | **YELLOW** |
| `match rate < 95%` ATAU sync belum sukses ATAU ada data quality issue (cross-date/duplicate canonical/reversal+bank_only) ATAU `balance_validation.status === 'UNBALANCED'` | **RED** |

**Beda dari OCBC**: validasi saldo Mandiri (per-batch, arah ASC/DESC)
**ikut memengaruhi health status** — `UNBALANCED` = RED — sedangkan OCBC
tidak punya dimensi ini di aturan health status-nya. RED dicek lebih
dulu (menang atas YELLOW), lalu YELLOW, default GREEN.

### Header & Sync Now
Header menampilkan dropdown tanggal (dari `recent_batches`), tombol **Sync
Now** (mencatat permintaan lewat endpoint generik `request-sync`, BUKAN
sync instan — lihat `docs/RECONCILIATION_OCBC.md` bagian "Tombol Sync Now"
utk penjelasan lengkap, mekanismenya identik) dan **Refresh**. Endpoint
Mandiri **TIDAK di-cache** (`getReconciliationMandiriAnalytics`/
`Transactions`/`RawBank`/`RawFp`/`ResolutionHistory`/`exportCsv` di
`services/api.js` — selalu fresh).

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

## Testing
`node backend/scripts/test-reconciliation-mandiri.js` — **53 test**:
- Ekstraksi ID: RULE A (Transfer Fee prefix), RULE B (principal via
  slash), RULE C (Credit Amount menimpa jadi CREDIT_REVERSAL), RULE D
  (UNKNOWN), fallback ke AdditionalDesc, TEST 12 (kata "Transfer Fee" di
  ekor deskripsi principal tetap PRINCIPAL), TEST 13 (Remarks &
  AdditionalDesc sama persis → tetap 1 hasil, tidak dihitung 2x).
- TEST 1-5: MATCHED (principal+fee cocok, 5 kasus nominal berbeda).
- TEST 6: MATCHED_NO_FEE. TEST 7: FEE_MISMATCH (varianceFee dihitung
  benar). TEST 8: NOMINAL_MISMATCH. TEST 9: DUPLICATE_BANK (2 baris
  principal dgn id sama, TIDAK dijumlahkan). TEST 10: NEED_REVIEW (hanya
  ada baris fee, tanpa principal). TEST 11: REVERSAL (Credit Amount
  menimpa status lain).
- PENDING_BANK/FP_ONLY (grace period), DUPLICATE_FP (id dobel di DATA FP).
- BANK_ONLY: valid (`FULL_BUSINESS_DATE`), fee-only/credit-only BUKAN
  kandidat BANK_ONLY, `FP_COVERAGE_WINDOW` default mengabaikan mutasi jauh
  di luar rentang waktu FP.
- `validateMandiriBalance`: urutan ASC/DESC konsisten → BALANCED + arah
  terdeteksi benar, data tidak konsisten → UNBALANCED/UNDETERMINED (tidak
  error), kurang dari 2 baris → UNDETERMINED.
- `parseFlexibleDateTime`: format ISO-like & DD/MM/YYYY (jam 1/2 digit),
  anchor Asia/Jakarta eksplisit, kosong/null → null.
- `formatDateJakarta`: jam dini hari WIB TIDAK mundur ke hari sebelumnya
  (regresi insiden nyata — kolom DATE tersimpan salah tanggal krn geser
  timezone), jam sore/malam konsisten, null/invalid → null.
- `timeDelayBucket`: kategori selisih waktu (normal/warning/delayed/exception).
- **LAPORAN HARIAN (17 test baru)**: `dedupeMandiriResultsByCanonicalKey`
  (1 transaksi logis 2 baris berbagi key → dihitung 1x, baris pertama
  dipertahankan), `computeMandiriDataQualityWarning` (cross-date
  terdeteksi, duplicate canonical terdeteksi, kombinasi REVERSAL+BANK_ONLY
  terdeteksi, tidak ada masalah → `has_issue:false`/`message:null`),
  `computeMandiriActionableException` (hanya 9 `EXCEPTION_STATUSES`,
  MATCHED/MATCHED_NO_FEE tidak ikut, fallback `bank_total_debit` utk
  BANK_ONLY tanpa `fp_nominal`, nominal 0 kalau tidak ada exception),
  `computeMandiriHealthStatus` (GREEN, YELLOW via match rate 95-99%,
  YELLOW via masih ada exception, RED via match rate <95%, RED via
  `UNBALANCED`, RED via data quality issue, RED via sync belum sukses,
  RED menang atas YELLOW kalau keduanya terpenuhi, GREEN kalau match rate
  `null`/tidak ada FP), `MANDIRI_HEALTH_THRESHOLDS` (konfigurasi terpusat
  99%/95%).

Skenario DB/live (resync idempotensi, resolution manual existing, upsert
canonical key, regresi OCBC) diverifikasi end-to-end lewat server
sungguhan — dijalankan BARENG `test-reconciliation-ocbc.js` setiap kali
ada perubahan pada `warroom-reconciliation.js` (helper/tabel shared),
karena keduanya memakai infrastruktur yang sama.

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
- **Health status Laporan Harian Mandiri tiba-tiba RED padahal match rate
  100%**: WAJAR kalau `balance_validation.status === 'UNBALANCED'` — beda
  dari OCBC, validasi saldo Mandiri SENGAJA ikut memengaruhi health status
  (lihat bagian "Tab 7 — Laporan Harian" di atas). Cek panel "Validasi
  Saldo Mandiri" utk detail arah statement & baris yang selisih.
- **`actionable_exception_count` di analytics/daily-report Mandiri beda
  angka dari jumlah baris exception yang terlihat di dashboard**: cek
  apakah ada `data_quality_warning.has_issue = true` — kalau ada baris
  cross-date/duplicate canonical yang belum dibersihkan, angka
  `actionable_exception_count` dihitung dari data yang SUDAH bersih
  (dedupe + cross-date dikecualikan), sedangkan tampilan mentah di tab
  lain mungkin belum tentu memfilter hal yang sama — segera bersihkan data
  quality issue-nya (idealnya `has_issue` SELALU `false`).
