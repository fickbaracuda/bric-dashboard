# BRIC Dashboard — Knowledge End-to-End

> Dokumen ini adalah gambaran LENGKAP dan TERKINI dari seluruh sistem BRIC Dashboard,
> mencakup fitur-fitur yang **tidak/belum tercatat di `CLAUDE.md`** (CLAUDE.md sudah
> agak ketinggalan — banyak fitur besar ditambahkan setelah ditulis). Baca dokumen ini
> untuk gambaran menyeluruh; baca `CLAUDE.md` untuk detail teknis War-Room yang sudah
> lama ada (InstaQris Segmen, Speedcash, PA Produk lama, MGM PA, Ekspedisi, Fastpay,
> Farming, ASDP/LPD, DM Fastpay, Hunter, InstaQris TRX, QRIS Control Tower).

---

## 1. Apa itu BRIC

Dashboard analitik bisnis internal BMS Retail (bmsretail.my.id). Tiga unit bisnis
utama: **Winme & InstaQris**, **Payment Agent** (puluhan sub-produk War Room), dan
**Speedcash/Dompet Digital** — ditambah cluster **Rekonsiliasi Bank** (6 bank) dan
**Balance Control Tower** yang berdiri agak terpisah secara organisasi (dipakai tim
Finance/Operasional, bukan cuma leader/tim penjualan).

## 2. Stack & Infrastruktur (ringkas — detail lengkap ada di CLAUDE.md)

- **Frontend**: React 18 + Vite + react-router-dom v6, Chart.js, Tabler Icons, axios.
- **Backend**: Node.js + Express, JWT (`requireAuth`), bcryptjs, helmet, compression,
  express-rate-limit. Listen `127.0.0.1:3001` di belakang Nginx.
- **Database**: PostgreSQL (`bricuser`), pool di `backend/src/db.js`.
- **Process manager**: PM2 v7, jalan sebagai user `admin` (BUKAN root).
- **VPS**: `147.139.201.43`, repo di `/home/admin/bric-dashboard`, frontend static di
  `/var/www/bric/`.
- **Auth model**: JWT untuk semua endpoint GET/CRUD; **token statis** (`x-sync-token`
  / `Authorization: Bearer` / body `token`) untuk semua endpoint `POST .../sync` yang
  dipanggil Google Apps Script — bypass JWT sepenuhnya.

### 2.1 Evolusi Deployment Safety (PENTING — baca sebelum menyentuh deploy/migration/backup)

Proyek ini pernah diaudit keamanan (`docs/DEPLOYMENT_SAFETY.md`) setelah ditemukan:
password VPS & token sync hardcoded di banyak file, restart backend sering pakai
`pkill` + `nohup` manual sebagai root (bypass PM2), build gagal tetap ter-deploy diam-
diam, tidak ada backup DB/frontend sebelum perubahan, tidak ada jalur rollback cepat.

**Perbaikan yang sudah dibangun** (folder `scripts/`, semua pakai `deploy_common.py`):

| Script | Fungsi | Gerbang konfirmasi |
|---|---|---|
| `scripts/safe_deploy.py` | Deploy 8 langkah: cek git status server (hanya path yang dikenal aman/dikonfirmasi pemilik boleh lolos, lainnya STOP) → git pull (STOP kalau ada commit baru, kecuali `--confirm-new-commit`) → preflight check → `npm run build` (STOP kalau gagal) → backup `/var/www/bric` → copy → `sudo -u admin pm2 reload bric-backend` (TIDAK PERNAH pkill/nohup) → health check → instruksi rollback kalau gagal | ketik `DEPLOY` |
| `scripts/backup_db.py` | `pg_dump` ke server + salin ke lokal | ketik `BACKUP` |
| `scripts/check_server_readonly.py` | Audit read-only (git/PM2/health/env var **presence**-only, Nginx -t, preflight) — **tidak ada gerbang**, aman dijalankan kapan saja | — |
| `scripts/deploy_common.py` | Helper SSH bersama + `mask()` untuk redact secret di log | — |
| `scripts/run_dm_control_tower_migration_remote.py`, `scripts/run_payment_agent_produk_migration_remote.py` | Migration runner khusus 1 fitur per script, verifikasi tabel sesudahnya | ketik `MIGRATE` |
| `scripts/validate_dm_control_tower_sync.py` | Validasi hasil sync DM Control Tower | — |

**Semua gerbang konfirmasi (`BACKUP`/`MIGRATE`/`DEPLOY`) memakai `input()` interaktif
di keyboard — SENGAJA tidak bisa dilewati lewat pipe/otomatisasi.** Ini kontrol keras
yang harus dihormati oleh AI mana pun yang bekerja di repo ini: kalau ketemu gerbang
ini, **berhenti dan minta pemilik project yang mengetik sendiri**, jangan cari cara
melewatinya (termasuk tidak boleh `echo KATA | python script.py`).

**SSH akses**: sejak 2026-07-03 ada SSH key alias `bric-prod` di `~/.ssh/config` —
`deploy_common.py` otomatis pakai ini (tanpa password) kalau ada, fallback ke
password interaktif kalau tidak ada.

**`safe_deploy.py` punya 2 whitelist path** yang boleh "dirty" di git status server
tanpa men-STOP proses:
- `KNOWN_SAFETY_PREFIXES`/`KNOWN_SAFETY_EXACT_BASES` — tooling safety itu sendiri
  (dikirim manual via SFTP, bukan git): `scripts/`, `docs/`, `backend/src/config/`, dll.
- `USER_CONFIRMED_PREEXISTING_PATHS` — daftar eksplisit file FITUR yang pemilik
  project SUDAH KONFIRMASI memang live di production tapi belum sempat di-commit
  (per 2026-07-02, plus package-lock.json per 2026-07-30). File di luar 2 daftar ini
  akan men-STOP deploy — ini jaring pengaman utama supaya tidak ada perubahan tak
  dikenal ikut ter-deploy diam-diam.

---

## 3. Backend — Peta Route Lengkap (`backend/src/app.js`)

Urutan registrasi PENTING: semua `POST .../sync` didaftarkan SEBELUM
`app.use('/api/warroom', requireAuth, warroomRoutes)` (catch-all) supaya bisa
bypass JWT. Berikut peta **lengkap per cluster** (termasuk yang tidak ada di
CLAUDE.md):

### 3.1 Cluster Winme & InstaQris
| Fitur | Route file | Endpoint utama |
|---|---|---|
| Scoreboard/Winme/PA/Dompet Digital | `scoreboard.js`, `winme.js`, `paymentagent.js`, `dompetdigital.js` | lihat CLAUDE.md |
| **InstaQRIS Command Center** *(baru)* | `warroom-instaqris-command-center.js` | `GET .../instaqris-command-center/{months,analytics}` — **read-only**, agregasi dari `iq_raw_outlet/qris/trx` (tabel yang sama dipakai `data-raw.js`), TIDAK ADA sync sendiri |
| **Quick Win Q3 IQWM** *(baru)* | `warroom-quick-win-q3.js` | `POST .../quick-win-q3/sync` (token `QUICK_WIN_Q3_SYNC_TOKEN`), `GET .../{periods,analytics}` |
| InstaQris Segmen, InstaQris TRX, Data Raw, QRIS Control Tower, InstaQris-Analitik (iq-raw), Penerbitan QRIS, Transaksi by Outlet | berbagai file | **sudah didokumentasikan detail di CLAUDE.md** |

### 3.2 Cluster Payment Agent
| Fitur | Route file | Endpoint utama |
|---|---|---|
| **Produk** *(BARU — dibangun sesi ini)* | `warroom-payment-agent-produk.js` | lihat §4 di bawah |
| PA Produk (legacy Apr/Mei/Jun hardcode) | `warroom.js` bagian C | `pa-produk/sync`, `/analytics`, `/trendline` — **JANGAN disatukan** dengan Produk baru |
| `warroom_pa_produk_periode` (rolling m2/m1/curr) | migration ada (`create_warroom_pa_produk_periode.sql`) | **belum ada route aktif** — infrastruktur belum dipakai, jangan asumsikan sudah terintegrasi |
| Ekspedisi (outlet-level) | `warroom-ekspedisi.js` | sudah di CLAUDE.md |
| **Ekspedisi Produk** *(baru, domain terpisah dari di atas)* | `warroom-ekspedisi-produk.js` | `POST .../ekspedisi-produk/sync` (token `EKSPEDISI_PRODUK_SYNC_TOKEN`), `.../{months,analytics,outlets,product-detail,outlet-detail}` — status naik/turun/stabil/zero_activity, priority P0-P4 |
| MGM PA, Hunter, DM Fastpay, ASDP, PA-ASDP, LPD, PA-LPD, BUMDes | berbagai file | sudah di CLAUDE.md (Farming per baris di bawah SUDAH DI-UPGRADE, jangan pakai deskripsi Farming lama di CLAUDE.md) |
| **Farming (Farming Fastpay Command Center)** *(UPGRADE penuh, bukan fitur baru)* | `warroom-farming.js` | lihat §4b di bawah — domain baru `farming_outlet_snapshot`, tabel lama `farming_snapshot` tidak disentuh |
| **DM Control Tower** *(baru)* | `warroom-dm-control-tower.js` | lihat §5 di bawah |

### 3.3 Cluster Speedcash
Sudah lengkap di CLAUDE.md (`warroom.js` bagian B).

### 3.4 Cluster Rekonsiliasi & Finance *(SELURUHNYA baru, tidak ada di CLAUDE.md)*
| Fitur | Route file | Ringkas |
|---|---|---|
| Rekonsiliasi OCBC (base) | `warroom-reconciliation.js` (2422 baris) | lihat §6 |
| Rekonsiliasi Mandiri | `warroom-reconciliation-mandiri.js` | adapter `reconciliation/mandiriAdapter.js` |
| Rekonsiliasi BRI | `warroom-reconciliation-bri.js` | adapter `reconciliation/briAdapter.js` |
| Rekonsiliasi BRI BI-FAST | `warroom-reconciliation-bri-bifast.js` (1401 baris) | adapter `reconciliation/briBifastAdapter.js` |
| Rekonsiliasi BNI | `warroom-reconciliation-bni.js` | adapter `reconciliation/bniAdapter.js` |
| Rekonsiliasi BCA | `warroom-reconciliation-bca.js` | adapter `reconciliation/bcaAdapter.js` |
| **Balance Control Tower** | `balance-control-tower.js` (1610 baris) | lihat §7 |
| **Finance Balance Requests** | `finance-balance-requests.js` | lihat §8 |

### 3.5 Admin/Ops
Users, Server Monitor, AI Chat, Presence — sudah lengkap di CLAUDE.md.

---

## 4. Payment Agent → Produk *(fitur baru, dibangun & di-deploy pada sesi ini)*

**Marketing Decision Dashboard** untuk performa produk Payment Agent (MAT, TRX, REV,
ARPT, ATPU, ARPU), domain TERPISAH dari PA Produk lama dan `warroom_pa_produk_periode`.

- **Sumber**: Google Sheet `1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw`, tab "Produk".
- **Bulan 100% dinamis** — Apps Script baca label bulan dari header sheet, urutkan,
  bulan terakhir = current, pertama = baseline, tengah = previous.
- **Deviasi dipetakan POSISIONAL**, bukan berdasarkan teks: `compare_key` selalu
  `baseline_vs_current` atau `previous_vs_current` (compare_label tetap simpan teks
  asli sheet untuk audit).
- **Tabel**: `payment_agent_produk_metrics` (UNIQUE snapshot_date+month_key+product_label),
  `payment_agent_produk_deviation` (UNIQUE snapshot_date+compare_key+product_label),
  `payment_agent_produk_sync_log`, `payment_agent_produk_config`.
- **Endpoint**: `POST /api/warroom/payment-agent/produk/sync` (token
  `PAYMENT_AGENT_PRODUK_SYNC_TOKEN`, TIDAK ADA fallback hardcode), `GET .../{snapshots,
  analytics,detail,table}`.
- **Status**: no_data/kritis(rev≤0)/turun(≤-5%)/naik(≥+5%)/stabil, semua dibanding
  `previous_month`. **Priority** P0 (kritis atau turun & top-revenue) → P1 (turun lain,
  atau naik signifikan) → P2 (frequency problem: MAT stabil, TRX/ATPU turun) → P3
  (stabil) → P4 (no_data). **Segment**: Core Revenue Driver, Growth Product, Declining
  Product, High MAT Low Revenue, Low MAT High ARPU, Frequency Problem, Monetization
  Problem, Low Priority.
- **Frontend**: `frontend/src/pages/WarRoomPaymentAgentProduk.jsx`, route
  `/war-room/payment-agent/produk`, sidebar badge `PROD` (`#0EA5E9`), 6 tab: Overview,
  Product Ranking, Growth & Decline, Campaign Priority, Product Deep Dive, Data Quality.
- **Apps Script**: `apps-script-payment-agent-produk.js` — parser scan header dinamis
  (cari baris subheader berisi MAT/TRX/REV), fungsi `previewPaymentAgentProdukPayload()`
  / `pushPaymentAgentProdukSemua()` / `setupPaymentAgentProdukTrigger()` (BELUM aktif).
- **Detail lengkap**: `docs/PAYMENT_AGENT_PRODUK.md`.
- **Status deploy saat dokumen ini ditulis**: migration ✅, deploy ✅, sync token ✅
  ter-set di server, siap terima push pertama dari Apps Script.

---

## 4b. Payment Agent → Farming — Farming Fastpay Command Center *(upgrade penuh, sesi ini)*

**Route/menu TIDAK berubah** (`/war-room/farming`, badge `Nizar`, tema hijau)
tapi seluruh model data & business logic diganti total. Sumber: sheet
**"Farming"** di spreadsheet YANG SAMA dengan Payment Agent Produk
(`1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw`) — sheet berbeda, domain
BENAR-BENAR terpisah (parser/tabel/token semua beda).

- **Bulan/periode 100% dinamis** — Apps Script TIDAK melakukan interpretasi
  header sama sekali, hanya kirim `headers[]` + `rows[]` mentah. SEMUA parsing
  (`backend/src/farming/headerParser.js`) ada di backend: baseline_month
  (bulan header "Full"), previous_period (potongan hari, bulan SAMA dengan
  baseline), current_period (potongan hari, bulan berikutnya). `month_key`
  diturunkan dari `snapshot_date` (bukan teks label — nama bulan saja tidak
  punya info tahun).
- **Tabel baru**: `farming_outlet_snapshot`, `farming_sync_log`,
  `farming_outlet_followup` — tabel LAMA `farming_snapshot` (kolom hardcode
  Mei/Jun) TIDAK disentuh, tetap ada sebagai histori legacy.
- **BREAKING CHANGE Apps Script**: payload sync lama (`{tanggal, data:[...]}`)
  sudah TIDAK KOMPATIBEL — Apps Script lama akan gagal begitu backend baru
  live. Wajib pasang `apps-script-farming.js` yang baru.
- **Business logic** (`backend/src/farming/businessLogic.js`) dihitung SEKALI
  saat sync (bukan per-request) — status (churned/new_active/critical_decline/
  declining/rocket_growth/growing/stable/zero_activity), segmentasi 10 kelas,
  priority P0-P3 dengan konteks lintas-outlet (top-10% revenue-at-risk, top-20%
  kontributor revenue), semua tersimpan sebagai kolom siap query.
- **Endpoint**: `POST /api/warroom/farming/sync` (token `FARMING_SYNC_TOKEN`,
  beda dari token Produk), `GET .../{analytics,snapshots,action-queue,outlets,
  outlets/:id,trendline,data-quality,export,followup}`.
- **Frontend**: `WarRoomFarming.jsx` full rewrite, 7 tab (Command Center,
  Action Queue, Growth & Decline, ARPU & Monetization, Outlet Explorer, Daily
  Trend, Data Quality), CSS prefix `farm-cc-*`.
- **Temuan penting**: sebelum upgrade ini, menu "Farming" TIDAK punya link
  sidebar sama sekali (orphan route, sama seperti Payment Agent Produk lama
  sebelum ada §4) — sudah ditambahkan sebagai bagian dari upgrade ini.
- **Doc lengkap**: `docs/FARMING_COMMAND_CENTER.md`.
- **Test**: `backend/scripts/test-farming-command-center.js` (51 test, pure
  function, tanpa DB) — parser header (termasuk rollover tahun Des→Jan),
  parser angka, business logic, priority.

## 5. DM Control Tower

Funnel aktivasi outlet untuk channel Direct Marketing (register → aktivasi →
transaksi). KPI inti: **`handoff_farming`** — outlet yang kohort registrasinya sudah
matang (lewat H3) tapi belum pernah transaksi → wajib diserahkan ke tim Farming.

- **Tabel**: `dm_ct_raw_register`/`aktivasi` (UNIQUE bulan+id_outlet), `dm_ct_raw_trx`
  (UNIQUE bulan+row_hash MD5, banyak baris per outlet), `dm_ct_month_config` (source
  of truth periode dari sheet `01_CONFIG`, fallback "akhir bulan -3 hari"),
  `dm_ct_sync_log`.
- **8 segmen** (cascade): `anomaly` (P0, transaksi sebelum register/aktivasi),
  `repeat_h0_h3`/`tx1_h0_h3` (P3, sehat), `active_after_handoff` (P3), `late_tx` (P2),
  `handoff_farming` (P1, KPI utama), `activated_no_tx` (P1), `registered_only` (P2),
  `unknown` (P2).
- **Catatan performa**: klasifikasi dihitung 1x per request via temp table (dulu
  pernah jalan 13x paralel via `Promise.all` dan bikin Postgres stall 70+ detik —
  jangan ulangi pola itu).
- **Endpoint**: `POST .../register|aktivasi|trx/sync` (token `APPS_SCRIPT_TOKEN`,
  support `replace_mode: replace|append`), `GET .../{months,analytics,data-quality,
  outlets}`.
- **Frontend**: `/war-room/dm-control-tower`, badge `DM CT` (`#7F77DD`), tab:
  Overview, Cohort H0-H3, Segmentasi, Data Quality, Action Queue, Outlet Detail.
- **Doc**: `docs/DM_CONTROL_TOWER.md`.

---

## 6. Rekonsiliasi Bank (6 bank) — Engine Bersama

Rekonsiliasi harian transaksi internal Fastpay (FP) vs mutasi rekening bank, untuk
**OCBC** (base/default), **Mandiri**, **BRI**, **BRI BI-FAST**, **BNI**, **BCA**.
Semua berbagi 5 tabel inti (dibedakan kolom `bank_code`), 1 route "core engine"
(`warroom-reconciliation.js`), dan per-bank adapter murni di
`backend/src/reconciliation/{bank}Adapter.js`.

**Tabel bersama**: `recon_sync_batches` (UNIQUE business_date+bank_code),
`recon_fp_transactions`, `recon_bank_transactions` (SENGAJA tidak unique per
reference_no — 1 transfer BI-FAST = 2 baris: fee + pokok), `recon_results` (unique
index batch_id+id_transaksi+reference_no, di-upsert lintas resync supaya histori
resolve tidak hilang), `recon_action_logs`, `recon_sync_requests` (antrian tombol
"Sync Now" khusus OCBC, karena Apps Script Web App tidak bisa dipanggil langsung dari
dashboard — kebijakan Google Workspace).

**Endpoint per bank** (`{bank}` kosong untuk OCBC): `POST .../reconciliation{bank}/sync`
(token `APPS_SCRIPT_TOKEN`), `GET .../analytics`, `.../daily-report`,
`.../balance-needs-periodic` (engine `reconciliation/periodicBalanceNeeds.js`, dipakai
ulang oleh Balance Control Tower), `.../transactions`, `.../raw-bank`, `.../raw-fp`
(tidak ada di OCBC base), `.../resolution-history` (tidak ada di OCBC base),
`.../export`, `POST .../:id/resolve` (transaksional, catat before/after status ke
`recon_action_logs`), `GET .../:id/logs`.

**Status vocabulary umum**: `MATCHED, MATCHED_NO_FEE, PENDING_BANK, FP_ONLY, BANK_ONLY,
NOMINAL_MISMATCH, FEE_MISMATCH, DUPLICATE_FP, DUPLICATE_BANK, REVERSAL, NEED_REVIEW`
(dipakai OCBC/Mandiri/BRI/BRI-BIFAST/BNI). **BCA punya vocabulary sendiri**:
`MATCHED_AMOUNT_EXACT, FP_NOT_FOUND_IN_BANK, BANK_NOT_FOUND_IN_FP, AMOUNT_MISMATCH,
DUPLICATE_FP_TRANSACTION_ID, DUPLICATE_BANK_TRANSACTION_ID, MULTIPLE_BANK_ROWS_SAME_ID,
CREDIT_TRANSACTION, UNPARSEABLE_REFERENCE, UNKNOWN, REQUIRES_MAPPING_REVIEW`.

**Perbedaan per bank**:
- **OCBC**: matching by `id_transaksi`/reference_no; satu-satunya yang punya antrian
  `recon_sync_requests` + polling status.
- **Mandiri/BRI**: tambahan kolom `scope_mode`, `expected_fee`, `grace_period_minutes`,
  toleransi coverage; punya `raw-bank`/`raw-fp`/`resolution-history` (OCBC tidak).
- **BRI BI-FAST**: 1 transfer = 2 baris debit terpisah (pokok + fee Rp77, bukan 1
  baris gabungan). Matching key = `DATA FP.bill_info1 == beneficiary_account`
  (pola `BFST<digit>`), BUKAN `id_transaksi`. Badge kualitas tambahan:
  `time_order_status` (`NORMAL/WARNING/DELAYED/EXTREME/IMPOSSIBLE_ORDER`),
  `account_conflict`, `duplicate_bank_trace`, `orphan_fee_group`, `unbalanced`,
  `extraction_medium`.
- **BNI**: matching key = `id_transaksi` diekstrak dari teks Deskripsi bank (2 metode:
  hash `"BMS_SNAP API #<10 digit>"` atau 10 digit terakhir setelah `/`), bukan
  Reference No. `scope_mode` default `FP_COVERAGE_WINDOW`.
- **BCA**: tidak ada konsep baris fee terpisah; `scope_mode` selalu
  `FULL_BUSINESS_DATE`.

**Apps Script**: `apps-script-reconciliation-{ocbc,mandiri,bri,bri-bifast,bni,bca}.js`
di root repo.

**Doc per bank**: `docs/RECONCILIATION_{OCBC,MANDIRI,BRI,BRI_BIFAST,BNI}.md` (BCA
belum ada dokumen terpisah).

---

## 7. Balance Control Tower

Monitoring likuiditas lintas bank + rekomendasi top-up + alur maker-checker.
Dideskripsikan di commit sebagai *"dark ops command center"* untuk OCBC. Manual-first
(belum ada API bank live) — kolom `source` snapshot: `MANUAL`/`API`/`RECONCILIATION`
(`RECONCILIATION` sudah aktif untuk OCBC via refresh-on-read dari engine rekonsiliasi).

**Tabel**: `bct_bank_accounts`, `bct_balance_snapshots` (kolom `reserve_source`:
SNAPSHOT/POLICY_DEFAULT), `bct_balance_policies` (threshold
absolute_minimum/watch/critical/emergency/excess, `burn_window_minutes`,
`topup_lead_time_minutes`, `safety_buffer_type`), `bct_topup_requests` (status
DRAFT→REQUESTED→APPROVED→TRANSFERRED→BALANCE_CONFIRMED→COMPLETED, atau
REJECTED/CANCELLED), `bct_alerts` (status OPEN/ACKNOWLEDGED/RESOLVED, tipe
LOW_BALANCE/CRITICAL_BALANCE/EXCESS_BALANCE/DATA_STALE/SYNC_ERROR, max 1 OPEN per
bank+tipe), `bct_forecast_snapshots` (histori forecast eksplisit, hanya dibuat saat
`POST .../forecast/refresh`), `bct_audit_log`.

**RBAC di backend** (bukan cuma UI): `requireAdmin` (CRUD bank/policy),
`requireOpsOrFinance` (unit OP/FA — snapshot, request/cancel top-up), `requireFinance`
(unit FA — approve/reject/transfer/confirm-balance/complete). Maker-checker: requester
tidak bisa approve permintaannya sendiri.

**Cascade status `resolveFinalStatus()`** (satu sumber kebenaran dipakai summary,
detail, DAN alert supaya tidak ada 2 formula jalan bersamaan):
1. Sudden-drop check (prioritas tertinggi) → `SUDDEN_DROP`.
2. Kalau bank punya adapter rekonsiliasi & operational engine (burn-window intraday)
   berhasil → pakai status dari situ (`SAFE/WATCH/CRITICAL/EMERGENCY/DATA_STALE/
   CONFIGURATION_REQUIRED`), TIDAK jalankan cascade lama untuk bank ini.
3. Excess balance (legacy) — hanya kalau hasil operational = SAFE & policy set
   threshold excess.
4. Fallback ke cascade manual lama untuk bank tanpa adapter rekonsiliasi.

**Doc lengkap belum ada file terpisah** — lihat langsung `backend/src/routes/
balance-control-tower.js` dan `backend/src/utils/balanceControlTower.js`.

---

## 8. Finance Balance Requests

Antrian notifikasi ringan "tolong top-up rekening" dari tim Operasional ke Finance —
**BUKAN sistem yang sama** dengan alur top-up Balance Control Tower, ini standalone,
dipasang sebagai panel di dalam halaman Rekonsiliasi per-bank (tidak ada menu sidebar
sendiri).

- **Tabel**: `finance_balance_requests` (`bank_code` CHECK: OCBC/MANDIRI/BRI/
  BRI_BIFAST/BNI/BCA; status PENDING→ACKNOWLEDGED→TRANSFERRED).
- **Endpoint**: `POST /api/finance/balance-requests` (guard double-submit 10 detik),
  `GET .../pending` (FA only), `.../acknowledged?bank_code=` (FA only), `.../history`
  (semua user, sengaja transparan), `POST .../:id/acknowledge` & `.../mark-transferred`
  (FA only, UPDATE kondisional atomik supaya tidak race antar user FA), `GET .../:id`.

---

## 9. Frontend — Peta Lengkap Terkini

### 9.1 Sidebar (struktur aktual saat ini — CLAUDE.md sudah ketinggalan di bagian ini)

```
Unit Scoreboard
Leader Scoreboard
Winme & InstaQris (accordion)
  ├─ Scoreboard Tim
  ├─ War Room:
  │   InstaQRIS Command Center (CMD, #7F77DD)
  │   Quick Win Q3 (Q3, #0EA5E9)
  │   Instaqris - Analitik (IQ, #0EA5E9)
  │   Penerbitan QRIS (QRIS, #EC4899)
  │   QRIS Control Tower (CTL, #0891B2)
  │   Transaksi by Outlet (OUT, #2563EB)
  └─ Data Raw (RAW, #3B82F6)
Payment Agent (accordion)
  ├─ Scoreboard Tim
  └─ War Room:
      Produk (PROD, #0EA5E9)              ← BARU
      Ekspedisi (Okta, #8B5CF6)
      Produk Ekspedisi (PROD, #0EA5E9, indented)
      Farming (Nizar, #10B981)            ← ditambahkan (sebelumnya orphan, tanpa link sidebar)
      MGM PA (MGM, #10B981)
      Hunter (HNT, #F97316, indented)
      DM Fastpay (DM, #0EA5E9)
      DM Control Tower (DM CT, #7F77DD)
      ASDP (PA, #3B82F6)
      LPD (PA, #9333EA)
      BUMDes (PA, #0D9488)
Speedcash (accordion)
  ├─ Scoreboard Tim
  └─ WAR-ROOM Speedcash
Rekonsiliasi (accordion — SELALU tampil, termasuk untuk user unit OP/FA)
  Rekonsiliasi OCBC (REK, #DC2626)
  Rekonsiliasi Mandiri (MDR, #003D79)
  Rekonsiliasi BRI (BRI, #00529C)
  Rekonsiliasi BRI BI-FAST (BRI BF, #00529C)
  Rekonsiliasi BNI (BNI, #F15A23)
  Rekonsiliasi BCA (BCA, #0033A0)
  Balance Control Tower (BCT, #0D9488)
Server Monitor (admin only)
Kelola User (admin only)
```

Seluruh section di atas (kecuali Rekonsiliasi) **disembunyikan total** untuk user
dengan `unit ∈ {OP, FA}` (user rekonsiliasi-only).

### 9.2 Route "orphan" (ada di `App.jsx`, TIDAK ada link sidebar — hanya via URL manual)
- `/war-room/instaqris` (legacy `WarRoom.jsx`)
- `/war-room/asdp` (single-snapshot `WarRoomAsdp.jsx`)
- `/war-room/lpd` (single-snapshot `WarRoomLpd.jsx`)
- `/dashboard`, `/tren`, `/per-unit`, `/laporan` (stub `ComingSoon`)
- `WarRoomAffiliateAnalitik.jsx` — dead code, sengaja direvert, jangan diaktifkan
  tanpa konfirmasi user (lihat CLAUDE.md §Catatan).

### 9.3 CSS
Semua di `frontend/src/index.css` (satu file besar), tiap fitur baru menambah
section dengan prefix sendiri (`eprod-*`, `dmct-*`, `wrr-*`/`wrrm-*`/`wrrbri-*`
rekonsiliasi, `pa-prod-*` Payment Agent Produk, dst). Dark mode via atribut
`[data-theme="dark"]` di root (bukan `prefers-color-scheme`), semua warna pakai
`var(--token)` (`--bg-card`, `--bg-elevated`, `--bg-hover`, `--border`, `--text-1..4`,
`--text-muted`, dst) supaya otomatis kontras di kedua mode.

---

## 10. Inventaris Migration (`backend/src/migrations/`)

31 file. Yang **TIDAK ADA** di inventaris tabel CLAUDE.md (representasi utama gap
dokumentasi — semua sudah dijelaskan domainnya di §4-8 di atas):

`create_dm_control_tower.sql`, `create_quick_win_q3_iqwm.sql`,
`create_balance_control_tower.sql` + 4 file `add_balance_control_tower_*.sql`,
`add_finance_balance_requests.sql` + 3 follow-up, `create_reconciliation_ocbc.sql`,
`add_reconciliation_{bca,bni,bri,bri_bifast,mandiri}_columns.sql`,
`add_reconciliation_canonical_transaction_key{,_unique}.sql`,
`add_reconciliation_ocbc_{archive_business_date_index,coverage}.sql`,
`create_recon_sync_requests.sql`, `create_ekspedisi_produk.sql`,
`create_payment_agent_produk.sql`, `create_warroom_pa_produk_periode.sql`
(belum ada route aktif), `create_farming_command_center.sql` (didokumentasikan
di §4b dokumen ini — `farming_outlet_snapshot`/`farming_sync_log`/
`farming_outlet_followup`, terpisah dari `farming_snapshot` lama).

Sudah terdokumentasi baik di CLAUDE.md: `create_ekspedisi_{monthly,outlet_status,
snapshot}.sql`, `create_farming_snapshot.sql`, `create_fastpay_snapshot.sql`,
`create_qris_control_tower.sql`, `hunter_tables.sql` (di `backend/migrations/`,
bukan `backend/src/migrations/`).

---

## 11. Catatan untuk sesi AI berikutnya

1. **`CLAUDE.md` masih valid untuk fitur lama** (semua yang tercantum di sana), tapi
   **tidak lengkap** untuk fitur di dokumen ini. Kalau bekerja di area yang tidak ada
   di CLAUDE.md, cek dulu route file aslinya — jangan asumsikan.
2. Jangan pernah menyatukan tabel-tabel yang secara eksplisit dipisahkan pemiliknya:
   PA Produk lama vs `warroom_pa_produk_periode` vs Payment Agent Produk baru;
   Ekspedisi (outlet) vs Ekspedisi Produk; War Room Ekspedisi legacy
   `ekspedisi_snapshot` vs `ekspedisi_monthly`.
3. Semua endpoint `POST .../sync` baru WAJIB terdaftar sebelum catch-all
   `/api/warroom` di `app.js`, dan token env-nya WAJIB tanpa fallback hardcode (fail
   401 kalau env belum diset) — pola yang konsisten dipakai sejak `EKSPEDISI_PRODUK_
   SYNC_TOKEN`, `QUICK_WIN_Q3_SYNC_TOKEN`, `PAYMENT_AGENT_PRODUK_SYNC_TOKEN`.
4. **Jangan pernah bypass gerbang konfirmasi manual** (`BACKUP`/`MIGRATE`/`DEPLOY`) di
   `scripts/*.py` — ini kontrol keras hasil audit keamanan, bukan formalitas.
5. Rekonsiliasi & Balance Control Tower dipakai tim Finance/Operasional (unit OP/FA)
   yang HANYA melihat cluster Rekonsiliasi di sidebar — hati-hati kalau mengubah
   RBAC/hide-menu logic di `Sidebar.jsx`.
6. File ini (`BricKnowledge.MD`) dan `CLAUDE.md` **tidak saling menggantikan** —
   `CLAUDE.md` adalah instruksi proyek yang di-load otomatis tiap sesi Claude Code
   (system prompt), file ini murni referensi manual untuk dibaca manusia/AI yang
   butuh gambaran menyeluruh sekali baca.
