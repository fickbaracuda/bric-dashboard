# BRIC Dashboard — Dokumentasi Teknis Lengkap

## Overview
Dashboard analitik bisnis untuk BMS Retail (bmsretail.my.id). Diakses oleh tim internal (leader, tim, admin) untuk memonitor performa unit bisnis: Winme & InstaQris, Payment Agent (dengan puluhan sub-produk War Room), dan Speedcash/Dompet Digital. Berisi juga fitur AI Chat (Gemini), Server Monitor, dan Data Raw browser.

## Autonomous Development Workflow

Task development apa pun (fitur baru, perbaikan bug, revisi, "sampai live") **otomatis**
mengikuti alur di `.claude/skills/bric-release/SKILL.md` — branch per developer,
self-review, test, lalu release lewat gerbang manual BACKUP/MIGRATE/DEPLOY
(`scripts/`). Aturan pendukung modular ada di `.claude/rules/` (arsitektur,
git workflow, production safety, security). Identitas developer per komputer
disimpan di `CLAUDE.local.md` (machine-local, tidak ikut Git — lihat
`CLAUDE.local.md.example`). Baca `.claude/skills/bric-release/SKILL.md`
kalau butuh detail workflow-nya; jangan duplikasikan isinya ke sini.

## Stack
- **Frontend**: React 18 + Vite + react-router-dom v6, Chart.js (`import Chart from 'chart.js/auto'`), Tabler Icons webfont CDN, axios
- **Backend**: Node.js + Express.js, JWT auth via `requireAuth` middleware, bcryptjs, helmet, compression, express-rate-limit
- **Database**: PostgreSQL via `pool` (backend/src/db.js), user: `bricuser`, koneksi via `DATABASE_URL` (SSL otomatis aktif jika URL mengandung "neon")
- **Data source**: `backend/data/scoreboard.json` (sync dari Google Sheets, untuk Scoreboard/Winme/PA/Dompet Digital) + puluhan tabel PostgreSQL (untuk semua WAR-ROOM)
- **Process manager**: **PM2 v7.0.1** (berjalan sebagai user `admin`, bukan root — `pm2 list` dari root terlihat kosong, harus `sudo -u admin pm2 list`)
- **Web server**: Nginx, frontend static di `/var/www/bric/`, backend Express listen `127.0.0.1:3001` (proxy_pass dari nginx)

## VPS
- IP: 147.139.201.43
- User SSH: root (password: lihat catatan terpisah — JANGAN ditulis plaintext di file manapun di repo ini)
- Repo di VPS: `/home/admin/bric-dashboard`
- Deploy: git pull → npm run build (frontend) → cp dist/* /var/www/bric/ → `sudo -u admin pm2 reload bric-backend`
- Deploy via Python paramiko dari lokal (Node.js tidak ada di PATH lokal Windows) — lihat banyak script `deploy_*.py` di root repo (deploy_full.py, deploy_frontend.py, deploy_migration.py, deploy_hunter.py, deploy_wb.py, deploy_dm.py, deploy_pa_lpd.py), serta `check_backend.py`, `check_nginx.py`, `fix_nginx.py`, `restart_backend.py`, `test_sync.py` untuk debugging jarak jauh
- PM2 logs: `/home/admin/.pm2/logs/bric-backend-out.log` dan `/home/admin/.pm2/logs/bric-backend-error.log`
- Backend env vars (lihat `backend/.env.example`): `PORT=3001`, `DATABASE_URL`, `JWT_SECRET` (default fallback `bric-jwt-secret-2026`), `ADMIN_PASSWORD`, `VIEWER_PASSWORD`, `APPS_SCRIPT_URL`, `APPS_SCRIPT_TOKEN=bric2026bimasaktisecret`, `ALLOWED_ORIGIN`

---

# BAGIAN 1 — BACKEND

## Struktur Backend (`backend/src/`)
```
app.js                          — route registration hub, middleware, health check
db.js                            — PostgreSQL pool (DATABASE_URL, max 20, idle 30s, ssl utk neon)
middleware/auth.js               — requireAuth (JWT), bypass utk path '/sync' POST
routes/
  auth.js                        — login, seed default user admin/viewer
  scoreboard.js                  — sync + units (data dari scoreboard.json + daily_snapshot)
  users.js                       — CRUD user (admin only)
  winme.js                       — GET /api/winme (Winme & InstaQris group)
  paymentagent.js                — GET /api/paymentagent (unit tunggal, pace analysis)
  dompetdigital.js               — GET /api/dompetdigital (3 sub-unit: SpeedCash/Travel B2C/Pulsagram)
  members.js                     — CRUD leader & tim, targets, pencapaian harian
  presence.js                    — ping tiap 30s, in-memory active user list (TTL 2 menit)
  ai.js                          — Gemini 2.5 Flash chat, retry 3x backoff, rate limit 20/menit/user
  ai-context.js                  — system prompt builder (load semua data dashboard), chat_history CRUD
  system.js                      — Server Monitor: CPU, RAM, disk, PostgreSQL stats
  data-raw.js                    — sync + analytics utk 4 tabel raw (outlet/affiliate/qris/trx), affiliate network, outlet segmentation
  warroom.js                     — WAR-ROOM InstaQris (segmen) + Speedcash + PA Produk + PA ARPU + MGM PA (5 domain dalam 1 file besar)
  warroom-ekspedisi.js           — WAR-ROOM Ekspedisi (sync multi-bulan + analytics + outlet-status + notes)
  warroom-fastpay.js             — WAR-ROOM Fastpay Global (sync + analytics + outlets, snapshot harian Mei/Jun)
  warroom-farming.js             — WAR-ROOM Farming (sync + analytics + outlets, period-based Mei/Jun)
  warroom-asdp.js                — WAR-ROOM ASDP (single snapshot, TIDAK ada kolom bulan, key = id_outlet saja)
  warroom-pa-asdp.js             — WAR-ROOM PA ASDP (multi-bulan, key = bulan+id_outlet)
  warroom-pa-lpd.js              — WAR-ROOM PA LPD (multi-bulan, chunked 500 baris, dedup)
  warroom-lpd.js                 — WAR-ROOM LPD standalone (single snapshot Mei vs Juni, key = id_outlet)
  warroom-bumdes.js              — WAR-ROOM BUMDes (multi-bulan, chunked 500 baris)
  warroom-dm-fastpay.js          — WAR-ROOM DM Fastpay (marketing/ads snapshot harian, 1 row per tanggal)
  warroom-hunter.js              — WAR-ROOM Hunter/PB (3 tabel D1/D2/D3, scoring & staging engine kompleks)
  warroom-instaqris-trx.js       — WAR-ROOM InstaQris TRX (segmentasi buyer behavior, export CSV)
  warroom-qris-control-tower.js  — QRIS Control Tower (4 tabel JSONB, stage engine, SLA, priority scoring)
```

### Middleware & Setup Global (`app.js`)
1. `compression({ level: 6, threshold: 1024 })`
2. `helmet({ contentSecurityPolicy: false })`
3. `app.disable('x-powered-by')`
4. `app.set('trust proxy', 1)` — wajib utk rate-limit + X-Forwarded-For di belakang nginx
5. Rate limit global: **1000 req/menit per IP** pada `/api/*` (dinaikkan dari 300 karena semua user kantor share satu NAT IP)
6. Rate limit login: **10 percobaan / 15 menit** pada `/api/auth/login`
7. `cors({ origin: process.env.ALLOWED_ORIGIN || '*' })`
8. `express.json({ limit: '30mb' })` — dinaikkan utk handle 40k+ baris dari Apps Script
9. Listen di `127.0.0.1:{PORT}` (default 3001) — bukan `0.0.0.0`, karena nginx yang expose ke publik
10. `GET /health` → `{ status: 'ok' }` (no auth)
11. 404 handler fallback: `{ error: 'Not found' }`

### Auth Model (2 jenis)
| Jenis | Dipakai di | Mekanisme |
|---|---|---|
| **JWT** (`requireAuth`) | Semua endpoint GET analytics/CRUD | Header `Authorization: Bearer <token>`, `jwt.verify(token, JWT_SECRET)`, payload `{ id, username, role, unit }`, expired 8 jam |
| **Token sync** (non-JWT) | Semua endpoint `POST .../sync` | Header `x-sync-token` ATAU `Authorization: Bearer <token>` ATAU body `{ token }` — tergantung file. Dipakai Google Apps Script, bypass JWT sepenuhnya |

`middleware/auth.js` — `requireAuth` juga punya bypass khusus: jika `req.path === '/sync' && req.method === 'POST'` maka skip JWT (tapi tetap harus lolos validasi token di dalam handler masing-masing).

**Sync token yang dipakai** (hampir semua sama, ada 1 pengecualian):
- `bric2026bimasaktisecret` — dipakai di HAMPIR SEMUA endpoint sync (segmen, speedcash, ekspedisi, fastpay, farming, pa-produk, pa-arpu, asdp, pa-asdp, pa-lpd, lpd, bumdes, hunter, instaqris-trx, qris-ctrl/*, data-raw/*)
- `bric2026mgmpasecret` — **KHUSUS MGM PA** (`POST /api/warroom/mgm/sync`), token berbeda dari yang lain. Cek header `x-sync-token` atau body `token`.

### Urutan Registrasi Route di `app.js` (PENTING)
Semua endpoint `POST .../sync` HARUS didaftarkan **sebelum** `app.use('/api/warroom', requireAuth, ...)` agar bisa bypass JWT. Urutan lengkap (ringkas, method+path+handler+auth):

```js
// Auth (no JWT)
POST /api/auth/login                          authRoutes                          — none (loginLimiter)

// Core (JWT)
/api/scoreboard/*                              scoreboardRoutes                    requireAuth
/api/users/*                                   usersRoutes                         requireAuth
/api/winme/*                                   winmeRoutes                         requireAuth
/api/paymentagent/*                            paymentAgentRoutes                  requireAuth
/api/dompetdigital/*                           dompetDigitalRoutes                 requireAuth
/api/members/*                                 membersRoutes                       requireAuth
/api/presence/*                                presenceRoutes                      requireAuth
/api/ai/*                                      aiRoutes                            requireAuth
/api/ai-context/*                              aiContextRoutes                     requireAuth

// WAR-ROOM sync (token, bypass JWT) — HARUS sebelum app.use('/api/warroom', requireAuth, ...)
POST /api/warroom/segmen/sync                  warroomRoutes.syncHandler           token bric2026bimasaktisecret
POST /api/warroom/speedcash/sync               warroomRoutes.speedcashSyncHandler  token
POST /api/warroom/ekspedisi/sync               ekspedisiRoutes.syncHandler         token
GET  /api/warroom/ekspedisi/analytics          ekspedisiRoutes.analyticsHandler    requireAuth
GET  /api/warroom/ekspedisi/outlet-status      ekspedisiRoutes.outletStatusHandler requireAuth
POST /api/warroom/ekspedisi/outlet-status      ekspedisiRoutes.updateOutletStatusHandler requireAuth
GET  /api/warroom/ekspedisi/notes              ekspedisiRoutes.notesHandler        requireAuth
POST /api/warroom/ekspedisi/notes              ekspedisiRoutes.addNoteHandler      requireAuth
POST /api/warroom/fastpay/sync                 fastpayRoutes.syncHandler           token
GET  /api/warroom/fastpay/analytics            fastpayRoutes.analyticsHandler      requireAuth
GET  /api/warroom/fastpay/outlets              fastpayRoutes.outletsHandler        requireAuth
POST /api/warroom/farming/sync                 farmingRoutes.syncHandler           token
GET  /api/warroom/farming/analytics            farmingRoutes.analyticsHandler      requireAuth
GET  /api/warroom/farming/outlets              farmingRoutes.outletsHandler        requireAuth
POST /api/warroom/pa-produk/sync               warroomRoutes.paProdukSyncHandler   token
GET  /api/warroom/pa-produk/analytics          warroomRoutes (fn)                  requireAuth
GET  /api/warroom/pa-produk/trendline          warroomRoutes (fn)                  requireAuth
POST /api/warroom/pa-arpu/sync                 warroomRoutes.paArpuSyncHandler     token
GET  /api/warroom/pa-arpu/analytics            warroomRoutes (fn)                  requireAuth
POST /api/warroom/mgm/sync                     warroomRoutes.mgmSyncHandler        token bric2026mgmpasecret (BEDA!)
GET  /api/warroom/mgm/analytics                warroomRoutes.mgmAnalyticsHandler   requireAuth
GET  /api/warroom/mgm/search                   warroomRoutes (fn, via /api/warroom router) requireAuth
POST /api/warroom/dm-fastpay/sync              dmFastpayRoutes.syncHandler         token
GET  /api/warroom/dm-fastpay/analytics         dmFastpayRoutes.analyticsHandler    requireAuth
POST /api/warroom/instaqris-trx/sync           iqTrxRoutes.syncHandler             token
GET  /api/warroom/instaqris-trx/analytics      iqTrxRoutes.analyticsHandler        requireAuth
GET  /api/warroom/instaqris-trx/export         iqTrxRoutes.exportHandler           requireAuth
GET  /api/warroom/instaqris-trx/merchants      iqTrxRoutes.merchantsHandler        requireAuth
POST /api/warroom/asdp/sync                    asdpRoutes.syncHandler              token
GET  /api/warroom/asdp/analytics               asdpRoutes.analyticsHandler         requireAuth
GET  /api/warroom/asdp/outlets                 asdpRoutes.outletsHandler           requireAuth
POST /api/warroom/pa-asdp/sync                 paAsdpRoutes.syncHandler            token
GET  /api/warroom/pa-asdp/analytics            paAsdpRoutes.analyticsHandler       requireAuth
GET  /api/warroom/pa-asdp/outlets              paAsdpRoutes.outletsHandler         requireAuth
POST /api/warroom/pa-lpd/sync                  paLpdRoutes.syncHandler             token
GET  /api/warroom/pa-lpd/analytics             paLpdRoutes.analyticsHandler        requireAuth
GET  /api/warroom/pa-lpd/outlets               paLpdRoutes.outletsHandler          requireAuth
POST /api/warroom/bumdes/sync                  bumdesRoutes.syncHandler            token
GET  /api/warroom/bumdes/analytics             bumdesRoutes.analyticsHandler       requireAuth
GET  /api/warroom/bumdes/outlets               bumdesRoutes.outletsHandler         requireAuth
POST /api/warroom/lpd/sync                     lpdRoutes.syncHandler                token
GET  /api/warroom/lpd/analytics                lpdRoutes.analyticsHandler          requireAuth
GET  /api/warroom/lpd/outlets                  lpdRoutes.outletsHandler            requireAuth
POST /api/warroom/hunter/sync                  hunterRoutes.syncHandler            token
GET  /api/warroom/hunter/analytics             hunterRoutes.analyticsHandler       requireAuth
POST /api/warroom/qris-ctrl/merchant/sync      qrisCtrlRoutes.syncMerchantHandler  token (x-sync-token)
POST /api/warroom/qris-ctrl/kyckym/sync        qrisCtrlRoutes.syncKycHandler       token
POST /api/warroom/qris-ctrl/verifikasi-op/sync qrisCtrlRoutes.syncVerifikasiOpHandler token
POST /api/warroom/qris-ctrl/pten/sync          qrisCtrlRoutes.syncPtenHandler      token
GET  /api/warroom/qris-ctrl/analytics          qrisCtrlRoutes.analyticsHandler     requireAuth

// Catch-all utk GET lain di bawah /api/warroom (mis. /segmen, /segmen/history, /segmen/trendline, /speedcash, /speedcash/analytics, dst)
/api/warroom/*                                 warroomRoutes                       requireAuth

// Data Raw sync (token, bypass JWT)
POST /api/data-raw/outlet/sync                 dataRawRoutes.outletSyncHandler     token
POST /api/data-raw/affiliate/sync              dataRawRoutes.affiliateSyncHandler  token
POST /api/data-raw/qris/sync                   dataRawRoutes.qrisSyncHandler       token
POST /api/data-raw/trx/sync                    dataRawRoutes.trxSyncHandler        token
/api/data-raw/*                                dataRawRoutes                       requireAuth (GET list/analytics)

/api/system/*                                  systemRoutes                        requireAuth
GET  /health                                    inline                              none
*                                               404 handler                         —
```

---

## Detail Endpoint per Domain

### `auth.js`
- Seed 2 user default saat startup jika tabel `users` kosong: `admin` (password `ADMIN_PASSWORD` env, role admin), `viewer` (password `VIEWER_PASSWORD` env, role viewer). Password di-hash bcrypt cost 10.
- `POST /api/auth/login` — body `{ username, password }`. Cek `is_active`, bandingkan bcrypt, update `last_login`, sign JWT expired `8h`. Response `{ token, username, full_name, unit, role }`.

### `scoreboard.js`
- Konstanta: `SECRET_TOKEN = APPS_SCRIPT_TOKEN || 'bric2026bimasaktisecret'`, `DATA_FILE = data/scoreboard.json`, `EXCLUDE_TOTAL = ['A. TOTAL BUSINESS RETAIL', 'B. TOTAL ESA', 'REVENUE BISNIS BMS']`.
- `POST /api/scoreboard/sync` — body `{ token, bulan?, synced_at, days_elapsed, all_rows[] }`. Simpan ke `data/scoreboard.json` (per bulan) DAN upsert ke tabel `daily_snapshot` (key `tanggal, bulan, unit_nama`). Menghitung ranking (`rank_posisi`) berdasarkan `est_kpi_juni` DESC, exclude subtotal/parent/excluded rows.
- `GET /api/scoreboard/units?bulan=&metric=kpi|rev` — baca dari JSON, filter unit non-subtotal, hitung ranking & summary (total, count per status, avg KPI, best/worst).

### `users.js` (admin only)
- `UNITS` const: `['Payment Agent','SpeedCash','Travel B2C','Pulsagram','Winme','InstaQris','DOMPET DIGITAL SPEEDCASH','WINME&INSTAQRIS','Semua Unit']`
- `GET /api/users`, `POST /api/users` (validasi password ≥6 char, hash bcrypt, default role viewer), `PUT /api/users/:id` (password opsional — hanya re-hash jika dikirim), `DELETE /api/users/:id` (block self-delete), `GET /api/users/units`.

### `winme.js` — GET `/api/winme?bulan=`
Baca `scoreboard.json`, cari row `WINME&INSTAQRIS` (grup) + `Winme` + `InstaQris` (produk). Hitung kontribusi %, gap ke target, surplus (`est_kpi_juni >= 100`). Tren harian dari `daily_snapshot` (delta harian dari kumulatif).

### `paymentagent.js` — GET `/api/paymentagent?bulan=`
Unit tunggal `PAYMENT AGENT`. Hitung **pace**: `pace_ideal = target_rkap/totalDays`, `pace_aktual = juni/daysElapsed`, `gap_pace`, forecast (`rev_dibutuhkan/hari`, `surplus_rkap`, `on_track`), kontribusi vs BMS (`REVENUE BISNIS BMS` row).

### `dompetdigital.js` — GET `/api/dompetdigital?bulan=`
Grup `DOMPET DIGITAL SPEEDCASH` + 3 sub-unit: SpeedCash (`#EF4444`), Travel B2C (`#1D9E75`), Pulsagram (`#378ADD`). Per sub-unit: `gap_surplus = est_rev_juni - target_rkap`, `is_bermasalah` jika negatif, `rev_per_hari_dibutuhkan`.

### `members.js` — Leader & Tim CRUD
- `GET /api/members?unit=` — list dengan target & pencapaian terakhir (LEFT JOIN nested).
- `GET /api/members/:id/detail` — 30 hari histori, hitung trend (naik/turun/stabil berdasarkan avg 3 hari terakhir vs 3 hari sebelumnya, threshold ±2%), auto-rekomendasi.
- `POST /api/members` — validasi: tim wajib `leader_id`. Transaksi insert member + targets sekaligus.
- `POST /api/members/targets/:target_id/pencapaian` — upsert `(target_id, tanggal)`, auto-hitung `pct_revenue` jika tidak dikirim.

### `presence.js`
In-memory Map `username → {username, role, unit, lastSeen}`, TTL 2 menit (`120000ms`), reset saat restart server. `POST /api/presence/ping` return semua session aktif.

### `ai.js` — Gemini 2.5 Flash Chat
- `GEMINI_URL`: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`
- Temperature `0.3`, max output tokens `8192`.
- `POST /api/ai/chat` — body `{ message, history[]?, pageContext? }`. Rate limit internal 20 pesan/menit/user. Retry 3x dengan backoff 3s/6s/9s jika Gemini return 503/429.

### `ai-context.js`
- `GET /api/ai-context?page=&bulan=&member_id=` — bangun system prompt lengkap: data scoreboard + semua leader/tim 3 unit + (opsional) profil member spesifik + instruksi statis persona AI.
- Chat history CRUD di tabel `chat_history` (kolom: `id, user_id, username, page, role, message, created_at`).

### `system.js` — Server Monitor
`GET /api/system/stats` — OS stats (`os.loadavg`, `os.totalmem/freemem`, `process.memoryUsage`, uptime, disk via `df -B1 /`) + 6 query paralel PostgreSQL: ukuran DB, koneksi (active/idle/total/max dari `pg_stat_activity`+`pg_settings`), ukuran 12 tabel terbesar (`pg_stat_user_tables`), 15 active queries (`pg_stat_activity`, exclude idle), lock waiting count (`pg_locks`).
- **Heap gauge**: pakai `mem_total` (RAM server) sebagai max, BUKAN `node_heap_total` — karena V8 heap_total selalu ≈ heap_used (misleading).

### `data-raw.js` — Raw Data Warehouse
- Tabel whitelist: `outlet→iq_raw_outlet`, `affiliate→iq_raw_affiliate`, `qris→iq_raw_qris`, `trx→iq_raw_trx`. Sync token `bric2026bimasaktisecret`.
- **Sync logic** (factory `makeSyncHandler`): DELETE semua baris utk `bulan` tsb, lalu INSERT ulang via `jsonb_array_elements` (transaksi). Body: `{ token, bulan, sheet_name?, rows[] }` — setiap row disimpan sebagai JSONB utuh di kolom `row_data`.
- **List endpoints** (factory `makeListHandler`): pagination (max 500/page), full-text search di `row_data::text`, filter tanggal fleksibel (deteksi kolom tanggal otomatis), sort dinamis, return `columns[]` dari key JSONB baris pertama + `bulan_list[]`.
- **Analytics endpoints** (semua `GET`, JWT):
  - `/api/data-raw/analytics?bulan=` — agregasi per kategori dari `iq_raw_trx`, bandingkan 3 bulan, deteksi anomali (`trx naik, margin turun`).
  - `/api/data-raw/trendline?days=&bulan=` — tren harian per kategori.
  - `/api/data-raw/qris-analytics?bulan=` — status penerbitan QRIS (Terbit/Belum Terbit/Perbaikan Data/Rejected) per kategori/provinsi.
  - `/api/data-raw/outlet-analytics?bulan=` — segmentasi 8 kategori: superstar (≥P75 trx&margin), tumbuh (growth≥20%), at_risk (-25%<growth<-10%), turun (growth≤-25%), stabil, churn, baru_aktif, reaktivasi. Rekomendasi aksi: selamatkan/hubungi/reward/reaktivasi/optimasi (masing-masing top 30-50).
  - `/api/data-raw/affiliate-analytics?bulan=` — agregasi per upline (network size, QRIS status, trx/margin, activation rate).
  - `/api/data-raw/affiliate-analytics/downlines?upline=&bulan=` — drill-down outlet di bawah 1 upline.
- **Dedup pattern**: `DISTINCT ON (id_outlet) ... ORDER BY id_outlet, bulan DESC` — dipakai di outlet catalog & QRIS status utk ambil data terbaru per outlet.
- **Territory clustering**: fungsi `territoryCluster(provinsi)` → Jawa/Sumatera/Kalimantan/Sulawesi/Bali & Nusa Tenggara/Maluku/Papua/Lainnya (dipakai juga di InstaQris TRX).

---

## WAR-ROOM — Detail Per Domain

### 1. InstaQris Segmen (`warroom.js`, bagian A) — `/war-room/instaqris`
- Sync: `POST /api/warroom/segmen/sync`, body `{ token, tanggal, synced_at, rows[] }`. Tabel `segmen_snapshot`, UNIQUE `(tanggal, mcc)`.
- Filter skip saat sync: mcc kosong/NULL/non-numerik, atau kategori/mcc mengandung "total".
- Analytics `GET /api/warroom/segmen?tanggal=` — anomali: `dev_mei_jun_merchant > 0 AND dev_mei_jun_rev < 0`. Return summary, top_rev, top_growth, segmen_masalah, anomali, tabel lengkap.
- `GET /api/warroom/segmen/history?mcc=&days=`, `GET /api/warroom/segmen/trendline?days=` (multi-MCC line chart data).

### 2. Speedcash (`warroom.js`, bagian B) — `/war-room/speedcash`
- Data source: Google Sheet `1MIpXkyU_COR_ptTvweKQKFYT0pxWIo_5zfCC90Gqlck` tab "Juni". Sync `POST /api/warroom/speedcash/sync`, tabel `speedcash_snapshot`, UNIQUE `(tanggal, id_outlet)`. Kolom: id_outlet, tgl_reg, trx_mei, margin_mei, trx_jun, margin_jun, dev_trx, dev_margin, no_hp, nama.
- **Apps Script `cleanNum` PENTING**: harus cek `typeof v === 'number'` DULU sebelum string processing, agar tidak mengira `408146.85` → `40814685` (100x salah karena titik desimal ikut terhapus saat string replace).
- Analytics `GET /api/warroom/speedcash/analytics?tanggal=` — 20 query paralel:
  1. **Threshold percentile**: P25/P50/P75 TRX & Margin (`PERCENTILE_CONT`) dari outlet aktif (trx_jun>0).
  2. **Segmentasi** (CASE, threshold-based):
     | Segmen | Kondisi |
     |---|---|
     | inactive | trx_jun = 0 |
     | superstar | trx_jun ≥ P75 AND margin_jun ≥ P75 |
     | rising_star | (trx_mei=0 OR trx_mei<P25) AND trx_jun>P50 AND dev_margin>0 |
     | at_risk | trx_mei≥P75 AND trx_jun < trx_mei×0.75 |
     | high_trx_low_margin | trx_jun≥P75 AND margin_jun<P25 |
     | low_trx_high_margin | trx_jun<P25 AND margin_jun≥P75 |
     | low_value | else (aktif) |
  3. **Growth status**: inactive/new_active/churned/growing/declining/stable (dari trx_mei vs trx_jun).
  4. **Margin status**: new_margin_source/margin_hero/margin_drop/volume_no_margin/normal.
  - Query lain: top10_trx, top10_margin, top20_dt_pos/neg, top20_dm_pos/neg, growth_table (union 5 kategori), segment_counts, scatter_data (max 4000), top20_margin_jun, top20_dev_margin, bot20_dev_margin, cohort_year, cohort_month, action_drop/growth/high_trx/rising (masing2 max 50).
- Warna segmen (frontend `SEGMENT_COLORS`): superstar `#7C3AED`, rising_star `#059669`, at_risk `#DC2626`, high_trx_low_margin `#D97706`, low_trx_high_margin `#2563EB`, low_value `#9CA3AF`, inactive `#D1D5DB`.
- Action Center 4 prioritas: drop (🚨 wajib diselamatkan), growth (📈 wajib dihubungi), high_trx (⚡ wajib dioptimasi), rising (⭐ wajib testimoni).
- Trigger harian Apps Script: `setupSpeedcashTrigger()` jam 23.00 UTC (06.00 WIB).

### 3. PA Produk & PA ARPU (`warroom.js`, bagian C-D) — `/war-room/pa-produk`
- Sync `POST /api/warroom/pa-produk/sync` — tabel `pa_produk_snapshot` (UNIQUE `tanggal, produk`) + `pa_produk_totals` (MAT resmi dari sheet row 24, UNIQUE `tanggal`). Skip produk kosong/"total".
- Analytics: hitung `dev_trx/rev`, `pct_growth`, `arpt` (Average Revenue Per Transaction) per periode Apr/Mei/Jun. Stats: total_outlets, active_jun, growing/declining/new_active/churned/kritis_2period (turun 2 periode beruntun).
- `GET /api/warroom/pa-produk/trendline?days=` — top 20 produk by rev_jun, histori 30-90 hari.
- PA ARPU: sync `POST /api/warroom/pa-arpu/sync` — tabel `pa_arpu_snapshot` (UNIQUE `tanggal, id_outlet`), kolom `layer_arpu` (Low/Mid/High/Top ARPU). Analytics: distribusi & kontribusi revenue per layer.

### 4. MGM PA (`warroom.js`, bagian E) — `/war-room/mgm-pa`
- **Sync token BEDA**: `bric2026mgmpasecret` (bukan yang umum). Body `{ token, bulan, aktivasi[], registrasi[] }`.
- Dua tabel: `mgm_aktivasi` (outlet aktif + trx/rev) & `mgm_registrasi` (outlet baru daftar), keduanya UNIQUE `(bulan, id_outlet)`.
- Analytics `GET /api/warroom/mgm/analytics?bulan=` — 9-10 query paralel: summary, tipe breakdown (aktivasi & registrasi), top 15 upline (aktivasi & registrasi), **konversi** (upline dengan ≥3 registrasi, `pct_konversi = converted/total*100`), provinsi top 10, trend semua bulan, recent aktivasi/registrasi (top 50).
- Search `GET /api/warroom/mgm/search?q=&bulan=` — cari di `id_outlet` DAN `upline` (karena kode outlet bisa juga jadi ID upline). LIMIT 2000 + COUNT(*) terpisah utk total sebenarnya.

### 5. Ekspedisi (`warroom-ekspedisi.js`) — `/war-room/ekspedisi` (badge: Okta)
- Sync `POST /api/warroom/ekspedisi/sync` — Bearer token (bukan x-sync-token header). Body `{ token, tanggal, months: [{ bulan, rows[] }] }`. Tabel `ekspedisi_monthly`, PK `(tanggal, id_outlet, bulan)`.
- Analytics `GET /api/warroom/ekspedisi/analytics` punya **dual-shape response**: legacy shape (months/outlets/history/summary, backward-compat) + business-logic-layer baru (meta/monthlyFacts/monthlySummary/outletPerformance/executiveInsights/charts/queues/businessMetrics).
- **Segmentasi outlet** (10 segmen): churn, new_active, whale (≥P90 trx/rev), one_timer, growth_driver, at_risk, low_yield, premium_yield, stable, declining.
- **Priority P0-P3**: P0 = churn+whale ATAU decay≥-50%; P1 = churn/declining/at_risk/low_yield; P2 = new_active/one_timer/growth_driver (non-whale); P3 = stable/whale/premium_yield.
- **EOM Projection**: `projectedEomTrx = totalTrx/dayCutoff × daysInMonth` (proyeksi akhir bulan dari data parsial).
- Business metrics: retentionRate, churnRate, newOutletRate, dependencyRisk (top10 rev / total rev), productivity, avgRevenuePerTrx.
- Fitur tambahan: `ekspedisi_outlet_status` (kontak PIC, follow-up date) & `ekspedisi_outlet_notes` (catatan per outlet) — state mutable, bukan snapshot sync.

### 6. Fastpay Global (`warroom-fastpay.js`) — `/war-room/fastpayglobal` (badge: Ainul)
- Sync `POST /api/warroom/fastpay/sync` — Bearer token. Tabel `fastpay_snapshot`, UNIQUE `(tanggal, id_outlet)`. Snapshot harian Mei vs Jun (bukan multi-bulan).
- Status computation: churned/new/rocket (growth≥50% & dev_trx≥20)/growing/declining/stable.
- Analytics: 14+ query (status counts, top15 trx/rev/growth/decline, new/churned/rocket outlets, prefix breakdown 3 char, distribusi bucket TRX, scatter, anomali free-trx).
- Outlets endpoint: server-side pagination (50/page, max 200), search, filter status, sort 9 kolom.

### 7. Farming (`warroom-farming.js`) — `/war-room/farming` (badge: Nizar)
- Mirip Fastpay tapi pakai **period-based columns** (`trx_mei_period`, `trx_jun_period`) selain full-month (`trx_mei_full`) — utk handle cutoff pertengahan bulan. Tabel `farming_snapshot`, UNIQUE `(tanggal, id_outlet)`.
- Prefix breakdown pakai 2 karakter (bukan 3 seperti Fastpay).

### 8. ASDP vs PA ASDP — 2 file BERBEDA (badge: ASDP/PA)
- **`warroom-asdp.js`** (`/war-room/asdp`) — **single snapshot**, TIDAK ada kolom `bulan`. Tabel `warroom_asdp_outlet`, UNIQUE `id_outlet` SAJA. Kolom pakai `trx_mei`/`trx_juni` (ejaan "juni" bukan "jun").
- **`warroom-pa-asdp.js`** (`/war-room/pa-asdp`) — **multi-bulan**. Tabel `warroom_pa_asdp_outlet`, UNIQUE `(bulan, id_outlet)`, CHUNK=500 baris per insert, async via `setImmediate()`.
- Keduanya pakai `toIsoDate()` utk convert `DD/MM/YYYY` → ISO sebelum insert.

### 9. LPD vs PA LPD — 2 file BERBEDA (badge: PA)
- **`warroom-lpd.js`** (`/war-room/lpd`) — **single snapshot** Mei vs Juni. Tabel `warroom_lpd_outlet`, UNIQUE `id_outlet` SAJA. Kolom `trx_mei/rev_mei` vs `trx_juni/rev_juni`.
- **`warroom-pa-lpd.js`** (`/war-room/pa-lpd`) — **multi-bulan**, CHUNK=500, dedup by id_outlet sebelum insert (Google Sheet ada duplikat), response dikirim langsung + proses DB di background (`setImmediate`). Data source Sheet `10cqIuji7iYi8u7hRR19xtMBVRI-ZyfwG4eNlsbAjPzc`. Tabel `warroom_pa_lpd_outlet`, UNIQUE `(bulan, id_outlet)`.
- 12 KPI card khas LPD: Transaksi, Revenue, MAT, NMAT, NMAT Min 100 TRX, MAT Min 300 TRX, Trx New MAT, Rev New MAT, New Reg, EDC, Dev TRX, Dev Rev.

### 10. BUMDes (`warroom-bumdes.js`) — `/war-room/bumdes` (badge: PA)
- Multi-bulan, CHUNK=500. Tabel `warroom_bumdes_outlet`, UNIQUE `(bulan, id_outlet)`. Sheet: `1_9n2qYrY0qOHFyQWwCttPxxbqjEiB1Cbe24FtTNXpts`, header row 13, data mulai row 14.

### 11. DM Fastpay (`warroom-dm-fastpay.js`) — `/war-room/dm-fastpay` (badge: DM)
- **1 baris per tanggal** (bukan per outlet) — tabel `dm_fastpay_snapshot`, UNIQUE `tanggal`. 31 kolom metrik marketing: reg/akt/nmat/rev_akt/trx/rev_trx/budget_ads/nmat_jawa/retargeting/brand_exp × 3 periode (apr/mei/jun).
- Metrik turunan di frontend: ROI = `(rev_akt_jun+rev_trx_jun)/budget_ads_jun×100`, konversi = `akt/reg`, kontribusi Jawa = `nmat_jawa/nmat×100`.

### 12. Hunter/PB (`warroom-hunter.js`) — `/war-room/hunter` (badge: HNT)
- **3 tabel** per bulan: `hunter_d1` (registrasi, UNIQUE `bulan,id_loket`), `hunter_d2` (volume trx per outlet, UNIQUE `bulan,id_outlet`), `hunter_d3` (detail aktivasi, UNIQUE `bulan,id_aktifasi`).
- Sync pakai transaksi (BEGIN/DELETE-per-bulan/INSERT via `jsonb_array_elements`).
- **Stage engine** per outlet (join D1+D2+D3): registered_not_activated → activated_no_trx → activation_loss (komisi<0) → first_trx → low_frequency → revenue_hero (margin>5jt) → high_potential.
- **Hunter scoring**: `score = 0.20×sR(reg) + 0.25×sA(akt) + 0.25×sT(trx_out) + 0.20×sV(revenue) + 0.10×sC(consistency)`, semua dinormalisasi terhadap max value di seluruh hunter.
- **Hunter status** (cascade): costly_hunter (>30% aktivasi komisi negatif) → dormant_hunter (reg<3) → super_hunter (act_rate≥0.5 & trx_rate≥0.3) → activation_hunter → acquisition_hunter → revenue_hunter.
- **Action queue priority**: `0.40×stageWeight + 0.25×agingWeight + 0.20×hunterScoreWeight + 0.10×typeWeight + 0.05×dataCompletenessWeight`, top 300 diambil.
- **Funnel bottleneck** per hunter: "Closing Aktivasi" (akt/reg<0.3), "Edukasi Penggunaan" (trx/akt<0.3), "Kualitas Transaksi" (margin<100rb), "Struktur Biaya" (rev_akt<0), else "OK".
- Apps Script GAS builder script di-embed langsung di halaman frontend (`buildScript()` function di WarRoomHunter.jsx) — user copy-paste ke Google Apps Script Editor.

### 13. InstaQris TRX (`warroom-instaqris-trx.js`) — `/war-room/instaqris-trx`
- Tabel `instaqris_trx_merchant`, UNIQUE `(merchant_id, bulan)`. Upsert per-row TANPA chunking.
- **Segmentasi 8 tingkat** (berdasarkan `total_transaction` & `last_transaction_date` & `avg_daily_transactions`): new_merchant → churn (>45 hari) → dormant (31-45 hari) → declining (14-30 hari) → high_density (≤7 hari & rate≥1.0) → daily_active (≤7 hari & rate≥0.3) → repeat_scan (≥3 trx & ≤14 hari) → activated (default).
- 7 behavior score (0-100): repeat_scan_score, buyer_conversion_score, merchant_activation_score, transaction_density_score, retention_score, ecosystem_dependency_score, final_priority_score (weighted average).
- Export CSV 3 tipe: `transaksi` (density score), `segmentasi` (per segmen), `behavior_score` (7 skor).

### 14. QRIS Control Tower (`warroom-qris-control-tower.js`) — `/war-room/qris-control-tower` (badge: CTL)
Lihat bagian khusus "QRIS Control Tower" di bawah — fitur paling kompleks di seluruh dashboard.

---

## Database — Semua Tabel PostgreSQL

### Tabel via migration file (`backend/src/migrations/*.sql`)
| Tabel | File | Key | Catatan |
|---|---|---|---|
| `wb_warrooms`, `wb_sheet_sources`, `wb_column_mappings`, `wb_snapshots`, `wb_alerts`, `wb_actions`, `wb_import_logs` | `005_warroom_builder.sql` | id SERIAL | Sistem "War Room Builder" generik (JSONB config, plugin_codes) — infrastruktur belum dipakai aktif oleh war-room manapun saat ini, kemungkinan fitur masa depan |
| `ekspedisi_monthly` | `create_ekspedisi_monthly.sql` | (tanggal, id_outlet, bulan) | trx, revenue per bulan |
| `ekspedisi_outlet_status` | `create_ekspedisi_outlet_status.sql` | id_outlet | is_contacted, pic, followup_date |
| `ekspedisi_outlet_notes` | `create_ekspedisi_outlet_status.sql` | id SERIAL | catatan per outlet |
| `ekspedisi_snapshot` | `create_ekspedisi_snapshot.sql` | (tanggal, id_outlet) | LEGACY wide format (Apr/Mei/Jun kolom terpisah), tidak dihapus tapi sudah digantikan `ekspedisi_monthly` |
| `farming_snapshot` | `create_farming_snapshot.sql` | (tanggal, id_outlet) | status CHECK IN (rocket,growing,stable,declining,new,churned) |
| `fastpay_snapshot` | `create_fastpay_snapshot.sql` | (tanggal, id_outlet) | sama status enum |
| `qris_ctrl_merchant`, `qris_ctrl_kyckym`, `qris_ctrl_verifikasi_op`, `qris_ctrl_pten` | `create_qris_control_tower.sql` | id_outlet | kolom `row_data JSONB` (raw row dari Apps Script) + `synced_at` |
| `hunter_d1`, `hunter_d2`, `hunter_d3` | `backend/migrations/hunter_tables.sql` | lihat di atas | — |

### Tabel via `setup_members.sql`
| Tabel | Key | Kolom penting |
|---|---|---|
| `members` | id SERIAL | unit, nama, posisi CHECK(leader/tim), fungsi, avatar_warna DEFAULT '#7F77DD', leader_id FK→members(id) ON DELETE SET NULL, is_active |
| `member_targets` | id SERIAL | member_id FK CASCADE, nama_target, key_result, target_revenue, periode, urutan |
| `member_pencapaian` | UNIQUE(target_id, tanggal) | member_id FK, target_id FK, pencapaian_kr, pencapaian_revenue, pct_kr, pct_revenue, catatan |

### Tabel legacy (dibuat manual di VPS via psql, TIDAK ADA file migration di repo — hati-hati saat provisioning DB baru!)
| Tabel | Key | Kolom | Dipakai di |
|---|---|---|---|
| `daily_snapshot` | (tanggal, bulan, unit_nama) | juni, mei, target_rkap, est_rev_juni, avg_rev_day, real_kpi, est_kpi_juni, status, is_subtotal, is_parent, rank_posisi | scoreboard.js, winme.js, paymentagent.js, dompetdigital.js |
| `users` | id SERIAL, username UNIQUE | password_hash, full_name, unit, role, is_active, last_login | auth.js, users.js |
| `chat_history` | id SERIAL | user_id, username, page, role CHECK(user/model), message, created_at | ai-context.js |
| `segmen_snapshot` | UNIQUE(tanggal, mcc) | mcc, kategori, apr/mei/jun_merchant/trx/rev, dev_apr_jun_*/dev_mei_jun_* | warroom.js (InstaQris) |
| `speedcash_snapshot` | UNIQUE(tanggal, id_outlet) | tgl_reg, trx_mei, margin_mei, trx_jun, margin_jun, dev_trx, dev_margin, no_hp, nama | warroom.js (Speedcash) |
| `pa_produk_snapshot` | UNIQUE(tanggal, produk) | mat/trx/rev × apr/mei/jun | warroom.js (PA Produk) |
| `pa_produk_totals` | UNIQUE(tanggal) | mat_apr, mat_mei, mat_jun | warroom.js (PA Produk, MAT resmi) |
| `pa_arpu_snapshot` | UNIQUE(tanggal, id_outlet) | layer_arpu, jml_group_layanan, jml_bill, jml_trx, jml_rev | warroom.js (PA ARPU) |
| `mgm_aktivasi` | UNIQUE(bulan, id_outlet) | upline, nama_pemilik, tipe_outlet, balance, is_active, nama_kota, nama_propinsi, tanggal_aktifasi, trx, rev | warroom.js (MGM PA) |
| `mgm_registrasi` | UNIQUE(bulan, id_outlet) | sama + tanggal_registrasi | warroom.js (MGM PA) |
| `warroom_asdp_outlet` | UNIQUE(id_outlet) | trx_mei/rev_mei/trx_juni/rev_juni/dev_trx/dev_rev, balance | warroom-asdp.js |
| `warroom_pa_asdp_outlet` | UNIQUE(bulan, id_outlet) | trx_prev/rev_prev/trx_curr/rev_curr/dev_trx/dev_rev | warroom-pa-asdp.js |
| `warroom_lpd_outlet` | UNIQUE(id_outlet) | trx_mei/rev_mei/trx_juni/rev_juni | warroom-lpd.js |
| `warroom_pa_lpd_outlet` | UNIQUE(bulan, id_outlet) | trx_prev/rev_prev/trx_curr/rev_curr | warroom-pa-lpd.js |
| `warroom_bumdes_outlet` | UNIQUE(bulan, id_outlet) | sama pola pa_lpd | warroom-bumdes.js |
| `dm_fastpay_snapshot` | UNIQUE(tanggal) | 31 kolom marketing (lihat atas) | warroom-dm-fastpay.js |
| `instaqris_trx_merchant` | UNIQUE(merchant_id, bulan) | merchant_name, category, city, province, qris_terbit, total_transaction, first/last_transaction_date, avg_daily_transactions | warroom-instaqris-trx.js |
| `iq_raw_outlet`, `iq_raw_affiliate`, `iq_raw_qris`, `iq_raw_trx` | (bulan + row_data JSONB) | row_data menyimpan seluruh baris sheet sebagai JSONB | data-raw.js |

> **Catatan penting**: Sebagian besar tabel snapshot outlet (fastpay, farming, asdp, dll) kolomnya tidak seragam antar domain (ada yang pakai `trx_mei`/`trx_jun`, ada yang `trx_prev`/`trx_curr`, ada yang `_mei`/`_juni` — ejaan beda-beda). Selalu cek file route spesifik sebelum menulis query baru, jangan asumsi nama kolom sama antar war-room.

---

# BAGIAN 2 — FRONTEND

## Struktur Frontend (`frontend/src/`)
```
App.jsx                — semua route (lihat tabel di bawah)
main.jsx                — entry point
index.css               — SEMUA CSS, termasuk CSS variables & class prefix per komponen
services/api.js         — semua API call (50+ fungsi), authHeaders(), caching per-endpoint, interceptor 401→logout
utils/auth.js           — saveAuth/getToken/getUser/isLoggedIn (cek exp JWT)/logout, localStorage key bric_token/bric_user
components/
  Layout.jsx            — sidebar + topbar + main-content + AiChat + gsheet-bar + presence-footer
  Sidebar.jsx            — menu accordion 3 level (lihat detail di bawah)
  Nav.jsx, Topbar.jsx    — TIDAK DIPAKAI di flow utama (alternatif lama, masih ada di repo)
  ProtectedRoute.jsx     — cek isLoggedIn(), redirect /login jika gagal
  LeaderManagement.jsx   — modal CRUD member/target/pencapaian (dipakai di ScoreboardTim)
  AiChat.jsx             — floating AI chat widget (Gemini)
  qris/                  — 18 file komponen khusus QRIS Control Tower (lihat bagian tersendiri)
pages/                   — 30+ halaman (lihat tabel route di bawah)
```

## Semua Route (`App.jsx`)
Semua route memakai `<ProtectedRoute>` kecuali `/login`. `/users` dan `/server-monitor` admin-only (dicek di Sidebar, bukan di level route).

| Path | Komponen | Catatan |
|---|---|---|
| `/login` | Login | public |
| `/` | redirect → `/scoreboard` | |
| `/scoreboard` | Scoreboard | dashboard KPI utama |
| `/leader-scoreboard` | LeaderScoreboard | ranking leader lintas unit |
| `/winme` | WinmeInstaqris | |
| `/payment-agent` | PaymentAgent | |
| `/dompet-digital` | DompetDigital | |
| `/users` | UserManagement | **admin only** |
| `/anggota/:id` | AnggotaDetail | |
| `/scoreboard-tim` | ScoreboardTim (unit=winme_instaqris) | |
| `/scoreboard-tim-pa` | ScoreboardTim (unit=payment_agent) | |
| `/scoreboard-tim-sc` | ScoreboardTim (unit=speedcash) | |
| `/data-raw` | DataRaw | |
| `/war-room/instaqris` | WarRoom | |
| `/war-room/speedcash` | WarRoomSpeedcash | |
| `/war-room/ekspedisi` | WarRoomEkspedisi | badge Okta |
| `/war-room/fastpayglobal` | WarRoomFastpay | badge Ainul |
| `/war-room/farming` | WarRoomFarming | badge Nizar |
| `/war-room/pa-produk` | WarRoomPAProduk | |
| `/war-room/mgm-pa` | WarRoomMgmPa | badge MGM |
| `/war-room/dm-fastpay` | WarRoomDmFastpay | badge DM |
| `/war-room/instaqris-trx` | WarRoomInstaqrisTrx | |
| `/war-room/asdp` | WarRoomAsdp | (single snapshot) |
| `/war-room/pa-asdp` | WarRoomPaAsdp | badge PA (multi-bulan) |
| `/war-room/pa-lpd` | WarRoomPaLpd | badge PA (multi-bulan) |
| `/war-room/bumdes` | WarRoomBumdes | badge PA |
| `/war-room/lpd` | WarRoomLpd | badge PA (single snapshot) |
| `/war-room/hunter` | WarRoomHunter | badge HNT |
| `/war-room/qris-control-tower` | WarRoomQrisControlTower | badge CTL |
| `/war-room/iq-raw` | WarRoomIqRaw | badge IQ (Instaqris - Analitik, dari data-raw kategori) |
| `/war-room/penerbitan-qris` | WarRoomQris | badge QRIS (legacy analytics, TERPISAH dari Control Tower) |
| `/war-room/trx-outlet` | WarRoomTrxOutlet | badge OUT |
| `/server-monitor` | ServerMonitor | **admin only** |
| `/dashboard`, `/tren`, `/per-unit`, `/laporan` | ComingSoon placeholder | belum diimplementasi |

**Catatan**: `WarRoomAffiliateAnalitik.jsx` masih ada sebagai file tapi TIDAK terdaftar di `App.jsx` maupun `Sidebar.jsx` (sengaja direvert — lihat git log "revert: hapus menu Affiliate Analitik dari sidebar dan routing"). File dianggap dead code sampai ada keputusan lanjutan.

## Menu Sidebar (struktur aktual saat ini)
```
BRIC — Bisnis Retail Insight Center
├─ Unit Scoreboard              → /scoreboard
── separator ──
├─ Leader Scoreboard            → /leader-scoreboard
── separator ──
├─ Winme & InstaQris (L1 accordion, ikon ti-bolt)
│  auto-open: /winme, /scoreboard-tim, /war-room/iq-raw, /war-room/penerbitan-qris,
│             /war-room/trx-outlet, /war-room/qris-control-tower, /data-raw
│  ├─ Scoreboard Tim (L2 accordion) → LeaderAccordion per-leader (L3) → Tim sub-list
│  ├─ [War Room label]
│  │  ├─ Instaqris - Analitik      → /war-room/iq-raw          (#0EA5E9, badge "IQ")
│  │  ├─ Penerbitan QRIS           → /war-room/penerbitan-qris (#EC4899, badge "QRIS")
│  │  ├─ QRIS Control Tower        → /war-room/qris-control-tower (#0891B2, badge "CTL")
│  │  └─ Transaksi by Outlet       → /war-room/trx-outlet      (#2563EB, badge "OUT")
│  └─ [Data label]
│     └─ Data Raw                 → /data-raw                 (#3B82F6, badge "RAW")
── separator ──
├─ Payment Agent (L1 accordion, ikon ti-building-bank)
│  auto-open: /payment-agent, /scoreboard-tim-pa, /war-room/ekspedisi, /war-room/fastpayglobal,
│             /war-room/farming, /war-room/pa-produk, /war-room/dm-fastpay, /war-room/pa-asdp,
│             /war-room/pa-lpd, /war-room/bumdes, /war-room/mgm-pa, /war-room/hunter
│  ├─ Scoreboard Tim (L2 accordion) → LeaderAccordion per-leader (L3) → Tim sub-list
│  ├─ [War Room label]
│  │  ├─ ⚡ Produk       → /war-room/pa-produk    (#639922, no badge)
│  │  ├─ Ekspedisi       → /war-room/ekspedisi    (#8B5CF6, badge "Okta")
│  │  ├─ Fastpay Global  → /war-room/fastpayglobal (#F59E0B, badge "Ainul")
│  │  ├─ Farming         → /war-room/farming      (#10B981, badge "Nizar")
│  │  ├─ MGM PA          → /war-room/mgm-pa       (#10B981, badge "MGM")
│  │  ├─ Hunter          → /war-room/hunter       (#F97316, badge "HNT")
│  │  ├─ DM Fastpay      → /war-room/dm-fastpay   (#0EA5E9, badge "DM")
│  │  ├─ ASDP            → /war-room/pa-asdp      (#3B82F6, badge "PA")
│  │  ├─ LPD             → /war-room/pa-lpd       (#9333EA, badge "PA")
│  │  └─ BUMDes          → /war-room/bumdes       (#0D9488, badge "PA")
── separator ──
├─ Speedcash (L1 accordion, label "Speedcash", ikon ti-wallet)
│  auto-open: /dompet-digital, /scoreboard-tim-sc, /war-room/speedcash
│  ├─ Scoreboard Tim (L2 accordion) → LeaderAccordion per-leader (L3) → Tim sub-list
│  └─ WAR-ROOM Speedcash → /war-room/speedcash
── separator (jika admin) ──
├─ Server Monitor  → /server-monitor  (admin only, #6366F1)
── separator (jika admin) ──
└─ Kelola User     → /users           (admin only)
```
- Catatan: `/war-room/asdp` dan `/war-room/lpd` (versi single-snapshot) **TIDAK ada link langsung di sidebar** — hanya dapat diakses via URL manual atau mungkin legacy yang digantikan versi PA (multi-bulan). Perlu klarifikasi ke user jika ingin menghapus atau menambah link.
- Accordion: chevron rotate 180° (`sidebar-chevron--open`), animasi height via `scrollHeight`+`requestAnimationFrame`.
- Leader/Tim nested 3 level: Winme(L1)→Scoreboard Tim(L2)→LeaderAccordion per-leader(L3)→Tim sub-list. Sama pola utk Payment Agent & Speedcash.
- Event `membersUpdated` dipancarkan setelah CRUD member, untuk refresh list di seluruh sidebar tanpa reload.

## `Layout.jsx`
```
<div class="layout">
  <aside class="sidebar [sidebar--open mobile]"><Sidebar/></aside>
  [sidebar-overlay jika mobile terbuka]
  <div class="layout-main">
    <header class="topbar">hamburger + [sync chip] + [bulan chip]</header>
    <main class="main-content">{children}</main>
    <AiChat/>
    [gsheet-bar jika gsheetUrl ada — link ke sumber Google Sheet]
    <footer class="presence-footer">daftar user aktif (pingPresence tiap 30s)</footer>
  </div>
</div>
```
`.main-content` TIDAK ada max-width — full width. `--sidebar-w: 260px`, `--topbar-h: 56px`.

## `services/api.js` — Pola Penting
- `authHeaders()` inject `Authorization: Bearer <token>` dari `getToken()`.
- Interceptor global: response 401 → `logout()` + redirect `/login`.
- **Caching**: War Room analytics pakai TTL 5 menit; `getMembers()` pakai TTL 20 detik + in-flight dedup (mencegah race condition saat banyak komponen fetch bersamaan); data-raw & pa-lpd/pa-asdp/bumdes (multi-bulan) TIDAK di-cache (selalu fresh).
- Base URL dari `import.meta.env.VITE_API_URL` (fallback empty string, relative path).

## `utils/auth.js`
- `localStorage` key: `bric_token`, `bric_user`.
- `isLoggedIn()` decode JWT payload manual (`atob` pada bagian ke-2 token, base64), cek `payload.exp*1000 > Date.now()` — TIDAK verifikasi signature di frontend (hanya expiry check, wajar karena signature check ada di backend).

## CSS — Variabel & Prefix (`index.css`)
```css
--primary: #1D9E75       --primary-dark: #167A5B    --primary-bg: #F0FBF7
--danger: #EF4444        --warning: #F59E0B
--text-1: #111827        --text-2: #374151          --text-3: #6B7280   --text-4: #9CA3AF
--border: #E5E7EB        --bg-page: #F3F4F6         --bg-card: #FFFFFF
--sidebar-w: 260px       --topbar-h: 56px           --radius: 10px
```
Prefix kelas CSS per komponen: `layout-*`/`sidebar-*`/`topbar-*` (struktur), `lm-*` (LeaderManagement), `ad-*` (AnggotaDetail), `st-*` (ScoreboardTim), `lsc-*` (LeaderScoreboard card), `ls-*` (filter button shared), `aic-*` (AI Chat), `wr-*` (War Room umum/InstaQris), `wrd-*`/`wrfp-*` (Speedcash dashboard), `wre-*` (Ekspedisi), `wrqris-*` (QRIS Control Tower), `prod-*` (produk card Winme), `sub-*` (sub-unit Dompet Digital), `hero-panel-pa` (Payment Agent hero), `chip-*` (topbar chip), `gsheet-*`, `presence-*`.

---

## Halaman Frontend — Ringkasan Per Page

### Dashboard Utama (non War-Room)
| Halaman | Route | Fitur Utama |
|---|---|---|
| **Login** | `/login` | form + `saveAuth()`, redirect ke `/scoreboard` |
| **Scoreboard** | `/scoreboard` | KPI grup, segmentasi 4-tier (Aman/Waspada/Awas/Kritis), top performer, executive summary, tabel detail per unit + filter, modal detail unit dgn auto-rekomendasi CEO. `HIDDEN_UNITS` menyembunyikan sementara unit ESA dari tampilan (data tetap ada di backend) |
| **WinmeInstaqris** | `/winme` | Head-to-head Winme (#378ADD) vs InstaQris (#1D9E75), progress bar skala 200%, tren harian delta, rekomendasi sinergi bundling |
| **PaymentAgent** | `/payment-agent` | Hero pace analysis (pace ideal vs aktual per hari), 3-indikator status, chart bar dgn overlay pace ideal dashed, kontribusi vs BMS + concentration risk warning |
| **DompetDigital** | `/dompet-digital` | Grup 3 sub-unit (SpeedCash #EF4444, Travel B2C #1D9E75, Pulsagram #378ADD), alert banner dinamis, health check, rekomendasi realokasi resource antar sub-unit |
| **ScoreboardTim** | `/scoreboard-tim(+variant)` | Hierarki leader→tim per unit, ranking dgn medali 🥇🥈🥉, modal "Kelola Tim" (LeaderManagement) |
| **AnggotaDetail** | `/anggota/:id` | Profil + multi-target + chart historis + riwayat pencapaian, modal tambah target/input pencapaian |
| **UserManagement** | `/users` (admin) | CRUD user, self-protection (tidak bisa nonaktifkan/hapus akun sendiri) |
| **LeaderScoreboard** | `/leader-scoreboard` | Ranking leader lintas 3 unit sekaligus (parallel fetch), auto-rekomendasi per leader |
| **ServerMonitor** | `/server-monitor` (admin) | Auto-refresh 15s + countdown, gauge CPU/RAM/Disk/Heap, tabel ukuran 12 tabel terbesar, active queries PostgreSQL |
| **DataRaw** | `/data-raw` | 4 tab (Outlet/Affiliate/QRIS/Transaksi), filter bulan+search+date range+sort, generate & copy Apps Script code langsung dari UI (`buildScript()`) |

### War-Room Pages (lihat detail domain masing-masing di bagian Backend di atas untuk business logic; berikut ringkasan tampilan)
| Halaman | Route | Tab | Warna Tema |
|---|---|---|---|
| WarRoom (InstaQris) | `/war-room/instaqris` | 5: Executive/Trendline/Trend&Growth/Unit Ekonomi/Action Center | `#E24B4A` |
| WarRoomSpeedcash | `/war-room/speedcash` | 6: Executive/Growth&Churn/Segmentation/Margin/Cohort/Action Center | `#F97316` |
| WarRoomEkspedisi | `/war-room/ekspedisi` | 5: Executive/Trendline/Outlet Movement/Execution Queue/Revenue Quality | `#8B5CF6` |
| WarRoomFastpay | `/war-room/fastpayglobal` | 5: Executive/Growth&Decline/Outlet Detail/Revenue Analysis/Action Center | `#F59E0B` |
| WarRoomFarming | `/war-room/farming` | 5 (mirip Fastpay, period-based) | `#10B981` |
| WarRoomPAProduk | `/war-room/pa-produk` | Trendline multi-line, Pareto, product detail | `#639922` |
| WarRoomMgmPa | `/war-room/mgm-pa` | 5: Overview/Top Upline/Sebaran Wilayah/Data Tabel/Cari Outlet | `#10B981`/`#3B82F6` |
| WarRoomPaAsdp | `/war-room/pa-asdp` | 6: Executive/Outlet/Upline/Kota/Tipe Outlet/Growth | `#3B82F6` |
| WarRoomPaLpd | `/war-room/pa-lpd` | 6 (sama pola PaAsdp) | `#9333EA` |
| WarRoomBumdes | `/war-room/bumdes` | 6 (sama pola) | `#0D9488` |
| WarRoomAsdp | `/war-room/asdp` | single-snapshot, mirip PaAsdp tanpa filter bulan | `#3B82F6` |
| WarRoomLpd | `/war-room/lpd` | single-snapshot, mirip PaLpd tanpa filter bulan | `#9333EA` |
| WarRoomDmFastpay | `/war-room/dm-fastpay` | Tabel perbandingan Apr/Mei/Jun + ROI/konversi | `#0EA5E9` |
| WarRoomHunter | `/war-room/hunter` | Command center, leaderboard, action queue, funnel, revenue loss | tanpa warna khusus |
| WarRoomInstaqrisTrx | `/war-room/instaqris-trx` | 10 tab: Executive/Merchant/Segmentasi/Cohort/Score/Territory/Growth/Kategori/Action/Export | `#7F77DD` |
| WarRoomIqRaw | `/war-room/iq-raw` | 5 tab (mirip WarRoom InstaQris tapi per-kategori bukan per-MCC) | `#0EA5E9` |
| WarRoomTrxOutlet | `/war-room/trx-outlet` | 9 tab: Executive/Outlet/Segmentasi/Trend/Kategori/Territory/Growth/Action/Export | `#2563EB` |
| WarRoomQris (legacy) | `/war-room/penerbitan-qris` | 5 tab: Ringkasan/Penerbitan Harian/Per Kategori/Per Provinsi/Action Center | `#EC4899` |
| WarRoomQrisControlTower | `/war-room/qris-control-tower` | 7 tab (lihat bagian khusus) | `#0891B2` |

Semua war-room outlet-level page umumnya punya pola sama: KPI cards → chart (donut/scatter/HBar) → tabel detail (server-side atau client-side paginated) → export CSV → Action Center dengan prioritas P0-P3 & WhatsApp deep-link (`https://wa.me/{no_hp}`).

---

# BAGIAN 3 — QRIS CONTROL TOWER (fitur paling kompleks)

## Konsep
Melacak pipeline registrasi & verifikasi merchant QRIS dari 4 sumber Google Sheet (Data Merchant, KYCKYM, VerifikasiOP, PTEN) yang di-join menjadi satu record per outlet, lalu dihitung **stage, owner, SLA, priority** SEPENUHNYA DI BACKEND. Frontend murni presentasi/filter — tidak ada logic bisnis di frontend.

## 11 Stage (`STAGE` enum, backend & frontend `qrisConstants.js` harus SELALU sinkron)
```
Baru Daftar → Belum Isi KYC → Belum Submit Foto → Menunggu Verifikasi OS
  → [APPROVE] → Siap Submit PTEN → [Pending/Menunggu PTEN] → QRIS Terbit (terminal)
  → [REJECT/Perbaikan Data di OP atau PTEN] → Perlu Perbaikan Data (balik ke merchant)
Data Belum Lengkap / Perlu Review = kondisi edge-case
```
Stage ditentukan via cascade rule (`getCurrentStage()`), priority tertinggi: PTEN APPROVE > Pending/Menunggu PTEN > Rejected/Perbaikan > Siap Submit PTEN > Menunggu Verifikasi OS > Belum Lengkap > Baru Daftar (cek KYC/foto/aktivasi kosong) > Belum Isi KYC > Belum Submit Foto > Perlu Review (catch-all).

## SLA per Stage (`STAGE_SLA_MINUTES`)
| Stage | SLA |
|---|---|
| Baru Daftar | 30 menit |
| Belum Isi KYC, Belum Submit Foto, Siap Submit PTEN | 60 menit |
| Menunggu Verifikasi OS | 30 menit |
| Pending/Menunggu PTEN, Perlu Perbaikan, Data Belum Lengkap, Perlu Review | 1440 menit (24 jam) |
| QRIS Terbit | tidak ada (terminal) |

Status SLA: `aging/sla > 1.0` → **Breach** (merah), `≥0.7` → **Warning** (amber), `<0.7` → **On Track** (hijau).

## Priority P0-P3
Cascade rule (backend `getPriorityLevel`), lihat detail lengkap di file `warroom-qris-control-tower.js`. Ringkas: P0 = butuh aksi SEKARANG (menunggu verifikasi OS, siap submit PTEN, atau breach di tahap PTEN, atau baru direvisi merchant); P1 = follow-up cepat (rejected, data belum lengkap>2jam, SLA warning); P2 = monitoring (default aktif normal); P3 = selesai (QRIS Terbit).

**Priority score** (secondary sort dalam level yang sama): `agingScore + stageWeight(±) + readinessWeight(+40 jika KYC&foto lengkap) + riskWeight(+25 reject, +15 MCC high-risk) + slaBreachWeight(+50)`.

**MCC High-Risk keywords**: FINANCIAL, WIRE TRANSFER, MARKETPLACES, DIGITAL GOODS, PROFESSIONAL SERVICES, COMPUTER PROGRAMMING (substring match, case-insensitive).

## Reject Category (content-based classification dari teks alasan reject)
- "foto usaha tidak mencerminkan..." → Foto Tidak Sesuai Usaha
- "screenshot"/"marketplace"/"online" → Foto Dari Sumber Online
- "nama pemilik tidak sesuai"/"ktp" → Data KTP Tidak Sesuai
- "tidak ada foto" → Foto Tidak Ada

## 7 Tab Frontend (`WarRoomQrisControlTower.jsx`)
| Tab | Fokus | Filter |
|---|---|---|
| Command Center | KPI + funnel 7-step + insight otomatis + top 10 P0 hari ini | quick filter (Semua/Hari ini/Over SLA/Belum Terbit) |
| Smart Queue | Work queue utama, 150/page | stage, owner, status OP, status PTEN, SLA, MCC, priority |
| SLA & Aging | Breach + stuck-too-long (top 50 aging) | SLA, aging bucket, owner, stage |
| Merchant Follow-Up | hanya `isMerchantBacklog=true` | followup type, reject category, aging, MCC |
| Verifikasi & PTEN | hanya `isInternalBacklog=true` | internal stage, SLA, status OP, status PTEN |
| Reject Analysis | `statusPTEN=REJECTED OR statusVerifikasiOP=Perbaikan Data` | reject category, MCC, stage, status |
| Raw Data & Audit | 19 kolom lengkap + export CSV | stage, status OP, status PTEN, completeness |

Aging bucket: 0-30m, 30-60m, 1-4j, 4-24j, >24j.

8 action per row (belum semua terhubung backend, sebagian hanya toast/clipboard): verify_now, assign_to_me, copy_reminder (WA template otomatis sesuai reject_category/stage), copy_reject_reason, mark_followed_up, escalate_pten, recheck_status, done_archive.

## Backend Sync (4 endpoint, tiap 30 menit via Apps Script)
```
POST /api/warroom/qris-ctrl/merchant/sync       ← sheet "Data Merchant"
POST /api/warroom/qris-ctrl/kyckym/sync         ← sheet "KYCKYM"
POST /api/warroom/qris-ctrl/verifikasi-op/sync  ← sheet "VerifikasiOP"
POST /api/warroom/qris-ctrl/pten/sync           ← sheet "PTEN"
```
Semua simpan raw row sebagai JSONB (`row_data`), key `id_outlet`, chunk 500/batch, dedup last-occurrence-wins, proses async via `setImmediate()`.

`GET /api/warroom/qris-ctrl/analytics` — join 4 tabel, hitung semua field kalkulasi (stage/owner/aging/SLA/priority/reject category), sort P0→P3 lalu priority score desc, return `{ records[], total, empty, last_sync }`.

---

# BAGIAN 4 — GOOGLE APPS SCRIPT

Semua file `apps-script-*.js` di root repo adalah source code yang di-copy-paste manual ke Google Apps Script Editor (bukan dijalankan dari repo). Sync token yang dipakai HAMPIR SEMUA `bric2026bimasaktisecret` (kecuali MGM PA yang beda: `bric2026mgmpasecret`, ditulis langsung di kode Apps Script masing-masing War Room, bukan di file ini).

| File | Sheet Source | Endpoint Tujuan | Trigger | Catatan Khusus |
|---|---|---|---|---|
| `apps-script.js` | (legacy, sheet scoreboard) | Query API `doGet()` read-only, TIDAK terkait QRIS Control Tower | manual | Auth via query param `?token=` |
| `apps-script-ekspedisi.js` | `1yVNeyHe3b_PLnFf3SGvLx3wuD4Gm3e6XItjiDADd_Lo` tab "Ekspedisi" | `POST /api/warroom/ekspedisi/sync` (Bearer auth header, BEDA dari yang lain!) | harian 23:30 UTC (06:30 WIB) | **Deteksi blok bulan otomatis** — baca row 2 label bulan, stride 3 kolom, tahun ditentukan otomatis (blok kanan = tahun berjalan) |
| `apps-script-bumdes.js` | `1_9n2qYrY0qOHFyQWwCttPxxbqjEiB1Cbe24FtTNXpts`, 12 sheet bulanan | `POST /api/warroom/bumdes/sync` (header x-sync-token) | harian 23:00 UTC (06:00 WIB) | Header row 13, data row 14+, kolom A-N |
| `apps-script-pa-lpd.js` | `10cqIuji7iYi8u7hRR19xtMBVRI-ZyfwG4eNlsbAjPzc`, 12 sheet bulanan | `POST /api/warroom/pa-lpd/sync` (x-sync-token) | harian 23:00 UTC (06:00 WIB) | Header row 15, data row 16+ (BEDA row dari BUMDes!), `BULAN_MAP` pakai `new Date().getFullYear()` dinamis |
| `apps-script-qris-control-tower.js` | Sheet QRIS Issuance (4 tab live-state) | 4 endpoint `qris-ctrl/*` (x-sync-token) | **tiap 30 menit** (paling sering, karena SLA tertipis 30 menit) | Fungsi: `pushQrisControlTowerSemua()`, `setupQrisControlTowerTrigger()` |

`cleanNum()` guard di semua Apps Script WAJIB cek `typeof v === 'number'` dulu sebelum string processing (lihat catatan Speedcash di atas) — bug ini pernah terjadi dan fix-nya harus direplikasi di semua Apps Script baru.

---

# BAGIAN 5 — INFRASTRUKTUR

## Nginx (`/etc/nginx/sites-enabled/bric`, sumber: `nginx-bric.conf`)
- Rate limit zone: `bric_api` 500r/m, `bric_login` 5r/m (burst 3, `limit_req_status 429`).
- Blokir semua search engine/crawler user-agent (googlebot, bingbot, gptbot, claudebot, ccbot, anthropic, dll → 403).
- Regex sync endpoint (body besar, tanpa rate limit, timeout 120s, `client_max_body_size 30m`):
  ```
  ^/api/(warroom/(segmen|speedcash|ekspedisi|fastpay|farming|pa-produk|pa-arpu|mgm|dm-fastpay|
    instaqris-trx|asdp|bumdes|lpd|hunter)|data-raw/(outlet|affiliate|qris|trx))/sync$
  ```
  **PENTING**: endpoint sync baru (misalnya `pa-asdp/sync`, `pa-lpd/sync`, `qris-ctrl/*/sync`) HARUS ditambahkan ke regex ini juga jika belum masuk daftar, atau body besar akan ditolak nginx sebelum sampai ke Express.
- `/api/auth/login` → limit_req zone bric_login.
- `/api/*` lainnya → limit_req zone bric_api (burst 100).
- SPA fallback: `try_files $uri $uri/ /index.html`.
- Security headers: X-Frame-Options DENY, X-Content-Type-Options nosniff, HSTS, Permissions-Policy, dll.

## PM2
- v7.0.1, jalan sebagai user `admin` (BUKAN root). Selalu `sudo -u admin pm2 <cmd>` dari root SSH.
- God Daemon PID 1087, auto-restart on crash. **JANGAN** `pkill node` — PM2 akan restart otomatis dengan kode LAMA (belum di-reload).
- Reload kode baru: `sudo -u admin pm2 reload bric-backend`. Restart hard: `sudo -u admin pm2 restart bric-backend`.
- Logs: `/home/admin/.pm2/logs/bric-backend-{out,error}.log`.

## Deploy Workflow (Python paramiko, karena Node.js tidak ada di PATH Windows lokal)
```python
import paramiko, sys
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("147.139.201.43", username="root", password="[JANGAN tulis plaintext di kode — lihat catatan terpisah]", timeout=30)
cmds = [
  "cd /home/admin/bric-dashboard && git pull origin master 2>&1",
  "cd /home/admin/bric-dashboard/frontend && npm run build 2>&1 | tail -6",
  "cp -r /home/admin/bric-dashboard/frontend/dist/* /var/www/bric/ && echo Done",
  "sudo -u admin pm2 reload bric-backend && sleep 2 && curl -s http://localhost:3001/health",
]
```
Script serupa sudah ada di root repo: `deploy_full.py`, `deploy_frontend.py`, `deploy_migration.py`, `deploy_hunter.py`, `deploy_wb.py`, `deploy_dm.py`, `deploy_pa_lpd.py`. Untuk migration SQL baru, tambahkan step `node backend/scripts/run-XXX-migration.js` di daftar `cmds`.

Migration runner scripts (`backend/scripts/*.js`) pola standarnya: baca file `.sql` di `backend/src/migrations/`, jalankan via `pool.query(sql)`, lalu `pool.end()`. Contoh: `run-ekspedisi-migration.js`, `run-ekspedisi-outlet-status-migration.js`, `run-qris-ctrl-migration.js`.

---

# CATATAN UNTUK AI (baca sebelum mengubah kode)

1. **Jangan asumsi nama kolom sama antar war-room** — tiap domain punya konvensi sendiri (`trx_mei`/`trx_jun` vs `trx_prev`/`trx_curr` vs `trx_mei`/`trx_juni`). Selalu buka file route spesifik dulu.
2. **Cek dulu apakah war-room itu single-snapshot atau multi-bulan** sebelum menambah fitur filter bulan — ASDP & LPD punya 2 varian (single vs PA multi-bulan) yang sering membingungkan.
3. **Sync token MGM PA beda** (`bric2026mgmpasecret`) dari semua war-room lain (`bric2026bimasaktisecret`). Jangan disamakan saat membuat war-room baru kecuali diminta eksplisit.
4. **Endpoint sync baru wajib didaftarkan SEBELUM** `app.use('/api/warroom', requireAuth, ...)` di `app.js`, DAN wajib ditambahkan ke regex nginx `bric-bric.conf` jika payload besar (>1MB), atau nginx akan menolak duluan.
5. **`cleanNum()` di Apps Script manapun wajib guard `typeof v === 'number'` dulu** — lihat insiden Speedcash 100x salah karena titik desimal terhapus saat treat number sebagai string.
6. **Jangan pernah menulis password VPS/DB dalam bentuk plaintext** ke file manapun di repo ini (termasuk file dokumentasi ini) — sudah ada insiden password root ter-expose di beberapa `deploy_*.py` lama, jangan direplikasi ke file baru.
7. **`WarRoomAffiliateAnalitik.jsx`** adalah dead code (sengaja direvert dari routing). Jangan aktifkan kembali tanpa konfirmasi user.
8. **QRIS Control Tower TIDAK ADA logic bisnis di frontend** — semua kalkulasi stage/SLA/priority di backend. Jika ada bug tampilan, cek dulu apakah data dari backend sudah benar sebelum ubah frontend.
9. Tabel `wb_*` (War Room Builder) ada di migration tapi belum dipakai aktif oleh war-room manapun — kemungkinan infrastruktur untuk fitur self-service war-room builder di masa depan. Jangan hapus, tapi juga jangan asumsikan sudah terintegrasi.
10. File `backend/scripts/test-qris-control-tower.js` tersedia untuk test manual logic stage/SLA/priority engine tanpa perlu hit endpoint sungguhan — gunakan ini saat mengubah business logic QRIS Control Tower.
