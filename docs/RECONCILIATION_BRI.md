# Rekonsiliasi FP vs Bank BRI — Rekonsiliasi > Rekonsiliasi BRI

## Tujuan
Mencocokkan transaksi FP terhadap mutasi rekening Bank BRI secara otomatis.
Berbeda dari OCBC/Mandiri: sheet BRI adalah **statement rekening umum**
(bukan sheet khusus FASTPAY) — mencampur SEMUA jenis mutasi (transfer
FASTPAY, transfer lain seperti "BKO...", biaya, dst), dan 1 transaksi
FASTPAY = **1 baris debit** (principal + fee TERGABUNG, bukan 2 baris
terpisah seperti Mandiri).

## Arsitektur — Reconciliation Core Engine + Adapter
Sama seperti Rekonsiliasi OCBC & Mandiri, fitur ini REUSE tabel generic
`recon_*` (`recon_sync_batches`, `recon_fp_transactions`,
`recon_bank_transactions`, `recon_results`, `recon_action_logs`) —
dibedakan lewat `bank_code = 'BRI'`. TIDAK ada tabel `bri_recon_results`
terpisah.

```
Reconciliation Core (tabel generic + pola sync/analytics/resolve/audit)
├── OCBC Adapter    — backend/src/routes/warroom-reconciliation.js
├── Mandiri Adapter — backend/src/reconciliation/mandiriAdapter.js
└── BRI Adapter     — backend/src/reconciliation/briAdapter.js
                       (dipakai oleh backend/src/routes/warroom-reconciliation-bri.js)
```

Helper dasar (`extractToken`, `nullIfEmpty`, `cleanNum`, `csvEscape`,
`isValidIdTransaksi`, `RECON_STATUSES`, `EXCEPTION_STATUSES`,
`normalizeCanonicalKey`, `safeDiv`, dst) diimpor langsung dari
`warroom-reconciliation.js` — tidak diduplikasi. `briAdapter.js` sendiri
SENGAJA tidak import lintas adapter (mis. parser tanggal Mandiri) — semua
fungsi waktu/fingerprint direplikasi mandiri di dalam file itu supaya
adapter BRI berdiri sendiri.

## Sumber Data
Spreadsheet ID **TIDAK di-hardcode** — Apps Script membaca Script Property
`BRI_SPREADSHEET_ID`, fallback ke `SpreadsheetApp.getActiveSpreadsheet()`.

Nama tab sheet (exact match, case & spasi harus sama persis —
`getSheetByName`):
- **`Data FP`** — header baris 1 (dibaca **by NAME**, fallback index A-F
  kalau nama tidak ditemukan), data baris 2+: `id_transaksi`, `nominal`,
  `id_produk`, `time_response`, `id_outlet`, `id_biller`. Seluruh baris
  DATA FP dengan `id_biller = '284'` adalah kandidat rekonsiliasi BRI
  (`id_produk` disimpan utk analitik, bukan filter utama).
- **`Data bank bri`** — header baris 1 (by NAME, fallback index A-R), data
  baris 2+: `ID`, `NOREK`, `TGL_TRAN`, `TGL_EFEKTIF`, `JAM_TRAN`, `SEQ`,
  `DESK_TRAN`, `SALDO_AWAL_MUTASI`, `MUTASI_DEBET`, `MUTASI_KREDIT`,
  `SALDO_AKHIR_MUTASI`, `GLSIGN`, `TRUSER`, `KODE_TRAN`,
  `KODE_TRAN_TELLER`, `TRREMK`, `TLBDS1`, `TLBDS2`. Ekstraksi ID
  (DESK_TRAN/TRREMK/TLBDS2), klasifikasi `bank_row_type`, & validasi saldo
  **TIDAK** dilakukan di Apps Script — dikirim apa adanya, seluruh logic
  bisnis ada di backend (`briAdapter.js`) supaya satu sumber kebenaran.

Header dibaca berdasarkan NAMA kolom (bukan index tetap) — urutan kolom di
sheet boleh berpindah asal nama header sesuai spek. Semua ID
(id_transaksi, NOREK, JAM_TRAN, SEQ, dst) diproses sebagai **STRING** di
Apps Script maupun backend — tidak pernah lewat `Number()`.

## Konfigurasi Default (per batch, bisa dikirim di `config` payload sync)
| Field | Default |
|---|---|
| `bank_code` | `BRI` |
| `account_no` (NOREK) | `36001001118309` |
| `expected_fee` | `Rp150` |
| `grace_period_minutes` | `30` |
| `scope_mode` | `FP_COVERAGE_WINDOW` |
| `coverage_tolerance_minutes` | `60` |
| `reversal_lookup_days` | `3` |

## Ekstraksi ID Transaksi (`briAdapter.js::extractBriTransactionIds`)
**3 sumber independen**, WAJIB saling konsisten:
1. **DESK_TRAN** — regex `/(\d{8,12})\b` (angka setelah slash).
2. **TRREMK** — pola sama, `/(\d{8,12})\b`.
3. **TLBDS2** — pola `WS_OB;(\d{8,12});`.

Prioritas method kalau sepakat: DESK_TRAN → TRREMK → TLBDS2. **Seluruh**
kandidat dari ketiga sumber SELALU diekstrak (bukan cuma yang pertama
ketemu) utk validasi konsistensi:
- `extractionConfidence = HIGH` — minimal 2 sumber sepakat ID yang sama.
- `extractionConfidence = MEDIUM` — hanya 1 sumber menemukan ID.
- `extractionConfidence = CONFLICT` — >1 ID **berbeda** ditemukan antar
  sumber → `id_conflict = true`, **TIDAK PERNAH** diam-diam memilih salah
  satu → baris jadi `bank_row_type = NEED_REVIEW`.
- `extractionConfidence = NONE` — tidak ada sumber yang menghasilkan ID
  sama sekali.

## Klasifikasi Baris (`classifyBriRow`) — `bank_row_type`
| Type | Kondisi |
|---|---|
| `UNKNOWN` | DESK_TRAN & TRREMK sama-sama kosong — data tak cukup dinilai |
| `OUT_OF_SCOPE` | Bukan pola FASTPAY (mis. `BKO178370886...`) — **TIDAK PERNAH** jadi BANK_ONLY/exception, tetap tersimpan mentah di Raw Data |
| `NEED_REVIEW` | Pola FASTPAY tapi ID conflict, ID tidak ditemukan, ATAU tidak ada debit/credit > 0 sama sekali |
| `CREDIT_REVERSAL` | Pola FASTPAY + ID valid + `MUTASI_KREDIT > 0` |
| `DEBIT_TRANSFER` | Pola FASTPAY + ID valid + `MUTASI_DEBET > 0` |

Urutan keputusan: (1) tidak ada teks Description sama sekali → `UNKNOWN`;
(2) bukan pola FASTPAY → `OUT_OF_SCOPE` — diperiksa **sebelum** cek ID
conflict, supaya mutasi yang jelas bukan FASTPAY tidak pernah "naik
derajat" jadi `NEED_REVIEW` hanya karena kebetulan ada digit mirip ID
transaksi; (3) pola FASTPAY + ID conflict/tidak ada ID → `NEED_REVIEW`;
(4) kredit>0 → `CREDIT_REVERSAL`; (5) debit>0 → `DEBIT_TRANSFER`; (6)
sisanya → `NEED_REVIEW` (data tidak lengkap).

## Coverage Window (`calculateBriCoverage`)
Default `FP_COVERAGE_WINDOW`: `coverage_start = min(FP time_response) −
toleransi`, `coverage_end = max(FP time_response) + toleransi` (default 60
menit). Perlu karena data sample menunjukkan DATA BRI sekitar 00:31–02:08
sedangkan DATA FP sekitar 03:12–12:11 — jendela waktu TIDAK overlap, jadi
mutasi BRI dini hari tidak boleh otomatis jadi BANK_ONLY.

`coverage_status` (`IN_FP_COVERAGE`/`OUTSIDE_FP_COVERAGE`) adalah dimensi
**terpisah** dari `recon_status` — mutasi `OUTSIDE_FP_COVERAGE` tidak
pernah masuk Exception Queue/match rate, tetap terlihat di Raw Data.
Mode `FULL_BUSINESS_DATE` (via `config.scope_mode`) menganggap SELURUH
mutasi batch dalam scope, tanpa batas jendela waktu FP.

## Matching & Cascade Status (`reconcileBriTransactions`)
Grouping berdasarkan `extracted_transaction_id` (`canonical_transaction_key`).
Satu grup bisa punya banyak baris debit dan/atau credit. `consumedBankKeys`
ditandai SEGERA saat grup dipasangkan ke FP (sebelum cascade status
ditentukan) — mencegah grup yang sama muncul lagi sbg BANK_ONLY (prinsip
sama dgn fix insiden REVERSAL+BANK_ONLY double count di OCBC).

11 status generic (sama dgn OCBC/Mandiri): `MATCHED`, `MATCHED_NO_FEE`,
`PENDING_BANK`, `FP_ONLY`, `BANK_ONLY`, `NOMINAL_MISMATCH`, `FEE_MISMATCH`,
`DUPLICATE_FP`, `DUPLICATE_BANK`, `REVERSAL`, `NEED_REVIEW`. Prioritas
cascade per grup FP:
1. `DUPLICATE_FP` — `id_transaksi` muncul >1 kali di DATA FP.
2. `NEED_REVIEW` — ada konflik ekstraksi ID pada mutasi BRI utk id ini.
3. Tidak ada grup bank sama sekali → `PENDING_BANK` (masih dalam grace
   period) / `FP_ONLY` (sudah lewat).
4. Grup ada tapi `debitCount = 0` (hanya credit) → `NEED_REVIEW`.
5. `debitCount > 1` → `DUPLICATE_BANK` (gross debit dijumlahkan HANYA utk
   ditampilkan, `bankPrincipal` tetap `null` — **TIDAK PERNAH**
   dijumlahkan jadi MATCHED).
6. `debitCount = 1` → bandingkan `grossDebit` vs `fpNominal`:
   `grossDebit < fpNominal` → `NOMINAL_MISMATCH`; `grossDebit == fpNominal`
   → `MATCHED_NO_FEE`; `actualFee == expectedFee` → `MATCHED`; selain itu
   → `FEE_MISMATCH`.
7. `creditCount > 0` MENIMPA status manapun di atas → `REVERSAL` (sinyal
   reversal lebih kuat, grup sudah ditandai consumed jadi tidak bisa lagi
   jadi `BANK_ONLY`).

**Principal HANYA dihitung setelah pasangan FP ditemukan**
(`bank_principal = fp_nominal`, `bank_fee = gross_debit − fp_nominal`) —
**TIDAK PERNAH** `gross_debit − 150` sebelum ada pasangan FP. Utk
`BANK_ONLY` (tanpa FP), `estimated_bank_principal = gross_debit −
expected_fee` selalu ditandai **ESTIMASI**, bukan principal pasti.

`BANK_ONLY` — per GROUP bank yang: belum consumed, punya id_transaksi yang
TIDAK ada di DATA FP, punya `debitCount >= 1` (bukan credit-only), DAN
berada dalam coverage window. Kalau `debitCount > 1` tanpa pasangan FP →
`NEED_REVIEW` (ambigu principal mana), bukan `BANK_ONLY`.

## Reversal Cross-Date Lookup (`applyBriReversalCrossDateLookup`)
Fungsi **terpisah** dari `reconcileBriTransactions()` (sengaja diisolasi —
butuh query bank row dari tanggal LAIN, business_date+1 s.d.
+`reversal_lookup_days`, default 3 hari). Kalau kredit ditemukan di
tanggal lain utk canonical key yang sama, hasil batch aslinya di-UPDATE
jadi `REVERSAL` (`reversal_lookup_source = CROSS_DATE_LOOKUP`) — TIDAK
membuat baris/BANK_ONLY duplikat pada tanggal reversal-nya. Status yang
eligible utk lookup ini: `FP_ONLY`, `BANK_ONLY`, `MATCHED`,
`MATCHED_NO_FEE`, `FEE_MISMATCH`, `NOMINAL_MISMATCH`, `PENDING_BANK` (yang
sudah `REVERSAL` dilewati). Diuji terpisah di `test-reconciliation-bri.js`.

Query caller (`syncHandler`) mengambil baris `CREDIT_REVERSAL` dari
`recon_bank_transactions` pada rekening yang sama, `business_date` di
rentang `(business_date, business_date + reversal_lookup_days]`, lalu
di-passing sbg `Map<canonicalKey, futureCreditRows[]>` ke fungsi pure ini —
`briAdapter.js` sendiri TIDAK pernah menyentuh DB.

## Validasi Saldo (`validateBriBalance`) — PER BARIS
Beda dari Mandiri (per urutan statement): `SALDO_AWAL_MUTASI −
MUTASI_DEBET + MUTASI_KREDIT` harus sama dgn `SALDO_AKHIR_MUTASI`
(toleransi ±Rp1). Status: `BALANCED`/`UNBALANCED`/`UNDETERMINED` — murni
informatif, **TIDAK PERNAH** mengubah `recon_status` transaksi manapun,
dan **TIDAK** memengaruhi tampilan apa pun di luar panel "Validasi Saldo
BRI" (beda dari Rekonsiliasi Mandiri, di mana `UNBALANCED` ikut memicu
health status RED — BRI belum punya konsep Laporan Harian/health status,
lihat bagian "Perbedaan dari OCBC/Mandiri" di bawah).

## Waktu — JAM_TRAN, TGL_TRAN, TGL_EFEKTIF
`business_date` = tanggal `TGL_EFEKTIF` (Asia/Jakarta). `posting_time` =
`TGL_TRAN` + presisi detik dari `JAM_TRAN` kalau valid: normalisasi
`String(JAM_TRAN).padStart(6,'0')`, HH=char 1-2, MM=char 3-4, SS=char 5-6
(mis. `3153` → `"003153"` → `00:31:53`); kalau JAM_TRAN tidak valid
(mis. jam>23/menit>59/detik>59), fallback ke jam bawaan TGL_TRAN. Semua
di-anchor eksplisit ke **Asia/Jakarta (+07:00)** — TIDAK PERNAH
`toISOString().slice(0,10)`. Parser tanggal fleksibel (`parseFlexibleBriDateTime`)
menerima format ISO-like (`YYYY-MM-DD[ T]HH:MM[:SS]`) maupun `DD/MM/YYYY`,
direplikasi mandiri di `briAdapter.js` (tidak share kode dgn parser
Mandiri, walau polanya identik).

## Database
Migration: `backend/src/migrations/add_reconciliation_bri_columns.sql`
(perluasan tabel `recon_*` yang sudah ada, semua kolom baru nullable —
tidak mengubah perilaku baris OCBC/Mandiri yang sudah ada, idempotent).
Runner: `backend/scripts/run-reconciliation-bri-migration.js`

Kolom baru penting:
- `recon_sync_batches`: `coverage_tolerance_minutes`, `reversal_lookup_days`.
- `recon_bank_transactions`: `business_date`, `effective_date_time`,
  `sequence_no`, `remarks`, `tlbds1`, `tlbds2`, `opening_balance`,
  `gl_sign`, `tr_user`, `kode_tran`, `kode_tran_teller`,
  `extraction_confidence`, `id_conflict`, `coverage_status`,
  `balance_check_status`, `balance_variance`, `row_fingerprint` (UNIQUE
  parsial, idempotensi sync).
- `recon_results`: `extracted_transaction_id`, `estimated_bank_principal`,
  `reversal_date`, `reversal_amount`, `reversal_lookup_source`,
  `id_conflict`.

`row_fingerprint` = SHA-256 dari `bank_code|NOREK|TGL_TRAN|TGL_EFEKTIF|SEQ|
DESK_TRAN(dinormalisasi)|MUTASI_DEBET|MUTASI_KREDIT|SALDO_AKHIR_MUTASI` —
**TIDAK PERNAH** memakai nomor baris sumber (posisi bisa berubah).
DESK_TRAN dinormalisasi (uppercase, buang non-alfanumerik selain `/`)
SEBELUM di-hash — pelajaran dari insiden nyata Rekonsiliasi OCBC (teks
Description mutasi identik bisa berbeda tanda baca antar pembacaan sheet).
`recon_results` upsert lewat `UNIQUE(batch_id, canonical_transaction_key)`
(sama pola dgn OCBC/Mandiri) — resync tidak menggandakan baris/menghapus
riwayat resolve & audit log. `canonical_transaction_key` = `extracted_transaction_id`
kalau ada, else `id_transaksi` (utk `FP_ONLY`/`PENDING_BANK` murni tanpa
bank sama sekali).

## Backend Endpoints (`backend/src/routes/warroom-reconciliation-bri.js`)
| Endpoint | Auth | Keterangan |
|---|---|---|
| `POST /api/warroom/reconciliation/bri/sync` | `APPS_SCRIPT_TOKEN` (token SHARED) | Chunk FP/BRI (1500 baris/chunk), jalankan adapter+engine+cross-date lookup di chunk terakhir. `bank_rows_skipped_duplicate_fingerprint` dilaporkan di response kalau ada baris yang di-skip karena `row_fingerprint` sudah ada |
| `GET /api/warroom/reconciliation/sync-request-status?bank_code=BRI` | `APPS_SCRIPT_TOKEN` | Endpoint GENERIK (bukan di bawah `/bri`, dipakai bareng OCBC/Mandiri) — dipanggil Apps Script BRI tiap 1 menit, cek tombol "Sync Now" |
| `POST /api/warroom/reconciliation/request-sync` | JWT | Endpoint GENERIK — tombol "Sync Now", body `{bank_code: 'BRI'}` |
| `GET /api/warroom/reconciliation/bri/analytics?date=` | JWT | Kalau `date` TIDAK dikirim, fallback ke batch tanggal PALING BARU (`ORDER BY business_date DESC LIMIT 1`) — kalau `date` DIKIRIM, query exact match, TIDAK fallback. Response: `meta`, `active_batch`, `summary` (+ `actionable_exception_count`/`actionable_exception_nominal`), `status_distribution`, `coverage`, `fee_analysis`, `time_analysis`, `balance_validation`, `extraction_summary`, `cross_date_reversal_count`, `data_quality_warning`, `recent_batches` (14 batch terakhir) |
| `GET /api/warroom/reconciliation/bri/balance-needs-periodic?start_date=&end_date=` | JWT | **Kebutuhan Saldo** (tab 7) — SHARED service, lihat bagian tersendiri di bawah |
| `GET /api/warroom/reconciliation/bri/daily-report?date=` | JWT | **Laporan Harian** (tab 8) — lihat bagian tersendiri di bawah |
| `GET /api/warroom/reconciliation/bri/transactions?date=&status=&coverage_status=&id_outlet=&id_produk=&id_biller=&search=&page=&limit=&sort=&order=` | JWT | List berpaginasi, `status` boleh comma-separated, `coverage_status` (`IN_FP_COVERAGE`/`OUTSIDE_FP_COVERAGE`) bisa difilter — TIDAK ada di Mandiri |
| `GET /api/warroom/reconciliation/bri/raw-bank?date=` | JWT | Raw mutasi BRI + hasil ekstraksi/klasifikasi/balance check (18 kolom + JSON `raw_data`) |
| `GET /api/warroom/reconciliation/bri/raw-fp?date=` | JWT | Raw baris DATA FP |
| `GET /api/warroom/reconciliation/bri/export?...` | JWT | CSV (fetch sbg blob, max 20.000 baris) |
| `POST /api/warroom/reconciliation/bri/:id/resolve` | JWT | Body `{status, notes}`, `matching_method` di-set `MANUAL_RESOLUTION`, tercatat di `recon_action_logs` |
| `GET /api/warroom/reconciliation/bri/:id/logs` | JWT | Riwayat audit 1 baris hasil |
| `GET /api/warroom/reconciliation/bri/resolution-history?date=` | JWT | Rekap semua resolve manual pada batch tanggal ini |

`daily-report` didaftarkan SEBELUM route dinamis `bri/:id/resolve` dan
`bri/:id/logs` di `app.js` — wajib, supaya Express tidak salah mencocokkan
`daily-report` sebagai nilai parameter `:id`.

### `active_batch` & `data_quality_warning` (analytics & daily-report)
Sama konsep dgn OCBC/Mandiri: `active_batch`
(`batch_id`/`bank_code`/`business_date`/`account_no`/`synced_at`/`sync_status`)
adalah sumber kebenaran batch yang sedang ditampilkan — query
`WHERE business_date = $1 AND bank_code = $2` memakai cast `::text` pada
kolom DATE (wajib, kalau lupa akan selalu gagal integrity guard karena
`pg` mengembalikan objek `Date`, bukan string — insiden nyata yang sudah
pernah terjadi & diperbaiki di Rekonsiliasi Mandiri, direplikasi fix-nya
di sini dari awal). Kalau `business_date` batch tidak sama dgn `date`
yang diminta, handler melempar error keras (integrity guard) alih-alih
diam-diam mencampur data.

`data_quality_warning` di BRI **berbeda struktur** dari OCBC/Mandiri
(spec eksplisit meminta field khusus BRI):
```
data_quality_warning: {
  invalid_business_date_count,       // bank_transaction_date hasil != business_date batch, DAN bukan CROSS_DATE_LOOKUP
  duplicate_canonical_result_count,  // canonical_transaction_key muncul >1x (dijaga jg oleh UNIQUE index)
  consumed_also_bank_only_count,     // key yg sudah dipasangkan ke FP tapi JUGA muncul sbg BANK_ONLY
  id_conflict_count,                 // mutasi dgn kandidat ID berbeda antar DESK_TRAN/TRREMK/TLBDS2
  unbalanced_bank_row_count,         // raw bank row dgn balance_check_status = UNBALANCED
  has_issue,                         // true HANYA dari 3 field pertama (lihat di bawah)
  message,
}
```
`has_issue` **TIDAK** ikut menghitung `id_conflict_count`/
`unbalanced_bank_row_count` — keduanya tetap ditampilkan jelas di
response & di panel Laporan Harian, tapi dampaknya ke *health status*
mengikuti threshold MATERIAL terpisah (lihat "Health Status BRI"),
bukan jadi `has_issue` biner. Fungsi murni
`computeBriResultQualityChecks(results, businessDate)` ada di
`warroom-reconciliation-bri.js` (BUKAN `briAdapter.js` — logic
ekstraksi/klasifikasi/matching BRI TIDAK disentuh oleh paket parity ini).

**`cross_date_reversal_count` BUKAN bagian dari `data_quality_warning`** —
field ini top-level, terpisah, murni informasi operasional (jumlah hasil
dgn `reversal_lookup_source = CROSS_DATE_LOOKUP`). Reversal cross-date
adalah fitur bisnis BRI yang VALID (lihat "Reversal Cross-Date Lookup" di
atas) — **TIDAK PERNAH** dihitung sbg masalah data quality, berbeda dari
`invalid_business_date_count` yang justru secara eksplisit MENGECUALIKAN
baris `CROSS_DATE_LOOKUP` dari hitungannya (supaya reversal valid tidak
salah dianggap data stale).

### Actionable Exception (backend, bukan lagi frontend)
`summary.actionable_exception_count`/`actionable_exception_nominal`
(analytics) dan `actionable_exception_count`/`actionable_exception_nominal`
(daily-report) sekarang dihitung di `computeBriActionableException()` di
`warroom-reconciliation-bri.js` — BUKAN lagi di `SummaryTab` frontend
seperti sebelumnya. Definisi: 9 `EXCEPTION_STATUSES`, DIKECUALIKAN kalau
`coverage_status = OUTSIDE_FP_COVERAGE` (pertahanan eksplisit — walau
`briAdapter.js` sendiri sudah menjamin baris `OUTSIDE_FP_COVERAGE` TIDAK
PERNAH masuk `recon_results` sama sekali, lihat "Coverage Window" di
atas). Nominal = `fp_nominal`, fallback `bank_total_debit` (gross debit)
utk `BANK_ONLY` yang tidak punya `fp_nominal`. Dihitung dari hasil yang
SUDAH bersih dari cross-date invalid & sudah di-dedupe by canonical key
(`dedupeBriResultsByCanonicalKey()`) — "satu canonical_transaction_key
hanya dihitung sekali" (spec).

### Extraction Summary (baru, khas BRI — tidak ada padanan di OCBC/Mandiri)
Dihitung dari `GROUP BY extraction_confidence, extraction_method,
bank_row_type, id_conflict` atas SELURUH baris mentah
`recon_bank_transactions` batch ini (bukan hanya yg punya `recon_results` —
banyak baris `OUT_OF_SCOPE`/`UNKNOWN` tidak pernah punya hasil
rekonsiliasi sama sekali):
```
extraction_summary: {
  high_confidence_count, medium_confidence_count, conflict_count, none_confidence_count,
  id_conflict_count,
  id_from_desk_tran_count, id_from_trremk_count, id_from_tlbds2_count,
  need_review_conflict_count, out_of_scope_count,
}
```

## Frontend
- Route: `/war-room/rekonsiliasi/bri`
- Page: `frontend/src/pages/WarRoomReconciliationBri.jsx`
- Komponen Laporan Harian: `frontend/src/components/reconciliation/DailyReportBriTab.jsx`
  (file TERPISAH dari page utama, seperti Mandiri — BRI punya 2 panel
  tambahan yang tidak ada di Mandiri maupun OCBC: **Coverage Window BRI**
  dan **Extraction & ID Quality**)
- Menu: Rekonsiliasi > **Rekonsiliasi BRI** (badge `BRI`, navy `#00529C`)
- CSS: reuse `wrr-*`/`wrrm-*` (layout generik dari OCBC/Mandiri: tabs,
  panel, kpi grid, table, modal, pagination, mini-panel-row,
  **daily-report** termasuk `wrr-daily-report-*` yang dibangun utk OCBC,
  TIDAK diduplikasi) + `wrrbri-*` (elemen BARU khusus BRI):
  - `.wrrbri-subtab-btn--active` — sub-tab aktif di Raw Data & Audit
  - `.wrrbri-badge` + varian `--in_fp_coverage`/`--outside_fp_coverage`
    (Coverage), `--high`/`--medium`/`--conflict`/`--none` (Extraction
    Confidence)
- **8 tab (urutan tetap, Laporan Harian WAJIB paling akhir)**: Executive
  Summary, Hasil Rekonsiliasi, Exception Queue, Fee Analysis, Time &
  Posting Analysis, Raw Data & Audit (4 sub-tab: Raw DATA FP, Raw DATA
  BRI, Sync History, Resolution History), **Kebutuhan Saldo**, **Laporan
  Harian**.

## Kebutuhan Saldo (Tab 7) — SHARED service, bukan implementasi terpisah
Dipasang via komponen shared
`frontend/src/components/reconciliation/PeriodicBalanceNeeds.jsx`
(`bankCode="BRI"`, `bankLabel="BRI"`, tanpa `supportsFundingComparison`),
fetch via `getBriPeriodicBalanceNeeds()` di `services/api.js`. Route
handler `balanceNeedsPeriodicHandler` di `warroom-reconciliation-bri.js`
HANYA mengunci `bankCode: 'BRI'` lalu memanggil
`periodicBalanceNeeds.buildBalanceNeedsResponse()`. Expected fee per
tanggal diambil dari `recon_sync_batches.expected_fee` (kolom batch, BUKAN
raw debit mentah), fallback default Rp150 (`DEFAULT_FEE_BY_BANK.BRI`)
hanya kalau batch genuinely tidak punya nilai. Mekanisme lengkap (included
days, dedup transaksi, 24 bucket jam, KPI, export, testing) — lihat
`docs/RECONCILIATION_BNI.md` bagian "Kebutuhan Saldo".

### Tab 1 — Executive Summary
Panel "Coverage Window" (scope mode, coverage start/end, jumlah bank
dalam/luar coverage, jumlah mutasi `OUT_OF_SCOPE`). KPI grid 12 kartu:
Total FP, Total Nominal FP, ID Transaksi Bank Unik, Matched Transaksi,
Matched Nominal, Pending Bank, FP Only, Bank Only, Nominal Mismatch, Match
Rate Transaksi (Valid), Match Rate Nominal (Valid), **Actionable
Exception**. **"Actionable Exception" sekarang dihitung di BACKEND**
(`summary.actionable_exception_count`, lihat "Actionable Exception" di
atas) — BUKAN lagi dihitung ulang di frontend seperti sebelumnya.

Tiga mini-tabel sejajar (`StatusMiniTable`, pola sama dgn OCBC/Mandiri) —
**FP Only**, **Bank Only**, **Reversal** — masing-masing tabel ringkas ID
Trx + Nominal (fallback ke `bank_gross_debit` kalau `fp_nominal` null,
mis. utk baris `BANK_ONLY` murni).

Panel "Validasi Saldo BRI" (badge SELARAS/TIDAK SELARAS/TIDAK DAPAT
DIPASTIKAN, jumlah baris balanced/unbalanced/undetermined, total variance)
dan panel "Distribusi Status" (klik baris → lompat ke tab Hasil
Rekonsiliasi kalau MATCHED/MATCHED_NO_FEE, atau Exception Queue utk status
lain, dengan filter status ikut diterapkan).

### Tab 2 & 3 — Hasil Rekonsiliasi / Exception Queue (`ReconTable`)
Komponen SAMA dipakai 2 tab lewat prop `scope="all"|"exception"`. Kolom
(LEBIH banyak drpd Mandiri karena BRI punya dimensi tambahan): ID
Transaksi, Produk, Outlet, Biller, Nominal FP, Gross Debit, Principal,
**Est. Principal** (ditandai "(est.)"), Fee, Credit, Selisih Principal,
Selisih Fee (merah kalau ≠0), Waktu FP, Waktu BRI, Selisih Waktu, Norek,
**Extraction** (matching_method + `⚠` kalau `id_conflict`), **Coverage**
(`CoverageBadge`), Status. Search (ID Transaksi/Outlet/Produk), sort
per-kolom, paginasi (25/50/100/500). Filter status: "Semua Status" (11)
vs "Semua Exception" (9, khusus Exception Queue). Kolom aksi (HANYA
Exception Queue): **Resolve** (`ResolveModal`) dan **Riwayat**
(`AuditLogModal`, `GET .../:id/logs`).

### Tab 4 — Fee Analysis
7 KPI: Expected Fee/Transaksi (default Rp150), Transaksi dengan Fee,
Actual Fee Total, Expected Fee Total, Fee Variance (alert jika ≠0), Matched
Tanpa Fee (`MATCHED_NO_FEE`), Fee Tidak Sesuai (`FEE_MISMATCH`). Tabel
Distribusi Fee (sesuai expected/Rp0/lainnya). 3 tabel breakdown: Fee per
Produk, Fee per Outlet (Top 20), Fee per Biller — BRI **tidak** punya
tabel "Fee per Account Number" terpisah seperti Mandiri (rekonsiliasi BRI
memakai 1 rekening tunggal per batch).

### Tab 5 — Time & Posting Analysis
4 KPI: Rata-rata/Median/P95/Maksimum selisih waktu (menit, antara
`time_response` FP dan waktu posting mutasi BRI). Grid 4 bucket
keterlambatan (0-5 normal, 5-15 warning, 15-30 delayed, >30 exception) +
tabel "Transaksi Posting Terlambat" (Top 50, urut selisih waktu
terbesar). Murni indikator kecepatan posting bank, **bukan** pembanding
nominal — selisih waktu besar TIDAK membuat status jadi mismatch.

### Tab 6 — Raw Data & Audit (4 sub-tab)
- **Raw DATA FP** — tabel baris mentah `recon_fp_transactions` (Row #, ID
  Transaksi, Nominal, Produk, Time Response, Outlet, Biller), paginasi
  100/halaman.
- **Raw DATA BRI** — tabel baris mentah `recon_bank_transactions`, PALING
  detail di antara 3 bank (21 kolom): Row #, Norek, Waktu Transaksi, Waktu
  Efektif, SEQ, DESK_TRAN, TRREMK, TLBDS1, TLBDS2, Saldo Awal, Debit,
  Credit, Saldo Akhir, Extracted ID, **ID dari DESK_TRAN/TRREMK/TLBDS2**
  (3 kolom terpisah dari `raw_data` — memperlihatkan HASIL EKSTRAKSI per
  sumber, bukan cuma extracted_transaction_id final), Confidence
  (`ConfidenceBadge`), Conflict (⚠ Ya/Tidak), Row Type, Coverage
  (`CoverageBadge`), Balance Check.
- **Sync History** — panel Info Sync Batch Ini (Batch No, Norek, Scope
  Mode, Expected Fee, Grace Period, **Coverage Tolerance**, **Reversal
  Lookup Days**, Jumlah Baris FP/BRI, Sync Terakhir) + tabel Riwayat Sync
  (14 batch terakhir).
- **Resolution History** — rekap SEMUA resolve manual pada tanggal ini
  (`GET .../resolution-history`), beda dari tombol "Riwayat" per-baris di
  Exception Queue.

Tombol **Export CSV** ada di panel atas (di luar sub-tab), berlaku utk
filter yang aktif di URL query saat itu.

### Tab 7 — Laporan Harian (`DailyReportBriTab`, WAJIB paling akhir)
Laporan siap-cetak/PDF untuk Direktur — sumber data
`GET .../bri/daily-report`, TIDAK PERNAH fallback tanggal (default hari
ini Asia/Jakarta, sama persis prinsip dgn Laporan Harian OCBC/Mandiri).
Isi: header laporan (tanggal, sync terakhir, waktu laporan dibuat), badge
status `BERJALAN (HARI INI)`/`SELESAI`, badge kesehatan GREEN/YELLOW/RED,
panel Ringkasan Otomatis Direktur, 8 KPI utama, panel Ringkasan Status,
Posisi Finansial (11 field, termasuk **Bank Only — Gross Debit**/**Est.
Principal (ESTIMASI)**/**Nominal Mismatch Absolut** — tidak ada di
Mandiri/OCBC), **Coverage Window BRI** (scope mode, coverage
start/end/tolerance, bank dalam/luar coverage, out of scope, FASTPAY
dalam scope — TIDAK ada di Laporan Harian OCBC/Mandiri), **Extraction &
ID Quality** (confidence HIGH/MEDIUM/CONFLICT/NONE, ID conflict, ID per
sumber DESK_TRAN/TRREMK/TLBDS2, NEED_REVIEW akibat conflict, out of scope
— TIDAK ada di OCBC/Mandiri), Time & Posting Summary (rata-rata/median/
P95/maks + 4 bucket keterlambatan), Validasi Saldo BRI (badge SELARAS/
TIDAK SELARAS/TIDAK DAPAT DIPASTIKAN, baris diperiksa/balanced/
unbalanced/undetermined + persentase balanced, total variance), Top 10
Exception (20 kolom — PALING lengkap di antara 3 bank: ID Transaksi,
Outlet, Produk, Biller, Norek, Status, Nominal FP, Gross Debit, Principal,
Est. Principal, Fee, Selisih Principal, Selisih Fee, Selisih Waktu,
Extraction Method, Extraction Confidence, ID Conflict, Coverage, Reversal
Source, Catatan), Pemeriksaan Kualitas Data (+ mini-panel ID Conflict/
Saldo Unbalanced/Cross-Date Reversal — 3 angka yg TETAP ditampilkan
walau tidak semuanya memicu `has_issue`), Tindak Lanjut Utama. Tiga
tombol: **Perbarui Laporan**, **Salin Ringkasan** (format WhatsApp/email
SESUAI spec BRI — beda template dari OCBC/Mandiri, punya baris
Cross-Date Reversal/ID Conflict/Mutasi Di Luar Coverage/Mutasi Out of
Scope tambahan, lihat `buildCopyText()`; ada FALLBACK manual
`document.execCommand('copy')` kalau `navigator.clipboard` gagal/tidak
tersedia), **Cetak / Simpan PDF** (`window.print()`, REUSE CSS print
global `@media print` — TIDAK ada CSS baru yang perlu ditambahkan).

**Health Status BRI** (`computeBriHealthStatus()`, threshold terpusat di
`BRI_HEALTH_THRESHOLDS`, RED dicek lebih dulu — menang atas YELLOW — lalu
YELLOW, default GREEN):

| Kondisi | Status |
|---|---|
| Match rate ≥99% DAN actionable exception=0 DAN sync sukses DAN invalid_business_date=0 DAN duplicate_canonical=0 DAN consumed_also_bank_only=0 DAN id_conflict=0 DAN unbalanced=0 DAN tidak ada extraction MEDIUM DAN tidak ada posting delay DAN outside-coverage ratio ≤5% | **GREEN** |
| Match rate 95–99% ATAU masih ada actionable exception ATAU ada posting delay (bucket >30 menit) ATAU ada extraction confidence MEDIUM ATAU id_conflict 1–4 (di bawah material) ATAU unbalanced 1–4 (di bawah material) ATAU outside-coverage ratio >5% (material) — tapi tidak memenuhi kondisi RED | **YELLOW** |
| Match rate <95% ATAU sync gagal ATAU `invalid_business_date_count`>0 ATAU `duplicate_canonical_result_count`>0 ATAU `consumed_also_bank_only_count`>0 ATAU `id_conflict_count` ≥5 (MATERIAL) ATAU `unbalanced_bank_row_count` ≥5 (MATERIAL) | **RED** |

**Threshold terpusat** (`BRI_HEALTH_THRESHOLDS` di
`warroom-reconciliation-bri.js`): `GREEN_MIN_MATCH_RATE=0.99`,
`YELLOW_MIN_MATCH_RATE=0.95`, `ID_CONFLICT_MATERIAL_COUNT=5`,
`UNBALANCED_MATERIAL_COUNT=5`, `OUTSIDE_COVERAGE_MATERIAL_RATIO=0.05`
(5%). Angka MATERIAL sengaja dipilih supaya sejumlah KECIL kejadian
(1-4 ID conflict/unbalanced) menurunkan status dari GREEN ke YELLOW —
bukan langsung RED — hanya jumlah BESAR (berpotensi masalah sistemik,
bukan kasus tepi biasa mengingat statement BRI mencampur banyak jenis
mutasi) yang menaikkan ke RED. **Cross-date reversal VALID
(`cross_date_reversal_count`) TIDAK PERNAH jadi input fungsi ini sama
sekali** — bukan cuma "tidak memicu RED", field itu memang tidak
pernah dibaca oleh `computeBriHealthStatus()` (spec: "Cross-date
reversal valid tidak otomatis membuat status RED").

### Header & Sync Now
Header menampilkan dropdown tanggal (dari `recent_batches`), tombol **Sync
Now** (mencatat permintaan lewat endpoint generik `request-sync` — BUKAN
sync instan, lihat `docs/RECONCILIATION_OCBC.md` bagian "Tombol Sync Now"
utk penjelasan lengkap, mekanismenya identik) dan **Refresh**. Endpoint
BRI **TIDAK di-cache** (semua fungsi `getReconciliationBri*` di
`services/api.js` selalu fresh, termasuk `getReconciliationBriDailyReport`).

## Perbedaan dari OCBC/Mandiri (yang MEMANG tidak/belum disamakan)
Setelah paket parity ini, Rekonsiliasi BRI punya `active_batch`,
`data_quality_warning`, Actionable Exception backend, dan tab Laporan
Harian — SEJAJAR secara operasional dgn OCBC/Mandiri. Sisa perbedaan yang
TERSISA SENGAJA (bukan gap yang perlu ditutup):
1. **`data_quality_warning` BRI punya field BEDA** dari OCBC/Mandiri
   (`invalid_business_date_count`/`id_conflict_count`/
   `unbalanced_bank_row_count` — bukan `cross_date_result_count`/
   `reversal_also_bank_only_count`) — struktur ini KHUSUS BRI krn BRI
   punya dimensi ID conflict & balance-per-baris yang tidak dimiliki bank
   lain.
2. **Health status BRI punya threshold MATERIAL** (ID conflict/unbalanced/
   outside-coverage) yang tidak ada di OCBC/Mandiri — konsekuensi
   langsung dari statement BRI yang mencampur banyak jenis mutasi
   (jumlah KECIL ID conflict adalah hal biasa, bukan otomatis RED).
3. **Validasi saldo BRI PER BARIS** (bukan per-batch seperti Mandiri) —
   `unbalanced_bank_row_count` MEMENGARUHI health status (via threshold
   material), TAPI tidak pernah mengubah `recon_status` transaksi
   manapun — sama prinsip informatif dgn Mandiri, beda hanya di
   granularitas & threshold-nya.
4. **2 panel Laporan Harian tambahan** (Coverage Window BRI, Extraction &
   ID Quality) yang tidak relevan utk OCBC/Mandiri.

Bagian yang MEMANG unik milik BRI dan TIDAK PERNAH disamakan ke
Mandiri/OCBC (logic core, bukan reporting): ekstraksi 3-sumber
(DESK_TRAN/TRREMK/TLBDS2) + `extractionConfidence`/`id_conflict`,
klasifikasi `OUT_OF_SCOPE` (statement rekening umum, bukan sheet khusus
FASTPAY), `coverage_status` per baris (`IN_FP_COVERAGE`/
`OUTSIDE_FP_COVERAGE`), Reversal Cross-Date Lookup, validasi saldo PER
BARIS, `account_no` default `36001001118309`, `expected_fee` Rp150 —
SEMUA logic ini ada di `briAdapter.js` yang **TIDAK DISENTUH SAMA SEKALI**
oleh paket parity ini.

## Apps Script (`apps-script-reconciliation-bri.js`)
Fungsi: `testReconciliationBri()` (dry-run, HANYA logging — tidak mengirim
apa pun), `pushReconciliationBri()` (kirim, chunk 1500 baris),
`setupReconciliationBriTrigger()`, `removeReconciliationBriTrigger()`,
`checkReconciliationBriChanges()` (dipanggil time-based trigger tiap 1
menit), `getReconciliationBriStatus()` (lihat ringkasan sync terakhir
tanpa buka Execution Log).

Spreadsheet ID dibaca dari Script Property `BRI_SPREADSHEET_ID` (fallback
`getActiveSpreadsheet()`) — **tidak** di-hardcode di kode, beda dari
OCBC/Mandiri yang hardcode ID sheet-nya. Header sheet dibaca **by NAME**
(fallback index A-F/A-R) — kolom boleh berpindah posisi asal nama header
sesuai spek. Sheet **tidak pernah dimutasi** (hanya `getValues()`).

`reconBriCleanNum_()` WAJIB cek `typeof value === 'number'` DULU sebelum
string processing (insiden Speedcash: titik desimal number asli ikut
terhapus kalau diproses sbg string sebelum cek tipe) — direplikasi persis
di sini. `time_response` DATA FP dikirim LENGKAP dgn jam
(`reconBriToDateTimeIso_`, format `yyyy-MM-dd'T'HH:mm:ss` Asia/Jakarta) —
BUKAN cuma tanggal (`reconBriToIso_`, dipakai KHUSUS utk TGL_TRAN/
TGL_EFEKTIF yang memang cuma kolom tanggal, presisi jam datang terpisah
dari JAM_TRAN dan digabung di backend).

### Tombol "Sync Now" — kompromi, BUKAN sync instan
Sama seperti OCBC/Mandiri (lihat `docs/RECONCILIATION_OCBC.md`). Tombol di
dashboard HANYA mencatat permintaan lewat `POST .../reconciliation/request-sync`
(endpoint generik); trigger checker BRI yang jalan tiap 1 menit ikut
mengecek lewat `reconBriCheckForceSyncRequested_()` dan sync SEKARANG kalau
ada. Realistis ~1-2 menit dari klik sampai data ter-update.

### Auto-sync REAKTIF (2 lapis, bukan interval tetap)
1. **`reconBriOnChangeTrigger_`** — installable trigger `onChange`, HANYA
   menandai `RECON_BRI_DIRTY_SINCE` di Script Properties (sangat ringan,
   bukan sync langsung — mencegah edit/paste beruntun memicu banyak sync
   tumpang tindih).
2. **`checkReconciliationBriChanges`** — time-based trigger tiap 1 menit.
   Jalankan `pushReconciliationBri()` kalau: (dirty flag + lewat 30 detik
   debounce) ATAU ada permintaan "Sync Now" — DAN tidak ada sync lain yang
   sedang berjalan (lock `RECON_BRI_SYNC_IN_PROGRESS`, dihapus di blok
   `finally` supaya tidak pernah macet permanen kalau sync gagal).

Hasil: data ter-update otomatis ~30-90 detik setelah perubahan terakhir
di Sheet. Pasang sekali lewat `setupReconciliationBriTrigger()` (memasang
KEDUA trigger sekaligus), lepas dengan `removeReconciliationBriTrigger()`.

### Setup
1. Buka spreadsheet DATA FP + DATA BRI → Extensions > Apps Script.
2. Tempel isi `apps-script-reconciliation-bri.js` sebagai file baru.
3. Project Settings > Script Properties:
   - `BRIC_SYNC_TOKEN` = sama dengan `APPS_SCRIPT_TOKEN` di server (**jangan** ditulis di source code)
   - `BRIC_API_BASE_URL` = `https://bmsretail.my.id` (opsional, ini defaultnya)
   - `BRI_SPREADSHEET_ID` = ID spreadsheet (opsional kalau script sudah di-bind langsung ke Sheet-nya)
4. Jalankan `testReconciliationBri()` dulu — cek Execution Log (tidak
   mengirim apa pun, hanya melapor jumlah baris & sample data terbaca).
5. Jalankan `pushReconciliationBri()` utk sync manual pertama kali.
6. Jalankan `setupReconciliationBriTrigger()` utk sync otomatis reaktif.

## Testing
`node backend/scripts/test-reconciliation-bri.js` — **51 test**:

**24 test asli** — seluruh fungsi pure di `briAdapter.js` (TIDAK disentuh
oleh paket parity ini, TIDAK menyentuh DB):
- **TEST 1-4** — MATCHED (principal+fee cocok), MATCHED_NO_FEE (gross
  debit = nominal FP persis), FEE_MISMATCH (actual fee ≠ expected,
  `varianceFee` dihitung benar), NOMINAL_MISMATCH (gross debit < nominal
  FP).
- **TEST 5-6** — ekstraksi ID dari DESK_TRAN (`extractionConfidence`
  HIGH kalau ≥2 sumber sepakat), ID CONFLICT antar sumber → `NEED_REVIEW`
  + `id_conflict=true`.
- **TEST 7 (7, 7b)** — pola `BKO...` → `OUT_OF_SCOPE`, DAN mutasi
  `OUT_OF_SCOPE` tidak pernah muncul sbg `BANK_ONLY`/`NEED_REVIEW` di
  hasil rekonsiliasi (bercampur dgn mutasi FASTPAY valid dalam 1 sync).
- **TEST 8-9** — mutasi jauh di luar `FP_COVERAGE_WINDOW` (toleransi 60
  menit) TIDAK jadi `BANK_ONLY`; mutasi valid DALAM coverage tanpa
  pasangan FP → `BANK_ONLY` dgn `estimated_bank_principal = gross_debit −
  expected_fee`.
- **TEST 10** — FP+debit ditemukan lalu credit dgn ID sama →
  `REVERSAL`, bukan `BANK_ONLY` terpisah (hanya 1 hasil, bukan 2).
- **TEST 11** — 2 baris `DEBIT_TRANSFER` dgn ID sama → `DUPLICATE_BANK`,
  `bankPrincipal` tetap `null` (tidak dijumlahkan jadi MATCHED).
- **TEST 12 (12, 12b)** — `validateBriBalance`: saldo konsisten →
  `BALANCED`; saldo tidak sesuai → `UNBALANCED` dgn `balance_variance_total`
  terhitung benar.
- **TEST 13 (13, 13b)** — `normalizeJamTran`: `3153`/`"3153"` →
  `"00:31:53"`; JAM_TRAN tidak valid (jam>23) → `null`.
- **TEST 14** — transaksi tengah malam WIB (00:31) → `business_date`
  yang benar (Asia/Jakarta), bukan mundur ke hari sebelumnya (regresi
  timezone).
- **Reversal cross-date lookup** — `BANK_ONLY` hari ini + credit
  ditemukan di hari lain → `REVERSAL`, `reversal_lookup_source =
  CROSS_DATE_LOOKUP`, `reversalAmount` benar.
- **DUPLICATE_FP** — id_transaksi muncul 2x di DATA FP → 1 hasil,
  `DUPLICATE_FP`.
- **PENDING_BANK / FP_ONLY** — grace period belum/sudah lewat.
- **Fingerprint idempotensi** (2 test) — DESK_TRAN beda huruf besar/kecil
  → fingerprint SAMA (dinormalisasi); `source_row_number` TIDAK
  memengaruhi fingerprint (tidak ada di formula — posisi baris boleh
  berubah tanpa memicu resync duplikat).
- **`classifyBriRow`** — tidak ada teks Description sama sekali →
  `UNKNOWN`.

**27 test baru — LAPORAN HARIAN** (pure function di
`warroom-reconciliation-bri.js`, `briAdapter.js` TIDAK disentuh):
- `dedupeBriResultsByCanonicalKey` — 2 baris berbagi canonical key →
  dihitung 1x, baris pertama dipertahankan.
- `computeBriResultQualityChecks` (5 test) — `invalid_business_date_count`
  terdeteksi kalau `bank_transaction_date` beda dari business_date DAN
  bukan `CROSS_DATE_LOOKUP`; cross-date VALID (reversal) TIDAK dihitung
  invalid; `duplicate_canonical_result_count` dari 2 baris berbagi key;
  `consumed_also_bank_only_count` dari kombinasi MATCHED+BANK_ONLY di
  key yang sama; data bersih → semua count 0.
- `computeBriActionableException` (2 test) — hanya 9
  `EXCEPTION_STATUSES` dihitung (MATCHED/MATCHED_NO_FEE tidak ikut),
  nominal fallback `bank_total_debit`; `OUTSIDE_FP_COVERAGE` TIDAK
  pernah dihitung meski statusnya exception-like.
- `computeBriHealthStatus` (18 test) — GREEN (semua bersih), YELLOW
  (match rate 95-99%, masih ada actionable exception, id_conflict 1-4 di
  bawah material, unbalanced 1-4 di bawah material, extraction MEDIUM
  ada, posting delay ada, outside-coverage ratio material >5%), RED
  (match rate <95%, sync gagal, invalid_business_date>0,
  duplicate_canonical>0, consumed_also_bank_only>0, id_conflict MATERIAL
  ≥5, unbalanced MATERIAL ≥5, RED menang atas YELLOW kalau keduanya
  terpenuhi), cross-date reversal valid tidak pernah jadi input fungsi
  ini (tetap GREEN), match rate `null` (tidak ada FP) + semua bersih →
  tetap GREEN.
- `BRI_HEALTH_THRESHOLDS` — konfigurasi terpusat 99%/95%/material
  thresholds.

Skenario DB/live (idempotensi sync via `row_fingerprint`, resolusi manual
bertahan setelah resync, regresi OCBC & Mandiri) diverifikasi end-to-end
lewat server sungguhan setiap kali ada perubahan pada helper/tabel shared
(`warroom-reconciliation.js`), dijalankan bareng
`test-reconciliation-{ocbc,mandiri}.js` — bukan di level pure-function di
sini.

## Troubleshooting
- **401 saat sync**: cek `BRIC_SYNC_TOKEN` di Script Properties sama dgn `APPS_SCRIPT_TOKEN` server.
- **413 saat sync**: cek endpoint `reconciliation/bri/sync` sudah masuk regex payload besar di Nginx (`location ~ ^/api/(warroom/(...|reconciliation(/mandiri|/bri)?)|...)/sync$`).
- **Sheet "Data FP"/"Data bank bri" tidak ditemukan**: `getSheetByName` exact-match — cek nama tab sungguhan di spreadsheet sama persis (termasuk huruf besar/kecil & spasi) dgn `RECON_BRI_SHEET_FP`/`RECON_BRI_SHEET_BANK` di `apps-script-reconciliation-bri.js`.
- **Banyak NEED_REVIEW**: kemungkinan DESK_TRAN/TRREMK/TLBDS2 saling
  konflik (format BRI berubah) — cek `extractBriTransactionIds()` terhadap
  contoh terbaru.
- **BANK_ONLY membludak / kosong sama sekali**: cek `coverage_tolerance_minutes`
  atau `scope_mode` (`FULL_BUSINESS_DATE` kalau memang ingin semua mutasi
  tanggal itu jadi kandidat, tanpa batas jendela waktu FP).
- **Mutasi non-FASTPAY (mis. "BKO...") muncul di Exception Queue**: BUG —
  seharusnya `OUT_OF_SCOPE` dan tidak pernah sampai situ. Cek
  `classifyBriRow()` — kemungkinan pola FASTPAY baru yang belum
  dikenali `FASTPAY_PATTERN`.
- **Principal BANK_ONLY terlihat pasti padahal seharusnya estimasi**: cek
  frontend memakai `estimated_bank_principal` (bukan `bank_principal`,
  yang HARUS `null` utk BANK_ONLY) — lihat `ReconTable` kolom "Est. Principal".
- **Angka "Actionable Exception" di Executive Summary/Laporan Harian tidak
  sama dengan yang terlihat kalau dihitung manual dari tabel Distribusi
  Status**: cek dulu `data_quality_warning.has_issue` — kalau ada baris
  invalid business date/duplikat canonical yang belum dibersihkan,
  `actionable_exception_count` dihitung dari data yang SUDAH bersih
  (dedupe + invalid business date dikecualikan), sedangkan Distribusi
  Status di tab lain mungkin memakai hasil mentah. Angka ini SEKARANG
  dihitung di backend (`computeBriActionableException()` di
  `warroom-reconciliation-bri.js`), bukan lagi di frontend.
- **Health status Laporan Harian BRI RED padahal match rate 100%**: cek
  `id_conflict_count`/`unbalanced_bank_row_count` — kalau salah satunya
  ≥5 (MATERIAL, lihat `BRI_HEALTH_THRESHOLDS`), itu SENGAJA memicu RED
  meski match rate sempurna (statement BRI mencampur banyak jenis mutasi,
  jumlah BESAR ID conflict/unbalanced adalah sinyal masalah sistemik).
  1-4 kejadian hanya YELLOW, bukan RED — WAJAR & bukan bug.
- **`daily-report` mengembalikan 404 atau ke-intercept jadi `:id`**: cek
  urutan registrasi di `app.js` — `GET .../bri/daily-report` HARUS
  didaftarkan SEBELUM `POST .../bri/:id/resolve` dan
  `GET .../bri/:id/logs` (route dinamis Express mencocokkan berdasar
  urutan definisi, bukan spesifisitas).
- **`cross_date_reversal_count` > 0 tapi health status tetap
  GREEN/tidak berubah**: WAJAR — cross-date reversal adalah fitur bisnis
  valid, bukan input sama sekali ke `computeBriHealthStatus()`. Kalau
  ingin melihat reversal cross-date sbg sinyal, cek panel "Pemeriksaan
  Kualitas Data" di Laporan Harian (ditampilkan terpisah dari
  `has_issue`).
