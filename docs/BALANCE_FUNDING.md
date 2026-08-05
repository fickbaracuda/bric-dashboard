# Balance & Funding

Status: **implementasi selesai, menunggu backup DB (keyword `BACKUP`),
migration (keyword `MIGRATE`), dan deploy (keyword `DEPLOY`) — semua gate
manual per instruksi pemilik produk.** Belum live sampai ketiganya
dijalankan dan production smoke test lolos.

## 1. Tujuan Bisnis

Fitur BARU dan **STANDALONE** — reminder & decision support operasional
untuk Finance/FA di 6 bank: OCBC, Mandiri, BRI, BRI BI-FAST, BNI, BCA.
Untuk tiap bank: Actual Balance vs Planned Balance per jam, evaluasi
scheduler funding berikutnya, rekomendasi **CANCEL / REDUCE / KEEP / ADD**.

**ADVISORY ONLY** — tidak pernah transfer dana, cancel/edit scheduler bank,
atau approve funding secara otomatis. Semua eksekusi tetap manual FA;
sistem hanya memberi ALERT + RECOMMENDATION + REMINDER, dan acknowledge =
catat tindak lanjut, bukan aksi bank.

**TIDAK REUSE Balance Control Tower lama sama sekali** — tabel, route,
adapter, engine, dan komponen frontend semuanya baru & independen. BCT
lama TIDAK diubah/dihapus.

## 2. Balance Source Matrix (hasil audit source code, bukan asumsi)

Audit dilakukan dgn membaca langsung `backend/src/routes/warroom-
reconciliation-*.js` dan `backend/src/reconciliation/*Adapter.js` per bank.

| Bank | Authoritative Source | Source Table.Field | Business Date | Confidence |
|---|---|---|---|---|
| **OCBC** | Nilai resmi statement, dikirim apa adanya oleh Apps Script | `recon_sync_batches.raw_summary.available_balance` | `recon_sync_batches.business_date` | **HIGH** |
| **BCA** | Footer "Saldo Akhir" statement, forwarded verbatim | `recon_sync_batches.raw_summary.current_balance.saldo_akhir` (flag `source='sheet_footer'`) | `recon_sync_batches.business_date` | **HIGH** kalau `source='sheet_footer'`, **MEDIUM** kalau fallback `row_order_fallback`/`balance_continuity`, **UNAVAILABLE** kalau kosong dua-duanya |
| **MANDIRI** | Kolom `close_balance` per baris mutasi (SALDO AKHIR statement asli, bukan hasil hitung app) — TIDAK ada field ringkasan resmi terpisah (`raw_summary` Mandiri secara desain SELALU kosong, Apps Script client tidak pernah mengirimnya). Adapter mundur sampai 30 batch terakhir untuk mencari batch dengan `close_balance` yang genuinely terisi (lihat §14b.2). | `recon_bank_transactions.close_balance`, baris terakhir per arah kronologi (`validateMandiriBalance()` auto-deteksi ASC/DESC via continuity match ≥95%) dari batch valid terbaru | `recon_bank_transactions.business_date` (batch yang benar-benar dipakai, bisa lebih lama dari batch paling baru — lihat §14b.2) | **MEDIUM** kalau continuity BALANCED, **LOW** kalau UNBALANCED/UNDETERMINED, **UNAVAILABLE** kalau 30 batch terakhir semuanya close_balance 0 |
| **BRI** | Kolom `balance` (SALDO_AKHIR_MUTASI) per baris, real nilai statement, divalidasi per-baris saat sync (`balance_check_status`) | `recon_bank_transactions.balance`, baris terakhir (`business_date DESC, effective_date_time DESC, sequence_no DESC`) | `recon_bank_transactions.business_date` | **MEDIUM** kalau `balance_check_status='BALANCED'`, **LOW** kalau tidak |
| **BRI_BIFAST** | Sama pola BRI (kolom `balance` generik, tabel sama), TAPI rekening/settlement rail terpisah dari BRI biasa (bank_code beda, default account_no sendiri: `36001999999306`) | `recon_bank_transactions.balance` (scope `bank_code='BRI_BIFAST'`) | `recon_bank_transactions.business_date` | **MEDIUM/LOW** (sama logika BRI, tapi kurang teruji — tidak ada `synced_at` tiebreak eksplisit di query existing manapun) |
| **BNI** | **TIDAK TERSEDIA secara struktural** — file mutasi BNI tidak memuat kolom saldo apa pun (opening/closing/balance). Kode existing SUDAH mendisclaim ini secara eksplisit: *"Nilai ini menunjukkan arus dana ... bukan saldo rekening aktual karena data tidak memuat opening balance."* Satu-satunya proxy (`funding_summary.net_cash_movement`) adalah net cash-flow, BUKAN saldo. | — | — | **SELALU `UNAVAILABLE`** |

**Konsekuensi desain**: BNI tidak akan pernah menampilkan CANCEL/REDUCE/ADD
— selalu `BALANCE_UNAVAILABLE` ("Saldo aktual belum dapat diverifikasi"),
sesuai spec section 40 ("Jika UNAVAILABLE: jangan give CANCEL/REDUCE/ADD").
Ini bukan bug atau keterbatasan sementara — kalau BNI butuh fitur ini,
sumber saldo baru (mis. balance-inquiry API terpisah) harus disediakan
lebih dulu di luar scope reconciliation existing.

Implementasi lengkap ada di `backend/src/balanceFunding/bankBalanceAdapters.js`.

## 3. Architecture

```
Rekonsiliasi OCBC/Mandiri/BRI/BRI-BF/BNI/BCA (recon_sync_batches, recon_bank_transactions)
                           ↓  (READ ONLY, via bankBalanceAdapters.js)
                  getActualBankBalance(bankCode)
                           ↓
                Hourly Plan (balance_funding_hourly_plan)
                           ↓
          balanceFundingEngine.calculateBankRecommendation()
                (variance → burn s.d. next schedule → projected
                 balance → required funding → CANCEL/REDUCE/KEEP/ADD)
                           ↓
                Alert + Recommendation History + FA Acknowledge
```

Semua file baru, tidak ada satu pun import dari `backend/src/
balanceControlTower/` atau `backend/src/reconciliation/bankPosition/`
(adapter OCBC milik BCT lama):
- `backend/src/balanceFunding/bankBalanceAdapters.js` — 6 adapter saldo.
- `backend/src/balanceFunding/balanceFundingEngine.js` — decision engine, PURE.
- `backend/src/balanceFunding/balanceFundingDataAccess.js` — orkestrasi DB + engine.
- `backend/src/routes/balance-funding.js` — router standalone (`/api/balance-funding`).
- `frontend/src/pages/BalanceFunding.jsx` — halaman standalone, CSS `wbf-*`.

**Reuse yang DIIZINKAN** (spec section 58 — read consumer boleh reuse
helper baca dari modul rekonsiliasi): `validateMandiriBalance()` dari
`backend/src/reconciliation/mandiriAdapter.js` untuk deteksi arah
kronologi & continuity check Mandiri — fungsi PURE read-only, tidak
mengubah recon_status apa pun.

## 4. Setiap Bank Punya Plan Sendiri (bukan 1 baseline global)

`balance_funding_plans` — 1 baris AKTIF per `bank_code`
(`UNIQUE(bank_code) WHERE is_active=TRUE`), berisi `opening_balance`,
`timezone`, `source` (MANUAL/GOOGLE_SHEET/CSV/API — future-proof, spec
section 38), dan konfigurasi toleransi per bank (`variance_tolerance`,
`scheduler_tolerance`, `stale_after_minutes` — NULL = pakai default modul
10.000.000 / 10.000.000 / 120 menit).

## 5. Funding Source ≠ Target Bank

`balance_funding_schedules` menyimpan `target_bank_code` (bank yang
MENERIMA dana, = pemilik `plan_id`) TERPISAH dari `funding_source_code`
(bank ASAL dana — **boleh bank lain**). Contoh baseline OCBC: target=OCBC,
funding_source bisa MANDIRI (05:00-18:00) atau BRI (19:00, 21:00) — valid,
diuji eksplisit di `test-balance-funding-engine.js`.

## 6. Data Model (additive, tabel baru, prefix `balance_funding_`)

Migration: `backend/src/migrations/create_balance_funding.sql`
Runner: `node backend/scripts/run-balance-funding-migration.js`

| Tabel | Key | Catatan |
|---|---|---|
| `balance_funding_plans` | 1 aktif per `bank_code` | opening_balance, tolerance config, `source` |
| `balance_funding_hourly_plan` | `UNIQUE(plan_id, hour_of_day)` | nominal_average, transaksi_trf, dana_disiapkan, planned_balance |
| `balance_funding_schedules` | 1 aktif per `(plan_id, scheduled_time)` | target_bank_code, funding_source_code, status |
| `balance_funding_recommendations` | riwayat, insert-on-material-change | snapshot lengkap kalkulasi + acknowledge |
| `balance_funding_alerts` | dedupe 1 OPEN per `(bank_code, alert_type)` | 8 alert_type |
| `balance_funding_audit_log` | generik | config changes, schedule changes, acknowledge |

**TIDAK DIREUSE** (per larangan spec section 11): `bct_bank_accounts`,
`bct_balance_snapshots`, `bct_balance_policies`, `bct_topup_requests`,
`bct_alerts`, `bct_forecast_snapshots`, `bct_audit_log` — sama sekali
tidak disentuh oleh migration/route/kode Balance & Funding.

## 7. Seed Awal — OCBC (initial example, spec section 13)

Opening balance Rp500.000.000. 24 baris hourly plan + 10 baris scheduler
(8× MANDIRI, 2× BRI — lihat migration untuk nilai lengkap). Ini **CONTOH
AWAL**, bukan data final — admin bisa edit kapan saja lewat Manage Plan
UI tanpa ubah kode (spec section 12/37).

## 8. Decision Engine

`backend/src/balanceFunding/balanceFundingEngine.js` —
`calculateBankRecommendation({ now, targetBankCode, hourlyPlan, schedules,
balanceInfo, planVarianceTolerance, schedulerTolerance, staleAfterMinutes })`.

### Gate order (fail-safe, tidak pernah mengarang rekomendasi finansial)
1. `balanceInfo.confidence === 'UNAVAILABLE'` → `BALANCE_UNAVAILABLE`, tidak pernah CANCEL/REDUCE/ADD.
2. Umur `balance_timestamp` > `stale_after_minutes` → `BALANCE_STALE`.
3. `business_date` saldo aktual ≠ tanggal operasional hari ini (Asia/Jakarta) → **warning**, tetap lanjut (spec section 42: warning, bukan block).
4. Hourly plan jam berjalan kosong → `INSUFFICIENT_DATA`.
5. Tidak ada scheduler SCHEDULED/CONFIRMED/ADJUSTED milik `target_bank_code` setelah waktu sekarang → `NO_UPCOMING_SCHEDULER`.
6. Duplicate scheduler di menit sama → `INSUFFICIENT_DATA`.
7. Target planned_balance jam scheduler kosong / nominal scheduler invalid → `INSUFFICIENT_DATA`.

### Formula (identik prinsipnya dgn spec, angka tervalidasi via contoh OCBC section 54)
```
variance = actual − planned[jam berjalan]
burn_until_next = burn proporsional jam berjalan + burn penuh jam di antaranya (TIDAK termasuk jam scheduler)
projected = actual − burn_until_next + confirmed_inflow_lain
required = MAX(0, target_planned[jam scheduler] − projected)

CANCEL : required <= tolerance
REDUCE : required > tolerance  DAN required < existing − tolerance
KEEP   : |required − existing| <= tolerance
ADD    : required > existing + tolerance
```
41 test case di `test-balance-funding-engine.js` mencakup ke-4 skenario
dgn angka OCBC section 54 persis (REDUCE, CANCEL, ADD, KEEP), plus gate
BALANCE_UNAVAILABLE/BALANCE_STALE/business-date-mismatch/timezone/
tolerance-boundary/rounding. 15 test tambahan di
`test-balance-funding-adapters.js` untuk parsing/confidence per bank
(pool di-mock, tidak bergantung production DB).

## 9. API

Prefix: `/api/balance-funding` (JWT via `requireAuth`, terdaftar terpisah
dari router BCT di `app.js`).

| Method | Path | RBAC |
|---|---|---|
| GET | `/overview` | requireAuth — 6 bank, sorted priority (ADD→CANCEL→REDUCE→UNAVAILABLE→STALE→INSUFFICIENT→NO_SCHEDULER→KEEP) |
| GET | `/banks/:bankCode` | requireAuth |
| GET | `/banks/:bankCode/plan` | requireAuth |
| PUT | `/banks/:bankCode/plan` | `requireAdmin` |
| PUT | `/banks/:bankCode/plan/hourly/:hour` | `requireAdmin` |
| GET | `/banks/:bankCode/schedules` | requireAuth |
| POST | `/banks/:bankCode/schedules` | `requireAdmin` |
| PUT | `/banks/:bankCode/schedules/:id` | `requireAdmin` |
| GET | `/banks/:bankCode/recommendations` | requireAuth |
| POST | `/recommendations/:id/acknowledge` | `requireFinanceOrOps` (FA/OP/admin) |
| GET | `/alerts`, POST `/alerts/:id/acknowledge` | requireAuth / `requireFinanceOrOps` |

RBAC middleware (`requireAdmin`, `requireFinanceOrOps`) ditulis lokal di
`balance-funding.js` — TIDAK diimpor dari `balance-control-tower.js`,
supaya modul ini genuinely independen (pola/logic sama sederhananya,
tapi baris kode terpisah).

## 10. Frontend

`frontend/src/pages/BalanceFunding.jsx` — route `/balance-funding`, menu
sidebar standalone "Balance & Funding" (posisi: setelah grup Rekonsiliasi,
sebelum Server Monitor/Kelola User — BUKAN di dalam accordion Balance
Control Tower). Semua CSS class prefix `wbf-*` (BARU, tidak share dgn
`bct-*`/`bctcc-*`/`wrfs-*`).

- **Overview**: grid card 6 bank, sorted critical-first, klik → detail.
- **Bank Detail**: header (source/confidence/business date/account),
  alert banner, 5 KPI card, Recommendation card dominan + acknowledge,
  chart 24 jam (planned line + 1 titik actual jam berjalan — histori
  actual per-jam TIDAK disimpan di rilis ini, sesuai spec section 32
  "jangan invent historical chart"), Funding Timeline table, Data
  Quality section (source/verification/business date/account/sync/
  confidence — spec section 50).
- **Manage Plan (admin)**: edit opening balance/tolerance, 24 baris
  hourly plan, tambah/edit scheduler — collapsible panel, tanpa perlu
  edit kode (spec section 37).

## 11. Alert Dedupe

`balance_funding_alerts` — dedupe partial unique index `(bank_code,
alert_type) WHERE status='OPEN'`, disinkron tiap GET overview/detail
(resolve tipe yang tidak lagi relevan, insert-if-not-open utk yang
relevan). KEEP tidak membuat alert. `SCHEDULER_MISSED` hanya dibuat saat
admin eksplisit set status scheduler = MISSED (tidak ada deteksi otomatis
— tidak ada feed konfirmasi eksekusi transfer bank real-time).

## 12. Timezone

Semua kalkulasi jam pakai `Intl.DateTimeFormat` dgn `timeZone:
'Asia/Jakarta'` eksplisit (`getJakartaParts`/`jakartaBusinessDate`) — sama
prinsipnya dgn Funding Scheduler Assistant BCT, tapi implementasi
terpisah, tidak ada import lintas modul.

## 13. Test

- `node backend/scripts/test-balance-funding-engine.js` — 31 test.
- `node backend/scripts/test-balance-funding-adapters.js` — 15 test (pool di-mock, tidak bergantung DB production).

Total 46 test, semua pass.

## 14. Performance & Reconciliation Safety

- Overview: `Promise.all` 6 bank paralel (BUKAN loop sekuensial), setiap
  adapter 1-2 query terarah (index-friendly: `bank_code`+`status`+
  `business_date DESC`), tidak ada N+1 per jam.
- **TIDAK PERNAH menulis** ke tabel `recon_*` — read-only murni. Membuka
  Balance & Funding tidak memicu mutasi data rekonsiliasi apa pun (diuji
  di production smoke test: cek 6 halaman Rekonsiliasi tetap identik
  sebelum/sesudah).

## 14b. Mandiri Baseline *(ditambahkan pada sesi lanjutan — plan Mandiri, sesudah OCBC)*

### 14b.1 Plan

Opening balance **Rp200.000.000**, timezone Asia/Jakarta, 24 baris hourly
plan + 9 baris scheduler. Seed: `backend/scripts/seed-balance-funding-
mandiri.js` — data-only (tidak ada migration baru, tabel `balance_funding_*`
sudah ada), idempotent (upsert plan+hourly, `ON CONFLICT DO NOTHING` untuk
scheduler supaya tidak menimpa perubahan manual FA lewat UI kalau script
dijalankan ulang). Validasi matematis 24 baris (`prev_planned + scheduler −
nominal_average ≈ current_planned`, toleransi Rp1) dijalankan **sebelum**
menulis apa pun — script berhenti (exit 1) kalau ada satu saja baris tidak
cocok.

| Waktu | Funding Source | Nominal |
|---|---|---|
| 05:00 | MANDIRI → MANDIRI | Rp150.000.000 |
| 07:00 | MANDIRI → MANDIRI | Rp150.000.000 |
| 09:00 | MANDIRI → MANDIRI | Rp300.000.000 |
| 11:00 | MANDIRI → MANDIRI | Rp300.000.000 |
| 13:00 | MANDIRI → MANDIRI | Rp200.000.000 |
| 15:00 | MANDIRI → MANDIRI | Rp200.000.000 |
| 17:00 | MANDIRI → MANDIRI | Rp300.000.000 |
| 19:00 | MANDIRI → MANDIRI | Rp300.000.000 (lihat catatan 19:00 di bawah) |
| 21:00 | **BRI** → MANDIRI | Rp250.000.000 (funding source BRI, target bank tetap MANDIRI) |

**Catatan 19:00** — source mentah FA menulis label "Data Schedule 18:00"
untuk funding Rp300jt ini. Validasi matematis 24 baris HANYA konsisten
kalau funding itu masuk di baris **19:00**:
- 18:00 valid **tanpa** scheduler apa pun: `349.132.566 − 154.325.742 =
  194.806.824` (cocok persis dengan planned_balance source).
- 19:00 **hanya** cocok kalau +Rp300jt masuk di baris itu:
  `194.806.824 + 300.000.000 − 168.905.616 = 325.901.208` (cocok persis).

`scheduled_time` di-set ke `19:00` mengikuti bukti matematis, bukan label
mentah — discrepancy ini disimpan sebagai catatan audit di kolom `note`
baris scheduler tsb (bisa dilihat lewat `GET /banks/MANDIRI/schedules` atau
tab Manage Plan admin), **bukan** dihilangkan diam-diam.

### 14b.2 Investigasi Actual Balance Mandiri Rp0 (root cause & fix)

Sebelum baseline ini ditambahkan, kartu Mandiri di Overview menampilkan
**Actual Balance Rp0, confidence LOW**. Investigasi produksi (query
langsung ke `recon_bank_transactions`, dibandingkan berturut-turut per
`business_date`) menemukan:

| business_date | Baris `close_balance` nonzero |
|---|---|
| 2026-07-27 | 3.388 / 3.388 (100% terisi) |
| 2026-07-28 s.d. 2026-08-05 | **0 / N** (100% nol, di SEMUA baris, SETIAP hari) |

Sebuah statement bank asli tidak pernah persis Rp0 di setiap baris selama
9 hari berturut-turut — ini indikasi kolom `close_balance` berhenti terisi
oleh pipeline sync Mandiri sejak 2026-07-28 (regresi di luar scope Balance
& Funding), **bukan** saldo Rp0 yang authoritative. Adapter lama (`getMandiriBalance`)
mengambil batch TERBARU apa pun kondisinya, sehingga menampilkan Rp0 palsu
dengan percaya diri (confidence LOW, tapi tetap sebuah ANGKA, bukan
UNAVAILABLE).

**Fix** (di `backend/src/balanceFunding/bankBalanceAdapters.js`, TIDAK
menyentuh `warroom-reconciliation-mandiri.js`/`mandiriAdapter.js` sama
sekali): `getMandiriBalance()` sekarang mundur sampai 30 batch sukses
terakhir, melewati batch yang `close_balance`-nya 0 di **semua** baris
(`isMandiriCloseBalanceTrustworthy()`), dan memakai batch valid TERBARU
yang ditemukan. Kalau tidak ada satu pun dari 30 batch itu yang punya
close_balance genuine → `BALANCE_UNAVAILABLE` (bukan Rp0). Kalau yang
dipakai bukan batch paling baru, `business_date`/`balance_timestamp` ikut
batch itu (lebih lama) — sehingga gate `BALANCE_STALE` di decision engine
otomatis aktif kalau umurnya sudah lewat `stale_after_minutes`, TANPA
perlu logic staleness tambahan.

Hasil setelah fix: Mandiri sekarang menampilkan saldo asli dari
**2026-07-27** (batch valid terakhir), dengan warning eksplisit
menjelaskan kenapa bukan batch hari ini. Ini **tidak menyelesaikan**
masalah sync Mandiri yang mendasarinya (di luar scope task ini, perlu
tim Rekonsiliasi Mandiri cek Apps Script/sheet) — hanya memastikan
Balance & Funding tidak menampilkan angka palsu selama masalah itu belum
diperbaiki.

### 14b.3 Test

11 test baru di `test-balance-funding-engine.js` (baseline math, 19:00
discrepancy, 21:00 cross-bank funding source, current-hour/next-scheduler
resolve) + 2 test baru di `test-balance-funding-adapters.js` (skip batch
close_balance-0, UNAVAILABLE kalau semua batch dalam lookback rusak).
Total 59 test (42 engine + 17 adapter), semua pass.

## 14c. Balance Position Time & Funding Countdown *(ditambahkan pada sesi lanjutan)*

### 14c.1 Masalah yang diperbaiki

Sebelum enhancement ini, `balance_timestamp` yang ditampilkan di semua UI
(header Bank Detail, Data Quality section) sebenarnya berisi
`recon_sync_batches.synced_at` — **waktu Apps Script melakukan sync**, BUKAN
waktu posisi saldo yang sebenarnya. FA tidak bisa membedakan "saldo ini
posisi jam berapa" dari "kapan terakhir sistem sinkron", padahal keduanya
sering BERBEDA jauh (dibuktikan dari data produksi: BRI baris mutasi
terakhir yang dipakai `effective_date_time` 2026-07-10, tapi batch-nya baru
sync 2026-07-14 — beda 4 hari).

### 14c.2 Audit sumber timestamp per bank (hasil baca kode+data produksi, bukan asumsi)

| Bank | Kolom bank-provided dgn jam:menit? | balance_position_time diambil dari | Presisi |
|---|---|---|---|
| **MANDIRI** | Ya — `recon_bank_transactions.post_date_time` (TIMESTAMPTZ, terbukti 0% NULL di produksi) | `post_date_time` baris mutasi yang dipakai sbg `close_balance` | **MINUTE** |
| **BRI / BRI_BIFAST** | Ya — `recon_bank_transactions.effective_date_time` (Value Date) | `effective_date_time` baris mutasi terakhir | **MINUTE** |
| **OCBC** | **Tidak** — `recon_bank_transactions.transaction_date`/`value_date` bertipe `DATE` (bukan TIMESTAMPTZ), `raw_summary.release_date` juga cuma string tanggal (dikonfirmasi data produksi: `"05/08/2026"`, tanpa jam) | `business_date` batch, di-anchor ke **00:00:00 WIB** (satu-satunya instant yang bisa dibuktikan tanpa mengarang jam) | **DATE** |
| **BCA** | Sama seperti OCBC — TIDAK ADA kolom jam sama sekali di sumbernya | `business_date` batch, anchor sama (00:00:00 WIB) | **DATE** |
| **BNI** | Tidak relevan — selalu `UNAVAILABLE` | — | — |

`balance_position_precision` (`'MINUTE'` \| `'DATE'` \| `null`) dikirim ke
frontend supaya TIDAK PERNAH menampilkan klaim jam:menit utk bank yang
sumbernya cuma punya tanggal (OCBC/BCA tampil sbg "Posisi: DD/MM/YYYY",
BUKAN "17:42 WIB" yang dikarang).

**Guard "no fake timestamp"** (`resolveDateOnlyPosition`/`resolveTimePosition`
di `bankBalanceAdapters.js`): kalau timestamp hasil (baik dari business_date
maupun dari kolom bank-provided) ternyata berada di **masa depan** relatif
`now` — kondisi ANOMALI nyata ditemukan di data produksi BCA
(`business_date = "2026-09-07"` padahal `synced_at` 2026-07-30, indikasi bug
parsing tanggal di pipeline sync BCA, di luar scope fitur ini) —
`balance_position_time` di-set `null` (BUKAN dipakai apa adanya / BUKAN
fallback ke `NOW()`), confidence diturunkan, warning eksplisit ditambahkan.

### 14c.3 API & field baru

Semua adapter (`bankBalanceAdapters.js`) sekarang butuh param `now` (dipakai
utk guard masa depan) — `getActualBankBalance(pool, bankCode, now)`, default
`new Date()` kalau tidak dikirim. Return shape tiap bank bertambah:

```
balance_position_time        -- ISO instant posisi saldo genuine, atau null
balance_position_precision   -- 'MINUTE' | 'DATE' | null
last_sync_at                 -- waktu sync (recon_sync_batches.synced_at) -- SELALU beda field dari posisi saldo
balance_source                -- alias balance_source utk `source` (nama field persis sesuai spec)
balance_timestamp             -- DIPERTAHANKAN sbg alias balance_position_time (supaya STALE gate
                                  di balanceFundingEngine.js otomatis pakai posisi asli TANPA perlu
                                  diubah sama sekali -- lihat 14c.4)
```

`balance_age_minutes` dihitung SEKALI di `balanceFundingDataAccess.js`
(`computeBalanceFundingForBank`, satu-satunya tempat yang pegang `now` dan
`balanceInfo` bersamaan) — `null` kalau `balance_position_time` tidak ada.

### 14c.4 Decision engine — HANYA ditambah, TIDAK diubah

Formula CANCEL/REDUCE/KEEP/ADD di `balanceFundingEngine.js` **tidak
tersentuh sama sekali**. Yang ditambahkan murni metadata additive:

- `next_schedule.minutes_to_next_scheduler`, `.next_scheduler_time`
  (absolute instant, dipakai frontend utk countdown LOKAL tanpa hit API
  tiap detik — spec section 3), `.urgency`
  (`NORMAL`/`WATCH`/`WARNING`/`URGENT`/`OVERDUE`, ambang batas: >60=NORMAL,
  31-60=WATCH, 16-30=WARNING, 0-15=URGENT, <0=OVERDUE), `.finance_action_alert`
  (`true` HANYA kalau recommendation ADD/REDUCE/CANCEL DAN urgency
  URGENT/OVERDUE — KEEP TIDAK PERNAH memicu ini, spec section 5/6).
- `deriveScheduleDisplayStatus()` — scheduler yg waktunya lewat tapi masih
  status SCHEDULED/CONFIRMED/ADJUSTED sekarang `SCHEDULER_OVERDUE` (dulu
  diam-diam jadi `'COMPLETED'`, salah — itu klaim eksekusi yang tidak
  terbukti). `deriveScheduleOverdueMinutes()` (baru) — angka "TERLAMBAT X
  MENIT".
- STALE gate (existing, TIDAK diubah kodenya) otomatis membaca posisi saldo
  asli karena `balance_timestamp` sekarang = `balance_position_time` (lihat
  14c.3) — bukan `synced_at` lagi.

### 14c.5 stale_after_minutes utk OCBC/BCA (DATE precision) — data update, BUKAN migration/DDL

Default modul `stale_after_minutes` (120 menit) TIDAK COCOK utk anchor
00:00 WIB: begitu lewat jam 02:00 WIB SETIAP HARI, OCBC/BCA akan selalu
`BALANCE_STALE` walau baru saja sync — regresi nyata dibanding perilaku
lama. Fix: `backend/scripts/update-balance-funding-stale-threshold-date-precision.js`
(data-only, idempotent, guard `stale_after_minutes IS NULL` supaya tidak
menimpa kustomisasi FA manual) — set `1440` menit (24 jam) KHUSUS OCBC/BCA,
angka ini dipilih PERSIS supaya secara matematis setara "business_date !=
hari ini WIB" tanpa perlu logic precision-aware baru di decision engine.

### 14c.6 Frontend

`frontend/src/pages/BalanceFunding.jsx` — Overview card format compact baru
(Actual Balance + posisi saldo & age sbg info utama, Last Sync TIDAK lagi
ditonjolkan sbg info utama sesuai spec section 2/7), countdown lokal
(`useTick` re-render 1s di Bank Detail / 30s di Overview, TANPA hit API
tambahan — hitung ulang dari `next_scheduler_time` absolute), badge urgency
(HANYA ditonjolkan kalau recommendation actionable — KEEP tetap netral),
`FinanceActionAlert` (banner dominan ADD/CANCEL/REDUCE + countdown, HANYA
muncul saat `finance_action_alert` true), operational strip di Bank Detail
(SEKARANG/POSISI SALDO/NEXT SCHEDULER/STATUS, tanpa scroll), teks staleness
persis spec ("Saldo terakhir posisi HH:mm WIB — X menit lalu..."), dan teks
"Waktu posisi saldo tidak tersedia" saat `balance_position_time` null.

Actionable sorting di `/overview` (`balance-funding.js`
`overviewSortPriority()`): ADD+URGENT → CANCEL+URGENT → REDUCE+URGENT →
actionable+WARNING → BALANCE_STALE → BALANCE_UNAVAILABLE → actionable
lainnya → INSUFFICIENT_DATA/NO_UPCOMING_SCHEDULER → KEEP, dgn tie-break
`minutes_to_next_scheduler` ascending dalam tier yang sama.

### 14c.7 Test

26 test baru: engine (urgency ladder tiap ambang batas, overdue,
`scheduledTimeToAbsolute`, `needsFinanceActionAlert` utk ADD/CANCEL/REDUCE
actionable vs KEEP non-actionable, `deriveScheduleDisplayStatus` ->
`SCHEDULER_OVERDUE`) + adapter (position_time per bank, future-date guard
OCBC & BCA memakai angka anomali nyata dari produksi, Mandiri post_date_time
dari baris yang dipakai bukan batch, BRI effective_date_time BEDA dari
synced_at). Total **97 test** (71 engine + 26 adapter), semua pass.

## 15. Known Limitations

1. **BNI selalu BALANCE_UNAVAILABLE** — bukan bug, struktur data sumber
   memang tidak punya saldo (lihat §2).
2. **Histori actual balance per-jam tidak disimpan** — chart 24 jam hanya
   menampilkan 1 titik actual di jam berjalan, bukan garis penuh 24 jam
   (spec section 32, sengaja — tidak invent data historis yang tidak
   reliable).
3. **MANDIRI/BRI/BRI_BIFAST bukan HIGH confidence** — saldo diturunkan
   dari baris mutasi terakhir (bukan field ringkasan resmi terpisah
   seperti OCBC), sesuai keterbatasan struktur data sumber masing-masing
   bank (lihat §2, bukan keterbatasan implementasi).
4. **1 plan aktif per bank** (bukan multi-plan/versioning paralel) — edit
   admin mengubah baris plan yang sama, riwayat perubahan tercatat di
   `balance_funding_audit_log`, bukan versi plan terpisah.
5. **BRI_BIFAST**: adapter mengasumsikan pola sama dgn BRI (kolom
   `balance` generik + `balance_check_status`) — belum divalidasi di
   production dgn data BI-FAST riil sebanyak OCBC (yang sudah lama
   dipakai BCT). Perlu dipantau di smoke test awal.
6. **OCBC/BCA balance_position_time cuma presisi tanggal (DATE), bukan
   jam:menit** — bukan keterbatasan implementasi, sumbernya (statement
   bank) memang tidak punya kolom jam sama sekali (lihat §14c.2). Frontend
   menampilkan ini sbg tanggal ("Posisi: DD/MM/YYYY"), BUKAN jam yang
   dikarang.
7. **Countdown scheduler dihitung dari business date WIB hari berjalan** —
   kalau server/browser jam-nya melenceng jauh dari waktu sebenarnya,
   countdown lokal (`next_scheduler_time`) bisa salah; tidak ada validasi
   clock-skew di fitur ini (di luar scope, sama seperti semua kalkulasi
   berbasis `now` lain di modul ini).

## 16. Deployment

Ikuti safe deploy flow existing (`scripts/safe_deploy.py
--confirm-new-commit`). Urutan: commit → push → backup DB (keyword
`BACKUP` manual) → migration (`run-balance-funding-migration.js`, keyword
`MIGRATE` manual, kalau ada skema baru) / data update
(`update-balance-funding-stale-threshold-date-precision.js`, data-only —
lihat §14c.5) → verifikasi → deploy (keyword `DEPLOY` manual) → production
smoke test (termasuk regression check 6 halaman Rekonsiliasi, DAN
verifikasi `balance_position_time` per bank sesuai audit §14c.2).

## 17. Rollback

- **Migration**: additive, aman dibiarkan meski deploy di-rollback (tidak
  mengubah data existing apa pun — recon_* TIDAK disentuh). Revert penuh
  kalau perlu: `DROP TABLE balance_funding_alerts,
  balance_funding_recommendations, balance_funding_schedules,
  balance_funding_hourly_plan, balance_funding_plans,
  balance_funding_audit_log;` — **jangan dijalankan tanpa approval
  eksplisit**.
- **Backend/Frontend**: restore dari backup `/var/www/bric_backup_*` +
  `git revert` komit terkait, `pm2 reload` via user `admin`.
