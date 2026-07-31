# Farming Fastpay Command Center — War Room Payment Agent > Farming

## Tujuan
Upgrade War Room Farming (route `/war-room/farming`, tetap sama) dari dashboard
statistik pasif menjadi **Command Center operasional**: daily outlet rescue,
revenue recovery, ARPU optimization, retention, growth opportunity, dan action
queue — bukan sekadar laporan.

Menjawab: outlet mana yang wajib dihubungi hari ini, outlet mana yang
kehilangan transaksi/revenue, outlet TRX tinggi tapi monetisasi lemah, outlet
High/Top ARPU berisiko, outlet yang bertumbuh dan layak dioptimalkan, dan
apakah tindakan Farming menghasilkan perbaikan dari hari ke hari.

## Sumber Data
Google Sheet: `1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw`, tab **Farming**.

**Spreadsheet ini DIBAGI dengan menu Payment Agent > Produk** (tab "Produk",
lihat `docs/PAYMENT_AGENT_PRODUK.md`) — satu `spreadsheet_id`, `sheet_name`
berbeda. Parser, tabel, endpoint, dan business logic KEDUANYA sepenuhnya
terpisah, tidak boleh dicampur.

## Domain Terpisah dari Farming Lama
Tabel lama `farming_snapshot` (kolom hardcode `trx_mei_period`/`trx_jun_period`)
**TIDAK diubah/dihapus** — histori lama tetap ada. Tabel baru:
`farming_outlet_snapshot`, `farming_sync_log`, `farming_outlet_followup`
(`backend/src/migrations/create_farming_command_center.sql`).

**BREAKING CHANGE yang disengaja**: kontrak payload sync berubah total (dari
`{tanggal, data:[...field bernama]}` menjadi `{snapshot_date, headers[], rows[]}`
mentah). Apps Script LAMA untuk Farming (kalau masih terpasang & bertrigger)
akan mulai gagal begitu backend ini di-deploy — **wajib** diganti dengan
`apps-script-farming.js` yang baru sebelum/segera setelah deploy, supaya tidak
ada gap sync harian.

## Bulan & Periode 100% Dinamis
Tidak ada nama bulan hardcode di backend/Apps Script. Header sheet contoh:
```
Trx Juni Full | Rev Juni Full | Trx 1-9 Juni | Rev 1-9 Juni | Trx 1-9 Juli | Rev 1-9 Juli | Dev Trx | Dev Rev | layer_arpu
```
Backend membaca header ASLI (dikirim mentah oleh Apps Script, TIDAK diberi
nama field oleh Apps Script) dan menurunkan:
- **baseline_month** = bulan pada header "Full" (mis. Juni) — MAT/TRX/REV
  penuh 1 bulan, jadi referensi.
- **previous_period** = potongan hari (mis. 1-9) pada bulan YANG SAMA dengan
  baseline (aturan: period-pair yang label bulannya SAMA dengan header "Full"
  = previous).
- **current_period** = potongan hari yang sama (mis. 1-9) pada bulan
  berikutnya (label bulan BERBEDA dari baseline).

Kalau header berubah menjadi `Trx Juli Full / Trx 1-10 Juli / Trx 1-10 Agustus`,
seluruh dashboard otomatis berubah jadi "Baseline: Juli Full, Perbandingan:
1–10 Agustus vs 1–10 Juli" — TIDAK ADA perubahan kode.

**month_key ('YYYY-MM') diturunkan dari `snapshot_date`** (current = bulan
snapshot_date, previous/baseline = 1 bulan sebelumnya, dengan rollover tahun
di Desember→Januari), BUKAN dari teks label bulan (nama bulan saja tidak
punya info tahun). Label teks tetap dipakai untuk validasi silang — kalau
tidak cocok, masuk `warnings` (tidak fatal, snapshot_date tetap sumber
kebenaran).

**Deviasi TIDAK dipercaya mentah dari sheet** — backend menghitung ulang
`calculated_dev_trx`/`calculated_dev_revenue` dari `current - previous`, lalu
membandingkan dengan `sheet_dev_trx`/`sheet_dev_revenue` (kalau kolom Dev ada
di sheet). Selisih disimpan sebagai `dev_trx_variance`/`dev_revenue_variance`
dan ditampilkan di tab Data Quality — data tetap disimpan (tidak fatal),
`calculated_*` yang dipakai untuk semua analytics/business logic.

## Parser Header (`backend/src/farming/headerParser.js`)
Regex utama:
```
/^trx\s+(.+?)\s+full$/i              -> Full TRX
/^rev(?:enue)?\s+(.+?)\s+full$/i     -> Full REV
/^trx\s+(\d+)\s*[-–]\s*(\d+)\s+(.+)$/i    -> Period TRX (start, end, bulan)
/^rev(?:enue)?\s+(\d+)\s*[-–]\s*(\d+)\s+(.+)$/i -> Period REV
/^dev\s+trx$/i, /^dev\s+rev(?:enue)?$/i
/^layer[_\s-]*arpu$/i
/^id\s*outlet$/i
```
Gagal (400, sync dibatalkan) kalau: ID Outlet tidak ada, pasangan Full TRX/REV
tidak ada, jumlah header periode TRX/REV bukan persis 2, atau rentang tanggal
previous ≠ current. Response 400 menyertakan `details[]` (pesan jelas) dan
`diagnostics` (header apa yang ketemu/tidak).

Warning (tidak fatal): mapping previous/current jatuh ke posisi kolom (bukan
kecocokan label bulan) kalau label ambigu; label bulan tidak cocok dengan
bulan hasil `snapshot_date`.

## Parser Angka (`backend/src/farming/numberParser.js`)
`safeNumber()` — WAJIB cek `typeof === 'number'` dulu (insiden Speedcash 100x,
CLAUDE.md §5). Titik/koma = pemisah ribuan. Tanda kurung = negatif. Formula
error (`#DIV/0!` dst) & blank → `null`. Tidak pernah mengembalikan NaN/Infinity
(diverifikasi test).

## Business Logic (`backend/src/farming/businessLogic.js`)
Dihitung **sekali saat sync** (bukan saat GET) — hasil (status/priority/
segment/priority_score/reason_codes) disimpan sebagai kolom, sehingga endpoint
analytics/outlets/action-queue cukup `SELECT`, tidak perlu klasifikasi ulang
tiap request (hindari pola stall Postgres yang pernah terjadi di DM Control
Tower saat CTE dijalankan 13x paralel).

### Growth status (cascade)
`unknown` (data tidak cukup) → `churned` (prev>0, curr=0) → `new_active`
(prev=0, curr>0) → `zero_activity` (prev=0 DAN curr=0 — dicek SEBELUM stable
supaya outlet yang memang tidak pernah aktif tidak salah dibaca stabil) →
`critical_decline` (dev rev ≤-25%, atau High/Top ARPU dev trx ≤-25%) →
`declining` (dev rev atau trx ≤-10%) → `rocket_growth` (dev rev ≥+25% & rev
current>0) → `growing` (dev rev atau trx ≥+10%) → `stable` (selain di atas).

### Anomaly flags
`volume_no_revenue` (curr trx>0, curr rev=0), `trx_up_revenue_down` (dev
trx>0 & dev rev<0), `trx_down_revenue_up` (dev trx<0 & dev rev>0).

### Segmentasi (cascade, paling spesifik dulu)
Churned → New Active → Volume No Revenue → High Value At Risk (High/Top ARPU
+ critical_decline/declining) → Growth Champion / Upgrade Opportunity
(rocket_growth/growing, dipecah Low-Mid ARPU + dev trx>0 = Upgrade
Opportunity) → Frequency Problem (dev trx<0 & dev rev≤0) → Monetization
Problem (dev trx≥0 & dev rev<0) → Stable Core (High/Top ARPU + stable) → Low
Value Stable (Low/Mid ARPU + stable) → Data Review (fallback).

### Priority P0–P3 (`finalizePriorities`, butuh konteks SELURUH batch snapshot)
- **P0**: churned; High/Top ARPU + critical_decline; dev revenue ≤-25%;
  High/Top ARPU dev trx ≤-25%; `volume_no_revenue`; termasuk top-10%
  (P90) penyumbang revenue-at-risk terbesar di batch.
- **P1** (kalau belum P0): dev revenue -10% s/d -25%; dev trx -10% s/d -25%;
  High/Top ARPU + declining; `trx_up_revenue_down`; kontributor revenue
  besar (top 20% previous-revenue) yang mulai melemah.
- **P2** (kalau belum P0/P1): rocket_growth/growing; Low/Mid ARPU bertumbuh
  (upgrade candidate); revenue tumbuh signifikan (≥+5%) DAN jauh lebih cepat
  dari trx (gap ≥5 poin persen) — ambang 5% sengaja dipakai (bukan >0%)
  supaya outlet "stable" dengan selisih kecil tidak salah ter-flag.
- **P3**: default (stabil, tidak ada sinyal urgent).

`priority_score` (secondary sort dalam priority level yang sama) — heuristik,
BUKAN formula presisi: bobot layer ARPU + severity decline (%) + bobot churn
+ bobot anomaly + bobot growth opportunity + skala dampak revenue absolut.

### Revenue at Risk
`revenue_at_risk = MAX(previous_period_revenue - current_period_revenue, 0)`
HANYA untuk outlet berstatus declining/critical_decline/churned. Ditampilkan
per outlet, total, per-P0, per-High/Top-ARPU, top 10 kontributor, dan %
konsentrasi top-10 terhadap total (insight otomatis muncul kalau ≥40%).

## Database
Migration: `backend/src/migrations/create_farming_command_center.sql`
Runner: `backend/scripts/run-farming-command-center-migration.js`
Remote runner (SSH, safety-gated, ketik `MIGRATE`): `scripts/run_farming_command_center_migration_remote.py`

| Tabel | Key | Isi |
|---|---|---|
| `farming_outlet_snapshot` | UNIQUE(snapshot_date, id_outlet) | Seluruh metrik per outlet per hari (baseline/previous/current + kalkulasi + klasifikasi), lihat migration untuk daftar kolom lengkap |
| `farming_sync_log` | id | Audit tiap sync (batch id, jumlah baris diterima/valid/skip/insert/update/error, labels, header asli, error summary, durasi, status success/partial/failed) |
| `farming_outlet_followup` | PK id_outlet | State follow-up operasional (PIC, is_contacted, followup_status, followup_date, notes, updated_by/at) — **TIDAK ditimpa saat sync ulang** (di-upsert terpisah dari snapshot) |

Sync idempotent per `snapshot_date` — `INSERT ... ON CONFLICT (snapshot_date,
id_outlet) DO UPDATE`, sync ulang hari yang sama tidak menggandakan baris.
Snapshot hari sebelumnya TIDAK dihapus/ditimpa.

## Backend Endpoints (`backend/src/routes/warroom-farming.js`)
Route URL & posisi registrasi di `app.js` **tidak berubah** (tetap sebelum
catch-all `/api/warroom`).

| Endpoint | Auth | Keterangan |
|---|---|---|
| `POST /api/warroom/farming/sync` | token `x-sync-token`/`Authorization: Bearer`/body `token`, dari ENV `FARMING_SYNC_TOKEN` (TIDAK ADA fallback — 401 kalau env belum diset) | Terima `{snapshot_date, headers[], rows[]}`, parse+klasifikasi+upsert dalam 1 transaksi, log ke `farming_sync_log` selalu (sukses/gagal) |
| `GET /api/warroom/farming/analytics?snapshot_date=latest` | JWT | meta (labels dinamis), summary KPI, priority/status/segment counts, arpu distribution, top decline/growth, anomalies, action_queue_preview, insights, data_quality |
| `GET /api/warroom/farming/snapshots` | JWT | Daftar snapshot tersedia |
| `GET /api/warroom/farming/action-queue?...` | JWT | Sama seperti outlets tapi selalu diurutkan priority (P0→P3) lalu priority_score DESC |
| `GET /api/warroom/farming/outlets?...` | JWT | Server-side pagination, filter priority/status/segment/layer_arpu/search/anomaly, sort kolom whitelist |
| `GET /api/warroom/farming/outlets/:id` | JWT | Detail 1 outlet: histori lengkap + snapshot terbaru + follow-up state |
| `GET /api/warroom/farming/trendline?days=30` | JWT | Agregat harian: TRX/revenue current, revenue at risk, jumlah P0/declining/anomali, breakdown per layer ARPU |
| `GET /api/warroom/farming/data-quality?snapshot_date=latest` | JWT | Semua check DQ + histori 20 sync terakhir + header asli sheet |
| `GET /api/warroom/farming/export?scope=&snapshot_date=` | JWT | CSV — scope: `all/action_queue/p0/high_top_arpu_at_risk/volume_no_revenue/growth_opportunity/data_quality_mismatch`, header kolom pakai label periode dinamis |
| `GET /api/warroom/farming/followup?id_outlet=` | JWT | State follow-up 1 outlet |
| `POST /api/warroom/farming/followup` | JWT | Upsert follow-up (audit `updated_by` dari user login) |

## Apps Script (`apps-script-farming.js`)
Fungsi: `previewFarmingPayload()`, `pushFarmingSemua()`, `setupFarmingTrigger()`
(BELUM diaktifkan), `removeFarmingTriggers()`.

**Tidak melakukan interpretasi header apa pun** — hanya mencari baris header
(baris yang mengandung sel "ID Outlet"), lalu mengirim header ASLI + seluruh
baris data mentah (`getValues()`, tipe numerik asli terjaga). Semua parsing
bulan/periode ada di backend.

`snapshot_date` = tanggal hari ini (Asia/Jakarta) — BUKAN diturunkan dari
kolom "Day N" (yang hanya disimpan sebagai `day_metadata` informasional, tidak
dipakai sebagai cutoff, sesuai instruksi eksplisit).

### Berbagi spreadsheet dengan Payment Agent > Produk
Spreadsheet sama (`1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw`), sheet beda
("Produk" vs "Farming"). Kalau kedua Apps Script (`apps-script-payment-agent-produk.js`
dan `apps-script-farming.js`) ditempatkan di project Apps Script yang sama:
- Semua nama fungsi unik (prefix `pap_`/`Payment Agent Produk` vs
  `farm_`/`Farming`) — tidak ada bentrok.
- `removeFarmingTriggers()` HANYA menghapus trigger dengan handler function
  `pushFarmingSemua` (filter eksplisit via `Set`), **tidak pernah**
  `ScriptApp.getProjectTriggers().forEach(...deleteTrigger)` tanpa filter —
  trigger Produk tidak akan ikut terhapus.
- Kegagalan sync satu fitur (mis. Farming gagal karena header berubah) tidak
  memengaruhi fitur lain (Produk) karena keduanya fungsi & trigger terpisah
  total.

Script Properties (beda nama & beda TOKEN dari Produk):
- `FARMING_SYNC_TOKEN` — harus identik dengan env server, **BEDA** dari
  `PAYMENT_AGENT_PRODUK_SYNC_TOKEN`.
- `FARMING_SYNC_URL` — default `https://bmsretail.my.id/api/warroom/farming/sync`.

## Frontend
- Route: `/war-room/farming` (tidak berubah) — `frontend/src/pages/WarRoomFarming.jsx` (REWRITE penuh)
- Menu: **Payment Agent → War Room → Farming**, badge `Nizar`, tema hijau `#10B981`
  (link ini SEBELUMNYA TIDAK tampil di sidebar — ditemukan sebagai "orphan
  route" saat audit, sekarang ditambahkan)
- Service API: `frontend/src/services/api.js` — `getFarmingSnapshots`,
  `getFarmingAnalytics`, `getFarmingActionQueue`, `getFarmingOutlets`,
  `getFarmingOutletDetail`, `getFarmingTrendline`, `getFarmingDataQuality`,
  `getFarmingFollowup`, `upsertFarmingFollowup`
- CSS prefix: `farm-cc-*`, semua warna via `var(--token)` untuk kontras
  light/dark mode otomatis.

### 7 Tab
1. **Command Center** — 10 KPI, priority/ARPU distribution chart, top
   decline/growth, scatter Dev TRX vs Dev Revenue, top 10 action queue,
   automated insights.
2. **Action Queue** — filter priority/layer ARPU/status/segment/anomali/
   search, export CSV, kolom Reason & Recommended Action & status follow-up.
3. **Growth & Decline** — kuadran (Healthy Growth/Monetization Problem/
   Better Yield/Rescue Required), status distribution, tabel gabungan top
   growth+decline.
4. **ARPU & Monetization** — distribusi & kontribusi revenue/TRX/ARPT per
   layer, jumlah at-risk per layer.
5. **Outlet Explorer** — server-side pagination, kolom dinamis pakai label
   periode dari API, sort per kolom.
6. **Daily Trend** — line chart TRX/revenue/revenue-at-risk/jumlah P0-
   declining-anomali dari `farming_outlet_snapshot` histori harian.
7. **Data Quality** — kartu ringkasan check, parse warnings, sync history,
   header asli sheet (audit).

Klik outlet di tab mana pun membuka **drawer detail** (histori chart + form
follow-up: PIC, status, tanggal, kontak, catatan — tersimpan lewat
`POST /followup`, tidak hilang saat sync ulang).

## Testing
`backend/scripts/test-farming-command-center.js` (Node murni, tanpa DB):
- Parser header: kasus standar Juni/Juli, rollover bulan Juli→Agustus,
  rollover TAHUN Desember→Januari, variasi kapitalisasi/dash/spasi, 2 kasus
  kegagalan wajib (pasangan tidak lengkap, rentang tanggal beda).
- Parser angka: semua format di spec (native number, koma/titik ribuan, Rp,
  negatif kurung, blank, null, dash, formula error) + jaminan tidak pernah
  NaN/Infinity.
- Business logic: 9 growth status, 3 anomaly flag, 5 segmentasi, priority
  P0-P3 (termasuk kasus High/Top ARPU critical_decline→P0, volume_no_revenue
  →P0 walau status stable, growing Low ARPU→P2, stable normal→P3).

Jalankan: `node backend/scripts/test-farming-command-center.js` — 51/51 test
lulus saat implementasi ini selesai.

**Idempotency sync** (upsert DB, bukan pure-function) diverifikasi manual:
jalankan `pushFarmingSemua()` dua kali berturut-turut pada `snapshot_date`
yang sama, lalu cek `SELECT COUNT(*) FROM farming_outlet_snapshot WHERE
snapshot_date = '...'` tidak bertambah pada percobaan kedua.

**Regresi** yang wajib dicek manual setelah deploy: login, sidebar (menu lain
tidak berubah), route lain, dark mode, mobile layout, `/health`.

## Environment Variable
- `FARMING_SYNC_TOKEN` — wajib diset di server (`backend/.env`), token acak,
  **beda** dari token war-room lain manapun (isolasi blast-radius).

## Setup Apps Script & Trigger
1. Copy `apps-script-farming.js` ke Apps Script Editor (boleh project yang
   sama dengan Payment Agent Produk).
2. Set Script Properties `FARMING_SYNC_TOKEN` (sama dengan server) dan
   `FARMING_SYNC_URL` (opsional, ada default).
3. `previewFarmingPayload()` dulu — cek `headers`, jumlah `rows`, sample baris.
4. `pushFarmingSemua()` SATU KALI setelah preview OK.
5. `setupFarmingTrigger()` HANYA setelah disetujui eksplisit terpisah (23:00
   UTC / 06:00 WIB harian). Untuk lepas trigger: `removeFarmingTriggers()`
   (aman, hanya hapus trigger Farming).

## Deploy / Migration Steps
1. `python scripts/run_farming_command_center_migration_remote.py` (ketik
   `MIGRATE`) — bikin 3 tabel baru, tabel lama `farming_snapshot` tidak disentuh.
2. Set `FARMING_SYNC_TOKEN` di `backend/.env` server (generate token baru,
   jangan pernah ditampilkan di chat/log), `pm2 reload`.
3. `python scripts/safe_deploy.py --execute` (ketik `DEPLOY`) — deploy kode
   backend+frontend, otomatis backup frontend lama & health-check.
4. Update Apps Script Farming (langkah "Setup Apps Script" di atas) — WAJIB
   segera setelah deploy karena payload lama sudah tidak kompatibel.

## Rollback
- **Frontend**: `safe_deploy.py` otomatis backup `/var/www/bric` sebelum
  ditimpa (`/var/www/bric_backup_<timestamp>`) — copy balik kalau perlu.
- **Backend**: `git log` + `git revert` commit ini di server, lalu
  `sudo -u admin pm2 reload bric-backend`. Tabel baru (`farming_outlet_snapshot`
  dst) aman dibiarkan ada (tidak dipakai kode lama), TIDAK PERNAH di-DROP
  otomatis oleh proses rollback.
- **Data**: tabel lama `farming_snapshot` tidak pernah disentuh — kalau
  rollback kode, dashboard otomatis kembali baca sumber lama tanpa migrasi
  data apa pun.

## Known Limitations
- `priority_score` adalah heuristik (bobot manual), bukan model yang di-tune
  dengan data historis — cukup untuk secondary sort, jangan dipakai sebagai
  angka bisnis presisi.
- Follow-up hanya menyimpan 1 `notes` mutable (bukan log riwayat catatan
  append-only seperti Ekspedisi) — cukup untuk kebutuhan saat ini, catatan
  lama tertimpa kalau diedit ulang. Kalau butuh histori penuh, perlu tabel
  terpisah (`farming_outlet_followup_notes`), belum dibangun di iterasi ini.
- `arpt_change`/`arpt_change_pct` dihitung tapi belum ada tab khusus "ARPT
  trend per outlet" — ada di drawer detail (nilai saat ini) dan tabel Outlet
  Explorer, belum di-chart historikal per outlet.
- Idempotency penuh (upsert DB) diverifikasi manual, bukan automated test
  (butuh koneksi DB sungguhan) — lihat §Testing.
