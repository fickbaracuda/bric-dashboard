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
  members.js      — CRUD leader & tim (GET, POST, PUT, DELETE, targets, pencapaian)
  warroom.js      — WAR-ROOM InstaQris + Speedcash (segmen & outlet monitoring)
  ai.js           — Gemini 2.5 Flash chat, retry 3x backoff
  ai-context.js   — system prompt builder, selalu load SEMUA data, chat_history CRUD
```

### Route yang terdaftar di app.js
```js
/api/auth/login                    — authRoutes (no auth)
/api/scoreboard                    — requireAuth
/api/users                         — requireAuth
/api/winme                         — requireAuth
/api/paymentagent                  — requireAuth
/api/dompetdigital                 — requireAuth
/api/members                       — requireAuth
/api/warroom/segmen/sync           — token auth (BUKAN JWT), no rate limit, body max 30mb
/api/warroom/speedcash/sync        — token auth (BUKAN JWT), no rate limit, body max 30mb
/api/warroom                       — requireAuth (semua GET endpoint di bawahnya)
/api/ai                            — requireAuth
/api/ai-context                    — requireAuth
```

### Penting — Urutan registrasi route di app.js
Sync endpoints HARUS didaftarkan **sebelum** `app.use('/api/warroom', requireAuth, ...)` agar bypass JWT:
```js
app.post('/api/warroom/segmen/sync',    warroomRoutes.syncHandler);
app.post('/api/warroom/speedcash/sync', warroomRoutes.speedcashSyncHandler);
app.use('/api/warroom', requireAuth, warroomRoutes);
```

### Express body limit
`express.json({ limit: '30mb' })` — dinaikkan untuk handle 40k+ baris dari Apps Script.

## Struktur Frontend (`frontend/src/`)
```
App.jsx             — routes: /scoreboard, /winme, /payment-agent, /dompet-digital,
                      /users, /anggota/:id, /scoreboard-tim, /scoreboard-tim-pa,
                      /scoreboard-tim-sc, /war-room/instaqris, /war-room/speedcash,
                      /leader-scoreboard
index.css           — semua CSS (CSS variables: --primary #1D9E75, --text-1/2/3/4, --border, --bg-page, --bg-card, dll)
                      CSS prefix: lm-* (LeaderManagement), ad-* (AnggotaDetail), st-* (ScoreboardTim)
                      CSS prefix: wr-* (WAR-ROOM shared), aic-* (AI Chat)
                      .main-content: TIDAK ada max-width — full width
services/api.js     — semua API calls pakai authHeaders()
utils/auth.js       — getToken, getUser, logout
components/
  Layout.jsx
  Sidebar.jsx       — nested accordion: Winme (L1) → Scoreboard Tim (L2) → LeaderAccordion per-leader (L3)
                      separator antar menu utama: .sidebar-menu-sep
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
  WarRoomSpeedcash.jsx  — /war-room/speedcash, monitoring outlet Speedcash
  LeaderScoreboard.jsx  — /leader-scoreboard
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
                    dev_trx, dev_margin, synced_at, UNIQUE(tanggal, id_outlet))
-- Index: idx_speedcash_tanggal, idx_speedcash_outlet
-- Grant: GRANT ALL ON speedcash_snapshot TO bricuser;
--        GRANT USAGE, SELECT ON SEQUENCE speedcash_snapshot_id_seq TO bricuser;
```

## Sidebar Accordion
- Nested 3 level: Winme (L1) → Scoreboard Tim (L2) → LeaderAccordion per-leader (L3)
- Auto-buka jika path `/winme`, `/scoreboard-tim`, atau `/anggota/:id`
- Chevron rotate 180° saat terbuka (class `sidebar-chevron--open`)
- Animasi height via `scrollHeight` + `requestAnimationFrame` (komponen `Accordion`)
- Tiap leader punya accordion sendiri (`LeaderAccordion`) — Tim tampil sebagai sub-item di bawah leader-nya
- Event `membersUpdated` untuk refresh list setelah CRUD
- Separator antar menu utama: `<div className="sidebar-menu-sep" />` (garis tipis 1px)

## Menu Order (Sidebar)
1. Unit Scoreboard
   ── [separator] ──
2. Leader Scoreboard
   ── [separator] ──
3. Winme & InstaQris (L1 accordion)
   └─ Scoreboard Tim (L2 accordion)
      └─ [Leader accordion] → Tim sub-list
   ── [separator] ──
4. Payment Agent (L1 accordion)
   └─ Scoreboard Tim PA
   ── [separator] ──
5. Dompet Digital (L1 accordion)
   └─ Scoreboard Tim SpeedCash
   ── [separator] ──
6. ⚔ WAR-ROOM (label merah #E24B4A)
   └─ InstaQris → /war-room/instaqris
   ── [separator] ──
7. ⚡ WAR-ROOM SPEEDCASH (label oranye #F97316)
   └─ Speedcash → /war-room/speedcash
   ── [separator] ──
8. Kelola User (admin only)

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
- ~40.000+ baris outlet → kirim langsung (nginx & Express limit sudah 30mb)
- Anomali: `dev_trx > 0 && dev_margin < 0`
- Outlet baru: `tgl_reg >= tanggal - 1 bulan`
- Upsert: UNIQUE(tanggal, id_outlet)
- Trigger harian: `setupSpeedcashTrigger()` → jam 23.00 UTC (06.00 WIB)

### Nginx — Sync Endpoints
File: `/etc/nginx/sites-enabled/bric`
Endpoint `/api/warroom/(segmen|speedcash)/sync` punya location block sendiri:
- `client_max_body_size 30m`
- `proxy_read_timeout 120s`
- Tanpa rate limit (Apps Script pakai token auth, bukan user)

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
