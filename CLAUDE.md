# BRIC Dashboard — Project Briefing

## Overview
Dashboard analitik bisnis untuk BMS Retail (bmsretail.my.id). Diakses oleh tim internal.

## Stack
- **Frontend**: React 18 + Vite + react-router-dom v6, Chart.js (`import Chart from 'chart.js/auto'`), Tabler Icons webfont CDN
- **Backend**: Node.js + Express.js, JWT auth via `requireAuth` middleware
- **Database**: PostgreSQL via `pool` (backend/src/db.js), user: `bricuser`
- **Data source**: `backend/data/scoreboard.json` (sync dari Google Sheets)
- **Process manager**: nohup node (BUKAN pm2 — pm2 list selalu kosong)
- **Web server**: Nginx, frontend di `/var/www/bric/`

## VPS
- IP: 147.139.201.43
- User SSH: root
- Repo di VPS: `/home/admin/bric-dashboard`
- Deploy: git pull → npm run build → cp dist/* /var/www/bric/ → pkill + nohup restart
- Deploy via Python paramiko dari lokal (Node.js tidak ada di PATH lokal)

## Struktur Backend (`backend/src/`)
```
app.js          — route registration hub
db.js           — PostgreSQL pool
middleware/auth.js
routes/
  auth.js
  scoreboard.js
  users.js
  winme.js
  paymentagent.js
  dompetdigital.js
  members.js           — CRUD leader & tim (GET, POST, PUT, DELETE, targets, pencapaian)
  presence.js          — ping setiap 30s, active user list
  warroom.js           — WAR-ROOM InstaQris + Speedcash + PA Produk + PA ARPU + MGM PA
  warroom-ekspedisi.js — WAR-ROOM Ekspedisi (sync + analytics + outlets)
  warroom-fastpay.js   — WAR-ROOM Fastpay Global (sync + analytics + outlets)
  warroom-farming.js   — WAR-ROOM Farming (sync + analytics + outlets)
  system.js            — Server Monitor: CPU, RAM, disk, PostgreSQL stats
  ai.js                — Gemini 2.5 Flash chat, retry 3x backoff
  ai-context.js        — system prompt builder, selalu load SEMUA data, chat_history CRUD
```

### Route yang terdaftar di app.js
```js
/api/auth/login                      — authRoutes (no auth), rate limit 10/15min
/api/scoreboard                      — requireAuth
/api/users                           — requireAuth
/api/winme                           — requireAuth
/api/paymentagent                    — requireAuth
/api/dompetdigital                   — requireAuth
/api/members                         — requireAuth
/api/presence                        — requireAuth
/api/ai                              — requireAuth
/api/ai-context                      — requireAuth
/api/warroom/segmen/sync             — token auth (BUKAN JWT), no rate limit, body max 30mb
/api/warroom/speedcash/sync          — token auth (BUKAN JWT), no rate limit, body max 30mb
/api/warroom/ekspedisi/sync          — token auth (BUKAN JWT)
/api/warroom/ekspedisi/analytics     — requireAuth
/api/warroom/fastpay/sync            — token auth (BUKAN JWT)
/api/warroom/fastpay/analytics       — requireAuth
/api/warroom/fastpay/outlets         — requireAuth
/api/warroom/farming/sync            — token auth (BUKAN JWT)
/api/warroom/farming/analytics       — requireAuth
/api/warroom/farming/outlets         — requireAuth
/api/warroom/pa-produk/sync          — token auth (BUKAN JWT)
/api/warroom/pa-arpu/sync            — token auth (BUKAN JWT)
/api/warroom/mgm/sync                — token auth (BUKAN JWT)
/api/warroom/mgm/analytics           — requireAuth
/api/warroom/mgm/search              — requireAuth (via /api/warroom router)
/api/warroom                         — requireAuth (semua GET endpoint di bawahnya)
/api/system/stats                    — requireAuth
```

### Penting — Urutan registrasi route di app.js
Sync endpoints HARUS didaftarkan **sebelum** `app.use('/api/warroom', requireAuth, ...)` agar bypass JWT:
```js
app.post('/api/warroom/segmen/sync',      warroomRoutes.syncHandler);
app.post('/api/warroom/speedcash/sync',   warroomRoutes.speedcashSyncHandler);
app.post('/api/warroom/ekspedisi/sync',   ekspedisiRoutes.syncHandler);
app.get('/api/warroom/ekspedisi/analytics', requireAuth, ekspedisiRoutes.analyticsHandler);
app.post('/api/warroom/fastpay/sync',     fastpayRoutes.syncHandler);
app.get('/api/warroom/fastpay/analytics', requireAuth, fastpayRoutes.analyticsHandler);
app.get('/api/warroom/fastpay/outlets',   requireAuth, fastpayRoutes.outletsHandler);
app.post('/api/warroom/farming/sync',     farmingRoutes.syncHandler);
app.get('/api/warroom/farming/analytics', requireAuth, farmingRoutes.analyticsHandler);
app.get('/api/warroom/farming/outlets',   requireAuth, farmingRoutes.outletsHandler);
app.post('/api/warroom/pa-produk/sync',   warroomRoutes.paProdukSyncHandler);
app.post('/api/warroom/pa-arpu/sync',     warroomRoutes.paArpuSyncHandler);
app.post('/api/warroom/mgm/sync',         warroomRoutes.mgmSyncHandler);
app.get('/api/warroom/mgm/analytics',     requireAuth, warroomRoutes.mgmAnalyticsHandler);
app.use('/api/warroom',   requireAuth, warroomRoutes);
app.use('/api/system',    requireAuth, systemRoutes);
```

### Express body limit & Rate limit
- `express.json({ limit: '30mb' })` — dinaikkan untuk handle 40k+ baris dari Apps Script
- Rate limit global: **1000 req/menit per IP** (dinaikkan dari 300 karena semua user kantor share satu NAT IP)
- Login rate limit: 10 percobaan / 15 menit

## Struktur Frontend (`frontend/src/`)
```
App.jsx             — routes: /scoreboard, /winme, /payment-agent, /dompet-digital,
                      /users, /anggota/:id, /scoreboard-tim, /scoreboard-tim-pa,
                      /scoreboard-tim-sc, /war-room/instaqris, /war-room/speedcash,
                      /war-room/ekspedisi, /war-room/fastpayglobal, /war-room/farming,
                      /war-room/pa-produk, /war-room/mgm-pa, /leader-scoreboard,
                      /server-monitor
index.css           — semua CSS (CSS variables: --primary #1D9E75, --text-1/2/3/4, --border, --bg-page, --bg-card, dll)
                      CSS prefix: lm-* (LeaderManagement), ad-* (AnggotaDetail), st-* (ScoreboardTim)
                      CSS prefix: wr-* (WAR-ROOM shared), aic-* (AI Chat)
                      CSS prefix: wrd-* (WAR-ROOM Speedcash Dashboard — tab nav, KPI cards, chart cards, badges)
                      .main-content: TIDAK ada max-width — full width
services/api.js     — semua API calls pakai authHeaders()
utils/auth.js       — getToken, getUser, logout
components/
  Layout.jsx
  Sidebar.jsx       — nested accordion: Winme (L1) → Scoreboard Tim (L2) → LeaderAccordion per-leader (L3)
                      Payment Agent (L1) → War Room sub-section (Produk, Ekspedisi, Fastpay, Farming, MGM PA)
                      separator antar menu utama: .sidebar-menu-sep
                      .sidebar-warroom-label / .sidebar-warroom-item / .sidebar-warroom-badge — War Room sub-items
  ProtectedRoute.jsx
  AiChat.jsx        — floating AI chat, Gemini 2.5 Flash, quick questions per halaman
  LeaderManagement.jsx  — CRUD modal: tambah/edit anggota, targets, input pencapaian harian
                          posisi Tim wajib memilih leader_id
pages/
  Login.jsx
  Scoreboard.jsx
  WinmeInstaqris.jsx    — hanya Pencapaian Unit
  ScoreboardTim.jsx     — /scoreboard-tim, analytics dashboard per-leader, modal Kelola Tim
  PaymentAgent.jsx      — unit PAYMENT AGENT, warna #639922
  DompetDigital.jsx     — grup SpeedCash/Travel B2C/Pulsagram
  UserManagement.jsx
  AnggotaDetail.jsx     — /anggota/:id, profil + target cards + bar chart riwayat
  WarRoom.jsx           — /war-room/instaqris, monitoring segmen MCC InstaQris
  WarRoomSpeedcash.jsx  — /war-room/speedcash, dashboard analitik 6 tab outlet Speedcash
                          Tab: Executive Summary · Growth & Churn · Merchant Segmentation
                               Margin Analysis · Cohort Analysis · Action Center
                          Semua data dari endpoint /api/warroom/speedcash/analytics
                          Komponen internal: KPICard, ChartCard, InsightBox, StatusBadge,
                          SegmentBadge, HBarChart, VGroupedBar, DonutChart, ScatterPlot, NoHpLink
                          Export CSV tersedia di tab Growth, Segmentation, dan Action Center
                          Kolom outlet: id_outlet, nama, no_hp (WhatsApp link via NoHpLink)
  WarRoomEkspedisi.jsx  — /war-room/ekspedisi, monitoring ekspedisi PA (badge: Okta)
  WarRoomFastpay.jsx    — /war-room/fastpayglobal, monitoring Fastpay Global PA (badge: Ainul)
  WarRoomFarming.jsx    — /war-room/farming, monitoring Farming PA (badge: Nizar)
  WarRoomPAProduk.jsx   — /war-room/pa-produk, monitoring produk PA (⚡ Produk)
  WarRoomMgmPa.jsx      — /war-room/mgm-pa, dashboard MGM PA 2 tab:
                          Tab "Dashboard" — KPI summary, distribusi tipe outlet, top upline, provinsi
                          Tab "Cari Outlet" — search by id_outlet OR upline, filter bulan, shows true total
                          Filter bulan: Semua Bulan / Mei (2025-05) / Jun (2025-06)
                          Search limit: 2000 rows tampil, COUNT(*) terpisah untuk total sebenarnya
  LeaderScoreboard.jsx  — /leader-scoreboard
  ServerMonitor.jsx     — /server-monitor (admin only)
                          Auto-refresh 15s dengan countdown timer
                          Komponen: Gauge (bar merah di ≥90%, kuning ≥70%), KPI, Dot, StateBadge
                          Gauge "Heap vs RAM Server" — heap_used dibagi mem_total (bukan heap_total)
                          Tabel: table sizes + mini bar + dead_rows + last vacuum
                          Active queries: duration merah jika > 10s, kuning > 3s
                          Endpoint: GET /api/system/stats
```

## Database Tables
```sql
-- Existing
daily_snapshot (id, unit_nama, tanggal, revenue, ...)

-- Leader & Tim
members (id, unit, nama, posisi CHECK('leader','tim'), fungsi, avatar_warna DEFAULT '#7F77DD',
         leader_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
         is_active, created_at, updated_at)
member_targets (id, member_id FK CASCADE, nama_target, key_result, target_revenue, periode, urutan, created_at)
member_pencapaian (id, member_id FK, target_id FK, tanggal, pencapaian_kr, pencapaian_revenue, pct_kr, pct_revenue, catatan, UNIQUE(target_id, tanggal))

-- AI Chat
chat_history (id, user_id, username, page, role CHECK('user','model'), message TEXT, created_at)
-- Grant: GRANT USAGE, SELECT ON SEQUENCE chat_history_id_seq TO bricuser;

-- WAR-ROOM InstaQris
segmen_snapshot (id, tanggal, mcc, kategori, apr/mei/jun _merchant/_trx/_rev,
                 dev_apr_jun_*/dev_mei_jun_*, synced_at, UNIQUE(tanggal, mcc))
-- Filter saat sync: skip mcc NULL/kosong/non-numerik atau label 'total'

-- WAR-ROOM Speedcash
speedcash_snapshot (id, tanggal, id_outlet VARCHAR(30), tgl_reg DATE,
                    trx_mei, margin_mei, trx_jun, margin_jun,
                    dev_trx, dev_margin, synced_at,
                    no_hp VARCHAR(25), nama VARCHAR(150),    -- ditambah Juni 2025
                    UNIQUE(tanggal, id_outlet))
-- Index: idx_speedcash_tanggal, idx_speedcash_outlet
-- Grant: GRANT ALL ON speedcash_snapshot TO bricuser;
--        GRANT USAGE, SELECT ON SEQUENCE speedcash_snapshot_id_seq TO bricuser;
-- CATATAN: Apps Script cleanNum harus guard typeof number DULU sebelum string processing
--          agar tidak mengira 408146.85 → "40814685" (100x salah karena dot desimal ikut dihapus)

-- WAR-ROOM MGM PA
mgm_aktivasi (id, bulan VARCHAR(7), upline VARCHAR(30), id_outlet VARCHAR(30),
              nama_pemilik VARCHAR(150), tipe_outlet VARCHAR(50), balance NUMERIC,
              is_active SMALLINT, nama_kota VARCHAR(100), nama_propinsi VARCHAR(100),
              tanggal_aktifasi DATE, trx BIGINT, rev NUMERIC, synced_at,
              UNIQUE(bulan, id_outlet))
mgm_registrasi (id, bulan VARCHAR(7), upline VARCHAR(30), id_outlet VARCHAR(30),
                nama_pemilik VARCHAR(150), tipe_outlet VARCHAR(50), balance NUMERIC,
                is_active SMALLINT, nama_kota VARCHAR(100), nama_propinsi VARCHAR(100),
                tanggal_registrasi DATE, tanggal_aktifasi DATE, synced_at,
                UNIQUE(bulan, id_outlet))
-- Search: WHERE (UPPER(id_outlet) LIKE $1 OR UPPER(upline) LIKE $1) — upline bisa jadi search target
-- LIMIT 2000 + COUNT(*) paralel untuk total sebenarnya
```

## Sidebar Accordion
- Nested 3 level: Winme (L1) → Scoreboard Tim (L2) → LeaderAccordion per-leader (L3)
- Auto-buka jika path `/winme`, `/scoreboard-tim`, atau `/anggota/:id`
- Payment Agent (L1) → auto-buka jika path `/payment-agent`, `/scoreboard-tim-pa`, `/war-room/ekspedisi`, `/war-room/fastpayglobal`, `/war-room/farming`, `/war-room/pa-produk`
- Chevron rotate 180° saat terbuka (class `sidebar-chevron--open`)
- Animasi height via `scrollHeight` + `requestAnimationFrame` (komponen `Accordion`)
- Tiap leader punya accordion sendiri (`LeaderAccordion`) — Tim tampil sebagai sub-item di bawah leader-nya
- Event `membersUpdated` untuk refresh list setelah CRUD
- Separator antar menu utama: `<div className="sidebar-menu-sep" />` (garis tipis 1px)
- War Room sub-items di Payment Agent pakai class `.sidebar-warroom-item` + `.sidebar-warroom-badge`

## Menu Order (Sidebar)
1. Unit Scoreboard
   ── [separator] ──
2. Leader Scoreboard
   ── [separator] ──
3. Winme & InstaQris (L1 accordion)
   └─ Scoreboard Tim (L2 accordion)
      └─ [Leader accordion] → Tim sub-list
   └─ ⚔ WAR-ROOM InstaQris → /war-room/instaqris
   ── [separator] ──
4. Payment Agent (L1 accordion)
   └─ Scoreboard Tim PA (L2 accordion)
      └─ [Leader accordion] → Tim sub-list
   └─ [War Room label]
      ├─ ⚡ Produk          → /war-room/pa-produk
      ├─ Ekspedisi [Okta]   → /war-room/ekspedisi
      ├─ Fastpay Global [Ainul] → /war-room/fastpayglobal
      ├─ Farming [Nizar]    → /war-room/farming
      └─ MGM PA [MGM]       → /war-room/mgm-pa
   ── [separator] ──
5. Speedcash (L1 accordion, label "Speedcash")
   └─ Scoreboard Tim (L2 accordion)
      └─ [Leader accordion] → Tim sub-list
   └─ WAR-ROOM Speedcash → /war-room/speedcash
   ── [separator] ──
6. Server Monitor → /server-monitor (admin only, icon #6366F1)
   ── [separator] ──
7. Kelola User → /users (admin only)

## Icons
Tabler Icons webfont — gunakan `<i className="ti ti-xxx" />` bukan SVG.
CDN sudah ada di `frontend/index.html`.

## Warna per Unit
- Winme & InstaQris grup: `#7F77DD`
- Winme: `#378ADD`, InstaQris: `#7F77DD`
- Payment Agent: `#639922`
- Dompet Digital grup: `#D85A30`
- SpeedCash: `#EF4444`, Travel B2C: `#1D9E75`, Pulsagram: `#378ADD`
- WAR-ROOM InstaQris: `#E24B4A` (merah)
- WAR-ROOM Speedcash: `#F97316` (oranye)
- WAR-ROOM Ekspedisi: `#8B5CF6` (ungu)
- WAR-ROOM Fastpay Global: `#F59E0B` (kuning)
- WAR-ROOM Farming: `#10B981` (hijau)
- WAR-ROOM MGM PA: `#10B981` (hijau)
- Server Monitor: `#6366F1` (indigo)

## WAR-ROOM — Catatan Penting

### InstaQris (`/war-room/instaqris`)
- Data source: Google Sheet → Apps Script `pushSegmenToVPS()` → POST /api/warroom/segmen/sync
- Sync token: `bric2026bimasaktisecret`
- Anomali: `dev_mei_jun_merchant > 0 && dev_mei_jun_rev < 0`
- Filter sync: skip baris dengan mcc NULL, kosong, non-numerik, atau ILIKE 'total'
- Upsert: UNIQUE(tanggal, mcc) — hari sama timpa, hari beda simpan baru

### Speedcash (`/war-room/speedcash`)
- Data source: Google Sheet `1MIpXkyU_COR_ptTvweKQKFYT0pxWIo_5zfCC90Gqlck` tab "Juni"
- Apps Script: `pushSpeedcashToVPS()` — baca semua data sekaligus (bukan row by row)
- Kolom sheet: id_outlet, tgl_reg, trx_mei, margin_mei, trx_jun, margin_jun, dev_trx, dev_margin, **no_hp, nama** (10 kolom)
- ~40.000+ baris outlet → kirim langsung (nginx & Express limit sudah 30mb)
- Anomali: `dev_trx > 0 && dev_margin < 0`
- Outlet baru: `tgl_reg >= tanggal - 1 bulan`
- Upsert: UNIQUE(tanggal, id_outlet)
- Trigger harian: `setupSpeedcashTrigger()` → jam 23.00 UTC (06.00 WIB)

#### Apps Script `cleanNum` — PENTING
Google Sheets `getValues()` mengembalikan JavaScript Number untuk cell numerik. Fungsi `cleanNum` HARUS mengecek tipe dulu:
```javascript
function cleanNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;  // angka dari GSheet — gunakan langsung!
  const s   = String(v).replace(/Rp\s*/gi, '').trim();
  const neg = s.startsWith('(') && s.endsWith(')');
  const num = parseFloat(s.replace(/[()]/g, '').replace(/,/g, '')) || 0;
  return neg ? -num : num;
}
```
Tanpa guard ini: `408146.85` → String → hapus titik → `40814685` = 100x terlalu besar.

#### Endpoint Analytics (`GET /api/warroom/speedcash/analytics`)
Endpoint untuk dashboard 6 tab. Satu request → 20 query paralel.
- **Step 1**: Hitung threshold percentile via `PERCENTILE_CONT` (P25/P50/P75 TRX & Margin)
- **Step 2**: Inject threshold ke inline SQL CASE WHEN untuk segmentasi server-side
- Data yang dikembalikan:
  - `summary` — aggregasi total outlet, TRX, margin, growth counts
  - `thresholds` — `{ trxP75, trxP25, trxP50, marginP75, marginP25 }`
  - `growth_counts` — jumlah per status: growing/declining/churned/new_active/stable
  - `segment_counts` — jumlah per segmen merchant
  - `top10_trx`, `top10_margin` — top 10 untuk Executive Summary (include nama, no_hp)
  - `top20_dt_pos/neg`, `top20_dm_pos/neg` — top/bottom 20 DEV TRX & Margin (include nama, no_hp)
  - `growth_table` — union 5 kategori (150+150+300+300+50 rows) dengan field `growth_status` (include nama, no_hp)
  - `scatter_data` — max 4000 outlet aktif dengan field `segment` & `avg_margin_per_trx`
  - `top20_margin_jun`, `top20_dev_margin`, `bot20_dev_margin` — untuk Margin Analysis (include nama, no_hp)
  - `cohort_year` — agregasi per tahun registrasi
  - `cohort_month` — agregasi per bulan+tahun registrasi (untuk heatmap)
  - `action_drop`, `action_growth`, `action_high_trx`, `action_rising` — daftar prioritas Action Center (max 50 each, include nama, no_hp)

#### Segmentasi Merchant (threshold-based, computed server-side)
| Segmen | Kondisi |
|--------|---------|
| superstar | trx_jun ≥ P75 AND margin_jun ≥ P75 |
| rising_star | (trx_mei=0 OR trx_mei < P25) AND trx_jun > P50 AND dev_margin > 0 |
| at_risk | trx_mei ≥ P75 AND trx_jun < trx_mei × 0.75 |
| high_trx_low_margin | trx_jun ≥ P75 AND margin_jun < P25 |
| low_trx_high_margin | trx_jun < P25 AND margin_jun ≥ P75 |
| low_value | else (aktif) |
| inactive | trx_jun = 0 |

#### Warna Segmen (SEGMENT_COLORS di WarRoomSpeedcash.jsx)
- superstar: `#7C3AED`, rising_star: `#059669`, at_risk: `#DC2626`
- high_trx_low_margin: `#D97706`, low_trx_high_margin: `#2563EB`, low_value: `#9CA3AF`

#### Action Center — 4 Prioritas
- `drop` (🚨 Wajib Diselamatkan) — outlet dengan dev_trx negatif terbesar
- `growth` (📈 Wajib Dihubungi) — outlet dev_trx & dev_margin positif terbesar
- `optimize` (⚡ Wajib Dioptimasi) — outlet high TRX tapi low margin
- `testimony` (⭐ Wajib Testimoni) — rising stars / outlet baru dengan growth besar

### MGM PA (`/war-room/mgm-pa`)
- Data source: Google Sheet → Apps Script → POST /api/warroom/mgm/sync
- Sync token: `bric2026bimasaktisecret` (sama dengan InstaQris)
- Body: `{ bulan: "YYYY-MM", aktivasi: [...], registrasi: [...] }`
- Upsert: UNIQUE(bulan, id_outlet) pada masing-masing tabel — per bulan timpa
- Dua tabel terpisah: `mgm_aktivasi` (outlet aktif + TRX/REV) & `mgm_registrasi` (outlet baru daftar)
- Filter bulan di dashboard: default bulan terbaru dari DB
- Search endpoint `GET /api/warroom/mgm/search?q=...&bulan=...`:
  - Mencari di kolom `id_outlet` DAN `upline` (FA582386 bisa jadi ID upline, bukan ID outlet)
  - ORDER: id_outlet match dulu, lalu upline match, sorted by bulan DESC, trx DESC
  - LIMIT 2000 + COUNT(*) terpisah → response termasuk `total_aktivasi`, `total_registrasi`
  - Frontend tampilkan warning jika total > 2000 (truncated)

### Nginx — Sync Endpoints
File: `/etc/nginx/sites-enabled/bric`
Endpoint `/api/warroom/(segmen|speedcash)/sync` punya location block sendiri:
- `client_max_body_size 30m`
- `proxy_read_timeout 120s`
- Tanpa rate limit (Apps Script pakai token auth, bukan user)

## Server Monitor (`/server-monitor`)
- Hanya tampil untuk admin (menu di sidebar), route tetap terlindungi ProtectedRoute biasa
- Data dari `GET /api/system/stats` → `backend/src/routes/system.js`
- Dikumpulkan: `os.loadavg()`, `os.totalmem/freemem()`, `process.memoryUsage()`, `process.uptime()`, `os.uptime()`
- Disk via `execSync('df -B1 / 2>/dev/null')`
- 6 parallel DB queries: db size, connections (active/idle/total/max), table sizes (top 12), active queries (max 15), lock count
- **Heap gauge**: pakai `sv.mem_total` sebagai max (BUKAN `node_heap_total`)
  - V8 `heap_total` adalah alokasi saat ini — selalu hampir sama dengan `heap_used` = misleading
  - Metrik yang bermakna: heap_used vs total RAM server

## Deploy Script (Python paramiko)
```python
import paramiko, sys
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("147.139.201.43", username="root", password="[lihat catatan terpisah]", timeout=30)
cmds = [
    "cd /home/admin/bric-dashboard && git pull origin master 2>&1",
    "cd /home/admin/bric-dashboard/frontend && npm run build 2>&1 | tail -6",
    "cp -r /home/admin/bric-dashboard/frontend/dist/* /var/www/bric/ && echo Done",
    "pkill -f 'node.*app.js' 2>/dev/null; sleep 1; cd /home/admin/bric-dashboard/backend && nohup node src/app.js > /var/log/bric-backend.log 2>&1 & sleep 2 && curl -s http://localhost:3001/health",
]
for cmd in cmds:
    _, out, _ = client.exec_command(cmd, timeout=120)
    sys.stdout.buffer.write(out.read()); sys.stdout.buffer.flush()
client.close()
```
