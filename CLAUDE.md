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
```

### Route yang terdaftar di app.js
```js
/api/auth/login       — authRoutes (no auth)
/api/scoreboard       — requireAuth
/api/users            — requireAuth
/api/winme            — requireAuth
/api/paymentagent     — requireAuth
/api/dompetdigital    — requireAuth
/api/members          — requireAuth
```

## Struktur Frontend (`frontend/src/`)
```
App.jsx             — routes: /scoreboard, /winme, /payment-agent, /dompet-digital, /users, /anggota/:id
index.css           — semua CSS (CSS variables: --primary #1D9E75, --text-1/2/3/4, --border, --bg-page, --bg-card, dll)
services/api.js     — semua API calls pakai authHeaders()
utils/auth.js       — getToken, getUser, logout
components/
  Layout.jsx
  Sidebar.jsx       — dinamis: load members, accordion Winme, member links dengan avatar + status dot
  ProtectedRoute.jsx
  LeaderManagement.jsx  — CRUD modal: tambah/edit anggota, targets, input pencapaian harian
pages/
  Login.jsx
  Scoreboard.jsx
  WinmeInstaqris.jsx    — tab: Analitik | Leader & Tim
  PaymentAgent.jsx      — unit PAYMENT AGENT, warna #639922
  DompetDigital.jsx     — grup SpeedCash/Travel B2C/Pulsagram
  UserManagement.jsx
  AnggotaDetail.jsx     — /anggota/:id, profil + target cards + bar chart riwayat
```

## Database Tables
```sql
-- Existing
daily_snapshot (id, unit_nama, tanggal, revenue, ...)

-- Leader & Tim
members (id, unit, nama, posisi CHECK('leader','tim'), fungsi, avatar_warna DEFAULT '#7F77DD', is_active, created_at, updated_at)
member_targets (id, member_id FK CASCADE, nama_target, key_result, target_revenue, periode, urutan, created_at)
member_pencapaian (id, member_id FK, target_id FK, tanggal, pencapaian_kr, pencapaian_revenue, pct_kr, pct_revenue, catatan, UNIQUE(target_id, tanggal))
```

## Sidebar Accordion
- Winme & InstaQris punya accordion untuk menampilkan member links
- Auto-buka jika path `/winme` atau `/anggota/:id`
- Chevron rotate 180° saat terbuka
- Event `membersUpdated` untuk refresh list setelah CRUD

## Menu Order (Sidebar)
1. Unit Scoreboard
2. Winme & InstaQris (+ accordion member links di bawahnya)
3. Payment Agent
4. Dompet Digital
5. Kelola User (admin only)

## Icons
Tabler Icons webfont — gunakan `<i className="ti ti-xxx" />` bukan SVG.
CDN sudah ada di `frontend/index.html`.

## Warna per Unit
- Winme & InstaQris grup: `#7F77DD`
- Winme: `#378ADD`, InstaQris: `#7F77DD`
- Payment Agent: `#639922`
- Dompet Digital grup: `#D85A30`
- SpeedCash: `#EF4444`, Travel B2C: `#1D9E75`, Pulsagram: `#378ADD`

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
