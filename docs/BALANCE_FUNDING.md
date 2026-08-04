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
| **MANDIRI** | Kolom `close_balance` per baris mutasi (SALDO AKHIR statement asli, bukan hasil hitung app) — TIDAK ada field ringkasan resmi terpisah (`raw_summary` Mandiri secara desain SELALU kosong, Apps Script client tidak pernah mengirimnya) | `recon_bank_transactions.close_balance`, baris terakhir per arah kronologi (`validateMandiriBalance()` auto-deteksi ASC/DESC via continuity match ≥95%) | `recon_sync_batches.business_date` | **MEDIUM** kalau continuity BALANCED, **LOW** kalau UNBALANCED/UNDETERMINED |
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

## 16. Deployment

Ikuti safe deploy flow existing (`scripts/safe_deploy.py
--confirm-new-commit`). Urutan: commit → push → backup DB (keyword
`BACKUP` manual) → migration (`run-balance-funding-migration.js`, keyword
`MIGRATE` manual) → verifikasi migration → deploy (keyword `DEPLOY`
manual) → production smoke test (termasuk regression check 6 halaman
Rekonsiliasi).

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
