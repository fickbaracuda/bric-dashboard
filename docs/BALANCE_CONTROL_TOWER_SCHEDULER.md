# Balance Control Tower — Funding Scheduler Adjustment Assistant

Status: **implementasi selesai, menunggu backup DB (keyword `BACKUP`),
migration (keyword `MIGRATE`), dan deploy (keyword `DEPLOY`) — semua gate
manual per instruksi pemilik produk.** Belum live sampai ketiganya
dijalankan dan production smoke test lolos.

## 1. Tujuan

Enhancement pada Balance Control Tower **existing** (bukan dashboard baru)
untuk Finance/FA: reminder + decision support apakah scheduler funding
berikutnya (BNI/BRI) harus **CANCEL / REDUCE / KEEP / ADD**, berdasarkan
perbandingan Actual Balance berjalan vs Planned Balance per jam, dan
kebutuhan saldo sampai scheduler berikutnya.

**ADVISORY ONLY.** Fitur ini TIDAK PERNAH: transfer dana, cancel/edit
scheduler bank, atau approve top-up secara otomatis. Semua eksekusi tetap
manual oleh FA — sistem hanya memberi ALERT + RECOMMENDATION + REMINDER,
dan FA meng-acknowledge (catat tindak lanjut, bukan aksi bank).

`funding_source_code` (BNI/BRI) **BUKAN** `bct_bank_accounts` — itu adalah
sumber dana yang mentransfer, bukan rekening yang saldonya dipantau (yang
dipantau tetap rekening existing di `bct_bank_accounts`, saat ini hanya
OCBC yang punya adapter rekonsiliasi). Kolom bertipe `VARCHAR(30)` bebas,
bukan enum/FK, supaya sumber baru bisa ditambah tanpa migration.

## 2. Baseline BNI Multibiller (seed awal)

Opening planned balance Rp200.000.000. 24 baris (`hour_of_day` 0-23,
`average_burn`, `planned_balance`) + 8 baris scheduler:

| Jam | Sumber | Nominal |
|---|---|---|
| 01:00 | BRI | Rp100.000.000 |
| 07:00 | BNI | Rp100.000.000 |
| 09:00 | BNI | Rp150.000.000 |
| 11:00 | BNI | Rp150.000.000 |
| 13:00 | BNI | Rp150.000.000 |
| 15:00 | BNI | Rp150.000.000 |
| 17:00 | BNI | Rp150.000.000 |
| 19:00 | BNI | Rp150.000.000 |

Seed di `backend/src/migrations/add_balance_control_tower_funding_scheduler.sql`,
scoped ke bank dengan `bank_code = 'OCBC'` (satu-satunya rekening
ter-monitor di production saat ini), idempotent (`ON CONFLICT ... DO
NOTHING` — tidak menimpa baseline yang sudah diedit admin).

**Planned Balance adalah source of truth** untuk target saldo per jam.
`average_burn` (Nominal Average) dipakai sebagai hourly expected burn —
formula validasi (`planned[t-1] - burn[t] + scheduler[t] ≈ planned[t]`)
HANYA untuk anomaly detection (`GET .../baseline-check`), **tidak pernah**
menimpa nilai `planned_balance` yang sudah ada di baseline.

## 3. Decision Engine (pure functions)

`backend/src/balanceControlTower/fundingSchedulerEngine.js` — semua
kalkulasi murni JS, tanpa DB, testable. Entry point utama:
`calculateFundingSchedulerAssistant({ now, hourlyPlan, schedulers,
actualBalance, actualBalanceStale, planVarianceTolerance,
schedulerTolerance })`.

### Alur
```
ACTUAL BALANCE (resolver existing BCT)
  -> compare -> PLANNED BALANCE jam berjalan (Asia/Jakarta) -> variance
  -> forecast burn s.d. NEXT SCHEDULER (fraksi jam berjalan + jam penuh di antaranya)
  -> PROJECTED BALANCE sebelum scheduler = actual - burn + confirmed inflow
  -> compare dengan TARGET (planned_balance jam scheduler)
  -> REQUIRED FUNDING = MAX(0, target - projected)
  -> compare dengan EXISTING scheduled_amount -> CANCEL/REDUCE/KEEP/ADD
```

### Variance (Rule A/B/C)
- `variance = actual − planned_balance[jam berjalan]`
- `|variance| <= tolerance` → **ON_PLAN** (info hijau, tidak alert keras)
- `variance > tolerance` → **ABOVE_PLAN** ("Saldo di atas rencana")
- `variance < -tolerance` → **BELOW_PLAN** ("Saldo di bawah rencana")
- Default tolerance Rp10.000.000, configurable per bank
  (`bct_balance_policies.funding_plan_variance_tolerance`).

### Recommendation (tangga CANCEL → REDUCE → KEEP → ADD)
```
CANCEL : required_funding <= scheduler_tolerance
REDUCE : required_funding > tolerance  DAN required_funding < existing - tolerance
KEEP   : |required_funding - existing| <= tolerance
ADD    : required_funding > existing + tolerance
```
Default `scheduler_tolerance` Rp10.000.000, configurable
(`bct_balance_policies.funding_scheduler_tolerance`). Mutually exclusive &
exhaustive — dibuktikan lewat 41 test case (lihat Bagian 7).

### Fail-safe (tidak pernah mengarang rekomendasi finansial)
| Kondisi | Recommendation |
|---|---|
| Actual balance basi (stale) menurut policy BCT existing | `DATA_STALE` |
| `actual_balance`/hourly plan jam berjalan/`average_burn`/`planned_balance` kosong | `INSUFFICIENT_DATA` (+ `missing_fields[]`) |
| Tidak ada scheduler SCHEDULED/CONFIRMED/ADJUSTED tersisa hari ini | `NO_UPCOMING_SCHEDULER` |
| >1 scheduler aktif di menit yang sama (duplicate) | `INSUFFICIENT_DATA` |
| Target `planned_balance` jam scheduler berikutnya kosong | `INSUFFICIENT_DATA` |
| `scheduled_amount` scheduler tidak valid (negatif/NaN) | `INSUFFICIENT_DATA` |

## 4. Sumber Actual Balance — REUSE PENUH, tidak ada saldo baru

`backend/src/balanceControlTower/fundingSchedulerDataAccess.js` →
`resolveActualBalance()`:
- Bank ber-adapter rekonsiliasi (saat ini hanya OCBC,
  `isSupportedBank()`): panggil `computeOperationalCalculationForBank()`
  (mesin operasional existing, SAMA yang dipakai status/Command Center) →
  `operational.available_balance`, staleness dari
  `operational.data_freshness_status` (`STALE`/`UNAVAILABLE`).
- Bank tanpa adapter: snapshot manual/API terbaru
  (`pickCurrentAndPrevious`, SAMA util classifier lama), staleness dari
  `policy.stale_after_minutes` vs `captured_at`.

Tidak ada query saldo baru yang dibuat khusus fitur ini.

## 5. Skema Database (additive only)

Migration: `backend/src/migrations/add_balance_control_tower_funding_scheduler.sql`
Runner: `node backend/scripts/run-balance-control-tower-funding-scheduler-migration.js`

- **`bct_hourly_balance_plan`** — baseline saldo per jam. Satu baris AKTIF
  per `(bank_account_id, hour_of_day)` (`UNIQUE ... WHERE is_active=TRUE`);
  edit admin = UPDATE baris aktif itu (bukan versioning baru per edit).
- **`bct_funding_scheduler_plan`** — baseline jadwal funding (recurring
  harian, bukan instance per-tanggal — lihat Batasan §9). Satu baris AKTIF
  per `(bank_account_id, scheduled_time)`. `status` ENUM `SCHEDULED /
  CONFIRMED / CANCELLED / ADJUSTED / COMPLETED / MISSED`.
- **`bct_funding_recommendation_history`** — audit trail kalkulasi +
  acknowledgement. Insert HANYA saat rekomendasi berubah material atau saat
  FA acknowledge (dedupe, bukan tiap polling — lihat Bagian 8).
- **`bct_balance_policies`** (existing, reuse) — 2 kolom baru:
  `funding_plan_variance_tolerance`, `funding_scheduler_tolerance`
  (`NUMERIC(18,2) NOT NULL DEFAULT 10000000`).
- **`bct_alerts`** (existing, reuse) — `chk_bct_alerts_type` diperluas
  (superset, tidak menghapus nilai lama): `ABOVE_PLAN`, `BELOW_PLAN`,
  `SCHEDULER_CANCEL`, `SCHEDULER_REDUCE`, `SCHEDULER_ADD`,
  `SCHEDULER_MISSED`.

Semua nominal `NUMERIC(18,2)`. Tidak ada `DROP`/`TRUNCATE`/destructive
rename apa pun.

## 6. API

Prefix router existing: `/api/warroom/balance-control-tower` (JWT via
`requireAuth` global di `app.js`, tidak berubah).

| Method | Path | RBAC |
|---|---|---|
| GET | `/banks/:id/funding-scheduler` | requireAuth (semua role login) |
| POST | `/banks/:id/funding-scheduler/acknowledge` | `requireFinance` (FA/admin) |
| GET | `/banks/:id/funding-scheduler/history` | requireAuth |
| GET | `/banks/:id/funding-scheduler/hourly-plan` | requireAuth |
| PUT | `/banks/:id/funding-scheduler/hourly-plan/:hour` | `requireAdmin` |
| GET | `/banks/:id/funding-scheduler/scheduler-plan` | requireAuth |
| POST | `/banks/:id/funding-scheduler/scheduler-plan` | `requireAdmin` |
| PUT | `/banks/:id/funding-scheduler/scheduler-plan/:schedulerId` | `requireAdmin` |
| GET | `/banks/:id/funding-scheduler/baseline-check` | requireAuth |
| PUT | `/banks/:id/policy` (existing, extended) | `requireAdmin` — 2 field toleransi baru, aman utk pemanggil lama (lihat §7) |

Response `GET .../funding-scheduler` (ringkas): `actual_balance`,
`actual_balance_source`, `actual_balance_stale`, `current_plan {hour,
planned_balance, average_burn, variance, variance_pct, status}`,
`next_scheduler {id, scheduled_time, funding_source_code, scheduled_amount,
target_planned_balance, projected_balance_before, required_funding,
adjustment_amount, recommendation, recommendation_reason}`, `recommendation`,
`reason`, `plan_24h[]`, `scheduler_timeline[]`.

## 7. RBAC

Reuse middleware existing (`requireAdmin`/`requireOpsOrFinance`/
`requireFinance`, sudah enforce di backend, bukan cuma sembunyikan tombol):
- **FA**: lihat rekomendasi + acknowledge (`requireFinance`).
- **OP**: lihat (endpoint GET tidak dibatasi lebih ketat dari GET BCT
  lainnya — konsisten dengan `/summary`, `/banks/:id`, `/command-center`).
- **Admin**: kelola hourly plan, scheduler plan, toleransi (via PUT
  `/policy` yang sudah ada).

**Penting — kenapa toleransi TIDAK dapat endpoint PUT partial sendiri**:
endpoint `PUT /banks/:id/policy` yang sudah ada didesain full-form (semua
field policy dikirim sekaligus, form modal existing sudah prefill semua).
Kalau saya buat endpoint partial baru khusus 2 field toleransi ini, field
lain akan ter-null-kan tiap kali dipanggil terpisah dari form utama (regresi
serius pada policy OCBC yang sudah dikonfigurasi). Solusi: 2 field baru
ditambahkan ke **form modal Policy existing** (frontend) + resolusi
undefined→nilai-existing di backend (bukan default 10jt buta) supaya
pemanggil lama (yang belum tahu field ini) tetap aman.

## 8. Alert Dedupe

`bct_alerts` (existing) di-reuse, TAPI dedupe/resolve untuk 6 alert_type
baru **terpisah total** dari `syncAlertsForBank()` (status operasional
bank) — kalau dicampur, alert scheduler ini akan langsung ter-auto-resolve
tiap kali `/summary` dipanggil (fungsi itu me-resolve SEMUA alert OPEN
selain tipe status bank saat itu). Fungsi baru
`syncFundingSchedulerAlerts()` hanya resolve/insert di antara 6 tipe
miliknya sendiri. KEEP tidak membuat alert (info hijau saja, sesuai spec).
`SCHEDULER_MISSED` hanya dibuat saat admin/FA eksplisit set status scheduler
= `MISSED` (tidak ada deteksi otomatis — lihat Batasan §9).

## 9. Batasan yang Diketahui (Known Limitations)

1. **Scheduler plan adalah template recurring harian, bukan instance
   per-tanggal.** `status` di `bct_funding_scheduler_plan` adalah baseline
   admin-level (biasanya `SCHEDULED`), bukan status eksekusi harian.
   Timeline menampilkan status **derived** (`deriveSchedulerDisplayStatus`):
   waktu sudah lewat + status masih SCHEDULED/CONFIRMED/ADJUSTED →
   ditampilkan "COMPLETED" (diasumsikan berjalan sesuai rencana — BRIC
   tidak punya feed konfirmasi eksekusi transfer bank BNI/BRI real-time).
   Acknowledge FA **tidak mengubah** baris scheduler plan — hanya
   tercatat sebagai baris riwayat terpisah (snapshot + user + note),
   supaya rekomendasi hari berikutnya tetap dihitung fresh dari baseline,
   bukan "terkunci" oleh keputusan hari sebelumnya.
2. **Tidak ada validasi realisasi funding otomatis** dari rekonsiliasi
   BNI/BRI (keduanya belum punya adapter — hanya OCBC). `actual_amount`/
   `actual_time` di scheduler plan tetap kosong kecuali diisi manual lewat
   admin panel.
3. **Chart 24 jam** menampilkan Actual Balance hanya sebagai satu titik di
   jam berjalan (histori actual per-jam tidak disimpan di rilis ini) —
   Planned Balance tetap tampil penuh 24 titik.
4. **Rekomendasi hanya untuk NEXT scheduler** — scheduler lain di timeline
   (masa lalu maupun jauh ke depan) tidak pernah dihitung ulang pakai
   actual balance sekarang (sesuai spec).

## 10. Timezone

Semua kalkulasi jam pakai `Intl.DateTimeFormat` dengan `timeZone:
'Asia/Jakarta'` eksplisit (`getJakartaParts()`) — tidak bergantung
timezone OS/server. Diuji lewat test case timezone (00:05 WIB, 14:23 WIB).

## 11. Test

`node backend/scripts/test-funding-scheduler.js` — 41 test (pola sama
dengan `test-qris-control-tower.js`, `assert` built-in, tanpa dependency
baru karena project belum punya test framework). Cakupan: CANCEL, REDUCE,
KEEP, ADD (termasuk 4 skenario bisnis persis dari spec, angka tervalidasi
manual), ABOVE_PLAN, BELOW_PLAN, ON_PLAN, DATA_STALE, INSUFFICIENT_DATA,
NO_UPCOMING_SCHEDULER, duplicate scheduler, timezone, tolerance boundary,
rounding/desimal, baseline formula validation.

## 12. Deployment

Ikuti safe deploy flow existing (`scripts/safe_deploy.py`,
`--confirm-new-commit`). Urutan: commit → push → backup DB (`scripts/backup_db.py`,
keyword `BACKUP` manual) → migration (`run-balance-control-tower-funding-scheduler-migration.js`,
keyword `MIGRATE` manual) → verifikasi migration → `safe_deploy.py --execute
--confirm-new-commit` (keyword `DEPLOY` manual) → production smoke test.

## 13. Rollback

- **Migration**: additive, aman dibiarkan meski deploy di-rollback (tidak
  mengubah data existing apa pun). Kalau benar-benar perlu direvert:
  `DROP TABLE bct_funding_recommendation_history, bct_funding_scheduler_plan,
  bct_hourly_balance_plan;` + `ALTER TABLE bct_balance_policies DROP COLUMN
  funding_plan_variance_tolerance, DROP COLUMN
  funding_scheduler_tolerance;` + kembalikan `chk_bct_alerts_type` ke
  daftar lama — **jangan dijalankan tanpa approval eksplisit**, tidak ada
  data existing lain yang perlu direstore.
- **Backend/Frontend**: restore dari backup `/var/www/bric_backup_*` (ada
  otomatis dari `safe_deploy.py`) + `git revert` komit terkait, lalu
  `pm2 reload` via user `admin`.
