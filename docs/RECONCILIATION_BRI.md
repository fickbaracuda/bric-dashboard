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
`isValidIdTransaksi`, `RECON_STATUSES`, `normalizeCanonicalKey`, dst)
diimpor langsung dari `warroom-reconciliation.js` — tidak diduplikasi.

## Sumber Data
Spreadsheet ID **TIDAK di-hardcode** — Apps Script membaca Script Property
`BRI_SPREADSHEET_ID`, fallback ke `SpreadsheetApp.getActiveSpreadsheet()`.

- **DATA FP**: header baris 1, data baris 2+. A-F: `id_transaksi`,
  `nominal`, `id_produk`, `time_response`, `id_outlet`, `id_biller`.
  Seluruh baris DATA FP dengan `id_biller = '284'` adalah kandidat
  rekonsiliasi BRI (`id_produk` disimpan utk analitik, bukan filter utama).
- **DATA BRI**: header baris 1, data baris 2+. A-R: `ID`, `NOREK`,
  `TGL_TRAN`, `TGL_EFEKTIF`, `JAM_TRAN`, `SEQ`, `DESK_TRAN`,
  `SALDO_AWAL_MUTASI`, `MUTASI_DEBET`, `MUTASI_KREDIT`,
  `SALDO_AKHIR_MUTASI`, `GLSIGN`, `TRUSER`, `KODE_TRAN`,
  `KODE_TRAN_TELLER`, `TRREMK`, `TLBDS1`, `TLBDS2`.

Semua ID (id_transaksi, NOREK, JAM_TRAN, SEQ, dst) diproses sebagai
**STRING** di Apps Script maupun backend — tidak pernah lewat `Number()`.

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

## Klasifikasi Baris (`classifyBriRow`) — `bank_row_type`
| Type | Kondisi |
|---|---|
| `UNKNOWN` | DESK_TRAN & TRREMK sama-sama kosong — data tak cukup dinilai |
| `OUT_OF_SCOPE` | Bukan pola FASTPAY (mis. `BKO178370886...`) — **TIDAK PERNAH** jadi BANK_ONLY/exception, tetap tersimpan mentah di Raw Data |
| `NEED_REVIEW` | Pola FASTPAY tapi ID conflict ATAU ID tidak ditemukan |
| `CREDIT_REVERSAL` | Pola FASTPAY + ID valid + `MUTASI_KREDIT > 0` |
| `DEBIT_TRANSFER` | Pola FASTPAY + ID valid + `MUTASI_DEBET > 0` |

`OUT_OF_SCOPE` diperiksa **sebelum** cek ID conflict — mutasi yang jelas
bukan FASTPAY tidak pernah "naik derajat" jadi NEED_REVIEW hanya karena
kebetulan ada digit mirip ID transaksi.

## Coverage Window (`calculateBriCoverage`)
Default `FP_COVERAGE_WINDOW`: `coverage_start = min(FP time_response) −
toleransi`, `coverage_end = max(FP time_response) + toleransi` (default 60
menit). Perlu karena data sample menunjukkan DATA BRI sekitar 00:31–02:08
sedangkan DATA FP sekitar 03:12–12:11 — jendela waktu TIDAK overlap, jadi
mutasi BRI dini hari tidak boleh otomatis jadi BANK_ONLY.

`coverage_status` (`IN_FP_COVERAGE`/`OUTSIDE_FP_COVERAGE`) adalah dimensi
**terpisah** dari `recon_status` — mutasi `OUTSIDE_FP_COVERAGE` tidak
pernah masuk Exception Queue/match rate, tetap terlihat di Raw Data.

## Matching & Cascade Status (`reconcileBriTransactions`)
Grouping berdasarkan `extracted_transaction_id` (`canonical_transaction_key`).
Satu grup bisa punya banyak baris debit dan/atau credit. `consumedBankKeys`
ditandai SEGERA saat grup dipasangkan ke FP (sebelum cascade status
ditentukan) — mencegah grup yang sama muncul lagi sbg BANK_ONLY.

11 status generic (sama dgn OCBC/Mandiri): `MATCHED`, `MATCHED_NO_FEE`,
`PENDING_BANK`, `FP_ONLY`, `BANK_ONLY`, `NOMINAL_MISMATCH`, `FEE_MISMATCH`,
`DUPLICATE_FP`, `DUPLICATE_BANK`, `REVERSAL`, `NEED_REVIEW`. Prioritas
cascade: REVERSAL (kredit ditemukan) menimpa status principal apa pun →
DUPLICATE_FP/DUPLICATE_BANK → MATCHED/MATCHED_NO_FEE/FEE_MISMATCH/
NOMINAL_MISMATCH (berdasar `gross_debit` vs `nominal FP`) →
PENDING_BANK/FP_ONLY (grace period) → BANK_ONLY (hanya kalau: pola FASTPAY
valid, ID valid tanpa conflict, ada debit, dalam coverage, belum consumed,
bukan credit-only) → NEED_REVIEW (fallback/ID conflict/data ambigu).

**Principal HANYA dihitung setelah pasangan FP ditemukan**
(`bank_principal = fp_nominal`, `bank_fee = gross_debit − fp_nominal`) —
**TIDAK PERNAH** `gross_debit − 150` sebelum ada pasangan FP. Utk
`BANK_ONLY` (tanpa FP), `estimated_bank_principal = gross_debit −
expected_fee` selalu ditandai **ESTIMASI**, bukan principal pasti.

`DUPLICATE_BANK` (>1 baris `DEBIT_TRANSFER` utk 1 ID yang sama) TIDAK
PERNAH dijumlahkan jadi MATCHED.

## Reversal Cross-Date Lookup (`applyBriReversalCrossDateLookup`)
Fungsi **terpisah** dari `reconcileBriTransactions()` (sengaja diisolasi —
butuh query bank row dari tanggal LAIN, business_date+1 s.d.
+`reversal_lookup_days`, default 3 hari). Kalau kredit ditemukan di
tanggal lain utk canonical key yang sama, hasil batch aslinya di-UPDATE
jadi `REVERSAL` (`reversal_lookup_source = CROSS_DATE_LOOKUP`) — TIDAK
membuat baris/BANK_ONLY duplikat pada tanggal reversal-nya. Diuji terpisah
di `test-reconciliation-bri.js`.

## Validasi Saldo (`validateBriBalance`) — PER BARIS
Beda dari Mandiri (per urutan statement): `SALDO_AWAL_MUTASI −
MUTASI_DEBET + MUTASI_KREDIT` harus sama dgn `SALDO_AKHIR_MUTASI`
(toleransi ±Rp1). Status: `BALANCED`/`UNBALANCED`/`UNDETERMINED` — murni
informatif, **TIDAK PERNAH** mengubah `recon_status` transaksi manapun.

## Waktu — JAM_TRAN, TGL_TRAN, TGL_EFEKTIF
`business_date` = tanggal `TGL_EFEKTIF` (Asia/Jakarta). `posting_time` =
`TGL_TRAN` + presisi detik dari `JAM_TRAN` kalau valid: normalisasi
`String(JAM_TRAN).padStart(6,'0')`, HH=char 1-2, MM=char 3-4, SS=char 5-6
(mis. `3153` → `"003153"` → `00:31:53`); kalau JAM_TRAN tidak valid,
fallback ke jam bawaan TGL_TRAN. Semua di-anchor eksplisit ke **Asia/Jakarta
(+07:00)** — TIDAK PERNAH `toISOString().slice(0,10)`.

## Database
Migration: `backend/src/migrations/add_reconciliation_bri_columns.sql`
(perluasan tabel `recon_*` yang sudah ada, semua kolom baru nullable —
tidak mengubah perilaku baris OCBC/Mandiri yang sudah ada).
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
`recon_results` upsert lewat `UNIQUE(batch_id, canonical_transaction_key)`
(sama pola dgn OCBC/Mandiri) — resync tidak menggandakan baris/menghapus
riwayat resolve & audit log.

## Backend Endpoints (`backend/src/routes/warroom-reconciliation-bri.js`)
| Endpoint | Auth | Keterangan |
|---|---|---|
| `POST /api/warroom/reconciliation/bri/sync` | `APPS_SCRIPT_TOKEN` (token SHARED) | Chunk FP/BRI, jalankan adapter+engine+cross-date lookup di chunk terakhir |
| `GET /api/warroom/reconciliation/sync-request-status?bank_code=BRI` | `APPS_SCRIPT_TOKEN` | Endpoint GENERIK — dipanggil Apps Script BRI tiap 1 menit, cek tombol "Sync Now" |
| `POST /api/warroom/reconciliation/request-sync` | JWT | Endpoint GENERIK — tombol "Sync Now", body `{bank_code: 'BRI'}` |
| `GET /api/warroom/reconciliation/bri/analytics?date=` | JWT | Summary, coverage, fee analysis, time analysis, balance validation, quality diagnostics |
| `GET /api/warroom/reconciliation/bri/transactions?...` | JWT | List berpaginasi (status & coverage_status boleh difilter) |
| `GET /api/warroom/reconciliation/bri/raw-bank?date=` | JWT | Raw mutasi BRI + hasil ekstraksi/klasifikasi/balance check |
| `GET /api/warroom/reconciliation/bri/raw-fp?date=` | JWT | Raw baris DATA FP |
| `GET /api/warroom/reconciliation/bri/export?...` | JWT | CSV (fetch sbg blob) |
| `POST /api/warroom/reconciliation/bri/:id/resolve` | JWT | Body `{status, notes}`, `matching_method` di-set `MANUAL_RESOLUTION` |
| `GET /api/warroom/reconciliation/bri/:id/logs` | JWT | Riwayat audit 1 baris hasil |
| `GET /api/warroom/reconciliation/bri/resolution-history?date=` | JWT | Rekap semua resolve manual pada batch tanggal ini |

## Frontend
- Route: `/war-room/rekonsiliasi/bri`
- Page: `frontend/src/pages/WarRoomReconciliationBri.jsx`
- Menu: Rekonsiliasi > **Rekonsiliasi BRI** (badge `BRI`, navy `#00529C`)
- CSS: reuse `wrr-*`/`wrrm-*` (layout generik dari OCBC/Mandiri) + `wrrbri-*`
  (elemen BARU: badge coverage, extraction confidence, id conflict,
  reversal lookup source)
- 6 tab: Executive Summary, Hasil Rekonsiliasi, Exception Queue, Fee
  Analysis, Time & Posting Analysis, Raw Data & Audit (4 sub-tab: Raw FP,
  Raw BRI, Sync History, Resolution History)

## Apps Script (`apps-script-reconciliation-bri.js`)
Fungsi: `testReconciliationBri()` (dry-run), `pushReconciliationBri()`
(kirim, chunk 1500 baris), `setupReconciliationBriTrigger()`,
`removeReconciliationBriTrigger()`, `checkReconciliationBriChanges()`
(dipanggil time-based trigger tiap 1 menit), `getReconciliationBriStatus()`.

Spreadsheet ID dibaca dari Script Property `BRI_SPREADSHEET_ID` (fallback
`getActiveSpreadsheet()`) — **tidak** di-hardcode di kode, beda dari
OCBC/Mandiri yang hardcode ID sheet-nya. Header sheet dibaca **by NAME**
(fallback index A-F/A-R) — kolom boleh berpindah posisi asal nama header
sesuai spek. Sheet **tidak pernah dimutasi** (hanya `getValues()`).

### Tombol "Sync Now" — kompromi, BUKAN sync instan
Sama seperti OCBC/Mandiri (lihat `docs/RECONCILIATION_OCBC.md`). Tombol di
dashboard HANYA mencatat permintaan lewat `POST .../reconciliation/request-sync`
(endpoint generik); trigger checker BRI yang jalan tiap 1 menit ikut
mengecek lewat `reconBriCheckForceSyncRequested_()` dan sync SEKARANG kalau
ada. Realistis ~1-2 menit dari klik sampai data ter-update.

### Auto-sync REAKTIF (2 lapis)
1. **`reconBriOnChangeTrigger_`** — installable trigger `onChange`, HANYA
   menandai `RECON_BRI_DIRTY_SINCE` di Script Properties (sangat ringan).
2. **`checkReconciliationBriChanges`** — time-based trigger tiap 1 menit.
   Jalankan `pushReconciliationBri()` kalau: (dirty flag + lewat 30 detik
   debounce) ATAU ada permintaan "Sync Now" — DAN tidak ada sync lain yang
   sedang berjalan (lock `RECON_BRI_SYNC_IN_PROGRESS`).

Pasang sekali lewat `setupReconciliationBriTrigger()`, lepas dengan
`removeReconciliationBriTrigger()`.

### Setup
1. Buka spreadsheet DATA FP + DATA BRI → Extensions > Apps Script.
2. Tempel isi `apps-script-reconciliation-bri.js` sebagai file baru.
3. Project Settings > Script Properties:
   - `BRIC_SYNC_TOKEN` = sama dengan `APPS_SCRIPT_TOKEN` di server (**jangan** ditulis di source code)
   - `BRIC_API_BASE_URL` = `https://bmsretail.my.id` (opsional, ini defaultnya)
   - `BRI_SPREADSHEET_ID` = ID spreadsheet (opsional kalau script sudah di-bind langsung ke Sheet-nya)
4. Jalankan `testReconciliationBri()` dulu — cek Execution Log.
5. Jalankan `pushReconciliationBri()` utk sync manual pertama kali.
6. Jalankan `setupReconciliationBriTrigger()` utk sync otomatis reaktif.

## Troubleshooting
- **401 saat sync**: cek `BRIC_SYNC_TOKEN` di Script Properties sama dgn `APPS_SCRIPT_TOKEN` server.
- **413 saat sync**: cek endpoint `reconciliation/bri/sync` sudah masuk regex payload besar di Nginx (`location ~ ^/api/(warroom/(...|reconciliation(/mandiri|/bri)?)|...)/sync$`).
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
